import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  loadArkCredential,
  preflightArkNetwork,
  runDoubaoBridge,
} from "./codex-runner.mjs";

const REQUEST_NAME = "RUNTIME_DECOMPOSITION_REQUEST.json";
const STATUS_NAME = "RUNTIME_DECOMPOSITION_STATUS.json";

export function runtimeDecompositionRequestPath(taskRoot) {
  return join(taskRoot, REQUEST_NAME);
}

export function runtimeDecompositionStatusPath(taskRoot) {
  return join(taskRoot, STATUS_NAME);
}

export function readRuntimeDecompositionStatus(taskRoot) {
  const path = runtimeDecompositionStatusPath(taskRoot);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value?.schema_version === 1 ? value : null;
  } catch {
    return null;
  }
}

export function loadRuntimeDecompositionRequest({ task, taskRoot }) {
  const path = runtimeDecompositionRequestPath(taskRoot);
  if (!existsSync(path)) return null;
  const request = JSON.parse(readFileSync(path, "utf8"));
  if (
    request?.schema_version !== 1 ||
    request?.request_type !== "doubao_video_decomposition" ||
    request?.task_id !== task.id ||
    request?.automatic_retry !== false
  ) throw new Error("RUNTIME_DECOMPOSITION_REQUEST_INVALID");

  const contextPath = join(taskRoot, "PROJECT_CONTEXT.json");
  if (!existsSync(contextPath))
    throw new Error("RUNTIME_DECOMPOSITION_PROJECT_CONTEXT_MISSING");
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  const expected = context?.setup?.formal_project_route?.reference_video_path;
  if (!expected || !existsSync(expected))
    throw new Error("RUNTIME_DECOMPOSITION_REFERENCE_MISSING");
  const expectedPath = realpathSync(expected);
  if (!statSync(expectedPath).isFile() || lstatSync(expectedPath).isSymbolicLink())
    throw new Error("RUNTIME_DECOMPOSITION_REFERENCE_INVALID");

  const requested = String(request.reference_video_path || "").trim();
  const requestedPath = requested
    ? realpathSync(isAbsolute(requested) ? requested : resolve(taskRoot, requested))
    : expectedPath;
  if (requestedPath !== expectedPath)
    throw new Error("RUNTIME_DECOMPOSITION_REFERENCE_MISMATCH");
  if (!expectedPath.startsWith(`${realpathSync(taskRoot)}${sep}`))
    throw new Error("RUNTIME_DECOMPOSITION_REFERENCE_OUTSIDE_PROJECT");
  return { request, requestPath: path, referenceVideoPath: expectedPath };
}

export async function runRuntimeDecomposition({
  task,
  taskRoot,
  onEvent,
  credentialLoader = loadArkCredential,
  networkPreflight = preflightArkNetwork,
  bridgeRunner = runDoubaoBridge,
}) {
  const loaded = loadRuntimeDecompositionRequest({ task, taskRoot });
  if (!loaded) return null;
  const previous = readRuntimeDecompositionStatus(taskRoot);
  if (
    previous?.request_path === loaded.requestPath &&
    previous?.reference_video_path === loaded.referenceVideoPath &&
    previous?.status === "completed"
  ) return previous;

  const writeStatus = (status, extra = {}) => {
    const value = {
      schema_version: 1,
      request_type: "doubao_video_decomposition",
      task_id: task.id,
      request_path: loaded.requestPath,
      reference_video_path: loaded.referenceVideoPath,
      status,
      updated_at: new Date().toISOString(),
      ...extra,
    };
    writeFileSync(runtimeDecompositionStatusPath(taskRoot), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return value;
  };

  writeStatus("preflight_running", {
    phase_label: "正在检查参考视频拆解通道",
    summary: "只检查本项目参考视频、豆包通道和安全凭证，不上传其他素材。",
    next_action: "暂时不用操作。",
  });
  try {
    const credential = credentialLoader();
    if (!credential) throw Object.assign(new Error("火山方舟安全凭证不可用。"), { code: "CREDENTIAL_UNAVAILABLE" });
    await networkPreflight();
    writeStatus("running", {
      phase_label: "正在理解参考视频",
      summary: "豆包正在拆解本项目唯一参考视频；产品图、人物图和其他资料不会上传。",
      next_action: "暂时不用操作。",
    });
    const result = await bridgeRunner({
      task: { ...task, reference_video_path: loaded.referenceVideoPath },
      taskDir: taskRoot,
      credential,
      onEvent,
    });
    return writeStatus("completed", {
      phase_label: "参考视频理解完成",
      summary: result.reused ? "已复用同一参考视频的豆包拆解结果。" : "参考视频已经完成拆解并保存到当前项目。",
      next_action: "项目任务会继续完成本地对账和后续制作。",
      reused: Boolean(result.reused),
      provider_output: result.output,
      provider_summary: result.summary,
    });
  } catch (error) {
    writeStatus("failed", {
      phase_label: "参考视频理解暂未完成",
      summary: String(error?.message || error).slice(0, 500),
      next_action: "没有自动重试，也没有上传其他素材。",
      error_code: error?.code || "RUNTIME_DECOMPOSITION_FAILED",
    });
    throw error;
  }
}
