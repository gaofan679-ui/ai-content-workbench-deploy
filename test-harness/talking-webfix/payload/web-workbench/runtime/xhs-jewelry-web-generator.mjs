import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  completedBrowserJobForRequest,
  createBrowserJob,
  getBrowserJob,
  pendingBrowserJobForTask,
  updateBrowserJob,
} from "./chatgpt-web-bridge.mjs";
import { ensureXhsJewelryProjectRoute } from "./xhs-jewelry-artifact-route.mjs";

export async function runXhsJewelryWebGeneration({
  task,
  taskDir,
  stage,
  contract,
  productPack = null,
  onEvent,
  onExternalRequestStarted,
  onBrowserJob,
  env = process.env,
}) {
  const existingPending = pendingBrowserJobForTask(env.WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT || join(taskDir, "browser-bridge"), task.id, stage);
  if (existingPending) {
    const error = preflightError("XHS_JEWELRY_RESULT_CHECK_REQUIRED");
    error.result_check_required = true;
    throw error;
  }
  const referenceBindings = buildReferenceBindings(task, stage, productPack);
  const uploadBindings = await prepareWebUploadBindings(referenceBindings, { taskDir, stage });
  const sourceGeometry = await displayedGeometry(referenceBindings[0].path);
  const prompt = buildWebPrompt({ task, stage, contract, referenceBindings, productPack, sourceGeometry });
  const promptSha256 = sha256Text(prompt);
  const bridgeRoot = env.WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT;
  if (!bridgeRoot) throw preflightError("CHATGPT_WEB_BRIDGE_NOT_CONNECTED");
  // A user-requested rework must always create a fresh browser job. Reusing a
  // completed job here would silently return the candidate the user rejected.
  const completed = task.pending_rework ? null : completedBrowserJobForRequest(bridgeRoot, {
    taskId: task.id,
    promptSha256,
    referenceBindings: uploadBindings,
  });
  const job = completed || createBrowserJob(bridgeRoot, {
    task: { ...task, generation_stage: `xhs_jewelry_${stage}` },
    taskDir,
    prompt,
    promptSha256,
    referenceBindings: uploadBindings,
  });
  const recoveryDir = join(taskDir, "browser-recovery");
  mkdirSync(recoveryDir, { recursive: true });
  const recoveryPath = join(recoveryDir, `${job.id}.json`);
  if (!existsSync(recoveryPath)) writeFileSync(recoveryPath, JSON.stringify({
    jobId: job.id, taskId: task.id, stage, task, promptSha256, referenceBindings, uploadBindings, productPack,
  }, null, 2), { flag: "wx" });
  onBrowserJob?.(job.id);
  onEvent?.(completed
    ? "已找到同一请求先前完成的 ChatGPT 图片，正在接回；不会再次发送。"
    : "ChatGPT 浏览器伴侣任务已建立，正在等待页面接收。");

  const timeoutMs = Number(env.WORKBENCH_CHATGPT_WEB_TIMEOUT_MS || 10 * 60 * 1000);
  const deadline = Date.now() + Math.max(30_000, timeoutMs);
  let lastState = "";
  let lastMessage = "";
  let requestMarked = false;
  let waitingStartedAt = 0;
  let slowWarningSent = false;
  while (Date.now() < deadline) {
    const current = getBrowserJob(bridgeRoot, job.id);
    if (!current) throw preflightError("CHATGPT_BROWSER_JOB_NOT_FOUND");
    if (current.state !== lastState || current.message !== lastMessage) {
      lastState = current.state;
      lastMessage = current.message;
      onEvent?.(current.message || stateMessage(current.state));
    }
    if (!requestMarked && ["submitting", "submitted", "waiting_result", "submission_unknown", "completed"].includes(current.state)) {
      requestMarked = true;
      onExternalRequestStarted?.();
    }
    if (current.state === "waiting_result") {
      waitingStartedAt ||= Date.now();
      if (!slowWarningSent && Date.now() - waitingStartedAt >= 3 * 60 * 1000) {
        slowWarningSent = true;
        onEvent?.("已等待超过 3 分钟，ChatGPT 可能变慢；工作台仍在检查，页面明确报错会立即停止，满 10 分钟仍无结果会暂停核对。");
      }
    }
    if (current.state === "completed") {
      return finalizeWebResult({ current, task, taskDir, stage, promptSha256, referenceBindings, uploadBindings, env });
    }
    if (["auth_required", "blocked", "failed", "submission_unknown"].includes(current.state)) {
      const error = preflightError(stateError(current));
      error.external_request_started = requestMarked;
      error.attempt_refund = current.attempt_refund === true;
      error.provider_failure = current.state === "failed" && requestMarked && !error.attempt_refund;
      error.result_check_required = current.state === "submission_unknown";
      error.user_message = browserFailureMessage(current);
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  const timedOut = getBrowserJob(bridgeRoot, job.id);
  const mayHaveSubmitted = timedOut && ["submitting", "submitted", "waiting_result"].includes(timedOut.state);
  if (timedOut && !["completed", "blocked", "failed", "submission_unknown"].includes(timedOut.state)) {
    updateBrowserJob(bridgeRoot, job.id, {
      state: mayHaveSubmitted ? "submission_unknown" : "failed",
      message: mayHaveSubmitted
        ? "生成请求可能已经提交，但结果状态无法确认；系统不会自动再发一次。"
        : "浏览器伴侣等待超时，任务没有进入提交状态。",
    });
  }
  const error = preflightError("CHATGPT_WEB_BRIDGE_TIMEOUT");
  error.external_request_started = Boolean(mayHaveSubmitted || requestMarked);
  error.result_check_required = Boolean(mayHaveSubmitted || requestMarked);
  error.user_message = mayHaveSubmitted || requestMarked
    ? "原请求可能已经提交。请检查原任务，暂不重新生成。"
    : "浏览器未能及时接收或上传素材，本次已停止。请打开 ChatGPT，确认输入框可用后再继续。";
  throw error;
}

export async function inspectXhsJewelryOriginalWebResult({ task, taskDir, stage, env = process.env }) {
  const root = env.WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT;
  const pending = root ? pendingBrowserJobForTask(root, task.id, stage) : null;
  const id = task.browser_job_id || pending?.id;
  if (!id || !root) return { state: "unavailable", message: "未找到可核对的原网页任务记录，请保留当前项目并联系支持处理。" };
  const job = getBrowserJob(root, id);
  if (!job || job.task_id !== task.id || (job.generation_stage && job.generation_stage !== `xhs_jewelry_${stage}`)) {
    return { state: "unavailable", message: "原任务记录无法匹配，已停止重新提交，请联系支持处理。" };
  }
  const age = Date.now() - Date.parse(job.created_at || "");
  if (["queued", "claimed", "page_ready", "uploading"].includes(job.state)
      && Number.isFinite(age) && age >= Number(env.WORKBENCH_CHATGPT_WEB_TIMEOUT_MS || 10 * 60 * 1000)) {
    updateBrowserJob(root, id, { state: "failed", message: "原请求在正式提交前等待超时，已停止领取与提交。" });
    return { state: "failed", message: "原任务在正式提交前已超时停止。请确认 ChatGPT 输入框和附件可用，再重新开始。" };
  }
  if (["failed", "blocked", "auth_required"].includes(job.state)) {
    return { state: "failed", message: browserFailureMessage(job) };
  }
  if (job.state !== "completed") return {
    state: "pending", message: ["queued", "claimed", "page_ready", "uploading"].includes(job.state)
      ? "原任务仍在等待浏览器或上传素材。请保持 ChatGPT 页面打开，稍后再检查；不会新建生成请求。"
      : "原请求尚未确认结果。请保持原 ChatGPT 对话打开，稍后再检查；不会重新提交。",
  };
  const contextPath = join(taskDir, "browser-recovery", `${id}.json`);
  if (!existsSync(contextPath) || lstatSync(contextPath).isSymbolicLink()) return { state: "unavailable", message: "网页已有结果，但缺少本轮引用核对记录，请联系支持接回图片；不要重新生成。" };
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  const attemptField = stage === "visual_base" ? "base_attempt_count" : "product_attempt_count";
  if (context.taskId !== task.id || context.stage !== stage || context.jobId !== id
      || context.task[attemptField] !== task[attemptField] || context.promptSha256 !== job.prompt_sha256
      || context.uploadBindings.length !== job.assets.length
      || context.uploadBindings.some((item, index) => item.path !== job.assets[index].path || item.sha256 !== job.assets[index].sha256)
      || context.referenceBindings.some((item) => sha256File(item.path) !== item.sha256)) {
    throw preflightError("XHS_JEWELRY_REFERENCE_BINDING_MISMATCH");
  }
  const raw = await finalizeWebResult({ current: job, task: context.task, taskDir, stage,
    promptSha256: context.promptSha256, referenceBindings: context.referenceBindings,
    uploadBindings: context.uploadBindings, env });
  return { state: "completed", raw, executionTask: context.task, productPack: context.productPack };
}

export function browserFailureMessage(job) {
  if (job.failure_code === "CHATGPT_FEEDBACK_CLARIFICATION_REQUIRED") return `需要补充说明：${job.assistant_response_excerpt || "请说明希望怎样修改。"} 上一版仍保留，请在“填写问题”中补充。`;
  if (job.state === "auth_required") return "ChatGPT 页面未能进入可输入状态。请查看原页面的登录、验证或加载提示，处理后再继续。";
  if (job.state === "submission_unknown") return "原请求的提交或结果尚未确认，请检查原任务，暂不重新生成。";
  if (job.state === "blocked" && !job.submission_marker_confirmed) {
    if (job.failure_code === "ATTACHMENT_DRAFT_PRESENT") return "原网页已有草稿或附件，工作台已保留并停止。本次未发送生成请求，请先查看原页面。";
    if (/ATTACHMENT_(INPUT|SCOPE)/.test(job.failure_code || "")) return "工作台未能确认网页的上传入口或附件区域，本次未发送生成请求。请查看原页面，并反馈此提示以检查浏览器伴侣。";
    if (/ATTACHMENT_/.test(job.failure_code || "") || /附件|上传.*超时|参考图/.test(job.message || "")) return "参考图上传或核对未完成，本次未发送生成请求。素材已保留，请先查看原网页的附件和错误提示，不要连续重试。";
  }
  if (job.attempt_refund) return "参考图未完整送达，本次已停止。请检查 ChatGPT 附件，确认图片完整后再继续。";
  if (/generating your image|图片生成失败|生图失败|IMAGE_GENERATION_FAILED/i.test(`${job.failure_code || ""} ${job.message || ""}`)) return "ChatGPT 已明确返回图片生成失败。素材已保留，你可以手动重新生成。";
  if (job.submission_marker_confirmed) return "原网页任务已明确结束，但未返回可用图片。请查看原 ChatGPT 对话的提示，再决定是否重新生成。";
  return "图片尚未完成提交，浏览器处理已停止。请查看 ChatGPT 页面及附件提示，再继续当前步骤。";
}

export function buildXhsJewelryWebRequest({ task, stage, contract, productPack = null }) {
  const referenceBindings = buildReferenceBindings(task, stage, productPack);
  const prompt = buildWebPrompt({ task, stage, contract, referenceBindings, productPack });
  return { prompt, prompt_sha256: sha256Text(prompt), reference_bindings: referenceBindings };
}

async function finalizeWebResult({ current, task, taskDir, stage, promptSha256, referenceBindings, uploadBindings, env }) {
  if (!current.result_image_path || !existsSync(current.result_image_path) || !statSync(current.result_image_path).isFile()) {
    throw preflightError("CHATGPT_RESULT_IMAGE_MISSING");
  }
  if (lstatSync(current.result_image_path).isSymbolicLink()) throw preflightError("XHS_JEWELRY_ARTIFACT_SYMLINK_BLOCKED");
  assertFreshReworkCandidate(task, current.result_image_path);
  const geometryCheck = assessWebImageGeometry({
    source: await displayedGeometry(referenceBindings[0].path),
    result: await displayedGeometry(current.result_image_path),
    targetRatio: task.target_ratio,
  });
  const route = ensureXhsJewelryProjectRoute(task, taskDir, env);
  const extension = /^\.(png|jpe?g|webp)$/i.test(extname(current.result_image_path))
    ? extname(current.result_image_path).toLowerCase()
    : ".png";
  const attempt = stage === "visual_base" ? task.base_attempt_count : task.product_attempt_count;
  const runSuffix = String(task.active_run_id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  const label = stage === "visual_base" ? "visual-base" : "product-replacement";
  const targetPath = join(route.final_dir, `${label}-chatgpt-attempt-${attempt}-${runSuffix}${extension}`);
  if (existsSync(targetPath)) {
    if (lstatSync(targetPath).isSymbolicLink() || sha256File(targetPath) !== sha256File(current.result_image_path)) throw preflightError("XHS_JEWELRY_RESULT_TARGET_EXISTS");
  } else copyFileSync(current.result_image_path, targetPath, constants.COPYFILE_EXCL);
  const receiptPath = join(route.work_dir, `${label}-chatgpt-receipt-attempt-${attempt}-${runSuffix}.json`);
  const actualReferenceImages = referenceBindings.map((item, index) => ({
    path: item.path,
    sha256: item.sha256,
    uploaded_path: uploadBindings[index]?.path || item.path,
    uploaded_sha256: uploadBindings[index]?.sha256 || item.sha256,
    upload_derivative: uploadBindings[index]?.path !== item.path,
    role: item.role,
    must_inherit: item.must_inherit.join("；"),
    must_not_inherit: item.must_not_inherit.join("；"),
  }));
  const receipt = {
    schema_version: 1,
    status: "success",
    approval_status: "needs_review",
    task_id: task.id,
    business_skill: "xhs-jewelry-visual-remix",
    generation_provider: "chatgpt_web",
    generation_execution_context: "chatgpt_web_companion",
    browser_companion: true,
    browser_job_id: current.id,
    prompt_sha256: promptSha256,
    project_output_path: targetPath,
    raw_generation_path: current.result_image_path,
    actual_reference_images: actualReferenceImages,
    file_spec: { sha256: sha256File(targetPath), extension },
    generation_provenance: {
      browser_job_observed_by_workbench: true,
      exact_reference_bindings_used: true,
      recent_conversation_images_used: "false",
      automatic_retry: false,
    },
    automatic_retry: false,
    published: false,
  };
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  if (existsSync(receiptPath)) {
    if (lstatSync(receiptPath).isSymbolicLink() || readFileSync(receiptPath, "utf8") !== receiptText) throw preflightError("XHS_JEWELRY_EXECUTION_RECEIPT_MISMATCH");
  } else writeFileSync(receiptPath, receiptText, { flag: "wx" });
  return {
    status: "completed",
    summary: stage === "visual_base" ? "ChatGPT 网页已返回人物种草图候选。" : "ChatGPT 网页已返回珠宝替换候选。",
    estimated_cost_cny: 0,
    external_request_started: true,
    artifacts: [
      { label: stage === "visual_base" ? "人物种草图候选" : "珠宝种草图候选", path: targetPath, published: false },
      { label: "ChatGPT 网页生成执行回执", path: receiptPath, published: false },
    ],
    requires_confirmation: true,
    geometry_check: geometryCheck,
    user_message: !geometryCheck.pass
      ? `图片已返回，但画幅发生变化：要求 ${geometryCheck.expected_label}，实际 ${geometryCheck.result.width}×${geometryCheck.result.height}。请先检查构图；当前图片保留供查看，系统不会自动重生。`
      : stage === "visual_base"
      ? "ChatGPT 网页已返回 1 张人物种草图，请确认人物、氛围和佩戴位置。"
      : "ChatGPT 网页已返回 1 张珠宝种草图，请对照产品图检查结构、方向和佩戴融合。",
  };
}

async function prepareWebUploadBindings(referenceBindings, { taskDir, stage }) {
  if (stage !== "product_replacement") return referenceBindings;
  const uploadDir = join(taskDir, "web-upload-cache", stage);
  mkdirSync(uploadDir, { recursive: true });
  const prepared = [];
  for (const item of referenceBindings) {
    const targetPath = join(uploadDir, `${item.order}-${item.sha256.slice(0, 12)}.jpg`);
    if (!existsSync(targetPath)) {
      await sharp(item.path)
        .rotate()
        .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true })
        .toFile(targetPath);
    }
    prepared.push({
      ...item,
      path: targetPath,
      sha256: sha256File(targetPath),
      upload_name: `${String(item.order).padStart(2, "0")}_${item.role}_${basename(item.path).replace(/\.[^.]+$/, "")}.jpg`,
      source_path: item.path,
      source_sha256: item.sha256,
    });
  }
  return prepared;
}

function buildReferenceBindings(task, stage, productPack = null) {
  if (stage === "product_replacement" && !productPack?.generation_reference_plan?.product_evidence_paths?.length) {
    throw preflightError("XHS_JEWELRY_PRODUCT_PACK_REQUIRED");
  }
  const items = stage === "visual_base"
    ? [
        ...task.reference_image_paths.slice(0, 1).map((path) => ({
          path,
          role: "source_visual_style_only",
          must_inherit: ["构图", "姿态与行为", "场景", "成像指纹", "光线与色调", "珠宝佩戴槽位"],
          must_not_inherit: ["对标人物身份", "对标人物脸", "原珠宝产品结构", "品牌或文字"],
        })),
        ...task.person_image_paths.slice(0, 1).map((path) => ({
          path,
          role: task.person_strategy === "partial_body" ? "authorized_body_reference" : "authorized_person_identity",
          must_inherit: task.person_strategy === "partial_body" ? ["局部身体的肤色", "手型等已指定身体特征"] : ["人物身份", "可识别五官与发型特征"],
          must_not_inherit: ["原照片背景", "原照片服装与姿态", "原照片光线", ...(task.person_strategy === "partial_body" ? ["人脸", "可识别面部身份"] : [])],
        })),
      ]
    : [
        {
          path: productGenerationBasePath(task),
          role: "approved_base_lock",
          must_inherit: ["人物身份", "脸与头发", "表情视线", "姿态手势", "服装褶皱", "构图背景", "光线色调", "景深与画质"],
          must_not_inherit: ["原有目标珠宝"],
        },
        ...productPack.generation_reference_plan.product_evidence_paths.map((path, index) => ({
          path,
          role: productPack.generation_reference_plan.product_evidence_roles[index] || "product_identity_evidence",
          must_inherit: index === 0
            ? ["同一真实产品在多角度中的稳定结构", "轮廓与比例", "图案手性与朝向", "组件和连接关系"]
            : ["对应原始产品像素中的真实轮廓", "核心结构", "图案手性与朝向", "组件数量", "连接关系", "材质颜色"],
          must_not_inherit: index === 0
            ? ["证据板排版", "文字标签", "白色卡片背景", "把不同角度平均成新款", "镜像或翻转"]
            : ["产品图背景", "产品图模特", "产品图布光", "电商高光", "镜像或翻转"],
        })),
      ];
  if (task.pending_rework?.mode === "targeted_refine") {
    const candidate = task.pending_rework.rejected_candidate;
    if (!candidate?.path || !candidate.sha256 || !existsSync(candidate.path)
        || lstatSync(candidate.path).isSymbolicLink() || !lstatSync(candidate.path).isFile()) {
      throw preflightError("XHS_JEWELRY_FEEDBACK_IMAGE_UNAVAILABLE");
    }
    if (sha256File(candidate.path) !== candidate.sha256) {
      throw preflightError("XHS_JEWELRY_FEEDBACK_IMAGE_MISMATCH");
    }
    items.push({
      path: candidate.path,
      role: "rejected_candidate_diagnostic_only",
      must_inherit: ["仅观察用户反馈对应的位置与现象，不继承画面内容"],
      must_not_inherit: ["生成底图", "人物或产品身份", "错误结构", "错误材质", "原样返回上一版"],
    });
  }
  return items.filter((item) => item.path).map((item, index) => ({
    order: index + 1,
    ref_id: `JEWELRY-REF-${String(index + 1).padStart(2, "0")}`,
    display_name: basename(item.path),
    upload_name: `${String(index + 1).padStart(2, "0")}_${item.role}_${basename(item.path)}`,
    visual_locator: `第 ${index + 1} 张上传图（${item.role}）`,
    path: resolve(item.path),
    sha256: sha256File(item.path),
    role: item.role,
    must_inherit: item.must_inherit,
    must_not_inherit: item.must_not_inherit,
    upload_authorized: true,
  }));
}

function buildWebPrompt({ task, stage, referenceBindings, productPack = null, sourceGeometry = null }) {
  const bindings = referenceBindings.map((item) => [
    `${item.order}. ${item.visual_locator}`,
    `   - 职责：${item.role}`,
    `   - 必须继承：${item.must_inherit.join("、")}`,
    `   - 禁止继承：${item.must_not_inherit.join("、")}`,
  ].join("\n")).join("\n");
  const stageInstruction = stage === "visual_base"
    ? [
        "先在内部完成视觉反推，再直接生成最终人物种草图。",
        task.person_strategy === "partial_body"
          ? "本次只制作不露脸的局部佩戴画面：保持参考景别与可见身体部位，只呈现手部、颈部或穿搭局部，不新增完整人脸，不扩展为全身。无需人物身份图；有 authorized_body_reference 时仅继承局部肤色、手型，无此图时生成原创局部身体。source_visual_style_only 只提供构图、姿态、光线、场景和佩戴位置，不复制可识别人物身份、品牌、文字或原珠宝结构。"
          : "人物身份只来自 authorized_person_identity；source_visual_style_only 只提供构图、姿态、场景、光线色调、成像指纹和佩戴槽位，绝不能复制对标人物脸、品牌、文字或原珠宝结构。",
        `保持自然手机随拍和小红书生活种草感，保留真实皮肤纹理、轻微压缩与不完美；不要商业写真、棚拍广告、过度磨皮或过度精致的 AI 质感。第一阶段不绑定真实产品，只自然弱化旧珠宝或留出适合${task.target_slot}的佩戴位置。`,
      ].join("\n")
    : [
        `执行一次保护底片的生成式编辑，只替换目标槽位 ${task.target_slot}，不是贴图，也不是重新拍一张相似画面。`,
        "第 1 张 approved_base_lock 是已通过的人物底片。除旧珠宝、新珠宝及其极小接触、遮挡、阴影和反射区域外，人物、手、衣服、构图、背景和成像全部保持不变。",
        "标记为 product_* 的图片共同定义同一件真实产品：结构证据板帮助核对跨角度稳定结构，原始产品图是产品真实像素的最高视觉依据。诊断图不属于产品证据。不得把不同角度平均成新款，不得镜像、翻面、增删部件或自行设计。",
        categoryOperationRules(productPack?.category, task.target_slot),
        "产品图只定义产品身份，不继承其背景、模特、棚灯、微距锐度或电商高光。珠宝的色温、亮暗、反射、景深、边缘、噪声和可见细节服从第 1 张底图；看不见的微小细节允许自然损失，禁止凭空补全或异常强化。",
        "最终画面首先仍应被看成第 1 张真实照片，只是目标佩戴位置换成了产品参考中的同一件真实珠宝。",
      ].join("\n");
  const reworkInstruction = task.pending_rework?.mode === "fresh_variant" ? [
    "重新生成一张全新候选。上一张被否决候选只保留为历史，未上传、未参与本次生成，不得尝试复现它。",
    `本次仍使用同一产品资产包：${JSON.stringify(productPack?.sku_constraint_card || {})}`,
    "从第 1 张已确认底片重新换入产品，重新采样允许自然差异，但产品身份、人物身份和画面机制仍须遵守同一约束；结果通过技术验收后交用户审核。",
  ].join("\n") : task.pending_rework ? [
    "重新生成一张全新的修正候选，禁止复用或重新返回上一张被否决图片。",
    `用户指出的问题：${task.pending_rework.user_observation || "按所选问题逐项修正"}`,
    "先结合完整原话、rejected_candidate_diagnostic_only 诊断图和正式参考理解修改意图，定位哪里要改、哪些要保留，再执行本次生成。反馈不受预设分类限制；多项要求、否定和保留要求均按完整语义处理，不把口语措辞自动解释为不确定。",
    "上一版只提供问题对照，底片和产品证据仍决定画面及款式。只修正用户要求且可由参考核实的内容；未指定修正方向时不自行夸大。若存在会导致相反结果且无法从参考消除的歧义，说明需要澄清的问题，不猜测生成。",
    `必须修正：${(task.pending_rework.diagnosis?.required_repairs || []).join("；") || "按用户文字定向修正"}`,
    `完成前必须核对：${(task.pending_rework.diagnosis?.mandatory_checks || []).join("；") || "逐项核对用户反馈"}`,
    `允许的自然损失：${(task.pending_rework.diagnosis?.allowed_natural_loss || []).join("；") || "只允许符合当前景别、景深和压缩的自然细节损失"}`,
    `禁止过度修正：${(task.pending_rework.diagnosis?.forbidden_overcorrection || []).join("；") || "不得为了修一个问题而改变构图、比例或虚构细节"}`,
    `其余内容保持：${task.pending_rework.diagnosis?.preserve_contract || "未被指出的问题区域保持不变"}`,
    ...(task.pending_rework.feedback_interpretation?.uncertainty_detected
      ? ["用户表达包含不确定判断：先依据底片、产品原图和结构板核实是否真的有错；只修正有证据的问题，不要把猜测放大成大幅改造。"]
      : []),
    stage === "product_replacement"
      ? "第 1 张是已确认人物底片；最后一张 rejected_candidate_diagnostic_only 是本次被指出问题的上一版，只用于理解失败原因，不得作为本次生成底图、人物身份或画面身份参考。"
      : "被否决候选只用于理解失败原因，不得作为人物、产品或画面身份参考，也不得原样返回。",
  ].join("\n") : null;
  return [
    `生成目标：${stage === "visual_base" ? "生成一张真实自然的人物种草图" : "在已确认底片中准确换入产品参考里的真实珠宝"}。`,
    `目标画面比例：${task.target_ratio === "follow_source" ? "跟随第 1 张风格/底片参考" : task.target_ratio}`,
    ...(sourceGeometry ? [`第 1 张实际尺寸为 ${sourceGeometry.width}×${sourceGeometry.height}。${task.target_ratio === "follow_source" ? "输出必须保持相同宽高比，不能改成另一种画幅。" : "输出严格使用上面指定的宽高比。"} 不得为了修正珠宝而裁切、放大或重新布局非产品区域。`] : []),
    ...(task.brief ? [`用户补充要求：${task.brief}`] : []),
    "",
    "参考图职责（严格按上传顺序识别）：",
    bindings,
    "",
    "画面与产品要求：",
    stageInstruction,
    ...(reworkInstruction ? ["", "本次修正要求（优先执行）：", reworkInstruction] : []),
    "",
    task.pending_rework?.mode === "targeted_refine"
      ? "输出要求：意图可确定时只生成一张最终图片。仅在存在无法从图片消除、会导致相反修改结果的关键歧义时停止生图，只回复 [WB_FEEDBACK_QUESTION]一个简短的澄清问题[/WB_FEEDBACK_QUESTION]。不要回复分析、方案、JSON或多张候选。"
      : "输出要求：只生成一张最终图片，不要回复分析、方案、JSON、说明或多张候选。",
  ].join("\n");
}

async function displayedGeometry(path) {
  const metadata = await sharp(path).metadata();
  const swapped = metadata.orientation >= 5 && metadata.orientation <= 8;
  return { width: swapped ? metadata.height : metadata.width, height: swapped ? metadata.width : metadata.height };
}

export function assessWebImageGeometry({ source, result, targetRatio }) {
  const parts = String(targetRatio || "").match(/^(\d+):(\d+)$/);
  const expected = parts ? Number(parts[1]) / Number(parts[2]) : source.width / source.height;
  const actual = result.width / result.height;
  const deviation = Math.abs(actual / expected - 1);
  return { pass: Number.isFinite(deviation) && deviation <= 0.01, expected_label: parts ? targetRatio : `${source.width}:${source.height}`, source, result, relative_deviation: deviation };
}

function categoryOperationRules(category, targetSlot) {
  if (category === "ring") {
    return "戒指规则：严格保持原手、手指数量、指节姿态和皮肤纹理；戒圈必须按指定手指的截面自然环绕，宽度、厚度、重复节点和正面朝向来自产品证据，并随透视产生合理缩短、遮挡、接触阴影与金属反射。不得把戒指变成指甲装饰、开口错误、悬浮或套错手指。";
  }
  if (category === "necklace") {
    return "项链规则：链条、连接环和吊坠的组件关系与朝向来自产品证据；链条沿颈部、锁骨和衣领受重力自然下垂，吊坠有合理垂直方向、遮挡、接触阴影和环境反射。不得悬浮、贴纸化，也不得为了展示产品改变领口、头发、姿态或构图。";
  }
  return `珠宝规则：按 ${targetSlot || "指定位置"} 的真实人体接触、重力、遮挡和透视植入产品；产品结构、方向、比例和连接关系只来自视觉证据，不得重设计。`;
}

export function assertFreshReworkCandidate(task, candidatePath) {
  const rejectedSha256 = task?.pending_rework?.rejected_candidate?.sha256;
  if (!rejectedSha256) return;
  if (sha256File(candidatePath) !== rejectedSha256) return;
  const error = preflightError("CHATGPT_REWORK_RETURNED_REJECTED_IMAGE");
  error.external_request_started = true;
  throw error;
}

function approvedBasePath(task) {
  return task.base_result?.image?.path
    || (task.visual_mode === "direct_product_edit" ? task.reference_image_paths?.[0] : null);
}

function productGenerationBasePath(task) {
  return approvedBasePath(task);
}

function sha256File(path) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) throw preflightError("CHATGPT_REFERENCE_IMAGE_UNAVAILABLE");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stateMessage(state) {
  return ({ claimed: "浏览器伴侣已领取任务。", page_ready: "ChatGPT 页面已就绪。", uploading: "正在上传已授权参考图。", submitting: "正在提交本次唯一一次生成请求。", submitted: "已提交 1 次生成请求。", waiting_result: "正在等待 ChatGPT 返回图片；页面明确报错会立即停止，超过 10 分钟仍无结果会暂停核对，绝不会自动重发。" })[state] || `浏览器任务状态：${state}`;
}

function stateError(job) {
  if (job.failure_code === "CHATGPT_FEEDBACK_CLARIFICATION_REQUIRED") return job.failure_code;
  if (job.state === "auth_required") return "CHATGPT_WEB_LOGIN_REQUIRED";
  if (job.state === "submission_unknown") return "CHATGPT_WEB_SUBMISSION_UNKNOWN";
  if (job.state === "blocked" && job.submission_marker_confirmed !== true) return "CHATGPT_WEB_PRE_SUBMIT_BLOCKED";
  return job.message || "CHATGPT_WEB_BRIDGE_FAILED";
}

function preflightError(code) {
  const error = new Error(code);
  error.code = code;
  error.external_request_started = false;
  if (/^XHS_JEWELRY_FEEDBACK_IMAGE_/.test(code)) error.user_message = "无法核对本次修改对应的上一版图片，已在提交前停止。请保留项目并联系支持检查图片记录。";
  return error;
}
