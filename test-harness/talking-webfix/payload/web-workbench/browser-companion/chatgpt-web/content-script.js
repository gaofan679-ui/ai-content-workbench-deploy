/* global chrome */

let runningJobId = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bridge-probe") {
    const composer = findComposer();
    sendResponse({ loggedIn: Boolean(composer), composerReady: Boolean(composer), pageState: composer ? "ready" : "login_or_loading" });
    return false;
  }
  if (message?.type === "bridge-marker-probe") {
    sendResponse({ found: Boolean(userTurnForMarker(message.marker)) });
    return false;
  }
  if (message?.type === "bridge-run-job") {
    if (runningJobId) { sendResponse({ accepted: false, reason: "busy" }); return false; }
    runningJobId = message.job.id;
    void runJob(message.job, message.context || {}).finally(() => { runningJobId = null; });
    sendResponse({ accepted: true });
    return false;
  }
  if (message?.type === "bridge-resume-job") {
    if (runningJobId) { sendResponse({ accepted: false, reason: "busy" }); return false; }
    runningJobId = message.job.id;
    void resumeJob(message.job).finally(() => { runningJobId = null; });
    sendResponse({ accepted: true });
    return false;
  }
  return false;
});

async function resumeJob(job) {
  try {
    const submittedTurn = userTurnForMarker(job.submission_marker);
    if (!submittedTurn) throw new Error("当前页面没有本任务校验码，不能接回其他对话的图片");
    const assetResponse = await chrome.runtime.sendMessage({ type: "bridge-assets", job });
    if (!assetResponse?.ok) throw new Error(assetResponse?.error || "参考图核对失败");
    if (job.required_reference_count > 0 && !assetResponse.assets?.length) throw new Error("没有可核对的参考图");
    const referenceImages = new Set((assetResponse.assets || []).map((asset) => asset.base64));
    await status(job.id, "waiting_result", "已恢复结果接收，不会重新上传或再次提交。");
    const { blob, base64 } = await waitForNewImage(new Set(), new Set(), referenceImages, submittedTurn, 2 * 60 * 1000, job.submission_marker);
    const result = await chrome.runtime.sendMessage({ type: "bridge-result", jobId: job.id, mimeType: blob.type || "image/png", base64 });
    if (!result?.ok) throw new Error(result?.error || "生成结果回传失败");
  } catch (error) {
    if (isTerminalAssistantFailure(error)) {
      await terminal(job.id, "failed", terminalAssistantFailureMessage(error), terminalAssistantFailureEvidence(error));
      return;
    }
    await terminal(job.id, "submission_unknown", "已提交的请求无法自动确认结果，系统不会再次发送。");
  }
}

async function runJob(job, context) {
  let clickAttempted = false;
  let submissionConfirmed = false;
  let submissionStarted = false;
  if (!findComposer()) return terminal(job.id, "auth_required", "ChatGPT 尚未登录，或输入区还没有加载完成。");
  const existingImageElements = new Set(conversationImages());
  const existingImageSources = new Set([...existingImageElements].map((image) => image.currentSrc || image.src));
  const existingUserTurns = new Set(userTurns());
  try {
    await status(job.id, "page_ready", "ChatGPT 页面已就绪。", {
      browser_tab_id: Number.isInteger(context.tabId) ? context.tabId : null,
      conversation_url: location.href,
    });
    const assetResponse = await chrome.runtime.sendMessage({ type: "bridge-assets", job });
    if (!assetResponse?.ok) throw new Error(assetResponse?.error || "参考图读取失败");
    if (job.required_reference_count > 0 && !assetResponse.assets?.length) throw new Error("没有可上传的参考图");
    const referenceImages = new Set((assetResponse.assets || []).map((asset) => asset.base64));
    let attachmentEvidence = emptyAttachmentEvidence();
    if ((assetResponse.assets || []).length > 0) {
      await status(job.id, "uploading", `正在上传 ${assetResponse.assets.length} 张已授权参考图。`);
      attachmentEvidence = await uploadAssets(assetResponse.assets);
    } else {
      await status(job.id, "uploading", "本次为文字创建，不上传参考图。");
    }
    await status(job.id, "uploading", "参考图已就绪，正在写入并核对生图要求；尚未正式提交。", {
      browser_tab_id: Number.isInteger(context.tabId) ? context.tabId : null,
      conversation_url: location.href,
      ...attachmentEvidence,
    });
    const markedPrompt = promptWithMarker(job.prompt, job.submission_marker);
    // ChatGPT may replace the composer DOM node after an attachment is added.
    // Always acquire the live composer after upload instead of writing to the stale node.
    const composer = await waitForStableComposer(30_000);
    await waitForComposerContentSettled(composer, 15_000);
    fillComposer(composer, markedPrompt);
    await verifyComposerPrompt(markedPrompt, 5000);
    const sendButton = await waitForSendButton(20_000);
    if (assetResponse.assets?.length) attachmentEvidence = await waitForAttachmentsBeforeSend(assetResponse.assets, 10_000);
    submissionStarted = true;
    await status(job.id, "submitting", "正在提交唯一一次生成请求；此状态不会自动重试。", {
      browser_tab_id: Number.isInteger(context.tabId) ? context.tabId : null,
      conversation_url: location.href,
    });
    const liveComposer = findComposer();
    if (!liveComposer || !liveComposer.isConnected) throw new Error("发送前没有找到 ChatGPT 的真实输入框，已阻断");
    await verifyComposerPrompt(markedPrompt, 1000);
    clickAttempted = true;
    sendButton.click();
    const submittedTurn = await waitForSubmittedUserTurn(existingUserTurns, job.submission_marker, 30_000);
    submissionConfirmed = true;
    await status(job.id, "submitted", "ChatGPT 对话已出现本任务消息，确认提交成功。", {
      submission_marker: job.submission_marker,
      submission_marker_confirmed: true,
      browser_tab_id: Number.isInteger(context.tabId) ? context.tabId : null,
      conversation_url: location.href,
      submitted_turn_fingerprint: `${job.submission_marker}:${normalizeText(submittedTurn.textContent).length}`,
      ...attachmentEvidence,
    });
    await status(job.id, "waiting_result", "正在等待 ChatGPT 返回图片；页面明确报错会立即停止，超过 10 分钟仍无结果会暂停核对，绝不会自动重发。");
    const { blob, base64 } = await waitForNewImage(existingImageElements, existingImageSources, referenceImages, submittedTurn, 10 * 60 * 1000, job.submission_marker);
    const result = await chrome.runtime.sendMessage({ type: "bridge-result", jobId: job.id, mimeType: blob.type || "image/png", base64 });
    if (!result?.ok) throw new Error(result?.error || "生成结果回传失败");
  } catch (error) {
    const currentMessage = String(error?.message || error);
    if (isTerminalAssistantFailure(error)) {
      await terminal(job.id, "failed", terminalAssistantFailureMessage(error), terminalAssistantFailureEvidence(error));
      return;
    }
    const state = submissionStarted || submissionConfirmed || clickAttempted ? "submission_unknown" : "blocked";
    await terminal(job.id, state, state === "submission_unknown" ? `提交环节中断，结果尚待核实，系统不会自动再发一次。${currentMessage}` : currentMessage, {
      failure_code: error?.uploadFailureCode || null,
    });
  }
}

function findComposer() {
  return document.querySelector("#prompt-textarea") || document.querySelector('textarea[placeholder]') || document.querySelector('[contenteditable="true"][data-virtualkeyboard]') || document.querySelector('main [contenteditable="true"]');
}

async function waitForStableComposer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let candidate = null;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const current = findComposer();
    if (current?.isConnected && current === candidate) stableReads += 1;
    else {
      candidate = current?.isConnected ? current : null;
      stableReads = candidate ? 1 : 0;
    }
    if (candidate && stableReads >= 3) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("ChatGPT 新对话输入框一直在重载，尚未稳定，未提交生成请求");
}

async function waitForComposerContentSettled(composer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const stableWindowMs = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname) ? 2500 : 300;
  let lastValue = normalizeText(composerValue(composer));
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    if (!composer.isConnected) throw new Error("ChatGPT 输入框在恢复草稿时被替换，未提交生成请求");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const currentValue = normalizeText(composerValue(composer));
    if (currentValue !== lastValue) {
      lastValue = currentValue;
      unchangedSince = Date.now();
      continue;
    }
    if (Date.now() - unchangedSince >= stableWindowMs) return;
  }
  throw new Error("ChatGPT 旧草稿一直在变化，尚未稳定，未提交生成请求");
}

async function uploadAssets(assets) {
  const composer = await waitForStableComposer(30_000);
  await waitForComposerContentSettled(composer, 15_000);
  const scope = attachmentScope();
  if (!scope) throw uploadFailure("ATTACHMENT_SCOPE_MISSING", "无法核对当前输入区的附件，已在发送前停止。请查看原页面。");
  const input = selectAttachmentInput(scope, assets);
  const evidenceBefore = attachmentEvidenceSnapshot();
  if (evidenceBefore.items.length || normalizeText(composerValue(findComposer()))) {
    throw uploadFailure("ATTACHMENT_DRAFT_PRESENT", "原页面已有草稿或附件，已保留并停止发送。请先查看原页面。");
  }
  const transfer = new DataTransfer();
  for (const asset of assets) transfer.items.add(new File([base64ToBytes(asset.base64)], asset.name, { type: asset.mimeType }));
  input.files = transfer.files;
  if (input.files.length !== assets.length) throw new Error(`参考图没有完整附加：任务需要 ${assets.length} 张，页面只准备了 ${input.files.length} 张`);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return waitForAttachmentUpload(assets, evidenceBefore, 45_000);
}

async function waitForAttachmentUpload(assets, evidenceBefore, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (attachmentErrorElement()) throw uploadFailure("ATTACHMENT_UPLOAD_ERROR", "页面显示附件上传失败，已在发送前停止。请查看原页面的附件提示。");
    if (!attachmentScope()) throw uploadFailure("ATTACHMENT_SCOPE_MISSING", "上传过程中输入区暂不可核对，已停止发送。请查看原页面。");
    const evidence = attachmentUploadEvidence(assets, evidenceBefore);
    if (evidence) return evidence;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw uploadFailure("ATTACHMENT_UPLOAD_TIMEOUT", `等待参考图上传完成超时：任务需要 ${assets.length} 张，页面未能确认附件已就绪；尚未发送生成请求。`);
}

function uploadFailure(code, message) {
  return Object.assign(new Error(message), { uploadFailureCode: code });
}

function attachmentScope() {
  const composer = findComposer();
  if (!composer?.isConnected) return null;
  // Never count attachments in historical conversation turns or another composer.
  const scope = composer.closest('form, [data-testid="composer"], [data-testid="composer-container"]');
  return scope && !scope.querySelector('[data-message-author-role]') ? scope : null;
}

function selectAttachmentInput(scope, assets) {
  const accepts = (input) => {
    if (input.disabled || !input.isConnected || (assets.length > 1 && !input.multiple)) return false;
    const accept = String(input.accept || "").toLowerCase().split(",").map((part) => part.trim()).filter(Boolean);
    return assets.every((asset) => !accept.length || accept.some((type) => type === "*/*" || type === asset.mimeType?.toLowerCase()
      || (type === "image/*" && asset.mimeType?.startsWith("image/")) || (type.startsWith(".") && asset.name.toLowerCase().endsWith(type))));
  };
  const local = [...scope.querySelectorAll('input[type="file"]')].filter(accepts);
  // A portalled file control is usable only when there is exactly one compatible control.
  const inputs = local.length ? local : [...document.querySelectorAll('input[type="file"]')].filter(accepts);
  if (inputs.length !== 1) throw uploadFailure("ATTACHMENT_INPUT_AMBIGUOUS", "无法确定当前对话的图片上传入口，已在发送前停止。请查看原页面。");
  return inputs[0];
}

function fillComposer(composer, text) {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set;
    setter?.call(composer, text);
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, text);
    // ChatGPT's ProseMirror composer may split multiline text into block nodes,
    // or reject execCommand outside a direct user gesture. Fall back to the
    // contenteditable surface and let its input observer reconcile the change.
    if (!inserted || normalizeText(composerValue(composer)) !== normalizeText(text)) composer.innerText = text;
  }
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  composer.dispatchEvent(new Event("change", { bubbles: true }));
}

async function verifyComposerPrompt(prompt, timeoutMs) {
  const expected = normalizeText(prompt);
  try {
    await waitFor(() => {
      const current = findComposer();
      return current?.isConnected && normalizeText(composerValue(current)) === expected;
    }, timeoutMs);
  } catch {
    throw new Error("提示词没有稳定写入 ChatGPT 输入框，已在发送前阻断");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const current = findComposer();
  if (!current?.isConnected || normalizeText(composerValue(current)) !== expected) throw new Error("提示词没有稳定写入 ChatGPT 输入框，已在发送前阻断");
}

async function waitForSendButton(timeoutMs) {
  return waitFor(() => {
    const candidates = [
      document.querySelector('button[data-testid="send-button"]'),
      document.querySelector('button[aria-label="Send prompt"]'),
      document.querySelector('button[aria-label="发送提示"]'),
      findButton(["Send", "发送"]),
    ].filter(Boolean);
    return candidates.find((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true") || null;
  }, timeoutMs);
}

async function waitForSubmittedUserTurn(existingUserTurns, marker, timeoutMs) {
  return waitFor(() => userTurns().find((root) => !existingUserTurns.has(root) && normalizeText(root.textContent).includes(marker)) || null, timeoutMs);
}

async function waitForNewImage(existingElements, existingSources, referenceImages, submittedTurn, timeoutMs, marker) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Editing and resending creates a new ChatGPT branch and replaces the old
    // message node. Rebind only to the latest visible user turn carrying the
    // same unique workbench marker; never accept an unrelated branch.
    const currentSubmittedTurn = latestUserTurnForMarker(marker) || submittedTurn;
    const failure = terminalAssistantFailureAfter(currentSubmittedTurn);
    if (failure) throw terminalAssistantFailureError(failure);
    const candidates = conversationImagesAfter(currentSubmittedTurn).filter((image) => {
      const source = image.currentSrc || image.src;
      return source && !existingElements.has(image) && !existingSources.has(source) && image.naturalWidth >= 256 && image.naturalHeight >= 256;
    });
    for (const image of candidates.reverse()) {
      try {
        const response = await fetch(image.currentSrc || image.src);
        if (!response.ok) continue;
        const blob = await response.blob();
        const base64 = await blobToBase64(blob);
        if (referenceImages.has(base64)) continue;
        return { image, blob, base64 };
      } catch { /* image may still be loading */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("等待 ChatGPT 生成结果超时");
}

function conversationImages() {
  const assistantRoots = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const explicit = assistantRoots.flatMap((root) => [...root.querySelectorAll("img")]);
  const fallback = conversationTurns().flatMap((root) => [...root.querySelectorAll("img")]).filter((image) => !image.closest('[data-message-author-role="user"]'));
  return [...new Set([...explicit, ...fallback])];
}

function conversationImagesAfter(node) {
  return conversationImages().filter((image) => Boolean(node.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING));
}

function terminalAssistantFailureAfter(node) {
  if (!node) return null;
  const patterns = [
    "something went wrong while generating your image",
    "we had trouble generating your image",
    "couldn't generate your image",
    "could not generate your image",
    "生成图片时出现问题",
    "图片生成失败",
    "无法生成图片",
  ];
  const assistantTurns = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    .filter((root) => Boolean(node.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING));
  for (const root of assistantTurns) {
    const text = normalizeText(root.textContent);
    const question = text.match(/^\[WB_FEEDBACK_QUESTION\]([\s\S]{1,400}?)\[\/WB_FEEDBACK_QUESTION\]$/);
    if (question && !root.querySelector("img")) {
      return { code: "CHATGPT_FEEDBACK_CLARIFICATION_REQUIRED", text: question[1].trim() };
    }
    const lower = text.toLowerCase();
    if (patterns.some((pattern) => lower.includes(pattern))) return { code: "CHATGPT_IMAGE_GENERATION_FAILED", text };
    const missingReference = (
      /(没有|没|未|无法|看不到).{0,18}(收到|读取|查看|找到).{0,30}(参考图|图片|附件|文件)/.test(text)
      || /(请|需要).{0,18}(重新|再).{0,8}上传/.test(text)
      || /(?:did not|didn't|have not|haven't|cannot|can't|could not|couldn't).{0,40}(?:receive|see|access|find).{0,40}(?:reference|image|attachment|file)/i.test(text)
      || /please.{0,20}(?:re-?upload|upload again)/i.test(text)
    );
    if (missingReference) return { code: "CHATGPT_REFERENCE_UPLOAD_NOT_CONFIRMED", text };
  }
  return null;
}

function terminalAssistantFailureError(failure) {
  const error = new Error(failure.code === "CHATGPT_FEEDBACK_CLARIFICATION_REQUIRED"
    ? "ChatGPT 需要补充修改说明"
    : failure.code === "CHATGPT_REFERENCE_UPLOAD_NOT_CONFIRMED"
    ? "ChatGPT 已明确说明未收到参考图"
    : "ChatGPT 已明确返回图片生成失败");
  error.code = failure.code;
  error.pageMessage = normalizeText(failure.text).slice(0, 240);
  return error;
}

function isTerminalAssistantFailure(error) {
  return ["CHATGPT_IMAGE_GENERATION_FAILED", "CHATGPT_REFERENCE_UPLOAD_NOT_CONFIRMED", "CHATGPT_FEEDBACK_CLARIFICATION_REQUIRED"].includes(error?.code);
}

function terminalAssistantFailureMessage(error) {
  if (error?.code === "CHATGPT_FEEDBACK_CLARIFICATION_REQUIRED") return `需要补充修改说明：${error.pageMessage}`;
  const detail = error?.pageMessage ? ` 页面提示：${error.pageMessage}` : "";
  if (error?.code === "CHATGPT_REFERENCE_UPLOAD_NOT_CONFIRMED") {
    return `ChatGPT 已明确说明没有收到参考图。本次已立即停止，不再继续等待；这属于网页附件提交故障，本次生成次数将退还。${detail}`;
  }
  return `ChatGPT 已明确返回图片生成失败。本次请求已提交但没有产出图片；工作台不会后台自动重试，可以由用户手动重新提交一次。${detail}`;
}

function terminalAssistantFailureEvidence(error) {
  return {
    failure_code: error?.code || null,
    assistant_response_excerpt: error?.pageMessage || null,
    attempt_refund: error?.code === "CHATGPT_REFERENCE_UPLOAD_NOT_CONFIRMED",
  };
}

function conversationTurns() {
  return [...document.querySelectorAll('article[data-testid^="conversation-turn"], [data-testid^="conversation-turn-"]')];
}

function userTurns() {
  return [...document.querySelectorAll('[data-message-author-role="user"]')];
}

function userTurnForMarker(marker) {
  if (!marker) return null;
  return latestUserTurnForMarker(marker);
}

function latestUserTurnForMarker(marker) {
  if (!marker) return null;
  return userTurns().filter((root) => normalizeText(root.textContent).includes(marker)).at(-1) || null;
}

function composerValue(composer) {
  return composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.innerText;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function findButton(labels) {
  return [...document.querySelectorAll("button")].find((button) => {
    const value = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
    return labels.some((label) => value.toLowerCase().includes(label.toLowerCase()));
  }) || null;
}

async function waitFor(check, timeoutMs, intervalMs = 250, label = "页面控件") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待${label}超时`);
}

async function status(jobId, state, message, evidence = {}) {
  const response = await chrome.runtime.sendMessage({ type: "bridge-status", jobId, state, message, ...evidence });
  if (!response?.ok) throw new Error(response?.error || "状态回传失败");
  if (response.value?.job?.state && response.value.job.state !== state) throw new Error("原任务已暂停或结束，停止本次浏览器操作。");
}

async function terminal(jobId, state, message, evidence = {}) {
  try { await status(jobId, state, message, evidence); } finally { chrome.runtime.sendMessage({ type: "bridge-terminal", jobId }); }
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function promptWithMarker(prompt, marker) {
  if (!marker) throw new Error("任务缺少提交校验码，已在发送前阻断");
  return `${String(prompt || "").trim()}\n\n工作台任务校验码：${marker}`;
}

function attachmentUploadEvidence(assets, before) {
  if (uploadProgressElement() || attachmentErrorElement()) return null;
  const snapshot = attachmentEvidenceSnapshot();
  if (!snapshot.scope || snapshot.items.length !== before.items.length + assets.length) return null;
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) return null;
  const remaining = snapshot.items.filter((item) => !before.items.some((old) => old.element === item.element));
  for (const asset of assets) {
    const name = normalizeText(asset.name);
    const index = remaining.findIndex((item) => item.labels.some((label) => attachmentLabelMatches(label, name)));
    if (index < 0) return null;
    remaining.splice(index, 1);
  }
  return {
    verified_attachment_count: assets.length,
    verified_attachment_names: assets.map((asset) => asset.name),
    attachment_verification_method: "composer_filenames",
  };
}

function emptyAttachmentEvidence() {
  return { verified_attachment_count: 0, verified_attachment_names: [], attachment_verification_method: "no_references" };
}

function attachmentLabelMatches(label, name) {
  if (label === name || label.endsWith(`：${name}`) || label.endsWith(`: ${name}`) || label.endsWith(` ${name}`)) return true;
  // ChatGPT may append a duplicate-name counter only after the upload finishes.
  // Keep the complete stem, extension and attachment-count checks intact.
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[ ：])${escape(name.slice(0, dot))} ?\\([1-9][0-9]*\\)${escape(name.slice(dot))}$`).test(label);
}

async function waitForAttachmentsBeforeSend(assets, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stableReads = 0;
  while (Date.now() < deadline) {
    if (attachmentErrorElement()) throw uploadFailure("ATTACHMENT_UPLOAD_ERROR", "发送前页面显示附件错误，已停止发送。请查看原页面的附件提示。");
    const evidence = attachmentUploadEvidence(assets, { items: [] });
    stableReads = evidence ? stableReads + 1 : 0;
    if (stableReads >= 2) return evidence;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const snapshot = attachmentEvidenceSnapshot();
  const reason = !snapshot.scope ? "当前输入区暂时无法读取"
    : uploadProgressElement() ? "附件仍显示上传中"
    : snapshot.items.length !== assets.length ? `当前可核对 ${snapshot.items.length} 张，任务需要 ${assets.length} 张`
    : "附件数量正确，但文件名未全部匹配";
  throw uploadFailure("ATTACHMENT_CHANGED_BEFORE_SEND", `发送前等待附件稳定后仍未通过核对：${reason}。已停止发送，请查看原页面。`);
}

function attachmentEvidenceSnapshot() {
  const scope = attachmentScope();
  if (!scope) return { scope: null, items: [] };
  const attachmentRoots = [...scope.querySelectorAll('[data-testid*="attachment"]')]
    .filter((element) => !element.parentElement?.closest('[data-testid*="attachment"]'));
  const removeControls = [...scope.querySelectorAll('button[aria-label*="Remove file"], button[aria-label*="Remove attachment"], button[aria-label*="移除文件"], button[aria-label*="删除附件"]')];
  const evidenceElements = [...attachmentRoots, ...removeControls.filter((button) => !attachmentRoots.some((root) => root.contains(button)))];
  return {
    scope,
    items: evidenceElements.map((element) => ({ element, labels: [element, ...element.querySelectorAll('[aria-label], [title], [alt]')]
      .flatMap((item) => [item.textContent, item.getAttribute("aria-label"), item.getAttribute("title"), item.getAttribute("alt")]).filter(Boolean).map(normalizeText) })),
  };
}

function uploadProgressElement() {
  return attachmentScope()?.querySelector('[data-testid*="upload-progress"], [role="progressbar"], button[aria-label*="Cancel upload"], button[aria-label*="取消上传"], button[aria-label*="Stop upload"], button[aria-label*="停止上传"]');
}

function attachmentErrorElement() {
  return attachmentScope()?.querySelector('[data-testid*="upload-error"], [role="alert"]');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(blob);
  });
}
