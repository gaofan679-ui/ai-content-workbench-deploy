import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuredBinary, skillFile } from "./portable-paths.mjs";

const VIDEO_FRAME_SIZES = Object.freeze({
  "3:4": { width: 1152, height: 1536, fileLabel: "3x4" },
  "4:3": { width: 1536, height: 1152, fileLabel: "4x3" },
  "9:16": { width: 864, height: 1536, fileLabel: "9x16" },
  "16:9": { width: 1536, height: 864, fileLabel: "16x9" },
});

export async function runXhsJewelryVideo({ task, taskDir, env = process.env, onEvent = () => {}, onExternalRequestStarted = () => {} }) {
  const firstFrame = task.final_result?.image?.path;
  if (!firstFrame || !existsSync(firstFrame) || task.final_result?.approval_status !== "approved") {
    throw beforeSubmit("XHS_JEWELRY_VIDEO_FIRST_FRAME_MISSING");
  }
  const provider = task.video_provider;
  if (!["libtv", "runninghub_h3_multiref"].includes(provider)) throw beforeSubmit("XHS_JEWELRY_VIDEO_PROVIDER_INVALID");
  const model = resolveXhsJewelryVideoModel(provider, task.video_model_key);
  const runDir = join(taskDir, "video_generation", `attempt-${String(task.video_attempt_count).padStart(2, "0")}`);
  mkdirSync(runDir, { recursive: true });
  const sourcePromptPath = join(runDir, "video-prompt-source.txt");
  const prompt = buildXhsJewelryVideoPrompt(task);
  const promptContents = `${prompt}\n`;
  if (existsSync(sourcePromptPath)) {
    if (readFileSync(sourcePromptPath, "utf8") !== promptContents) throw beforeSubmit("XHS_JEWELRY_VIDEO_PROMPT_CONFLICT");
  } else {
    writeFileSync(sourcePromptPath, promptContents, { flag: "wx" });
  }

  if (env.WORKBENCH_XHS_JEWELRY_VIDEO_GENERATOR) {
    const resultPath = join(runDir, "fixture-result.json");
    onExternalRequestStarted();
    await runProcess(process.execPath, [env.WORKBENCH_XHS_JEWELRY_VIDEO_GENERATOR, firstFrame, resultPath, provider, model.modelKey, videoAspectRatio(task), String(videoDurationSeconds(task))], env);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    return validateResult(result, provider);
  }
  const result = provider === "runninghub_h3_multiref"
    ? await runRunningHub({ task, firstFrame, runDir, env, onEvent, onExternalRequestStarted })
    : await runLibTV({ task, firstFrame, prompt, runDir, env, onEvent, onExternalRequestStarted, model });
  return validateResult(result, provider);
}

export function buildXhsJewelryVideoPrompt(task) {
  const aspectRatio = videoAspectRatio(task);
  const durationSeconds = videoDurationSeconds(task);
  return [
    `以已确认珠宝种草成品图作为唯一首帧与画面身份来源，生成一条 ${durationSeconds} 秒、${aspectRatio} 画幅的自然动态短视频。`,
    "若首帧上下存在同场景柔化延展区域，中央完整画面才是构图主体；必须完整保留人物脸、手机、双手、上半身和珠宝，不得放大裁切中央画面。",
    "人物只做轻微呼吸、自然眨眼与极小幅度姿态变化；镜头基本固定，可有非常轻微的手持漂移。",
    "镜头焦距、取景范围和主体大小从头到尾保持不变；禁止推近、拉近、变焦、裁切或转成珠宝特写。",
    "双手保持首帧位置，只允许极小自然颤动；禁止手指靠近、触碰、托起或遮挡吊坠。",
    "珠宝必须从第一帧到最后一帧保持同一产品：轮廓、浮雕/纹理左右方向、文字或符号朝向、组件数量、吊环与连接结构、比例和佩戴位置全部锁定。",
    "禁止镜像、翻面、重绘产品、增加部件、改变链条连接方式；禁止产品漂浮、融化、抖动、忽大忽小或异常闪烁。",
    "人物脸、发型、肤色、服装、手、背景、构图和光线不得重新设计；保留原图的手机感、景深、噪声和曝光特征。",
    "画面内不新增字幕、Logo、贴纸、边框或转场，不生成声音。",
    task.brief ? `用户补充要求：${String(task.brief).slice(0, 500)}` : "",
    task.pending_rework?.user_observation ? `上次视频问题，必须定向修正：${String(task.pending_rework.user_observation).slice(0, 500)}` : "",
  ].filter(Boolean).join("\n");
}

async function runRunningHub({ task, firstFrame, runDir, env, onEvent, onExternalRequestStarted }) {
  const receiptPath = join(runDir, "runninghub-preflight.json");
  const rawOutputPath = join(runDir, "runninghub-result-with-audio.mp4");
  const outputPath = join(runDir, "result.mp4");
  const aspectRatio = videoAspectRatio(task);
  const durationSeconds = videoDurationSeconds(task);
  const preparedFrame = prepareRunningHubFirstFrame(firstFrame, runDir, env, aspectRatio);
  const productReferences = await prepareRunningHubProductReferences(task, runDir);
  const promptContract = buildRunningHubPromptContract(task, preparedFrame.path, productReferences);
  const compiledPrompt = compileRunningHubPrompt(promptContract, runDir, env);
  const runner = env.WORKBENCH_RUNNINGHUB_H3_RUNNER
    || skillFile("ai-video-generation-runner", "scripts/runninghub_h3_multiref.py", env);
  const common = [
    "--ref1", preparedFrame.path,
    "--ref1-role", preparedFrame.safeFrameApplied
      ? `已确认珠宝种草首帧的${aspectRatio}安全构图版：中央人物、产品与构图必须完整保留，延展区域仅用于适配画幅`
      : "已确认珠宝种草首帧：人物、产品、构图与光线唯一身份来源",
    "--prompt-file", compiledPrompt.promptPath,
    "--duration", String(durationSeconds),
    "--quality-profile", "high",
    "--aspect-ratio", aspectRatio,
    "--budget-limit", String(Number(env.WORKBENCH_RUNNINGHUB_BUDGET_COINS || 200)),
    "--preflight-receipt", receiptPath,
  ];
  productReferences.forEach((reference, index) => {
    const slot = index + 2;
    common.push(
      `--ref${slot}`, reference.path,
      `--ref${slot}-role`, reference.role,
    );
  });
  onEvent("正在检查 MiniMax H3 模型、余额、提示词和参考图绑定；当前尚未提交或扣积分。");
  await runProcess(env.WORKBENCH_PYTHON || "python3", [runner, "preflight", ...common], env);
  onExternalRequestStarted();
  onEvent("预检通过，已按本次确认提交 1 次视频生成；不会自动重试。");
  await runProcess(env.WORKBENCH_PYTHON || "python3", [runner, "run", ...common,
    "--run-dir", runDir,
    "--output", rawOutputPath,
    "--confirm-paid-once", "确认仅付费提交1次",
  ], env, Number(env.WORKBENCH_RUNNINGHUB_TIMEOUT_MS || 50 * 60 * 1000));
  if (!existsSync(rawOutputPath)) throw afterSubmit("XHS_JEWELRY_VIDEO_RESULT_MISSING");
  removeAudioTrack(rawOutputPath, outputPath, env);
  const journalPath = join(runDir, "task.json");
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : {};
  return {
    status: "completed",
    provider: "runninghub_h3_multiref",
    model_key: "minimax-h3-multiref-owned-clean",
    duration_seconds: durationSeconds,
    points_used: journal.usage?.consumeCoins ?? journal.usage?.coins ?? null,
    external_request_started: true,
    automatic_retry: false,
    aspect_ratio: aspectRatio,
    safe_frame_applied: preparedFrame.safeFrameApplied,
    source_dimensions: preparedFrame.sourceDimensions,
    prompt_compiler: "aigc-video-prompt-codex:h3-multiref",
    prompt_binding_fingerprint: compiledPrompt.receipt.binding_fingerprint,
    prompt_binding_count: compiledPrompt.receipt.bindings.length,
    product_source_count: productReferences.sourceCount,
    product_reference_strategy: productReferences.strategy,
    product_reference_manifest: productReferences.manifestPath,
    audio_removed: true,
    video: { path: outputPath },
    user_message: `MiniMax H3 已完成本次唯一一次提交，${aspectRatio}、${durationSeconds} 秒视频已返回；已分别使用 ${productReferences.sourceCount} 张产品图保留不同角度和细节。`,
  };
}

export function buildRunningHubPromptContract(task, preparedFramePath, productReferences = []) {
  const assets = [{
    exact_alias: "@已确认首帧",
    role: "approved_first_frame_identity",
    path: preparedFramePath,
  }];
  const referenceLines = [
    "@已确认首帧是唯一的人物、构图、动作起点、佩戴位置、背景和光线来源；完整保持中央人物、手机、双手、上半身和珠宝的取景范围。",
  ];
  productReferences.forEach((reference, index) => {
    const alias = `@产品参考图${index + 1}`;
    assets.push({ exact_alias: alias, role: reference.contractRole, path: reference.path });
    referenceLines.push(`${alias}${reference.role}；只负责补充真实产品身份与该视角可见细节，不得改变@已确认首帧的人物、构图、动作或佩戴位置。`);
  });
  return {
    body: [
      ...referenceLines,
      buildXhsJewelryVideoPrompt(task),
      "产品参考图只提供产品身份与结构证据，禁止把产品素材的白底、石膏背景、模特、裁切和拍摄角度带入视频。",
    ].join("\n"),
    assets,
  };
}

export function compileRunningHubPrompt(contract, runDir, env) {
  const sourcePath = join(runDir, "video-prompt-h3-source.txt");
  const promptPath = join(runDir, "video-prompt.txt");
  const receiptPath = join(runDir, "video-prompt-binding.json");
  writeFileSync(sourcePath, `${contract.body}\n`);
  const compiler = env.WORKBENCH_VIDEO_PROMPT_COMPILER
    || skillFile("aigc-video-prompt-codex", "scripts/provider_prompt_compiler.py", env);
  const result = spawnSync(env.WORKBENCH_PYTHON || "python3", [compiler, "h3-multiref",
    "--body-file", sourcePath,
    "--assets-json", JSON.stringify(contract.assets),
    "--json",
  ], { encoding: "utf8", env, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    throw beforeSubmit(`XHS_JEWELRY_VIDEO_PROMPT_COMPILE_FAILED:${String(result.stderr || result.stdout || "").slice(-800)}`);
  }
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { throw beforeSubmit("XHS_JEWELRY_VIDEO_PROMPT_COMPILE_INVALID"); }
  if (receipt?.validation?.status !== "pass" || !receipt.prompt) throw beforeSubmit("XHS_JEWELRY_VIDEO_PROMPT_COMPILE_BLOCKED");
  writeFileSync(promptPath, `${receipt.prompt}\n`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { promptPath, receiptPath, receipt };
}

export async function prepareRunningHubProductReferences(task, runDir) {
  const paths = Array.isArray(task?.product_image_paths)
    ? task.product_image_paths.filter((path) => typeof path === "string" && existsSync(path))
    : [];
  if (!paths.length) throw beforeSubmit("XHS_JEWELRY_VIDEO_PRODUCT_REFERENCES_MISSING");
  if (paths.length > 8) throw beforeSubmit("XHS_JEWELRY_VIDEO_PRODUCT_REFERENCES_EXCEED_H3_LIMIT");
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "product-reference-manifest.json");
  const manifest = {
    schema_version: 1,
    source_count: paths.length,
    provider_total_reference_slots: 9,
    reserved_first_frame_slots: 1,
    product_reference_slots: 8,
    strategy: "individual_product_references",
    sources: paths.map((path, index) => ({ index: index + 1, path, sha256: sha256File(path) })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const references = paths.map((path, index) => ({
    path,
    contractRole: `product_reference_${String(index + 1).padStart(2, "0")}`,
    role: index === 0
      ? "是产品主身份图，优先锁定正面款式、材质、纹理方向与关键结构"
      : `提供第 ${index + 1} 个真实产品视角，补充该视角可见的结构、材质、组件、比例与连接关系`,
  }));
  return Object.assign(references, { sourceCount: paths.length, strategy: manifest.strategy, manifestPath });
}

export function runningHubFramePlan(width, height, aspectRatio = "9:16") {
  const numericWidth = Number(width);
  const numericHeight = Number(height);
  if (!(numericWidth > 0 && numericHeight > 0)) throw beforeSubmit("XHS_JEWELRY_VIDEO_FRAME_DIMENSIONS_INVALID");
  const target = VIDEO_FRAME_SIZES[aspectRatio];
  if (!target) throw beforeSubmit("XHS_JEWELRY_VIDEO_ASPECT_RATIO_INVALID");
  const ratio = numericWidth / numericHeight;
  return {
    safeFrameApplied: Math.abs(ratio - target.width / target.height) > 0.01,
    sourceDimensions: { width: numericWidth, height: numericHeight },
    providerAspectRatio: aspectRatio,
  };
}

function prepareRunningHubFirstFrame(firstFrame, runDir, env, aspectRatio) {
  const dimensions = probeImageDimensions(firstFrame, env);
  const plan = runningHubFramePlan(dimensions.width, dimensions.height, aspectRatio);
  if (!plan.safeFrameApplied) return { path: firstFrame, ...plan };
  const target = VIDEO_FRAME_SIZES[aspectRatio];
  const outputPath = join(runDir, `first-frame-${target.fileLabel}-safe.png`);
  const ffmpeg = configuredBinary("WORKBENCH_FFMPEG", "ffmpeg", env);
  const filter = `[0:v]scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height},gblur=sigma=30[bg];[0:v]scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgb24`;
  const result = spawnSync(ffmpeg, ["-y", "-i", firstFrame, "-filter_complex", filter, "-frames:v", "1", outputPath], {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0 || !existsSync(outputPath)) {
    throw beforeSubmit(`XHS_JEWELRY_VIDEO_SAFE_FRAME_FAILED:${String(result.stderr || "").slice(-500)}`);
  }
  return { path: outputPath, ...plan };
}

function probeImageDimensions(path, env) {
  const ffprobe = configuredBinary("WORKBENCH_FFPROBE", "ffprobe", env);
  const result = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path], {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) throw beforeSubmit("XHS_JEWELRY_VIDEO_FRAME_PROBE_FAILED");
  const stream = JSON.parse(result.stdout || "{}").streams?.[0];
  if (!stream?.width || !stream?.height) throw beforeSubmit("XHS_JEWELRY_VIDEO_FRAME_DIMENSIONS_INVALID");
  return { width: Number(stream.width), height: Number(stream.height) };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function videoAspectRatio(task) {
  const value = String(task?.video_aspect_ratio || "");
  if (!VIDEO_FRAME_SIZES[value]) throw beforeSubmit("XHS_JEWELRY_VIDEO_ASPECT_RATIO_REQUIRED");
  return value;
}

function videoDurationSeconds(task) {
  const value = Number(task?.video_duration_seconds);
  if (!Number.isInteger(value) || value < 4 || value > 15) throw beforeSubmit("XHS_JEWELRY_VIDEO_DURATION_INVALID");
  return value;
}

function removeAudioTrack(inputPath, outputPath, env) {
  const ffmpeg = configuredBinary("WORKBENCH_FFMPEG", "ffmpeg", env);
  const result = spawnSync(ffmpeg, ["-y", "-i", inputPath, "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", outputPath], {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0 || !existsSync(outputPath)) {
    throw afterSubmit(`XHS_JEWELRY_VIDEO_AUDIO_NORMALIZATION_FAILED:${String(result.stderr || "").slice(-500)}`);
  }
}

async function runLibTV({ task, firstFrame, prompt, runDir, env, onEvent, onExternalRequestStarted, model }) {
  const aspectRatio = videoAspectRatio(task);
  const durationSeconds = videoDurationSeconds(task);
  const cli = configuredBinary("WORKBENCH_LIBTV_CLI", "libtv", env);
  onEvent(`正在建立本任务专属 ${model.label} 任务；当前尚未提交视频生成。`);
  const projectName = `珠宝种草-${task.id.slice(0, 8)}-${task.video_attempt_count}`;
  const project = cliJson(cli, ["project", "create", projectName, "-d", `珠宝种草 ${aspectRatio} ${durationSeconds} 秒首帧视频`]);
  const projectUuid = project.uuid || project.projectUuid;
  if (!projectUuid) throw beforeSubmit("XHS_JEWELRY_LIBTV_PROJECT_CREATE_FAILED");
  const imageName = `01_已确认珠宝首帧_${task.id.slice(0, 8)}`;
  const uploaded = cliJson(cli, ["upload", imageName, "-p", projectUuid, "--resource", firstFrame, "--x", "0", "--y", "0"]);
  const imageNodeId = uploaded.nodeKey || uploaded.id;
  if (!imageNodeId) throw beforeSubmit("XHS_JEWELRY_LIBTV_UPLOAD_FAILED");
  const videoName = `02_${durationSeconds}秒_${aspectRatio.replace(":", "x")}_自然动态_run${String(task.video_attempt_count).padStart(2, "0")}`;
  const created = cliJson(cli, ["node", "create", videoName, "-p", projectUuid, "-t", "video",
    "--prompt", prompt,
    "-s", `model=${model.modelKey}`,
    "-s", "modeType=image2video",
    "-s", "count=1",
    "-s", `ratio=${aspectRatio}`,
    "-s", "resolution=720p",
    "-s", `duration=${durationSeconds}`,
    "-s", "enableSound=off",
    "-s", "search_enabled=0",
    "-s", "autoCompliance=1",
    "--left-add", imageName,
    "--x", "900", "--y", "0",
  ]);
  const videoNodeId = created.nodeKey || created.id;
  if (!videoNodeId) throw beforeSubmit("XHS_JEWELRY_LIBTV_VIDEO_NODE_CREATE_FAILED");
  const receiptPath = join(runDir, "libtv-submission-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify({
    schema_version: 1,
    task_id: task.id,
    project_uuid: projectUuid,
    image_node_id: imageNodeId,
    video_node_id: videoNodeId,
    model_key: model.modelKey,
    aspect_ratio: aspectRatio,
    duration_seconds: durationSeconds,
    generation_count: 1,
    automatic_retry: false,
    external_request_started: false,
  }, null, 2)}\n`);
  onExternalRequestStarted();
  onEvent(`已向 ${model.label} 提交 1 次视频生成，正在等待结果；不会自动重试。`);
  await cliJsonAsync(cli, ["node", videoNodeId, "-p", projectUuid, "-r"], 15_000).catch((error) => {
    const node = cliJson(cli, ["node", videoNodeId, "-p", projectUuid]);
    if (!node.data?.taskInfo?.taskId) throw Object.assign(error, { external_request_started: true });
  });
  const deadline = Date.now() + Number(env.WORKBENCH_LIBTV_POLL_TIMEOUT_MS || 30 * 60 * 1000);
  let node = {};
  let lastProgress = -1;
  while (Date.now() < deadline) {
    node = cliJson(cli, ["node", videoNodeId, "-p", projectUuid]);
    const info = node.data?.taskInfo || {};
    const progress = Number(info.progressPercent || 0);
    if (progress !== lastProgress) {
      lastProgress = progress;
      onEvent(progress > 0 ? `视频正在生成，当前进度 ${progress}%。` : "视频任务已进入队列。");
    }
    const urls = Array.isArray(node.data?.url) ? node.data.url.filter(Boolean) : [];
    if (Number(info.status) === 2 && urls.length) break;
    if (info.taskId && info.loading === false && ![0, 1, 2].includes(Number(info.status))) throw afterSubmit(`XHS_JEWELRY_LIBTV_REMOTE_FAILED:${info.status}`);
    await delay(Number(env.WORKBENCH_LIBTV_POLL_INTERVAL_MS || 10_000));
  }
  if (Number(node.data?.taskInfo?.status) !== 2) throw afterSubmit("XHS_JEWELRY_LIBTV_POLL_TIMEOUT");
  const downloadDir = join(runDir, "result");
  mkdirSync(downloadDir, { recursive: true });
  cliJson(cli, ["download", "-p", projectUuid, "-n", videoNodeId, "-o", downloadDir, "--without-ai-watermark", "--vip"], true);
  const outputPath = findFile(downloadDir, /\.(mp4|mov|webm)$/i);
  if (!outputPath) throw afterSubmit("XHS_JEWELRY_VIDEO_RESULT_MISSING");
  return {
    status: "completed",
    provider: "libtv",
    model_key: model.modelKey,
    aspect_ratio: aspectRatio,
    duration_seconds: durationSeconds,
    points_used: null,
    project_uuid: projectUuid,
    remote_task_id: node.data.taskInfo.taskId || null,
    external_request_started: true,
    automatic_retry: false,
    video: { path: outputPath },
    user_message: `${model.label} 已完成本次唯一一次提交，${aspectRatio}、${durationSeconds} 秒视频已返回。`,
  };
}

export function resolveXhsJewelryVideoModel(provider, requestedModelKey) {
  if (provider === "runninghub_h3_multiref") {
    return { modelKey: "minimax-h3-multiref-owned-clean", label: "MiniMax H3" };
  }
  const modelKey = requestedModelKey || "star-video2-fast";
  const labels = {
    "star-video2.5": "Seedance 2.5",
    "star-video2": "Seedance 2.0",
    "star-video2-fast": "Seedance 2.0 Fast",
  };
  if (!labels[modelKey]) throw beforeSubmit("XHS_JEWELRY_VIDEO_MODEL_INVALID");
  return { modelKey, label: labels[modelKey] };
}

function validateResult(result, provider) {
  if (result?.status !== "completed" || result.provider !== provider || result.automatic_retry !== false) {
    throw beforeSubmit("XHS_JEWELRY_VIDEO_RESULT_INVALID");
  }
  const path = result.video?.path;
  if (!path || !existsSync(path) || !/\.(mp4|mov|webm)$/i.test(path)) throw afterSubmit("XHS_JEWELRY_VIDEO_RESULT_MISSING");
  const size = statSync(path).size;
  if (size < 1) throw afterSubmit("XHS_JEWELRY_VIDEO_RESULT_EMPTY");
  return { ...result, video: { ...result.video, path, size_bytes: size, published: false } };
}

function cliJson(cli, args, allowText = false) {
  const run = spawnSync(cli, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw beforeSubmit(run.error.message);
  if (run.status !== 0) throw beforeSubmit(String(run.stderr || run.stdout || `LIBTV_EXIT_${run.status}`).trim());
  const output = String(run.stdout || "").trim();
  if (!output) return {};
  try { return JSON.parse(output); } catch { if (allowText) return { output }; throw beforeSubmit("LIBTV_RESPONSE_NOT_JSON"); }
}

function cliJsonAsync(cli, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(afterSubmit("LIBTV_TRIGGER_WAIT_TIMEOUT")); }, timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code !== 0) return reject(afterSubmit(Buffer.concat(stderr).toString("utf8").trim() || output || `LIBTV_EXIT_${code}`));
      if (!output) return resolve({});
      try { resolve(JSON.parse(output)); } catch { reject(afterSubmit("LIBTV_RESPONSE_NOT_JSON")); }
    });
  });
}

function runProcess(command, args, env, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(beforeSubmit("XHS_JEWELRY_VIDEO_RUNNER_TIMEOUT")); }, timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(beforeSubmit(Buffer.concat(stderr).toString("utf8").trim() || `XHS_JEWELRY_VIDEO_RUNNER_EXIT_${code}`));
    });
  });
}

function findFile(root, pattern) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { const found = findFile(path, pattern); if (found) return found; }
    else if (pattern.test(entry.name)) return path;
  }
  return null;
}

function beforeSubmit(message) { return Object.assign(new Error(message), { external_request_started: false }); }
function afterSubmit(message) { return Object.assign(new Error(message), { external_request_started: true }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
