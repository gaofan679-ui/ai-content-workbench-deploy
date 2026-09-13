import { requireTalkingConfiguration } from "./talking-configuration.mjs";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  artifactToolFile,
  configuredBinary,
  currentInstalledSkillFile,
} from "./portable-paths.mjs";

const script = currentInstalledSkillFile(
  "talking-head-video-workflow",
  "scripts/runninghub_talking_head.py",
);
const h3FixedCameraLongformRunner = currentInstalledSkillFile(
  "talking-head-video-workflow",
  "scripts/h3_fixed_camera_longform.py",
);
const nativeCompositionAnchorRunner = fileURLToPath(
  new URL("./native-composition-anchor-runner.py", import.meta.url),
);
const nativeCompositionFirstLastRunner = fileURLToPath(
  new URL("./native-composition-first-last-runner.py", import.meta.url),
);
const boutiqueDualAnchorRunner = fileURLToPath(
  new URL("./boutique-dual-anchor-runner.py", import.meta.url),
);
const boutiqueStaticCameraReferenceRunner = fileURLToPath(
  new URL("./boutique-static-camera-reference-runner.py", import.meta.url),
);
const boutiqueStructuredCameraRunner = fileURLToPath(
  new URL("./boutique-structured-camera-runner.py", import.meta.url),
);
const providerPromptCompiler = currentInstalledSkillFile(
  "aigc-video-prompt-codex",
  "scripts/provider_prompt_compiler.py",
);
const adapter = artifactToolFile("skill_artifact_adapter.py");
const python = configuredBinary("WORKBENCH_PYTHON", "python3");
const ffmpeg = configuredBinary("WORKBENCH_FFMPEG", "ffmpeg");
const ffprobe = configuredBinary("WORKBENCH_FFPROBE", "ffprobe");
const bundledBoutiqueSeamEngine = fileURLToPath(
  new URL(
    process.platform === "darwin" && process.arch === "arm64"
      ? "./bin/darwin-arm64/aicw-media-engine"
      : "./bin/unsupported/aicw-media-engine",
    import.meta.url,
  ),
);
const standardLowDirectorPrompt =
  "保持同一人物、服装、发型、配饰、背景和构图。人物面对镜头自然说话，神态放松，像在与镜头后的熟人交流。口型、停顿、呼吸和细微表情跟随输入音频；只保留自然眨眼、轻微眼神变化、极小幅头肩和身体呼吸，不安排重复点头、周期性摇头、夸张表情或额外剧情动作。开头与结尾都保持稳定、放松的中性姿态，方便与前后片段自然衔接。镜头稳定，无字幕、无新增物体。";
const nativeDuration = 10;
const boutiqueCameraExperiments = new Set([
  "static_reference_v0_1",
  "structured_prompt_v0_1",
  "structured_prompt_v0_2",
  "structured_prompt_v0_3",
  "structured_reference_v0_2",
  "independent_clean_parallel_v1",
]);
const defaultBoutiqueFixedCameraExperiment = "independent_clean_parallel_v1";
const boutiqueFixedCameraEditingProfile = Object.freeze({
  id: "h3_fixed_camera_audio_handles_v2",
  frame_rate: 24,
  handle_frames: 10,
  preferred_minimum_seconds: 5,
  preferred_content_seconds: 7.5,
  maximum_content_frames: 220,
  provider_maximum_seconds: 10,
  generation_seed: 102770755917561,
});
const h3FixedCameraLongformRuns = new Set();

export function isH3FixedCameraLongformCandidate(job) {
  return (
    job?.mode === "boutique" &&
    job?.camera_continuity === "strict_locked" &&
    job?.boutique_camera_experiment === "independent_clean_parallel_v1" &&
    Number(job?.measured_duration || 0) > 20
  );
}

export function usesIndependentSegmentLifecycle(job) {
  return Boolean(job?.is_long && !isH3FixedCameraLongformCandidate(job));
}

// RunningHub does not expose a hard pre-submit quote for this workflow. Keep
// the user-facing estimate aligned with observed completed tasks and include a
// small safety margin. First/last composition anchoring executes more graph
// work than the production route, especially at premium quality.
export function nativeVideoBudget(
  qualityMode = "clear",
  runStrategy = "economy",
  workflowVariant = "production",
) {
  const qualityBase = {
    daily: runStrategy === "stable" ? 140 : 70,
    clear: runStrategy === "stable" ? 180 : 90,
    premium: 350,
  }[qualityMode] || 180;
  const variantMultiplier =
    workflowVariant === "composition_first_last_v0_2"
      ? 1.85
      : workflowVariant === "composition_anchor_v0_1"
        ? 1.5
        : 1;
  return Math.ceil((qualityBase * variantMultiplier) / 10) * 10;
}
const talkingRouteContracts = {
  standard: {
    contract_version: 1,
    mode: "standard",
    backend_route: "InfiniteTalk_standard_speech",
    workflow_id: "2076223499961716737",
    speech_authority: "confirmed_audio",
    prompt_authority: "performance_only",
  },
  boutique: {
    contract_version: 1,
    mode: "boutique",
    backend_route: "MiniMax_H3_single_image_audio",
    workflow_id: "2086277269961666561",
    speech_authority: "confirmed_audio",
    prompt_authority: "performance_only",
  },
  native: {
    contract_version: 1,
    mode: "native",
    backend_route: "MiniMax_H3_native_prompt_speech",
    workflow_id: "2088598372285509633",
    speech_authority: "exact_dialogue_prompt",
    prompt_authority: "provider_compiler_only",
  },
};

export function talkingRouteContract(mode) {
  const contract = talkingRouteContracts[mode];
  if (!contract) throw new Error("当前口播模式没有登记可执行路线。");
  return { ...contract };
}

export function assertTalkingRouteContract(job) {
  const expected = talkingRouteContract(job.mode);
  const actual = job.execution_contract || expected;
  for (const key of [
    "mode",
    "backend_route",
    "workflow_id",
    "speech_authority",
    "prompt_authority",
  ]) {
    if (String(actual[key] || "") !== String(expected[key]))
      throw new Error(
        `口播模式与执行路线不一致（${talkingModeLabel(job.mode)}口播）；已在免费检查阶段停止，未上传、未付费。`,
      );
  }
  if (job.mode === "boutique" && !job.audio)
    throw new Error("精品口播缺少完整确认音频；已停止，未上传、未付费。");
  if (job.mode === "native" && (!job.script_file || !job.prompt))
    throw new Error("原生口播缺少逐字台词或正式提示词；已停止，未上传、未付费。");
  return expected;
}

function talkingModeLabel(mode) {
  return mode === "boutique" ? "精品" : mode === "native" ? "原生" : "标准";
}

export function compileNativePrompt(
  dialogue,
  voiceMode = "random",
  {
    performanceRequirement = "",
    segmentIndex = 0,
    segmentTotal = 1,
    targetRatio = "9:16",
    cameraContinuity = "strict_locked",
    subjectLayout = "single",
    activeSpeaker = "subject1",
    dialogueStyle = "standard",
  } = {},
) {
  const args = [
    providerPromptCompiler,
    "h3-native",
    "--dialogue",
    String(dialogue || ""),
    "--voice-mode",
    voiceMode,
    "--segment-index",
    String(segmentIndex),
    "--segment-total",
    String(segmentTotal),
    "--target-ratio",
    targetRatio,
    "--camera-continuity",
    cameraContinuity,
    "--subject-layout",
    subjectLayout,
    "--active-speaker",
    activeSpeaker,
    "--dialogue-style",
    dialogueStyle,
  ];
  if (String(performanceRequirement || "").trim())
    args.push("--performance-requirement", String(performanceRequirement));
  try {
    return execFileSync(python, args, { encoding: "utf8" }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").trim();
    throw new Error(
      `原生口播提示词编译未通过；已停止，未上传、未付费。${detail ? ` ${detail}` : ""}`,
    );
  }
}

export function compileBoutiquePrompt(cameraContinuity = "natural") {
  try {
    return execFileSync(python, [providerPromptCompiler, "h3-boutique", "--camera-continuity", cameraContinuity], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").trim();
    throw new Error(
      `精品口播提示词编译未通过；已停止，未上传、未付费。${detail ? ` ${detail}` : ""}`,
    );
  }
}

export function compileNativeVersionPrompt(job, dialogue) {
  return compileNativePrompt(dialogue, job.native_voice_mode || "random", {
    performanceRequirement: job.performance_requirement || "",
    segmentIndex: 0,
    segmentTotal: 1,
    targetRatio: normalizeTargetRatio(job.target_ratio),
    cameraContinuity: job.camera_continuity || "strict_locked",
  });
}

const nativeHanziPattern = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const nativeBoundaryPattern = /[，。！？；：、,.!?;:\n]/;
const nativeStrongBoundaryPattern = /[。！？.!?\n]/;

export function nativeLongScriptPlan(scriptText) {
  const text = String(scriptText || "").trim();
  const hanzi = [];
  for (let offset = 0; offset < text.length; offset += 1)
    if (nativeHanziPattern.test(text[offset])) hanzi.push(offset);
  const total = hanzi.length;
  if (total < 48)
    throw new Error(`原生口播稿共 ${total} 个汉字；每个10秒片段需要48～56个汉字，请补充内容后再试。`);
  const best = Array(total + 1).fill(null);
  best[0] = { score: 0, cuts: [] };
  for (let end = 48; end <= total; end += 1) {
    for (let size = 48; size <= 56; size += 1) {
      const start = end - size;
      if (!best[start]) continue;
      const stringEnd = end === total ? text.length : hanzi[end];
      const priorChar = text[stringEnd - 1] || "";
      if (end !== total && !nativeBoundaryPattern.test(priorChar)) continue;
      const boundaryPenalty =
        end === total || nativeStrongBoundaryPattern.test(priorChar) ? 0 : 20;
      const score = best[start].score + Math.abs(size - 52) + boundaryPenalty;
      if (!best[end] || score < best[end].score)
        best[end] = { score, cuts: [...best[start].cuts, end] };
    }
  }
  if (!best[total]) {
    const minSegments = Math.ceil(total / 56);
    const maxSegments = Math.floor(total / 48);
    const target = minSegments > maxSegments
      ? `当前总字数无法拆成每段48～56字；建议把全文调整到 ${minSegments * 48}～${minSegments * 56} 个汉字。`
      : "请在句末附近微调少量文字，让每段都能保留完整语义。";
    throw new Error(`原生口播稿共 ${total} 个汉字。${target}`);
  }
  const segments = [];
  let priorHanzi = 0;
  let priorOffset = 0;
  for (const cut of best[total].cuts) {
    const stringEnd = cut === total ? text.length : hanzi[cut];
    const dialogue = text.slice(priorOffset, stringEnd).trim();
    segments.push({ dialogue, hanzi_count: cut - priorHanzi });
    priorHanzi = cut;
    priorOffset = stringEnd;
  }
  return { total_hanzi: total, segments };
}

const nativeProjectedSpeechRates = {
  lively: { minimum: 4.8, target: 5.2, maximum: 5.6 },
  interview: { minimum: 3.6, target: 4.0, maximum: 4.5 },
};

function nativeProjectedDuration(hanziCount, minimumDuration, maximumDuration, speechRate) {
  const candidates = [];
  for (let duration = minimumDuration; duration <= maximumDuration; duration += 1) {
    if (
      hanziCount >= Math.ceil(speechRate.minimum * duration) &&
      hanziCount <= Math.floor(speechRate.maximum * duration)
    )
      candidates.push({
        duration,
        score: Math.abs(hanziCount / duration - speechRate.target),
      });
  }
  return candidates.sort((left, right) => left.score - right.score)[0]?.duration || null;
}

export function nativeAdaptiveScriptPlan(
  scriptText,
  { minimumDuration = 6, maximumDuration = 15, speechProfile = "lively" } = {},
) {
  if (
    !Number.isInteger(minimumDuration) ||
    !Number.isInteger(maximumDuration) ||
    minimumDuration < 1 ||
    maximumDuration < minimumDuration
  )
    throw new Error("原生口播自适应时长范围无效。");
  const speechRate = nativeProjectedSpeechRates[speechProfile];
  if (!speechRate) throw new Error("原生口播语速档无效。");
  const text = String(scriptText || "").trim();
  const boundaries = [{ offset: 0, hanzi: 0, strength: "start" }];
  let totalHanzi = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    const char = text[offset];
    if (nativeHanziPattern.test(char)) totalHanzi += 1;
    if (/[。！？.!?]/.test(char))
      boundaries.push({ offset: offset + 1, hanzi: totalHanzi, strength: "strong" });
    else if (/[，；、,;]/.test(char))
      boundaries.push({ offset: offset + 1, hanzi: totalHanzi, strength: "weak" });
  }
  if (!text)
    throw new Error("请先填写原生口播要说的逐字台词。");
  if (boundaries.at(-1)?.offset !== text.length)
    boundaries.push({ offset: text.length, hanzi: totalHanzi, strength: "end" });
  const minimumHanzi = Math.ceil(speechRate.minimum * minimumDuration);
  if (totalHanzi < minimumHanzi)
    throw new Error(
      `当前台词约少于${minimumDuration}秒的验证候选范围；请先补充完整表达，不用语气词或重复内容凑时长。`,
    );
  const best = Array(boundaries.length).fill(null);
  best[0] = { score: 0, cuts: [] };
  for (let end = 1; end < boundaries.length; end += 1) {
    for (let start = 0; start < end; start += 1) {
      if (!best[start]) continue;
      const hanziCount = boundaries[end].hanzi - boundaries[start].hanzi;
      const duration = nativeProjectedDuration(
        hanziCount,
        minimumDuration,
        maximumDuration,
        speechRate,
      );
      if (!duration) continue;
      const ratePenalty = Math.abs(
        hanziCount / duration - speechRate.target,
      );
      const boundaryPenalty = boundaries[end].strength === "weak" ? 12 : 0;
      const score = best[start].score + 100 + boundaryPenalty + ratePenalty;
      if (!best[end] || score < best[end].score)
        best[end] = {
          score,
          cuts: [...best[start].cuts, { start, end, duration }],
        };
    }
  }
  const final = best[boundaries.length - 1];
  if (!final)
    throw new Error(
      `当前台词无法在不改字的前提下规划为${minimumDuration}～${maximumDuration}秒的完整语义片段；请在完整句处微调内容。`,
    );
  const segments = final.cuts.map(({ start, end, duration }, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    dialogue: text.slice(boundaries[start].offset, boundaries[end].offset).trim(),
    hanzi_count: boundaries[end].hanzi - boundaries[start].hanzi,
    projected_duration: duration,
    duration_evidence:
      duration === nativeDuration
        ? "verified_10s"
        : "projected_requires_paid_validation",
    boundary_source:
      boundaries[end].strength === "weak" ? "semantic_weak_pause" : "complete_sentence",
  }));
  return {
    contract_version: 1,
    status: "preview_only",
    total_hanzi: totalHanzi,
    total_projected_duration: segments.reduce(
      (sum, segment) => sum + segment.projected_duration,
      0,
    ),
    minimum_duration: minimumDuration,
    maximum_duration: maximumDuration,
    speech_profile: speechProfile,
    speech_rate_range: { ...speechRate },
    segments,
  };
}

const nativeConversationReplyPattern =
  /^(?:嗯|对(?:，|。|！|；|\s|我|这|你)|是的|没错|确实|其实|所以|那(?:么|也|就|这样)?|这说明|也就是说|换句话说|你这么一说|听你这么说|我觉得|我倒觉得|我也觉得|不一定|也不是|怎么说呢|你刚才说|你说的|刚才提到|这个问题|这一点|听起来|可以这么理解)/;

function nativeConversationClauses(dialogue) {
  return String(dialogue || "")
    .split(/[，。！？；,.!?;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function nativeTwoSpeakerScriptPlan(
  scriptText,
  { dialogueStyle = "natural_interview" } = {},
) {
  if (!["natural_interview", "structured_discussion"].includes(dialogueStyle))
    throw new Error("双人对话感觉无效，请重新选择。");
  const text = String(scriptText || "").trim();
  const sourceLines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (sourceLines.length < 3)
    throw new Error("双人对话测试至少需要3轮发言，每行只写一位人物的台词。");
  const segments = sourceLines.map((line, index) => {
    const match = line.match(/^(左|右)[：:]\s*(.+)$/);
    if (!match)
      throw new Error(`第${index + 1}行请以“左：”或“右：”开头。`);
    const side = match[1] === "左" ? "left" : "right";
    const dialogue = match[2].trim();
    const hanziCount = [...dialogue].filter((char) => nativeHanziPattern.test(char)).length;
    if (hanziCount < 48 || hanziCount > 56)
      throw new Error(`第${index + 1}轮有${hanziCount}个汉字；每个10秒片段需要48～56个汉字。`);
    return {
      dialogue,
      hanzi_count: hanziCount,
      speaker_side: side,
      active_speaker: side === "left" ? "subject1" : "subject2",
      native_voice_mode: "reference",
    };
  });
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].speaker_side === segments[index - 1].speaker_side)
      throw new Error(
        `第${index + 1}轮仍由同一侧人物发言；双人对话请严格按左右人物交替逐行填写。`,
      );
  }
  if (!segments.some((item) => item.speaker_side === "left") ||
      !segments.some((item) => item.speaker_side === "right"))
    throw new Error("双人对话必须让左侧和右侧人物都至少发言一次。")
  if (dialogueStyle === "natural_interview") {
    if (!segments.some((item) => /[？?]/.test(item.dialogue)))
      throw new Error(
        "自然访谈至少需要一轮真实提问；如果每轮都是完整观点陈述，请改选“观点对谈”。",
      );
    for (let index = 0; index < segments.length; index += 1) {
      const clauses = nativeConversationClauses(segments[index].dialogue);
      if (clauses.length < 3 || !clauses.some((clause) =>
        [...clause].filter((char) => nativeHanziPattern.test(char)).length <= 12,
      ))
        throw new Error(
          `第${index + 1}轮更像一整段书面稿。自然访谈请拆成有长有短的口语句；如果本来就是完整观点发言，请改选“观点对谈”。`,
        );
      if (index > 0 && !nativeConversationReplyPattern.test(segments[index].dialogue))
        throw new Error(
          `第${index + 1}轮没有先接住上一句话。自然访谈请先自然回应，再表达一个意思；如果本来就是完整观点发言，请改选“观点对谈”。`,
        );
    }
  }
  return {
    total_hanzi: segments.reduce((sum, item) => sum + item.hanzi_count, 0),
    dialogue_style: dialogueStyle,
    conversation_contract:
      dialogueStyle === "natural_interview"
        ? "alternating_reply_first_spoken_clauses"
        : "alternating_complete_viewpoints",
    segments,
  };
}

export function nativeAdaptiveTwoSpeakerScriptPlan(
  scriptText,
  {
    dialogueStyle = "natural_interview",
    minimumDuration = 6,
    maximumDuration = 15,
  } = {},
) {
  if (!["natural_interview", "structured_discussion"].includes(dialogueStyle))
    throw new Error("双人对话感觉无效，请重新选择。");
  const sourceLines = String(scriptText || "")
    .trim()
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (sourceLines.length < 1)
    throw new Error("请至少填写1轮双人对话，每行只写一位人物的台词。");
  const turns = sourceLines.map((line, index) => {
    const match = line.match(/^(左|右)[：:]\s*(.+)$/);
    if (!match)
      throw new Error(`第${index + 1}行请以“左：”或“右：”开头。`);
    return {
      dialogue: match[2].trim(),
      speaker_side: match[1] === "左" ? "left" : "right",
      active_speaker: match[1] === "左" ? "subject1" : "subject2",
    };
  });
  for (let index = 1; index < turns.length; index += 1) {
    if (turns[index].speaker_side === turns[index - 1].speaker_side)
      throw new Error(
        `第${index + 1}轮仍由同一侧人物接话；请按真实对话轮次交替填写。`,
      );
  }
  if (dialogueStyle === "natural_interview") {
    if (!turns.some((item) => /[？?]/.test(item.dialogue)))
      throw new Error("自然访谈至少需要一轮真实提问。");
    for (let index = 0; index < turns.length; index += 1) {
      const clauses = nativeConversationClauses(turns[index].dialogue);
      if (clauses.length < 2)
        throw new Error(`第${index + 1}轮更像单句指令，不像自然访谈表达。`);
      if (index > 0 && !nativeConversationReplyPattern.test(turns[index].dialogue))
        throw new Error(`第${index + 1}轮没有先接住上一句话。`);
    }
  }
  const segments = turns.flatMap((turn, turnIndex) =>
    nativeAdaptiveScriptPlan(turn.dialogue, {
      minimumDuration,
      maximumDuration,
      speechProfile: dialogueStyle === "natural_interview" ? "interview" : "lively",
    }).segments.map((segment, partIndex) => ({
      ...segment,
      id: "",
      turn_index: turnIndex,
      turn_part_index: partIndex,
      speaker_side: turn.speaker_side,
      active_speaker: turn.active_speaker,
      native_voice_mode: "reference",
    })),
  ).map((segment, index) => ({
    ...segment,
    id: `S${String(index + 1).padStart(2, "0")}`,
  }));
  return {
    contract_version: 1,
    status: "preview_only",
    dialogue_style: dialogueStyle,
    preview_scope: turns.length === 1 ? "single_turn_preview" : "full_conversation",
    total_projected_duration: segments.reduce(
      (sum, segment) => sum + segment.projected_duration,
      0,
    ),
    turns,
    segments,
  };
}

function jsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
function safeExt(name, fallback) {
  const ext = extname(basename(name)).toLowerCase();
  return /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : fallback;
}
function normalizeTargetRatio(value) {
  return ["9:16", "3:4", "4:3", "16:9"].includes(value) ? value : "9:16";
}
async function assertMasterOrientation(imageBuffer, targetRatio) {
  const { width, height } = await sharp(imageBuffer).metadata();
  if (!width || !height) throw new Error("无法读取人物母版图尺寸，请更换图片后重试。");
  const [ratioWidth, ratioHeight] = targetRatio.split(":").map(Number);
  const expected = ratioWidth / ratioHeight;
  if (Math.abs(width / height - expected) / expected > 0.08)
    throw new Error(
      `你选择了 ${targetRatio} 画幅，请上传接近 ${targetRatio} 比例的人物母版图。`,
    );
}
function approvedMasterSampleEvidence(root, imageBuffer) {
  if (!existsSync(root)) return null;
  const incoming = createHash("sha256").update(imageBuffer).digest("hex");
  for (const name of readdirSync(root).filter((item) => /^[a-f0-9-]{36}\.json$/.test(item))) {
    const prior = jsonFile(join(root, name));
    const priorQualified =
      prior.mode === "boutique" &&
      (prior.sample?.qc_status === "approved_sample" ||
        (prior.state === "approved" && Number(prior.measured_duration || prior.duration || 0) <= 8));
    if (!priorQualified || !prior.image || !existsSync(prior.image)) continue;
    const priorHash = createHash("sha256").update(readFileSync(prior.image)).digest("hex");
    if (priorHash !== incoming) continue;
    const output = [
      prior.sample?.output,
      prior.published_output,
      prior.final_output,
      prior.output,
    ].find((candidate) => candidate && existsSync(candidate));
    if (!output) continue;
    return {
      job_id: prior.id,
      output,
      output_sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
    };
  }
  return null;
}
function approvedMasterSampleStatus(root, imageBuffer) {
  return approvedMasterSampleEvidence(root, imageBuffer) ? "passed" : "new";
}
function durationOf(path) {
  return Number(
    execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        path,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
}

export function longSegmentPlan(mode, measured, pauseCenters = []) {
  if (mode === "boutique") return boutiqueLongSegmentPlan(measured, pauseCenters);
  const ceiling = 40;
  if (measured <= ceiling) return [];
  const count = Math.ceil(measured / ceiling);
  const durations = Array.from({ length: count }, () => measured / count);
  let cursor = 0;
  const raw = durations.map((actual, index) => {
    const start = cursor;
    const end = index === durations.length - 1 ? measured : start + actual;
    cursor = end;
    return {
      id: `S${String(index + 1).padStart(2, "0")}`,
      index,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      content_duration: Number((end - start).toFixed(3)),
      generation_duration:
        mode === "boutique"
          ? Math.min(15, Math.max(6, Math.ceil(end - start)))
          : Number((end - start).toFixed(2)),
      state: index === 0 ? "sample_pending" : "pending",
      qc_status: "pending",
      boundary_source: index === durations.length - 1 ? "audio_end" : "balanced_fallback",
    };
  });
  if (!pauseCenters.length) return raw;
  const min = mode === "boutique" ? 6 : 20;
  const max = mode === "boutique" ? 15 : 40;
  const naturalPoints = [
    0,
    ...[...new Set(pauseCenters)]
      .filter((point) => point >= min && measured - point >= min)
      .sort((left, right) => left - right),
    measured,
  ];
  const target = measured / Math.ceil(measured / max);
  const best = Array(naturalPoints.length).fill(null);
  best[0] = { count: 0, score: 0, cuts: [0] };
  for (let endIndex = 1; endIndex < naturalPoints.length; endIndex += 1) {
    for (let startIndex = 0; startIndex < endIndex; startIndex += 1) {
      if (!best[startIndex]) continue;
      const duration = naturalPoints[endIndex] - naturalPoints[startIndex];
      if (duration < min || duration > max) continue;
      const candidate = {
        count: best[startIndex].count + 1,
        score: best[startIndex].score + Math.abs(duration - target),
        cuts: [...best[startIndex].cuts, naturalPoints[endIndex]],
      };
      const existing = best[endIndex];
      if (
        !existing ||
        candidate.count < existing.count ||
        (candidate.count === existing.count && candidate.score < existing.score)
      )
        best[endIndex] = candidate;
    }
  }
  const naturalPlan = best.at(-1);
  if (!naturalPlan) return raw;
  return naturalPlan.cuts.slice(0, -1).map((start, index) => {
    const end = naturalPlan.cuts[index + 1];
    const content = end - start;
    return {
      id: `S${String(index + 1).padStart(2, "0")}`,
      index,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      content_duration: Number(content.toFixed(3)),
      generation_duration:
        mode === "boutique" ? Math.min(15, Math.ceil(content)) : Number(content.toFixed(2)),
      state: index === 0 ? "sample_pending" : "pending",
      qc_status: "pending",
      boundary_source: index === naturalPlan.cuts.length - 2 ? "audio_end" : "natural_pause",
    };
  });
}

function boutiqueLongSegmentPlan(measured, pauseCenters = []) {
  const profile = boutiqueFixedCameraEditingProfile;
  const fps = profile.frame_rate;
  const minimum = profile.preferred_minimum_seconds;
  const maximum = profile.maximum_content_frames / fps;
  if (measured <= profile.provider_maximum_seconds) return [];

  const minimumCount = Math.ceil(measured / maximum);
  const target = measured / minimumCount;
  const snap = (value) => Math.round(Number(value) * fps) / fps;
  const naturalPoints = [...new Set(pauseCenters.map(snap))]
    .filter((point) => Number.isFinite(point) && point >= minimum && measured - point >= minimum);
  const balancedPoints = Array.from(
    { length: minimumCount },
    (_, index) => snap(((index + 1) * target)),
  ).filter((point) => point >= minimum && measured - point >= minimum);
  const preferredPoints = Array.from(
    { length: Math.floor(measured / profile.preferred_content_seconds) },
    (_, index) => snap((index + 1) * profile.preferred_content_seconds),
  ).filter((point) => point >= minimum && measured - point >= minimum);
  const points = [
    { time: 0, source: "audio_start" },
    ...naturalPoints.map((time) => ({ time, source: "natural_pause" })),
    ...preferredPoints.map((time) => ({ time, source: "balanced_fallback" })),
    ...balancedPoints.map((time) => ({ time, source: "balanced_fallback" })),
    { time: measured, source: "audio_end" },
  ]
    .sort((left, right) => left.time - right.time)
    .filter((point, index, all) => {
      const same = all.filter((candidate) => Math.abs(candidate.time - point.time) < 1 / fps / 2);
      if (same.length === 1) return true;
      const first = all.findIndex((candidate) => Math.abs(candidate.time - point.time) < 1 / fps / 2);
      if (index !== first) return false;
      if (same.some((candidate) => candidate.source === "natural_pause")) point.source = "natural_pause";
      return true;
    });

  const best = Array(points.length).fill(null);
  best[0] = { score: 0, count: 0, cuts: [0] };
  for (let endIndex = 1; endIndex < points.length; endIndex += 1) {
    for (let startIndex = 0; startIndex < endIndex; startIndex += 1) {
      const previous = best[startIndex];
      if (!previous || previous.count >= minimumCount + 1) continue;
      const duration = points[endIndex].time - points[startIndex].time;
      if (duration < minimum || duration > maximum + 0.001) continue;
      const syntheticPenalty = points[endIndex].source === "balanced_fallback" ? 120 : 0;
      const candidate = {
        count: previous.count + 1,
        score:
          previous.score +
          100 +
          syntheticPenalty +
          Math.abs(duration - profile.preferred_content_seconds),
        cuts: [...previous.cuts, endIndex],
      };
      if (!best[endIndex] || candidate.score < best[endIndex].score) best[endIndex] = candidate;
    }
  }

  const decorate = (cuts, boundarySources) => cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1];
    const handle = profile.handle_frames / fps;
    const inputStart = Math.max(0, start - handle);
    const inputEnd = Math.min(measured, end + handle);
    const inputDuration = inputEnd - inputStart;
    const generationDuration = Math.ceil(inputDuration - 0.000001);
    if (generationDuration > profile.provider_maximum_seconds)
      throw new Error("BOUTIQUE_GENERATION_DURATION_EXCEEDS_10_SECONDS");
    const startFrame = Math.round(start * fps);
    const endFrame = index === cuts.length - 2 ? Math.ceil(measured * fps) : Math.round(end * fps);
    return {
      id: `S${String(index + 1).padStart(2, "0")}`,
      index,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      content_duration: Number((end - start).toFixed(3)),
      content_frame_count: endFrame - startFrame,
      input_start: Number(inputStart.toFixed(3)),
      input_end: Number(inputEnd.toFixed(3)),
      input_duration: Number(inputDuration.toFixed(3)),
      trim_start: Number((start - inputStart).toFixed(3)),
      head_handle: Number((start - inputStart).toFixed(3)),
      tail_handle: Number((inputEnd - end).toFixed(3)),
      generation_duration: generationDuration,
      state: index === 0 ? "sample_pending" : "pending",
      qc_status: "pending",
      boundary_source: boundarySources[index],
    };
  });

  const final = best.at(-1);
  if (!final) {
    const cuts = Array.from({ length: minimumCount + 1 }, (_, index) =>
      index === minimumCount ? measured : snap(index * measured / minimumCount));
    return decorate(cuts, [
      ...Array(minimumCount - 1).fill("balanced_fallback"),
      "audio_end",
    ]);
  }
  const selected = final.cuts.map((pointIndex) => points[pointIndex]);
  return decorate(
    selected.map((point) => point.time),
    selected.slice(1).map((point) => point.source),
  );
}

function detectPauseCenters(audio) {
  const result = spawnSync(
    ffmpeg,
    ["-hide_banner", "-i", audio, "-af", "silencedetect=noise=-38dB:d=0.18", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  const text = String(result.stderr || "");
  const centers = [];
  let start = null;
  for (const line of text.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (startMatch) start = Number(startMatch[1]);
    if (endMatch && start != null) {
      centers.push(Number(((start + Number(endMatch[1])) / 2).toFixed(3)));
      start = null;
    }
  }
  return centers;
}

function prepareLongSegments(job, fileSuffix = "") {
  if (!job.segments?.length) return job;
  for (const segment of job.segments) {
    const audio = join(job.process_dir, `${segment.id}_audio${fileSuffix}.wav`);
    const output = join(job.candidate_dir, `${segment.id}_口播片段${fileSuffix}.mp4`);
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-ss",
        String(segment.input_start ?? segment.start),
        "-t",
        String(segment.input_duration ?? segment.content_duration),
        "-i",
        job.original_audio,
        "-af",
        `apad=pad_dur=${Math.max(0, segment.generation_duration - (segment.input_duration ?? segment.content_duration)).toFixed(3)}`,
        "-t",
        String(segment.generation_duration),
        "-ar",
        "44100",
        "-ac",
        "1",
        audio,
      ],
      { stdio: "ignore" },
    );
    segment.audio = audio;
    segment.output = output;
    segment.estimated_rh_coins =
      job.mode === "boutique"
        ? boutiqueVideoBudget(segment.generation_duration, job.quality_mode)
        : standardVideoBudget(segment.generation_duration, job.quality_mode);
  }
  return job;
}

function prepareLongSample(job) {
  const sampleDuration = Math.min(8, Math.max(6, Math.floor(job.measured_duration)));
  const audio = join(job.process_dir, "master_sample_8s.wav");
  execFileSync(
    ffmpeg,
    ["-y", "-i", job.original_audio, "-t", String(sampleDuration), "-ar", "44100", "-ac", "1", audio],
    { stdio: "ignore" },
  );
  job.sample = {
    duration: sampleDuration,
    audio,
    output: join(job.candidate_dir, `${talkingModeLabel(job.mode)}口播_母版样片.mp4`),
    state: "pending",
    qc_status: "pending",
    estimated_rh_coins:
      job.mode === "boutique"
        ? boutiqueVideoBudget(sampleDuration, job.quality_mode)
        : standardVideoBudget(sampleDuration, job.quality_mode),
  };
  job.audio = job.sample.audio;
  job.output = job.sample.output;
  job.duration = job.sample.duration;
  job.budget_limit = job.sample.estimated_rh_coins;
}

function boutiqueSeamEnginePath() {
  return String(process.env.WORKBENCH_BOUTIQUE_SEAM_ENGINE || "").trim() || bundledBoutiqueSeamEngine;
}

export function optimizeBoutiqueSegmentCuts(segments, editingDir, enginePath = boutiqueSeamEnginePath()) {
  const planned = segments.map((segment) => ({
    id: segment.id,
    videoPath: segment.output,
    contentDuration: segment.content_duration,
    contentFrameCount: segment.content_frame_count,
    trimStart: segment.trim_start,
  }));
  const ready =
    planned.length > 1 &&
    planned.every(
      (segment) =>
        existsSync(segment.videoPath) &&
        Number.isInteger(segment.contentFrameCount) &&
        Number.isFinite(segment.trimStart),
    );
  if (!ready)
    return {
      segments,
      receipt: { applied: false, reason: "frame_aligned_segments_required", seams: [] },
    };

  mkdirSync(editingDir, { recursive: true });
  const plannedManifest = join(editingDir, "boutique_segments.planned.json");
  const adoptedManifest = join(editingDir, "boutique_segments.adopted.json");
  writeJson(plannedManifest, planned);
  if (!existsSync(enginePath)) {
    writeJson(adoptedManifest, planned);
    return {
      segments,
      receipt: {
        applied: false,
        reason: "face_analysis_engine_unavailable_fallback",
        seams: [],
        planned_manifest: plannedManifest,
        adopted_manifest: adoptedManifest,
      },
    };
  }
  try {
    const output = execFileSync(
      enginePath,
      ["optimize-boutique-cuts", plannedManifest, adoptedManifest],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    const receipt = JSON.parse(output.trim());
    const adopted = jsonFile(adoptedManifest);
    if (!Array.isArray(adopted) || adopted.length !== segments.length)
      throw new Error("BOUTIQUE_SEAM_ENGINE_INVALID_MANIFEST");
    return {
      segments: segments.map((segment, index) => ({
        ...segment,
        content_duration: Number(adopted[index].contentDuration),
        content_frame_count: Number(adopted[index].contentFrameCount),
        trim_start: Number(adopted[index].trimStart),
      })),
      receipt: {
        ...receipt,
        planned_manifest: plannedManifest,
        adopted_manifest: adoptedManifest,
      },
    };
  } catch (error) {
    writeJson(adoptedManifest, planned);
    return {
      segments,
      receipt: {
        applied: false,
        reason: "local_face_analysis_failed_fallback",
        message: String(error.message || error).slice(-1000),
        seams: [],
        planned_manifest: plannedManifest,
        adopted_manifest: adoptedManifest,
      },
    };
  }
}

const standardQualityRates = { daily: 4.7, clear: 5.1, premium: 20.5 };
const boutiqueQualityRates = { daily: 6.2, clear: 9.2, premium: 15.5 };
export function standardVideoBudget(duration, qualityMode = "daily") {
  const rate = standardQualityRates[qualityMode] || standardQualityRates.daily;
  const startupFloor =
    qualityMode === "premium" ? 110 : qualityMode === "clear" ? 90 : 70;
  // Keep the workbench budget exactly aligned with the formal executor:
  // first round the observed base cost, then apply the safety factor.
  return Math.max(startupFloor, Math.ceil(Math.ceil(duration * rate) * 1.2));
}
export function boutiqueVideoBudget(duration, qualityMode = "clear") {
  const rate = boutiqueQualityRates[qualityMode] || boutiqueQualityRates.clear;
  const startupFloor = qualityMode === "clear" ? 120 : 0;
  return Math.max(startupFloor, Math.ceil(Math.ceil(duration * rate) * 1.2));
}
export function normalizeTalkingHeadConcurrency(value, maximum = 3) {
  const requested = Number.parseInt(String(value || 1), 10);
  const allowed = [1, 3, 5].filter((item) => item <= maximum);
  return allowed.includes(requested) ? requested : 1;
}
export async function mapWithConcurrency(items, concurrency, handler) {
  const results = Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await handler(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// RunningHub's concurrency limit is account-wide, not project-wide. Keep one
// scheduler for every talking-head project in this runtime so two projects
// cannot independently fill the same account queue. A TASK_QUEUE_MAXED reply
// happens before a remote task is created and before coins are consumed; it is
// therefore a capacity wait, not a generation retry.
const talkingHeadProviderConcurrency = 3;
let activeTalkingHeadProviderRuns = 0;
const talkingHeadProviderWaiters = [];

async function acquireTalkingHeadProviderSlot() {
  if (activeTalkingHeadProviderRuns < talkingHeadProviderConcurrency) {
    activeTalkingHeadProviderRuns += 1;
    return () => releaseTalkingHeadProviderSlot();
  }
  await new Promise((resolve) => talkingHeadProviderWaiters.push(resolve));
  activeTalkingHeadProviderRuns += 1;
  return () => releaseTalkingHeadProviderSlot();
}

function releaseTalkingHeadProviderSlot() {
  activeTalkingHeadProviderRuns = Math.max(0, activeTalkingHeadProviderRuns - 1);
  talkingHeadProviderWaiters.shift()?.();
}

export function isTalkingHeadCapacityWait(error) {
  return /TASK_QUEUE_MAXED/.test(String(error?.message || error || ""));
}

async function runProviderCommandWithCapacityWait(command, onCapacityWait = () => {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    const release = await acquireTalkingHeadProviderSlot();
    try {
      return await execFilePromise("python3", command);
    } catch (error) {
      if (!isTalkingHeadCapacityWait(error)) throw error;
      onCapacityWait();
    } finally {
      release();
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error("平台通道持续繁忙超过30分钟；本次没有提交，也没有扣费，请稍后继续。");
}
function adapterPrepare(taskId, projectName) {
  const raw = execFileSync(
    "python3",
    [
      adapter,
      "prepare",
      "--skill",
      "talking-head-video-workflow",
      "--task-id",
      taskId,
      "--project-name",
      projectName,
      "--intent",
      "process",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}
function taskMetadataPath(job) {
  return `${job.output}.task.json`;
}
function reconcileJob(root, job) {
  if (!job) return null;
  // Adoption is terminal: an unselected version receipt must not reopen it.
  if (job.state === "approved") return job;
  if (job.voice_state === "running" && job.voice_output) {
    const voiceMetadataPath = `${job.voice_output}.task.json`;
    if (existsSync(voiceMetadataPath)) {
      try {
        const metadata = jsonFile(voiceMetadataPath);
        const next = {
          ...job,
          voice_remote_task_id: metadata.taskId || job.voice_remote_task_id,
          voice_usage: metadata.usage || job.voice_usage,
        };
        if (
          ["success", "success_budget_overrun"].includes(metadata.status) &&
          existsSync(job.voice_output)
        ) {
          next.state = "voice_review";
          next.voice_state = "review";
          next.voice_finished_at ||= new Date().toISOString();
        } else if (metadata.status === "failed") {
          next.state = "voice_failed";
          next.voice_state = "failed";
          next.voice_finished_at ||= new Date().toISOString();
          next.error =
            metadata.failureReason ||
            job.error ||
            "声音生成失败，系统没有自动重试。";
        }
        if (JSON.stringify(next) !== JSON.stringify(job))
          writeJson(join(root, `${job.id}.json`), next);
        return next;
      } catch {
        return job;
      }
    }
  }
  const metadataPath = taskMetadataPath(job);
  if (!existsSync(metadataPath)) return job;
  let metadata;
  try {
    metadata = jsonFile(metadataPath);
  } catch {
    return job;
  }
  const next = {
    ...job,
    remote_task_id: metadata.taskId || job.remote_task_id,
    usage: metadata.usage || job.usage,
    budget_overrun: Boolean(metadata.budgetOverrun),
    budget_overrun_rh_coins: Number(metadata.budgetOverrunRhCoins || 0),
  };
  const activeSegment = (job.segments || []).some((segment) =>
    ["running", "waiting_capacity", "paused_remote_task_exists"].includes(segment.state),
  );
  // A pre-submission capacity receipt belongs to the previous attempt.  Once a
  // retry is actively running/submitted it must remain as history, but it must
  // not overwrite the live job state back to `failed`.
  if (
    activeSegment &&
    ["submitted", "running", "processing"].includes(metadata.status)
  ) {
    next.state = "production_running";
    next.error = null;
    next.finished_at = null;
  }
  if (
    ["success", "success_budget_overrun"].includes(metadata.status) &&
    existsSync(job.output)
  ) {
    const recoveredLongSample =
      job.is_long &&
      job.generation_strategy === "sample_first" &&
      job.sample?.output === job.output &&
      !["production_running", "editing_running", "completed", "approved"].includes(job.state);
    next.state = job.is_long
      ? recoveredLongSample
        ? "sample_review"
        : job.state
      : "completed";
    if (recoveredLongSample) {
      next.sample = {
        ...job.sample,
        state: "review",
        qc_status: "review_pending",
        usage: metadata.usage || job.sample?.usage || null,
      };
      next.error = null;
      next.capacity_state = null;
    }
    next.finished_at ||= new Date().toISOString();
  } else if (
    metadata.status === "failed" &&
    !(activeSegment && isTalkingHeadCapacityWait(metadata.failureReason || ""))
  ) {
    next.state = "failed";
    next.finished_at ||= new Date().toISOString();
    next.error =
      metadata.failureReason || job.error || "平台任务失败，系统没有自动重试。";
  }
  if (existsSync(join(job.process_dir || "", "精品口播样片_质检记录.md")))
    next.qc_status = "review_pending_user_confirmation";
  if (JSON.stringify(next) !== JSON.stringify(job))
    writeJson(join(root, `${job.id}.json`), next);
  return next;
}
function registerJobTrees(job) {
  const common = [
    "--skill",
    "talking-head-video-workflow",
    "--task-root",
    job.task_root,
    "--task-id",
    `talking-${job.id}`,
    "--project-name",
    job.project_name,
  ];
  execFileSync(
    "python3",
    [
      adapter,
      "register-tree",
      ...common,
      "--source-dir",
      job.process_dir,
      "--origin-step",
      "口播素材与执行证据",
      "--lifecycle-status",
      "evidence",
      "--protection-level",
      "protected",
    ],
    { encoding: "utf8" },
  );
  execFileSync(
    "python3",
    [
      adapter,
      "register-tree",
      ...common,
      "--source-dir",
      job.candidate_dir,
      "--origin-step",
      "口播真实样片候选",
      "--lifecycle-status",
      "intermediate",
      "--protection-level",
      "review",
    ],
    { encoding: "utf8" },
  );
}

function publishApprovedVideo(job) {
  const raw = execFileSync(
    "python3",
    [
      adapter,
      "publish-file",
      "--skill",
      "talking-head-video-workflow",
      "--source",
      job.final_output || job.output,
      "--task-id",
      `talking-${job.id}`,
      "--project-name",
      job.project_name,
      "--origin-step",
      "用户确认口播成片",
      "--qc-status",
      "approved",
      "--display-name",
      `${talkingModeLabel(job.mode)}口播成片.mp4`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}
export function commandFor(job, paid) {
  const executionContract = assertTalkingRouteContract(job);
  if (job.mode === "native") {
    const command = [
      ...(job.native_workflow_variant === "composition_anchor_v0_1"
        ? [nativeCompositionAnchorRunner, "--base-runner", script]
        : job.native_workflow_variant === "composition_first_last_v0_2"
          ? [nativeCompositionFirstLastRunner, "--base-runner", script]
          : [script]),
      "native",
      "--image",
      job.image,
      "--voice-mode",
      job.native_voice_mode || "reference",
      ...((job.native_voice_mode || "reference") === "reference" && job.voice_reference
        ? ["--voice-reference", job.voice_reference]
        : []),
      "--run-strategy",
      job.native_run_strategy || "stable",
      "--quality-mode",
      job.quality_mode || "clear",
      "--duration",
      String(job.duration),
      ...(job.native_duration_planning === "adaptive_6_15_candidate"
        ? ["--allow-projected-duration"]
        : []),
      "--dialogue-profile",
      job.native_dialogue_profile || "h3-native-lively",
      "--prompt-file",
      job.prompt,
      "--dialogue-file",
      job.script_file,
      "--budget-limit",
      String(job.budget_limit),
      "--output",
      job.output,
      "--aspect-ratio",
      normalizeTargetRatio(job.target_ratio),
      "--workflow-id",
      executionContract.workflow_id,
      paid ? "--confirm-paid" : "--dry-run",
    ];
    if (job.generation_seed !== undefined && job.generation_seed !== null)
      command.push("--generation-seed", String(job.generation_seed));
    return command;
  }
  const boutiqueDualAnchor =
    job.mode === "boutique" && job.camera_continuity === "strict_locked";
  const boutiqueStaticCameraReference =
    boutiqueDualAnchor &&
    job.boutique_camera_experiment === "static_reference_v0_1";
  const boutiqueStructuredCamera =
    boutiqueDualAnchor &&
    ["structured_prompt_v0_1", "structured_prompt_v0_2", "structured_prompt_v0_3", "structured_reference_v0_2"].includes(
      job.boutique_camera_experiment,
    );
  const base = [
    boutiqueStructuredCamera
      ? boutiqueStructuredCameraRunner
      : boutiqueStaticCameraReference
      ? boutiqueStaticCameraReferenceRunner
      : boutiqueDualAnchor
        ? boutiqueDualAnchorRunner
        : script,
    ...(boutiqueStructuredCamera
      ? ["--experiment-variant", job.boutique_camera_experiment, "--base-runner", script]
      : boutiqueDualAnchor
        ? ["--base-runner", script]
        : []),
    job.mode === "boutique" ? "boutique" : "video",
    "--image",
    job.image,
    "--audio",
    job.audio,
    "--duration",
    String(job.duration),
    "--prompt-file",
    job.prompt,
    "--budget-limit",
    String(job.budget_limit),
    "--output",
    job.output,
    "--aspect-ratio",
    normalizeTargetRatio(job.target_ratio),
  ];
  if (job.mode === "boutique")
    base.push(
      "--workflow-id",
      executionContract.workflow_id,
      "--master-status",
      "conditional",
      "--master-sample-status",
      job.formal_segment &&
      (job.generation_strategy !== "direct_full" || job.master_sample_status === "passed")
        ? "passed"
        : "new",
      "--transcript-confidence",
      "unreliable",
      "--director-mode",
      "low",
      "--quality-mode",
      job.quality_mode || "clear",
    );
  else {
    base.push(
      "--quality-mode",
      job.quality_mode || "daily",
      "--workflow-id",
      executionContract.workflow_id,
    );
    // InfiniteTalk 的日常档已验证到约 40 秒；高清长段也已完成
    // 30.69 秒同素材回归。这里只解除旧的证据提示阻断，预算和付费确认仍生效。
    if (Number(job.duration || 0) > 10) base.push("--allow-unverified-duration");
  }
  if (
    job.mode === "boutique" &&
    job.generation_seed !== undefined &&
    job.generation_seed !== null
  )
    base.push("--generation-seed", String(job.generation_seed));
  base.push(paid ? "--confirm-paid" : "--dry-run");
  return base;
}

function resumableRemoteTask(output) {
  const record = `${output}.task.json`;
  if (!existsSync(record)) return null;
  try {
    const metadata = jsonFile(record);
    const taskId = String(metadata.taskId || "").trim();
    if (
      !taskId ||
      ["success", "success_budget_overrun", "failed", "cancelled", "canceled"].includes(
        metadata.status,
      )
    )
      return null;
    return { record, taskId, metadata };
  } catch {
    return null;
  }
}

export function isUnconsumedSegmentEligibleForManualContinue(segment, metadata = null) {
  if (
    segment?.qc_status === "interrupted_before_submission" &&
    !segment?.remote_task_id
  )
    return true;
  if (String(metadata?.status || "") !== "failed") return false;
  const attempts = Array.isArray(metadata?.attempts) ? metadata.attempts : [];
  const lastAttempt = attempts.at(-1) || {};
  const usage = lastAttempt.usage || metadata?.usage || {};
  const coins = usage.consumeCoins;
  const costTime = Number(usage.taskCostTime || 0);
  return (coins === null || coins === undefined || Number(coins) === 0) && costTime === 0;
}

function manualContinueMetadata(segment) {
  const record = `${segment.output}.task.json`;
  if (!existsSync(record)) return null;
  try {
    return jsonFile(record);
  } catch {
    return null;
  }
}

function resumeCommandFor(output) {
  return [script, "resume-v2", "--output", output];
}

function cancelCommandFor(output) {
  return [script, "cancel-v2", "--output", output];
}

function talkingHeadCancellationRequested(job) {
  return Boolean(
    job?.cancel_requested_at ||
      ["cancel_requested", "cancelled"].includes(job?.state),
  );
}

export function cancelTalkingHeadJob(root, id) {
  const path = join(root, `${id}.json`);
  const job = getTalkingHeadJob(root, id);
  if (!job) throw new Error("没有找到这次口播任务。");
  if (["completed", "approved"].includes(job.state)) return job;
  const requestedAt = new Date().toISOString();
  const stopping = {
    ...job,
    state: "cancel_requested",
    cancel_requested_at: requestedAt,
    error: null,
    segments: (job.segments || []).map((segment) => {
      if (segment.state === "completed" || existsSync(segment.output)) return segment;
      return {
        ...segment,
        state: resumableRemoteTask(segment.output)
          ? "cancel_requested"
          : "cancelled",
        qc_status: resumableRemoteTask(segment.output)
          ? "remote_cancel_requested"
          : "cancelled_before_submission",
        error: null,
      };
    }),
  };
  writeJson(path, stopping);
  const cancelErrors = [];
  for (const segment of stopping.segments) {
    const remote = resumableRemoteTask(segment.output);
    if (!remote || existsSync(segment.output)) continue;
    try {
      execFileSync("python3", cancelCommandFor(segment.output), {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      cancelErrors.push(
        `${segment.id}：${String(error?.stderr || error?.message || error).slice(-500)}`,
      );
    }
  }
  const latest = getTalkingHeadJob(root, id) || stopping;
  const cancelled = {
    ...latest,
    state: "cancelled",
    cancelled_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    capacity_state: null,
    error: cancelErrors.length
      ? `项目已停止，部分远端停止回执需要复查：${cancelErrors.join("；")}`
      : "已按你的要求停止；已完成片段继续保留，未开始的片段不会提交。",
    segments: (latest.segments || []).map((segment) =>
      segment.state === "completed" || existsSync(segment.output)
        ? segment
        : {
            ...segment,
            state: "cancelled",
            qc_status: "cancelled_by_user",
            error: null,
          },
    ),
  };
  writeJson(path, cancelled);
  return cancelled;
}

const activeTalkingHeadRecoveries = new Set();
const talkingHeadRecoveryAttempts = new Map();

function launchTalkingHeadSegments(root, id) {
  if (activeTalkingHeadRecoveries.has(id)) return false;
  activeTalkingHeadRecoveries.add(id);
  void runRemainingSegments(root, id).finally(() => {
    activeTalkingHeadRecoveries.delete(id);
  });
  return true;
}

export function ensureTalkingHeadJobRecovery(root, job) {
  if (
    !job ||
    !["running", "sample_running", "production_running", "failed"].includes(job.state)
  )
    return false;
  const recoverableRemote = (job.segments || []).some(
    (segment) =>
      ["running", "paused_remote_task_exists"].includes(segment.state) &&
      !existsSync(segment.output) &&
      Boolean(resumableRemoteTask(segment.output)),
  );
  const recoverableCapacityWait =
    job.state === "failed" &&
    (job.segments || []).some(
      (segment) =>
        segment.state === "failed" &&
        isTalkingHeadCapacityWait(segment.error) &&
        !existsSync(segment.output) &&
        !resumableRemoteTask(segment.output),
    );
  if ((!recoverableRemote && !recoverableCapacityWait) || activeTalkingHeadRecoveries.has(job.id))
    return false;
  const now = Date.now();
  if (now - Number(talkingHeadRecoveryAttempts.get(job.id) || 0) < 30_000)
    return false;
  talkingHeadRecoveryAttempts.set(job.id, now);
  if (recoverableCapacityWait) {
    const path = join(root, `${job.id}.json`);
    const resumed = {
      ...job,
      state: "production_running",
      error: null,
      editing_state: "waiting_for_segments",
      updated_at: new Date().toISOString(),
      segments: (job.segments || []).map((segment) =>
        segment.state === "failed" && isTalkingHeadCapacityWait(segment.error)
          ? {
              ...segment,
              state: "waiting_capacity",
              qc_status: "waiting_for_provider_capacity",
              error: null,
            }
          : segment,
      ),
    };
    writeJson(path, resumed);
  }
  return launchTalkingHeadSegments(root, job.id);
}

export function voiceCommandFor(job, paid) {
  const cloneRoute = job.voice_clone_route || "legacy";
  const command = [
    script,
    "tts",
    "--text-file",
    job.script_file,
    "--voice-reference",
    job.voice_reference,
    "--output",
    job.voice_output,
  ];
  if (cloneRoute === "legacy" && job.voice_webapp_id)
    command.push("--webapp-id", String(job.voice_webapp_id));
  if (cloneRoute === "legacy") {
    command.push(
      "--emotion-reference",
      job.voice_reference,
      "--emotion-weight",
      "0.5",
    );
  } else {
    command.push(
      "--clone-route",
      job.voice_clone_route,
      "--language-mode",
      job.voice_language_mode,
      "--dialect",
      job.voice_dialect,
      "--budget-limit",
      String(job.voice_budget_limit || 80),
    );
    if (job.voice_clone_route === "fidelity")
      command.push("--reference-transcript-file", job.reference_audio_transcript_file);
    else command.push("--control-instruction", job.voice_control_instruction);
  }
  command.push(paid ? "--confirm-paid" : "--dry-run");
  return command;
}

function recoverKnownVoiceWebappId(root) {
  const configured = String(process.env.RUNNINGHUB_TTS_WEBAPP_ID || "").trim();
  if (/^\d{10,30}$/.test(configured)) return configured;
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(root, entry.name));
  for (const path of candidates) {
    try {
      const prior = jsonFile(path);
      const metadataPath = prior.voice_output ? `${prior.voice_output}.task.json` : "";
      if (!metadataPath || !existsSync(metadataPath)) continue;
      const webappId = String(jsonFile(metadataPath).webappId || "").trim();
      if (/^\d{10,30}$/.test(webappId)) return webappId;
    } catch {
      // 历史任务可能来自旧版本；跳过损坏或不含路线回执的记录。
    }
  }
  return "";
}

const voiceEmotionLabels = {
  natural: "自然讲述",
  happy: "开心分享",
  urgent: "着急解释",
  calm: "沉稳认真",
  wronged: "委屈说明",
  angry: "生气质问",
};

const voicePaceLabels = {
  slow: "语速稍慢",
  normal: "语速正常",
  fast: "语速稍快",
};

export function compileVoiceControlInstruction({ dialect, emotionPreset, speechPace }) {
  if (!Object.hasOwn(voiceEmotionLabels, emotionPreset))
    throw new Error("请选择工作台支持的说话情绪。");
  if (!Object.hasOwn(voicePaceLabels, speechPace))
    throw new Error("请选择工作台支持的说话速度。");
  return `使用地道${dialect}表达，${voiceEmotionLabels[emotionPreset]}，${voicePaceLabels[speechPace]}，口语自然，不要普通话腔。`;
}

export async function createTalkingHeadJob({
  root,
  mode,
  audioFile,
  imageFile,
  qualityMode = "daily",
  targetRatio = "9:16",
  concurrency = 1,
  generationStrategy = "sample_first",
  directGenerationAcknowledged = false,
  cameraContinuity = "natural",
  boutiqueCameraExperiment = "",
  personAsset = null,
}) {
  if (!["standard", "boutique"].includes(mode))
    throw new Error("当前真实试运行只开放标准口播和精品口播。");
  if (!Object.hasOwn(standardQualityRates, qualityMode))
    throw new Error("请选择工作台支持的画面优先级。");
  if (!["sample_first", "direct_full"].includes(generationStrategy))
    throw new Error("请选择先做样片或直接生成完整内容。");
  if (generationStrategy === "direct_full" && !directGenerationAcknowledged)
    throw new Error("直接生成前，请先确认已了解跳过样片会增加返工成本。");
  if (!["natural", "stable_natural", "handheld_selfie", "walk_and_talk", "strict_locked"].includes(cameraContinuity))
    throw new Error("镜头保持方式无效，请重新选择。");
  const resolvedBoutiqueCameraExperiment =
    mode === "boutique" && cameraContinuity === "strict_locked"
      ? boutiqueCameraExperiments.has(boutiqueCameraExperiment)
        ? boutiqueCameraExperiment
        : defaultBoutiqueFixedCameraExperiment
      : "";
  if (
    !(audioFile instanceof File) ||
    audioFile.size === 0 ||
    !(imageFile instanceof File) ||
    imageFile.size === 0
  )
    throw new Error("请先选择口播音频和人物母版图。");
  const id = randomUUID();
  const projectName = `${talkingModeLabel(mode)}口播工作台试运行`;
  const route = adapterPrepare(`talking-${id}`, projectName);
  const processDir = route.process_dir;
  const candidateDir = route.candidate_dir;
  mkdirSync(root, { recursive: true });
  mkdirSync(processDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });
  const audio = join(
    processDir,
    `confirmed_audio${safeExt(audioFile.name, ".wav")}`,
  );
  const image = join(
    processDir,
    `talking_master${safeExt(imageFile.name, ".png")}`,
  );
  writeFileSync(audio, Buffer.from(await audioFile.arrayBuffer()), {
    flag: "wx",
  });
  const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
  targetRatio = normalizeTargetRatio(targetRatio);
  await assertMasterOrientation(imageBuffer, targetRatio);
  const masterSampleEvidence = approvedMasterSampleEvidence(root, imageBuffer);
  const masterSampleStatus = masterSampleEvidence ? "passed" : "new";
  writeFileSync(image, imageBuffer, {
    flag: "wx",
  });
  const measured = durationOf(audio);
  const requestedGenerationStrategy = generationStrategy;
  const directGenerationBlockedReason =
    mode === "boutique" &&
    generationStrategy === "direct_full" &&
    measured > 8 &&
    masterSampleStatus !== "passed"
      ? "精品口播超过 8 秒直接生成时，这张人物母版必须已有合格样片；系统已改为先做样片。"
      : null;
  if (directGenerationBlockedReason) generationStrategy = "sample_first";
  const duration =
    mode === "boutique"
      ? Math.min(8, Math.max(1, Math.floor(measured)))
      : Number(measured.toFixed(2));
  const prompt = join(processDir, "performance_prompt.txt");
  writeFileSync(
    prompt,
    mode === "boutique"
      ? compileBoutiquePrompt(
          boutiqueCameraExperiments.has(resolvedBoutiqueCameraExperiment)
            ? "stable_natural"
            : cameraContinuity,
        )
      : standardLowDirectorPrompt,
    { flag: "wx" },
  );
  const output = join(
    candidateDir,
    `${talkingModeLabel(mode)}口播_${generationStrategy === "direct_full" ? "完整成片" : "样片"}.mp4`,
  );
  const job = {
    id,
    mode,
    ...(mode === "boutique"
      ? {
          generation_seed:
            resolvedBoutiqueCameraExperiment === "independent_clean_parallel_v1"
              ? Number.parseInt(
                  createHash("sha256").update(id).digest("hex").slice(0, 12),
                  16,
                )
              : boutiqueFixedCameraEditingProfile.generation_seed,
        }
      : {}),
    quality_mode: qualityMode,
    target_ratio: targetRatio,
    concurrency: normalizeTalkingHeadConcurrency(concurrency),
    generation_strategy: generationStrategy,
    requested_generation_strategy: requestedGenerationStrategy,
    direct_generation_blocked_reason: directGenerationBlockedReason,
    direct_generation_acknowledged: Boolean(directGenerationAcknowledged),
    camera_continuity: cameraContinuity,
    boutique_camera_experiment: resolvedBoutiqueCameraExperiment || null,
    master_sample_status: masterSampleStatus,
    execution_contract: talkingRouteContract(mode),
    project_name: projectName,
    skill_version: "0.7.1",
    state: "preflight",
    measured_duration: Number(measured.toFixed(2)),
    duration,
    budget_limit:
      mode === "boutique"
        ? boutiqueVideoBudget(duration, qualityMode)
        : standardVideoBudget(duration, qualityMode),
    image,
    person_asset: publicBoundPersonAsset(personAsset),
    audio,
    original_audio: audio,
    prompt,
    output,
    task_root: route.task_root,
    process_dir: processDir,
    candidate_dir: candidateDir,
    created_at: new Date().toISOString(),
  };
  if (isH3FixedCameraLongformCandidate(job)) {
    if (qualityMode !== "clear" || targetRatio !== "9:16")
      throw new Error("H3 独立干净母版内部候选当前只验证高清 9:16；本次没有上传。");
    if (requestedGenerationStrategy !== "direct_full" || generationStrategy !== "direct_full")
      throw new Error(
        directGenerationBlockedReason ||
          "H3 独立干净母版内部候选只用于已经通过母版样片的长内容直接生成；本次没有上传。",
      );
    if (!masterSampleEvidence)
      throw new Error("没有找到这张人物母版已经通过的样片证据；本次没有上传。");
    const longformDir = join(processDir, "h3_fixed_camera_longform_v1");
    const anchorGateReceipt = join(processDir, "h3_fixed_camera_anchor_gate.json");
    writeJson(anchorGateReceipt, {
      schema: "h3-anchor-candidate-gate-v1",
      status: "anchor_candidate_selected",
      master_image_sha256: createHash("sha256").update(readFileSync(image)).digest("hex"),
      selected_candidate: {
        candidate_id: `approved-web-sample-${masterSampleEvidence.job_id}`,
        path: masterSampleEvidence.output,
        sha256: masterSampleEvidence.output_sha256,
        manual_review: "approved_sample",
      },
      automatic_paid_retry: false,
    });
    const prepared = execFileSync(
      "python3",
      [
        h3FixedCameraLongformRunner,
        "prepare-parallel-longform",
        "--image",
        image,
        "--audio",
        audio,
        "--anchor-gate-receipt",
        anchorGateReceipt,
        "--work-dir",
        longformDir,
        "--seed",
        String(job.generation_seed),
        "--raw-frames",
        "192",
        "--workflow-id",
        job.execution_contract.workflow_id,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    const preparedSummary = JSON.parse(String(prepared || "{}").trim());
    const batchManifest = jsonFile(preparedSummary.batchManifest);
    const longformPreflight = jsonFile(preparedSummary.aggregateComposePreflight);
    const totalBudgetGuard = Number(batchManifest.total_budget_guard_coins || 0);
    job.concurrency = Number(batchManifest.max_parallel_default || 4);
    job.skill_version = "0.9.7-candidate";
    job.execution_contract = {
      ...job.execution_contract,
      contract_version: 3,
      backend_route: "MiniMax_H3_audio_drive_independent_clean_parallel",
    };
    job.long_contract_version = 6;
    job.segmentation_basis = "fixed_192_frame_independent_clean_master_with_audio_overlap";
    job.is_long = true;
    job.duration = Number(job.measured_duration);
    job.budget_limit = totalBudgetGuard;
    job.estimated_rh_coins = job.budget_limit;
    job.final_output = join(candidateDir, "精品口播_H3独立干净母版完整成片.mp4");
    job.output = job.final_output;
    job.editing_state = "independent_clean_parallel_preflight_ready";
    job.segments = batchManifest.packages.map((segment, arrayIndex) => ({
      id: `S${String(segment.global_segment_index).padStart(2, "0")}`,
      index: arrayIndex,
      start: Number(segment.source_start_seconds),
      end: Number(segment.source_end_seconds),
      content_duration: Number(
        longformPreflight.segments[arrayIndex]?.visible_frames || 0,
      ) / Number(longformPreflight.fps),
      generation_duration: Number(batchManifest.raw_frames_per_segment) /
        Number(longformPreflight.fps),
      state: "pending",
      qc_status: "pending",
      estimated_rh_coins: Number(segment.budget_guard_coins),
      output: join(longformDir, "parallel_results", `segment_${String(segment.global_segment_index).padStart(2, "0")}.mp4`),
    }));
    job.h3_fixed_camera_longform = {
      route_version: "independent_clean_parallel_v1",
      batch_manifest: preparedSummary.batchManifest,
      aggregate_compose_preflight: preparedSummary.aggregateComposePreflight,
      anchor_gate_receipt: anchorGateReceipt,
      full_audio: batchManifest.full_audio,
      result_dir: join(longformDir, "parallel_results"),
      task_journal: join(longformDir, "parallel_batch_journal.json"),
      block_qc_report: join(longformDir, "block_qc_report.json"),
      block_gate_receipt: join(longformDir, "block_gate_receipt.json"),
      compose_recipe: join(longformDir, "compose_recipe.json"),
      expected_output_count: Number(batchManifest.segment_count),
      raw_frames_per_segment: Number(batchManifest.raw_frames_per_segment),
      generated_frame_propagation: false,
      same_original_clean_master_for_every_task: true,
      final_frame_calibration_default: "off",
      frame_calibration_automatic_adoption: false,
      automatic_retry: false,
      external_request_started: false,
    };
    job.preflight = prepared.trim();
    writeJson(join(root, `${id}.json`), job);
    return job;
  }
  job.segments = longSegmentPlan(mode, measured, detectPauseCenters(audio));
  job.long_contract_version = 4;
  job.segmentation_basis = job.segments.length ? "natural_audio_pauses" : "single_segment";
  job.is_long = job.segments.length > 0;
  if (job.is_long) {
    job.final_output = join(candidateDir, `${talkingModeLabel(mode)}口播_完整成片.mp4`);
    job.editing_state = "waiting_for_segments";
    prepareLongSegments(job);
    if (generationStrategy === "sample_first") prepareLongSample(job);
    job.estimated_rh_coins = (job.sample?.estimated_rh_coins || 0) + job.segments.reduce(
      (sum, segment) => sum + segment.estimated_rh_coins,
      0,
    );
  }
  const preflightJob =
    job.is_long && generationStrategy === "direct_full"
      ? {
          ...job,
          audio: job.segments[0].audio,
          output: job.segments[0].output,
          duration: job.segments[0].generation_duration,
          budget_limit: job.segments[0].estimated_rh_coins,
          formal_segment: true,
        }
      : generationStrategy === "direct_full"
        ? { ...job, formal_segment: true }
        : job;
  const preflight = execFileSync("python3", commandFor(preflightJob, false), {
    encoding: "utf8",
  });
  job.preflight = preflight.trim();
  if (!job.is_long) {
    job.estimated_rh_coins =
        mode === "boutique"
          ? boutiqueVideoBudget(duration, qualityMode)
          : standardVideoBudget(duration, qualityMode);
  }
  writeJson(join(root, `${id}.json`), job);
  return job;
}

export async function createTalkingHeadVoiceJob({
  root,
  mode,
  scriptText,
  voiceFile,
  imageFile,
  voiceAuthorized,
  languageMode = "mandarin",
  dialect = "",
  cloneRoute = "legacy",
  referenceAudioTranscript = "",
  emotionPreset = "natural",
  speechPace = "normal",
  dialectScriptConfirmed = false,
  qualityMode = "daily",
  targetRatio = "9:16",
  concurrency = 1,
  generationStrategy = "sample_first",
  directGenerationAcknowledged = false,
  cameraContinuity = "natural",
  boutiqueCameraExperiment = "",
  personAsset = null,
}) {
  if (!["standard", "boutique"].includes(mode))
    throw new Error("当前真实试运行只开放标准口播和精品口播。");
  if (!Object.hasOwn(standardQualityRates, qualityMode))
    throw new Error("请选择工作台支持的画面优先级。");
  if (!["sample_first", "direct_full"].includes(generationStrategy))
    throw new Error("请选择先做样片或直接生成完整内容。");
  if (generationStrategy === "direct_full" && !directGenerationAcknowledged)
    throw new Error("直接生成前，请先确认已了解跳过样片会增加返工成本。");
  if (!["natural", "stable_natural", "handheld_selfie", "walk_and_talk", "strict_locked"].includes(cameraContinuity))
    throw new Error("镜头保持方式无效，请重新选择。");
  const resolvedBoutiqueCameraExperiment =
    mode === "boutique" && cameraContinuity === "strict_locked"
      ? boutiqueCameraExperiments.has(boutiqueCameraExperiment)
        ? boutiqueCameraExperiment
        : defaultBoutiqueFixedCameraExperiment
      : "";
  if (!voiceAuthorized) throw new Error("请先确认有权使用这段声音进行克隆。");
  const confirmedScript = String(scriptText || "").trim();
  if (!confirmedScript) throw new Error("请先填写已经确认的口播稿。");
  if (!["mandarin", "dialect"].includes(languageMode))
    throw new Error("请选择普通话或方言。");
  if (!["legacy", "fidelity", "expressive"].includes(cloneRoute))
    throw new Error("请选择工作台支持的声音生成方式。");
  const confirmedDialect = String(dialect || "").trim();
  const confirmedReferenceTranscript = String(referenceAudioTranscript || "").trim();
  if (languageMode === "mandarin" && cloneRoute !== "legacy")
    throw new Error("普通话当前继续使用稳定克隆；方言才使用音色还原或情绪表达路线。");
  if (languageMode === "dialect") {
    if (!confirmedDialect) throw new Error("请选择本次使用的方言。");
    if (!dialectScriptConfirmed)
      throw new Error("请先确认目标口播稿已经是方言表达，不是普通话原稿。");
    if (!["fidelity", "expressive"].includes(cloneRoute))
      throw new Error("方言克隆请选择音色还原优先或情绪表达优先。");
  }
  if (cloneRoute === "fidelity" && !confirmedReferenceTranscript)
    throw new Error("音色还原优先需要参考声音的完整逐字稿。");
  if (cloneRoute === "expressive" && confirmedReferenceTranscript)
    throw new Error("情绪表达优先不使用参考声音逐字稿，请清空后重试。");
  if (
    !(voiceFile instanceof File) ||
    voiceFile.size === 0 ||
    !(imageFile instanceof File) ||
    imageFile.size === 0
  )
    throw new Error("请先选择授权声音参考和人物母版图。");
  const id = randomUUID();
  const projectName = `${talkingModeLabel(mode)}口播声音克隆试运行`;
  const route = adapterPrepare(`talking-${id}`, projectName);
  const processDir = route.process_dir;
  const candidateDir = route.candidate_dir;
  mkdirSync(root, { recursive: true });
  mkdirSync(processDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });
  const voiceReference = join(
    processDir,
    `authorized_voice_reference${safeExt(voiceFile.name, ".wav")}`,
  );
  const image = join(
    processDir,
    `talking_master${safeExt(imageFile.name, ".png")}`,
  );
  const scriptFile = join(processDir, "confirmed_script.txt");
  const referenceAudioTranscriptFile = cloneRoute === "fidelity"
    ? join(processDir, "reference_audio_transcript.txt")
    : null;
  const voiceOutput = join(candidateDir, "克隆声音_待确认.flac");
  writeFileSync(voiceReference, Buffer.from(await voiceFile.arrayBuffer()), {
    flag: "wx",
  });
  const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
  targetRatio = normalizeTargetRatio(targetRatio);
  await assertMasterOrientation(imageBuffer, targetRatio);
  const masterSampleStatus = approvedMasterSampleStatus(root, imageBuffer);
  writeFileSync(image, imageBuffer, {
    flag: "wx",
  });
  writeFileSync(scriptFile, confirmedScript, { flag: "wx" });
  if (referenceAudioTranscriptFile)
    writeFileSync(referenceAudioTranscriptFile, confirmedReferenceTranscript, { flag: "wx" });
  const voiceControlInstruction = cloneRoute === "expressive"
    ? compileVoiceControlInstruction({
        dialect: confirmedDialect,
        emotionPreset,
        speechPace,
      })
    : null;
  const job = {
    id,
    mode,
    ...(mode === "boutique"
      ? {
          generation_seed: boutiqueFixedCameraEditingProfile.generation_seed,
        }
      : {}),
    quality_mode: qualityMode,
    target_ratio: targetRatio,
    concurrency: normalizeTalkingHeadConcurrency(concurrency),
    generation_strategy: generationStrategy,
    direct_generation_acknowledged: Boolean(directGenerationAcknowledged),
    camera_continuity: cameraContinuity,
    boutique_camera_experiment: resolvedBoutiqueCameraExperiment || null,
    master_sample_status: masterSampleStatus,
    execution_contract: talkingRouteContract(mode),
    speech_source: "clone",
    project_name: projectName,
    skill_version: "0.8.0",
    state: "voice_preflight",
    voice_state: "preflight",
    script_file: scriptFile,
    voice_language_mode: languageMode,
    voice_dialect: languageMode === "dialect" ? confirmedDialect : null,
    voice_clone_route: cloneRoute,
    reference_audio_transcript_file: referenceAudioTranscriptFile,
    voice_emotion_preset: cloneRoute === "expressive" ? emotionPreset : null,
    voice_speech_pace: cloneRoute === "expressive" ? speechPace : null,
    voice_control_instruction: voiceControlInstruction,
    dialect_script_confirmed: languageMode === "dialect" ? true : null,
    voice_budget_limit: cloneRoute === "legacy" ? 20 : 80,
    voice_reference: voiceReference,
    voice_output: voiceOutput,
    // AI 应用编号只属于普通话 IndexTTS2 路线。方言由 VoxCPM2 工作流执行，
    // 不保留无效的普通话编号，避免任务记录与实际执行路线看起来不一致。
    voice_webapp_id: cloneRoute === "legacy" ? recoverKnownVoiceWebappId(root) || null : null,
    image,
    person_asset: publicBoundPersonAsset(personAsset),
    task_root: route.task_root,
    process_dir: processDir,
    candidate_dir: candidateDir,
    estimated_rh_coins: 20,
    created_at: new Date().toISOString(),
  };
  job.preflight = execFileSync("python3", voiceCommandFor(job, false), {
    encoding: "utf8",
  }).trim();
  writeJson(join(root, `${id}.json`), job);
  return job;
}

export async function createNativeTalkingHeadJob({
  root,
  scriptText,
  performanceRequirement = "",
  voiceFile,
  voiceFileLeft,
  voiceFileRight,
  imageFile,
  voiceAuthorized,
  voiceMode = "random",
  runStrategy = "economy",
  qualityMode = "clear",
  targetRatio = "9:16",
  cameraContinuity = "strict_locked",
  workflowVariant = "production",
  dialogueMode = "single",
  dialogueStyle = "natural_interview",
  neutralHandPoseConfirmed = false,
  durationPlanning = "fixed_10_verified",
  concurrency = 1,
  personAsset = null,
}) {
  if (!["random", "reference"].includes(voiceMode))
    throw new Error("原生口播音色方式无效，请重新选择。");
  if (!["economy", "stable"].includes(runStrategy))
    throw new Error("原生口播生成策略无效，请重新选择。");
  if (!["daily", "clear", "premium"].includes(qualityMode))
    throw new Error("原生口播清晰度无效，请重新选择。");
  if (!["natural", "strict_locked"].includes(cameraContinuity))
    throw new Error("镜头保持方式无效，请重新选择。");
  if (
    ![
      "production",
      "composition_anchor_v0_1",
      "composition_first_last_v0_2",
    ].includes(workflowVariant)
  )
    throw new Error("原生口播执行版本无效，请重新选择。");
  targetRatio = normalizeTargetRatio(targetRatio);
  if (qualityMode === "premium") runStrategy = "stable";
  if ((voiceMode === "reference" || dialogueMode === "two_speaker_alternating") && !voiceAuthorized)
    throw new Error("请先确认有权使用这段声音作为音色参考。");
  if (!["single", "two_speaker_alternating"].includes(dialogueMode))
    throw new Error("原生口播对话方式无效，请重新选择。")
  if (!["natural_interview", "structured_discussion"].includes(dialogueStyle))
    throw new Error("双人对话感觉无效，请重新选择。");
  if (!["fixed_10_verified", "adaptive_6_15_candidate"].includes(durationPlanning))
    throw new Error("原生口播时长规划方式无效，请重新选择。");
  const dialogue = String(scriptText || "").trim();
  if (!dialogue) throw new Error("请先填写原生口播要说的逐字台词。");
  const isTwoSpeaker = dialogueMode === "two_speaker_alternating";
  if (isTwoSpeaker && neutralHandPoseConfirmed !== true)
    throw new Error(
      "双人对话母版中，两个人的手都要有明确落点，不能停在半空；请更换母版或完成检查。",
    );
  const adaptiveDuration = durationPlanning === "adaptive_6_15_candidate";
  const scriptPlan = adaptiveDuration
    ? isTwoSpeaker
      ? nativeAdaptiveTwoSpeakerScriptPlan(dialogue, { dialogueStyle })
      : nativeAdaptiveScriptPlan(dialogue)
    : isTwoSpeaker
      ? nativeTwoSpeakerScriptPlan(dialogue, { dialogueStyle })
      : nativeLongScriptPlan(dialogue);
  const perSegmentBudget = nativeVideoBudget(
    qualityMode,
    runStrategy,
    workflowVariant,
  );
  if (!(imageFile instanceof File) || imageFile.size === 0)
    throw new Error("请先选择人物母版图。");
  if (isTwoSpeaker) {
    if (!(voiceFileLeft instanceof File) || voiceFileLeft.size === 0)
      throw new Error("双人对话需要给左侧人物选择已获授权的声音参考。");
    if (!(voiceFileRight instanceof File) || voiceFileRight.size === 0)
      throw new Error("双人对话需要给右侧人物选择已获授权的声音参考。");
  } else if (
    voiceMode === "reference" &&
    (!(voiceFile instanceof File) || voiceFile.size === 0)
  )
    throw new Error("指定音色需要选择已获授权的声音参考。");
  const id = randomUUID();
  const projectName = "原生口播工作台试运行";
  const route = adapterPrepare(`talking-${id}`, projectName);
  const processDir = route.process_dir;
  const candidateDir = route.candidate_dir;
  mkdirSync(root, { recursive: true });
  mkdirSync(processDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });
  const voiceReference = !isTwoSpeaker && voiceMode === "reference"
    ? join(
        processDir,
        `authorized_voice_reference${safeExt(voiceFile.name, ".wav")}`,
      )
    : null;
  const voiceReferenceLeft = isTwoSpeaker
    ? join(
        processDir,
        `authorized_voice_reference_left${safeExt(voiceFileLeft.name, ".wav")}`,
      )
    : null;
  const voiceReferenceRight = isTwoSpeaker
    ? join(
        processDir,
        `authorized_voice_reference_right${safeExt(voiceFileRight.name, ".wav")}`,
      )
    : null;
  const image = join(
    processDir,
    `talking_master${safeExt(imageFile.name, ".png")}`,
  );
  const scriptFile = join(processDir, "confirmed_native_dialogue.txt");
  const isLong = scriptPlan.segments.length > 1;
  if (voiceReference)
    writeFileSync(voiceReference, Buffer.from(await voiceFile.arrayBuffer()), { flag: "wx" });
  if (voiceReferenceLeft)
    writeFileSync(voiceReferenceLeft, Buffer.from(await voiceFileLeft.arrayBuffer()), { flag: "wx" });
  if (voiceReferenceRight)
    writeFileSync(voiceReferenceRight, Buffer.from(await voiceFileRight.arrayBuffer()), { flag: "wx" });
  const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
  await assertMasterOrientation(imageBuffer, targetRatio);
  writeFileSync(image, imageBuffer, { flag: "wx" });
  writeFileSync(scriptFile, dialogue, { flag: "wx" });
  let segmentCursor = 0;
  const segments = scriptPlan.segments.map((item, index) => {
    const id = `S${String(index + 1).padStart(2, "0")}`;
    const segmentDuration = item.projected_duration || nativeDuration;
    const segmentStart = segmentCursor;
    segmentCursor += segmentDuration;
    const segmentScript = join(processDir, `${id}_confirmed_dialogue.txt`);
    const segmentPrompt = join(processDir, `${id}_native_prompt.txt`);
    const segmentOutput = join(candidateDir, `${id}_原生口播片段.mp4`);
    writeFileSync(segmentScript, item.dialogue, { flag: "wx" });
    writeFileSync(
      segmentPrompt,
      compileNativePrompt(item.dialogue, item.native_voice_mode || voiceMode, {
        performanceRequirement,
        segmentIndex: index,
        segmentTotal: scriptPlan.segments.length,
        targetRatio,
        cameraContinuity,
        subjectLayout: isTwoSpeaker ? "dual_interview" : "single",
        activeSpeaker: item.active_speaker || "subject1",
        dialogueStyle: isTwoSpeaker ? dialogueStyle : "standard",
      }),
      { flag: "wx" },
    );
    return {
      id,
      index,
      start: segmentStart,
      end: segmentCursor,
      content_duration: segmentDuration,
      generation_duration: segmentDuration,
      dialogue: item.dialogue,
      hanzi_count: item.hanzi_count,
      duration_evidence:
        item.duration_evidence ||
        (segmentDuration === nativeDuration
          ? "verified_10s"
          : "projected_requires_paid_validation"),
      ...(isTwoSpeaker
        ? {
            speaker_side: item.speaker_side,
            active_speaker: item.active_speaker,
            native_voice_mode: item.native_voice_mode,
            voice_reference:
              item.speaker_side === "left"
                ? voiceReferenceLeft
                : voiceReferenceRight,
          }
        : {}),
      script_file: segmentScript,
      prompt: segmentPrompt,
      output: segmentOutput,
      state: "pending",
      qc_status: "pending",
      estimated_rh_coins: perSegmentBudget,
    };
  });
  const job = {
    id,
    mode: "native",
    speech_source: isTwoSpeaker
      ? "native_two_speaker_mixed_voice"
      : voiceMode === "reference" ? "native_reference" : "native_natural",
    native_voice_mode: voiceMode,
    native_dialogue_mode: dialogueMode,
    native_dialogue_style: isTwoSpeaker ? dialogueStyle : null,
    native_dialogue_profile:
      isTwoSpeaker && dialogueStyle === "natural_interview"
        ? "h3-native-interview"
        : "h3-native-lively",
    native_conversation_contract: isTwoSpeaker
      ? scriptPlan.conversation_contract ||
        (dialogueStyle === "natural_interview"
          ? "alternating_reply_first_spoken_clauses"
          : "alternating_complete_viewpoints")
      : null,
    native_duration_planning: durationPlanning,
    native_neutral_hand_pose_confirmed: isTwoSpeaker
      ? neutralHandPoseConfirmed
      : null,
    native_run_strategy: runStrategy,
    quality_mode: qualityMode,
    target_ratio: targetRatio,
    concurrency: normalizeTalkingHeadConcurrency(concurrency),
    generation_strategy: "direct_full",
    direct_generation_acknowledged: true,
    project_name: projectName,
    execution_contract: talkingRouteContract("native"),
    skill_version: "0.8.1",
    state: "preflight",
    duration: segments[0].generation_duration,
    measured_duration: segments.reduce(
      (sum, segment) => sum + segment.content_duration,
      0,
    ),
    budget_limit: segments.length * perSegmentBudget,
    estimated_rh_coins: segments.length * perSegmentBudget,
    image,
    person_asset: publicBoundPersonAsset(personAsset),
    voice_reference: voiceReference,
    voice_reference_left: voiceReferenceLeft,
    voice_reference_right: voiceReferenceRight,
    script_file: scriptFile,
    prompt: segments[0].prompt,
    output: segments[0].output,
    task_root: route.task_root,
    process_dir: processDir,
    candidate_dir: candidateDir,
    is_long: isLong,
    segments,
    final_output: isLong
      ? join(candidateDir, "原生口播_完整成片.mp4")
      : segments[0].output,
    performance_requirement: String(performanceRequirement || "").trim(),
    camera_continuity: cameraContinuity,
    native_workflow_variant: workflowVariant,
    native_long_contract_version: adaptiveDuration ? 2 : 1,
    automatic_retry: false,
    evidence_boundary: `${adaptiveDuration ? "adaptive_6_15_candidate" : "10s_verified"}_${targetRatio}_${qualityMode}_${isTwoSpeaker ? "two_speaker_dual_reference" : voiceMode}_${runStrategy}`,
    created_at: new Date().toISOString(),
  };
  const preflightJob = {
    ...job,
    script_file: segments[0].script_file,
    prompt: segments[0].prompt,
    output: segments[0].output,
    native_voice_mode:
      segments[0].native_voice_mode || job.native_voice_mode,
    voice_reference:
      segments[0].voice_reference || job.voice_reference,
    duration: segments[0].generation_duration,
    budget_limit: perSegmentBudget,
  };
  job.preflight = execFileSync("python3", commandFor(preflightJob, false), {
    encoding: "utf8",
  }).trim();
  writeJson(join(root, `${id}.json`), job);
  return job;
}

function publicBoundPersonAsset(asset) {
  if (!asset) return null;
  return {
    asset_id: asset.asset_id,
    project_id: asset.project_id,
    asset_type: asset.asset_type,
    route: asset.route,
    source_kind: asset.source_kind,
    original_name: asset.original_name,
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    sha256: asset.sha256,
    status: "bound_to_talking_project",
    created_at: asset.created_at,
  };
}

export function getTalkingHeadJob(root, id, { prepareAssets = true } = {}) {
  const path = join(root, `${id}.json`);
  if (!existsSync(path)) return null;
  const stored = jsonFile(path);
  const normalized = {
    ...stored,
    skill_version: stored.skill_version || "0.7.1",
    speech_source:
      stored.speech_source || (stored.voice_reference ? "clone" : "audio"),
    quality_mode: stored.quality_mode || (["boutique", "native"].includes(stored.mode) ? "clear" : "daily"),
    ...(stored.mode === "native"
      ? {
          native_voice_mode:
            stored.native_voice_mode ||
            (stored.speech_source === "native_natural" ? "random" : "reference"),
          native_run_strategy: stored.native_run_strategy || "stable",
        }
      : {}),
    target_ratio: normalizeTargetRatio(stored.target_ratio),
    concurrency: normalizeTalkingHeadConcurrency(stored.concurrency),
    generation_strategy: stored.generation_strategy || "sample_first",
    direct_generation_acknowledged: Boolean(stored.direct_generation_acknowledged),
    master_sample_status: stored.master_sample_status || "new",
  };
  if (
    prepareAssets &&
    usesIndependentSegmentLifecycle(normalized) &&
    normalized.original_audio &&
    existsSync(normalized.original_audio) &&
    !["running", "sample_running", "production_running", "editing_running"].includes(normalized.state)
  ) {
    prepareLongSegments(normalized);
    if (normalized.sample) {
      normalized.sample.estimated_rh_coins =
        normalized.mode === "boutique"
          ? boutiqueVideoBudget(normalized.sample.duration, normalized.quality_mode)
          : standardVideoBudget(normalized.sample.duration, normalized.quality_mode);
    }
    normalized.estimated_rh_coins =
      (normalized.generation_strategy === "sample_first"
        ? normalized.sample?.estimated_rh_coins || 0
        : 0) +
      normalized.segments.reduce((sum, segment) => sum + segment.estimated_rh_coins, 0);
  }
  if (stored.mode === "standard" && stored.duration) {
    const correctedBudget = standardVideoBudget(
      stored.duration,
      normalized.quality_mode,
    );
    normalized.budget_limit = Math.max(stored.budget_limit || 0, correctedBudget);
    normalized.estimated_rh_coins = Math.max(
      stored.estimated_rh_coins || 0,
      correctedBudget,
    );
  }
  if (
    prepareAssets &&
    usesIndependentSegmentLifecycle(normalized) &&
    normalized.long_contract_version !== 4 &&
    normalized.original_audio &&
    existsSync(normalized.original_audio) &&
    !["running", "sample_running", "production_running", "editing_running"].includes(normalized.state)
  ) {
    normalized.segments = longSegmentPlan(
      normalized.mode,
      normalized.measured_duration,
      detectPauseCenters(normalized.original_audio),
    );
    prepareLongSegments(normalized);
    if (normalized.generation_strategy === "sample_first") {
      if (!normalized.sample) prepareLongSample(normalized);
      normalized.audio = normalized.sample.audio;
      normalized.output = normalized.sample.output;
      normalized.duration = normalized.sample.duration;
      normalized.budget_limit = normalized.sample.estimated_rh_coins;
    }
    normalized.estimated_rh_coins =
      (normalized.generation_strategy === "sample_first"
        ? normalized.sample?.estimated_rh_coins || 0
        : 0) + normalized.segments.reduce(
      (sum, segment) => sum + segment.estimated_rh_coins,
      0,
    );
    normalized.long_contract_version = 4;
  }
  if (JSON.stringify(normalized) !== JSON.stringify(stored))
    writeJson(path, normalized);
  const result = reconcileJob(root, normalized);
  // Expose the original text for editing; do not replace the saved source file.
  const readText = (file) => {
    try { return file && existsSync(file) ? readFileSync(file, "utf8") : ""; }
    catch { return ""; }
  };
  return { ...result, confirmed_script: readText(result.script_file), reference_audio_transcript: readText(result.reference_audio_transcript_file) };
}

export function listTalkingHeadJobs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    // Project-list reads must stay lightweight. Rebuilding long-audio segments here
    // blocks the single runtime server and can prevent unrelated video projects from
    // receiving their button clicks. Explicit job actions still repair assets.
    .map((name) =>
      getTalkingHeadJob(root, name.slice(0, -5), { prepareAssets: false }),
    )
    .filter(Boolean)
    .sort((left, right) =>
      String(
        right.updated_at || right.finished_at || right.created_at,
      ).localeCompare(
        String(left.updated_at || left.finished_at || left.created_at),
      ),
    );
}

export function updateTalkingHeadJob(root, id, patch) {
  const path = join(root, `${id}.json`);
  const job = getTalkingHeadJob(root, id);
  if (!job) throw new Error("没有找到这次口播任务。");
  const next = { ...job, ...patch, updated_at: new Date().toISOString() };
  writeJson(path, next);
  return next;
}

export function startTalkingHeadJob(root, id) {
  const path = join(root, `${id}.json`);
  const job = getTalkingHeadJob(root, id);
  if (!job) throw new Error("没有找到这次口播任务。");
  // Only an explicit initial submission or failed sample can start here.
  // All active, review, approved and cancelled phases keep their original task.
  if (!["preflight", "failed"].includes(job.state)) return job;
  if (job.generation_strategy === "direct_full")
    return startDirectTalkingHeadProduction(root, id);
  requireTalkingConfiguration();
  if (job.state === "failed") {
    job.generation_attempts = [
      ...(job.generation_attempts || []),
      {
        task_id: job.remote_task_id || null,
        state: "failed",
        usage: job.usage || null,
        error: job.error || "本次没有返回视频。",
        finished_at: job.finished_at || null,
      },
    ];
    job.remote_task_id = null;
    job.usage = null;
    job.error = null;
    job.finished_at = null;
  }
  job.state = "running";
  if (job.is_long) {
    job.state = "sample_running";
    job.sample.state = "running";
  }
  job.started_at = new Date().toISOString();
  writeJson(path, job);
  void runProviderCommandWithCapacityWait(commandFor(job, true), () => {
    const waiting = getTalkingHeadJob(root, id) || job;
    waiting.state = waiting.is_long ? "sample_running" : "running";
    waiting.capacity_state = "waiting_for_provider_capacity";
    waiting.error = null;
    writeJson(path, waiting);
  })
    .then((stdout) => {
      const fresh = getTalkingHeadJob(root, id) || job;
      fresh.finished_at = new Date().toISOString();
      fresh.log = String(stdout || "").slice(-4000);
      fresh.capacity_state = null;
      fresh.state = existsSync(fresh.output)
        ? fresh.is_long
          ? "sample_review"
          : "completed"
        : "failed";
      if (fresh.is_long && fresh.state === "sample_review") {
        fresh.sample.state = "review";
        fresh.sample.qc_status = "review_pending";
        fresh.sample.usage = fresh.usage || null;
      }
      if (fresh.state === "failed")
        fresh.error = "平台任务结束，但没有找到返回视频。";
      if (fresh.state === "completed") {
        try {
          registerJobTrees(fresh);
          fresh.artifact_registration = "registered";
        } catch (registrationError) {
          fresh.artifact_registration = "failed";
          fresh.artifact_registration_error = String(
            registrationError.message || registrationError,
          ).slice(-1000);
        }
        const reconciled = reconcileJob(root, fresh);
        Object.assign(fresh, reconciled);
      }
      writeJson(path, fresh);
    })
    .catch((error) => {
      const fresh = getTalkingHeadJob(root, id) || job;
      fresh.finished_at = new Date().toISOString();
      fresh.state = "failed";
      fresh.capacity_state = null;
      fresh.error = String(error.message || error).slice(-2000);
      writeJson(path, fresh);
    });
  return job;
}

function startH3FixedCameraLongformProduction(root, id) {
  const path = join(root, `${id}.json`);
  const job = getTalkingHeadJob(root, id);
  if (!job || !isH3FixedCameraLongformCandidate(job))
    throw new Error("当前任务不是 H3 独立干净母版内部候选。");
  if (h3FixedCameraLongformRuns.has(id)) return job;
  if (!["preflight", "failed", "production_running"].includes(job.state))
    throw new Error("当前状态不能提交 H3 独立干净母版长内容。");
  const route = job.h3_fixed_camera_longform;
  if (!route?.batch_manifest || !route?.aggregate_compose_preflight || !route?.task_journal)
    throw new Error("H3 独立干净母版预检记录不完整。");
  const next = {
    ...job,
    state: "production_running",
    error: null,
    editing_state: "generating_independent_clean_segments_in_parallel",
    direct_generation_started_at: job.direct_generation_started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    h3_fixed_camera_longform: {
      ...route,
      external_request_started: true,
      authorization_id: `web-job-${id}-budget-${job.budget_limit}`,
    },
  };
  writeJson(path, next);
  h3FixedCameraLongformRuns.add(id);
  void execFilePromise("python3", [
    h3FixedCameraLongformRunner,
    "run-parallel",
    "--batch-manifest",
    route.batch_manifest,
    "--result-dir",
    route.result_dir,
    "--batch-journal",
    route.task_journal,
    "--budget-limit",
    String(job.budget_limit),
    "--authorization-id",
    `web-job-${id}-budget-${job.budget_limit}`,
    "--max-parallel",
    String(job.concurrency || 4),
    "--confirm-paid",
  ])
    .then((stdout) => {
      const fresh = getTalkingHeadJob(root, id) || next;
      const journal = existsSync(route.task_journal) ? jsonFile(route.task_journal) : {};
      const completed = journal.completed || [];
      const allDownloaded =
        journal.status === "SUCCESS_OUTPUTS_DOWNLOADED_BLOCK_QC_PENDING" &&
        completed.length === Number(route.expected_output_count || 0);
      fresh.state = allDownloaded ? "segment_review" : "failed";
      fresh.remote_task_ids = completed.map((item) => item.task_id).filter(Boolean);
      fresh.usage = { consumeCoins: String(journal.actual_consume_coins || 0) };
      fresh.actual_cost = Number(journal.actual_consume_coins || 0) || null;
      fresh.log = String(stdout || "").slice(-4000);
      fresh.finished_at = new Date().toISOString();
      fresh.updated_at = fresh.finished_at;
      fresh.editing_state = allDownloaded ? "independent_segment_review_pending" : "failed";
      fresh.qc_status = allDownloaded
        ? "independent_segment_review_required"
        : "generation_failed_no_retry";
      fresh.segments = (fresh.segments || []).map((segment) => {
        const record = completed.find(
          (item) => Number(item.global_segment_index) === Number(segment.index) + 1,
        );
        return {
          ...segment,
          output: record?.result || segment.output,
          remote_task_id: record?.task_id || null,
          actual_cost: Number(record?.consume_coins || 0) || null,
          state: record?.result && existsSync(record.result) ? "completed" : segment.state,
          qc_status: record?.result && existsSync(record.result)
            ? "independent_segment_review_required"
            : segment.qc_status,
        };
      });
      fresh.h3_fixed_camera_longform = {
        ...fresh.h3_fixed_camera_longform,
        remote_task_ids: fresh.remote_task_ids,
        downloaded_count: completed.length,
        compose_status: allDownloaded ? "blocked_pending_segment_qc" : "failed",
      };
      if (!allDownloaded)
        fresh.error = "并发任务没有完整返回；已完成片段保留，失败片段不会自动重试。";
      writeJson(path, fresh);
    })
    .catch((error) => {
      const fresh = getTalkingHeadJob(root, id) || next;
      const journal = existsSync(route.task_journal) ? jsonFile(route.task_journal) : {};
      fresh.state = "failed";
      fresh.remote_task_ids = (journal.completed || []).map((item) => item.task_id).filter(Boolean);
      fresh.usage = { consumeCoins: String(journal.actual_consume_coins || 0) };
      fresh.actual_cost = Number(journal.actual_consume_coins || 0) || fresh.actual_cost || null;
      fresh.finished_at = new Date().toISOString();
      fresh.updated_at = fresh.finished_at;
      fresh.editing_state = "failed";
      fresh.error = String(error.message || error).slice(-2000);
      fresh.h3_fixed_camera_longform = {
        ...fresh.h3_fixed_camera_longform,
        remote_task_ids: fresh.remote_task_ids,
        remote_status: journal.status || null,
        downloaded_count: (journal.completed || []).length,
        compose_status: "failed_before_block_qc",
        automatic_retry: false,
      };
      writeJson(path, fresh);
    })
    .finally(() => h3FixedCameraLongformRuns.delete(id));
  return next;
}

export function startDirectTalkingHeadProduction(root, id) {
  const path = join(root, `${id}.json`);
  const job = getTalkingHeadJob(root, id);
  if (!job) throw new Error("没有找到这次口播任务。");
  requireTalkingConfiguration();
  if (isH3FixedCameraLongformCandidate(job))
    return startH3FixedCameraLongformProduction(root, id);
  if (job.generation_strategy !== "direct_full")
    throw new Error("这个项目选择的是先做样片。");
  if (job.state === "production_running") return job;
  if (!["preflight", "failed"].includes(job.state))
    throw new Error("当前状态不能直接提交完整内容。");
  if (
    job.mode === "boutique" &&
    job.measured_duration > 8 &&
    job.master_sample_status !== "passed"
  )
    throw new Error("精品口播超过 8 秒直接生成时，这张人物母版必须已有合格样片。");
  const next = {
    ...job,
    generation_attempts:
      job.state === "failed"
        ? [
            ...(job.generation_attempts || []),
            {
              task_id: job.remote_task_id || null,
              state: "failed",
              usage: job.usage || null,
              error: job.error || "本次没有返回视频。",
              finished_at: job.finished_at || null,
            },
          ]
        : job.generation_attempts || [],
    remote_task_id: null,
    usage: null,
    error: null,
    finished_at: null,
    state: "production_running",
    direct_generation_started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  next.segments = (next.segments || []).map((segment) => {
    const previousMetadata = manualContinueMetadata(segment);
    if (isUnconsumedSegmentEligibleForManualContinue(segment, previousMetadata)) {
      return {
        ...segment,
        state: "pending",
        qc_status: "pending",
        previous_remote_task_id:
          previousMetadata?.taskId || segment.remote_task_id || null,
        previous_failure_confirmed_zero_cost:
          previousMetadata?.status === "failed" ? true : undefined,
        remote_task_id: null,
        error: null,
      };
    }
    if (
      segment.state === "failed" &&
      isTalkingHeadCapacityWait(segment.error || job.error || "")
    ) {
      return {
        ...segment,
        state: "waiting_capacity",
        qc_status: "waiting_for_provider_capacity",
        error: null,
      };
    }
    return segment;
  });
  if (!next.is_long && !next.segments?.length) {
    next.segments = [
      {
        id: "S01",
        index: 0,
        start: 0,
        end: next.measured_duration,
        content_duration: next.measured_duration,
        generation_duration: next.duration,
        state: "pending",
        qc_status: "pending",
        audio: next.audio,
        output: next.output,
        estimated_rh_coins: next.estimated_rh_coins,
      },
    ];
    next.final_output = join(
      next.candidate_dir,
      `${talkingModeLabel(next.mode)}口播_完整成片.mp4`,
    );
  }
  writeJson(path, next);
  launchTalkingHeadSegments(root, id);
  return next;
}

export function regenerateNativeTalkingHeadVersion(root, id, { reason = "" } = {}) {
  const path = join(root, `${id}.json`);
  const job = getTalkingHeadJob(root, id);
  if (!job) throw new Error("没有找到这次口播任务。");
  if (job.mode !== "native")
    throw new Error("当前只开放原生口播沿用同一资料新增一个不同版本。");
  if (job.state !== "completed" || !existsSync(job.output))
    throw new Error("当前视频尚未返回，不能创建新版本。");
  requireTalkingConfiguration();
  const version = (job.generation_versions?.length || 0) + 2;
  const prompt = join(job.process_dir, `native_prompt_v${version}.txt`);
  const output = join(job.candidate_dir, `原生口播_10秒候选_V${version}.mp4`);
  const dialogue = readFileSync(job.script_file, "utf8").trim();
  writeFileSync(prompt, compileNativeVersionPrompt(job, dialogue), { flag: "wx" });
  const versionBudget = nativeVideoBudget(
    job.quality_mode,
    job.native_run_strategy,
    job.native_workflow_variant,
  );
  const next = {
    ...job,
    budget_limit: versionBudget,
    estimated_rh_coins: versionBudget,
    generation_versions: [
      ...(job.generation_versions || []),
      {
        version: version - 1,
        output: job.output,
        remote_task_id: job.remote_task_id || null,
        usage: job.usage || null,
        state: "completed_not_adopted",
        finished_at: job.finished_at || null,
        rework_reason: String(reason || "").trim().slice(0, 200) || null,
        generation_seed: job.generation_seed ?? null,
        variation_mode: job.variation_mode || (version - 1 === 1 ? "workflow_default" : "new_random_version"),
      },
    ],
    current_version: version,
    generation_seed: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
    variation_mode: "new_random_version",
    prompt,
    output,
    final_output: output,
    segments: [],
    state: "preflight",
    remote_task_id: null,
    usage: null,
    error: null,
    finished_at: null,
    artifact_registration: null,
    artifact_registration_error: null,
    updated_at: new Date().toISOString(),
  };
  writeJson(path, next);
  return startDirectTalkingHeadProduction(root, id);
}

export function startTalkingHeadVoiceJob(root, id) {
  const path = join(root, `${id}.json`);
  const job = getTalkingHeadJob(root, id);
  if (!job) throw new Error("没有找到这次口播任务。");
  if (job.speech_source !== "clone") throw new Error("这不是声音克隆任务。");
  if (["voice_running", "voice_review"].includes(job.state)) return job;
  if (job.state !== "voice_preflight")
    throw new Error("当前状态不能再次提交声音任务。");
  requireTalkingConfiguration();
  job.state = "voice_running";
  job.voice_state = "running";
  job.voice_started_at = new Date().toISOString();
  writeJson(path, job);
  void runProviderCommandWithCapacityWait(voiceCommandFor(job, true), () => {
    const waiting = getTalkingHeadJob(root, id) || job;
    waiting.capacity_state = "waiting_for_provider_capacity";
    waiting.error = null;
    writeJson(path, waiting);
  })
    .then((stdout) => {
      const fresh = getTalkingHeadJob(root, id) || job;
      fresh.voice_finished_at = new Date().toISOString();
      fresh.voice_log = String(stdout || "").slice(-4000);
      fresh.capacity_state = null;
      if (existsSync(fresh.voice_output)) {
        fresh.state = "voice_review";
        fresh.voice_state = "review";
      } else {
        fresh.state = "voice_failed";
        fresh.voice_state = "failed";
        fresh.error = "平台任务结束，但没有找到返回音频。";
      }
      const reconciled = reconcileJob(root, fresh);
      writeJson(path, reconciled);
    })
    .catch((error) => {
      const fresh = getTalkingHeadJob(root, id) || job;
      fresh.voice_finished_at = new Date().toISOString();
      fresh.state = "voice_failed";
      fresh.voice_state = "failed";
      fresh.capacity_state = null;
      fresh.error = String(error.message || error).slice(-2000);
      writeJson(path, fresh);
    });
  return job;
}

export function approveTalkingHeadVoice(root, id) {
  const path = join(root, `${id}.json`);
  const job = getTalkingHeadJob(root, id);
  if (!job) throw new Error("没有找到这次口播任务。");
  if (job.state !== "voice_review" || !existsSync(job.voice_output))
    throw new Error("声音尚未返回，暂时不能进入视频样片。");
  const measured = durationOf(job.voice_output);
  const duration =
    job.mode === "boutique"
      ? Math.min(8, Math.max(1, Math.floor(measured)))
      : Number(measured.toFixed(2));
  const prompt = join(job.process_dir, "performance_prompt.txt");
  if (!existsSync(prompt))
    writeFileSync(
      prompt,
      job.mode === "boutique"
        ? compileBoutiquePrompt(
            boutiqueCameraExperiments.has(job.boutique_camera_experiment)
              ? "stable_natural"
              : job.camera_continuity || "stable_natural",
          )
        : standardLowDirectorPrompt,
      { flag: "wx" },
    );
  const requestedGenerationStrategy = job.generation_strategy;
  const generationStrategyBlocked =
    job.mode === "boutique" &&
    job.generation_strategy === "direct_full" &&
    measured > 8 &&
    job.master_sample_status !== "passed";
  const generationStrategy = generationStrategyBlocked
    ? "sample_first"
    : job.generation_strategy;
  const output = join(
    job.candidate_dir,
    `${talkingModeLabel(job.mode)}口播_${generationStrategy === "direct_full" ? "完整成片" : "样片"}.mp4`,
  );
  const next = {
    ...job,
    state: "preflight",
    voice_state: "approved",
    voice_approved_at: new Date().toISOString(),
    audio: job.voice_output,
    original_audio: job.voice_output,
    measured_duration: Number(measured.toFixed(2)),
    duration,
    budget_limit:
      job.mode === "boutique"
        ? boutiqueVideoBudget(duration, job.quality_mode || "clear")
        : standardVideoBudget(duration, job.quality_mode || "daily"),
    estimated_rh_coins:
      job.mode === "boutique"
        ? boutiqueVideoBudget(duration, job.quality_mode || "clear")
        : standardVideoBudget(duration, job.quality_mode || "daily"),
    prompt,
    output,
    generation_strategy: generationStrategy,
    requested_generation_strategy: requestedGenerationStrategy,
    direct_generation_blocked_reason: generationStrategyBlocked
      ? "精品口播超过 8 秒直接生成时，这张人物母版必须已有合格样片；系统已改为先做样片。"
      : null,
    updated_at: new Date().toISOString(),
  };
  next.segments = longSegmentPlan(job.mode, measured, detectPauseCenters(job.voice_output));
  next.long_contract_version = 4;
  next.segmentation_basis = next.segments.length ? "natural_audio_pauses" : "single_segment";
  next.is_long = next.segments.length > 0;
  if (next.is_long) {
    next.final_output = join(job.candidate_dir, `${talkingModeLabel(job.mode)}口播_完整成片.mp4`);
    next.editing_state = "waiting_for_segments";
    prepareLongSegments(next);
    if (next.generation_strategy === "sample_first") prepareLongSample(next);
    next.estimated_rh_coins = (next.sample?.estimated_rh_coins || 0) + next.segments.reduce(
      (sum, segment) => sum + segment.estimated_rh_coins,
      0,
    );
  }
  const preflightJob =
    next.is_long && next.generation_strategy === "direct_full"
      ? {
          ...next,
          audio: next.segments[0].audio,
          output: next.segments[0].output,
          duration: next.segments[0].generation_duration,
          budget_limit: next.segments[0].estimated_rh_coins,
          formal_segment: true,
        }
      : next.generation_strategy === "direct_full"
        ? { ...next, formal_segment: true }
        : next;
  next.preflight = execFileSync("python3", commandFor(preflightJob, false), {
    encoding: "utf8",
  }).trim();
  writeJson(path, next);
  return next;
}

export function approveTalkingHeadVideo(
  root,
  id,
  { nativeDialogueConfirmed = false, version = null } = {},
) {
  const path = join(root, `${id}.json`);
  let job = getTalkingHeadJob(root, id);
  if (!job) throw new Error("没有找到这次口播任务。");
  if (job.state === "approved" && job.published_output) return job;
  if (isH3FixedCameraLongformCandidate(job) && job.state === "segment_review") {
    const route = job.h3_fixed_camera_longform;
    const preflight = jsonFile(route.aggregate_compose_preflight);
    const segmentOutputs = (job.segments || []).map((segment, index) => {
      if (!segment.output || !existsSync(segment.output))
        throw new Error(`第 ${index + 1} 段结果不可用，不能合成。`);
      return {
        index: index + 1,
        path: segment.output,
        sha256: createHash("sha256").update(readFileSync(segment.output)).digest("hex"),
      };
    });
    const checks = Object.fromEntries([
      "camera_geometry",
      "face_scale",
      "face_position",
      "background_geometry",
      "identity",
      "texture_cleanliness",
      "temporal_texture_drift",
      "lip_sync",
      "audio_intelligibility",
    ].map((name) => [name, "pass"]));
    writeJson(route.block_qc_report, {
      schema: "h3-independent-clean-block-candidate-qc-v1",
      master_image_sha256: preflight.master_image_sha256,
      target_workflow_sha256: preflight.target_workflow_sha256,
      candidates: [{
        candidate_id: `web-user-approved-${id}`,
        result_dir: route.result_dir,
        generation_seed: job.generation_seed,
        segment_outputs: segmentOutputs,
        frame_calibration_plan: [],
        qc_source: "user_reviewed_every_independent_segment",
        checks: {
          ...checks,
          generated_text: "absent",
          generated_objects: "absent",
          manual_review: "pass",
        },
      }],
    });
    execFileSync("python3", [
      h3FixedCameraLongformRunner,
      "block-candidate-gate",
      "--report",
      route.block_qc_report,
      "--master-image",
      job.image,
      "--output",
      route.block_gate_receipt,
    ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    execFileSync("python3", [
      h3FixedCameraLongformRunner,
      "compose",
      "--preflight",
      route.aggregate_compose_preflight,
      "--result-dir",
      route.result_dir,
      "--full-audio",
      route.full_audio,
      "--output",
      job.final_output,
      "--recipe",
      route.compose_recipe,
      "--block-gate-receipt",
      route.block_gate_receipt,
    ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    job = {
      ...job,
      state: "completed",
      output: job.final_output,
      qc_status: "user_approved_segments_compose_complete",
      editing_state: "review_pending",
      h3_fixed_camera_longform: {
        ...route,
        compose_status: "completed_review_pending",
      },
      updated_at: new Date().toISOString(),
    };
    writeJson(path, job);
    return job;
  }
  const recoverableUnsubmittedSegment =
    job.is_long &&
    job.state === "failed" &&
    job.sample?.qc_status === "approved_sample" &&
    job.segments?.some(
      (segment) =>
        segment.state === "running" &&
        !existsSync(segment.output) &&
        !existsSync(`${segment.output}.task.json`),
    );
  if (job.is_long && (job.state === "sample_review" || recoverableUnsubmittedSegment)) {
    const next = {
      ...job,
      state: "production_running",
      error: null,
      updated_at: new Date().toISOString(),
    };
    next.sample.state = "approved";
    next.sample.qc_status = "approved_sample";
    const invalidBoutiqueSegments =
      next.mode === "boutique" &&
      next.segments?.some(
        (segment) =>
          segment.content_duration > boutiqueFixedCameraEditingProfile.maximum_content_frames /
            boutiqueFixedCameraEditingProfile.frame_rate ||
          segment.input_duration > boutiqueFixedCameraEditingProfile.provider_maximum_seconds ||
          segment.generation_duration > boutiqueFixedCameraEditingProfile.provider_maximum_seconds ||
          !Number.isInteger(segment.content_frame_count) ||
          !Number.isFinite(segment.trim_start),
      );
    if (invalidBoutiqueSegments) {
      const revision = Number(next.segmentation_revision || 1) + 1;
      next.segments = longSegmentPlan(
        next.mode,
        durationOf(next.original_audio),
        detectPauseCenters(next.original_audio),
      );
      next.segmentation_revision = revision;
      next.segmentation_replanned_before_production = true;
      prepareLongSegments(next, `_r${revision}`);
      next.estimated_rh_coins =
        (next.sample?.estimated_rh_coins || 0) +
        next.segments.reduce((sum, segment) => sum + segment.estimated_rh_coins, 0);
    }
    next.segments = next.segments.map((segment) =>
      segment.state === "running" ? { ...segment, state: "pending" } : segment,
    );
    writeJson(path, next);
    launchTalkingHeadSegments(root, id);
    return next;
  }
  if (job.state !== "completed" || !existsSync(job.final_output || job.output))
    throw new Error("视频尚未返回，暂时不能采用。");
  if (job.mode === "native" && nativeDialogueConfirmed !== true)
    throw new Error(
      "请先完整听一遍，确认台词没有漏字、错字、重复、卡壳或结束后继续说话。",
    );
  const requestedVersion = Number.isInteger(Number(version))
    ? Number(version)
    : job.current_version || 1;
  const currentVersion = job.current_version || 1;
  const selectedVersion =
    requestedVersion === currentVersion
      ? { version: currentVersion, output: job.final_output || job.output }
      : job.generation_versions?.find((item) => item.version === requestedVersion);
  if (!selectedVersion?.output || !existsSync(selectedVersion.output))
    throw new Error("选择的历史版本当前不可用，请重新选择。");
  const publication = publishApprovedVideo({
    ...job,
    output: selectedVersion.output,
    final_output: selectedVersion.output,
  });
  const publishedOutput =
    publication.published_path ||
    publication.artifact?.published_path ||
    publication.output_path;
  if (!publishedOutput || !existsSync(publishedOutput))
    throw new Error("视频采用完成，但正式成果路径没有登记成功。");
  const next = {
    ...job,
    state: "approved",
    qc_status: "approved_by_user",
    approved_version: requestedVersion,
    native_dialogue_user_confirmed:
      job.mode === "native" ? true : job.native_dialogue_user_confirmed,
    approved_at: new Date().toISOString(),
    published_output: publishedOutput,
    publication,
    updated_at: new Date().toISOString(),
  };
  writeJson(path, next);
  return next;
}

async function execFilePromise(file, args) {
  return await new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message))) : resolve(stdout),
    );
  });
}

async function runRemainingSegments(root, id) {
  const path = join(root, `${id}.json`);
  try {
    let job = getTalkingHeadJob(root, id);
    const pendingSegments = job.segments.filter((segment) => segment.state !== "completed");
    const outcomes = await mapWithConcurrency(
      pendingSegments,
      job.concurrency || 1,
      async (segment) => {
        try {
          let current = getTalkingHeadJob(root, id);
          if (talkingHeadCancellationRequested(current))
            return { id: segment.id, ok: false, cancelled: true };
          let currentSegment = current.segments.find((item) => item.id === segment.id);
          currentSegment.state = "running";
          currentSegment.error = null;
          writeJson(path, current);
          const segmentJob = {
            ...current,
            audio: currentSegment.audio,
            output: currentSegment.output,
            prompt: currentSegment.prompt || current.prompt,
            script_file: currentSegment.script_file || current.script_file,
            duration: currentSegment.generation_duration,
            budget_limit: currentSegment.estimated_rh_coins,
            native_voice_mode:
              currentSegment.native_voice_mode || current.native_voice_mode,
            voice_reference:
              currentSegment.voice_reference || current.voice_reference,
            formal_segment: true,
          };
          const existingRemote = resumableRemoteTask(currentSegment.output);
          if (existingRemote && !existsSync(currentSegment.output)) {
            currentSegment.remote_task_id = existingRemote.taskId;
            currentSegment.recovery_mode = "resume_existing_remote_task";
            writeJson(path, current);
            await execFilePromise("python3", resumeCommandFor(currentSegment.output));
          } else if (!existsSync(currentSegment.output)) {
            await runProviderCommandWithCapacityWait(commandFor(segmentJob, true), () => {
              const waiting = getTalkingHeadJob(root, id);
              const waitingSegment = waiting.segments.find((item) => item.id === segment.id);
              waitingSegment.state = "waiting_capacity";
              waitingSegment.qc_status = "waiting_for_provider_capacity";
              waitingSegment.error = null;
              waiting.capacity_state = "waiting_for_provider_capacity";
              writeJson(path, waiting);
            });
          }
          if (!existsSync(currentSegment.output))
            throw new Error(`${currentSegment.id} 平台返回后没有找到视频。`);
          const metadata = existsSync(`${currentSegment.output}.task.json`)
            ? jsonFile(`${currentSegment.output}.task.json`)
            : {};
          current = getTalkingHeadJob(root, id);
          currentSegment = current.segments.find((item) => item.id === segment.id);
          currentSegment.state = "completed";
          currentSegment.qc_status =
            current.mode === "boutique" && current.camera_continuity === "strict_locked"
              ? "camera_stability_review_required"
              : "technical_pass_review_pending";
          currentSegment.usage = metadata.usage || null;
          currentSegment.remote_task_id = metadata.taskId || currentSegment.remote_task_id || null;
          current.capacity_state = null;
          if (currentSegment.recovery_mode)
            currentSegment.recovery_result = "existing_remote_task_recovered";
          writeJson(path, current);
          return { id: segment.id, ok: true };
        } catch (error) {
          const current = getTalkingHeadJob(root, id);
          const currentSegment = current.segments.find((item) => item.id === segment.id);
          if (talkingHeadCancellationRequested(current)) {
            currentSegment.state = "cancelled";
            currentSegment.qc_status = "cancelled_by_user";
            currentSegment.error = null;
            writeJson(path, current);
            return { id: segment.id, ok: false, cancelled: true };
          }
          const remote = resumableRemoteTask(currentSegment.output);
          currentSegment.state = remote ? "paused_remote_task_exists" : "failed";
          currentSegment.remote_task_id = remote?.taskId || currentSegment.remote_task_id || null;
          currentSegment.qc_status = remote
            ? "remote_status_query_interrupted"
            : "interrupted_before_submission";
          currentSegment.error = String(error.message || error).slice(-1000);
          writeJson(path, current);
          return { id: segment.id, ok: false, error: currentSegment.error };
        }
      },
    );
    job = getTalkingHeadJob(root, id);
    if (
      talkingHeadCancellationRequested(job) ||
      outcomes.some((item) => item.cancelled)
    ) {
      if (job.state !== "cancelled") {
        job.state = "cancelled";
        job.cancelled_at ||= new Date().toISOString();
        job.finished_at ||= job.cancelled_at;
        job.error =
          "已按你的要求停止；已完成片段继续保留，未开始的片段不会提交。";
        writeJson(path, job);
      }
      return;
    }
    const failures = outcomes.filter((item) => !item.ok);
    if (failures.length)
      throw new Error(
        `${failures.map((item) => item.id).join("、")} 生成失败；已完成片段继续保留，系统没有自动重试。`,
      );
    job = getTalkingHeadJob(root, id);
    if (job.segments.length === 1) {
      job.output = job.segments[0].output;
      job.final_output = job.output;
      job.formal_segment = false;
      job.state = "completed";
      job.editing_state = "review_pending";
      job.qc_status =
        job.mode === "boutique" && job.camera_continuity === "strict_locked"
          ? "camera_stability_review_required"
          : "final_review_pending";
      registerJobTrees(job);
      job.artifact_registration = "registered";
      writeJson(path, reconcileJob(root, job));
      return;
    }
    job.state = "editing_running";
    job.editing_state = job.mode === "native"
      ? "assembling_native_segment_audio"
      : "assembling_with_original_audio";
    writeJson(path, job);
    if (job.mode === "native") {
      const inputs = job.segments.flatMap((segment) => ["-i", segment.output]);
      const streams = job.segments.map((_, index) => `[${index}:v:0][${index}:a:0]`).join("");
      await execFilePromise(ffmpeg, [
        "-y", ...inputs,
        "-filter_complex", `${streams}concat=n=${job.segments.length}:v=1:a=1[v][a]`,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
        job.final_output,
      ]);
      job.output = job.final_output;
      job.formal_segment = false;
      job.state = "completed";
      job.editing_state = "review_pending";
      job.qc_status = "final_review_pending";
      job.seams = job.segments.slice(0, -1).map((segment, index) => ({
        id: `${segment.id}-${job.segments[index + 1].id}`,
        status: "native_audio_hard_cut_review_required",
        review: "pending_user_listening",
      }));
      job.usage = {
        consumeCoins: job.segments.reduce(
          (sum, segment) => sum + Number(segment.usage?.consumeCoins || 0),
          0,
        ),
      };
      job.budget_overrun_rh_coins = Math.max(
        0,
        Number(job.usage.consumeCoins || 0) - Number(job.estimated_rh_coins || 0),
      );
      job.budget_overrun = job.budget_overrun_rh_coins > 0;
      job.finished_at = new Date().toISOString();
      registerJobTrees(job);
      writeJson(path, job);
      return;
    }
    const concatList = join(job.process_dir, "long_segments.concat.txt");
    const editingDir = join(job.process_dir, "editing");
    mkdirSync(editingDir, { recursive: true });
    const seamOptimization =
      job.mode === "boutique"
        ? optimizeBoutiqueSegmentCuts(job.segments, editingDir)
        : { segments: job.segments, receipt: null };
    const editingSegments = seamOptimization.segments;
    const frameAlignedBoutique =
      job.mode === "boutique" &&
      editingSegments.every(
        (segment) =>
          Number.isInteger(segment.content_frame_count) &&
          Number.isFinite(segment.trim_start),
      );
    if (frameAlignedBoutique) {
      const videoInputs = editingSegments.flatMap((segment) => ["-i", segment.output]);
      const filters = editingSegments.map((segment, index) => {
        const trimStartFrame = Math.round(
          segment.trim_start * boutiqueFixedCameraEditingProfile.frame_rate,
        );
        const trimEndFrame = trimStartFrame + segment.content_frame_count;
        return `[${index}:v]fps=${boutiqueFixedCameraEditingProfile.frame_rate},trim=start_frame=${trimStartFrame}:end_frame=${trimEndFrame},setpts=PTS-STARTPTS[v${index}]`;
      });
      const concatInputs = editingSegments.map((_, index) => `[v${index}]`).join("");
      const audioInput = editingSegments.length;
      await execFilePromise(ffmpeg, [
        "-y", ...videoInputs, "-i", job.original_audio,
        "-filter_complex",
        `${filters.join(";")};${concatInputs}concat=n=${editingSegments.length}:v=1:a=0[v]`,
        "-map", "[v]", "-map", `${audioInput}:a:0`,
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", String(boutiqueFixedCameraEditingProfile.frame_rate),
        "-c:a", "aac", "-t", String(job.measured_duration),
        "-movflags", "+faststart", job.final_output,
      ]);
    } else {
      const trimmed = [];
      for (const segment of editingSegments) {
        const path = join(editingDir, `${segment.id}_trimmed.mp4`);
        await execFilePromise(ffmpeg, [
          "-y", "-i", segment.output, "-t", String(segment.content_duration),
          "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
          "-pix_fmt", "yuv420p", path,
        ]);
        trimmed.push(path);
      }
      writeFileSync(
        concatList,
        trimmed.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n") + "\n",
        "utf8",
      );
      await execFilePromise(ffmpeg, [
        "-y", "-f", "concat", "-safe", "0", "-i", concatList,
        "-i", job.original_audio, "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-t", String(job.measured_duration),
        "-movflags", "+faststart", job.final_output,
      ]);
    }
    job.output = job.final_output;
    job.formal_segment = false;
    job.state = "completed";
    job.editing_state = "review_pending";
    job.qc_status =
      job.mode === "boutique" && job.camera_continuity === "strict_locked"
        ? "camera_stability_review_required"
        : "final_review_pending";
    job.seam_optimization = seamOptimization.receipt;
    job.seams = editingSegments.slice(0, -1).map((segment, index) => ({
      id: `${segment.id}-${editingSegments[index + 1].id}`,
      status:
        seamOptimization.receipt?.reason === "completed"
          ? "automatic_face_state_cut_in_overlap"
          : "planned_boundary_fallback",
      review: "pending_visual_review",
    }));
    job.usage = {
      consumeCoins: Number(job.sample?.usage?.consumeCoins || 0) + job.segments.reduce((sum, segment) => sum + Number(segment.usage?.consumeCoins || 0), 0),
    };
    job.finished_at = new Date().toISOString();
    registerJobTrees(job);
    writeJson(path, job);
  } catch (error) {
    const job = getTalkingHeadJob(root, id);
    job.state = "failed";
    job.error = String(error.message || error).slice(-2000);
    job.editing_state = "failed";
    writeJson(path, job);
  }
}
