import { spawn } from "node:child_process";
import { resolveCodexBinary } from "./codex-project-task.mjs";

const TRANSIENT_PATTERNS = [
  /request timed out/i,
  /reconnecting\.\.\./i,
  /failed to refresh available models/i,
  /timeout waiting for child process to exit/i,
  /connection (?:reset|closed|refused)/i,
  /socket hang up/i,
  /network (?:is )?unreachable/i,
  /temporar(?:y|ily) unavailable/i,
  /后台执行等待超时|execution.*tim(?:ed? ?out|eout)/i,
  /ETIMEDOUT|ECONNRESET|EAI_AGAIN/i,
];

const HIDDEN_PROGRESS_PATTERNS = [
  /Skill descriptions were shortened to fit the skills context budget/i,
];

class SerialExecutionQueue {
  #tail = Promise.resolve();
  #pending = 0;

  enqueue(work) {
    this.#pending += 1;
    const current = this.#tail.then(work, work);
    this.#tail = current.catch(() => {}).finally(() => { this.#pending -= 1; });
    return current;
  }

  get pending() { return this.#pending; }
}

const defaultQueue = new SerialExecutionQueue();

export function inspectCodexExecutionSupervisor() {
  return { mode: "serial_supervised", pending: defaultQueue.pending, startup_recovery_limit: 1 };
}

export function classifyCodexFailure(value, evidence = {}) {
  const text = String(value || "");
  const transient = TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
  const businessStarted = Boolean(evidence.businessStarted);
  return {
    transient,
    business_started: businessStarted,
    safe_startup_recovery: transient && !businessStarted,
    category: transient ? (businessStarted ? "runtime_interrupted_after_work_started" : "runtime_startup_transient") : "execution_failure",
  };
}

export function observeCodexEvent(line, evidence) {
  if (!line?.trim()) return null;
  try {
    const event = JSON.parse(line);
    const runtimeMessage = event.message || event.item?.message || "";
    if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(String(runtimeMessage)))) evidence.lastTransientMessage = String(runtimeMessage);
    if (event.type === "thread.started" && event.thread_id) evidence.threadId = event.thread_id;
    const item = event.item;
    if (["item.started", "item.completed"].includes(event.type) && item && !["error", "agent_message", "reasoning"].includes(item.type)) {
      evidence.businessStarted = true;
    }
    return event;
  } catch { return null; }
}

export function codexEventProgressMessage(event) {
  if (!event) return null;
  if (
    ["item.started", "item.completed"].includes(event.type) &&
    event.item?.type === "function_call" &&
    event.item?.name === "spawn_agent"
  ) {
    return "正式预检已通过，干净生图执行单元已启动，正在生成本次唯一一张图片。";
  }
  const candidate = event.message || event.item?.text || event.item?.message || "";
  if (!candidate || HIDDEN_PROGRESS_PATTERNS.some((pattern) => pattern.test(String(candidate)))) return null;
  if (event.item?.text) {
    try {
      const structured = JSON.parse(event.item.text);
      return structured.user_message || structured.summary || null;
    } catch { /* keep ordinary agent text */ }
  }
  return String(candidate);
}

export function runManagedCodex(options) {
  const resolved = {
    ...options,
    command: options.command || resolveCodexBinary(options.env || process.env),
    defaultCodexCommand: !options.command || options.command === "codex",
  };
  return defaultQueue.enqueue(() => runWithStartupRecovery(resolved));
}

export function buildCodexResumeArgs(initialArgs, threadId) {
  const args = ["exec", "resume", "--json"];
  const flags = new Set(["--skip-git-repo-check", "--ignore-user-config", "--strict-config"]);
  const valued = new Set(["--model", "-m", "--output-schema", "--output-last-message", "-o", "--config", "-c", "--enable", "--disable", "--profile", "-p"]);
  for (let index = 0; index < initialArgs.length; index += 1) {
    const value = initialArgs[index];
    if (value === "--json") continue;
    if (flags.has(value)) args.push(value);
    else if (valued.has(value) && initialArgs[index + 1] !== undefined) args.push(value, initialArgs[++index]);
  }
  args.push(threadId, "-");
  return args;
}

async function runWithStartupRecovery(options) {
  const recoveryLimit = Number(options.startupRecoveryLimit ?? options.env?.WORKBENCH_CODEX_STARTUP_RECOVERY_LIMIT ?? 1);
  let lastError = null;
  let recoveryThreadId = null;
  for (let ordinal = 1; ordinal <= recoveryLimit + 1; ordinal += 1) {
    const evidence = { businessStarted: false, threadId: null, lastTransientMessage: null };
    try {
      const shouldResume = ordinal > 1 && recoveryThreadId && options.defaultCodexCommand;
      const result = await runOneAttempt({
        ...options,
        args: shouldResume ? buildCodexResumeArgs(options.args, recoveryThreadId) : options.args,
        prompt: shouldResume
          ? "继续完成上一轮原始任务。上一轮在业务命令或工具开始前因模型连接中断，现已恢复；请从原始任务继续执行，不要把这条恢复说明写入成果。"
          : options.prompt,
        evidence,
        ordinal,
      });
      return { ...result, attempts: ordinal, recovered_startup: ordinal > 1 };
    } catch (error) {
      lastError = error;
      const classification = classifyCodexFailure(error?.message || error, evidence);
      if (!classification.safe_startup_recovery || ordinal > recoveryLimit) {
        error.code = classification.transient ? "CODEX_RUNTIME_UNAVAILABLE" : (error.code || "CODEX_EXECUTION_FAILED");
        error.business_started = classification.business_started;
        error.external_request_started = classification.business_started ? undefined : false;
        error.execution_category = classification.category;
        error.execution_attempts = ordinal;
        error.thread_id = evidence.threadId;
        throw error;
      }
      recoveryThreadId = options.defaultCodexCommand ? evidence.threadId : null;
      options.onEvent?.(recoveryThreadId
        ? "后台连接短暂中断，正在恢复同一个后台任务；业务尚未开始，不会重复提交或占用生成次数。"
        : "后台连接短暂中断，正在自动恢复一次；业务尚未开始，不会重复提交或占用生成次数。");
    }
  }
  throw lastError;
}

function runOneAttempt({ command = "codex", args, prompt, env = process.env, timeoutMs = 15 * 60 * 1000, onEvent, onRawLine, earlySuccess, redact = (value) => String(value || ""), evidence, ordinal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let successPoll = null;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (successPoll) clearInterval(successPoll);
      child.kill("SIGTERM");
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (successPoll) clearInterval(successPoll);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finishReject(new Error(`Codex 后台执行等待超时（第 ${ordinal} 次启动）。`));
    }, timeoutMs);
    if (earlySuccess) {
      successPoll = setInterval(() => {
        try {
          if (earlySuccess()) finishResolve({
            thread_id: evidence.threadId,
            business_started: evidence.businessStarted,
            early_success: true,
          });
        } catch {
          // A partially written receipt is expected briefly; the next poll retries.
        }
      }, 500);
      successPoll.unref?.();
    }
    child.stdin.end(prompt || "");
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const rawLine of lines) {
        handleLine(redact(rawLine), evidence, onEvent, onRawLine);
        if (!settled && earlySuccess?.()) {
          finishResolve({ thread_id: evidence.threadId, business_started: evidence.businessStarted, early_success: true });
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", finishReject);
    child.on("close", (code) => {
      if (settled) return;
      if (stdout) handleLine(redact(stdout), evidence, onEvent, onRawLine);
      settled = true;
      clearTimeout(timer);
      if (successPoll) clearInterval(successPoll);
      if (code === 0) return resolve({ thread_id: evidence.threadId, business_started: evidence.businessStarted });
      reject(new Error(redact(stderr || evidence.lastTransientMessage || `Codex 执行器退出码 ${code}`)));
    });
  });
}

function handleLine(line, evidence, onEvent, onRawLine) {
  onRawLine?.(line);
  const event = observeCodexEvent(line, evidence);
  const message = codexEventProgressMessage(event);
  if (message) onEvent?.(String(message).slice(0, 300));
}
