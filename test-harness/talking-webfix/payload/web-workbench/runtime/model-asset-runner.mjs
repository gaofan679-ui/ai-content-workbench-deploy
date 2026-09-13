import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runPersonStage } from "./person-runner.mjs";
import { artifactRoot } from "./portable-paths.mjs";

const FINAL_GENERATION_PROMPT_HEADING = "【最终可直接使用的完整生图提示词】";

export function promptBodyForGeneration(value) {
  const prompt = String(value || "").trim();
  if (!prompt.startsWith(FINAL_GENERATION_PROMPT_HEADING)) return prompt;
  return prompt.slice(FINAL_GENERATION_PROMPT_HEADING.length).trim();
}

export async function runModelAssetGeneration({ project, references, projectDir, onEvent, env = process.env }) {
  const attempt = project.active_attempt;
  if (!attempt) throw new Error("MODEL_ASSET_ATTEMPT_MISSING");
  const exactTalkingPrompt = attempt.talking_style_analysis?.approved_generation_prompt
    ? promptBodyForGeneration(attempt.talking_style_analysis.approved_generation_prompt)
    : null;
  const exactStagePrompt = attempt.final_prompt
    ? String(attempt.final_prompt).trim()
    : null;
  const exactGenerationPrompt = exactTalkingPrompt || exactStagePrompt;
  const taskDir = join(projectDir, "runs", `attempt-${attempt.attempt_number}`);
  mkdirSync(taskDir, { recursive: true });
  const artifactRoute = prepareModelAssetArtifactRoute(project, env);
  const priorApprovalEvidence = modelAssetApprovalEvidence(project, attempt, references);
  const task = {
    id: project.id,
    title: project.name,
    // A standalone model-asset project has image references, not a source video.
    // Passing the first image as `reference_video_path` made the owner Skill
    // misclassify an approved parent image as an unreviewed source artifact.
    reference_video_path: null,
    person_route: project.route === "real_person" ? "authorized_person" : "auto_ai_person",
    person_brief: exactGenerationPrompt || [project.brief, attempt.instruction].filter(Boolean).join("\n\n本次补充要求：\n"),
    final_prompt: exactGenerationPrompt,
    person_attempt_count: attempt.attempt_number,
    person_generation_provider: attempt.provider,
    person_source_upload_authorized: attempt.upload_authorized || references.length === 0,
    reference_images: references.map((asset, index) => ({
      order: index + 1,
      ref_id: `MODEL-REF-${String(index + 1).padStart(2, "0")}`,
      display_name: asset.original_name,
      path: asset.path,
      sha256: asset.sha256,
      category: asset.category,
    })),
    prior_approval_evidence: priorApprovalEvidence,
    model_asset_context: {
      standalone_project: true,
      route: project.route,
      route_state: project.route_state,
      ai_source_method: project.route === "ai_model" ? project.ai_source_method || "original" : null,
      ai_workflow_stage: project.route === "ai_model" ? project.ai_workflow_stage || "v0" : null,
      design_direction_confirmed:
        project.route === "ai_model" && project.ai_source_method === "original"
          ? project.ai_design_direction_confirmed === true
          : null,
      owner_chain:
        project.route === "real_person"
          ? ["ai-video-real-person-assets", "ai-video-person-assets"]
          : ["ai-model-asset-codex"],
      target_use: "reusable_model_asset_for_talking_head_and_video",
      authorization_confirmed: project.authorization_confirmed,
      user_revision_allowed: true,
      artifact_route: artifactRoute,
      talking_head_style_analysis: attempt.talking_style_analysis || null,
      exact_prompt_passthrough: Boolean(exactGenerationPrompt),
      stage_prompt_contract: attempt.stage_prompt_contract || null,
      prior_approval_evidence: priorApprovalEvidence,
    },
  };
  return runPersonStage({
    task,
    taskDir,
    onEvent,
    env,
    skillContractWorkflow: project.route === "ai_model"
      ? "model_asset_generation"
      : "real_person_generation",
  });
}

export function modelAssetApprovalEvidence(project, attempt, references = []) {
  const parentIds = Array.isArray(attempt?.parent_asset_ids) ? attempt.parent_asset_ids : [];
  const approvedParents = parentIds.map((assetId) =>
    (project.assets || []).find((asset) => asset.asset_id === assetId)
  ).filter((asset) =>
    asset?.status === "approved"
      && asset.approved_at
      && references.some((reference) =>
        reference.asset_id === asset.asset_id
          || reference.derived_from_asset_id === asset.asset_id
      )
  ).map((asset) => ({
    asset_id: asset.asset_id,
    asset_stage: asset.asset_stage || null,
    approval_status: "approved",
    approved_at: asset.approved_at,
    approval_source: "explicit_workbench_user_action",
    path: asset.path,
    sha256: asset.sha256,
  }));
  return {
    schema_version: 1,
    requested_asset_stage: attempt?.asset_stage || null,
    workflow_stage: project.workflow_stage || null,
    active_asset_lock: project.active_asset_lock || null,
    approved_parent_assets: approvedParents,
    authoritative_for_stage_routing: true,
  };
}

export function prepareModelAssetArtifactRoute(project, env) {
  // Test generators already own their isolated output route. The live workbench
  // must prepare the formal candidate destination before any model upload.
  if (env.WORKBENCH_PERSON_GENERATOR || env.WORKBENCH_CHATGPT_WEB_MODE === "simulation")
    return null;
  const workbench = artifactRoot(env);
  const adapter = env.WORKBENCH_SKILL_ARTIFACT_ADAPTER || join(
    workbench,
    "系统文件_无需打开",
    "tools",
    "scripts",
    "workbench-artifacts",
    "skill_artifact_adapter.py",
  );
  if (!existsSync(adapter)) throw new Error("MODEL_ASSET_ARTIFACT_ADAPTER_MISSING");
  const output = execFileSync("python3", [
    adapter,
    "prepare",
    "--skill", "ai-video-image-assets",
    "--task-id", project.id,
    "--project-name", project.name,
    "--intent", "process",
  ], { env, encoding: "utf8" });
  const route = JSON.parse(output);
  if (route.status !== "prepared" || !route.route_receipt || !route.final_dir || !route.work_dir)
    throw new Error("MODEL_ASSET_ARTIFACT_ROUTE_NOT_READY");
  return {
    route_contract: route.route_contract,
    workspace_root: route.workspace_root,
    task_root: route.task_root,
    work_dir: route.work_dir,
    process_dir: route.process_dir,
    candidate_dir: route.candidate_dir,
    final_dir: route.final_dir,
    route_receipt: route.route_receipt,
    artifact_tool: route.artifact_tool,
    skill: route.skill,
    intent: route.intent,
  };
}

export function reconcileBlockedModelAssetResult(project, result, env = process.env) {
  if (result?.status !== "blocked") return result;
  const route = prepareModelAssetArtifactRoute(project, env);
  const candidate = (result.artifacts || []).find((item) => item?.path && /\.(png|jpe?g|webp)$/i.test(item.path));
  const receipt = findSuccessfulExecutionReceipt(route.task_root, candidate?.path, project.id);
  if (!receipt) return result;
  if ((project.assets || []).some((asset) =>
    asset.sha256 === receipt.file_spec?.sha256 || asset.path === receipt.project_output_path
  )) return result;
  const recoveredPath = receipt.project_output_path;
  return {
    ...result,
    status: "completed",
    summary: "候选图已生成并完成来源校验；上次中断遗留的过程证据已补登记，本次恢复为待审核候选。",
    user_message: "候选图已经安全回到工作台，请检查本人相貌、眼周、肤感和头颈肩后决定是否采用。",
    recovered_attempt_number: Number(String(receipt.attempt_id || "").match(/(\d+)$/)?.[1] || 0) || null,
    artifacts: [{ type: "image", path: recoveredPath }],
  };
}

function findSuccessfulExecutionReceipt(processRoot, candidatePath, taskId = null) {
  const stack = [processRoot];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^execution_receipt(?:-[^/]+)?\.json$/.test(entry.name)) continue;
      const receiptPath = join(current, entry.name);
      try {
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        const receiptPathMatches = !candidatePath || receipt.project_output_path === candidatePath;
        const taskMatches = !taskId || receipt.task_id === taskId;
        if (receipt.status === "success" && receipt.approval_status === "needs_review" && receiptPathMatches && taskMatches && existsSync(receipt.project_output_path)) {
          const fileHash = createHash("sha256").update(readFileSync(receipt.project_output_path)).digest("hex");
          if (receipt.file_spec?.sha256 === fileHash) return receipt;
        }
      } catch { /* keep checking this task's bounded process tree */ }
    }
    for (const entry of entries)
      if (entry.isDirectory()) stack.push(join(current, entry.name));
  }
  return null;
}
