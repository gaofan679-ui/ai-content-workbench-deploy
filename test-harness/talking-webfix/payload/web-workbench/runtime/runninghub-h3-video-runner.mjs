import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { configuredBinary, skillFile } from "./portable-paths.mjs";

export async function runRunningHubH3VideoGeneration({ task, taskDir, env = process.env, onEvent = () => {}, onExternalRequestStarted = () => {} }) {
  const preview = task.generation_pack_result?.submission_preview;
  if (preview?.provider !== "runninghub_h3_multiref") throw beforeSubmit("RUNNINGHUB_H3_PROVIDER_CONTRACT_MISMATCH");
  const packPath = task.generation_pack_result?.artifacts?.find((item) => item.label === "视频生成任务包")?.path;
  const cards = loadTaskCards(packPath);
  if (cards.length !== preview.generation_count || cards.length < 1 || cards.length > 5) throw beforeSubmit("RUNNINGHUB_H3_TASK_COUNT_MISMATCH");
  assertSafeMultiSegmentContract(cards);
  const prepared = cards.map((card, index) => prepareCard({ card, index, task, taskDir, preview, env }));
  const reusableCount = prepared.filter(hasCompletedRunningHubResult).length;
  onEvent(`正在核对 RunningHub 工作流、余额和 ${cards.length} 段素材职责；当前尚未上传或计费。`);
  for (const item of prepared) if (!hasCompletedRunningHubResult(item)) {
    await runProcess(env.WORKBENCH_PYTHON || "python3", [env.WORKBENCH_RUNNINGHUB_H3_RUNNER || skillFile("ai-video-generation-runner", "scripts/runninghub_h3_multiref.py", env), "preflight", ...item.common], env);
  }
  if (reusableCount < cards.length) onExternalRequestStarted();
  const concurrency = Math.min(cards.length, Math.max(1, Number(preview.effective_concurrency || 3)));
  onEvent(reusableCount === cards.length
    ? `已接回 ${cards.length} 段原任务结果，正在本地合成；不会再次上传或扣积分。`
    : `预检已经全部通过，正在以 ${concurrency} 路并发提交 ${cards.length - reusableCount} 段；已有 ${reusableCount} 段直接接回，每段最多只提交 1 次。`);
  const completed = await mapWithConcurrency(prepared, concurrency, async (item) => {
    if (!hasCompletedRunningHubResult(item)) {
      await runProcess(env.WORKBENCH_PYTHON || "python3", [env.WORKBENCH_RUNNINGHUB_H3_RUNNER || skillFile("ai-video-generation-runner", "scripts/runninghub_h3_multiref.py", env), "run", ...item.common, "--run-dir", item.runDir, "--output", item.output, "--confirm-paid-once", "确认仅付费提交1次"], env, Number(env.WORKBENCH_RUNNINGHUB_TIMEOUT_MS || 50 * 60 * 1000));
    }
    if (!existsSync(item.output)) throw afterSubmit(`RUNNINGHUB_H3_RESULT_MISSING:${item.index + 1}`);
    const journal = existsSync(join(item.runDir, "task.json")) ? JSON.parse(readFileSync(join(item.runDir, "task.json"), "utf8")) : {};
    return { ...item, journal };
  });
  const fullSequence = cards.length > 1 || cards[0].generation_unit === "full_sequence";
  const stitched = cards.length > 1 ? stitchSegments(
    completed.map((item) => item.output),
    cards.map((card) => Number(card.trim_to_seconds || card.original_target_duration_seconds || card.duration_seconds)),
    join(taskDir, "09_video_generation", `runninghub_h3_full_sequence_run${String(task.full_video_generation_attempt_count || 1).padStart(3, "0")}`),
    env,
  ) : completed[0].output;
  const points = completed.map((item) => item.journal.usage?.consumeCoins ?? item.journal.usage?.coins).filter((value) => Number.isFinite(Number(value))).map(Number);
  return {
    status: "completed",
    summary: fullSequence ? `完整版视频已分 ${cards.length} 段生成并合成为一条返回工作台。` : "4 秒验证视频已经生成并返回工作台。",
    user_message: `RunningHub H3 已完成 ${cards.length} 次已确认提交，结果已返回工作台；系统没有自动重试。`,
    generation_kind: fullSequence ? "full_sequence" : "smoke_test",
    provider: "runninghub_h3_multiref",
    model_key: "minimax-h3-multiref-owned-clean",
    duration_seconds: Number(preview.target_duration_seconds || preview.duration_seconds),
    points_used: points.length ? points.reduce((sum, value) => sum + value, 0) : null,
    points_receipt_status: points.length === cards.length ? "returned_by_runninghub" : "partially_or_not_returned_by_runninghub",
    remote_task_ids: completed.map((item) => item.journal.taskId).filter(Boolean),
    external_request_started: true,
    automatic_retry: false,
    segment_count: cards.length,
    artifacts: [
      { label: fullSequence ? "正式视频" : "4秒动作小样", path: stitched, published: false },
      ...completed.map((item, index) => ({ label: `正式视频分段 ${index + 1}`, path: item.output, published: false })),
    ],
  };
}

export function assertSafeMultiSegmentContract(cards) {
  if (!Array.isArray(cards) || cards.length <= 1) return;
  const continuousNativeDialogue = cards.every((card) =>
    card.audio_route === "native_model_audio"
      && card.voice_policy === "exact_source_dialogue_only"
      && card.generation_unit === "segmented_full_sequence"
  );
  if (!continuousNativeDialogue) return;
  const safe = cards.every((card) => {
    const contract = card.stitch_contract || {};
    return contract.scene_relation !== "continuous_single_shot"
      || (
        ["bridge_frame", "previous_end_frame", "shared_audio_timeline"].includes(contract.continuity_method)
        && contract.speech_boundary_verified === true
        && Number(contract.tail_margin_seconds) >= 0.35
      );
  });
  if (!safe) throw beforeSubmit("RUNNINGHUB_H3_CONTINUOUS_NATIVE_DIALOGUE_HARD_STITCH_FORBIDDEN");
}

export async function runRunningHubH3VideoRework({ task, taskDir, env = process.env, onEvent = () => {}, onExternalRequestStarted = () => {} }) {
  const plan = task.video_rework_plan;
  if (
    plan?.status !== "running" ||
    plan.provider !== "runninghub_h3_multiref" ||
    plan.automatic_retry !== false
  )
    throw beforeSubmit("RUNNINGHUB_H3_REWORK_PLAN_INVALID");
  const version = Number(plan.version_contract?.next_version || 2);
  const planDirectory = join(taskDir, "07_generation_pack", plan.source_directory || "");
  const prepared = plan.selected_segment_ids.map((segmentId) => {
    const cardPath = join(planDirectory, `${segmentId}_rework.json`);
    if (!existsSync(cardPath)) throw beforeSubmit(`RUNNINGHUB_H3_REWORK_CARD_MISSING:${segmentId}`);
    const card = JSON.parse(readFileSync(cardPath, "utf8"));
    if (
      card.original_segment_id !== segmentId ||
      card.preflight_status !== "pass_ready_for_billable_confirmation" ||
      card.external_request_started !== false
    )
      throw beforeSubmit(`RUNNINGHUB_H3_REWORK_CARD_INVALID:${segmentId}`);
    return prepareReworkCard({ card, cardPath, taskDir, env, version });
  });
  onEvent(`正在核对 ${prepared.length} 个重生成片段的提示词和素材顺序；所有旧版本及未选片段保持不变。`);
  for (const item of prepared) {
    if (!hasCompletedRunningHubResult(item))
      await runProcess(
        env.WORKBENCH_PYTHON || "python3",
        [env.WORKBENCH_RUNNINGHUB_H3_RUNNER || skillFile("ai-video-generation-runner", "scripts/runninghub_h3_multiref.py", env), "preflight", ...item.common],
        env,
      );
  }
  const reusableCount = prepared.filter(hasCompletedRunningHubResult).length;
  if (reusableCount < prepared.length) onExternalRequestStarted();
  onEvent(
    reusableCount === prepared.length
      ? `已接回 ${prepared.length} 个重生成片段，正在重新合成版本 ${version}；不会再次提交。`
      : `预检通过，正在提交 ${prepared.length - reusableCount} 个选中片段；每段只提交 1 次，不自动重试。`,
  );
  const completed = await mapWithConcurrency(
    prepared,
    Math.min(prepared.length, 3),
    async (item) => {
      if (!hasCompletedRunningHubResult(item)) {
        await runProcess(
          env.WORKBENCH_PYTHON || "python3",
          [
            env.WORKBENCH_RUNNINGHUB_H3_RUNNER || skillFile("ai-video-generation-runner", "scripts/runninghub_h3_multiref.py", env),
            "run",
            ...item.common,
            "--run-dir",
            item.runDir,
            "--output",
            item.output,
            "--confirm-paid-once",
            "确认仅付费提交1次",
          ],
          env,
          Number(env.WORKBENCH_RUNNINGHUB_TIMEOUT_MS || 50 * 60 * 1000),
        );
      }
      if (!existsSync(item.output)) throw afterSubmit(`RUNNINGHUB_H3_REWORK_RESULT_MISSING:${item.segmentId}`);
      const journal = existsSync(join(item.runDir, "task.json"))
        ? JSON.parse(readFileSync(join(item.runDir, "task.json"), "utf8"))
        : {};
      return { ...item, journal };
    },
  );
  const replacementPaths = new Map(completed.map((item) => [item.segmentId, item.output]));
  const orderedPaths = plan.timeline_segments.map((segment, index) => {
    if (replacementPaths.has(segment.segment_id)) return replacementPaths.get(segment.segment_id);
    const artifact = [...(task.artifacts || [])]
      .reverse()
      .find((item) =>
        item.stage === "video_generation" &&
        (item.label === `正式视频分段 ${index + 1}` ||
          new RegExp(`^版本\\s*\\d+\\s*返工分段\\s*${index + 1}$`).test(item.label)),
      );
    if (!artifact?.path || !existsSync(artifact.path))
      throw afterSubmit(`RUNNINGHUB_H3_PRESERVED_SEGMENT_MISSING:${segment.segment_id}`);
    return artifact.path;
  });
  const stitched = stitchSegments(
    orderedPaths,
    plan.timeline_segments.map((segment) => Number(segment.target_duration_seconds)),
    join(taskDir, "09_video_generation", `runninghub_h3_full_sequence_v${String(version).padStart(3, "0")}`),
    env,
  );
  const points = completed
    .map((item) => item.journal.usage?.consumeCoins ?? item.journal.usage?.coins)
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number);
  return {
    status: "completed",
    summary: `已只替换第 ${plan.selected_segment_ids.map((id) => Number(id.slice(-2))).join("、")} 段并重新合成为版本 ${version}；所有旧版本保留。`,
    user_message: `选中的 ${completed.length} 个片段已各提交 1 次并返回，系统已自动重新合成版本 ${version}；所有旧版本和未选片段保持不变。`,
    generation_kind: "full_sequence",
    rework_version: version,
    provider: "runninghub_h3_multiref",
    model_key: "minimax-h3-multiref-owned-clean",
    duration_seconds: plan.timeline_segments.reduce((sum, segment) => sum + Number(segment.target_duration_seconds), 0),
    points_used: points.length ? points.reduce((sum, value) => sum + value, 0) : null,
    points_receipt_status: points.length === completed.length ? "returned_by_runninghub" : "partially_or_not_returned_by_runninghub",
    remote_task_ids: completed.map((item) => item.journal.taskId).filter(Boolean),
    external_request_started: true,
    automatic_retry: false,
    segment_count: orderedPaths.length,
    replaced_segment_ids: plan.selected_segment_ids,
    preserved_segment_ids: plan.preserved_segment_ids,
    artifacts: [
      { label: `版本 ${version} 正式视频`, path: stitched, published: false },
      ...completed.map((item) => ({
        label: `版本 ${version} 返工分段 ${Number(item.segmentId.slice(-2))}`,
        path: item.output,
        published: false,
      })),
    ],
  };
}

function prepareReworkCard({ card, cardPath, taskDir, env, version }) {
  const segmentId = card.original_segment_id;
  const runDir = join(taskDir, "09_video_generation", `runninghub_h3_rework_${segmentId}_v${String(version).padStart(3, "0")}`);
  mkdirSync(runDir, { recursive: true });
  const promptPath = join(runDir, "model_prompt.txt");
  if (!String(card.prompt_summary || "").trim()) throw beforeSubmit(`RUNNINGHUB_H3_REWORK_PROMPT_MISSING:${segmentId}`);
  const references = (card.upload_order_plan || []).map((asset) => ({
    ...asset,
    path: resolveReworkPath(asset.path, taskDir, dirname(cardPath)),
  }));
  if (
    references.length < 1 ||
    references.length > 3 ||
    references.some((item) => !item.path || !existsSync(item.path) || /红线|网格|安全提交版/.test(`${item.alias || ""}${item.role || ""}${item.path || ""}`))
  )
    throw beforeSubmit(`RUNNINGHUB_H3_REWORK_REFERENCE_INVALID:${segmentId}`);
  const compiled = compileRunningHubH3ReferencePrompt({ sourceText: card.prompt_summary, references, runDir, env });
  writeFileSync(promptPath, `${compiled.prompt}\n`);
  writeFileSync(join(runDir, "provider_binding_receipt.json"), `${JSON.stringify(compiled, null, 2)}\n`);
  const preflightReceipt = join(runDir, "runninghub_preflight.json");
  const output = join(runDir, "result.mp4");
  const common = [
    "--prompt-file", promptPath,
    "--duration", String(normalizeRunningHubDuration(card.duration_seconds)),
    "--quality-profile", card.quality_profile || "high",
    "--aspect-ratio", card.aspect_ratio || "9:16",
    "--budget-limit", String(Number(env.WORKBENCH_RUNNINGHUB_BUDGET_COINS || 200)),
    "--preflight-receipt", preflightReceipt,
  ];
  references.forEach((item, index) => {
    common.push(
      `--ref${index + 1}`,
      item.path,
      `--ref${index + 1}-role`,
      String(item.role || item.alias || `参考图${index + 1}`).slice(0, 80),
    );
  });
  return { card, segmentId, common, runDir, output };
}

function resolveReworkPath(path, taskDir, cardDir) {
  if (!path) return null;
  if (isAbsolute(path)) return path;
  if (String(path).startsWith("run/")) return join(dirname(taskDir), path);
  return join(cardDir, path);
}

function prepareCard({ card, index, task, taskDir, preview, env }) {
  const references = (card.references || []).filter((item) => item.upload_to_video_model !== false);
  if (references.length > 3 || references.some((item) => /红线|网格|安全提交版/.test(`${item.alias || ""}${item.role || ""}${item.path || ""}`))) {
    throw beforeSubmit("RUNNINGHUB_H3_CLEAR_REFERENCE_CONTRACT_FAILED");
  }
  const fullSequence = preview.generation_kind === "full_sequence";
  const attempt = fullSequence ? task.full_video_generation_attempt_count : task.video_generation_attempt_count;
  const runDir = join(taskDir, "09_video_generation", `runninghub_h3_${fullSequence ? `segment_${String(index + 1).padStart(2, "0")}` : "smoke_test"}_run${String(attempt || 1).padStart(3, "0")}`);
  mkdirSync(runDir, { recursive: true });
  const promptPath = materializeRunningHubPrompt(card, runDir, references, env);
  const preflightReceipt = join(runDir, "runninghub_preflight.json");
  const output = join(runDir, "result.mp4");
  const common = [
    "--prompt-file", promptPath,
    "--duration", String(normalizeRunningHubDuration(card.duration_seconds || preview.duration_seconds)),
    "--quality-profile", task.generation_model_snapshot?.quality_profile || task.generation_quality_profile || "high",
    "--aspect-ratio", card.aspect_ratio || preview.aspect_ratio || "9:16",
    "--budget-limit", String(Number(env.WORKBENCH_RUNNINGHUB_BUDGET_COINS || 200)),
    "--preflight-receipt", preflightReceipt,
  ];
  references.forEach((item, index) => {
    const path = resolvePath(item.path, dirname(card.taskCardsPath));
    if (!path || !existsSync(path)) throw beforeSubmit(`RUNNINGHUB_H3_REFERENCE_MISSING:${index + 1}`);
    common.push(`--ref${index + 1}`, path, `--ref${index + 1}-role`, String(item.role || item.control_scope || item.asset_role || `参考图${index + 1}`).slice(0, 80));
  });
  return { card, index, common, runDir, output };
}

export function materializeRunningHubPrompt(card, runDir, references = null, env = process.env) {
  const declaredPromptPath = resolvePath(
    card.model_prompt_path
      || card.model_prompt_file
      || card.prompt?.model_prompt_file
      || card.prompt?.compiled_prompt_path
      || card.prompt?.source_prompt_path,
    dirname(card.taskCardsPath),
  );
  const inlinePrompt = String(card.model_prompt || card.prompt?.model_prompt || "").trim();
  const sourceText = declaredPromptPath && existsSync(declaredPromptPath)
    ? readFileSync(declaredPromptPath, "utf8").trim()
    : inlinePrompt;
  const promptPath = sourceText ? join(runDir, "model_prompt.txt") : null;
  if (declaredPromptPath && !existsSync(declaredPromptPath)) throw beforeSubmit("RUNNINGHUB_H3_PROMPT_MISSING");
  if (!promptPath) throw beforeSubmit("RUNNINGHUB_H3_PROMPT_MISSING");
  if (Array.isArray(references) && references.length) {
    const compiled = /@图片\d+/.test(sourceText)
      ? validateProviderCompiledPrompt({ sourceText, references })
      : compileRunningHubH3ReferencePrompt({ sourceText, references, runDir, env });
    writeFileSync(promptPath, `${compiled.prompt}\n`);
    writeFileSync(join(runDir, "provider_binding_receipt.json"), `${JSON.stringify(compiled, null, 2)}\n`);
  } else {
    writeFileSync(promptPath, `${sourceText}\n`);
  }
  return promptPath;
}

export function validateProviderCompiledPrompt({ sourceText, references }) {
  const prompt = String(sourceText || "").trim();
  const slotNumbers = [...new Set([...prompt.matchAll(/@图片(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  const expected = references.map((_, index) => index + 1);
  const businessAliases = references
    .map((item) => item.exact_alias || item.business_alias || item.alias)
    .filter(Boolean);
  if (
    slotNumbers.length !== expected.length ||
    slotNumbers.some((value, index) => value !== expected[index]) ||
    businessAliases.some((alias) => alias !== `@图片${businessAliases.indexOf(alias) + 1}` && prompt.includes(alias))
  ) throw beforeSubmit("RUNNINGHUB_H3_COMPILED_PROMPT_BINDING_INVALID");
  const bindings = references.map((item, index) => ({
    business_alias: item.exact_alias || item.business_alias || item.alias || `参考图${index + 1}`,
    provider_alias: `@图片${index + 1}`,
    role: item.role || item.control_scope || item.asset_role || "reference",
    path: item.path || "",
  }));
  return {
    prompt,
    bindings,
    validation: { status: "pass", source_mode: "provider_compiled" },
    binding_fingerprint: createHash("sha256").update(JSON.stringify(bindings)).digest("hex"),
  };
}

export function compileRunningHubH3ReferencePrompt({ sourceText, references, runDir, env = process.env }) {
  if (!Array.isArray(references) || references.length < 1 || references.length > 3)
    throw beforeSubmit("RUNNINGHUB_H3_REFERENCE_COUNT_INVALID");
  const sourcePath = join(runDir, "model_prompt.model-independent.txt");
  writeFileSync(sourcePath, `${String(sourceText || "").trim()}\n`);
  const assets = references.map((item) => ({
    exact_alias: item.exact_alias || item.business_alias || item.alias,
    role: item.role || item.control_scope || item.asset_role,
    path: item.path || "",
  }));
  const compiler = env.WORKBENCH_H3_PROMPT_COMPILER || skillFile("aigc-video-prompt-codex", "scripts/provider_prompt_compiler.py", env);
  const result = spawnSync(env.WORKBENCH_PYTHON || "python3", [
    compiler,
    "h3-multiref",
    "--body-file", sourcePath,
    "--assets-json", JSON.stringify(assets),
    "--json",
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw beforeSubmit(`RUNNINGHUB_H3_PROMPT_COMPILATION_FAILED:${String(result.stderr || result.stdout).trim().slice(0, 300)}`);
  let payload;
  try { payload = JSON.parse(result.stdout); }
  catch { throw beforeSubmit("RUNNINGHUB_H3_PROMPT_COMPILATION_RECEIPT_INVALID"); }
  if (payload.validation?.status !== "pass" || payload.bindings?.length !== references.length)
    throw beforeSubmit("RUNNINGHUB_H3_PROMPT_BINDING_CONTRACT_FAILED");
  return payload;
}

export function normalizeRunningHubDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 15)
    throw beforeSubmit("RUNNINGHUB_H3_DURATION_INVALID");
  return Math.ceil(duration);
}

export function loadTaskCards(packPath) {
  if (!packPath || !existsSync(packPath)) throw beforeSubmit("RUNNINGHUB_H3_TASK_PACK_MISSING");
  const packDir = statSync(packPath).isDirectory() ? packPath : dirname(packPath);
  const taskCardsPath = statSync(packPath).isFile() && packPath.endsWith(".json") ? packPath : join(packDir, "generation_tasks.json");
  if (!existsSync(taskCardsPath)) throw beforeSubmit("RUNNINGHUB_H3_TASK_CARDS_MISSING");
  const pack = JSON.parse(readFileSync(taskCardsPath, "utf8"));
  const cards = pack.task_cards || pack.generation_tasks || pack.tasks;
  if (!Array.isArray(cards) || !cards.length) throw beforeSubmit("RUNNINGHUB_H3_TASK_CARD_MISSING");
  const manifestPath = join(packDir, "asset_binding_manifest.json");
  const assetManifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : Array.isArray(pack.asset_binding_manifest)
      ? { assets: pack.asset_binding_manifest }
      : pack.asset_binding_manifest || null;
  return cards.map((card) => ({
    ...card,
    references: resolveRunningHubReferences(card, assetManifest),
    taskCardsPath,
  }));
}

export function resolveRunningHubReferences(card, assetManifest) {
  const assets = new Map();
  for (const item of assetManifest?.assets || []) {
    if (item.asset_id) assets.set(item.asset_id, item);
    if (item.alias) assets.set(item.alias, item);
  }
  return (card.references || []).map((reference) => {
    const fromManifest = typeof reference === "string";
    const asset = fromManifest ? assets.get(reference) : reference;
    const approved = !fromManifest || /^approved(?:_|$)/.test(String(asset?.status || ""));
    if (!asset?.path || !approved || asset.upload_to_video_model === false || asset.upload_allowed === false) {
      throw beforeSubmit("RUNNINGHUB_H3_REFERENCE_MANIFEST_INVALID");
    }
    if (Array.isArray(asset.segments) && card.task_id && !asset.segments.includes(card.task_id)) {
      throw beforeSubmit("RUNNINGHUB_H3_REFERENCE_SEGMENT_MISMATCH");
    }
    if (asset.sha256 && existsSync(asset.path)) {
      const actual = createHash("sha256").update(readFileSync(asset.path)).digest("hex");
      if (actual !== asset.sha256) throw beforeSubmit("RUNNINGHUB_H3_REFERENCE_HASH_MISMATCH");
    }
    return asset;
  });
}

async function mapWithConcurrency(items, concurrency, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await handler(items[index], index);
    }
  }));
  return results;
}

export function stitchSegments(paths, trimDurations, outputDir, env, outputName = "result.mp4") {
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, outputName);
  const command = configuredBinary("WORKBENCH_FFMPEG", "ffmpeg", env);
  const filters = paths.flatMap((_, index) => [
    `[${index}:v]trim=duration=${trimDurations[index]},setpts=PTS-STARTPTS[v${index}]`,
    `[${index}:a]atrim=duration=${trimDurations[index]},asetpts=PTS-STARTPTS[a${index}]`,
  ]);
  const concatInputs = paths.map((_, index) => `[v${index}][a${index}]`).join("");
  filters.push(`${concatInputs}concat=n=${paths.length}:v=1:a=1[v][a]`);
  const result = spawnSync(command, [
    "-y",
    "-loglevel", "error",
    "-nostats",
    ...paths.flatMap((path) => ["-i", path]),
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", "fast",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    output,
  ], { encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0 || !existsSync(output))
    throw afterSubmit(
      result.stderr?.trim() ||
        result.error?.message ||
        `RUNNINGHUB_H3_STITCH_FAILED:${result.status ?? "no_status"}`,
    );
  return output;
}

function hasCompletedRunningHubResult(item) {
  if (!existsSync(item.output)) return false;
  const journalPath = join(item.runDir, "task.json");
  if (!existsSync(journalPath)) return false;
  try {
    return JSON.parse(readFileSync(journalPath, "utf8")).status === "SUCCESS";
  } catch {
    return false;
  }
}

function resolvePath(path, base) {
  return path ? (isAbsolute(path) ? path : join(base, path)) : null;
}

function runProcess(command, args, env, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(afterSubmit("RUNNINGHUB_H3_TIMEOUT")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(beforeSubmit(error.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject((/预检|余额|预算|工作流|素材|参考图|提示词/.test(stderr) ? beforeSubmit : afterSubmit)(stderr.trim() || `RUNNINGHUB_H3_EXIT_${code}`));
    });
  });
}

function beforeSubmit(message) {
  const error = new Error(message);
  error.external_request_started = false;
  return error;
}

function afterSubmit(message) {
  const error = new Error(message);
  error.external_request_started = true;
  return error;
}
