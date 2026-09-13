const PROCESSING = new Set([
  "running_decomposition", "running_rewrite", "running_person_generation",
  "running_product_assets",
  "running_storyboard_generation", "running_motion_preflight", "running_video_prompt",
  "running_person_package", "running_generation_pack", "running_video_generation",
]);

const ASSISTANCE = new Set([
  "storyboard_generation_failed", "motion_preflight_blocked", "video_prompt_blocked",
  "person_package_failed", "generation_pack_blocked", "video_generation_failed",
  "product_assets_blocked",
  "person_generation_failed", "interrupted", "failed", "blocked_configuration",
  "blocked_runtime", "blocked_diagnostic",
]);

const STEP_LABELS = Object.freeze({
  decomposition: "理解参考视频",
  user_confirmation: "确认参考片分析",
  rewrite: "重构内容方案",
  completed: "选择人物和制作方式",
  person_inputs_ready: "准备人物",
  person_generation: "生成人物候选",
  person_review: "确认人物形象",
  product_assets: "整理产品参考图",
  product_assets_review: "确认产品参考图",
  storyboard_inputs_ready: "准备分镜",
  storyboard_generation: "生成分镜",
  storyboard_review: "确认分镜",
  motion_preflight: "检查动作与镜头",
  video_prompt: "整理视频生成方案",
  person_package: "补齐人物一致性素材",
  generation_pack: "完成生成前检查",
  video_generation: "生成视频",
});

const NEXT_STEPS = Object.freeze({
  ready: "确认项目设置后开始处理参考视频。",
  awaiting_confirmation: "查看当前结果并确认是否继续。",
  completed: "选择人物路线，继续准备人物。",
  person_inputs_ready: "创建或提交本次要使用的人物。",
  person_review: "放大查看人物候选，满意后采用。",
  person_approved: "生成第一版分镜。",
  product_assets_review: "放大查看干净产品参考，准确后采用。",
  storyboard_inputs_ready: "确认分镜要求并开始生成。",
  storyboard_review: "放大查看分镜，满意后采用。",
  storyboard_approved: "开始动作与镜头检查。",
  motion_preflight_ready: "整理正式视频生成方案。",
  video_prompt_ready: "选择本次模型和生成方式，进入生成前检查。",
  person_package_required: "补齐人物一致性所需素材。",
  person_package_review: "检查人物一致性素材，合格后采用。",
  generation_pack_ready: "确认本次模型和必要上传范围后提交生成。",
  video_generation_completed: "查看生成结果并决定采用、复验或继续完整版。",
});

function clean(value, fallback = "") {
  return String(value || fallback)
    .replace(/\/Users\/[^/\s]+/g, "当前电脑")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function publicSummary(value, fallback) {
  const summary = clean(value, fallback);
  if (/clean-image|route receipt|task_root|A（推荐）|\bready route\b/i.test(summary)) {
    return "当前步骤的运行条件没有对齐，已有成果已保留，也没有自动重试。";
  }
  return summary;
}

export function projectUserState(task) {
  const status = String(task?.status || "ready");
  const currentStep = STEP_LABELS[task?.current_step] || "继续当前任务";
  const summary = publicSummary(task?.user_message, "当前任务状态已记录。");

  if (task?.video_generation_result?.user_approval_status === "approved") {
    return {
      key: "completed",
      label: "已采用",
      tone: "done",
      headline: "当前视频已采用",
      summary,
      next_step: "可以在成果中心播放、比较历史版本，或按需继续返工某个片段。",
      needs_attention: false,
    };
  }

  if (PROCESSING.has(status)) {
    return {
      key: "processing",
      label: "正在处理",
      tone: "running",
      headline: currentStep,
      summary,
      next_step: "暂时不用操作；完成或需要确认时，工作台会在这里说明。",
      needs_attention: false,
    };
  }

  if (ASSISTANCE.has(status)) {
    const handedOff = Boolean(task?.workflow_handoff);
    return {
      key: "assistance",
      label: "需要处理",
      tone: "error",
      headline: "当前步骤没有继续消耗或重复提交",
      summary,
      next_step: handedOff
        ? "打开已经准备好的项目任务，从当前步骤继续处理。"
        : "查看当前说明和已有成果；需要判断或修复时，在对应 Codex 任务中继续。",
      needs_attention: true,
    };
  }

  return {
    key: "confirmation",
    label: "等你确认",
    tone: status === "video_generation_completed" ? "done" : "waiting",
    headline: status === "video_generation_completed" ? "结果已经准备好" : currentStep,
    summary,
    next_step: NEXT_STEPS[status] || "查看当前结果和主按钮，确认后继续。",
    needs_attention: true,
  };
}

export function buildTaskContext(task) {
  const userState = projectUserState(task);
  return {
    task: {
      id: task.id,
      title: task.title,
      user_state: userState,
      internal_status: task.status,
      current_step: task.current_step,
      user_message: clean(task.user_message),
      last_error: clean(task.last_error),
      estimated_cost_cny: Number(task.estimated_cost_cny || 0),
      selected_routes: {
        remix: task.remix_precision_route || null,
        person: task.person_route || null,
        image_provider: task.default_image_generation_provider || null,
        video_model: task.generation_model_key || null,
      },
    },
    available_results: (task.artifacts || []).map((item) => ({
      label: clean(item.label), stage: item.stage, published: Boolean(item.published),
    })).slice(0, 30),
    recent_events: (task.events || []).slice(0, 8).map((item) => ({
      level: item.level, message: clean(item.message), created_at: item.created_at,
    })),
    workflow_handoff: task.workflow_handoff || null,
  };
}

export function answerQuickQuestion(task, message) {
  const text = clean(message);
  const state = projectUserState(task);
  if (/下一步|怎么做|点哪里|如何继续/.test(text)) {
    return { answer: state.next_step, current_state: state.key, next_step: state.next_step, risk_note: "不会替你提交、上传、扣费或修改成果。", source: "deterministic" };
  }
  if (/为什么|失败|出错|问题|卡住|停止|暂停/.test(text)) {
    const reason = clean(task.last_error || task.user_message, "现有记录不足以判断具体原因。");
    return { answer: `目前能确认的是：${reason}`, current_state: state.key, next_step: state.next_step, risk_note: "我只依据当前任务记录说明，没有发起重试。", source: "deterministic" };
  }
  if (/现在|到哪|进度|后台|进行中|状态/.test(text)) {
    return { answer: `${state.label}：${state.headline}。${state.summary}`, current_state: state.key, next_step: state.next_step, risk_note: "这是当前任务记录的只读解释。", source: "deterministic" };
  }
  return null;
}
