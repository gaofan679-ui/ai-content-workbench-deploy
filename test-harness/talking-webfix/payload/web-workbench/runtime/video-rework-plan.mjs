import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function discoverVideoReworkPlan({ task, taskDir }) {
  const request = task?.video_rework_request;
  if (request?.status !== "prepared") return null;
  const packRoot = join(taskDir, "07_generation_pack");
  if (!existsSync(packRoot)) return null;
  const candidates = readdirSync(packRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rework_preflight_"))
    .map((entry) => join(packRoot, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const directory of candidates) {
    const plan = planFromDirectory({ task, request, directory });
    if (plan) return plan;
  }
  return null;
}

export function prepareDirectRetryPlan({ task, taskDir, selectedSegmentIds }) {
  const packPath = task?.generation_pack_result?.artifacts?.find(
    (item) => item.label === "视频生成任务包",
  )?.path;
  if (!packPath || !existsSync(packPath)) throw new Error("VIDEO_GENERATION_PACK_MISSING");
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  const taskCards = pack.task_cards || pack.generation_tasks || pack.tasks || [];
  const assetManifestPath = join(dirname(packPath), "asset_binding_manifest.json");
  const manifestFile = existsSync(assetManifestPath)
    ? JSON.parse(readFileSync(assetManifestPath, "utf8"))
    : null;
  const assetManifest = Array.isArray(pack.asset_binding_manifest)
    ? pack.asset_binding_manifest
    : Array.isArray(manifestFile?.assets)
      ? manifestFile.assets
      : Array.isArray(manifestFile)
        ? manifestFile
        : [];
  const allSegmentIds = taskCards.map((_, index) =>
    `segment_${String(index + 1).padStart(2, "0")}`,
  );
  if (
    !selectedSegmentIds?.length ||
    selectedSegmentIds.some((segmentId) => !allSegmentIds.includes(segmentId))
  )
    throw new Error("VIDEO_DIRECT_RETRY_SEGMENT_INVALID");
  const version = nextVideoVersion(task);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const directory = join(taskDir, "07_generation_pack", `direct_retry_${stamp}_v${String(version).padStart(3, "0")}`);
  mkdirSync(directory, { recursive: true });
  const cards = selectedSegmentIds.map((segmentId) => {
    const original = taskCards[allSegmentIds.indexOf(segmentId)];
    if (!original) throw new Error(`VIDEO_DIRECT_RETRY_CARD_MISSING:${segmentId}`);
    const latestRework = latestReworkCard(taskDir, segmentId);
    const references = latestRework?.upload_order_plan?.length
      ? latestRework.upload_order_plan
        : (original.references || []).map((assetId, index) => {
          const asset = assetManifest.find(
            (item) => item.asset_id === assetId || item.alias === assetId,
          );
          if (!asset) throw new Error(`VIDEO_DIRECT_RETRY_ASSET_MISSING:${assetId}`);
          return {
            image_index: index + 1,
            role: asset.role,
            alias: asset.alias,
            path: asset.path,
          };
        });
    const card = {
      schema_version: "direct-retry-task-card-v1",
      task_id: `${segmentId}_direct_retry_v${version}`,
      original_segment_id: segmentId,
      scope: `只重新生成第 ${Number(segmentId.slice(-2))} 段；所有旧版本继续保留`,
      provider: original.provider || task.generation_provider,
      model_key: original.model_key || task.generation_model_key,
      quality_profile: original.quality_profile || task.generation_quality_profile || "high",
      duration_seconds: Number(original.duration_seconds),
      trim_to_seconds: Number(original.trim_to_seconds || original.original_target_duration_seconds || original.duration_seconds),
      aspect_ratio: original.aspect_ratio || "9:16",
      automatic_retry: false,
      submission_count: 1,
      preflight_status: "pass_ready_for_billable_confirmation",
      external_request_started: false,
      upload_order_plan: references,
      prompt_summary: String(latestRework?.prompt_summary || original.model_prompt || "").trim(),
      root_fix: "内容、提示词和素材职责保持不变，本次只重新抽取一个候选版本。",
      estimated_cost_rh_coins: latestRework?.estimated_cost_rh_coins || "以提交前平台预检为准",
      direct_retry: true,
    };
    if (!card.prompt_summary || !card.upload_order_plan.length)
      throw new Error(`VIDEO_DIRECT_RETRY_CARD_INCOMPLETE:${segmentId}`);
    const path = join(directory, `${segmentId}_rework.json`);
    writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`);
    return { path, value: card };
  });
  return planFromCards({ task, request: task.video_rework_request, directory, cards, directRetry: true });
}

function planFromDirectory({ task, request, directory }) {
  const selected = request.selected_segment_ids || [];
  const cards = selected.map((segmentId) => {
    const path = join(directory, `${segmentId}_rework.json`);
    if (!existsSync(path)) return null;
    try {
      return { path, value: JSON.parse(readFileSync(path, "utf8")) };
    } catch {
      return null;
    }
  });
  if (cards.some((card) => !card)) return null;
  if (
    cards.some(
      ({ value }, index) =>
        value.original_segment_id !== selected[index] ||
        value.preflight_status !== "pass_ready_for_billable_confirmation" ||
        value.external_request_started !== false,
    )
  )
    return null;
  return planFromCards({ task, request, directory, cards, directRetry: false });
}

function planFromCards({ task, request, directory, cards, directRetry }) {
  const selected = request.selected_segment_ids || [];
  const fingerprint = createHash("sha256").update(cards.map(({ path }) => readFileSync(path)).join("\n")).digest("hex");
  const segmentPlans = cards.map(({ value }) => ({
    segment_id: value.original_segment_id,
    duration_seconds: Number(value.duration_seconds || 0),
    trim_to_seconds: Number(value.trim_to_seconds || value.duration_seconds || 0),
    root_fix: String(value.root_fix || "").trim(),
    prompt_summary: String(value.prompt_summary || "").trim(),
    upload_assets: (value.upload_order_plan || []).map((asset) => ({
      image_index: Number(asset.image_index),
      role: String(asset.role || ""),
      alias: String(asset.alias || ""),
    })),
    estimated_cost_rh_coins: String(value.estimated_cost_rh_coins || ""),
    submission_count: Number(value.submission_count || 1),
  }));
  const timelineSegments = originalTimeline(task).map((segment, index, all) => ({
    ...segment,
    start_seconds: Number(
      all.slice(0, index).reduce((sum, item) => sum + item.target_duration_seconds, 0).toFixed(3),
    ),
    end_seconds: Number(
      all.slice(0, index + 1).reduce((sum, item) => sum + item.target_duration_seconds, 0).toFixed(3),
    ),
  }));
  return {
    schema_version: 1,
    status: "ready_for_confirmation",
    mode: directRetry ? "direct_retry" : "analyzed_rework",
    source_fingerprint: fingerprint,
    prepared_at: new Date(
      Math.max(...cards.map(({ path }) => statSync(path).mtimeMs)),
    ).toISOString(),
    source_directory: basename(directory),
    selected_segment_ids: selected,
    preserved_segment_ids: request.preserved_segment_ids || [],
    provider: cards[0].value.provider,
    model_key: cards[0].value.model_key,
    quality_profile: cards[0].value.quality_profile,
    estimated_submission_count: segmentPlans.reduce(
      (sum, segment) => sum + segment.submission_count,
      0,
    ),
    estimated_cost_cny_reference: Number(task.estimated_cost_cny || 0),
    automatic_retry: false,
    external_request_started: false,
    version_contract: {
      base_version: Math.max(1, nextVideoVersion(task) - 1),
      next_version: nextVideoVersion(task),
      preserve_base_version: true,
      preserve_all_versions: true,
      replace_selected_segments_only: true,
      restitch_after_generation: true,
    },
    segment_plans: segmentPlans,
    timeline_segments: timelineSegments,
  };
}

function latestReworkCard(taskDir, segmentId) {
  const packRoot = join(taskDir, "07_generation_pack");
  if (!existsSync(packRoot)) return null;
  const candidates = readdirSync(packRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^(rework_preflight_|direct_retry_)/.test(entry.name))
    .map((entry) => join(packRoot, entry.name, `${segmentId}_rework.json`))
    .filter(existsSync)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const path of candidates) {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* try older */ }
  }
  return null;
}

export function nextVideoVersion(task) {
  let current = (task?.artifacts || []).some((item) => item.stage === "video_generation") ? 1 : 0;
  for (const artifact of task?.artifacts || []) {
    const match = String(artifact.label || "").match(/^版本\s*(\d+)/);
    if (match) current = Math.max(current, Number(match[1]));
  }
  return Math.max(2, current + 1);
}

function originalTimeline(task) {
  const packPath = task.generation_pack_result?.artifacts?.find(
    (item) => item.label === "视频生成任务包",
  )?.path;
  if (packPath && existsSync(packPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packPath, "utf8"));
      const cards = parsed.task_cards || parsed.generation_tasks || parsed.tasks || [];
      if (Array.isArray(cards) && cards.length) {
        return cards.map((card, index) => ({
          segment_id: `segment_${String(index + 1).padStart(2, "0")}`,
          target_duration_seconds: Number(
            card.trim_to_seconds || card.original_target_duration_seconds || card.duration_seconds || 0,
          ),
          generated_duration_seconds: Number(card.duration_seconds || 0),
        }));
      }
    } catch {
      // A missing historical timeline only removes exact positions; it must not invent them.
    }
  }
  return (task.generation_pack_result?.submission_preview?.segment_durations_seconds || []).map(
    (duration, index) => ({
      segment_id: `segment_${String(index + 1).padStart(2, "0")}`,
      target_duration_seconds: Number(duration || 0),
      generated_duration_seconds: Number(duration || 0),
    }),
  );
}
