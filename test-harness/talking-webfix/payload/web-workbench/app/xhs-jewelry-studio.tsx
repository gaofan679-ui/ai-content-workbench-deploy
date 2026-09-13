"use client";

import { requestJewelry } from "./jewelry-request.mjs";
import Image from "next/image";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_WORKBENCH_API || "http://127.0.0.1:4318";
const SIMULATED_TEST = process.env.NEXT_PUBLIC_WORKBENCH_SIMULATED_TEST === "1";

export type JewelryTask = {
  id: string;
  title: string;
  visual_mode: "rebuild_two_stage" | "direct_product_edit";
  person_strategy?: "authorized_real_person" | "partial_body" | "existing_base";
  result_check_required?: boolean;
  target_slot: "necklace" | "earrings" | "bracelet" | "ring" | "brooch_hair";
  target_ratio: string;
  brief: string;
  status: "ready" | "running_base" | "base_review" | "base_failed" | "running_product" | "final_review" | "product_failed" | "video_ready" | "running_video" | "video_review" | "video_failed" | "completed";
  current_stage: string;
  person_authorization_confirmed: boolean;
  external_upload_authorized: boolean;
  reference_image_count: number;
  person_image_count: number;
  product_image_count: number;
  product_facts: Record<string, string>;
  has_production_base_image: boolean;
  has_product_structure_board: boolean;
  base_attempt_count: number;
  product_attempt_count: number;
  video_attempt_count: number;
  base_generation_provider: GenerationProvider | null;
  product_generation_provider: GenerationProvider | null;
  active_generation_provider: GenerationProvider | null;
  active_stage: string | null;
  active_external_request_started: boolean;
  base_result: { approval_status?: string; user_message?: string } | null;
  final_result: { approval_status?: string; user_message?: string } | null;
  video_provider: VideoProvider | null;
  video_model_key: SeedanceModelKey | "minimax-h3-multiref-owned-clean" | null;
  video_aspect_ratio: VideoAspectRatio | null;
  video_duration_seconds: number | null;
  video_result: { approval_status?: string; user_message?: string; duration_seconds?: number; aspect_ratio?: string; product_source_count?: number; product_reference_strategy?: string } | null;
  latest_feedback: { feedback_id: string; stage: string; issue_codes: string[]; user_observation: string | null; created_at: string } | null;
  can_rework_base: boolean;
  can_rework_product: boolean;
  can_rework_video: boolean;
  can_retry_failed_stage: boolean;
  user_message: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type Props = {
  available: boolean;
  availabilityMessage: string;
  codexAvailable: boolean;
  chatgptWebAvailable: boolean;
  chatgptWebMessage: string;
  onNotice: (message: string, tone?: "success" | "error") => void;
};

type GenerationProvider = "codex_builtin" | "chatgpt_web";
type VideoProvider = "libtv" | "runninghub_h3_multiref";
type SeedanceModelKey = "star-video2.5" | "star-video2" | "star-video2-fast";
type VideoAspectRatio = "3:4" | "4:3" | "9:16" | "16:9";

type UploadKind = "reference" | "person" | "product";
type UploadPreview = { name: string; url: string };
type UploadPreviewState = Record<UploadKind, UploadPreview[]>;

const EMPTY_UPLOAD_PREVIEWS: UploadPreviewState = { reference: [], person: [], product: [] };

function videoMessageForDisplay(message?: string) {
  return String(message || "")
    .replaceAll("RunningHub H3", "MiniMax H3")
    .replaceAll("LibTV / Seedance", "Seedance 2.0 Fast");
}

function productFactLabel(key: string) {
  const labels: Record<string, string> = {
    product_name: "产品名",
    sku: "SKU",
    material: "材质 / 镀层",
    color: "真实颜色",
    dimensions: "尺寸",
    component_count: "组件数量",
    front_orientation: "正面与方向",
    connection_structure: "连接结构",
    must_not_change: "不可出错项",
  };
  return labels[key] || key;
}

export function XhsJewelryStudio({ available, availabilityMessage, codexAvailable, chatgptWebAvailable, chatgptWebMessage, onNotice }: Props) {
  const [tasks, setTasks] = useState<JewelryTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem("workbench-selected-xhs-jewelry-task"),
  );
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionInFlightRef = useRef(false);
  const [connectionWarning, setConnectionWarning] = useState("");
  const [personStrategy, setPersonStrategy] = useState<"authorized_real_person" | "partial_body">("authorized_real_person");
  const [uploadAuthorized, setUploadAuthorized] = useState(false);
  const [feedbackStage, setFeedbackStage] = useState<"visual_base" | "product_replacement" | "video_generation" | null>(null);
  const [feedbackIssues, setFeedbackIssues] = useState<string[]>([]);
  const [feedbackText, setFeedbackText] = useState("");
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [visualMode, setVisualMode] = useState<"rebuild_two_stage" | "direct_product_edit">("rebuild_two_stage");
  const [productReferenceIndex, setProductReferenceIndex] = useState(0);
  const [generationProvider, setGenerationProvider] = useState<GenerationProvider>(() => codexAvailable ? "codex_builtin" : "chatgpt_web");
  const [videoProvider, setVideoProvider] = useState<VideoProvider>("libtv");
  const [seedanceModelKey, setSeedanceModelKey] = useState<SeedanceModelKey>("star-video2-fast");
  const [videoAspectRatio, setVideoAspectRatio] = useState<VideoAspectRatio | "">("");
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(5);
  const [videoConfirmed, setVideoConfirmed] = useState(false);
  const [uploadPreviews, setUploadPreviews] = useState<UploadPreviewState>(EMPTY_UPLOAD_PREVIEWS);
  const uploadPreviewsRef = useRef<UploadPreviewState>(EMPTY_UPLOAD_PREVIEWS);
  const onNoticeRef = useRef(onNotice);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    onNoticeRef.current = onNotice;
  }, [onNotice]);

  const refresh = useCallback(async () => {
    if (!available || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const { response, data } = await requestJewelry(`${API}/xhs-jewelry/tasks?_=${Date.now()}`, { cache: "no-store" });
      setConnectionWarning("");
      if (!response.ok) throw new Error(data.error || "珠宝种草任务读取失败");
      const next = data.tasks || [];
      setTasks(next);
      setSelectedId((current) => current && next.some((item: JewelryTask) => item.id === current)
        ? current
        : next[0]?.id || null);
    } catch (error) {
      setConnectionWarning(error instanceof Error ? error.message : "进度暂时无法更新，请稍后检查原任务。");
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [available]);

  useEffect(() => {
    const first = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 3000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const selected = useMemo(() => tasks.find((task) => task.id === selectedId) || null, [tasks, selectedId]);
  const savedGenerationProvider = selected?.active_generation_provider
    || (selected?.current_stage === "visual_base" ? selected?.base_generation_provider : selected?.product_generation_provider)
    || selected?.base_generation_provider;

  /* eslint-disable react-hooks/set-state-in-effect -- switching tasks must restore that task's saved video settings */
  useEffect(() => {
    if (!selectedId) return;
    // Preserve the chosen channel even when it is offline. Switching requires
    // an explicit user choice, including after reload and automatic selection.
    setGenerationProvider(savedGenerationProvider || (codexAvailable ? "codex_builtin" : "chatgpt_web"));
  }, [selectedId, savedGenerationProvider, codexAvailable]);

  useEffect(() => {
    if (!selected?.id) return;
    window.localStorage.setItem("workbench-selected-xhs-jewelry-task", selected.id);
    setProductReferenceIndex(0);
    setUploadAuthorized(false);
    setVideoConfirmed(false);
    setFeedbackStage(null);
    setFeedbackIssues([]);
    setFeedbackText("");
  }, [selected?.id]);

  useEffect(() => {
    setVideoConfirmed(false);
  }, [videoProvider, seedanceModelKey, videoAspectRatio, videoDurationSeconds]);

  useEffect(() => {
    if (selected?.video_provider) setVideoProvider(selected.video_provider);
    if (["star-video2.5", "star-video2", "star-video2-fast"].includes(String(selected?.video_model_key))) {
      setSeedanceModelKey(selected?.video_model_key as SeedanceModelKey);
    }
    const storedRatio = String(selected?.video_aspect_ratio || "");
    const sourceRatio = String(selected?.target_ratio || "");
    const nextRatio = ["3:4", "4:3", "9:16", "16:9"].includes(storedRatio)
      ? storedRatio
      : ["3:4", "4:3", "9:16", "16:9"].includes(sourceRatio) ? sourceRatio : "";
    setVideoAspectRatio(nextRatio as VideoAspectRatio | "");
    setVideoDurationSeconds(Number(selected?.video_duration_seconds || 5));
  }, [selected?.id, selected?.video_provider, selected?.video_model_key, selected?.video_aspect_ratio, selected?.video_duration_seconds, selected?.target_ratio]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!lightbox) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [lightbox]);

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    try {
      const form = new FormData(event.currentTarget);
      form.set("person_authorization_confirmed", String(form.get("person_authorization_confirmed") === "on"));
      if (visualMode === "rebuild_two_stage") form.set("person_strategy", personStrategy);
      const { response, data } = await requestJewelry(`${API}/xhs-jewelry/tasks`, { method: "POST", body: form });
      if (!response.ok) throw new Error(data.error || "项目没有建立成功");
      setSelectedId(data.task.id);
      setCreating(false);
      setUploadAuthorized(false);
      clearUploadPreviews();
      await refresh();
      onNotice("珠宝种草项目已建立；这款产品的素材和后续版本会保存在同一项目里");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "项目没有建立成功", "error");
    } finally {
      actionInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function postAction(action: string, body: Record<string, unknown>) {
    if (!selected || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    try {
      const requestKey = `jewelry-pending-start:${selected.id}`;
      const requestId = action === "start" ? window.localStorage.getItem(requestKey) || crypto.randomUUID() : undefined;
      if (requestId) window.localStorage.setItem(requestKey, requestId);
      const { response, data } = await requestJewelry(`${API}/xhs-jewelry/tasks/${selected.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...(requestId ? { requestId } : {}) }),
      });
      if (requestId) window.localStorage.removeItem(requestKey);
      if (!response.ok) throw new Error(data.error || "操作没有完成");
      if (data.task) {
        setTasks((current) => current.map((item) => item.id === data.task.id ? data.task : item));
      }
      setUploadAuthorized(false);
      setVideoConfirmed(false);
      setFeedbackStage(null);
      setFeedbackIssues([]);
      setFeedbackText("");
      void refresh();
      onNotice(action === "check-result" ? (data.recovered ? "已接回原任务图片，请审核" : data.task?.user_message || "已核对原任务状态") : action === "approve-final" ? "成品图已采用，可以继续生成短视频" : action === "approve-video" ? "短视频已采用" : "操作已提交，页面会自动更新");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作没有完成", "error");
    } finally {
      actionInFlightRef.current = false;
      setBusy(false);
    }
  }

  function toggleFeedbackIssue(code: string) {
    setFeedbackIssues((current) => current.includes(code)
      ? current.filter((item) => item !== code)
      : [...current, code]);
  }

  function selectTask(id: string) {
    setSelectedId(id);
    window.localStorage.setItem("workbench-selected-xhs-jewelry-task", id);
    const task = tasks.find((item) => item.id === id);
    setProductReferenceIndex(0);
    setVideoProvider(task?.video_provider || "libtv");
    if (["star-video2.5", "star-video2", "star-video2-fast"].includes(String(task?.video_model_key))) {
      setSeedanceModelKey(task?.video_model_key as SeedanceModelKey);
    } else {
      setSeedanceModelKey("star-video2-fast");
    }
    setVideoConfirmed(false);
    setFeedbackStage(null);
    setFeedbackIssues([]);
    setFeedbackText("");
  }

  function submitRework() {
    if (!feedbackStage) return;
    if (feedbackStage !== "video_generation" && (generationProvider === "chatgpt_web" ? !chatgptWebAvailable : !codexAvailable)) {
      onNotice("所选生图通道暂不可用，请恢复连接或主动选择其他通道；修改意见已保留。", "error");
      return;
    }
    postAction("request-rework", {
      issueCodes: feedbackIssues,
      userText: feedbackText,
      reworkMode: "targeted_refine",
      generationProvider,
    });
  }

  function regenerateFresh() {
    postAction("request-rework", {
      issueCodes: [],
      userText: "",
      reworkMode: "fresh_variant",
      generationProvider,
    });
  }

  function updateUploadPreviews(kind: UploadKind, files: FileList | null) {
    uploadPreviewsRef.current[kind].forEach((item) => URL.revokeObjectURL(item.url));
    const nextItems = Array.from(files || []).map((file) => ({ name: file.name, url: URL.createObjectURL(file) }));
    const next = { ...uploadPreviewsRef.current, [kind]: nextItems };
    uploadPreviewsRef.current = next;
    setUploadPreviews(next);
  }

  function clearUploadPreviews(kind?: UploadKind) {
    const targets = kind ? [kind] : (["reference", "person", "product"] as UploadKind[]);
    targets.forEach((target) => uploadPreviewsRef.current[target].forEach((item) => URL.revokeObjectURL(item.url)));
    const next = kind ? { ...uploadPreviewsRef.current, [kind]: [] } : EMPTY_UPLOAD_PREVIEWS;
    uploadPreviewsRef.current = next;
    setUploadPreviews(next);
  }

  useEffect(() => () => {
    Object.values(uploadPreviewsRef.current).flat().forEach((item) => URL.revokeObjectURL(item.url));
  }, []);

  useEffect(() => {
    if (visualMode === "direct_product_edit") clearUploadPreviews("person");
  }, [visualMode]);

  const visibleProductReferenceIndex = selected && selected.product_image_count > 0
    ? Math.min(productReferenceIndex, selected.product_image_count - 1)
    : 0;

  if (!available) {
    return (
      <section className="jewelry-studio jewelry-unavailable">
        <div className="jewelry-hero-copy">
          <small>珠宝种草图与短视频</small>
          <h1>珠宝种草</h1>
          <p>{availabilityMessage}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="jewelry-studio" aria-label="珠宝种草">
      {SIMULATED_TEST && <aside role="note" style={{ padding: "16px 20px", border: "2px solid #ad6800", borderRadius: 16, background: "#fff3cd", color: "#663c00", marginBottom: 16 }}><strong>模拟流程测试 · 不是真实生图</strong><p>本页的纯色图片和测试视频仅用于检查按钮、返工与结果回收；没有调用真实生图或视频服务，也不代表成图效果。</p></aside>}
      <header className={`jewelry-hero ${tasks.length > 0 || creating ? "compact" : ""}`}>
        <div className="jewelry-icon">薯</div>
        <div className="jewelry-hero-copy">
          <small>珠宝种草图与短视频</small>
          <h1>珠宝种草</h1>
          <p>一个项目对应一款产品。先生成并确认种草图，再继续做短视频；以后做同一款产品，直接打开历史项目接着做。</p>
        </div>
        {!creating && <button className="jewelry-primary" onClick={() => setCreating(true)}>新建项目</button>}
      </header>

      {(tasks.length === 0 || creating) && <div className="jewelry-safety-strip">
        <span>① 上传图片</span>
        <span>② 确认展示画面</span>
        <span>③ 确认产品效果</span>
        <span>④ 设置并生成视频</span>
      </div>}

      {creating && (
        <form className="jewelry-create" onSubmit={createTask}>
          <div className="jewelry-create-heading">
            <div><small>新建产品项目</small><h2>一款产品，只需设置一次</h2></div>
            <button type="button" onClick={() => { setCreating(false); clearUploadPreviews(); }}>取消</button>
          </div>
          <label><span>项目名称</span><input name="title" placeholder="建议填写产品名或 SKU，例如：R6371 金银切面麻花戒指" required /></label>
          <div className="jewelry-project-rule"><b>建议一个项目只放一款产品</b><span>产品图、结构板、已核实参数和返修记录都会跟随这个项目保存。以后继续做这款产品时，直接打开历史项目，不用从零开始。</span></div>
          <fieldset>
            <legend>这次要做什么</legend>
            <label className="jewelry-choice"><input aria-label="参考喜欢的画面重新制作" type="radio" name="visual_mode" value="rebuild_two_stage" checked={visualMode === "rebuild_two_stage"} onChange={() => setVisualMode("rebuild_two_stage")} /><span><b>参考喜欢的画面重新制作</b><small>保留喜欢的风格，重新制作佩戴画面和产品</small></span></label>
            <label className="jewelry-choice"><input aria-label="我已有满意画面" type="radio" name="visual_mode" value="direct_product_edit" checked={visualMode === "direct_product_edit"} onChange={() => setVisualMode("direct_product_edit")} /><span><b>我已有满意画面</b><small>保留这张画面，只换上产品</small></span></label>
          </fieldset>
          {visualMode === "rebuild_two_stage" && <fieldset>
            <legend>画面里怎么展示</legend>
            <label className="jewelry-choice"><input aria-label="使用指定模特" type="radio" name="person_strategy" value="authorized_real_person" checked={personStrategy === "authorized_real_person"} onChange={() => { setPersonStrategy("authorized_real_person"); updateUploadPreviews("person", null); }} /><span><b>使用指定模特</b><small>上传人物照片，保持同一人物身份</small></span></label>
            <label className="jewelry-choice"><input aria-label="不露脸，展示局部" type="radio" name="person_strategy" value="partial_body" checked={personStrategy === "partial_body"} onChange={() => { setPersonStrategy("partial_body"); updateUploadPreviews("person", null); }} /><span><b>不露脸，展示局部</b><small>只露手、颈部或穿搭局部，无需上传脸照</small></span></label>
          </fieldset>}
          <div className="jewelry-section-heading"><b>上传素材</b><small>点击卡片选择图片，选好后会立即显示预览</small></div>
          <div className="jewelry-upload-grid">
            <label className="jewelry-upload"><span className="jewelry-upload-title"><i>1</i><b>{visualMode === "rebuild_two_stage" ? "参考画面" : "满意的画面"}</b></span><small>{visualMode === "rebuild_two_stage" ? "选择 1 张你喜欢的画面" : "选择 1 张准备直接换产品的画面"}</small><input type="file" name="referenceImages" accept="image/png,image/jpeg,image/webp" required onChange={(event) => updateUploadPreviews("reference", event.target.files)} /><span className="jewelry-upload-action">{uploadPreviews.reference.length ? "重新选择" : "选择图片"}</span><UploadPreviewList items={uploadPreviews.reference} /></label>
            {visualMode === "rebuild_two_stage" && <label className="jewelry-upload"><span className="jewelry-upload-title"><i>2</i><b>{personStrategy === "partial_body" ? "局部身体参考（可选）" : "出镜人物"}</b></span><small>{personStrategy === "partial_body" ? "想固定肤色或手型时再选图；不需要脸照" : "选择 1 张原创或已授权的清晰人物照片"}</small><input key={personStrategy} type="file" name="personImages" accept="image/png,image/jpeg,image/webp" required={personStrategy !== "partial_body"} onChange={(event) => updateUploadPreviews("person", event.target.files)} /><span className="jewelry-upload-action">{uploadPreviews.person.length ? "重新选择" : "选择图片"}</span><UploadPreviewList items={uploadPreviews.person} /></label>}
            <label className="jewelry-upload jewelry-upload-product"><span className="jewelry-upload-title"><i>{visualMode === "rebuild_two_stage" ? "3" : "2"}</i><b>要换上的产品</b></span><small>同一款选择 1–5 张，多角度更容易保持款式准确</small><input type="file" name="productImages" accept="image/png,image/jpeg,image/webp" multiple required onChange={(event) => updateUploadPreviews("product", event.target.files)} /><span className="jewelry-upload-action">{uploadPreviews.product.length ? `已选择 ${uploadPreviews.product.length} 张，重新选择` : "选择产品图"}</span><UploadPreviewList items={uploadPreviews.product} /></label>
          </div>
          <div className="jewelry-section-heading"><b>想要的成品</b><small>选择产品位置和图片比例</small></div>
          <div className="jewelry-create-row">
            <label><span>产品戴在哪里</span><select name="target_slot" defaultValue="necklace" required><option value="necklace">项链 / 吊坠</option><option value="earrings">耳环 / 耳饰</option><option value="bracelet">手链 / 手镯</option><option value="ring">戒指</option><option value="brooch_hair">胸针 / 发饰</option></select></label>
            <label><span>图片比例</span><select name="target_ratio" defaultValue="follow_source"><option value="follow_source">跟随参考图</option><option value="3:4">3:4</option><option value="4:5">4:5</option><option value="9:16">9:16</option><option value="1:1">1:1</option></select></label>
          </div>
          <section className="jewelry-product-profile jewelry-product-profile-visible" aria-labelledby="jewelry-product-profile-title">
            <div className="jewelry-section-heading"><div><b id="jewelry-product-profile-title">补充产品资料</b><small>首次建议填写；没有资料也能继续</small></div><em>帮助锁定款式</em></div>
            <div className="jewelry-product-profile-copy"><b>图片证明产品长什么样，资料锁定不能猜错的事实</b><small>尺寸、正面方向、连接方式等信息会跟随这个产品项目复用。看不准的内容请留空，系统会标为“未核实”。</small></div>
            <div className="jewelry-create-row jewelry-product-profile-key-fields"><label><span>产品名</span><input name="product_name" placeholder="例如：飞马金币项链" /></label><label><span>尺寸</span><input name="product_dimensions" placeholder="例如：吊坠直径 18 mm" /></label><label><span>正面与方向</span><input name="product_front_orientation" placeholder="例如：飞马头朝左，禁止镜像" /></label><label><span>连接结构</span><input name="product_connection_structure" placeholder="例如：链条穿过椭圆吊环" /></label></div>
            <label className="jewelry-product-must-not-change"><span>最不能生成错的地方</span><input name="product_must_not_change" placeholder="例如：飞马朝向、翅膀纹路和吊环连接不能变" /></label>
            <details className="jewelry-product-profile-more"><summary>更多产品资料（可选）</summary><div className="jewelry-create-row"><label><span>SKU</span><input name="product_sku" placeholder="例如：PG-01" /></label><label><span>材质 / 镀层</span><input name="product_material" placeholder="例如：14K 包金；不确定可留空" /></label><label><span>真实颜色</span><input name="product_color" placeholder="例如：浅金色" /></label><label><span>组件或重复结构数量</span><input name="product_component_count" placeholder="例如：12 个节点" /></label></div></details>
          </section>
          <details className="jewelry-optional-settings"><summary>画面补充要求（可选）</summary><label><span>还有什么需要特别注意？</span><input name="brief" placeholder="例如：保留松弛日常感，不要像商业写真" /></label></details>
          <label className="jewelry-consent"><input type="checkbox" name="person_authorization_confirmed" required /><span>我确认本次素材为原创、本人所有或已获得使用授权</span></label>
          <div className="jewelry-create-actions"><button className="jewelry-primary" disabled={busy}>{busy ? "正在保存…" : "保存素材，开始制作"}</button><small>下一步只确认哪些图片会用于生成，不需要重新填写资料。</small></div>
        </form>
      )}

      {!creating && tasks.length === 0 && (
        <div className="jewelry-empty"><div>✦</div><h2>还没有珠宝种草项目</h2><p>为第一款产品建立项目；以后这款产品的生图、短视频和返修都从这里继续。</p><button className="jewelry-primary" onClick={() => setCreating(true)}>建立第一个产品项目</button></div>
      )}

      {!creating && tasks.length > 0 && (
        <div className="jewelry-workspace">
          <div className="jewelry-project-switcher">
            <label htmlFor="jewelry-project-select"><span>当前项目</span><select id="jewelry-project-select" aria-label="切换种草项目" value={selectedId || ""} onChange={(event) => selectTask(event.target.value)}>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title} · {statusLabel(task.status, task.person_strategy)}</option>)}</select></label>
            <small>共 {tasks.length} 个项目</small>
          </div>
          {selected && (
            <article className="jewelry-task-detail">
              <header><div><small>{selected.visual_mode === "rebuild_two_stage" ? "参考画面重新制作" : "保留画面，只换产品"}</small><h2>{selected.title}</h2></div><span className={`jewelry-status ${statusTone(selected.status)}`}>{statusLabel(selected.status, selected.person_strategy)}</span></header>
              <div className="jewelry-current-step" aria-label="当前需要处理">
                <small>当前需要处理</small>
                <b>{currentStepTitle(selected)}</b>
              </div>
              <details className="jewelry-product-asset-summary">
                <summary><span><small>本款产品资料</small><b>{selected.product_facts?.product_name || "已上传的这款产品"}</b></span><em>换品前自动建立并复用</em></summary>
                <div><p>首次进入换品时，系统会自动把产品原图、已核实参数、非生成式结构板和短约束卡编成一个产品资产包；同一项目后续重生或返工直接复用，不需要再次反推长提示词。</p>{Object.keys(selected.product_facts || {}).length > 0 ? <dl>{Object.entries(selected.product_facts).map(([key, value]) => <div key={key}><dt>{productFactLabel(key)}</dt><dd>{value}</dd></div>)}</dl> : <small>当前未填写参数，结构板仍会使用原始产品图建立；无法核实的尺寸、材质和隐藏结构会标记为“未核实”。</small>}</div>
              </details>
              {(selected.has_production_base_image || selected.has_product_structure_board) && (
                <details className="jewelry-production-evidence">
                  <summary>
                    <span><small>本次制作依据</small><b>{Number(selected.has_production_base_image) + Number(selected.has_product_structure_board)} 项已建立素材</b></span>
                    <em>展开查看</em>
                  </summary>
                  <div className="jewelry-evidence-grid">
                    {selected.has_production_base_image && (
                      <article className="jewelry-evidence-card">
                        <header><div><small>已确认</small><b>展示画面</b></div><span>后续换品基准</span></header>
                        <ReviewImage
                          compact
                          src={`${API}/xhs-jewelry/tasks/${selected.id}/production-base-image?v=${selected.base_attempt_count}`}
                          alt="已确认画面"
                          onOpen={() => setLightbox({ src: `${API}/xhs-jewelry/tasks/${selected.id}/production-base-image?v=${selected.base_attempt_count}`, alt: "已确认画面" })}
                        />
                        <p>换产品和按问题重生时，都从这张已确认画面重新开始。</p>
                      </article>
                    )}
                    {selected.has_product_structure_board && (
                      <article className="jewelry-evidence-card">
                        <header><div><small>已建立</small><b>产品结构参考板</b></div><span>产品一致性依据</span></header>
                        <ReviewImage
                          compact
                          src={`${API}/xhs-jewelry/tasks/${selected.id}/structure-board?v=${selected.product_attempt_count}`}
                          alt="产品结构参考板"
                          onOpen={() => setLightbox({ src: `${API}/xhs-jewelry/tasks/${selected.id}/structure-board?v=${selected.product_attempt_count}`, alt: "产品结构参考板" })}
                        />
                        <p>由真实产品图裁切拼成，不是 AI 重画；用于核对方向、连接和核心结构。</p>
                      </article>
                    )}
                  </div>
                </details>
              )}
              {(["running_base", "running_product", "running_video"] as string[]).includes(selected.status) && (
                <section className="jewelry-running-card" role="status" aria-live="polite">
                  <div><span className="jewelry-running-spinner" aria-hidden="true" /><small>任务已经启动</small></div>
                  <b>{selected.user_message}</b>
                  <div className="jewelry-running-track" aria-hidden="true"><i /></div>
                  <small>页面会自动更新，你可以留在当前页面等待结果。</small>
                </section>
              )}
              <details className="jewelry-project-overview">
                <summary><span>项目进度与素材</span><small>需要时展开查看</small></summary>
                <div className="jewelry-progress" aria-label="制作进度">
                  {progressSteps(selected).map((step) => <div key={step.label} className={step.state}><i>{step.state === "done" ? "✓" : step.index}</i><span>{step.label}</span></div>)}
                </div>
                <div className="jewelry-message"><b>{selected.user_message}</b><small>{selected.active_external_request_started ? "本次已经正式提交 1 次，系统不会自动再次发送。" : "当前状态和已完成结果会保存在当前电脑。"}</small></div>
                <div className="jewelry-input-summary"><span>{slotLabel(selected.target_slot)}</span><span>参考图 {selected.reference_image_count} 张</span><span>{selected.person_strategy === "partial_body" ? "局部参考" : "模特图"} {selected.person_image_count} 张</span><span>产品图 {selected.product_image_count} 张</span><span>{ratioLabel(selected.target_ratio)}</span></div>
              </details>

              {!["running_base", "running_product", "video_ready", "running_video", "video_review", "video_failed", "completed"].includes(selected.status) && (
                <GenerationProviderPicker
                  value={generationProvider}
                  codexAvailable={codexAvailable}
                  chatgptWebAvailable={chatgptWebAvailable}
                  chatgptWebMessage={chatgptWebMessage}
                  onChange={setGenerationProvider}
                />
              )}

              {connectionWarning && <section className="jewelry-action-card" role="status"><h3>进度暂时无法更新</h3><p>{connectionWarning}</p><button type="button" className="jewelry-secondary" onClick={() => void refresh()}>刷新任务状态</button></section>}
              {selected.result_check_required && <section className="jewelry-action-card" role="status"><h3>先核对原任务</h3><p>{selected.user_message}</p><p>保持原 ChatGPT 对话打开。检查只接回已有结果，不会重新上传或生成。</p><button className="jewelry-primary" disabled={busy} onClick={() => postAction("check-result", {})}>{busy ? "正在检查…" : "检查原任务"}</button></section>}
              {!selected.result_check_required && (["ready", "base_failed", "product_failed"] as string[]).includes(selected.status) && (
                <section className="jewelry-action-card"><h3>{selected.status === "ready" ? "开始制作" : "本次没有出图"}</h3><p>{selected.status === "ready" ? (selected.current_stage === "visual_base" ? (selected.person_strategy === "partial_body" ? "先制作不露脸的局部佩戴画面；你确认满意后，再换上真实产品。" : "先参考喜欢的画面生成一张人物图；你确认满意后，再换上真实产品。") : "使用已确认的画面和产品图，生成换好产品的种草图。") : selected.user_message}</p>{!selected.external_upload_authorized && <label className="jewelry-consent"><input type="checkbox" checked={uploadAuthorized} onChange={(event) => setUploadAuthorized(event.target.checked)} /><span>{selected.current_stage === "visual_base" ? (selected.person_strategy === "partial_body" ? "同意上传本次参考画面及已选择的局部参考，用于制作不露脸画面" : "同意上传本次参考画面和已授权人物图，用于生成人物画面") : "同意上传已确认画面和产品图，用于换上产品"}</span></label>}<button className="jewelry-primary" disabled={(!selected.external_upload_authorized && !uploadAuthorized) || busy || (generationProvider === "chatgpt_web" ? !chatgptWebAvailable : !codexAvailable)} onClick={() => postAction("start", { confirmed: true, uploadAuthorized: true, generationProvider })}>{busy ? "正在开始…" : selected.status === "base_failed" ? (selected.person_strategy === "partial_body" ? "重新生成局部画面" : "重新生成人物画面") : selected.status === "product_failed" ? "重新换上产品" : selected.current_stage === "product_replacement" ? "继续换上产品" : selected.person_strategy === "partial_body" ? "开始生成局部画面" : "开始生成人物画面"}</button></section>
              )}

              {selected.status === "base_review" && (
                <section className="jewelry-review">
                  <ReviewImage
                    src={`${API}/xhs-jewelry/tasks/${selected.id}/base-image?v=${selected.base_attempt_count}`}
                    alt="待确认的人物种草图"
                    onOpen={() => setLightbox({ src: `${API}/xhs-jewelry/tasks/${selected.id}/base-image?v=${selected.base_attempt_count}`, alt: "待确认的人物种草图" })}
                  />
                  <div className="jewelry-review-copy">
                    <small>需要你确认</small>
                    <h3>{selected.person_strategy === "partial_body" ? "这张局部画面可以继续吗？" : "这张人物图可以继续吗？"}</h3>
                    <p>{selected.person_strategy === "partial_body" ? "重点看是否保持不露脸、手型与姿态是否自然、珠宝佩戴位置是否合适。点击图片可以放大检查。" : "重点看人物身份、氛围、构图，以及项链、耳环或手部是否有自然可用的佩戴位置。点击左侧图片可以放大检查。"}</p>
                    {selected.base_result?.user_message && <div className="jewelry-generation-note"><b>本次生成备注</b><span>{selected.base_result.user_message}</span></div>}
                    <div className="jewelry-review-actions">
                      <button className="jewelry-primary" disabled={busy || (generationProvider === "chatgpt_web" ? !chatgptWebAvailable : !codexAvailable)} onClick={() => postAction("approve-base", { confirmed: true, generationProvider })}>{busy ? "正在进入下一步…" : "满意，继续换产品"}</button>
                      <button className="jewelry-secondary" disabled={busy} onClick={() => setFeedbackStage("visual_base")}>不满意，填写问题</button>
                    </div>
                    {feedbackStage === "visual_base" && <FeedbackPanel generationAvailable={generationProvider === "chatgpt_web" ? chatgptWebAvailable : codexAvailable} partialBody={selected.person_strategy === "partial_body"} stage="visual_base" selectedIssues={feedbackIssues} feedbackText={feedbackText} busy={busy} onToggle={toggleFeedbackIssue} onText={setFeedbackText} onCancel={() => setFeedbackStage(null)} onSubmit={submitRework} />}
                  </div>
                </section>
              )}

              {["final_review", "video_ready", "running_video", "video_review", "video_failed", "completed"].includes(selected.status) && (
                <details className={`jewelry-result-history ${selected.status === "final_review" ? "current" : ""}`} open={selected.status === "final_review"}>
                  <summary>
                    <span>{selected.status === "final_review" ? "当前图片审核" : "已完成 · 成品图"}</span>
                    <b>{selected.status === "final_review" ? "对照产品图确认这张图片" : "查看已采用成品图和产品对照"}</b>
                    {selected.status !== "final_review" && <small>点击展开</small>}
                  </summary>
                <section className="jewelry-final-review">
                  <div className="jewelry-compare-grid" aria-label="产品参考与生成结果对照">
                    <div className="jewelry-compare-card">
                      <header><b>真实产品参考</b><span>{visibleProductReferenceIndex + 1} / {selected.product_image_count}</span></header>
                      <ReviewImage
                        compact
                        src={`${API}/xhs-jewelry/tasks/${selected.id}/product-image/${visibleProductReferenceIndex}`}
                        alt={`真实产品参考 ${visibleProductReferenceIndex + 1}`}
                        onOpen={() => setLightbox({ src: `${API}/xhs-jewelry/tasks/${selected.id}/product-image/${visibleProductReferenceIndex}`, alt: `真实产品参考 ${visibleProductReferenceIndex + 1}` })}
                      />
                      {selected.product_image_count > 1 && <div className="jewelry-compare-controls"><button type="button" onClick={() => setProductReferenceIndex((current) => (current - 1 + selected.product_image_count) % selected.product_image_count)}>上一张</button><button type="button" onClick={() => setProductReferenceIndex((current) => (current + 1) % selected.product_image_count)}>下一张</button></div>}
                    </div>
                    <div className="jewelry-compare-card">
                      <header><b>{SIMULATED_TEST ? "模拟结果（纯色占位图）" : "当前生成结果"}</b><span>{["video_ready", "running_video", "video_review", "video_failed", "completed"].includes(selected.status) ? "已采用" : "待确认"}</span></header>
                      <ReviewImage
                        compact
                        src={`${API}/xhs-jewelry/tasks/${selected.id}/final-image?v=${selected.product_attempt_count}`}
                        alt="珠宝种草结果"
                        onOpen={() => setLightbox({ src: `${API}/xhs-jewelry/tasks/${selected.id}/final-image?v=${selected.product_attempt_count}`, alt: "珠宝种草结果" })}
                      />
                    </div>
                  </div>
                  <div className="jewelry-review-copy">
                    <small>{["video_ready", "running_video", "video_review", "video_failed", "completed"].includes(selected.status) ? "成品图已采用" : "图片确认"}</small>
                    <h3>对照产品图检查真实珠宝</h3>
                    <p>放大确认款式结构、浮雕或纹理方向、比例、佩戴位置和受光；人物、衣服、构图和背景不应被重新设计。</p>
                    {selected.final_result?.user_message && <div className="jewelry-generation-note"><b>本次生成备注</b><span>{selected.final_result.user_message}</span></div>}
                    {selected.status === "final_review" && <>
                      <div className="jewelry-review-actions">
                        <button className="jewelry-primary" disabled={busy} onClick={() => postAction("approve-final", { confirmed: true })}>{busy ? "正在保存…" : "满意，确认采用"}</button>
                        <button className="jewelry-secondary" disabled={busy || (generationProvider === "chatgpt_web" ? !chatgptWebAvailable : !codexAvailable)} onClick={regenerateFresh}>直接重新生成一版</button>
                        <button className="jewelry-secondary" disabled={busy} onClick={() => setFeedbackStage("product_replacement")}>不满意，填写问题</button>
                      </div>
                      <small className="jewelry-review-hint">两种返工都会从已确认画面重新换入同一产品；“填写问题”会把修改要求带入下一版。每次只生成一张新图，不会覆盖原参考图。</small>
                      {feedbackStage === "product_replacement" && <FeedbackPanel generationAvailable={generationProvider === "chatgpt_web" ? chatgptWebAvailable : codexAvailable} stage="product_replacement" selectedIssues={feedbackIssues} feedbackText={feedbackText} busy={busy} onToggle={toggleFeedbackIssue} onText={setFeedbackText} onCancel={() => setFeedbackStage(null)} onSubmit={submitRework} />}
                    </>}
                  </div>
                </section>
                </details>
              )}

              {["video_ready", "video_failed"].includes(selected.status) && (
                <section className="jewelry-action-card jewelry-video-card">
                  <small>短视频生成</small>
                  <h3>{selected.status === "video_failed" ? "上次视频需要返工" : "把成品图生成自然短视频"}</h3>
                  <p>{selected.status === "video_failed" ? "上一版已折叠在下方。重新确认模型、画幅和时长后再制作，不会沿用错误参数。" : "选择模型、画幅和时长，制作一条无声短视频。"}</p>
                  <VideoProviderPicker value={videoProvider} seedanceModelKey={seedanceModelKey} aspectRatio={videoAspectRatio} durationSeconds={videoDurationSeconds} productImageCount={selected.product_image_count} onChange={setVideoProvider} onSeedanceModelChange={setSeedanceModelKey} onAspectRatioChange={setVideoAspectRatio} onDurationChange={setVideoDurationSeconds} />
                  <label className="jewelry-consent"><input type="checkbox" checked={videoConfirmed} onChange={(event) => setVideoConfirmed(event.target.checked)} /><span>我同意上传本次视频所需图片并提交 1 条 {videoAspectRatio || "待选画幅"}、{videoDurationSeconds} 秒视频，实际费用以平台返回为准。</span></label>
                  <button className="jewelry-primary" disabled={!videoConfirmed || !videoAspectRatio || busy} onClick={() => postAction("generate-video", { confirmed: true, uploadAuthorized: true, feeConfirmed: true, provider: videoProvider, modelKey: videoProvider === "libtv" ? seedanceModelKey : "minimax-h3-multiref-owned-clean", aspectRatio: videoAspectRatio, durationSeconds: videoDurationSeconds })}>{busy ? "正在提交…" : selected.status === "video_failed" ? "按当前设置重新生成" : "生成短视频"}</button>
                  <small>本次只提交 1 条，失败不会自动重试或切换模型。</small>
                </section>
              )}

              {["video_review", "video_failed", "completed"].includes(selected.status) && selected.video_result && (
                selected.status === "video_failed" ? <details className="jewelry-video-history">
                  <summary><span><small>上一版</small><b>上一版视频（未采用）</b></span><em>展开查看</em></summary>
                  <section className="jewelry-video-review">
                    <div className="jewelry-video-frame">
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- generated product preview is intentionally silent */}
                      <video src={`${API}/xhs-jewelry/tasks/${selected.id}/video-file?v=${selected.video_attempt_count}`} controls playsInline preload="metadata" />
                    </div>
                    <div className="jewelry-review-copy">
                      <small>未采用 · 仅供对照</small><h3>上一版视频和已记录的问题</h3>
                      <p>该版本只用于本轮返工对照，不会冒充当前成果。需要时再展开播放。</p>
                      {selected.video_result.user_message && <div className="jewelry-generation-note"><b>本次生成备注</b><span>{videoMessageForDisplay(selected.video_result.user_message)}</span></div>}
                    </div>
                  </section>
                </details> : <section className="jewelry-video-review">
                  <div className="jewelry-video-frame">
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption -- generated product preview is intentionally silent */}
                    <video src={`${API}/xhs-jewelry/tasks/${selected.id}/video-file?v=${selected.video_attempt_count}`} controls playsInline preload="metadata" />
                  </div>
                  <div className="jewelry-review-copy">
                    <small>{selected.status === "completed" ? "已采用" : selected.status === "video_failed" ? "未采用 · 保留作对照" : "视频确认"}</small>
                    <h3>{selected.status === "video_failed" ? "查看上次视频和已记录的问题" : "检查人物、珠宝和轻微动态"}</h3>
                    <p>重点看产品浮雕/纹理方向、连接结构、比例是否全程稳定，以及人物脸、手和背景是否出现融化、跳变或异常闪烁。</p>
                    {(selected.video_result.aspect_ratio || selected.video_result.duration_seconds || selected.video_result.product_source_count) && <div className="jewelry-generation-note"><b>本次生成设置</b><span>{selected.video_result.aspect_ratio ? `${selected.video_result.aspect_ratio} 画幅` : "画幅回执缺失"} · {selected.video_result.duration_seconds ? `${selected.video_result.duration_seconds} 秒` : "时长回执缺失"}{selected.video_result.product_source_count ? ` · 已分别使用 ${selected.video_result.product_source_count} 张产品图` : ""}</span></div>}
                    {selected.video_result.user_message && <div className="jewelry-generation-note"><b>本次生成备注</b><span>{videoMessageForDisplay(selected.video_result.user_message)}</span></div>}
                    {selected.status === "video_review" && <>
                      <div className="jewelry-review-actions">
                        <button className="jewelry-primary" disabled={busy} onClick={() => postAction("approve-video", { confirmed: true })}>{busy ? "正在保存…" : "满意，确认采用视频"}</button>
                        <button className="jewelry-secondary" disabled={busy} onClick={() => setFeedbackStage("video_generation")}>不满意，填写问题</button>
                      </div>
                      {feedbackStage === "video_generation" && <FeedbackPanel stage="video_generation" selectedIssues={feedbackIssues} feedbackText={feedbackText} busy={busy} onToggle={toggleFeedbackIssue} onText={setFeedbackText} onCancel={() => setFeedbackStage(null)} onSubmit={submitRework} />}
                    </>}
                    {selected.status === "completed" && <p>视频已完成，可直接下载或继续用于发布与剪辑。</p>}
                  </div>
                </section>
              )}
            </article>
          )}
        </div>
      )}
      {lightbox && (
        <div className="jewelry-lightbox" role="dialog" aria-modal="true" aria-label={lightbox.alt}>
          <button className="jewelry-lightbox-close" type="button" onClick={() => setLightbox(null)} aria-label="关闭大图">×</button>
          <Image src={lightbox.src} alt={lightbox.alt} width={1600} height={1600} unoptimized />
          <span>按 Esc 或右上角按钮关闭</span>
        </div>
      )}
    </section>
  );
}

function ReviewImage({ src, alt, onOpen, compact = false }: { src: string; alt: string; onOpen: () => void; compact?: boolean }) {
  return (
    <div className={`jewelry-image ${compact ? "compact" : ""}`}>
      <button type="button" className="jewelry-image-button" onClick={onOpen} aria-label={`放大查看${alt}`}>
        <Image src={src} alt={alt} width={900} height={1200} unoptimized />
        <span>点击放大检查</span>
      </button>
    </div>
  );
}

function GenerationProviderPicker({ value, codexAvailable, chatgptWebAvailable, chatgptWebMessage, onChange }: {
  value: GenerationProvider;
  codexAvailable: boolean;
  chatgptWebAvailable: boolean;
  chatgptWebMessage: string;
  onChange: (value: GenerationProvider) => void;
}) {
  return (
    <section className="jewelry-provider-picker" aria-label="选择本步骤生图通道">
      <div className="jewelry-provider-heading">
        <div><small>图片生成方式</small><b>选择这一步在哪里生成</b></div>
        <span>只影响当前图片</span>
      </div>
      <div className="jewelry-provider-options">
        <label className={value === "codex_builtin" ? "selected" : ""}>
          <input type="radio" name="jewelry-generation-provider" value="codex_builtin" checked={value === "codex_builtin"} disabled={!codexAvailable} onChange={() => onChange("codex_builtin")} />
          <span><b>Codex 内置生图</b><small>{codexAvailable ? "使用当前工作台内置通道" : "当前未接通"}</small></span>
          <i className={codexAvailable ? "ready" : "offline"}>{codexAvailable ? "可用" : "离线"}</i>
        </label>
        <label className={value === "chatgpt_web" ? "selected" : ""}>
          <input type="radio" name="jewelry-generation-provider" value="chatgpt_web" checked={value === "chatgpt_web"} disabled={!chatgptWebAvailable} onChange={() => onChange("chatgpt_web")} />
          <span><b>ChatGPT 网页生图</b><small>{chatgptWebAvailable ? "复用已登录网页，不占用 Codex 生图额度" : chatgptWebMessage}</small></span>
          <i className={chatgptWebAvailable ? "ready" : "offline"}>{chatgptWebAvailable ? "可用" : "离线"}</i>
        </label>
      </div>
      <details className="jewelry-provider-details"><summary>查看生成说明</summary><p>两种方式使用相同的参考图和人工确认流程；失败后不会自动切换或重复生成。</p></details>
    </section>
  );
}

function VideoProviderPicker({ value, seedanceModelKey, aspectRatio, durationSeconds, productImageCount, onChange, onSeedanceModelChange, onAspectRatioChange, onDurationChange }: {
  value: VideoProvider;
  seedanceModelKey: SeedanceModelKey;
  aspectRatio: VideoAspectRatio | "";
  durationSeconds: number;
  productImageCount: number;
  onChange: (value: VideoProvider) => void;
  onSeedanceModelChange: (value: SeedanceModelKey) => void;
  onAspectRatioChange: (value: VideoAspectRatio | "") => void;
  onDurationChange: (value: number) => void;
}) {
  return (
    <section className="jewelry-provider-picker" aria-label="选择短视频生成模型">
      <div className="jewelry-provider-heading">
        <div><small>视频生成模型</small><b>选择模型</b></div>
        <span>1 条 · 画幅与时长可选</span>
      </div>
      <div className="jewelry-provider-options">
        <label htmlFor="jewelry-video-provider-libtv" aria-label="选择 Seedance 视频模型" className={value === "libtv" ? "selected" : ""}>
          <input id="jewelry-video-provider-libtv" type="radio" name="jewelry-video-provider" value="libtv" checked={value === "libtv"} onChange={() => onChange("libtv")} />
          <span><b>Seedance</b><small>画面质量更好，费用相对更高</small></span>
        </label>
        <label htmlFor="jewelry-video-provider-runninghub" aria-label="选择 MiniMax H3 视频模型" className={value === "runninghub_h3_multiref" ? "selected" : ""}>
          <input id="jewelry-video-provider-runninghub" type="radio" name="jewelry-video-provider" value="runninghub_h3_multiref" checked={value === "runninghub_h3_multiref"} onChange={() => onChange("runninghub_h3_multiref")} />
          <span><b>MiniMax H3</b><small>成本更低，性价比更高</small></span>
        </label>
      </div>
      {value === "libtv" && <label className="jewelry-model-select"><span>Seedance 版本</span><select aria-label="Seedance 版本" value={seedanceModelKey} onChange={(event) => onSeedanceModelChange(event.target.value as SeedanceModelKey)}><option value="star-video2.5">Seedance 2.5</option><option value="star-video2">Seedance 2.0</option><option value="star-video2-fast">Seedance 2.0 Fast</option></select><small>本次会按这里选择的版本真实提交，不会自动换成其他模型。</small></label>}
      <label className="jewelry-model-select"><span>视频画幅（必选）</span><select aria-label="视频画幅" value={aspectRatio} onChange={(event) => onAspectRatioChange(event.target.value as VideoAspectRatio | "")}><option value="">请选择画幅</option><option value="3:4">3:4 竖版</option><option value="9:16">9:16 竖屏</option><option value="4:3">4:3 横版</option><option value="16:9">16:9 横屏</option></select><small>选择和发布平台、原图构图最合适的画幅。</small></label>
      <label className="jewelry-model-select jewelry-duration-range"><span>视频时长：<b>{durationSeconds} 秒</b></span><input type="range" aria-label="视频时长" min="4" max="15" step="1" value={durationSeconds} onInput={(event) => onDurationChange(Number(event.currentTarget.value))} onChange={(event) => onDurationChange(Number(event.target.value))} /><small>可在 4–15 秒之间逐秒选择。</small></label>
      {value === "runninghub_h3_multiref" && <div className="jewelry-generation-note"><b>本次产品参考</b><span>已选择 {productImageCount} 张产品图。系统会分别使用每张图片保留不同角度和细节，不会把多张产品图压成一张。</span></div>}
      <details className="jewelry-provider-details"><summary>查看两种模型的区别</summary><p>Seedance 通常画面和动态质量更好，费用相对更高；MiniMax H3 成本更低、性价比更高。两种模型都可以选择画幅和 4–15 秒时长。</p></details>
    </section>
  );
}

function UploadPreviewList({ items }: { items: UploadPreview[] }) {
  if (items.length === 0) return <span className="jewelry-upload-empty">尚未选择图片</span>;
  return <div className="jewelry-upload-previews" aria-label={`已选择 ${items.length} 张图片`}>
    {items.map((item) => <span key={`${item.name}-${item.url}`}><Image src={item.url} alt={item.name} width={96} height={72} unoptimized /><small>{item.name}</small></span>)}
  </div>;
}

function FeedbackPanel({ stage, generationAvailable = true, partialBody = false, selectedIssues, feedbackText, busy, onToggle, onText, onCancel, onSubmit }: {
  stage: "visual_base" | "product_replacement" | "video_generation";
  partialBody?: boolean;
  generationAvailable?: boolean;
  selectedIssues: string[];
  feedbackText: string;
  busy: boolean;
  onToggle: (code: string) => void;
  onText: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const options = stage === "visual_base"
    ? (partialBody ? [{ code: "body_appearance", label: "肤色或手型不对" }, { code: "unwanted_face", label: "出现了不需要的人脸" }, ...BASE_FEEDBACK_OPTIONS.filter((item) => item.code !== "person_identity")] : BASE_FEEDBACK_OPTIONS)
    : stage === "product_replacement"
      ? PRODUCT_FEEDBACK_OPTIONS
      : VIDEO_FEEDBACK_OPTIONS;
  const canSubmit = selectedIssues.length > 0 || feedbackText.trim().length > 0;
  return (
    <div className="jewelry-feedback-panel">
      <div><b>具体哪里不对？</b><small>{stage === "video_generation" ? "可多选。提交后只保存问题并生成定向修正要求，不会在这一步扣费或自动重生。" : "可多选。后台会先把问题编译成定向修正要求，再只重生 1 张图片。"}</small></div>
      <div className="jewelry-feedback-options">
        {options.map((option) => <label key={option.code} className={selectedIssues.includes(option.code) ? "selected" : ""}><input type="checkbox" checked={selectedIssues.includes(option.code)} onChange={() => onToggle(option.code)} /><span>{option.label}</span></label>)}
      </div>
      <label className="jewelry-feedback-text"><span>补充描述（可选）</span><textarea value={feedbackText} onChange={(event) => onText(event.target.value)} maxLength={1000} placeholder={stage === "product_replacement" ? "例如：飞马头应朝左，现在像是被镜像了；翅膀和腿的方向也不对。" : stage === "video_generation" ? "例如：画面被裁掉了脸；珠宝方向发生变化；人物或背景有明显跳变。" : partialBody ? "例如：出现了不需要的人脸；手型或手指遮挡关系不自然。" : "例如：脸不像授权模特，手机和手指遮挡关系不自然。"} /></label>
      <div className="jewelry-feedback-actions"><button type="button" className="jewelry-secondary" onClick={onCancel}>取消</button><button type="button" className="jewelry-primary" disabled={!canSubmit || busy || !generationAvailable} onClick={onSubmit}>{busy ? "正在提交…" : stage === "video_generation" ? "保存问题，生成修正方案" : "提交问题并重新生成"}</button></div>
    </div>
  );
}

const BASE_FEEDBACK_OPTIONS = [
  { code: "person_identity", label: "人物不像" },
  { code: "pose_hands", label: "姿态或手不自然" },
  { code: "composition", label: "构图或镜像不对" },
  { code: "lighting_realism", label: "光线或真实感不对" },
  { code: "jewelry_slot", label: "佩戴位置不好用" },
  { code: "ai_artifacts", label: "有明显 AI 痕迹" },
  { code: "other", label: "其他" },
];

const PRODUCT_FEEDBACK_OPTIONS = [
  { code: "product_detail_visibility", label: "产品细节不像或看不清" },
  { code: "product_orientation", label: "浮雕/纹理方向不对" },
  { code: "product_structure", label: "款式或连接结构不对" },
  { code: "scale_position", label: "大小或位置不对" },
  { code: "physical_integration", label: "漂浮、贴图或接触不自然" },
  { code: "base_changed", label: "人物或底片被改了" },
  { code: "lighting_realism", label: "产品光线或清晰度不对" },
  { code: "other", label: "其他" },
];

const VIDEO_FEEDBACK_OPTIONS = [
  { code: "video_composition", label: "比例、构图或裁切不对" },
  { code: "product_drift", label: "产品不一致或结构漂移" },
  { code: "person_drift", label: "人物脸、手或衣服变形" },
  { code: "motion_artifacts", label: "动态、闪烁或背景异常" },
  { code: "audio_unwanted", label: "出现了不需要的声音" },
  { code: "other", label: "其他" },
];

export function statusLabel(status: JewelryTask["status"], strategy?: string) {
  const label = ({ ready: "资料已保存", running_base: "正在生成人物图", base_review: "人物图待确认", base_failed: "人物图生成已暂停", running_product: "正在换上珠宝", final_review: "成品图待确认", product_failed: "换品已暂停", video_ready: "成品图已采用", running_video: "正在生成短视频", video_review: "视频待确认", video_failed: "视频待重新生成", completed: "视频已采用" })[status];
  return strategy === "partial_body" ? label.replaceAll("人物", "局部") : label;
}

function statusTone(status: JewelryTask["status"]) {
  if (["completed"].includes(status)) return "done";
  if (["base_review", "final_review", "video_review"].includes(status)) return "waiting";
  if (["base_failed", "product_failed", "video_failed"].includes(status)) return "blocked";
  return "running";
}

function ratioLabel(value: string) {
  return value === "follow_source" ? "跟随参考图比例" : `${value} 比例`;
}

function slotLabel(value: JewelryTask["target_slot"]) {
  return ({ necklace: "项链 / 吊坠", earrings: "耳环 / 耳饰", bracelet: "手链 / 手镯", ring: "戒指", brooch_hair: "胸针 / 发饰" })[value];
}

function progressSteps(task: JewelryTask) {
  const order = task.visual_mode === "direct_product_edit"
    ? ["素材已准备", "换上产品", "确认图片", "生成视频", "确认视频"]
    : ["素材已准备", task.person_strategy === "partial_body" ? "生成局部画面" : "生成人物画面", "换上产品", "确认图片", "生成视频", "确认视频"];
  const stageIndex = task.status === "completed" ? order.length
    : task.status === "video_review" ? order.length - 1
      : ["video_ready", "running_video", "video_failed"].includes(task.status) ? order.length - 2
        : task.status === "final_review" ? order.length - 3
          : task.status === "running_product" || task.status === "product_failed" ? order.length - 4
        : task.status === "base_review" ? 1
          : task.status === "running_base" || task.status === "base_failed" ? 1
            : 0;
  return order.map((label, index) => ({ label, index: index + 1, state: index < stageIndex ? "done" : index === stageIndex ? "active" : "pending" }));
}

function currentStepTitle(task: JewelryTask) {
  const base = task.person_strategy === "partial_body" ? "局部画面" : "人物画面";
  if (task.status === "ready") return task.current_stage === "product_replacement" ? "确认本次使用的图片，然后换上产品" : `确认本次使用的图片，然后生成${base}`;
  if (task.status === "running_base") return `${base}正在生成，完成后会在这里显示`;
  if (task.status === "base_review") return `放大查看${base}，满意就继续换产品`;
  if (task.result_check_required) return "原任务结果待核实，请先检查原任务";
  if (task.status === "base_failed") return task.user_message || "本次画面生成已暂停，请按下方提示处理";
  if (task.status === "running_product") return "正在换上产品，完成后会在这里显示";
  if (task.status === "final_review") return "对照产品图检查，满意就确认采用";
  if (task.status === "product_failed") return task.user_message || "本次换产品没有完成，请按下方提示处理";
  if (task.status === "video_ready") return "成品图已采用，请设置模型、画幅和时长";
  if (task.status === "running_video") return "短视频正在生成，完成后会在这里显示";
  if (task.status === "video_review") return "播放查看短视频，满意就确认采用";
  if (task.status === "video_failed") return "选择模型重新生成；上一版可在下方展开查看";
  return "图片和视频都已采用，可在成果中心继续查看";
}
