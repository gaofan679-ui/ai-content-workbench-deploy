import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexBinary } from "./codex-project-task.mjs";

const PROMPT_VERSION = "dialect-draft-v1";
const schemaPath = fileURLToPath(
  new URL("./dialect-draft-schema.json", import.meta.url),
);

export function validateDialectDraftInput(input = {}) {
  const sourceText = String(input.sourceText || "").trim();
  const dialect = String(input.dialect || "").trim();
  const regionHint = String(input.regionHint || "").trim();
  const referenceExamples = String(input.referenceExamples || "").trim();
  if (!sourceText) throw userError("请先填写要转换的普通话原稿。");
  if (sourceText.length > 10_000) throw userError("单次转换最多 10000 字。");
  if (!dialect) throw userError("请先选择或填写具体方言。");
  if (dialect.length > 40 || regionHint.length > 80)
    throw userError("方言或地区说明过长，请精简后再试。");
  if (referenceExamples.length > 3_000)
    throw userError("方言参考表达最多 3000 字。");
  return { sourceText, dialect, regionHint, referenceExamples };
}

export function buildDialectDraftPrompt(rawInput) {
  const input = validateDialectDraftInput(rawInput);
  return [
    "你是中国方言口播文案转换助手。请把普通话原稿改写为指定地区真实口语习惯的方言文字草稿。",
    "这只是供用户审核的草稿，不得声称 100% 地道。不要调用工具，不要搜索网络。",
    "",
    `目标方言：${input.dialect}`,
    input.regionHint ? `地区/口音细化：${input.regionHint}` : "地区/口音细化：未提供",
    "",
    "必须遵守：",
    "1. 保留原稿的事实、逻辑、人物关系、否定、数字、时间、金额、人名、地名、品牌和行动号召；不增加新事实。",
    "2. 优先使用当地人口头自然、可被语音模型读出的常用汉字写法；不输出拼音、国际音标或括号注音。",
    "3. 不要逐字硬译；在不改变意思的前提下，调整语序、语气词和称呼。",
    "4. 参考表达只用于学习用词和句式，不得抄入与原稿无关的内容。",
    "5. 无法确定的说法不要猜成定论，写入 uncertain_phrases，并把 meaning_check 设为 needs_review。",
    "6. draft 里只放可继续编辑的完整方言口播稿；notes 只做简短审校提醒。",
    "",
    "普通话原稿：",
    input.sourceText,
    "",
    "用户提供的方言参考表达：",
    input.referenceExamples || "无",
    "",
    "严格按给定 JSON Schema 输出。",
  ].join("\n");
}

export function protectedSourceTokens(sourceText) {
  const matches = String(sourceText || "").match(
    /(?:\d+(?:\.\d+)?(?:\s*(?:%|元|块|万|秒|分钟|小时|年|月|日|次|个|件|人))?)|(?:[A-Za-z][A-Za-z0-9._+-]*)/g,
  ) || [];
  return [...new Set(matches)];
}

export function validateDialectDraftResult(raw, sourceText) {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw runnerError("方言转译暂时没有返回可用草稿。");
  const draft = String(value.draft || "").trim();
  if (!draft) throw runnerError("方言转译返回了空草稿，请稍后手动重试。");
  const missingProtectedTokens = protectedSourceTokens(sourceText).filter(
    (token) => !draft.replace(/\s+/g, "").includes(token.replace(/\s+/g, "")),
  );
  const uncertain = Array.isArray(value.uncertain_phrases)
    ? value.uncertain_phrases.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
    : [];
  if (missingProtectedTokens.length)
    uncertain.unshift(`请核对原稿中的关键值：${missingProtectedTokens.join("、")}`);
  return {
    draft,
    meaning_check:
      value.meaning_check === "preserved" && !missingProtectedTokens.length
        ? "preserved"
        : "needs_review",
    uncertain_phrases: [...new Set(uncertain)].slice(0, 20),
    notes: String(value.notes || "").trim().slice(0, 1000),
  };
}

export function parseCodexJsonl(stdout, sourceText) {
  let lastMessage = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.item || event;
    if (
      (event.type === "item.completed" || item.type === "agent_message") &&
      item.type === "agent_message"
    ) lastMessage = item.text || item.content || "";
  }
  if (!lastMessage) throw runnerError("方言转译暂时没有返回草稿。");
  return validateDialectDraftResult(lastMessage, sourceText);
}

export function dialectDraftCacheKey(input, model) {
  const normalized = validateDialectDraftInput(input);
  return createHash("sha256")
    .update(JSON.stringify({ version: PROMPT_VERSION, model, ...normalized }))
    .digest("hex");
}

export async function runDialectDraftWithCodex({
  input,
  cacheRoot,
  env = process.env,
  spawnImpl = spawn,
  timeoutMs = 120_000,
} = {}) {
  const normalized = validateDialectDraftInput(input);
  const model = env.WORKBENCH_CODEX_MODEL || "gpt-5.6-sol";
  const cacheKey = dialectDraftCacheKey(normalized, model);
  mkdirSync(cacheRoot, { recursive: true });
  const cachePath = join(cacheRoot, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    const cached = validateDialectDraftResult(
      JSON.parse(readFileSync(cachePath, "utf8")),
      normalized.sourceText,
    );
    return { ...cached, cached: true, external_request_started: false };
  }

  const prompt = buildDialectDraftPrompt(normalized);
  const args = buildDialectDraftCodexArgs({ model, cacheRoot, env });
  const childEnv = { ...env };
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.CODEX_THREAD_ID;
  delete childEnv.CODEX_SESSION_ID;
  delete childEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete childEnv.CODEX_PERMISSION_PROFILE;
  const stdout = await runCodexProcess({
    command: resolveCodexBinary(childEnv),
    args,
    prompt,
    env: childEnv,
    spawnImpl,
    timeoutMs,
  });
  const result = parseCodexJsonl(stdout, normalized.sourceText);
  writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return { ...result, cached: false, external_request_started: true };
}

export function buildDialectDraftCodexArgs({ model, cacheRoot, env = process.env }) {
  const args = [
    "exec", "-", "--json", "--ephemeral", "--skip-git-repo-check",
    "--ignore-rules", "--ignore-user-config", "--sandbox", "read-only",
    "--model", model, "-C", cacheRoot, "--output-schema", schemaPath,
  ];
  if ((env.WORKBENCH_CODEX_TRANSPORT || "https") === "https") {
    args.push(
      "--config", "model_provider=workbench_https",
      "--config", 'model_providers.workbench_https.name="ChatGPT HTTPS"',
      "--config", 'model_providers.workbench_https.base_url="https://chatgpt.com/backend-api/codex"',
      "--config", "model_providers.workbench_https.requires_openai_auth=true",
      "--config", "model_providers.workbench_https.supports_websockets=false",
    );
  }
  return args;
}

function runCodexProcess({ command, args, prompt, env, spawnImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.("SIGTERM");
      reject(runnerError("方言草稿生成超时，原稿和设置已保留；不会自动重试。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = runnerError("当前方言转译服务暂不可用。");
      error.cause = cause;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const detail = /auth|login|401|unauthorized/i.test(stderr)
        ? "当前工作台登录状态不可用，请重新打开工作台后再试。"
        : "原稿和设置已保留；不会自动重试。";
      reject(runnerError(`方言草稿暂时没有生成，${detail}`));
    });
    child.stdin.end(prompt);
  });
}

function userError(message) {
  const error = new Error(message);
  error.code = "DIALECT_DRAFT_INPUT_INVALID";
  return error;
}

function runnerError(message) {
  const error = new Error(message);
  error.code = "DIALECT_DRAFT_GENERATION_FAILED";
  return error;
}
