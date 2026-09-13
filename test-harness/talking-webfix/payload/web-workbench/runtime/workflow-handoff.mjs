import { createHash } from "node:crypto";
import { existsSync, statSync, createReadStream } from "node:fs";

export const HANDOFF_OUTCOMES = Object.freeze({
  COMPLETED: "completed",
  NEEDS_USER_CHOICE: "needs_user_choice",
  BLOCKED_LOCAL: "blocked_local",
  BLOCKED_EXTERNAL: "blocked_external",
  FAILED_AFTER_SUBMIT: "failed_after_submit",
});

const STAGE_OWNERS = Object.freeze({
  decomposition: "ai-video-decompose-gemini",
  rewrite: "ai-video-product-rewrite",
  person_generation: "ai-video-person-assets",
  person: "ai-video-person-assets",
  product_assets: "ai-video-product-assets",
  storyboard: "ai-video-storyboard",
  storyboard_generation: "ai-video-storyboard",
  motion_preflight: "ai-video-motion-preflight",
  video_prompt: "aigc-video-prompt-codex",
  person_package: "ai-video-person-assets",
  generation_pack: "ai-video-generation-pack",
  video_generation: "ai-video-generation-runner",
  video_rework_generation: "ai-video-generation-runner",
});

export function classifyWorkflowOutcome({ task, error = null, result = null }) {
  if (result?.status === "needs_user_input") return HANDOFF_OUTCOMES.NEEDS_USER_CHOICE;
  const explicitlySubmitted = result?.external_request_started === true || error?.external_request_started === true;
  const explicitlyBlocked = result?.status === "blocked" || task?.status === "blocked_configuration";
  if (explicitlyBlocked && !explicitlySubmitted) {
    const code = String(error?.code || result?.code || "").toUpperCase();
    const text = `${error?.message || error || ""} ${result?.summary || ""} ${result?.user_message || ""}`;
    if (
      task?.status === "blocked_configuration" ||
      /CREDENTIAL|NETWORK|DNS|TLS|AUTH|PROVIDER|QUOTA|RATE_LIMIT/.test(code) ||
      /凭证|网络|登录|授权|额度|限流|供应商|第三方|配置/.test(text)
    ) return HANDOFF_OUTCOMES.BLOCKED_EXTERNAL;
    return HANDOFF_OUTCOMES.BLOCKED_LOCAL;
  }
  const externalRequestStarted = explicitExternalRequestStarted(task, error, result);
  if (externalRequestStarted === true) return HANDOFF_OUTCOMES.FAILED_AFTER_SUBMIT;
  const code = String(error?.code || result?.code || "").toUpperCase();
  const text = `${error?.message || error || ""} ${result?.summary || ""} ${result?.user_message || ""}`;
  if (
    task?.status === "blocked_configuration" ||
    /CREDENTIAL|NETWORK|DNS|TLS|AUTH|PROVIDER|QUOTA|RATE_LIMIT/.test(code) ||
    /凭证|网络|登录|授权|额度|限流|供应商|第三方/.test(text)
  ) return HANDOFF_OUTCOMES.BLOCKED_EXTERNAL;
  return HANDOFF_OUTCOMES.BLOCKED_LOCAL;
}

export async function buildWorkflowHandoffEnvelope({
  task,
  stage,
  error = null,
  result = null,
  createdAt = new Date().toISOString(),
}) {
  if (!task?.id) throw new Error("WORKFLOW_HANDOFF_TASK_REQUIRED");
  const outcome = classifyWorkflowOutcome({ task, error, result });
  const externalRequestStarted = explicitExternalRequestStarted(task, error, result);
  const skillContract = result?.skill_contract || stageResult(task, stage)?.skill_contract || null;
  const ownerSkill = skillContract?.owner_skill || STAGE_OWNERS[stage] || "formal_skills";
  const technicalMessage = safeText(error?.message || error || task.last_error || "", 1200);
  const userMessage = safeText(result?.user_message || task.user_message || outcomeSummary(outcome), 500);
  const artifacts = await artifactManifest(task, stage);
  return {
    schema_version: 1,
    contract_name: "ai_content_workbench_handoff",
    contract_version: "1.0.0",
    handoff_id: `${task.id}:${stage}:${createdAt}`,
    created_at: createdAt,
    project: {
      task_id: task.id,
      title: task.title,
      workflow: task.workflow,
      run_id: task.active_run_id || result?.run_id || null,
      attempt_id: result?.attempt_id || null,
    },
    responsibility: {
      stage,
      owner_skill: ownerSkill,
      skill_contract: skillContract,
      workbench_role: "validate_transport_persist_display",
      business_rules_may_be_overridden_by_workbench: false,
    },
    inputs_and_outputs: {
      artifacts,
      result_artifacts: normalizeResultArtifacts(result?.artifacts),
    },
    execution: {
      provider: result?.provider || task.generation_model_snapshot?.provider || task.generation_provider || null,
      model_key: result?.model_key || task.generation_model_key || null,
      quality_profile: result?.quality_profile || task.generation_quality_profile || null,
      external_request_started: externalRequestStarted,
      billable_submission_count: billableSubmissionCount(result, externalRequestStarted),
      automatic_retry: false,
      remote_task_ids: collectRemoteTaskIds(result || stageResult(task, stage)),
      estimated_cost_cny: Number(result?.estimated_cost_cny ?? task.estimated_cost_cny ?? 0),
    },
    outcome: {
      state: outcome,
      user_summary: userMessage,
      technical_evidence: technicalMessage || null,
      next_action: nextAction(outcome),
    },
    routing: {
      target: "project_codex_task",
      action: "create_or_continue",
      starts_model_turn_automatically: Boolean(task.managed_mode),
      user_opens_task_to_continue: !task.managed_mode,
      resubmission_allowed: outcome !== HANDOFF_OUTCOMES.FAILED_AFTER_SUBMIT,
    },
  };
}

export function workflowHandoffUserCopy(envelope) {
  const state = envelope?.outcome?.state;
  if (state === HANDOFF_OUTCOMES.FAILED_AFTER_SUBMIT) return {
    label: "已提交，等待接回",
    headline: "不会重新生成，只接回原任务",
    detail: "项目任务已收到原提交记录和远程任务编号。打开后只核对同一次请求，不会重复扣费。",
  };
  if (state === HANDOFF_OUTCOMES.BLOCKED_EXTERNAL) return {
    label: "外部条件待恢复",
    headline: "项目资料已保存，恢复条件后继续",
    detail: "项目任务已收到缺失条件和当前进度；不会自动重试或改用别的通道。",
  };
  if (state === HANDOFF_OUTCOMES.NEEDS_USER_CHOICE) return {
    label: "等你决定",
    headline: "当前成果和可选路线已交接",
    detail: "打开项目任务即可继续判断，不会自动上传、生成或扣费。",
  };
  return {
    label: "提交前已停止",
    headline: "没有重复提交，问题已转入项目任务",
    detail: "工作台已把当前步骤、Skill 版本和本地证据一起交接；打开后从原步骤修复，不必重做前面的成果。",
  };
}

function explicitExternalRequestStarted(task, error, result) {
  if (typeof result?.external_request_started === "boolean") return result.external_request_started;
  if (typeof error?.external_request_started === "boolean") return error.external_request_started;
  const stageResultValue = stageResult(task, task?.active_stage || task?.current_step);
  if (typeof stageResultValue?.external_request_started === "boolean") return stageResultValue.external_request_started;
  return task?.active_external_request_started === true ? true : null;
}

function billableSubmissionCount(result, externalRequestStarted) {
  for (const value of [result?.billable_submission_count, result?.submission_count, result?.actual_submission_count]) {
    if (Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  }
  return externalRequestStarted === false ? 0 : null;
}

function nextAction(outcome) {
  if (outcome === HANDOFF_OUTCOMES.FAILED_AFTER_SUBMIT) return "reattach_existing_remote_request_only";
  if (outcome === HANDOFF_OUTCOMES.BLOCKED_EXTERNAL) return "restore_external_condition_then_resume_same_stage";
  if (outcome === HANDOFF_OUTCOMES.NEEDS_USER_CHOICE) return "await_user_choice";
  return "repair_local_contract_then_revalidate_same_stage";
}

function outcomeSummary(outcome) {
  if (outcome === HANDOFF_OUTCOMES.FAILED_AFTER_SUBMIT) return "请求已经提交，但结果返回中断；只允许接回原任务。";
  if (outcome === HANDOFF_OUTCOMES.BLOCKED_EXTERNAL) return "外部运行条件未满足，任务已安全暂停。";
  if (outcome === HANDOFF_OUTCOMES.NEEDS_USER_CHOICE) return "需要你确认当前结果或路线后继续。";
  return "提交前检查没有通过，已有成果和本次尝试已保留。";
}

function stageResult(task, stage) {
  const map = {
    decomposition: task?.decomposition_result,
    rewrite: task?.rewrite_result,
    person: task?.person_generation_result,
    person_generation: task?.person_generation_result,
    product_assets: task?.product_assets_result,
    storyboard: task?.storyboard_generation_result,
    storyboard_generation: task?.storyboard_generation_result,
    motion_preflight: task?.motion_preflight_result,
    video_prompt: task?.video_prompt_result,
    person_package: task?.person_package_result,
    generation_pack: task?.generation_pack_result,
    video_generation: task?.video_generation_result,
    video_rework_generation: task?.video_generation_result,
  };
  return map[stage] || null;
}

async function artifactManifest(task, stage) {
  const candidates = (task.artifacts || [])
    .filter((item) => item.path && (item.stage === stage || item.published))
    .slice(-30);
  const entries = [];
  for (const item of candidates) {
    const base = {
      stage: item.stage,
      label: safeText(item.label, 160),
      path: item.path,
      published: Boolean(item.published),
      exists: false,
      size_bytes: null,
      sha256: null,
    };
    try {
      if (!existsSync(item.path)) { entries.push(base); continue; }
      const stat = statSync(item.path);
      if (!stat.isFile()) { entries.push({ ...base, exists: true }); continue; }
      entries.push({ ...base, exists: true, size_bytes: stat.size, sha256: await hashFile(item.path) });
    } catch {
      entries.push(base);
    }
  }
  return entries;
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function normalizeResultArtifacts(artifacts) {
  return Array.isArray(artifacts) ? artifacts.slice(0, 30).map((item) => ({
    label: safeText(item?.label, 160), path: item?.path || null, published: Boolean(item?.published),
  })) : [];
}

function collectRemoteTaskIds(value) {
  const found = new Set();
  visit(value, (key, child) => {
    if (/^(remote_)?task_ids?$/i.test(key)) {
      for (const item of Array.isArray(child) ? child : [child]) {
        const text = safeText(item, 160);
        if (text) found.add(text);
      }
    }
  });
  return [...found].slice(0, 30);
}

function visit(value, callback, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return;
  for (const [key, child] of Object.entries(value)) {
    callback(key, child);
    visit(child, callback, depth + 1);
  }
}

function safeText(value, max) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
