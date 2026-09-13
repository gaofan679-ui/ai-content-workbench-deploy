import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { skillFile } from "./portable-paths.mjs";
import {
  assertSafeMultiSegmentContract,
  loadTaskCards,
  stitchSegments,
  validateProviderCompiledPrompt,
} from "./runninghub-h3-video-runner.mjs";

const REQUEST_NAME = "RUNTIME_GENERATION_REQUEST.json";
const STATUS_NAME = "RUNTIME_GENERATION_STATUS.json";
const ALLOWED_QUALITIES = new Set(["normal", "high", "ultra"]);
const ALLOWED_RATIOS = new Set(["9:16", "16:9"]);

function isApprovedAssetStatus(value) {
  const status = String(value || "");
  return status === "approved" || status.startsWith("approved_");
}

export function runtimeGenerationRequestPath(taskRoot) {
  return join(taskRoot, REQUEST_NAME);
}

export function runtimeGenerationStatusPath(taskRoot) {
  return join(taskRoot, STATUS_NAME);
}

export function readRuntimeGenerationStatus(taskRoot) {
  const path = runtimeGenerationStatusPath(taskRoot);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value?.schema_version === 1 ? value : null;
  } catch {
    return null;
  }
}

export function loadRuntimeGenerationRequest({ task, taskRoot }) {
  const requestPath = runtimeGenerationRequestPath(taskRoot);
  if (!existsSync(requestPath)) return null;
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  if (request?.schema_version !== 1)
    throw new Error("RUNTIME_GENERATION_REQUEST_INVALID");
  if (
    request.request_type === "ai_video_generation_preflight" ||
    (request.request_type === "runninghub_h3_generation" &&
      request.generation_task_path &&
      request.asset_binding_manifest_path &&
      request.prompt_path)
  )
    return loadFormalPreflightRuntimeGenerationRequest({ task, taskRoot, request });
  if (request.request_type !== "runninghub_h3_generation" || request.task_id !== task.id)
    throw new Error("RUNTIME_GENERATION_REQUEST_INVALID");
  const packDirectory = safeTaskDirectory(taskRoot, request.pack_path);
  if (packDirectory)
    return loadGenerationPackDirectoryRequest({ task, taskRoot, request, packDirectory });
  const packPath = safeGenerationPackFile(taskRoot, request.pack_path);
  if (!packPath) throw new Error("RUNTIME_GENERATION_PACK_PATH_INVALID");
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  if (Array.isArray(pack?.task_cards))
    return loadBatchRuntimeGenerationRequest({ task, taskRoot, request, pack, packPath });
  if (
    pack?.task_id !== task.id ||
    pack?.provider !== "runninghub_h3_multiref" ||
    pack?.artifact_status !== "ready_for_runner_preflight" ||
    pack?.preflight_status !== "passed_local" ||
    pack?.external_request_started !== false ||
    pack?.paid_execution_allowed !== false ||
    pack?.generation_count !== 1 ||
    pack?.automatic_retry !== false ||
    !Number.isInteger(pack?.duration_seconds) ||
    pack.duration_seconds < 1 ||
    pack.duration_seconds > 15 ||
    !ALLOWED_QUALITIES.has(pack?.quality_profile) ||
    !ALLOWED_RATIOS.has(pack?.aspect_ratio)
  )
    throw new Error("RUNTIME_GENERATION_PACK_CONTRACT_INVALID");
  const promptPath = safeTaskFile(taskRoot, pack.prompt_path);
  if (!promptPath) throw new Error("RUNTIME_GENERATION_PROMPT_PATH_INVALID");
  const assets = (pack.assets || []).filter(
    (item) => item?.upload_to_video_model !== false,
  );
  if (assets.length < 1 || assets.length > 3)
    throw new Error("RUNTIME_GENERATION_ASSET_COUNT_INVALID");
  const references = assets.map((item, index) => {
    const path = safeRegularFile(item.path);
    if (!path) throw new Error(`RUNTIME_GENERATION_ASSET_INVALID_${index + 1}`);
    if (/\u7ea2\u7ebf|\u7f51\u683c|\u5b89\u5168\u63d0\u4ea4\u7248/.test(`${item.alias || ""}${item.role || ""}${path}`))
      throw new Error("RUNTIME_GENERATION_UNSAFE_REFERENCE_REJECTED");
    return {
      path,
      role: String(item.role || item.alias || `\u53c2\u8003\u56fe${index + 1}`).slice(0, 80),
    };
  });
  const executionInstanceType = resolveExecutionInstanceType(pack);
  const routeId = `${String(pack.route_id || "single_run").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72)}-${executionInstanceType}`;
  const runDir = join(taskRoot, "run", "10_runtime_generation", routeId);
  const receiptPath = join(runDir, "runninghub_preflight.json");
  const outputPath = join(runDir, "result.mp4");
  return {
    request,
    pack,
    packPath,
    items: [{ pack: { ...pack, execution_instance_type: executionInstanceType }, promptPath, references, runDir, receiptPath, outputPath }],
    outputPath,
  };
}

function loadGenerationPackDirectoryRequest({ task, taskRoot, request, packDirectory }) {
  const generationTaskPath = safePackFile(taskRoot, packDirectory, "generation_tasks.json");
  const manifestPath = safePackFile(taskRoot, packDirectory, "asset_binding_manifest.json");
  const redlinePath = safePackFile(taskRoot, packDirectory, "redline_scan_report.json");
  if (!generationTaskPath || !manifestPath || !redlinePath)
    throw new Error("RUNTIME_GENERATION_PACK_DIRECTORY_INCOMPLETE");
  const generationTask = JSON.parse(readFileSync(generationTaskPath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const redline = JSON.parse(readFileSync(redlinePath, "utf8"));
  const units = Array.isArray(generationTask?.generation_units)
    ? generationTask.generation_units
    : [];
  if (
    generationTask?.schema_version !== 1 ||
    generationTask?.project_id !== task.id ||
    generationTask?.task_id !== task.id ||
    generationTask?.provider !== "runninghub_h3_multiref" ||
    generationTask?.execution_mode_for_runner !== "dry_run" ||
    generationTask?.automatic_retry !== false ||
    units.length < 1 || units.length > 5 ||
    generationTask?.generation_count !== units.length ||
    !ALLOWED_QUALITIES.has(generationTask?.quality_profile) ||
    !ALLOWED_RATIOS.has(generationTask?.aspect_ratio) ||
    redline?.status !== "pass" ||
    manifest?.schema_version !== 1 ||
    manifest?.task_id !== task.id ||
    manifest?.provider !== "runninghub_h3_multiref" ||
    manifest?.automatic_asset_addition !== false
  ) throw new Error("RUNTIME_GENERATION_PACK_DIRECTORY_CONTRACT_INVALID");

  const assets = (manifest.assets || [])
    .filter((item) => item?.upload_to_video_model !== false)
    .slice()
    .sort((left, right) => Number(left.order) - Number(right.order));
  if (assets.length < 1 || assets.length > 3)
    throw new Error("RUNTIME_GENERATION_ASSET_COUNT_INVALID");
  const references = assets.map((item, index) => {
    if (
      Number(item.order) !== index + 1 ||
      !isApprovedAssetStatus(item.approval_status) ||
      item.allowed_downstream !== "generation_pack"
    ) throw new Error(`RUNTIME_GENERATION_ASSET_BINDING_INVALID_${index + 1}`);
    const path = safePackFile(taskRoot, packDirectory, item.path);
    if (!path) throw new Error(`RUNTIME_GENERATION_ASSET_INVALID_${index + 1}`);
    if (item.sha256 && sha256File(path) !== item.sha256)
      throw new Error(`RUNTIME_GENERATION_ASSET_HASH_MISMATCH_${index + 1}`);
    if (/红线|网格|安全提交版/.test(`${item.role || ""}${item.control_scope || ""}${path}`))
      throw new Error("RUNTIME_GENERATION_UNSAFE_REFERENCE_REJECTED");
    return { path, role: String(item.role || `参考图${index + 1}`).slice(0, 80) };
  });
  const executionInstanceType = resolveExecutionInstanceType(generationTask);
  const packIdentity = createHash("sha256")
    .update(realpathSync(generationTaskPath))
    .update("\0")
    .update(readFileSync(generationTaskPath))
    .update("\0")
    .update(executionInstanceType)
    .digest("hex")
    .slice(0, 12);
  const routeStem = String(generationTask.pack_id || generationTask.task_id)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 60);
  const batchRoot = units.length === 1
    ? join(taskRoot, "run", "10_runtime_generation", `${routeStem}-${executionInstanceType}`)
    : join(taskRoot, "run", "14_runtime_full_sequence", `${routeStem}_${packIdentity}-${executionInstanceType}`);
  const pack = {
    ...generationTask,
    task_id: task.id,
    route_id: `${routeStem}-${executionInstanceType}`,
    artifact_status: "ready_for_runner_preflight",
    preflight_status: "passed_local",
    external_request_started: false,
    paid_execution_allowed: false,
    execution_instance_type: executionInstanceType,
  };
  const items = units.map((unit, index) => {
    const duration = Number(unit?.duration_seconds ?? (units.length === 1 ? generationTask?.duration_seconds : NaN));
    if (!Number.isInteger(duration) || duration < 1 || duration > 15)
      throw new Error(`RUNTIME_GENERATION_PACK_DIRECTORY_DURATION_INVALID_${index + 1}`);
    const promptPath = safePackFile(taskRoot, packDirectory, unit.prompt_path);
    if (!promptPath) throw new Error(`RUNTIME_GENERATION_PROMPT_PATH_INVALID_${index + 1}`);
    validateProviderCompiledPrompt({ sourceText: readFileSync(promptPath, "utf8"), references });
    const unitId = String(unit.unit_id || `segment_${index + 1}`)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 48);
    const runDir = units.length === 1 ? batchRoot : join(batchRoot, unitId);
    return {
      pack: { ...pack, ...unit, duration_seconds: duration, generation_count: 1 },
      promptPath,
      references,
      runDir,
      receiptPath: join(runDir, "runninghub_preflight.json"),
      outputPath: join(runDir, "result.mp4"),
      trimToSeconds: Number(unit.requested_content_duration_seconds || duration),
    };
  });
  return {
    request: { ...request, pack_path: relative(taskRoot, generationTaskPath) },
    pack,
    packPath: generationTaskPath,
    items,
    outputPath: units.length === 1
      ? items[0].outputPath
      : join(batchRoot, "stitched", "result.mp4"),
  };
}

function loadFormalPreflightRuntimeGenerationRequest({ task, taskRoot, request }) {
  const policy = request.execution_policy || {};
  const parameters = request.parameters || {};
  const strictFormalEnvelope = request.request_type === "ai_video_generation_preflight";
  const projectId = request.project_id || request.task_id;
  const requestedDuration = Number(parameters.duration_seconds);
  const authorizedBillablePreflight =
    policy.billable_submission_allowed === true &&
    policy.billable_confirmation_status === "authorized_by_user_current_end_to_end_paid_test" &&
    policy.billable_submission_count_allowed === 1;
  const safePreflightEnvelope =
    policy.billable_submission_allowed === false || authorizedBillablePreflight;
  if (
    projectId !== task.id ||
    request.request_status !== "pending_workbench_preflight" ||
    request.provider !== "runninghub_h3_multiref" ||
    policy.workbench_preflight_required !== true ||
    !safePreflightEnvelope ||
    policy.automatic_retry !== false ||
    parameters.generation_count !== 1 ||
    !Number.isFinite(requestedDuration) ||
    requestedDuration < 1 ||
    requestedDuration > 15 ||
    !ALLOWED_QUALITIES.has(parameters.quality_profile) ||
    !ALLOWED_RATIOS.has(parameters.aspect_ratio)
  ) throw new Error("RUNTIME_GENERATION_FORMAL_REQUEST_CONTRACT_INVALID");

  const generationTaskPath = safeTaskFile(taskRoot, request.generation_task_path);
  const manifestPath = safeTaskFile(taskRoot, request.asset_binding_manifest_path);
  const promptPath = safeTaskFile(taskRoot, request.prompt_path);
  const localPreflightPath = safeTaskFile(taskRoot, request.local_preflight_report_path);
  if (!generationTaskPath || !manifestPath || !promptPath || !localPreflightPath)
    throw new Error("RUNTIME_GENERATION_FORMAL_PATH_INVALID");

  const generationTask = JSON.parse(readFileSync(generationTaskPath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fingerprint = String(request.binding_fingerprint || "");
  if (
    generationTask?.schema_version !== 1 ||
    generationTask?.project_id !== task.id ||
    (strictFormalEnvelope && generationTask?.task_id !== request.task_id) ||
    generationTask?.provider !== request.provider ||
    generationTask?.execution_mode_for_runner !== "dry_run" ||
    !(
      generationTask?.billable_submission_allowed === false ||
      (
        authorizedBillablePreflight &&
        generationTask?.billable_submission_allowed === true &&
        generationTask?.billable_submission_confirmation === "authorized_by_user_current_end_to_end_paid_test" &&
        generationTask?.billable_submission_count_allowed === 1
      )
    ) ||
    generationTask?.automatic_retry !== false ||
    generationTask?.generation_count !== 1 ||
    Number(generationTask?.duration_seconds) !== requestedDuration ||
    generationTask?.quality_profile !== parameters.quality_profile ||
    generationTask?.aspect_ratio !== parameters.aspect_ratio ||
    manifest?.schema_version !== 1 ||
    manifest?.project_id !== task.id ||
    manifest?.task_id !== generationTask?.task_id ||
    manifest?.provider !== request.provider ||
    manifest?.automatic_billable_submission_allowed !== false ||
    (strictFormalEnvelope && !fingerprint) ||
    (fingerprint && generationTask?.binding_fingerprint !== fingerprint) ||
    (fingerprint && manifest?.binding_fingerprint !== fingerprint)
  ) throw new Error("RUNTIME_GENERATION_FORMAL_BINDING_INVALID");

  const assets = (manifest.assets || []).filter((item) => item?.upload_to_video_model !== false);
  if (assets.length < 1 || assets.length > 3)
    throw new Error("RUNTIME_GENERATION_ASSET_COUNT_INVALID");
  const references = assets
    .slice()
    .sort((left, right) => Number(left.slot_index) - Number(right.slot_index))
    .map((item, index) => {
      if (
        Number(item.slot_index) !== index + 1 ||
        !isApprovedAssetStatus(item.approval_status) ||
        item.allowed_downstream !== "generation_pack"
      ) throw new Error(`RUNTIME_GENERATION_ASSET_BINDING_INVALID_${index + 1}`);
      const path = safeTaskFile(taskRoot, item.path);
      if (!path) throw new Error(`RUNTIME_GENERATION_ASSET_INVALID_${index + 1}`);
      if (item.sha256 && sha256File(path) !== item.sha256)
        throw new Error(`RUNTIME_GENERATION_ASSET_HASH_MISMATCH_${index + 1}`);
      if (/红线|网格|安全提交版/.test(`${item.asset_role || ""}${item.control_scope || ""}${path}`))
        throw new Error("RUNTIME_GENERATION_UNSAFE_REFERENCE_REJECTED");
      return {
        path,
        role: String(item.asset_role || `参考图${index + 1}`).slice(0, 80),
      };
    });
  validateProviderCompiledPrompt({ sourceText: readFileSync(promptPath, "utf8"), references });

  const executionInstanceType = resolveExecutionInstanceType(generationTask);
  const routeId = `${String(generationTask.task_id || request.task_id || "single_run").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72)}-${executionInstanceType}`;
  const runDir = join(taskRoot, "run", "10_runtime_generation", routeId);
  const roundedDuration = Math.ceil(requestedDuration);
  const needsExactTrim = roundedDuration !== requestedDuration;
  const legacyOutputPath = join(runDir, "result.mp4");
  const legacyCompletedResult =
    needsExactTrim &&
    existsSync(legacyOutputPath) &&
    completedTaskJournal(join(runDir, "task.json"));
  const generatedOutputPath = needsExactTrim
    ? legacyCompletedResult
      ? legacyOutputPath
      : join(runDir, "source_result.mp4")
    : legacyOutputPath;
  const outputPath = needsExactTrim
    ? legacyCompletedResult
      ? join(runDir, "result_trimmed.mp4")
      : legacyOutputPath
    : legacyOutputPath;
  const pack = {
    ...generationTask,
    task_id: task.id,
    duration_seconds: roundedDuration,
    route_id: routeId,
    artifact_status: "ready_for_runner_preflight",
    preflight_status: "passed_local",
    external_request_started: false,
    paid_execution_allowed: false,
    execution_instance_type: executionInstanceType,
  };
  const normalizedRequest = {
    ...request,
    pack_path: request.generation_task_path,
  };
  return {
    request: normalizedRequest,
    pack,
    packPath: generationTaskPath,
    items: [{
      pack,
      promptPath,
      references,
      runDir,
      receiptPath: join(runDir, "runninghub_preflight.json"),
      outputPath: generatedOutputPath,
      trimToSeconds: requestedDuration,
    }],
    outputPath,
  };
}

function loadBatchRuntimeGenerationRequest({ task, taskRoot, request, pack, packPath }) {
  if (
    pack?.task_id !== task.id ||
    pack?.provider !== "runninghub_h3_multiref" ||
    !["pass_business_ready_for_runner_readonly_preflight", "passed_local"].includes(pack?.preflight_status) ||
    pack?.external_request_started !== false ||
    pack?.generation_count < 1 ||
    pack?.generation_count > 5 ||
    pack?.generation_count !== pack.task_cards.length ||
    pack?.automatic_retry !== false ||
    !ALLOWED_QUALITIES.has(pack?.quality_profile) ||
    !ALLOWED_RATIOS.has(pack?.aspect_ratio)
  ) throw new Error("RUNTIME_GENERATION_BATCH_PACK_CONTRACT_INVALID");
  const cards = loadTaskCards(packPath);
  assertSafeMultiSegmentContract(cards);
  // A rerun must not silently reuse a prior batch just because segment task ids
  // happen to be unchanged.  Keep resume/idempotency inside the exact same pack,
  // but isolate every materially different pack as a new preserved version.
  const executionInstanceType = resolveExecutionInstanceType(pack);
  const packIdentity = createHash("sha256")
    .update(realpathSync(packPath))
    .update("\0")
    .update(readFileSync(packPath))
    .update("\0")
    .update(executionInstanceType)
    .digest("hex")
    .slice(0, 12);
  const batchRoot = join(taskRoot, "run", "14_runtime_full_sequence", `pack_${packIdentity}`);
  const items = cards.map((card, index) => {
    const duration = Number(card.duration_seconds);
    const quality = card.quality_profile || pack.quality_profile;
    const ratio = card.aspect_ratio || pack.aspect_ratio;
    if (!Number.isInteger(duration) || duration < 1 || duration > 15)
      throw new Error(`RUNTIME_GENERATION_BATCH_DURATION_INVALID_${index + 1}`);
    if (!ALLOWED_QUALITIES.has(quality) || !ALLOWED_RATIOS.has(ratio))
      throw new Error(`RUNTIME_GENERATION_BATCH_PARAMETER_INVALID_${index + 1}`);
    const promptPath = safeRegularFile(join(dirname(packPath), String(card.model_prompt_file || "")));
    if (!promptPath) throw new Error(`RUNTIME_GENERATION_BATCH_PROMPT_INVALID_${index + 1}`);
    const references = (card.references || []).map((reference, referenceIndex) => {
      const path = safeRegularFile(reference.path);
      if (!path) throw new Error(`RUNTIME_GENERATION_BATCH_ASSET_INVALID_${index + 1}_${referenceIndex + 1}`);
      if (/红线|网格|安全提交版/.test(`${reference.alias || ""}${reference.role || ""}${path}`))
        throw new Error("RUNTIME_GENERATION_UNSAFE_REFERENCE_REJECTED");
      return {
        ...reference,
        path,
        role: String(reference.role || reference.exact_alias || `参考图${referenceIndex + 1}`).slice(0, 80),
      };
    });
    if (references.length < 1 || references.length > 3)
      throw new Error(`RUNTIME_GENERATION_BATCH_ASSET_COUNT_INVALID_${index + 1}`);
    validateProviderCompiledPrompt({
      sourceText: readFileSync(promptPath, "utf8"),
      references,
    });
    const route = String(card.task_id || `segment_${index + 1}`)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80);
    const runDir = join(batchRoot, route);
    return {
      pack: { ...card, duration_seconds: duration, quality_profile: quality, aspect_ratio: ratio, execution_instance_type: executionInstanceType },
      promptPath,
      references,
      runDir,
      receiptPath: join(runDir, "runninghub_preflight.json"),
      outputPath: join(runDir, "result.mp4"),
      trimToSeconds: Number(card.trim_to_seconds || card.original_target_duration_seconds || duration),
    };
  });
  return {
    request,
    pack,
    packPath,
    items,
    outputPath: join(batchRoot, "stitched", "result.mp4"),
  };
}

export async function runRuntimeGenerationPreflight({
  task,
  taskRoot,
  env = process.env,
  autoSubmitAfterPreflight = false,
}) {
  const context = loadRuntimeGenerationRequest({ task, taskRoot });
  if (!context) return null;
  const previous = readRuntimeGenerationStatus(taskRoot);
  if (
    previous?.status === "preflight_passed" &&
    previous?.pack_path === context.request.pack_path &&
    context.items.every((item) => existsSync(item.receiptPath))
  )
    return previous;
  context.items.forEach((item) => mkdirSync(item.runDir, { recursive: true }));
  writeStatus(taskRoot, {
    task_id: task.id,
    status: "preflight_running",
    phase_label: "正在做生成前免费检查",
    summary: `正在核对 ${context.items.length} 段的模型、余额、素材和生成参数；未上传、未提交、未扣费。`,
    can_confirm_paid: false,
    pack_path: context.request.pack_path,
  });
  try {
    for (const item of context.items)
      if (!existsSync(item.receiptPath)) await runOfficialRunner("preflight", item, env);
    const receipts = context.items.map((item) => JSON.parse(readFileSync(item.receiptPath, "utf8")));
    if (receipts.some((receipt) => receipt?.status !== "preflight_passed_no_upload_no_charge"))
      throw new Error("RUNTIME_GENERATION_PREFLIGHT_RECEIPT_INVALID");
    const estimatedMin = receipts.reduce((sum, receipt) => sum + Number(receipt.cost?.estimatedCoinsMin || 0), 0);
    const estimatedMax = receipts.reduce((sum, receipt) => sum + Number(receipt.cost?.estimatedCoinsMax || 0), 0);
    const totalDuration = context.items.reduce((sum, item) => sum + Number(item.trimToSeconds || item.pack.duration_seconds), 0);
    const referenceCount = context.items.reduce((sum, item) => sum + item.references.length, 0);
    return writeStatus(taskRoot, {
      task_id: task.id,
      status: "preflight_passed",
      phase_label: "生成前检查已通过",
      summary: `${context.items.length} 段，共 ${totalDuration.toFixed(1)} 秒 / ${context.pack.aspect_ratio} / ${qualityLabel(context.pack.quality_profile)}，预计 ${estimatedMin}–${estimatedMax} RH 币；每段只提交 1 次，不自动重试。`,
      next_action: autoSubmitAfterPreflight
        ? `本项目创建时已授权该路线，将按清单自动上传参考图并提交 ${context.items.length} 段。`
        : `确认后才会上传清单中的参考图并付费提交 ${context.items.length} 段。`,
      estimated_coins_min: estimatedMin,
      estimated_coins_max: estimatedMax,
      pack_path: context.request.pack_path,
      generation: {
        provider: "runninghub_h3_multiref",
        duration_seconds: totalDuration,
        aspect_ratio: context.pack.aspect_ratio,
        quality_profile: context.pack.quality_profile,
        reference_count: referenceCount,
        generation_count: context.items.length,
        automatic_retry: false,
      },
      can_confirm_paid: !autoSubmitAfterPreflight,
    });
  } catch (error) {
    return writeStatus(taskRoot, {
      task_id: task.id,
      status: "preflight_failed",
      phase_label: "\u751f\u6210\u524d\u68c0\u67e5\u672a\u901a\u8fc7",
      summary: publicError(error),
      next_action: "\u5df2\u4fdd\u7559\u4efb\u52a1\u5305\u548c\u4e0a\u6e38\u6210\u679c\uff1b\u5f53\u524d\u6ca1\u6709\u4e0a\u4f20\u3001\u63d0\u4ea4\u6216\u6263\u8d39\u3002",
      can_confirm_paid: false,
    });
  }
}

export async function runConfirmedRuntimeGeneration({ task, taskRoot, env = process.env }) {
  const context = loadRuntimeGenerationRequest({ task, taskRoot });
  const status = readRuntimeGenerationStatus(taskRoot);
  if (!context || !["preflight_passed", "generation_running"].includes(status?.status) || status?.pack_path !== context.request.pack_path || !context.items.every((item) => existsSync(item.receiptPath)))
    throw new Error("RUNTIME_GENERATION_PREFLIGHT_REQUIRED");
  if (existsSync(context.outputPath)) return readRuntimeGenerationStatus(taskRoot);
  writeStatus(taskRoot, {
    ...status,
    status: "generation_running",
    phase_label: `已提交 ${context.items.length} 段，正在生成`,
    summary: `工作台已按确认清单提交 ${context.items.length} 段；每段只提交 1 次，不会自动重试。`,
    next_action: "\u6682\u65f6\u4e0d\u7528\u64cd\u4f5c\uff0c\u7ed3\u679c\u8fd4\u56de\u540e\u4f1a\u81ea\u52a8\u663e\u793a\u3002",
    can_confirm_paid: false,
  });
  try {
    await Promise.all(context.items.map(async (item) => {
      if (!existsSync(item.outputPath)) {
        const journal = readTaskJournal(join(item.runDir, "task.json"));
        await runOfficialRunner(journal?.taskId ? "resume" : "run", item, env);
      }
      if (!existsSync(item.outputPath)) throw new Error("RUNTIME_GENERATION_RESULT_MISSING");
    }));
    if (
      context.items.length > 1 ||
      context.items[0]?.outputPath !== context.outputPath
    )
      stitchSegments(
        context.items.map((item) => item.outputPath),
        context.items.map((item) => item.trimToSeconds),
        dirname(context.outputPath),
        env,
        basename(context.outputPath),
      );
    const completedJournals = context.items
      .map((item) => readCompletedTaskJournal(join(item.runDir, "task.json")))
      .filter(Boolean);
    const actualCoins = completedJournals
      .map((journal) => Number(journal.usage?.consumeCoins ?? journal.result?.usage?.consumeCoins))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    return writeStatus(taskRoot, {
      ...status,
      status: "generation_completed",
      phase_label: "\u89c6\u9891\u5df2\u751f\u6210",
      summary: context.items.length === 1
        ? "正片已返回工作台；系统没有自动重试。"
        : `${context.items.length} 段均已返回并按已核验的连续方案合成为完整视频；系统没有自动重试。`,
      next_action: "\u8bf7\u64ad\u653e\u67e5\u770b\uff1b\u6ee1\u610f\u53ef\u4ee5\u91c7\u7528\uff0c\u4e0d\u6ee1\u610f\u53ef\u4ee5\u4fdd\u7559\u65e7\u7248\u540e\u518d\u505a\u8c03\u6574\u3002",
      can_confirm_paid: false,
      pack_path: context.request.pack_path,
      actual_coins: actualCoins || null,
      remote_task_ids: completedJournals.map((journal) => journal.taskId).filter(Boolean),
      artifacts: [
        { stage: "video_generation", label: "正式视频", path: relative(taskRoot, context.outputPath) },
        ...(context.items.length > 1
          ? context.items.map((item, index) => ({ stage: "video_generation", label: `正式视频分段 ${index + 1}`, path: relative(taskRoot, item.outputPath) }))
          : []),
      ],
    });
  } catch (error) {
    const failedJournals = context.items
      .map((item) => readTaskJournal(join(item.runDir, "task.json")))
      .filter(Boolean);
    const capacityFailure = failedJournals.some((journal) =>
      /OutOfMemory|显存不足|显存耗尽/i.test(JSON.stringify(journal?.result?.failedReason || journal?.result || journal)),
    );
    const actualCoins = failedJournals
      .map((journal) => Number(journal?.usage?.consumeCoins ?? journal?.result?.usage?.consumeCoins))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    return writeStatus(taskRoot, {
      ...status,
      status: "generation_failed",
      phase_label: "\u89c6\u9891\u751f\u6210\u672a\u5b8c\u6210",
      summary: capacityFailure
        ? "RunningHub 这次因显存不足中止，没有返回视频。"
        : publicError(error),
      next_action: capacityFailure
        ? "可改用大显存模式重新提交 1 次；人物、分镜、提示词和旧版结果均保留。"
        : "\u7cfb\u7edf\u4e0d\u4f1a\u81ea\u52a8\u518d\u63d0\u4ea4\uff1b\u5df2\u4fdd\u7559\u4efb\u52a1\u5305\u548c\u8fdc\u7a0b\u56de\u6267\u4f9b\u540e\u7eed\u6838\u5bf9\u3002",
      failure_kind: capacityFailure ? "capacity_oom" : "provider_failure",
      actual_coins: Number.isFinite(actualCoins) ? actualCoins : null,
      can_confirm_paid: false,
    });
  }
}

function runnerArgs(context) {
  const budgetLimit = context.pack.execution_instance_type === "plus" ? "400" : "200";
  const args = [
    "--prompt-file", context.promptPath,
    "--duration", String(context.pack.duration_seconds),
    "--quality-profile", context.pack.quality_profile,
    "--aspect-ratio", context.pack.aspect_ratio,
    "--budget-limit", budgetLimit,
    "--preflight-receipt", context.receiptPath,
    "--instance-type", context.pack.execution_instance_type || "default",
  ];
  context.references.forEach((item, index) => {
    args.push(`--ref${index + 1}`, item.path, `--ref${index + 1}-role`, item.role);
  });
  return args;
}

async function runOfficialRunner(command, context, env) {
  const script = env.WORKBENCH_RUNNINGHUB_H3_RUNNER || skillFile(
    "ai-video-generation-runner",
    "scripts/runninghub_h3_multiref.py",
    env,
  );
  const args = command === "resume"
    ? [script, command, "--run-dir", context.runDir, "--output", context.outputPath]
    : [script, command, ...runnerArgs(context)];
  if (command === "run")
    args.push(
      "--run-dir", context.runDir,
      "--output", context.outputPath,
      "--confirm-paid-once", "\u786e\u8ba4\u4ec5\u4ed8\u8d39\u63d0\u4ea41\u6b21",
    );
  await spawnChecked(env.WORKBENCH_PYTHON || "python3", args, env, ["run", "resume"].includes(command) ? 55 * 60_000 : 3 * 60_000);
}

function spawnChecked(binary, args, env, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error("RUNTIME_GENERATION_RUNNER_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-6000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-6000); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`RUNNER_EXIT_${code}: ${stderr || stdout}`));
    });
  });
}

function safeTaskFile(taskRoot, value) {
  if (!value || isAbsolute(String(value))) return null;
  const root = realpathSync(taskRoot);
  const requested = resolve(taskRoot, String(value));
  const candidate = safeRegularFile(requested);
  if (!candidate) return null;
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

function safeGenerationPackFile(taskRoot, value) {
  if (!value || isAbsolute(String(value))) return null;
  const root = realpathSync(taskRoot);
  const requested = resolve(taskRoot, String(value));
  try {
    if (!existsSync(requested) || lstatSync(requested).isSymbolicLink()) return null;
    const resolved = realpathSync(requested);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null;
    if (lstatSync(resolved).isFile()) return resolved;
    if (!lstatSync(resolved).isDirectory()) return null;
    return safeTaskFile(taskRoot, relative(taskRoot, join(resolved, "generation_tasks.json")));
  } catch {
    return null;
  }
}

function safeTaskDirectory(taskRoot, value) {
  if (!value || isAbsolute(String(value))) return null;
  try {
    const root = realpathSync(taskRoot);
    const requested = resolve(taskRoot, String(value));
    if (!existsSync(requested) || lstatSync(requested).isSymbolicLink()) return null;
    const resolved = realpathSync(requested);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null;
    return lstatSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function safePackFile(taskRoot, packDirectory, value) {
  if (!value || isAbsolute(String(value))) return null;
  const candidate = resolve(packDirectory, String(value));
  return safeTaskFile(taskRoot, relative(taskRoot, candidate));
}

function safeRegularFile(value) {
  try {
    if (!existsSync(value) || lstatSync(value).isSymbolicLink()) return null;
    const candidate = realpathSync(value);
    return lstatSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function completedTaskJournal(path) {
  if (!existsSync(path)) return false;
  try {
    return JSON.parse(readFileSync(path, "utf8"))?.status === "SUCCESS";
  } catch {
    return false;
  }
}

function readCompletedTaskJournal(path) {
  if (!existsSync(path)) return null;
  try {
    const journal = JSON.parse(readFileSync(path, "utf8"));
    return journal?.status === "SUCCESS" ? journal : null;
  } catch {
    return null;
  }
}

function readTaskJournal(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function resolveExecutionInstanceType(pack) {
  if (pack?.execution_instance_type === "plus") return "plus";
  const duration = Array.isArray(pack?.task_cards)
    ? Math.max(...pack.task_cards.map((card) => Number(card?.duration_seconds || 0)), 0)
    : Array.isArray(pack?.generation_units)
      ? Math.max(...pack.generation_units.map((unit) => Number(unit?.duration_seconds || 0)), 0)
    : Number(pack?.duration_seconds || 0);
  return duration >= 15 && ["high", "ultra"].includes(pack?.quality_profile)
    ? "plus"
    : "default";
}

export function recordRuntimeGenerationRequestFailure({ task, taskRoot, error }) {
  return writeStatus(taskRoot, {
    task_id: task.id,
    status: "preflight_failed",
    phase_label: "生成前检查未通过",
    summary: publicError(error),
    next_action: "任务资料和已有成果均已保留，当前没有上传、提交或扣费；修复申请后工作台会自动重新检查。",
    can_confirm_paid: false,
  });
}

function writeStatus(taskRoot, value) {
  const path = runtimeGenerationStatusPath(taskRoot);
  const next = {
    schema_version: 1,
    request_type: "runninghub_h3_generation",
    ...value,
    updated_at: new Date().toISOString(),
  };
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return next;
}

function publicError(error) {
  const message = String(error?.message || error || "");
  if (/security.*44|keychain|RUNNINGHUB_API_KEY/i.test(message))
    return "\u5de5\u4f5c\u53f0\u8fd0\u884c\u65f6\u6682\u65f6\u65e0\u6cd5\u8bfb\u53d6 RunningHub \u672c\u673a\u51ed\u8bc1\uff1b\u4efb\u52a1\u5305\u5df2\u4fdd\u7559\uff0c\u6ca1\u6709\u4e0a\u4f20\u6216\u6263\u8d39\u3002";
  if (/\u4f59\u989d|remain|balance/i.test(message))
    return "RunningHub \u4f59\u989d\u4e0d\u8db3\u4ee5\u8986\u76d6\u672c\u6b21\u4fdd\u5b88\u9884\u4f30\uff1b\u6ca1\u6709\u4e0a\u4f20\u6216\u63d0\u4ea4\u3002";
  return "\u751f\u6210\u524d\u68c0\u67e5\u6ca1\u6709\u5b8c\u6210\uff1b\u4efb\u52a1\u5305\u548c\u5df2\u6709\u6210\u679c\u5df2\u4fdd\u7559\uff0c\u7cfb\u7edf\u6ca1\u6709\u81ea\u52a8\u91cd\u8bd5\u3002";
}

function qualityLabel(value) {
  return value === "ultra" ? "\u8d85\u6e05" : value === "high" ? "\u9ad8\u6e05" : "\u666e\u901a";
}
