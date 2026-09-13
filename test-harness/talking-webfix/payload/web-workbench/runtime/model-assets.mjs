import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import {
  compileLockedRealPersonGenerationPrompt,
  compileStyledIdentityCloseupPrompt,
  REAL_PERSON_PROMPT_FILES,
  REAL_PERSON_STAGE_ORDER,
} from "./real-person-stage-contracts.mjs";

const IMAGE_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
]);

const SOURCE_CATEGORIES = new Set([
  "identity_source",
  "hair_reference",
  "wardrobe_reference",
  "body_identity_reference",
  "scene_reference",
  "atmosphere_reference",
  "benchmark_style_reference",
  "pose_reference",
  "styled_identity_anchor",
  "face_outline_reference",
  "eye_reference",
  "nose_lip_reference",
  "style_vibe_reference",
  "deidentify_source",
  "person_a_reference",
  "person_b_reference",
  "user_revision",
]);

const REAL_PERSON_STAGES = new Set([
  "v0",
  "appearance_bridge",
  "styled_anchor",
  "performance_master",
  "current_shot",
]);

const AI_SOURCE_METHODS = new Set([
  "original",
  "multi_reference_fusion",
  "single_reference_deidentify",
  "two_person_middle_face",
]);

export function createModelAssetProject(root, input) {
  const route = input.route === "real_person" ? "real_person" : "ai_model";
  const aiSourceMethod = route === "ai_model" && AI_SOURCE_METHODS.has(input.aiSourceMethod)
    ? input.aiSourceMethod
    : "original";
  if (route === "real_person" && input.authorizationConfirmed !== true)
    throw modelAssetError(
      "MODEL_ASSET_AUTHORIZATION_REQUIRED",
      "使用本人或指定真人前，请先确认已经取得肖像授权。",
    );
  const id = randomUUID();
  const stamp = new Date().toISOString();
  const project = {
    schema_version: 3,
    id,
    name: cleanText(input.name, 100) || (route === "ai_model" ? "未命名 AI 模特" : "未命名真人模特"),
    route,
    route_state: "formal",
    ai_source_method: route === "ai_model" ? aiSourceMethod : null,
    brief: cleanText(input.brief, 4000),
    ai_design_direction_confirmed:
      route === "ai_model" && aiSourceMethod === "original"
        ? input.designDirectionConfirmed === true
        : false,
    authorization_confirmed: route === "real_person",
    default_generation_provider:
      input.defaultGenerationProvider === "chatgpt_web" ? "chatgpt_web" : "codex_builtin",
    status: "draft",
    generation_attempt_count: 0,
    active_attempt: null,
    assets: [],
    approved_asset_id: null,
    library_archived_at: null,
    workflow_stage: route === "real_person" ? "intake" : "v0",
    ai_workflow_stage: route === "ai_model" && aiSourceMethod === "single_reference_deidentify"
      ? "deidentify_bridge"
      : route === "ai_model" ? "v0" : null,
    ai_active_bridge_asset_id: null,
    ai_talking_asset_id: null,
    active_asset_lock: route === "real_person" ? {
      v0_asset_id: null,
      appearance_bridge_asset_id: null,
      styled_anchor_asset_id: null,
      performance_master_asset_id: null,
      current_shot_asset_id: null,
    } : null,
    style_analysis_attempt_count: 0,
    talking_style_analysis: null,
    created_at: stamp,
    updated_at: stamp,
  };
  const projectDir = join(root, id);
  mkdirSync(projectDir, { recursive: true });
  writeProject(projectDir, project, true);
  return publicModelAssetProject(project);
}

export function listModelAssetProjects(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readProject(join(root, entry.name)))
    .filter(Boolean)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .map(publicModelAssetProject);
}

export function recoverInterruptedModelAssetGenerations(root) {
  if (!existsSync(root)) return 0;
  let recovered = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(root, entry.name);
    const project = readProject(projectDir);
    if (!project || project.status !== "running" || !project.active_attempt) continue;
    const attemptNumber = Number(project.active_attempt.attempt_number || 0);
    const resultPath = join(
      projectDir,
      "runs",
      `attempt-${attemptNumber}`,
      `person-result-attempt-${attemptNumber}.json`,
    );
    if (existsSync(resultPath)) {
      try {
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        const candidatePath = findCandidatePath(result);
        if (result.status === "completed" && candidatePath && existsSync(candidatePath)) {
          finishModelAssetGeneration(root, project.id, result);
          recovered += 1;
          continue;
        }
      } catch {
        // Incomplete or invalid result files remain blocked for a safe manual retry.
      }
    }
    project.status = "blocked";
    project.last_error =
      "工作台后台在生成过程中重新启动，本次回写已中断。为防止页面无限等待，已停止本次任务；原素材和分析结果都已保留，可以重新生成。";
    project.active_attempt.interrupted_by_runtime_restart = true;
    project.updated_at = new Date().toISOString();
    writeProject(projectDir, project);
    recovered += 1;
  }
  return recovered;
}

export function getModelAssetProject(root, projectId) {
  if (!isUuid(projectId)) return null;
  const project = readProject(join(root, projectId));
  return project ? publicModelAssetProject(project) : null;
}

export function getInternalModelAssetProject(root, projectId) {
  if (!isUuid(projectId)) return null;
  return readProject(join(root, projectId));
}

export function setModelAssetLibraryArchived(root, projectId, archived) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  project.library_archived_at = archived === true ? new Date().toISOString() : null;
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return publicModelAssetProject(project);
}

export async function addModelAssetSource({ root, projectId, file, category, assetStage, revisesAssetId }) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  if (!(file instanceof File) || file.size === 0)
    throw modelAssetError("MODEL_ASSET_FILE_MISSING", "请先选择一张图片。");
  if (!SOURCE_CATEGORIES.has(category))
    throw modelAssetError("MODEL_ASSET_CATEGORY_INVALID", "请选择这张图片的用途。");
  let revisionStage = null;
  let revisionParent = null;
  if (category === "user_revision") {
    revisionParent = requireAsset(project, revisesAssetId);
    revisionStage = normalizeRealPersonStage(assetStage || revisionParent.asset_stage);
    if (!revisionStage)
      throw modelAssetError("MODEL_ASSET_REVISION_STAGE_REQUIRED", "请先选择这张修正版对应的人物资产阶段。");
  }
  const extension = IMAGE_TYPES.get(file.type) || safeImageExtension(file.name);
  if (!extension)
    throw modelAssetError("MODEL_ASSET_TYPE_UNSUPPORTED", "只支持 PNG、JPG 或 WebP 图片。");
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) throw modelAssetError("MODEL_ASSET_FILE_EMPTY", "这张图片没有可读取的内容。");
  const assetId = randomUUID();
  const assetDir = join(projectDir, "assets", assetId);
  const path = join(assetDir, `source${extension}`);
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(path, buffer, { flag: "wx" });
  const asset = {
    asset_id: assetId,
    project_id: project.id,
    category,
    source_kind: "user_upload",
    original_name: safeDisplayName(file.name),
    mime_type: file.type || mimeFromExtension(extension),
    size_bytes: buffer.length,
    sha256: sha256Buffer(buffer),
    path,
    status: category === "user_revision" ? "candidate" : "source_ready",
    generation_provider: null,
    attempt_number: null,
    asset_stage: revisionStage,
    parent_asset_ids: revisionParent ? [revisionParent.asset_id] : [],
    revises_asset_id: revisionParent?.asset_id || null,
    created_at: new Date().toISOString(),
  };
  project.assets.push(asset);
  project.status = category === "user_revision" ? "needs_review" : "source_ready";
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return { project: publicModelAssetProject(project), asset: publicAsset(asset) };
}

export async function importReadyModelMaster({ root, projectId, file }) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  if (!(file instanceof File) || file.size === 0)
    throw modelAssetError("MODEL_ASSET_FILE_MISSING", "请先选择一张模特母版图。");
  const extension = IMAGE_TYPES.get(file.type) || safeImageExtension(file.name);
  if (!extension)
    throw modelAssetError("MODEL_ASSET_TYPE_UNSUPPORTED", "模特母版只支持 PNG、JPG 或 WebP 图片。");
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) throw modelAssetError("MODEL_ASSET_FILE_EMPTY", "这张模特母版没有可读取的内容。");
  const assetId = randomUUID();
  const assetDir = join(projectDir, "assets", assetId);
  const path = join(assetDir, `source${extension}`);
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(path, buffer, { flag: "wx" });
  const stage = project.route === "real_person" ? "styled_anchor" : "v0";
  const stamp = new Date().toISOString();
  const asset = {
    asset_id: assetId,
    project_id: project.id,
    category: "imported_master",
    source_kind: "user_upload",
    original_name: safeDisplayName(file.name),
    mime_type: file.type || mimeFromExtension(extension),
    size_bytes: buffer.length,
    sha256: sha256Buffer(buffer),
    path,
    status: "approved",
    generation_provider: null,
    attempt_number: null,
    asset_stage: stage,
    parent_asset_ids: [],
    revises_asset_id: null,
    approved_at: stamp,
    created_at: stamp,
  };
  project.assets.push(asset);
  project.approved_asset_id = assetId;
  project.status = "approved";
  if (project.route === "real_person") {
    project.active_asset_lock = {
      v0_asset_id: assetId,
      appearance_bridge_asset_id: assetId,
      styled_anchor_asset_id: assetId,
      performance_master_asset_id: null,
      current_shot_asset_id: null,
    };
    project.workflow_stage = "performance_master";
  }
  project.updated_at = stamp;
  writeProject(projectDir, project);
  return { project: publicModelAssetProject(project), asset: publicAsset(asset) };
}

export function prepareModelAssetGeneration(root, projectId, input) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  if (project.status === "running")
    throw modelAssetError("MODEL_ASSET_GENERATION_RUNNING", "当前已经有一次生成在进行中，请等待结果返回。");
  const provider = input.provider === "chatgpt_web" ? "chatgpt_web" : "codex_builtin";
  const referenceIds = Array.isArray(input.referenceAssetIds)
    ? [...new Set(input.referenceAssetIds.map(String))]
    : [];
  const references = referenceIds.map((assetId) => requireAsset(project, assetId));
  const talkingStyleGeneration = input.useTalkingStyleAnalysis === true;
  const auxiliaryMode = project.route === "real_person" && input.auxiliaryMode === "styled_identity_closeup"
    ? "styled_identity_closeup"
    : null;
  if (references.some((asset) => asset.category === "benchmark_style_reference"))
    throw modelAssetError("MODEL_ASSET_BENCHMARK_ANALYSIS_ONLY", "口播对标图只用于分析画面风格，不能和人物母版一起提交生图。");
  if (references.some((asset) => !existsAndMatches(asset)))
    throw modelAssetError("MODEL_ASSET_REFERENCE_INVALID", "有一张参考图已经失效，请重新上传或取消选择。");
  if (provider === "codex_builtin" && references.length > 5)
    throw modelAssetError("MODEL_ASSET_CODEX_REFERENCE_LIMIT", "Codex 内置生图本次最多选择 5 张参考图。");
  if (project.route === "real_person") {
    if (!project.authorization_confirmed)
      throw modelAssetError("MODEL_ASSET_AUTHORIZATION_REQUIRED", "真人模特路线缺少肖像授权确认。");
    if (auxiliaryMode) {
      validateStyledIdentityCloseupReferences(project, references);
    } else {
      const assetStage = normalizeRealPersonStage(input.assetStage);
      if (!assetStage)
        throw modelAssetError("MODEL_ASSET_STAGE_REQUIRED", "请先选择这次要生成哪一层真人资产。");
      if (assetStage === "v0" && !references.some((asset) => ["identity_source", "user_revision"].includes(asset.category)))
        throw modelAssetError("MODEL_ASSET_IDENTITY_SOURCE_REQUIRED", "生成 v0 至少要选择一张本人身份照片。");
      validateRealPersonStageReferences(project, assetStage, references);
    }
  } else if (talkingStyleGeneration) {
    if (input.assetStage !== "current_shot")
      throw modelAssetError("MODEL_STYLE_ASSET_STAGE_REQUIRED", "口播画面复刻必须生成一张新的口播镜头母版。");
    validateAiTalkingStyleReferences(project, references);
  } else {
    validateAiModelReferences(project, references);
  }
  if (input.uploadAuthorized !== true && references.length > 0)
    throw modelAssetError("MODEL_ASSET_UPLOAD_AUTHORIZATION_REQUIRED", "请先确认允许上传本次勾选的参考图。");
  project.generation_attempt_count += 1;
  const realPersonPromptContract = project.route === "real_person" && !talkingStyleGeneration
    ? auxiliaryMode
      ? compileStyledIdentityCloseupPrompt(input.instruction)
      : compileLockedRealPersonGenerationPrompt(normalizeRealPersonStage(input.assetStage), input.instruction)
    : null;
  project.active_attempt = {
    attempt_id: randomUUID(),
    attempt_number: project.generation_attempt_count,
    provider,
    reference_asset_ids: referenceIds,
    instruction: cleanText(input.instruction, 4000),
    final_prompt: realPersonPromptContract?.final_prompt || null,
    final_prompt_sha256: realPersonPromptContract
      ? sha256Buffer(Buffer.from(realPersonPromptContract.final_prompt, "utf8"))
      : null,
    stage_prompt_contract: realPersonPromptContract ? {
      filename: realPersonPromptContract.filename,
      sha256: realPersonPromptContract.sha256,
    } : null,
    auxiliary_mode: auxiliaryMode,
    resume_status: auxiliaryMode ? project.status : null,
    asset_stage: auxiliaryMode
      ? null
      : project.route === "real_person"
      ? normalizeRealPersonStage(input.assetStage)
      : talkingStyleGeneration ? "current_shot" : currentAiAssetStage(project),
    parent_asset_ids: Array.isArray(input.parentAssetIds)
      ? [...new Set(input.parentAssetIds.map(String))].filter((id) => references.some((asset) =>
        asset.asset_id === id || asset.derived_from_asset_id === id
      ))
      : [],
    upload_authorized: input.uploadAuthorized === true,
    external_request_started: false,
    progress_stage: "planning",
    progress_message: "人物 Skill 正在准备生成任务；尚未进入正式生图。",
    progress_updated_at: new Date().toISOString(),
    talking_style_analysis: talkingStyleGeneration
      ? approvedTalkingStyleAnalysis(project)
      : null,
    started_at: new Date().toISOString(),
  };
  project.default_generation_provider = provider;
  project.status = "running";
  project.last_error = null;
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return { project: publicModelAssetProject(project), references };
}

export function recordModelAssetGenerationProgress(root, projectId, message) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  if (project.status !== "running" || !project.active_attempt) return publicModelAssetProject(project);
  const next = classifyGenerationProgress(message);
  const rank = { planning: 0, preflight: 1, generating: 2, finalizing: 3 };
  const current = project.active_attempt.progress_stage || "planning";
  if ((rank[next.stage] ?? 0) < (rank[current] ?? 0)) return publicModelAssetProject(project);
  if (next.stage === current && next.message === project.active_attempt.progress_message)
    return publicModelAssetProject(project);
  project.active_attempt.progress_stage = next.stage;
  project.active_attempt.progress_message = next.message;
  project.active_attempt.progress_updated_at = new Date().toISOString();
  project.updated_at = project.active_attempt.progress_updated_at;
  writeProject(projectDir, project);
  return publicModelAssetProject(project);
}

function classifyGenerationProgress(value) {
  const message = String(value || "");
  if (/task_close|close_receipt|register-tree|execution_receipt|收尾|登记|回写/.test(message))
    return { stage: "finalizing", message: "图片已返回，正在登记来源并回写当前项目。" };
  if (/图片已经返回，正在保存/.test(message))
    return { stage: "finalizing", message: "图片已经返回，正在保存到当前项目。" };
  if (/imagegen-return|image_gen|正在生图|等待 1 张结果|干净生图执行单元已启动|正在生成本次唯一一张图片/.test(message))
    return { stage: "generating", message: "前置检查已通过，正在执行本次唯一一张生图。" };
  if (/正在开始本次唯一一张图片生成/.test(message))
    return { stage: "generating", message: "人物与画面要求已确认，正在生成本次唯一一张图片。" };
  if (/preflight|前检|预检|任务卡|参考图职责|干净生图执行|即将开始唯一一次生图请求/.test(message))
    return { stage: "preflight", message: "正在核对任务卡、参考图职责和上传范围；尚未正式生图。" };
  return { stage: "planning", message: "人物 Skill 正在准备生成任务；尚未进入正式生图。" };
}

export function prepareModelStyleAnalysis(root, projectId, input) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  if (project.route === "real_person" && !activeRealPersonLock(project).performance_master_asset_id)
    throw modelAssetError("MODEL_STYLE_BASE_ASSET_REQUIRED", "请先采用神态姿态母版，再复刻画质与氛围。");
  if (project.route === "ai_model" && !project.approved_asset_id)
    throw modelAssetError("MODEL_STYLE_BASE_ASSET_REQUIRED", "请先采用一张正式 AI 模特母版，再制作口播母版。");
  if (project.talking_style_analysis?.status === "running")
    throw modelAssetError("MODEL_STYLE_ANALYSIS_RUNNING", "当前对标图正在分析，请等待结果返回。");
  const benchmark = requireAsset(project, String(input.benchmarkAssetId || ""));
  if (benchmark.category !== "benchmark_style_reference")
    throw modelAssetError("MODEL_STYLE_BENCHMARK_REQUIRED", "请选择一张口播对标图。");
  if (!existsAndMatches(benchmark))
    throw modelAssetError("MODEL_ASSET_REFERENCE_INVALID", "这张对标图已经失效，请重新上传。");
  if (input.uploadAuthorized !== true)
    throw modelAssetError("MODEL_STYLE_UPLOAD_AUTHORIZATION_REQUIRED", "请先确认允许上传这张对标图用于画面分析。");
  project.style_analysis_attempt_count = Number(project.style_analysis_attempt_count || 0) + 1;
  project.talking_style_analysis = {
    analysis_id: randomUUID(),
    attempt_number: project.style_analysis_attempt_count,
    benchmark_asset_id: benchmark.asset_id,
    benchmark_sha256: benchmark.sha256,
    benchmark_usage: "analysis_only",
    status: "running",
    approval_status: "pending",
    locked_template_sha256: project.route === "real_person"
      ? REAL_PERSON_PROMPT_FILES.style_compiler.sha256
      : "af51d24bc887c33c1273c72920839b377b19cf6b5ad26dc14489229ba1401fbb",
    reverse_prompt_type: project.route === "real_person"
      ? "causal_calibrated_visual_reconstruction_v3"
      : "talking_head_master_style",
    text_overlay_policy: "ignore_completely",
    reference_person_identity_policy: "do_not_extract",
    final_generation_benchmark_reference_included: false,
    started_at: new Date().toISOString(),
  };
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return { project: publicModelAssetProject(project), benchmark };
}

export function finishModelStyleAnalysis(root, projectId, result) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  const analysis = project.talking_style_analysis;
  if (!analysis || analysis.status !== "running")
    throw modelAssetError("MODEL_STYLE_ANALYSIS_MISSING", "没有找到本次对标图分析记录。");
  const conclusion = cleanText(result.reverse_conclusion, 12000);
  const prompt = cleanText(result.generation_prompt, 30000);
  if (!conclusion || !prompt)
    throw modelAssetError("MODEL_STYLE_ANALYSIS_INCOMPLETE", "对标图分析没有返回完整的反推结论和生图提示词。");
  project.talking_style_analysis = {
    ...analysis,
    status: "needs_review",
    approval_status: "needs_review",
    reverse_conclusion: conclusion,
    generation_prompt: prompt,
    generation_prompt_sha256: sha256Buffer(Buffer.from(prompt, "utf8")),
    summary: cleanText(result.summary, 1200),
    completed_at: new Date().toISOString(),
  };
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return publicModelAssetProject(project);
}

export function failModelStyleAnalysis(root, projectId, error) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  project.talking_style_analysis = {
    ...(project.talking_style_analysis || {}),
    status: "failed",
    approval_status: "pending",
    error: cleanText(error?.message || error, 1200),
    failed_at: new Date().toISOString(),
  };
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return publicModelAssetProject(project);
}

export function approveModelStylePrompt(root, projectId, promptInput) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  const analysis = project.talking_style_analysis;
  if (!analysis || !["needs_review", "approved"].includes(analysis.status))
    throw modelAssetError("MODEL_STYLE_ANALYSIS_NOT_REVIEWABLE", "请先完成一次对标图画面分析。");
  const prompt = cleanText(promptInput, 30000);
  if (!prompt) throw modelAssetError("MODEL_STYLE_PROMPT_REQUIRED", "反推提示词不能为空。");
  project.talking_style_analysis = {
    ...analysis,
    status: "approved",
    approval_status: "approved",
    approved_generation_prompt: prompt,
    approved_generation_prompt_sha256: sha256Buffer(Buffer.from(prompt, "utf8")),
    approved_at: new Date().toISOString(),
  };
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return publicModelAssetProject(project);
}

export function finishModelAssetGeneration(root, projectId, result) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  const attempt = project.active_attempt;
  if (!attempt) throw modelAssetError("MODEL_ASSET_ATTEMPT_MISSING", "没有找到本次生成记录。");
  const candidatePath = findCandidatePath(result);
  if (!candidatePath || !existsSync(candidatePath) || !statSync(candidatePath).isFile())
    throw modelAssetError("MODEL_ASSET_CANDIDATE_MISSING", "生成结果没有形成可读取的人物图片。");
  const buffer = readFileSync(candidatePath);
  const closeupHelper = attempt.auxiliary_mode === "styled_identity_closeup";
  const extension = safeImageExtension(candidatePath) || ".png";
  const aiCandidateName = attempt.asset_stage === "deidentify_bridge"
    ? `去身份过桥图-第${attempt.attempt_number}版${extension}`
    : `AI模特v0-第${attempt.attempt_number}版${extension}`;
  const asset = {
    asset_id: randomUUID(),
    project_id: project.id,
    category: closeupHelper ? "styled_identity_anchor" : "generated_candidate",
    source_kind: "generated",
    original_name: closeupHelper
      ? `近景身份图-第${attempt.attempt_number}版${extension}`
      : project.route === "ai_model" ? aiCandidateName : basename(candidatePath),
    mime_type: mimeFromExtension(extname(candidatePath)),
    size_bytes: buffer.length,
    sha256: sha256Buffer(buffer),
    path: candidatePath,
    status: closeupHelper ? "source_ready" : "candidate",
    generation_provider: attempt.provider,
    attempt_number: Number(result.recovered_attempt_number) || attempt.attempt_number,
    asset_stage: closeupHelper ? null : attempt.asset_stage || "v0",
    parent_asset_ids: attempt.parent_asset_ids || [],
    derived_from_asset_id: closeupHelper ? attempt.reference_asset_ids?.[1] || null : null,
    identity_source_asset_id: closeupHelper ? attempt.reference_asset_ids?.[0] || null : null,
    revises_asset_id: null,
    execution_summary: cleanText(result.summary, 1000),
    created_at: new Date().toISOString(),
  };
  project.assets.push(asset);
  project.status = closeupHelper ? attempt.resume_status || "approved" : "needs_review";
  project.active_attempt = null;
  project.last_error = null;
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return { project: publicModelAssetProject(project), asset: publicAsset(asset) };
}

export function failModelAssetGeneration(root, projectId, error, externalRequestStarted = false) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  const closeupHelper = project.active_attempt?.auxiliary_mode === "styled_identity_closeup";
  if (closeupHelper) {
    project.status = project.active_attempt.resume_status || "approved";
    project.last_error = `近景身份图没有生成成功：${cleanText(error?.message || error, 1000)}`;
    project.active_attempt = null;
    project.updated_at = new Date().toISOString();
    writeProject(projectDir, project);
    return publicModelAssetProject(project);
  }
  project.status = externalRequestStarted ? "failed_after_submit" : "blocked";
  const rawError = cleanText(error?.message || error, 1200);
  project.last_error = project.active_attempt?.provider === "chatgpt_web"
    && externalRequestStarted !== true
    && /Codex 后台执行等待超时/.test(rawError)
      ? "生图前的人物请求整理等待超时，尚未提交到 ChatGPT。请稍后从当前项目重新生成。"
      : rawError;
  if (project.active_attempt)
    project.active_attempt.external_request_started = externalRequestStarted === true;
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return publicModelAssetProject(project);
}

export function adoptModelAsset(root, projectId, assetId) {
  const projectDir = projectDirectory(root, projectId);
  const project = requireProject(projectDir);
  const asset = requireAsset(project, assetId);
  if (!["candidate", "approved"].includes(asset.status))
    throw modelAssetError("MODEL_ASSET_NOT_ADOPTABLE", "这张图片还不能采用为正式模特母版。");
  if (!existsAndMatches(asset))
    throw modelAssetError("MODEL_ASSET_FILE_CHANGED", "这张图片的文件内容已经变化，不能继续采用。");
  const stage = project.route === "real_person"
    ? normalizeRealPersonStage(asset.asset_stage)
    : asset.asset_stage === "current_shot" ? "current_shot" : "v0";
  if (project.route === "real_person" && !stage)
    throw modelAssetError("MODEL_ASSET_STAGE_REQUIRED", "这张候选缺少真人资产阶段，不能采用。");
  for (const item of project.assets) {
    if (item.status === "approved" && item.asset_stage === stage)
      item.status = "candidate";
  }
  asset.status = "approved";
  asset.approved_at = new Date().toISOString();
  const isAiBridge = project.route === "ai_model"
    && project.ai_source_method === "single_reference_deidentify"
    && asset.asset_stage === "deidentify_bridge";
  const isAiTalkingShot = project.route === "ai_model" && stage === "current_shot";
  if (!isAiTalkingShot) project.approved_asset_id = isAiBridge ? null : asset.asset_id;
  if (project.route === "real_person") {
    project.active_asset_lock ||= {
      v0_asset_id: null,
      appearance_bridge_asset_id: null,
      styled_anchor_asset_id: null,
      performance_master_asset_id: null,
      current_shot_asset_id: null,
    };
    project.active_asset_lock[`${stage}_asset_id`] = asset.asset_id;
    invalidateDownstreamRealPersonLocks(project, stage);
    project.workflow_stage = stage === "current_shot" ? "ready_for_talking" : nextRealPersonStage(stage);
  } else if (isAiTalkingShot) {
    project.ai_talking_asset_id = asset.asset_id;
    project.workflow_stage = "ready_for_talking";
  } else if (isAiBridge) {
    project.ai_active_bridge_asset_id = asset.asset_id;
    project.ai_workflow_stage = "v0";
    project.workflow_stage = "v0";
  } else {
    const staleTalkingId = project.ai_talking_asset_id;
    const staleTalkingAsset = project.assets.find((item) => item.asset_id === staleTalkingId);
    if (staleTalkingAsset?.status === "approved") staleTalkingAsset.status = "candidate";
    project.ai_talking_asset_id = null;
  }
  project.status = isAiBridge ? "source_ready" : "approved";
  project.active_attempt = null;
  project.last_error = null;
  project.updated_at = new Date().toISOString();
  writeProject(projectDir, project);
  return { project: publicModelAssetProject(project), asset: publicAsset(asset) };
}

export function getModelAssetFile(root, projectId, assetId) {
  const project = getInternalModelAssetProject(root, projectId);
  if (!project) return null;
  const asset = project.assets.find((item) => item.asset_id === assetId);
  return asset && existsAndMatches(asset) ? asset : null;
}

export function getApprovedModelAsset(root, projectId) {
  const project = getInternalModelAssetProject(root, projectId);
  if (!project?.approved_asset_id) return null;
  const approvedId = project.route === "real_person" && project.schema_version >= 2
    ? project.active_asset_lock?.current_shot_asset_id
    : project.ai_talking_asset_id || project.approved_asset_id;
  if (!approvedId) return null;
  const asset = project.assets.find((item) => item.asset_id === approvedId);
  return asset && existsAndMatches(asset) ? { project, asset } : null;
}

export function publicModelAssetProject(project) {
  const activeAssetLock = project.route === "real_person" ? activeRealPersonLock(project) : project.active_asset_lock;
  const activeAttempt = project.active_attempt ? { ...project.active_attempt } : null;
  if (activeAttempt) delete activeAttempt.final_prompt;
  return {
    ...project,
    route_state: "formal",
    active_asset_lock: activeAssetLock,
    active_attempt: activeAttempt,
    assets: project.assets.map(publicAsset),
  };
}

function publicAsset(asset) {
  const safe = { ...asset };
  delete safe.path;
  return safe;
}

function requireProject(projectDir) {
  const project = readProject(projectDir);
  if (!project) throw modelAssetError("MODEL_ASSET_PROJECT_NOT_FOUND", "没有找到这个模特资产项目。");
  return project;
}

function requireAsset(project, assetId) {
  const asset = project.assets.find((item) => item.asset_id === assetId);
  if (!asset) throw modelAssetError("MODEL_ASSET_FILE_NOT_FOUND", "没有找到这张项目图片。");
  return asset;
}

function readProject(projectDir) {
  const path = join(projectDir, "project.json");
  if (!existsSync(path)) return null;
  try {
    const project = JSON.parse(readFileSync(path, "utf8"));
    if (!isUuid(project.id) || !Array.isArray(project.assets)) return null;
    return project;
  } catch {
    return null;
  }
}

function writeProject(projectDir, project, exclusive = false) {
  writeFileSync(
    join(projectDir, "project.json"),
    `${JSON.stringify(project, null, 2)}\n`,
    exclusive ? { flag: "wx" } : undefined,
  );
}

function projectDirectory(root, projectId) {
  if (!isUuid(projectId)) throw modelAssetError("MODEL_ASSET_PROJECT_ID_INVALID", "当前模特项目标识无效。");
  return join(root, projectId);
}

function existsAndMatches(asset) {
  if (!asset.path || !existsSync(asset.path)) return false;
  try {
    const buffer = readFileSync(asset.path);
    return buffer.length === asset.size_bytes && sha256Buffer(buffer) === asset.sha256;
  } catch {
    return false;
  }
}

function findCandidatePath(result) {
  const imageArtifact = (result?.artifacts || []).find(
    (item) => item?.path && /\.(png|jpe?g|webp)$/i.test(item.path),
  );
  return imageArtifact?.path || "";
}

function safeImageExtension(name) {
  const extension = extname(String(name || "")).toLowerCase();
  return /^\.(png|jpe?g|webp)$/.test(extension) ? (extension === ".jpeg" ? ".jpg" : extension) : "";
}

function mimeFromExtension(extension) {
  const normalized = String(extension).toLowerCase();
  if (normalized === ".png") return "image/png";
  if (normalized === ".webp") return "image/webp";
  return "image/jpeg";
}

function safeDisplayName(value) {
  return cleanText(value, 120).replace(/[\\/]/g, "_") || "模特参考图";
}

function cleanText(value, limit) {
  return String(value || "").replace(/\0/g, "").trim().slice(0, limit);
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isUuid(value) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(value || ""));
}

function modelAssetError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.external_request_started = false;
  return error;
}

function normalizeRealPersonStage(value) {
  const stage = String(value || "");
  return REAL_PERSON_STAGES.has(stage) ? stage : null;
}

function nextRealPersonStage(stage) {
  if (stage === "v0") return "appearance_bridge";
  if (stage === "appearance_bridge") return "styled_anchor";
  if (stage === "styled_anchor") return "performance_master";
  if (stage === "performance_master") return "current_shot";
  return "ready_for_talking";
}

function validateRealPersonStageReferences(project, stage, references) {
  const lock = activeRealPersonLock(project);
  if (stage === "v0") {
    if (references.length < 1 || references.length > 5 || references.some((asset) => asset.category !== "identity_source"))
      throw modelAssetError("MODEL_ASSET_V0_REFERENCE_SCOPE", "第 1 步只使用 1–5 张本人照片。");
    return;
  }
  if (stage === "appearance_bridge") {
    if (!lock.v0_asset_id || references[0]?.asset_id !== lock.v0_asset_id)
      throw modelAssetError("MODEL_ASSET_ACTIVE_V0_REQUIRED", "请先采用商业身份母版，并把它作为第 1 张参考图。");
    if (references.length < 2 || references.slice(1).some((asset) => asset.category !== "hair_reference"))
      throw modelAssetError("MODEL_ASSET_HAIR_REFERENCE_REQUIRED", "第 2 步需要商业身份母版和至少 1 张发型参考图。");
    return;
  }
  if (stage === "styled_anchor") {
    if (!lock.appearance_bridge_asset_id || references[0]?.asset_id !== lock.appearance_bridge_asset_id)
      throw modelAssetError("MODEL_ASSET_APPEARANCE_MASTER_REQUIRED", "请先采用发型母版，并把它作为第 1 张参考图。");
    const remaining = references.slice(1);
    const bodyReferences = remaining.filter((asset) => asset.category === "body_identity_reference");
    const wardrobeReferences = remaining.filter((asset) => asset.category === "wardrobe_reference");
    if (bodyReferences.length > 1 || wardrobeReferences.length < 1 || remaining.some((asset) => !["body_identity_reference", "wardrobe_reference"].includes(asset.category)))
      throw modelAssetError("MODEL_ASSET_OUTFIT_REFERENCE_REQUIRED", "第 3 步需要发型母版和穿搭参考；身体比例照最多 1 张。");
    if (bodyReferences.length === 1 && remaining[0].category !== "body_identity_reference")
      throw modelAssetError("MODEL_ASSET_BODY_REFERENCE_ORDER", "身体比例照需要放在发型母版之后、穿搭参考之前。");
    return;
  }
  if (stage === "performance_master") {
    const identityReference = references[0];
    const validIdentityReference = identityReference?.asset_id === lock.styled_anchor_asset_id
      || identityReference?.category === "styled_identity_anchor";
    if (!lock.styled_anchor_asset_id || !validIdentityReference)
      throw modelAssetError("MODEL_ASSET_STYLED_ANCHOR_REQUIRED", "请先选择已采用的穿搭母版，或选择同一人物的半身身份锚点。");
    if (references.length !== 2 || references[1].category !== "pose_reference")
      throw modelAssetError("MODEL_ASSET_POSE_REFERENCE_REQUIRED", "第 4 步需要 1 张人物身份图和 1 张神态姿态对标图。");
    return;
  }
  if (!lock.performance_master_asset_id || references.length !== 1 || references[0]?.asset_id !== lock.performance_master_asset_id)
    throw modelAssetError("MODEL_ASSET_PERFORMANCE_MASTER_REQUIRED", "第 5 步最终生图只使用已采用的神态姿态母版；对标图只用于前面的画面分析。");
}

function validateStyledIdentityCloseupReferences(project, references) {
  const lock = activeRealPersonLock(project);
  if (!lock.v0_asset_id || !lock.styled_anchor_asset_id)
    throw modelAssetError("MODEL_ASSET_CLOSEUP_HELPER_PARENT_REQUIRED", "请先采用商业身份母版和穿搭母版，再生成近景身份图。");
  if (
    references.length !== 2
    || references[0]?.asset_id !== lock.v0_asset_id
    || references[1]?.asset_id !== lock.styled_anchor_asset_id
    || references.some((asset) => asset.status !== "approved")
  ) throw modelAssetError(
    "MODEL_ASSET_CLOSEUP_HELPER_REFERENCE_SCOPE",
    "近景身份图只使用已采用的商业身份母版和已采用的发型穿搭母版，不会使用神态姿态对标图。",
  );
}

function currentAiAssetStage(project) {
  return project.ai_source_method === "single_reference_deidentify"
    && project.ai_workflow_stage === "deidentify_bridge"
    ? "deidentify_bridge"
    : "v0";
}

function validateAiModelReferences(project, references) {
  const method = AI_SOURCE_METHODS.has(project.ai_source_method)
    ? project.ai_source_method
    : "original";
  const categories = references.map((asset) => asset.category);
  const uniqueHashes = new Set(references.map((asset) => asset.sha256));
  if (method === "original") {
    if (references.length)
      throw modelAssetError("MODEL_ASSET_ORIGINAL_REFERENCE_FORBIDDEN", "完全原创不上传人物参考脸，请取消勾选后再生成。");
    return;
  }
  if (method === "multi_reference_fusion") {
    const allowed = new Set([
      "face_outline_reference",
      "eye_reference",
      "nose_lip_reference",
      "style_vibe_reference",
      "hair_reference",
    ]);
    if (references.length < 3 || references.length > 5 || references.some((asset) => !allowed.has(asset.category)))
      throw modelAssetError("MODEL_ASSET_MULTI_REFERENCE_COUNT", "多图融合需要选择 3–5 张分工明确的人物参考图。");
    if (uniqueHashes.size !== references.length)
      throw modelAssetError("MODEL_ASSET_MULTI_REFERENCE_DUPLICATE", "多图融合不能重复使用同一张图片，请选择不同参考图。");
    for (const required of ["face_outline_reference", "eye_reference", "nose_lip_reference"])
      if (!categories.includes(required))
        throw modelAssetError("MODEL_ASSET_MULTI_REFERENCE_ROLE_MISSING", "请补齐脸型轮廓、眼型、鼻唇三类基础参考。");
    return;
  }
  if (method === "single_reference_deidentify") {
    if (project.ai_workflow_stage === "deidentify_bridge") {
      if (references.length !== 1 || categories[0] !== "deidentify_source")
        throw modelAssetError("MODEL_ASSET_DEIDENTIFY_SOURCE_REQUIRED", "单图脱离第一步只能选择 1 张原始人物参考图。");
      return;
    }
    const bridge = project.assets.find((asset) => asset.asset_id === project.ai_active_bridge_asset_id);
    if (!bridge || bridge.status !== "approved" || bridge.asset_stage !== "deidentify_bridge")
      throw modelAssetError("MODEL_ASSET_DEIDENTIFY_BRIDGE_REQUIRED", "请先采用第一步去身份过桥图。");
    if (references.length !== 1 || references[0].asset_id !== bridge.asset_id)
      throw modelAssetError("MODEL_ASSET_DEIDENTIFY_BRIDGE_ONLY", "第二步只能使用已确认的过桥图，不能再次上传原始人物图。");
    return;
  }
  if (method === "two_person_middle_face") {
    if (references.length !== 2 || !categories.includes("person_a_reference") || !categories.includes("person_b_reference"))
      throw modelAssetError("MODEL_ASSET_MIDDLE_FACE_PAIR_REQUIRED", "双人中间脸需要人物 A 和人物 B 各 1 张参考图。");
    if (uniqueHashes.size !== 2)
      throw modelAssetError("MODEL_ASSET_MIDDLE_FACE_DUPLICATE", "人物 A 和人物 B 不能是同一张图片。");
  }
}

function validateAiTalkingStyleReferences(project, references) {
  const base = project.assets.find((asset) => asset.asset_id === project.approved_asset_id);
  if (!base || base.status !== "approved" || !existsAndMatches(base))
    throw modelAssetError("MODEL_STYLE_BASE_ASSET_REQUIRED", "请先采用一张有效的正式 AI 模特母版。");
  if (references.length !== 1 || references[0].asset_id !== base.asset_id)
    throw modelAssetError("MODEL_STYLE_BASE_ASSET_ONLY", "制作口播母版时只使用已确认的正式 AI 模特母版作为人物参考。");
}

function approvedTalkingStyleAnalysis(project) {
  const analysis = project.talking_style_analysis;
  if (!analysis || analysis.status !== "approved" || !analysis.approved_generation_prompt)
    throw modelAssetError("MODEL_STYLE_PROMPT_NOT_APPROVED", "请先查看并确认对标图反推的画面提示词。");
  const executionPrompt = buildTalkingStyleExecutionPrompt(project, analysis.approved_generation_prompt);
  return {
    analysis_id: analysis.analysis_id,
    reverse_prompt_type: analysis.reverse_prompt_type,
    benchmark_asset_id: analysis.benchmark_asset_id,
    benchmark_usage: "analysis_only",
    approved_generation_prompt: executionPrompt,
    approved_generation_prompt_sha256: sha256Buffer(Buffer.from(executionPrompt, "utf8")),
    source_generation_prompt_sha256: analysis.approved_generation_prompt_sha256,
    final_generation_benchmark_reference_included: false,
  };
}

function buildTalkingStyleExecutionPrompt(project, stylePrompt) {
  const cleaned = cleanText(stylePrompt, 30000);
  if (project.route === "real_person") {
    if (!activeRealPersonLock(project).performance_master_asset_id)
      throw modelAssetError("MODEL_STYLE_APPROVED_ASSET_CONTRACT_INCOMPLETE", "请先采用神态姿态母版，再复刻画质与氛围。");
    return cleaned;
  }
  return cleaned;
}

function invalidateDownstreamRealPersonLocks(project, adoptedStage) {
  const order = REAL_PERSON_STAGE_ORDER;
  const adoptedIndex = order.indexOf(adoptedStage);
  if (adoptedIndex < 0) return;
  for (const stage of order.slice(adoptedIndex + 1)) {
    const key = `${stage}_asset_id`;
    const staleId = project.active_asset_lock?.[key];
    if (!staleId) continue;
    const staleAsset = project.assets.find((item) => item.asset_id === staleId);
    if (staleAsset?.status === "approved") staleAsset.status = "candidate";
    project.active_asset_lock[key] = null;
  }
}

function activeRealPersonLock(project) {
  const lock = project.active_asset_lock || {};
  return {
    v0_asset_id: lock.v0_asset_id || null,
    appearance_bridge_asset_id: lock.appearance_bridge_asset_id || null,
    styled_anchor_asset_id: lock.styled_anchor_asset_id || null,
    performance_master_asset_id: lock.performance_master_asset_id
      || (Number(project.schema_version || 0) < 3 ? lock.styled_anchor_asset_id || null : null),
    current_shot_asset_id: lock.current_shot_asset_id || null,
  };
}
