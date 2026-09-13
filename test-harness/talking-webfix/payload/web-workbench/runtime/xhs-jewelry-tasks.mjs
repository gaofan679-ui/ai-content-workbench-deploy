import { randomUUID } from "node:crypto";

export const XHS_JEWELRY_STATUSES = Object.freeze({
  READY: "ready",
  RUNNING_BASE: "running_base",
  BASE_REVIEW: "base_review",
  BASE_FAILED: "base_failed",
  RUNNING_PRODUCT: "running_product",
  FINAL_REVIEW: "final_review",
  PRODUCT_FAILED: "product_failed",
  VIDEO_READY: "video_ready",
  RUNNING_VIDEO: "running_video",
  VIDEO_REVIEW: "video_review",
  VIDEO_FAILED: "video_failed",
  COMPLETED: "completed",
});

const now = () => new Date().toISOString();

export function initializeXhsJewelryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS xhs_jewelry_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      visual_mode TEXT NOT NULL,
      target_slot TEXT NOT NULL DEFAULT 'necklace',
      target_ratio TEXT NOT NULL DEFAULT 'follow_source',
      brief TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL,
      reference_image_paths_json TEXT NOT NULL DEFAULT '[]',
      person_image_paths_json TEXT NOT NULL DEFAULT '[]',
      product_image_paths_json TEXT NOT NULL DEFAULT '[]',
      product_facts_json TEXT NOT NULL DEFAULT '{}',
      person_authorization_confirmed INTEGER NOT NULL DEFAULT 0,
      external_upload_authorized INTEGER NOT NULL DEFAULT 0,
      base_attempt_count INTEGER NOT NULL DEFAULT 0,
      product_attempt_count INTEGER NOT NULL DEFAULT 0,
      video_attempt_count INTEGER NOT NULL DEFAULT 0,
      base_generation_provider TEXT,
      product_generation_provider TEXT,
      active_generation_provider TEXT,
      active_stage TEXT,
      active_run_id TEXT,
      active_run_started_at TEXT,
      active_external_request_started INTEGER NOT NULL DEFAULT 0,
      base_result_json TEXT,
      final_result_json TEXT,
      video_result_json TEXT,
      video_provider TEXT,
      video_model_key TEXT,
      video_aspect_ratio TEXT,
      video_duration_seconds INTEGER,
      pending_rework_json TEXT,
      feedback_history_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      user_message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS xhs_jewelry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES xhs_jewelry_tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_xhs_jewelry_tasks_updated
      ON xhs_jewelry_tasks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_xhs_jewelry_events_task
      ON xhs_jewelry_events(task_id, id DESC);
  `);
  ensureColumn(db, "xhs_jewelry_tasks", "target_slot", "TEXT NOT NULL DEFAULT 'necklace'");
  ensureColumn(db, "xhs_jewelry_tasks", "product_facts_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "xhs_jewelry_tasks", "pending_rework_json", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "feedback_history_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "xhs_jewelry_tasks", "base_generation_provider", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "product_generation_provider", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "active_generation_provider", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "video_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "xhs_jewelry_tasks", "video_result_json", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "video_provider", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "video_model_key", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "video_aspect_ratio", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "video_duration_seconds", "INTEGER");
  db.prepare(`UPDATE xhs_jewelry_tasks
    SET status = ?, current_stage = 'video_generation',
      user_message = '历史成品图已采用。现在可以选择视频模型、画幅和时长生成短视频。',
      updated_at = ?
    WHERE status = ? AND video_result_json IS NULL AND final_result_json IS NOT NULL`)
    .run(XHS_JEWELRY_STATUSES.VIDEO_READY, now(), XHS_JEWELRY_STATUSES.COMPLETED);
  db.prepare(`UPDATE xhs_jewelry_tasks
    SET user_message = '历史成品图已采用。现在可以选择视频模型、画幅和时长生成短视频。',
      updated_at = ?
    WHERE status = ?
      AND user_message = '历史成品图已采用。现在可以选择视频通道生成 1 条 5 秒短视频。'`)
    .run(now(), XHS_JEWELRY_STATUSES.VIDEO_READY);
  ensureColumn(db, "xhs_jewelry_tasks", "person_strategy", "TEXT NOT NULL DEFAULT 'authorized_real_person'");
  ensureColumn(db, "xhs_jewelry_tasks", "browser_job_id", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "last_start_request_id", "TEXT");
  ensureColumn(db, "xhs_jewelry_tasks", "result_check_required", "INTEGER NOT NULL DEFAULT 0");
  recoverInterruptedXhsJewelryTasks(db);
}

export function createXhsJewelryTask(db, input) {
  const stamp = now();
  const id = input.id || randomUUID();
  const status = XHS_JEWELRY_STATUSES.READY;
  const stage = input.visualMode === "direct_product_edit" ? "product_replacement" : "visual_base";
  const message = input.visualMode === "direct_product_edit"
    ? "资料已保存在当前电脑。确认本次上传范围后，可以开始把珠宝换入现有人物图。"
    : "资料已保存在当前电脑。确认本次上传范围后，可以先生成 1 张人物种草图。";
  db.prepare(`INSERT INTO xhs_jewelry_tasks (
    id, title, visual_mode, target_slot, target_ratio, brief, status, current_stage,
    reference_image_paths_json, person_image_paths_json, product_image_paths_json, product_facts_json,
    person_authorization_confirmed, user_message, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      input.title,
      input.visualMode,
      input.targetSlot || "necklace",
      input.targetRatio || "follow_source",
      input.brief || "",
      status,
      stage,
      JSON.stringify(input.referenceImagePaths || []),
      JSON.stringify(input.personImagePaths || []),
      JSON.stringify(input.productImagePaths || []),
      JSON.stringify(input.productFacts || {}),
      input.personAuthorizationConfirmed ? 1 : 0,
      message,
      stamp,
      stamp,
    );
  const strategy = input.visualMode === "direct_product_edit" ? "existing_base" : input.personStrategy || "authorized_real_person";
  db.prepare("UPDATE xhs_jewelry_tasks SET person_strategy = ? WHERE id = ?").run(strategy, id);
  addXhsJewelryEvent(db, id, "task_created", "info", "珠宝种草图任务已建立，素材仅保存在当前电脑。", {
    visual_mode: input.visualMode,
    external_upload_started: false,
  });
  return getXhsJewelryTask(db, id);
}

export function listXhsJewelryTasks(db) {
  return db.prepare("SELECT * FROM xhs_jewelry_tasks ORDER BY updated_at DESC")
    .all()
    .map((row) => hydrateTask(db, row));
}

export function getXhsJewelryTask(db, id) {
  const row = db.prepare("SELECT * FROM xhs_jewelry_tasks WHERE id = ?").get(id);
  return row ? hydrateTask(db, row) : null;
}

export function xhsJewelryStageForStart(task) {
  return task?.current_stage === "product_replacement" ? "product_replacement" : "visual_base";
}

export function beginXhsJewelryStage(db, taskId, stage, { uploadAuthorized, generationProvider = "codex_builtin" }) {
  const task = requireTask(db, taskId);
  if (!uploadAuthorized) throw xhsError("XHS_JEWELRY_UPLOAD_AUTHORIZATION_REQUIRED");
  if (!["visual_base", "product_replacement"].includes(stage)) throw xhsError("XHS_JEWELRY_STAGE_INVALID");
  if (!["codex_builtin", "chatgpt_web"].includes(generationProvider)) throw xhsError("XHS_JEWELRY_GENERATION_PROVIDER_INVALID");
  if (task.active_run_id) throw xhsError("XHS_JEWELRY_STAGE_ALREADY_RUNNING");
  if (task.result_check_required) throw xhsError("XHS_JEWELRY_RESULT_CHECK_REQUIRED");

  const isBase = stage === "visual_base";
  if (isBase && task.visual_mode !== "rebuild_two_stage") throw xhsError("XHS_JEWELRY_BASE_ROUTE_UNAVAILABLE");
  const allowedStatuses = isBase
    ? [XHS_JEWELRY_STATUSES.READY, XHS_JEWELRY_STATUSES.BASE_FAILED]
    : task.visual_mode === "direct_product_edit"
      ? [XHS_JEWELRY_STATUSES.READY, XHS_JEWELRY_STATUSES.PRODUCT_FAILED]
      : [XHS_JEWELRY_STATUSES.BASE_REVIEW, XHS_JEWELRY_STATUSES.PRODUCT_FAILED];
  if (!allowedStatuses.includes(task.status)) throw xhsError("XHS_JEWELRY_STAGE_UNAVAILABLE");
  if (!isBase && task.visual_mode === "rebuild_two_stage" && task.base_result?.approval_status !== "approved") {
    throw xhsError("XHS_JEWELRY_BASE_APPROVAL_REQUIRED");
  }
  const attemptField = isBase ? "base_attempt_count" : "product_attempt_count";
  const providerField = isBase ? "base_generation_provider" : "product_generation_provider";
  const providerFailureManualRetry = isExplicitChatGptImageFailure(task.last_error);

  const runId = randomUUID();
  const stamp = now();
  const status = isBase ? XHS_JEWELRY_STATUSES.RUNNING_BASE : XHS_JEWELRY_STATUSES.RUNNING_PRODUCT;
  const message = providerFailureManualRetry
    ? `ChatGPT 上一次已明确报错，正在按你的操作手动重试 1 次${isBase ? "人物图" : "换品"}；系统仍不会后台自动重发。`
    : isBase
      ? task.pending_rework
        ? task.pending_rework.mode === "fresh_variant"
          ? "正在从正式人物依据重新生成 1 张新版本；不会继承上一张候选。"
          : "正在按你指出的问题定向重做人物种草图；只提交这 1 次，不会自动追加候选。"
        : "正在制作本次唯一一张人物种草图；不会自动追加候选或重试。"
      : task.pending_rework
        ? task.pending_rework.mode === "fresh_variant"
          ? "正在从已确认人物底片重新换入同一产品，生成 1 张全新版本。"
          : "正在回到已确认人物底片，按你指出的问题重新换入同一产品；不会继承上一张候选的画面变化。"
        : "正在把你的真实珠宝换入已确认画面；不会自动追加候选或重试。";
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = ?, external_upload_authorized = 1,
    ${attemptField} = ${attemptField} + 1,
    ${providerField} = ?, active_generation_provider = ?, browser_job_id = NULL, result_check_required = 0,
    active_stage = ?, active_run_id = ?, active_run_started_at = ?,
    active_external_request_started = 0, last_error = NULL, user_message = ?, updated_at = ?
    WHERE id = ?`)
    .run(status, stage, generationProvider, generationProvider, stage, runId, stamp, message, stamp, taskId);
  addXhsJewelryEvent(db, taskId, `${stage}_started`, "info", message, {
    run_id: runId,
    automatic_retry: false,
    provider_failure_manual_retry: providerFailureManualRetry,
    external_request_started: false,
    generation_provider: generationProvider,
  });
  return getXhsJewelryTask(db, taskId);
}

export function markXhsJewelryExternalRequestStarted(db, taskId, runId) {
  const changed = db.prepare(`UPDATE xhs_jewelry_tasks
    SET active_external_request_started = 1, updated_at = ?
    WHERE id = ? AND active_run_id = ? AND active_stage IS NOT NULL
      AND active_external_request_started = 0`)
    .run(now(), taskId, runId);
  if (changed.changes === 1) {
    const task = getXhsJewelryTask(db, taskId);
    const message = task?.active_stage === "video_generation"
      ? "本次视频生成请求已提交 1 次。"
      : "本次图片生成请求已提交 1 次。";
    addXhsJewelryEvent(db, taskId, "external_request_started", "info", message, {
      run_id: runId,
      automatic_retry: false,
    });
  }
  return changed.changes === 1;
}

export function finishXhsJewelryStage(db, taskId, stage, runId, result) {
  const task = requireActiveRun(db, taskId, stage, runId);
  const isBase = stage === "visual_base";
  const resultField = isBase ? "base_result_json" : "final_result_json";
  const status = isBase ? XHS_JEWELRY_STATUSES.BASE_REVIEW : XHS_JEWELRY_STATUSES.FINAL_REVIEW;
  const nextStage = isBase ? "base_review" : "final_review";
  const normalized = {
    ...result,
    approval_status: "needs_review",
    automatic_retry: false,
    applied_rework_contract: task.pending_rework || null,
  };
  const message = isBase
    ? "人物种草图已返回，并通过文件与任务技术检查。请放大确认人物、氛围和佩戴位置，满意后工作台再换入真实珠宝。"
    : "珠宝种草图已返回，并通过文件与任务技术检查。请对照产品图确认款式、比例、方向和佩戴是否自然。";
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = ?, active_stage = NULL, active_run_id = NULL,
    active_run_started_at = NULL, active_external_request_started = 0,
    active_generation_provider = NULL,
    ${resultField} = ?, pending_rework_json = NULL,
    last_error = NULL, user_message = ?, updated_at = ?
    WHERE id = ?`)
    .run(status, nextStage, JSON.stringify(normalized), message, now(), taskId);
  addXhsJewelryEvent(db, taskId, `${stage}_completed`, "info", message, {
    run_id: runId,
    external_request_started: Boolean(task.active_external_request_started || result.external_request_started),
  });
  return getXhsJewelryTask(db, taskId);
}

export function recoverXhsJewelryCompletedResult(db, taskId, stage, result) {
  const task = requireTask(db, taskId);
  const isBase = stage === "visual_base";
  const expectedStatus = isBase ? XHS_JEWELRY_STATUSES.BASE_FAILED : XHS_JEWELRY_STATUSES.PRODUCT_FAILED;
  if (task.status !== expectedStatus || task.current_stage !== stage || task.active_stage !== null) {
    throw xhsError("XHS_JEWELRY_RESULT_RECOVERY_UNAVAILABLE");
  }
  const resultField = isBase ? "base_result_json" : "final_result_json";
  const status = isBase ? XHS_JEWELRY_STATUSES.BASE_REVIEW : XHS_JEWELRY_STATUSES.FINAL_REVIEW;
  const nextStage = isBase ? "base_review" : "final_review";
  const normalized = {
    ...result,
    approval_status: "needs_review",
    automatic_retry: false,
  };
  const message = isBase
    ? "已恢复生成成功的人物种草图，并通过文件与任务技术检查。请放大确认后决定采用或返工。"
    : "已恢复生成成功的珠宝种草图，并通过文件与任务技术检查。请对照产品图确认后决定采用或返工。";
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = ?, active_stage = NULL, active_run_id = NULL,
    active_run_started_at = NULL, active_external_request_started = 0,
    active_generation_provider = NULL,
    ${resultField} = ?, result_check_required = 0, last_error = NULL, user_message = ?, updated_at = ?
    WHERE id = ?`)
    .run(status, nextStage, JSON.stringify(normalized), message, now(), taskId);
  addXhsJewelryEvent(db, taskId, `${stage}_completed`, "info", message, {
    recovered_from_successful_receipt: true,
    automatic_retry: false,
  });
  return getXhsJewelryTask(db, taskId);
}

export function failXhsJewelryStage(db, taskId, stage, runId, error) {
  const task = requireActiveRun(db, taskId, stage, runId);
  const isBase = stage === "visual_base";
  if (error?.code === "CHATGPT_FEEDBACK_CLARIFICATION_REQUIRED" && task.pending_rework) {
    const resultField = isBase ? "base_result_json" : "final_result_json";
    const previousResult = isBase ? task.base_result : task.final_result;
    const message = error.user_message || "需要补充修改说明。上一版仍保留，请在“填写问题”中补充。";
    db.prepare(`UPDATE xhs_jewelry_tasks SET status = ?, active_stage = NULL, active_run_id = NULL,
      active_run_started_at = NULL, active_external_request_started = 0, active_generation_provider = NULL,
      result_check_required = 0, last_error = ?, user_message = ?, ${resultField} = ?, updated_at = ? WHERE id = ?`)
      .run(isBase ? XHS_JEWELRY_STATUSES.BASE_REVIEW : XHS_JEWELRY_STATUSES.FINAL_REVIEW,
        error.code, message, JSON.stringify({ ...previousResult, user_message: message }), now(), taskId);
    addXhsJewelryEvent(db, taskId, "feedback_clarification_required", "info", message, {
      run_id: runId, external_request_started: true, automatic_retry: false, new_image_generated: false,
    });
    return getXhsJewelryTask(db, taskId);
  }
  const attemptField = isBase ? "base_attempt_count" : "product_attempt_count";
  const status = isBase ? XHS_JEWELRY_STATUSES.BASE_FAILED : XHS_JEWELRY_STATUSES.PRODUCT_FAILED;
  const requestStarted = task.active_external_request_started || error?.external_request_started === true || error?.result_check_required === true;
  const refundAttempt = !requestStarted || error?.attempt_refund === true;
  const errorCode = String(error?.code || error?.message || error).trim().split(/\s+/)[0];
  const needsCheck = error?.result_check_required === true
    || /SUBMISSION_UNKNOWN|RESULT_CHECK_REQUIRED/.test(errorCode)
    || (requestStarted && !error?.provider_failure && error?.attempt_refund !== true
      && !/CHATGPT_REWORK_RETURNED_REJECTED_IMAGE/.test(errorCode));
  const duplicateRejected = errorCode === "CHATGPT_REWORK_RETURNED_REJECTED_IMAGE";
  const message = needsCheck
    ? "原请求可能已经提交，结果尚待核实。请检查原任务；此时不会重新生成。"
    : error?.user_message
      ? error.user_message
      : duplicateRejected
    ? "ChatGPT 返回的仍是上一张被否决图片，工作台已拦截，没有把它当作新结果。请手动再次生成。"
    : refundAttempt
      ? error?.attempt_refund === true
        ? `ChatGPT 网页没有接收完整参考图，工作台已立即停止并退还本次次数，可以从当前步骤重新生成。`
        : `${isBase ? "人物种草图" : "珠宝替换"}在正式提交前停止，本次次数没有消耗，可以从当前步骤继续。`
      : `${isBase ? "人物种草图" : "珠宝替换"}没有完成。已有素材和上一步结果都已保留，系统不会自动重复提交。`;
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = ?, active_stage = NULL, active_run_id = NULL,
    active_run_started_at = NULL, active_external_request_started = 0,
    active_generation_provider = NULL,
    ${attemptField} = CASE WHEN ? = 1 THEN MAX(${attemptField} - 1, 0) ELSE ${attemptField} END,
    last_error = ?, user_message = ?, updated_at = ?
    WHERE id = ?`)
    .run(status, stage, refundAttempt ? 1 : 0, String(error?.message || error).slice(0, 2000), message, now(), taskId);
  db.prepare("UPDATE xhs_jewelry_tasks SET result_check_required = ? WHERE id = ?").run(needsCheck ? 1 : 0, taskId);
  addXhsJewelryEvent(db, taskId, `${stage}_failed`, requestStarted ? "error" : "warning", message, {
    run_id: runId,
    external_request_started: Boolean(requestStarted),
    attempt_refunded: refundAttempt,
    automatic_retry: false,
    error_code: errorCode,
    result_check_required: needsCheck,
    browser_job_id: task.browser_job_id,
  });
  return getXhsJewelryTask(db, taskId);
}

export function canRetryFailedXhsJewelryStage(task) {
  if (task?.result_check_required || /SUBMISSION_UNKNOWN|RESULT_CHECK_REQUIRED/.test(task?.last_error || "")) return false;
  if (![XHS_JEWELRY_STATUSES.BASE_FAILED, XHS_JEWELRY_STATUSES.PRODUCT_FAILED].includes(task?.status)) return false;
  return true;
}

export function approveXhsJewelryBase(db, taskId) {
  const task = requireTask(db, taskId);
  if (task.status !== XHS_JEWELRY_STATUSES.BASE_REVIEW || !task.base_result) {
    throw xhsError("XHS_JEWELRY_BASE_APPROVAL_UNAVAILABLE");
  }
  const approved = { ...task.base_result, approval_status: "approved", approved_at: now() };
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    base_result_json = ?, current_stage = 'product_replacement',
    user_message = ?, updated_at = ? WHERE id = ?`)
    .run(
      JSON.stringify(approved),
      "人物种草图已确认。工作台将按原授权范围自动开始换入真实珠宝。",
      now(),
      taskId,
    );
  addXhsJewelryEvent(db, taskId, "base_approved", "info", "人物种草图已确认，可以进入珠宝替换。", {});
  return getXhsJewelryTask(db, taskId);
}

export function approveXhsJewelryFinal(db, taskId) {
  const task = requireTask(db, taskId);
  if (task.status !== XHS_JEWELRY_STATUSES.FINAL_REVIEW || !task.final_result) {
    throw xhsError("XHS_JEWELRY_FINAL_APPROVAL_UNAVAILABLE");
  }
  const approved = { ...task.final_result, approval_status: "approved", approved_at: now() };
  const message = "这张珠宝种草图已采用。下一步请选择视频模型、画幅和时长，再生成自然动态短视频。";
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = 'video_generation', final_result_json = ?,
    user_message = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
    .run(XHS_JEWELRY_STATUSES.VIDEO_READY, JSON.stringify(approved), message, now(), taskId);
  addXhsJewelryEvent(db, taskId, "final_approved", "info", message, { next_stage: "video_generation" });
  return getXhsJewelryTask(db, taskId);
}

export function beginXhsJewelryVideo(db, taskId, { provider, modelKey, aspectRatio, durationSeconds, uploadAuthorized, feeConfirmed }) {
  const task = requireTask(db, taskId);
  if (![XHS_JEWELRY_STATUSES.VIDEO_READY, XHS_JEWELRY_STATUSES.VIDEO_FAILED].includes(task.status)) {
    throw xhsError("XHS_JEWELRY_VIDEO_UNAVAILABLE");
  }
  if (task.final_result?.approval_status !== "approved") throw xhsError("XHS_JEWELRY_FINAL_APPROVAL_REQUIRED");
  if (!uploadAuthorized || !feeConfirmed) throw xhsError("XHS_JEWELRY_VIDEO_CONFIRMATION_REQUIRED");
  if (!["libtv", "runninghub_h3_multiref"].includes(provider)) throw xhsError("XHS_JEWELRY_VIDEO_PROVIDER_INVALID");
  const selectedModelKey = provider === "libtv" ? (modelKey || "star-video2-fast") : "minimax-h3-multiref-owned-clean";
  if (provider === "libtv" && !["star-video2.5", "star-video2", "star-video2-fast"].includes(selectedModelKey)) {
    throw xhsError("XHS_JEWELRY_VIDEO_MODEL_INVALID");
  }
  const allowedAspectRatios = ["3:4", "4:3", "9:16", "16:9"];
  if (!allowedAspectRatios.includes(aspectRatio)) throw xhsError("XHS_JEWELRY_VIDEO_ASPECT_RATIO_REQUIRED");
  const normalizedDuration = Number(durationSeconds);
  if (!Number.isInteger(normalizedDuration) || normalizedDuration < 4 || normalizedDuration > 15) {
    throw xhsError("XHS_JEWELRY_VIDEO_DURATION_INVALID");
  }
  if (task.active_run_id) throw xhsError("XHS_JEWELRY_STAGE_ALREADY_RUNNING");
  const runId = randomUUID();
  const stamp = now();
  const modelLabel = provider === "libtv"
    ? ({ "star-video2.5": "Seedance 2.5", "star-video2": "Seedance 2.0", "star-video2-fast": "Seedance 2.0 Fast" })[selectedModelKey]
    : "MiniMax H3";
  const message = `正在用 ${modelLabel} 生成 ${aspectRatio}、${normalizedDuration} 秒自然动态短视频；只提交 1 次，不会自动重试或换模型。`;
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = 'video_generation', video_attempt_count = video_attempt_count + 1,
    video_provider = ?, video_model_key = ?, video_aspect_ratio = ?, video_duration_seconds = ?,
    active_stage = 'video_generation', active_run_id = ?, active_run_started_at = ?,
    active_external_request_started = 0, last_error = NULL, user_message = ?, updated_at = ?
    WHERE id = ?`)
    .run(XHS_JEWELRY_STATUSES.RUNNING_VIDEO, provider, selectedModelKey, aspectRatio, normalizedDuration, runId, stamp, message, stamp, taskId);
  addXhsJewelryEvent(db, taskId, "video_generation_started", "info", message, {
    run_id: runId,
    provider,
    model_key: selectedModelKey,
    aspect_ratio: aspectRatio,
    duration_seconds: normalizedDuration,
    generation_count: 1,
    automatic_retry: false,
  });
  return getXhsJewelryTask(db, taskId);
}

export function finishXhsJewelryVideo(db, taskId, runId, result) {
  const task = requireActiveRun(db, taskId, "video_generation", runId);
  const normalized = {
    ...result,
    approval_status: "needs_review",
    automatic_retry: false,
    applied_rework_contract: task.pending_rework || null,
  };
  const message = `${result.aspect_ratio || task.video_aspect_ratio}、${result.duration_seconds || task.video_duration_seconds} 秒短视频已经返回。请检查人物、产品结构和动态是否自然，再决定采用或手动返工。`;
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = 'video_review', active_stage = NULL, active_run_id = NULL,
    active_run_started_at = NULL, active_external_request_started = 0,
    video_result_json = ?, pending_rework_json = NULL,
    last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?`)
    .run(XHS_JEWELRY_STATUSES.VIDEO_REVIEW, JSON.stringify(normalized), message, now(), taskId);
  addXhsJewelryEvent(db, taskId, "video_generation_completed", "info", message, {
    provider: result.provider,
    external_request_started: result.external_request_started === true,
  });
  return getXhsJewelryTask(db, taskId);
}

export function failXhsJewelryVideo(db, taskId, runId, error) {
  const task = requireActiveRun(db, taskId, "video_generation", runId);
  const requestStarted = task.active_external_request_started || error?.external_request_started === true;
  const message = requestStarted
    ? "短视频没有完成。成品图仍已保留，系统不会自动重试；你可以检查后手动再提交 1 次。"
    : "短视频在正式提交前停止，本次次数已退还，没有产生视频生成费用。";
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = 'video_generation', active_stage = NULL, active_run_id = NULL,
    active_run_started_at = NULL, active_external_request_started = 0,
    video_attempt_count = CASE WHEN ? = 1 THEN MAX(video_attempt_count - 1, 0) ELSE video_attempt_count END,
    last_error = ?, user_message = ?, updated_at = ? WHERE id = ?`)
    .run(XHS_JEWELRY_STATUSES.VIDEO_FAILED, requestStarted ? 0 : 1, String(error?.message || error).slice(0, 2000), message, now(), taskId);
  addXhsJewelryEvent(db, taskId, "video_generation_failed", requestStarted ? "error" : "warning", message, {
    run_id: runId,
    external_request_started: Boolean(requestStarted),
    attempt_refunded: !requestStarted,
    automatic_retry: false,
  });
  return getXhsJewelryTask(db, taskId);
}

export function approveXhsJewelryVideo(db, taskId) {
  const task = requireTask(db, taskId);
  if (task.status !== XHS_JEWELRY_STATUSES.VIDEO_REVIEW || !task.video_result) {
    throw xhsError("XHS_JEWELRY_VIDEO_APPROVAL_UNAVAILABLE");
  }
  const approved = { ...task.video_result, approval_status: "approved", approved_at: now() };
  const message = "短视频已采用，已完成本次珠宝种草图片与视频制作。";
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = 'completed', video_result_json = ?,
    user_message = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
    .run(XHS_JEWELRY_STATUSES.COMPLETED, JSON.stringify(approved), message, now(), taskId);
  addXhsJewelryEvent(db, taskId, "video_approved", "info", message, { deliverable: "mp4_video" });
  return getXhsJewelryTask(db, taskId);
}

export function requestXhsJewelryRework(db, taskId, { issueCodes, userText, reworkMode = "targeted_refine" }) {
  const task = requireTask(db, taskId);
  const isBase = task.status === XHS_JEWELRY_STATUSES.BASE_REVIEW;
  const isFinal = task.status === XHS_JEWELRY_STATUSES.FINAL_REVIEW;
  const isVideo = task.status === XHS_JEWELRY_STATUSES.VIDEO_REVIEW;
  if (!isBase && !isFinal && !isVideo) throw xhsError("XHS_JEWELRY_REWORK_UNAVAILABLE");
  const stage = isBase ? "visual_base" : isFinal ? "product_replacement" : "video_generation";
  const normalizedCodes = [...new Set((Array.isArray(issueCodes) ? issueCodes : [])
    .map((value) => String(value || "").trim())
    .map((value) => isBase && task.person_strategy === "partial_body" && value === "person_identity" ? "body_appearance" : value)
    .filter(Boolean))].slice(0, 8);
  const answer = String(userText || "").trim().slice(0, 1000);
  const clarifying = task.last_error === "CHATGPT_FEEDBACK_CLARIFICATION_REQUIRED";
  const normalizedText = clarifying && answer
    ? `${task.pending_rework?.user_observation || ""}\n补充说明：${answer}`.trim()
    : answer;
  if (clarifying) {
    for (const code of task.pending_rework?.issue_codes || []) {
      if (!normalizedCodes.includes(code)) normalizedCodes.push(code);
    }
  }
  const mode = reworkMode === "fresh_variant" && !isVideo ? "fresh_variant" : "targeted_refine";
  if (mode === "targeted_refine" && normalizedCodes.length === 0 && !normalizedText) {
    throw xhsError("XHS_JEWELRY_FEEDBACK_REQUIRED");
  }
  const stamp = now();
  const feedbackId = randomUUID();
  const rejectedResult = isBase ? task.base_result : isFinal ? task.final_result : task.video_result;
  const contract = buildReworkContract({
    feedbackId,
    stage,
    productCategory: inferProductCategory(task.target_slot),
    partialBody: task.person_strategy === "partial_body",
    issueCodes: normalizedCodes,
    userText: normalizedText,
    mode,
    rejectedResult,
    createdAt: stamp,
  });
  const feedbackHistory = [...task.feedback_history, contract];
  const resultField = isBase ? "base_result_json" : isFinal ? "final_result_json" : "video_result_json";
  const nextStatus = isBase
    ? XHS_JEWELRY_STATUSES.BASE_FAILED
    : isFinal
      ? XHS_JEWELRY_STATUSES.PRODUCT_FAILED
      : XHS_JEWELRY_STATUSES.VIDEO_FAILED;
  const rejected = {
    ...(rejectedResult || {}),
    approval_status: "rejected",
    rejected_at: stamp,
    user_feedback: contract,
  };
  const message = mode === "fresh_variant"
    ? isBase
      ? "已保留上一张候选，准备从正式人物依据重新生成 1 张新版本。"
      : "已保留上一张候选，准备从已确认人物底片和同一产品资产包重新生成 1 张新版本。"
    : isBase
      ? "问题已记录并编译成定向返工要求，准备重新生成 1 张人物底片。"
      : isFinal
        ? "问题已记录并编译成产品修正要求，准备做 1 次整图生成式定向修正。"
      : "视频问题已记录并编译成定向返工要求。确认模型和费用后，可沿用已确认成品图手动重试 1 条。";
  db.prepare(`UPDATE xhs_jewelry_tasks SET
    status = ?, current_stage = ?, ${resultField} = ?,
    pending_rework_json = ?, feedback_history_json = ?,
    user_message = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
    .run(
      nextStatus,
      stage,
      JSON.stringify(rejected),
      JSON.stringify(contract),
      JSON.stringify(feedbackHistory),
      message,
      stamp,
      taskId,
    );
  addXhsJewelryEvent(db, taskId, `${stage}_rework_requested`, "info", message, {
    feedback_id: feedbackId,
    issue_codes: normalizedCodes,
    rework_mode: mode,
    user_initiated: true,
    automatic_retry: false,
  });
  return getXhsJewelryTask(db, taskId);
}

export function updateXhsJewelryProgress(db, taskId, stage, runId, message) {
  const changed = db.prepare(`UPDATE xhs_jewelry_tasks SET user_message = ?, updated_at = ?
    WHERE id = ? AND active_stage = ? AND active_run_id = ?`)
    .run(String(message || "").slice(0, 300), now(), taskId, stage, runId);
  return changed.changes === 1;
}

function recoverInterruptedXhsJewelryTasks(db) {
  const rows = db.prepare(`SELECT * FROM xhs_jewelry_tasks
    WHERE status IN (?, ?, ?)`)
    .all(XHS_JEWELRY_STATUSES.RUNNING_BASE, XHS_JEWELRY_STATUSES.RUNNING_PRODUCT, XHS_JEWELRY_STATUSES.RUNNING_VIDEO);
  for (const row of rows) {
    const task = hydrateRow(row);
    if (task.active_stage === "video_generation") {
      const refundAttempt = !task.active_external_request_started;
      const message = refundAttempt
        ? "工作台重启时短视频尚未正式提交，本次次数已退还。"
        : "工作台重启中断了视频结果等待；成品图仍保留，系统没有自动重复提交。";
      db.prepare(`UPDATE xhs_jewelry_tasks SET
        status = ?, current_stage = 'video_generation', active_stage = NULL, active_run_id = NULL,
        active_run_started_at = NULL, active_external_request_started = 0,
        video_attempt_count = CASE WHEN ? = 1 THEN MAX(video_attempt_count - 1, 0) ELSE video_attempt_count END,
        user_message = ?, updated_at = ? WHERE id = ?`)
        .run(XHS_JEWELRY_STATUSES.VIDEO_FAILED, refundAttempt ? 1 : 0, message, now(), task.id);
      addXhsJewelryEvent(db, task.id, "runtime_recovered", "warning", message, {
        invalidated_run_id: task.active_run_id,
        external_request_started: task.active_external_request_started,
        attempt_refunded: refundAttempt,
        automatic_retry: false,
      });
      continue;
    }
    const isBase = task.active_stage === "visual_base";
    const attemptField = isBase ? "base_attempt_count" : "product_attempt_count";
    const status = isBase ? XHS_JEWELRY_STATUSES.BASE_FAILED : XHS_JEWELRY_STATUSES.PRODUCT_FAILED;
    const uncertainBrowserJob = Boolean(task.browser_job_id);
    const refundAttempt = !task.active_external_request_started && !uncertainBrowserJob;
    const message = refundAttempt
      ? "后台任务在正式提交前中断，本次次数已经退还，可以从当前步骤继续。"
      : "后台结果等待被中断；已有素材和上一步结果保留，系统没有自动重复提交。";
    db.prepare(`UPDATE xhs_jewelry_tasks SET
      status = ?, current_stage = ?, active_stage = NULL, active_run_id = NULL,
      active_run_started_at = NULL, active_external_request_started = 0,
      active_generation_provider = NULL,
      ${attemptField} = CASE WHEN ? = 1 THEN MAX(${attemptField} - 1, 0) ELSE ${attemptField} END,
      user_message = ?, updated_at = ? WHERE id = ?`)
      .run(status, isBase ? "visual_base" : "product_replacement", refundAttempt ? 1 : 0, message, now(), task.id);
    db.prepare("UPDATE xhs_jewelry_tasks SET result_check_required = ? WHERE id = ?")
      .run(refundAttempt ? 0 : 1, task.id);
    addXhsJewelryEvent(db, task.id, "runtime_recovered", "warning", message, {
      invalidated_run_id: task.active_run_id,
      external_request_started: task.active_external_request_started,
      attempt_refunded: refundAttempt,
      automatic_retry: false,
    });
  }
}

export function bindXhsJewelryBrowserJob(db, taskId, stage, runId, jobId) {
  requireActiveRun(db, taskId, stage, runId);
  db.prepare("UPDATE xhs_jewelry_tasks SET browser_job_id = ? WHERE id = ?").run(jobId, taskId);
}

export function setXhsJewelryResultCheck(db, taskId, required, message) {
  const task = requireTask(db, taskId);
  if (!["base_failed", "product_failed"].includes(task.status)) throw xhsError("XHS_JEWELRY_RESULT_RECOVERY_UNAVAILABLE");
  db.prepare("UPDATE xhs_jewelry_tasks SET result_check_required = ?, last_error = CASE WHEN ? = 0 THEN NULL ELSE last_error END, user_message = ?, updated_at = ? WHERE id = ?")
    .run(required ? 1 : 0, required ? 1 : 0, message, now(), taskId);
  return getXhsJewelryTask(db, taskId);
}

function addXhsJewelryEvent(db, taskId, eventType, level, message, details) {
  db.prepare(`INSERT INTO xhs_jewelry_events
    (task_id, event_type, level, message, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(taskId, eventType, level, message, JSON.stringify(details || {}), now());
}

function requireTask(db, id) {
  const task = getXhsJewelryTask(db, id);
  if (!task) throw xhsError("XHS_JEWELRY_TASK_NOT_FOUND");
  return task;
}

function requireActiveRun(db, id, stage, runId) {
  const task = requireTask(db, id);
  if (task.active_stage !== stage || task.active_run_id !== runId) {
    throw xhsError("XHS_JEWELRY_STALE_RUN");
  }
  return task;
}

function hydrateTask(db, row) {
  const task = hydrateRow(row);
  task.events = db.prepare("SELECT * FROM xhs_jewelry_events WHERE task_id = ? ORDER BY id DESC LIMIT 50")
    .all(row.id)
    .map((event) => ({ ...event, details: safeJson(event.details_json, {}) }));
  return task;
}

function hydrateRow(row) {
  return {
    ...row,
    reference_image_paths: safeJson(row.reference_image_paths_json, []),
    person_image_paths: safeJson(row.person_image_paths_json, []),
    product_image_paths: safeJson(row.product_image_paths_json, []),
    product_facts: safeJson(row.product_facts_json, {}),
    person_authorization_confirmed: Boolean(row.person_authorization_confirmed),
    result_check_required: Boolean(row.result_check_required),
    external_upload_authorized: Boolean(row.external_upload_authorized),
    active_external_request_started: Boolean(row.active_external_request_started),
    base_result: safeJson(row.base_result_json, null),
    final_result: safeJson(row.final_result_json, null),
    video_result: safeJson(row.video_result_json, null),
    pending_rework: normalizeReworkContract(safeJson(row.pending_rework_json, null), inferProductCategory(row.target_slot)),
    feedback_history: safeJson(row.feedback_history_json, []),
  };
}

function normalizeReworkContract(contract, productCategory = null) {
  if (!contract || contract.stage !== "product_replacement") return contract;
  const category = contract.product_category || productCategory || "jewelry";
  const categoryIssues = productReworkIssues(category);
  const inheritedDiagnosis = contract.feedback_interpretation?.compiler === "deterministic_feedback_compiler_v1"
    ? {} : (contract.diagnosis || {});
  const diagnoses = (contract.issue_codes || []).map((code) => categoryIssues[code]).filter(Boolean);
  const feedbackInterpretation = compileXhsJewelryFeedbackObservation({
    stage: contract.stage,
    productCategory: category,
    userText: contract.user_observation,
  });
  return {
    ...contract,
    product_category: category,
    diagnosis: {
      ...inheritedDiagnosis,
      required_repairs: uniqueStrings([
        ...(diagnoses.map((item) => item.repair)),
        ...(inheritedDiagnosis?.required_repairs || []),
        ...feedbackInterpretation.required_repairs,
      ]),
      mandatory_checks: uniqueStrings([
        ...(diagnoses.map((item) => item.check)),
        ...(inheritedDiagnosis?.mandatory_checks || []),
        ...feedbackInterpretation.mandatory_checks,
      ]),
      allowed_natural_loss: uniqueStrings([
        ...(inheritedDiagnosis?.allowed_natural_loss || []),
        ...feedbackInterpretation.allowed_natural_loss,
      ]),
      forbidden_overcorrection: uniqueStrings([
        ...(inheritedDiagnosis?.forbidden_overcorrection || []),
        ...feedbackInterpretation.forbidden_overcorrection,
      ]),
      preserve_requirements: uniqueStrings([
        ...(inheritedDiagnosis?.preserve_requirements || []),
        ...feedbackInterpretation.preserve_requirements,
      ]),
      repair_scope: contract.mode === "fresh_variant"
        ? "regenerate_fresh_product_variant_from_approved_base_and_same_product_pack"
        : "regenerate_product_from_approved_base_with_targeted_corrections",
      preserve_contract: contract.mode === "fresh_variant"
        ? "上一张候选只留作历史记录，不作为新图底图；重新使用已确认人物底片和同一产品资产包。"
        : "重新使用已确认人物底片和同一产品资产包；上一张被否决候选只用于诊断用户指出的问题，不作为本次生成底图或画面身份来源。",
    },
    feedback_interpretation: feedbackInterpretation,
    rejected_candidate: contract.rejected_candidate ? {
      ...contract.rejected_candidate,
      use: "diagnostic_only_do_not_use_as_generation_identity_reference",
    } : null,
  };
}

function buildReworkContract({ feedbackId, partialBody = false, stage, productCategory = "jewelry", issueCodes, userText, mode, rejectedResult, createdAt }) {
  const isBase = stage === "visual_base";
  const isVideo = stage === "video_generation";
  const issueMap = isBase ? BASE_REWORK_ISSUES : isVideo ? VIDEO_REWORK_ISSUES : productReworkIssues(productCategory);
  const diagnoses = issueCodes.map((code) => issueMap[code]).filter(Boolean);
  const feedbackInterpretation = compileXhsJewelryFeedbackObservation({ stage, productCategory, userText });
  return {
    schema_version: 1,
    feedback_id: feedbackId,
    stage,
    product_category: isBase || isVideo ? null : productCategory,
    mode,
    issue_codes: issueCodes,
    user_observation: userText || null,
    diagnosis: {
      repair_scope: mode === "fresh_variant"
        ? isBase
          ? "regenerate_fresh_visual_base_from_formal_identity_sources"
          : "regenerate_fresh_product_variant_from_approved_base_and_same_product_pack"
        : isBase
          ? "regenerate_visual_base_with_targeted_corrections"
        : isVideo
          ? "regenerate_video_from_approved_first_frame_with_targeted_corrections"
          : "regenerate_product_from_approved_base_with_targeted_corrections",
      required_repairs: uniqueStrings([...diagnoses.map((item) => item.repair), ...feedbackInterpretation.required_repairs]),
      mandatory_checks: uniqueStrings([...diagnoses.map((item) => item.check), ...feedbackInterpretation.mandatory_checks]),
      allowed_natural_loss: feedbackInterpretation.allowed_natural_loss,
      forbidden_overcorrection: feedbackInterpretation.forbidden_overcorrection,
      preserve_requirements: feedbackInterpretation.preserve_requirements,
      preserve_contract: isBase && partialBody
        ? "保持不露脸和参考局部构图；可选局部参考仅约束肤色、手型或体态，不建立人脸身份、不补全脸或全身。上一张被否决候选仅供诊断；保留未被指出的问题区域。"
        : mode === "fresh_variant"
        ? isBase
          ? "上一张候选只留作历史记录，不作为新图身份或构图来源；重新使用正式人物与参考画面。"
          : "上一张候选只留作历史记录，不作为新图底图；重新使用已确认人物底片和同一产品资产包。"
        : isBase
        ? "人物身份仍只来自授权人物图；保留已通过或未被用户指出的问题区域，不继承被否决候选的错误。"
        : isVideo
          ? "已确认成品图是唯一首帧身份来源；完整保留中央构图、人物和珠宝，不把被否决视频作为身份参考。"
          : "重新使用已确认人物底片和同一产品资产包；上一张被否决候选只用于诊断用户指出的问题，不作为本次生成底图或画面身份来源。",
      no_mirror_product_identity: isVideo
        ? issueCodes.includes("product_drift")
        : !isBase && issueCodes.includes("product_orientation"),
      return_to_stage1: false,
    },
    feedback_interpretation: feedbackInterpretation,
    rejected_candidate: rejectedResult?.image || rejectedResult?.video ? {
      path: rejectedResult.image?.path || rejectedResult.video?.path,
      sha256: rejectedResult.image?.sha256 || rejectedResult.video?.sha256 || null,
      use: "diagnostic_only_do_not_use_as_generation_identity_reference",
    } : null,
    created_at: createdAt,
  };
}

const BASE_REWORK_ISSUES = Object.freeze({
  body_appearance: { repair: "纠正可见皮肤、手型和局部体态；有指定局部参考时按其核对，不引入人脸。", check: "核对可见局部自然度与用户指定的局部特征。" },
  unwanted_face: { repair: "恢复参考的局部裁切，去掉意外补全的人脸或全身。", check: "确认画面保持不露脸，产品展示位置可用。" },
  person_identity: { repair: "加强授权人物身份锁定，纠正脸型、五官或年龄漂移。", check: "与授权人物图核对人物身份。" },
  pose_hands: { repair: "纠正姿态、手势或手机遮挡关系，保持参考视觉机制而不继承原人物身份。", check: "核对头肩手几何和遮挡。" },
  composition: { repair: "纠正景别、裁切、主体位置和镜像自拍关系。", check: "核对构图与镜头方向。" },
  lighting_realism: { repair: "纠正过度棚拍、美颜或曝光平衡，恢复参考画面的真实现场成像。", check: "核对光源、色温、黑位、肤色亮度和局部失控。" },
  jewelry_slot: { repair: "重建自然可用的珠宝佩戴槽位、尺度空间、遮挡和接触条件。", check: "核对目标槽位是否能承载真实产品。" },
  ai_artifacts: { repair: "清除明显 AI 痕迹、畸形和不自然补全，同时保持真实瑕疵。", check: "检查手、皮肤、头发、背景物体和边缘。" },
  other: { repair: "根据用户文字定位并修正明确问题。", check: "逐项核对用户文字。" },
});

const PRODUCT_REWORK_ISSUES = Object.freeze({
  product_detail_visibility: {
    repair: "保持真实佩戴比例和当前景别，只纠正最终展示尺寸下可见的产品身份：外轮廓、正面方向、主浮雕或主纹理、连接结构；不要凭空补全不可见微细节。",
    check: "按最终展示尺寸核对：允许景深、压缩和产品占比造成自然细节损失，但可见主结构不能变成无关图案、镜像或相似款。",
  },
  product_orientation: { repair: "以产品正面身份图为最高证据，纠正浮雕、文字、纹理和标志结构的左右方向；禁止镜像、翻面或重构。", check: "核对正面图案手性、左右关系和朝向。" },
  product_structure: { repair: "纠正轮廓、主结构、组件数量、吊环和连接拓扑。", check: "核对 Tier 1 产品身份结构。" },
  scale_position: { repair: "纠正产品相对人体的真实尺度、中心位置、链长和垂坠。", check: "以颈宽、锁骨和佩戴图核对比例。" },
  physical_integration: { repair: "纠正漂浮、贴图感、接触阴影、遮挡、透视和重力关系。", check: "放大检查产品与皮肤、衣物或头发的接触。" },
  base_changed: { repair: "恢复并锁定人物脸、发型、姿态、手、衣服、构图、光线和背景，只允许产品极小区域变化。", check: "遮住产品后与已通过底片逐项对照。" },
  lighting_realism: { repair: "让产品锐度、景深、噪声、压缩、金属反射和高光完全服从底片。", check: "核对产品是否异常高清或拥有独立棚灯。" },
  other: { repair: "根据用户文字定位并修正明确问题。", check: "逐项核对用户文字。" },
});

const RING_REWORK_ISSUES = Object.freeze({
  ...PRODUCT_REWORK_ISSUES,
  product_structure: {
    repair: "纠正闭合戒圈轮廓、戒身主结构、重复节点或双色层级及其连接拓扑。",
    check: "以戒指结构板和原始产品图核对戒圈、节点、双色层级与连续连接。",
  },
  scale_position: {
    repair: "纠正戒指所戴手指、指节位置、真实圈宽与厚度，并让戒圈按该手指截面自然环绕。",
    check: "以指定手指、指节、手指截面和佩戴图核对位置与比例，禁止套到相邻手指。",
  },
});

function productReworkIssues(category) {
  return category === "ring" ? RING_REWORK_ISSUES : PRODUCT_REWORK_ISSUES;
}

function inferProductCategory(targetSlot) {
  const slot = String(targetSlot || "").toLowerCase();
  if (slot === "ring" || slot.includes("戒指") || slot.includes("指环")) return "ring";
  if (slot === "necklace" || slot === "pendant" || slot.includes("项链") || slot.includes("吊坠")) return "necklace";
  if (slot === "earring" || slot.includes("耳")) return "earring";
  if (slot === "bracelet" || slot === "bangle" || slot.includes("手链") || slot.includes("手镯")) return "bracelet";
  return "jewelry";
}

// This is an execution context, not a deterministic diagnosis of free text.
// Semantic interpretation belongs to the existing model that sees the images.
export function compileXhsJewelryFeedbackObservation({ stage, productCategory = "jewelry", userText }) {
  const text = String(userText || "").trim();
  const isProduct = stage === "product_replacement";
  return {
    compiler: "model_feedback_context_v2",
    interpretation_status: text ? "pending_execution_model" : "not_requested",
    interpretation_owner: "selected_generation_executor",
    user_text: text,
    product_category: isProduct ? productCategory : null,
    uncertainty_detected: null,
    observed_concerns: [],
    required_repairs: text ? ["结合用户完整原话、当前候选和正式参考理解本次修改意图，区分要修改的内容、明确保留的内容与询问；逐项处理，不限于预设问题分类。"] : [],
    mandatory_checks: text ? ["生成前先对照当前候选与正式参考，定位反馈对应区域、可核实的问题和修正目标；口语措辞本身不代表用户不确定。没有图像证据时不得声称已经看见问题。"] : [],
    allowed_natural_loss: isProduct ? ["按当前景别、景深和成像质量判断可见细节；微小且不可分辨的细节允许自然损失，不要求强行补全。"] : [],
    forbidden_overcorrection: text ? ["不擅自补充用户未指定的修改方向，不把否定或保留要求反向执行；不得为了修正局部而放大产品、改变比例或虚构细节。证据不足或存在相反的合理解释时不猜测大改。"] : [],
    preserve_requirements: text ? ["保留未被要求修改的内容，并遵守原项目的人物、产品身份、构图及授权边界；当前候选仅用于诊断，不继承其中错误。"] : [],
  };
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

const VIDEO_REWORK_ISSUES = Object.freeze({
  video_composition: { repair: "按用户明确选择的视频画幅完整保留首帧人物、手机、双手、上半身和珠宝，不得擅自改成其他比例或放大裁切。", check: "核对成片宽高比与本轮结构化画幅参数完全一致，并逐帧检查主体完整性。" },
  product_drift: { repair: "锁定珠宝浮雕方向、连接结构、比例和佩戴位置，禁止镜像、翻面、融化或漂移。", check: "逐帧核对珠宝正面手性与结构连续性。" },
  person_drift: { repair: "锁定人物脸、手、发型、衣服和身体结构，只保留微小自然动作。", check: "抽帧检查脸、手和衣物边缘。" },
  motion_artifacts: { repair: "降低动作幅度和镜头漂移，消除闪烁、背景跳变和异常补全。", check: "检查首中尾帧及运动峰值帧。" },
  audio_unwanted: { repair: "成片必须静音，不保留模型生成的音轨。", check: "检查最终文件不存在音频流。" },
  other: { repair: "根据用户文字定位并修正明确的视频问题。", check: "逐项核对用户文字。" },
});

function safeJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function xhsError(code) {
  const error = new Error(code);
  error.code = code;
  error.external_request_started = false;
  return error;
}

function isExplicitChatGptImageFailure(value) {
  return /ChatGPT 已明确返回图片生成失败|Something went wrong while generating your image/i.test(String(value || ""));
}
