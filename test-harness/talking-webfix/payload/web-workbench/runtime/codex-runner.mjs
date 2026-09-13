import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";
import { artifactRoot, codexWorkspaceRoot, skillFile, workbenchRuntimeFile } from "./portable-paths.mjs";

const schemaPath = fileURLToPath(new URL("./output-schema.json", import.meta.url));
const ARK_API_HOST = "ark.cn-beijing.volces.com";
const ARK_PREFLIGHT_URL = `https://${ARK_API_HOST}/api/v3/models`;
const ARK_API_ROOT = `https://${ARK_API_HOST}/api/v3`;
const ARK_MODEL = "doubao-seed-2-0-pro-260215";

export async function runCodexStage({ task, stage, taskDir, onEvent }) {
  const skillContract = stage === "decomposition"
    ? resolveSkillContract("decomposition")
    : resolveSkillContract("remix_planning");
  const contractReceipt = skillContract ? skillContractReceipt(skillContract) : null;
  mkdirSync(taskDir, { recursive: true });
  ensureProjectStatus(task, taskDir);
  const resultPath = join(taskDir, `${stage}-result.json`);
  const eventPath = join(taskDir, `${stage}-events.jsonl`);
  const contractReceiptPath = skillContract ? join(taskDir, "decomposition-skill-contract.json") : null;
  if (contractReceiptPath) writeFileSync(contractReceiptPath, `${JSON.stringify(contractReceipt, null, 2)}\n`, "utf8");
  let credential = null;
  let providerEvidence = null;
  if (stage === "decomposition") {
    credential = loadArkCredential();
    if (!credential) {
      const error = new Error("火山方舟凭证当前无法从安全存储加载。未启动 Codex，也未发起外部请求。");
      error.code = "CREDENTIAL_UNAVAILABLE";
      throw error;
    }
    await preflightArkNetwork();
    providerEvidence = await runDoubaoBridge({ task, taskDir, credential, onEvent });
  }

  const prompt = stage === "decomposition"
    ? buildDecompositionPrompt(task, providerEvidence, taskDir, skillContract)
    : rewritePrompt(task, taskDir, skillContract);
  writeFileSync(join(taskDir, `${stage}-prompt.md`), prompt, "utf8");

  const args = buildCodexArgs({ taskDir, resultPath });
  const childEnv = { ...process.env };
  delete childEnv.VOLCENGINE_ARK_API_KEY;
  delete childEnv.ARK_API_KEY;
  const secrets = [];
  await runManagedCodex({
    args, prompt, env: childEnv, onEvent,
    onRawLine: (line) => recordEventLine(line, eventPath, secrets),
    redact: (value) => redactSecrets(value, secrets),
  });
  const rawResult = readFileSync(resultPath, "utf8");
  const safeResult = redactSecrets(rawResult, secrets);
  if (safeResult !== rawResult) writeFileSync(resultPath, safeResult, "utf8");
  const result = JSON.parse(safeResult);
  if (!contractReceipt) return result;
  const finalized = {
    ...result,
    skill_contract: contractReceipt,
    skill_contract_receipt_path: contractReceiptPath,
    external_request_started:
      stage === "decomposition" ? !providerEvidence.reused : false,
    video_generation_started: false,
  };
  writeFileSync(resultPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  return finalized;
}

export function buildCodexArgs({ taskDir, resultPath, env = process.env, pathExists = existsSync, outputSchemaPath = schemaPath, sandbox = "workspace-write", includeWorkspaceDirs = true }) {
  const args = [
    "exec", "-", "--json", "--skip-git-repo-check", "--sandbox", sandbox,
    "--model", env.WORKBENCH_CODEX_MODEL || "gpt-5.6-sol",
    "-C", taskDir,
  ];
  if (includeWorkspaceDirs) args.push("--add-dir", codexWorkspaceRoot(env));
  if ((env.WORKBENCH_CODEX_TRANSPORT || "https") === "https") {
    args.push(
      "--config", "model_provider=workbench_https",
      "--config", 'model_providers.workbench_https.name="ChatGPT HTTPS"',
      "--config", 'model_providers.workbench_https.base_url="https://chatgpt.com/backend-api/codex"',
      "--config", "model_providers.workbench_https.requires_openai_auth=true",
      "--config", "model_providers.workbench_https.supports_websockets=false",
    );
  }
  const formalRoot = artifactRoot(env);
  if (includeWorkspaceDirs && pathExists(formalRoot)) args.push("--add-dir", formalRoot);
  args.push("--output-schema", outputSchemaPath, "--output-last-message", resultPath);
  return args;
}

export function buildDoubaoArgs({ task, taskDir, env = process.env }) {
  const analysisDir = join(taskDir, "01_source_video_analysis");
  const prompt = env.WORKBENCH_DOUBAO_PROMPT
    || skillFile("ai-video-decompose-gemini", "references/doubao-video-reverse-prompt.md", env);
  return {
    runner: env.WORKBENCH_DOUBAO_RUNNER || workbenchRuntimeFile("gemini-video-adapter/scripts/doubao_video_decompose.mjs", env),
    prompt,
    output: join(analysisDir, "semantic-raw.json"),
    summary: join(analysisDir, "doubao-run-summary.json"),
    manifest: join(analysisDir, "provider-bridge-manifest.json"),
    args: [
      "--execute",
      "--video", task.reference_video_path,
      "--prompt", prompt,
      "--output", join(analysisDir, "semantic-raw.json"),
      "--summary", join(analysisDir, "doubao-run-summary.json"),
      "--model", ARK_MODEL,
      "--api-root", ARK_API_ROOT,
    ],
  };
}

export async function runDoubaoBridge({ task, taskDir, credential, onEvent, env = process.env }) {
  const config = buildDoubaoArgs({ task, taskDir, env });
  mkdirSync(join(taskDir, "01_source_video_analysis"), { recursive: true });
  for (const [label, path] of [["豆包适配器", config.runner], ["豆包拆解提示词", config.prompt]]) {
    if (!existsSync(path)) {
      const error = new Error(`${label}缺失，未提交外部处理。`);
      error.code = "ARK_PROVIDER_BRIDGE_FAILED";
      throw error;
    }
  }
  const video = statSync(task.reference_video_path);
  const promptSha256 = createHash("sha256").update(readFileSync(config.prompt)).digest("hex");
  const reusable = readJsonFile(config.manifest);
  const summary = readJsonFile(config.summary);
  if (
    reusable?.video_path === task.reference_video_path
    && reusable?.video_size === video.size
    && reusable?.model === ARK_MODEL
    && reusable?.api_root === ARK_API_ROOT
    && reusable?.prompt_sha256 === promptSha256
    && summary?.status === "ok"
    && existsSync(config.output)
  ) {
    onEvent?.("已复用本任务成功的豆包主拆回执，未重复提交或计费。");
    return { ...config, reused: true };
  }

  onEvent?.("豆包连通性预检通过，正在通过受限适配器提交本次参考视频。");
  await runProcess(process.execPath, [config.runner, ...config.args], {
    env: {
      ...env,
      VOLCENGINE_ARK_API_KEY: credential.value,
      VOLCENGINE_ARK_API_ROOT: ARK_API_ROOT,
      DOUBAO_DECOMPOSE_MODEL: ARK_MODEL,
    },
    secrets: [credential.value],
  });
  const completed = readJsonFile(config.summary);
  if (completed?.status !== "ok" || !existsSync(config.output)) {
    const error = new Error("豆包适配器未返回可复用的成功回执，任务已安全暂停。");
    error.code = "ARK_PROVIDER_BRIDGE_FAILED";
    throw error;
  }
  writeFileSync(config.manifest, `${JSON.stringify({
    schema_version: 1,
    video_path: task.reference_video_path,
    video_size: video.size,
    model: ARK_MODEL,
    api_root: ARK_API_ROOT,
    prompt_path: config.prompt,
    prompt_sha256: promptSha256,
    output: config.output,
    summary: config.summary,
    completed_at: new Date().toISOString(),
  }, null, 2)}\n`, { flag: "w" });
  onEvent?.("豆包主拆回执已保存；接下来只做本地对账和成果整理。");
  return { ...config, reused: false };
}

function runProcess(command, args, { env, secrets }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout: redactSecrets(stdout, secrets) });
      const error = new Error(redactSecrets(stderr || stdout || `豆包适配器退出码 ${code}`, secrets));
      error.code = "ARK_PROVIDER_BRIDGE_FAILED";
      reject(error);
    });
  });
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export async function preflightArkNetwork({
  url = process.env.WORKBENCH_ARK_PREFLIGHT_URL || ARK_PREFLIGHT_URL,
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "ai-content-workbench-network-preflight/0.1" },
    });
    return { ok: true, status: response.status };
  } catch (cause) {
    const error = new Error("任务环境暂时无法连接火山方舟。未启动 Codex，也未提交豆包处理；请恢复网络后重新预检。");
    error.code = "ARK_NETWORK_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }
}

export function loadArkCredential({ env = process.env, readKeychain = readArkKeychain } = {}) {
  const candidates = [
    ["VOLCENGINE_ARK_API_KEY", env.VOLCENGINE_ARK_API_KEY || ""],
    ["ARK_API_KEY", env.ARK_API_KEY || ""],
    ["macOS Keychain", readKeychain()],
  ];
  const match = candidates.find(([, value]) => typeof value === "string" && value.startsWith("ark-"));
  return match ? { source: match[0], value: match[1] } : null;
}

function readArkKeychain() {
  try {
    return execFileSync("security", ["find-generic-password", "-s", "VOLCENGINE_ARK_API_KEY", "-w"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

export function redactSecrets(value, secrets = []) {
  let safe = String(value || "");
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[REDACTED_ARK_KEY]");
  }
  return safe.replace(/ark-[A-Za-z0-9._-]{12,}/g, "[REDACTED_ARK_KEY]");
}

function recordEventLine(line, eventPath, secrets, onEvent) {
  const safeLine = redactSecrets(line, secrets);
  writeFileSync(eventPath, `${safeLine}\n`, { flag: "a" });
  if (!safeLine.trim()) return;
  try {
    const event = JSON.parse(safeLine);
    const message = event.message || event.item?.text || event.type;
    if (message) onEvent?.(redactSecrets(String(message), secrets).slice(0, 300));
  } catch { /* full sanitized evidence remains in the event file */ }
}

function ensureProjectStatus(task, taskDir) {
  const statusPath = join(taskDir, "00_project_status.md");
  if (existsSync(statusPath)) return;
  writeFileSync(statusPath, `# 本地任务中心项目状态

- project_id: ${task.id}
- project_title: ${task.title}
- workflow: video_decompose_to_product_rewrite
- current_stage: ${task.current_step}
- internal_workspace: ${taskDir}
- final_delivery_rule: 仅使用正式成果工具返回的 published_path
- safety_rule: 不自动进入下游生成、发布、覆盖或删除
`, "utf8");
}

export function buildDecompositionPrompt(task, providerEvidence, taskDir, skillContract) {
  return buildSkillOwnedPrompt({
    contract: skillContract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      reference_video_path: task.reference_video_path,
      work_dir: taskDir,
      provider_semantic_result_path: providerEvidence.output,
      provider_receipt_path: providerEvidence.summary,
      provider_result_reused: Boolean(providerEvidence.reused),
      budget_limit_cny: task.budget_limit_cny,
      remix_change_contract: task.remix_change_contract || null,
    },
    runtimeEnvelope: {
      provider_stage_already_completed: true,
      repeat_provider_request_allowed: false,
      gemini_dispute_submission_allowed: false,
      additional_uploads_allowed: false,
      downstream_stage_execution_allowed: false,
      credentials_available_to_offline_organizer: false,
      output_interface: { result_schema_required: true, user_visible_artifacts_must_follow_owner_skill_contract: true },
      user_message_policy: "只用大白话说明拆解结果、费用和下一步；不展示凭证、内部命令或技术路径。",
    },
  });
}

function rewritePrompt(task, taskDir, skillContract) {
  const decomp = task.decomposition_result || {};
  const changeContract = task.remix_change_contract || null;
  return buildSkillOwnedPrompt({
    contract: skillContract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      work_dir: taskDir,
      decomposition_summary: decomp.summary || null,
      decomposition_artifacts: decomp.artifacts || [],
      remix_change_contract: changeContract,
      product_brief: task.product_brief || null,
      product_image_paths: task.product_image_paths || [],
      person_route: task.person_route || null,
      person_brief: task.person_brief || null,
      scene_reference_paths: changeContract?.scene?.image_paths || [],
      video_generation_provider: task.generation_provider || null,
      video_generation_quality: task.generation_quality_profile || null,
    },
    runtimeEnvelope: {
      operation: "compile_remix_plan_and_script_handoff_only",
      external_uploads_allowed: false,
      image_generation_allowed: false,
      video_generation_allowed: false,
      downstream_execution_allowed: false,
      overall_task_close_forbidden: true,
      intermediate_stage_only: true,
      automatic_retry_allowed: false,
      output_interface: {
        result_schema_required: true,
        user_visible_artifacts_must_follow_owner_skill_contract: true,
      },
      user_message_policy: "只说明已经按用户选择整理了什么、还缺什么和下一步；不展示内部命令或技术路径。",
    },
  });
}
