import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectGridImageBuffer, writeGridInspection } from "./image-grid-contract.mjs";

export const BRIDGE_CLIENT = "chatgpt-companion-v1";
export const HEARTBEAT_MAX_AGE_MS = 20_000;
export const MIN_COMPANION_VERSION = "0.1.16";
export const TERMINAL_JOB_STATES = new Set(["completed", "blocked", "failed", "auth_required", "submission_unknown"]);
export const SAFE_JOB_STATES = new Set([
  "queued", "claimed", "auth_required", "page_ready", "uploading", "submitted",
  "submitting", "waiting_result", "completed", "blocked", "failed", "submission_unknown",
]);
const JOB_TRANSITIONS = {
  queued: new Set(["claimed", "failed"]),
  claimed: new Set(["auth_required", "page_ready", "blocked", "failed"]),
  page_ready: new Set(["uploading", "blocked", "failed"]),
  uploading: new Set(["submitting", "blocked", "failed"]),
  submitting: new Set(["submitted", "submission_unknown"]),
  submitted: new Set(["waiting_result", "submission_unknown"]),
  waiting_result: new Set(["completed", "failed", "submission_unknown"]),
  submission_unknown: new Set(["waiting_result", "completed", "failed"]),
};

export function bridgeRoot(dataRoot) {
  return join(dataRoot, "browser-bridge");
}

export function inspectChatGPTBridge(root, env = process.env, stamp = Date.now()) {
  if (env.WORKBENCH_CHATGPT_WEB_GENERATOR) {
    return { available: true, mode: "simulation", state: "ready", user_message: "模拟网页桥已连接。" };
  }
  const heartbeat = readJson(join(root, "heartbeat.json"), null);
  if (!heartbeat) {
    return { available: false, mode: "companion", state: "companion_not_connected", user_message: "ChatGPT 浏览器伴侣尚未连接。" };
  }
  if (compareVersions(heartbeat.client_version, MIN_COMPANION_VERSION) < 0) {
    return { available: false, mode: "companion", state: "companion_update_required", user_message: `ChatGPT 浏览器伴侣需要重新加载到 ${MIN_COMPANION_VERSION}。` };
  }
  const age = stamp - Date.parse(heartbeat.updated_at || "");
  if (!Number.isFinite(age) || age > HEARTBEAT_MAX_AGE_MS) {
    return { available: false, mode: "companion", state: "companion_offline", user_message: "ChatGPT 浏览器伴侣已离线，请重新打开浏览器伴侣。" };
  }
  if (heartbeat.page_state === "tab_closed") {
    return { available: false, mode: "companion", state: "tab_closed", user_message: "请在已连接浏览器伴侣的 Chrome 中打开 ChatGPT 页面，再检查是否就绪。" };
  }
  if (!["login_required", "login"].includes(heartbeat.page_state) && (heartbeat.logged_in !== true || heartbeat.composer_ready !== true)) {
    return { available: false, mode: "companion", state: "page_not_ready", user_message: "ChatGPT 输入区暂未就绪。请查看页面是否仍在加载、需要验证或登录，待输入框出现后再继续。" };
  }
  if (heartbeat.logged_in !== true || heartbeat.composer_ready !== true) {
    return { available: false, mode: "companion", state: "login_required", user_message: "浏览器伴侣已连接，但 ChatGPT 尚未处于可输入状态。请先在伴侣使用的 Chrome 中登录。" };
  }
  return { available: true, mode: "live", state: "ready", user_message: "ChatGPT 浏览器伴侣已就绪。" };
}

export function recordHeartbeat(root, value, stamp = new Date()) {
  mkdirSync(root, { recursive: true });
  const heartbeat = {
    client: BRIDGE_CLIENT,
    client_version: cleanText(value.client_version, 40) || "0.1.0",
    logged_in: value.logged_in === true,
    composer_ready: value.composer_ready === true,
    page_state: cleanText(value.page_state, 80) || "unknown",
    updated_at: stamp.toISOString(),
  };
  writeJson(join(root, "heartbeat.json"), heartbeat);
  return heartbeat;
}

export function createBrowserJob(root, { task, taskDir, prompt, promptSha256 = null, referencePaths = [], referenceBindings = [], resultContract = null, allowEmptyReferences = false }) {
  const bindings = referenceBindings.length
    ? referenceBindings.map((item, index) => normalizeReferenceBinding(item, index))
    : referencePaths.map((path, index) => normalizeReferenceBinding({ path, order: index + 1 }, index));
  const references = bindings.map((item) => item.path);
  if (references.length === 0 && !allowEmptyReferences) throw new Error("CHATGPT_REFERENCE_IMAGES_MISSING");
  if (new Set(references).size !== references.length) throw new Error("CHATGPT_REFERENCE_IMAGES_DUPLICATED");
  if (new Set(bindings.map((item) => item.ref_id)).size !== bindings.length) throw new Error("CHATGPT_REFERENCE_IDS_DUPLICATED");
  if (new Set(bindings.map((item) => item.upload_name)).size !== bindings.length) throw new Error("CHATGPT_REFERENCE_UPLOAD_NAMES_DUPLICATED");
  for (const binding of bindings) {
    if (!existsSync(binding.path) || !statSync(binding.path).isFile()) throw new Error("CHATGPT_REFERENCE_IMAGE_UNAVAILABLE");
    const actualHash = sha256File(binding.path);
    if (binding.sha256 && binding.sha256 !== actualHash) throw new Error("CHATGPT_REFERENCE_IMAGE_HASH_MISMATCH");
    binding.sha256 = actualHash;
  }
  const actualPromptHash = sha256Text(prompt);
  if (promptSha256 && promptSha256 !== actualPromptHash) throw new Error("CHATGPT_PROMPT_HASH_MISMATCH");
  const id = randomUUID();
  const submissionMarker = `WB-${id.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  const jobDir = join(root, "jobs", id);
  mkdirSync(jobDir, { recursive: true });
  const job = {
    schema_version: 3,
    id,
    task_id: task.id,
    generation_stage: task.generation_stage || null,
    project_name: task.title,
    state: "queued",
    provider: "chatgpt_web",
    prompt,
    prompt_sha256: actualPromptHash,
    submission_marker: submissionMarker,
    submission_marker_confirmed: false,
    verified_attachment_count: 0,
    verified_attachment_names: [],
    attachment_verification_method: null,
    failure_code: null,
    assistant_response_excerpt: null,
    attempt_refund: false,
    browser_tab_id: null,
    conversation_url: null,
    assets: bindings.map((item, index) => ({
      index,
      ref_id: item.ref_id,
      display_name: item.display_name,
      name: item.upload_name,
      path: item.path,
      sha256: item.sha256,
      role: item.role,
      visual_locator: item.visual_locator,
      must_inherit: item.must_inherit,
      must_not_inherit: item.must_not_inherit,
    })),
    required_reference_count: references.length,
    requested_output_count: 1,
    automatic_retry: false,
    result_contract: resultContract,
    source_frame_upload_authorized: task.source_frame_upload_authorized === true || task.person_source_upload_authorized === true,
    task_dir: taskDir,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeJson(join(jobDir, "job.json"), job);
  return job;
}

// This fence covers old jobs without a stage too: an unknown historical request
// must be reconciled before a new image request for the same project is created.
export function pendingBrowserJobForTask(root, taskId, stage = null) {
  const jobsRoot = join(root, "jobs");
  if (!existsSync(jobsRoot)) return null;
  return readdirSync(jobsRoot).map((id) => readJson(join(jobsRoot, id, "job.json"), null))
    .filter((job) => job?.task_id === taskId
      && (!stage || !job.generation_stage || job.generation_stage === `xhs_jewelry_${stage}`)
      && ["queued", "claimed", "page_ready", "uploading", "submitting", "submitted", "waiting_result", "submission_unknown"].includes(job.state))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

export function nextBrowserJob(root) {
  const jobsRoot = join(root, "jobs");
  if (!existsSync(jobsRoot)) return null;
  const jobs = readdirSync(jobsRoot)
    .map((id) => readJson(join(jobsRoot, id, "job.json"), null))
    .filter((job) => job?.state === "queued")
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const job = jobs[0];
  if (!job) return null;
  return updateBrowserJob(root, job.id, { state: "claimed", message: "浏览器伴侣已领取任务。" });
}

export function resumableBrowserJob(root) {
  const jobsRoot = join(root, "jobs");
  if (!existsSync(jobsRoot)) return null;
  return readdirSync(jobsRoot)
    .map((id) => readJson(join(jobsRoot, id, "job.json"), null))
    .filter((job) => ["submitted", "waiting_result", "submission_unknown"].includes(job?.state)
      && job?.submission_marker_confirmed === true
      && Number.isInteger(job?.browser_tab_id)
      && isChatGPTUrl(job?.conversation_url)
      && !job?.result_image_path)
    .sort((a, b) => String(b.submitted_at || b.updated_at).localeCompare(String(a.submitted_at || a.updated_at)))[0] || null;
}

export function manualPendingBrowserJob(root) {
  const jobsRoot = join(root, "jobs");
  if (!existsSync(jobsRoot)) return null;
  return readdirSync(jobsRoot)
    .map((id) => readJson(join(jobsRoot, id, "job.json"), null))
    .filter((job) => job?.state === "submission_unknown" && job?.submission_marker && !job?.result_image_path)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
}

export function getBrowserJob(root, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  return readJson(join(root, "jobs", id, "job.json"), null);
}

export function completedBrowserJobForRequest(root, { taskId, promptSha256, referenceBindings = [] }) {
  const jobsRoot = join(root, "jobs");
  if (!existsSync(jobsRoot)) return null;
  const expectedReferences = referenceBindings.map((item) => ({
    path: resolve(String(item?.path || "")),
    sha256: cleanText(item?.sha256, 64),
  }));
  return readdirSync(jobsRoot)
    .map((id) => readJson(join(jobsRoot, id, "job.json"), null))
    .filter((job) => job?.state === "completed"
      && job?.task_id === taskId
      && job?.prompt_sha256 === promptSha256
      && job?.result_image_path
      && existsSync(job.result_image_path)
      && job.assets?.length === expectedReferences.length
      && expectedReferences.every((expected, index) => {
        const actual = job.assets[index];
        return actual?.path === expected.path
          && (!expected.sha256 || actual?.sha256 === expected.sha256);
      }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
}

export function shouldContinueWaitingForBrowserResult(job) {
  return job?.state === "submission_unknown"
    && job?.submission_marker_confirmed === true
    && !job?.result_image_path;
}

export function updateBrowserJob(root, id, patch) {
  const job = getBrowserJob(root, id);
  if (!job) throw new Error("CHATGPT_BROWSER_JOB_NOT_FOUND");
  const nextState = cleanText(patch.state, 40);
  if (!SAFE_JOB_STATES.has(nextState)) throw new Error("CHATGPT_BROWSER_JOB_STATE_INVALID");
  const resolvingUnknown = job.state === "submission_unknown"
    && JOB_TRANSITIONS.submission_unknown.has(nextState);
  if (TERMINAL_JOB_STATES.has(job.state) && !resolvingUnknown) {
    if (nextState === "submitting") throw new Error("CHATGPT_BROWSER_JOB_ALREADY_CLOSED");
    return job;
  }
  if (nextState !== job.state && !JOB_TRANSITIONS[job.state]?.has(nextState)) throw new Error("CHATGPT_BROWSER_JOB_TRANSITION_INVALID");
  const markerConfirmed = job.submission_marker_confirmed === true || (
    patch.submission_marker_confirmed === true
    && cleanText(patch.submission_marker, 80) === job.submission_marker
  );
  if (nextState === "submitted" && !markerConfirmed) throw new Error("CHATGPT_BROWSER_SUBMISSION_NOT_CONFIRMED");
  const verifiedAttachmentCount = Number.isInteger(patch.verified_attachment_count) && patch.verified_attachment_count >= 0
    ? patch.verified_attachment_count
    : Number(job.verified_attachment_count || 0);
  const verifiedAttachmentNames = Array.isArray(patch.verified_attachment_names)
    ? patch.verified_attachment_names.map((value) => cleanText(value, 120)).filter(Boolean).slice(0, 20)
    : (job.verified_attachment_names || []);
  const attachmentVerificationMethod = cleanText(patch.attachment_verification_method, 80)
    || job.attachment_verification_method
    || null;
  if (nextState === "submitted" && verifiedAttachmentCount !== Number(job.required_reference_count || 0)) {
    throw new Error("CHATGPT_BROWSER_ATTACHMENTS_NOT_CONFIRMED");
  }
  const browserTabId = Number.isInteger(patch.browser_tab_id) && patch.browser_tab_id >= 0 ? patch.browser_tab_id : job.browser_tab_id;
  const conversationUrl = isChatGPTUrl(patch.conversation_url) ? String(patch.conversation_url) : job.conversation_url;
  const updated = {
    ...job,
    state: nextState,
    message: cleanText(patch.message, 500),
    submission_marker_confirmed: markerConfirmed,
    browser_tab_id: browserTabId,
    conversation_url: conversationUrl,
    submitted_turn_fingerprint: markerConfirmed ? (cleanText(patch.submitted_turn_fingerprint, 64) || job.submitted_turn_fingerprint || null) : null,
    verified_attachment_count: verifiedAttachmentCount,
    verified_attachment_names: verifiedAttachmentNames,
    attachment_verification_method: attachmentVerificationMethod,
    failure_code: cleanText(patch.failure_code, 80) || job.failure_code || null,
    assistant_response_excerpt: cleanText(patch.assistant_response_excerpt, 500) || job.assistant_response_excerpt || null,
    attempt_refund: job.attempt_refund === true || patch.attempt_refund === true,
    submitted_at: nextState === "submitted" && markerConfirmed && !job.submitted_at ? new Date().toISOString() : job.submitted_at,
    updated_at: new Date().toISOString(),
  };
  writeJson(join(root, "jobs", id, "job.json"), updated);
  return updated;
}

export function confirmManualBrowserSubmission(root, id, { submissionMarker, browserTabId, conversationUrl }) {
  const job = getBrowserJob(root, id);
  if (!job) throw new Error("CHATGPT_BROWSER_JOB_NOT_FOUND");
  if (job.state !== "submission_unknown") throw new Error("CHATGPT_MANUAL_CONFIRMATION_STATE_INVALID");
  if (cleanText(submissionMarker, 80) !== job.submission_marker) throw new Error("CHATGPT_MANUAL_CONFIRMATION_MARKER_INVALID");
  if (!Number.isInteger(browserTabId) || browserTabId < 0 || !isChatGPTUrl(conversationUrl)) throw new Error("CHATGPT_MANUAL_CONFIRMATION_CONTEXT_INVALID");
  const stamp = new Date().toISOString();
  const updated = {
    ...job,
    state: "waiting_result",
    message: "使用者已确认在固定 ChatGPT 对话中手动发送；系统只接回结果，不会重新上传或再次发送。",
    submission_marker_confirmed: true,
    browser_tab_id: browserTabId,
    conversation_url: String(conversationUrl),
    submitted_turn_fingerprint: `${job.submission_marker}:manual-user-confirmed`,
    submitted_at: job.submitted_at || stamp,
    manual_submission_confirmed: true,
    updated_at: stamp,
  };
  writeJson(join(root, "jobs", id, "job.json"), updated);
  return updated;
}

export function browserJobAsset(root, id, index) {
  const job = getBrowserJob(root, id);
  const asset = job?.assets?.find((item) => item.index === Number(index));
  if (!asset?.path || !existsSync(asset.path) || !statSync(asset.path).isFile()) return null;
  return asset;
}

export async function completeBrowserJob(root, id, imageBuffer, extension = ".png") {
  const job = getBrowserJob(root, id);
  if (!job) throw new Error("CHATGPT_BROWSER_JOB_NOT_FOUND");
  if (job.state === "completed" || ["blocked", "failed", "auth_required"].includes(job.state)) return job;
  if (job.submission_marker_confirmed !== true) throw new Error("CHATGPT_BROWSER_RESULT_SOURCE_UNCONFIRMED");
  if (!["submitted", "waiting_result", "submission_unknown"].includes(job.state)) throw new Error("CHATGPT_BROWSER_RESULT_NOT_EXPECTED");
  const inspection = await inspectGridImageBuffer(imageBuffer, job.result_contract);
  if (!inspection.pass) {
    const message = inspection.code === "storyboard_safe_grid_not_equal"
      ? "图片已返回，但六格没有保持 3×2 等分，上下两排高度不一致；已判退，不会自动重生。"
      : "图片已返回，但整张画布比例不符合 3×2、单格 9:16 的要求；已判退，不会自动重生。";
    return rejectBrowserJobResult(root, id, { inspection, message });
  }
  const inspectionPath = join(root, "jobs", id, "result-qc.json");
  writeGridInspection(inspectionPath, inspection);
  const safeExtension = /^\.(png|jpe?g|webp)$/i.test(extension) ? extension.toLowerCase() : ".png";
  const imagePath = join(root, "jobs", id, `result${safeExtension}`);
  writeFileSync(imagePath, imageBuffer, { flag: "wx" });
  const updated = { ...job, state: "completed", result_image_path: imagePath, result_qc_path: inspectionPath, message: job.state === "submission_unknown" ? "已从 ChatGPT 页面接回先前提交的图片；没有再次发送。" : "ChatGPT 已返回 1 张图片。", updated_at: new Date().toISOString() };
  writeJson(join(root, "jobs", id, "job.json"), updated);
  return updated;
}

export function rejectBrowserJobResult(root, id, { inspection, message } = {}) {
  const job = getBrowserJob(root, id);
  if (!job) throw new Error("CHATGPT_BROWSER_JOB_NOT_FOUND");
  const inspectionPath = join(root, "jobs", id, "result-qc.json");
  writeGridInspection(inspectionPath, inspection || { pass: false, status: "failed", code: "manually_rejected" });
  const rejected = {
    ...job,
    state: "failed",
    message: cleanText(message, 500) || "图片未通过结果校验，已判退，不会自动重生。",
    result_qc_path: inspectionPath,
    result_rejected: true,
    completed_at: null,
    updated_at: new Date().toISOString(),
  };
  writeJson(join(root, "jobs", id, "job.json"), rejected);
  return rejected;
}

export function publicBrowserJob(job) {
  if (!job) return null;
  return {
    schema_version: job.schema_version,
    id: job.id,
    task_id: job.task_id,
    project_name: job.project_name,
    state: job.state,
    prompt: job.prompt,
    prompt_sha256: job.prompt_sha256,
    submission_marker: job.submission_marker,
    submission_marker_confirmed: job.submission_marker_confirmed === true,
    verified_attachment_count: Number(job.verified_attachment_count || 0),
    attachment_verification_method: job.attachment_verification_method || null,
    browser_tab_id: Number.isInteger(job.browser_tab_id) ? job.browser_tab_id : null,
    conversation_url: isChatGPTUrl(job.conversation_url) ? job.conversation_url : null,
    assets: (job.assets || []).map(({ index, ref_id, display_name, name, sha256, role, visual_locator }) => ({ index, ref_id, display_name, name, sha256, role, visual_locator })),
    required_reference_count: job.required_reference_count,
    requested_output_count: 1,
    automatic_retry: false,
  };
}

function normalizeReferenceBinding(value, index) {
  const path = resolve(String(value?.path || ""));
  const order = Number(value?.order || index + 1);
  if (order !== index + 1) throw new Error("CHATGPT_REFERENCE_ORDER_INVALID");
  const refId = cleanText(value?.ref_id, 24) || `REF-${String(index + 1).padStart(2, "0")}`;
  const displayName = cleanText(value?.display_name, 80) || `参考图${index + 1}`;
  const extension = /^\.(png|jpe?g|webp)$/i.test(extname(path)) ? extname(path).toLowerCase() : ".png";
  const uploadName = cleanUploadName(value?.upload_name || `${refId}_${displayName}${extension}`);
  return {
    path, order, ref_id: refId, display_name: displayName, upload_name: uploadName,
    sha256: cleanText(value?.sha256, 64), role: cleanText(value?.role, 300),
    visual_locator: cleanText(value?.visual_locator, 300),
    must_inherit: cleanText(value?.must_inherit, 500), must_not_inherit: cleanText(value?.must_not_inherit, 500),
  };
}

function cleanUploadName(value) {
  const cleaned = cleanText(value, 120).replace(/[\\/:*?"<>|]/g, "_");
  if (!cleaned || !/\.(png|jpe?g|webp)$/i.test(cleaned)) throw new Error("CHATGPT_REFERENCE_UPLOAD_NAME_INVALID");
  return cleaned;
}

function sha256Text(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function cleanText(value, limit) {
  return String(value || "").replace(/\0/g, "").trim().slice(0, limit);
}

function isChatGPTUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch { return false; }
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "0").split(".").map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}
