import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";
import { buildGenerationEvidenceProjection } from "./generation-evidence-projection.mjs";
import { compileGenerationPack } from "./generation-pack-compiler.mjs";
import { buildCodexArgs } from "./codex-runner.mjs";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { artifactRoot } from "./portable-paths.mjs";

export async function runGenerationPackStage({ task, taskDir, outputDir = taskDir, onEvent, env = process.env }) {
  const skillContract = resolveSkillContract("generation_pack", { env });
  const contractReceipt = skillContractReceipt(skillContract);
  mkdirSync(outputDir, { recursive: true });
  const resultPath = join(outputDir, "generation-pack-result.json");
  const indexPath = join(outputDir, "project-identity-index.json");
  const contractReceiptPath = join(outputDir, "generation-pack-skill-contract.json");
  const routes = discoverTaskRoutes(task.id, artifactRoot(env));
  const canonicalRoute = chooseCanonicalRoute(task, routes);
  const sourceGenerationFacts = readSourceGenerationFacts(taskDir);
  const provider = task.generation_model_snapshot?.provider || task.generation_provider || "libtv";
  const evidenceProjection = env.WORKBENCH_GENERATION_PACK_GENERATOR
    ? null
    : buildGenerationEvidenceProjection({ task, taskDir, projectionDir: join(outputDir, "08_generation_evidence_projection"), provider, env });
  if (evidenceProjection) onEvent?.("正在把已确认的人物、分镜、动态和提示词成果统一登记到生成前检查；不会重新生成内容。");
  const index = {
    schema_version: 1,
    task_id: task.id,
    project_name: task.title,
    generation_route_choice: task.generation_route_choice,
    generation_model_key: task.generation_model_key,
    generation_model_snapshot: task.generation_model_snapshot,
    generation_model_selection: {
      provider,
      quality_profile: task.generation_model_snapshot?.quality_profile || task.generation_quality_profile || "high",
      model_key: task.generation_model_key,
      selected_by: "user",
      selection_source: "workbench_current_generation_choice",
      selection_scope: "current_generation_attempt",
      explicit_selection: true,
      may_fall_back_to_default: false,
    },
    source_generation_facts: sourceGenerationFacts,
    generation_unit_authority: {
      owner_skill: "ai-video-generation-pack",
      upstream_prompt_handoff_authority: "content_only_non_authoritative_for_task_count",
      user_selection_source: "workbench_current_generation_choice",
      user_generation_unit_choice: task.generation_route_choice === "in_chat_libtv_generation" ? "full_sequence" : "smoke_test_first",
      user_generation_unit_choice_explicit: true,
    },
    canonical_route: canonicalRoute,
    related_project_routes: routes,
    generation_evidence_projection: evidenceProjection,
    registered_artifacts: task.artifacts.map(({ stage, label, path, published }) => ({ stage, label, path, published: Boolean(published), exists: existsSync(path) })),
    authoritative_stage_results: {
      decomposition: task.decomposition_result,
      rewrite: task.rewrite_result,
      person: task.person_generation_result,
      person_package: task.person_package_result,
      storyboard: task.storyboard_generation_result,
      motion_preflight: task.motion_preflight_result,
      video_prompt: task.video_prompt_result,
    },
    external_request_authorized: false,
    video_generation_authorized: false,
    skill_contract: contractReceipt,
    skill_contract_receipt_path: contractReceiptPath,
  };
  writeFileSync(contractReceiptPath, `${JSON.stringify(contractReceipt, null, 2)}\n`, { flag: existsSync(contractReceiptPath) ? "w" : "wx" });
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, { flag: existsSync(indexPath) ? "w" : "wx" });
  onEvent?.(evidenceProjection ? "已完成生成前证据统一登记，正在恢复本次未消费预检；当前不会提交真实生成。" : "正在准备视频任务包；当前不会提交真实生成。");
  const reusableResult = readReusableGenerationPackResult(resultPath, task);
  if (reusableResult) {
    onEvent?.("已核对现有任务包与本次项目、通道、模型和清晰度完全一致，直接恢复本地验收，不重复调用 Skill。");
  } else if (env.WORKBENCH_GENERATION_PACK_GENERATOR) {
    await runProcess(process.execPath, [env.WORKBENCH_GENERATION_PACK_GENERATOR, "--task-json", indexPath, "--task-dir", outputDir, "--output", resultPath], { env, onEvent });
  } else if (env.WORKBENCH_DETERMINISTIC_GENERATION_PACK === "1") {
    onEvent?.("生成前硬检查已通过，正在本地编译测试任务包；当前不会提交真实生成。");
    compileGenerationPack({ task, taskDir, evidenceProjection, resultPath, env });
  } else {
    onEvent?.("生成前硬检查已通过，正在由正式视频任务包 Skill 决定逐镜或整段、主锚点和素材组合；当前不会上传或生成视频。");
    const prompt = buildGenerationPackPrompt(task, outputDir, indexPath, canonicalRoute, skillContract, evidenceProjection, sourceGenerationFacts);
    const promptPath = join(outputDir, "generation-pack-prompt.md");
    writeFileSync(promptPath, prompt, { flag: existsSync(promptPath) ? "w" : "wx" });
    const args = buildCodexArgs({ taskDir: outputDir, resultPath, env });
    await runManagedCodex({ args, prompt, env, onEvent, timeoutMs: 15 * 60 * 1000 });
  }
  if (!existsSync(resultPath)) throw new Error("GENERATION_PACK_RESULT_MISSING");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.status === "completed") {
    const missing = ["视频生成任务包", "任务包预检"].filter((label) => !(result.artifacts || []).some((item) => item.path && existsSync(item.path) && item.label.includes(label)));
    if (missing.length) throw new Error(`GENERATION_PACK_ARTIFACTS_MISSING:${missing.join(",")}`);
    assertGenerationUnitMatchesUserChoice(task, result);
  }
  const submissionPreview = result.status === "completed"
    ? buildSubmissionPreview(task, result)
    : result.submission_preview;
  const deterministic = env.WORKBENCH_DETERMINISTIC_GENERATION_PACK === "1";
  const executionMode = env.WORKBENCH_GENERATION_PACK_GENERATOR ? "test_or_external_generator" : deterministic ? "local_deterministic_adapter" : "formal_skill_managed";
  const finalized = {
    ...result,
    submission_preview: submissionPreview,
    skill_contract: contractReceipt,
    skill_contract_receipt_path: contractReceiptPath,
    skill_contract_role: deterministic ? "interface_compatibility_checked_only" : "business_rules_owner",
    skill_execution_status: env.WORKBENCH_GENERATION_PACK_GENERATOR ? "generator_managed" : deterministic ? "not_invoked" : "invoked",
    execution_mode: executionMode,
    external_request_started: false,
    video_generation_started: false,
    estimated_cost_cny: 0,
  };
  writeFileSync(resultPath, `${JSON.stringify(finalized, null, 2)}\n`);
  return finalized;
}

function discoverTaskRoutes(taskId, artifactRoot) {
  const projects = join(artifactRoot, "02_项目工作区");
  if (!existsSync(projects)) return [];
  const routes = [];
  for (const name of readdirSync(projects)) {
    const path = join(projects, name, "task_route.json");
    if (!existsSync(path)) continue;
    try {
      const route = JSON.parse(readFileSync(path, "utf8"));
      if (route.task_id === taskId || String(route.task_id || "").startsWith(`${taskId}_`) || String(route.task_id || "").startsWith(`${taskId}-`)) routes.push({ ...route, route_receipt: path });
    } catch { /* unrelated or unreadable historical route */ }
  }
  return routes;
}

function chooseCanonicalRoute(task, routes) {
  const approved = task.artifacts.find((item) => item.published && ["person", "storyboard"].includes(item.stage));
  if (approved) {
    const route = routes.find((item) => approved.path.startsWith(`${item.task_root}/`));
    if (route) return route;
  }
  return routes.find((item) => item.task_id === task.id && item.project_name.replace(/[\s_]+/g, "") === task.title.replace(/[\s_]+/g, "")) || routes.find((item) => item.task_id === task.id) || null;
}

export function buildGenerationPackPrompt(task, taskDir, indexPath, canonicalRoute, skillContract, evidenceProjection = null, sourceGenerationFacts = null) {
  const h3SegmentContract = task.generation_model_snapshot?.provider === "runninghub_h3_multiref" && task.generation_model_snapshot?.segmented_full_sequence_required
    ? "当前正式视频的有效内容明确超过 H3 单次 15 秒上限，必须按自然停顿、场景变化或动作闭合点输出 2–5 张 segmented_full_sequence 任务卡；每卡 1–15 秒、各自 generation_count=1，覆盖完整原片时长。不得压成一张超长卡，也不得拆成逐镜碎片卡。连续单镜头且使用模型原生音频逐字口播时，禁止生成相互独立后再硬切拼接；必须提供已核验的段间承接方案和每段完整收音余量，否则免费阻断。"
    : null;
  const h3MarginalOverrunContract = task.generation_model_snapshot?.provider === "runninghub_h3_multiref" && task.generation_model_snapshot?.marginal_overrun_compacted_to_single_task
    ? `原素材容器时长约 ${task.generation_model_snapshot.source_duration_seconds} 秒，只比 H3 上限多不超过 ${task.generation_model_snapshot.marginal_overrun_tolerance_seconds} 秒；本次按单条 15 秒 full_sequence 编译，通过略微收紧自然语速覆盖完整台词，不得机械拆成两条独立原生音频任务。`
    : null;
  const promptDrivenContract = task.remix_precision_route === "prompt_driven_remix"
    ? "当前项目是用户明确选择的快速提示词复刻：storyboard_intentionally_skipped=true、motion_blueprint_intentionally_skipped=true。必须读取 quick-route-contract.json，按正式拆解、人物/产品素材、正式提示词与分段交接建立任务卡；不得套用锚帧路线要求分镜或动态预演，也不得退回补分镜。"
    : null;
  return buildSkillOwnedPrompt({
    contract: skillContract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      generation_route_choice: task.generation_route_choice,
      generation_model_selection: {
        provider: task.generation_model_snapshot?.provider || task.generation_provider || "libtv",
        quality_profile: task.generation_model_snapshot?.quality_profile || task.generation_quality_profile || "high",
        model_key: task.generation_model_key,
        selected_by: "user",
        selection_source: "workbench_current_generation_choice",
        selection_scope: "current_generation_attempt",
        explicit_selection: true,
        may_fall_back_to_default: false,
      },
      source_generation_facts: sourceGenerationFacts,
      remix_precision_route: task.remix_precision_route,
      quick_route_contract_path: evidenceProjection?.quickContractPath || null,
      generation_unit_authority: {
        owner_skill: "ai-video-generation-pack",
        upstream_prompt_handoff_authority: "content_only_non_authoritative_for_task_count",
        user_selection_source: "workbench_current_generation_choice",
        user_generation_unit_choice: task.generation_route_choice === "in_chat_libtv_generation" ? "full_sequence" : "smoke_test_first",
        user_generation_unit_choice_explicit: true,
      },
      project_evidence_index_path: indexPath,
      work_dir: taskDir,
      canonical_project_route: canonicalRoute,
      generation_evidence_projection: evidenceProjection,
      formal_preflight_project_dir: evidenceProjection?.projectionDir || null,
    },
    runtimeEnvelope: {
      external_requests_allowed: false,
      source_upload_allowed: false,
      video_generation_allowed: false,
      paid_execution_allowed: false,
      duplicate_project_creation_allowed: false,
      generation_unit_decision_contract: ["必须由 ai-video-generation-pack 根据当前正式 Skill 和客观项目证据独立决定 generation_unit。上游提示词条数、动作节点数、宫格格数及提示词交接中的逐镜建议均不能直接决定任务卡数量；发生冲突时以本 Skill 的粒度规则为准，并在预检中说明。", promptDrivenContract, h3MarginalOverrunContract, h3SegmentContract].filter(Boolean).join(" "),
      output_interface: { required_artifact_labels: ["视频生成任务包", "任务包预检"], published: false, estimated_cost_cny: 0 },
      user_message_policy: "只用大白话说明任务包状态和下一步；不能把任务包完成写成视频已生成。",
    },
  });
}

function assertGenerationUnitMatchesUserChoice(task, result) {
  if (task.generation_route_choice !== "in_chat_libtv_generation") return;
  const packArtifact = (result.artifacts || []).find((item) => /视频生成任务包/.test(item.label || ""));
  const taskCardsPath = resolveGenerationTaskCardsPath(packArtifact?.path);
  if (!taskCardsPath || !existsSync(taskCardsPath)) throw new Error("GENERATION_PACK_TASK_CARDS_MISSING");
  const taskCards = JSON.parse(readFileSync(taskCardsPath, "utf8"));
  const normalized = normalizeGenerationUnitDecision(taskCards);
  const provider = task.generation_model_snapshot?.provider || task.generation_provider || taskCards.provider || "libtv";
  if (provider === "runninghub_h3_multiref" && normalized.taskCount > 1) {
    const durations = normalized.cards.map((card) => Number(card.duration_seconds));
    const total = normalized.cards.reduce((sum, card) => sum + Number(card.trim_to_seconds || card.original_target_duration_seconds || card.duration_seconds || 0), 0);
    const target = Number(task.generation_model_snapshot?.target_duration_seconds || 0);
    const validSegments = normalized.taskCount <= 5 && durations.every((duration) => Number.isFinite(duration) && duration >= 1 && duration <= 15);
    if (validSegments && total + 0.35 >= target) return;
  }
  if (normalized.generationUnit !== "full_sequence" || normalized.taskCount !== 1) {
    const error = new Error("GENERATION_PACK_USER_FULL_SEQUENCE_SELECTION_CONFLICT");
    error.code = "GENERATION_PACK_USER_FULL_SEQUENCE_SELECTION_CONFLICT";
    error.external_request_started = false;
    error.video_generation_started = false;
    throw error;
  }
}

export function normalizeGenerationUnitDecision(taskCards) {
  const decision = taskCards?.generation_unit_decision || {};
  const cards = Array.isArray(taskCards?.task_cards)
    ? taskCards.task_cards
    : Array.isArray(taskCards?.generation_tasks)
      ? taskCards.generation_tasks
      : Array.isArray(taskCards?.tasks)
        ? taskCards.tasks
        : [];
  const declaredUnit = decision.generation_unit || decision.decision || taskCards?.generation_unit || null;
  const cardUnit = cards.length === 1 ? cards[0]?.generation_unit || cards[0]?.source_shot || null : null;
  return {
    generationUnit: declaredUnit || cardUnit,
    taskCount: cards.length,
    cards,
  };
}

export function buildSubmissionPreview(task, result) {
  const packArtifact = (result.artifacts || []).find((item) => /视频生成任务包/.test(item.label || ""));
  const taskCardsPath = resolveGenerationTaskCardsPath(packArtifact?.path);
  if (!taskCardsPath || !existsSync(taskCardsPath)) return result.submission_preview || null;
  const packDir = dirname(taskCardsPath);
  const taskCards = JSON.parse(readFileSync(taskCardsPath, "utf8"));
  const providerContract = taskCards.provider_contract && typeof taskCards.provider_contract === "object"
    ? taskCards.provider_contract
    : {};
  const normalized = normalizeGenerationUnitDecision(taskCards);
  if (normalized.taskCount < 1) return result.submission_preview || null;
  const card = normalized.cards[0];
  const modelPromptFile = card.model_prompt_file
    || card.model_prompt_path
    || card.prompt?.model_prompt_file
    || card.prompt?.compiled_prompt_path
    || card.prompt?.source_prompt_path
    || null;
  const promptPath = modelPromptFile ? (isAbsolute(modelPromptFile) ? modelPromptFile : join(packDir, modelPromptFile)) : null;
  const promptText = promptPath && existsSync(promptPath)
    ? readFileSync(promptPath, "utf8").trim()
    : card.model_prompt || card.prompt?.model_prompt || null;
  return {
    provider: taskCards.provider
      || providerContract.provider
      || task.generation_model_snapshot?.provider
      || task.generation_provider
      || "libtv",
    model_key: taskCards.model_key || providerContract.requested_model_key || task.generation_model_key,
    model_name: taskCards.model_name || task.generation_model_snapshot?.model_name || task.generation_model_key,
    sample_type: normalized.taskCount > 1 ? `分 ${normalized.taskCount} 段生成正式版` : normalized.generationUnit === "full_sequence" ? "直接生成正式版" : "4 秒关键动作小样",
    generation_kind: normalized.taskCount > 1 || normalized.generationUnit === "full_sequence" ? "full_sequence" : "smoke_test",
    duration_seconds: normalized.cards.reduce((sum, item) => sum + Number(item.trim_to_seconds || item.original_target_duration_seconds || item.duration_seconds || 0), 0),
    target_duration_seconds: Number(task.generation_model_snapshot?.target_duration_seconds || 0) || normalized.cards.reduce((sum, item) => sum + Number(item.trim_to_seconds || item.original_target_duration_seconds || item.duration_seconds || 0), 0),
    aspect_ratio: card.aspect_ratio || taskCards.aspect_ratio,
    resolution: card.resolution || taskCards.quality_parameter,
    generate_audio: Boolean(card.generate_audio),
    generation_count: normalized.taskCount,
    segment_durations_seconds: normalized.cards.map((item) => Number(item.duration_seconds)),
    effective_concurrency: Math.min(normalized.taskCount, 3),
    upload_assets: uniqueUploadAssets(normalized.cards, taskCards),
    prompt_path: promptPath,
    prompt_text: promptText,
    billable_submission_count_allowed: normalized.taskCount,
    automatic_retry: false,
    project_binding_status: task.libtv_project_uuid ? "dedicated_project_ready" : "not_checked",
    cost_quote_status: "reported_after_generation",
    billable_submission_allowed: false,
  };
}

function uniqueUploadAssets(cards, taskCards = {}) {
  if (Array.isArray(taskCards.asset_binding_manifest)) {
    return taskCards.asset_binding_manifest
      .filter((item) => item.upload_to_video_model !== false)
      .map((item) => ({
        alias: item.alias,
        role: item.role || item.control_scope || item.asset_role,
        filename: item.path?.split("/").pop(),
      }));
  }
  const seen = new Set();
  const assets = [];
  for (const card of cards) for (const item of card.references || []) {
    if (item.upload_to_video_model === false) continue;
    const key = `${item.alias || ""}|${item.path || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assets.push({ alias: item.alias, role: item.role || item.control_scope || item.asset_role, filename: item.path?.split("/").pop() });
  }
  return assets;
}

export function resolveGenerationPackDir(artifactPath) {
  if (!artifactPath || !existsSync(artifactPath)) return null;
  try {
    return statSync(artifactPath).isDirectory() ? artifactPath : dirname(artifactPath);
  } catch {
    return null;
  }
}

export function resolveGenerationTaskCardsPath(artifactPath) {
  if (!artifactPath || !existsSync(artifactPath)) return null;
  try {
    if (statSync(artifactPath).isFile() && artifactPath.endsWith(".json")) {
      const payload = JSON.parse(readFileSync(artifactPath, "utf8"));
      if (normalizeGenerationUnitDecision(payload).taskCount > 0)
        return artifactPath;
    }
  } catch { /* fall through to legacy directory package */ }
  const packDir = resolveGenerationPackDir(artifactPath);
  const legacyPath = packDir ? join(packDir, "generation_tasks.json") : null;
  return legacyPath && existsSync(legacyPath) ? legacyPath : null;
}

export function readReusableGenerationPackResult(resultPath, task) {
  if (!resultPath || !existsSync(resultPath)) return null;
  try {
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    if (result.status !== "completed") return null;
    const packArtifact = (result.artifacts || []).find((item) =>
      /视频生成任务包/.test(item.label || ""),
    );
    const taskCardsPath = resolveGenerationTaskCardsPath(packArtifact?.path);
    if (!taskCardsPath) return null;
    const taskCards = JSON.parse(readFileSync(taskCardsPath, "utf8"));
    const provider =
      task.generation_model_snapshot?.provider ||
      task.generation_provider ||
      "libtv";
    const quality =
      task.generation_model_snapshot?.quality_profile ||
      task.generation_quality_profile ||
      "high";
    if (taskCards.task_id !== task.id) return null;
    if ((taskCards.provider || "libtv") !== provider) return null;
    if (taskCards.model_key !== task.generation_model_key) return null;
    if ((taskCards.quality_profile || "high") !== quality) return null;
    assertGenerationUnitMatchesUserChoice(task, result);
    return result;
  } catch {
    return null;
  }
}

export function readSourceGenerationFacts(taskDir) {
  const semanticPath = join(taskDir, "01_source_video_analysis", "semantic-merge.json");
  if (!existsSync(semanticPath)) return { semantic_path: semanticPath, evidence_status: "missing" };
  try {
    const semantic = JSON.parse(readFileSync(semanticPath, "utf8"));
    const visualShotCount = Number(semantic.semantic_drafts?.[0]?.visual_shot_count ?? semantic.visual_shots?.length ?? 0) || null;
    return {
      semantic_path: semanticPath,
      evidence_status: "ready",
      duration_seconds: Number(semantic.video_meta?.duration_seconds ?? 0) || null,
      aspect_ratio: semantic.video_meta?.aspect_ratio || null,
      visual_shot_count: visualShotCount,
      cut_point_count: Number(semantic.semantic_drafts?.[0]?.cut_point_count ?? semantic.merged_cut_candidates?.length ?? 0) || 0,
    };
  } catch {
    return { semantic_path: semanticPath, evidence_status: "unreadable" };
  }
}

function runProcess(command, args, { env, onEvent, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("GENERATION_PACK_TIMEOUT")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); onEvent?.(chunk.toString().trim().slice(0, 300)); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr || stdout || `GENERATION_PACK_EXIT_${code}`));
    });
  });
}
