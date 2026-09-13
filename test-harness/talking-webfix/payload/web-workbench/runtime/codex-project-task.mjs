import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_VISIBLE_TURN_TIMEOUT_MS = 6 * 60 * 60_000;
const DEFAULT_TRANSPORT_STALL_TIMEOUT_MS = 60_000;
const THREAD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

export function isCodexTransportDisconnect(value) {
  const message = String(value || "").toLowerCase();
  return (
    message.includes("failed to connect to websocket") ||
    message.includes("tls handshake eof") ||
    message.includes("backend-api/codex/responses")
  );
}

export function resolveCodexBinary(env = process.env) {
  if (env.WORKBENCH_CODEX_BIN) return env.WORKBENCH_CODEX_BIN;
  const candidates = [
    env.HOME ? join(env.HOME, ".local", "bin", "codex") : null,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "codex";
}

export function codexThreadUrl(threadId) {
  const value = String(threadId || "").trim();
  if (!THREAD_ID_PATTERN.test(value))
    throw new Error("CODEX_THREAD_ID_INVALID");
  return `codex://threads/${value}`;
}

export function projectTaskInstructions({ taskId, title, contextUrl = null }) {
  return [
    `这是 AI 内容工作台项目“${String(title || "未命名项目").trim()}”（项目 ID：${taskId}）的专属 Codex 任务。`,
    "每轮开始先只读读取当前目录中的 PROJECT_CONTEXT.json 获取不可变的项目输入合同，再读取 CODEX_PROGRESS.json 获取最新执行状态。",
    contextUrl
      ? `只有本地摘要文件不存在或不可读时，才尝试备用地址：${contextUrl}`
      : null,
    "工作台只负责展示项目资料、进度和成果，不是业务规则所有者。",
    "处理项目时先读取当前项目目录中的真实资料和状态，再调用对应正式 Skill；不要自行仿写或覆盖 Skill 的业务规则。",
    "这是爆款重构项目时，必须由 ai-commercial-video-remix 作为总控，并由它调度正式子 Skill；不得调用网页旧编排器逐阶段推进。",
    "项目提交时已把路线、注册素材和授权边界写入 PROJECT_CONTEXT.json；在 authorization.planned_execution 范围内要连续执行，不得把同一资料、中间候选或既定付费提交再次变成用户确认点。",
    "执行过程中把面向用户的阶段、摘要、下一步和成果路径写入当前目录的 CODEX_PROGRESS.json；它是唯一业务状态总账，网页只读取并展示，不据此改写业务规则。",
    "只有新增未登记素材、扩大用途、超出授权次数的额外付费提交或重试、删除覆盖、凭证隐私变更时才暂停。代码或工作台故障必须写成结构化技术阻断，不得在客户项目任务里修改 Skill 或工作台代码。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function projectTaskExecutionMessage({ title }) {
  return [
    `我已在工作台一次性提交项目“${String(title || "未命名项目").trim()}”的资料和路线。`,
    "请先读取当前目录的 PROJECT_CONTEXT.json，并核对现有项目文件、已有成果和当前断点；不要重做已经合格的上游成果。",
    "请使用正式 ai-commercial-video-remix Skill 继续这个项目，并由它调度所需子 Skill。网页旧编排器只保留兼容读取，不再作为本项目执行者。",
    "优先复用用户已选择的人物、产品、场景、内容脚本、生图通道、视频通道、模型和清晰度；不要重复询问已经提交的资料。",
    "创建页已经登记的素材及其已选通道属于本项目既定执行范围；不得把这些素材再次当成新增上传，也不得重复询问同一授权。只有新增文件、扩大用途、超出既定通道的费用或不可逆操作时才暂停。",
    "严格执行 PROJECT_CONTEXT.json 中 authorization.planned_execution：样片路线只允许 1 次样片付费提交；直接正片路线允许正式 Skill 判定的必要分段，最多 5 段、每段 1 次、不自动重试。该范围内免二次确认；额外提交必须暂停。",
    "人物、产品、场景、分镜和提示词的中间候选由正式 Skill 的质量合同决定是否继续，不要额外询问用户审美确认；最终视频返回工作台后由用户决定采用或返工。",
    "每到一个有意义的阶段，把 CODEX_PROGRESS.json 更新为 schema_version=1，并至少写 task_state、phase_key、phase_label、summary、next_action、current_skill、updated_at、artifacts；不得覆盖 PROJECT_CONTEXT.json。",
    "当正式拆解 Skill 需要把参考视频交给豆包时，不要在项目任务里读取 Keychain 或直接访问外部 API；只在当前目录写 RUNTIME_DECOMPOSITION_REQUEST.json，字段必须为 schema_version=1、request_type=doubao_video_decomposition、task_id=当前项目 ID、reference_video_path=PROJECT_CONTEXT.json 中登记的正式参考视频绝对路径、automatic_retry=false。唯一工作台运行时只会上传这一条已登记参考视频；本任务必须留在当前对话轮次内轮询 RUNTIME_DECOMPOSITION_STATUS.json，完成后读取回执继续，不得依赖运行时另开项目任务。",
    "当 RunningHub H3 正式任务包已通过本地检查时，不要在项目任务里读取 Keychain 或直接调用 runner；只在当前目录写 RUNTIME_GENERATION_REQUEST.json，schema_version=1、request_type=runninghub_h3_generation、task_id=当前项目 ID、pack_path=当前目录内正式任务包相对路径。唯一工作台运行时会完成零费用预检，密钥不进入项目目录。",
    "现在从现有断点连续推进到项目合同指定的结果；保留旧文件和旧结果，不删除、不覆盖、不自动重试付费请求。",
  ].join("\n");
}

export function projectTaskRegisteredProductScopeMessage({ title, productImageCount }) {
  return [
    `工作台已修正项目“${String(title || "未命名项目").trim()}”的创建页授权识别。`,
    `本项目创建时已经登记并提交 ${Number(productImageCount || 0)} 张产品图，选择了“换产品”及既定生图通道；这些图片属于原始项目输入，不是后续新增上传。`,
    "请继续使用 PROJECT_CONTEXT.json 中 remix_change_contract.product.image_paths 已登记的这些产品图，只用于产品参考净化、目标分镜和本项目后续生成；不得读取、上传或扩展到其他文件。",
    "旧 PROJECT_CONTEXT.json 中把“产品图”整体列入 excluded_scope 是工作台合同生成错误，本条更正只解除已登记产品图的矛盾排除，不扩大任何其他授权。",
    "不要再次等待用户确认这批图片；从当前断点继续调用正式 ai-commercial-video-remix 及其子 Skill。保留现有成果，不删除、不覆盖、不自动重试付费请求。",
    "尽快把 CODEX_PROGRESS.json 更新为正在处理状态，再继续后续人物、产品资产、分镜、提示词、任务包和视频生成流程；只有真正新增素材或扩大用途时才暂停。",
  ].join("\n");
}

export function projectTaskFullVideoMessage({ title }) {
  return [
    `我已在工作台为项目“${String(title || "未命名项目").trim()}”选择“保留已有版本，重新准备正片”。`,
    "请先读取当前目录的 PROJECT_CONTEXT.json，并核对现有项目文件、已有成果和当前断点；已生成的小样、正片版本及全部上游成果都要保留，不得覆盖或重做。",
    "请使用正式 ai-commercial-video-remix 总控，并由它调用正式提示词、任务包和生成执行 Skill；网页旧编排器不是业务规则来源。",
    "沿用工作台已经保存的人物、产品、场景、内容脚本、RunningHub H3 多参考图通道、高清和 9:16 画幅；正片时长、是否需要自然分段及参考图职责由正式 Skill 根据原片和已采用分镜决定。不得复用旧任务包冒充新版本；也不得只因容器时长向上取整超过 15 秒就机械分段。",
    "请新建独立的 full_sequence 提示词和正式任务包目录，旧文件原样保留。先完成本地合同检查；不要在项目任务里读取 Keychain，也不要直接调用 runner。",
    "当正片任务包通过本地检查后，只在当前目录写新的 RUNTIME_GENERATION_REQUEST.json，schema_version=1、request_type=runninghub_h3_generation、task_id=当前项目 ID、pack_path=当前目录内正片任务包相对路径。唯一工作台运行时会做零费用预检，并在网页显示素材、时长和预计 RH 币，等待用户确认后才付费提交。",
    "本轮禁止自动重试、禁止换通道、禁止删除任何旧版本；若正片必须分成多段，必须先把总段数、连续方式、语音边界余量和总预计费用回写工作台，并由一次网页确认授权这一轮明确列出的全部分段，不能静默逐段扣费。",
    "每到一个有意义的阶段更新 CODEX_PROGRESS.json；现在从现有断点直接准备正片，不再生成小样。",
  ].join("\n");
}

export function projectTaskInitialMessage({ title }) {
  return [
    `我刚从工作台打开项目“${String(title || "未命名项目").trim()}”。`,
    "请先只读读取当前目录中的 PROJECT_CONTEXT.json，只用简短中文告诉我当前阶段和下一步可以做什么。",
    "这次只完成项目交接：不要开始拆解、生图或生成视频，不要上传任何素材，不要产生外部费用，也不要修改或删除文件。",
    "回复后等待我的下一条指令。",
  ].join("\n");
}

export async function openCodexThreadInDesktop(
  threadId,
  {
    openBinary = process.env.WORKBENCH_CODEX_OPEN_BIN || "/usr/bin/open",
    disabled = process.env.WORKBENCH_CODEX_DESKTOP_NAVIGATION === "disabled",
  } = {},
) {
  const url = codexThreadUrl(threadId);
  if (disabled) return url;
  await new Promise((resolve, reject) => {
    const opener = spawn(openBinary, [url], { stdio: "ignore" });
    opener.once("error", reject);
    opener.once("spawn", () => {
      opener.unref();
      resolve();
    });
  });
  return url;
}

export async function createProjectCodexTask({
  taskId,
  title,
  cwd,
  contextUrl = null,
  writableRoots = [cwd],
  existingThreadId = null,
  startVisibleTurn = false,
  visibleTurnMessage = null,
  onThreadStarted = null,
  onVisibleTurnStarted = null,
  desktopOpener = openCodexThreadInDesktop,
  codexBinary = resolveCodexBinary(),
  timeoutMs = Number(
    process.env.WORKBENCH_CODEX_TASK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  ),
  visibleTurnTimeoutMs = Number(
    process.env.WORKBENCH_CODEX_VISIBLE_TURN_TIMEOUT_MS ||
      DEFAULT_VISIBLE_TURN_TIMEOUT_MS,
  ),
  transportStallTimeoutMs = Number(
    process.env.WORKBENCH_CODEX_TRANSPORT_STALL_TIMEOUT_MS ||
      DEFAULT_TRANSPORT_STALL_TIMEOUT_MS,
  ),
}) {
  if (!taskId || !cwd) throw new Error("CODEX_PROJECT_TASK_INPUTS_REQUIRED");
  const allowedWritableRoots = [cwd, ...(writableRoots || [])]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) => value.startsWith("/") && values.indexOf(value) === index);
  const childEnv = { ...process.env };
  // The workbench creates a separate user-owned project task. Inheriting the
  // parent Codex turn identity makes app-server bind to the developer thread
  // and can also leak its read-only permission profile into the new task.
  for (const key of [
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "CODEX_PERMISSION_PROFILE",
  ])
    delete childEnv[key];
  const child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  let requestId = 0;
  let stopped = false;
  let activeVisibleTurnId = null;
  const completedVisibleTurns = new Map();
  let visibleTurnTimer = null;
  let visibleTurnPollTimer = null;
  let visibleTurnPollBusy = false;
  let transportStallTimer = null;
  let transportFailureStartedAt = null;
  let resolveVisibleTurn = null;
  let rejectVisibleTurn = null;

  child.stderr.on("data", (chunk) => {
    const text = String(chunk || "");
    stderr = `${stderr}${text}`.slice(-4000);
    if (
      activeVisibleTurnId &&
      isCodexTransportDisconnect(text) &&
      !transportStallTimer
    ) {
      transportFailureStartedAt = Date.now();
      transportStallTimer = setTimeout(() => {
        const seconds = Math.max(
          1,
          Math.round((Date.now() - transportFailureStartedAt) / 1_000),
        );
        rejectVisibleTurn?.(
          new Error(`CODEX_TRANSPORT_DISCONNECTED: stalled ${seconds}s`),
        );
        stop();
      }, transportStallTimeoutMs);
      transportStallTimer.unref?.();
    }
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (visibleTurnTimer) clearTimeout(visibleTurnTimer);
    if (visibleTurnPollTimer) clearInterval(visibleTurnPollTimer);
    if (transportStallTimer) clearTimeout(transportStallTimer);
    lines.close();
    child.kill("SIGTERM");
  };
  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.once("error", (error) => {
    failAll(error);
    rejectVisibleTurn?.(error);
  });
  child.once("exit", (code) => {
    if (!stopped) {
      const error = new Error(
        `CODEX_APP_SERVER_EXITED_${code ?? "UNKNOWN"}${stderr ? `: ${stderr.trim()}` : ""}`,
      );
      if (pending.size) failAll(error);
      rejectVisibleTurn?.(error);
    }
  });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // Any valid app-server response means the transport recovered. A later
    // disconnect starts a fresh watchdog window.
    if (transportStallTimer) {
      clearTimeout(transportStallTimer);
      transportStallTimer = null;
      transportFailureStartedAt = null;
    }
    if (message.method === "turn/completed" && message.params?.turn?.id) {
      const completedTurn = message.params.turn;
      if (completedTurn.id === activeVisibleTurnId)
        resolveVisibleTurn?.(completedTurn);
      else completedVisibleTurns.set(completedTurn.id, completedTurn);
      return;
    }
    if (message.id == null || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error)
      reject(
        new Error(
          `CODEX_APP_SERVER_${message.error.code}: ${message.error.message}`,
        ),
      );
    else resolve(message.result);
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = requestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CODEX_APP_SERVER_TIMEOUT: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ method, id, params });
    });

  try {
    try {
      await request("initialize", {
        clientInfo: {
          name: "one_content_workbench",
          title: "One Content Workbench",
          version: "0.1.0",
        },
      });
    } catch (error) {
      throw new Error(`CODEX_INITIALIZE_FAILED: ${String(error?.message || error)}`);
    }
    send({ method: "initialized", params: {} });
    let threadId = existingThreadId;
    let started = null;
    let verified = null;
    const threadName = `项目｜${String(title || "未命名项目").trim()}`.slice(
      0,
      100,
    );
    if (threadId) {
      try {
        await request("thread/resume", {
          threadId,
          cwd,
          sandbox: "workspace-write",
          approvalPolicy: "never",
          developerInstructions: projectTaskInstructions({
            taskId,
            title,
            contextUrl,
          }),
        });
        await request("thread/name/set", { threadId, name: threadName });
        verified = await request("thread/read", {
          threadId,
          includeTurns: false,
        });
      } catch (error) {
        const message = String(error?.message || error).toLowerCase();
        if (!message.includes("thread not found"))
          throw error;
        console.warn("codex project task replacing stale thread", {
          taskId,
          threadId,
          reason: String(error?.message || error),
        });
        threadId = null;
      }
    }
    if (!threadId)
      started = await request("thread/start", {
        cwd,
        ephemeral: false,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        developerInstructions: projectTaskInstructions({
          taskId,
          title,
          contextUrl,
        }),
      });
    threadId ||= started?.thread?.id;
    codexThreadUrl(threadId);
    if (threadId !== existingThreadId && onThreadStarted)
      await onThreadStarted(threadId, {
        replacedThreadId: existingThreadId || null,
      });
    if (threadId !== existingThreadId) {
      await request("thread/name/set", { threadId, name: threadName });
      verified = await request("thread/read", {
        threadId,
        includeTurns: false,
      });
    }
    if (verified?.thread?.id !== threadId)
      throw new Error("CODEX_THREAD_VERIFICATION_FAILED");
    let initialTurnStarted = false;
    if (startVisibleTurn) {
      const visibleTurnCompleted = new Promise((resolve, reject) => {
        resolveVisibleTurn = resolve;
        rejectVisibleTurn = reject;
      });
      const startTurn = () => {
        const requestedModel = process.env.WORKBENCH_CODEX_HANDOFF_MODEL;
        const requestedEffort = process.env.WORKBENCH_CODEX_HANDOFF_EFFORT;
        return request("turn/start", {
          threadId,
          cwd,
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: allowedWritableRoots,
            networkAccess: false,
          },
          approvalPolicy: "never",
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(requestedEffort ? { effort: requestedEffort } : {}),
          input: [
            {
              type: "text",
              text: visibleTurnMessage || projectTaskInitialMessage({ title }),
            },
          ],
        });
      };
      let startedTurn;
      try {
        startedTurn = await startTurn();
      } catch (error) {
        const message = String(error?.message || error).toLowerCase();
        if (
          threadId !== existingThreadId ||
          !message.includes("thread not found")
        )
          throw error;
        started = await request("thread/start", {
          cwd,
          ephemeral: false,
          sandbox: "workspace-write",
          approvalPolicy: "never",
          developerInstructions: projectTaskInstructions({
            taskId,
            title,
            contextUrl,
          }),
        });
        threadId = started?.thread?.id;
        codexThreadUrl(threadId);
        if (onThreadStarted)
          await onThreadStarted(threadId, {
            replacedThreadId: existingThreadId || null,
          });
        await request("thread/name/set", { threadId, name: threadName });
        verified = await request("thread/read", {
          threadId,
          includeTurns: false,
        });
        if (verified?.thread?.id !== threadId)
          throw new Error("CODEX_THREAD_VERIFICATION_FAILED");
        startedTurn = await startTurn();
      }
      activeVisibleTurnId = startedTurn?.turn?.id;
      if (!activeVisibleTurnId)
        throw new Error("CODEX_INITIAL_TURN_NOT_STARTED");
      if (onVisibleTurnStarted)
        await onVisibleTurnStarted(threadId, activeVisibleTurnId);
      const alreadyCompletedTurn = completedVisibleTurns.get(activeVisibleTurnId);
      if (alreadyCompletedTurn) {
        completedVisibleTurns.delete(activeVisibleTurnId);
        resolveVisibleTurn?.(alreadyCompletedTurn);
      }
      initialTurnStarted = true;
      visibleTurnTimer = setTimeout(
        () => rejectVisibleTurn?.(new Error("CODEX_INITIAL_TURN_TIMEOUT")),
        visibleTurnTimeoutMs,
      );
      visibleTurnTimer.unref?.();
      // Some Codex desktop builds persist a terminal turn state without
      // emitting turn/completed to this app-server client. Poll the same
      // thread as a fallback so the workbench cannot remain falsely
      // "running" after an interrupted or failed turn.
      visibleTurnPollTimer = setInterval(async () => {
        if (visibleTurnPollBusy || stopped || !activeVisibleTurnId) return;
        visibleTurnPollBusy = true;
        try {
          const snapshot = await request("thread/read", {
            threadId,
            includeTurns: true,
          });
          const turns = snapshot?.thread?.turns || snapshot?.turns || [];
          const visibleTurn = turns.find(
            (turn) => turn?.id === activeVisibleTurnId,
          );
          if (
            visibleTurn &&
            ["completed", "interrupted", "failed", "cancelled"].includes(
              String(visibleTurn.status || "").toLowerCase(),
            )
          )
            resolveVisibleTurn?.(visibleTurn);
        } catch {
          // Ordinary completion events and the main timeout remain active
          // when a transient status poll itself fails.
        } finally {
          visibleTurnPollBusy = false;
        }
      }, 5_000);
      visibleTurnPollTimer.unref?.();
      const completedTurn = await visibleTurnCompleted;
      if (completedTurn?.status !== "completed")
        throw new Error(
          `CODEX_INITIAL_TURN_${String(completedTurn?.status || "FAILED").toUpperCase()}`,
        );
      await desktopOpener(threadId);
    }
    return {
      threadId,
      threadName,
      url: codexThreadUrl(threadId),
      source: verified.thread.source || started?.thread?.source || null,
      initialTurnStarted,
    };
  } finally {
    stop();
  }
}

export function inspectCodexProjectTaskBridge(env = process.env) {
  const disabled = env.WORKBENCH_CODEX_TASK_BRIDGE === "disabled";
  return {
    enabled: !disabled,
    mode: disabled ? "disabled" : "local_app_server",
    automatic_on_project_create: !disabled,
    automatic_scope: "managed_remix_projects",
    starts_model_turn: !disabled,
  };
}
