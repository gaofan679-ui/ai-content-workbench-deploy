import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const DEFAULT_LIBTV = "libtv";
const REFERENCE_CONTRACT = [
  { alias: "@分镜安全提交版", nodeLabel: "01_分镜安全提交版" },
  { alias: "@三道红线人物参考", nodeLabel: "02_三道红线人物参考" },
  { alias: "@局部材质拼图", nodeLabel: "03_局部材质拼图" },
];
const SUPPORTED_VIDEO_MODELS = new Set(["star-video2-mini", "star-video2-fast", "star-video2", "star-video2.5"]);

export function videoGenerationRunIdentity(modelKey, attemptNumber = 1, generationKind = "smoke_test") {
  if (!SUPPORTED_VIDEO_MODELS.has(modelKey)) throw new Error("VIDEO_GENERATION_MODEL_UNSUPPORTED");
  const safeModelKey = modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeAttemptNumber = Number(attemptNumber);
  if (!Number.isInteger(safeAttemptNumber) || safeAttemptNumber < 1) throw new Error("VIDEO_GENERATION_ATTEMPT_INVALID");
  const attempt = String(safeAttemptNumber).padStart(3, "0");
  if (!new Set(["smoke_test", "full_sequence"]).has(generationKind)) throw new Error("VIDEO_GENERATION_KIND_INVALID");
  const full = generationKind === "full_sequence";
  return {
    nodeName: full ? `05_正式版_${safeModelKey}_run${attempt}` : `04_4秒动作小样_${safeModelKey}_run${attempt}`,
    runDirectoryName: full ? `${safeModelKey}_full_run${attempt}` : `${safeModelKey}_run${attempt}`,
  };
}

export function libTVNodeId(node) {
  return node?.id || node?.nodeKey || null;
}

export function buildReferenceNodeSpecs(references) {
  if (!Array.isArray(references) || references.length !== REFERENCE_CONTRACT.length) throw beforeSubmit("VIDEO_GENERATION_REFERENCE_SET_INVALID");
  const byAlias = new Map(references.map((item) => [item.alias, item]));
  if (byAlias.size !== REFERENCE_CONTRACT.length) throw beforeSubmit("VIDEO_GENERATION_REFERENCE_ALIAS_INVALID");
  return REFERENCE_CONTRACT.map(({ alias, nodeLabel }) => {
    const reference = byAlias.get(alias);
    if (!reference?.path || !existsSync(reference.path) || !reference.upload_to_video_model) throw beforeSubmit(`VIDEO_GENERATION_REFERENCE_INVALID:${alias}`);
    const sha256 = createHash("sha256").update(readFileSync(reference.path)).digest("hex");
    return { ...reference, alias, nodeLabel, nodeName: `${nodeLabel}_${sha256.slice(0, 10)}`, sha256 };
  });
}

export function compileLibTVReferencePrompt(canonicalPrompt, imageList, referenceNodes) {
  if (typeof canonicalPrompt !== "string" || !canonicalPrompt.trim()) throw beforeSubmit("VIDEO_GENERATION_PROMPT_EMPTY");
  const expected = new Map(referenceNodes.map((item) => [item.nodeId, item]));
  if (expected.size !== REFERENCE_CONTRACT.length || referenceNodes.some((item) => !item.nodeId)) throw beforeSubmit("VIDEO_GENERATION_REFERENCE_IDENTITY_UNPROVEN");
  const actualIds = (Array.isArray(imageList) ? imageList : []).map(imageInputNodeId);
  if (actualIds.length !== expected.size || new Set(actualIds).size !== actualIds.length || actualIds.some((id) => !expected.has(id))) {
    throw beforeSubmit("VIDEO_GENERATION_REFERENCE_ORDER_UNPROVEN");
  }
  let providerPrompt = canonicalPrompt;
  const bindings = actualIds.map((nodeId, index) => {
    const reference = expected.get(nodeId);
    const placeholder = `{{Image ${index + 1}}}`;
    providerPrompt = providerPrompt.replaceAll(reference.alias, placeholder);
    return { position: index + 1, placeholder, node_id: nodeId, node_name: reference.nodeName, alias: reference.alias, source_path: reference.path, source_sha256: reference.sha256 };
  });
  const missingAliases = referenceNodes.filter((item) => providerPrompt.includes(item.alias));
  if (missingAliases.length || referenceNodes.some((item) => !canonicalPrompt.includes(item.alias))) throw beforeSubmit("VIDEO_GENERATION_PROMPT_REFERENCE_BINDING_INCOMPLETE");
  return { providerPrompt, bindings, referenceOrderFingerprint: referenceOrderFingerprint(imageList) };
}

export function referenceOrderFingerprint(imageList) {
  const ids = (Array.isArray(imageList) ? imageList : []).map(imageInputNodeId);
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

export function advanceBindingStability(previous, { fingerprint, contractPass, requiredStableReads = 3 }) {
  if (!contractPass || !fingerprint) return { fingerprint: null, stable_reads: 0, ready: false };
  const stableReads = previous?.fingerprint === fingerprint ? Number(previous.stable_reads || 0) + 1 : 1;
  return { fingerprint, stable_reads: stableReads, ready: stableReads >= requiredStableReads };
}

export function verifyPromptLineage(taskCard) {
  if (!taskCard?.model_prompt || sha256Text(taskCard.model_prompt) !== taskCard.provider_prompt_template_sha256) {
    throw beforeSubmit("VIDEO_GENERATION_PROVIDER_PROMPT_HASH_MISMATCH");
  }
  if (taskCard.generation_unit !== "full_sequence") return true;
  if (!taskCard.canonical_prompt || sha256Text(taskCard.canonical_prompt) !== taskCard.canonical_prompt_sha256) {
    throw beforeSubmit("VIDEO_GENERATION_CANONICAL_PROMPT_HASH_MISMATCH");
  }
  if (!taskCard.model_prompt.endsWith(taskCard.canonical_prompt) || (taskCard.prompt_body_transformations || []).length) {
    throw beforeSubmit("VIDEO_GENERATION_CANONICAL_PROMPT_MUTATED");
  }
  return true;
}

export function smokePromptSafetyDiagnostics(prompt) {
  const text = String(prompt || "");
  return {
    structure_only: /@分镜安全提交版[^。；\n]*(只参考|仅参考)[^。；\n]*(构图|景别|动作起点|空间)/.test(text),
    no_face_from_grid: /@分镜安全提交版[^。；\n]*不从[^。；\n]*(读取|复制)[^。；\n]*人物五官/.test(text),
    no_grid_layout: /不生成[^。；\n]*宫格[^。；\n]*分屏[^。；\n]*白边[^。；\n]*网格/.test(text),
    no_input_marks_in_output: /红线、网格和拼图边界[^。\n]*最终画面[^。\n]*完全不可见/.test(text),
  };
}

export function loadLibTVTaskCard(packArtifactPath, submissionPreview) {
  if (!packArtifactPath || !existsSync(packArtifactPath)) throw beforeSubmit("VIDEO_GENERATION_INPUTS_MISSING");
  const packDir = statSync(packArtifactPath).isDirectory() ? packArtifactPath : dirname(packArtifactPath);
  const taskCardsPath = statSync(packArtifactPath).isFile() && packArtifactPath.endsWith(".json")
    ? packArtifactPath
    : join(packDir, "generation_tasks.json");
  if (!existsSync(taskCardsPath)) throw beforeSubmit("VIDEO_GENERATION_TASK_CARDS_MISSING");
  const pack = JSON.parse(readFileSync(taskCardsPath, "utf8"));
  const rawCard = pack.task_cards?.[0];
  const promptFile = rawCard?.model_prompt_path || rawCard?.model_prompt_file || rawCard?.prompt?.model_prompt_file;
  const promptPath = promptFile ? (isAbsolute(promptFile) ? promptFile : join(packDir, promptFile)) : null;
  if (!rawCard || !promptPath || !existsSync(promptPath)) throw beforeSubmit("VIDEO_GENERATION_MODEL_PROMPT_MISSING");
  const modelPrompt = readFileSync(promptPath, "utf8").trimEnd();
  if (!modelPrompt || (submissionPreview?.prompt_text && modelPrompt !== String(submissionPreview.prompt_text).trimEnd())) {
    throw beforeSubmit("VIDEO_GENERATION_PROMPT_PREVIEW_MISMATCH");
  }
  const taskCard = {
    ...rawCard,
    model_prompt_path: promptPath,
    model_prompt: rawCard.model_prompt ?? modelPrompt,
    canonical_prompt: rawCard.canonical_prompt ?? modelPrompt,
    canonical_prompt_sha256: rawCard.canonical_prompt_sha256 ?? sha256Text(modelPrompt),
    provider_prompt_template_sha256: rawCard.provider_prompt_template_sha256 ?? sha256Text(modelPrompt),
    prompt_body_transformations: rawCard.prompt_body_transformations ?? [],
  };
  return { pack, taskCard, taskCardsPath };
}

export async function runLibTVVideoGeneration({ task, taskDir, env = process.env, onEvent = () => {}, onExternalRequestStarted = () => {} }) {
  const cli = env.WORKBENCH_LIBTV_CLI || DEFAULT_LIBTV;
  const projectUuid = task.libtv_project_uuid;
  const card = task.generation_pack_result?.submission_preview;
  const packPath = task.generation_pack_result?.artifacts?.find((item) => item.label === "视频生成任务包")?.path;
  if (!projectUuid || !packPath || !existsSync(packPath)) throw beforeSubmit("VIDEO_GENERATION_INPUTS_MISSING");
  const { pack, taskCard } = loadLibTVTaskCard(packPath, card);
  if (!taskCard || taskCard.generation_count !== 1 || taskCard.duration_seconds !== card?.duration_seconds || taskCard.model_prompt.trimEnd() !== readFileSync(taskCard.model_prompt_path, "utf8").trimEnd()) {
    throw beforeSubmit("VIDEO_GENERATION_PACK_CONTRACT_MISMATCH");
  }
  if (pack.model_key && pack.model_key !== card.model_key) throw beforeSubmit("VIDEO_GENERATION_MODEL_CHANGED");
  verifyPromptLineage(taskCard);
  const generationKind = taskCard.generation_unit === "full_sequence" ? "full_sequence" : "smoke_test";
  const duration = Number(card.duration_seconds);
  if (card.automatic_retry !== false || card.generation_count !== 1 || !SUPPORTED_VIDEO_MODELS.has(card.model_key) || !Number.isInteger(duration) || duration < 4 || duration > 15 || (generationKind === "smoke_test" && duration !== 4) || card.aspect_ratio !== "9:16" || !["480p", "720p", "1080p"].includes(card.resolution)) {
    throw beforeSubmit("VIDEO_GENERATION_SELECTION_CHANGED");
  }
  const safetyDiagnostics = generationKind === "smoke_test" ? smokePromptSafetyDiagnostics(taskCard.model_prompt) : null;
  if (safetyDiagnostics && !Object.values(safetyDiagnostics).every(Boolean)) {
    const failed = Object.entries(safetyDiagnostics).filter(([, passed]) => !passed).map(([name]) => name);
    throw beforeSubmit(`VIDEO_GENERATION_VISUAL_CONTAMINATION_GATE_FAILED:${failed.join(",")}`);
  }
  const referenceSpecs = buildReferenceNodeSpecs(taskCard.references);

  const attemptNumber = generationKind === "full_sequence" ? (task.full_video_generation_attempt_count || 1) : (task.video_generation_attempt_count || 1);
  const runIdentity = videoGenerationRunIdentity(card.model_key, attemptNumber, generationKind);
  const runDir = join(taskDir, "09_video_generation", runIdentity.runDirectoryName);
  mkdirSync(runDir, { recursive: true });
  const receiptPath = join(runDir, "libtv_submission_receipt.json");
  const bindingReceiptPath = join(runDir, "libtv_reference_binding_receipt.json");
  const existingReceipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
  let project = cliJson(cli, ["project", projectUuid]);
  const projectNodes = new Map((project.nodes || []).map((item) => [item.name, item]));

  for (let index = 0; index < referenceSpecs.length; index += 1) {
    const { nodeName, path } = referenceSpecs[index];
    if (projectNodes.has(nodeName)) continue;
    onEvent(`正在上传第 ${index + 1}/3 项已确认素材。`);
    const uploaded = cliJson(cli, ["upload", nodeName, "-p", projectUuid, "--resource", path, "--x", "0", "--y", String(index * 700)]);
    projectNodes.set(nodeName, { id: uploaded.nodeKey, name: nodeName, type: "image" });
  }

  project = cliJson(cli, ["project", projectUuid]);
  const refreshedNodes = new Map((project.nodes || []).map((item) => [item.name, item]));
  const referenceNodes = referenceSpecs.map((item) => {
    const summary = refreshedNodes.get(item.nodeName);
    const nodeId = libTVNodeId(summary);
    if (!nodeId || summary?.type !== "image") throw beforeSubmit(`VIDEO_GENERATION_REFERENCE_NODE_MISMATCH:${item.alias}`);
    return { ...item, nodeId };
  });
  let videoSummary = (project.nodes || []).find((item) => item.name === runIdentity.nodeName);
  if (!videoSummary) {
    onEvent("素材已就绪，正在建立一次性生成任务。\n");
    const args = ["node", "create", runIdentity.nodeName, "-p", projectUuid, "-t", "video", "--prompt", taskCard.model_prompt,
      "-s", `model=${card.model_key}`, "-s", "modeType=image2video", "-s", "count=1", "-s", `ratio=${card.aspect_ratio}`,
      "-s", `resolution=${card.resolution}`, "-s", `duration=${card.duration_seconds}`, "-s", `enableSound=${card.generate_audio ? "on" : "off"}`,
      "-s", "search_enabled=0", "-s", "autoCompliance=1", "--x", "900", "--y", "700"];
    for (const item of referenceNodes) args.push("--left-add", item.nodeName);
    const created = cliJson(cli, args);
    const createdNodeId = libTVNodeId(created);
    if (!createdNodeId) throw beforeSubmit("VIDEO_GENERATION_CREATED_NODE_ID_MISSING");
    videoSummary = { id: createdNodeId, name: runIdentity.nodeName, type: "video" };
  }

  videoSummary = { ...videoSummary, id: libTVNodeId(videoSummary) };
  if (!videoSummary.id) throw beforeSubmit("VIDEO_GENERATION_VIDEO_NODE_ID_MISSING");

  // LibTV may rebuild imageList from edge/node creation order when a task is
  // started. Pin the provider-visible order explicitly instead of trusting the
  // temporary order returned immediately after --left-add.
  const pinnedReferenceOrder = referenceNodes.map((item) => item.nodeId);
  cliJson(cli, ["node", videoSummary.id, "-p", projectUuid,
    "-s", `imageListOrder=${JSON.stringify(pinnedReferenceOrder)}`,
    "-s", `mixedListOrder=${JSON.stringify(pinnedReferenceOrder)}`]);

  // LibTV may return the newly-created node before all reference edges become
  // visible in subsequent reads. Wait only for read consistency; this does not
  // trigger generation and is separate from the no-automatic-retry contract.
  let node;
  let nodeDiagnostics;
  let compiledBinding;
  let bindingStability = { fingerprint: null, stable_reads: 0, ready: false };
  // LibTV sometimes exposes the edges before the new node's imageList becomes
  // readable. This is a read-consistency wait only: it neither recreates the
  // node nor uploads or submits anything again.
  const bindingChecks = Number(env.WORKBENCH_LIBTV_BINDING_CHECKS || 180);
  const requiredStableReads = Math.max(3, Number(env.WORKBENCH_LIBTV_REQUIRED_STABLE_READS || 3));
  for (let check = 0; check < bindingChecks; check += 1) {
    node = cliJson(cli, ["node", videoSummary.id, "-p", projectUuid]);
    project = cliJson(cli, ["project", projectUuid]);
    const connectedInputIds = (project.edges || []).filter((edge) => edge.target === videoSummary.id).map((edge) => edge.source);
    try { compiledBinding = compileLibTVReferencePrompt(taskCard.model_prompt, node.data?.params?.imageList, referenceNodes); }
    catch { compiledBinding = null; }
    nodeDiagnostics = videoNodeContractDiagnostics(node.data, card, compiledBinding?.providerPrompt, { expectedNodeIds: referenceNodes.map((item) => item.nodeId), expectedOrderedNodeIds: pinnedReferenceOrder, connectedInputIds });
    if (compiledBinding && !node.data?.taskInfo?.taskId && node.data?.params?.prompt !== compiledBinding.providerPrompt) {
      cliJson(cli, ["node", videoSummary.id, "-p", projectUuid, "--prompt", compiledBinding.providerPrompt]);
      bindingStability = { fingerprint: null, stable_reads: 0, ready: false };
      if (check < bindingChecks - 1) await delay(250);
      continue;
    }
    const contractPass = Boolean(compiledBinding) && Object.values(nodeDiagnostics).every(Boolean);
    bindingStability = advanceBindingStability(bindingStability, {
      fingerprint: compiledBinding?.referenceOrderFingerprint || null,
      contractPass,
      requiredStableReads,
    });
    // One extra identical read is the immediate pre-submit gate. This catches
    // LibTV's delayed reference reorder after a node first appears stable.
    if (bindingStability.ready && bindingStability.stable_reads >= requiredStableReads + 1) break;
    if (check < bindingChecks - 1) await delay(1000);
  }
  if (!compiledBinding) throw beforeSubmit("VIDEO_GENERATION_REFERENCE_ORDER_UNPROVEN");
  if (!bindingStability.ready || bindingStability.stable_reads < requiredStableReads + 1) throw beforeSubmit("VIDEO_GENERATION_REFERENCE_ORDER_NOT_STABLE");
  const connectedInputIds = (project.edges || []).filter((edge) => edge.target === videoSummary.id).map((edge) => edge.source);
  verifyNodeContract(node.data, card, compiledBinding.providerPrompt, { expectedNodeIds: referenceNodes.map((item) => item.nodeId), expectedOrderedNodeIds: pinnedReferenceOrder, connectedInputIds });
  writeFileSync(bindingReceiptPath, `${JSON.stringify({
    schema_version: 2,
    task_id: task.id,
    project_uuid: projectUuid,
    video_node_id: videoSummary.id,
    verified_at: new Date().toISOString(),
    canonical_prompt_sha256: createHash("sha256").update(taskCard.model_prompt).digest("hex"),
    provider_prompt_sha256: createHash("sha256").update(compiledBinding.providerPrompt).digest("hex"),
    provider_prompt_template_sha256: taskCard.provider_prompt_template_sha256,
    canonical_prompt_source: taskCard.canonical_prompt_source || null,
    reference_order_fingerprint: compiledBinding.referenceOrderFingerprint,
    stable_read_count: bindingStability.stable_reads,
    required_stable_read_count: requiredStableReads,
    verified_immediately_before_submission: true,
    bindings: compiledBinding.bindings,
    contract_status: "pass",
    external_request_started: false,
  }, null, 2)}\n`);
  // This function only runs after a fresh explicit UI submission. A provider-side
  // rejection created no remote task, so a later user click may reuse the same node.
  // The runner itself never schedules or loops a new submission.
  const capacityRetryAllowed = existingReceipt?.submission_state === "rejected_before_task_creation";
  const alreadySubmitted = Boolean(node.data?.taskInfo?.taskId || (existingReceipt?.submission_started_at && !capacityRetryAllowed));
  if (!alreadySubmitted) {
    const receipt = {
      ...(existingReceipt || {}),
      schema_version: 1,
      task_id: task.id,
      project_uuid: projectUuid,
      video_node_id: videoSummary.id,
      video_node_name: runIdentity.nodeName,
      model_key: card.model_key,
      duration_seconds: card.duration_seconds,
      generation_count: 1,
      automatic_retry: false,
      reference_binding_receipt: bindingReceiptPath,
      reference_bindings: compiledBinding.bindings,
      submission_started_at: new Date().toISOString(),
      submission_state: "triggering_once",
      infrastructure_retry_count: Number(existingReceipt?.infrastructure_retry_count || 0) + (capacityRetryAllowed ? 1 : 0),
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, existingReceipt ? undefined : { flag: "wx" });
    onExternalRequestStarted();
    onEvent("已提交一次视频生成，正在等待 LibTV 返回结果。\n");
    try {
      await cliJsonAsync(cli, ["node", videoSummary.id, "-p", projectUuid, "-r"], { timeout: 15_000 });
    } catch (error) {
      if (/1200000136|算力不足/.test(String(error))) {
        const rejected = { ...receipt, submission_state: "rejected_before_task_creation", rejected_at: new Date().toISOString(), rejection_code: "1200000136", rejection_reason: "算力不足" };
        writeFileSync(receiptPath, `${JSON.stringify(rejected, null, 2)}\n`);
        throw beforeSubmit("LIBTV_CAPACITY_UNAVAILABLE_BEFORE_TASK_CREATION");
      }
      // The CLI can keep waiting after the remote task is already created. A
      // local timeout must not turn a real remote task into a failed attempt.
      node = cliJson(cli, ["node", videoSummary.id, "-p", projectUuid]);
      if (!node.data?.taskInfo?.taskId) throw afterSubmit("VIDEO_GENERATION_SUBMISSION_STATE_UNKNOWN", { receiptPath, videoNodeId: videoSummary.id });
    }
  } else if (!node.data?.taskInfo?.taskId && existingReceipt?.submission_started_at) {
    throw afterSubmit("VIDEO_GENERATION_SUBMISSION_STATE_UNKNOWN", { receiptPath, videoNodeId: videoSummary.id });
  }

  const deadline = Date.now() + Number(env.WORKBENCH_LIBTV_POLL_TIMEOUT_MS || 30 * 60 * 1000);
  let lastProgress = -1;
  while (Date.now() < deadline) {
    node = cliJson(cli, ["node", videoSummary.id, "-p", projectUuid]);
    const info = node.data?.taskInfo || {};
    const progress = Number(info.progressPercent || 0);
    if (progress !== lastProgress) {
      lastProgress = progress;
      onEvent(progress > 0 ? `视频正在生成，当前进度 ${progress}%。` : "视频任务已进入队列，正在等待生成。\n");
    }
    const urls = Array.isArray(node.data?.url) ? node.data.url.filter(Boolean) : [];
    if (Number(info.status) === 2 && urls.length) break;
    if (info.taskId && info.loading === false && ![0, 1, 2].includes(Number(info.status))) {
      throw afterSubmit(`VIDEO_GENERATION_REMOTE_FAILED:${info.status}`, { receiptPath, videoNodeId: videoSummary.id });
    }
    await delay(Number(env.WORKBENCH_LIBTV_POLL_INTERVAL_MS || 10_000));
  }
  const urls = Array.isArray(node.data?.url) ? node.data.url.filter(Boolean) : [];
  if (!urls.length || Number(node.data?.taskInfo?.status) !== 2) throw afterSubmit("VIDEO_GENERATION_POLL_TIMEOUT", { receiptPath, videoNodeId: videoSummary.id });

  const downloadDir = join(runDir, "result");
  mkdirSync(downloadDir, { recursive: true });
  onEvent("视频已经生成，正在返回工作台并检查文件。\n");
  cliJson(cli, ["download", "-p", projectUuid, "-n", videoSummary.id, "-o", downloadDir, "--without-ai-watermark", "--vip"], { allowText: true, timeout: 120_000 });
  const resultPath = findFile(downloadDir, /\.(mp4|mov|webm)$/i);
  if (!resultPath) throw afterSubmit("VIDEO_GENERATION_DOWNLOAD_MISSING", { receiptPath, videoNodeId: videoSummary.id, remoteUrl: urls[0] });
  const completedReceipt = {
    ...(existingReceipt || JSON.parse(readFileSync(receiptPath, "utf8"))),
    submission_state: "completed",
    completed_at: new Date().toISOString(),
    remote_task_id: node.data.taskInfo.taskId,
    remote_url: urls[0],
    local_result_path: resultPath,
    points_used: null,
    points_receipt_status: "not_returned_by_libtv_cli",
  };
  writeFileSync(receiptPath, `${JSON.stringify(completedReceipt, null, 2)}\n`);
  const fullSequence = generationKind === "full_sequence";
  return {
    status: "completed",
    summary: fullSequence ? "完整版视频已经生成并返回工作台。" : "4 秒动作小样已经生成并返回工作台。",
    user_message: fullSequence ? "完整版视频已经生成，可以直接查看；LibTV CLI 本次没有返回积分数字。" : "4 秒动作小样已经生成，可以直接查看；LibTV CLI 本次没有返回积分数字。",
    generation_kind: generationKind,
    model_key: card.model_key,
    duration_seconds: card.duration_seconds,
    points_used: null,
    points_receipt_status: "not_returned_by_libtv_cli",
    project_uuid: projectUuid,
    video_node_id: videoSummary.id,
    remote_task_id: node.data.taskInfo.taskId,
    remote_url: urls[0],
    external_request_started: true,
    automatic_retry: false,
    artifacts: [
      { label: fullSequence ? "完整版视频" : "4 秒动作小样", path: resultPath, published: true },
      { label: "视频生成回执", path: receiptPath, published: false },
    ],
  };
}

export function videoNodeContractDiagnostics(data, card, prompt, referenceContract = {}) {
  const params = data?.params || {};
  const settings = params.settings || params;
  const expectedNodeIds = Array.isArray(referenceContract.expectedNodeIds) ? referenceContract.expectedNodeIds : [];
  const connectedInputIds = Array.isArray(referenceContract.connectedInputIds) ? referenceContract.connectedInputIds : [];
  const expectedOrderedNodeIds = Array.isArray(referenceContract.expectedOrderedNodeIds) ? referenceContract.expectedOrderedNodeIds : [];
  const imageInputIds = (Array.isArray(params.imageList) ? params.imageList : []).map(imageInputNodeId);
  const exactReferenceSet = expectedNodeIds.length === REFERENCE_CONTRACT.length
    && imageInputIds.length === expectedNodeIds.length
    && connectedInputIds.length === expectedNodeIds.length
    && sameUniqueSet(imageInputIds, expectedNodeIds)
    && sameUniqueSet(connectedInputIds, expectedNodeIds);
  const pinnedImageOrder = Array.isArray(params.imageListOrder) ? params.imageListOrder : [];
  const pinnedMixedOrder = Array.isArray(params.mixedListOrder) ? params.mixedListOrder : [];
  const exactReferenceOrder = expectedOrderedNodeIds.length === 0
    || (sameExactOrder(imageInputIds, expectedOrderedNodeIds)
      && sameExactOrder(pinnedImageOrder, expectedOrderedNodeIds)
      && sameExactOrder(pinnedMixedOrder, expectedOrderedNodeIds));
  return {
    type: data?.type === "video",
    prompt: Boolean(prompt) && params.prompt === prompt && !REFERENCE_CONTRACT.some((item) => params.prompt.includes(item.alias)),
    model: params.model === card.model_key,
    count: Number(params.count) === 1,
    ratio: settings.ratio === card.aspect_ratio,
    resolution: settings.resolution === card.resolution,
    duration: Number(settings.duration) === card.duration_seconds,
    references: exactReferenceSet && exactReferenceOrder,
  };
}

function verifyNodeContract(data, card, prompt, referenceContract) {
  const diagnostics = videoNodeContractDiagnostics(data, card, prompt, referenceContract);
  const failed = Object.entries(diagnostics).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length) throw beforeSubmit(`VIDEO_GENERATION_NODE_CONTRACT_MISMATCH:${failed.join(",")}`);
}

function imageInputNodeId(item) { return item?.nodeId || item?.nodeKey || item?.id || null; }
function sha256Text(value) { return createHash("sha256").update(String(value ?? "")).digest("hex"); }
function sameUniqueSet(actual, expected) {
  return new Set(actual).size === actual.length && new Set(expected).size === expected.length
    && actual.length === expected.length && actual.every((item) => expected.includes(item));
}

function sameExactOrder(actual, expected) {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function cliJson(cli, args, { timeout = 60_000, allowText = false } = {}) {
  const run = spawnSync(cli, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(String(run.stderr || run.stdout || `LIBTV_EXIT_${run.status}`).trim());
  const output = String(run.stdout || "").trim();
  if (!output) return {};
  try { return JSON.parse(output); }
  catch { if (allowText) return { output }; throw new Error("LIBTV_RESPONSE_NOT_JSON"); }
}

function cliJsonAsync(cli, args, { timeout = 60_000, allowText = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error("LIBTV_TRIGGER_WAIT_TIMEOUT");
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return reject(new Error(errorOutput || output || `LIBTV_EXIT_${code}`));
      if (!output) return resolve({});
      try { resolve(JSON.parse(output)); }
      catch { if (allowText) resolve({ output }); else reject(new Error("LIBTV_RESPONSE_NOT_JSON")); }
    });
  });
}

function findFile(directory, pattern) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const nested = findFile(path, pattern); if (nested) return nested; }
    else if (pattern.test(entry.name)) return path;
  }
  return null;
}

function beforeSubmit(message) {
  const error = new Error(message);
  error.external_request_started = false;
  return error;
}

function afterSubmit(message, details) {
  const error = new Error(message);
  error.external_request_started = true;
  error.details = details;
  return error;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
