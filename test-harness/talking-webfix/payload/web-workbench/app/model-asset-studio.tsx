"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { useDialogFocus } from "./use-dialog-focus";

const API = process.env.NEXT_PUBLIC_WORKBENCH_API || "http://127.0.0.1:4318";
type GenerationProvider = "codex_builtin" | "chatgpt_web";
type ProviderCapabilities = {
  chatgptWebAvailable: boolean;
  chatgptWebMode: "simulation" | "live" | "companion";
  chatgptWebState: string;
  chatgptWebMessage: string;
};
type TalkingHeadPersonAsset = {
  asset_id: string;
  project_id: string;
};

type ModelAssetCategory =
  | "identity_source"
  | "hair_reference"
  | "wardrobe_reference"
  | "body_identity_reference"
  | "scene_reference"
  | "atmosphere_reference"
  | "benchmark_style_reference"
  | "pose_reference"
  | "styled_identity_anchor"
  | "face_outline_reference"
  | "eye_reference"
  | "nose_lip_reference"
  | "style_vibe_reference"
  | "deidentify_source"
  | "person_a_reference"
  | "person_b_reference"
  | "imported_master"
  | "user_revision"
  | "generated_candidate";
type RealPersonAssetStage = "v0" | "appearance_bridge" | "styled_anchor" | "performance_master" | "current_shot";
type ModelAssetStage = RealPersonAssetStage | "deidentify_bridge";
type AiModelSourceMethod =
  | "original"
  | "multi_reference_fusion"
  | "single_reference_deidentify"
  | "two_person_middle_face";
type ModelAssetItem = {
  asset_id: string;
  project_id: string;
  category: ModelAssetCategory;
  source_kind: "user_upload" | "generated" | "derived_crop";
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: "source_ready" | "candidate" | "approved" | "invalid";
  generation_provider: GenerationProvider | null;
  attempt_number: number | null;
  asset_stage?: ModelAssetStage | null;
  parent_asset_ids?: string[];
  derived_from_asset_id?: string | null;
  revises_asset_id?: string | null;
  execution_summary?: string | null;
  created_at: string;
};
export type ModelAssetProject = {
  id: string;
  name: string;
  route: "ai_model" | "real_person";
  route_state: "formal";
  ai_source_method?: AiModelSourceMethod | null;
  brief: string;
  authorization_confirmed: boolean;
  default_generation_provider: GenerationProvider;
  status:
    | "draft"
    | "source_ready"
    | "running"
    | "needs_review"
    | "approved"
    | "blocked"
    | "failed_after_submit";
  generation_attempt_count: number;
  active_attempt: null | {
    attempt_id: string;
    attempt_number: number;
    provider: GenerationProvider;
    reference_asset_ids: string[];
    instruction: string;
    external_request_started: boolean;
    asset_stage?: RealPersonAssetStage | null;
    auxiliary_mode?: "styled_identity_closeup" | null;
    progress_stage?: "planning" | "preflight" | "generating" | "finalizing";
    progress_message?: string;
    progress_updated_at?: string;
  };
  assets: ModelAssetItem[];
  approved_asset_id: string | null;
  library_archived_at?: string | null;
  workflow_stage?: string;
  ai_workflow_stage?: "deidentify_bridge" | "v0" | null;
  ai_active_bridge_asset_id?: string | null;
  ai_talking_asset_id?: string | null;
  active_asset_lock?: null | {
    v0_asset_id: string | null;
    appearance_bridge_asset_id: string | null;
    styled_anchor_asset_id: string | null;
    performance_master_asset_id: string | null;
    current_shot_asset_id: string | null;
  };
  style_analysis_attempt_count?: number;
  talking_style_analysis?: null | {
    analysis_id: string;
    attempt_number: number;
    benchmark_asset_id: string;
    benchmark_sha256: string;
    status: "running" | "needs_review" | "approved" | "failed";
    approval_status: "pending" | "needs_review" | "approved";
    reverse_conclusion?: string;
    generation_prompt?: string;
    approved_generation_prompt?: string;
    generation_prompt_sha256?: string;
    approved_generation_prompt_sha256?: string;
    error?: string;
  };
  last_error?: string | null;
  created_at: string;
  updated_at: string;
};
const modelAssetCategoryLabels: Record<ModelAssetCategory, string> = {
  identity_source: "本人身份照",
  hair_reference: "发型参考",
  wardrobe_reference: "穿搭参考",
  body_identity_reference: "身体比例照",
  scene_reference: "场景参考",
  atmosphere_reference: "画质与氛围参考",
  benchmark_style_reference: "口播对标图（只分析）",
  pose_reference: "姿态参考",
  styled_identity_anchor: "近景人物图",
  face_outline_reference: "脸型轮廓参考",
  eye_reference: "眼型参考",
  nose_lip_reference: "鼻唇参考",
  style_vibe_reference: "人物气质参考",
  deidentify_source: "单图脱离原始参考",
  person_a_reference: "人物 A 参考",
  person_b_reference: "人物 B 参考",
  imported_master: "现有模特母版",
  user_revision: "我自己修过的版本",
  generated_candidate: "生成候选",
};

const realPersonStageInfo: Record<RealPersonAssetStage, {
  number: string;
  name: string;
  approvalName: string;
  short: string;
  description: string;
  placeholder: string;
}> = {
  v0: {
    number: "1",
    name: "商业身份母版",
    approvalName: "商业身份母版",
    short: "把随手照变成稳定母版",
    description: "只使用本人随手照，重建一张商业摄影级身份母版。发型、穿搭和对标画面留到后面分别处理。",
    placeholder: "可补充希望保留的稳定特征；没有补充可以留空",
  },
  appearance_bridge: {
    number: "2",
    name: "更换发型",
    approvalName: "发型母版",
    short: "只换发型",
    description: "使用已采用的商业身份母版和发型参考，只更换发型，不同时改穿搭或姿态。",
    placeholder: "可补充发长、分缝或蓬松度；没有补充可以留空",
  },
  styled_anchor: {
    number: "3",
    name: "更换穿搭",
    approvalName: "穿搭母版",
    short: "只换穿搭",
    description: "使用已采用的发型母版和穿搭参考，只更换服装与服饰，不重新设计头脸和发型。身体比例照可选但建议上传，用来降低换头感。",
    placeholder: "可补充服装版型或松紧感；没有补充可以留空",
  },
  performance_master: {
    number: "4",
    name: "匹配神态姿态",
    approvalName: "神态姿态母版",
    short: "迁移动作和机位",
    description: "先选一张人物图锁定本人，再用一张姿态参考迁移神态、姿态、动作和镜头几何。脸更清楚的近景图通常更稳，但最终由你选择，也可以继续使用全身穿搭母版。",
    placeholder: "可补充希望更松弛或更克制；没有补充可以留空",
  },
  current_shot: {
    number: "5",
    name: "复刻画质氛围",
    approvalName: "最终画面母版",
    short: "匹配设备、色调与场景",
    description: "最后才反推并复刻对标画面的画质、设备、色调、场景和整体氛围；对标人物不会进入最终生图。",
    placeholder: "可补充少量取舍；没有补充可以留空",
  },
};

const realPersonStageOrder = Object.keys(realPersonStageInfo) as RealPersonAssetStage[];

const aiModelSourceMethods: Array<{
  id: AiModelSourceMethod;
  letter: string;
  name: string;
  description: string;
  status: "available";
}> = [
  { id: "original", letter: "A", name: "完全原创", description: "不上传固定人物脸，从用途、年龄感和气质开始创建全新虚构模特。", status: "available" },
  { id: "multi_reference_fusion", letter: "B", name: "多图融合", description: "3–5 张参考各借一个局部特点，融合成现实中不存在的新人物。", status: "available" },
  { id: "single_reference_deidentify", letter: "C", name: "单图脱离", description: "1 张参考先做性别过桥，再从过桥图建立脱离原型的新人物。", status: "available" },
  { id: "two_person_middle_face", letter: "D", name: "双人中间脸", description: "人物 A 与人物 B 各 1 张，以中间比例生成新的虚构人物。", status: "available" },
];

const aiMethodUploadSlots: Record<Exclude<AiModelSourceMethod, "original">, Array<{
  category: ModelAssetCategory;
  label: string;
  hint: string;
  required: boolean;
}>> = {
  multi_reference_fusion: [
    { category: "face_outline_reference", label: "脸型轮廓", hint: "只借脸型和下颌轮廓", required: true },
    { category: "eye_reference", label: "眼型", hint: "只借眼型、眼距和目光气质", required: true },
    { category: "nose_lip_reference", label: "鼻唇", hint: "只借鼻部和唇部结构", required: true },
    { category: "style_vibe_reference", label: "整体气质", hint: "可选，只借气质不借身份", required: false },
    { category: "hair_reference", label: "发型", hint: "可选，只借发型轮廓和发流", required: false },
  ],
  single_reference_deidentify: [
    { category: "deidentify_source", label: "原始人物参考", hint: "第一步只使用这 1 张，第二步不会再回看", required: true },
  ],
  two_person_middle_face: [
    { category: "person_a_reference", label: "人物 A", hint: "主要参考整体脸型和基础轮廓", required: true },
    { category: "person_b_reference", label: "人物 B", hint: "主要参考眼、鼻、唇局部结构", required: true },
  ],
};

function aiMethodSourcesReady(
  method: AiModelSourceMethod,
  sources: Array<{ category: ModelAssetCategory }>,
) {
  if (method === "original") return sources.length === 0;
  const categories = new Set(sources.map((source) => source.category));
  return aiMethodUploadSlots[method]
    .filter((slot) => slot.required)
    .every((slot) => categories.has(slot.category));
}

function aiMethodSourceRequirement(method: AiModelSourceMethod) {
  if (method === "original") return "完全原创不需要上传人物参考图。";
  if (method === "multi_reference_fusion") return "请先分别上传脸型轮廓、眼型、鼻唇 3 张不同参考图。";
  if (method === "single_reference_deidentify") return "请先上传 1 张用于去身份化的原始人物参考图。";
  return "请先分别上传人物 A 和人物 B 两张不同参考图。";
}

function modelAssetUploadCategories(project: ModelAssetProject, realStage: RealPersonAssetStage = "v0") {
  if (project.route === "real_person") {
    const categories: Record<RealPersonAssetStage, ModelAssetCategory[]> = {
      v0: ["identity_source"],
      appearance_bridge: ["hair_reference"],
      // The required reference is first so a user who immediately uploads an
      // outfit cannot accidentally save it as the optional body-proportion photo.
      styled_anchor: ["wardrobe_reference", "body_identity_reference"],
      performance_master: ["pose_reference", "styled_identity_anchor"],
      current_shot: ["benchmark_style_reference"],
    };
    return categories[realStage].map((key) => [key, modelAssetCategoryLabels[key]] as const);
  }
  const method = project.ai_source_method || "original";
  if (method === "original") return [];
  if (method === "single_reference_deidentify" && project.ai_workflow_stage === "v0") return [];
  return aiMethodUploadSlots[method].map((slot) => [slot.category, modelAssetCategoryLabels[slot.category]] as const);
}

function initialModelAssetCategory(project: ModelAssetProject, realStage: RealPersonAssetStage = "v0"): ModelAssetCategory {
  return modelAssetUploadCategories(project, realStage)[0]?.[0] as ModelAssetCategory || "identity_source";
}

function aiGenerationReferencesReady(project: ModelAssetProject, assets: ModelAssetItem[]) {
  const method = project.ai_source_method || "original";
  if (method === "original") return assets.length === 0;
  if (method === "multi_reference_fusion") {
    const categories = new Set(assets.map((asset) => asset.category));
    return assets.length >= 3 && assets.length <= 5 && ["face_outline_reference", "eye_reference", "nose_lip_reference"].every((category) => categories.has(category as ModelAssetCategory));
  }
  if (method === "single_reference_deidentify")
    return assets.length === 1 && (project.ai_workflow_stage === "deidentify_bridge" ? assets[0].category === "deidentify_source" : assets[0].asset_id === project.ai_active_bridge_asset_id);
  return assets.length === 2 && assets.some((asset) => asset.category === "person_a_reference") && assets.some((asset) => asset.category === "person_b_reference");
}

function aiGenerationHeading(project: ModelAssetProject) {
  if (project.ai_source_method === "single_reference_deidentify")
    return project.ai_workflow_stage === "deidentify_bridge" ? "生成第 1 步：去身份过桥" : "生成第 2 步：最终虚构模特";
  return "生成这一版";
}

function aiGenerationPlaceholder(project: ModelAssetProject) {
  const method = project.ai_source_method || "original";
  if (method === "original") return "补充性别、年龄段、气质和用途；工作台会按原创结构化脸建立 v0";
  if (method === "multi_reference_fusion") return "例如：清爽可信的知识口播模特；各参考只借已声明局部，不能像其中任何一人";
  if (method === "single_reference_deidentify")
    return project.ai_workflow_stage === "deidentify_bridge" ? "第一步会做重大结构变换；满意并采用后才进入最终 v0" : "从已确认过桥图返回目标性别和气质，不能恢复原始人物脸";
  return "例如：人物 A 与 B 各占约 50%，允许模型为整体自然协调角度和光影";
}

function referenceStepTitle(project: ModelAssetProject, talkingStyleMode: boolean) {
  if (talkingStyleMode) return project.talking_style_analysis ? "确认想要的画面" : "上传对标图";
  if (project.route === "real_person") return "补充素材并确认本阶段参考";
  if (project.ai_source_method === "single_reference_deidentify")
    return project.ai_workflow_stage === "deidentify_bridge"
      ? "选择 1 张原始人物图"
      : "确认已采用的去身份过桥图";
  return "准备参考图片";
}

function referenceStepDescription(project: ModelAssetProject, talkingStyleMode: boolean, realStage: RealPersonAssetStage) {
  if (talkingStyleMode) return "系统只学习对标图的拍摄感觉，不会使用对标人物、字幕或水印。";
  if (project.route === "real_person") return realPersonStageInfo[realStage].description;
  if (project.ai_source_method === "single_reference_deidentify")
    return project.ai_workflow_stage === "deidentify_bridge"
      ? "第一步只使用你选中的这一张原图，把人物转换成相反性别，生成去身份过桥图。"
      : "第二步只使用已确认的过桥图转回目标性别，不会再次读取原始人物图。";
  return "每张图只选一个主要用途，避免人物、穿搭和场景互相干扰。";
}

function modelAssetGenerationError(value: string | null | undefined) {
  const message = String(value || "").trim();
  if (!message) return "";
  if (/正式 Skill 接口已变化|source_character_asset|person_prompt_ready_for_image_generation/.test(message))
    return "上次生成在提交前被旧版人物接口拦住，没有占用生图次数。现在可以直接重新生成，不需要重新上传素材。";
  return message;
}

function realPersonRetryReasonOptions(stage: RealPersonAssetStage) {
  if (stage === "v0") return ["人脸不够像", "皮肤质感不自然", "头颈肩或整人比例不自然"];
  if (stage === "appearance_bridge") return ["发型不像参考", "人脸有偏差", "发际线或头型不自然"];
  if (stage === "styled_anchor") return ["有换头感", "穿搭不像参考", "身体比例不自然"];
  if (stage === "performance_master") return ["人脸有偏差", "神态不自然", "姿态或机位不准"];
  return ["画质氛围不像", "皮肤质感不自然", "场景、设备感或色调不准"];
}

function ModelProviderOptions({
  value,
  defaultValue,
  capabilities,
  chatgptStatusOverride,
  onChange,
}: {
  value: GenerationProvider;
  defaultValue: GenerationProvider;
  capabilities: ProviderCapabilities;
  chatgptStatusOverride?: string;
  onChange: (provider: GenerationProvider) => void;
}) {
  const chatgptDescription = capabilities.chatgptWebAvailable
    ? capabilities.chatgptWebMode === "companion"
      ? "浏览器伴侣已连接，生成后自动返回工作台"
      : "当前测试通道已就绪"
    : chatgptStatusOverride || capabilities.chatgptWebMessage || "当前不可用";
  return (
    <>
      <div className="provider-heading">
        <strong>这一次在哪里生图</strong>
        <span>{value === defaultValue ? "使用默认选择" : "只改这一次"}</span>
      </div>
      <div className="provider-options" aria-label="这一次在哪里生图">
        <button type="button" className={value === "codex_builtin" ? "selected" : ""} onClick={() => onChange("codex_builtin")}>
          <strong>Codex 内置生图</strong>
          <span>生成后自动返回工作台</span>
        </button>
        <button type="button" disabled={!capabilities.chatgptWebAvailable} className={value === "chatgpt_web" ? "selected" : ""} onClick={() => onChange("chatgpt_web")}>
          <strong>ChatGPT 网页生图</strong>
          <span>{chatgptDescription}</span>
        </button>
      </div>
    </>
  );
}

export function ModelAssetStudio({
  projects,
  entryMode,
  entryRoute,
  capabilities,
  onRefresh,
  onNotice,
  onUseForTalking,
}: {
  projects: ModelAssetProject[];
  entryMode: "home" | "project";
  entryRoute?: "ai_model" | "real_person" | null;
  capabilities: ProviderCapabilities;
  onRefresh: () => Promise<void>;
  onNotice: (message: string, tone?: "success" | "error") => void;
  onUseForTalking: () => void;
}) {
  const [selectedId, setSelectedId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : window.localStorage.getItem("workbench-selected-model-project") || "",
  );
  const [creating, setCreating] = useState(Boolean(entryRoute));
  const [showHome, setShowHome] = useState(entryMode === "home" && !entryRoute);
  const [quickTalkingOpen, setQuickTalkingOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelFilter, setModelFilter] = useState<"all" | "ai_model" | "real_person" | "imported_master">("all");
  const [libraryView, setLibraryView] = useState<"active" | "removed">("active");
  const [libraryMenuProjectId, setLibraryMenuProjectId] = useState("");
  const [archiveTargetProjectId, setArchiveTargetProjectId] = useState("");
  const [route, setRoute] = useState<"ai_model" | "real_person">(entryRoute || "ai_model");
  const [aiSourceMethod, setAiSourceMethod] = useState<AiModelSourceMethod>("original");
  const [aiDirectionConfirmed, setAiDirectionConfirmed] = useState(false);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [pendingSources, setPendingSources] = useState<
    Array<{ id: string; category: ModelAssetCategory; file: File }>
  >([]);
  const [provider, setProvider] = useState<GenerationProvider>("codex_builtin");
  const [category, setCategory] = useState<ModelAssetCategory>("identity_source");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [closeupIdentityFile, setCloseupIdentityFile] = useState<File | null>(null);
  const [closeupUploadAuthorized, setCloseupUploadAuthorized] = useState(false);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [uploadAuthorized, setUploadAuthorized] = useState(false);
  const [previewAssetId, setPreviewAssetId] = useState("");
  const [zoomAssetId, setZoomAssetId] = useState("");
  const [realStage, setRealStage] = useState<RealPersonAssetStage>("v0");
  const [revisionFile, setRevisionFile] = useState<File | null>(null);
  const [reviewPanel, setReviewPanel] = useState<"none" | "retry" | "revision">("none");
  const [retryReasons, setRetryReasons] = useState<string[]>([]);
  const [retryNote, setRetryNote] = useState("");
  const [selectedBenchmarkId, setSelectedBenchmarkId] = useState("");
  const [stylePrompt, setStylePrompt] = useState("");
  const [styleUploadAuthorized, setStyleUploadAuthorized] = useState(false);
  const [talkingStyleMode, setTalkingStyleMode] = useState(false);
  const [quickMasterFile, setQuickMasterFile] = useState<File | null>(null);
  const [quickBenchmarkFile, setQuickBenchmarkFile] = useState<File | null>(null);
  const [quickUploadConfirmed, setQuickUploadConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const initializedProjectIdRef = useRef("");
  const syncedStyleAnalysisIdRef = useRef("");
  const selected = projects.find((project) => project.id === selectedId) || null;
  const importedMasterProject = Boolean(selected && isImportedMasterProject(selected));
  const visibleRealPersonStages: RealPersonAssetStage[] = importedMasterProject
    ? ["performance_master", "current_shot"]
    : realPersonStageOrder;
  const projectBriefRequired = route === "ai_model" && aiSourceMethod === "original";
  const creationMissingItems = [
    !name.trim() ? "项目名称" : "",
    projectBriefRequired && !brief.trim() ? "人物方向" : "",
    route === "real_person" && !pendingSources.some((source) => source.category === "identity_source") ? "本人照片" : "",
    route === "real_person" && !authorized ? "肖像授权确认" : "",
    route === "ai_model" && !aiMethodSourcesReady(aiSourceMethod, pendingSources) ? aiMethodSourceRequirement(aiSourceMethod).replace(/[。]/g, "") : "",
    route === "ai_model" && aiSourceMethod === "original" && !aiDirectionConfirmed ? "原创方向确认" : "",
  ].filter(Boolean);
  const currentAssetStage: ModelAssetStage = talkingStyleMode
    ? "current_shot"
    : selected?.route === "ai_model"
    && selected.ai_source_method === "single_reference_deidentify"
    && selected.ai_workflow_stage === "deidentify_bridge"
      ? "deidentify_bridge"
      : selected?.route === "real_person" ? realStage : "v0";
  const candidates = selected?.assets.filter((asset) =>
    ["candidate", "approved"].includes(asset.status) &&
    (asset.asset_stage || "v0") === currentAssetStage,
  ).filter((asset, index, assets) =>
    assets.findIndex((candidate) => candidate.sha256 === asset.sha256) === index,
  ) || [];
  const closeZoom = useCallback(() => setZoomAssetId(""), []);
  useDialogFocus(Boolean(zoomAssetId), "模特候选大图", closeZoom);
  const [showGenerationForm, setShowGenerationForm] = useState(false);
  const requestLock = useRef(false);
  const approvedForTalking = selected ? (selected.route === "real_person" ? selected.active_asset_lock?.current_shot_asset_id : selected.ai_talking_asset_id || selected.approved_asset_id) : null;
  const approvedImage = selected?.assets.find((asset) => asset.asset_id === approvedForTalking && asset.status === "approved");
  const [failedImageId, setFailedImageId] = useState("");
  const selectedPreview = selected?.assets.find((asset) => asset.asset_id === previewAssetId && (asset.asset_stage || "v0") === currentAssetStage)
    || candidates.at(-1)
    || null;
  const sourceAssets = selected?.assets.filter((asset) => asset.status === "source_ready") || [];
  const generationReferenceAssets = talkingStyleMode && selected
    ? talkingStyleBaseReferences(selected)
    : selected?.route === "real_person"
    ? realPersonReferencesForStage(selected, realStage)
    : selected?.ai_source_method === "single_reference_deidentify" && selected.ai_workflow_stage === "v0"
      ? selected.assets.filter((asset) => asset.asset_id === selected.ai_active_bridge_asset_id && asset.status === "approved")
      : sourceAssets;
  const selectedGenerationAssets = generationReferenceAssets.filter((asset) =>
    selectedReferenceIds.includes(asset.asset_id),
  );
  const generationBlockedReason = !selected
    ? ""
    : busy
      ? "当前操作还在处理，请稍候。"
      : provider === "chatgpt_web" && !capabilities.chatgptWebAvailable
        ? "ChatGPT 网页生图暂不可用，请先使用 Codex 内置生图。"
          : talkingStyleMode && !["needs_review", "approved"].includes(selected.talking_style_analysis?.status || "")
            ? "请先上传一张口播对标图，完成画面分析。"
          : selected.route === "real_person" && realStage === "current_shot" && !["needs_review", "approved"].includes(selected.talking_style_analysis?.status || "")
            ? "请先分析画质氛围对标图，并确认生成用的画面描述。"
          : !talkingStyleMode && selectedReferenceIds.length > 0 && !uploadAuthorized
          ? `还差一步：确认只上传已勾选的 ${selectedReferenceIds.length} 张图片。`
            : talkingStyleMode && selectedReferenceIds.length === 0
              ? "当前模特还没有可用于口播画面复刻的正式母版。"
            : selected.route === "real_person" && !realPersonGenerationReferencesReady(selected, realStage, selectedGenerationAssets)
            ? realPersonStageMissingMessage(realStage)
            : selected.route === "ai_model" && !talkingStyleMode && !aiGenerationReferencesReady(selected, selectedGenerationAssets)
              ? selected.ai_source_method === "multi_reference_fusion"
                ? "请勾选脸型轮廓、眼型、鼻唇 3 张必需参考图，最多选择 5 张。"
                : selected.ai_source_method === "single_reference_deidentify"
                  ? "请只勾选当前阶段要求的 1 张参考图。"
                  : selected.ai_source_method === "two_person_middle_face"
                    ? "请同时勾选人物 A 和人物 B 两张参考图。"
                    : "当前参考图还没有准备齐。"
              : "";
  const generationReady = Boolean(selected && !generationBlockedReason);
  const currentStageApproved = Boolean(selected && (
    selected.route === "real_person"
      ? selected.active_asset_lock?.[`${realStage}_asset_id` as keyof NonNullable<ModelAssetProject["active_asset_lock"]>]
      : selected.status === "approved"
  ));
  const reusableMasterProjects = projects.filter((project) => Boolean(preferredReusableMasterAsset(project)));
  const savedMasterProjects = reusableMasterProjects.filter((project) => !project.library_archived_at);
  const removedMasterProjects = reusableMasterProjects.filter((project) => Boolean(project.library_archived_at));
  const libraryProjects = libraryView === "removed" ? removedMasterProjects : savedMasterProjects;
  const modelCounts = {
    all: libraryProjects.length,
    ai_model: libraryProjects.filter((project) => project.route === "ai_model" && !isImportedMasterProject(project)).length,
    real_person: libraryProjects.filter((project) => project.route === "real_person" && !isImportedMasterProject(project)).length,
    imported_master: libraryProjects.filter(isImportedMasterProject).length,
  };
  const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase("zh-CN");
  const filterModelProjects = (items: ModelAssetProject[]) => items.filter((project) => {
    const matchesFilter = modelFilter === "all"
      || (modelFilter === "ai_model" && project.route === "ai_model" && !isImportedMasterProject(project))
      || (modelFilter === "real_person" && project.route === "real_person" && !isImportedMasterProject(project))
      || (modelFilter === "imported_master" && isImportedMasterProject(project));
    return matchesFilter && (!normalizedModelQuery || `${project.name} ${project.brief}`.toLocaleLowerCase("zh-CN").includes(normalizedModelQuery));
  });
  const filteredApprovedModels = filterModelProjects(libraryProjects).flatMap((project) => {
    const asset = preferredReusableMasterAsset(project);
    return asset ? [{ project, asset }] : [];
  });
  const filteredWorkingProjects = filterModelProjects(projects.filter((project) => !preferredReusableMasterAsset(project)));
  const archiveTargetProject = projects.find((project) => project.id === archiveTargetProjectId) || null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (entryRoute) {
        setRoute(entryRoute);
        setShowHome(false);
        setCreating(true);
        setQuickTalkingOpen(false);
      } else if (entryMode === "home") {
        setShowHome(true);
        setCreating(false);
        setQuickTalkingOpen(false);
      } else {
        setShowHome(false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [entryMode, entryRoute]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [showHome, creating, selectedId]);

  useEffect(() => {
    if (creating || projects.length === 0) return;
    const savedId = window.localStorage.getItem("workbench-selected-model-project");
    const nextId = projects.some((project) => project.id === selectedId)
      ? selectedId
      : projects.some((project) => project.id === savedId)
        ? savedId || ""
        : projects[0].id;
    if (!nextId || nextId === selectedId) return;
    const timer = window.setTimeout(() => setSelectedId(nextId), 0);
    return () => window.clearTimeout(timer);
  }, [creating, projects, selectedId]);

  useEffect(() => {
    if (selectedId) window.localStorage.setItem("workbench-selected-model-project", selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!selected) return;
    // Dashboard polling returns fresh project objects. Resetting local form
    // state for every object refresh used to erase a file immediately after
    // the user selected it. Initialize only when the actual project changes.
    if (initializedProjectIdRef.current === selected.id) return;
    initializedProjectIdRef.current = selected.id;
    // Imported masters use the same locked stage-4/stage-5 contracts as the
    // real-person workflow, but get a shorter two-step shell.  They must not
    // enter the legacy one-step talking-style mode, which skips pose transfer.
    const nextTalkingStyleMode = isImportedMasterProject(selected) ? false : talkingStyleMode;
    const timer = window.setTimeout(() => {
      if (nextTalkingStyleMode !== talkingStyleMode) setTalkingStyleMode(nextTalkingStyleMode);
      setProvider(selected.default_generation_provider);
      setUploadFile(null);
      setCloseupIdentityFile(null);
      setCloseupUploadAuthorized(false);
      setRevisionFile(null);
      setReviewPanel("none");
      setRetryReasons([]);
      setRetryNote("");
      const latestBenchmark = selected.assets.filter((asset) => asset.category === "benchmark_style_reference").at(-1);
      setSelectedBenchmarkId(selected.talking_style_analysis?.benchmark_asset_id || latestBenchmark?.asset_id || "");
      setStylePrompt(selected.talking_style_analysis?.approved_generation_prompt || selected.talking_style_analysis?.generation_prompt || "");
      setStyleUploadAuthorized(false);
      setInstruction(selected.status === "running" ? selected.active_attempt?.instruction || "" : "");
      setUploadAuthorized(false);
      const initialStage = nextTalkingStyleMode ? "current_shot" : selected.route === "real_person" ? suggestedRealPersonStage(selected) : "v0";
      setRealStage(initialStage);
      setCategory(nextTalkingStyleMode ? "benchmark_style_reference" : initialModelAssetCategory(selected, initialStage));
      setSelectedReferenceIds(nextTalkingStyleMode
        ? talkingStyleBaseReferences(selected).map((asset) => asset.asset_id)
        : selected.route === "real_person"
        ? defaultRealPersonReferenceIdsForStage(selected, initialStage)
        : selected.ai_source_method === "single_reference_deidentify" && selected.ai_workflow_stage === "v0"
          ? selected.assets.filter((asset) => asset.asset_id === selected.ai_active_bridge_asset_id && asset.status === "approved").map((asset) => asset.asset_id)
          : selected.ai_source_method === "single_reference_deidentify" && selected.ai_workflow_stage === "deidentify_bridge"
            ? selected.assets.filter((asset) => asset.status === "source_ready" && asset.category === "deidentify_source").slice(0, 1).map((asset) => asset.asset_id)
            : selected.assets.filter((asset) => asset.status === "source_ready").map((asset) => asset.asset_id));
      setPreviewAssetId(
        selected.assets.filter((asset) => ["candidate", "approved"].includes(asset.status) && (asset.asset_stage || "v0") === (selected.route === "ai_model" && selected.ai_source_method === "single_reference_deidentify" && selected.ai_workflow_stage === "deidentify_bridge" ? "deidentify_bridge" : initialStage)).at(-1)?.asset_id ||
          selected.approved_asset_id ||
          "",
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selected, talkingStyleMode]);

  useEffect(() => {
    const analysis = selected?.talking_style_analysis;
    if (!analysis || analysis.status === "running" || syncedStyleAnalysisIdRef.current === analysis.analysis_id) return;
    syncedStyleAnalysisIdRef.current = analysis.analysis_id;
    const timer = window.setTimeout(() => setStylePrompt(analysis.approved_generation_prompt || analysis.generation_prompt || ""), 0);
    return () => window.clearTimeout(timer);
  }, [selected?.talking_style_analysis]);

  function selectRealPersonStage(stage: RealPersonAssetStage, project = selected) {
    if (!project || project.route !== "real_person") return;
    setRealStage(stage);
    setCategory(initialModelAssetCategory(project, stage));
    setSelectedReferenceIds(defaultRealPersonReferenceIdsForStage(project, stage));
    setPreviewAssetId(
      project.assets.filter((asset) => ["candidate", "approved"].includes(asset.status) && (asset.asset_stage || "v0") === stage).at(-1)?.asset_id || "",
    );
    setInstruction("");
    setUploadAuthorized(false);
    setCloseupIdentityFile(null);
    setCloseupUploadAuthorized(false);
    setRevisionFile(null);
    setReviewPanel("none");
    setRetryReasons([]);
    setRetryNote("");
  }

  async function request(path: string, init: RequestInit) {
    if (requestLock.current) return null;
    requestLock.current = true;
    setBusy(true);
    try {
      const response = await fetch(`${API}${path}`, init);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "操作没有完成");
      await onRefresh();
      return payload;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作没有完成", "error");
      return null;
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      onNotice("请先填写项目名称", "error");
      return;
    }
    if (route === "ai_model" && aiSourceMethod === "original" && !brief.trim()) {
      onNotice("完全原创需要先说明人物方向，例如年龄感、气质和使用场景", "error");
      return;
    }
    const identityCount = pendingSources.filter((source) => source.category === "identity_source").length;
    if (route === "real_person" && identityCount === 0) {
      onNotice("请先上传至少 1 张本人照片，再建立真人模特项目", "error");
      return;
    }
    if (route === "real_person" && !authorized) {
      onNotice("请先确认本人或已取得肖像使用授权", "error");
      return;
    }
    if (route === "ai_model" && !aiMethodSourcesReady(aiSourceMethod, pendingSources)) {
      onNotice(aiMethodSourceRequirement(aiSourceMethod), "error");
      return;
    }
    setBusy(true);
    let createdProjectId = "";
    try {
      const response = await fetch(`${API}/model-assets/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          route,
          aiSourceMethod: route === "ai_model" ? aiSourceMethod : null,
          brief,
          designDirectionConfirmed:
            route === "ai_model" && aiSourceMethod === "original" && aiDirectionConfirmed,
          authorizationConfirmed: route === "real_person" && authorized,
          defaultGenerationProvider: provider,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "模特项目没有建立成功");
      createdProjectId = payload.project.id;

      for (const source of pendingSources) {
        const form = new FormData();
        form.set("image", source.file);
        form.set("category", source.category);
        const uploadResponse = await fetch(`${API}/model-assets/projects/${createdProjectId}/assets`, {
          method: "POST",
          body: form,
        });
        const uploadPayload = await uploadResponse.json();
        if (!uploadResponse.ok) {
          throw new Error(`${source.file.name} 没有保存成功：${uploadPayload.error || "请进入项目后重新上传"}`);
        }
      }

      await onRefresh();
      setCreating(false);
      setShowHome(false);
      setSelectedId(createdProjectId);
      setName("");
      setBrief("");
      setAuthorized(false);
      setPendingSources([]);
      onNotice(route === "real_person" ? "真人照片和参考素材已保存到当前项目，可以开始生成" : pendingSources.length ? "AI 模特参考图已按职责保存，可以开始生成" : "AI 模特项目已经建立");
    } catch (error) {
      if (createdProjectId) {
        await onRefresh();
        setCreating(false);
        setSelectedId(createdProjectId);
        setPendingSources([]);
      }
      onNotice(error instanceof Error ? error.message : "模特项目没有建立成功", "error");
    } finally {
      setBusy(false);
    }
  }

  function stageSources(category: ModelAssetCategory, files: FileList | null) {
    if (!files?.length) return;
    const additions = Array.from(files).map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}-${file.size}`,
      category,
      file,
    }));
    setPendingSources((current) => [...current, ...additions]);
  }

  function stageSingleSource(category: ModelAssetCategory, files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setPendingSources((current) => [
      ...current.filter((source) => source.category !== category),
      { id: `${Date.now()}-${file.name}-${file.size}`, category, file },
    ]);
  }

  function startNewModel(nextRoute: "ai_model" | "real_person") {
    setQuickTalkingOpen(false);
    setTalkingStyleMode(false);
    setRoute(nextRoute);
    setCreating(true);
    setShowHome(false);
    setAiSourceMethod("original");
    setAiDirectionConfirmed(false);
    setName("");
    setBrief("");
    setAuthorized(false);
    setPendingSources([]);
  }

  async function chooseSavedMasterForQuickProject(project: ModelAssetProject) {
    const asset = preferredReusableMasterAsset(project);
    if (!asset) {
      onNotice("这个项目还没有可以使用的正式母版", "error");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${API}/model-assets/projects/${project.id}/assets/${asset.asset_id}/file`);
      if (!response.ok) throw new Error("这张已保存母版暂时无法读取");
      const blob = await response.blob();
      setQuickMasterFile(new File([blob], asset.original_name || `${project.name}.png`, {
        type: asset.mime_type || blob.type || "image/png",
      }));
      onNotice(`已选用“${project.name}”的正式母版；再选择一张对标图即可开始`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "这张已保存母版没有选用成功", "error");
    } finally {
      setBusy(false);
    }
  }

  function openStandardProject(project: ModelAssetProject) {
    setLibraryMenuProjectId("");
    initializedProjectIdRef.current = "";
    setTalkingStyleMode(false);
    setSelectedId(project.id);
    setCreating(false);
    setShowHome(false);
    setQuickTalkingOpen(false);
  }

  async function updateLibraryStatus(project: ModelAssetProject, archived: boolean) {
    const payload = await request(`/model-assets/projects/${project.id}/library-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (!payload) return;
    setLibraryMenuProjectId("");
    setArchiveTargetProjectId("");
    onNotice(archived ? `“${project.name}”已移出模特资产库，可在“已移除”中恢复` : `“${project.name}”已恢复到模特资产库`);
  }

  function openModelAssetLibrary() {
    setTalkingStyleMode(false);
    setCreating(false);
    setQuickTalkingOpen(false);
    setShowHome(true);
    window.setTimeout(() => {
      document.getElementById("my-model-assets")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }

  async function uploadSource(event: FormEvent) {
    event.preventDefault();
    if (!selected || !uploadFile) return;
    const categoryControl = (event.currentTarget as HTMLFormElement).elements.namedItem("category") as HTMLSelectElement | null;
    const selectedCategory = String(categoryControl?.value || category) as ModelAssetCategory;
    const form = new FormData();
    form.set("image", uploadFile);
    form.set("category", selectedCategory);
    const payload = await request(`/model-assets/projects/${selected.id}/assets`, {
      method: "POST",
      body: form,
    });
    if (!payload) return;
    setUploadFile(null);
    if (selectedCategory === "benchmark_style_reference") {
      setSelectedBenchmarkId(payload.asset.asset_id);
    } else {
      setSelectedReferenceIds((current) => selected.route === "ai_model"
        && selected.ai_source_method === "single_reference_deidentify"
        && selected.ai_workflow_stage === "deidentify_bridge"
          ? [payload.asset.asset_id]
          : [...new Set([...current, payload.asset.asset_id])]);
    }
    onNotice("参考图已保存到当前模特项目");
  }

  async function uploadCloseupIdentitySource(event: FormEvent) {
    event.preventDefault();
    if (!selected || selected.route !== "real_person" || !closeupIdentityFile) return;
    const form = new FormData();
    form.set("image", closeupIdentityFile);
    form.set("category", "styled_identity_anchor");
    const payload = await request(`/model-assets/projects/${selected.id}/assets`, {
      method: "POST",
      body: form,
    });
    if (!payload) return;
    setCloseupIdentityFile(null);
    const poseId = realPersonReferencesForStage(selected, "performance_master")
      .find((asset) => asset.category === "pose_reference")?.asset_id;
    setSelectedReferenceIds([payload.asset.asset_id, poseId].filter((assetId): assetId is string => Boolean(assetId)));
    onNotice("近景人物图已保存并选为第四阶段身份参考；神态姿态对标图仍需单独选择");
  }

  async function generateCloseupIdentitySource() {
    if (!selected || selected.route !== "real_person") return;
    const v0Id = selected.active_asset_lock?.v0_asset_id;
    const styledId = selected.active_asset_lock?.styled_anchor_asset_id;
    if (!v0Id || !styledId) {
      onNotice("请先采用商业身份母版和发型穿搭母版", "error");
      return;
    }
    if (!closeupUploadAuthorized) {
      onNotice("请先确认只上传商业身份母版和发型穿搭母版，用于生成近景身份图", "error");
      return;
    }
    const payload = await request(`/model-assets/projects/${selected.id}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        auxiliaryMode: "styled_identity_closeup",
        referenceAssetIds: [v0Id, styledId],
        parentAssetIds: [v0Id, styledId],
        instruction: "",
        uploadAuthorized: true,
      }),
    });
    if (!payload) return;
    setCloseupUploadAuthorized(false);
    onNotice(provider === "chatgpt_web"
      ? "已交给 ChatGPT 生成 1 张近景身份图；不会使用姿态对标图，也不会自动重试"
      : "已交给 Codex 生成 1 张近景身份图；不会使用姿态对标图，也不会自动重试");
  }

  async function uploadRevision(event: FormEvent) {
    event.preventDefault();
    if (!selected || !selectedPreview || !revisionFile) return;
    const form = new FormData();
    form.set("image", revisionFile);
    form.set("category", "user_revision");
    form.set("assetStage", selectedPreview.asset_stage || realStage);
    form.set("revisesAssetId", selectedPreview.asset_id);
    const payload = await request(`/model-assets/projects/${selected.id}/assets`, {
      method: "POST",
      body: form,
    });
    if (!payload) return;
    setRevisionFile(null);
    setPreviewAssetId(payload.asset.asset_id);
    onNotice("你修过的版本已作为独立候选回到当前阶段，原图没有被覆盖");
  }

  async function generate(requestInstruction = instruction) {
    if (!selected) return;
    const allowedReferenceIds = new Set(generationReferenceAssets.map((asset) => asset.asset_id));
    // Always submit references in the workflow's semantic order. When a user
    // switches the stage-4 identity radio, React selection order can otherwise
    // become [pose, identity] even though the page visibly shows
    // [identity, pose]. The runtime correctly rejects that ambiguous order.
    const selectedReferenceIdSet = new Set(selectedReferenceIds);
    const finalReferenceIds = generationReferenceAssets
      .filter((asset) => allowedReferenceIds.has(asset.asset_id) && selectedReferenceIdSet.has(asset.asset_id))
      .map((asset) => asset.asset_id);
    const payload = await request(`/model-assets/projects/${selected.id}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        referenceAssetIds: finalReferenceIds,
        instruction: requestInstruction,
        uploadAuthorized: talkingStyleMode || uploadAuthorized || finalReferenceIds.length === 0,
        assetStage: talkingStyleMode ? "current_shot" : selected.route === "real_person" ? realStage : "v0",
        parentAssetIds: selected.route === "real_person"
          ? realStage === "performance_master" && selected.active_asset_lock?.styled_anchor_asset_id
            ? [selected.active_asset_lock.styled_anchor_asset_id]
            : Object.values(selected.active_asset_lock || {}).filter((id): id is string => Boolean(id) && finalReferenceIds.includes(String(id)))
          : talkingStyleMode && selected.approved_asset_id && finalReferenceIds.includes(selected.approved_asset_id) ? [selected.approved_asset_id] : [],
        useTalkingStyleAnalysis: talkingStyleMode || (selected.route === "real_person" && realStage === "current_shot" && selected.talking_style_analysis?.status === "approved"),
      }),
    });
    if (!payload) return null;
    setUploadAuthorized(false);
    onNotice(provider === "chatgpt_web" ? "已交给 ChatGPT 网页生成 1 张，不会自动重试" : "已交给 Codex 生成 1 张，不会自动重试");
    return payload;
  }

  async function retryCurrentStage() {
    const retryInstruction = [...retryReasons, retryNote.trim()].filter(Boolean).join("；");
    const payload = await generate(retryInstruction);
    if (!payload) return;
    setReviewPanel("none");
    setRetryReasons([]);
    setRetryNote("");
  }

  async function analyzeTalkingStyle() {
    if (!selected || !selectedBenchmarkId) return;
    const payload = await request(`/model-assets/projects/${selected.id}/analyze-style`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ benchmarkAssetId: selectedBenchmarkId, uploadAuthorized: styleUploadAuthorized }),
    });
    if (!payload) return;
    setStyleUploadAuthorized(false);
    onNotice("已开始分析对标图，只反推画面风格，不会生图");
  }

  async function startQuickTalkingStyle(event: FormEvent) {
    event.preventDefault();
    if (!quickMasterFile || !quickBenchmarkFile || !quickUploadConfirmed) return;
    setBusy(true);
    try {
      const createResponse = await fetch(`${API}/model-assets/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `现有模特对标画面-${new Date().toLocaleDateString("zh-CN")}`,
          route: "real_person",
          aiSourceMethod: null,
          brief: "使用用户已确认的现有模特母版，先匹配对标图的神态姿态，再复刻画质、设备、色调、场景和氛围。",
          designDirectionConfirmed: false,
          authorizationConfirmed: true,
          defaultGenerationProvider: provider,
        }),
      });
      const created = await createResponse.json();
      if (!createResponse.ok) throw new Error(created.error || "没有建立本次口播母版任务");
      const projectId = created.project.id;

      const masterForm = new FormData();
      masterForm.set("image", quickMasterFile);
      const masterResponse = await fetch(`${API}/model-assets/projects/${projectId}/import-master`, { method: "POST", body: masterForm });
      const masterPayload = await masterResponse.json();
      if (!masterResponse.ok) throw new Error(masterPayload.error || "模特母版没有保存成功");

      // Keep two explicit records for the same user-selected image.  Stage 1
      // may upload the pose record to generation; stage 2 uploads the style
      // record to analysis only and excludes it from final generation.
      const poseForm = new FormData();
      poseForm.set("image", quickBenchmarkFile);
      poseForm.set("category", "pose_reference");
      const poseResponse = await fetch(`${API}/model-assets/projects/${projectId}/assets`, { method: "POST", body: poseForm });
      const posePayload = await poseResponse.json();
      if (!poseResponse.ok) throw new Error(posePayload.error || "神态姿态对标图没有保存成功");

      const styleForm = new FormData();
      styleForm.set("image", quickBenchmarkFile);
      styleForm.set("category", "benchmark_style_reference");
      const styleResponse = await fetch(`${API}/model-assets/projects/${projectId}/assets`, { method: "POST", body: styleForm });
      const stylePayload = await styleResponse.json();
      if (!styleResponse.ok) throw new Error(stylePayload.error || "画质氛围对标图没有保存成功");

      initializedProjectIdRef.current = "";
      window.localStorage.setItem("workbench-selected-model-project", projectId);
      setTalkingStyleMode(false);
      setRealStage("performance_master");
      setCreating(false);
      setShowHome(false);
      setQuickTalkingOpen(false);
      setQuickMasterFile(null);
      setQuickBenchmarkFile(null);
      setQuickUploadConfirmed(false);
      await onRefresh();
      setSelectedId(projectId);
      onNotice("两张图片已经保存。先生成神态姿态母版，满意采用后再复刻画质氛围");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "本次口播母版任务没有建立成功", "error");
    } finally {
      setBusy(false);
    }
  }

  async function approveAndGenerateTalkingStyle() {
    if (!selected || !stylePrompt.trim()) return;
    if (!talkingStyleMode && !uploadAuthorized) {
      onNotice("请先确认只上传当前选中的人物母版，用于本次生成", "error");
      return;
    }
    const references = selected.route === "real_person"
      ? realPersonReferencesForStage(selected, "current_shot")
      : talkingStyleBaseReferences(selected);
    if (!references.length) {
      onNotice("请先上传或选择一张模特母版图", "error");
      return;
    }
    setBusy(true);
    try {
      const promptResponse = await fetch(`${API}/model-assets/projects/${selected.id}/style-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: stylePrompt }),
      });
      const promptPayload = await promptResponse.json();
      if (!promptResponse.ok) throw new Error(promptPayload.error || "画面描述没有保存成功");
      const referenceIds = [...new Set(references.map((asset) => asset.asset_id))];
      const generateResponse = await fetch(`${API}/model-assets/projects/${selected.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          referenceAssetIds: referenceIds,
          instruction,
          uploadAuthorized: talkingStyleMode ? true : uploadAuthorized,
          assetStage: "current_shot",
          parentAssetIds: referenceIds,
          useTalkingStyleAnalysis: true,
        }),
      });
      const generatePayload = await generateResponse.json();
      if (!generateResponse.ok) throw new Error(generatePayload.error || "新母版没有开始生成");
      await onRefresh();
      onNotice("已经开始生成新母版；原模特图和对标图都会保留");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "新母版没有开始生成", "error");
    } finally {
      setBusy(false);
    }
  }

  async function adopt(assetId: string) {
    if (!selected) return;
    const payload = await request(`/model-assets/projects/${selected.id}/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId }),
    });
    if (!payload) return;
    setPreviewAssetId(assetId);
    if (talkingStyleMode) {
      onNotice("这张图已采用为口播镜头母版；原始正式模特母版没有被覆盖");
      return;
    }
    if (selected.route === "real_person") {
      const currentIndex = realPersonStageOrder.indexOf(realStage);
      if (currentIndex < realPersonStageOrder.length - 1) selectRealPersonStage(realPersonStageOrder[currentIndex + 1], payload.project);
      onNotice(`${realPersonStageInfo[realStage].name}已采用；下一步只会使用这张正式母版，不会拿失败候选继续加工`);
    } else if (payload.project.ai_source_method === "single_reference_deidentify" && payload.project.ai_workflow_stage === "v0" && !payload.project.approved_asset_id) {
      setSelectedReferenceIds(payload.project.ai_active_bridge_asset_id ? [payload.project.ai_active_bridge_asset_id] : []);
      setPreviewAssetId("");
      setUploadAuthorized(false);
      setInstruction("");
      onNotice("去身份过桥图已确认；第二步只使用这张过桥图建立最终虚构模特，不会再回看原始人物图");
    } else {
      onNotice("这张图已采用为正式模特母版");
    }
  }

  async function useForTalking() {
    if (!selected) return;
    const talkingProjectId = savedTalkingHeadProjectId();
    const payload = await request(`/model-assets/projects/${selected.id}/use-for-talking`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ talkingProjectId }),
    });
    if (!payload) return;
    // The explicit action "用于 AI 口播" starts from the newly adopted
    // master.  A previously opened talking-head job must not win during the
    // next studio mount and silently replace this asset with its old person.
    // Removing only the local resume pointer preserves the historical job in
    // the task center while making the selected master the current input.
    try {
      const draft = JSON.parse(window.localStorage.getItem("workbench-talking-draft-v1") || "null");
      if (draft) window.localStorage.setItem("workbench-talking-draft-v1", JSON.stringify({...draft, jobId: null, stage: "setup", talkingProjectId}));
      else window.localStorage.setItem("workbench-talking-draft-v1", JSON.stringify({version: 1, jobId: null, stage: "setup", talkingProjectId}));
    } catch { /* The original job remains in the task center. */ }
    window.localStorage.removeItem("workbench-talking-head-job");
    window.localStorage.setItem("workbench-talking-head-person-asset", JSON.stringify(payload.asset));
    window.localStorage.setItem("workbench-talking-head-project-id", talkingProjectId);
    onNotice("模特母版已经自动带入口播项目");
    onUseForTalking();
  }

  if (quickTalkingOpen) {
    return (
      <section className="model-asset-studio model-quick-talking-page">
        <div className="model-focused-page-heading">
          <button type="button" onClick={() => { setQuickTalkingOpen(false); setShowHome(true); }}>← 返回模特资产</button>
          <div><small>已有满意母版</small><h1>做成对标画面</h1><p>上传一张模特母版和一张对标图，分两步生成：先匹配神态姿态，再匹配画质氛围。</p></div>
        </div>
        <section className="model-quick-talking-workspace">
          <div className="model-quick-talking-guide">
            <span>只需两张图</span>
            <h2>先准备参考图片</h2>
            <p>模特母版决定“是谁”。对标图先负责神态、姿态和机位，确认后再负责画质、设备、色调、场景和氛围。原图都会保留。</p>
            <div><i>1 上传两张图</i><i>2 匹配神态姿态</i><i>3 匹配画质氛围</i></div>
          </div>
          <form className="model-talking-quick-form" onSubmit={startQuickTalkingStyle}>
            <div className="model-talking-quick-files">
              <label className="model-file-input">
                <span>模特母版图</span><b>{quickMasterFile ? "重新选择" : "选择模特图"}</b>
                <small>{quickMasterFile?.name || "选择已经满意的人物母版"}</small>
                <input aria-label="快速上传模特母版图" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setQuickMasterFile(event.target.files?.[0] || null)} />
              </label>
              <label className="model-file-input">
                <span>想模仿的对标图</span><b>{quickBenchmarkFile ? "重新选择" : "选择对标图"}</b>
                <small>{quickBenchmarkFile?.name || "先参考神态姿态，再参考画质氛围"}</small>
                <input aria-label="快速上传口播对标图" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setQuickBenchmarkFile(event.target.files?.[0] || null)} />
              </label>
            </div>
            <label className="check-line"><input type="checkbox" checked={quickUploadConfirmed} onChange={(event) => setQuickUploadConfirmed(event.target.checked)} /><span>我确认这张母版属于本人、已获授权人物，或我有权使用的 AI 模特；并同意用这两张图完成本次分析和生成</span></label>
            <button className="model-action-button primary" type="submit" disabled={busy || !quickMasterFile || !quickBenchmarkFile || !quickUploadConfirmed}>{busy ? "正在保存图片…" : "保存图片，开始第 1 步 →"}</button>
            <small className="model-talking-quick-hint">保存后先进入神态姿态迁移，不会在这里自动生图。</small>
          </form>
        </section>
        {savedMasterProjects.length > 0 && <section className="model-quick-saved-models">
          <div><h2>也可以从已保存模特继续</h2><p>选择已有正式母版后，只需补充对标图。</p></div>
          <div className="model-talking-entry-projects">
            {savedMasterProjects.map((project) => (
              <button type="button" key={project.id} disabled={busy} onClick={() => chooseSavedMasterForQuickProject(project)}>
                <b>{modelProjectSourceBadge(project)}</b>
                <span><strong>{project.name}</strong><small>{modelProjectSourceLabel(project)} · 已有正式母版</small></span>
                <i>选用这张母版 →</i>
              </button>
            ))}
          </div>
        </section>}
      </section>
    );
  }

  if (showHome) {
    return (
      <section className="model-asset-studio model-asset-home">
        <header className="model-home-hero">
          <div><small>模特资产</small><h1>你想创建哪一种模特？</h1><p>先选人物来源，工作台再带你准备对应素材。两条路线各自保存，不会互相串图。</p></div>
          <span>{savedMasterProjects.length} 个模特资产 · {projects.length} 个项目</span>
        </header>
        <div className="model-home-routes" aria-label="选择模特路线">
          <button type="button" onClick={() => startNewModel("ai_model")}>
            <b>AI</b><span className="model-route-copy"><small>虚构人物</small><strong>AI 模特</strong><p>从零创建，或按人物资产 Skill 的来源方式建立长期虚构模特。</p><i>完全原创 · 多图融合 · 单图脱离 · 双人中间脸</i></span><em>开始创建 →</em>
          </button>
          <button type="button" onClick={() => startNewModel("real_person")}>
            <b>真</b><span className="model-route-copy"><small>本人／已授权人物</small><strong>真人模特</strong><p>从随手照开始，依次确认商业母版、发型、穿搭、姿态和最终画面。</p><i>五步独立确认 · 可回传修正版</i></span><em>上传照片 →</em>
          </button>
        </div>
        <section className="model-home-talking-entry" aria-label="用已有模特制作对标画面">
          <div className="model-talking-entry-copy">
            <span>已有满意母版？</span>
            <h2>拿现有模特做成对标画面</h2>
            <p>上传模特图和对标图，生成同样拍摄感觉的新母版。AI 模特和真人模特都可以使用。</p>
          </div>
          <button type="button" onClick={() => { setQuickTalkingOpen(true); setShowHome(false); }}>开始制作 <span>→</span></button>
        </section>
        <section className="model-home-library" id="my-model-assets">
          <div className="section-heading model-library-heading"><div><h2>{libraryView === "active" ? "我的模特资产" : "已移除的模特"}</h2><p>{libraryView === "active" ? "已经确认满意的模特会保存在这里，点开即可查看或继续使用。" : "这里只是从常用资产区隐藏，原图、项目和历史版本都还保留。"}</p></div><div className="model-library-view-switch" aria-label="模特资产状态"><button type="button" className={libraryView === "active" ? "selected" : ""} onClick={() => { setLibraryView("active"); setLibraryMenuProjectId(""); }}>使用中 <span>{savedMasterProjects.length}</span></button><button type="button" className={libraryView === "removed" ? "selected" : ""} onClick={() => { setLibraryView("removed"); setLibraryMenuProjectId(""); }}>已移除 <span>{removedMasterProjects.length}</span></button></div></div>
          <div className="model-home-library-tools">
            <label><span>搜索模特</span><input aria-label="搜索模特" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="输入项目名称或用途" /></label>
            <div aria-label="筛选模特类型">
              {([
                ["all", "全部"],
                ["ai_model", "AI 模特"],
                ["real_person", "真人模特"],
                ["imported_master", "现有母版"],
              ] as const).map(([value, label]) => (
                <button type="button" key={value} className={modelFilter === value ? "selected" : ""} onClick={() => setModelFilter(value)}>{label}<span>{modelCounts[value]}</span></button>
              ))}
            </div>
          </div>
          <div className="model-asset-gallery">
            {filteredApprovedModels.map(({ project, asset }) => (
              <article className="model-asset-card" key={project.id}>
                <button className="model-asset-card-open" type="button" onClick={() => openStandardProject(project)}>
                  <span className="model-asset-gallery-preview">
                    <img src={`${API}/model-assets/projects/${project.id}/assets/${asset.asset_id}/file`} alt={`${project.name} 模特资产缩略图`} />
                    <b>{modelProjectSourceBadge(project)}</b>
                  </span>
                  <span className="model-asset-gallery-copy">
                    <strong>{project.name}</strong>
                    <small>{modelProjectSourceLabel(project)} · {libraryView === "removed" ? "已移除" : modelProjectStatus(project)}</small>
                    <i>打开资产 →</i>
                  </span>
                </button>
                <button className="model-asset-card-menu-button" type="button" aria-label={`管理${project.name}`} aria-expanded={libraryMenuProjectId === project.id} onClick={() => setLibraryMenuProjectId((current) => current === project.id ? "" : project.id)}>•••</button>
                {libraryMenuProjectId === project.id && <div className="model-asset-card-menu" role="menu">
                  {libraryView === "active"
                    ? <button type="button" role="menuitem" onClick={() => { setArchiveTargetProjectId(project.id); setLibraryMenuProjectId(""); }}>移出模特资产库</button>
                    : <button type="button" role="menuitem" disabled={busy} onClick={() => updateLibraryStatus(project, false)}>恢复到模特资产库</button>}
                </div>}
              </article>
            ))}
            {filteredApprovedModels.length === 0 && <div className="model-home-empty">{libraryView === "removed" ? "这里还没有已移除的模特。" : savedMasterProjects.length === 0 ? "还没有保存的模特资产。生成候选并点击满意后，会自动出现在这里。" : "没有找到符合条件的模特资产。"}</div>}
          </div>
          {libraryView === "active" && <><div className="model-working-heading"><strong>制作中的项目</strong><span>{filteredWorkingProjects.length}</span></div>
          <div className="model-home-projects">
            {filteredWorkingProjects.map((project) => (
              <button type="button" key={project.id} onClick={() => openStandardProject(project)}>
                <b>{modelProjectSourceBadge(project)}</b><span><strong>{project.name}</strong><small>{modelProjectSourceLabel(project)} · {modelProjectStatus(project)}</small></span><i>打开 →</i>
              </button>
            ))}
            {filteredWorkingProjects.length === 0 && <div className="model-home-empty">{projects.length === 0 ? "还没有模特项目，请先从上面选择一条路线。" : "当前没有符合条件的制作中项目。"}</div>}
          </div></>}
          {archiveTargetProject && <div className="model-library-dialog-backdrop"><section className="model-library-dialog" role="dialog" aria-modal="true" aria-labelledby="model-library-dialog-title"><span>移出资产库</span><h3 id="model-library-dialog-title">移出“{archiveTargetProject.name}”？</h3><p>这张模特会从“我的模特资产”中隐藏；原图、项目和历史版本都不会删除，之后可以在“已移除”中恢复。</p><div><button type="button" onClick={() => setArchiveTargetProjectId("")}>取消</button><button type="button" disabled={busy} onClick={() => updateLibraryStatus(archiveTargetProject, true)}>确认移出</button></div></section></div>}
        </section>
      </section>
    );
  }

  return (
    <section className="model-asset-studio">
      <div className="model-asset-layout project-focus">
        <aside className="model-project-list">
          <div className="model-list-heading"><strong>我的模特</strong><span>{projects.length}</span></div>
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={selectedId === project.id ? "selected" : ""}
              onClick={() => openStandardProject(project)}
            >
              <b>{modelProjectSourceBadge(project)}</b>
              <span><strong>{project.name}</strong><small>{modelProjectStatus(project)}</small></span>
            </button>
          ))}
          {projects.length === 0 && <p>还没有模特项目，先在右侧建立一个。</p>}
        </aside>

        <div className="model-asset-main">
          {creating || !selected ? (
            <form className="model-create-card" onSubmit={createProject}>
              <div className="model-create-intro">
                <span className="model-route-badge">{route === "real_person" ? "真人模特" : "AI 模特"}</span>
                <div><h2>{route === "real_person" ? "先建立商业身份母版" : "选择 AI 模特的创建方式"}</h2><p>{route === "real_person" ? "现在只上传本人照片。建立项目后，工作台会按发型、穿搭、神态姿态和画质氛围逐步带你完成。" : "四种方式各自建立独立项目；需要参考图的路线会在下面显示对应上传位。"}</p></div>
                <button type="button" onClick={() => setShowHome(true)}>更换路线</button>
              </div>
              {route === "ai_model" && (
                <section className="ai-method-picker" aria-label="AI 模特创建方式">
                  <div className="ai-method-grid">
                    {aiModelSourceMethods.map((method) => (
                      <button
                        type="button"
                        key={method.id}
                        className={aiSourceMethod === method.id ? "selected" : ""}
                        onClick={() => { setAiSourceMethod(method.id); setAiDirectionConfirmed(false); setPendingSources([]); }}
                      >
                        <b>{method.letter}</b><span><strong>{method.name}</strong><p>{method.description}</p></span>
                      </button>
                    ))}
                  </div>
                  <div className="ai-method-guide"><strong>现在怎么选？</strong><span>{aiMethodSourceRequirement(aiSourceMethod)}</span></div>
                  {aiSourceMethod !== "original" && (
                    <section className="model-create-uploads ai-method-uploads" aria-label={`${aiModelSourceMethods.find((method) => method.id === aiSourceMethod)?.name}参考素材`}>
                      <div className="model-create-upload-heading">
                        <div><h3><span>1</span> 按职责上传参考图</h3><p>每张图只承担一个主要职责，工作台不会把完整身份机械拼在一起。</p></div>
                        <span>仅保存到当前项目</span>
                      </div>
                      <div className="model-create-upload-grid">
                        {aiMethodUploadSlots[aiSourceMethod].map((slot) => {
                          const staged = pendingSources.find((source) => source.category === slot.category);
                          return (
                            <label key={slot.category} className={`model-create-upload ${slot.required ? "required" : "model-create-upload-optional"}`}>
                              <span><strong>{slot.label}</strong><small>{slot.hint}</small></span>
                              <input aria-label={`上传${slot.label}`} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { stageSingleSource(slot.category, event.target.files); event.currentTarget.value = ""; }} />
                              <b>{staged ? `已选：${staged.file.name}` : slot.required ? "＋ 选择图片" : "＋ 可选添加"}</b>
                            </label>
                          );
                        })}
                      </div>
                      {pendingSources.length > 0 && (
                        <div className="model-pending-files">
                          {pendingSources.map((source) => (
                            <span key={source.id}><LocalImageThumbnail file={source.file} /><i>{modelAssetCategoryLabels[source.category]}</i>{source.file.name}<button type="button" aria-label={`移除 ${source.file.name}`} onClick={() => setPendingSources((current) => current.filter((item) => item.id !== source.id))}>移除</button></span>
                          ))}
                        </div>
                      )}
                    </section>
                  )}
                </section>
              )}
              {route === "real_person" && (
                <>
                  <section className="model-create-uploads" aria-label="真人模特照片与参考素材">
                    <div className="model-create-upload-heading">
                      <div><h3><span>1</span> 上传本人照片</h3><p>这是唯一必传素材。建议 3–5 张，工作台会把真实文件保存到当前项目。</p></div>
                      <span>仅保存到当前电脑</span>
                    </div>
                    <div className="model-primary-upload-row">
                      <label className="model-create-upload model-create-upload-primary required">
                        <span><strong>本人照片</strong><small>正面清晰照、左右 45°、自然表情</small></span>
                        <input aria-label="上传本人照片" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { stageSources("identity_source", event.target.files); event.currentTarget.value = ""; }} />
                        <b>{pendingSources.filter((source) => source.category === "identity_source").length ? `已选 ${pendingSources.filter((source) => source.category === "identity_source").length} 张，可继续添加` : "＋ 选择本人照片"}</b>
                      </label>
                    </div>
                    <label className="check-line model-portrait-consent"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} /><span>我确认这是本人，或已经取得该人物的肖像使用授权</span></label>
                    {pendingSources.length > 0 && (
                      <div className="model-pending-files">
                        {pendingSources.map((source) => (
                          <span key={source.id}>
                            <LocalImageThumbnail file={source.file} />
                            <i>{modelAssetCategoryLabels[source.category]}</i>
                            {source.file.name}
                            <button type="button" aria-label={`移除 ${source.file.name}`} onClick={() => setPendingSources((current) => current.filter((item) => item.id !== source.id))}>移除</button>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="model-local-note">这些图片此时只保存在当前模特项目；只有你之后勾选图片并点击生成，才会上传到所选生图渠道。</p>
                  </section>
                </>
              )}
              <section className="model-create-details">
                <div><h3><span>{route === "real_person" ? "2" : aiSourceMethod === "original" ? "1" : "2"}</span> {projectBriefRequired ? "确定人物方向" : "填写项目名称"}</h3><p>{projectBriefRequired ? "完全原创没有人物参考，需要用年龄感、气质和使用场景确定基础方向。" : "参考图已经决定主要人物方向；其他要求可以现在补充，也可以进入项目后再填写。"}</p></div>
                <label><span>项目名称</span><input aria-label="模特项目名称" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：品牌主理人口播模特" required /></label>
                <label><span>{projectBriefRequired ? "人物方向（必填）" : "补充要求（可选）"}</span><textarea aria-label="模特人物要求" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder={projectBriefRequired ? "例如：30岁左右、自然可信，主要用于知识口播和日常手机感短视频" : "例如：希望更松弛自然；没有补充可以留空"} required={projectBriefRequired} /></label>
                {route === "ai_model" && aiSourceMethod === "original" && <label className="check-line ai-direction-confirm"><input type="checkbox" checked={aiDirectionConfirmed} onChange={(event) => setAiDirectionConfirmed(event.target.checked)} /><span>我确认先按以上人物方向建立基础脸；候选不满意时可以重新生成，不会自动采用。</span></label>}
              </section>
              <section className="model-create-provider">
                <div><h3><span>{route === "real_person" ? "3" : aiSourceMethod === "original" ? "2" : "3"}</span> 选择生图渠道</h3><p>每次只生成 1 张候选，不满意时再由你主动重新生成。</p></div>
                <ModelProviderOptions
                  value={provider}
                  defaultValue={provider}
                  capabilities={capabilities}
                  chatgptStatusOverride="暂不可用"
                  onChange={setProvider}
                />
              </section>
              <div className={`model-create-submit ${creationMissingItems.length ? "incomplete" : "ready"}`}>
                <div><strong>{creationMissingItems.length ? `还差：${creationMissingItems.join("、")}` : "资料已准备好"}</strong><span>{creationMissingItems.length ? "补齐后即可建立项目；按钮仍可点击查看具体提示。" : "建立后会进入当前模特项目，不会自动开始付费生图。"}</span></div>
                <button type="submit" disabled={busy}>{busy ? "正在建立项目…" : route === "real_person" ? "保存照片，进入真人模特制作 →" : "建立 AI 模特项目 →"}</button>
              </div>
            </form>
          ) : (
            <>
              <div className="model-project-title">
                <button type="button" className="model-project-back" onClick={() => { setTalkingStyleMode(false); setShowHome(true); setCreating(false); }}>← 模特资产首页</button>
                <div><small>{importedMasterProject ? "现有模特做成对标画面" : talkingStyleMode ? "用已有模特制作口播母版" : selected.route === "ai_model" ? "AI 模特" : "真人模特"}</small><h2>{selected.name}</h2></div>
                {importedMasterProject
                  ? <button type="button" onClick={() => { setQuickTalkingOpen(true); setShowHome(false); setCreating(false); }}>＋ 新建对标画面</button>
                  : talkingStyleMode ? <span className="model-project-mode-badge">画面风格复刻</span> : <button type="button" onClick={() => startNewModel(selected.route)}>＋ 新建同类模特</button>}
              </div>
              {approvedImage && <section className="model-ready-summary" aria-label="已确认模特与下一步">
                <button type="button" className="model-preview-button" onClick={() => setZoomAssetId(approvedImage.asset_id)}><img src={`${API}/model-assets/projects/${selected.id}/assets/${approvedImage.asset_id}/file`} alt="已确认的模特母版" onError={() => setFailedImageId(approvedImage.asset_id)} onLoad={() => setFailedImageId("")} /></button>
                <div><small>已保存的正式母版 · {modelProjectStatus(selected)}</small><h3>这张模特可以继续用于口播</h3><p>采用后带回口播设置，继续准备内容和声音。</p>
                {failedImageId === approvedImage.asset_id && <p role="alert">图片暂时无法加载，请刷新重试或检查原项目素材。</p>}
                <button className="model-action-button primary" type="button" disabled={busy || failedImageId === approvedImage.asset_id} onClick={useForTalking}>继续用于 AI 口播 →</button>
                <button className="model-action-button secondary" type="button" onClick={openModelAssetLibrary}>查看我的模特资产 →</button>
                <button className="model-action-button secondary" type="button" onClick={() => setShowGenerationForm((value) => !value)}>{showGenerationForm ? "收起修改区域" : "查看阶段与修改母版"}</button></div>
              </section>}
              <div className="model-editing-area" hidden={Boolean(approvedImage) && selected.status === "approved" && !showGenerationForm}>
              {importedMasterProject
                ? <div className="model-talking-mode-intro"><strong>分两步做成对标画面</strong><span>先确认神态姿态，再复刻画质氛围；每一步都由你决定是否采用。</span></div>
                : talkingStyleMode ? <div className="model-talking-mode-intro"><strong>用这张模特图，生成对标画面的新母版</strong><span>原模特图会保留，对标图不会替换人物。</span></div> : <details className="model-project-brief"><summary>查看项目用途和人物要求</summary><p>{selected.brief}</p></details>}

              {selected.route === "real_person" && !talkingStyleMode && (
                <section className="real-person-progress" aria-label={importedMasterProject ? "现有模特对标画面制作步骤" : "真人模特制作步骤"}>
                  <div className="real-person-progress-heading">
                    <div><h3>{importedMasterProject ? "对标画面分两步完成" : "当前制作阶段"}</h3></div>
                    <span>当前：{realPersonStageInfo[realStage].name}</span>
                  </div>
                  <div className="real-person-stage-tabs">
                    {visibleRealPersonStages.map((stage, visibleIndex) => {
                      const approvedId = selected.active_asset_lock?.[`${stage}_asset_id` as keyof NonNullable<ModelAssetProject["active_asset_lock"]>];
                      const unlocked = isRealPersonStageUnlocked(selected, stage);
                      return (
                        <button type="button" key={stage} className={`${stage === realStage ? "selected" : ""} ${approvedId ? "completed" : ""}`} disabled={!unlocked} onClick={() => selectRealPersonStage(stage)}>
                          <b>{approvedId ? "✓" : importedMasterProject ? visibleIndex + 1 : realPersonStageInfo[stage].number}</b>
                          <span><strong>{realPersonStageInfo[stage].name}</strong><small>{approvedId ? "已确认，可随时回来查看" : unlocked ? realPersonStageInfo[stage].short : "完成前一步后开放"}</small></span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {selected.route === "ai_model" && selected.ai_source_method === "single_reference_deidentify" && (
                <section className="real-person-progress ai-deidentify-progress" aria-label="单图脱离制作步骤">
                  <div className="real-person-progress-heading"><div><h3>单图脱离分两步完成</h3></div><span>当前：{selected.ai_workflow_stage === "deidentify_bridge" ? "去身份过桥" : "最终虚构模特"}</span></div>
                  <div className="real-person-stage-tabs">
                    <button type="button" className={selected.ai_workflow_stage === "deidentify_bridge" ? "selected" : "completed"}><b>{selected.ai_workflow_stage === "deidentify_bridge" ? "1" : "✓"}</b><span><strong>去身份过桥</strong><small>{selected.ai_workflow_stage === "deidentify_bridge" ? "先做重大结构变换" : "已确认，不再回看原图"}</small></span></button>
                    <button type="button" disabled={selected.ai_workflow_stage === "deidentify_bridge"} className={selected.ai_workflow_stage === "v0" ? "selected" : ""}><b>2</b><span><strong>最终虚构模特</strong><small>只使用已确认过桥图</small></span></button>
                  </div>
                </section>
              )}

              <div className="model-step-grid">
                <section className="model-step-card">
                  <div className="step-number">1</div><h3>{importedMasterProject && realStage === "performance_master" ? "确认人物图和神态姿态对标图" : referenceStepTitle(selected, talkingStyleMode)}</h3>
                  <p>{referenceStepDescription(selected, talkingStyleMode, realStage)}</p>
                  {(talkingStyleMode || modelAssetUploadCategories(selected, realStage).length > 0) && <form onSubmit={uploadSource}>
                    {!talkingStyleMode && modelAssetUploadCategories(selected, realStage).length > 1 && <label><span>这张图用来参考什么</span><select name="category" aria-label="模特参考图用途" value={category} onChange={(event) => setCategory(event.target.value as ModelAssetCategory)}>
                      {modelAssetUploadCategories(selected, realStage).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select></label>}
                    {!talkingStyleMode && modelAssetUploadCategories(selected, realStage).length === 1 && <input type="hidden" name="category" value={modelAssetUploadCategories(selected, realStage)[0][0]} />}
                    {talkingStyleMode && <input type="hidden" name="category" value="benchmark_style_reference" />}
                    <label className="model-file-input">
                      <span>{talkingStyleMode || (selected.route === "real_person" && realStage === "current_shot") ? "上传一张画质氛围对标图" : `上传${modelAssetCategoryLabels[category] || "参考图片"}`}</span>
                      <b>{uploadFile ? "重新选择图片" : "选择图片"}</b>
                      <small>{uploadFile ? uploadFile.name : "支持 PNG、JPG、WebP"}</small>
                      <input aria-label="上传模特参考图" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setUploadFile(event.target.files?.[0] || null)} />
                    </label>
                    <button className="model-action-button secondary" type="submit" disabled={busy || !uploadFile}>{talkingStyleMode || (selected.route === "real_person" && realStage === "current_shot") ? "保存对标图" : "保存这张参考图"}</button>
                  </form>}
                  {!talkingStyleMode && selected.route === "ai_model" && selected.ai_source_method === "original" && <div className="stage-reference-rule"><strong>完全原创：</strong>不上传任何人物参考脸，直接根据已确认用途和人物方向建立新人物。</div>}
                  {selected.route === "ai_model" && selected.ai_source_method === "single_reference_deidentify" && selected.ai_workflow_stage === "v0" && <div className="stage-reference-rule"><strong>身份隔离：</strong>第二步已锁定为只使用过桥图，原始参考不会再次进入生图。</div>}
                  {talkingStyleMode && <div className="stage-reference-rule"><strong>本次人物：</strong>使用你上传或选中的模特母版，原图不会被覆盖。</div>}
                  {selected.route === "real_person" && !talkingStyleMode && <div className="stage-reference-rule"><strong>这一阶段会用：</strong>{realPersonStageReferenceSummary(realStage)}</div>}
                  {selected.route === "real_person" && !talkingStyleMode && realStage === "performance_master" && <section className="performance-identity-guide" aria-label="第四阶段近景身份图帮助">
                    <div className="performance-identity-guide-heading">
                      <div><strong>人物图怎么选更稳？</strong><p>优先选择已经换好发型和穿搭、胸口以上、脸清楚的照片。这样更不容易被对标人物带偏；如果没有，也可以直接选择全身穿搭母版继续，最终选择权在你。</p></div>
                      <span>提醒，不强制</span>
                    </div>
                    <div className="performance-identity-helper-options">
                      <form onSubmit={uploadCloseupIdentitySource}>
                        <strong>我已有合适的近景图</strong>
                        <p>上传你自己修过或另行准备的同一人物近景图。</p>
                        <label className="model-file-input compact">
                          <span>上传近景人物图</span>
                          <b>{closeupIdentityFile ? "重新选择" : "选择图片"}</b>
                          <small>{closeupIdentityFile ? closeupIdentityFile.name : "PNG、JPG、WebP"}</small>
                          <input aria-label="上传已有近景人物图" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setCloseupIdentityFile(event.target.files?.[0] || null)} />
                        </label>
                        <button className="model-action-button secondary" type="submit" disabled={busy || selected.status === "running" || !closeupIdentityFile}>保存并选用这张近景图</button>
                      </form>
                      <div>
                        <strong>我没有合适的近景图</strong>
                        <p>系统只用已采用的商业身份母版和发型穿搭母版，生成 1 张新的近景身份图；不会用神态姿态对标图。</p>
                        <div className="closeup-helper-provider">当前渠道：{provider === "chatgpt_web" ? "ChatGPT 网页生图" : "Codex 内置生图"}</div>
                        <label className="check-line consent-box"><input type="checkbox" checked={closeupUploadAuthorized} onChange={(event) => setCloseupUploadAuthorized(event.target.checked)} /><span>我同意只上传这 2 张已采用母版，用于本次生成</span></label>
                        <button className="model-action-button primary" type="button" disabled={busy || selected.status === "running" || !closeupUploadAuthorized || (provider === "chatgpt_web" && !capabilities.chatgptWebAvailable) || !selected.active_asset_lock?.v0_asset_id || !selected.active_asset_lock?.styled_anchor_asset_id} onClick={generateCloseupIdentitySource}>生成 1 张近景身份图</button>
                      </div>
                    </div>
                  </section>}
                  {(talkingStyleMode || (selected.route === "real_person" && realStage === "current_shot")) && (
                    <section className="talking-style-reverse" aria-label="口播母版画面风格复刻">
                      <div className="talking-style-reverse-heading">
                        <div><strong>匹配这张图的拍摄感觉</strong><p>系统会自动整理构图、光线、姿态和画质。</p></div>
                        <span>不换人</span>
                      </div>
                      <div className="talking-style-benchmark-list">
                        {selected.assets.filter((asset) => asset.category === "benchmark_style_reference").map((asset) => (
                          <label key={asset.asset_id} className={selectedBenchmarkId === asset.asset_id ? "selected" : ""}>
                            <input type="radio" name="talking-style-benchmark" checked={selectedBenchmarkId === asset.asset_id} onChange={() => { setSelectedBenchmarkId(asset.asset_id); setStyleUploadAuthorized(false); }} />
                            <img src={`${API}/model-assets/projects/${selected.id}/assets/${asset.asset_id}/file`} alt={asset.original_name} />
                            <span><strong>{asset.original_name}</strong><small>只用于画面分析，不进入最终生图</small></span>
                          </label>
                        ))}
                        {!selected.assets.some((asset) => asset.category === "benchmark_style_reference") && <p>请先在上方把图片用途选为“口播对标图（只分析）”并保存。</p>}
                      </div>
                      {selectedBenchmarkId && <label className="check-line consent-box"><input type="checkbox" checked={styleUploadAuthorized} onChange={(event) => setStyleUploadAuthorized(event.target.checked)} /><span>我同意上传这 1 张对标图，只用于本次画面风格反推</span></label>}
                      {selected.talking_style_analysis?.status === "running" ? <button type="button" disabled>正在分析画面风格…</button> : <button type="button" disabled={busy || !selectedBenchmarkId || !styleUploadAuthorized} onClick={analyzeTalkingStyle}>{selected.talking_style_analysis ? "重新分析这张对标图" : "分析画面风格"}</button>}
                      {selected.talking_style_analysis?.error && <div className="model-error"><strong>这次分析没有完成</strong><p>{selected.talking_style_analysis.error}</p></div>}
                      {selected.talking_style_analysis?.reverse_conclusion && <details className="talking-style-conclusion"><summary>查看反推结论</summary><div>{selected.talking_style_analysis.reverse_conclusion}</div></details>}
                      {selected.talking_style_analysis?.generation_prompt && (
                        <div className="talking-style-prompt-editor">
                          <div className="talking-style-ready"><strong>对标画面已经准备好</strong><p>系统已经理解了它的构图、光线、姿态和画质；不会照搬对标人物、字幕或水印。</p></div>
                          <details>
                            <summary>高级设置：查看或修改画面描述</summary>
                            <label><span>画面描述</span><textarea aria-label="口播母版画面提示词" value={stylePrompt} onChange={(event) => setStylePrompt(event.target.value)} /></label>
                            <small>{selected.route === "real_person" ? "这里只显示 V3 标记区域内的最终画面提示词；分析过程不会提交生图。" : "开头的展示标题在正式生图前会自动移除，不会提交给模型。"}</small>
                          </details>
                          {talkingStyleMode && <button className="model-action-button primary" type="button" disabled={busy || !stylePrompt.trim() || (provider === "chatgpt_web" && !capabilities.chatgptWebAvailable)} onClick={approveAndGenerateTalkingStyle}>{busy ? "正在生成…" : "生成新母版 →"}</button>}
                        </div>
                      )}
                    </section>
                  )}
                  <div className="model-source-list">
                    {generationReferenceAssets.map((asset) => {
                      const performanceRole = selected.route === "real_person" && realStage === "performance_master";
                      const performancePose = performanceRole && asset.category === "pose_reference";
                      return (
                      <label key={asset.asset_id}>
                        <input
                          type={selected.route === "ai_model" && selected.ai_source_method === "single_reference_deidentify" || performanceRole ? "radio" : "checkbox"}
                          name={selected.route === "ai_model" && selected.ai_source_method === "single_reference_deidentify" ? "single-deidentify-reference" : performanceRole ? performancePose ? "performance-pose-reference" : "performance-identity-reference" : undefined}
                          checked={selectedReferenceIds.includes(asset.asset_id)}
                          onChange={(event) => setSelectedReferenceIds((current) => selected.route === "real_person"
                            ? toggleRealPersonReference(selected, realStage, asset, event.target.checked, current)
                            : selected.ai_source_method === "single_reference_deidentify"
                              ? event.target.checked ? [asset.asset_id] : []
                              : event.target.checked ? [...new Set([...current, asset.asset_id])] : current.filter((id) => id !== asset.asset_id))}
                        />
                        <img src={`${API}/model-assets/projects/${selected.id}/assets/${asset.asset_id}/file`} alt={asset.original_name} />
                        <span><strong>{asset.asset_stage === "deidentify_bridge" ? "已确认去身份过桥图" : selected.route === "real_person" ? realPersonReferenceLabel(selected, realStage, asset) : modelAssetCategoryLabels[asset.category]}</strong><small>{asset.original_name}</small></span>
                      </label>
                    )})}
                  </div>
                </section>

                <section className="model-step-card">
                  <div className="step-number">2</div><h3>{talkingStyleMode ? "选择生成方式" : selected.route === "real_person" ? `生成：${realPersonStageInfo[realStage].name}` : aiGenerationHeading(selected)}</h3>
                  <p>{talkingStyleMode ? "选好渠道后，回到上面的“生成新母版”即可。每次只生成 1 张，不满意再重新生成。" : selected.route === "real_person" ? "默认只生成 1 张候选。对本阶段不满意时，从同一正式来源重新生成，不把失败候选继续往下加工。" : "选择本次执行渠道。切换渠道不会改变人物规则，也不会自动重复提交。"}</p>
                  <ModelProviderOptions
                    value={provider}
                    defaultValue={selected.default_generation_provider}
                    capabilities={capabilities}
                    chatgptStatusOverride="暂不可用"
                    onChange={setProvider}
                  />
                  <label><span>补充要求（可选）</span><textarea aria-label="本次模特生成要求" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={talkingStyleMode ? "例如：表情更松弛，眼神自然看向镜头；没有补充可以留空" : selected.route === "real_person" ? realPersonStageInfo[realStage].placeholder : aiGenerationPlaceholder(selected)} /></label>
                  {(talkingStyleMode || (selected.route === "real_person" && realStage === "current_shot")) && selected.talking_style_analysis?.status === "approved" && <div className="stage-reference-rule"><strong>已启用：</strong>口播母版画面风格复刻。对标图已排除，最终只提交人物资产与已确认的画面描述。</div>}
                  {!talkingStyleMode && selectedReferenceIds.length > 0 && <label className="check-line consent-box"><input type="checkbox" checked={uploadAuthorized} onChange={(event) => setUploadAuthorized(event.target.checked)} /><span>我同意只上传上面勾选的 {selectedReferenceIds.length} 张图片，用于本次生成</span></label>}
                  <div className="privacy-line">{provider === "chatgpt_web" ? "使用当前 ChatGPT 网页额度，不占用 Codex 生图额度；每次从新对话开始。" : "使用 Codex 内置生图额度；一次只生成 1 张。"} 不自动重试。</div>
                  {selected.status === "running" ? <>
                    <button className="model-action-button primary" type="button" disabled>正在生成第 {selected.active_attempt?.attempt_number} 版…</button>
                    <div className="stage-reference-rule"><strong>当前阶段：</strong>{selected.active_attempt?.progress_message || "人物 Skill 正在准备生成任务；尚未进入正式生图。"}</div>
                    <div className="privacy-line">可以离开页面；后台会继续执行。一次只生成 1 张，不会自动重试。</div>
                  </> : <>
                    <div className={`model-generation-readiness ${generationReady ? "ready" : "blocked"}`}>
                      <strong>{currentStageApproved ? generationReady ? "可以重新生成" : "当前阶段已完成" : generationReady ? "可以开始生成" : "生成前还需完成"}</strong>
                      <span>{currentStageApproved && !generationReady
                        ? `当前采用版本不会受影响；如需重新生成：${generationBlockedReason.replace(/^还差一步：/, "")}`
                        : generationReady
                          ? selectedReferenceIds.length ? `已选择 ${selectedReferenceIds.length} 张参考图，上传范围已确认。` : "完全原创路线不需要上传参考图，当前条件已齐。"
                          : generationBlockedReason}</span>
                    </div>
                    {!talkingStyleMode && !(selected.route === "real_person" && realStage === "current_shot") && <button className="model-action-button primary" type="button" disabled={!generationReady} onClick={() => generate()}>{selected.route === "ai_model" && selected.ai_source_method === "single_reference_deidentify"
                      ? selected.ai_workflow_stage === "deidentify_bridge" ? "生成去身份过桥图" : "生成最终虚构模特"
                      : candidates.length ? `重新生成${selected.route === "real_person" ? `「${realPersonStageInfo[realStage].name}」` : ""} 1 张` : "生成第 1 张候选"}</button>}
                    {!talkingStyleMode && selected.route === "real_person" && realStage === "current_shot" && <button className="model-action-button primary" type="button" disabled={!generationReady} onClick={approveAndGenerateTalkingStyle}>{candidates.length ? "重新生成「复刻画质氛围」1 张" : "生成最终画面母版 →"}</button>}
                  </>}
                  {selected.last_error && <div className="model-error"><strong>这次没有完成</strong><p>{modelAssetGenerationError(selected.last_error)}</p></div>}
                </section>
              </div>

              <section className="model-result-card">
                  <div className="step-number">3</div><div className="model-result-heading"><div><h3>{talkingStyleMode ? "查看并采用口播母版" : selected.route === "real_person" ? `审核：${realPersonStageInfo[realStage].name}` : selected.ai_source_method === "single_reference_deidentify" && selected.ai_workflow_stage === "deidentify_bridge" ? "审核去身份过桥图" : "查看、采用或继续修改"}</h3><p>不满意可以填写新要求重生成，也可以把自己修过的图片重新上传；原候选始终保留。</p></div>{talkingStyleMode ? selectedPreview?.status === "candidate" ? <span className="approved-badge">当前候选待确认</span> : (selected.route === "ai_model" ? selected.ai_talking_asset_id : selected.active_asset_lock?.current_shot_asset_id) && <span className="approved-badge">口播母版已确认</span> : selected.route === "real_person" ? selected.active_asset_lock?.[`${realStage}_asset_id` as keyof NonNullable<ModelAssetProject["active_asset_lock"]>] && <span className="approved-badge">本阶段已确认</span> : selected.status === "approved" && <span className="approved-badge">已有正式母版</span>}</div>
                {selectedPreview ? (
                  <div className="model-result-preview">
                    <button type="button" className="model-preview-button" onClick={() => setZoomAssetId(selectedPreview.asset_id)}>
                      <img src={`${API}/model-assets/projects/${selected.id}/assets/${selectedPreview.asset_id}/file`} alt="模特候选预览" />
                      <span>点击放大查看</span>
                    </button>
                    <div className="model-candidate-strip">{candidates.map((asset) => <button type="button" key={asset.asset_id} className={selectedPreview.asset_id === asset.asset_id ? "selected" : ""} onClick={() => setPreviewAssetId(asset.asset_id)}><img src={`${API}/model-assets/projects/${selected.id}/assets/${asset.asset_id}/file`} alt={`第${asset.attempt_number || "修"}版`} /><small>{asset.source_kind === "generated" ? `${asset.generation_provider === "chatgpt_web" ? "ChatGPT" : "Codex"} 第${asset.attempt_number}版` : "我的修正版"}</small></button>)}</div>
                    {selectedPreview.execution_summary && <div className="model-candidate-qc"><strong>生成自检</strong><p>{selectedPreview.execution_summary}</p></div>}
                    {selected.route === "real_person" ? <div className="model-review-actions" aria-label="本阶段候选操作">
                      <button className="model-review-adopt" type="button" disabled={busy || selectedPreview.status === "approved"} onClick={() => adopt(selectedPreview.asset_id)}>{selectedPreview.status === "approved" ? realStage === "current_shot" ? "已保存到模特资产库" : "已满意并采用" : realStage === "current_shot" ? "满意，保存到我的模特资产库" : "满意，采用"}<small>{realStage === "current_shot" ? "作为最终可复用模特资产" : "作为本阶段正式母版"}</small></button>
                      <button className="model-review-retry" type="button" disabled={busy} onClick={() => setReviewPanel((current) => current === "retry" ? "none" : "retry")}>不满意，重新生成<small>原候选和已采用版本都保留</small></button>
                      <button className="model-review-upload" type="button" disabled={busy} onClick={() => setReviewPanel((current) => current === "revision" ? "none" : "revision")}>我修过了，上传新版<small>作为独立候选，不覆盖原图</small></button>
                    </div> : <div className="model-result-actions">
                      {selectedPreview.status !== "approved" && <button className="model-action-button primary" type="button" disabled={busy} onClick={() => adopt(selectedPreview.asset_id)}>{talkingStyleMode ? "满意，采用为口播镜头母版" : selectedPreview.asset_stage === "deidentify_bridge" ? "满意，采用为去身份过桥图" : "满意，保存到我的模特资产库"}</button>}
                      
                      {selectedPreview.status === "approved" && !talkingStyleMode && selected.route !== "real_person" && selected.approved_asset_id === selectedPreview.asset_id && <div className="model-saved-confirmation"><span><strong>已保存到我的模特资产库</strong><small>以后可从模特资产首页找到并继续使用。</small></span><button type="button" onClick={openModelAssetLibrary}>查看我的模特资产 →</button></div>}
                    </div>}
                    <div className="model-result-actions">
                      
                      {selectedPreview.status === "approved" && !talkingStyleMode && selected.route === "real_person" && realStage === "current_shot" && <div className="model-saved-confirmation"><span><strong>已保存到我的模特资产库</strong><small>以后可从模特资产首页找到并继续使用。</small></span><button type="button" onClick={openModelAssetLibrary}>查看我的模特资产 →</button></div>}
                    </div>
                    {selected.route === "real_person" && reviewPanel === "retry" && <section className="model-retry-panel" aria-label="重新生成本阶段候选">
                      <div><strong>这次主要哪里不满意？</strong><p>可以不选原因直接重生成；如果选择，工作台只把它作为本次返工补充，不会改动五阶段原始提示词。</p></div>
                      <div className="model-retry-reasons">{realPersonRetryReasonOptions(realStage).map((reason) => <button key={reason} type="button" className={retryReasons.includes(reason) ? "selected" : ""} onClick={() => setRetryReasons((current) => current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason])}>{reason}</button>)}</div>
                      <label><span>其他补充（可选）</span><textarea aria-label="本阶段重新生成补充" value={retryNote} onChange={(event) => setRetryNote(event.target.value)} placeholder="只写最想修正的一点；没有可以留空" /></label>
                      {!talkingStyleMode && selectedReferenceIds.length > 0 && <label className="check-line consent-box"><input type="checkbox" checked={uploadAuthorized} onChange={(event) => setUploadAuthorized(event.target.checked)} /><span>我同意仍只上传当前勾选的 {selectedReferenceIds.length} 张图片，用于重新生成这一版</span></label>}
                      <button className="model-action-button primary" type="button" disabled={!generationReady} onClick={retryCurrentStage}>重新生成 1 张</button>
                      {!generationReady && <small>{generationBlockedReason}</small>}
                    </section>}
                    {selected.route === "real_person" && reviewPanel === "revision" && (
                      <form className="model-revision-upload" onSubmit={uploadRevision}>
                        <div><strong>你在其他软件里修过这张？</strong><p>上传后会成为当前阶段的新候选，并记录来源；不会覆盖原图，也不会继承其他旧候选。</p></div>
                        <label className="model-file-input">
                          <span>上传我修过的新版</span>
                          <b>{revisionFile ? "重新选择修正版" : "选择修正版图片"}</b>
                          <small>{revisionFile ? revisionFile.name : "上传后会新增候选，不覆盖原图"}</small>
                          <input aria-label="上传我修过的人物版本" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setRevisionFile(event.target.files?.[0] || null)} />
                        </label>
                        <button className="model-action-button secondary" type="submit" disabled={busy || !revisionFile}>保存为独立修正版候选</button>
                      </form>
                    )}
                  </div>
                ) : <div className="empty-model-result">候选返回后会显示在这里；刷新和离开页面不会丢失。</div>}
              </section>
              </div>
            </>
          )}
          {selected && zoomAssetId && (
            <div className="talking-person-lightbox" role="dialog" aria-modal="true" aria-label="模特候选大图">
              <button type="button" onClick={() => setZoomAssetId("")} aria-label="关闭模特候选大图">×</button>
              <Image src={`${API}/model-assets/projects/${selected.id}/assets/${zoomAssetId}/file`} width={1800} height={1800} unoptimized alt="模特候选大图" />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function modelProjectFinalAsset(project: ModelAssetProject) {
  const id = project.route === "real_person" ? project.active_asset_lock?.current_shot_asset_id : project.ai_talking_asset_id || project.approved_asset_id;
  return project.assets.find((asset) => asset.asset_id === id && asset.status === "approved");
}
export function modelProjectComplete(project: ModelAssetProject) {
  return project.status === "approved" && Boolean(modelProjectFinalAsset(project));
}

export function modelProjectStatus(project: ModelAssetProject) {
  if (["blocked", "failed_after_submit"].includes(project.status)) return "本次未完成，需要处理（已确认母版保留）";
  if (project.talking_style_analysis?.status === "running") return "正在分析口播画面";
  if (project.status === "running") return "正在生成";
  if (project.status === "needs_review") return "有候选等你确认";
  if (project.route === "ai_model" && project.ai_talking_asset_id) return "口播母版已确认";
  if (project.route === "real_person" && project.active_asset_lock?.current_shot_asset_id) return "口播母版已确认";
  if (project.route === "real_person" && project.active_asset_lock?.performance_master_asset_id) return "待复刻画质氛围";
  if (project.route === "real_person" && project.active_asset_lock?.styled_anchor_asset_id) return "待匹配神态姿态";
  if (project.route === "real_person" && project.active_asset_lock?.appearance_bridge_asset_id) return "发型母版已确认";
  if (project.route === "real_person" && project.active_asset_lock?.v0_asset_id) return "身份母版已确认";
  if (project.status === "approved") return "已采用正式母版";
  if (["blocked", "failed_after_submit"].includes(project.status)) return "需要处理";
  return "待继续";
}

export function isImportedMasterProject(project: ModelAssetProject) {
  return project.assets.some((asset) => asset.category === "imported_master");
}

function modelProjectSourceBadge(project: ModelAssetProject) {
  if (isImportedMasterProject(project)) return "母";
  return project.route === "ai_model" ? "AI" : "真";
}

export function modelProjectSourceLabel(project: ModelAssetProject) {
  if (isImportedMasterProject(project)) return "现有模特母版";
  return project.route === "ai_model" ? "AI 模特" : "真人模特";
}

function preferredReusableMasterAsset(project: ModelAssetProject) {
  const assetById = (assetId: string | null | undefined) =>
    assetId ? project.assets.find((asset) => asset.asset_id === assetId && asset.status === "approved") || null : null;
  if (project.route === "ai_model") return assetById(project.approved_asset_id);
  return assetById(project.active_asset_lock?.current_shot_asset_id)
    || assetById(project.active_asset_lock?.performance_master_asset_id)
    || assetById(project.active_asset_lock?.styled_anchor_asset_id)
    || assetById(project.active_asset_lock?.appearance_bridge_asset_id)
    || assetById(project.active_asset_lock?.v0_asset_id)
    || assetById(project.approved_asset_id);
}

function talkingStyleBaseReferences(project: ModelAssetProject) {
  const assetById = (assetId: string | null | undefined) =>
    assetId ? project.assets.find((asset) => asset.asset_id === assetId && asset.status === "approved") || null : null;
  if (project.route === "ai_model") {
    const base = assetById(project.approved_asset_id);
    return base ? [base] : [];
  }
  const base = assetById(project.active_asset_lock?.performance_master_asset_id);
  return base ? [base] : [];
}

function LocalImageThumbnail({ file }: { file: File }) {
  const [source] = useState(() => URL.createObjectURL(file));
  useEffect(() => {
    return () => URL.revokeObjectURL(source);
  }, [source]);
  return <img src={source} alt={`${file.name} 本地预览`} />;
}

function suggestedRealPersonStage(project: ModelAssetProject): RealPersonAssetStage {
  const lock = project.active_asset_lock;
  if (!lock?.v0_asset_id) return "v0";
  if (!lock.appearance_bridge_asset_id) return "appearance_bridge";
  if (!lock.styled_anchor_asset_id) return "styled_anchor";
  if (!lock.performance_master_asset_id) return "performance_master";
  return "current_shot";
}

function isRealPersonStageUnlocked(project: ModelAssetProject, stage: RealPersonAssetStage) {
  if (stage === "v0") return true;
  if (stage === "appearance_bridge") return Boolean(project.active_asset_lock?.v0_asset_id);
  if (stage === "styled_anchor") return Boolean(project.active_asset_lock?.appearance_bridge_asset_id);
  if (stage === "performance_master") return Boolean(project.active_asset_lock?.styled_anchor_asset_id);
  return Boolean(project.active_asset_lock?.performance_master_asset_id);
}

function realPersonReferencesForStage(project: ModelAssetProject, stage: RealPersonAssetStage) {
  const lock = project.active_asset_lock;
  const assetById = (assetId: string | null | undefined) =>
    assetId ? project.assets.find((asset) => asset.asset_id === assetId) || null : null;
  const sources = (categories: ModelAssetCategory[]) => project.assets.filter(
    (asset) => asset.status === "source_ready" && categories.includes(asset.category),
  );
  const references: Array<ModelAssetItem | null> = [];
  if (stage === "v0") references.push(...sources(["identity_source"]));
  if (stage === "appearance_bridge") {
    references.push(assetById(lock?.v0_asset_id), ...sources(["hair_reference"]));
  }
  if (stage === "styled_anchor") {
    references.push(
      assetById(lock?.appearance_bridge_asset_id),
      ...sources(["body_identity_reference"]),
      ...sources(["wardrobe_reference"]),
    );
  }
  if (stage === "performance_master") {
    const identityAnchors = project.assets.filter((asset) =>
      ["source_ready", "approved"].includes(asset.status)
        && asset.category === "styled_identity_anchor"
        && (
          asset.source_kind === "user_upload"
          || asset.derived_from_asset_id === lock?.styled_anchor_asset_id
        )
    ).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    references.push(...identityAnchors, assetById(lock?.styled_anchor_asset_id), ...sources(["pose_reference"]).slice(-1));
  }
  if (stage === "current_shot") {
    references.push(assetById(lock?.performance_master_asset_id));
  }
  return references.filter((asset): asset is ModelAssetItem => Boolean(asset)).filter(
    (asset, index, all) => all.findIndex((candidate) => candidate.asset_id === asset.asset_id) === index,
  );
}

function defaultRealPersonReferenceIdsForStage(project: ModelAssetProject, stage: RealPersonAssetStage) {
  const references = realPersonReferencesForStage(project, stage);
  if (stage !== "performance_master") return references.slice(0, 5).map((asset) => asset.asset_id);
  const identity = references.find((asset) => asset.category === "styled_identity_anchor" && asset.source_kind !== "derived_crop")
    || references.find((asset) => asset.asset_id === project.active_asset_lock?.styled_anchor_asset_id);
  const pose = references.find((asset) => asset.category === "pose_reference");
  return [identity?.asset_id, pose?.asset_id].filter((assetId): assetId is string => Boolean(assetId));
}

function toggleRealPersonReference(
  project: ModelAssetProject,
  stage: RealPersonAssetStage,
  asset: ModelAssetItem,
  checked: boolean,
  current: string[],
) {
  if (stage !== "performance_master")
    return checked ? [...new Set([...current, asset.asset_id])] : current.filter((id) => id !== asset.asset_id);
  const choices = realPersonReferencesForStage(project, stage);
  const isPose = asset.category === "pose_reference";
  const sameRoleIds = choices.filter((choice) => (choice.category === "pose_reference") === isPose).map((choice) => choice.asset_id);
  if (!checked) return current.filter((id) => id !== asset.asset_id);
  return [...current.filter((id) => !sameRoleIds.includes(id)), asset.asset_id];
}

function realPersonReferenceLabel(project: ModelAssetProject, stage: RealPersonAssetStage, asset: ModelAssetItem) {
  if (stage !== "performance_master")
    return asset.source_kind === "generated" || asset.category === "user_revision"
      ? realPersonStageInfo[(asset.asset_stage || "v0") as RealPersonAssetStage]?.name || "已确认人物资产"
      : modelAssetCategoryLabels[asset.category];
  if (asset.category === "pose_reference") return "神态姿态对标图";
  if (asset.category === "styled_identity_anchor")
    return asset.source_kind === "derived_crop"
      ? "历史自动裁切（仅供判断）"
      : asset.source_kind === "generated" ? "生成的近景身份图" : "我上传的近景身份图";
  if (asset.asset_id === project.active_asset_lock?.styled_anchor_asset_id) return "全身穿搭母版";
  return modelAssetCategoryLabels[asset.category];
}

function realPersonStageReferenceSummary(stage: RealPersonAssetStage) {
  if (stage === "v0") return "本人身份照。发型、穿搭、场景和氛围图不会混入。";
  if (stage === "appearance_bridge") return "已采用商业母版 ＋ 发型参考。";
  if (stage === "styled_anchor") return "已采用发型母版 ＋ 可选身体比例照 ＋ 穿搭参考。";
  if (stage === "performance_master") return "1 张由你选择的人物身份图 ＋ 1 张神态姿态对标图；近景图通常更稳，但不强制。";
  return "最终生图只用已采用姿态母版和反推文字；对标图只参与前面的分析。";
}

function realPersonGenerationReferencesReady(project: ModelAssetProject, stage: RealPersonAssetStage, references: ModelAssetItem[]) {
  const lock = project.active_asset_lock;
  if (stage === "v0") return references.length >= 1 && references.length <= 5 && references.every((asset) => asset.category === "identity_source");
  if (stage === "appearance_bridge") return references[0]?.asset_id === lock?.v0_asset_id && references.slice(1).some((asset) => asset.category === "hair_reference");
  if (stage === "styled_anchor") return references[0]?.asset_id === lock?.appearance_bridge_asset_id && references.slice(1).some((asset) => asset.category === "wardrobe_reference");
  if (stage === "performance_master") return references.length === 2
    && (references[0]?.asset_id === lock?.styled_anchor_asset_id || references[0]?.category === "styled_identity_anchor")
    && references[1]?.category === "pose_reference";
  return references.length === 1 && references[0]?.asset_id === lock?.performance_master_asset_id;
}

function realPersonStageMissingMessage(stage: RealPersonAssetStage) {
  if (stage === "v0") return "请勾选 1–5 张本人照片。";
  if (stage === "appearance_bridge") return "请先上传并勾选至少 1 张发型参考图。";
  if (stage === "styled_anchor") return "请先上传并勾选至少 1 张穿搭参考图；身体比例照可选。";
  if (stage === "performance_master") return "请选择 1 张人物身份图，并上传 1 张神态姿态对标图。";
  return "请先采用神态姿态母版。";
}


function savedTalkingHeadPersonAsset(): TalkingHeadPersonAsset | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      window.localStorage.getItem("workbench-talking-head-person-asset") || "null",
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
