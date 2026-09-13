#!/usr/bin/env node
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { bridgeRoot, completedBrowserJobForRequest, createBrowserJob, getBrowserJob, updateBrowserJob } from "./chatgpt-web-bridge.mjs";
import { assertStoryboardRequestContract } from "./storyboard-contract.mjs";

const args = parseArgs(process.argv.slice(2));
const taskPath = args["--task-json"];
const taskDir = args["--task-dir"];
const requestPath = args["--request-json"];
const outputPath = args["--output"];
const resumeJobId = args["--resume-job-id"];
if (!taskPath || !taskDir || !outputPath) fail("CHATGPT_WEB_GENERATOR_ARGUMENTS_INVALID");

const task = JSON.parse(readFileSync(taskPath, "utf8"));
const stage = task.generation_stage === "storyboard" ? "storyboard" : "person";
if (task.source_frame_upload_authorized !== true) fail(stage === "storyboard" ? "STORYBOARD_SOURCE_UPLOAD_AUTHORIZATION_REQUIRED" : "PERSON_SOURCE_UPLOAD_AUTHORIZATION_REQUIRED");
const root = process.env.WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT || bridgeRoot(process.env.WORKBENCH_DATA_ROOT || join(taskDir, "..", "..", ".."));
if (!requestPath) fail("CHATGPT_SKILL_COMPILED_REQUEST_REQUIRED");
const request = loadInternalGenerationRequest(requestPath, task.id, stage);
const references = request.reference_images.map((item) => item.path);
const prompt = request.final_model_prompt;
const completedJob = !resumeJobId ? completedBrowserJobForRequest(root, {
  taskId: task.id,
  promptSha256: request.final_model_prompt_sha256,
  referenceBindings: request.reference_images,
}) : null;
const job = resumeJobId ? getBrowserJob(root, resumeJobId) : (completedJob || createBrowserJob(root, {
  task, taskDir, prompt, promptSha256: request.final_model_prompt_sha256,
  referenceBindings: request.reference_images,
  allowEmptyReferences: request.person_source_method === "original",
}));
if (!job || job.task_id !== task.id || job.prompt_sha256 !== request.final_model_prompt_sha256 || job.required_reference_count !== references.length) fail("CHATGPT_RESUME_JOB_IDENTITY_MISMATCH");
if (resumeJobId && !job.manual_submission_confirmed) fail("CHATGPT_RESUME_JOB_NOT_USER_CONFIRMED");
process.stdout.write(resumeJobId
  ? "正在接回使用者已手动发送的 ChatGPT 结果；不会再次上传或发送。\n"
  : completedJob
    ? "已找到本任务先前完成的同一张 ChatGPT 图片，正在接回本地结果；不会再次上传或发送。\n"
    : "浏览器伴侣任务已经建立，正在等待 ChatGPT 页面接收。\n");

const timeoutMs = Number(process.env.WORKBENCH_CHATGPT_WEB_TIMEOUT_MS || 12 * 60 * 1000);
const deadline = Date.now() + Math.max(30_000, timeoutMs);
let lastState = "";
while (Date.now() < deadline) {
  const current = getBrowserJob(root, job.id);
  if (!current) fail("CHATGPT_BROWSER_JOB_NOT_FOUND");
  if (current.state !== lastState) {
    lastState = current.state;
    process.stdout.write(`${current.message || stateMessage(current.state)}\n`);
  }
  if (current.state === "completed") {
    finish(current);
    process.exit(0);
  }
  if (["auth_required", "blocked", "failed"].includes(current.state)) {
    fail(stateError(current));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const timedOutJob = getBrowserJob(root, job.id);
if (timedOutJob && !["completed", "blocked", "failed", "submission_unknown"].includes(timedOutJob.state)) {
  const mayHaveSubmitted = ["submitting", "submitted", "waiting_result"].includes(timedOutJob.state);
  updateBrowserJob(root, job.id, {
    state: mayHaveSubmitted ? "submission_unknown" : "failed",
    message: mayHaveSubmitted
      ? "生成请求可能已经提交，但结果状态无法确认；系统不会自动再发一次。"
      : "浏览器伴侣等待超时，任务没有进入提交状态。",
  });
}
fail("CHATGPT_WEB_BRIDGE_TIMEOUT");

function finish(current) {
  if (!current.result_image_path || !existsSync(current.result_image_path)) fail("CHATGPT_RESULT_IMAGE_MISSING");
  const finalDir = stage === "storyboard" ? join(taskDir, "04_storyboard", "03_inbox") : join(taskDir, "07_final");
  const workDir = join(taskDir, "work", stage === "storyboard" ? "storyboard-generation" : "person-generation");
  mkdirSync(finalDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const extension = /^\.(png|jpe?g|webp)$/i.test(extname(current.result_image_path)) ? extname(current.result_image_path).toLowerCase() : ".png";
  const segmentLabel = request.asset_type === "segment_storyboard"
    ? `-${String(request.segment_id).replace(/[^a-zA-Z0-9_-]/g, "_")}`
    : "";
  const runLabel = stage === "storyboard"
    ? `${task.execution_run_id || task.storyboard_attempt_count}${segmentLabel}`
    : task.person_attempt_count;
  const candidatePath = join(finalDir, stage === "storyboard" ? `chatgpt_storyboard_candidate_${runLabel}${extension}` : `chatgpt_person_candidate_attempt_${runLabel}${extension}`);
  if (existsSync(candidatePath)) fail("CHATGPT_RESULT_TARGET_EXISTS");
  copyFileSync(current.result_image_path, candidatePath, constants.COPYFILE_EXCL);
  const qcPath = join(workDir, stage === "storyboard" ? `chatgpt_storyboard_qc_${runLabel}.md` : `chatgpt_person_qc_attempt_${runLabel}.md`);
  const receiptPath = join(workDir, stage === "storyboard" ? `chatgpt_storyboard_receipt_${runLabel}.json` : `chatgpt_person_receipt_attempt_${runLabel}.json`);
  writeFileSync(qcPath, stage === "storyboard"
    ? `# ChatGPT 分镜候选基础检查\n\n- 已取得 1 张可追溯目标宫格。\n- 生成通道：ChatGPT 网页浏览器伴侣。\n- 自动重试：否。\n- 当前结论：客观画布比例另行硬检查；审美与镜头匹配等待使用者确认。\n`
    : `# ChatGPT 人物候选基础检查\n\n- 已取得 1 张可追溯图片。\n- 生成通道：ChatGPT 网页浏览器伴侣。\n- 自动重试：否。\n- 当前结论：等待使用者审美确认；确认前不发布为正式人物母版。\n`, { flag: "wx" });
  writeFileSync(receiptPath, `${JSON.stringify({
    schema_version: 2,
    status: "success",
    generation_provider: "chatgpt_web",
    generation_stage: stage,
    browser_companion: true,
    browser_job_id: current.id,
    submitted_at: current.submitted_at || null,
    raw_generation_path: current.result_image_path,
    project_output_path: candidatePath,
    source_reference_paths: references,
    source_reference_bindings: request.reference_images,
    final_model_prompt_sha256: request.final_model_prompt_sha256,
    internal_generation_request_path: request.request_path,
    required_reference_count: references.length,
    automatic_retry: false,
    segment_id: request.segment_id || null,
    segment_time_range: request.segment_time_range || null,
  }, null, 2)}\n`, { flag: "wx" });
  const artifacts = stage === "storyboard"
    ? storyboardArtifacts(candidatePath, qcPath, receiptPath, workDir, runLabel, request)
    : [
      { label: "AI 人物候选图", path: candidatePath, published: false },
      { label: "人物质检报告", path: qcPath, published: false },
      { label: "人物生成执行回执", path: receiptPath, published: false },
    ];
  writeFileSync(outputPath, `${JSON.stringify({
    status: "completed",
    summary: stage === "storyboard" ? "ChatGPT 网页浏览器伴侣已返回 1 张目标宫格分镜候选。" : "ChatGPT 网页浏览器伴侣已返回 1 张人物候选。",
    estimated_cost_cny: 0,
    external_request_started: true,
    artifacts,
    requires_confirmation: true,
    user_message: stage === "storyboard" ? "ChatGPT 已返回 1 张目标宫格分镜，请先通过比例硬检查，再确认采用或重做。" : "ChatGPT 已返回 1 张人物候选，请查看后选择采用或重新生成。",
  }, null, 2)}\n`, { flag: "wx" });
}

function storyboardArtifacts(candidatePath, qcPath, receiptPath, workDir, runLabel, requestValue) {
  const grid = assertStoryboardRequestContract(requestValue);
  const size = pngSize(candidatePath);
  const panelRatio = parseRatio(grid.panel_ratio);
  if (!panelRatio) fail("CHATGPT_STORYBOARD_PANEL_RATIO_INVALID");
  const expected = (Number(grid.columns) * panelRatio) / Number(grid.rows);
  const actual = size.width / size.height;
  const tolerance = Math.min(Number(grid.tolerance ?? 0.05), 0.05);
  const relativeError = Math.abs(actual - expected) / expected;
  const pass = relativeError <= tolerance;
  const ratioPath = join(workDir, `chatgpt_storyboard_ratio_${runLabel}.json`);
  writeFileSync(ratioPath, `${JSON.stringify({ image: candidatePath, image_width: size.width, image_height: size.height, columns: Number(grid.columns), rows: Number(grid.rows), panel_ratio: grid.panel_ratio, expected_grid_ratio: expected, actual_grid_ratio: actual, relative_error: relativeError, tolerance, pass, status: pass ? "pass" : "failed" }, null, 2)}\n`, { flag: "wx" });
  return [
    { label: "目标宫格分镜候选图", path: candidatePath, published: false },
    { label: "分镜比例检查", path: ratioPath, published: false },
    { label: "分镜质检报告", path: qcPath, published: false },
    { label: "分镜生成执行回执", path: receiptPath, published: false },
  ];
}

function loadInternalGenerationRequest(path, taskId, requestStage) {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) fail("CHATGPT_INTERNAL_REQUEST_UNAVAILABLE");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const declaredPromptPath = saved.final_model_prompt_path || saved.final_prompt_path;
  const promptPath = declaredPromptPath
    ? (isAbsolute(declaredPromptPath) ? declaredPromptPath : resolve(dirname(path), declaredPromptPath))
    : null;
  const filePrompt = promptPath && existsSync(promptPath) && statSync(promptPath).isFile()
    ? readFileSync(promptPath, "utf8").trim()
    : "";
  const prompt = saved.final_model_prompt || saved.final_prompt || filePrompt;
  const normalized = {
    ...saved,
    final_model_prompt: prompt,
    final_model_prompt_sha256: saved.final_model_prompt_sha256 || sha256Text(prompt),
    execution_parameters: saved.execution_parameters || { requested_output_count: saved.requested_output_count },
    allow_automatic_retry: saved.allow_automatic_retry
      ?? saved.execution_policy?.allow_automatic_retry
      ?? saved.execution_parameters?.allow_automatic_retry,
    request_path: path,
  };
  if (requestStage === "storyboard" && !["target_grid_storyboard", "segment_storyboard"].includes(normalized.asset_type))
    fail("CHATGPT_STORYBOARD_INTERNAL_REQUEST_INVALID");
  if (requestStage === "storyboard" && normalized.asset_type === "segment_storyboard"
      && (!normalized.segment_id || !normalized.segment_time_range))
    fail("CHATGPT_STORYBOARD_INTERNAL_REQUEST_INVALID");
  validateInternalRequest(normalized, taskId);
  if (requestStage === "storyboard") assertStoryboardRequestContract(normalized);
  for (const reference of normalized.reference_images) {
    if (!isAbsolute(reference.path) || !existsSync(reference.path) || !statSync(reference.path).isFile()) fail("CHATGPT_REFERENCE_IMAGE_UNAVAILABLE");
    if (sha256File(reference.path) !== reference.sha256) fail("CHATGPT_REFERENCE_IMAGE_HASH_MISMATCH");
  }
  return normalized;
}

function parseRatio(value) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  return match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}

function pngSize(path) {
  const data = readFileSync(path);
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  fail("CHATGPT_STORYBOARD_IMAGE_DIMENSIONS_UNREADABLE");
}

function validateInternalRequest(value, taskId) {
  if (value?.schema_version !== 2 || value?.task_id !== taskId || value?.request_type !== "internal_image_generation_request") fail("CHATGPT_INTERNAL_REQUEST_INVALID");
  if (!value.final_model_prompt || value.final_model_prompt_sha256 !== sha256Text(value.final_model_prompt)) fail("CHATGPT_FINAL_PROMPT_HASH_INVALID");
  assertPromptClean(value.final_model_prompt);
  if (!Array.isArray(value.reference_images)) fail("CHATGPT_REFERENCE_IMAGES_MISSING");
  if (value.reference_images.length === 0 && value.person_source_method !== "original") fail("CHATGPT_REFERENCE_IMAGES_MISSING");
  const ids = new Set();
  const names = new Set();
  value.reference_images.forEach((item, index) => {
    if (item.order !== index + 1 || !item.ref_id || !item.display_name || !item.upload_name || !item.visual_locator || !item.path || !item.sha256 || !item.role || !item.must_inherit || !item.must_not_inherit) fail("CHATGPT_REFERENCE_BINDING_INVALID");
    if (ids.has(item.ref_id) || names.has(item.upload_name)) fail("CHATGPT_REFERENCE_BINDING_DUPLICATED");
    ids.add(item.ref_id); names.add(item.upload_name);
  });
  if (value.execution_parameters?.requested_output_count !== 1 || value.allow_automatic_retry !== false || value.manual_pack_equivalence?.same_request_required !== true) fail("CHATGPT_INTERNAL_REQUEST_EXECUTION_INVALID");
}

function assertPromptClean(value) {
  const forbidden = [
    /任务包|本地路径|manifest|\bQC\b|\brunner\b|\bAPI\b|费用/i,
    /不复制原片真人脸|new fictional person|not the same face|do not copy the face/i,
    /只作为参考|给故事板用|给视频模型的提示词|干净生图测试/i,
    /只返回\s*1?\s*张图|只生成\s*1\s*张|只生成一张/i,
  ];
  if (forbidden.some((pattern) => pattern.test(String(value)))) fail("CHATGPT_FINAL_PROMPT_CONTAINS_INTERNAL_NOTES");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stateMessage(state) {
  return ({ claimed: "浏览器伴侣已领取任务。", page_ready: "ChatGPT 页面已就绪。", uploading: "正在上传已授权参考图。", submitted: "已提交 1 次生成请求。", waiting_result: "正在等待 ChatGPT 返回图片。" })[state] || `浏览器任务状态：${state}`;
}

function stateError(jobValue) {
  if (jobValue.state === "auth_required") return "CHATGPT_WEB_LOGIN_REQUIRED";
  if (jobValue.state === "submission_unknown") return "CHATGPT_WEB_SUBMISSION_UNKNOWN";
  if (jobValue.state === "blocked" && jobValue.submission_marker_confirmed !== true)
    return `CHATGPT_WEB_PRE_SUBMIT_BLOCKED: ${jobValue.message || "ChatGPT 页面在发送前停止"}`;
  return jobValue.message || "CHATGPT_WEB_BRIDGE_FAILED";
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) result[values[index]] = values[index + 1];
  return result;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
