/* global chrome */

import { selectReadyChatGPTPage } from "./tab-selection.js";

const API = "http://127.0.0.1:4318/browser-bridge";
const CLIENT = "chatgpt-companion-v1";
const VERSION = "0.1.20";
const HEADERS = { "X-Workbench-Bridge-Client": CLIENT };
let activeJobId = null;
let loopStarted = false;
let tickInFlight = false;
const unavailableResumeJobs = new Map();
const RESUME_RECHECK_MS = 10_000;

chrome.runtime.onInstalled.addListener(() => startLoop());
chrome.runtime.onStartup.addListener(() => startLoop());
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "bridge-status") {
    const body = {
      state: message.state,
      message: message.message,
      submission_marker: message.submission_marker,
      submission_marker_confirmed: message.submission_marker_confirmed,
      browser_tab_id: message.browser_tab_id,
      conversation_url: message.conversation_url,
      submitted_turn_fingerprint: message.submitted_turn_fingerprint,
      verified_attachment_count: message.verified_attachment_count,
      verified_attachment_names: message.verified_attachment_names,
      attachment_verification_method: message.attachment_verification_method,
      failure_code: message.failure_code,
      assistant_response_excerpt: message.assistant_response_excerpt,
      attempt_refund: message.attempt_refund,
    };
    postJson(`/jobs/${message.jobId}/status`, body)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "bridge-assets") {
    fetchAssets(message.job)
      .then((assets) => sendResponse({ ok: true, assets }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "bridge-result") {
    uploadResult(message.jobId, message.mimeType, message.base64)
      .then((value) => { activeJobId = null; sendResponse({ ok: true, value }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "bridge-terminal") activeJobId = null;
  return false;
});

startLoop();

function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  void tick();
  setInterval(() => void tick(), 3000);
}

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  let dispatchingResumeId = null;
  try {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const { tab, page } = await selectReadyChatGPTPage(
      tabs,
      (candidate) => chrome.tabs.sendMessage(candidate.id, { type: "bridge-probe" }),
    );
    await postJson("/heartbeat", {
      client_version: VERSION,
      logged_in: page.loggedIn === true,
      composer_ready: page.composerReady === true,
      page_state: page.pageState,
    });
    if (activeJobId) return;
    const manualPending = await getJson("/jobs/manual-pending");
    if (manualPending.job) {
      const manualTab = await findMarkerTab(manualPending.job, tabs);
      if (manualTab?.id) {
        await postJson(`/jobs/${manualPending.job.id}/manual-submission`, {
          submission_marker: manualPending.job.submission_marker,
          browser_tab_id: manualTab.id,
          conversation_url: manualTab.url,
        });
      }
    }
    const resumable = await getJson("/jobs/resumable");
    if (resumable.job && resumeAvailable(resumable.job.id)) {
      const resumeTab = await findResumeTab(resumable.job, tabs);
      if (!resumeTab?.id) deferResume(resumable.job.id);
      else {
        const resumePage = await chrome.tabs.sendMessage(resumeTab.id, { type: "bridge-probe" });
        if (!resumePage?.composerReady) deferResume(resumable.job.id);
        else {
          activeJobId = resumable.job.id;
          dispatchingResumeId = resumable.job.id;
          await chrome.tabs.update(resumeTab.id, { active: true });
          const accepted = await chrome.tabs.sendMessage(resumeTab.id, { type: "bridge-resume-job", job: resumable.job });
          if (!accepted?.accepted) throw new Error("原页面暂未接收结果核对任务");
          dispatchingResumeId = null;
          return;
        }
      }
    }
    if (!tab?.id || !page.composerReady) return;
    const response = await getJson("/jobs/next");
    if (!response.job) return;
    activeJobId = response.job.id;
    await runInFreshChat(response.job);
  } catch (error) {
    if (dispatchingResumeId) {
      if (activeJobId === dispatchingResumeId) activeJobId = null;
      deferResume(dispatchingResumeId);
    }
    console.warn("ChatGPT companion tick failed", error);
  } finally { tickInFlight = false; }
}

async function runInFreshChat(job) {
  try {
    const freshTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (!freshTab.id) throw new Error("无法新建 ChatGPT 对话");
    const page = await waitForComposer(freshTab.id, 30_000);
    if (!page.loggedIn || !page.composerReady) throw new Error("新建的 ChatGPT 对话还不能输入");
    const response = await chrome.tabs.sendMessage(freshTab.id, { type: "bridge-run-job", job, context: { tabId: freshTab.id } });
    if (!response?.accepted) throw new Error("新建对话没有接收生图任务");
  } catch (error) {
    try {
      await postJson(`/jobs/${job.id}/status`, { state: "auth_required", message: String(error?.message || error) });
    } finally {
      activeJobId = null;
    }
  }
}

async function findResumeTab(job, tabs) {
  const byId = tabs.find((tab) => tab.id === job.browser_tab_id);
  if (byId) return byId;
  if (!job.conversation_url) return null;
  return tabs.find((tab) => sameConversation(tab.url, job.conversation_url)) || null;
}

async function findMarkerTab(job, tabs) {
  const preferred = await findResumeTab(job, tabs);
  const candidates = preferred ? [preferred, ...tabs.filter((tab) => tab.id !== preferred.id)] : tabs;
  for (const tab of candidates) {
    if (!tab?.id) continue;
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "bridge-marker-probe", marker: job.submission_marker });
      if (result?.found) return tab;
    } catch { /* another ChatGPT tab may still be loading */ }
  }
  return null;
}

function resumeAvailable(jobId) {
  const retryAt = unavailableResumeJobs.get(jobId) || 0;
  if (Date.now() < retryAt) return false;
  unavailableResumeJobs.delete(jobId);
  return true;
}

function deferResume(jobId) {
  unavailableResumeJobs.set(jobId, Date.now() + RESUME_RECHECK_MS);
}

function sameConversation(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.hostname === "chatgpt.com" && b.hostname === "chatgpt.com" && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

async function waitForComposer(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const page = await chrome.tabs.sendMessage(tabId, { type: "bridge-probe" });
      if (page?.composerReady) return page;
    } catch { /* content script is still loading */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("等待新建 ChatGPT 对话加载超时");
}

async function fetchAssets(job) {
  const assets = [];
  for (const asset of job.assets || []) {
    const response = await fetch(`${API}/jobs/${job.id}/assets/${asset.index}`, { headers: HEADERS });
    if (!response.ok) throw new Error(`参考图 ${asset.index + 1} 读取失败`);
    const buffer = await response.arrayBuffer();
    assets.push({ name: asset.name, mimeType: response.headers.get("content-type") || "image/jpeg", base64: arrayBufferToBase64(buffer) });
  }
  return assets;
}

async function uploadResult(jobId, mimeType, base64) {
  const response = await fetch(`${API}/jobs/${jobId}/result`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": mimeType },
    body: base64ToBytes(base64),
  });
  if (!response.ok) throw new Error("生成图片回传失败");
  return response.json();
}

async function bridgeJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${API}${path}`, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`bridge ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function getJson(path) {
  return bridgeJson(path, { headers: HEADERS });
}

async function postJson(path, body) {
  return bridgeJson(path, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
