"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import WorkspaceIcon from "./workspace-icon";
import { isCompleteTalkingVideo, talkingResultMedia, talkingSubmissionPlan, talkingSampleChoice, missingTalkingFileHints, talkingSubmissionSummary } from "./talking-presentation";
import {
  ModelAssetStudio,
  isImportedMasterProject,
  modelProjectSourceLabel,
  modelProjectStatus,
  modelProjectComplete,
  modelProjectFinalAsset,
  type ModelAssetProject,
} from "./model-asset-studio";
import { XhsJewelryStudio, statusLabel as jewelryStatusLabel, type JewelryTask } from "./xhs-jewelry-studio";

import { useDialogFocus } from "./use-dialog-focus";

const API = process.env.NEXT_PUBLIC_WORKBENCH_API || "http://127.0.0.1:4318";

type Artifact = {
  id: number;
  stage: string;
  label: string;
  path: string;
  published: number;
};
type VideoReworkPlan = {
  schema_version: number;
  status: "ready_for_confirmation" | "running" | "completed";
  mode?: "direct_retry" | "analyzed_rework";
  prepared_at: string;
  selected_segment_ids: string[];
  preserved_segment_ids: string[];
  provider: "libtv" | "runninghub_h3_multiref";
  model_key: string;
  quality_profile: "normal" | "high" | "ultra";
  estimated_submission_count: number;
  estimated_cost_cny_reference: number;
  automatic_retry: boolean;
  external_request_started: boolean;
  last_failure_after_submission?: boolean;
  version_contract: {
    base_version: number;
    next_version: number;
    preserve_base_version: boolean;
    preserve_all_versions?: boolean;
    replace_selected_segments_only: boolean;
    restitch_after_generation: boolean;
  };
  segment_plans: Array<{
    segment_id: string;
    duration_seconds: number;
    trim_to_seconds: number;
    root_fix: string;
    prompt_summary: string;
    upload_assets: Array<{ image_index: number; role: string; alias: string }>;
    estimated_cost_rh_coins: string;
    submission_count: number;
  }>;
  timeline_segments: Array<{
    segment_id: string;
    target_duration_seconds: number;
    generated_duration_seconds: number;
    start_seconds: number;
    end_seconds: number;
  }>;
};
type TaskEvent = {
  id: number;
  event_type: string;
  level: string;
  message: string;
  created_at: string;
};
type UserState = {
  key: "processing" | "confirmation" | "assistance";
  label: string;
  tone: string;
  headline: string;
  summary: string;
  next_step: string;
  needs_attention: boolean;
};
type WorkflowHandoff = {
  schema_version: 1;
  handoff_id: string;
  responsibility: { stage: string; owner_skill: string };
  execution: {
    external_request_started: boolean | null;
    billable_submission_count: number | null;
    automatic_retry: false;
    remote_task_ids: string[];
  };
  outcome: {
    state:
      | "needs_user_choice"
      | "blocked_local"
      | "blocked_external"
      | "failed_after_submit";
    user_summary: string;
    next_action: string;
  };
};
type SubmissionPreview = {
  provider: "libtv" | "runninghub_h3_multiref";
  model_key: string;
  model_name: string;
  sample_type: string;
  duration_seconds: number;
  aspect_ratio: string;
  resolution: string;
  generation_kind?: "smoke_test" | "full_sequence";
  target_duration_seconds?: number;
  generate_audio: boolean;
  generation_count: number;
  segment_durations_seconds?: number[];
  effective_concurrency?: number;
  upload_assets: Array<{ alias: string; role: string; filename: string }>;
  billable_submission_count_allowed: number;
  automatic_retry: boolean;
  project_binding_status: string;
  cost_quote_status: string;
  billable_submission_allowed: boolean;
  project_uuid?: string;
  project_name?: string;
  project_selection_mode?: "explicit_per_task";
};
type StageResult = {
  status: string;
  summary: string;
  estimated_cost_cny: number;
  user_message: string;
  artifacts: Array<{ label: string; path: string; published: boolean }>;
  required_assets?: string[];
  missing_assets?: string[];
  checkpoint_resume_available?: boolean;
  checkpoint_source_run_id?: string;
  business_qc_status?: "pass" | "needs_rework" | "blocked";
  decision?: "pass" | "reject" | "review";
  submission_preview?: SubmissionPreview;
  duration_seconds?: number;
} | null;
type GenerationProvider = "codex_builtin" | "chatgpt_web";
type RemixPrecisionRoute = "anchor_frame_alignment" | "prompt_driven_remix";
type SceneRoute =
  | "source_like"
  | "auto_match"
  | "user_location"
  | "described_scene";
type ScriptRoute =
  | "keep_structure"
  | "auto_rewrite"
  | "partial_adjustment"
  | "use_own_copy";
type RemixChangeContract = {
  schema_version: 1;
  production_preference: RemixPrecisionRoute;
  product: {
    mode: "keep_original_style" | "replace_product" | "exact_original";
    scope: Task["product_scope"];
    brief: string;
    image_paths: string[];
  };
  person: {
    mode: NonNullable<Task["person_route"]>;
    brief: string;
    source_image_paths: string[];
    authorization_confirmed: boolean;
  };
  scene: { mode: SceneRoute; brief: string; image_paths: string[] };
  script: { mode: ScriptRoute; brief: string };
};
type GenerationRoute =
  "smoke_test_first" | "full_external_manual" | "in_chat_libtv_generation";
type VideoModelOption = {
  model_key: string;
  model_name: string;
  alias_name: string;
  description: string;
  duration_min: number;
  duration_max: number;
  resolutions: string[];
  ratios: string[];
  image_max: number;
  video_max: number;
  audio_max: number;
};
type VideoGenerationSelection = {
  generationRouteChoice: "smoke_test_first" | "in_chat_libtv_generation";
  generationModelKey: string;
  generationProvider: "libtv" | "runninghub_h3_multiref";
  qualityProfile: "normal" | "high" | "ultra";
};
type VideoReworkRequest = {
  status: "prepared";
  created_at: string;
  selected_segment_ids: string[];
  preserved_segment_ids: string[];
  issue_codes: string[];
  note: string;
  provider: "libtv" | "runninghub_h3_multiref";
  model_key: string | null;
  quality_profile: "normal" | "high" | "ultra";
  estimated_submission_count: number;
  resolution_mode?: "direct_retry" | "analyze_then_retry";
  automatic_retry: false;
  external_request_started: false;
};
type TalkingMode = "standard" | "boutique" | "native" | "singing";
type TalkingTargetRatio = "9:16" | "3:4" | "4:3" | "16:9";
type TalkingStage =
  | "mode"
  | "setup"
  | "preflight"
  | "sample"
  | "production"
  | "qc"
  | "editing"
  | "result";
type TalkingHeadPersonAsset = {
  asset_id: string;
  project_id: string;
  asset_type: "talking_head_drive_master";
  route: "uploaded_master";
  source_kind: "user_upload";
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: "stored_unconfirmed" | "bound_to_talking_project";
  created_at: string;
};
type TalkingGenerationVersion = {
  version: number;
  output: string;
  remote_task_id?: string | null;
  usage?: { consumeCoins?: string | number; taskCostTime?: string | number } | null;
  state?: string;
  finished_at?: string | null;
  rework_reason?: string | null;
  generation_seed?: number | null;
  variation_mode?: "workflow_default" | "new_random_version" | string;
};
type TalkingJob = {
  generation_configuration?: { status: "present" | "missing" | "unverified"; message: string };
  confirmed_script?: string;
  reference_audio_transcript?: string;
  id: string;
  project_name?: string;
  state:
    | "voice_preflight"
    | "voice_running"
    | "voice_review"
    | "voice_failed"
    | "preflight"
    | "running"
    | "sample_running"
    | "sample_review"
    | "segment_review"
    | "production_running"
    | "editing_running"
    | "completed"
    | "approved"
    | "failed"
    | "cancel_requested"
    | "cancelled";
  mode: TalkingMode;
  execution_contract?: {
    contract_version: number;
    mode: "standard" | "boutique" | "native";
    backend_route: string;
    workflow_id: string;
    speech_authority: "confirmed_audio" | "exact_dialogue_prompt";
    prompt_authority: "performance_only" | "provider_compiler_only";
  };
  speech_source?:
    | "clone"
    | "audio"
    | "native_reference"
    | "native_natural"
    | "native_two_speaker_mixed_voice";
  voice_language_mode?: "mandarin" | "dialect";
  voice_dialect?: string | null;
  voice_clone_route?: "legacy" | "fidelity" | "expressive";
  voice_emotion_preset?: "natural" | "happy" | "urgent" | "calm" | "wronged" | "angry" | null;
  voice_speech_pace?: "slow" | "normal" | "fast" | null;
  dialect_script_confirmed?: boolean | null;
  voice_budget_limit?: number;
  native_voice_mode?: "random" | "reference";
  native_dialogue_mode?: "single" | "two_speaker_alternating";
  native_dialogue_style?: "natural_interview" | "structured_discussion" | null;
  native_neutral_hand_pose_confirmed?: boolean;
  native_duration_planning?: "fixed_10_verified" | "adaptive_6_15_candidate";
  native_run_strategy?: "economy" | "stable";
  performance_requirement?: string;
  quality_mode?: "daily" | "clear" | "premium" | null;
  target_ratio?: TalkingTargetRatio;
  concurrency?: 1 | 3 | 5;
  generation_strategy?: "sample_first" | "direct_full";
  camera_continuity?: "natural" | "stable_natural" | "handheld_selfie" | "walk_and_talk" | "strict_locked";
  boutique_camera_experiment?: string | null;
  native_workflow_variant?:
    | "production"
    | "composition_anchor_v0_1"
    | "composition_first_last_v0_2";
  requested_generation_strategy?: "sample_first" | "direct_full";
  direct_generation_acknowledged?: boolean;
  direct_generation_blocked_reason?: string | null;
  master_sample_status?: "new" | "passed";
  image?: string;
  person_asset?: TalkingHeadPersonAsset | null;
  duration?: number;
  measured_duration?: number;
  estimated_rh_coins: number;
  created_at?: string;
  updated_at?: string;
  output?: string;
  published_output?: string;
  error?: string;
  budget_overrun?: boolean;
  budget_overrun_rh_coins?: number;
  is_long?: boolean;
  editing_state?: string;
  final_output?: string;
  sample?: {
    duration: number;
    state: string;
    qc_status: string;
    estimated_rh_coins: number;
  };
  segments?: Array<{
    id: string;
    start: number;
    end: number;
    content_duration: number;
    generation_duration: number;
    state: string;
    qc_status: string;
    estimated_rh_coins?: number;
    dialogue?: string;
    hanzi_count?: number;
    duration_evidence?: "verified_10s" | "projected_requires_paid_validation" | string;
    speaker_side?: "left" | "right";
    native_voice_mode?: "random" | "reference";
    output?: string;
    remote_task_id?: string;
    usage?: {
      consumeCoins?: string | number;
      taskCostTime?: string | number;
    } | null;
  }>;
  seams?: Array<{ id: string; status: string; review: string }>;
  usage?: { consumeCoins?: string | number; taskCostTime?: string | number };
  voice_usage?: {
    consumeCoins?: string | number;
    taskCostTime?: string | number;
  };
  voice_output?: string;
  voice_state?: "preflight" | "running" | "review" | "approved" | "failed";
  qc_status?: string;
  current_version?: number;
  approved_version?: number;
  generation_seed?: number | null;
  variation_mode?: "workflow_default" | "new_random_version" | string;
  generation_versions?: TalkingGenerationVersion[];
  native_dialogue_user_confirmed?: boolean;
  voice_reference?: string | null;
  voice_reference_left?: string | null;
  voice_reference_right?: string | null;
  codex_thread_id?: string | null;
  codex_thread_name?: string | null;
  codex_thread_status?: "connecting" | "running" | "ready" | "failed" | null;
  codex_thread_initialized_at?: string | null;
  codex_thread_error?: string | null;
};
type PreviewWorkflowId =
  | "positioning"
  | "topics"
  | "copywriting"
  | "commerce"
  | "social-extract"
  | "xhs-remix"
  | "publishing"
  | "cover"
  | "image"
  | "model"
  | "live-photo"
  | "editing";
type PreviewWorkflow = {
  id: PreviewWorkflowId;
  group: "内容策划" | "图文增长" | "人物与视觉" | "视频制作";
  name: string;
  icon: string;
  tone: string;
  promise: string;
  description: string;
  inputs: string[];
  steps: string[];
  automatic: string[];
  confirmations: string[];
  outputs: string[];
};
type SocialExtraction = {
  id: string;
  title: string;
  source_text: string;
  source_url: string;
  extraction_scope: "copy_only" | "media_only" | "copy_and_media";
  downstream_use: string;
  download_authorized: boolean;
  status: "running" | "completed" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
  result: null | {
    platform: string;
    id: string;
    title: string;
    desc: string;
    hashtags: string[];
    author: string;
    stats: Record<string, number>;
    output_dir?: string;
    downloaded_files?: string[];
    decrypted_files?: string[];
    reused_from_extraction_id?: string;
    provider_usage?: {
      confirmed_cost_usd?: number;
      possible_cost_usd?: number;
      original_confirmed_cost_usd?: number;
    };
  };
};

function inspectLocalAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    const finish = (value: number | null) => {
      URL.revokeObjectURL(objectUrl);
      resolve(value);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () =>
      finish(
        Number.isFinite(audio.duration)
          ? Number(audio.duration.toFixed(1))
          : null,
      );
    audio.onerror = () => finish(null);
    audio.src = objectUrl;
  });
}

function balancedBoutiqueDurations(total: number): number[] {
  if (total <= 10) return [Number(total.toFixed(1))];
  const count = Math.ceil(total / (220 / 24));
  const base = total / count;
  return Array.from({ length: count }, (_, index) =>
    Number((index === count - 1 ? total - base * index : base).toFixed(1)),
  );
}
function talkingTotalCoins(job: TalkingJob): number | null {
  const voice = Number(job.voice_usage?.consumeCoins || 0);
  const video = talkingVideoCoins(job) || 0;
  return voice || video ? voice + video : null;
}
function talkingVideoCoins(job: TalkingJob): number | null {
  const recordedVideo = Number(job.usage?.consumeCoins || 0);
  const completedSegmentVideo = (job.segments || []).reduce(
    (sum, segment) => sum + Number(segment.usage?.consumeCoins || 0),
    0,
  );
  const video = recordedVideo || completedSegmentVideo;
  return video || null;
}
function talkingDisplayDuration(job: TalkingJob): number {
  return job.is_long && job.measured_duration
    ? Number(job.measured_duration.toFixed(1))
    : job.duration || 0;
}
function talkingActualConcurrency(job: TalkingJob): number {
  return Math.min(job.concurrency || 1, job.segments?.length || 1);
}

function talkingHeadFailureMessage(error?: string | null): string {
  const detail = String(error || "").trim();
  if (/RemoteDisconnected|ECONNRESET|socket hang up|closed connection/i.test(detail))
    return "平台查询连接刚才中断了。系统会先核对已经提交的任务，不会因此自动重复提交；已有结果和费用记录都保留。";
  if (/TASK_QUEUE_MAXED/.test(detail))
    return "平台当前任务较多，本次尚未重复提交；可以稍后按原设置继续。";
  if (/Traceback|File ".*", line|urllib\.|http\.client|node:internal/i.test(detail))
    return "这次执行被技术问题中断了。已有资料和结果仍保留，系统不会自动重复付费提交。";
  return detail || "这次没有返回可播放的视频。已有资料仍保留，系统没有自动重复提交。";
}

function talkingEmotionName(value?: string): string {
  return {
    natural: "自然讲述",
    happy: "开心分享",
    urgent: "着急解释",
    calm: "沉稳认真",
    wronged: "委屈说明",
    angry: "生气质问",
  }[value || "natural"] || "自然讲述";
}

function reworkCostLabel(value: string): string {
  const normalized = value.trim().replace(/^约\s*/, "").replace(/\s*RH\s*币.*$/i, "");
  return `约 ${normalized} RH 币`;
}
function normalizeTalkingTargetRatio(value?: string): TalkingTargetRatio {
  return (["9:16", "3:4", "4:3", "16:9"] as const).includes(
    value as TalkingTargetRatio,
  )
    ? (value as TalkingTargetRatio)
    : "9:16";
}
function restoredNativeScript(job: TalkingJob): string {
  const segments = (job.segments || []).filter((segment) => segment.dialogue?.trim());
  if (job.native_dialogue_mode === "two_speaker_alternating")
    return segments
      .map(
        (segment) =>
          `${segment.speaker_side === "right" ? "右" : "左"}：${segment.dialogue?.trim() || ""}`,
      )
      .join("\n");
  return segments.map((segment) => segment.dialogue?.trim() || "").join("");
}
function restoredTalkingStage(job: TalkingJob, current: TalkingStage): TalkingStage {
  if (current === "setup" || current === "mode") return current;
  if (job.state === "approved") return "result";
  if (["production_running", "cancel_requested", "cancelled"].includes(job.state))
    return "production";
  if (job.state === "editing_running") return "editing";
  if (["sample_review", "segment_review"].includes(job.state)) return "sample";
  if (job.state === "completed" && job.final_output)
    return "sample";
  if (!job.is_long) return current;
  return current;
}
type ProviderCapabilities = {
  codexBuiltinAvailable: boolean;
  codexBuiltinMessage: string;
  chatgptWebAvailable: boolean;
  chatgptWebMode: "simulation" | "live" | "companion";
  chatgptWebState: string;
  chatgptWebMessage: string;
};
type XhsJewelryCapability = {
  available: boolean;
  visible: boolean;
  state: string;
  userMessage: string;
};
type Task = {
  id: string;
  title: string;
  status: string;
  current_step: string;
  reference_video_path: string;
  product_brief: string;
  product_scope: "full_look" | "top_only" | "bottom_only" | "custom" | "unspecified";
  product_image_paths: string[];
  budget_limit_cny: number;
  remix_precision_route: RemixPrecisionRoute;
  managed_mode: boolean;
  setup_upload_authorized: boolean;
  planned_execution_authorized: boolean;
  default_image_generation_provider: GenerationProvider;
  rewrite_mode:
    "keep_original_style" | "replace_product" | "exact_original" | null;
  remix_change_contract: RemixChangeContract | null;
  continuation_choice: "continue_video" | "save_decomposition_only" | null;
  person_route:
    "authorized_person" | "auto_ai_person" | "generic_no_fixed_face" | null;
  person_brief: string;
  person_authorization_confirmed: boolean;
  person_source_image_paths: string[];
  person_source_upload_authorized: boolean;
  person_generation_provider: GenerationProvider | null;
  person_attempt_count: number;
  person_generation_result: StageResult;
  product_assets_result: (StageResult & { approval_status?: "needs_review" | "approved" | "blocked" }) | null;
  storyboard_mode: "anchor_storyboard" | null;
  storyboard_brief: string;
  storyboard_result: Record<string, unknown> | null;
  storyboard_generation_provider: GenerationProvider | null;
  storyboard_source_upload_authorized: boolean;
  storyboard_upload_scope: {
    schema_version: 1;
    source_anchor_frames_authorized: boolean;
    approved_person_paths: string[];
    scene_reference_paths: string[];
    product_reference_paths: string[];
  } | null;
  storyboard_ratio_repair_authorized: boolean;
  storyboard_attempt_count: number;
  storyboard_generation_result: StageResult;
  motion_preflight_result: StageResult;
  video_prompt_result: StageResult;
  person_package_generation_provider: GenerationProvider | null;
  person_package_source_upload_authorized: boolean;
  person_package_attempt_count: number;
  person_package_result: StageResult;
  generation_route_choice: GenerationRoute | null;
  generation_provider: "libtv" | "runninghub_h3_multiref";
  generation_quality_profile: "normal" | "high" | "ultra";
  generation_model_key: string | null;
  generation_model_snapshot: VideoModelOption | null;
  libtv_project_uuid: string | null;
  libtv_project_name: string | null;
  libtv_project_registered_at: string | null;
  codex_thread_id: string | null;
  codex_thread_name: string | null;
  codex_thread_status: "connecting" | "running" | "ready" | "failed" | null;
  codex_thread_error: string | null;
  codex_thread_created_at: string | null;
  codex_thread_initialized_at: string | null;
  generation_pack_result: StageResult;
  video_generation_attempt_count: number;
  video_quality_revalidation_authorized: boolean;
  full_video_generation_attempt_count: number;
  full_video_generation_authorized: boolean;
  full_video_quality_revalidation_authorized: boolean;
  contract_repair_full_video_authorized: boolean;
  video_generation_result: StageResult & {
    generation_kind?: "smoke_test" | "full_sequence";
    points_used?: number | null;
    points_receipt_status?: string;
    remote_task_id?: string;
    quality_qc?: StageResult;
    quality_qc_status?: string;
    user_approval_status?: "approved";
    user_approved_at?: string;
    user_approved_version?: number;
    user_approval_overrode_qc?: boolean;
  };
  video_rework_request: VideoReworkRequest | null;
  video_rework_plan: VideoReworkPlan | null;
  workflow_handoff: WorkflowHandoff | null;
  execution_owner?: "project_codex_task" | "legacy_web_orchestrator";
  codex_progress?: {
    schema_version: 1;
    task_state?: string;
    phase_key?: string;
    phase_label?: string;
    summary?: string;
    next_action?: string;
    current_skill?: string;
    updated_at?: string;
  } | null;
  runtime_generation?: {
    schema_version: 1;
    status: "preflight_running" | "preflight_passed" | "preflight_failed" | "generation_running" | "generation_completed" | "generation_failed";
    phase_label?: string;
    summary?: string;
    next_action?: string;
    estimated_coins_min?: number | null;
    estimated_coins_max?: number | null;
    actual_coins?: number | null;
    failure_kind?: "capacity_oom" | "provider_failure";
    can_confirm_paid?: boolean;
    generation?: {
      duration_seconds?: number;
      aspect_ratio?: string;
      quality_profile?: "normal" | "high" | "ultra";
      reference_count?: number;
      generation_count?: number;
      automatic_retry?: boolean;
    };
  } | null;
  estimated_cost_cny: number;
  decompose_retry_count: number;
  rewrite_retry_count: number;
  last_error: string | null;
  user_message: string | null;
  created_at: string;
  updated_at: string;
  decomposition_result: StageResult;
  rewrite_result: StageResult;
  events: TaskEvent[];
  artifacts: Artifact[];
  user_state: UserState;
};

const statusInfo: Record<
  string,
  { label: string; tone: string; hint: string }
> = {
  draft: { label: "草稿", tone: "muted", hint: "资料还未完成" },
  ready: { label: "待开始", tone: "waiting", hint: "等待你确认上传和费用" },
  running_decomposition: {
    label: "拆解中",
    tone: "running",
    hint: "正在处理参考视频",
  },
  awaiting_confirmation: {
    label: "待确认",
    tone: "waiting",
    hint: "需要你确认后继续",
  },
  running_rewrite: {
    label: "改写中",
    tone: "running",
    hint: "正在重构商品脚本",
  },
  completed: {
    label: "参考片已处理",
    tone: "done",
    hint: "可以继续选择人物和制作方式",
  },
  person_inputs_ready: {
    label: "人物待创建",
    tone: "waiting",
    hint: "人物选择已保存，可以继续制作",
  },
  running_person_generation: {
    label: "人物生成中",
    tone: "running",
    hint: "正在创建 1 张人物候选",
  },
  person_review: {
    label: "人物待确认",
    tone: "waiting",
    hint: "请查看人物候选并决定是否采用",
  },
  person_approved: {
    label: "人物已确认",
    tone: "done",
    hint: "可以继续生成第一版分镜",
  },
  storyboard_inputs_ready: {
    label: "分镜待开始",
    tone: "waiting",
    hint: "人物已确认，可以生成第一版分镜",
  },
  running_storyboard_generation: {
    label: "分镜生成中",
    tone: "running",
    hint: "正在创建 1 张分镜候选图",
  },
  storyboard_review: {
    label: "分镜待确认",
    tone: "waiting",
    hint: "请查看分镜并决定是否采用",
  },
  storyboard_approved: {
    label: "分镜已采用",
    tone: "done",
    hint: "可以继续检查人物和镜头怎么动",
  },
  running_motion_preflight: {
    label: "动态检查中",
    tone: "running",
    hint: "正在检查人物动作、镜头运动和衣物表现",
  },
  motion_preflight_ready: {
    label: "动态检查完成",
    tone: "done",
    hint: "可以继续整理视频生成方案",
  },
  motion_preflight_blocked: {
    label: "动态检查待处理",
    tone: "error",
    hint: "现有成果已保留，处理后可以继续",
  },
  running_video_prompt: {
    label: "生成方案整理中",
    tone: "running",
    hint: "正在整理视频生成所需内容",
  },
  video_prompt_ready: {
    label: "可以开始生成",
    tone: "done",
    hint: "点击后先检查素材、模型和费用",
  },
  video_prompt_blocked: {
    label: "生成方案待处理",
    tone: "error",
    hint: "已有成果已保留，处理后可以继续",
  },
  person_package_required: {
    label: "待补人物参考",
    tone: "waiting",
    hint: "需要补齐保持人物一致所需的图片",
  },
  running_person_package: {
    label: "人物参考生成中",
    tone: "running",
    hint: "正在生成红线遮脸版、局部材质拼图和必要视图",
  },
  person_package_review: {
    label: "人物参考待确认",
    tone: "waiting",
    hint: "确认后会继续做生成前检查",
  },
  person_package_failed: {
    label: "人物参考待继续",
    tone: "waiting",
    hint: "点击继续，只处理还缺少的图片",
  },
  running_generation_pack: {
    label: "生成前检查中",
    tone: "running",
    hint: "正在核对素材、画面要求和生成设置",
  },
  generation_pack_ready: {
    label: "可以提交生成",
    tone: "done",
    hint: "只差确认模型、费用和上传素材",
  },
  generation_pack_blocked: {
    label: "生成资料待补齐",
    tone: "error",
    hint: "系统会先自动处理能确定的问题",
  },
  running_video_generation: {
    label: "视频生成中",
    tone: "running",
    hint: "已提交一次，正在等待结果",
  },
  video_generation_completed: {
    label: "视频已生成",
    tone: "done",
    hint: "可以直接播放查看",
  },
  video_generation_failed: {
    label: "视频生成未完成",
    tone: "error",
    hint: "已停止，不会自动再次提交",
  },
  storyboard_generation_failed: {
    label: "分镜生成未完成",
    tone: "error",
    hint: "客观比例只自动纠正一次，现有成果不受影响",
  },
  person_generation_failed: {
    label: "人物生成未完成",
    tone: "error",
    hint: "不会自动重试，现有成果不受影响",
  },
  interrupted: {
    label: "已安全暂停",
    tone: "waiting",
    hint: "检测到中断，未自动重试",
  },
  failed: { label: "执行失败", tone: "error", hint: "可手动重试一次" },
  blocked_configuration: {
    label: "等待处理",
    tone: "waiting",
    hint: "阻断条件处理后可继续，不占用失败重试",
  },
  blocked_runtime: {
    label: "后台暂时未启动",
    tone: "waiting",
    hint: "业务尚未开始，稍后可直接继续",
  },
  blocked_diagnostic: {
    label: "待诊断",
    tone: "error",
    hint: "已停止继续重试",
  },
};

const steps = [
  {
    id: "created",
    title: "建立视频项目",
    description: "参考片和项目规则保存在本机",
  },
  {
    id: "decomposition",
    title: "理解参考视频",
    description: "识别画面结构、动作节奏和可复用重点",
  },
  {
    id: "user_confirmation",
    title: "等待你的确认",
    description: "查看拆解结果，再决定是否继续",
  },
  {
    id: "rewrite",
    title: "商品脚本重构",
    description: "只使用已确认的真实产品事实",
  },
  {
    id: "completed",
    title: "保存重构方案",
    description: "保留可继续使用的参考片分析和脚本",
  },
  {
    id: "person_inputs_ready",
    title: "选择人物路线",
    description: "决定由 AI 创建、使用授权人物或不固定脸",
  },
  {
    id: "person_generation",
    title: "创建人物候选",
    description: "一次只生成 1 张，失败不自动重试",
  },
  {
    id: "person_review",
    title: "确认人物形象",
    description: "满意后再继续制作分镜",
  },
  {
    id: "storyboard_inputs_ready",
    title: "准备第一版分镜",
    description: "把参考片、人物和产品要求对齐",
  },
  {
    id: "storyboard_generation",
    title: "生成分镜候选",
    description: "一次生成 1 张，先看效果再决定",
  },
  {
    id: "storyboard_review",
    title: "确认分镜",
    description: "采用后继续检查人物和镜头怎么动",
  },
  {
    id: "motion_preflight",
    title: "检查动态表现",
    description: "逐镜检查动作、镜头和衣物表现，不生成视频",
  },
  {
    id: "video_prompt",
    title: "整理生成方案",
    description: "整理分镜与动态要求，不提交视频生成",
  },
  {
    id: "person_package",
    title: "补齐人物参考",
    description: "只补保持人物一致真正需要的图片",
  },
  {
    id: "generation_pack",
    title: "开始生成视频",
    description: "先检查素材、模型和费用，再由你确认提交",
  },
];

const previewWorkflows: PreviewWorkflow[] = [
  {
    id: "positioning",
    group: "内容策划",
    name: "内容定位",
    icon: "位",
    tone: "blue",
    promise: "先把你是谁、服务谁、讲什么说清楚",
    description:
      "通过一次对话梳理账号方向、目标受众和内容边界，形成后续选题与文案都能直接使用的定位底稿。",
    inputs: ["你的业务和擅长领域", "希望吸引的人", "目前内容上的困惑"],
    steps: ["了解你和业务", "找到目标受众", "确定内容方向", "生成定位卡"],
    automatic: ["整理访谈答案", "识别定位冲突", "沉淀可复用信息"],
    confirmations: ["最终服务对象", "不做哪些内容", "定位卡正式采用"],
    outputs: ["账号定位卡", "目标受众说明", "内容边界与表达方向"],
  },
  {
    id: "topics",
    group: "内容策划",
    name: "选题策划",
    icon: "题",
    tone: "cyan",
    promise: "从一个想法，找到真正值得做的选题",
    description:
      "结合你的定位、业务目标和当下灵感，扩展出不同受众入口，并筛出最值得优先制作的题目。",
    inputs: ["一个灵感或业务重点", "已确认的内容定位", "想发布的平台"],
    steps: ["理解灵感", "扩展受众入口", "评估传播价值", "确认选题"],
    automatic: ["生成多层选题", "去除重复与空泛题", "匹配账号定位"],
    confirmations: ["本次主选题", "目标平台", "是否进入文案"],
    outputs: ["推荐选题", "备选题库", "切入角度与受众理由"],
  },
  {
    id: "copywriting",
    group: "内容策划",
    name: "文案创作",
    icon: "文",
    tone: "violet",
    promise: "把确认的选题，写成可以直接发布的内容",
    description:
      "从标题、开头到正文和行动引导，按平台语感完成一版内容母稿，而不是只给零散句子。",
    inputs: ["确认的选题", "真实观点与案例", "发布平台"],
    steps: ["明确表达目标", "设计标题开头", "完成内容母稿", "检查可发布性"],
    automatic: ["组织内容结构", "保持你的表达立场", "适配平台阅读习惯"],
    confirmations: ["核心观点", "不能夸大的事实", "最终发布稿"],
    outputs: ["标题方案", "发布级正文", "平台话题与行动引导"],
  },
  {
    id: "commerce",
    group: "图文增长",
    name: "电商素材分析",
    icon: "商",
    tone: "orange",
    promise: "把零散商品素材，整理成可行动的内容机会",
    description:
      "分析你收集的商品和对标素材，提取卖点、内容角度与优先级，为后续图文或视频制作做好准备。",
    inputs: ["商品资料", "参考内容链接", "本次销售目标"],
    steps: ["收集素材", "识别卖点", "判断内容机会", "生成制作建议"],
    automatic: ["整理商品事实", "对比素材差异", "归纳内容切口"],
    confirmations: ["真实商品卖点", "本次主推方向", "下一步做图文或视频"],
    outputs: ["素材分析结果", "内容机会清单", "推荐制作方向"],
  },
  {
    id: "social-extract",
    group: "图文增长",
    name: "爆款提取",
    icon: "取",
    tone: "cyan",
    promise: "一个链接，拿到可继续使用的内容资料",
    description:
      "从抖音、小红书或视频号等内容中整理标题、发布文案、口播文字和可用素材，供后续分析与重构。",
    inputs: ["一条社媒链接", "想提取的内容", "后续使用目的"],
    steps: ["识别平台内容", "提取文字素材", "整理图片或视频", "交付可用资料"],
    automatic: ["整理标题和话题", "提取口播与字幕", "按用途归类素材"],
    confirmations: ["是否允许下载素材", "提取范围", "后续交给哪个流程"],
    outputs: ["发布文案", "口播与字幕", "已整理的原始素材"],
  },
  {
    id: "xhs-remix",
    group: "图文增长",
    name: "小红书爆款重构",
    icon: "红",
    tone: "pink",
    promise: "参考一篇爆款，做成符合你业务的新笔记",
    description:
      "学习参考笔记的选题、结构和视觉逻辑，再换成你的产品、观点与素材，避免只做表面模仿。",
    inputs: ["参考笔记", "你的产品或观点", "人物与图片素材"],
    steps: ["分析爆款逻辑", "建立重构方案", "制作图文内容", "检查发布质量"],
    automatic: ["提炼结构和钩子", "重写成你的内容", "整理配图职责"],
    confirmations: ["保留什么风格", "产品事实", "最终图文是否采用"],
    outputs: ["重构文案", "成套图文图片", "发布标题与话题"],
  },
  {
    id: "publishing",
    group: "图文增长",
    name: "图文发布制作",
    icon: "发",
    tone: "blue",
    promise: "把确认稿，制作成真正能发布的图文",
    description:
      "将已经确认的文章或笔记制作成封面、正文配图和适合平台阅读的版式，集中交付全部发布素材。",
    inputs: ["已确认内容稿", "品牌或人物素材", "发布平台"],
    steps: ["确定视觉方向", "制作封面", "完成正文配图", "整理发布文件"],
    automatic: ["拆分配图位置", "统一视觉语言", "适配平台尺寸"],
    confirmations: ["封面方向", "人物与产品使用范围", "整套发布效果"],
    outputs: ["发布封面", "正文配图", "排版稿与素材清单"],
  },
  {
    id: "cover",
    group: "图文增长",
    name: "小红书封面复刻",
    icon: "封",
    tone: "pink",
    promise: "学会参考封面的吸引力，做出你的版本",
    description:
      "保留参考封面的构图、信息层级和视觉节奏，再替换成你的标题、人物与业务内容。",
    inputs: ["参考封面", "新标题", "人物或产品图片"],
    steps: ["分析封面结构", "确定替换内容", "生成封面候选", "确认最终封面"],
    automatic: ["提取版式规律", "匹配标题层级", "检查画面完整性"],
    confirmations: ["必须保留的风格", "人物使用授权", "最终采用版本"],
    outputs: ["封面候选", "最终高清封面", "可复用视觉说明"],
  },
  {
    id: "image",
    group: "人物与视觉",
    name: "图片生成与修改",
    icon: "图",
    tone: "blue",
    promise: "说清想要什么，直接得到可用图片",
    description:
      "支持从零生成、带参考图生成和局部修改；每张参考图的用途会在生成前说清楚。",
    inputs: ["画面目标", "必要参考图", "尺寸与使用场景"],
    steps: ["理解画面需求", "分配参考图职责", "生成或修改", "检查可用性"],
    automatic: ["整理生图要求", "选择合适执行方式", "保存合格结果"],
    confirmations: ["参考图上传范围", "可能消耗的额度", "最终采用图片"],
    outputs: ["高清图片", "修改后版本", "对应生成记录"],
  },
  {
    id: "model",
    group: "人物与视觉",
    name: "人物与模特",
    icon: "人",
    tone: "violet",
    promise: "建立一个能反复出镜的稳定人物形象",
    description:
      "创建原创人物，或使用本人及已授权人物，逐步补齐口播、剧情和商业视频真正需要的人物参考。",
    inputs: ["人物用途", "形象要求或授权照片", "服装与风格要求"],
    steps: ["选择人物路线", "确认人物形象", "补齐必要视图", "登记人物资料"],
    automatic: ["保持人物身份一致", "按用途准备参考图", "检查服装与细节"],
    confirmations: ["人物授权", "基准形象", "衍生图片是否一致"],
    outputs: ["确认人物形象", "必要多视图与细节图", "后续视频可复用的人物资料"],
  },
  {
    id: "live-photo",
    group: "人物与视觉",
    name: "图文 Live 图",
    icon: "动",
    tone: "cyan",
    promise: "让一张图片自然动起来，更适合图文发布",
    description:
      "为人物、商品或场景图片设计轻微自然运动，重点保持主体一致，不把图片做成夸张视频。",
    inputs: ["一张确认图片", "希望哪里动", "发布平台"],
    steps: ["检查主体", "设计轻运动", "生成 Live 图", "确认循环效果"],
    automatic: ["限制动作幅度", "保护人物与产品", "检查首尾衔接"],
    confirmations: ["允许变化的区域", "是否严格保产品", "最终动态效果"],
    outputs: ["Live 图文件", "封面静帧", "发布使用说明"],
  },
  {
    id: "editing",
    group: "视频制作",
    name: "智能剪辑",
    icon: "剪",
    tone: "green",
    promise: "把已有素材，剪成节奏清楚的完整成片",
    description:
      "整理口播、剧情或商品视频素材，完成结构、字幕、声音和基础包装，并把不合格片段明确退回对应环节。",
    inputs: ["待剪视频素材", "文案或逐字稿", "参考风格（可选）"],
    steps: ["整理可用片段", "设计成片结构", "完成字幕与声音", "检查并导出"],
    automatic: ["寻找自然切点", "统一字幕与音量", "标记需要返工的片段"],
    confirmations: ["成片节奏", "字幕与包装风格", "最终导出版本"],
    outputs: ["完整成片", "字幕与逐字稿", "质量检查与返工建议"],
  },
];

const previewWorkflowGroups = [
  "内容策划",
  "图文增长",
  "人物与视觉",
  "视频制作",
] as const;

// 客户界面只展示已经跑过真实流程的工作流。其余功能和页面继续保留，
// 以后完成验证后只需调整这里，无需恢复或迁移业务代码。
const customerWorkflowVisibility = {
  remix: true,
  talking: true,
  socialExtract: true,
  shortVideo: false,
  plannedWorkflowCatalog: false,
} as const;

export default function Home() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    let nextTheme: "dark" | "light" = "dark";
    try { if (window.localStorage.getItem("workbench-theme") === "light") nextTheme = "light"; } catch { /* Theme remains usable when storage is unavailable. */ }
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    const frame = window.requestAnimationFrame(() => setTheme(nextTheme));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    try { window.localStorage.setItem("workbench-theme", nextTheme); } catch { /* The current session can still switch theme. */ }
  };
  const [view, setView] = useState<
    "home" | "tasks" | "results" | "models" | "talking" | "shortVideo" | "preview" | "xhsJewelry"
  >("home");
  const [modelsFromTalking, setModelsFromTalking] = useState(false);
  const [previewWorkflowId, setPreviewWorkflowId] =
    useState<PreviewWorkflowId>("positioning");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [socialExtractions, setSocialExtractions] = useState<
    SocialExtraction[]
  >([]);
  const [talkingJobs, setTalkingJobs] = useState<TalkingJob[]>([]);
  const [modelAssetProjects, setModelAssetProjects] = useState<ModelAssetProject[]>([]);
  const [xhsJewelryTasks, setXhsJewelryTasks] = useState<JewelryTask[]>([]);
  const [modelEntryMode, setModelEntryMode] = useState<"home" | "project">("home");
  const [modelCreateRoute, setModelCreateRoute] = useState<"ai_model" | "real_person" | null>(null);
  const [videoModels, setVideoModels] = useState<VideoModelOption[]>([]);
  const [runtimeOnline, setRuntimeOnline] = useState<boolean | null>(null);
  const [hasLoadedData, setHasLoadedData] = useState(false);
  const [providerCapabilities, setProviderCapabilities] =
    useState<ProviderCapabilities>({
      codexBuiltinAvailable: false,
      codexBuiltinMessage: "当前后台没有接入可自动回传的 Codex 生图执行器。",
      chatgptWebAvailable: false,
      chatgptWebMode: "companion",
      chatgptWebState: "companion_not_connected",
      chatgptWebMessage: "ChatGPT 浏览器伴侣尚未连接。",
    });
  const [xhsJewelryCapability, setXhsJewelryCapability] =
    useState<XhsJewelryCapability>({
      available: false,
      visible: false,
      state: "internal_feature_disabled",
      userMessage: "珠宝种草仍在内部验证，当前入口未开放。",
    });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [resultsHomeKey, setResultsHomeKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [
        health,
        taskResponse,
        socialResponse,
        talkingResponse,
        modelResponse,
        modelAssetsResponse,
        xhsJewelryResponse,
      ] = await Promise.all([
        fetch(`${API}/health`, { cache: "no-store" }),
        fetch(`${API}/tasks`, { cache: "no-store" }),
        fetch(`${API}/social-extractions`, { cache: "no-store" }).catch(() => null),
        fetch(`${API}/talking-head/jobs`, { cache: "no-store" }).catch(() => null),
        fetch(`${API}/video-models`, { cache: "no-store" }).catch(() => null),
        fetch(`${API}/model-assets/projects`, { cache: "no-store" }).catch(() => null),
        fetch(`${API}/xhs-jewelry/tasks`, { cache: "no-store" }).catch(() => null),
      ]);
      if (!health.ok || !taskResponse.ok) throw new Error("runtime offline");
      const [healthData, data] = await Promise.all([
        health.json(),
        taskResponse.json(),
      ]);
      setRuntimeOnline(true);
      setHasLoadedData(true);
      setProviderCapabilities({
        codexBuiltinAvailable: Boolean(
          healthData.person_generation_providers?.codex_builtin?.available,
        ),
        codexBuiltinMessage:
          healthData.person_generation_providers?.codex_builtin?.user_message ||
          "当前后台没有接入可自动回传的 Codex 生图执行器。",
        chatgptWebAvailable: Boolean(
          healthData.person_generation_providers?.chatgpt_web?.available,
        ),
        chatgptWebMode: ["simulation", "live"].includes(
          healthData.person_generation_providers?.chatgpt_web?.mode,
        )
          ? healthData.person_generation_providers.chatgpt_web.mode
          : "companion",
        chatgptWebState:
          healthData.person_generation_providers?.chatgpt_web?.state ||
          "companion_not_connected",
        chatgptWebMessage:
          healthData.person_generation_providers?.chatgpt_web?.user_message ||
          "ChatGPT 浏览器伴侣尚未连接。",
      });
      setXhsJewelryCapability({
        available: Boolean(healthData.xhs_jewelry_visual_remix?.available),
        visible: Boolean(healthData.xhs_jewelry_visual_remix?.visible),
        state:
          healthData.xhs_jewelry_visual_remix?.state ||
          "internal_feature_disabled",
        userMessage:
          healthData.xhs_jewelry_visual_remix?.user_message ||
          "珠宝种草仍在内部验证，当前入口未开放。",
      });
      setTasks(data.tasks || []);
      if (socialResponse?.ok)
        setSocialExtractions((await socialResponse.json()).extractions || []);
      if (talkingResponse?.ok)
        setTalkingJobs((await talkingResponse.json()).jobs || []);
      if (modelResponse?.ok) {
        const modelData = await modelResponse.json();
        setVideoModels(modelData.models || []);
      }
      if (modelAssetsResponse?.ok)
        setModelAssetProjects((await modelAssetsResponse.json()).projects || []);
      if (xhsJewelryResponse?.ok)
        setXhsJewelryTasks((await xhsJewelryResponse.json()).tasks || []);
    } catch {
      setRuntimeOnline(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) || null,
    [tasks, selectedId],
  );
  const visibleSocialExtractions = useMemo(
    () =>
      socialExtractions.filter(
        (item, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.source_url === item.source_url &&
              candidate.extraction_scope === item.extraction_scope,
          ) === index,
      ),
    [socialExtractions],
  );
  const totalCount =
    tasks.length + visibleSocialExtractions.length + talkingJobs.length + modelAssetProjects.length + xhsJewelryTasks.length;
  const activeCount =
    tasks.filter((task) => task.status.startsWith("running_")).length +
    visibleSocialExtractions.filter((item) => item.status === "running")
      .length +
    talkingJobs.filter((item) =>
      ["running", "voice_running"].includes(item.state),
    ).length + modelAssetProjects.filter((item) => item.status === "running").length
    + xhsJewelryTasks.filter((item) => item.status.startsWith("running_")).length;
  const waitingCount =
    tasks.filter((task) =>
      [
        "awaiting_confirmation",
        "ready",
        "blocked_configuration",
        "blocked_runtime",
      ].includes(task.status),
    ).length +
    visibleSocialExtractions.filter((item) => item.status === "failed").length +
    talkingJobs.filter((item) =>
      ["failed", "voice_failed", "voice_review"].includes(item.state),
    ).length + modelAssetProjects.filter((item) =>
      item.status !== "running" && !modelProjectComplete(item),
    ).length + xhsJewelryTasks.filter((item) => !item.status.startsWith("running_") && !["video_ready", "completed"].includes(item.status)).length;
  const resultCount =
    tasks.filter((task) => userFacingArtifacts(task).length > 0).length +
    visibleSocialExtractions.filter((item) => item.status === "completed")
      .length +
    talkingJobs.filter((item) => ["completed", "approved"].includes(item.state))
      .length + modelAssetProjects.filter((item) => modelProjectFinalAsset(item)).length
      + xhsJewelryTasks.filter((item) => Boolean(item.base_result || item.final_result)).length;
  const selectedPreviewWorkflow =
    previewWorkflows.find((workflow) => workflow.id === previewWorkflowId) ||
    previewWorkflows[0];
  const openPreviewWorkflow = (id: PreviewWorkflowId) => {
    setPreviewWorkflowId(id);
    setView("preview");
  };

  const showNotice = useCallback((
    message: string,
    tone: "success" | "error" = "success",
  ) => {
    setNotice({ message, tone });
    window.setTimeout(() => setNotice(null), 4200);
  }, []);

  async function postAction(
    path: string,
    body: BodyInit,
    headers?: HeadersInit,
  ) {
    setLoading(true);
    try {
      const response = await fetch(`${API}${path}`, {
        method: "POST",
        body,
        headers,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "操作没有完成");
      await refresh();
      showNotice("操作已提交，任务状态会自动更新");
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "操作没有完成",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div>
            <strong>一人内容团队</strong>
            <small>一个人，也能跑起自己的内容团队</small>
          </div>
        </div>
        <nav className="nav-list" aria-label="主要功能">
          <button
            aria-label="工作台" title="工作台" aria-current={view === "home" ? "page" : undefined}
            className={view === "home" ? "active" : ""}
            onClick={() => setView("home")}
          >
            <span className="nav-icon"><WorkspaceIcon name="home" /></span>
            <span className="nav-label">工作台</span>
          </button>
          <button
            aria-label="任务" title="任务" aria-current={view === "tasks" ? "page" : undefined}
            className={view === "tasks" ? "active" : ""}
            onClick={() => setView("tasks")}
          >
            <span className="nav-icon"><WorkspaceIcon name="projects" /></span>
            <span className="nav-label">任务</span>
            {totalCount > 0 && <i>{totalCount}</i>}
          </button>
          <button
            aria-label="成果" title="成果" aria-current={view === "results" ? "page" : undefined}
            className={view === "results" ? "active" : ""}
            onClick={() => {
              setResultsHomeKey((current) => current + 1);
              setView("results");
            }}
          >
            <span className="nav-icon"><WorkspaceIcon name="results" /></span>
            <span className="nav-label">成果</span>
          </button>
        </nav>
        <div className="sidebar-workflows-scroll">
          <div className="sidebar-label">已开放</div>
          <nav className="workflow-nav" aria-label="已接入工作流">
            <button aria-label="爆款重构" title="爆款重构" onClick={() => setCreateOpen(true)}>
              <b className="mini-icon orange"><WorkspaceIcon name="viral" /></b>
              <span>爆款重构</span>
            </button>
            <button
              aria-label="AI 口播" title="AI 口播" aria-current={view === "talking" ? "page" : undefined}
            className={view === "talking" ? "active" : ""}
              onClick={() => setView("talking")}
            >
              <b className="mini-icon violet"><WorkspaceIcon name="new" /></b>
              <span>AI 口播</span>
            </button>
            <button
              aria-label="模特资产" title="模特资产" aria-current={view === "models" ? "page" : undefined}
            className={view === "models" ? "active" : ""}
              onClick={() => {
                setModelCreateRoute(null);
                setModelEntryMode("home");
                setView("models");
              }}
            >
              <b className="mini-icon blue"><WorkspaceIcon name="assets" /></b>
              <span>模特资产</span>
            </button>
            <button
              className={
                view === "preview" && previewWorkflowId === "social-extract"
                  ? "active"
                  : ""
              }
              aria-label="爆款提取" title="爆款提取" onClick={() => openPreviewWorkflow("social-extract")}
            >
              <b className="mini-icon cyan"><WorkspaceIcon name="content" /></b>
              <span>爆款提取</span>
            </button>
            {(xhsJewelryCapability.visible || !hasLoadedData) && (
              <button
                className={view === "xhsJewelry" ? "active" : ""}
                disabled={!runtimeOnline}
                title={!runtimeOnline ? "正在连接工作台，连接后即可使用" : undefined}
                onClick={() => setView("xhsJewelry")}
              >
                <b className="mini-icon gold"><WorkspaceIcon name="graphic" /></b>
                <span>珠宝种草</span>
              </button>
            )}
          </nav>
        </div>
        <div className="sidebar-bottom">
          <div className="runtime-state">
            <i className={runtimeOnline === true ? "online" : "offline"}></i>
            <div>
              <strong>
                {runtimeOnline === null
                  ? "正在连接工作台"
                  : runtimeOnline
                    ? "工作台运行正常"
                    : "暂时无法连接工作台"}
              </strong>
              <small>
                {runtimeOnline === null
                  ? "正在读取本机项目，请稍候"
                  : runtimeOnline
                  ? "内容只保存在当前电脑"
                  : "请先刷新检查连接"}
              </small>
            </div>
          </div>
          <div
            className={`companion-state ${providerCapabilities.chatgptWebAvailable ? "ready" : "unavailable"}`}
            title={providerCapabilities.chatgptWebMessage}
          >
            <i></i>
            <div>
              <strong>
                {!hasLoadedData
                  ? "正在检查 ChatGPT 网页"
                  : providerCapabilities.chatgptWebAvailable
                  ? "ChatGPT 网页已就绪"
                  : "ChatGPT 网页暂不可用"}
              </strong>
              <small>
                {!hasLoadedData
                  ? "读取本机连接状态中"
                  : providerCapabilities.chatgptWebAvailable
                  ? "浏览器伴侣已连接，可作为生图通道"
                  : providerCapabilities.chatgptWebMessage}
              </small>
            </div>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="page-crumb">
            AI 内容工作台 <span>/</span>{" "}
            {view === "home"
              ? "工作台"
              : view === "tasks"
                ? "任务中心"
                : view === "results"
                  ? "成果中心"
                  : view === "talking"
              ? "AI 口播"
              : view === "models"
                ? "模特资产"
              : view === "xhsJewelry"
                ? "珠宝种草"
              : view === "shortVideo"
                ? "原创短片"
                : view === "preview"
                  ? selectedPreviewWorkflow.name
                  : "爆款重构"}
          </div>
          <div className="top-actions">
            <button className="theme-toggle" type="button"
              aria-label={theme === "dark" ? "切换为浅色模式" : "切换为深色模式"}
              aria-pressed={theme === "light"} onClick={toggleTheme}>
              <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
              <b>{theme === "dark" ? "浅色" : "深色"}</b>
            </button>
            <button className="icon-button" onClick={refresh} aria-label="刷新">
              ↻
            </button>
            {view === "results" ||
            view === "talking" ||
            view === "models" ||
            view === "xhsJewelry" ||
            view === "shortVideo" ||
            view === "preview" ? (
              <button
                className="new-task secondary-top-action"
                aria-label={view === "models" && modelsFromTalking ? "返回口播设置" : "返回工作台"}
                onClick={() => { setView(view === "models" && modelsFromTalking ? "talking" : "home"); setModelsFromTalking(false); }}
              >
                ← 返回
              </button>
            ) : (
              <button
                className="new-task"
                onClick={() => setCreateOpen(true)}
                disabled={!runtimeOnline}
              >
                <span>＋</span>开始制作
              </button>
            )}
          </div>
        </header>
        <div className="content">
          {runtimeOnline === false && (
            <div className="offline-banner">
              <strong>暂时无法连接本机制作服务。</strong>
              <span>先点击右上角刷新重试；仍无法连接时重新打开工作台。当前无法判断历史任务状态。</span>
            </div>
          )}
          {view === "home" && (
            <Dashboard
              tasks={tasks}
              xhsJewelryTasks={xhsJewelryTasks}
              talkingJobs={talkingJobs}
              modelAssetProjects={modelAssetProjects}
              totalCount={totalCount}
              activeCount={activeCount}
              waitingCount={waitingCount}
              resultCount={resultCount}
              dataLoaded={hasLoadedData}
              onCreate={() => setCreateOpen(true)}
              onOpen={(id) => {
                setSelectedId(id);
                setView("tasks");
              }}
              onOpenTasks={() => setView("tasks")}
              onOpenResults={() => {
                setResultsHomeKey((current) => current + 1);
                setView("results");
              }}
              onOpenTalking={() => setView("talking")}
              onOpenModels={() => {
                setModelCreateRoute(null);
                setModelEntryMode("home");
                setView("models");
              }}
              onOpenRecentModel={(projectId) => {
                window.localStorage.setItem("workbench-selected-model-project", projectId);
                setModelCreateRoute(null); setModelEntryMode("project"); setView("models");
              }}
              onOpenShortVideo={() => setView("shortVideo")}
              onOpenPreview={openPreviewWorkflow}
              xhsJewelryVisible={xhsJewelryCapability.visible}
              onOpenXhsJewelry={() => setView("xhsJewelry")}
            />
          )}
          {view === "tasks" && (
            <TaskCenter
              tasks={tasks}
              xhsJewelryTasks={xhsJewelryTasks}
              onOpenXhsJewelry={(taskId) => {
                window.localStorage.setItem("workbench-selected-xhs-jewelry-task", taskId);
                setView("xhsJewelry");
              }}
              socialExtractions={visibleSocialExtractions}
              talkingJobs={talkingJobs}
              modelAssetProjects={modelAssetProjects}
              onCreate={() => setCreateOpen(true)}
              onOpen={setSelectedId}
              onOpenSocial={() => openPreviewWorkflow("social-extract")}
              onOpenTalking={(job) => {
                window.localStorage.setItem(
                  "workbench-talking-head-job",
                  JSON.stringify(job),
                );
                setView("talking");
              }}
              onOpenModel={(projectId) => {
                window.localStorage.setItem(
                  "workbench-selected-model-project",
                  projectId,
                );
                setModelCreateRoute(null);
                setModelEntryMode("project");
                setView("models");
              }}
            />
          )}
          {view === "results" && (
            <Results
              key={resultsHomeKey}
              tasks={tasks}
              socialExtractions={visibleSocialExtractions}
              talkingJobs={talkingJobs}
              modelAssetProjects={modelAssetProjects}
              xhsJewelryTasks={xhsJewelryTasks}
              onOpenTask={(id) => {
                setSelectedId(id);
                setView("tasks");
              }}
              onOpenTalking={(job) => {
                window.localStorage.setItem(
                  "workbench-talking-head-job",
                  JSON.stringify(job),
                );
                setView("talking");
              }}
              onOpenModel={(projectId) => {
                window.localStorage.setItem(
                  "workbench-selected-model-project",
                  projectId,
                );
                setModelCreateRoute(null);
                setModelEntryMode("project");
                setView("models");
              }}
              onOpenXhsJewelry={(taskId) => {
                window.localStorage.setItem("workbench-selected-xhs-jewelry-task", taskId);
                setView("xhsJewelry");
              }}
            />
          )}
          {view === "talking" && (
            <TalkingHeadStudio
              onOpenModels={(route) => {
                setModelsFromTalking(true);
                setModelCreateRoute(route);
                setModelEntryMode("home");
                setView("models");
              }}
            />
          )}
          {view === "models" && (
            <ModelAssetStudio
              projects={modelAssetProjects}
              entryMode={modelEntryMode}
              entryRoute={modelCreateRoute}
              capabilities={providerCapabilities}
              onRefresh={refresh}
              onNotice={showNotice}
              onUseForTalking={() => setView("talking")}
            />
          )}
          {view === "shortVideo" && <ShortVideoStudio />}
          {view === "xhsJewelry" && (
            <XhsJewelryStudio
              available={xhsJewelryCapability.available}
              availabilityMessage={xhsJewelryCapability.userMessage}
              codexAvailable={providerCapabilities.codexBuiltinAvailable}
              chatgptWebAvailable={providerCapabilities.chatgptWebAvailable}
              chatgptWebMessage={providerCapabilities.chatgptWebMessage}
              onNotice={showNotice}
            />
          )}
          {view === "preview" &&
            (selectedPreviewWorkflow.id === "social-extract" ? (
              <SocialExtractStudio
                extractions={socialExtractions}
                loading={loading}
                onSubmit={async (payload) => {
                  setLoading(true);
                  try {
                    const response = await fetch(`${API}/social-extractions`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(payload),
                    });
                    const data = await response.json();
                    if (!response.ok)
                      throw new Error(data.error || "爆款提取没有开始");
                    await refresh();
                    showNotice(
                      data.reused
                        ? "已复用这条内容的现有结果，本次没有再次请求接口"
                        : "已经开始提取，完成后会直接显示在这里和成果中心",
                    );
                    return true;
                  } catch (error) {
                    showNotice(
                      error instanceof Error
                        ? error.message
                        : "爆款提取没有开始",
                      "error",
                    );
                    return false;
                  } finally {
                    setLoading(false);
                  }
                }}
              />
            ) : (
              <WorkflowPreviewStudio workflow={selectedPreviewWorkflow} />
            ))}
        </div>
      </section>

      {createOpen && (
        <CreateTaskModal
          loading={loading}
          providerCapabilities={providerCapabilities}
          socialExtractions={socialExtractions}
          onClose={() => setCreateOpen(false)}
          onCreated={async (form) => {
            setLoading(true);
            try {
              const response = await fetch(`${API}/tasks`, {
                method: "POST",
                body: form,
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "项目建立失败");
              setCreateOpen(false);
              setSelectedId(data.task.id);
              setView("tasks");
              await refresh();
              showNotice(
                data.task.status === "running_decomposition"
                  ? "项目设置已保存，后台开始拆解参考视频"
                  : "项目已建立，尚未上传到外部服务",
              );
            } catch (error) {
              showNotice(
                error instanceof Error ? error.message : "项目建立失败",
                "error",
              );
            } finally {
              setLoading(false);
            }
          }}
        />
      )}

      {selected && (
        <TaskDrawer
          key={`${selected.id}-${selected.updated_at}`}
          task={selected}
          providerCapabilities={providerCapabilities}
          videoModels={videoModels}
          loading={loading}
          onClose={() => setSelectedId(null)}
          onStart={() =>
            postAction(
              `/tasks/${selected.id}/start`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onResume={() =>
            postAction(
              `/tasks/${selected.id}/resume`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onSkipRewrite={() =>
            postAction(
              `/tasks/${selected.id}/skip-rewrite`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onRewrite={(form) =>
            postAction(`/tasks/${selected.id}/confirm-rewrite`, form)
          }
          onSaveOnly={() =>
            postAction(
              `/tasks/${selected.id}/save-decomposition`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onSetDefaultProvider={(generationProvider) =>
            postAction(
              `/tasks/${selected.id}/generation-provider`,
              JSON.stringify({ confirmed: true, generationProvider }),
              { "Content-Type": "application/json" },
            )
          }
          onBindCodexTask={(intent) =>
            postAction(
              `/tasks/${selected.id}/codex-task`,
              JSON.stringify({ confirmed: true, intent }),
              { "Content-Type": "application/json" },
            )
          }
          onConfirmRuntimeGeneration={() =>
            postAction(
              `/tasks/${selected.id}/runtime-generation`,
              JSON.stringify({
                confirmed: true,
                confirmation: "确认按本次清单付费提交",
                automaticRetry: false,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onRetryRuntimeGenerationWithPlus={() =>
            postAction(
              `/tasks/${selected.id}/runtime-generation`,
              JSON.stringify({
                confirmed: true,
                confirmation: "确认按本次清单付费提交",
                automaticRetry: false,
                capacityRetry: true,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onPreparePerson={(body) =>
            postAction(
              `/tasks/${selected.id}/prepare-person`,
              JSON.stringify(body),
              { "Content-Type": "application/json" },
            )
          }
          onUploadAuthorizedPerson={(form) =>
            postAction(`/tasks/${selected.id}/upload-person-source`, form)
          }
          onGeneratePerson={(generationProvider) =>
            postAction(
              `/tasks/${selected.id}/generate-person`,
              JSON.stringify({
                confirmed: true,
                sourceFrameUploadAuthorized: true,
                generationProvider,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onApprovePerson={() =>
            postAction(
              `/tasks/${selected.id}/approve-person`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onPrepareProductAssets={() =>
            postAction(
              `/tasks/${selected.id}/prepare-product-assets`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onApproveProductAssets={() =>
            postAction(
              `/tasks/${selected.id}/approve-product-assets`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onSetProductScope={(productScope) =>
            postAction(
              `/tasks/${selected.id}/product-scope`,
              JSON.stringify({ productScope }),
              { "Content-Type": "application/json" },
            )
          }
          onPrepareStoryboard={(storyboardBrief) =>
            postAction(
              `/tasks/${selected.id}/prepare-storyboard`,
              JSON.stringify({
                confirmed: true,
                storyboardMode: "anchor_storyboard",
                storyboardBrief,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onGenerateStoryboard={(generationProvider, resumeIncomplete = false) =>
            postAction(
              `/tasks/${selected.id}/generate-storyboard`,
              JSON.stringify({
                confirmed: true,
                sourceFrameUploadAuthorized: true,
                objectiveRatioRepairAuthorized: true,
                generationProvider,
                resumeIncomplete,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onApproveStoryboard={() =>
            postAction(
              `/tasks/${selected.id}/approve-storyboard`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onStartMotionPreflight={() =>
            postAction(
              `/tasks/${selected.id}/start-motion-preflight`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onStartVideoPrompt={(selection) =>
            postAction(
              `/tasks/${selected.id}/start-video-prompt`,
              JSON.stringify({ confirmed: true, ...(selection || {}) }),
              { "Content-Type": "application/json" },
            )
          }
          onResolveVideoPrompt={(resolution, text) =>
            postAction(
              `/tasks/${selected.id}/resolve-video-prompt`,
              JSON.stringify({ confirmed: true, resolution, text }),
              { "Content-Type": "application/json" },
            )
          }
          onStartVideoGeneration={(selection) =>
            postAction(
              `/tasks/${selected.id}/start-video-generation`,
              JSON.stringify({ confirmed: true, ...selection }),
              { "Content-Type": "application/json" },
            )
          }
          onRebuildGenerationPack={(selection) =>
            postAction(
              `/tasks/${selected.id}/start-generation-pack`,
              JSON.stringify({ confirmed: true, ...selection }),
              { "Content-Type": "application/json" },
            )
          }
          onGeneratePersonPackage={(generationProvider) =>
            postAction(
              `/tasks/${selected.id}/generate-person-package`,
              JSON.stringify({
                confirmed: true,
                sourceUploadAuthorized: true,
                generationProvider,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onApprovePersonPackage={() =>
            postAction(
              `/tasks/${selected.id}/approve-person-package`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onGenerateVideo={() =>
            postAction(
              `/tasks/${selected.id}/generate-video`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onApproveVideoResult={() =>
            postAction(
              `/tasks/${selected.id}/approve-video-result`,
              JSON.stringify({ confirmed: true }),
              { "Content-Type": "application/json" },
            )
          }
          onPrepareVideoRework={(body) =>
            postAction(
              `/tasks/${selected.id}/prepare-video-rework`,
              JSON.stringify(body),
              { "Content-Type": "application/json" },
            )
          }
          onConfirmVideoRework={(selectedSegmentIds) =>
            postAction(
              `/tasks/${selected.id}/confirm-video-rework`,
              JSON.stringify({
                confirmed: true,
                selectedSegmentIds,
                preserveAllVersions: true,
                replaceSelectedOnly: true,
                automaticRetry: false,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onRevalidateFullVideoQuality={() =>
            postAction(
              `/tasks/${selected.id}/revalidate-full-video-quality`,
              JSON.stringify({
                confirmed: true,
                preserveExistingResult: true,
                singleSubmissionOnly: true,
                rebuildWithCurrentContract: true,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onValidateContractRepairFullVideo={() =>
            postAction(
              `/tasks/${selected.id}/revalidate-contract-repair-full-video`,
              JSON.stringify({
                confirmed: true,
                preserveExistingResult: true,
                singleSubmissionOnly: true,
                rebuildWithCurrentContract: true,
                contractRepairValidation: true,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onPrepareFullVideo={() =>
            postAction(
              `/tasks/${selected.id}/prepare-full-video`,
              JSON.stringify({
                confirmed: true,
                preserveExistingSamples: true,
                singleSubmissionOnly: true,
              }),
              { "Content-Type": "application/json" },
            )
          }
          onResumeVideo={() =>
            postAction(
              `/tasks/${selected.id}/generate-video`,
              JSON.stringify({
                confirmed: true,
                resumeExisting: true,
              }),
              { "Content-Type": "application/json" },
            )
          }
        />
      )}
      {notice && (
        <div className={`toast ${notice.tone}`}>
          <span>{notice.tone === "success" ? "✓" : "!"}</span>
          {notice.message}
        </div>
      )}
    </main>
  );
}

function SocialExtractStudio({
  extractions,
  loading,
  onSubmit,
}: {
  extractions: SocialExtraction[];
  loading: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [sourceText, setSourceText] = useState("");
  const [scope, setScope] = useState<
    "copy_only" | "media_only" | "copy_and_media"
  >(
    "copy_and_media",
  );
  const [downstreamUse, setDownstreamUse] = useState("作为爆款重构参考");
  const [authorized, setAuthorized] = useState(false);
  const latest = extractions[0] || null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const accepted = await onSubmit({
      sourceText,
      extractionScope: scope,
      downstreamUse,
      downloadAuthorized: scope === "copy_only" || authorized,
    });
    if (accepted) {
      setSourceText("");
      setAuthorized(false);
    }
  };
  return (
    <section
      className="workflow-preview-studio social-extract-studio"
      aria-label="爆款提取"
    >
      <header className="workflow-preview-hero tone-cyan">
        <div className="workflow-preview-intro">
          <div className="workflow-icon cyan">取</div>
          <small>保存爆款文案与素材</small>
          <h1>
            {scope === "copy_and_media"
              ? "粘贴链接，拿到文案和原始素材"
              : scope === "media_only"
                ? "粘贴链接，只保存图片或视频"
                : "粘贴链接，只拿发布文案"}
          </h1>
          <p>
            {scope === "copy_and_media"
              ? "下载的图片或视频会统一保存在社媒素材库，后续可以直接交给爆款重构。"
              : scope === "media_only"
                ? "只把可获取的视频、封面或图集保存到社媒素材库，不展示发布文案。"
                : "只整理发布文案、话题、作者和互动数据，不下载图片或视频。"}
          </p>
        </div>
        <aside>
          <span>本次会拿到</span>
          {scope === "media_only" ? (
            <>
              <strong>✓ 可获取的原视频或图集</strong>
              <strong>✓ 封面和素材清单</strong>
              <strong>✓ 统一保存到本机素材库</strong>
            </>
          ) : (
            <>
              <strong>✓ 发布文案与话题</strong>
              <strong>✓ 作者和互动数据</strong>
              <strong>
                {scope === "copy_and_media"
                  ? "✓ 可播放的原始素材"
                  : "✓ 不下载图片或视频"}
              </strong>
            </>
          )}
        </aside>
      </header>
      <form className="social-extract-form" onSubmit={submit}>
        <div className="preview-section-title">
          <small>开始提取</small>
          <h2>把分享文字或链接粘贴进来</h2>
          <p>工作台会识别其中的链接，不需要你手动清理分享口令。</p>
        </div>
        <label>
          <span>社媒分享内容</span>
          <textarea
            aria-label="社媒分享内容"
            required
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder="粘贴抖音、小红书或视频号分享内容"
          />
        </label>
        <fieldset>
          <legend>这次需要什么</legend>
          <label>
            <input
              type="radio"
              name="scope"
              checked={scope === "copy_and_media"}
              onChange={() => setScope("copy_and_media")}
            />
            文案和原始素材（推荐）
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              checked={scope === "copy_only"}
              onChange={() => setScope("copy_only")}
            />
            只提取发布文案
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              aria-label="只保存图片或视频"
              checked={scope === "media_only"}
              onChange={() => setScope("media_only")}
            />
            只保存图片或视频
          </label>
        </fieldset>
        <label>
          <span>后续准备怎么用</span>
          <select
            aria-label="后续准备怎么用"
            value={downstreamUse}
            onChange={(event) => setDownstreamUse(event.target.value)}
          >
            <option>作为爆款重构参考</option>
            <option>用于内容分析</option>
            <option>先保存备用</option>
          </select>
        </label>
        {scope !== "copy_only" && (
          <label className="social-download-confirm">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
            />
            我确认保存这条公开内容的图片或视频到本机社媒素材库
          </label>
        )}
        <button
          type="submit"
          disabled={
            loading ||
            !sourceText.trim() ||
            (scope !== "copy_only" && !authorized)
          }
        >
          {loading
            ? "正在开始…"
            : scope === "copy_and_media"
              ? "提取文案并保存素材"
              : scope === "media_only"
                ? "只保存图片或视频"
                : "只提取发布文案"}
        </button>
        <small className="preview-status-note">
          只处理这一个链接；不会读取账号登录态，也不会自动进入后续制作。
        </small>
      </form>
      <section className="social-extract-history">
        <div className="preview-section-title">
          <small>最近结果</small>
          <h2>{latest ? "这次任务的进度和成果" : "完成后会显示在这里"}</h2>
        </div>
        {latest && <SocialExtractionResult extraction={latest} />}
      </section>
    </section>
  );
}

function SocialExtractionResult({
  extraction,
}: {
  extraction: SocialExtraction;
}) {
  const result = extraction.result;
  if (extraction.status === "running")
    return (
      <div className="social-result-card running">
        <strong>正在提取内容并保存素材…</strong>
        <p>可以离开页面，工作台会继续处理。</p>
      </div>
    );
  if (extraction.status === "failed")
    return (
      <div className="social-result-card failed">
        <strong>这次没有完成</strong>
        <p>{extraction.error}</p>
        <small>系统不会自动重复付费请求。</small>
      </div>
    );
  if (!result) return null;
  const files = socialResultFiles(result);
  const mediaOnly = extraction.extraction_scope === "media_only";
  return (
    <div className="social-result-card completed">
      <div>
        <small>
          {result.reused_from_extraction_id ? "已复用现有结果" : "提取完成"}
        </small>
        <h3>{result.author || "未知作者"}</h3>
        <p>
          {mediaOnly
            ? "本次只保存原始素材，不展示发布文案。"
            : result.desc || "没有发布文案"}
        </p>
        {!mediaOnly && (
          <div className="result-chip-list">
            {(result.hashtags || []).map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}
      </div>
      <dl>
        <div>
          <dt>作品</dt>
          <dd>
            {result.platform} · {result.id}
          </dd>
        </div>
        <div>
          <dt>本次用途</dt>
          <dd>{extraction.downstream_use || "未设置"}</dd>
        </div>
        <div>
          <dt>已保存</dt>
          <dd>{files.length ? files.join("、") : "本次只提取文案"}</dd>
        </div>
        <div>
          <dt>本次费用</dt>
          <dd>
            ${Number(result.provider_usage?.confirmed_cost_usd || 0).toFixed(3)}
            {result.reused_from_extraction_id ? "（未再次请求接口）" : ""}
          </dd>
        </div>
      </dl>
      {files.length > 0 && (
        <div className="social-artifact-links">
          {files.map((file) => {
            const index = socialArtifactIndex(files, file);
            return (
              <a
                key={file}
                href={`${API}/social-extractions/${extraction.id}/artifacts/${index}`}
                target="_blank"
                rel="noreferrer"
              >
                {file === "video.mp4"
                  ? "播放原视频"
                  : file === "cover.jpg"
                    ? "查看封面"
                    : `打开 ${file}`}{" "}
                ↗
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function socialArtifactIndex(files: string[], file: string) {
  const order = [
    "video.mp4",
    "cover.jpg",
    "manifest.json",
    ...files.filter(
      (item) => !["video.mp4", "cover.jpg", "manifest.json"].includes(item),
    ),
  ];
  return [...new Set(order.filter((item) => files.includes(item)))].indexOf(
    file,
  );
}

function socialResultFiles(result?: SocialExtraction["result"] | null) {
  if (!result) return [];
  const decrypted = result.decrypted_files || [];
  const downloaded = result.downloaded_files || [];
  const hasPlayableVideo = decrypted.includes("video.mp4") || downloaded.includes("video.mp4");
  return [...new Set([...decrypted, ...downloaded])].filter(
    (file) => !(hasPlayableVideo && file === "video.encrypted.mp4"),
  );
}

function Dashboard({
  tasks,
  xhsJewelryTasks,
  talkingJobs,
  modelAssetProjects,
  totalCount,
  activeCount,
  waitingCount,
  resultCount,
  dataLoaded,
  onCreate,
  onOpen,
  onOpenTasks,
  onOpenResults,
  onOpenTalking,
  onOpenModels,
  onOpenRecentModel,
  onOpenShortVideo,
  onOpenPreview,
  xhsJewelryVisible,
  onOpenXhsJewelry,
}: {
  tasks: Task[];
  xhsJewelryTasks: JewelryTask[];
  talkingJobs: TalkingJob[];
  modelAssetProjects: ModelAssetProject[];
  totalCount: number;
  activeCount: number;
  waitingCount: number;
  resultCount: number;
  dataLoaded: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onOpenTasks: () => void;
  onOpenResults: () => void;
  onOpenTalking: () => void;
  onOpenModels: () => void;
  onOpenRecentModel: (projectId: string) => void;
  onOpenShortVideo: () => void;
  onOpenPreview: (id: PreviewWorkflowId) => void;
  xhsJewelryVisible: boolean;
  onOpenXhsJewelry: () => void;
}) {
  const recentProjects = [
    ...xhsJewelryTasks.map((task) => ({id: task.id, time: task.updated_at, title: task.title, kind: jewelryStatusLabel(task.status, task.person_strategy), open: () => {window.localStorage.setItem("workbench-selected-xhs-jewelry-task", task.id); onOpenXhsJewelry();}})),
    ...tasks.map((task) => ({id: task.id, time: task.updated_at || task.created_at, title: task.title || task.id, kind: "爆款重构", open: () => onOpen(task.id)})),
    ...talkingJobs.map((job) => ({id: job.id, time: job.updated_at || job.created_at || "", title: job.confirmed_script?.trim().slice(0, 28) || job.project_name || `口播 ${job.id.slice(0, 6)}`, kind: "AI 口播", open: () => {window.localStorage.setItem("workbench-talking-head-job", JSON.stringify(job)); onOpenTalking();}})),
    ...modelAssetProjects.map((project) => ({id: project.id, time: project.updated_at, title: project.name, kind: modelProjectStatus(project), open: () => onOpenRecentModel(project.id)})),
  ].sort((a,b) => String(b.time).localeCompare(String(a.time))).slice(0, 3);
  const workflows = [
    {
      id: "remix",
      icon: "影",
      tone: "orange",
      title: "爆款重构",
      description: "参考一条视频，换成你的内容",
      action: onCreate,
    },
    {
      id: "talking",
      icon: "播",
      tone: "violet",
      title: "AI 口播",
      description: "用人物和声音生成口播",
      action: onOpenTalking,
    },
    {
      id: "models",
      icon: "模",
      tone: "blue",
      title: "模特资产",
      description: "创建或整理可复用人物",
      action: onOpenModels,
    },
    {
      id: "social-extract",
      icon: "取",
      tone: "cyan",
      title: "爆款提取",
      description: "从链接保存爆款文案和素材",
      action: () => onOpenPreview("social-extract"),
    },
    ...(xhsJewelryVisible
      ? [
          {
            id: "xhs-jewelry",
            icon: "薯",
            tone: "gold",
            title: "珠宝种草",
            description: "一款产品一个项目，持续生成种草图与短视频",
            action: onOpenXhsJewelry,
          },
        ]
      : []),
  ];

  return (
    <>
      <section className="hero home-hero">
        <div>
          <div className="date-pill">
            <span></span>你的内容工作台
          </div>
          <h1>今天想做什么？</h1>
          <p>选择一个目标开始，任务进度和制作成果都会保存在这里。</p>
          <button className="hero-button" onClick={onCreate}>
            开始制作 <span>→</span>
          </button>
        </div>
        <div className="home-summary" aria-label="工作台概况">
          <div>
            <strong>{dataLoaded ? activeCount : "—"}</strong>
            <span>正在制作</span>
          </div>
          <div>
            <strong>{dataLoaded ? waitingCount : "—"}</strong>
            <span>需要处理</span>
          </div>
          <div>
            <strong>{dataLoaded ? resultCount : "—"}</strong>
            <span>已有成果</span>
          </div>
        </div>
      </section>

      <section className="home-section-heading">
        <div>
          <h2>选择制作方式</h2>
          <p>直接选择你想拿到的结果</p>
        </div>
      </section>
      <section className="home-workflow-grid" aria-label="制作方式">
        {workflows.map((workflow) => (
          <button
            key={workflow.id}
            className="home-workflow-card"
            onClick={workflow.action}
          >
            <span className={`workflow-icon ${workflow.tone}`}>
              <WorkspaceIcon name={({"影":"viral","播":"new","模":"assets","取":"content","薯":"graphic"} as Record<string,string>)[workflow.icon] || "graphic"} />
            </span>
            <span>
              <strong>{workflow.title}</strong>
              <small>{workflow.description}</small>
            </span>
            <b>→</b>
          </button>
        ))}
      </section>

      <section className="home-priority-grid" aria-label="当前进度">
        <button className="home-priority-card attention" onClick={onOpenTasks}>
          <span>需要你处理</span>
          <strong>{dataLoaded ? waitingCount : "—"} 个任务</strong>
          <small>确认、补充资料和失败任务都在这里</small>
          <b>去任务中心 →</b>
        </button>
        <button className="home-priority-card" onClick={onOpenResults}>
          <span>已经完成</span>
          <strong>{dataLoaded ? resultCount : "—"} 项成果</strong>
          <small>集中查看视频、图片和文案</small>
          <b>去成果中心 →</b>
        </button>
      </section>
      {customerWorkflowVisibility.shortVideo && (
        <button
          className="live-workflow-card short-video-workflow-card"
          onClick={onOpenShortVideo}
        >
          <div className="workflow-icon pink">片</div>
          <div>
            <small>原创短片</small>
            <h3>先选目标和表达形式，再进入正确的制作流程</h3>
            <p>
              获客、带货和娱乐只是目的；口播加素材、剧情段子、产品展示和唱跳表演才决定具体怎么做。
            </p>
          </div>
          <b>选择目标与形式 →</b>
        </button>
      )}
      {customerWorkflowVisibility.plannedWorkflowCatalog && (
        <section className="workflow-catalog-section">
        <div className="section-heading">
          <div>
            <h2>更多内容生产线</h2>
            <p>按你想完成的结果直接选择，无需先研究背后的工具</p>
          </div>
        </div>
        {previewWorkflowGroups.map((group) => (
          <div className="workflow-family" key={group}>
            <div className="workflow-family-title">
              <h3>{group}</h3>
              <span>
                {
                  previewWorkflows.filter(
                    (workflow) => workflow.group === group,
                  ).length
                }{" "}
                条生产线
              </span>
            </div>
            <div className="preview-workflow-grid">
              {previewWorkflows
                .filter((workflow) => workflow.group === group)
                .map((workflow) => (
                  <button
                    key={workflow.id}
                    className="preview-workflow-card"
                    onClick={() => onOpenPreview(workflow.id)}
                  >
                    <div className={`workflow-icon ${workflow.tone}`}>
                      {workflow.icon}
                    </div>
                    <small>{workflow.group}</small>
                    <h3>{workflow.name}</h3>
                    <p>{workflow.promise}</p>
                    <span>查看怎么完成 →</span>
                  </button>
                ))}
            </div>
          </div>
        ))}
        </section>
      )}
      <section className="recent-section">
        <div className="section-heading compact">
          <div>
            <h2>最近制作</h2>
            <p>
              {!dataLoaded
                ? "正在读取本机项目"
                : recentProjects.length
                  ? "从上次停下的位置继续"
                  : "开始制作后会显示在这里"}
            </p>
          </div>
          {dataLoaded && recentProjects.length > 0 && (
            <button className="home-text-button" onClick={onOpenTasks}>
              查看全部任务 →
            </button>
          )}
        </div>
        {!dataLoaded ? (
          <div className="task-search-empty">正在读取项目，请稍候…</div>
        ) : recentProjects.length ? (
          <div className="task-list">
            {recentProjects.map((project) => <button className="recent-project-link" key={project.id} type="button" onClick={project.open}><span><strong>{project.title}</strong><small>{project.kind}</small></span><span>继续制作 →</span></button>)}
          </div>
        ) : (
          <EmptyState onCreate={onCreate} />
        )}
      </section>
      <div className="home-storage-note">
        共 {dataLoaded ? totalCount : "—"} 个项目，内容保存在当前电脑。
      </div>
    </>
  );
}

function WorkflowPreviewStudio({ workflow }: { workflow: PreviewWorkflow }) {
  return (
    <section
      className="workflow-preview-studio"
      aria-label={`${workflow.name}流程预览`}
    >
      <div className="prototype-banner">
        <span>使用流程</span>
        <strong>先确认完整使用体验</strong>
        <p>
          当前不会上传素材、不会开始制作，也不会产生费用。体验确认后，功能会逐步开放。
        </p>
      </div>
      <header className={`workflow-preview-hero tone-${workflow.tone}`}>
        <div className="workflow-preview-intro">
          <div className={`workflow-icon ${workflow.tone}`}>
            {workflow.icon}
          </div>
          <small>
            {workflow.group} · {workflow.name}
          </small>
          <h1>{workflow.promise}</h1>
          <p>{workflow.description}</p>
        </div>
        <aside>
          <span>完成后会拿到</span>
          {workflow.outputs.slice(0, 3).map((output) => (
            <strong key={output}>✓ {output}</strong>
          ))}
        </aside>
      </header>

      <section className="workflow-preview-journey">
        <div className="preview-section-title">
          <small>完整流程</small>
          <h2>从开始到拿到成果</h2>
          <p>先把关键选择说明白，后续能自动完成的部分由工作台接着做。</p>
        </div>
        <div className="journey-grid">
          {workflow.steps.map((step, index) => (
            <div key={step}>
              <span>{index + 1}</span>
              <small>第 {index + 1} 步</small>
              <strong>{step}</strong>
              {index < workflow.steps.length - 1 && <i>→</i>}
            </div>
          ))}
        </div>
      </section>

      <div className="workflow-preview-columns">
        <section>
          <div className="preview-column-icon input">你</div>
          <small>开始时</small>
          <h3>你只需要提供</h3>
          <ul>
            {workflow.inputs.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <section>
          <div className="preview-column-icon auto">AI</div>
          <small>接下来</small>
          <h3>工作台自动完成</h3>
          <ul>
            {workflow.automatic.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <section>
          <div className="preview-column-icon confirm">✓</div>
          <small>关键节点</small>
          <h3>只请你确认这些</h3>
          <ul>
            {workflow.confirmations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="workflow-preview-result">
        <div>
          <small>最终成果</small>
          <h2>需要的内容，会集中出现在成果中心</h2>
          <p>
            不用在任务记录和文件夹里寻找；合格版本、可继续修改的内容和必要说明会按项目放在一起。
          </p>
        </div>
        <div className="preview-output-grid">
          {workflow.outputs.map((output, index) => (
            <div key={output}>
              <span>{index + 1}</span>
              <strong>{output}</strong>
            </div>
          ))}
        </div>
        <button type="button" disabled>
          开始{workflow.name}（功能开放后可用）
        </button>
        <small className="preview-status-note">
          当前只展示完整操作路径，按钮不会开始真实制作。
        </small>
      </section>
    </section>
  );
}

function ShortVideoStudio() {
  const [route, setRoute] = useState<"lead" | "commerce" | "entertainment">(
    "lead",
  );
  const [format, setFormat] = useState<
    "talking_material" | "story" | "product_demo" | "performance" | "unsure"
  >("talking_material");
  const routes = {
    lead: {
      eyebrow: "建立信任 · 引导咨询",
      name: "获客短片",
      description:
        "用观点、故事、案例或场景吸引目标用户，让对方愿意继续了解你。",
      inputs: "业务目标、受众、核心观点",
      output: "可发布的内容获客短片",
    },
    commerce: {
      eyebrow: "展示产品 · 推动购买",
      name: "带货视频",
      description:
        "围绕真实商品卖点、使用场景和购买理由，制作人物或剧情带货内容。",
      inputs: "商品资料、卖点、参考素材",
      output: "可发布的商品带货视频",
    },
    entertainment: {
      eyebrow: "唱歌跳舞 · 剧情创意",
      name: "娱乐短片",
      description: "让确认的人物完成唱歌、跳舞、轻剧情或其他创意表达。",
      inputs: "人物、音乐或动作参考、创意方向",
      output: "可发布的娱乐短片",
    },
  } as const;
  const selected = routes[route];
  return (
    <section className="short-video-studio" aria-label="原创短片制作流程">
      <div className="prototype-banner">
        <span>使用流程</span>
        <strong>先选择这条视频要完成什么</strong>
        <p>当前不会上传素材、不会开始生成，也不会产生费用。</p>
      </div>
      <header className="short-video-hero">
        <div>
          <small>原创短片</small>
          <h1>先说想达到什么效果，再选择最合适的拍法</h1>
          <p>
            不用先研究属于哪种工作流。先选获客、带货或娱乐，再选口播加素材、剧情、产品展示或唱跳表演。
          </p>
        </div>
        <aside>
          <span>两步找到正确入口</span>
          <strong>先选目的 → 再选表达形式 → 进入对应制作流程</strong>
        </aside>
      </header>
      <section className="short-video-picker">
        <div className="preview-section-title">
          <small>第 1 步</small>
          <h2>这次想做哪一种短片？</h2>
          <p>先按业务目标选择，后面的资料和制作流程会随之调整。</p>
        </div>
        <div className="short-video-route-grid">
          {Object.entries(routes).map(([key, item]) => (
            <button
              type="button"
              key={key}
              className={route === key ? "selected" : ""}
              onClick={() => setRoute(key as keyof typeof routes)}
            >
              <span>{route === key ? "✓" : ""}</span>
              <small>{item.eyebrow}</small>
              <h3>{item.name}</h3>
              <p>{item.description}</p>
            </button>
          ))}
        </div>
      </section>
      <section className="short-video-picker format-picker">
        <div className="preview-section-title">
          <small>第 2 步</small>
          <h2>准备怎么表达？</h2>
          <p>同一个获客或带货目标，可以用完全不同的形式完成。</p>
        </div>
        <div className="short-video-route-grid format-grid">
          {([
            ["talking_material", "口播＋素材", "人物讲清观点，同时穿插门店、工厂、案例或产品画面。"],
            ["story", "剧情 / 段子", "用人物关系、冲突和转折完成获客、带货或娱乐表达。"],
            ["product_demo", "产品 / 场景展示", "以产品使用、环境和动作展示为主，口播不是主体。"],
            ["performance", "唱歌 / 跳舞 / 表演", "以音乐、动作和人物表现为主的娱乐短片。"],
            ["unsure", "我还不确定", "先提供目标和素材，由系统给出更合适的制作建议。"],
          ] as const).map(([key, name, description]) => (
            <button
              type="button"
              key={key}
              className={format === key ? "selected" : ""}
              onClick={() => setFormat(key)}
            >
              <span>{format === key ? "✓" : ""}</span>
              <h3>{name}</h3>
              <p>{description}</p>
            </button>
          ))}
        </div>
      </section>
      <section className="short-video-route-summary">
        <div>
          <small>当前选择</small>
          <h2>{selected.name} · {shortVideoFormatName(format)}</h2>
          <p>{shortVideoRouteRecommendation(route, format)}</p>
        </div>
        <dl>
          <div>
            <dt>开始时提供</dt>
            <dd>{selected.inputs}</dd>
          </div>
          <div>
            <dt>最终拿到</dt>
            <dd>{selected.output}</dd>
          </div>
          <div>
            <dt>需要你确认</dt>
            <dd>创作方向、人物与素材、费用、最终成片</dd>
          </div>
        </dl>
        <button type="button" disabled>
          {format === "talking_material"
            ? "前往 AI 口播（剪辑衔接正在设计）"
            : format === "performance"
              ? "前往唱歌与跳舞（功能开放后可用）"
              : "开始制作（对应流程开放后可用）"}
        </button>
      </section>
    </section>
  );
}

function shortVideoFormatName(format: "talking_material" | "story" | "product_demo" | "performance" | "unsure") {
  return {
    talking_material: "口播＋素材",
    story: "剧情 / 段子",
    product_demo: "产品 / 场景展示",
    performance: "唱歌 / 跳舞 / 表演",
    unsure: "待推荐形式",
  }[format];
}

function shortVideoRouteRecommendation(
  route: "lead" | "commerce" | "entertainment",
  format: "talking_material" | "story" | "product_demo" | "performance" | "unsure",
) {
  if (format === "talking_material") return "先由 AI 口播完成人物讲话，再由剪辑流程加入场景、案例或产品素材。";
  if (format === "performance") return "使用唱歌、跳舞或动作迁移流程，不混入口播和带货的表单。";
  if (format === "unsure") return "先收集业务目标、受众和现有素材，再推荐一种主形式，不让你自己猜工作流。";
  if (route === "commerce" && format === "product_demo") return "围绕商品事实、使用动作和真实场景设计镜头，再进入人物、分镜、生成与剪辑。";
  if (route === "lead" && format === "story") return "先把业务观点转成冲突和转折，再进入人物、场景、分镜与成片。";
  return "按当前目标和表达形式进入独立制作流程，避免把不同类型的视频硬塞进同一套规则。";
}

const talkingStages: Array<{ id: TalkingStage; title: string; short: string }> =
  [
    { id: "mode", title: "选择制作方式", short: "模式" },
    { id: "setup", title: "一次设置", short: "设置" },
    { id: "preflight", title: "方案确认", short: "确认" },
    { id: "sample", title: "确认样片", short: "样片" },
    { id: "production", title: "批量制作", short: "生成" },
    { id: "qc", title: "质量检查", short: "质检" },
    { id: "editing", title: "成片剪辑", short: "剪辑" },
    { id: "result", title: "拿到成片", short: "成果" },
  ];

const supportedVoiceDialectOptions = [
  { value: "上海话", label: "上海话" },
  { value: "陕西关中话", label: "陕西关中话" },
  { value: "四川话", label: "四川话" },
  { value: "粤语", label: "粤语" },
  { value: "吴语", label: "吴语" },
  { value: "东北话", label: "东北话" },
  { value: "河南话", label: "河南话" },
  { value: "陕西话", label: "陕西话" },
  { value: "山东话", label: "山东话" },
  { value: "天津话", label: "天津话" },
  { value: "闽南话", label: "闽南话" },
] as const;

const talkingModeInfo: Record<
  TalkingMode,
  {
    name: string;
    eyebrow: string;
    description: string;
    fit: string;
    accent: string;
  }
> = {
  standard: {
    name: "标准口播",
    eyebrow: "稳定 · 速度快",
    description: "适合知识分享、课程讲解、日常口播和批量内容。",
    fit: "默认推荐给大多数口播任务",
    accent: "blue",
  },
  boutique: {
    name: "精品口播",
    eyebrow: "自然 · 速度慢",
    description: "更重视微表情和身体反应，适合短视频开场、广告和重点片段。",
    fit: "生成段不超过10秒；长音频会带重叠把手分段并自动优化接缝",
    accent: "violet",
  },
  native: {
    name: "原生口播",
    eyebrow: "真实表达 · 长稿可拆分",
    description: "面部细节、微表情、表达节奏和肢体语言一起生成，更接近真人自然表达。",
    fit: "短稿直接生成，长稿先按完整语义规划分段",
    accent: "gold",
  },
  singing: {
    name: "唱歌模式",
    eyebrow: "歌曲 · 对口型",
    description: "让已确认的人物跟随歌曲演唱，按乐句生成后再剪成完整视频。",
    fit: "需要提供有权使用的歌曲音频",
    accent: "pink",
  },
};

function talkingModeName(mode: TalkingMode | undefined) {
  return mode ? talkingModeInfo[mode]?.name || "AI口播" : "AI口播";
}

function countChineseCharacters(value: string) {
  return (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
}

function savedTalkingHeadJob(): TalkingJob | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      window.localStorage.getItem("workbench-talking-head-job") || "null",
    ) as TalkingJob | null;
    return value?.id ? value : null;
  } catch {
    return null;
  }
}

function savedTalkingHeadPersonAsset(): TalkingHeadPersonAsset | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      window.localStorage.getItem("workbench-talking-head-person-asset") ||
        "null",
    ) as TalkingHeadPersonAsset | null;
    return value?.asset_id && value?.project_id ? value : null;
  } catch {
    return null;
  }
}

function savedTalkingHeadProjectId(): string {
  if (typeof window === "undefined") return "";
  const stored = window.localStorage.getItem("workbench-talking-head-project-id") || "";
  if (/^[a-f0-9-]{36}$/i.test(stored)) return stored;
  const assetProjectId = savedTalkingHeadPersonAsset()?.project_id || "";
  if (/^[a-f0-9-]{36}$/i.test(assetProjectId)) return assetProjectId;
  const created = window.crypto.randomUUID();
  window.localStorage.setItem("workbench-talking-head-project-id", created);
  return created;
}

const talkingFiles = new Map<string, {voice: File | null; left: File | null; right: File | null; speech: File | null}>();
function savedTalkingDraft() {
  if (typeof window === "undefined") return null;
  try {
    const draft = JSON.parse(window.localStorage.getItem("workbench-talking-draft-v1") || "null");
    const job = savedTalkingHeadJob();
    return draft?.version === 1 && (draft.jobId || null) === (job?.id || null) ? draft : null;
  } catch { return null; }
}

function TalkingHeadStudio({
  initialMode = "standard",
  onOpenModels,
}: {
  initialMode?: TalkingMode;
  onOpenModels?: (route: "ai_model" | "real_person" | null) => void;
}) {
  const [draft] = useState(() => {
    const saved = savedTalkingDraft();
    if (saved) return saved;
    const job = savedTalkingHeadJob();
    if (!job) return null;
    return {mode: job.mode, script: job.confirmed_script || restoredNativeScript(job), speechSource: job.speech_source === "audio" ? "audio" : "clone",
      voiceLanguageMode: job.voice_language_mode || "mandarin", voiceDialect: job.voice_dialect || "上海话", voiceCloneRoute: job.voice_clone_route === "expressive" ? "expressive" : "fidelity",
      referenceAudioTranscript: job.reference_audio_transcript || "", voiceEmotionPreset: job.voice_emotion_preset || "natural", voiceSpeechPace: job.voice_speech_pace || "normal", dialectScriptConfirmed: Boolean(job.dialect_script_confirmed),
      reusedVoiceJobId: job.voice_reference ? job.id : "", reusedLeftVoiceJobId: job.voice_reference_left ? job.id : "", reusedRightVoiceJobId: job.voice_reference_right ? job.id : "", voiceAuthorized: Boolean(job.voice_reference || (job.voice_reference_left && job.voice_reference_right)),
      nativeVoiceMode: job.native_voice_mode || "random", nativeDialogueMode: job.native_dialogue_mode || "single", nativeDialogueStyle: job.native_dialogue_style || "natural_interview", nativeRunStrategy: job.native_run_strategy || "stable",
      performanceRequirement: job.performance_requirement, nativeWorkflowVariant: job.native_workflow_variant || "production", nativeNeutralHandPoseConfirmed: Boolean(job.native_neutral_hand_pose_confirmed),
      qualityMode: job.quality_mode || "daily", targetRatio: normalizeTalkingTargetRatio(job.target_ratio), concurrency: job.concurrency || 1, generationStrategy: job.generation_strategy || "sample_first", directGenerationAcknowledged: Boolean(job.direct_generation_acknowledged)};
  });
  const [retainedFiles] = useState(() => talkingFiles.get(savedTalkingHeadProjectId()));
  const [stage, setStage] = useState<TalkingStage>(() => {
    const resume = savedTalkingDraft();
    if (resume?.stage) return resume.stage;
    const job = savedTalkingHeadJob();
    if (!job) return "mode";
    if (job.state === "approved") return "result";
    if (
      [
        "voice_preflight",
        "voice_running",
        "voice_review",
        "voice_failed",
        "preflight",
      ].includes(job.state)
    )
      return "preflight";
    if (["production_running", "editing_running"].includes(job.state))
      return job.state === "editing_running" ? "editing" : "production";
    if (job.state === "failed" && job.sample?.qc_status === "approved_sample")
      return "production";
    if (["running", "sample_running", "sample_review", "segment_review", "completed", "failed"].includes(job.state))
      return "sample";
    return "mode";
  });
  const [mode, setMode] = useState<TalkingMode>(() => draft?.mode ?? (initialMode));
  const [speechSource, setSpeechSource] = useState<"clone" | "audio">(() => draft?.speechSource ?? ("clone"));
  const [voiceLanguageMode, setVoiceLanguageMode] = useState<"mandarin" | "dialect">(() => draft?.voiceLanguageMode ?? ("mandarin"));
  const [voiceDialect, setVoiceDialect] = useState(() => draft?.voiceDialect ?? ("上海话"));
  const [voiceDialectDetail, setVoiceDialectDetail] = useState(() => draft?.voiceDialectDetail ?? (""));
  const [dialectScriptMode, setDialectScriptMode] = useState<"already_dialect" | "convert_from_mandarin">(() => draft?.dialectScriptMode ?? ("already_dialect"));
  const [dialectReferenceExamples, setDialectReferenceExamples] = useState(() => draft?.dialectReferenceExamples ?? (""));
  const [dialectDraft, setDialectDraft] = useState(() => draft?.dialectDraft ?? (""));
  const [dialectDraftConfirmed, setDialectDraftConfirmed] = useState(() => draft?.dialectDraftConfirmed ?? (false));
  const [dialectDraftLoading, setDialectDraftLoading] = useState(false);
  const [dialectDraftError, setDialectDraftError] = useState("");
  const [dialectDraftUncertain, setDialectDraftUncertain] = useState<string[]>([]);
  const [dialectDraftNotes, setDialectDraftNotes] = useState("");
  const dialectDraftRequestId = useRef(0);
  const [voiceCloneRoute, setVoiceCloneRoute] = useState<"fidelity" | "expressive">(() => draft?.voiceCloneRoute ?? ("fidelity"));
  const [referenceAudioTranscript, setReferenceAudioTranscript] = useState(() => draft?.referenceAudioTranscript ?? (""));
  const [voiceEmotionPreset, setVoiceEmotionPreset] = useState<"natural" | "happy" | "urgent" | "calm" | "wronged" | "angry">(() => draft?.voiceEmotionPreset ?? ("natural"));
  const [voiceSpeechPace, setVoiceSpeechPace] = useState<"slow" | "normal" | "fast">(() => draft?.voiceSpeechPace ?? ("normal"));
  const [dialectScriptConfirmed, setDialectScriptConfirmed] = useState(() => draft?.dialectScriptConfirmed ?? (false));
  const [nativeVoiceMode, setNativeVoiceMode] = useState<"random" | "reference">(() => draft?.nativeVoiceMode ?? ("random"));
  const [nativeDialogueMode, setNativeDialogueMode] = useState<
    "single" | "two_speaker_alternating"
  >(() => draft?.nativeDialogueMode ?? ("single"));
  const [nativeDialogueStyle, setNativeDialogueStyle] = useState<
    "natural_interview" | "structured_discussion"
  >(() => draft?.nativeDialogueStyle ?? ("natural_interview"));
  const [nativeNeutralHandPoseConfirmed, setNativeNeutralHandPoseConfirmed] =
    useState(() => draft?.nativeNeutralHandPoseConfirmed ?? (false));
  const [nativeRunStrategy, setNativeRunStrategy] = useState<"economy" | "stable">(() => draft?.nativeRunStrategy ?? ("economy"));
  const [performanceRequirement, setPerformanceRequirement] = useState(() => draft?.performanceRequirement ?? ("松弛、可信，像面对镜头和熟人分享；微表情自然，肢体动作幅度与语气和内容相匹配。"));
  const [nativeWorkflowVariant, setNativeWorkflowVariant] = useState<
    "production" | "composition_anchor_v0_1" | "composition_first_last_v0_2"
  >(() => draft?.nativeWorkflowVariant ?? ("production"));
  const [nativeCompositionAbVisible] = useState(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("nativeCompositionAb") === "1",
  );
  const [nativeDialogueAbVisible] = useState(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("nativeDialogueAb") === "1",
  );
  const [boutiqueCameraExperiment] = useState(() => {
    if (typeof window === "undefined") return "independent_clean_parallel_v1";
    const requested = new URLSearchParams(window.location.search).get(
      "boutiqueCameraVariant",
    );
    return [
      "structured_prompt_v0_1",
      "structured_prompt_v0_2",
      "structured_prompt_v0_3",
      "structured_reference_v0_2",
      "independent_clean_parallel_v1",
    ].includes(requested || "")
      ? requested!
      : "independent_clean_parallel_v1";
  });
  const [script, setScript] = useState(() => draft?.script ?? ("今天用一分钟，讲清楚怎样让一个人也能稳定做内容。"));
  const [voiceAuthorized, setVoiceAuthorized] = useState(() => Boolean((retainedFiles?.voice || draft?.reusedVoiceJobId || ((retainedFiles?.left || draft?.reusedLeftVoiceJobId) && (retainedFiles?.right || draft?.reusedRightVoiceJobId))) && draft?.voiceAuthorized));
  const [voiceFileName, setVoiceFileName] = useState(() => retainedFiles?.voice?.name || draft?.voiceFileName || "");
  const [voiceFile, setVoiceFile] = useState<File | null>(() => retainedFiles?.voice || null);
  const [leftVoiceFileName, setLeftVoiceFileName] = useState(() => retainedFiles?.left?.name || "");
  const [leftVoiceFile, setLeftVoiceFile] = useState<File | null>(() => retainedFiles?.left || null);
  const [rightVoiceFileName, setRightVoiceFileName] = useState(() => retainedFiles?.right?.name || "");
  const [rightVoiceFile, setRightVoiceFile] = useState<File | null>(() => retainedFiles?.right || null);
  const [reusedVoiceJobId, setReusedVoiceJobId] = useState(() => draft?.reusedVoiceJobId ?? (""));
  const [reusedLeftVoiceJobId, setReusedLeftVoiceJobId] = useState(() => draft?.reusedLeftVoiceJobId ?? (""));
  const [reusedRightVoiceJobId, setReusedRightVoiceJobId] = useState(() => draft?.reusedRightVoiceJobId ?? (""));
  const [speechFileName, setSpeechFileName] = useState(() => retainedFiles?.speech?.name || draft?.speechFileName || "");
  const [speechDuration, setSpeechDuration] = useState<number | null>(() => draft?.speechDuration || null);
  const [speechFile, setSpeechFile] = useState<File | null>(() => retainedFiles?.speech || null);
  const [masterFileName, setMasterFileName] = useState("");
  const [, setMasterFile] = useState<File | null>(null);
  const [personAsset, setPersonAsset] = useState<TalkingHeadPersonAsset | null>(
    () => savedTalkingHeadJob()?.person_asset || savedTalkingHeadPersonAsset(),
  );
  const [talkingProjectId, setTalkingProjectId] = useState(() =>
    savedTalkingHeadJob()?.person_asset?.project_id || savedTalkingHeadProjectId(),
  );
  const [masterPreviewUrl, setMasterPreviewUrl] = useState(() => {
    const job = savedTalkingHeadJob();
    const asset = job?.person_asset || savedTalkingHeadPersonAsset();
    if (asset?.asset_id)
      return `${API}/talking-head/person-assets/${asset.asset_id}/file`;
    return job?.image ? `${API}/talking-head/jobs/${job.id}/master-image` : "";
  });
  const [personAssetUploading, setPersonAssetUploading] = useState(false);
  const [personPreviewOpen, setPersonPreviewOpen] = useState(false);
  const closePersonPreview = useCallback(() => setPersonPreviewOpen(false), []);
  useDialogFocus(personPreviewOpen, "人物母版大图", closePersonPreview);
  const [qualityMode, setQualityMode] = useState<
    "daily" | "clear" | "premium"
  >(() => draft?.qualityMode ?? ("daily"));
  const [targetRatio, setTargetRatio] = useState<TalkingTargetRatio>(() => draft?.targetRatio ?? ("9:16"));
  const [concurrency, setConcurrency] = useState<1 | 3 | 5>(() => draft?.concurrency ?? (1));
  const [generationStrategy, setGenerationStrategy] = useState<
    "sample_first" | "direct_full"
  >(() => draft?.generationStrategy ?? ("sample_first"));
  const [boutiqueCameraStyle, setBoutiqueCameraStyle] = useState<
    "stable_natural" | "strict_locked" | "handheld_selfie" | "walk_and_talk"
  >(() =>
    savedTalkingHeadJob()?.camera_continuity === "handheld_selfie" ||
    savedTalkingHeadJob()?.camera_continuity === "walk_and_talk"
      ? savedTalkingHeadJob()!.camera_continuity as "handheld_selfie" | "walk_and_talk"
      : "stable_natural",
  );
  const [directGenerationAcknowledged, setDirectGenerationAcknowledged] =
    useState(() => draft?.directGenerationAcknowledged ?? (false));
  const [talkingJob, setTalkingJob] = useState<TalkingJob | null>(() =>
    savedTalkingHeadJob(),
  );
  const [talkingJobs, setTalkingJobs] = useState<TalkingJob[]>([]);
  const reusableVoiceJobs = talkingJobs
    .filter((job) => Boolean(job.voice_reference))
    .slice(0, 8);
  const selectedReusableVoiceJob = reusableVoiceJobs.find(
    (job) => job.id === reusedVoiceJobId,
  );
  const recentReferenceVoiceJob = reusableVoiceJobs[0];
  const recentPersonAsset = talkingJobs.find((job) => Boolean(job.person_asset))
    ?.person_asset;
  const [talkingError, setTalkingError] = useState("");
  const [songAuthorized, setSongAuthorized] = useState(false);
  const [nativeDialogueConfirmedFor, setNativeDialogueConfirmedFor] =
    useState("");
  const [reviewVersion, setReviewVersion] = useState<number | null>(null);
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);
  const [regenerateReason, setRegenerateReason] = useState("模型随机效果不满意");
  const actionLock = useRef(false);
  const [actionPending, setActionPending] = useState(false);
  const [mediaFailures, setMediaFailures] = useState<Record<string, boolean>>({});
  const mediaKey = `${talkingJob?.id}:${reviewVersion || talkingJob?.current_version || 1}`;
  const mediaFailed = Object.keys(mediaFailures).some((key) => key.startsWith(mediaKey + ":") && mediaFailures[key]);
  const requiredMediaParts = talkingJob?.state === "segment_review" ? (talkingJob.segments || []).map((_, index) => String(index)) : ["main"];
  const reviewMediaReady = requiredMediaParts.length > 0 && requiredMediaParts.every((part) => mediaFailures[mediaKey + ":" + part] === false);
  const voiceMediaReady = mediaFailures[mediaKey + ":voice"] === false;
  const markMedia = (part: string, failed: boolean) => setMediaFailures((current) => ({...current, [mediaKey + ":" + part]: failed}));
  useEffect(() => {
    talkingFiles.set(talkingProjectId, {voice: voiceFile, left: leftVoiceFile, right: rightVoiceFile, speech: speechFile});
  }, [talkingProjectId, voiceFile, leftVoiceFile, rightVoiceFile, speechFile]);
  const [draftSaveError, setDraftSaveError] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem("workbench-talking-draft-v1", JSON.stringify({version: 1, jobId: talkingJob?.id || null, stage, talkingProjectId, voiceAuthorized, mode, speechSource, voiceLanguageMode, voiceDialect, voiceDialectDetail, dialectScriptMode, dialectReferenceExamples, dialectDraft, dialectDraftConfirmed, voiceCloneRoute, referenceAudioTranscript, voiceEmotionPreset, voiceSpeechPace, dialectScriptConfirmed, nativeVoiceMode, nativeDialogueMode, nativeDialogueStyle, nativeNeutralHandPoseConfirmed, nativeRunStrategy, performanceRequirement, nativeWorkflowVariant, script, reusedVoiceJobId, reusedLeftVoiceJobId, reusedRightVoiceJobId, qualityMode, targetRatio, concurrency, generationStrategy, directGenerationAcknowledged, voiceFileName, speechFileName, speechDuration, leftVoiceFileName, rightVoiceFileName}));
      setDraftSaveError(false);
    } catch { setDraftSaveError(true); }
  }, [talkingJob?.id, stage, talkingProjectId, voiceAuthorized, mode, speechSource, voiceLanguageMode, voiceDialect, voiceDialectDetail, dialectScriptMode, dialectReferenceExamples, dialectDraft, dialectDraftConfirmed, voiceCloneRoute, referenceAudioTranscript, voiceEmotionPreset, voiceSpeechPace, dialectScriptConfirmed, nativeVoiceMode, nativeDialogueMode, nativeDialogueStyle, nativeNeutralHandPoseConfirmed, nativeRunStrategy, performanceRequirement, nativeWorkflowVariant, script, reusedVoiceJobId, reusedLeftVoiceJobId, reusedRightVoiceJobId, qualityMode, targetRatio, concurrency, generationStrategy, directGenerationAcknowledged, voiceFileName, speechFileName, speechDuration, leftVoiceFileName, rightVoiceFileName]);
  const directProduction = isCompleteTalkingVideo(talkingJob);
  const submissionPlan = talkingSubmissionPlan(talkingJob);
  const effectiveVoiceDialect = voiceDialectDetail.trim()
    ? `${voiceDialect.trim()}（${voiceDialectDetail.trim()}）`
    : voiceDialect.trim();
  const dialectConfirmationComplete = dialectScriptMode === "convert_from_mandarin"
    ? Boolean(dialectDraft.trim() && dialectDraftConfirmed)
    : dialectScriptConfirmed;
  const effectiveCloneScript =
    voiceLanguageMode === "dialect" && dialectScriptMode === "convert_from_mandarin"
      ? dialectDraft
      : script;
  const missingSetupItems = [
    !personAsset && "人物母版图",
    personAssetUploading && "等待人物图保存",
    mode === "native" && !script.trim() && "逐字口播稿",
    mode !== "native" && speechSource === "clone" && !effectiveCloneScript.trim() && "确认后的口播稿",
    mode !== "native" && speechSource === "audio" && !speechFile && "录好的口播音频",
    ((mode !== "native" && speechSource === "clone") || (mode === "native" && nativeDialogueMode === "single" && nativeVoiceMode === "reference")) && !(voiceFile || reusedVoiceJobId) && "声音参考",
    ((mode !== "native" && speechSource === "clone") || (mode === "native" && nativeVoiceMode === "reference")) && !voiceAuthorized && "声音使用授权",
    mode === "native" && nativeDialogueMode === "two_speaker_alternating" && !(leftVoiceFile || reusedLeftVoiceJobId) && "左侧声音参考",
    mode === "native" && nativeDialogueMode === "two_speaker_alternating" && !(rightVoiceFile || reusedRightVoiceJobId) && "右侧声音参考",
    mode === "native" && nativeDialogueMode === "two_speaker_alternating" && !nativeNeutralHandPoseConfirmed && "双人姿态确认",
    mode !== "native" && speechSource === "clone" && voiceLanguageMode === "dialect" && !dialectConfirmationComplete && "方言稿确认",
    mode !== "native" && speechSource === "clone" && voiceLanguageMode === "dialect" && !effectiveVoiceDialect && "方言选择",
    mode !== "native" && speechSource === "clone" && voiceLanguageMode === "dialect" && voiceCloneRoute === "fidelity" && !referenceAudioTranscript.trim() && "参考声音逐字稿",
    generationStrategy === "direct_full" && !directGenerationAcknowledged && "跳过样片确认",
    mode === "singing" && !songAuthorized && "歌曲使用授权",
  ].filter(Boolean);
  const singleNativeProduction = talkingJob?.mode === "native" && !talkingJob.is_long;
  const independentH3LongformProduction =
    talkingJob?.boutique_camera_experiment === "independent_clean_parallel_v1";
  const currentVersion = talkingJob?.current_version || 1;
  const activeReviewVersion = reviewVersion || currentVersion;
  const talkingVersions = talkingJob
      ? [
        ...(talkingJob.generation_versions || []).filter(
          (item) => item.version !== currentVersion,
        ),
        {
          version: currentVersion,
          output: talkingJob.output || talkingJob.final_output || "",
          usage: talkingJob.usage || null,
          state: talkingJob.state,
          generation_seed: talkingJob.generation_seed ?? null,
          variation_mode: talkingJob.variation_mode || (currentVersion === 1 ? "workflow_default" : "new_random_version"),
        },
      ].sort((left, right) => left.version - right.version)
    : [];
  const nativeReviewKey = talkingJob?.mode === "native"
    ? `${talkingJob.id}:${activeReviewVersion}`
    : "";
  const nativeDialogueConfirmed =
    Boolean(nativeReviewKey) && nativeDialogueConfirmedFor === nativeReviewKey;
  const directReviewStage = { id: "sample" as TalkingStage, title: "确认成片", short: "确认" };
  const visibleTalkingStages = directProduction
    ? talkingJob?.is_long
      ? [talkingStages[0], talkingStages[1], talkingStages[2], talkingStages[4], talkingStages[6], directReviewStage, talkingStages[7]]
      : [talkingStages[0], talkingStages[1], talkingStages[2], talkingStages[4], directReviewStage, talkingStages[7]]
    : talkingStages.filter((item) =>
        talkingJob?.is_long
          ? ["mode", "setup", "preflight", "sample", "production", "editing", "result"].includes(item.id)
          : ["mode", "setup", "preflight", "sample", "result"].includes(item.id),
      );
  const visibleCurrentIndex = visibleTalkingStages.findIndex(
    (item) => item.id === stage,
  );
  const currentMode = talkingModeInfo[mode];
  const boutiqueDurations =
    mode === "boutique" && speechDuration
      ? balancedBoutiqueDurations(speechDuration)
      : [];
  const go = (next: TalkingStage) => {
    setStage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const clearDialectDraft = () => {
    dialectDraftRequestId.current += 1;
    setDialectDraft("");
    setDialectDraftConfirmed(false);
    setDialectDraftLoading(false);
    setDialectDraftError("");
    setDialectDraftUncertain([]);
    setDialectDraftNotes("");
  };
  const createDialectDraft = async () => {
    if (!script.trim()) {
      setDialectDraftError("请先填写要转换的普通话原稿。");
      return;
    }
    if (!effectiveVoiceDialect) {
      setDialectDraftError("请先填写具体方言或地区。");
      return;
    }
    const requestId = dialectDraftRequestId.current + 1;
    dialectDraftRequestId.current = requestId;
    setDialectDraftLoading(true);
    setDialectDraftError("");
    setDialectDraftConfirmed(false);
    try {
      const response = await fetch(`${API}/talking-head/dialect-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceText: script,
          dialect: voiceDialect.trim(),
          regionHint: voiceDialectDetail.trim(),
          referenceExamples: dialectReferenceExamples,
        }),
      });
      const payload = await response.json();
      if (requestId !== dialectDraftRequestId.current) return;
      if (!response.ok)
        throw new Error(payload.error || "方言草稿暂时没有生成。");
      setDialectDraft(payload.draft.draft || "");
      setDialectDraftUncertain(payload.draft.uncertain_phrases || []);
      setDialectDraftNotes(payload.draft.notes || "");
    } catch (error) {
      if (requestId !== dialectDraftRequestId.current) return;
      setDialectDraftError(
        error instanceof Error
          ? error.message
          : "方言草稿暂时没有生成，不会自动重试。",
      );
    } finally {
      if (requestId === dialectDraftRequestId.current)
        setDialectDraftLoading(false);
    }
  };
  const uploadPersonMaster = async (file: File | null) => {
    if (!file) return;
    const localPreview = URL.createObjectURL(file);
    setMasterFile(file);
    setMasterFileName(file.name);
    setMasterPreviewUrl(localPreview);
    setPersonAsset(null);
    setPersonAssetUploading(true);
    setTalkingError("");
    try {
      const form = new FormData();
      form.set("image", file);
      form.set("project_id", talkingProjectId);
      const response = await fetch(`${API}/talking-head/person-assets`, {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "人物母版保存失败，请重新选择。");
      const asset = payload.asset as TalkingHeadPersonAsset;
      setPersonAsset(asset);
      setMasterFileName(asset.original_name);
      setMasterPreviewUrl(
        `${API}/talking-head/person-assets/${asset.asset_id}/file`,
      );
      window.localStorage.setItem(
        "workbench-talking-head-person-asset",
        JSON.stringify(asset),
      );
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "人物母版保存失败，请重新选择。",
      );
    } finally {
      URL.revokeObjectURL(localPreview);
      setPersonAssetUploading(false);
    }
  };
  const startNewTalkingProject = () => {
    const nextProjectId = window.crypto.randomUUID();
    setTalkingJob(null);
    setTalkingError("");
    setMode(initialMode);
    setSpeechSource("clone");
    setVoiceLanguageMode("mandarin");
    setVoiceDialect("上海话");
    setVoiceDialectDetail("");
    setDialectScriptMode("already_dialect");
    setDialectReferenceExamples("");
    clearDialectDraft();
    setVoiceCloneRoute("fidelity");
    setReferenceAudioTranscript("");
    setVoiceEmotionPreset("natural");
    setVoiceSpeechPace("normal");
    setDialectScriptConfirmed(false);
    setNativeVoiceMode("random");
    setNativeDialogueMode("single");
    setNativeDialogueStyle("natural_interview");
    setNativeNeutralHandPoseConfirmed(false);
    setNativeRunStrategy("economy");
    setPerformanceRequirement("松弛、可信，像面对镜头和熟人分享；微表情自然，肢体动作幅度与语气和内容相匹配。");
    setScript("今天用一分钟，讲清楚怎样让一个人也能稳定做内容。");
    setVoiceAuthorized(false);
    setVoiceFileName("");
    setVoiceFile(null);
    setLeftVoiceFileName("");
    setLeftVoiceFile(null);
    setRightVoiceFileName("");
    setRightVoiceFile(null);
    setReusedVoiceJobId("");
    setReusedLeftVoiceJobId("");
    setReusedRightVoiceJobId("");
    setSpeechFileName("");
    setSpeechDuration(null);
    setSpeechFile(null);
    setMasterFileName("");
    setMasterFile(null);
    setPersonAsset(null);
    setTalkingProjectId(nextProjectId);
    setMasterPreviewUrl("");
    setPersonPreviewOpen(false);
    setQualityMode("daily");
    setTargetRatio("9:16");
    setConcurrency(1);
    setGenerationStrategy("sample_first");
    setBoutiqueCameraStyle("stable_natural");
    setDirectGenerationAcknowledged(false);
    setSongAuthorized(false);
    setNativeDialogueConfirmedFor("");
    window.localStorage.removeItem("workbench-talking-head-job");
    window.localStorage.removeItem("workbench-talking-head-person-asset");
    window.localStorage.setItem("workbench-talking-head-project-id", nextProjectId);
    go("mode");
  };
  const restoreTalkingSetupFromJob = (job: TalkingJob) => {
    setTalkingJob(job);
    setMode(job.mode);
    setSpeechSource(
      job.mode === "native" ||
        job.speech_source === "clone" ||
        job.speech_source === "native_reference"
        ? "clone"
        : "audio",
    );
    setScript(job.confirmed_script ?? (job.mode === "native" ? restoredNativeScript(job) : ""));
    setVoiceLanguageMode(job.voice_language_mode || "mandarin");
    setVoiceDialect(job.voice_dialect || "上海话");
    setVoiceDialectDetail("");
    setDialectScriptMode("already_dialect");
    setDialectScriptConfirmed(Boolean(job.dialect_script_confirmed));
    clearDialectDraft();
    setVoiceCloneRoute(job.voice_clone_route === "expressive" ? "expressive" : "fidelity");
    setReferenceAudioTranscript(job.reference_audio_transcript || "");
    setVoiceEmotionPreset(job.voice_emotion_preset || "natural");
    setVoiceSpeechPace(job.voice_speech_pace || "normal");
    setVoiceFile(null);
    setVoiceFileName(job.voice_reference?.split(/[\\/]/).pop() || "");
    setReusedVoiceJobId(job.voice_reference ? job.id : "");
    setVoiceAuthorized(Boolean(job.voice_reference));
    setSpeechFile(null);
    setSpeechFileName("");
    setTalkingError(job.speech_source === "audio" ? "稿件和人物设置已恢复，请重新选择录好的音频。旧任务和成片仍保留。" : "");
    if (job.mode === "native") {
      const dialogueMode =
        job.native_dialogue_mode === "two_speaker_alternating"
          ? "two_speaker_alternating"
          : "single";
      setNativeVoiceMode(
        job.native_voice_mode ||
          (job.speech_source === "native_natural" ? "random" : "reference"),
      );
      setNativeDialogueMode(dialogueMode);
      setNativeDialogueStyle(
        job.native_dialogue_style === "structured_discussion"
          ? "structured_discussion"
          : "natural_interview",
      );
      setNativeNeutralHandPoseConfirmed(
        Boolean(job.native_neutral_hand_pose_confirmed),
      );
      setNativeRunStrategy(job.native_run_strategy || "stable");
      setNativeWorkflowVariant(job.native_workflow_variant || "production");
      setPerformanceRequirement(
        job.performance_requirement ||
          "松弛、可信，像面对镜头和熟人分享；微表情自然，肢体动作幅度与语气和内容相匹配。",
      );
      const restoredScript = job.confirmed_script || restoredNativeScript(job);
      if (restoredScript) setScript(restoredScript);
      setVoiceFile(null);
      setLeftVoiceFile(null);
      setRightVoiceFile(null);
      if (dialogueMode === "two_speaker_alternating") {
        setLeftVoiceFileName(
          job.voice_reference_left?.split("/").pop() || "",
        );
        setRightVoiceFileName(
          job.voice_reference_right?.split("/").pop() || "",
        );
        setReusedLeftVoiceJobId(job.voice_reference_left ? job.id : "");
        setReusedRightVoiceJobId(job.voice_reference_right ? job.id : "");
        setReusedVoiceJobId("");
        setVoiceAuthorized(
          Boolean(job.voice_reference_left && job.voice_reference_right),
        );
      } else {
        setVoiceFileName(job.voice_reference?.split("/").pop() || "");
        setReusedVoiceJobId(job.voice_reference ? job.id : "");
        setReusedLeftVoiceJobId("");
        setReusedRightVoiceJobId("");
        setVoiceAuthorized(Boolean(job.voice_reference));
      }
    }
    setPersonAsset(job.person_asset || null);
    if (job.person_asset?.project_id)
      setTalkingProjectId(job.person_asset.project_id);
    setMasterFileName(job.person_asset?.original_name || "已登记人物母版图");
    setMasterPreviewUrl(`${API}/talking-head/jobs/${job.id}/master-image`);
    setQualityMode(
      job.quality_mode === "clear" || job.quality_mode === "premium"
        ? job.quality_mode
        : "daily",
    );
    setTargetRatio(normalizeTalkingTargetRatio(job.target_ratio));
    setConcurrency((job.concurrency || 1) >= 3 ? 3 : 1);
    setGenerationStrategy(job.generation_strategy || "sample_first");
    setBoutiqueCameraStyle(
      job.camera_continuity === "handheld_selfie" ||
      job.camera_continuity === "walk_and_talk"
        ? job.camera_continuity
        : "stable_natural",
    );
    setDirectGenerationAcknowledged(Boolean(job.direct_generation_acknowledged));
  };
  const prepareRealJob = async () => {
    if (mode === "singing") return go("preflight");
    if (!personAsset) {
      setTalkingError("请先上传一张人物母版图。");
      return;
    }
    if (speechSource === "audio" && !speechFile) return;
    if (
      mode !== "native" &&
      speechSource === "clone" &&
      (!(voiceFile || reusedVoiceJobId) || !voiceAuthorized)
    )
      return;
    if (mode !== "native" && speechSource === "clone" && voiceLanguageMode === "dialect") {
      if (!effectiveVoiceDialect) {
        setTalkingError("请选择本次使用的方言。");
        return;
      }
      if (!dialectConfirmationComplete) {
        setTalkingError("请先检查并确认最终方言口播稿。");
        return;
      }
      if (voiceCloneRoute === "fidelity" && !referenceAudioTranscript.trim()) {
        setTalkingError("音色还原优先需要填写参考声音的完整逐字稿。");
        return;
      }
    }
    if (
      mode === "native" &&
      nativeDialogueMode === "two_speaker_alternating" &&
      (!(leftVoiceFile || reusedLeftVoiceJobId) ||
        !(rightVoiceFile || reusedRightVoiceJobId) ||
        !voiceAuthorized)
    ) return;
    if (
      mode === "native" &&
      nativeDialogueMode === "single" &&
      nativeVoiceMode === "reference" &&
      (!(voiceFile || reusedVoiceJobId) || !voiceAuthorized)
    ) return;
    setTalkingError("");
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    try {
      const form = new FormData();
      form.set("mode", mode);
      form.set("speech_source", speechSource);
      form.set("quality_mode", qualityMode);
      form.set("target_ratio", targetRatio);
      form.set("concurrency", String(concurrency));
      form.set("generation_strategy", generationStrategy);
      // 说话机制与机位合同按模式隔离：原生口播仍使用原生提示词说话；
      // 精品口播仍由完整音频驱动，只吸收已验证的机位稳定经验。
      form.set(
        "camera_continuity",
        mode === "native" ? "strict_locked" : mode === "boutique" ? boutiqueCameraStyle : "natural",
      );
      if (
        mode === "boutique" &&
        boutiqueCameraStyle === "strict_locked"
      ) {
        // 生产构建会先在服务端渲染，useState 的初始化值因此看不到浏览器查询参数。
        // 真正提交时重新读取当前地址；没有显式实验参数时使用当前正式默认路线。
        const requestedBoutiqueCameraExperiment =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("boutiqueCameraVariant")
            : null;
        const resolvedBoutiqueCameraExperiment = [
          "structured_prompt_v0_1",
          "structured_prompt_v0_2",
          "structured_prompt_v0_3",
          "structured_reference_v0_2",
          "independent_clean_parallel_v1",
        ].includes(requestedBoutiqueCameraExperiment || "")
          ? requestedBoutiqueCameraExperiment!
          : boutiqueCameraExperiment;
        form.set("boutique_camera_experiment", resolvedBoutiqueCameraExperiment);
      }
      form.set(
        "direct_generation_acknowledged",
        String(generationStrategy === "direct_full" && directGenerationAcknowledged),
      );
      if (mode === "native") {
        form.set("script", script);
        form.set("performance_requirement", performanceRequirement);
        form.set("native_voice_mode", nativeVoiceMode);
        if (nativeDialogueAbVisible)
          form.set("native_dialogue_mode", nativeDialogueMode);
        if (nativeDialogueMode === "two_speaker_alternating")
          form.set("native_dialogue_style", nativeDialogueStyle);
        if (nativeDialogueMode === "two_speaker_alternating")
          form.set(
            "native_neutral_hand_pose_confirmed",
            String(nativeNeutralHandPoseConfirmed),
          );
        form.set("native_duration_planning", "adaptive_6_15_candidate");
        form.set("native_run_strategy", qualityMode === "premium" ? "stable" : nativeRunStrategy);
        if (nativeCompositionAbVisible)
          form.set("native_workflow_variant", nativeWorkflowVariant);
        if (nativeDialogueMode === "two_speaker_alternating") {
          if (leftVoiceFile) form.set("voice_left", leftVoiceFile);
          if (rightVoiceFile) form.set("voice_right", rightVoiceFile);
          if (!leftVoiceFile && reusedLeftVoiceJobId)
            form.set("reuse_voice_job_id_left", reusedLeftVoiceJobId);
          if (!rightVoiceFile && reusedRightVoiceJobId)
            form.set("reuse_voice_job_id_right", reusedRightVoiceJobId);
          form.set("voice_authorized", "true");
        } else if (nativeVoiceMode === "reference" && voiceFile) {
          form.set("voice", voiceFile);
          form.set("voice_authorized", "true");
        } else if (nativeVoiceMode === "reference" && reusedVoiceJobId) {
          form.set("reuse_voice_job_id", reusedVoiceJobId);
          form.set("voice_authorized", "true");
        }
      } else if (speechSource === "clone") {
        form.set("script", effectiveCloneScript);
        if (voiceFile) form.set("voice", voiceFile);
        if (!voiceFile && reusedVoiceJobId)
          form.set("reuse_voice_job_id", reusedVoiceJobId);
        form.set("voice_authorized", "true");
        form.set("voice_language_mode", voiceLanguageMode);
        form.set("voice_dialect", voiceLanguageMode === "dialect" ? effectiveVoiceDialect : "");
        form.set(
          "voice_clone_route",
          voiceLanguageMode === "dialect" ? voiceCloneRoute : "legacy",
        );
        form.set(
          "reference_audio_transcript",
          voiceLanguageMode === "dialect" && voiceCloneRoute === "fidelity"
            ? referenceAudioTranscript
            : "",
        );
        form.set("voice_emotion_preset", voiceEmotionPreset);
        form.set("voice_speech_pace", voiceSpeechPace);
        form.set(
          "dialect_script_confirmed",
          String(voiceLanguageMode === "dialect" && dialectConfirmationComplete),
        );
      } else {
        form.set("audio", speechFile!);
      }
      form.set("person_asset_id", personAsset.asset_id);
      form.set("person_project_id", talkingProjectId);
      const response = await fetch(`${API}/talking-head/jobs`, {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "口播预检失败。");
      setTalkingJob(payload.job);
      if (payload.job.person_asset) {
        setPersonAsset(payload.job.person_asset);
        setMasterFileName(payload.job.person_asset.original_name);
        setMasterPreviewUrl(
          `${API}/talking-head/jobs/${payload.job.id}/master-image`,
        );
      }
      go("preflight");
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "口播预检失败。",
      );
    } finally {
      actionLock.current = false;
      setActionPending(false);
    }
  };
  const startRealVoice = async () => {
    if (!talkingJob) return;
    setTalkingError("");
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    try {
      const response = await fetch(
        `${API}/talking-head/jobs/${talkingJob.id}/start-voice`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "声音提交失败。");
      setTalkingJob(payload.job);
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "声音提交失败。",
      );
    } finally {
      actionLock.current = false;
      setActionPending(false);
    }
  };
  const approveRealVoice = async () => {
    if (!talkingJob) return;
    setTalkingError("");
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    try {
      const response = await fetch(
        `${API}/talking-head/jobs/${talkingJob.id}/approve-voice`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "声音确认失败。");
      setTalkingJob(payload.job);
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "声音确认失败。",
      );
    } finally {
      actionLock.current = false;
      setActionPending(false);
    }
  };
  const startRealSample = async () => {
    if (!talkingJob) return;
    setTalkingError("");
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    try {
      const response = await fetch(
        `${API}/talking-head/jobs/${talkingJob.id}/start`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "样片提交失败。");
      setTalkingJob(payload.job);
      go(payload.job.state === "production_running" ? "production" : "sample");
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "样片提交失败。",
      );
    } finally {
      actionLock.current = false;
      setActionPending(false);
    }
  };
  const stopRealGeneration = async () => {
    if (!talkingJob) return;
    const confirmed = window.confirm(
      "停止当前生成？已完成的片段会保留，正在生成的片段会请求平台停止，未开始的片段不会再提交；已产生的费用无法撤回。",
    );
    if (!confirmed) return;
    setTalkingError("");
    try {
      const response = await fetch(
        `${API}/talking-head/jobs/${talkingJob.id}/cancel`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "停止生成失败。");
      setTalkingJob(payload.job);
      go("production");
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "停止生成失败。",
      );
    }
  };
  const approveRealVideo = async () => {
    if (!talkingJob) return;
    setTalkingError("");
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    try {
      const response = await fetch(
        `${API}/talking-head/jobs/${talkingJob.id}/approve-video`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nativeDialogueConfirmed,
            version: activeReviewVersion,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "视频采用失败。");
      setTalkingJob(payload.job);
      go(
        payload.job.state === "production_running"
          ? "production"
          : payload.job.state === "completed"
            ? "sample"
            : "result",
      );
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "视频采用失败。",
      );
    } finally {
      actionLock.current = false;
      setActionPending(false);
    }
  };
  const regenerateNativeVersion = async () => {
    if (!talkingJob || talkingJob.mode !== "native") return;
    setTalkingError("");
    setNativeDialogueConfirmedFor("");
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    try {
      const response = await fetch(
        `${API}/talking-head/jobs/${talkingJob.id}/regenerate-native`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: regenerateReason }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "新版本提交失败。");
      setTalkingJob(payload.job);
      setReviewVersion(null);
      setRegenerateConfirmOpen(false);
      go("production");
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "新版本提交失败。",
      );
    } finally {
      actionLock.current = false;
      setActionPending(false);
    }
  };
  const openTalkingHeadCodexTask = async () => {
    if (!talkingJob) return;
    setTalkingError("");
    try {
      const response = await fetch(
        `${API}/talking-head/jobs/${talkingJob.id}/codex-task`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        },
      );
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "暂时无法打开项目任务。");
      setTalkingJob(payload.job);
    } catch (error) {
      setTalkingError(
        error instanceof Error ? error.message : "暂时无法打开项目任务。",
      );
    }
  };

  useEffect(() => {
    if (talkingJob)
      window.localStorage.setItem(
        "workbench-talking-head-job",
        JSON.stringify(talkingJob),
      );
    if (talkingJob?.person_asset) {
      window.localStorage.setItem(
        "workbench-talking-head-person-asset",
        JSON.stringify(talkingJob.person_asset),
      );
      window.localStorage.setItem(
        "workbench-talking-head-project-id",
        talkingJob.person_asset.project_id,
      );
    }
  }, [talkingJob]);

  useEffect(() => {
    fetch(`${API}/talking-head/jobs`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const jobs = (payload?.jobs || []) as TalkingJob[];
        setTalkingJobs(jobs);
        const refreshed = talkingJob?.id
          ? jobs.find((job) => job.id === talkingJob.id)
          : null;
        if (refreshed) {
          setTalkingJob(refreshed);
          setStage((current) => restoredTalkingStage(refreshed, current));
        }
      })
      .catch(() => undefined);
  }, [talkingJob?.id]);

  useEffect(() => {
    if (!talkingJob?.id) return;
    let active = true;
    fetch(`${API}/talking-head/jobs/${talkingJob.id}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (active && payload?.job) {
          setTalkingJob(payload.job);
          setStage((current) => restoredTalkingStage(payload.job, current));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [talkingJob?.id]);

  const pollingTalkingJobId = talkingJob?.id;
  const pollingTalkingJobState = talkingJob?.state;
  const pollingCodexThreadStatus = talkingJob?.codex_thread_status;

  useEffect(() => {
    if (
      !pollingTalkingJobId ||
      (![
        "running",
        "sample_running",
        "production_running",
        "editing_running",
        "voice_running",
        "cancel_requested",
      ].includes(pollingTalkingJobState || "") &&
        pollingCodexThreadStatus !== "connecting")
    )
      return;
    let active = true;
    const jobId = pollingTalkingJobId;
    const timer = window.setInterval(async () => {
      const response = await fetch(`${API}/talking-head/jobs/${jobId}`);
      if (!response.ok) return;
      const payload = await response.json();
      if (!active || payload.job?.id !== jobId) return;
      setTalkingJob(payload.job);
      if (payload.job?.state === "editing_running") setStage("editing");
      else if (payload.job?.state === "segment_review") setStage("sample");
      else if (payload.job?.state === "completed" && payload.job.final_output)
        setStage("sample");
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pollingTalkingJobId, pollingTalkingJobState, pollingCodexThreadStatus]);

  return (
    <section className={`talking-studio stage-${stage}`} aria-label="AI 口播使用流程">
      {draftSaveError && <p role="alert">当前浏览器无法保存草稿，请先复制口播稿再离开。</p>}
      <div className="prototype-banner">
        <span>AI 口播</span>
        <strong>按页面提示准备内容、声音和人物</strong>
        <p>资料齐全后先确认制作方案，再开始生成。</p>
      </div>
      <header className="talking-hero">
        <div>
          <small>AI 口播</small>
          <h1>从内容到成片，一次走完</h1>
          <p>先把人物和内容设置好；长音频会自动分段生成、检查接缝并合成为完整成片。</p>
        </div>
        <div className="talking-outcome">
          <span>最终会拿到</span>
          <strong>可播放的口播成片</strong>
          <small>保留原始完整音频，片段生成后自动进入接缝检查与合成</small>
        </div>
      </header>
      {talkingJob && (
        <div className="talking-new-project">
          <span>当前项目会继续保存在任务中心，不会被删除。</span>
          <button type="button" onClick={startNewTalkingProject}>新建另一条口播 →</button>
        </div>
      )}
      <div className="talking-progress" aria-label="口播制作进度">
        {visibleTalkingStages.map((item, index) => (
          <button
            type="button"
            key={item.id}
            className={
              index === visibleCurrentIndex
                ? "current"
                : index < visibleCurrentIndex
                  ? "complete"
                  : "pending"
            }
            disabled={index > visibleCurrentIndex}
            onClick={() => { if (index > visibleCurrentIndex) return; if (item.id === "setup" && talkingJob) restoreTalkingSetupFromJob(talkingJob); go(item.id); }}
            aria-current={index === visibleCurrentIndex ? "step" : undefined}
          >
            <span>{index < visibleCurrentIndex ? "✓" : index + 1}</span>
            <b>{item.short}</b>
          </button>
          ))}
      </div>

      {stage === "mode" && (
        <div className="talking-panel mode-panel">
          <div className="talking-section-title">
            <span>第 1 步</span>
            <h2>这次想做哪一种视频？</h2>
            <p>不知道怎么选时，标准口播适合大多数日常内容。</p>
          </div>
          <section className="mode-group" aria-label="AI 口播">
            <div className="mode-group-heading">
              <div>
                <small>口播制作</small>
                <h3>AI 口播</h3>
              </div>
              <span>说话内容驱动人物口型与表演</span>
            </div>
            <div className="talking-mode-grid">
              {(["standard", "boutique", "native"] as TalkingMode[]).map((key) => {
                const info = talkingModeInfo[key];
                return (
                  <button
                    type="button"
                    key={key}
                    className={`talking-mode-card ${info.accent} ${mode === key ? "selected" : ""}`}
                    onClick={() => {
                      if (key === mode) return;
                      setMode(key);
                      setGenerationStrategy(key === "native" ? "direct_full" : "sample_first");
                      setDirectGenerationAcknowledged(key === "native");
                      setQualityMode(["boutique", "native"].includes(key) ? "clear" : "daily");
                      if (key === "standard") setConcurrency(1);
                      if (key === "native") {
                        setSpeechSource("clone");
                        setNativeVoiceMode("random");
                        setNativeRunStrategy("economy");
                        setTargetRatio("9:16");
                        setConcurrency(1);
                        setGenerationStrategy("direct_full");
                        setDirectGenerationAcknowledged(true);

                      }
                    }}
                  >
                    <span className="mode-check">
                      {mode === key ? "✓" : ""}
                    </span>
                    <small>{info.eyebrow}</small>
                    <h3>{info.name}</h3>
                    <p>{info.description}</p>
                    <b>{info.fit}</b>
                  </button>
                );
              })}
            </div>
          </section>
          <div className="talking-primary-row">
            <div>
              <small>当前选择</small>
              <strong>{currentMode.name}</strong>
              <span>{currentMode.description}</span>
            </div>
            <button type="button" onClick={() => go("setup")}>
              继续设置内容与人物 →
            </button>
          </div>
          {talkingJobs.length > 0 && (
            <section className="recent-talking-projects">
              <div>
                <small>继续上次项目</small>
                <h3>最近口播项目</h3>
                <p>项目资料、制作进度和已有成果会一起恢复。</p>
              </div>
              <div>
                {talkingJobs.slice(0, 4).map((job) => (
                  <button
                    type="button"
                    key={job.id}
                    onClick={() => {
                      restoreTalkingSetupFromJob(job);
                      go(
                        [
                          "voice_preflight",
                          "voice_running",
                          "voice_review",
                          "voice_failed",
                          "preflight",
                        ].includes(job.state)
                          ? "preflight"
                          : job.state === "approved"
                            ? "result"
                            : ["production_running", "editing_running"].includes(job.state) ||
                                (job.state === "failed" && job.sample?.qc_status === "approved_sample")
                              ? job.state === "editing_running" ? "editing" : "production"
                            : "sample",
                      );
                    }}
                  >
                    <span>
                      {job.mode === "boutique"
                        ? "精"
                        : job.mode === "standard"
                          ? "标"
                          : job.mode === "native"
                            ? "原"
                            : "唱"}
                    </span>
                    <p>
                      <strong>
                        {job.mode === "boutique"
                          ? "精品口播"
                          : job.mode === "standard"
                            ? "标准口播"
                            : job.mode === "native"
                              ? "原生口播"
                              : "唱歌模式"}
                        项目
                      </strong>
                      <small>
                        {["completed", "approved"].includes(job.state)
                          ? job.state === "approved"
                            ? "成片已采用"
                            : isCompleteTalkingVideo(job)
                              ? "成片已返回"
                              : "样片已返回"
                          : job.state === "voice_review"
                            ? "声音待确认"
                            : job.state === "voice_running"
                              ? "声音生成中"
                              : job.state === "voice_failed"
                                ? "声音需要处理"
                                : ["running", "sample_running", "production_running", "editing_running"].includes(job.state)
                                  ? "正在生成"
                                  : job.state === "failed"
                                    ? "需要处理"
                                    : "方案待确认"}
                      </small>
                    </p>
                    <b>继续 →</b>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {stage === "setup" && (
        <div className="talking-panel setup-panel">
          <div className="talking-section-title">
            <span>一次设置</span>
            <h2>把必要资料一次准备好</h2>
            <p>
              能自动检查和处理的项目不再反复询问；只有缺少必要素材时才会暂停。
            </p>
          </div>
          <div className="setup-summary">
            <span className={`mode-dot ${currentMode.accent}`}></span>
            <div>
              <small>当前模式</small>
              <strong>{currentMode.name}</strong>
            </div>
            <button type="button" onClick={() => go("mode")}>
              重新选择
            </button>
          </div>
          <div className={`mode-rule-note ${mode === "native" ? "gold" : "blue"}`}>
            <strong>{mode === "native" ? "逐字台词生成声音和画面" : mode === "boutique" ? "完整音频驱动精品口播" : "完整音频驱动标准口播"}</strong>
            <span>
              {mode === "native"
                ? "台词是唯一说话内容；可选声音只参考音色，工作台不会把它误送到音频驱动路线。"
                : mode === "boutique"
                  ? "人物母版＋完整确认音频直接驱动口型与表演；提示词只约束自然表演，不会重新生成或改写台词。"
                  : "人物母版＋完整确认音频直接驱动口型；提示词不承担台词内容。"}
            </span>
          </div>
          <div className="talking-form-grid">
            <section className="talking-form-card">
              <div className="form-card-head">
                <span>1</span>
                <div>
                  <h3>{mode === "singing" ? "歌曲音频" : mode === "native" ? "逐字台词与音色" : "声音与内容"}</h3>
                  <p>
                    {mode === "singing"
                      ? "上传有权使用的完整歌曲或已裁好的片段"
                      : mode === "native"
                        ? "填写唯一台词，再选择自然音色或指定已授权音色"
                      : "先选声音怎么来，稿件内容不会被工作台改写"}
                  </p>
                </div>
              </div>
              {mode !== "singing" ? (
                <>
                  {mode === "native" && nativeDialogueAbVisible && (
                    <div className="segmented-control" aria-label="原生口播人物方式">
                      <button
                        type="button"
                        className={nativeDialogueMode === "single" ? "selected" : ""}
                        onClick={() => {
                          setNativeDialogueMode("single");
                          setNativeNeutralHandPoseConfirmed(false);
                        }}
                      >
                        <b>单人口播</b>
                        <small>一位人物连续说完整台词</small>
                      </button>
                      <button
                        type="button"
                        className={nativeDialogueMode === "two_speaker_alternating" ? "selected" : ""}
                        onClick={() => {
                          setNativeDialogueMode("two_speaker_alternating");
                          setNativeVoiceMode("reference");
                        }}
                      >
                        <b>双人访谈 / 对谈</b>
                        <small>左右人物轮流说话，每轮只让一人开口</small>
                      </button>
                    </div>
                  )}
                  {mode === "native" && nativeDialogueMode === "two_speaker_alternating" ? (
                    <>
                      <div className="segmented-control" aria-label="双人对话感觉">
                        <button
                          type="button"
                          className={nativeDialogueStyle === "natural_interview" ? "selected" : ""}
                          onClick={() => setNativeDialogueStyle("natural_interview")}
                        >
                          <b>自然访谈</b>
                          <small>先接住上一句，再自然表达</small>
                        </button>
                        <button
                          type="button"
                          className={nativeDialogueStyle === "structured_discussion" ? "selected" : ""}
                          onClick={() => setNativeDialogueStyle("structured_discussion")}
                        >
                          <b>观点对谈</b>
                          <small>每轮完整讲一个观点</small>
                        </button>
                      </div>
                      <div className="mode-rule-note gold">
                        <strong>{nativeDialogueStyle === "natural_interview" ? "像真人聊天，不是轮流念稿" : "适合轮流表达完整观点"}</strong>
                        <span>{nativeDialogueStyle === "natural_interview"
                          ? "至少包含一次真实提问；后续每轮先回应上一句话，再说一个意思，并使用有长有短的口语句。提交前会免费检查。"
                          : "每轮可以完整表达一个观点，但仍需严格左右交替。它更像观点节目，不等同于自然访谈。"}</span>
                      </div>
                      <div className="mode-rule-note gold">
                        <strong>先确认自然休息位，再让动作完整发生</strong>
                        <span>母版里两个人的手都要有明确落点。发言时可按语义完成一次自然单手动作，随后落到任意舒适支撑位；不要求逐帧回到起始姿势，也不会让手臂一直悬空。</span>
                      </div>
                      <label className="talking-check">
                        <input
                          type="checkbox"
                          checked={nativeNeutralHandPoseConfirmed}
                          onChange={(event) =>
                            setNativeNeutralHandPoseConfirmed(event.target.checked)
                          }
                        />
                        <span>我已确认：左右人物的手都有明确休息位，动作结束后可以落到舒适位置。</span>
                      </label>
                      <div className="mode-rule-note gold">
                        <strong>左右人物分别使用自己的授权音色</strong>
                        <span>每行以“左：”或“右：”开头；工作台会保持完整语义，在6～15秒内规划每轮时长，并按发言人绑定对应声音。底层每段仍是独立生成，成片需要完整听审衔接。</span>
                      </div>
                    </>
                  ) : mode === "native" ? <div className="segmented-control" aria-label="原生口播音色方式">
                    <button
                      type="button"
                      className={nativeVoiceMode === "random" ? "selected" : ""}
                      onClick={() => setNativeVoiceMode("random")}
                    >
                      <b>自然音色</b>
                      <small>不上传声音，由模型自然生成</small>
                    </button>
                    <button
                      type="button"
                      className={nativeVoiceMode === "reference" ? "selected" : ""}
                      onClick={() => setNativeVoiceMode("reference")}
                    >
                      <b>指定音色</b>
                      <small>参考已授权声音的音色与表达倾向</small>
                    </button>
                  </div> : <div className="segmented-control" aria-label="声音来源">
                    <button
                      type="button"
                      className={speechSource === "clone" ? "selected" : ""}
                      onClick={() => setSpeechSource("clone")}
                    >
                      <b>克隆声音</b>
                      <small>确认稿＋授权声音</small>
                    </button>
                    <button
                      type="button"
                      className={speechSource === "audio" ? "selected" : ""}
                      onClick={() => setSpeechSource("audio")}
                    >
                      <b>上传录好音频</b>
                      <small>直接使用成品声音</small>
                    </button>
                  </div>}
                  {speechSource === "clone" ? (
                    <>
                      <label className="talking-field">
                        <span>{mode === "native"
                          ? nativeDialogueMode === "two_speaker_alternating"
                            ? "完整对话稿（每行一轮，按左右人物交替生成）"
                            : "完整口播稿（工作台自动拆段，不改字）"
                          : voiceLanguageMode === "dialect" && dialectScriptMode === "convert_from_mandarin"
                            ? "要转换的普通话原稿"
                            : "已经确认、不再改写的口播稿"}</span>
                        <textarea
                          value={script}
                          onChange={(event) => {
                            setScript(event.target.value);
                            clearDialectDraft();
                          }}
                          aria-label="已经确认的口播稿"
                        />
                        <small>
                          {mode === "native" ? countChineseCharacters(script) : script.length} {mode === "native" ? "个汉字" : "字"} · {mode === "native"
                            ? nativeDialogueMode === "two_speaker_alternating"
                              ? nativeDialogueStyle === "natural_interview"
                                ? "每轮保持完整语义；左右交替、至少一轮提问，后续先接话再表达"
                                : "每轮保持完整语义；左右严格交替，每轮完整表达一个观点"
                              : "长稿会按完整语义规划为6～15秒片段，提交前免费检查"
                            : "只用于生成声音，不加入动作提示或改写台词"}
                        </small>
                      </label>
                      {mode !== "native" && (
                        <section className="voice-route-settings" aria-label="口播语言与声音方式">
                          <div className="segmented-control" aria-label="口播语言">
                            <button
                              type="button"
                              className={voiceLanguageMode === "mandarin" ? "selected" : ""}
                              onClick={() => {
                                setVoiceLanguageMode("mandarin");
                                setDialectScriptConfirmed(false);
                                setDialectDraftConfirmed(false);
                              }}
                            >
                              <b>普通话</b>
                              <small>继续使用当前稳定克隆</small>
                            </button>
                            <button
                              type="button"
                              className={voiceLanguageMode === "dialect" ? "selected" : ""}
                              onClick={() => setVoiceLanguageMode("dialect")}
                            >
                              <b>方言</b>
                              <small>上海话、陕西关中话等</small>
                            </button>
                          </div>
                          {voiceLanguageMode === "dialect" && (
                            <>
                              <label className="talking-field">
                                <span>选择方言</span>
                                <select
                                  aria-label="选择方言"
                                  value={voiceDialect}
                                  onChange={(event) => {
                                    setVoiceDialect(event.target.value);
                                    setVoiceDialectDetail("");
                                    setDialectScriptConfirmed(false);
                                    clearDialectDraft();
                                  }}
                                >
                                  {supportedVoiceDialectOptions.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                  ))}
                                </select>
                                <small>先选最接近的一种；有明确地区或口音时，可以在下面补充。</small>
                              </label>
                              <label className="talking-field">
                                <span>具体地区或口音（可选）</span>
                                <input
                                  type="text"
                                  value={voiceDialectDetail}
                                  maxLength={24}
                                  onChange={(event) => {
                                    setVoiceDialectDetail(event.target.value);
                                    setDialectScriptConfirmed(false);
                                    clearDialectDraft();
                                  }}
                                  aria-label="具体地区或口音"
                                  placeholder="例如：上海老城厢、成都城区、广州口音"
                                />
                                <small>有明确地区时再填，可以让草稿和后续试听更有针对性。</small>
                              </label>
                              <div className="segmented-control" aria-label="方言文案准备方式">
                                <button
                                  type="button"
                                  className={dialectScriptMode === "already_dialect" ? "selected" : ""}
                                  onClick={() => {
                                    setDialectScriptMode("already_dialect");
                                    setDialectDraftConfirmed(false);
                                  }}
                                >
                                  <b>我已经写好方言稿</b>
                                  <small>直接检查后确认</small>
                                </button>
                                <button
                                  type="button"
                                  className={dialectScriptMode === "convert_from_mandarin" ? "selected" : ""}
                                  onClick={() => {
                                    setDialectScriptMode("convert_from_mandarin");
                                    setDialectScriptConfirmed(false);
                                  }}
                                >
                                  <b>把普通话转成方言草稿</b>
                                  <small>自动转译，你再修改</small>
                                </button>
                              </div>
                              {dialectScriptMode === "already_dialect" ? (
                                <label className="talking-check">
                                  <input
                                    type="checkbox"
                                    checked={dialectScriptConfirmed}
                                    onChange={(event) => setDialectScriptConfirmed(event.target.checked)}
                                  />
                                  <span>我已检查并确认上面的方言口播稿</span>
                                </label>
                              ) : (
                                <section className="dialect-draft-card" aria-label="方言转译草稿">
                                  <div className="mode-rule-note gold">
                                    <strong>先生成草稿，再由你确认</strong>
                                    <span>系统会尽量改成当地口语，但方言有地区和个人差异，生成后请直接修改不地道的地方。</span>
                                  </div>
                                  <label className="talking-field">
                                    <span>方言参考表达（可选）</span>
                                    <textarea
                                      value={dialectReferenceExamples}
                                      onChange={(event) => {
                                        setDialectReferenceExamples(event.target.value);
                                        clearDialectDraft();
                                      }}
                                      aria-label="方言参考表达"
                                      placeholder="可粘贴你确认过的本地说法或错误修正示例"
                                    />
                                    <small>参考越接近目标地区和人群，结果通常越稳。</small>
                                  </label>
                                  <div className="dialect-draft-actions">
                                    <button
                                      type="button"
                                      onClick={createDialectDraft}
                                      disabled={dialectDraftLoading || !script.trim() || !effectiveVoiceDialect}
                                    >
                                      {dialectDraftLoading ? "正在生成草稿…" : `生成${effectiveVoiceDialect || "方言"}草稿`}
                                    </button>
                                    <small>点击后只生成一版可修改草稿；确认前不会进入声音生成。</small>
                                  </div>
                                  {dialectDraftError && (
                                    <div className="mode-rule-note pink">
                                      <strong>草稿未生成</strong>
                                      <span>{dialectDraftError}</span>
                                    </div>
                                  )}
                                  {dialectDraft && (
                                    <>
                                      <label className="talking-field">
                                        <span>可修改的方言口播草稿</span>
                                        <textarea
                                          value={dialectDraft}
                                          onChange={(event) => {
                                            setDialectDraft(event.target.value);
                                            setDialectDraftConfirmed(false);
                                          }}
                                          aria-label="可修改的方言口播草稿"
                                        />
                                        <small>这一版可以直接改；后续会按你最终确认的文字原样生成声音。</small>
                                      </label>
                                      {(dialectDraftUncertain.length > 0 || dialectDraftNotes) && (
                                        <div className="dialect-draft-review">
                                          <strong>建议重点核对</strong>
                                          {dialectDraftUncertain.map((item) => <span key={item}>{item}</span>)}
                                          {dialectDraftNotes && <small>{dialectDraftNotes}</small>}
                                        </div>
                                      )}
                                      <label className="talking-check">
                                        <input
                                          type="checkbox"
                                          checked={dialectDraftConfirmed}
                                          onChange={(event) => setDialectDraftConfirmed(event.target.checked)}
                                        />
                                        <span>我已检查并确认这版方言口播稿</span>
                                      </label>
                                    </>
                                  )}
                                </section>
                              )}
                              <div className="segmented-control" aria-label="方言声音生成方式">
                                <button
                                  type="button"
                                  className={voiceCloneRoute === "fidelity" ? "selected" : ""}
                                  onClick={() => setVoiceCloneRoute("fidelity")}
                                >
                                  <b>音色还原优先</b>
                                  <small>更像参考声音，需要参考逐字稿</small>
                                </button>
                                <button
                                  type="button"
                                  className={voiceCloneRoute === "expressive" ? "selected" : ""}
                                  onClick={() => {
                                    setVoiceCloneRoute("expressive");
                                    setReferenceAudioTranscript("");
                                  }}
                                >
                                  <b>情绪表达优先</b>
                                  <small>可调情绪和语速；方言稳定性较弱，可能夹普通话</small>
                                </button>
                              </div>
                              {voiceCloneRoute === "fidelity" ? (
                                <label className="talking-field">
                                  <span>参考声音的完整逐字稿</span>
                                  <textarea
                                    value={referenceAudioTranscript}
                                    onChange={(event) => setReferenceAudioTranscript(event.target.value)}
                                    aria-label="参考声音的完整逐字稿"
                                    placeholder="只填写参考音频里实际说出的内容，一字不差"
                                  />
                                  <small>用于最大程度保留参考声音的音色、节奏和表达细节；本模式不再叠加情绪控制。</small>
                                </label>
                              ) : (
                                <>
                                  <div className="mode-rule-note pink">
                                    <strong>方言实验路线</strong>
                                    <span>情绪控制会减弱方言约束，可能夹普通话。请先短样试听；正式口播优先选“音色还原优先”。</span>
                                  </div>
                                  <div className="voice-expression-grid">
                                    <label className="talking-field">
                                      <span>说话情绪</span>
                                      <select
                                        aria-label="说话情绪"
                                        value={voiceEmotionPreset}
                                        onChange={(event) => setVoiceEmotionPreset(event.target.value as typeof voiceEmotionPreset)}
                                      >
                                        <option value="natural">自然讲述</option>
                                        <option value="happy">开心分享</option>
                                        <option value="urgent">着急解释</option>
                                        <option value="calm">沉稳认真</option>
                                        <option value="wronged">委屈说明</option>
                                        <option value="angry">生气质问</option>
                                      </select>
                                    </label>
                                    <label className="talking-field">
                                      <span>说话速度</span>
                                      <select
                                        aria-label="说话速度"
                                        value={voiceSpeechPace}
                                        onChange={(event) => setVoiceSpeechPace(event.target.value as typeof voiceSpeechPace)}
                                      >
                                        <option value="slow">慢一点</option>
                                        <option value="normal">正常</option>
                                        <option value="fast">快一点</option>
                                      </select>
                                    </label>
                                  </div>
                                </>
                              )}
                            </>
                          )}
                        </section>
                      )}
                      {mode === "native" && (
                        <label className="talking-field">
                          <span>整体表达要求</span>
                          <textarea
                            value={performanceRequirement}
                            onChange={(event) => setPerformanceRequirement(event.target.value)}
                            aria-label="原生口播整体表达要求"
                          />
                          <small>用于统一各段的语气、节奏、微表情和自然肢体语言；不会写进口播台词。</small>
                        </label>
                      )}
                      {mode === "native" && nativeCompositionAbVisible && (
                        <div className="segmented-control" aria-label="原生口播内部对照版本">
                          <button
                            type="button"
                            className={nativeWorkflowVariant === "production" ? "selected" : ""}
                            onClick={() => setNativeWorkflowVariant("production")}
                          >
                            <b>现行版</b>
                            <small>保持当前正式生成方式</small>
                          </button>
                          <button
                            type="button"
                            className={nativeWorkflowVariant === "composition_anchor_v0_1" ? "selected" : ""}
                            onClick={() => setNativeWorkflowVariant("composition_anchor_v0_1")}
                          >
                            <b>首帧锚点实验版</b>
                            <small>只增加首帧构图锚点，其他条件不变</small>
                          </button>
                          <button
                            type="button"
                            className={nativeWorkflowVariant === "composition_first_last_v0_2" ? "selected" : ""}
                            onClick={() => setNativeWorkflowVariant("composition_first_last_v0_2")}
                          >
                            <b>首尾锚点实验版</b>
                            <small>首帧和尾帧都使用人物母版构图</small>
                          </button>
                        </div>
                      )}
                      {mode === "native" && nativeDialogueMode === "two_speaker_alternating" && (
                        <div className="voice-expression-grid" aria-label="双人音色参考">
                          <label className="compact-upload">
                            <input
                              aria-label="左侧人物授权声音参考"
                              type="file"
                              accept="audio/*"
                              onChange={(event) => {
                                const file = event.target.files?.[0] ?? null;
                                setLeftVoiceFile(file);
                                setLeftVoiceFileName(file?.name ?? "");
                              }}
                            />
                            <span>左</span>
                            <p>
                              <strong>{leftVoiceFileName || "上传左侧人物声音参考"}</strong>
                              <small>只绑定左侧人物发言片段，不复述样本原话</small>
                            </p>
                            <b>{leftVoiceFileName ? "已选择" : "选择文件"}</b>
                          </label>
                          <label className="compact-upload">
                            <input
                              aria-label="右侧人物授权声音参考"
                              type="file"
                              accept="audio/*"
                              onChange={(event) => {
                                const file = event.target.files?.[0] ?? null;
                                setRightVoiceFile(file);
                                setRightVoiceFileName(file?.name ?? "");
                              }}
                            />
                            <span>右</span>
                            <p>
                              <strong>{rightVoiceFileName || "上传右侧人物声音参考"}</strong>
                              <small>只绑定右侧人物发言片段，不复述样本原话</small>
                            </p>
                            <b>{rightVoiceFileName ? "已选择" : "选择文件"}</b>
                          </label>
                        </div>
                      )}
                      {(mode !== "native" || (nativeVoiceMode === "reference" && nativeDialogueMode === "single")) && <label className="compact-upload">
                        <input
                          aria-label="授权声音参考"
                          type="file"
                          accept="audio/*"
                          onChange={(event) => {
                            const file = event.target.files?.[0] ?? null;
                            setVoiceFile(file);
                            setVoiceFileName(file?.name ?? "");
                            setReusedVoiceJobId("");
                          }}
                        />
                        <span>♪</span>
                        <p>
                          <strong>{voiceFileName || "上传授权声音参考"}</strong>
                          <small>
                            {mode === "native"
                              ? "同时参考音色、声音质感、表达倾向和自然节奏，不复述原内容"
                              : voiceLanguageMode === "dialect" && voiceCloneRoute === "fidelity"
                                ? "用于还原音色与方言表达；本路线还需要填写参考声音逐字稿"
                                : voiceLanguageMode === "dialect" && voiceCloneRoute === "expressive"
                                  ? "用于参考声音身份；情绪由上方设置控制，方言可能夹普通话"
                                  : "用于参考音色与自然表达"}
                          </small>
                        </p>
                        <b>{voiceFileName ? "已选择" : "选择文件"}</b>
                      </label>}
                      {mode !== "native" && reusableVoiceJobs.length > 0 && (
                        <label className="talking-field">
                          <span>使用以前保存的声音</span>
                          <select
                            aria-label="选择以前使用过的授权声音"
                            value={reusedVoiceJobId}
                            onChange={(event) => {
                              const selectedId = event.target.value;
                              const selectedJob = reusableVoiceJobs.find((job) => job.id === selectedId);
                              setReusedVoiceJobId(selectedId);
                              if (selectedId) {
                                setVoiceFile(null);
                                setVoiceFileName(
                                  selectedJob?.project_name ||
                                    `${talkingModeName(selectedJob?.mode || "standard")}历史声音`,
                                );
                                setVoiceAuthorized(true);
                              } else {
                                setVoiceFileName("");
                              }
                            }}
                          >
                            <option value="">本次上传新的声音参考</option>
                            {reusableVoiceJobs.map((job, index) => (
                              <option key={job.id} value={job.id}>
                                {index === 0 ? "最近使用 · " : ""}{job.project_name || talkingModeName(job.mode)} · {talkingModeName(job.mode)} · {formatTime(job.created_at || job.updated_at || "")}
                              </option>
                            ))}
                          </select>
                          <small>选择后不必重新上传参考文件；新口播稿仍会生成一条新的声音，旧任务和旧成果不会改变。</small>
                          {selectedReusableVoiceJob?.voice_output && (
                            // The spoken content is the user-provided script displayed in this form.
                            // eslint-disable-next-line jsx-a11y/media-has-caption
                            <audio
                              aria-label="试听以前保存的声音"
                              controls
                              preload="metadata"
                              src={`${API}/talking-head/jobs/${selectedReusableVoiceJob.id}/audio`}
                            />
                          )}
                        </label>
                      )}
                      {mode === "native" && nativeVoiceMode === "reference" && nativeDialogueMode === "single" && recentReferenceVoiceJob && (
                        <button
                          type="button"
                          className="talking-reuse-voice"
                          onClick={() => {
                            setVoiceFile(null);
                            setReusedVoiceJobId(recentReferenceVoiceJob.id);
                            setVoiceFileName("最近已授权音色参考");
                          }}
                        >
                          复用最近已授权音色
                        </button>
                      )}
                      {(mode !== "native" || nativeVoiceMode === "reference" || nativeDialogueMode === "two_speaker_alternating") && <label className="talking-check">
                        <input
                          type="checkbox"
                          checked={voiceAuthorized}
                          onChange={(event) =>
                            setVoiceAuthorized(event.target.checked)
                          }
                        />
                        <span>我确认有权使用这段声音{mode === "native" ? "作为音色参考" : "进行克隆"}</span>
                      </label>}
                      {mode === "native" && nativeVoiceMode === "random" && nativeDialogueMode === "single" && (
                        <div className="mode-rule-note gold">
                          <strong>本次使用自然音色</strong>
                          <span>不会上传声音参考；模型会根据台词自然生成声音、节奏、微表情和肢体表达。</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <label className="mock-upload">
                      <input
                        aria-label="已录好的口播音频"
                        type="file"
                        accept="audio/*"
                        onChange={async (event) => {
                          const file = event.target.files?.[0] ?? null;
                          setSpeechFile(file);
                          setSpeechFileName(file?.name ?? "");
                          setSpeechDuration(
                            file ? await inspectLocalAudioDuration(file) : null,
                          );
                        }}
                      />
                      <span>♪</span>
                      <strong>{speechFileName || "选择录好的口播音频"}</strong>
                      <small>
                        {speechDuration
                          ? `本机读到 ${speechDuration} 秒 · ${speechDuration > 10 && mode === "boutique" ? `预计分成 ${balancedBoutiqueDurations(speechDuration).length} 段` : "可按当前模式继续"}`
                          : "上传后自动检查时长和完整性；超出单段时长会自动分段，样片通过后生成并合成完整成片"}
                      </small>
                    </label>
                  )}
                </>
              ) : (
                <>
                  <label className="mock-upload">
                    <input type="file" accept="audio/*" />
                    <span>♫</span>
                    <strong>选择歌曲音频</strong>
                    <small>接通功能后会按乐句分段，不改歌词和旋律</small>
                  </label>
                  <label className="talking-check">
                    <input
                      type="checkbox"
                      checked={songAuthorized}
                      onChange={(event) =>
                        setSongAuthorized(event.target.checked)
                      }
                    />
                    <span>我确认有权使用这段歌曲音频</span>
                  </label>
                </>
              )}
            </section>
            <section className="talking-form-card">
              <div className="form-card-head">
                <span>2</span>
                <div>
                  <h3>人物母版图</h3>
                  <p>这张图会真正驱动人物说话，需要单独检查</p>
                </div>
              </div>
              <div className="talking-person-routes" aria-label="人物路线">
                <button
                  type="button"
                  className="talking-person-route selected"
                >
                  <span>可用</span>
                  <strong>上传已有母版</strong>
                  <small>选择后立即保存并绑定当前口播项目</small>
                </button>
                <button
                  type="button"
                  className="talking-person-route"
                  onClick={() => onOpenModels?.("ai_model")}
                >
                  <span>可用</span>
                  <strong>AI 创建主播</strong>
                  <small>进入人物资产创建，采用后自动带回当前口播项目</small>
                </button>
                <button
                  type="button"
                  className="talking-person-route"
                  onClick={() => onOpenModels?.("real_person")}
                >
                  <span>可用</span>
                  <strong>本人／指定真人</strong>
                  <small>按授权真人人物资产流程准备并采用，再自动带回口播</small>
                </button>
              </div>
              <button type="button" className="talking-person-reuse" onClick={() => onOpenModels?.(null)}>从我的模特资产库选择 →</button>
              {!personAsset && !masterPreviewUrl ? (
                <>
                  <label className="mock-upload compact talking-person-upload">
                    <input
                      aria-label="人物母版图"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={async (event) => {
                        const file = event.target.files?.[0] ?? null;
                        event.currentTarget.value = "";
                        await uploadPersonMaster(file);
                      }}
                    />
                    <span>人</span>
                    <strong>{personAssetUploading ? "正在保存人物母版…" : "选择人物母版图"}</strong>
                    <small>选择后立即保存在当前电脑；不会上传到外部平台</small>
                  </label>
                  {recentPersonAsset && (
                    <button
                      type="button"
                      className="talking-person-reuse"
                      onClick={() => {
                        setPersonAsset(recentPersonAsset);
                        setTalkingProjectId(recentPersonAsset.project_id);
                        setMasterFileName(recentPersonAsset.original_name);
                        setMasterPreviewUrl(
                          `${API}/talking-head/person-assets/${recentPersonAsset.asset_id}/file`,
                        );
                        window.localStorage.setItem(
                          "workbench-talking-head-person-asset",
                          JSON.stringify(recentPersonAsset),
                        );
                        window.localStorage.setItem(
                          "workbench-talking-head-project-id",
                          recentPersonAsset.project_id,
                        );
                      }}
                    >
                      复用最近人物母版：{recentPersonAsset.original_name}
                    </button>
                  )}
                </>
              ) : (
                <div className="talking-person-preview-card">
                  <button
                    type="button"
                    className="talking-person-preview-image"
                    onClick={() => setPersonPreviewOpen(true)}
                    aria-label="放大查看人物母版"
                  >
                    {masterPreviewUrl && (
                      <Image
                        src={masterPreviewUrl}
                        width={360}
                        height={480}
                        unoptimized
                        alt="当前项目人物母版预览"
                      />
                    )}
                    <span>点击放大</span>
                  </button>
                  <div>
                    <small>{personAssetUploading ? "正在保存" : "已绑定当前项目"}</small>
                    <strong>{masterFileName || personAsset?.original_name || "人物母版"}</strong>
                    <span>
                      {personAsset
                        ? "已保存到当前项目"
                        : "正在读取这次选择的图片"}
                    </span>
                    <div className="talking-person-preview-actions">
                      <button type="button" onClick={() => setPersonPreviewOpen(true)}>查看大图</button>
                      <label>
                        重新选择
                        <input
                          aria-label="重新选择人物母版图"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={async (event) => {
                            const file = event.target.files?.[0] ?? null;
                            event.currentTarget.value = "";
                            await uploadPersonMaster(file);
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              )}
              <div className="master-hints">
                <strong>母版图尽量这样拍</strong>
                <span>眼神自然，嘴唇和肩颈放松</span>
                <span>需要手势时，手臂完整并有自然休息位</span>
                <span>人物与背景分开，不切手、切腕</span>
                <small>避免证件照式僵直、双手悬空或紧抿嘴。</small>
              </div>
              {personPreviewOpen && masterPreviewUrl && (
                <div className="talking-person-lightbox" role="dialog" aria-modal="true" aria-label="人物母版大图">
                  <button type="button" onClick={() => setPersonPreviewOpen(false)} aria-label="关闭人物母版大图">×</button>
                  <Image src={masterPreviewUrl} width={1200} height={1600} unoptimized alt="人物母版大图" />
                </div>
              )}
            </section>
            <section className="talking-form-card">
              <div className="form-card-head">
                <span>3</span>
                <div>
                  <h3>成片要求</h3>
                  <p>只选你在意的结果，不展示底层参数</p>
                </div>
              </div>
              <section className="talking-option-group" aria-label="发布画幅">
                <div className="talking-option-title">发布画幅</div>
                <div className="talking-option-grid ratio-option-grid">
                  <button
                    type="button"
                    className={targetRatio === "9:16" ? "selected" : ""}
                    onClick={() => {
                      setTargetRatio("9:16");
                      setTalkingError("");
                    }}
                    aria-label={`${talkingModeName(mode)}成片比例 9:16`}
                  >
                    <i className="ratio-shape portrait"></i>
                    <span><b>竖屏</b><small>9:16 · 短视频常用</small></span>
                  </button>
                  <button
                    type="button"
                    className={targetRatio === "3:4" ? "selected" : ""}
                    onClick={() => {
                      setTargetRatio("3:4");
                      setTalkingError("");
                    }}
                    aria-label={`${talkingModeName(mode)}成片比例 3:4`}
                  >
                    <i className="ratio-shape portrait-standard"></i>
                    <span><b>竖版</b><small>3:4 · 人像与课程</small></span>
                  </button>
                  <button
                    type="button"
                    className={targetRatio === "4:3" ? "selected" : ""}
                    onClick={() => {
                      setTargetRatio("4:3");
                      setTalkingError("");
                    }}
                    aria-label={`${talkingModeName(mode)}成片比例 4:3`}
                  >
                    <i className="ratio-shape landscape-standard"></i>
                    <span><b>横版</b><small>4:3 · 课程与传统画面</small></span>
                  </button>
                  <button
                    type="button"
                    className={targetRatio === "16:9" ? "selected" : ""}
                    onClick={() => {
                      setTargetRatio("16:9");
                      setTalkingError("");
                    }}
                    aria-label={`${talkingModeName(mode)}成片比例 16:9`}
                  >
                    <i className="ratio-shape landscape"></i>
                    <span><b>横屏</b><small>16:9 · 课程与大屏</small></span>
                  </button>
                </div>
                <p className="talking-option-hint">人物母版与目标画幅差距明显时，成片可能出现裁切、留白或人物大小变化；工作台不会擅自裁图。</p>
              </section>
              {mode === "boutique" && (
                <section className="talking-option-group" aria-label="拍摄感觉">
                  <div className="talking-option-title">拍摄感觉</div>
                  <div className="talking-option-grid strategy-option-grid">
                    <button
                      type="button"
                      className={boutiqueCameraStyle === "stable_natural" ? "selected" : ""}
                      onClick={() => setBoutiqueCameraStyle("stable_natural")}
                    >
                      <span><b>稳定自然</b><small>机位基本稳定，保留自然表情和动作</small></span>
                    </button>
                    <button
                      type="button"
                      className={boutiqueCameraStyle === "strict_locked" ? "selected" : ""}
                      onClick={() => setBoutiqueCameraStyle("strict_locked")}
                    >
                      <span>
                        <b>固定机位</b>
                        <small>保持镜头角度和人物占比，同时保留自然口型与微表情</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={boutiqueCameraStyle === "handheld_selfie" ? "selected" : ""}
                      onClick={() => setBoutiqueCameraStyle("handheld_selfie")}
                    >
                      <span><b>手持自拍</b><small>轻微自然晃动，像自己拿手机随手录</small></span>
                    </button>
                    <button
                      type="button"
                      className={boutiqueCameraStyle === "walk_and_talk" ? "selected" : ""}
                      onClick={() => setBoutiqueCameraStyle("walk_and_talk")}
                    >
                      <span><b>边走边聊</b><small>慢步跟拍，保留自然摆臂和环境移动</small></span>
                    </button>
                  </div>
                  <p className="talking-option-hint">“稳定自然”允许轻微自然运镜；“固定机位”更重视角度、人物占比和背景位置稳定。这里只改变画面表现，不改变口播音频、人物身份或清晰度。</p>
                </section>
              )}
              {mode !== "native" && <section className="talking-option-group" aria-label="生成方式">
                <div className="talking-option-title">生成方式</div>
                <div className="talking-option-grid strategy-option-grid">
                  <button
                    type="button"
                    className={generationStrategy === "sample_first" ? "selected" : ""}
                    onClick={() => {
                      setGenerationStrategy("sample_first");
                      setDirectGenerationAcknowledged(false);
                    }}
                  >
                    <span><b>先看样片</b><small>{talkingSampleChoice(mode)}</small></span>
                    <em>推荐</em>
                  </button>
                  <button
                    type="button"
                    className={generationStrategy === "direct_full" ? "selected" : ""}
                    onClick={() => setGenerationStrategy("direct_full")}
                  >
                    <span><b>直接生成</b><small>跳过样片，直接制作完整内容</small></span>
                  </button>
                </div>
              </section>}
              {generationStrategy === "direct_full" && mode !== "native" && (
                <label className="talking-field direct-generation-confirmation">
                  <input
                    type="checkbox"
                    checked={directGenerationAcknowledged}
                    onChange={(event) =>
                      setDirectGenerationAcknowledged(event.target.checked)
                    }
                  />
                  <span>我确认跳过样片，直接按完整内容生成。</span>
                  <small>
                    精品口播超过 8 秒时，新母版仍会自动改为先做样片；已有合格样片的同一母版可直接生成。
                  </small>
                </label>
              )}
              <label className="talking-field">
                <span>成片清晰度</span>
                <select
                  value={qualityMode}
                  aria-label="成片清晰度"
                  onChange={(event) => {
                    const value = event.target.value as "daily" | "clear" | "premium";
                    setQualityMode(value);
                    if (mode === "native" && value === "premium") setNativeRunStrategy("stable");
                  }}
                >
                  <option value="daily">普通（人物占比较大）</option>
                  <option value="clear">高清（半身或人物稍远）</option>
                  <option value="premium">超清（人物占比较小）</option>
                </select>
                <small>
                  {mode === "native"
                    ? qualityMode === "daily"
                      ? "普通：适合人物离镜头较近、画面占比较大的口播。"
                      : qualityMode === "clear"
                        ? "高清：当前默认档，兼顾人物细节和生成速度。"
                        : "超清：适合人物较远或更重视面部细节的画面，并自动使用稳定优先。"
                    : qualityMode === "daily"
                    ? mode === "boutique"
                      ? "适合脸离镜头较近、人物占比较大的画面。"
                      : "适合脸离镜头较近、人物占比较大的画面。"
                    : qualityMode === "clear"
                      ? mode === "boutique"
                        ? "适合半身、露手或人物稍远的画面；精品高清档是当前默认稳定档。"
                        : "适合半身、露手或人物稍远的画面，改善眼睛、嘴部和牙齿细节。"
                      : mode === "boutique"
                        ? "适合人物占比更小、仍需保留远景构图的画面。"
                        : "适合人物占比更小、仍需保留远景构图的画面；生成时间和费用更高。"}
                </small>
              </label>
              {mode === "native" ? <label className="talking-field">
                <span>生成策略</span>
                <select
                  value={qualityMode === "premium" ? "stable" : nativeRunStrategy}
                  aria-label="原生口播生成策略"
                  disabled={qualityMode === "premium"}
                  onChange={(event) => setNativeRunStrategy(event.target.value as "economy" | "stable")}
                >
                  <option value="economy">快速优先</option>
                  <option value="stable">稳定优先</option>
                </select>
                <small>{qualityMode === "premium"
                  ? "超清档固定使用稳定优先，只提交 1 次。"
                  : nativeRunStrategy === "economy"
                    ? "先用快速路线；只有明确显存失败且未开始生成时，才切稳定路线补交 1 次。"
                    : "直接使用稳定实例，只提交 1 次，不自动重试。"}</small>
              </label> : <label className="talking-field">
                <span>生成速度</span>
                <select
                  value={concurrency}
                  aria-label="生成速度"
                  disabled={mode === "native"}
                  onChange={(event) =>
                    setConcurrency(Number(event.target.value) as 1 | 3 | 5)
                  }
                >
                  <option value={1}>稳妥生成（一次 1 条）</option>
                  <option value={3}>自动加速（推荐）</option>
                </select>
                <small>
                  {mode === "native" ? "当前固定一次 1 条，不自动重试。" : <>自动加速会按本项目片段数安排，最多同时生成 3 条；例如只有 2
                  个片段时，就同时生成 2 条。{generationStrategy === "sample_first"
                    ? "样片仍只提交 1 条。"
                    : "失败不会自动重试。"}</>}
                </small>
              </label>}
              {mode === "native" && <label className="talking-field">
                <span>多段生成速度</span>
                <select
                  value={concurrency}
                  aria-label="原生口播多段生成速度"
                  onChange={(event) =>
                    setConcurrency(Number(event.target.value) as 1 | 3 | 5)
                  }
                >
                  <option value={1}>依次生成（一次 1 段）</option>
                  <option value={3}>并发生成（最多同时 3 段）</option>
                </select>
                <small>
                  只影响多段任务的等待时间，不改台词、音色、画面或单段提示词；实际并发不会超过本次片段数，失败不自动重试。
                </small>
              </label>}
            </section>
          </div>
          {mode === "boutique" && (
            <div className="boutique-plan" aria-label="精品口播分段规则">
              <div>
                <small>精品口播 · 长音频规划</small>
                <strong>
                  {speechDuration
                    ? `${speechDuration} 秒音频 · ${boutiqueDurations.length} 段初步方案`
                    : "超过 10 秒自动进入长音频路线"}
                </strong>
                <p>
                  {speechDuration
                    ? `长度先平衡为 ${boutiqueDurations.map((duration) => `${duration} 秒`).join("＋")}；正式切点再以完整句、自然停顿和换气为准。`
                    : "有确认稿时按语义切段；只有音频时按自然停顿切段，并在成片前检查接缝。"}
                </p>
              </div>
              <ol>
                <li>
                  <b>完整表达优先</b>
                  <span>优先按自然停顿切分；相邻片段保留约 0.4 秒衔接余量，生成总时长不超过 10 秒</span>
                </li>
                <li>
                  <b>全局避免零碎尾段</b>
                  <span>先看整段语义与停顿，再平衡前后时长，不按固定秒数硬切</span>
                </li>
                <li>
                  <b>接缝单独验收</b>
                  <span>重叠区自动比较背景、头部、眼睛和嘴型；不够可靠时保留原切点</span>
                </li>
              </ol>
              <small>
                新母版仍先做约 6–8 秒样片；其余片段依次生成，最终回铺原始完整音频。
              </small>
            </div>
          )}
          {mode === "singing" && (
            <div className="mode-rule-note pink">
              <strong>唱歌模式当前边界</strong>
              <span>
                先验证短乐句；歌曲来源、使用权限和嘴部结构会在提交前单独确认。
              </span>
            </div>
          )}
          {talkingError && (
            <div className="mode-rule-note pink">
              <strong>暂时没有继续</strong>
              <span>{talkingError}</span>
            </div>
          )}
          <p className="setup-missing-guide">{missingSetupItems.length ? `还差：${missingSetupItems.join("、")}。` : "资料已准备好，可以查看制作方案。"}{missingTalkingFileHints({mode, speechSource, nativeVoiceMode, nativeDialogueMode, voiceName: voiceFileName, speechName: speechFileName, hasVoice: Boolean(voiceFile || reusedVoiceJobId), hasSpeech: Boolean(speechFile)})}</p>
          <div className="talking-primary-row">
            <div>
              <small>下一步</small>
              <strong>检查素材并确认方案</strong>
              <span>先检查资料是否齐全，不会开始生成</span>
            </div>
            <button
              type="button"
              disabled={actionPending || missingSetupItems.length > 0}
              onClick={prepareRealJob}
            >
              查看制作方案 →
            </button>
          </div>
        </div>
      )}

      {stage === "preflight" && (
        <div className="talking-panel preflight-panel">
          <div className="talking-section-title">
            <span>方案确认</span>
            <h2>
              {talkingJob?.state === "voice_running"
                ? "声音正在生成，可以离开页面"
                : talkingJob?.state === "voice_review"
                  ? "声音已经返回，请先听完确认"
                  : talkingJob?.state === "voice_failed"
                    ? "这次声音没有生成成功"
                    : "方案已经整理好，请确认后开始"}
            </h2>
            <p>
              {talkingJob?.speech_source === "clone"
                ? talkingJob.generation_strategy === "direct_full"
                  ? "声音与视频分开确认：先生成并确认口播音频，满意后再进入完整内容。"
                  : "声音与视频分开确认：先生成并确认口播音频，满意后才进入视频样片。"
                : talkingJob?.speech_source === "native_two_speaker_mixed_voice"
                  ? `双人图、左右两段授权声音和逐字对话已在本机检查；${talkingJob?.segments?.length || 1}个片段会按发言人和页面所列时长生成。`
                : talkingJob?.speech_source === "native_reference"
                  ? `人物、声音参考和逐字台词已在本机检查；${talkingJob?.segments?.length || 1}个片段会按页面所列时长依次生成。`
                  : talkingJob?.speech_source === "native_natural"
                    ? `人物和逐字台词已在本机检查；${talkingJob?.segments?.length || 1}个片段会按页面所列时长依次生成，本次不上传声音参考。`
                  : "本页读取真实素材检查结果；提交失败不会自动重试。"}
            </p>
          </div>
          {talkingJob?.state === "voice_failed" && <div className="mode-rule-note pink" role="alert"><strong>声音未完成，尚未继续制作视频</strong><span>{talkingHeadFailureMessage(talkingJob.error)}</span><p>已有任务保留。先调整资料并重新查看方案；如上次费用或平台状态不明，请先核对原任务记录。</p></div>}
          {["voice_review", "voice_failed", "preflight", "voice_preflight"].includes(talkingJob?.state || "") && <button className="secondary" type="button" onClick={() => { if (talkingJob) restoreTalkingSetupFromJob(talkingJob); go("setup"); }}>{talkingJob?.state === "voice_review" ? "声音不满意，修改后重新确认" : "修改资料，重新查看方案"}</button>}
          {talkingJob?.state === "voice_review" && (
            <section className="voice-review-card">
              <div>
                <small>
                  {talkingJob.voice_clone_route === "fidelity"
                    ? "音色还原优先 · 待你确认"
                    : talkingJob.voice_clone_route === "expressive"
                      ? "情绪表达优先 · 待你确认"
                      : "克隆声音 · 待你确认"}
                </small>
                <strong>
                  请听语气、音色、语速、停顿、内容是否完整
                  {talkingJob.voice_language_mode === "dialect" ? "，以及方言是否地道" : ""}
                </strong>
                <span>声音已返回 · 只提交 1 次</span>
                {talkingJob.voice_language_mode === "dialect" && talkingJob.voice_clone_route === "expressive" && (
                  <p className="voice-dialect-warning">
                    这条路线可能出现普通话混读，请重点试听方言是否地道；正式生产优先使用音色还原。
                  </p>
                )}
              </div>
              {/* This review player is audio-only; the confirmed script is shown in the project. */}
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio
                aria-label="克隆口播音频"
                onError={() => markMedia("voice", true)} onLoadedData={() => markMedia("voice", false)}
                controls
                src={`${API}/talking-head/jobs/${talkingJob.id}/audio`}
              />
            </section>
          )}
          {talkingJob?.state === "voice_review" && mediaFailures[mediaKey + ":voice"] && <p role="alert" className="mode-rule-note pink">声音暂时无法播放，请刷新检查原任务，能正常试听后再确认。</p>}
          {talkingJob?.direct_generation_blocked_reason && (
            <div className="mode-rule-note pink">
              <strong>已自动保留样片确认</strong>
              <span>{talkingJob.direct_generation_blocked_reason}</span>
            </div>
          )}
          <div className="preflight-layout">
            <div className="preflight-checks">
              <h3>生成条件</h3>
              {[
                [
                  "制作路线",
                  talkingJob?.mode === "native"
                    ? "逐字台词生成声音与画面；声音参考只负责音色"
                    : talkingJob?.mode === "boutique"
                      ? "人物母版＋完整确认音频驱动；提示词只负责表演"
                      : "人物母版＋完整确认音频驱动",
                ],
                [
                  "声音",
                  talkingJob?.mode === "singing"
                    ? "歌曲音频与授权待真实检查"
                    : talkingJob?.speech_source === "clone"
                      ? talkingJob.voice_clone_route === "fidelity"
                        ? `${talkingJob.voice_dialect || "方言"} · 音色还原优先 · 参考逐字稿已检查`
                        : talkingJob.voice_clone_route === "expressive"
                          ? `${talkingJob.voice_dialect || "方言"} · 情绪表达优先 · ${talkingEmotionName(talkingJob.voice_emotion_preset)}`
                          : "普通话确认稿＋授权声音参考，先生成并确认声音"
                      : talkingJob?.speech_source === "native_two_speaker_mixed_voice"
                        ? "左右人物分别使用自己的授权音色参考；每段只让一人发言"
                      : talkingJob?.speech_source === "native_reference"
                        ? "授权声音只作音色参考，模型直接生成新台词与表演"
                      : talkingJob?.speech_source === "native_natural"
                        ? "自然音色，不上传声音参考；声音与表演由模型一并生成"
                      : "已读取录好音频；噪声和内容完整性仍需试听确认",
                ],
                [
                  "人物",
                  talkingJob?.person_asset
                    ? `已读取当前项目的 ${talkingJob.person_asset.original_name}；生成后请检查口型和构图`
                    : "人物母版待登记",
                ],
                [
                  talkingJob?.mode === "native" ? "时长" : "分段",
                  talkingJob?.speech_source === "clone" && talkingJob.voice_state !== "approved"
                    ? talkingJob.mode === "standard"
                      ? "声音确认后按实际时长和自然停顿规划 · 标准口播通常按约 30～40 秒分段"
                      : "声音确认后按实际时长与自然停顿规划"
                    : talkingJob?.is_long
                    ? talkingJob.boutique_camera_experiment === "independent_clean_parallel_v1"
                      ? `${talkingJob.segments?.length || 0} 个独立 8 秒片段 · 每段都从原始干净母版开始，最多并发 4 条`
                      : `${talkingJob.segments?.length || 0} 个正式片段 · ${talkingJob.mode === "native" ? "按原稿顺序逐段生成" : `${talkingJob.generation_strategy === "direct_full" ? "确认后直接" : "样片通过后"}同时生成 ${talkingActualConcurrency(talkingJob)} 条`}`
                    : `${talkingJob?.mode === "boutique" ? "精品口播" : talkingJob?.mode === "native" ? "原生口播" : "标准口播"} · ${talkingJob?.mode === "native" ? "按完整语义规划6～15秒片段" : "当前音频可单段生成"}`,
                ],
                ["交付", talkingJob?.speech_source === "clone" && talkingJob.voice_state !== "approved" ? "先确认生成声音；确认后再规划视频片段与完整成片" : talkingJob?.is_long ? talkingJob.mode === "native" ? "逐段视频＋接缝记录＋保留各段原生声音的合成候选" : talkingJob.boutique_camera_experiment === "independent_clean_parallel_v1" ? "逐段质检＋动态接缝切点＋回铺原始完整音频的合成候选" : "逐段视频＋接缝记录＋回铺原始完整音频的合成候选" : talkingJob?.mode === "native" ? `${talkingJob.duration || 0}秒原生口播视频＋生成记录` : "原始口播视频＋生成记录"],
              ].map(([label, value], index) => (
                <div key={label}>
                  <span className={index < 4 ? "pass" : "ready"}>
                    {index < 4 ? "✓" : "→"}
                  </span>
                  <p>
                    <small>{label}</small>
                    <strong>{value}</strong>
                  </p>
                </div>
              ))}
            </div>
            <aside className="cost-preview submission-preview">
              <small>提交说明</small>
              <h3>
                {submissionPlan.title}
              </h3>
              <p>本次生成会调用外部服务；只按当前方案提交，不自动增加版本。</p>
              <p role="status" data-testid="talking-generation-configuration">{talkingJob?.generation_configuration?.message || "尚未确认生成通道配置，提交前将再次检查。"}</p>
              <dl>
                <div>
                  <dt>素材准备</dt>
                  <dd>资料已读取，生成效果待审阅</dd>
                </div>
                <div>
                  <dt>本次提交</dt>
                  <dd>
                    {submissionPlan.submissions} 次
                  </dd>
                </div>
                <div>
                  <dt>本次预估费用</dt>
                  <dd>{submissionPlan.currentCoins == null ? "待核对" : `${submissionPlan.currentCoins} RH 币`}</dd>
                </div>
                {submissionPlan.duration != null && <div><dt>本次视频时长</dt><dd>{submissionPlan.duration} 秒{!talkingJob?.is_long ? "（整段音频／完整内容）" : ""}</dd></div>}
                {submissionPlan.projectCoins != null && <div><dt>全项目预估费用</dt><dd>{submissionPlan.projectCoins} RH 币（含本次样片；后续片段需样片确认后提交）</dd></div>}
                <div>
                  <dt>自动重试</dt>
                  <dd>{talkingJob?.mode === "native" && talkingJob.native_run_strategy === "economy"
                    ? "仅在未开始生成的显存失败时转稳定 1 次"
                    : "关闭"}</dd>
                </div>
              </dl>
              <small>按同路线历史消耗并留安全余量估算；平台最终费用可能小幅浮动，以实际账单为准。</small>
            </aside>
          </div>
          {talkingJob?.mode === "native" && Boolean(talkingJob.segments?.length) && (
            <section className="native-duration-plan" aria-label="本次片段时长">
              <div>
                <small>本次片段时长</small>
                <strong>按每轮完整意思自然规划，不切断一句话</strong>
              </div>
              <ol>
                {talkingJob.segments?.map((segment, index) => (
                  <li key={segment.id}>
                    <span>第 {index + 1} 段</span>
                    <strong>{segment.speaker_side === "left" ? "左侧发言" : segment.speaker_side === "right" ? "右侧发言" : "单人口播"}</strong>
                    <b>{segment.generation_duration} 秒</b>
                    {segment.hanzi_count ? <small>{segment.hanzi_count} 字</small> : null}
                  </li>
                ))}
              </ol>
              {talkingJob.segments?.some((segment) => segment.duration_evidence === "projected_requires_paid_validation") && (
                <p>其中非 10 秒片段是本次实测候选；提交后仍需完整听审台词和衔接，当前不能提前保证效果。</p>
              )}
            </section>
          )}
          <div className="decision-bar">
            <div>
              <span>自动完成</span>
              <p>{talkingJob?.mode === "native" ? "台词容量、运行状态接回和技术检查" : talkingJob?.generation_strategy === "direct_full" ? "分段、运行状态接回和技术检查" : "样片动作编排、运行状态接回和技术检查"}</p>
            </div>
            <div>
              <span>需要你确认</span>
              <p>{talkingJob?.mode === "native" ? "最终成片" : talkingJob?.generation_strategy === "direct_full" ? "声音和最终成片" : "声音、样片审美和最终成片"}</p>
            </div>
            <div>
              <span>不会擅自做</span>
              <p>改稿、扩大上传、自动换通道或重复提交</p>
            </div>
          </div>
          {talkingError && (
            <div className="mode-rule-note pink">
              <strong>暂时没有继续</strong>
              <span>{talkingError}</span>
            </div>
          )}
          <div className="talking-primary-row">
            <div>
              <small>{talkingJob ? "准备生成" : "流程预览"}</small>
              <strong>
                {talkingJob?.speech_source === "clone" &&
                talkingJob.voice_state !== "approved"
                  ? talkingJob.voice_clone_route === "fidelity"
                    ? "本次只上传 1 段授权声音；参考逐字稿仅用于音色还原"
                    : talkingJob.voice_clone_route === "expressive"
                      ? "本次只上传 1 段授权声音；情绪和语速使用已选受控设置"
                      : "本次只上传 1 段授权声音，作为音色与情绪参考"
                  : talkingJob
                    ? talkingJob.speech_source === "native_two_speaker_mixed_voice"
                      ? "将上传 1 张双人母版和左右各 1 段授权音色样本；每段只读取当前发言人的声音"
                    : talkingJob.speech_source === "native_reference"
                      ? "将上传这 1 张母版和 1 段授权声音参考；声音只用于音色参考"
                      : talkingJob.speech_source === "native_natural"
                        ? "只上传这 1 张人物母版；不会上传声音参考"
                      : `将上传这 1 张母版和 ${talkingJob.generation_strategy === "direct_full" ? talkingDisplayDuration(talkingJob) : talkingJob.duration} 秒口播音频`
                    : "下一步只预览样片确认页面"}
              </strong>
              <span>
                {talkingJob
                  ? talkingJob.is_long
                    ? talkingJob.generation_strategy === "direct_full"
                      ? talkingJob.boutique_camera_experiment === "independent_clean_parallel_v1"
                        ? `跳过重复样片，本项目共 ${talkingJob.segments?.length || 1} 个独立 8 秒任务；每段都从原始干净母版开始，最多并发 4 条，失败不自动重试`
                        : `跳过样片，本项目共 ${talkingJob.segments?.length || 1} 段，按顺序逐段生成；同一时间只生成 ${talkingActualConcurrency(talkingJob)} 段，失败不自动重试`
                      : `样片只提交 1 次；通过后本项目将同时生成 ${talkingActualConcurrency(talkingJob)} 条，失败不自动重试`
                    : talkingJob.mode === "native" && talkingJob.native_run_strategy === "economy"
                      ? "先用快速路线；仅在未开始生成的显存失败时转稳定路线 1 次"
                      : "只提交 1 次，失败不自动重试"
                  : "当前路线尚未连接真实任务"}
              </span>
            </div>
            <button
              type="button"
              disabled={actionPending || (talkingJob?.generation_configuration?.status === "missing" && talkingJob?.state !== "voice_review") || talkingJob?.state === "voice_running" || talkingJob?.state === "voice_failed" || (talkingJob?.state === "voice_review" && !voiceMediaReady)}
              onClick={
                talkingJob?.state === "voice_review"
                  ? approveRealVoice
                  : talkingJob?.speech_source === "clone" &&
                      talkingJob.voice_state !== "approved"
                    ? startRealVoice
                    : talkingJob
                    ? startRealSample
                      : () => go("sample")
              }
            >
              {talkingJob?.state === "voice_running"
                ? "正在等待声音返回…"
                : talkingJob?.state === "voice_review"
                  ? talkingJob.generation_strategy === "direct_full"
                    ? "声音满意，继续完整内容 →"
                    : "声音满意，继续视频样片 →"
                  : talkingJob?.speech_source === "clone" &&
                      talkingJob.voice_state !== "approved"
                    ? "提交并生成口播音频 →"
                    : talkingJob
                      ? talkingJob.mode === "native"
                        ? `提交并生成${talkingJob.segments?.length || 1}段原生口播 →`
                        : talkingJob.generation_strategy === "direct_full"
                        ? "提交并直接生成完整内容 →"
                        : !talkingJob.is_long
                          ? `提交并生成整段 ${submissionPlan.duration} 秒视频 →`
                          : "提交并生成真实样片 →"
                      : "预览样片阶段 →"}
            </button>
          </div>
        </div>
      )}

      {stage === "sample" && (
        <div className="talking-panel review-panel talking-review-panel">
          <div className="talking-section-title">
            <span>{directProduction ? "成片确认" : "样片确认"}</span>
            <h2>
              {["running", "sample_running"].includes(talkingJob?.state || "")
                ? directProduction ? "完整内容正在生成" : "真实样片正在生成"
                : ["sample_review", "segment_review", "completed", "approved"].includes(talkingJob?.state || "")
                  ? directProduction ? "完整内容已经返回" : "真实样片已经返回"
                  : talkingJob?.state === "failed"
                    ? directProduction ? "这次完整内容没有生成成功" : "这次样片没有生成成功"
                    : directProduction ? "生成完成后在这里确认完整内容" : "先看一小段，满意再批量制作"}
            </h2>
            <p>
              {["running", "sample_running"].includes(talkingJob?.state || "")
                ? "可以离开页面，任务完成后这里会自动更新；即使服务重启，也会按平台任务记录恢复，不会重复提交。"
                : talkingJob?.state === "failed"
                  ? talkingHeadFailureMessage(talkingJob.error)
                  : "先检查人物、声音、表演和口型，再决定是否继续。"}
            </p>
          </div>
          {talkingJob && (
            <section
              className={`codex-task-link ${talkingJob.codex_thread_status === "failed" || !talkingJob.codex_thread_id ? "failed" : talkingJob.codex_thread_status === "connecting" ? "connecting" : "ready"}`}
            >
              <div>
                <small>需要判断、修改或继续制作？</small>
                <strong>
                  {talkingJob.codex_thread_status === "connecting"
                    ? "正在准备项目协助"
                    : talkingJob.codex_thread_status === "failed"
                      ? "项目已保存，协助入口暂未连接"
                      : talkingJob.codex_thread_id
                        ? "这个口播项目可以继续修改"
                        : "准备这个口播项目的协助入口"}
                </strong>
                <span>
                  {talkingJob.codex_thread_status === "ready"
                    ? "工作台会保留资料、进度和成果；需要修改时可以从这里继续。"
                    : "只准备并打开项目，不会自动生成音视频。"}
                </span>
              </div>
              {talkingJob.codex_thread_status !== "connecting" && (
                <button type="button" onClick={openTalkingHeadCodexTask}>
                  {talkingJob.codex_thread_id &&
                  talkingJob.codex_thread_status === "ready"
                    ? "打开项目任务 →"
                    : talkingJob.codex_thread_status === "failed"
                      ? "重新连接并打开"
                      : "建立并打开项目任务 →"}
                </button>
              )}
            </section>
          )}
          {mediaFailed && <p className="mode-rule-note pink" role="alert">视频暂时无法播放，尚不能确认质量。请刷新重试；仍无法播放时从任务中心检查原任务，不必重新生成。</p>}
          <div className="sample-layout">
            {talkingJob?.state === "failed" ? (
              <section className="talking-failure-card">
                <span className="review-badge">本次已停止 · 没有自动重试</span>
                <h3>平台没有返回可播放的视频</h3>
                <p>{talkingHeadFailureMessage(talkingJob.error)}</p>
                <p className="talking-failure-help">
                  你可以按原设置手动再试一次，或返回修改母版、画质和内容；系统不会自行重复提交。
                </p>
                
              <div className="review-choice">
                  <button type="button" className="secondary" onClick={() => { if (talkingJob) restoreTalkingSetupFromJob(talkingJob); go("setup"); }}>
                    返回修改设置
                  </button>
                  <button type="button" disabled={actionPending} onClick={startRealSample}>
                    按原设置手动重试一次
                  </button>
                </div>
              </section>
            ) : (
              <>
              {talkingJob?.state === "segment_review" ? (
              <section className="talking-segment-review-grid" aria-label="独立片段逐段检查">
                {talkingJob.segments?.map((segment, index) => (
                  <div key={segment.id}>
                    <strong>第 {index + 1} 段 · 约 8 秒</strong>
                    <video
                      className="real-talking-video"
                      aria-label={`口播片段 ${index + 1}`}
                      onError={() => markMedia(String(index), true)} onLoadedData={() => markMedia(String(index), false)}
                      controls
                      src={`${API}/talking-head/jobs/${talkingJob.id}/video?segment=${index + 1}`}
                    />
                  </div>
                ))}
              </section>
            ) : ["sample_review", "completed", "approved"].includes(talkingJob?.state || "") ? (
              <video
                key={`${talkingJob!.id}:${activeReviewVersion}`}
                className="real-talking-video"
                aria-label={directProduction ? "完整口播成片" : "真实口播样片"}
                onError={() => markMedia("main", true)} onLoadedData={() => markMedia("main", false)}
                controls
                src={`${API}/talking-head/jobs/${talkingJob!.id}/video?version=${activeReviewVersion}`}
              />
            ) : (
              <div className="mock-video">
                <div className="mock-person">
                  <i></i>
                  <span></span>
                </div>
                <button type="button" aria-label="播放样片演示">
                  {["running", "sample_running"].includes(talkingJob?.state || "") ? "…" : "▶"}
                </button>
                <em>
                  {["running", "sample_running"].includes(talkingJob?.state || "")
                    ? "真实任务进行中"
                    : talkingJob?.state === "failed"
                      ? "本次未生成视频"
                      : directProduction ? "视觉占位 · 完整内容尚未返回" : "视觉占位 · 尚未生成真实样片"}
                </em>
                <small>
                  00:
                  {String(Math.round(talkingJob?.duration || 8)).padStart(
                    2,
                    "0",
                  )}
                </small>
              </div>
              )}
            <aside className="sample-review">
              <span className="review-badge">
                {["running", "sample_running", "production_running", "editing_running"].includes(talkingJob?.state || "")
                  ? "正在等待平台返回"
                  : talkingJob?.state === "failed"
                    ? "没有自动重试"
                    : talkingJob?.qc_status ===
                        "review_pending_user_confirmation"
                      ? "硬项检查通过 · 等你看效果"
                      : "等待你的审美确认"}
              </span>
              {talkingJob && (
                <p className="actual-cost">
                  {[
                    "running",
                    "sample_running",
                    "production_running",
                    "editing_running",
                  ].includes(talkingJob.state || "")
                    ? "本次已提交，尚未返回"
                    : "本次生成已完成"} · {talkingSubmissionSummary(talkingJob)}
                  {talkingTotalCoins(talkingJob) != null
                    ? ` · 实际使用 ${talkingTotalCoins(talkingJob)} RH 币`
                    : ""}
                </p>
              )}
              {talkingJob?.budget_overrun && (
                <div className="mode-rule-note pink">
                  <strong>实际费用超过预估</strong>
                  <span>
                    本次比预算多 {talkingJob.budget_overrun_rh_coins || 0} RH 币；系统不会用这份旧预算自动扩大后续生成。
                  </span>
                </div>
              )}
              {talkingJob?.qc_status === "camera_stability_review_required" && (
                <div className="mode-rule-note pink">
                  <strong>机位约束仍需你逐段复核</strong>
                  <span>
                    当前模型已返回视频，但这不等于机位稳定性通过。请重点检查人物大小、拍摄角度、镜头推拉和片段间构图；确认前不会把它标成稳定成片。
                  </span>
                </div>
              )}
              {talkingJob?.qc_status === "independent_segment_review_required" && (
                <div className="mode-rule-note pink">
                  <strong>请先逐段看完，再合成完整成片</strong>
                  <span>
                    重点检查每段人物大小、角度、背景、脸部洁净度、口型、字幕和新增物体。任何一段有问题都不要通过；系统不会用整帧校准自动掩盖问题。
                  </span>
                </div>
              )}
              <h3>{talkingJob?.mode === "native" ? "这段原生口播可以采用吗？" : "这段人物状态可以继续吗？"}</h3>
              {talkingJob?.mode === "native" && talkingVersions.length > 1 && (
                <p className="talking-active-version">
                  正在查看 <strong>V{activeReviewVersion}</strong>
                  {activeReviewVersion === currentVersion ? " · 最新生成" : " · 历史版本"}
                </p>
              )}
              <ul>
                <li>
                  <b>人物</b>
                  <span>脸部稳定、身份一致</span>
                </li>
                <li>
                  <b>声音</b>
                  <span>音色、语速和停顿自然</span>
                </li>
                <li>
                  <b>表演</b>
                  <span>没有循环摇头或重复动作</span>
                </li>
                <li>
                  <b>口型</b>
                  <span>说话没有明显错位</span>
                </li>
                <li>
                  <b>画面文字</b>
                  <span>没有自动字幕、贴纸或乱码</span>
                </li>
                {talkingJob?.mode === "native" && (
                  <li>
                    <b>逐字台词</b>
                    <span>没有漏字、错字、重复、卡壳或结束后续说</span>
                  </li>
                )}
              </ul>
              {talkingJob?.mode === "native" && ["completed", "approved"].includes(talkingJob.state) && (
                <label className="talking-check native-dialogue-check">
                  <input
                    type="checkbox"
                    aria-label="原生口播逐字台词已完整听审"
                    checked={nativeDialogueConfirmed || Boolean(talkingJob.native_dialogue_user_confirmed)}
                    disabled={Boolean(talkingJob.native_dialogue_user_confirmed)}
                    onChange={(event) =>
                      setNativeDialogueConfirmedFor(event.target.checked ? nativeReviewKey : "")
                    }
                  />
                  <span>我已完整听过：台词没有漏字、错字、重复、卡壳，也没有结束后继续说话。</span>
                </label>
              )}
              {talkingJob?.mode === "native" && talkingJob.is_long && (
                <p className="talking-review-note">
                  请从头到尾完整听一遍，重点检查每个片段衔接处是否自然；工作台已保留全部独立片段，不能替你判断听感是否满意。
                </p>
              )}
              <div className="review-choice">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (talkingJob) restoreTalkingSetupFromJob(talkingJob);
                    go("setup");
                  }}
                >
                  调整母版或其他资料
                </button>
                {talkingJob?.mode === "native" && !talkingJob.is_long && talkingJob.state === "completed" && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setRegenerateConfirmOpen(true)}
                  >
                    再生成一个不同版本
                  </button>
                )}
                <button
                  type="button"
                  disabled={actionPending || !reviewMediaReady || mediaFailed || Boolean(
                    talkingJob &&
                    (!["sample_review", "segment_review", "completed", "approved"].includes(talkingJob.state) ||
                      (talkingJob.mode === "native" &&
                        !nativeDialogueConfirmed &&
                        !talkingJob.native_dialogue_user_confirmed)),
                  )}
                  onClick={approveRealVideo}
                >
                  {talkingJob?.state === "segment_review"
                    ? "各段都没问题，合成完整成片 →"
                    : talkingJob?.is_long && talkingJob.state === "sample_review"
                    ? `样片满意，生成 ${talkingJob.segments?.length || 0} 个正式片段 →`
                    : talkingJob?.mode === "native"
                      ? `满意，采用 V${activeReviewVersion}`
                      : directProduction ? "满意，采用完整成片" : "满意，采用为本次成片"}
                </button>
              </div>
              {regenerateConfirmOpen && talkingJob?.mode === "native" && (
                <section className="talking-regenerate-confirm" aria-label="重新生成确认">
                  <strong>保留所有旧版本，再新增生成 1 次</strong>
                  <p>
                    预计费用上限 {talkingJob.estimated_rh_coins || 195} RH 币；本次会换一个新的随机结果，人物占比、动作、表情或字幕都可能变化，不会自动重试。
                  </p>
                  <p>
                    如果只是人物太近、太远或留白不合适，建议取消并先点“调整母版或其他资料”；反复抽卡不能保证保持原构图。
                  </p>
                  <label>
                    不满意的原因（只做记录，不自动改提示词）
                    <select
                      value={regenerateReason}
                      onChange={(event) => setRegenerateReason(event.target.value)}
                    >
                      <option>模型随机效果不满意</option>
                      <option>自动出现字幕或文字</option>
                      <option>台词错误、重复或卡壳</option>
                      <option>构图或人物占比不满意</option>
                      <option>表演或口型不自然</option>
                      <option>其他</option>
                    </select>
                  </label>
                  <div>
                    <button type="button" className="secondary" onClick={() => setRegenerateConfirmOpen(false)}>
                      取消
                    </button>
                    <button type="button" disabled={actionPending} onClick={regenerateNativeVersion}>
                      确认生成不同版本 1 次
                    </button>
                  </div>
                </section>
              )}
            </aside>
              </>
            )}
          </div>
          {talkingJob?.mode === "native" && talkingVersions.length > 1 && (
            <section className="talking-version-history" aria-label="历史生成版本">
              <div>
                <span>版本记录</span>
                <h3>每一版都保留，可以重新播放和采用</h3>
                <p>选择某一版后，请重新完整听审，再在上方确认采用。</p>
              </div>
              <div className="talking-version-grid">
                {talkingVersions.map((version) => (
                  <article
                    key={version.version}
                    className={version.version === activeReviewVersion ? "active" : ""}
                  >
                    <video
                      controls
                      preload="metadata"
                      src={`${API}/talking-head/jobs/${talkingJob.id}/video?version=${version.version}`}
                    />
                    <div>
                      <strong>V{version.version}</strong>
                      <span>{version.version === currentVersion ? "最新生成" : "历史保留"}</span>
                      <small>{version.version === 1 && version.variation_mode !== "new_random_version" ? "首次稳定配置" : "不同随机版本"}</small>
                  <small>生成记录已保存</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setReviewVersion(version.version);
                        setNativeDialogueConfirmedFor("");
                        setRegenerateConfirmOpen(false);
                      }}
                    >
                      {version.version === activeReviewVersion ? "正在查看" : `查看并考虑采用 V${version.version}`}
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {stage === "production" && (
        <div className="talking-panel production-panel">
          <div className="talking-section-title">
            <span>{singleNativeProduction || independentH3LongformProduction ? "正在生成" : "批量制作"}</span>
            <h2>{talkingJob?.state === "cancelled" ? "本次生成已停止" : talkingJob?.state === "cancel_requested" ? "正在停止生成" : singleNativeProduction ? `${talkingJob?.duration || 0}秒原生口播正在生成` : talkingJob?.mode === "native" ? "完整原生口播正在逐段生成" : directProduction ? "完整内容正在加速生成" : "剩余片段正在加速生成"}</h2>
            <p>{singleNativeProduction ? "本次只提交 1 条；完成后会直接回到工作台，请你确认人物、声音、表演和口型。" : independentH3LongformProduction ? `本项目共 ${talkingJob?.segments?.length || 1} 个独立 8 秒任务；每段都从原始干净母版开始，最多并发 4 条，全部返回后先逐段确认，再按动态切点合成并回铺完整音频。` : `本项目共 ${talkingJob?.segments?.length || 1} 段，按顺序逐段生成；同一时间只生成 ${talkingJob ? talkingActualConcurrency(talkingJob) : 1} 段，每段独立记录结果和费用。`}</p>
          </div>
          <div className="production-overview">
            <div className="production-ring">
              <strong>{talkingJob?.segments?.filter((item) => item.state === "completed").length || 0}/{talkingJob?.segments?.length || 0}</strong>
              <span>真实片段</span>
            </div>
            <div>
              <small>{talkingJob ? talkingModeName(talkingJob.mode) : currentMode.name}</small>
              <h3>{talkingJob?.state === "cancelled" ? "已完成的片段仍然保留" : talkingJob?.state === "cancel_requested" ? "正在等待平台停止回执" : talkingJob?.state === "failed" ? "生产已安全暂停" : singleNativeProduction ? "可以离开页面，完成后自动回来确认" : "可以离开页面，完成后自动进入拼接"}</h3>
              <p>{talkingJob?.error || "工作台会持续读取每段真实平台状态。"}</p>
            </div>
          </div>
          <div className="segment-list">
            {talkingJob?.segments?.map((segment) => (
              <div key={segment.id} className={segment.state === "completed" ? "complete" : ""}>
                <span>{segment.state === "completed" ? "✓" : ["running", "waiting_capacity", "cancel_requested"].includes(segment.state) ? "…" : segment.state === "cancelled" ? "—" : "·"}</span>
                <p>
                  <strong>{segment.id}</strong>
                  <small>{segment.start.toFixed(1)}–{segment.end.toFixed(1)} 秒{segment.hanzi_count ? ` · ${segment.hanzi_count}个汉字` : ""} · {segment.state === "running" ? "生成中" : segment.state === "waiting_capacity" ? "排队等待可用通道" : segment.state === "cancel_requested" ? "正在停止" : segment.state === "cancelled" ? "已停止" : segment.state === "completed" ? "已返回" : segment.state === "failed" ? "未成功" : "等待开始"}</small>
                  {segment.dialogue && <small>{segment.dialogue}</small>}
                </p>
                <em>
                  {segment.content_duration.toFixed(1)} 秒
                  {segment.usage?.consumeCoins
                    ? ` · 已用 ${segment.usage.consumeCoins} RH 币`
                    : ""}
                </em>
              </div>
            ))}
          </div>
          {talkingJob && (talkingJob.voice_usage?.consumeCoins || talkingVideoCoins(talkingJob) != null) && (
            <p className="actual-cost">
              当前已记录费用：声音 {Number(talkingJob.voice_usage?.consumeCoins || 0)} RH 币
              {talkingVideoCoins(talkingJob) != null
                ? `，已返回视频片段 ${talkingVideoCoins(talkingJob)} RH 币`
                : "，视频片段尚未返回费用"}
              ；未开始或未成功的片段不计入。
            </p>
          )}
          {talkingError && (
            <div className="mode-rule-note pink">
              <strong>暂时没有继续</strong>
              <span>{talkingError}</span>
            </div>
          )}
          <div className="talking-primary-row"><div><small>{talkingJob?.state === "cancelled" ? "本次已停止" : "下一步自动完成"}</small><strong>{talkingJob?.state === "cancelled" ? "未开始的片段不会再提交" : singleNativeProduction ? "返回完整视频，等待你确认" : talkingJob?.mode === "native" ? "逐段生成并合成为完整候选" : "接缝检查、片段拼接、完整音频回铺"}</strong><span>{talkingJob?.state === "cancelled" ? "已完成片段可用于复盘，不会自动续跑" : singleNativeProduction ? "无需再提交或逐段操作" : talkingJob?.mode === "native" ? "完成后请完整听审片段衔接" : "无需逐段点击"}</span></div>{talkingJob?.state === "failed" ? <button type="button" onClick={startRealSample}>继续未消费的片段 →</button> : talkingJob?.state === "cancelled" ? <button type="button" disabled>已停止</button> : talkingJob?.state === "cancel_requested" ? <button type="button" disabled>正在停止…</button> : <button type="button" className="secondary" onClick={stopRealGeneration}>停止生成</button>}</div>
        </div>
      )}

      {stage === "qc" && (
        <div className="talking-panel qc-panel">
          <div className="talking-section-title">
            <span>质量检查</span>
            <h2>只返工有问题的片段</h2>
            <p>
              不会因为一个局部问题重做整条视频，也不会把“平台成功”误写成“成片完成”。
            </p>
          </div>
          <div className="qc-score">
            <div>
              <strong>92</strong>
              <span>演示评分</span>
            </div>
            <p>
              <small>整体结论</small>
              <b>2 段可直接使用，1 段建议剪辑处理</b>
              <span>没有需要重新生成的阻断问题</span>
            </p>
            <em>可以进入剪辑</em>
          </div>
          <div className="qc-table">
            <div className="qc-head">
              <span>片段</span>
              <span>口型与人物</span>
              <span>动作自然度</span>
              <span>处理建议</span>
            </div>
            <div>
              <strong>01 · 开场</strong>
              <span className="qc-pass">通过</span>
              <span className="qc-pass">通过</span>
              <span>直接使用</span>
            </div>
            <div>
              <strong>02 · 核心内容</strong>
              <span className="qc-pass">通过</span>
              <span className="qc-warn">结尾动作偏多</span>
              <span>剪掉末尾 0.6 秒</span>
            </div>
            <div>
              <strong>03 · 收尾</strong>
              <span className="qc-pass">通过</span>
              <span className="qc-pass">通过</span>
              <span>直接使用</span>
            </div>
          </div>
          <div className="talking-primary-row">
            <div>
              <small>最小返工原则</small>
              <strong>这个问题交给剪辑处理即可</strong>
              <span>不重新生成人物、声音或整段视频</span>
            </div>
            <button type="button" onClick={() => go("editing")}>
              预览成片剪辑 →
            </button>
          </div>
        </div>
      )}

      {stage === "editing" && (
        <div className="talking-panel editing-panel">
          <div className="talking-section-title">
            <span>自动合成</span>
            <h2>片段已经返回，正在生成完整成片</h2>
            <p>工作台会自动拼接已返回片段；精品口播同时回铺原始完整音频，原生口播保留各段模型原声。</p>
          </div>
          <div className="talking-running-card">
            <div>
              <strong>{talkingJob?.segments?.length || 1} 段已全部返回</strong>
              <span>
                {talkingJob?.mode === "boutique"
                  ? "正在拼接画面并回铺本次确认的完整音频"
                  : "正在按顺序拼接逐字口播片段"}
              </span>
            </div>
            <div>
              <strong>{talkingJob?.target_ratio || "原画幅"}</strong>
              <span>完整成片约 {Math.round(talkingJob?.measured_duration || talkingJob?.duration || 0)} 秒</span>
            </div>
          </div>
          <div className="talking-primary-row">
            <div>
              <small>无需操作</small>
              <strong>完成后自动进入成片确认</strong>
              <span>不会新增字幕、背景音乐或其他未选择的效果</span>
            </div>
            <button type="button" disabled>正在合成…</button>
          </div>
        </div>
      )}

      {stage === "result" && (
        <div className="talking-panel result-panel">
          <div className="result-celebration">
            <span>✓</span>
            <div>
              <small>
                {talkingJob?.state === "approved"
                  ? "本次真实口播已经采用"
                  : "完整流程视觉预演已完成"}
              </small>
              <h2>
                {talkingJob?.state === "approved"
                  ? "口播成片已经进入成果中心"
                  : "口播成片会在这里直接播放"}
              </h2>
              <p>
                成果、质量结论、费用和继续修改入口集中在同一页，不再跳回任务里猜下一步。
              </p>
            </div>
          </div>
          <div className="final-result-layout">
            {talkingJob?.state === "approved" ? (
              // The original spoken audio is the content; subtitle export is a later editing task.
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                className="real-talking-video"
                aria-label="已采用口播成片"
                controls
                src={`${API}/talking-head/jobs/${talkingJob.id}/video`}
              />
            ) : (
              <div className="final-video">
                <div className="mock-person">
                  <i></i>
                  <span></span>
                </div>
                <button type="button" aria-label="播放最终成片演示">
                  ▶
                </button>
                <div className="mock-caption">一个人，也能把内容稳定做出来</div>
                <em>视觉占位 · 无真实视频</em>
              </div>
            )}
            <aside className="result-assets">
              <h3>本项目成果</h3>
              <div>
                <span>片</span>
                <p>
                  <strong>口播成片</strong>
                  <small>可直接播放与打开</small>
                </p>
              </div>
              <div>
                <span>记</span>
                <p>
                  <strong>生成记录</strong>
                  <small>任务和版本记录已保存；额度明细在接口管理后台查看</small>
                </p>
              </div>
              {talkingJob?.state === "approved" ? (
                <a
                  className="button-link"
                  href={`${API}/talking-head/jobs/${talkingJob.id}/video`}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开成片 ↗
                </a>
              ) : (
                <button type="button" disabled>
                  下载成片（功能接通后开放）
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={startNewTalkingProject}
              >
                重新预演一条口播
              </button>
            </aside>
          </div>
        </div>
      )}
    </section>
  );
}

function TaskCenter({
  tasks,
  xhsJewelryTasks,
  onOpenXhsJewelry,
  socialExtractions,
  talkingJobs,
  modelAssetProjects,
  onCreate,
  onOpen,
  onOpenSocial,
  onOpenTalking,
  onOpenModel,
}: {
  tasks: Task[];
  xhsJewelryTasks: JewelryTask[];
  onOpenXhsJewelry: (taskId: string) => void;
  socialExtractions: SocialExtraction[];
  talkingJobs: TalkingJob[];
  modelAssetProjects: ModelAssetProject[];
  onCreate: () => void;
  onOpen: (id: string) => void;
  onOpenSocial: () => void;
  onOpenTalking: (job: TalkingJob) => void;
  onOpenModel: (projectId: string) => void;
}) {
  const [filter, setFilter] = useState<
    "all" | "attention" | "running" | "done"
  >("all");
  const [query, setQuery] = useState("");
  const entries = [
    ...xhsJewelryTasks.map((task) => ({
      id: `jewelry-${task.id}`,
      kind: "珠宝种草",
      icon: "珠",
      iconClass: "model-task-icon",
      title: task.title,
      subtitle: task.user_message,
      bucket: task.status.startsWith("running_") ? "running" : ["video_ready", "completed"].includes(task.status) ? "done" : "attention",
      statusLabel: jewelryStatusLabel(task.status, task.person_strategy),
      statusTone: task.status.startsWith("running_") ? "running" : task.status.endsWith("_failed") ? "error" : ["video_ready", "completed"].includes(task.status) ? "done" : "waiting",
      cost: "生成记录已保存",
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      onOpen: () => onOpenXhsJewelry(task.id),
    })),
    ...modelAssetProjects.map((project) => ({
      id: `model-${project.id}`,
      kind: modelProjectSourceLabel(project),
      icon: "模",
      iconClass: "model-task-icon",
      title: project.name,
      subtitle:
        isImportedMasterProject(project)
          ? "模特母版 · 对标画面 · 口播母版"
          : project.route === "ai_model"
          ? "人物母版 · 发型 · 穿搭 · 场景与氛围"
          : "授权真人 · 人物母版 · 人工确认",
      bucket:
        project.status === "running"
          ? "running"
          : modelProjectComplete(project)
            ? "done"
            : "attention",
      statusLabel: modelProjectStatus(project),
      statusTone:
        modelProjectComplete(project)
          ? "done"
          : ["blocked", "failed_after_submit"].includes(project.status)
            ? "error"
            : project.status === "running"
              ? "running"
              : "waiting",
      cost:
        project.generation_attempt_count > 0
          ? `${project.generation_attempt_count} 次生成记录`
          : "未调用生图",
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      onOpen: () => onOpenModel(project.id),
    })),
    ...socialExtractions.map((item) => ({
      id: `social-${item.id}`,
      kind: "社媒提取",
      icon: "取",
      iconClass: "social-task-icon",
      title:
        item.result?.author ||
        item.title ||
        `爆款提取 · ${formatShortDate(item.created_at)}`,
      subtitle: `${item.extraction_scope === "copy_and_media" ? "文案和素材" : item.extraction_scope === "media_only" ? "仅原始素材" : "仅发布文案"} · ${item.downstream_use || "未设置用途"}`,
      bucket:
        item.status === "completed"
          ? "done"
          : item.status === "failed"
            ? "attention"
            : "running",
      statusLabel:
        item.status === "completed"
          ? "已完成"
          : item.status === "failed"
            ? "需要处理"
            : "提取中",
      statusTone:
        item.status === "completed"
          ? "done"
          : item.status === "failed"
            ? "error"
            : "running",
      cost:
        item.result?.provider_usage?.confirmed_cost_usd != null
          ? `$${Number(item.result.provider_usage.confirmed_cost_usd).toFixed(3)}`
          : "尚未计费",
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      onOpen: onOpenSocial,
    })),
    ...talkingJobs.map((job) => {
      const done = ["completed", "approved"].includes(job.state);
      const running = [
        "running",
        "sample_running",
        "production_running",
        "editing_running",
        "voice_running",
      ].includes(job.state);
      const failed = ["failed", "voice_failed"].includes(job.state);
      const modeName = talkingModeName(job.mode);
      const duration = talkingDisplayDuration(job);
      return {
        id: `talking-${job.id}`,
        kind: modeName,
        icon: "播",
        iconClass: "talking-task-icon",
        title: `${job.confirmed_script?.trim().slice(0, 28) || job.project_name || modeName} · ${duration ? `${duration}秒` : "声音克隆"} · ${job.id.slice(0, 6)}`,
        subtitle: job.state.startsWith("voice_")
          ? "克隆声音 · AI 口播"
          : `${job.is_long ? "完整音频" : job.generation_strategy === "direct_full" ? "完整内容" : "样片"} · AI 口播`,
        bucket: done ? "done" : running ? "running" : "attention",
        statusLabel: done
          ? job.state === "approved"
            ? "成片已采用"
            : isCompleteTalkingVideo(job)
              ? "成片已返回"
              : "样片已返回"
          : job.state === "voice_review"
            ? "声音待确认"
            : failed
              ? "需要处理"
              : running
                ? "生成中"
                : "方案待确认",
        statusTone: done
          ? "done"
          : failed
            ? "error"
            : running
              ? "running"
              : "waiting",
        cost: "生成记录已保存",
        createdAt: job.created_at || job.updated_at || "",
        updatedAt: job.updated_at || job.created_at || "",
        onOpen: () => onOpenTalking(job),
      };
    }),
    ...tasks.map((task) => {
      const state = taskUserState(task);
      return {
        id: `remix-${task.id}`,
        kind: "爆款重构",
        icon: "影",
        iconClass: "",
        title: task.title,
        subtitle: "参考视频 · 内容重构 · 人物与分镜",
        bucket:
          state.key === "processing"
            ? "running"
            : state.needs_attention || state.key === "assistance"
              ? "attention"
              : userFacingArtifacts(task).length > 0
                ? "done"
                : "attention",
        statusLabel: state.label,
        statusTone: state.tone,
        cost: `¥${Number(task.estimated_cost_cny || 0).toFixed(2)} / ¥${Number(task.budget_limit_cny).toFixed(0)}`,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        onOpen: () => onOpen(task.id),
      };
    }),
  ].sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt)),
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = entries.filter(
    (entry) =>
      (filter === "all" || entry.bucket === filter) &&
      (!normalizedQuery ||
        `${entry.title} ${entry.kind} ${entry.subtitle}`
          .toLowerCase()
          .includes(normalizedQuery)),
  );
  const groupedEntries = visibleEntries.reduce<
    Record<string, typeof visibleEntries>
  >((groups, entry) => {
    const label = taskDateGroup(entry.updatedAt);
    (groups[label] ||= []).push(entry);
    return groups;
  }, {});
  const hasTasks = entries.length > 0;
  return (
    <section className="subpage">
      <div className="subpage-title">
        <div>
          <span>项目进度都在这里</span>
          <h1>任务中心</h1>
          <p>查看每个项目做到哪一步，继续确认或处理问题。</p>
        </div>
        <button onClick={onCreate}>＋ 新建视频项目</button>
      </div>
      {hasTasks ? (
        <>
          <div className="task-center-tools">
            <div className="filter-tabs" aria-label="任务状态筛选">
              {(
                [
                  ["all", "全部"],
                  ["attention", "等我处理"],
                  ["running", "生成中"],
                  ["done", "已完成"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              aria-label="搜索项目"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目名称或类型"
            />
          </div>
          {visibleEntries.length === 0 ? (
            <div className="task-search-empty">没有找到符合条件的项目</div>
          ) : (
            Object.entries(groupedEntries).map(([group, groupEntries]) => (
              <section className="task-date-group" key={group}>
                <h2>
                  {group}<span>{groupEntries.length} 个项目</span>
                </h2>
                <div className="task-table live-table">
                  <div className="table-head">
                    <span>项目</span><span>当前状态</span><span>费用</span><span>时间</span>
                  </div>
                  {groupEntries.map((entry) => (
                    <button
                      className="live-table-row"
                      key={entry.id}
                      onClick={entry.onOpen}
                    >
                      <span className="table-title">
                        <b className={entry.iconClass}>{entry.icon}</b>
                        <span>
                          <strong>{entry.title}</strong>
                          <small><em>{entry.kind}</em>{entry.subtitle}</small>
                        </span>
                      </span>
                      <span className={`status ${entry.statusTone}`}>
                        <i></i>{entry.statusLabel}
                      </span>
                      <span className="cost">{entry.cost}</span>
                      <time>
                        <strong>更新 {formatTime(entry.updatedAt)}</strong>
                        <small>创建 {formatTime(entry.createdAt)}</small>
                      </time>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      ) : (
        <EmptyState onCreate={onCreate} />
      )}
    </section>
  );
}

function xhsJewelryImageAdopted(task: JewelryTask) {
  return task.final_result?.approval_status === "approved" ||
    ["video_ready", "running_video", "video_review", "video_failed", "completed"].includes(task.status);
}

function xhsJewelryVideoAdopted(task: JewelryTask) {
  return task.video_result?.approval_status === "approved" || task.status === "completed";
}

function slotLabelForResult(slot: JewelryTask["target_slot"]) {
  return ({
    necklace: "项链 / 吊坠",
    earrings: "耳环 / 耳饰",
    bracelet: "手链 / 手镯",
    ring: "戒指",
    brooch_hair: "胸针 / 发饰",
  })[slot];
}

function Results({
  tasks,
  socialExtractions,
  talkingJobs,
  modelAssetProjects,
  xhsJewelryTasks,
  onOpenTask,
  onOpenTalking,
  onOpenModel,
  onOpenXhsJewelry,
}: {
  tasks: Task[];
  socialExtractions: SocialExtraction[];
  talkingJobs: TalkingJob[];
  modelAssetProjects: ModelAssetProject[];
  xhsJewelryTasks: JewelryTask[];
  onOpenTask: (id: string) => void;
  onOpenTalking: (job: TalkingJob) => void;
  onOpenModel: (projectId: string) => void;
  onOpenXhsJewelry: (taskId: string) => void;
}) {
  const projects = tasks
    .map((task) => ({ task, artifacts: userFacingArtifacts(task) }))
    .filter((item) => item.artifacts.length > 0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedTalkingId, setSelectedTalkingId] = useState<string | null>(
    null,
  );
  const [selectedSocialId, setSelectedSocialId] = useState<string | null>(null);
  const [selectedXhsJewelryId, setSelectedXhsJewelryId] = useState<string | null>(null);
  const [resultStatus, setResultStatus] = useState<"all" | "formal" | "review">("all");
  const [resultKind, setResultKind] = useState<"all" | "xhs" | "video" | "audio" | "image" | "text">("all");
  const [resultQuery, setResultQuery] = useState("");
  const selected =
    projects.find(({ task }) => task.id === selectedProjectId) || null;
  const completedTalking = talkingJobs.filter(
    (job) => talkingResultMedia(job) !== null,
  );
  const selectedTalking =
    completedTalking.find((job) => job.id === selectedTalkingId) || null;
  const completedSocial = socialExtractions.filter(
    (item) => item.status === "completed" && item.result,
  );
  const selectedSocial =
    completedSocial.find((item) => item.id === selectedSocialId) || null;
  const xhsJewelryResults = xhsJewelryTasks.filter((task) =>
    Boolean(task.base_result || task.final_result || task.video_result),
  );
  const selectedXhsJewelry =
    xhsJewelryResults.find((task) => task.id === selectedXhsJewelryId) || null;
  const selectedSocialMediaOnly =
    selectedSocial?.extraction_scope === "media_only";
  if (selectedXhsJewelry) {
    const hasFinalImage = Boolean(selectedXhsJewelry.final_result);
    const imageAdopted = xhsJewelryImageAdopted(selectedXhsJewelry);
    const videoAdopted = xhsJewelryVideoAdopted(selectedXhsJewelry);
    return (
      <section className="subpage result-detail-page">
        <div className="result-detail-head">
          <button type="button" onClick={() => setSelectedXhsJewelryId(null)}>← 返回成果中心</button>
          <div>
            <span>珠宝种草 · {imageAdopted ? "成品图已采用" : "图片待确认"}</span>
            <h1>{selectedXhsJewelry.title}</h1>
            <p>{imageAdopted ? "已采用图片可以直接查看；视频会按采用状态单独标记，不会影响图片成果。" : "当前图片仍需要确认，确认采用后会自动进入正式成果。"}</p>
          </div>
          <button type="button" className="continue-production" onClick={() => onOpenXhsJewelry(selectedXhsJewelry.id)}>返回项目继续 →</button>
        </div>
        <section className="result-section primary">
          <div className="result-section-head"><span>01</span><div><h2>{hasFinalImage ? "珠宝成品图" : "人物视觉底片"}</h2><p>{imageAdopted ? "已采用，可直接查看和继续使用" : "当前等待你的审核"}</p></div></div>
          <div className="xhs-result-image">
            <Image
              src={`${API}/xhs-jewelry/tasks/${selectedXhsJewelry.id}/${hasFinalImage ? "final-image" : "base-image"}?v=${hasFinalImage ? selectedXhsJewelry.product_attempt_count : selectedXhsJewelry.base_attempt_count}`}
              width={1200}
              height={1600}
              unoptimized
              alt={`${selectedXhsJewelry.title}${hasFinalImage ? "珠宝成品图" : "人物视觉底片"}`}
            />
          </div>
        </section>
        {selectedXhsJewelry.video_result && (
          <section className="result-section">
            <div className="result-section-head"><span>02</span><div><h2>{videoAdopted ? "已采用短视频" : "视频版本记录"}</h2><p>{videoAdopted ? "已采用，可直接播放" : "未采用或待确认，不会冒充正式成果"}</p></div></div>
            <div className="talking-result-viewer">
              <video controls muted playsInline preload="metadata" src={`${API}/xhs-jewelry/tasks/${selectedXhsJewelry.id}/video-file?v=${selectedXhsJewelry.video_attempt_count}`} />
            </div>
          </section>
        )}
      </section>
    );
  }
  if (selectedSocial)
    return (
      <section className="subpage result-detail-page">
        <div className="result-detail-head">
          <button type="button" onClick={() => setSelectedSocialId(null)}>
            ← 返回成果中心
          </button>
          <div>
            <span>社媒内容成果 · {formatShortDate(selectedSocial.updated_at)}</span>
            <h1>{selectedSocial.result?.author || selectedSocial.title}</h1>
            <p>
              {selectedSocialMediaOnly
                ? "保存的视频、封面或图集集中放在这里，可以直接查看和继续使用。"
                : "发布文案、话题和已提取素材集中放在这里，可以直接查看和继续使用。"}
            </p>
          </div>
        </div>
        {!selectedSocialMediaOnly && (
          <section className="result-section">
            <div className="result-section-head"><span>01</span><div><h2>发布文案</h2><p>完整文案与话题标签</p></div></div>
            <article className="social-copy-result">
              <p>{selectedSocial.result?.desc || "当前没有提取到发布文案。"}</p>
              {(selectedSocial.result?.hashtags || []).length > 0 && (
                <div className="result-chip-list">
                  {selectedSocial.result?.hashtags.map((tag) => <span key={tag}>#{tag.replace(/^#/, "")}</span>)}
                </div>
              )}
            </article>
          </section>
        )}
        {socialResultFiles(selectedSocial.result).length > 0 && (
          <section className="result-section">
            <div className="result-section-head"><span>{selectedSocialMediaOnly ? "01" : "02"}</span><div><h2>原始素材</h2><p>已保存的视频和封面</p></div></div>
            <div className="social-artifact-links prominent">
              {socialResultFiles(selectedSocial.result).map((file) => (
                <a key={file} href={`${API}/social-extractions/${selectedSocial.id}/artifacts/${socialArtifactIndex(socialResultFiles(selectedSocial.result), file)}`} target="_blank" rel="noreferrer">
                  {file === "video.mp4" ? "播放原视频" : file === "cover.jpg" ? "打开封面" : `打开 ${file}`} ↗
                </a>
              ))}
            </div>
          </section>
        )}
      </section>
    );
  if (selectedTalking)
    return (
      <section className="subpage result-detail-page">
        <div className="result-detail-head">
          <button type="button" onClick={() => setSelectedTalkingId(null)}>
            ← 返回成果中心
          </button>
          <div>
            <span>当前可用成果</span>
            <h1>
              {talkingModeName(selectedTalking.mode)}
              项目
            </h1>
            <p>
              {selectedTalking.state === "approved"
                ? "成片已经采用"
                : selectedTalking.state === "voice_review"
                  ? "声音已经返回"
                : selectedTalking.state === "sample_review"
                  ? "样片已经返回"
                  : "完整成片已经返回"}
              ；{selectedTalking.state === "approved"
                ? "已登记为正式可用成果。"
                : "当前等待你的审美确认。"}
            </p>
          </div>
          <button
            type="button"
            className="continue-production"
            onClick={() => onOpenTalking(selectedTalking)}
          >
            返回项目继续 →
          </button>
        </div>
        <div className="talking-result-viewer">
          <div>
            <span>{selectedTalking.state === "voice_review" ? "口播声音" : selectedTalking.state === "sample_review" ? "口播样片" : "口播成片"}</span>
            <h3>{selectedTalking.state === "voice_review" ? "先听声音，满意后返回项目继续制作视频" : "可直接播放检查人物、声音、表演和口型"}</h3>
          </div>
          {/* The spoken video is the content; subtitle export belongs to the editing workflow. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          {talkingResultMedia(selectedTalking) === "audio" ? <audio aria-label="口播待确认声音" controls src={`${API}/talking-head/jobs/${selectedTalking.id}/audio`} /> : <video
            aria-label="口播成果视频"
            controls
            src={`${API}/talking-head/jobs/${selectedTalking.id}/video`}
          />}
        </div>
      </section>
    );
  if (selected)
    {
      const grouped = groupResultArtifacts(selected.artifacts);
      const versionLibrary = videoVersionLibrary(selected.task);
      return (
      <section className="subpage result-detail-page">
        <div className="result-detail-head">
          <button type="button" onClick={() => setSelectedProjectId(null)}>
            ← 返回成果中心
          </button>
          <div>
            <span>当前可用成果</span>
            <h1>{selected.task.title}</h1>
            <p>{resultSummary(selected.task)}</p>
          </div>
          <button
            type="button"
            className="continue-production"
            onClick={() => onOpenTask(selected.task.id)}
          >
            继续制作 →
          </button>
        </div>
        {grouped.map((group, index) =>
          group.key === "materials" ? (
            <details className="result-section result-materials" key={group.key}>
              <summary>
                <div className="result-section-head"><span>0{index + 1}</span><div><h2>{group.title}</h2><p>{group.description} · 点击展开</p></div></div>
              </summary>
              <div className="artifact-viewer-grid">
                {group.artifacts.map((artifact) => <ArtifactViewer key={artifact.id} task={selected.task} artifact={artifact} />)}
              </div>
            </details>
          ) : (
            <section className={`result-section ${index === 0 ? "primary" : ""}`} key={group.key}>
              <div className="result-section-head"><span>0{index + 1}</span><div><h2>{group.title}</h2><p>{group.description}</p></div></div>
              <div className="artifact-viewer-grid">
                {group.artifacts.map((artifact) => <ArtifactViewer key={artifact.id} task={selected.task} artifact={artifact} />)}
              </div>
            </section>
          ),
        )}
        {(versionLibrary.full.length > 0 || versionLibrary.segments.length > 0) && (
          <section className="result-section result-version-library">
            <div className="result-section-head">
              <span>{String(grouped.length + 1).padStart(2, "0")}</span>
              <div>
                <h2>视频版本库</h2>
                <p>每次付费生成都保留；新版本不会覆盖旧片段，可以随时播放比较</p>
              </div>
            </div>
            {versionLibrary.full.length > 0 && (
              <details open>
                <summary>完整视频版本（{versionLibrary.full.length}）</summary>
                <div className="artifact-viewer-grid">
                  {versionLibrary.full.map((item) => (
                    <ArtifactViewer key={item.artifact.id} task={selected.task} artifact={item.artifact} />
                  ))}
                </div>
              </details>
            )}
            {versionLibrary.segments.map((segment) => (
              <details key={segment.segmentNumber}>
                <summary>第 {segment.segmentNumber} 段的全部版本（{segment.items.length}）</summary>
                <div className="artifact-viewer-grid">
                  {segment.items.map((item) => (
                    <ArtifactViewer key={item.artifact.id} task={selected.task} artifact={item.artifact} />
                  ))}
                </div>
              </details>
            ))}
          </section>
        )}
      </section>
      );
    }
  const hasResults =
    projects.length > 0 ||
    completedSocial.length > 0 ||
    completedTalking.length > 0 ||
    xhsJewelryResults.length > 0 ||
    modelAssetProjects.some((project) => modelProjectFinalAsset(project));
  const resultEntries = [
    ...xhsJewelryResults.map((task) => {
      const hasFinalImage = Boolean(task.final_result);
      const imageAdopted = xhsJewelryImageAdopted(task);
      const videoAdopted = xhsJewelryVideoAdopted(task);
      return {
        id: `xhs-jewelry-${task.id}`,
        type: "珠宝种草",
        kind: "image" as const,
        status: imageAdopted ? "formal" as const : "review" as const,
        title: `${task.title} · ${formatShortDate(task.updated_at)}`,
        updatedAt: task.updated_at,
        render: () => (
          <button className="result-project-card" onClick={() => setSelectedXhsJewelryId(task.id)}>
            <div className="result-media-preview xhs-jewelry-preview">
              <Image
                src={`${API}/xhs-jewelry/tasks/${task.id}/${hasFinalImage ? "final-image" : "base-image"}?v=${hasFinalImage ? task.product_attempt_count : task.base_attempt_count}`}
                width={900}
                height={1200}
                unoptimized
                alt={`${task.title}${hasFinalImage ? "珠宝成品图" : "人物视觉底片"}`}
              />
            </div>
            <ResultCardInfo
              type="珠宝种草"
              title={task.title}
              status={imageAdopted ? "成品图已采用" : "图片等你确认"}
              statusTone={imageAdopted ? "done" : "waiting"}
              date={task.updated_at}
              description={imageAdopted ? "成品图已经采用；视频按独立状态继续保留和审核。" : "图片已经返回，需要你决定是否采用。"}
              chips={[
                slotLabelForResult(task.target_slot),
                videoAdopted ? "视频已采用" : task.video_result ? "视频未采用/待确认" : "尚未采用视频",
              ]}
              action="查看图片与视频 →"
            />
          </button>
        ),
      };
    }),
    ...modelAssetProjects
      .filter((project) => modelProjectFinalAsset(project))
      .map((project) => {
        const asset = modelProjectFinalAsset(project);
        return {
          id: `model-${project.id}`,
          type: project.route === "ai_model" ? "AI 模特" : "真人模特",
          kind: "image" as const,
          status: "formal" as const,
          title: `${project.name} · ${formatShortDate(project.updated_at)}`,
          updatedAt: project.updated_at,
          render: () => (
            <button
              className="result-project-card"
              onClick={() => onOpenModel(project.id)}
            >
              <div className="result-media-preview portrait">
                {asset && (
                  <Image
                    src={`${API}/model-assets/projects/${project.id}/assets/${asset.asset_id}/file`}
                    width={800}
                    height={1000}
                    unoptimized
                    alt={`${project.name}正式母版`}
                  />
                )}
              </div>
              <ResultCardInfo
                type={project.route === "ai_model" ? "AI 模特" : "真人模特"}
                title={project.name}
                status="正式母版"
                statusTone="done"
                date={project.updated_at}
                description="已确认的人物母版，可直接带入口播项目，也可继续生成发型、穿搭、场景或氛围版本。"
                chips={[
                  project.default_generation_provider === "chatgpt_web"
                    ? "ChatGPT 网页"
                    : "Codex 内置",
                  `${project.generation_attempt_count} 次生成记录`,
                ]}
                action="查看模特资产 →"
              />
            </button>
          ),
        };
      }),
    ...completedTalking.map((job) => ({
      id: `talking-${job.id}`,
      type: job.state === "voice_review" ? "口播声音" : "口播视频",
      kind: talkingResultMedia(job) === "audio" ? "audio" as const : "video" as const,
      status: job.state === "approved" ? "formal" as const : "review" as const,
      title: `${talkingModeName(job.mode)} · ${talkingDisplayDuration(job)}秒 · ${formatShortDate(job.updated_at || job.created_at || "")}`,
      updatedAt: job.updated_at || job.created_at || "",
      render: () => (
        <button className="result-project-card" onClick={() => setSelectedTalkingId(job.id)}>
          <div className="result-media-preview portrait-media">{talkingResultMedia(job) === "audio" ? <span style={{ display: "block", padding: 16, color: "#f1f5f9" }}>声音待确认 · 点击试听</span> : <video muted preload="metadata" src={`${API}/talking-head/jobs/${job.id}/video`} />}<span className="media-play">▶</span></div>
          <ResultCardInfo
            type={talkingModeName(job.mode)}
            title={`${talkingModeName(job.mode)} · ${job.state === "voice_review" ? "声音待确认" : `${job.state === "sample_review" ? job.sample?.duration || job.duration || 0 : talkingDisplayDuration(job)}秒`}`}
            status={job.state === "approved" ? "可直接使用" : "等你确认"}
            statusTone={job.state === "approved" ? "done" : "waiting"}
            date={job.updated_at || job.created_at || ""}
            description={
              job.state === "approved"
                ? "正式成片已采用，可以直接播放和使用。"
                : job.state === "voice_review"
                  ? "声音已经返回；试听满意后返回项目继续视频。"
                : job.state === "sample_review"
                  ? "样片已经返回；满意后可继续生成完整内容。"
                  : "完整成片已经返回；播放确认后可以直接采用。"
            }
            chips={[job.state === "voice_review" ? "口播声音" : `${job.state === "sample_review" ? job.sample?.duration || job.duration || 0 : talkingDisplayDuration(job)} 秒`]}
            action="播放成果 →"
          />
        </button>
      ),
    })),
    ...completedSocial.map((item) => {
      const files = socialResultFiles(item.result);
      const hasVideo = files.includes("video.mp4");
      const hasCover = files.includes("cover.jpg");
      const mediaOnly = item.extraction_scope === "media_only";
      return {
        id: `social-${item.id}`,
        type: "社媒提取",
        kind: hasVideo ? "video" as const : hasCover ? "image" as const : "text" as const,
        status: "formal" as const,
        title: `${item.result?.author || item.title} · ${formatShortDate(item.updated_at)}`,
        updatedAt: item.updated_at,
        render: () => (
          <button className="result-project-card" onClick={() => setSelectedSocialId(item.id)}>
            <div className="result-media-preview social">
              {hasCover ? <Image src={`${API}/social-extractions/${item.id}/artifacts/${socialArtifactIndex(files, "cover.jpg")}`} width={800} height={450} unoptimized alt="社媒封面" /> : <div className="text-result-cover">文</div>}
            </div>
            <ResultCardInfo type={mediaOnly ? "社媒素材" : "社媒内容"} title={item.result?.author || item.title} status="可直接使用" statusTone="done" date={item.updated_at} description={mediaOnly ? "原视频、封面或图集已经保存。" : item.result?.desc || "发布文案和素材已经整理完成。"} chips={[...(!mediaOnly ? ["发布文案"] : []), ...(hasVideo ? ["原视频"] : []), ...(hasCover ? ["封面"] : [])]} action={mediaOnly ? "查看素材 →" : "查看文案与素材 →"} />
          </button>
        ),
      };
    }),
    ...projects.map(({ task, artifacts }) => {
      const primary = primaryResultArtifact(artifacts);
      const primaryKind = primary ? resultMediaKind(primary) : "text";
      const formal = Boolean(
        primary &&
        /video_generation/.test(primary.stage) &&
        isVideoUserApproved(task),
      );
      const remaining = Math.max(0, artifacts.length - 3);
      return {
        id: `remix-${task.id}`,
        type: "爆款重构",
        kind: primaryKind,
        status: formal ? "formal" as const : "review" as const,
        title: `${task.title} · ${formatShortDate(task.updated_at)}`,
        updatedAt: task.updated_at,
        render: () => (
          <button className="result-project-card" onClick={() => setSelectedProjectId(task.id)}>
            <ResultArtifactPreview task={task} artifact={primary} />
            <ResultCardInfo type="爆款重构" title={task.title} status={formal ? "可直接使用" : "等你确认"} statusTone={formal ? "done" : "waiting"} date={task.updated_at} description={resultSummary(task)} chips={[...artifacts.slice(0, 3).map(userArtifactLabel), ...(remaining ? [`还有 ${remaining} 项资料`] : [])]} action="查看作品与资料 →" />
          </button>
        ),
      };
    }),
  ].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const resultQueryText = resultQuery.trim().toLowerCase();
  const visibleResults = resultEntries.filter((entry) =>
    (resultStatus === "all" || entry.status === resultStatus) &&
    (resultKind === "all" || (resultKind === "xhs" ? entry.type === "珠宝种草" : entry.kind === resultKind)) &&
    (!resultQueryText || `${entry.title} ${entry.type}`.toLowerCase().includes(resultQueryText)),
  );
  const resultCounts = {
    all: resultEntries.length,
    formal: resultEntries.filter((entry) => entry.status === "formal").length,
    review: resultEntries.filter((entry) => entry.status === "review").length,
  };
  const resultGroups = [
    {
      key: "review",
      title: "待你确认",
      description: "先处理这些，确认后会自动进入正式成果。",
      entries: visibleResults.filter((entry) => entry.status === "review"),
    },
    {
      key: "formal",
      title: "正式成果",
      description: "已经采用，可以直接查看、播放或继续用于其他项目。",
      entries: visibleResults.filter((entry) => entry.status === "formal"),
    },
  ].filter((group) => group.entries.length > 0);
  return (
    <section className="subpage results-library-page">
      <div className="subpage-title results-library-title">
        <div>
          <span>你的作品库</span>
          <h1>成果中心</h1>
          <p>先处理需要你确认的内容，再查看已经采用的作品和素材。</p>
        </div>
      </div>
      {hasResults ? (
        <>
          <div className="result-status-overview" aria-label="成果状态筛选">
            <button aria-label="全部" className={resultStatus === "all" ? "active" : ""} onClick={() => setResultStatus("all")}>
              <span>全部成果</span><strong>{resultCounts.all}</strong><small>查看所有已返回内容</small>
            </button>
            <button aria-label="待确认" className={resultStatus === "review" ? "active waiting" : "waiting"} onClick={() => setResultStatus("review")}>
              <span>待你确认</span><strong>{resultCounts.review}</strong><small>{resultCounts.review ? "需要你决定是否采用" : "当前没有待处理内容"}</small>
            </button>
            <button aria-label="正式成果" className={resultStatus === "formal" ? "active done" : "done"} onClick={() => setResultStatus("formal")}>
              <span>可直接使用</span><strong>{resultCounts.formal}</strong><small>已经采用的正式成果</small>
            </button>
          </div>
          <div className="result-library-tools">
            <label>
              <span>搜索</span>
              <input aria-label="搜索成果" value={resultQuery} onChange={(event) => setResultQuery(event.target.value)} placeholder="输入项目名或成果类型" />
            </label>
            <label>
              <span>成果类型</span>
              <select aria-label="成果类型" value={resultKind} onChange={(event) => setResultKind(event.target.value as typeof resultKind)}><option value="all">全部类型</option><option value="xhs">珠宝种草</option><option value="video">视频成片</option><option value="audio">口播声音</option><option value="image">模特与图片</option><option value="text">文案与资料</option></select>
            </label>
          </div>
          {visibleResults.length === 0 ? <div className="task-search-empty result-search-empty"><strong>没有找到符合条件的成果</strong><span>可以换个关键词或查看全部成果。</span><button type="button" onClick={() => { setResultQuery(""); setResultKind("all"); setResultStatus("all"); }}>清除筛选</button></div> : resultGroups.map((group) => (
            <section className={`result-date-group ${group.key}`} key={group.key}>
              <div className="result-group-heading"><div><h2>{group.title}</h2><p>{group.description}</p></div><span>{group.entries.length} 个项目</span></div>
              <div className="result-project-grid">{group.entries.map((entry) => <div key={entry.id}>{entry.render()}</div>)}</div>
            </section>
          ))}
        </>
      ) : (
        <div className="results-empty">
          <span>◇</span>
          <h3>还没有可用成果</h3>
          <p>人物、分镜、社媒素材或视频完成后，会按项目显示在这里。</p>
        </div>
      )}
    </section>
  );
}

function ArtifactViewer({
  task,
  artifact,
}: {
  task: Task;
  artifact: Artifact;
}) {
  const source = `${API}/tasks/${task.id}/artifacts/${artifact.id}?v=${encodeURIComponent(task.runtime_generation?.status || task.updated_at)}`;
  const extension = artifact.path.split(".").pop()?.toLowerCase() || "";
  const imageFile = ["png", "jpg", "jpeg", "webp", "gif"].includes(extension);
  const videoFile = ["mp4", "webm", "mov"].includes(extension);
  const textFile = ["md", "txt", "json"].includes(extension);
  const pdfFile = extension === "pdf";
  const [previewFailed, setPreviewFailed] = useState(false);
  return (
    <article className="artifact-viewer">
      <div className="artifact-viewer-title">
        <div>
          <small>
            {artifact.stage === "person_package" ? "人物资产" : "项目成果"}
          </small>
          <h3>{userArtifactLabel(artifact)}</h3>
        </div>
        <a href={source} target="_blank" rel="noreferrer">
          单独打开 ↗
        </a>
      </div>
      {previewFailed ? (
        <ArtifactPreviewFailure source={source} />
      ) : imageFile ? (
        <Image
          src={source}
          width={1200}
          height={900}
          unoptimized
          alt={userArtifactLabel(artifact)}
          onError={() => setPreviewFailed(true)}
        />
      ) : videoFile ? (
        // 成果预览使用用户生成的原视频，工作台没有独立字幕轨可绑定。
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={source}
          controls
          preload="metadata"
          onError={(event) => {
            console.error(
              "artifact video preview failed",
              event.currentTarget.error?.code,
              event.currentTarget.error?.message,
            );
            setPreviewFailed(true);
          }}
        />
      ) : textFile ? (
        <TextArtifactPreview
          source={source}
          onError={() => setPreviewFailed(true)}
        />
      ) : pdfFile ? (
        <iframe
          src={source}
          title={userArtifactLabel(artifact)}
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <ArtifactPreviewFailure
          source={source}
          message="当前格式暂不支持在成果中心直接预览。"
        />
      )}
    </article>
  );
}

function ResultCardInfo({
  type,
  title,
  status,
  statusTone,
  date,
  description,
  chips,
  action,
}: {
  type: string;
  title: string;
  status: string;
  statusTone: string;
  date: string;
  description: string;
  chips: string[];
  action: string;
}) {
  return (
    <div className="result-card-info">
      <div className="result-project-top">
        <div>
          <small>{type} · 更新于 {formatTime(date)}</small>
          <h3>{title}</h3>
        </div>
        <span className={`status ${statusTone}`}><i></i>{status}</span>
      </div>
      <p>{description}</p>
      <div className="result-chip-list">
        {chips.map((chip) => <span key={chip}>{chip}</span>)}
      </div>
      <div className="result-project-action"><span>{formatShortDate(date)}</span><strong>{action}</strong></div>
    </div>
  );
}

function ResultArtifactPreview({
  task,
  artifact,
}: {
  task: Task;
  artifact: Artifact | null;
}) {
  if (!artifact)
    return <div className="result-media-preview"><div className="text-result-cover">资</div></div>;
  const source = `${API}/tasks/${task.id}/artifacts/${artifact.id}`;
  const kind = resultMediaKind(artifact);
  if (kind === "video")
    return <div className="result-media-preview"><video muted preload="metadata" src={source} /><span className="media-play">▶</span></div>;
  if (kind === "image")
    return <div className="result-media-preview"><Image src={source} width={900} height={520} unoptimized alt={userArtifactLabel(artifact)} /></div>;
  return <div className="result-media-preview"><div className="text-result-cover">资</div><span className="text-result-label">{userArtifactLabel(artifact)}</span></div>;
}

function TextArtifactPreview({
  source,
  onError,
}: {
  source: string;
  onError: () => void;
}) {
  const [content, setContent] = useState("正在读取成果…");
  useEffect(() => {
    const controller = new AbortController();
    fetch(source, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("preview unavailable");
        return response.text();
      })
      .then(setContent)
      .catch((error) => {
        if (error?.name !== "AbortError") onError();
      });
    return () => controller.abort();
  }, [source, onError]);
  return <pre className="artifact-text-preview">{content}</pre>;
}

function ArtifactPreviewFailure({
  source,
  message = "预览暂时没有打开，原文件仍然保留。",
}: {
  source: string;
  message?: string;
}) {
  return (
    <div className="artifact-preview-failure">
      <span>!</span>
      <strong>{message}</strong>
      <p>可以刷新后再试，或单独打开本地成果。</p>
      <a href={source} target="_blank" rel="noreferrer">
        单独打开成果 ↗
      </a>
    </div>
  );
}

function CreateTaskModal({
  loading,
  providerCapabilities,
  socialExtractions,
  onClose,
  onCreated,
}: {
  loading: boolean;
  providerCapabilities: ProviderCapabilities;
  socialExtractions: SocialExtraction[];
  onClose: () => void;
  onCreated: (form: FormData) => void;
}) {
  const [referenceName, setReferenceName] = useState("");
  const [selectedSocialId, setSelectedSocialId] = useState<string | null>(null);
  const [remixRoute, setRemixRoute] = useState<RemixPrecisionRoute>(
    "anchor_frame_alignment",
  );
  const [rewriteMode, setRewriteMode] = useState<
    NonNullable<Task["rewrite_mode"]>
  >("keep_original_style");
  const [productScope, setProductScope] = useState<
    "full_look" | "top_only" | "bottom_only" | "custom"
  >("custom");
  const [personRoute, setPersonRoute] =
    useState<NonNullable<Task["person_route"]>>("auto_ai_person");
  const [sceneRoute, setSceneRoute] = useState<SceneRoute>("source_like");
  const [scriptRoute, setScriptRoute] =
    useState<ScriptRoute>("keep_structure");
  const [defaultVideoProvider, setDefaultVideoProvider] = useState<
    VideoGenerationSelection["generationProvider"]
  >("runninghub_h3_multiref");
  const [defaultVideoQuality, setDefaultVideoQuality] = useState<
    VideoGenerationSelection["qualityProfile"]
  >("high");
  const [defaultGenerationRoute, setDefaultGenerationRoute] = useState<
    VideoGenerationSelection["generationRouteChoice"]
  >("smoke_test_first");
  const [defaultVideoModel, setDefaultVideoModel] = useState("star-video2-fast");
  const [uploadAuthorized, setUploadAuthorized] = useState(false);
  const [personAuthorization, setPersonAuthorization] = useState(false);
  const [personImageName, setPersonImageName] = useState("");
  const [productBriefValue, setProductBriefValue] = useState("");
  const [productImageCount, setProductImageCount] = useState(0);
  const [sceneImageCount, setSceneImageCount] = useState(0);
  const reusableSocialVideos = socialExtractions.filter(
    (item) => item.status === "completed" && socialResultFiles(item.result).includes("video.mp4"),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (selectedSocialId && !(form.get("referenceVideo") instanceof File && (form.get("referenceVideo") as File).size > 0)) {
      const extraction = socialExtractions.find((item) => item.id === selectedSocialId);
      const files = socialResultFiles(extraction?.result);
      const index = socialArtifactIndex(files, "video.mp4");
      const response = await fetch(`${API}/social-extractions/${selectedSocialId}/artifacts/${index}`);
      if (!response.ok) throw new Error("刚提取的原视频当前无法读取，请重新提取或从本机选择。");
      form.set("referenceVideo", new File([await response.blob()], "video.mp4", { type: "video/mp4" }));
    }
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const startImmediately = submitter?.value !== "save_only";
    form.set("managedMode", String(startImmediately));
    form.set("plannedExecutionAuthorized", String(startImmediately));
    form.set(
      "setupUploadAuthorized",
      String(startImmediately && uploadAuthorized),
    );
    form.set("sceneRoute", sceneRoute);
    form.set("scriptRoute", scriptRoute);
    onCreated(form);
  }
  const hasRequiredPersonInput =
    personRoute !== "authorized_person" ||
    (personAuthorization && Boolean(personImageName));
  const hasRequiredProductInput =
    rewriteMode !== "replace_product" ||
    Boolean(productBriefValue.trim()) ||
    productImageCount > 0;
  const canSave =
    Boolean(referenceName) &&
    hasRequiredPersonInput &&
    hasRequiredProductInput &&
    (sceneRoute !== "user_location" || sceneImageCount > 0);
  const canStart =
    referenceName &&
    uploadAuthorized &&
    hasRequiredPersonInput &&
    hasRequiredProductInput &&
    (sceneRoute !== "user_location" || sceneImageCount > 0);
  return (
    <div className="drawer-layer">
      <button
        className="drawer-backdrop"
        onClick={onClose}
        aria-label="关闭"
      ></button>
      <form
        className="task-drawer create-drawer setup-drawer"
        onSubmit={submit}
      >
        <input type="hidden" name="remixPrecisionRoute" value={remixRoute} />
        <input type="hidden" name="rewriteMode" value={rewriteMode} />
        <input type="hidden" name="productScope" value={productScope} />
        <input type="hidden" name="personRoute" value={personRoute} />
        <input type="hidden" name="generationProvider" value={defaultVideoProvider} />
        <input type="hidden" name="generationQualityProfile" value={defaultVideoQuality} />
        <input type="hidden" name="generationRouteChoice" value={defaultGenerationRoute} />
        <input type="hidden" name="generationModelKey" value={defaultVideoModel} />
        <input
          type="hidden"
          name="personAuthorizationConfirmed"
          value={String(personAuthorization)}
        />
        <div className="drawer-head">
          <div className="workflow-icon orange">影</div>
          <div>
            <small>一次选好 · 接着往下做</small>
            <h2>建立爆款重构项目</h2>
          </div>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="drawer-body">
          <div className="scope-strip">
            <strong>把要改的内容一次选好</strong>
            <span>
              没有选择修改的部分，默认沿用参考片的结构与作用；系统会自动安排后续步骤
            </span>
          </div>
          <div className="form-stack">
            <label>
              <span>项目名称</span>
              <input
                name="title"
                required
                maxLength={100}
                placeholder="例如：穿搭视频复刻"
              />
            </label>
            <label className="upload-box selected-upload">
              <input
                name="referenceVideo"
                type="file"
                accept="video/*,.mp4,.mov,.m4v,.webm"
                required={!selectedSocialId}
                onChange={(event) => {
                  setSelectedSocialId(null);
                  setReferenceName(event.target.files?.[0]?.name || "");
                }}
              />
              <span className="upload-symbol">＋</span>
              <strong>{referenceName || "添加一条参考视频"}</strong>
              <small>
                {referenceName
                  ? "已保存在本机，提交后按下方范围开始拆解"
                  : "支持 MP4、MOV、WebM，单次不超过 250MB"}
              </small>
            </label>
            {reusableSocialVideos.length > 0 && (
              <div className="scope-strip">
                <strong>也可以直接使用刚提取的视频</strong>
                <span>不需要再打开文件夹或重复选择本地文件</span>
                <div className="route-options compact-options">
                  {reusableSocialVideos.slice(0, 3).map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={selectedSocialId === item.id ? "selected" : ""}
                      onClick={() => {
                        setSelectedSocialId(item.id);
                        setReferenceName(`${item.result?.author || "社媒素材"} · video.mp4`);
                      }}
                    >
                      <strong>{item.result?.author || item.title}</strong>
                      <span>{formatShortDate(item.updated_at)} · 使用已保存原视频</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <fieldset className="setup-field change-contract-field">
              <legend>这次准备怎么改</legend>
              <div className="change-section">
                <div className="change-section-head">
                  <strong>人物</strong>
                  <span>选择成片中由谁出镜</span>
                </div>
                <div className="route-options compact-options">
                  <button type="button" className={personRoute === "auto_ai_person" ? "selected" : ""} onClick={() => setPersonRoute("auto_ai_person")}>
                    <strong>AI 创建新人物（推荐）</strong>
                    <span>先确认人物形象，再继续制作</span>
                  </button>
                  <button type="button" className={personRoute === "authorized_person" ? "selected" : ""} onClick={() => setPersonRoute("authorized_person")}>
                    <strong>本人 / 已授权人物</strong>
                    <span>使用你提供的清晰人物照片</span>
                  </button>
                  <button type="button" className={personRoute === "generic_no_fixed_face" ? "selected" : ""} onClick={() => setPersonRoute("generic_no_fixed_face")}>
                    <strong>不固定人物</strong>
                    <span>更快，但跨片段一致性较弱</span>
                  </button>
                </div>
              </div>
              <div className="change-section">
                <div className="change-section-head">
                  <strong>产品</strong>
                  <span>只替换你明确提供的内容</span>
                </div>
                <div className="route-options compact-options">
                  <button type="button" className={rewriteMode === "keep_original_style" ? "selected" : ""} onClick={() => setRewriteMode("keep_original_style")}>
                    <strong>不换产品</strong>
                    <span>沿用参考片中的产品角色，不填写新产品资料</span>
                  </button>
                  <button type="button" className={rewriteMode === "replace_product" ? "selected" : ""} onClick={() => setRewriteMode("replace_product")}>
                    <strong>换成我的产品</strong>
                    <span>使用本次上传的真实产品资料</span>
                  </button>
                </div>
              </div>
              <div className="change-section">
                <div className="change-section-head">
                  <strong>场景</strong>
                  <span>选择空间和环境怎么处理</span>
                </div>
                <div className="route-options compact-options">
                  <button type="button" className={sceneRoute === "source_like" ? "selected" : ""} onClick={() => setSceneRoute("source_like")}>
                    <strong>保留相近场景</strong>
                    <span>保留空间类型，不照搬店招和隐私细节</span>
                  </button>
                  <button type="button" className={sceneRoute === "auto_match" ? "selected" : ""} onClick={() => setSceneRoute("auto_match")}>
                    <strong>由 AI 自动匹配</strong>
                    <span>根据产品和参考片选择合适环境</span>
                  </button>
                  <button type="button" className={sceneRoute === "user_location" ? "selected" : ""} onClick={() => setSceneRoute("user_location")}>
                    <strong>使用我的店铺或场地</strong>
                    <span>上传空间照片作为场景依据</span>
                  </button>
                  <button type="button" className={sceneRoute === "described_scene" ? "selected" : ""} onClick={() => setSceneRoute("described_scene")}>
                    <strong>换成指定场景</strong>
                    <span>用一句话说明想换到哪里</span>
                  </button>
                </div>
              </div>
              <div className="change-section">
                <div className="change-section-head">
                  <strong>内容脚本</strong>
                  <span>决定原片内容需要改到什么程度</span>
                </div>
                <div className="route-options compact-options">
                  <button type="button" className={scriptRoute === "keep_structure" ? "selected" : ""} onClick={() => setScriptRoute("keep_structure")}>
                    <strong>保留原结构</strong>
                    <span>沿用内容作用和节奏，不新增台词</span>
                  </button>
                  <button type="button" className={scriptRoute === "auto_rewrite" ? "selected" : ""} onClick={() => setScriptRoute("auto_rewrite")}>
                    <strong>按我的资料自动改写</strong>
                    <span>保留爆点结构，替换成我的卖点</span>
                  </button>
                  <button type="button" className={scriptRoute === "partial_adjustment" ? "selected" : ""} onClick={() => setScriptRoute("partial_adjustment")}>
                    <strong>只修改指定部分</strong>
                    <span>说明哪些保留、哪些需要调整</span>
                  </button>
                  <button type="button" className={scriptRoute === "use_own_copy" ? "selected" : ""} onClick={() => setScriptRoute("use_own_copy")}>
                    <strong>使用我写好的内容</strong>
                    <span>已有台词、旁白或完整脚本，AI 不再改写</span>
                  </button>
                </div>
              </div>
            </fieldset>
            <fieldset className="setup-field preference-field">
              <legend>制作偏好</legend>
              <div className="route-options">
                <button
                  type="button"
                  className={
                    remixRoute === "anchor_frame_alignment" ? "selected" : ""
                  }
                  onClick={() => setRemixRoute("anchor_frame_alignment")}
                >
                  <strong>尽量像原片（推荐）</strong>
                  <span>
                    保留镜头、动作和节奏关系，画面更稳，制作时间相对较长
                  </span>
                </button>
                <button
                  type="button"
                  className={
                    remixRoute === "prompt_driven_remix" ? "selected" : ""
                  }
                  onClick={() => setRemixRoute("prompt_driven_remix")}
                >
                  <strong>只借思路快速生成</strong>
                  <span>
                    保留内容结构和节奏，允许画面明显变化，速度更快
                  </span>
                </button>
              </div>
            </fieldset>
            {rewriteMode === "replace_product" && (
              <>
                <label>
                  <span>新产品真实资料（可选）</span>
                  <textarea
                    name="productBrief"
                    value={productBriefValue}
                    onChange={(event) => setProductBriefValue(event.target.value)}
                    placeholder="产品名称、规格、真实卖点、价格/活动；没有资料可以只上传产品图"
                  ></textarea>
                </label>
                <fieldset className="setup-field">
                  <legend>图片里需要替换什么</legend>
                  <div className="route-options compact-options">
                    <button type="button" className={productScope === "custom" ? "selected" : ""} onClick={() => setProductScope("custom")}>
                      <strong>单个或其他产品</strong>
                      <span>按产品资料和图片识别需要替换的主体</span>
                    </button>
                    <button type="button" className={productScope === "full_look" ? "selected" : ""} onClick={() => setProductScope("full_look")}>
                      <strong>整套穿搭</strong>
                      <span>上衣和下装都要完整保留</span>
                    </button>
                    <button type="button" className={productScope === "top_only" ? "selected" : ""} onClick={() => setProductScope("top_only")}>
                      <strong>只换上衣</strong>
                      <span>下装只是搭配，不作为产品</span>
                    </button>
                    <button type="button" className={productScope === "bottom_only" ? "selected" : ""} onClick={() => setProductScope("bottom_only")}>
                      <strong>只换下装</strong>
                      <span>上衣只是搭配，不作为产品</span>
                    </button>
                  </div>
                  <small>普通商品选第一项；服装类再按实际范围选择。后续局部裁图只补细节，不会替代完整产品。</small>
                </fieldset>
                <label>
                  <span>新产品图片（与文字资料至少填一项）</span>
                  <input
                    className="file-input"
                    name="productImages"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => setProductImageCount(event.target.files?.length || 0)}
                  />
                  <small>
                    {productImageCount > 0
                      ? `已选择 ${productImageCount} 张产品图`
                      : "请填写上面的产品资料，或至少上传 1 张清晰产品图。"}
                  </small>
                </label>
              </>
            )}
            <label>
              <span>人物要求（可选）</span>
              <textarea
                name="personBrief"
                maxLength={2000}
                placeholder="例如：25～30 岁、自然素人感、长卷发、手机随拍质感"
              ></textarea>
            </label>
            {personRoute === "authorized_person" && (
              <>
                <label>
                  <span>人物母版照片</span>
                  <input className="file-input" name="personImages" type="file" accept="image/*" onChange={(event) => setPersonImageName(event.target.files?.[0]?.name || "")} />
                  <small>{personImageName ? `已选择：${personImageName}` : "建议正脸、清晰、无遮挡；只上传 1 张，产品图里的模特不会作为人物身份。"}</small>
                </label>
                <label className="check-line consent-box">
                  <input
                    type="checkbox"
                    checked={personAuthorization}
                    onChange={(event) =>
                      setPersonAuthorization(event.target.checked)
                    }
                  />
                  <span>我确认这是本人照片，或已取得该人物授权；仅用于当前项目的人物一致性。</span>
                </label>
              </>
            )}
            {sceneRoute === "user_location" && (
              <label>
                <span>店铺或场地照片</span>
                <input
                  className="file-input"
                  name="sceneImages"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => setSceneImageCount(event.target.files?.length || 0)}
                />
                <small>
                  {sceneImageCount > 0
                    ? `已选择 ${sceneImageCount} 张场景图；只用于本项目场景依据。`
                    : "建议上传正面、主要空间和关键区域；系统只把它们作为本项目场景依据。"}
                </small>
              </label>
            )}
            {(sceneRoute === "described_scene" || sceneRoute === "auto_match") && (
              <label>
                <span>{sceneRoute === "described_scene" ? "新场景要求" : "场景偏好（可选）"}</span>
                <textarea
                  name="sceneBrief"
                  required={sceneRoute === "described_scene"}
                  maxLength={2000}
                  placeholder={sceneRoute === "described_scene" ? "例如：江南园林回廊，早春阴天，自然手机随拍" : "例如：更生活化，不要棚拍和样板间"}
                ></textarea>
              </label>
            )}
            {scriptRoute !== "keep_structure" && (
              <label>
                <span>{scriptRoute === "use_own_copy" ? "粘贴台词、旁白或完整脚本" : "内容修改要求"}</span>
                <textarea
                  name="scriptBrief"
                  required={scriptRoute === "partial_adjustment" || scriptRoute === "use_own_copy"}
                  maxLength={8000}
                  placeholder={scriptRoute === "partial_adjustment" ? "例如：保留开头和结尾，中间改成新品面料与版型介绍" : scriptRoute === "use_own_copy" ? "粘贴准备使用的完整文案" : "填写产品、服务或内容希望突出什么；已有产品资料可不重复"}
                ></textarea>
              </label>
            )}
            <label>
              <span>默认在哪里生图</span>
              <select
                name="defaultImageGenerationProvider"
                defaultValue={providerCapabilities.codexBuiltinAvailable ? "codex_builtin" : "chatgpt_web"}
              >
                <option value="codex_builtin" disabled={!providerCapabilities.codexBuiltinAvailable}>Codex 内置生图{providerCapabilities.codexBuiltinAvailable ? "（已就绪）" : "（当前未接通）"}</option>
                <option value="chatgpt_web">ChatGPT 网页生图（实验）</option>
              </select>
            </label>
            <fieldset className="setup-field">
              <legend>生成方式</legend>
              <div className="route-options compact-options">
                <button
                  type="button"
                  className={defaultGenerationRoute === "smoke_test_first" ? "selected" : ""}
                  onClick={() => setDefaultGenerationRoute("smoke_test_first")}
                >
                  <strong>先做样片（推荐）</strong>
                  <span>先生成约 4 秒，满意后再做完整视频</span>
                </button>
                <button
                  type="button"
                  className={defaultGenerationRoute === "in_chat_libtv_generation" ? "selected" : ""}
                  onClick={() => setDefaultGenerationRoute("in_chat_libtv_generation")}
                >
                  <strong>直接生成完整视频</strong>
                  <span>跳过样片，按必要分段直接生成；每段只提交 1 次</span>
                </button>
              </div>
            </fieldset>
            <fieldset className="setup-field">
              <legend>默认从哪里生成视频</legend>
              <div className="route-options">
                <button
                  type="button"
                  className={defaultVideoProvider === "libtv" ? "selected" : ""}
                  onClick={() => setDefaultVideoProvider("libtv")}
                >
                  <strong>LibTV / Seedance（推荐）</strong>
                  <span>正式路线；固定人物脸自动准备红线安全版与局部材质图</span>
                </button>
                <button
                  type="button"
                  className={defaultVideoProvider === "runninghub_h3_multiref" ? "selected" : ""}
                  onClick={() => setDefaultVideoProvider("runninghub_h3_multiref")}
                >
                  <strong>RunningHub H3（实验）</strong>
                  <span>使用清晰人物、分镜与材质参考，不准备红线或网格图</span>
                </button>
              </div>
            </fieldset>
            {defaultVideoProvider === "libtv" && (
              <label>
                <span>Seedance 模型</span>
                <select
                  value={defaultVideoModel}
                  onChange={(event) => setDefaultVideoModel(event.target.value)}
                >
                  <option value="star-video2-mini">Seedance 2.0 Mini</option>
                  <option value="star-video2-fast">Seedance 2.0 Fast（推荐）</option>
                  <option value="star-video2">Seedance 2.0</option>
                  <option value="star-video2.5">Seedance 2.5</option>
                </select>
              </label>
            )}
            <fieldset className="setup-field">
              <legend>默认画面清晰度</legend>
              <div className="route-options compact-options">
                {(["normal", "high", "ultra"] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={defaultVideoQuality === value ? "selected" : ""}
                    onClick={() => setDefaultVideoQuality(value)}
                  >
                    <strong>{value === "normal" ? "普通" : value === "high" ? "高清（推荐）" : "超清"}</strong>
                    <span>{value === "normal" ? "人物靠近镜头" : value === "high" ? "半身露手等日常画面" : "人物较远或细节要求高"}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="safe-note compact-cost-note">
              <span>¥</span>
              <p>
                <strong>参考片拆解会自动完成。</strong>
                无需设置费用上限；系统保留异常费用保护，完成后显示本次实际费用。
              </p>
            </div>
            <label className="check-line consent-box">
              <input
                type="checkbox"
                checked={uploadAuthorized}
                onChange={(event) => setUploadAuthorized(event.target.checked)}
              />
              <span>
                我同意把本次参考视频上传到豆包做语义拆解，并允许本项目使用创建页已上传的产品图、已授权人物图、场景图及从参考片产生的必要参考图；点击“保存并开始制作”后，样片路线只提交 1 次，直接正片最多按 5 个必要分段各提交 1 次，不自动重试。
              </span>
            </label>
          </div>
          <div className="safe-note">
            <span>✓</span>
            <p>
              <strong>你可以先保存，也可以立即开始。</strong>
              “只保存项目”不会上传或调用模型；“保存并开始制作”会按已选路线连续执行，中间技术检查不再反复打断，最终成片返回后由你决定采用或返工。
            </p>
          </div>
        </div>
        <div className="drawer-footer">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            name="creationMode"
            value="save_only"
            className="secondary"
            disabled={loading || !canSave}
          >
            {loading ? "正在保存…" : "只保存项目"}
          </button>
          <button
            type="submit"
            name="creationMode"
            value="start_now"
            className="primary"
            disabled={loading || !canStart}
          >
            {loading ? "正在启动…" : "保存并开始制作"}
            <span>→</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function TaskDrawer({
  task,
  providerCapabilities,
  videoModels,
  loading,
  onClose,
  onStart,
  onResume,
  onSkipRewrite,
  onRewrite,
  onSaveOnly,
  onSetDefaultProvider,
  onBindCodexTask,
  onConfirmRuntimeGeneration,
  onRetryRuntimeGenerationWithPlus,
  onPreparePerson,
  onUploadAuthorizedPerson,
  onGeneratePerson,
  onApprovePerson,
  onPrepareProductAssets,
  onSetProductScope,
  onPrepareStoryboard,
  onGenerateStoryboard,
  onApproveStoryboard,
  onStartMotionPreflight,
  onStartVideoPrompt,
  onResolveVideoPrompt,
  onStartVideoGeneration,
  onRebuildGenerationPack,
  onGeneratePersonPackage,
  onApprovePersonPackage,
  onGenerateVideo,
  onApproveVideoResult,
  onPrepareVideoRework,
  onConfirmVideoRework,
  onValidateContractRepairFullVideo,
  onPrepareFullVideo,
  onResumeVideo,
}: {
  task: Task;
  providerCapabilities: ProviderCapabilities;
  videoModels: VideoModelOption[];
  loading: boolean;
  onClose: () => void;
  onStart: () => void;
  onResume: () => void;
  onSkipRewrite: () => void;
  onRewrite: (form: FormData) => void;
  onSaveOnly: () => void;
  onSetDefaultProvider: (provider: GenerationProvider) => void;
  onBindCodexTask: (intent?: "prepare_video_rework" | "prepare_full_video" | "execute_project") => void;
  onConfirmRuntimeGeneration: () => void;
  onRetryRuntimeGenerationWithPlus: () => void;
  onPreparePerson: (body: object) => void;
  onUploadAuthorizedPerson: (form: FormData) => void;
  onGeneratePerson: (provider: GenerationProvider) => void;
  onApprovePerson: () => void;
  onPrepareProductAssets: () => void;
  onApproveProductAssets: () => void;
  onSetProductScope: (scope: "full_look" | "top_only" | "bottom_only" | "custom") => void;
  onPrepareStoryboard: (brief: string) => void;
  onGenerateStoryboard: (provider: GenerationProvider, resumeIncomplete?: boolean) => void;
  onApproveStoryboard: () => void;
  onStartMotionPreflight: () => void;
  onStartVideoPrompt: (selection?: VideoGenerationSelection) => void;
  onResolveVideoPrompt: (
    resolution: "preserve_source_content" | "use_own_copy",
    text: string,
  ) => void;
  onStartVideoGeneration: (selection: VideoGenerationSelection) => void;
  onRebuildGenerationPack: (selection: VideoGenerationSelection) => void;
  onGeneratePersonPackage: (provider: GenerationProvider) => void;
  onApprovePersonPackage: () => void;
  onGenerateVideo: () => void;
  onApproveVideoResult: () => void;
  onPrepareVideoRework: (body: {
    selectedSegmentIds: string[];
    issueCodes: string[];
    note: string;
  }) => void;
  onConfirmVideoRework: (selectedSegmentIds: string[]) => void;
  onRevalidateFullVideoQuality: () => void;
  onValidateContractRepairFullVideo: () => void;
  onPrepareFullVideo: () => void;
  onResumeVideo: () => void;
}) {
  const [rewriteMode, setRewriteMode] = useState<
    "replace_product" | "exact_original" | null
  >(null);
  const [productScope, setProductScope] = useState<
    "full_look" | "top_only" | "bottom_only" | "custom"
  >(task.product_scope === "unspecified" ? "full_look" : task.product_scope);
  const [continueOpen, setContinueOpen] = useState(false);
  const [personRoute, setPersonRoute] = useState<Task["person_route"]>(
    task.person_route,
  );
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(
    task.person_authorization_confirmed,
  );
  const [personBrief, setPersonBrief] = useState(task.person_brief || "");
  const [sourceUploadConfirmed, setSourceUploadConfirmed] = useState(false);
  const [authorizedPersonFileName, setAuthorizedPersonFileName] = useState("");
  const [authorizedPersonUploadConfirmed, setAuthorizedPersonUploadConfirmed] = useState(false);
  const [generationProvider, setGenerationProvider] =
    useState<GenerationProvider>(
      task.person_generation_provider ||
        task.default_image_generation_provider ||
        "codex_builtin",
    );
  const [storyboardBrief, setStoryboardBrief] = useState(
    task.storyboard_brief || "",
  );
  const [storyboardUploadConfirmed, setStoryboardUploadConfirmed] =
    useState(false);
  const [storyboardGenerationProvider, setStoryboardGenerationProvider] =
    useState<GenerationProvider>(
      task.storyboard_generation_provider ||
        task.default_image_generation_provider ||
        "codex_builtin",
    );
  const [personPackageUploadConfirmed, setPersonPackageUploadConfirmed] =
    useState(false);
  const [personPackageProvider, setPersonPackageProvider] =
    useState<GenerationProvider>(
      task.person_package_generation_provider ||
        task.default_image_generation_provider ||
        "codex_builtin",
    );
  const [packagePreview, setPackagePreview] = useState<Artifact | null>(null);
  const [storyboardPreview, setStoryboardPreview] = useState<Artifact | null>(null);
  const [personPreview, setPersonPreview] = useState<Artifact | null>(null);
  const [generationRouteChoice, setGenerationRouteChoice] = useState<
    VideoGenerationSelection["generationRouteChoice"]
  >(
    task.generation_route_choice === "in_chat_libtv_generation"
      ? "in_chat_libtv_generation"
      : "smoke_test_first",
  );
  const [generationModelKey, setGenerationModelKey] = useState(
    task.generation_model_key ||
      task.generation_pack_result?.submission_preview?.model_key ||
      "star-video2",
  );
  const [videoGenerationProvider, setVideoGenerationProvider] = useState<
    VideoGenerationSelection["generationProvider"]
  >(task.generation_provider || "libtv");
  const [videoQualityProfile, setVideoQualityProfile] = useState<
    VideoGenerationSelection["qualityProfile"]
  >(task.generation_quality_profile || "high");
  const videoGenerationSelection: VideoGenerationSelection = {
    generationRouteChoice,
    generationModelKey,
    generationProvider: videoGenerationProvider,
    qualityProfile: videoQualityProfile,
  };
  const generationPreview = task.generation_pack_result?.submission_preview;
  const generationPackNeedsFourSecondRepair =
    task.generation_route_choice === "smoke_test_first" &&
    generationPreview?.duration_seconds !== 4;
  const preparingAuthorizedFull =
    generationPreview?.generation_kind === "full_sequence" &&
    task.full_video_generation_authorized;
  const selectedVideoModelAvailable =
    videoGenerationProvider === "runninghub_h3_multiref" ||
    videoModels.some((model) => model.model_key === generationModelKey);
  const personPackageCheckpoint =
    task.person_package_result?.checkpoint_resume_available === true;
  const preservedPersonPackageCount = personPackageCheckpoint
    ? task.person_package_result?.artifacts?.length || 0
    : 0;
  const missingPersonPackageCount = personPackageCheckpoint
    ? task.person_package_result?.missing_assets?.length || 1
    : 0;
  const personPackageNeedsRework =
    task.person_package_result?.business_qc_status === "needs_rework" ||
    task.person_package_result?.business_qc_status === "blocked";
  const videoQcRejected = isVideoQcRejected(task);
  const videoUserApproved = isVideoUserApproved(task);
  const currentFullVideoResult = videoVersionLibrary(task).full[0]?.artifact;
  const currentFullVideoArtifact = task.artifacts.find(
    (artifact) => artifact.path === currentFullVideoResult?.path,
  );
  const runtimeVideoArtifacts = [...task.artifacts]
    .reverse()
    .filter(
      (artifact) =>
        artifact.stage === "video_generation" &&
        /\.(mp4|webm|mov)$/i.test(artifact.path || ""),
    );
  const runtimeVideoArtifact =
    runtimeVideoArtifacts.find((artifact) =>
      /^(?:版本\s*\d+\s*)?正式视频$/.test(artifact.label || ""),
    ) || runtimeVideoArtifacts[0];
  const existingSampleArtifact = [...task.artifacts]
    .reverse()
    .find(
      (artifact) =>
        artifact.stage === "video_generation" &&
        /smoke|sample|小样/i.test(`${artifact.path || ""} ${artifact.label || ""}`) &&
        /\.(mp4|webm|mov)$/i.test(artifact.path || ""),
    );
  const runtimeResultIsSample = Boolean(
    task.runtime_generation?.status === "generation_completed" &&
      runtimeVideoArtifact &&
      /smoke|sample|小样/i.test(
        `${runtimeVideoArtifact.path || ""} ${runtimeVideoArtifact.label || ""}`,
      ),
  );
  const codexTaskState = task.codex_progress?.task_state || "";
  const fullVideoPreparationStarted =
    codexTaskState.includes("full_sequence") ||
    codexTaskState.includes("full_video") ||
    codexTaskState.includes("preparing_full");
  const currentFullVideoVersion = currentFullVideoResult
    ? videoArtifactVersion(currentFullVideoResult)?.version || 1
    : 1;
  const info = statusInfo[task.status] || statusInfo.draft;
  const userState = taskUserState(task);
  const stepIndex = currentStepIndex(task);
  function submitRewrite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("confirmed", "true");
    onRewrite(form);
  }
  return (
    <div className="drawer-layer">
      <button
        className="drawer-backdrop"
        onClick={onClose}
        aria-label="返回任务中心"
      ></button>
      <aside className={`task-drawer task-detail ${task.execution_owner === "project_codex_task" ? "codex-owned" : ""}`}>
        <div className="drawer-head">
          <div className="workflow-icon orange">影</div>
          <div>
            <small>爆款重构项目</small>
            <h2>{task.title}</h2>
          </div>
          <button onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="task-detail-columns">
          <div className="drawer-body">
            <div className="task-status-head">
              <Status task={task} />
              <span>生成记录已保存</span>
            </div>
            <h3 className="user-state-headline">{userState.headline}</h3>
            <p className="status-message">
              {userState.summary || taskStatusMessage(task, info.hint)}
            </p>
            <div className="next-step-card">
              <small>接下来</small>
              <strong>{userState.next_step}</strong>
            </div>
            {task.runtime_generation?.status !== "generation_completed" && (
              <CodexTaskLink
                task={task}
                loading={loading}
                onBind={onBindCodexTask}
              />
            )}
            {task.execution_owner === "project_codex_task" && existingSampleArtifact && (
              <section className="existing-sample-card">
                <div className="existing-sample-heading">
                  <div>
                    <small>已有小样</small>
                    <strong>4 秒小样已保留</strong>
                  </div>
                  <span>不会被正片覆盖</span>
                </div>
                <ArtifactViewer task={task} artifact={existingSampleArtifact} />
              </section>
            )}
            {task.execution_owner === "project_codex_task" && !task.runtime_generation && (
              <section className="codex-execution-card">
                <small>正片进度</small>
                <strong>
                  {fullVideoPreparationStarted
                    ? "正在准备正片"
                    : "正片尚未开始准备"}
                </strong>
                <p>
                  {fullVideoPreparationStarted
                    ? "系统正在整理两段正片所需的提示词、参考图和生成资料。现在尚未上传、尚未提交，也没有产生费用。"
                    : "已有小样和前面确认的资料都会保留。开始准备后，系统会先免费检查正片，再把时长和预计费用列给你确认。"}
                </p>
                <span>
                  {fullVideoPreparationStarted
                    ? "这一步无需操作；准备完成后，页面会出现“确认生成正片”按钮。"
                    : "需要生成正片时，点击下面的按钮即可。"}
                </span>
                {task.status === "video_prompt_ready" && !task.runtime_generation && !fullVideoPreparationStarted && (
                  <>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => onBindCodexTask("prepare_full_video")}
                    >
                      {loading ? "正在开始准备…" : "准备并生成正片"}
                    </button>
                    <div className="privacy-line">
                      先免费检查正片资料；检查通过后再确认付费生成，不自动重试。
                    </div>
                  </>
                )}
              </section>
            )}
            {task.execution_owner === "project_codex_task" && task.runtime_generation && (
              <section className={`action-panel runtime-generation-panel ${task.runtime_generation.status === "preflight_passed" || task.runtime_generation.status === "generation_completed" ? "success-panel" : task.runtime_generation.status.endsWith("failed") ? "warning-panel" : "running-panel"}`}>
                <small>RunningHub H3</small>
                <h3>{task.runtime_generation.phase_label}</h3>
                <p>{task.runtime_generation.summary}</p>
                {task.runtime_generation.status === "preflight_passed" && (
                  <>
                    <div className="generation-spec-grid compact-runtime-specs">
                      <div><span>正片</span><strong>{task.runtime_generation.generation?.generation_count || 1} 段 · 共 {task.runtime_generation.generation?.duration_seconds} 秒</strong></div>
                      <div><span>清晰度</span><strong>{task.runtime_generation.generation?.quality_profile === "ultra" ? "超清" : task.runtime_generation.generation?.quality_profile === "high" ? "高清" : "普通"}</strong></div>
                      <div><span>参考图</span><strong>{task.runtime_generation.generation?.reference_count} 张</strong></div>
                      <div><span>预计费用</span><strong>{task.runtime_generation.estimated_coins_min}–{task.runtime_generation.estimated_coins_max} RH 币</strong></div>
                    </div>
                    <button
                      type="button"
                      disabled={loading || !task.runtime_generation.can_confirm_paid}
                      onClick={onConfirmRuntimeGeneration}
                    >
                      {loading ? "正在提交…" : `确认生成 ${task.runtime_generation.generation?.generation_count || 1} 段`}
                    </button>
                    <div className="privacy-line">点击后才会上传上面列明的参考图并付费提交；不自动重试。</div>
                  </>
                )}
                {task.runtime_generation.status === "generation_failed" && (
                  <div className="runtime-next-action">
                    <strong>{task.runtime_generation.next_action}</strong>
                    {task.runtime_generation.failure_kind === "capacity_oom" && (
                      <>
                        <p>
                          上一次失败记录和已有视频都会保留；本次只把运行环境切换为大显存模式，提示词、人物和参考图不变。
                        </p>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={onRetryRuntimeGenerationWithPlus}
                        >
                          {loading ? "正在切换并提交…" : "用大显存模式重新生成 1 次"}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {task.runtime_generation.status === "generation_completed" && runtimeVideoArtifact && (
                  <>
                    <ArtifactViewer task={task} artifact={runtimeVideoArtifact} />
                    {runtimeResultIsSample && (
                      <div className="runtime-next-action">
                        <strong>这版小样可以继续使用</strong>
                        <p>采用后会保留这段小样，并免费准备完整正片；正式提交前会先列出总时长、分段和预计费用。</p>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => onBindCodexTask("prepare_full_video")}
                        >
                          {loading ? "正在准备正片…" : "满意，采用小样并准备正片"}
                        </button>
                      </div>
                    )}
                    {!runtimeResultIsSample && (
                      <div className="runtime-next-action">
                        <strong>想重新生成时，旧版会继续保留</strong>
                        <p>重新准备会按当前人物、场景、文案、通道和清晰度再做一次免费检查；检查通过后才会显示本次费用确认。</p>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => onBindCodexTask("prepare_full_video")}
                        >
                          {loading ? "正在重新准备…" : "保留这版，重新准备正片"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
            <ProjectFacts task={task} />
            <ProjectProviderDefault
              task={task}
              capabilities={providerCapabilities}
              loading={loading}
              onChange={onSetDefaultProvider}
            />
            {task.execution_owner === "project_codex_task" &&
              userFacingArtifacts(task).filter(
                (artifact) => artifact.path !== runtimeVideoArtifact?.path,
              ).length > 0 && (
                <section className="drawer-section codex-owned-results">
                  <h3>当前项目成果</h3>
                  <p className="section-intro">
                    项目任务返回的图片、视频和文档都会保留在这里；刷新页面不会丢失。
                  </p>
                  {userFacingArtifacts(task)
                    .filter(
                      (artifact) => artifact.path !== runtimeVideoArtifact?.path,
                    )
                    .map((artifact) => (
                      <ArtifactViewer
                        key={artifact.id}
                        task={task}
                        artifact={artifact}
                      />
                    ))}
                </section>
              )}
            {task.execution_owner !== "project_codex_task" && (
              <>
            <div className="real-step-list">
              {steps.map((step, index) => {
                const quickRouteSkipped =
                  task.remix_precision_route === "prompt_driven_remix" &&
                  [
                    "storyboard_inputs_ready",
                    "storyboard_generation",
                    "storyboard_review",
                    "motion_preflight",
                    "person_package",
                  ].includes(step.id);
                const skipped =
                  quickRouteSkipped ||
                  (task.rewrite_mode === "keep_original_style" &&
                    step.id === "rewrite");
                const quickRouteCopy =
                  task.remix_precision_route === "prompt_driven_remix"
                    ? quickRouteStepCopy(step)
                    : null;
                const visibleStepNumber = steps
                  .slice(0, index + 1)
                  .filter((candidate) => {
                    const quickSkipped =
                      task.remix_precision_route === "prompt_driven_remix" &&
                      [
                        "storyboard_inputs_ready",
                        "storyboard_generation",
                        "storyboard_review",
                        "motion_preflight",
                        "person_package",
                      ].includes(candidate.id);
                    const rewriteSkipped =
                      task.rewrite_mode === "keep_original_style" &&
                      candidate.id === "rewrite";
                    return !quickSkipped && !rewriteSkipped;
                  }).length;
                return (
                  <div
                    key={step.id}
                    className={
                      skipped
                        ? "skipped"
                        : index < stepIndex
                          ? "complete"
                          : index === stepIndex
                            ? "current"
                            : "pending"
                    }
                  >
                    <span>
                      {skipped ? "—" : index < stepIndex ? "✓" : visibleStepNumber}
                    </span>
                    <div>
                      <strong>{quickRouteCopy?.title || step.title}</strong>
                      <small>
                        {quickRouteSkipped
                          ? "快速重构不需要这一步"
                          : skipped
                            ? "按你的选择跳过"
                            : quickRouteCopy?.description || step.description}
                      </small>
                    </div>
                  </div>
                );
              })}
            </div>
            {task.status === "ready" && (
              <div className="action-panel warning-panel">
                <small>开始前确认</small>
                <h3>允许上传这一条参考视频进行语义拆解</h3>
                <p>
                  只上传本任务的参考片；不上传产品图、真人照或其他文件。外部费用超过
                  ¥{Number(task.budget_limit_cny).toFixed(0)} 将停止。
                </p>
                <button disabled={loading} onClick={onStart}>
                  {loading ? "正在提交…" : "确认范围并开始拆解"}
                </button>
              </div>
            )}
            {(task.status === "failed" || task.status === "interrupted") && (
              <div className="action-panel error-panel">
                <small>
                  {task.status === "interrupted" ? "安全恢复" : "有界重试"}
                </small>
                <h3>{info.label}</h3>
                <p>
                  {task.last_error || task.user_message}
                  。系统不会自行重复扣额度，当前只允许你手动继续一次。
                </p>
                <button disabled={loading} onClick={onResume}>
                  {loading ? "正在恢复…" : "确认并继续一次"}
                </button>
              </div>
            )}
            {task.status === "blocked_configuration" && (
              <div className="action-panel warning-panel">
                <small>配置阻断 · 不计失败</small>
                <h3>任务已安全暂停</h3>
                <p>
                  {task.user_message}{" "}
                  当前没有发起新的外部请求，也没有占用失败重试次数。
                </p>
                <button disabled={loading} onClick={onResume}>
                  {loading ? "正在重新预检…" : "重新预检并继续"}
                </button>
              </div>
            )}
            {task.status === "blocked_runtime" && (
              <div className="action-panel warning-panel">
                <small>后台启动阻断 · 不计失败</small>
                <h3>业务还没有开始</h3>
                <p>{task.user_message}</p>
                <button disabled={loading} onClick={onResume}>
                  {loading ? "正在重新连接…" : "重新连接并继续"}
                </button>
              </div>
            )}
            {task.status === "blocked_diagnostic" && (
              <div className="action-panel error-panel">
                <small>已停止</small>
                <h3>不再继续重试</h3>
                <p>
                  同一步骤已经连续失败或中断，需要先检查共同根因。当前不会自动换供应商或继续消耗额度。
                </p>
              </div>
            )}
            {task.status === "awaiting_confirmation" &&
              task.current_step === "user_confirmation" && (
                <div className="action-panel confirm-panel">
                  <small>需要你确认</small>
                  <h3>参考视频已经看完，接下来怎么做？</h3>
                  <p>
                    {task.decomposition_result?.summary ||
                      "先看分析结果，再选择保留原内容还是换成你的产品。"}
                  </p>
                  <div className="route-options">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={onSkipRewrite}
                    >
                      <strong>保留原产品 / 穿搭风格</strong>
                      <span>不换产品，直接继续人物和分镜制作</span>
                    </button>
                    <button
                      type="button"
                      className={
                        rewriteMode === "replace_product" ? "selected" : ""
                      }
                      onClick={() => setRewriteMode("replace_product")}
                    >
                      <strong>换成我的产品</strong>
                      <span>根据你的真实产品和卖点重构内容</span>
                    </button>
                  </div>
                  {rewriteMode && (
                    <form className="route-form" onSubmit={submitRewrite}>
                      <input
                        type="hidden"
                        name="rewriteMode"
                        value={rewriteMode}
                      />
                      <input type="hidden" name="productScope" value={productScope} />
                      <fieldset className="setup-field">
                        <legend>这些图片代表什么产品</legend>
                        <div className="route-options compact-options">
                          <button type="button" className={productScope === "full_look" ? "selected" : ""} onClick={() => setProductScope("full_look")}>
                            <strong>整套穿搭</strong>
                            <span>上衣和下装都要完整保留</span>
                          </button>
                          <button type="button" className={productScope === "top_only" ? "selected" : ""} onClick={() => setProductScope("top_only")}>
                            <strong>只换上衣</strong>
                            <span>下装仅作搭配参考</span>
                          </button>
                          <button type="button" className={productScope === "bottom_only" ? "selected" : ""} onClick={() => setProductScope("bottom_only")}>
                            <strong>只换下装</strong>
                            <span>上衣仅作搭配参考</span>
                          </button>
                        </div>
                      </fieldset>
                      <label>
                        <span>新产品的真实资料（可选）</span>
                        <textarea
                          name="productBrief"
                          defaultValue={
                            /不.*换|不需要换/.test(task.product_brief)
                              ? ""
                              : task.product_brief
                          }
                          placeholder="产品名称、规格、真实卖点、价格或活动、希望观众采取的行动"
                        ></textarea>
                      </label>
                      <label>
                        <span>补充产品图片（与文字资料至少填一项）</span>
                        <input
                          className="file-input"
                          name="productImages"
                          type="file"
                          accept="image/*"
                          multiple
                        />
                      </label>
                      <div className="privacy-line">
                        这些图片只在当前电脑中整理，本步骤不上传外部服务、不生图。
                      </div>
                      <button disabled={loading}>
                        {loading ? "正在提交…" : "确认资料并继续"}
                      </button>
                    </form>
                  )}
                </div>
              )}
            {task.status === "completed" && (
              <div className="action-panel success-panel">
                <small>参考视频处理完成</small>
                <h3>
                  {task.rewrite_mode === "keep_original_style"
                    ? "已经保留原产品和穿搭风格"
                    : "参考片分析和商品方案已经保存"}
                </h3>
                <p>{task.user_message || task.rewrite_result?.summary}</p>
                {!continueOpen && (
                  <div className="route-options">
                    <button type="button" onClick={() => setContinueOpen(true)}>
                      <strong>继续制作我的版本</strong>
                      <span>选择人物后，工作台接着准备分镜</span>
                    </button>
                    <button type="button" onClick={onSaveOnly}>
                      <strong>先保存，稍后继续</strong>
                      <span>保留现有成果，暂不制作人物和分镜</span>
                    </button>
                  </div>
                )}
                {continueOpen && (
                  <PersonRouteForm
                    loading={loading}
                    route={personRoute}
                    brief={personBrief}
                    authorization={authorizationConfirmed}
                    onRoute={setPersonRoute}
                    onBrief={setPersonBrief}
                    onAuthorization={setAuthorizationConfirmed}
                    onSubmit={() =>
                      onPreparePerson({
                        confirmed: true,
                        personRoute,
                        personBrief,
                        authorizationConfirmed,
                      })
                    }
                  />
                )}
              </div>
            )}
            {task.status === "person_inputs_ready" && (
              <div className="action-panel warning-panel">
                <small>第二阶段 · 创建人物</small>
                <h3>{personRouteHeading(task.person_route)}</h3>
                <p>{personRouteDescription(task.person_route)}</p>
                {task.person_route === "auto_ai_person" ? (
                  <>
                    <ProviderOptions
                      value={generationProvider}
                      defaultValue={task.default_image_generation_provider}
                      capabilities={providerCapabilities}
                      onChange={(value) => {
                        setGenerationProvider(value);
                        setSourceUploadConfirmed(false);
                      }}
                    />
                    <GenerationConsent
                      stage="person"
                      provider={generationProvider}
                      capabilities={providerCapabilities}
                      checked={sourceUploadConfirmed}
                      onChange={setSourceUploadConfirmed}
                    />
                    <button
                      type="button"
                      disabled={
                        loading ||
                        !sourceUploadConfirmed ||
                        (generationProvider === "chatgpt_web" &&
                          !providerCapabilities.chatgptWebAvailable)
                      }
                      onClick={() => onGeneratePerson(generationProvider)}
                    >
                      {loading
                        ? "正在启动…"
                        : generationProvider === "chatgpt_web"
                          ? chatGPTButtonLabel(providerCapabilities)
                          : "创建 1 张人物候选"}
                    </button>
                  </>
                ) : (
                  task.person_route === "authorized_person" ? (
                    <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); form.set("confirmed", String(authorizedPersonUploadConfirmed)); onUploadAuthorizedPerson(form); }}>
                      <label>
                        <span>上传 1 张人物母版照片</span>
                        <input className="file-input" name="personImages" type="file" accept="image/*" required onChange={(event) => { setAuthorizedPersonFileName(event.target.files?.[0]?.name || ""); setAuthorizedPersonUploadConfirmed(false); }} />
                        <small>{authorizedPersonFileName ? `本次只会保存：${authorizedPersonFileName}` : "建议选择清晰正脸照；不会把产品图里的模特当作人物。"}</small>
                      </label>
                      <label className="check-line consent-box">
                        <input type="checkbox" checked={authorizedPersonUploadConfirmed} onChange={(event) => setAuthorizedPersonUploadConfirmed(event.target.checked)} />
                        <span>我确认这 1 张照片属于本人或已取得授权，并同意仅用于当前项目。</span>
                      </label>
                      <button type="submit" disabled={loading || !authorizedPersonFileName || !authorizedPersonUploadConfirmed}>{loading ? "正在保存…" : "保存人物照片并预览"}</button>
                    </form>
                  ) : (
                    <div className="privacy-line">这条路线将在视频生成阶段临时创建角色，不会单独生成人物候选。</div>
                  )
                )}
                {!continueOpen && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setContinueOpen(true)}
                  >
                    修改人物路线
                  </button>
                )}
                {continueOpen && (
                  <PersonRouteForm
                    loading={loading}
                    route={personRoute}
                    brief={personBrief}
                    authorization={authorizationConfirmed}
                    onRoute={setPersonRoute}
                    onBrief={setPersonBrief}
                    onAuthorization={setAuthorizationConfirmed}
                    onSubmit={() =>
                      onPreparePerson({
                        confirmed: true,
                        personRoute,
                        personBrief,
                        authorizationConfirmed,
                      })
                    }
                  />
                )}
              </div>
            )}
            {task.status === "running_person_generation" && (
              <div className="action-panel running-panel">
                <small>正在创建人物</small>
                <h3>系统正在准备 1 张虚构人物候选</h3>
                <p>
                  {task.person_generation_provider === "chatgpt_web"
                    ? "先由人物 Skill 准备正式提示词和参考图职责；准备完成后才会打开 ChatGPT 网页上传并生成。页面异常时会安全停止，不会自动再次提交。"
                    : "会先核对原片风格、人物外观边界和参考图职责，再调用一次生图。页面可以暂时关闭，任务状态会保留。"}
                </p>
                <div className="privacy-line">
                  本次不会追加第二张，也不会在失败后自动重试。
                </div>
              </div>
            )}
            {task.status === "person_review" && (
              <div className="action-panel success-panel person-review-panel">
                <small>人物候选待确认</small>
                <h3>这个人物是否适合继续做复刻视频？</h3>
                {task.artifacts.find(
                  (artifact) =>
                    artifact.stage === "person" &&
                    /人物候选图/.test(artifact.label) &&
                    /\.(png|jpe?g|webp)$/i.test(artifact.path),
                ) ? (
                  <button
                    type="button"
                    className="package-preview-button person-candidate-preview"
                    onClick={() =>
                      setPersonPreview(
                        task.artifacts.find(
                          (artifact) =>
                            artifact.stage === "person" &&
                            /人物候选图/.test(artifact.label) &&
                            /\.(png|jpe?g|webp)$/i.test(artifact.path),
                        ) || null,
                      )
                    }
                    aria-label="放大查看人物候选"
                  >
                    <Image
                      className="person-candidate"
                      src={`${API}/tasks/${task.id}/person-image?v=${task.updated_at}`}
                      width={720}
                      height={960}
                      unoptimized
                      alt={`${task.title} AI 人物候选`}
                    />
                    <span>点击放大</span>
                  </button>
                ) : (
                  <Image
                    className="person-candidate"
                    src={`${API}/tasks/${task.id}/person-image?v=${task.updated_at}`}
                    width={720}
                    height={960}
                    unoptimized
                    alt={`${task.title} AI 人物候选`}
                  />
                )}
                <p>{task.user_message}</p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={onApprovePerson}
                >
                  满意，采用这个人物
                </button>
                {task.person_attempt_count < 2 ? (
                  <>
                    <h4>不满意，换通道或重做</h4>
                    <ProviderOptions
                      value={generationProvider}
                      defaultValue={task.default_image_generation_provider}
                      capabilities={providerCapabilities}
                      onChange={(value) => {
                        setGenerationProvider(value);
                        setSourceUploadConfirmed(false);
                      }}
                    />
                    <GenerationConsent
                      stage="person"
                      provider={generationProvider}
                      capabilities={providerCapabilities}
                      checked={sourceUploadConfirmed}
                      onChange={setSourceUploadConfirmed}
                    />
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        loading ||
                        !sourceUploadConfirmed ||
                        (generationProvider === "chatgpt_web" &&
                          !providerCapabilities.chatgptWebAvailable)
                      }
                      onClick={() => onGeneratePerson(generationProvider)}
                    >
                      重新生成 1 张人物
                    </button>
                  </>
                ) : (
                  <div className="limit-note">
                    本轮两次人物候选额度已用完，不能继续切换通道或生成；请先从现有候选中选择。
                  </div>
                )}
                <div className="privacy-line">
                  本次通道可以临时切换，不会改变项目默认设置；系统不会自行重复提交。
                </div>
              </div>
            )}
            {task.status === "person_generation_failed" && (
              <div className="action-panel error-panel">
                <small>人物生成已停止</small>
                <h3>没有把失败结果冒充人物成果</h3>
                <p>{task.user_message}</p>
                {task.last_error && (
                  <div className="error-box">{task.last_error}</div>
                )}
                {task.person_attempt_count < 2 ||
                (task.person_generation_provider === "chatgpt_web" &&
                  /PERSON_CHATGPT_INTERNAL_REQUEST_MISSING|CHATGPT_INTERNAL_REQUEST_EXECUTION_INVALID|CHATGPT_WEB_PRE_SUBMIT_BLOCKED|等待参考图上传完成超时|等待页面控件超时|EEXIST: file already exists.*\/person-(?:skill-contract-attempt|task-attempt|web-request-prompt)-\d+/.test(task.last_error || "")) ? (
                  <>
                    <ProviderOptions
                      value={generationProvider}
                      defaultValue={task.default_image_generation_provider}
                      capabilities={providerCapabilities}
                      onChange={(value) => {
                        setGenerationProvider(value);
                        setSourceUploadConfirmed(false);
                      }}
                    />
                    <GenerationConsent
                      stage="person"
                      provider={generationProvider}
                      capabilities={providerCapabilities}
                      checked={sourceUploadConfirmed}
                      onChange={setSourceUploadConfirmed}
                    />
                    <button
                      type="button"
                      disabled={
                        loading ||
                        !sourceUploadConfirmed ||
                        (generationProvider === "chatgpt_web" &&
                          !providerCapabilities.chatgptWebAvailable)
                      }
                      onClick={() => onGeneratePerson(generationProvider)}
                    >
                      {task.person_attempt_count >= 2 ? "继续上次网页生图" : "手动重新尝试一次"}
                    </button>
                    {task.person_attempt_count >= 2 && (
                      <div className="privacy-line">
                        上次停在发送前；继续会复用已准备好的提示词和参考图，不增加人物生成次数。
                      </div>
                    )}
                  </>
                ) : (
                  <div className="limit-note">
                    本轮两次人物候选尝试已用完，系统已停止继续生成。
                  </div>
                )}
                <div className="privacy-line">
                  原有拆解和复刻方案仍然保留；不会自动换通道。
                </div>
              </div>
            )}
            {task.status === "person_approved" && (
              <div className="action-panel success-panel person-review-panel">
                <small>人物已经确认</small>
                <h3>{task.remix_precision_route === "prompt_driven_remix" ? "选择这次怎么生成" : "可以生成第一版分镜了"}</h3>
                <Image
                  className="person-candidate"
                  src={`${API}/tasks/${task.id}/person-image?v=${task.updated_at}`}
                  width={720}
                  height={960}
                  unoptimized
                  alt={`${task.title} 已确认人物`}
                />
                <p>{task.user_message}</p>
                {task.remix_precision_route === "prompt_driven_remix" ? (
                  <>
                    <VideoGenerationSettings models={videoModels} route={generationRouteChoice} modelKey={generationModelKey} provider={videoGenerationProvider} quality={videoQualityProfile} onRouteChange={setGenerationRouteChoice} onModelChange={setGenerationModelKey} onProviderChange={setVideoGenerationProvider} onQualityChange={setVideoQualityProfile} />
                    <button type="button" disabled={loading || !selectedVideoModelAvailable} onClick={() => onStartVideoPrompt(videoGenerationSelection)}>{loading ? "正在整理…" : "整理提示词并检查素材"}</button>
                    <div className="privacy-line">快速路线不生成目标分镜；先按这次选择整理正式提示词和素材清单，不上传、不生成、不产生视频费用。</div>
                  </>
                ) : (
                  <>
                    <label>
                      <span>分镜补充要求（可选）</span>
                      <textarea value={storyboardBrief} onChange={(event) => setStoryboardBrief(event.target.value)} maxLength={2000} placeholder="例如：保留原片镜头节奏，重点展示上衣版型和走动状态"></textarea>
                    </label>
                    <button type="button" disabled={loading} onClick={() => onPrepareStoryboard(storyboardBrief)}>{loading ? "正在准备…" : "生成第一版分镜"}</button>
                    <div className="privacy-line">这一步先整理现有资料，不生图、不上传、不产生费用。</div>
                  </>
                )}
              </div>
            )}
            {task.status === "running_product_assets" && (
              <div className="action-panel running-panel">
                <small>产品参考整理中</small>
                <h3>正在从你上传的商品图里提取干净参考</h3>
                <p>{task.user_message}</p>
                <div className="privacy-line">
                  只做本地审计、裁切和拼图；不会上传图片，也不会调用生图。
                </div>
              </div>
            )}
            {task.status === "product_assets_review" && (
              <div className="action-panel warning-panel">
                <small>产品范围需要修正</small>
                <h3>这些图片代表整套穿搭，还是其中一件？</h3>
                <p>{task.user_message}</p>
                <div className="route-options compact-options">
                  <button type="button" className={productScope === "full_look" ? "selected" : ""} onClick={() => setProductScope("full_look")}>
                    <strong>整套穿搭</strong>
                    <span>上衣和下装都要保留</span>
                  </button>
                  <button type="button" className={productScope === "top_only" ? "selected" : ""} onClick={() => setProductScope("top_only")}>
                    <strong>只换上衣</strong>
                    <span>下装仅作搭配参考</span>
                  </button>
                  <button type="button" className={productScope === "bottom_only" ? "selected" : ""} onClick={() => setProductScope("bottom_only")}>
                    <strong>只换下装</strong>
                    <span>上衣仅作搭配参考</span>
                  </button>
                </div>
                <button type="button" disabled={loading} onClick={() => onSetProductScope(productScope)}>
                  按这个产品范围重新整理
                </button>
                <div className="privacy-line">
                  原图完整保留；局部图只补充细节，不能替代完整产品。整理完整后会自动继续，不再问是否满意。
                </div>
              </div>
            )}
            {task.status === "product_assets_blocked" && (
              <div className="action-panel error-panel">
                <small>现有商品图还不能安全使用</small>
                <h3>原图和已有成果都已保留</h3>
                <p>{task.user_message}</p>
                <div className="route-options compact-options">
                  <button type="button" className={productScope === "full_look" ? "selected" : ""} onClick={() => setProductScope("full_look")}>
                    <strong>整套穿搭</strong><span>上衣和下装都要保留</span>
                  </button>
                  <button type="button" className={productScope === "top_only" ? "selected" : ""} onClick={() => setProductScope("top_only")}>
                    <strong>只换上衣</strong><span>下装仅作搭配参考</span>
                  </button>
                  <button type="button" className={productScope === "bottom_only" ? "selected" : ""} onClick={() => setProductScope("bottom_only")}>
                    <strong>只换下装</strong><span>上衣仅作搭配参考</span>
                  </button>
                </div>
                <button type="button" disabled={loading} onClick={() => onSetProductScope(productScope)}>
                  按这个产品范围重新整理
                </button>
              </div>
            )}
            {task.status === "storyboard_inputs_ready" && (
              <div className="action-panel warning-panel">
                <small>第三阶段 · 锚帧分镜</small>
                <h3>分镜资料已经准备好</h3>
                <p>{task.user_message}</p>
                <div className="scope-strip">
                  <strong>已就绪</strong>
                  <span>
                    参考片拆解 · 已确认人物母版 ·{" "}
                    {task.rewrite_mode === "keep_original_style"
                      ? "原产品 / 穿搭路线"
                      : "商品脚本路线"}
                  </span>
                </div>
                <ProviderOptions
                  value={storyboardGenerationProvider}
                  defaultValue={task.default_image_generation_provider}
                  capabilities={providerCapabilities}
                  onChange={(value) => {
                    setStoryboardGenerationProvider(value);
                    setStoryboardUploadConfirmed(false);
                  }}
                />
                <GenerationConsent
                  stage="storyboard"
                  task={task}
                  provider={storyboardGenerationProvider}
                  capabilities={providerCapabilities}
                  checked={storyboardUploadConfirmed}
                  onChange={setStoryboardUploadConfirmed}
                />
                <button
                  type="button"
                  disabled={
                    loading ||
                    !storyboardUploadConfirmed ||
                    (storyboardGenerationProvider === "chatgpt_web" &&
                      !providerCapabilities.chatgptWebAvailable)
                  }
                  onClick={() =>
                    onGenerateStoryboard(storyboardGenerationProvider)
                  }
                >
                  {loading
                    ? "正在启动…"
                    : storyboardGenerationProvider === "chatgpt_web"
                      ? "交给 ChatGPT 生成第一版分镜"
                      : "生成第一版分镜"}
                </button>
              </div>
            )}
            {task.status === "running_storyboard_generation" && (
              <div className="action-panel running-panel">
                <small>正在生成分镜</small>
                <h3>系统正在按原片结构创建目标分镜</h3>
                <p>
                  会先核对原片动作节点、构图、手机画质和人物母版职责，再由干净生图执行层提交一次。页面可以关闭，状态会保留。
                </p>
                <div className="privacy-line">
                  短片通常生成一张宫格；长片会按自然段生成多张。每段只生成一次，不自动重试或进入视频生成。
                </div>
              </div>
            )}
            {task.status === "storyboard_review" && (
              <div className="action-panel success-panel person-review-panel">
                <small>目标宫格待确认</small>
                <h3>这组分段分镜是否可以继续使用？</h3>
                <p className="preview-hint">请逐段检查人物、穿搭、场景和动作；点击图片可放大。</p>
                <div className="package-gallery storyboard-review-gallery">
                  {storyboardResultArtifacts(task).map((artifact, index) => (
                    <figure key={`${artifact.path}-${index}`}>
                      <button
                        type="button"
                        className="package-preview-button"
                        onClick={() => setStoryboardPreview(artifact)}
                        aria-label={`放大查看第${index + 1}段分镜`}
                      >
                        <Image
                          src={`${API}/tasks/${task.id}/artifacts/${artifact.id}?v=${task.updated_at}`}
                          width={900}
                          height={900}
                          unoptimized
                          alt={`第${index + 1}段分镜`}
                        />
                        <span>点击放大</span>
                      </button>
                      <figcaption>第 {index + 1} 段分镜</figcaption>
                    </figure>
                  ))}
                </div>
                <p>{task.user_message}</p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={onApproveStoryboard}
                >
                  满意，采用这版分镜
                </button>
                {task.storyboard_attempt_count < 2 ? (
                  <>
                    <h4>不满意，换通道或重做</h4>
                    <ProviderOptions
                      value={storyboardGenerationProvider}
                      defaultValue={task.default_image_generation_provider}
                      capabilities={providerCapabilities}
                      onChange={(value) => {
                        setStoryboardGenerationProvider(value);
                        setStoryboardUploadConfirmed(false);
                      }}
                    />
                    <GenerationConsent
                      stage="storyboard"
                      task={task}
                      provider={storyboardGenerationProvider}
                      capabilities={providerCapabilities}
                      checked={storyboardUploadConfirmed}
                      onChange={setStoryboardUploadConfirmed}
                    />
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        loading ||
                        !storyboardUploadConfirmed ||
                        (storyboardGenerationProvider === "chatgpt_web" &&
                          !providerCapabilities.chatgptWebAvailable)
                      }
                      onClick={() =>
                        onGenerateStoryboard(storyboardGenerationProvider)
                      }
                    >
                      重做 1 版分镜
                    </button>
                  </>
                ) : (
                  <div className="limit-note">
                    本轮两次分镜额度已用完，不能继续切换通道或生成；请先处理现有候选。
                  </div>
                )}
                <div className="privacy-line">
                  本次通道可以临时切换，不会改变项目默认设置；系统不会自行重复提交。
                </div>
              </div>
            )}
            {task.status === "storyboard_generation_failed" && (
              <div className="action-panel error-panel person-review-panel">
                <small>分镜生成已停止</small>
                <h3>
                  {currentStoryboardResultImage(task)
                    ? "候选已生成，但硬检查未通过"
                    : "失败结果没有被当成正式分镜"}
                </h3>
                {currentStoryboardResultImage(task) && (
                  <Image
                    className="storyboard-candidate"
                    src={`${API}/tasks/${task.id}/storyboard-image?v=${task.updated_at}`}
                    width={960}
                    height={1280}
                    unoptimized
                    alt={`${task.title} 被比例检查拦截的分镜候选`}
                  />
                )}
                <p>{task.user_message}</p>
                {task.last_error && (
                  <div className="error-box">{task.last_error}</div>
                )}
                {task.last_error?.includes("后台执行等待超时") ? (
                  <>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() =>
                        onGenerateStoryboard(
                          task.storyboard_generation_provider || "codex_builtin",
                          true,
                        )
                      }
                    >
                      接回已生成的分镜
                    </button>
                    <div className="privacy-line">
                      图片已经生成，只恢复比例检查和工作台登记；不会重新生图、上传或占用新的生成次数。
                    </div>
                  </>
                ) : task.storyboard_generation_result?.objective_ratio_repair
                  ?.performed ? (
                  <div className="limit-note">
                    系统已完成本次允许的比例纠正并停止，不需要你再手动重复同一操作。
                  </div>
                ) : task.storyboard_attempt_count < 2 ? (
                  <>
                    <ProviderOptions
                      value={storyboardGenerationProvider}
                      defaultValue={task.default_image_generation_provider}
                      capabilities={providerCapabilities}
                      onChange={(value) => {
                        setStoryboardGenerationProvider(value);
                        setStoryboardUploadConfirmed(false);
                      }}
                    />
                    <GenerationConsent
                      stage="storyboard"
                      task={task}
                      provider={storyboardGenerationProvider}
                      capabilities={providerCapabilities}
                      checked={storyboardUploadConfirmed}
                      onChange={setStoryboardUploadConfirmed}
                    />
                    <button
                      type="button"
                      disabled={
                        loading ||
                        !storyboardUploadConfirmed ||
                        (storyboardGenerationProvider === "chatgpt_web" &&
                          !providerCapabilities.chatgptWebAvailable)
                      }
                      onClick={() =>
                        onGenerateStoryboard(storyboardGenerationProvider)
                      }
                    >
                      手动重做正确比例版本
                    </button>
                  </>
                ) : task.last_error?.trim() === "CHATGPT_RESULT_TARGET_EXISTS" ? (
                  <>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => onGenerateStoryboard("chatgpt_web", true)}
                    >
                      继续生成剩余分镜
                    </button>
                    <div className="privacy-line">
                      已完成段落会直接接回，只补未完成段落，不占用新的尝试次数。
                    </div>
                  </>
                ) : (
                  <div className="limit-note">
                    本轮两次分镜尝试已用完，系统已停止继续生成；现有素材和成果不受影响。
                  </div>
                )}
                <div className="privacy-line">
                  错误候选只作问题对照，不能采用；人物母版、拆解成果和分镜资料仍然保留；不会自动换通道。
                </div>
              </div>
            )}
            {task.status === "storyboard_approved" && (
              <div className="action-panel success-panel person-review-panel">
                <small>第三阶段分镜闭环完成</small>
                <h3>目标宫格分镜已经采用</h3>
                <Image
                  className="storyboard-candidate"
                  src={`${API}/tasks/${task.id}/storyboard-image?v=${task.updated_at}`}
                  width={960}
                  height={1280}
                  unoptimized
                  alt={`${task.title} 已采用目标宫格分镜`}
                />
                <p>{task.user_message}</p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={onStartMotionPreflight}
                >
                  {loading ? "正在启动…" : "开始动态预演"}
                </button>
                <div className="privacy-line">
                  这一步只整理逐镜运动蓝图，不上传素材、不生视频、不产生外部费用。
                </div>
              </div>
            )}
            {task.status === "running_motion_preflight" && (
              <div className="action-panel running-panel">
                <small>第四步 · 动态检查</small>
                <h3>正在检查人物和镜头怎么动</h3>
                <p>{task.user_message}</p>
                <div className="privacy-line">
                  页面可以关闭，进度会保留；当前没有生成视频，也不会自动进入付费平台。
                </div>
              </div>
            )}
            {task.status === "motion_preflight_ready" && (
              <div className="action-panel success-panel">
                <small>动态检查完成</small>
                <h3>人物动作和镜头运动已经整理好</h3>
                <p>{task.user_message}</p>
                <div className="scope-strip">
                  <strong>已经整理</strong>
                  <span>
                    人物动作 · 表演节奏 · 镜头运动 · 衣物表现 · 稳定重点
                  </span>
                </div>
                <button
                  type="button"
                  disabled={loading}
                  onClick={onStartVideoPrompt}
                >
                  {loading ? "正在启动…" : "整理视频生成方案"}
                </button>
                <div className="privacy-line">
                  当前只整理生成所需内容，不上传素材、不生成视频、不产生外部 API
                  费用。
                </div>
              </div>
            )}
            {task.status === "motion_preflight_blocked" && (
              <div className="action-panel error-panel">
                <small>动态预演已停止</small>
                <h3>现有分镜和人物不受影响</h3>
                <p>{task.user_message}</p>
                {task.last_error && (
                  <div className="error-box">{task.last_error}</div>
                )}
                <button
                  type="button"
                  disabled={loading}
                  onClick={onStartMotionPreflight}
                >
                  {loading ? "正在重新启动…" : "修复后重新开始动态预演"}
                </button>
              </div>
            )}
            {task.status === "running_video_prompt" && (
              <div className="action-panel running-panel">
                <small>第五步 · 整理生成方案</small>
                <h3>正在整理视频生成方案</h3>
                <p>{task.user_message}</p>
                <div className="privacy-line">
                  页面可以关闭，进度会保留；当前没有上传素材或开始生成视频。
                </div>
              </div>
            )}
            {task.status === "video_prompt_ready" && (
              <div className="action-panel success-panel">
                <small>第六步 · 准备生成</small>
                <h3>这一次怎么生成？</h3>
                <p>
                  可以先做 4
                  秒验证，也可以直接准备正式版；本次模型可单独选择，不改变以后任务。
                </p>
                <VideoGenerationSettings
                  models={videoModels}
                  route={generationRouteChoice}
                  modelKey={generationModelKey}
                  provider={videoGenerationProvider}
                  quality={videoQualityProfile}
                  onRouteChange={setGenerationRouteChoice}
                  onModelChange={setGenerationModelKey}
                  onProviderChange={setVideoGenerationProvider}
                  onQualityChange={setVideoQualityProfile}
                />
                <button
                  type="button"
                  disabled={loading || !selectedVideoModelAvailable}
                  onClick={() =>
                    onStartVideoGeneration(videoGenerationSelection)
                  }
                >
                  {loading ? "正在检查…" : "检查素材并生成确认单"}
                </button>
                <div className="privacy-line">
                  这里只整理任务包并检查素材，不上传、不生成、不产生视频费用。
                </div>
              </div>
            )}
            {task.status === "person_package_required" && (
              <div className="action-panel warning-panel">
                <small>生成前需要补齐人物参考</small>
                <h3>一次补齐保持人物一致所需的图片</h3>
                <p>{task.user_message}</p>
                <div className="scope-strip">
                  <strong>需要准备</strong>
                  <span>
                    {task.person_package_result?.required_assets?.join(" · ") ||
                      "人物多视图 · 三道红线遮脸版 · 局部材质拼图"}
                  </span>
                </div>
                <ProviderOptions
                  value={personPackageProvider}
                  defaultValue={task.default_image_generation_provider}
                  capabilities={providerCapabilities}
                  onChange={(value) => {
                    setPersonPackageProvider(value);
                    setPersonPackageUploadConfirmed(false);
                  }}
                />
                <label className="check-line consent-box">
                  <input
                    type="checkbox"
                    checked={personPackageUploadConfirmed}
                    onChange={(event) =>
                      setPersonPackageUploadConfirmed(event.target.checked)
                    }
                  />
                  <span>
                    我同意把已确认人物和已采用分镜中的必要参考图交给这次选择的生图方式，只用于上面列出的图片；不上传清单外内容。
                  </span>
                </label>
                <button
                  type="button"
                  disabled={
                    loading ||
                    !personPackageUploadConfirmed ||
                    (personPackageProvider === "chatgpt_web" &&
                      !providerCapabilities.chatgptWebAvailable)
                  }
                  onClick={() => onGeneratePersonPackage(personPackageProvider)}
                >
                  {loading ? "正在启动…" : "开始补齐人物参考"}
                </button>
                <div className="privacy-line">
                  红线遮脸版和局部材质拼图用于提高人物一致性；不需要的图片不会额外生成。本步不生成视频。
                </div>
              </div>
            )}
            {task.status === "running_person_package" && (
              <div className="action-panel running-panel">
                <small>正在补齐人物安全资产</small>
                <h3>系统正在合并生成固定清单</h3>
                <p>{task.user_message}</p>
                <div className="privacy-line">
                  只生成已列明资产，不自动扩大范围、不自动重试，也不会提前提交视频。
                </div>
              </div>
            )}
            {task.status === "person_package_review" && (
              <div className="action-panel success-panel person-review-panel">
                <small>人物安全资产待确认</small>
                <h3>人物、穿搭和安全衍生图是否一致？</h3>
                <p className="preview-hint">点击任意图片可放大检查细节。</p>
                <div className="package-gallery">
                  {task.artifacts
                    .filter(
                      (artifact) =>
                        artifact.stage === "person_package" &&
                        /\.(png|jpe?g|webp)$/i.test(artifact.path),
                    )
                    .map((artifact) => (
                      <figure key={artifact.id}>
                        <button
                          type="button"
                          className="package-preview-button"
                          onClick={() => setPackagePreview(artifact)}
                          aria-label={`放大查看${artifact.label}`}
                        >
                          <Image
                            src={`${API}/tasks/${task.id}/artifacts/${artifact.id}?v=${task.updated_at}`}
                            width={900}
                            height={900}
                            unoptimized
                            alt={artifact.label}
                          />
                          <span>点击放大</span>
                        </button>
                        <figcaption>{artifact.label}</figcaption>
                      </figure>
                    ))}
                </div>
                <p>{task.user_message}</p>
                {personPackageNeedsRework && (
                  <div className="limit-note">
                    已有合格图片会继续保留；系统只修复红线版和局部材质拼图，不会重做人物与分镜。
                  </div>
                )}
                <button
                  type="button"
                  disabled={
                    loading ||
                    (personPackageNeedsRework &&
                      personPackageProvider === "chatgpt_web" &&
                      !providerCapabilities.chatgptWebAvailable)
                  }
                  onClick={
                    personPackageNeedsRework
                      ? () => onGeneratePersonPackage(personPackageProvider)
                      : onApprovePersonPackage
                  }
                >
                  {loading
                    ? "正在继续…"
                    : personPackageNeedsRework
                      ? "修复 2 项并继续"
                      : "全部采用并继续生成视频"}
                </button>
                <div className="privacy-line">
                  修复只沿用此前确认的同一人物和分镜；真实视频费用仍会单独确认。
                </div>
              </div>
            )}
            {task.status === "person_package_failed" && (
              <div className="action-panel warning-panel">
                <small>人物资产需要继续处理</small>
                <h3>
                  {personPackageCheckpoint
                    ? `已保留 ${preservedPersonPackageCount} 项，只差 ${missingPersonPackageCount} 项`
                    : "人物资产还未生成"}
                </h3>
                <p>
                  {personPackageCheckpoint
                    ? `系统会直接复用已有结果，只补“${task.person_package_result?.missing_assets?.join("、") || "缺失资产"}”；不会重新生成现有图片，也不会提交视频。`
                    : "系统会复用已经确认的人物和分镜继续处理。本次没有提交视频，也没有产生新的生图费用。"}
                </p>
                <div className="scope-strip">
                  <strong>系统自动处理</strong>
                  <span>
                    {personPackageCheckpoint
                      ? "断点续做 · 已有图片不重做 · 只处理缺失项"
                      : "复用现有项目 · 保留原范围 · 不新建重复路径"}
                  </span>
                </div>
                <div className="limit-note">
                  如果这次原本选择的是 RunningHub H3，可直接切回该通道继续；H3
                  使用清晰人物与分镜，不需要补红线或网格安全素材。
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={loading}
                  onClick={() =>
                    onStartVideoGeneration({
                      ...videoGenerationSelection,
                      generationProvider: "runninghub_h3_multiref",
                    })
                  }
                >
                  {loading ? "正在切换…" : "改用 RunningHub H3 继续"}
                </button>
                {personPackageProvider === "chatgpt_web" &&
                  !providerCapabilities.chatgptWebAvailable && (
                    <div className="limit-note">
                      请先打开已登录的 ChatGPT 页面；就绪后按钮会自动恢复。
                    </div>
                  )}
                <button
                  type="button"
                  disabled={
                    loading ||
                    (personPackageProvider === "chatgpt_web" &&
                      !providerCapabilities.chatgptWebAvailable)
                  }
                  onClick={() => onGeneratePersonPackage(personPackageProvider)}
                >
                  {loading
                    ? "正在继续…"
                    : personPackageCheckpoint
                      ? "只补最后 1 项"
                      : "继续生成人物资产"}
                </button>
                <div className="privacy-line">
                  继续使用此前确认的同一批参考图和生图通道；如果需要新增素材、扩大上传范围或产生费用，系统会再单独询问。
                </div>
              </div>
            )}
            {task.status === "running_generation_pack" && (
              <div className="action-panel running-panel">
                <small>生成前检查</small>
                <h3>正在核对素材、画面要求和生成设置</h3>
                <p>{task.user_message}</p>
                <div className="privacy-line">
                  页面可以关闭；当前不会扣除视频生成费用。
                </div>
              </div>
            )}
            {task.status === "generation_pack_ready" && task.last_error && (
              <div className="action-panel warning-panel">
                <small>提交前检查已停止</small>
                <h3>没有上传，也没有扣积分</h3>
                <p>
                  生成资料、原授权和同一模型选择都已保留；修复后可以继续同一次提交前检查。
                </p>
                <button
                  type="button"
                  disabled={
                    loading ||
                    (task.generation_provider !== "runninghub_h3_multiref" &&
                      !task.libtv_project_uuid)
                  }
                  onClick={onGenerateVideo}
                >
                  {loading ? "正在继续…" : "继续同一次提交前检查"}
                </button>
              </div>
            )}
            {task.status === "generation_pack_ready" && !task.last_error && (
              <div className="action-panel success-panel generation-confirm-panel">
                <small>生成前最后一步</small>
                <h3>选好以后，点击一次开始生成</h3>
                <p>{generationPreview && generationPreview.generation_count > 1 ? `本次按自然段生成 ${generationPreview.generation_count} 段并合成为一条，不自动重试。` : "本次只生成 1 条，不自动重试，也不会擅自切换模型。"}</p>
                {!preparingAuthorizedFull && (
                  <>
                    <VideoGenerationSettings
                      models={videoModels}
                      route={generationRouteChoice}
                      modelKey={generationModelKey}
                      provider={videoGenerationProvider}
                      quality={videoQualityProfile}
                      onRouteChange={setGenerationRouteChoice}
                      onModelChange={setGenerationModelKey}
                      onProviderChange={setVideoGenerationProvider}
                      onQualityChange={setVideoQualityProfile}
                    />
                    {generationPackNeedsFourSecondRepair && (
                      <div className="limit-note">
                        旧任务包与当前选择不一致，请先应用选择；只更新本地生成资料，不会提交。
                      </div>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={loading || !selectedVideoModelAvailable}
                      onClick={() =>
                        onRebuildGenerationPack(videoGenerationSelection)
                      }
                    >
                      {loading ? "正在更新…" : "应用选择"}
                    </button>
                  </>
                )}
                {generationPreview && !generationPackNeedsFourSecondRepair ? (
                  <>
                    <h4 className="confirmation-subtitle">本次生成内容</h4>
                    <div className="generation-spec-grid">
                      <div>
                        <span>模型</span>
                        <strong>{generationPreview.model_name}</strong>
                        <small>
                          {generationPreview.provider === "runninghub_h3_multiref"
                            ? "RunningHub H3 实验通道"
                            : "LibTV 官方通道"}
                        </small>
                      </div>
                      <div>
                        <span>规格</span>
                        <strong>{generationPreview.sample_type}</strong>
                        <small>
                          {generationPreview.duration_seconds} 秒 ·{" "}
                          {generationPreview.aspect_ratio} ·{" "}
                          {generationPreview.resolution}
                        </small>
                      </div>
                      <div>
                        <span>提交规则</span>
                        <strong>{generationPreview.generation_count > 1 ? `${generationPreview.generation_count} 段并发` : "只生成 1 条"}</strong>
                        <small>{generationPreview.generation_count > 1 ? `实际并发 ${generationPreview.effective_concurrency || generationPreview.generation_count} 路；完成后自动合成` : "失败不自动重试"}</small>
                      </div>
                      <div>
                        <span>积分</span>
                        <strong>生成后记录</strong>
                        <small>不再要求设置费用上限</small>
                      </div>
                    </div>
                    <div className="generation-upload-list">
                      <span>
                        本次使用 {generationPreview.upload_assets.length}{" "}
                        项已确认素材
                      </span>
                      {generationPreview.upload_assets.map((asset, index) => (
                        <div key={asset.alias}>
                          <b>{index + 1}</b>
                          <p>
                            <strong>{asset.alias}</strong>
                            <small>{asset.role}</small>
                          </p>
                        </div>
                      ))}
                    </div>
                    {generationPreview.prompt_text && (
                      <details className="prompt-review">
                        <summary>查看完整提示词</summary>
                        <p>
                          这段内容由提示词 Skill
                          负责，任务包只负责绑定素材和提交参数。
                        </p>
                        <pre>{generationPreview.prompt_text}</pre>
                      </details>
                    )}
                    <div className="limit-note">
                      {generationPreview.provider === "runninghub_h3_multiref"
                        ? `RunningHub H3 预检会先核对余额、素材职责与当前清晰度；通过后上传上面列出的清晰素材，按 ${generationPreview.generation_count} 张任务卡各提交 1 次，失败不自动重试，全部返回后自动合成并交给你确认。`
                        : task.libtv_project_uuid
                          ? `专属画布“${task.libtv_project_name || task.title}”已就绪。点击下面按钮即代表同意上传以上 ${generationPreview.upload_assets.length} 项安全素材并执行一次生成；返回后由你决定采用或返工。`
                          : "专属 LibTV 画布尚未就绪，不能提交。"}
                    </div>
                    <button
                      type="button"
                      disabled={
                        loading ||
                        (generationPreview.provider !== "runninghub_h3_multiref" &&
                          !task.libtv_project_uuid)
                      }
                      onClick={onGenerateVideo}
                    >
                      {loading
                        ? "正在提交…"
                        : generationPreview.generation_kind === "full_sequence"
                          ? generationPreview.generation_count > 1 ? `并发生成 ${generationPreview.generation_count} 段完整版并自动合成` : `生成 ${generationPreview.duration_seconds} 秒完整版`
                          : "生成 4 秒动作小样"}
                    </button>
                  </>
                ) : (
                  !generationPackNeedsFourSecondRepair && (
                    <div className="limit-note">
                      当前任务包缺少新版确认信息，请先应用上面的选择。
                    </div>
                  )
                )}
              </div>
            )}
            {task.status === "running_video_generation" && (
              <div className="action-panel running-panel">
                <small>视频生成中</small>
                <h3>已提交一次，正在等待结果</h3>
                <p>{task.user_message}</p>
                <div className="privacy-line">
                  页面可以关闭；系统不会自动重试、追加或换模型。
                </div>
              </div>
            )}
            {task.status === "video_generation_completed" &&
              videoQcRejected && (
                <div className="action-panel error-panel">
                  <small>
                    {videoUserApproved
                      ? "视频已采用 · 历史质检提醒"
                      : "视频已返回 · 历史质检未通过"}
                  </small>
                  <h3>
                    {videoUserApproved
                      ? "你已选择采用这版"
                      : "请你观看后决定采用或返工"}
                  </h3>
                  <p>
                    {task.video_generation_result?.quality_qc?.user_message ||
                      task.video_generation_result?.quality_qc?.summary ||
                      "质检发现成片与已确认要求不一致。"}
                  </p>
                  {currentFullVideoArtifact && (
                    <div
                      className="artifact-viewer rejected-video-preview"
                      aria-label={`版本 ${currentFullVideoVersion} 完整视频`}
                    >
                      <div className="artifact-viewer-title">
                        <div>
                          <small>
                            {currentFullVideoVersion > 1
                              ? "当前合成版本 · 被替换的旧片段仍保留在版本库"
                              : "首次生成版本 · 尚未返工"}
                          </small>
                          <h3>{`版本 ${currentFullVideoVersion} 完整视频`}</h3>
                        </div>
                        <span className="video-version-badge">
                          {currentFullVideoVersion > 1 ? "当前版本" : "原始版本"}
                        </span>
                      </div>
                      <video
                        controls
                        preload="metadata"
                        src={`${API}/tasks/${task.id}/artifacts/${currentFullVideoArtifact.id}`}
                      >
                        <track kind="captions" srcLang="zh" label="字幕" />
                      </video>
                    </div>
                  )}
                  {videoUserApproved ? (
                    <div className="privacy-line approval-confirmed">
                      ✓ 你已采用当前完整视频；自动质检的历史提醒仍保留，旧版本也没有删除。
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={onApproveVideoResult}
                    >
                      满意，采用这个完整视频
                    </button>
                  )}
                  <div className="generation-spec-grid">
                    <div>
                      <span>实际积分</span>
                      <strong>
                        {task.video_generation_result?.points_used ??
                          "LibTV 未返回"}
                      </strong>
                      <small>
                        {task.video_generation_result?.points_used == null
                          ? "不显示为 0，避免误导"
                          : "本次真实消耗"}
                      </small>
                    </div>
                    <div>
                      <span>处理结果</span>
                      <strong>保留为失败证据</strong>
                      <small>没有自动重试</small>
                    </div>
                  </div>
                  {task.video_generation_result?.generation_kind ===
                    "full_sequence" && (
                      <VideoReworkPanel
                        task={task}
                        loading={loading}
                        onPrepare={onPrepareVideoRework}
                        onConfirm={onConfirmVideoRework}
                        onOpenCodex={() =>
                          onBindCodexTask("prepare_video_rework")
                        }
                      />
                    )}
                  <div className="privacy-line">
                    {videoUserApproved
                      ? "这版已列为可用成果；历史质检意见仅作提醒，不再替你做最终决定。"
                      : "历史质检意见仅作提醒；最终是否采用由你观看后决定。"}
                  </div>
                </div>
              )}
            {task.status === "video_generation_completed" &&
              !videoQcRejected && (
                <div className="action-panel success-panel">
                  <small>
                    {task.video_generation_result?.generation_kind ===
                    "full_sequence"
                      ? "完整版已返回"
                      : "4 秒动作小样已返回"}
                  </small>
                  <h3>
                    {videoUserApproved
                      ? "你已采用当前完整视频"
                      : "视频已经返回，请你观看确认"}
                  </h3>
                  <p>{task.user_message}</p>
                  {task.video_generation_result?.generation_kind ===
                    "full_sequence" && currentFullVideoArtifact && (
                    <div
                      className="artifact-viewer rejected-video-preview"
                      aria-label={`版本 ${currentFullVideoVersion} 完整视频`}
                    >
                      <div className="artifact-viewer-title">
                        <div>
                          <small>
                            {currentFullVideoVersion > 1
                              ? "当前合成版本 · 被替换的旧片段仍保留在版本库"
                              : "首次生成版本 · 三个独立片段也保留在下方"}
                          </small>
                          <h3>{`版本 ${currentFullVideoVersion} 完整视频`}</h3>
                        </div>
                        <span className="video-version-badge">
                          {currentFullVideoVersion > 1 ? "当前版本" : "原始版本"}
                        </span>
                      </div>
                      <video
                        controls
                        preload="metadata"
                        src={`${API}/tasks/${task.id}/artifacts/${currentFullVideoArtifact.id}`}
                      >
                        <track kind="captions" srcLang="zh" label="字幕" />
                      </video>
                    </div>
                  )}
                  {task.video_generation_result?.generation_kind ===
                    "full_sequence" &&
                    (videoUserApproved ? (
                      <div className="privacy-line approval-confirmed">
                        ✓ 你已采用当前完整视频，旧版本仍保留在版本库。
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={loading}
                        onClick={onApproveVideoResult}
                      >
                        满意，采用这个完整视频
                      </button>
                    ))}
                  <div className="generation-spec-grid">
                    <div>
                      <span>实际积分</span>
                      <strong>
                        {task.video_generation_result?.points_used ??
                          "LibTV 未返回"}
                      </strong>
                      <small>
                        {task.video_generation_result?.points_used == null
                          ? "不显示为 0，避免误导"
                          : "本次真实消耗"}
                      </small>
                    </div>
                    <div>
                      <span>本阶段提交</span>
                      <strong>
                        {task.video_generation_result?.generation_kind ===
                        "full_sequence"
                          ? `${task.full_video_generation_attempt_count} 次完整版`
                          : `${task.video_generation_attempt_count} 次小样`}
                      </strong>
                      <small>没有自动重试</small>
                    </div>
                  </div>
                  {task.video_generation_result?.generation_kind !==
                    "full_sequence" &&
                    task.full_video_generation_attempt_count === 0 && (
                      <>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={onPrepareFullVideo}
                        >
                          {loading
                            ? "正在准备…"
                            : `生成完整版（沿用 ${task.generation_model_snapshot?.alias_name || task.generation_model_key || "当前模型"}）`}
                        </button>
                        <div className="privacy-line">
                          现有小样会保留；先生成一份可核对的正式版确认单，再由工作台提交
                          1 次完整版，不自动重试。
                        </div>
                      </>
                    )}
                  {task.video_generation_result?.generation_kind ===
                    "full_sequence" && (
                      <VideoReworkPanel
                        task={task}
                        loading={loading}
                        onPrepare={onPrepareVideoRework}
                        onConfirm={onConfirmVideoRework}
                        onOpenCodex={() =>
                          onBindCodexTask("prepare_video_rework")
                        }
                      />
                    )}
                  <div className="privacy-line">
                    可以在下方“当前可用结果”或成果中心直接播放。
                  </div>
                </div>
              )}
            {task.status === "video_generation_failed" && (
              <div className="action-panel error-panel">
                <small>{task.video_generation_result?.external_request_started === true ? "视频返回中断" : "提交前检查已停止"}</small>
                <h3>{task.video_generation_result?.external_request_started === true ? "不会重新提交，只接回原任务" : "没有上传，也没有扣积分"}</h3>
                <p>{task.user_message}</p>
                {task.last_error && (
                  <div className="error-box">{task.last_error}</div>
                )}
                <button
                  type="button"
                  disabled={loading}
                  onClick={onResumeVideo}
                >
                  {loading ? "正在继续…" : task.video_generation_result?.external_request_started === true ? "接回已提交的视频" : "继续同一次提交前检查"}
                </button>
                <div className="privacy-line">
                  {task.video_generation_result?.external_request_started === true
                    ? "只读取原任务进度和结果，不会再次上传素材、重新生成或扣第二次积分。"
                    : "沿用原确认和当前任务包，不新增付费尝试；只有检查通过后才会上传并提交。"}
                </div>
              </div>
            )}
            {task.status === "generation_pack_blocked" && (
              <div className="action-panel error-panel">
                <small>生成资料还不完整</small>
                <h3>视频尚未提交，不会产生费用</h3>
                <p>{task.user_message}</p>
                {task.remix_precision_route === "prompt_driven_remix" &&
                task.rewrite_mode === "replace_product" &&
                task.product_assets_result?.approval_status !== "approved" ? (
                  <button type="button" disabled={loading} onClick={onPrepareProductAssets}>
                    {loading ? "正在整理…" : "用现有商品图整理干净参考"}
                  </button>
                ) : (
                  <>
                    <VideoGenerationSettings
                      models={videoModels}
                      route={generationRouteChoice}
                      modelKey={generationModelKey}
                      provider={videoGenerationProvider}
                      quality={videoQualityProfile}
                      onRouteChange={setGenerationRouteChoice}
                      onModelChange={setGenerationModelKey}
                      onProviderChange={setVideoGenerationProvider}
                      onQualityChange={setVideoQualityProfile}
                    />
                    <button
                      type="button"
                      disabled={loading || !selectedVideoModelAvailable}
                      onClick={() =>
                        onStartVideoGeneration(videoGenerationSelection)
                      }
                    >
                      {loading ? "正在检查…" : "按当前选择重新检查"}
                    </button>
                    {task.rewrite_mode === "replace_product" && (
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={loading}
                        onClick={onPrepareProductAssets}
                      >
                        重新整理产品参考
                      </button>
                    )}
                  </>
                )}
                <div className="privacy-line">
                  系统会先用现有成果解决能自动处理的问题；只有必须补图、上传或付费时才会询问你。
                </div>
              </div>
            )}
            {task.status === "video_prompt_blocked" && (
              <div className="action-panel error-panel">
                <small>视频提示词已停止</small>
                <h3>已有成果不受影响</h3>
                <p>{task.user_message}</p>
                {task.last_error && (
                  <div className="error-box">{task.last_error}</div>
                )}
                {task.contract_repair_full_video_authorized ? (
                  <>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={onValidateContractRepairFullVideo}
                    >
                      {loading ? "正在继续…" : "继续本次未消费验证"}
                    </button>
                    <div className="privacy-line">
                      沿用刚才的授权和次数；提示词通过后自动准备任务包，不会提交第二次验证。
                    </div>
                  </>
                ) : (
                  <>
                    {/服务范围|是否免费|业务承诺|逐字口播/.test(`${task.user_message || ""}\n${task.last_error || ""}`) && (
                      <fieldset className="setup-field">
                        <legend>按你提交的内容继续</legend>
                        <div className="notice-box">
                          工作台不审查、不删改参考片台词或你提交的文案，也不会擅自把人物改成静音。只会避免 AI 自己凭空添加新事实。
                        </div>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => onResolveVideoPrompt("preserve_source_content", "")}
                        >
                          {loading ? "正在继续…" : "保持原内容并继续"}
                        </button>
                      </fieldset>
                    )}
                    {task.remix_precision_route === "prompt_driven_remix" && (
                      <VideoGenerationSettings models={videoModels} route={generationRouteChoice} modelKey={generationModelKey} provider={videoGenerationProvider} quality={videoQualityProfile} onRouteChange={setGenerationRouteChoice} onModelChange={setGenerationModelKey} onProviderChange={setVideoGenerationProvider} onQualityChange={setVideoQualityProfile} />
                    )}
                    {!/服务范围|是否免费|业务承诺|逐字口播/.test(`${task.user_message || ""}\n${task.last_error || ""}`) && <button type="button" disabled={loading || (task.remix_precision_route === "prompt_driven_remix" && !selectedVideoModelAvailable)} onClick={() => onStartVideoPrompt(task.remix_precision_route === "prompt_driven_remix" ? videoGenerationSelection : undefined)}>
                      {loading ? "正在重新启动…" : "按当前选择重新编译并检查"}
                    </button>}
                  </>
                )}
              </div>
            )}
              </>
            )}
            {userFacingArtifacts(task).length > 0 && (
              <section className="drawer-section">
                <h3>当前可用结果</h3>
                {userFacingArtifacts(task).map((artifact) => (
                  <div className="artifact-line" key={artifact.id}>
                    <span>
                      {artifact.stage === "decomposition" ? "拆" : "文"}
                    </span>
                    <div>
                      <strong>{userArtifactLabel(artifact)}</strong>
                      <small title={artifact.path}>已保存 · 当前有效版本</small>
                    </div>
                  </div>
                ))}
              </section>
            )}
            <section className="drawer-section">
              <h3>任务记录</h3>
              <div className="event-log">
                {task.events.length ? (
                  task.events.map((event) => (
                    <div key={event.id} className={event.level}>
                      <i></i>
                      <div>
                        <strong>{userEventMessage(event)}</strong>
                        <time>{formatTime(event.created_at)}</time>
                      </div>
                    </div>
                  ))
                ) : (
                  <p>暂无记录</p>
                )}
              </div>
            </section>
          </div>
        </div>
      </aside>
      {packagePreview && (
        <ImageLightbox
          task={task}
          artifact={packagePreview}
          onClose={() => setPackagePreview(null)}
        />
      )}
      {storyboardPreview && (
        <ImageLightbox
          task={task}
          artifact={storyboardPreview}
          onClose={() => setStoryboardPreview(null)}
        />
      )}
      {personPreview && (
        <ImageLightbox
          task={task}
          artifact={personPreview}
          onClose={() => setPersonPreview(null)}
        />
      )}
    </div>
  );
}

function VideoReworkPanel({
  task,
  loading,
  onPrepare,
  onConfirm,
  onOpenCodex,
}: {
  task: Task;
  loading: boolean;
  onPrepare: (body: {
    selectedSegmentIds: string[];
    issueCodes: string[];
    note: string;
  }) => void;
  onConfirm: (selectedSegmentIds: string[]) => void;
  onOpenCodex: () => void;
}) {
  const preview = task.generation_pack_result?.submission_preview;
  const fallbackDurations = preview?.segment_durations_seconds?.length
    ? preview.segment_durations_seconds
    : [
        Number(
          preview?.duration_seconds ||
            task.video_generation_result?.duration_seconds ||
            0,
        ),
      ];
  const plan = task.video_rework_plan;
  const completedRework = plan?.status === "completed";
  const timeline = plan?.timeline_segments?.length
    ? plan.timeline_segments
    : fallbackDurations.map((duration, index) => ({
        segment_id: `segment_${String(index + 1).padStart(2, "0")}`,
        target_duration_seconds: Number(duration || 0),
        generated_duration_seconds: Number(duration || 0),
        start_seconds: fallbackDurations
          .slice(0, index)
          .reduce((sum, value) => sum + Number(value || 0), 0),
        end_seconds: fallbackDurations
          .slice(0, index + 1)
          .reduce((sum, value) => sum + Number(value || 0), 0),
      }));
  const formatPosition = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainder = Number((seconds % 60).toFixed(1));
    return `${minutes}:${remainder < 10 ? "0" : ""}${remainder}`;
  };
  const segments = timeline.map((timelineSegment, index) => {
    const versions = videoSegmentVersions(task, index + 1);
    const artifact = versions[0]?.artifact;
    const segmentPlan = plan?.segment_plans?.find(
      (item) => item.segment_id === timelineSegment.segment_id,
    );
    return {
      id: timelineSegment.segment_id,
      label: `第 ${index + 1} 段`,
      range: `${formatPosition(timelineSegment.start_seconds)}–${formatPosition(timelineSegment.end_seconds)}`,
      generatedDuration: timelineSegment.generated_duration_seconds,
      artifact,
      segmentPlan,
      versions,
      originLabel: artifact ? `当前合成 · 版本 ${versions[0].version}` : null,
    };
  });
  const saved = task.video_rework_request;
  const [selectedSegments, setSelectedSegments] = useState<string[]>(
    completedRework ? [] : saved?.selected_segment_ids || [],
  );
  const [issueCodes, setIssueCodes] = useState<string[]>(
    completedRework ? [] : saved?.issue_codes || [],
  );
  const [note, setNote] = useState(completedRework ? "" : saved?.note || "");
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSelectedSegments(completedRework ? [] : saved?.selected_segment_ids || []);
      setIssueCodes(completedRework ? [] : saved?.issue_codes || []);
      setNote(completedRework ? "" : saved?.note || "");
    });
    return () => { cancelled = true; };
    // The request timestamp is the stable identity; payload arrays are recreated by polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedRework, saved?.created_at]);
  const issueOptions = [
    ["missing_or_wrong_shot", "镜头缺失或顺序不对"],
    ["person_or_outfit", "人物或穿搭不一致"],
    ["motion_or_expression", "动作、表情不自然"],
    ["composition_or_clarity", "构图、比例或清晰度有问题"],
    ["random_retry", "内容基本正确，想重新抽一次"],
    ["other", "其他问题"],
  ] as const;
  const toggle = (values: string[], value: string, setter: (next: string[]) => void) =>
    setter(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  const selectedCount = selectedSegments.length;
  const preservedCount = Math.max(segments.length - selectedCount, 0);
  const canSave = selectedCount > 0 && (issueCodes.length > 0 || note.trim().length > 0);
  const directRetry = issueCodes.length === 1 && issueCodes[0] === "random_retry";
  const isSavedSelection = Boolean(
    saved &&
      JSON.stringify([...selectedSegments].sort()) ===
        JSON.stringify([...(saved.selected_segment_ids || [])].sort()) &&
      JSON.stringify([...issueCodes].sort()) ===
        JSON.stringify([...(saved.issue_codes || [])].sort()) &&
      note.trim() === (saved.note || "").trim(),
  );
  return (
    <section className="video-rework-panel" aria-label="调整并重新生成">
      <div className="video-rework-heading">
        <small>对结果不满意？</small>
        <h3>只告诉系统哪一段有问题</h3>
        <p>
          不需要先判断是提示词、模型还是素材出了问题。系统会保留没选中的片段，具体怎么修交给项目 Codex 任务和对应 Skill 判断。
        </p>
      </div>
      <div className="video-rework-section">
        <strong>1. 逐段播放，再选择不满意的片段</strong>
        <div className="video-rework-segments">
          {segments.map((segment) => {
            const selected = selectedSegments.includes(segment.id);
            return (
              <article key={segment.id} className={selected ? "selected" : ""}>
                <div className="video-rework-segment-title">
                  <div>
                    <div className="video-rework-segment-label">
                      <strong>{segment.label}</strong>
                      {segment.originLabel && (
                        <em
                          className={
                            "new"
                          }
                        >
                          {segment.originLabel}
                        </em>
                      )}
                    </div>
                    <small>成片位置 {segment.range} · 原片段约 {segment.generatedDuration} 秒</small>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggle(selectedSegments, segment.id, setSelectedSegments)}
                    />
                    {selected ? "已选中返工" : "这段不满意"}
                  </label>
                </div>
                {segment.artifact ? (
                  <video
                    controls
                    preload="metadata"
                    src={`${API}/tasks/${task.id}/artifacts/${segment.artifact.id}`}
                  >
                    <track kind="captions" srcLang="zh" label="字幕" />
                  </video>
                ) : (
                  <div className="video-rework-missing">这个独立片段暂时无法播放，请先不要凭编号选择。</div>
                )}
                {segment.versions.length > 0 && (
                  <details className="video-rework-history">
                    <summary>查看这段的全部版本（{segment.versions.length}）</summary>
                    <div>
                      {segment.versions.map((versionItem, versionIndex) => (
                        <article key={versionItem.artifact.id}>
                          <strong>
                            版本 {versionItem.version}
                            {versionIndex === 0 ? " · 当前合成使用" : " · 历史备选"}
                          </strong>
                          <video
                            controls
                            preload="metadata"
                            src={`${API}/tasks/${task.id}/artifacts/${versionItem.artifact.id}`}
                          >
                            <track kind="captions" srcLang="zh" label="字幕" />
                          </video>
                        </article>
                      ))}
                    </div>
                  </details>
                )}
                <p>
                  {segment.segmentPlan?.root_fix
                    ? `${completedRework ? "本次修法：" : ""}${segment.segmentPlan.root_fix}`
                    : selected
                      ? "等待 Codex 分析这段需要怎样调整。"
                      : completedRework
                        ? `这段未重新生成，当前合成继续使用版本 ${segment.versions[0]?.version || 1}。`
                        : "当前保留，不会重新生成。"}
                </p>
              </article>
            );
          })}
        </div>
      </div>
      <div className="video-rework-section">
        <strong>2. 你看到的问题</strong>
        <div className="video-rework-issues">
          {issueOptions.map(([code, label]) => (
            <label key={code} className={issueCodes.includes(code) ? "selected" : ""}>
              <input
                type="checkbox"
                checked={issueCodes.includes(code)}
                onChange={() => toggle(issueCodes, code, setIssueCodes)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="可选：例如‘第 1 段没有拍到托腮动作，第 3 段结尾缺少空镜’"
          maxLength={800}
        />
      </div>
      <div className="video-rework-summary">
        <div><span>将重做</span><strong>{selectedCount || "尚未选择"}{selectedCount ? " 段" : ""}</strong></div>
        <div><span>继续保留</span><strong>{preservedCount} 段</strong></div>
        <div><span>当前操作</span><strong>{directRetry ? "直接重新生成" : "保存返工要求"}</strong></div>
      </div>
      <button
        type="button"
        disabled={loading || !canSave}
        onClick={() => onPrepare({ selectedSegmentIds: selectedSegments, issueCodes, note })}
      >
        {loading
          ? "正在保存…"
          : directRetry
            ? "准备直接重新生成"
          : completedRework
            ? "保存新的返工要求"
            : saved
              ? "更新返工要求"
              : "保存返工要求"}
      </button>
      {plan?.status === "ready_for_confirmation" && isSavedSelection ? (
        <div className="video-rework-plan">
          {plan.last_failure_after_submission && (
            <div className="error-box">
              新片段已经生成，但本地重新合成没有完成。旧版本和新片段都已保留；再次继续只恢复本地合成，不会重新提交。
            </div>
          )}
          <small>{plan.mode === "direct_retry" ? "直接重新生成已准备" : "返工方案已准备"}</small>
          <h3>
            {plan.mode === "direct_retry" ? "不改提示词，" : ""}
            {plan.preserved_segment_ids.length > 0
              ? `保留第 ${plan.preserved_segment_ids.map((id) => Number(id.slice(-2))).join("、")} 段，只重做第 ${plan.selected_segment_ids.map((id) => Number(id.slice(-2))).join("、")} 段`
              : `只重做第 ${plan.selected_segment_ids.map((id) => Number(id.slice(-2))).join("、")} 段`}
          </h3>
          <div className="video-rework-plan-meta">
            <span>通道：RunningHub H3</span>
            <span>清晰度：{plan.quality_profile === "high" ? "高清" : plan.quality_profile === "ultra" ? "超清" : "普通"}</span>
            <span>预计提交：{plan.estimated_submission_count} 次</span>
            <span>自动重试：关闭</span>
          </div>
          {plan.segment_plans.map((segmentPlan) => (
            <details key={segmentPlan.segment_id}>
              <summary>
                {plan.mode === "direct_retry" ? "沿用第 " : "第 "}{Number(segmentPlan.segment_id.slice(-2))} 段{plan.mode === "direct_retry" ? "当前任务卡" : "怎么调整"}
                <em>{reworkCostLabel(segmentPlan.estimated_cost_rh_coins)}</em>
              </summary>
              <p>{segmentPlan.root_fix}</p>
              <strong>实际上传顺序</strong>
              <ol>
                {segmentPlan.upload_assets.map((asset) => (
                  <li key={`${segmentPlan.segment_id}-${asset.image_index}`}>
                    图片 {asset.image_index}：{asset.alias.replace(/^@/, "")}
                  </li>
                ))}
              </ol>
              <strong>本段生成重点</strong>
              <p>{segmentPlan.prompt_summary}</p>
            </details>
          ))}
          <div className="video-rework-version-note">
            生成完成后建立“版本 {plan.version_contract.next_version}”并用于新的合成；版本 1 到版本 {plan.version_contract.next_version - 1} 的完整视频和独立片段全部保留。
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => onConfirm(plan.selected_segment_ids)}
          >
            {loading
              ? "正在处理…"
              : plan.last_failure_after_submission
                ? "恢复本地合成（不重复提交）"
                : plan.mode === "direct_retry"
                  ? `确认并直接重抽 ${plan.estimated_submission_count} 段`
                  : `确认并重新生成 ${plan.estimated_submission_count} 段`}
          </button>
        </div>
      ) : saved?.status === "prepared" && isSavedSelection ? (
        <div className="video-rework-handoff">
          <div>
            <small>返工要求已登记</small>
            <strong>打开原项目任务，继续返工</strong>
            <span>
              返工要求已经写进项目资料。打开后回复“继续返工”，Codex 会先核对原通道、模型和素材，再给出提交次数；不会直接生成。
            </span>
          </div>
          <button type="button" disabled={loading} onClick={onOpenCodex}>
            {loading ? "正在打开…" : "打开 Codex 继续返工 →"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CodexTaskLink({
  task,
  loading,
  onBind,
}: {
  task: Task;
  loading: boolean;
  onBind: (intent?: "execute_project") => void;
}) {
  // A recovered project may retain its previous handoff as audit history. Once
  // execution has resumed, that old recovery card must not compete with the
  // live "正在处理" state or suggest that the user still needs to intervene.
  const handoff = task.status.startsWith("running_")
    ? null
    : task.workflow_handoff;
  const handoffCopy = handoff
    ? workflowHandoffCopy(handoff.outcome.state)
    : null;
  if (
    task.codex_thread_id &&
    task.codex_thread_initialized_at &&
    task.codex_thread_status === "ready"
  )
    return (
      <section className="codex-task-link ready">
        <div>
          <small>{handoffCopy?.label || (task.planned_execution_authorized ? "项目任务已就绪" : "需要判断、修改或继续制作？")}</small>
          <strong>{handoffCopy?.headline || (task.planned_execution_authorized ? "查看项目 Codex 任务" : "打开项目 Codex 任务")}</strong>
          <span>
            {handoffCopy?.detail || (task.planned_execution_authorized
              ? "项目已按创建页登记的路线和授权执行；这里用于查看本轮记录，进度与成果仍以工作台为准。"
              : "Codex 会读取工作台里的最新资料和成果，再调用正式 Skill 从当前断点继续。")}
          </span>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() =>
            onBind(task.execution_owner === "project_codex_task" ? "execute_project" : undefined)
          }
        >
          {loading ? "正在打开…" : "打开项目任务 →"}
        </button>
      </section>
    );
  if (task.codex_thread_status === "connecting")
    return (
      <section className="codex-task-link connecting">
        <div>
          <small>正在进入项目任务</small>
          <strong>{handoff ? "正在从当前断点继续制作" : "正在建立项目任务"}</strong>
          <span>
            {handoff
              ? "项目任务会读取现有资料并调用正式 Skill；需要新增上传或产生费用时才会停下来确认。"
              : task.planned_execution_authorized
                ? "已按创建页登记的路线、素材和次数授权启动制作；只有超出原范围时才会暂停。"
                : "会发送一条精简项目交接；不会开始拆解、上传素材或产生外部费用。"}
          </span>
        </div>
      </section>
    );
  if (task.codex_thread_status === "running")
    return (
      <section className="codex-task-link connecting">
        <div>
          <small>正在后台执行</small>
          <strong>项目任务正在继续制作</strong>
          <span>
            进度和成果会持续回到工作台。任务完成或需要你处理后，才会开放“打开项目任务”，避免同一任务被两个窗口同时占用。
          </span>
        </div>
      </section>
    );
  return (
    <section className={`codex-task-link ${task.codex_thread_status === "ready" ? "ready" : "failed"}`}>
      <div>
        <small>{handoffCopy?.label || "需要判断、修改或继续制作？"}</small>
        <strong>
          {task.codex_thread_status === "failed"
            ? "项目已保存，Codex 暂未连接"
            : handoffCopy?.headline || "在 Codex 中继续这个项目"}
        </strong>
        <span>
          {task.codex_thread_status === "ready" && handoffCopy
            ? handoffCopy.detail
            : "首次点击会创建可见任务并发送一条精简项目交接，使用少量 Token；不会自动开始制作。"}
        </span>
      </div>
      <button
        type="button"
        disabled={loading}
        onClick={() =>
          onBind(task.execution_owner === "project_codex_task" ? "execute_project" : undefined)
        }
      >
        {loading
          ? "正在打开…"
          : task.codex_thread_status === "failed"
            ? "重新连接并打开"
            : task.codex_thread_status === "ready" && handoff
              ? "打开项目 Codex 任务 →"
              : "在 Codex 中继续 →"}
      </button>
    </section>
  );
}

function workflowHandoffCopy(state: WorkflowHandoff["outcome"]["state"]) {
  if (state === "failed_after_submit")
    return {
      label: "已提交，等待接回",
      headline: "不会重新生成，只接回原任务",
      detail: "远程提交记录已经一起交接。打开后只核对同一次请求，不会重复扣费。",
    };
  if (state === "blocked_external")
    return {
      label: "外部条件待恢复",
      headline: "项目资料已保存，恢复条件后继续",
      detail: "缺失条件和当前进度已经交接；不会自动重试或擅自换通道。",
    };
  if (state === "needs_user_choice")
    return {
      label: "等你决定",
      headline: "当前成果和可选路线已交接",
      detail: "打开项目任务即可继续判断，不会自动上传、生成或扣费。",
    };
  return {
    label: "提交前已停止",
    headline: "没有重复提交，问题已转入项目任务",
    detail: "当前步骤、Skill 版本和本地证据已一起交接；打开后从原步骤修复，不必重做前面的成果。",
  };
}

function ProjectFacts({ task }: { task: Task }) {
  const facts = [
    [
      "制作偏好",
      task.remix_precision_route === "prompt_driven_remix"
        ? "只借思路快速生成"
        : "尽量像原片",
    ],
    [
      "产品",
      task.rewrite_mode === "replace_product"
        ? "换成我的产品"
        : task.rewrite_mode === "exact_original"
          ? "精确还原原款"
          : "不换产品",
    ],
    ...(task.rewrite_mode === "replace_product"
      ? [[
          "产品范围",
          task.product_scope === "full_look"
            ? "整套穿搭"
            : task.product_scope === "top_only"
              ? "只换上衣"
              : task.product_scope === "bottom_only"
                ? "只换下装"
                : task.product_scope === "custom"
                  ? "单个或其他产品"
                  : "待明确",
        ]]
      : []),
    [
      "出镜人物",
      task.person_route === "authorized_person"
        ? "本人或授权人物"
        : task.person_route === "generic_no_fixed_face"
          ? "不固定人物"
          : "AI 创建人物",
    ],
    [
      "场景处理",
      task.remix_change_contract?.scene.mode === "auto_match"
        ? "由 AI 自动匹配"
        : task.remix_change_contract?.scene.mode === "user_location"
          ? "使用我的店铺或场地"
          : task.remix_change_contract?.scene.mode === "described_scene"
            ? "换成指定场景"
            : "保留相近场景",
    ],
    [
      "内容脚本",
      task.remix_change_contract?.script.mode === "auto_rewrite"
        ? "按资料自动改写"
        : task.remix_change_contract?.script.mode === "partial_adjustment"
          ? "只修改指定部分"
          : task.remix_change_contract?.script.mode === "use_own_copy"
            ? "使用我写好的内容"
            : "保留原结构",
    ],
    [
      "默认生图",
      task.default_image_generation_provider === "chatgpt_web"
        ? "ChatGPT 网页"
        : "Codex 内置",
    ],
    [
      "视频方案",
      task.generation_model_snapshot?.model_name ||
        task.generation_model_key ||
        `${task.generation_provider === "runninghub_h3_multiref" ? "RunningHub H3" : "LibTV / Seedance"} · ${task.generation_quality_profile === "ultra" ? "超清" : task.generation_quality_profile === "normal" ? "普通" : "高清"}`,
    ],
  ];
  return (
    <section className="project-facts">
      <div className="project-facts-title">
        <div>
          <small>项目设置</small>
          <strong>这条视频会怎么改</strong>
        </div>
        <span>需要调整时，在项目 Codex 任务里说明即可</span>
      </div>
      <div>
        {facts.map(([label, value]) => (
          <article key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function VideoGenerationSettings({
  models,
  route,
  modelKey,
  provider,
  quality,
  onRouteChange,
  onModelChange,
  onProviderChange,
  onQualityChange,
}: {
  models: VideoModelOption[];
  route: VideoGenerationSelection["generationRouteChoice"];
  modelKey: string;
  provider: VideoGenerationSelection["generationProvider"];
  quality: VideoGenerationSelection["qualityProfile"];
  onRouteChange: (
    route: VideoGenerationSelection["generationRouteChoice"],
  ) => void;
  onModelChange: (modelKey: string) => void;
  onProviderChange: (
    provider: VideoGenerationSelection["generationProvider"],
  ) => void;
  onQualityChange: (
    quality: VideoGenerationSelection["qualityProfile"],
  ) => void;
}) {
  const order = [
    "star-video2-mini",
    "star-video2-fast",
    "star-video2",
    "star-video2.5",
  ];
  const sorted = [...models].sort(
    (a, b) => order.indexOf(a.model_key) - order.indexOf(b.model_key),
  );
  return (
    <section
      className="video-generation-settings"
      aria-label="本次视频生成设置"
    >
      <div className="generation-setting-heading">
        <strong>生成方式</strong>
        <span>只影响这一次</span>
      </div>
      <div className="generation-route-options">
        <button
          type="button"
          className={route === "smoke_test_first" ? "selected" : ""}
          onClick={() => onRouteChange("smoke_test_first")}
        >
          <strong>先做 4 秒验证</strong>
          <span>先测最容易出问题的动作，再决定是否生成正式版</span>
        </button>
        <button
          type="button"
          className={route === "in_chat_libtv_generation" ? "selected" : ""}
          onClick={() => onRouteChange("in_chat_libtv_generation")}
        >
          <strong>直接生成正式版</strong>
          <span>跳过小样，按当前视频完整时长准备一次正式生成</span>
        </button>
      </div>
      <div className="generation-setting-heading">
        <strong>从哪里生成</strong>
        <span>不同通道会自动匹配正确素材</span>
      </div>
      <div className="generation-route-options">
        <button
          type="button"
          className={provider === "libtv" ? "selected" : ""}
          onClick={() => onProviderChange("libtv")}
        >
          <strong>LibTV / Seedance（推荐）</strong>
          <span>固定人物脸会使用红线安全版与局部材质图，当前正式路线</span>
        </button>
        <button
          type="button"
          className={provider === "runninghub_h3_multiref" ? "selected" : ""}
          onClick={() => onProviderChange("runninghub_h3_multiref")}
        >
          <strong>RunningHub H3（实验）</strong>
          <span>使用清晰人物、分镜与材质参考，不上传红线或网格图</span>
        </button>
      </div>
      <div className="generation-setting-heading">
        <strong>画面清晰度</strong>
        <span>普通更省，人物越小越建议提高清晰度</span>
      </div>
      <div className="generation-route-options quality-options" aria-label="画面清晰度">
        {([
          ["normal", "普通", "人物靠近镜头、画面占比较高"],
          ["high", "高清", "半身露手等日常画面，默认推荐"],
          ["ultra", "超清", "人物离镜头较远或细节要求更高"],
        ] as const).map(([value, label, description]) => (
          <button
            type="button"
            key={value}
            className={quality === value ? "selected" : ""}
            onClick={() => onQualityChange(value)}
          >
            <strong>{label}</strong>
            <span>{description}</span>
          </button>
        ))}
      </div>
      <div className="generation-setting-heading">
        <strong>{provider === "libtv" ? "本次生成模型" : "本次通道模型"}</strong>
        <span>系统不会擅自换模型</span>
      </div>
      {provider === "runninghub_h3_multiref" ? (
        <div className="limit-note selected-provider-note">
          <strong>MiniMax H3 多参考图</strong>
          <span>最多使用 3 张本次真正需要的清晰参考图；当前属于个人实验通道。</span>
        </div>
      ) : sorted.length ? (
        <div className="video-model-options" aria-label="本次生成模型">
          {sorted.map((model) => (
            <button
              type="button"
              key={model.model_key}
              className={modelKey === model.model_key ? "selected" : ""}
              onClick={() => onModelChange(model.model_key)}
            >
              <div>
                <strong>{model.alias_name}</strong>
                {model.model_key === "star-video2" && <em>稳妥推荐</em>}
              </div>
              <span>
                {videoModelPromise(model.model_key, model.description)}
              </span>
              <small>
                最长 {model.duration_max} 秒 ·{" "}
                {model.resolutions
                  .map((item) => item.toUpperCase())
                  .join(" / ")}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <div className="limit-note">
          正在读取 LibTV 当前可用模型；如果持续没有出现，请确认 LibTV
          已登录后刷新。
        </div>
      )}
    </section>
  );
}

function videoModelPromise(modelKey: string, fallback: string) {
  if (modelKey === "star-video2-mini") return "成本更友好，适合普通镜头";
  if (modelKey === "star-video2-fast") return "速度优先，适合快速出片";
  if (modelKey === "star-video2") return "质量与清晰度优先";
  if (modelKey === "star-video2.5") return "复杂动作、长视频和多参考素材";
  return fallback;
}

function ImageLightbox({
  task,
  artifact,
  onClose,
}: {
  task: Task;
  artifact: Artifact;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`放大查看${artifact.label}`}
    >
      <button
        type="button"
        className="image-lightbox-backdrop"
        aria-label="关闭放大预览"
        onClick={onClose}
      ></button>
      <div className="image-lightbox-panel">
        <div>
          <strong>{artifact.label}</strong>
          <span>可滚动查看原图细节</span>
        </div>
        <button
          type="button"
          className="image-lightbox-close"
          onClick={onClose}
          aria-label="关闭放大预览"
        >
          ×
        </button>
        <Image
          src={`${API}/tasks/${task.id}/artifacts/${artifact.id}?v=${task.updated_at}`}
          width={1800}
          height={1800}
          unoptimized
          alt={artifact.label}
        />
      </div>
    </div>
  );
}

function ProjectProviderDefault({
  task,
  capabilities,
  loading,
  onChange,
}: {
  task: Task;
  capabilities: ProviderCapabilities;
  loading: boolean;
  onChange: (provider: GenerationProvider) => void;
}) {
  const current = task.default_image_generation_provider || "codex_builtin";
  return (
    <section className="project-provider-default" aria-label="默认在哪里生图">
      <div>
        <small>默认在哪里生图</small>
        <strong>
          {current === "chatgpt_web" ? "ChatGPT 网页生图" : "Codex 内置生图"}
        </strong>
        <span>后续生图先使用这个选择，每次生成前仍可临时切换。</span>
      </div>
      <div className="provider-default-actions">
        <button
          type="button"
          className={current === "codex_builtin" ? "selected" : ""}
          disabled={loading || current === "codex_builtin" || !capabilities.codexBuiltinAvailable}
          onClick={() => onChange("codex_builtin")}
        >
          设为 Codex
        </button>
        <button
          type="button"
          className={current === "chatgpt_web" ? "selected" : ""}
          disabled={
            loading ||
            current === "chatgpt_web" ||
            !capabilities.chatgptWebAvailable
          }
          onClick={() => onChange("chatgpt_web")}
        >
          设为 ChatGPT
        </button>
      </div>
      {current === "chatgpt_web" && !capabilities.chatgptWebAvailable && (
        <p>
          默认选择已保留，但 ChatGPT
          生图当前不可用；恢复连接后可继续，也可以临时选择 Codex。
        </p>
      )}
      {current === "codex_builtin" && !capabilities.codexBuiltinAvailable && (
        <p>{capabilities.codexBuiltinMessage} 请改用 ChatGPT 网页生图。</p>
      )}
    </section>
  );
}

function ProviderOptions({
  value,
  defaultValue,
  capabilities,
  onChange,
}: {
  value: GenerationProvider;
  defaultValue: GenerationProvider;
  capabilities: ProviderCapabilities;
  onChange: (provider: GenerationProvider) => void;
}) {
  return (
    <>
      <div className="provider-heading">
        <strong>这一次在哪里生图</strong>
        <span>{value === defaultValue ? "使用默认选择" : "只改这一次"}</span>
      </div>
      <div className="provider-options" aria-label="这一次在哪里生图">
        <button
          type="button"
          disabled={!capabilities.codexBuiltinAvailable}
          className={value === "codex_builtin" ? "selected" : ""}
          onClick={() => onChange("codex_builtin")}
        >
          <strong>Codex 内置生图</strong>
          <span>{capabilities.codexBuiltinAvailable ? "生成后自动返回工作台" : capabilities.codexBuiltinMessage}</span>
        </button>
        <button
          type="button"
          disabled={!capabilities.chatgptWebAvailable}
          className={value === "chatgpt_web" ? "selected" : ""}
          onClick={() => onChange("chatgpt_web")}
        >
          <strong>ChatGPT 网页生图（实验）</strong>
          <span>{chatGPTProviderDescription(capabilities)}</span>
        </button>
      </div>
    </>
  );
}

function GenerationConsent({
  stage,
  task,
  provider,
  capabilities,
  checked,
  onChange,
}: {
  stage: "person" | "storyboard";
  task?: Task;
  provider: GenerationProvider;
  capabilities: ProviderCapabilities;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const target = stage === "person" ? "人物候选" : "目标宫格分镜";
  const sceneCount = task?.remix_change_contract?.scene?.image_paths?.length || 0;
  const productCount = task?.remix_change_contract?.product?.mode === "replace_product"
    ? (task.remix_change_contract?.product?.image_paths?.length || task.product_image_paths?.length || 0)
    : 0;
  const storyboardReferences = [
    "必要原片锚帧",
    "已确认人物母版",
    sceneCount ? `你提供的 ${sceneCount} 张场景图` : "",
    productCount ? `你提供的 ${productCount} 张产品图` : "",
  ].filter(Boolean).join("、");
  const consent =
    provider === "chatgpt_web"
      ? capabilities.chatgptWebMode === "simulation"
        ? `我同意在正式联调时把本次内部生图请求列出的必要参考图交给 ChatGPT 网页；当前模拟测试不会真实上传。`
        : stage === "storyboard"
          ? `我同意把${storyboardReferences}交给 ChatGPT 网页伴侣，仅用于本次${target}及一次客观比例纠正；不上传完整视频或清单外素材。`
          : `我同意把本次内部生图请求逐张列出的必要参考图交给 ChatGPT 网页伴侣，仅用于本次${target}；不上传清单之外的图片。`
      : stage === "person"
        ? "我同意把本任务最多 5 张必要人物关键帧交给内置生图工具，仅用于发型、体态、动作气质和手机质感参考；不上传产品图或其他文件。"
        : `我同意把${storyboardReferences}交给 Codex 内置生图，仅用于这 1 张目标宫格分镜；不上传完整视频或清单外素材。`;
  const executionNote =
    stage === "storyboard" && provider === "chatgpt_web"
      ? "先生成 1 张；若只因整张画布比例失败，系统自动纠正 1 次，最多产生 2 张，不会因审美或其他问题重复生成。"
      : "只生成 1 张候选，不自动重试。";
  return (
    <>
      <label className="check-line consent-box">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {consent}
          {stage === "storyboard" && provider === "chatgpt_web"
            ? " 我也同意首图仅在客观画布比例失败时自动纠正一次。"
            : ""}
        </span>
      </label>
      <div className="privacy-line">
        {executionNote}
        {provider === "chatgpt_web"
          ? chatGPTUsage(capabilities)
          : "不产生外部 API 现金费用，但会使用当前 ChatGPT / Codex 生图额度。"}
      </div>
    </>
  );
}

function PersonRouteForm({
  loading,
  route,
  brief,
  authorization,
  onRoute,
  onBrief,
  onAuthorization,
  onSubmit,
}: {
  loading: boolean;
  route: Task["person_route"];
  brief: string;
  authorization: boolean;
  onRoute: (value: NonNullable<Task["person_route"]>) => void;
  onBrief: (value: string) => void;
  onAuthorization: (value: boolean) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="route-form">
      <div className="route-options">
        <button
          type="button"
          className={route === "auto_ai_person" ? "selected" : ""}
          onClick={() => onRoute("auto_ai_person")}
        >
          <strong>AI 自动创建新人物（推荐）</strong>
          <span>创建新的虚构人物，不复制原片真人脸</span>
        </button>
        <button
          type="button"
          className={route === "authorized_person" ? "selected" : ""}
          onClick={() => onRoute("authorized_person")}
        >
          <strong>使用本人 / 已授权人物</strong>
          <span>这里只登记路线，照片将在正式人物环节单独确认</span>
        </button>
        <button
          type="button"
          className={route === "generic_no_fixed_face" ? "selected" : ""}
          onClick={() => onRoute("generic_no_fixed_face")}
        >
          <strong>不固定脸临时角色</strong>
          <span>更快，但跨镜头人物一致性较弱</span>
        </button>
      </div>
      <label>
        <span>人物要求（可选）</span>
        <textarea
          value={brief}
          onChange={(event) => onBrief(event.target.value)}
          maxLength={2000}
          placeholder="例如：25～30 岁、自然素人感、长卷发、手机随拍质感"
        ></textarea>
      </label>
      {route === "authorized_person" && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={authorization}
            onChange={(event) => onAuthorization(event.target.checked)}
          />
          <span>我确认本人同意，或已取得该人物授权</span>
        </label>
      )}
      <div className="privacy-line">
        本轮只把选择和文字要求保存在本机，不上传照片、不生图、不产生费用。
      </div>
      <button
        type="button"
        disabled={
          loading || !route || (route === "authorized_person" && !authorization)
        }
        onClick={onSubmit}
      >
        {loading ? "正在保存…" : "保存人物路线"}
      </button>
    </div>
  );
}

function personRouteHeading(route: Task["person_route"]) {
  if (route === "auto_ai_person") return "人物路线已保存，请选择生图方式";
  if (route === "authorized_person") return "授权人物路线已登记，等待补充照片";
  return "临时角色路线已登记，无需单独生成人物";
}

function personRouteDescription(route: Task["person_route"]) {
  if (route === "auto_ai_person")
    return "系统将依据原片人物气质和手机画面感，创建一名新的虚构人物，不复制原片真人脸。";
  if (route === "authorized_person")
    return "系统已保存人物授权状态和文字要求；照片会在正式人物资产环节另行确认。";
  return "后续视频生成时使用不固定脸的临时角色，速度更快，但跨镜头一致性会更弱。";
}

function chatGPTProviderDescription(capabilities: ProviderCapabilities) {
  if (capabilities.chatgptWebMode === "simulation")
    return "模拟上传、生成、下载和回传；不操作真实账号";
  if (capabilities.chatgptWebAvailable)
    return "浏览器伴侣已连接，可复用同一 Chrome 的 ChatGPT 登录状态";
  return capabilities.chatgptWebMessage;
}

function chatGPTUsage(capabilities: ProviderCapabilities) {
  if (capabilities.chatgptWebMode === "simulation")
    return "当前只运行模拟网页桥，不读取登录态、不使用套餐额度。";
  return "使用当前 Chrome 中的 ChatGPT 网页额度；提交前检查登录和输入区，提交后状态不明时不会自动再发一次。";
}

function chatGPTButtonLabel(capabilities: ProviderCapabilities) {
  return capabilities.chatgptWebMode === "simulation"
    ? "模拟 ChatGPT 网页生成"
    : "交给 ChatGPT 生成 1 张";
}

function TaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button className="task-row" onClick={onClick}>
      <span className="file-icon">影</span>
      <span className="task-main">
        <strong>{task.title}</strong>
        <small>{taskUserState(task).headline}</small>
      </span>
      <Status task={task} />
      <time>{formatTime(task.updated_at)}</time>
      <span className="row-arrow">›</span>
    </button>
  );
}

function Status({ task }: { task: Task }) {
  const info = taskUserState(task);
  return (
    <span className={`status ${info.tone}`}>
      <i></i>
      {info.label}
    </span>
  );
}

function taskUserState(task: Task): UserState {
  if (task.user_state) return task.user_state;
  const info = statusInfo[task.status] || statusInfo.draft;
  const processing = task.status.startsWith("running_");
  const assistance = /failed|blocked|interrupted/.test(task.status);
  return {
    key: processing ? "processing" : assistance ? "assistance" : "confirmation",
    label: processing ? "正在处理" : assistance ? "需要处理" : "等你确认",
    tone: processing ? "running" : assistance ? "error" : info.tone,
    headline: info.hint,
    summary:
      /clean-image|route receipt|task_root|A（推荐）|\bready route\b/i.test(
        task.user_message || "",
      )
        ? "当前步骤的运行条件没有对齐，已有成果已保留，也没有自动重试。"
        : task.user_message || info.hint,
    next_step: assistance
      ? "查看当前说明和已有成果；需要判断或修复时，在对应 Codex 任务中继续。"
      : processing
        ? "暂时不用操作；完成或需要确认时会在这里说明。"
        : "查看当前结果和主按钮，确认后继续。",
    needs_attention: !processing,
  };
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <span>＋</span>
      <h3>还没有爆款重构项目</h3>
      <p>上传一条想参考的视频，开始做成你的版本。</p>
      <button onClick={onCreate}>开始爆款重构</button>
    </div>
  );
}

function currentStepIndex(task: Task) {
  if (task.runtime_generation?.status === "generation_completed")
    return steps.length;
  if (
    ["preflight_running", "preflight_passed", "generation_running", "generation_failed"].includes(
      task.runtime_generation?.status || "",
    )
  )
    return steps.length - 1;
  if (task.status === "person_inputs_ready") return 5;
  if (
    ["running_person_generation", "person_generation_failed"].includes(
      task.status,
    )
  )
    return 6;
  if (task.status === "person_review") return 7;
  if (["running_product_assets", "product_assets_review", "product_assets_blocked"].includes(task.status)) return 8;
  if (task.status === "person_approved") return 8;
  if (task.status === "storyboard_inputs_ready") return 9;
  if (
    ["running_storyboard_generation", "storyboard_generation_failed"].includes(
      task.status,
    )
  )
    return 9;
  if (task.status === "storyboard_review") return 10;
  if (task.status === "storyboard_approved") return 11;
  if (
    ["running_motion_preflight", "motion_preflight_blocked"].includes(
      task.status,
    )
  )
    return 11;
  if (task.status === "motion_preflight_ready") return 12;
  if (["running_video_prompt", "video_prompt_blocked"].includes(task.status))
    return 12;
  if (task.status === "video_prompt_ready") return 13;
  if (
    [
      "person_package_required",
      "running_person_package",
      "person_package_review",
      "person_package_failed",
    ].includes(task.status)
  )
    return 13;
  if (
    ["running_generation_pack", "generation_pack_blocked"].includes(task.status)
  )
    return 14;
  if (task.status === "generation_pack_ready") return 15;
  if (
    [
      "running_video_generation",
      "video_generation_completed",
      "video_generation_failed",
    ].includes(task.status)
  )
    return 16;
  if (task.status === "completed") return 5;
  if (task.status === "running_rewrite" || task.current_step === "rewrite")
    return 3;
  if (task.status === "awaiting_confirmation") return 2;
  if (
    task.status === "running_decomposition" ||
    task.current_step === "decomposition"
  )
    return 1;
  return 0;
}

function quickRouteStepCopy(step: (typeof steps)[number]) {
  if (step.id === "person_review")
    return {
      title: "确认人物形象",
      description: "满意后直接整理提示词和生成素材",
    };
  if (step.id === "video_prompt")
    return {
      title: "整理生成方案",
      description: "根据参考片拆解、人物和产品素材整理正式提示词",
    };
  if (step.id === "generation_pack")
    return {
      title: "开始生成视频",
      description: "检查提示词和上传素材，再确认提交",
    };
  return null;
}

function visibleArtifacts(task: Task) {
  const hideCancelledRewrite =
    task.current_step === "user_confirmation" ||
    task.rewrite_mode === "keep_original_style";
  let artifacts = hideCancelledRewrite
    ? task.artifacts.filter((artifact) => artifact.stage !== "rewrite")
    : task.artifacts;
  if (isVideoQcRejected(task) && !isVideoUserApproved(task)) {
    const rejectedResultPaths = new Set(
      (task.video_generation_result?.artifacts || []).map(
        (artifact) => artifact.path,
      ),
    );
    artifacts = artifacts.filter(
      (artifact) =>
        !rejectedResultPaths.has(artifact.path) &&
        !(
          artifact.stage === "video_generation" &&
          /完整版视频|视频生成回执/.test(artifact.label)
        ),
    );
  }
  return artifacts;
}

function artifactKind(artifact: Artifact) {
  if (/项目状态|阻断|阻塞/.test(artifact.label)) return null;
  if (/交接|自检|任务包|预检|回执|局部深拉证据/.test(artifact.label))
    return null;
  if (/^候选图片[｜|]/.test(artifact.label)) return null;
  if (
    artifact.stage === "person" &&
    (!artifact.published || /质检|执行回执/.test(artifact.label))
  )
    return null;
  if (artifact.stage === "storyboard" && !artifact.published) return null;
  if (artifact.stage === "person_package" && !artifact.published) return null;
  if (artifact.stage === "person" && /人物/.test(artifact.label))
    return "person_asset";
  if (/DNA/i.test(artifact.label)) return "remix_plan";
  if (/拆解.*报告|视频拆解验收报告/.test(artifact.label))
    return "decomposition_result";
  if (artifact.stage === "rewrite") return "rewrite_result";
  return `${artifact.stage}:${artifact.label}`;
}

function userFacingArtifacts(task: Task) {
  const latest = new Map<string, Artifact>();
  for (const artifact of visibleArtifacts(task)) {
    const kind = artifactKind(artifact);
    if (!kind) continue;
    const existing = latest.get(kind);
    if (!existing || artifact.id > existing.id) latest.set(kind, artifact);
  }
  return [...latest.values()].sort((a, b) => a.id - b.id);
}

function videoArtifactVersion(artifact: Artifact) {
  if (artifact.stage !== "video_generation") return null;
  const versionMatch = artifact.label.match(/^版本\s*(\d+)/);
  const version = versionMatch ? Number(versionMatch[1]) : 1;
  const segmentMatch = artifact.label.match(/(?:返工)?分段\s*(\d+)$/);
  const full =
    artifact.label === "正式视频" ||
    /^版本\s*\d+\s*正式视频$/.test(artifact.label);
  if (!full && !segmentMatch) return null;
  return {
    version,
    segmentNumber: segmentMatch ? Number(segmentMatch[1]) : null,
    full,
  };
}

function videoSegmentVersions(task: Task, segmentNumber: number) {
  return task.artifacts
    .map((artifact) => ({ artifact, meta: videoArtifactVersion(artifact) }))
    .filter(
      (item): item is { artifact: Artifact; meta: NonNullable<ReturnType<typeof videoArtifactVersion>> } =>
        item.meta?.segmentNumber === segmentNumber,
    )
    .map((item) => ({ artifact: item.artifact, version: item.meta.version }))
    .sort((left, right) => right.version - left.version || right.artifact.id - left.artifact.id);
}

function videoVersionLibrary(task: Task) {
  const items = task.artifacts
    .map((artifact) => ({ artifact, meta: videoArtifactVersion(artifact) }))
    .filter(
      (item): item is { artifact: Artifact; meta: NonNullable<ReturnType<typeof videoArtifactVersion>> } =>
        Boolean(item.meta),
    );
  const full = items
    .filter((item) => item.meta.full)
    .map((item) => ({ artifact: item.artifact, version: item.meta.version }))
    .sort((left, right) => right.version - left.version || right.artifact.id - left.artifact.id);
  const segmentNumbers = [...new Set(items.map((item) => item.meta.segmentNumber).filter((value): value is number => value != null))].sort((a, b) => a - b);
  return {
    full,
    segments: segmentNumbers.map((segmentNumber) => ({
      segmentNumber,
      items: videoSegmentVersions(task, segmentNumber),
    })),
  };
}

function currentStoryboardResultImage(task: Task) {
  return (
    task.storyboard_generation_result?.artifacts?.some((item) =>
      /\.(png|jpe?g|webp)$/i.test(item.path || ""),
    ) ?? false
  );
}

function storyboardResultArtifacts(task: Task): Artifact[] {
  const resultPaths = new Set(
    (task.storyboard_generation_result?.artifacts || [])
      .filter((item) => /候选图/.test(item.label || "") && /\.(png|jpe?g|webp)$/i.test(item.path || ""))
      .map((item) => item.path),
  );
  return task.artifacts.filter(
    (artifact) => artifact.stage === "storyboard" && resultPaths.has(artifact.path),
  );
}

function userArtifactLabel(artifact: Artifact) {
  const kind = artifactKind(artifact);
  if (kind === "decomposition_result") return "参考视频分析";
  if (kind === "remix_plan") return "重构方案（画面、动作与节奏）";
  if (kind === "rewrite_result") return "商品脚本方案";
  if (kind === "person_asset") return "已确认人物形象";
  if (artifact.stage === "person_package" && /多视图/.test(artifact.label))
    return "人物服装多视图";
  return artifact.label;
}

function resultMediaKind(artifact: Artifact): "video" | "image" | "text" {
  const extension = artifact.path.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "webm", "mov"].includes(extension)) return "video";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) return "image";
  return "text";
}

function primaryResultArtifact(artifacts: Artifact[]) {
  return (
    [...artifacts].reverse().find((artifact) =>
      artifact.stage === "video_generation" && resultMediaKind(artifact) === "video",
    ) ||
    [...artifacts].reverse().find((artifact) => resultMediaKind(artifact) === "video") ||
    [...artifacts].reverse().find((artifact) => resultMediaKind(artifact) === "image") ||
    artifacts.at(-1) ||
    null
  );
}

function groupResultArtifacts(artifacts: Artifact[]) {
  const groups = {
    final: [] as Artifact[],
    assets: [] as Artifact[],
    materials: [] as Artifact[],
  };
  for (const artifact of artifacts) {
    if (
      artifact.stage === "video_generation" ||
      /成片|完整.*视频|动作小样/.test(artifact.label)
    )
      groups.final.push(artifact);
    else if (
      ["person", "person_package", "storyboard"].includes(artifact.stage) ||
      /人物|分镜|红线|材质|母版/.test(artifact.label)
    )
      groups.assets.push(artifact);
    else groups.materials.push(artifact);
  }
  groups.final.sort((left, right) => {
    const score = (artifact: Artifact) =>
      /完整.*视频|正式.*视频|成片/.test(artifact.label)
        ? 3
        : /小样/.test(artifact.label)
          ? 1
          : 2;
    return score(right) - score(left) || right.id - left.id;
  });
  return [
    {
      key: "final",
      title: "最终成果",
      description: "优先播放、查看和使用已经生成的视频或样片",
      artifacts: groups.final,
    },
    {
      key: "assets",
      title: "核心素材",
      description: "人物、分镜和后续继续制作需要的关键图片",
      artifacts: groups.assets,
    },
    {
      key: "materials",
      title: "创作资料",
      description: "参考分析、重构方案、提示词和过程报告",
      artifacts: groups.materials,
    },
  ].filter((group) => group.artifacts.length > 0);
}

function resultSummary(task: Task) {
  if (isVideoUserApproved(task))
    return task.video_generation_result?.user_approval_overrode_qc
      ? "你已采用当前视频；自动质检的历史提醒仍保留，所有旧版本也可以继续查看。"
      : "当前完整视频已经采用，可以直接播放和使用；旧版本仍保留在版本库。";
  if (task.runtime_generation?.status === "generation_completed")
    return "正式视频已经返回，可以直接播放；满意后采用，不满意可以保留旧版再调整。";
  if (task.runtime_generation?.status === "generation_running")
    return "视频已经提交，正在等待生成结果返回。";
  if (task.runtime_generation?.status === "generation_failed")
    return "本次生成没有成功，已有成果仍然保留，系统不会自动重复提交。";
  if (isVideoQcRejected(task))
    return "视频已经返回，但质检未通过；失败结果已保留，不会自动重生。";
  if (task.status === "person_inputs_ready")
    return "参考视频已经分析完成，人物选择已保存，下一步创建人物。";
  if (task.status === "person_review")
    return "人物候选已经生成，正在等待确认；确认前不会进入分镜或视频生成。";
  if (task.status === "person_approved")
    return "人物形象已经确认，可以生成第一版分镜。";
  if (task.status === "storyboard_inputs_ready")
    return "分镜所需资料已经整理好，尚未开始生图。";
  if (task.status === "storyboard_review")
    return "第一版分镜已经生成，正在等待确认。";
  if (task.status === "storyboard_approved")
    return "分镜已采用，可以继续检查人物和镜头怎么动。";
  if (task.status === "running_motion_preflight")
    return "正在逐镜检查人物动作、镜头运动和衣物表现；尚未生成视频。";
  if (task.status === "motion_preflight_ready")
    return "动态检查已经完成，可以继续整理视频生成方案。";
  if (task.status === "motion_preflight_blocked")
    return "动态检查已停止，已有分镜、人物和参考片分析仍然保留。";
  if (task.status === "running_video_prompt")
    return "正在整理视频生成方案；尚未上传素材或生成视频。";
  if (task.status === "video_prompt_ready")
    return "生成视频所需内容已经准备好，可以直接开始生成流程。";
  if (task.status === "person_package_required")
    return "生成前检查发现只差一张必要人物多视图，确认范围后即可补齐。";
  if (task.status === "running_person_package")
    return "正在补齐必要人物多视图，尚未提交视频。";
  if (task.status === "person_package_review")
    return "保持人物一致所需的图片已经生成，确认后继续做生成前检查。";
  if (
    task.status === "person_package_failed" &&
    task.person_package_result?.checkpoint_resume_available
  )
    return `已有 ${task.person_package_result?.artifacts?.length || 0} 项人物资产安全保留，只需补齐 ${task.person_package_result?.missing_assets?.length || 1} 项。`;
  if (task.status === "person_package_failed")
    return "人物资产还未生成，点一下继续后系统会自动复用现有项目处理。";
  if (task.status === "video_prompt_blocked")
    return "视频生成方案整理已停止，已有成果仍然保留。";
  if (task.status === "running_generation_pack")
    return "正在核对素材、模型和费用；尚未提交视频生成。";
  if (task.status === "generation_pack_ready")
    return "生成前检查已经通过，下一步确认模型、费用和素材上传。";
  if (task.status === "generation_pack_blocked")
    return "生成前检查发现上游资料缺口，已有成果仍然保留。";
  if (task.status === "running_video_generation")
    return task.generation_provider === "runninghub_h3_multiref"
      ? "视频已经提交一次，正在等待 RunningHub H3 返回结果。"
      : "视频已经提交一次，正在等待 LibTV 返回结果。";
  if (task.status === "video_generation_completed")
    return task.video_generation_result?.generation_kind === "full_sequence"
      ? "完整版视频已经返回，可以在成果中心直接播放。"
      : "4 秒动作小样已生成，可以在成果中心直接播放。";
  if (task.status === "video_generation_failed")
    return "视频生成已停止，系统没有自动再次提交。";
  if (task.rewrite_mode === "keep_original_style")
    return "拆解已经完成，已按不换产品的路线保留参考结构，可继续制作复刻视频。";
  if (task.status === "completed")
    return "本阶段已经完成，可查看当前结果并继续后续制作。";
  return "已保存当前可用结果；任务仍可从原进度继续。";
}

function userEventMessage(event: TaskEvent) {
  if (event.event_type === "person_package_generation_failed")
    return "人物资产还未生成；本次没有产生新的生图费用，可以继续处理。";
  if (
    event.event_type === "person_package_progress" &&
    /A（推荐）|clean-image|route receipt|task_root|ready 路由|执行器|路由/.test(
      event.message,
    )
  )
    return "系统正在核对人物资产的保存位置和生成准备。";
  return event.message;
}

function taskStatusMessage(task: Task, fallback: string) {
  if (isVideoQcRejected(task))
    return (
      task.video_generation_result?.quality_qc?.user_message ||
      task.video_generation_result?.quality_qc?.summary ||
      "视频已经返回，但质检未通过；系统已停止继续生成。"
    );
  if (
    task.status === "person_package_failed" &&
    task.person_package_result?.checkpoint_resume_available
  )
    return `已有 ${task.person_package_result?.artifacts?.length || 0} 项人物资产安全保留，只需补齐 ${task.person_package_result?.missing_assets?.length || 1} 项；不会重做已有图片。`;
  if (task.status === "person_package_failed")
    return "人物资产还未生成；系统会复用现有项目继续处理。";
  return task.user_message || fallback;
}

function isVideoUserApproved(task: Task) {
  return task.video_generation_result?.user_approval_status === "approved";
}

function isVideoQcRejected(task: Task) {
  const qc = task.video_generation_result?.quality_qc;
  const historicalQcText = [qc?.summary, qc?.user_message]
    .filter(Boolean)
    .join("\n");
  const historicalQcReject =
    /不通过|不能采用|暂时不能采用|命中.*硬闸门|reject|needs_rework/i.test(
      historicalQcText,
    );
  return (
    task.status === "video_generation_completed" &&
    (qc?.decision === "reject" ||
      qc?.business_qc_status === "needs_rework" ||
      task.video_generation_result?.quality_qc_status === "needs_rework" ||
      historicalQcReject)
  );
}

function formatTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatShortDate(value: string) {
  if (!value) return "日期待记录";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function taskDateGroup(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期待记录";
  const today = new Date();
  const startToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const startTarget = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const days = Math.round(
    (startToday.getTime() - startTarget.getTime()) / 86_400_000,
  );
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", {
    ...(date.getFullYear() !== today.getFullYear()
      ? { year: "numeric" as const }
      : {}),
    month: "long",
    day: "numeric",
  }).format(date);
}
