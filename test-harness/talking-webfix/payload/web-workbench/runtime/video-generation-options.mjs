import { execFileSync, spawnSync } from "node:child_process";

const DEFAULT_LIBTV = "libtv";
const SUPPORTED_KEYS = new Set(["star-video2-mini", "star-video2-fast", "star-video2", "star-video2.5"]);
const QUALITY_PROFILES = {
  normal: { label: "普通", libtvResolution: "480p", runninghubResolution: "0.6MP" },
  high: { label: "高清", libtvResolution: "720p", runninghubResolution: "1.0MP" },
  ultra: { label: "超清", libtvResolution: "1080p", runninghubResolution: "1.5MP" },
};
const CACHE_TTL_MS = 5 * 60 * 1000;
const H3_MAX_DURATION_SECONDS = 15;
const H3_EDGE_OVERRUN_TOLERANCE_SECONDS = 0.25;
let cachedCatalog = null;
let cachedAt = 0;

export function loadVideoModelCatalog({ env = process.env, force = false } = {}) {
  if (!force && cachedCatalog && Date.now() - cachedAt < CACHE_TTL_MS) return cachedCatalog;
  if (env.WORKBENCH_VIDEO_MODELS_JSON) {
    const parsed = JSON.parse(env.WORKBENCH_VIDEO_MODELS_JSON);
    cachedCatalog = normalizeFixtureCatalog(parsed);
    cachedAt = Date.now();
    return cachedCatalog;
  }
  const cli = env.WORKBENCH_LIBTV_CLI || DEFAULT_LIBTV;
  let models = [];
  let source = "libtv_cli";
  let unavailableReason = null;
  try {
    const search = JSON.parse(execFileSync(cli, ["model", "search", "--type", "video", "Seedance"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    const matches = (search.matches || []).filter((item) => SUPPORTED_KEYS.has(item.modelKey));
    models = matches.map((item) => {
      const detail = JSON.parse(execFileSync(cli, ["model", item.modelKey], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
      return normalizeModel(item, detail.schema || {});
    });
  } catch (error) {
    source = "libtv_cli_unavailable";
    unavailableReason = error?.code || error?.message || "LIBTV_VIDEO_MODELS_UNAVAILABLE";
  }
  if (!models.length && source === "libtv_cli") {
    source = "libtv_cli_unavailable";
    unavailableReason = "LIBTV_VIDEO_MODELS_UNAVAILABLE";
  }
  cachedCatalog = { source, checked_at: new Date().toISOString(), models, unavailable_reason: unavailableReason };
  cachedAt = Date.now();
  return cachedCatalog;
}

export function resolveVideoGenerationSelection({ generationRouteChoice, generationModelKey, generationProvider = "libtv", qualityProfile = "high", referenceVideoPath, env = process.env }) {
  if (!["smoke_test_first", "in_chat_libtv_generation"].includes(generationRouteChoice)) throw new Error("GENERATION_ROUTE_INVALID");
  if (!["libtv", "runninghub_h3_multiref"].includes(generationProvider)) throw new Error("GENERATION_PROVIDER_INVALID");
  const quality = QUALITY_PROFILES[qualityProfile];
  if (!quality) throw new Error("GENERATION_QUALITY_INVALID");
  const sourceDurationSeconds = generationRouteChoice === "smoke_test_first" ? 4 : probeDuration(referenceVideoPath, env);
  const h3MarginalOverrun = generationProvider === "runninghub_h3_multiref"
    && generationRouteChoice === "in_chat_libtv_generation"
    && sourceDurationSeconds > H3_MAX_DURATION_SECONDS
    && sourceDurationSeconds <= H3_MAX_DURATION_SECONDS + H3_EDGE_OVERRUN_TOLERANCE_SECONDS;
  const targetDurationSeconds = h3MarginalOverrun ? H3_MAX_DURATION_SECONDS : sourceDurationSeconds;
  const requestDurationSeconds = generationRouteChoice === "smoke_test_first" ? 4 : Math.ceil(targetDurationSeconds);
  if (generationProvider === "runninghub_h3_multiref") {
    if (requestDurationSeconds < 1) throw new Error(`GENERATION_MODEL_DURATION_UNSUPPORTED:${requestDurationSeconds}:15`);
    return {
      provider: generationProvider,
      provider_label: "RunningHub H3 多参考图（实验）",
      provider_status: "personal_candidate",
      model_key: "minimax-h3-multiref-owned-clean",
      model_name: "MiniMax H3 多参考图",
      alias_name: "MiniMax H3 多参考图",
      description: "可使用清晰人物、分镜与材质参考，不需要红线或网格安全图。",
      duration_min: 1,
      duration_max: 15,
      resolutions: Object.values(QUALITY_PROFILES).map((item) => item.runninghubResolution),
      ratios: ["9:16"],
      image_max: 3,
      video_max: 0,
      audio_max: 0,
      catalog_source: "runninghub_h3_contract",
      catalog_checked_at: new Date().toISOString(),
      generation_route_choice: generationRouteChoice,
      quality_profile: qualityProfile,
      quality_label: quality.label,
      target_duration_seconds: targetDurationSeconds,
      request_duration_seconds: requestDurationSeconds,
      source_duration_seconds: sourceDurationSeconds,
      segmented_full_sequence_required: generationRouteChoice === "in_chat_libtv_generation" && requestDurationSeconds > H3_MAX_DURATION_SECONDS,
      marginal_overrun_compacted_to_single_task: h3MarginalOverrun,
      marginal_overrun_tolerance_seconds: H3_EDGE_OVERRUN_TOLERANCE_SECONDS,
      maximum_segment_duration_seconds: H3_MAX_DURATION_SECONDS,
      resolution: quality.runninghubResolution,
      aspect_ratio: "9:16",
      generate_audio: true,
    };
  }
  const catalog = loadVideoModelCatalog({ env });
  const model = catalog.models.find((item) => item.model_key === generationModelKey);
  if (!model) throw new Error("GENERATION_MODEL_UNAVAILABLE");
  if (requestDurationSeconds < model.duration_min || requestDurationSeconds > model.duration_max) {
    throw new Error(`GENERATION_MODEL_DURATION_UNSUPPORTED:${requestDurationSeconds}:${model.duration_max}`);
  }
  if (!model.resolutions.includes(quality.libtvResolution)) throw new Error(`GENERATION_MODEL_RESOLUTION_UNSUPPORTED:${quality.libtvResolution}`);
  if (!model.ratios.includes("9:16")) throw new Error("GENERATION_MODEL_VERTICAL_UNSUPPORTED");
  return {
    ...model,
    provider: generationProvider,
    provider_label: "LibTV / Seedance",
    provider_status: "formal",
    catalog_source: catalog.source,
    catalog_checked_at: catalog.checked_at,
    generation_route_choice: generationRouteChoice,
    target_duration_seconds: targetDurationSeconds,
    request_duration_seconds: requestDurationSeconds,
    quality_profile: qualityProfile,
    quality_label: quality.label,
    resolution: quality.libtvResolution,
    aspect_ratio: "9:16",
    generate_audio: true,
  };
}

export function resolveExistingVideoGenerationSelection(task, { env = process.env } = {}) {
  const generationProvider =
    task?.generation_model_snapshot?.provider ||
    task?.generation_provider ||
    task?.video_generation_result?.provider ||
    "libtv";
  const generationModelKey =
    task?.generation_model_key || task?.video_generation_result?.model_key;
  if (!generationModelKey && generationProvider === "libtv")
    throw new Error("GENERATION_MODEL_REQUIRED");
  return resolveVideoGenerationSelection({
    generationRouteChoice: "in_chat_libtv_generation",
    generationModelKey,
    generationProvider,
    qualityProfile:
      task?.generation_model_snapshot?.quality_profile ||
      task?.generation_quality_profile ||
      "high",
    referenceVideoPath: task?.reference_video_path,
    env,
  });
}

function normalizeModel(searchItem, schema) {
  const properties = schema.properties || {};
  return {
    model_key: searchItem.modelKey,
    model_name: searchItem.modelName,
    alias_name: searchItem.aliasName || searchItem.modelName,
    description: searchItem.description || "",
    duration_min: Number(properties.duration?.min || 4),
    duration_max: Number(properties.duration?.max || 15),
    resolutions: enumValues(properties.resolution?.enum),
    ratios: enumValues(properties.ratio?.enum),
    image_max: Number(properties.modeType?.mixed2videoConfig?.imageMax || 0),
    video_max: Number(properties.modeType?.mixed2videoConfig?.videoMax || 0),
    audio_max: Number(properties.modeType?.mixed2videoConfig?.audioMax || 0),
  };
}

function normalizeFixtureCatalog(value) {
  const models = Array.isArray(value) ? value : value.models;
  if (!Array.isArray(models) || !models.length) throw new Error("VIDEO_MODEL_FIXTURE_INVALID");
  return { source: "test_fixture", checked_at: new Date().toISOString(), models };
}

function enumValues(values = []) {
  return values.map((item) => typeof item === "string" ? item : item.value).filter(Boolean);
}

function probeDuration(path, env) {
  if (!path) return 10;
  const probeCommand = env.WORKBENCH_FFPROBE || "ffprobe";
  const probe = spawnSync(probeCommand, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8", timeout: 10_000 });
  const duration = Number(String(probe.stdout || "").trim());
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : 10;
}
