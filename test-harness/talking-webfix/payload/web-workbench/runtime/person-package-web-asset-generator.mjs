#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { bridgeRoot, createBrowserJob, getBrowserJob, shouldContinueWaitingForBrowserResult, updateBrowserJob } from "./chatgpt-web-bridge.mjs";
import { createStoryboardSafeGridContract, promptWithStoryboardSafeGridContract } from "./image-grid-contract.mjs";

const args = parseArgs(process.argv.slice(2));
const snapshotPath = args["--task-json"];
const taskCardPath = args["--task-card"];
const taskDir = args["--task-dir"];
const outputPath = args["--output"];
const assetLabel = args["--asset-label"];
if (!snapshotPath || !taskCardPath || !taskDir || !outputPath || !assetLabel) fail("PERSON_PACKAGE_WEB_ARGUMENTS_INVALID");

const snapshot = readJson(snapshotPath, "PERSON_PACKAGE_SNAPSHOT_INVALID");
const taskCard = readJson(taskCardPath, "PERSON_PACKAGE_TASK_CARD_INVALID");
const route = readJson(taskCard.route_receipt, "PERSON_PACKAGE_ROUTE_RECEIPT_INVALID");
validateTaskCard(taskCard, route);
const references = taskCard.reference_images.map((item, index) => ({
  path: item.path,
  order: index + 1,
  ref_id: `REF-${String(index + 1).padStart(2, "0")}`,
  display_name: item.display_name || `${assetLabel}参考图${index + 1}`,
  upload_name: `REF-${String(index + 1).padStart(2, "0")}_${safeName(item.display_name || assetLabel)}${imageExtension(item.path)}`,
  sha256: sha256File(item.path),
  visual_locator: `第 ${index + 1} 张上传图，以编号与画面共同定位`,
  role: item.role,
  must_inherit: item.must_inherit,
  must_not_inherit: item.must_not_inherit,
}));
let prompt = String(taskCard.final_model_prompt || taskCard.final_prompt || "").trim();
if (!prompt) fail("PERSON_PACKAGE_WEB_PROMPT_MISSING");
const resultContract = assetLabel === "分镜安全提交版"
  ? await createStoryboardSafeGridContract(references[0].path, { columns: 3, rows: 2, panelRatio: "9:16" })
  : null;
if (resultContract) prompt = promptWithStoryboardSafeGridContract(prompt, resultContract, references[0].display_name);
const plannedTargetPath = taskCard.output?.project_output_path;
if (!plannedTargetPath || !isInside(plannedTargetPath, route.task_root) || existsSync(plannedTargetPath)) fail("PERSON_PACKAGE_WEB_TARGET_INVALID");
if (args["--preflight-only"] === "true") {
  process.stdout.write(`${JSON.stringify({ status: "ready", asset_label: assetLabel, reference_count: references.length, target_path: plannedTargetPath, provider: "chatgpt_web", external_request_started: false })}\n`);
  process.exit(0);
}
const root = process.env.WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT || bridgeRoot(process.env.WORKBENCH_DATA_ROOT || join(process.cwd(), "data"));
const resumeBrowserJobId = args["--resume-browser-job"];
const job = resumeBrowserJobId
  ? getBrowserJob(root, resumeBrowserJobId)
  : createBrowserJob(root, {
    task: { id: snapshot.task_id, title: snapshot.project_name, source_frame_upload_authorized: true },
    taskDir,
    prompt,
    promptSha256: sha256Text(prompt),
    referenceBindings: references,
    resultContract,
  });
if (!job || job.task_id !== snapshot.task_id || job.prompt_sha256 !== sha256Text(prompt)) fail("CHATGPT_BROWSER_RECOVERY_JOB_MISMATCH");
process.stdout.write(resumeBrowserJobId
  ? "正在接回已完成的 ChatGPT 图片；不会重新上传或再次发送。\n"
  : "ChatGPT 网页伴侣任务已建立，正在等待同一 Chrome 页面接收。\n");

const timeoutMs = Number(process.env.WORKBENCH_PERSON_PACKAGE_WEB_TIMEOUT_MS || 60 * 60 * 1000);
const deadline = Date.now() + Math.max(30_000, timeoutMs);
let lastState = "";
let externalMarkerWritten = Boolean(resumeBrowserJobId);
while (Date.now() < deadline) {
  const current = getBrowserJob(root, job.id);
  if (!current) fail("CHATGPT_BROWSER_JOB_NOT_FOUND");
  if (["submitting", "submitted", "waiting_result", "completed"].includes(current.state) && !externalMarkerWritten) {
    process.stdout.write("__WORKBENCH_EXTERNAL_REQUEST_STARTED__\n");
    externalMarkerWritten = true;
  }
  if (current.state !== lastState) {
    lastState = current.state;
    process.stdout.write(`${current.message || stateMessage(current.state)}\n`);
  }
  if (current.state === "completed") finish(current);
  if (["auth_required", "blocked", "failed"].includes(current.state)) fail(stateError(current));
  if (current.state === "submission_unknown" && !shouldContinueWaitingForBrowserResult(current)) fail(stateError(current));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
}
const timedOut = getBrowserJob(root, job.id);
if (timedOut && !["completed", "blocked", "failed", "submission_unknown"].includes(timedOut.state)) {
  const mayHaveSubmitted = ["submitting", "submitted", "waiting_result"].includes(timedOut.state);
  updateBrowserJob(root, job.id, {
    state: mayHaveSubmitted ? "submission_unknown" : "failed",
    message: mayHaveSubmitted ? "本项可能已经提交，但结果状态无法确认；系统不会自动再发。" : "浏览器伴侣等待超时，本项没有进入提交状态。",
  });
}
fail("CHATGPT_WEB_BRIDGE_TIMEOUT");

function finish(current) {
  if (!current.result_image_path || !existsSync(current.result_image_path)) fail("CHATGPT_RESULT_IMAGE_MISSING");
  const targetPath = plannedTargetPath;
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(current.result_image_path, targetPath, constants.COPYFILE_EXCL);
  const registration = registerCandidate(route, targetPath);
  const receiptPath = join(taskDir, `${safeName(assetLabel)}-chatgpt-web-receipt.json`);
  writeFileSync(receiptPath, `${JSON.stringify({
    schema_version: 1,
    status: "success",
    generation_provider: "chatgpt_web",
    browser_companion: true,
    browser_job_id: current.id,
    task_id: snapshot.task_id,
    source_task_card: taskCardPath,
    source_reference_bindings: references,
    final_model_prompt_sha256: sha256Text(prompt),
    result_contract: current.result_contract || resultContract,
    result_qc_path: current.result_qc_path || null,
    raw_generation_path: current.result_image_path,
    project_output_path: targetPath,
    project_output_sha256: sha256File(targetPath),
    candidate_registration: registration,
    automatic_retry: false,
    approval_status: "needs_review",
  }, null, 2)}\n`, { flag: "wx" });
  writeFileSync(outputPath, `${JSON.stringify({
    status: "completed",
    external_request_started: true,
    artifact: { label: assetLabel, path: targetPath, published: false, approval_status: "needs_review" },
    receipt: { label: `${assetLabel}执行回执`, path: receiptPath, published: false },
  }, null, 2)}\n`, { flag: "wx" });
  process.exit(0);
}

function validateTaskCard(card, routeValue) {
  if (card?.schema_version !== 2 || !Array.isArray(card.reference_images) || card.reference_images.length === 0) fail("PERSON_PACKAGE_TASK_CARD_INVALID");
  if (card.requested_output_count !== 1 || card.execution_policy?.allow_automatic_retry !== false) fail("PERSON_PACKAGE_TASK_CARD_EXECUTION_INVALID");
  if (routeValue?.status !== "ready" || routeValue.task_root !== card.project_dir) fail("PERSON_PACKAGE_ROUTE_MISMATCH");
  if (!card.authorization?.generation_authorized || !card.authorization?.real_person_upload_authorized) fail("PERSON_PACKAGE_UPLOAD_AUTHORIZATION_REQUIRED");
  for (const reference of card.reference_images) {
    if (!reference.upload_authorized || !reference.path || !isAbsolute(reference.path) || !existsSync(reference.path) || !statSync(reference.path).isFile()) fail("PERSON_PACKAGE_REFERENCE_INVALID");
  }
}

function registerCandidate(routeValue, filePath) {
  const tool = join(routeValue.workspace_root, "系统文件_无需打开", "tools", "scripts", "workbench-artifacts", "artifact_manager.py");
  if (!existsSync(tool)) fail("PERSON_PACKAGE_ARTIFACT_TOOL_MISSING");
  const output = execFileSync("python3", [tool, "register", "--workbench", routeValue.workspace_root, "--file", filePath, "--task-id", routeValue.task_id, "--project-name", routeValue.project_name, "--category", routeValue.category, "--origin-step", "chatgpt-web-person-package", "--lifecycle-status", "intermediate", "--protection-level", "review", "--cleanup-status", "unknown"], { encoding: "utf8" });
  return JSON.parse(output);
}

function isInside(path, root) {
  if (!isAbsolute(path) || !isAbsolute(root)) return false;
  const inside = relative(resolve(root), resolve(path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

function readJson(path, error) {
  if (!path || !isAbsolute(path) || !existsSync(path)) fail(error);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { fail(error); }
}

function imageExtension(path) {
  const value = extname(path).toLowerCase();
  return /^\.(png|jpe?g|webp)$/.test(value) ? value : ".png";
}

function safeName(value) {
  return String(value || "asset").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 64);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stateMessage(state) {
  return ({ claimed: "浏览器伴侣已领取任务。", page_ready: "ChatGPT 页面已就绪。", uploading: "正在上传已授权参考图。", submitted: "已提交 1 次生成请求。", waiting_result: "正在等待 ChatGPT 返回图片。" })[state] || `浏览器任务状态：${state}`;
}

function stateError(job) {
  if (job.state === "auth_required") return "CHATGPT_WEB_LOGIN_REQUIRED";
  if (job.state === "submission_unknown") return "CHATGPT_WEB_SUBMISSION_UNKNOWN";
  return job.message || "CHATGPT_WEB_BRIDGE_FAILED";
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
