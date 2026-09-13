import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { projectUserState } from "./task-user-state.mjs";

export const STATUSES = Object.freeze({
  DRAFT: "draft",
  READY: "ready",
  RUNNING_DECOMPOSITION: "running_decomposition",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  RUNNING_REWRITE: "running_rewrite",
  PERSON_INPUTS_READY: "person_inputs_ready",
  RUNNING_PERSON_GENERATION: "running_person_generation",
  PERSON_REVIEW: "person_review",
  PERSON_APPROVED: "person_approved",
  RUNNING_PRODUCT_ASSETS: "running_product_assets",
  PRODUCT_ASSETS_REVIEW: "product_assets_review",
  PRODUCT_ASSETS_BLOCKED: "product_assets_blocked",
  STORYBOARD_INPUTS_READY: "storyboard_inputs_ready",
  RUNNING_STORYBOARD_GENERATION: "running_storyboard_generation",
  STORYBOARD_REVIEW: "storyboard_review",
  STORYBOARD_APPROVED: "storyboard_approved",
  STORYBOARD_GENERATION_FAILED: "storyboard_generation_failed",
  RUNNING_MOTION_PREFLIGHT: "running_motion_preflight",
  MOTION_PREFLIGHT_READY: "motion_preflight_ready",
  MOTION_PREFLIGHT_BLOCKED: "motion_preflight_blocked",
  RUNNING_VIDEO_PROMPT: "running_video_prompt",
  VIDEO_PROMPT_READY: "video_prompt_ready",
  VIDEO_PROMPT_BLOCKED: "video_prompt_blocked",
  PERSON_PACKAGE_REQUIRED: "person_package_required",
  RUNNING_PERSON_PACKAGE: "running_person_package",
  PERSON_PACKAGE_REVIEW: "person_package_review",
  PERSON_PACKAGE_FAILED: "person_package_failed",
  RUNNING_GENERATION_PACK: "running_generation_pack",
  GENERATION_PACK_READY: "generation_pack_ready",
  GENERATION_PACK_BLOCKED: "generation_pack_blocked",
  RUNNING_VIDEO_GENERATION: "running_video_generation",
  VIDEO_GENERATION_COMPLETED: "video_generation_completed",
  VIDEO_GENERATION_FAILED: "video_generation_failed",
  PERSON_GENERATION_FAILED: "person_generation_failed",
  COMPLETED: "completed",
  INTERRUPTED: "interrupted",
  FAILED: "failed",
  BLOCKED_CONFIGURATION: "blocked_configuration",
  BLOCKED_RUNTIME: "blocked_runtime",
  BLOCKED_DIAGNOSTIC: "blocked_diagnostic",
});

const now = () => new Date().toISOString();

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workflow TEXT NOT NULL DEFAULT 'video_decompose_to_product_rewrite',
      status TEXT NOT NULL,
      current_step TEXT NOT NULL,
      reference_video_path TEXT NOT NULL,
      product_brief TEXT NOT NULL DEFAULT '',
      product_scope TEXT NOT NULL DEFAULT 'unspecified',
      product_image_paths_json TEXT NOT NULL DEFAULT '[]',
      remix_precision_route TEXT NOT NULL DEFAULT 'anchor_frame_alignment',
      remix_change_contract_json TEXT,
      managed_mode INTEGER NOT NULL DEFAULT 0,
      setup_upload_authorized INTEGER NOT NULL DEFAULT 0,
      planned_execution_authorized INTEGER NOT NULL DEFAULT 0,
      default_image_generation_provider TEXT NOT NULL DEFAULT 'codex_builtin',
      rewrite_mode TEXT,
      continuation_choice TEXT,
      person_route TEXT,
      person_brief TEXT NOT NULL DEFAULT '',
      person_authorization_confirmed INTEGER NOT NULL DEFAULT 0,
      person_source_image_paths_json TEXT NOT NULL DEFAULT '[]',
      person_source_upload_authorized INTEGER NOT NULL DEFAULT 0,
      person_generation_provider TEXT,
      person_attempt_count INTEGER NOT NULL DEFAULT 0,
      person_generation_result_json TEXT,
      product_assets_result_json TEXT,
      storyboard_mode TEXT,
      storyboard_brief TEXT NOT NULL DEFAULT '',
      storyboard_result_json TEXT,
      storyboard_generation_provider TEXT,
      storyboard_source_upload_authorized INTEGER NOT NULL DEFAULT 0,
      storyboard_upload_scope_json TEXT,
      storyboard_ratio_repair_authorized INTEGER NOT NULL DEFAULT 0,
      storyboard_attempt_count INTEGER NOT NULL DEFAULT 0,
      storyboard_generation_result_json TEXT,
      motion_preflight_result_json TEXT,
      video_prompt_result_json TEXT,
      person_package_generation_provider TEXT,
      person_package_source_upload_authorized INTEGER NOT NULL DEFAULT 0,
      person_package_attempt_count INTEGER NOT NULL DEFAULT 0,
      person_package_result_json TEXT,
      generation_route_choice TEXT,
      generation_provider TEXT NOT NULL DEFAULT 'libtv',
      generation_quality_profile TEXT NOT NULL DEFAULT 'high',
      generation_model_key TEXT,
      generation_model_snapshot_json TEXT,
      libtv_project_uuid TEXT,
      libtv_project_name TEXT,
      libtv_project_registered_at TEXT,
      codex_thread_id TEXT,
      codex_thread_name TEXT,
      codex_thread_status TEXT,
      codex_thread_error TEXT,
      codex_thread_created_at TEXT,
      codex_thread_initialized_at TEXT,
      generation_pack_result_json TEXT,
      video_generation_attempt_count INTEGER NOT NULL DEFAULT 0,
      video_quality_revalidation_authorized INTEGER NOT NULL DEFAULT 0,
      full_video_generation_attempt_count INTEGER NOT NULL DEFAULT 0,
      full_video_generation_authorized INTEGER NOT NULL DEFAULT 0,
      full_video_quality_revalidation_authorized INTEGER NOT NULL DEFAULT 0,
      contract_repair_full_video_authorized INTEGER NOT NULL DEFAULT 0,
      video_qc_authorized INTEGER NOT NULL DEFAULT 0,
      video_generation_result_json TEXT,
      video_rework_request_json TEXT,
      video_rework_plan_json TEXT,
      workflow_handoff_json TEXT,
      budget_limit_cny REAL NOT NULL DEFAULT 5,
      estimated_cost_cny REAL NOT NULL DEFAULT 0,
      decompose_retry_count INTEGER NOT NULL DEFAULT 0,
      rewrite_retry_count INTEGER NOT NULL DEFAULT 0,
      active_stage TEXT,
      active_run_id TEXT,
      active_run_started_at TEXT,
      active_external_request_started INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      user_message TEXT,
      decomposition_result_json TEXT,
      rewrite_result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "tasks", "rewrite_mode", "TEXT");
  ensureColumn(db, "tasks", "product_scope", "TEXT NOT NULL DEFAULT 'unspecified'");
  ensureColumn(db, "tasks", "remix_precision_route", "TEXT NOT NULL DEFAULT 'anchor_frame_alignment'");
  ensureColumn(db, "tasks", "remix_change_contract_json", "TEXT");
  ensureColumn(db, "tasks", "managed_mode", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "setup_upload_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "planned_execution_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "default_image_generation_provider", "TEXT NOT NULL DEFAULT 'codex_builtin'");
  ensureColumn(db, "tasks", "continuation_choice", "TEXT");
  ensureColumn(db, "tasks", "person_route", "TEXT");
  ensureColumn(db, "tasks", "person_brief", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "person_authorization_confirmed", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "person_source_image_paths_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "tasks", "person_source_upload_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "person_generation_provider", "TEXT");
  ensureColumn(db, "tasks", "person_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "person_generation_result_json", "TEXT");
  ensureColumn(db, "tasks", "product_assets_result_json", "TEXT");
  ensureColumn(db, "tasks", "storyboard_mode", "TEXT");
  ensureColumn(db, "tasks", "storyboard_brief", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "storyboard_result_json", "TEXT");
  ensureColumn(db, "tasks", "storyboard_generation_provider", "TEXT");
  ensureColumn(db, "tasks", "storyboard_source_upload_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "storyboard_upload_scope_json", "TEXT");
  ensureColumn(db, "tasks", "storyboard_ratio_repair_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "storyboard_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "storyboard_generation_result_json", "TEXT");
  ensureColumn(db, "tasks", "motion_preflight_result_json", "TEXT");
  ensureColumn(db, "tasks", "video_prompt_result_json", "TEXT");
  ensureColumn(db, "tasks", "person_package_generation_provider", "TEXT");
  ensureColumn(db, "tasks", "person_package_source_upload_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "person_package_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "person_package_result_json", "TEXT");
  ensureColumn(db, "tasks", "active_run_id", "TEXT");
  ensureColumn(db, "tasks", "active_run_started_at", "TEXT");
  ensureColumn(db, "tasks", "active_external_request_started", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "generation_route_choice", "TEXT");
  ensureColumn(db, "tasks", "generation_provider", "TEXT NOT NULL DEFAULT 'libtv'");
  ensureColumn(db, "tasks", "generation_quality_profile", "TEXT NOT NULL DEFAULT 'high'");
  ensureColumn(db, "tasks", "generation_model_key", "TEXT");
  ensureColumn(db, "tasks", "generation_model_snapshot_json", "TEXT");
  ensureColumn(db, "tasks", "libtv_project_uuid", "TEXT");
  ensureColumn(db, "tasks", "libtv_project_name", "TEXT");
  ensureColumn(db, "tasks", "libtv_project_registered_at", "TEXT");
  ensureColumn(db, "tasks", "codex_thread_id", "TEXT");
  ensureColumn(db, "tasks", "codex_thread_name", "TEXT");
  ensureColumn(db, "tasks", "codex_thread_status", "TEXT");
  ensureColumn(db, "tasks", "codex_thread_error", "TEXT");
  ensureColumn(db, "tasks", "codex_thread_created_at", "TEXT");
  ensureColumn(db, "tasks", "codex_thread_initialized_at", "TEXT");
  ensureColumn(db, "tasks", "generation_pack_result_json", "TEXT");
  ensureColumn(db, "tasks", "video_generation_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "video_quality_revalidation_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "full_video_generation_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "full_video_generation_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "full_video_quality_revalidation_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "contract_repair_full_video_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "video_qc_authorized", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "video_generation_result_json", "TEXT");
  ensureColumn(db, "tasks", "video_rework_request_json", "TEXT");
  ensureColumn(db, "tasks", "video_rework_plan_json", "TEXT");
  ensureColumn(db, "tasks", "workflow_handoff_json", "TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      label TEXT NOT NULL,
      path TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, path)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'deterministic',
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_extractions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_text TEXT NOT NULL,
      source_url TEXT NOT NULL,
      extraction_scope TEXT NOT NULL,
      downstream_use TEXT NOT NULL DEFAULT '',
      download_authorized INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_task_created ON events(task_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_copilot_messages_task ON copilot_messages(task_id, id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_social_extractions_updated ON social_extractions(updated_at DESC)");
  db.prepare("UPDATE social_extractions SET status = 'failed', error = ?, updated_at = ? WHERE status = 'running'")
    .run("上次提取被工作台重启中断；未自动重复付费请求。", now());
  db.exec("PRAGMA optimize");
  recoverInterruptedTasks(db);
  repairSpecializedInterruptedTasks(db);
  return db;
}

export function createSocialExtraction(db, input) {
  const stamp = now();
  db.prepare(`INSERT INTO social_extractions (
    id, title, source_text, source_url, extraction_scope, downstream_use,
    download_authorized, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
    .run(input.id, input.title, input.sourceText, input.sourceUrl, input.extractionScope,
      input.downstreamUse || "", input.downloadAuthorized ? 1 : 0, stamp, stamp);
  return getSocialExtraction(db, input.id);
}

export function listSocialExtractions(db) {
  return db.prepare("SELECT * FROM social_extractions ORDER BY updated_at DESC").all().map(hydrateSocialExtraction);
}

export function getSocialExtraction(db, id) {
  const row = db.prepare("SELECT * FROM social_extractions WHERE id = ?").get(id);
  return row ? hydrateSocialExtraction(row) : null;
}

export function finishSocialExtraction(db, id, result) {
  db.prepare("UPDATE social_extractions SET status = 'completed', result_json = ?, error = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(result), now(), id);
  return getSocialExtraction(db, id);
}

export function failSocialExtraction(db, id, error) {
  db.prepare("UPDATE social_extractions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .run(String(error).slice(0, 2000), now(), id);
  return getSocialExtraction(db, id);
}

function hydrateSocialExtraction(row) {
  return { ...row, download_authorized: Boolean(row.download_authorized), result: safeJson(row.result_json, null) };
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function recoverInterruptedTasks(db) {
  const running = [STATUSES.RUNNING_DECOMPOSITION, STATUSES.RUNNING_REWRITE, STATUSES.RUNNING_PERSON_GENERATION, STATUSES.RUNNING_PRODUCT_ASSETS, STATUSES.RUNNING_STORYBOARD_GENERATION, STATUSES.RUNNING_MOTION_PREFLIGHT, STATUSES.RUNNING_VIDEO_PROMPT, STATUSES.RUNNING_PERSON_PACKAGE, STATUSES.RUNNING_GENERATION_PACK];
  const placeholders = running.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT id, active_stage, active_run_id, active_external_request_started, person_attempt_count, person_package_attempt_count FROM tasks WHERE status IN (${placeholders})`).all(...running);
  const update = db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, active_run_id = NULL, active_run_started_at = NULL, active_external_request_started = 0, person_attempt_count = CASE WHEN ? = 1 THEN MAX(person_attempt_count - 1, 0) ELSE person_attempt_count END, person_package_attempt_count = CASE WHEN ? = 1 THEN MAX(person_package_attempt_count - 1, 0) ELSE person_package_attempt_count END, user_message = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const recovery = interruptedRecovery(row.active_stage);
    const refundPersonAttempt = row.active_stage === "person" && row.active_external_request_started !== 1 && row.person_attempt_count > 0;
    const refundPackageAttempt = row.active_stage === "person_package" && row.active_external_request_started !== 1 && row.person_package_attempt_count > 0;
    const attemptRefunded = refundPersonAttempt || refundPackageAttempt;
    const message = attemptRefunded ? `${recovery.message} 本次没有进入外部生图，尝试次数已退还。` : recovery.message;
    update.run(recovery.status, row.active_stage || "unknown", refundPersonAttempt ? 1 : 0, refundPackageAttempt ? 1 : 0, message, now(), row.id);
    addEvent(db, row.id, "runtime_recovered", "warning", "检测到中断任务，已安全暂停，未自动重试。", { stage: row.active_stage, invalidated_run_id: row.active_run_id || null, attempt_refunded: attemptRefunded, external_request_started: row.active_external_request_started === 1 });
  }
}

function repairSpecializedInterruptedTasks(db) {
  const rows = db.prepare("SELECT id, active_stage, current_step FROM tasks WHERE status = ?").all(STATUSES.INTERRUPTED);
  const update = db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, user_message = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const stage = row.active_stage || row.current_step;
    const recovery = interruptedRecovery(stage);
    if (recovery.status === STATUSES.INTERRUPTED) continue;
    update.run(recovery.status, stage, recovery.message, now(), row.id);
    addEvent(db, row.id, "interrupted_route_repaired", "warning", "中断任务已回到原业务步骤的安全恢复入口，不会退回拆解。", { stage });
  }
}

function interruptedRecovery(stage) {
  const routes = {
    person: { status: STATUSES.PERSON_GENERATION_FAILED, message: "人物生成被运行时重载中断；现有拆解成果保留，不会自动重试。" },
    product_assets: { status: STATUSES.PRODUCT_ASSETS_BLOCKED, message: "产品参考图整理被运行时重载中断；原始图片仍然保留，可从产品素材整理继续。" },
    storyboard: { status: STATUSES.STORYBOARD_GENERATION_FAILED, message: "分镜生成被运行时重载中断；人物母版和已有候选保留，不会自动重试。" },
    motion_preflight: { status: STATUSES.MOTION_PREFLIGHT_BLOCKED, message: "动态预演被运行时重载中断；人物和分镜保留，可从动态预演继续。" },
    video_prompt: { status: STATUSES.VIDEO_PROMPT_BLOCKED, message: "视频提示词编译被运行时重载中断；上游成果保留，可从提示词继续。" },
    person_package: { status: STATUSES.PERSON_PACKAGE_FAILED, message: "人物安全资产包生成被运行时重载中断；人物、分镜和提示词保留，不会自动重试或退回拆解。" },
    generation_pack: { status: STATUSES.GENERATION_PACK_BLOCKED, message: "生成前检查被运行时重载中断；已有成果保留，可从生成前检查继续。" },
  };
  return routes[stage] || { status: STATUSES.INTERRUPTED, message: "上次执行被中断。为避免重复计费，请手动确认后继续。" };
}

export function createTask(db, task) {
  const stamp = now();
  db.prepare(`
    INSERT INTO tasks (
      id, title, status, current_step, reference_video_path, product_brief,
      product_scope, product_image_paths_json, remix_precision_route, remix_change_contract_json, managed_mode, setup_upload_authorized, planned_execution_authorized,
      default_image_generation_provider, rewrite_mode, person_route, person_brief,
      person_authorization_confirmed, person_source_image_paths_json,
      generation_route_choice, generation_provider, generation_quality_profile,
      generation_model_key, budget_limit_cny, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.title,
    STATUSES.READY,
    "decomposition",
    task.referenceVideoPath,
    task.productBrief || "",
    task.productScope || "unspecified",
    JSON.stringify(task.productImagePaths || []),
    task.remixPrecisionRoute || "anchor_frame_alignment",
    JSON.stringify(task.remixChangeContract || null),
    task.managedMode ? 1 : 0,
    task.setupUploadAuthorized ? 1 : 0,
    task.plannedExecutionAuthorized ? 1 : 0,
    task.defaultImageGenerationProvider || "codex_builtin",
    task.rewriteMode || null,
    task.personRoute || null,
    task.personBrief || "",
    task.personAuthorizationConfirmed ? 1 : 0,
    JSON.stringify(task.personSourceImagePaths || []),
    task.generationRouteChoice || "smoke_test_first",
    task.generationProvider || "libtv",
    task.generationQualityProfile || "high",
    task.generationModelKey || (task.generationProvider === "runninghub_h3_multiref"
      ? "minimax-h3-multiref-owned-clean"
      : "star-video2"),
    task.budgetLimitCny,
    stamp,
    stamp,
  );
  const message = task.managedMode
    ? task.plannedExecutionAuthorized
      ? "项目总设置与本次执行授权已保存；系统会按既定路线连续执行，最终成片返回后由你决定采用或返工。"
      : "项目总设置已保存；系统会按既定路线执行，遇到新增上传或付费提交时暂停。"
    : "视频任务已建立，等待你确认开始拆解。";
  addEvent(db, task.id, "task_created", "info", message, {
    budget_limit_cny: task.budgetLimitCny,
    remix_precision_route: task.remixPrecisionRoute || "anchor_frame_alignment",
    remix_change_contract: task.remixChangeContract || null,
    rewrite_mode: task.rewriteMode || null,
    person_route: task.personRoute || null,
    generation_provider: task.generationProvider || "libtv",
    generation_quality_profile: task.generationQualityProfile || "high",
    generation_route_choice: task.generationRouteChoice || "smoke_test_first",
    generation_model_key: task.generationModelKey || null,
    managed_mode: Boolean(task.managedMode),
    planned_execution_authorized: Boolean(task.plannedExecutionAuthorized),
  });
  return getTask(db, task.id);
}

export function listTasks(db) {
  return db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all().map((row) => hydrateTask(db, row));
}

export function getTask(db, id) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? hydrateTask(db, row) : null;
}

function hydrateTask(db, row) {
  const task = {
    ...row,
    product_image_paths: safeJson(row.product_image_paths_json, []),
    remix_change_contract: safeJson(row.remix_change_contract_json, null),
    managed_mode: Boolean(row.managed_mode),
    setup_upload_authorized: Boolean(row.setup_upload_authorized),
    planned_execution_authorized: Boolean(row.planned_execution_authorized),
    person_authorization_confirmed: Boolean(row.person_authorization_confirmed),
    person_source_image_paths: safeJson(row.person_source_image_paths_json, []),
    person_source_upload_authorized: Boolean(row.person_source_upload_authorized),
    decomposition_result: safeJson(row.decomposition_result_json, null),
    rewrite_result: safeJson(row.rewrite_result_json, null),
    person_generation_result: safeJson(row.person_generation_result_json, null),
    product_assets_result: safeJson(row.product_assets_result_json, null),
    storyboard_result: safeJson(row.storyboard_result_json, null),
    storyboard_source_upload_authorized: Boolean(row.storyboard_source_upload_authorized),
    storyboard_upload_scope: safeJson(row.storyboard_upload_scope_json, null),
    storyboard_ratio_repair_authorized: Boolean(row.storyboard_ratio_repair_authorized),
    video_qc_authorized: Boolean(row.video_qc_authorized),
    full_video_quality_revalidation_authorized: Boolean(row.full_video_quality_revalidation_authorized),
    contract_repair_full_video_authorized: Boolean(row.contract_repair_full_video_authorized),
    storyboard_generation_result: safeJson(row.storyboard_generation_result_json, null),
    motion_preflight_result: safeJson(row.motion_preflight_result_json, null),
    video_prompt_result: safeJson(row.video_prompt_result_json, null),
    person_package_source_upload_authorized: Boolean(row.person_package_source_upload_authorized),
    active_external_request_started: Boolean(row.active_external_request_started),
    video_quality_revalidation_authorized: Boolean(row.video_quality_revalidation_authorized),
    full_video_generation_attempt_count: Number(row.full_video_generation_attempt_count || 0),
    full_video_generation_authorized: Boolean(row.full_video_generation_authorized),
    person_package_result: safeJson(row.person_package_result_json, null),
    generation_model_snapshot: safeJson(row.generation_model_snapshot_json, null),
    generation_pack_result: safeJson(row.generation_pack_result_json, null),
    video_generation_result: safeJson(row.video_generation_result_json, null),
    video_rework_request: safeJson(row.video_rework_request_json, null),
    video_rework_plan: safeJson(row.video_rework_plan_json, null),
    workflow_handoff: safeJson(row.workflow_handoff_json, null),
    events: db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 40").all(row.id).map((event) => ({ ...event, details: safeJson(event.details_json, {}) })),
    artifacts: db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY id ASC").all(row.id),
    copilot_messages: db.prepare("SELECT * FROM copilot_messages WHERE task_id = ? ORDER BY id DESC LIMIT 40").all(row.id).reverse(),
  };
  return { ...task, user_state: projectUserState(task) };
}

export function addCopilotMessage(db, taskId, role, content, source = "deterministic") {
  if (!getTask(db, taskId)) throw new Error("TASK_NOT_FOUND");
  if (!["user", "assistant"].includes(role)) throw new Error("COPILOT_ROLE_INVALID");
  const value = String(content || "").trim().slice(0, 4000);
  if (!value) throw new Error("COPILOT_MESSAGE_REQUIRED");
  db.prepare("INSERT INTO copilot_messages (task_id, role, content, source, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(taskId, role, value, source, now());
  return db.prepare("SELECT * FROM copilot_messages WHERE id = last_insert_rowid()").get();
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function addEvent(db, taskId, eventType, level, message, details = {}) {
  db.prepare("INSERT INTO events (task_id, event_type, level, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(taskId, eventType, level, message, JSON.stringify(details), now());
}

export function setDefaultImageGenerationProvider(db, taskId, generationProvider) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (!["codex_builtin", "chatgpt_web"].includes(generationProvider)) throw new Error("IMAGE_GENERATION_PROVIDER_INVALID");
  db.prepare("UPDATE tasks SET default_image_generation_provider = ?, updated_at = ? WHERE id = ?")
    .run(generationProvider, now(), taskId);
  addEvent(db, taskId, "default_image_generation_provider_updated", "info", generationProvider === "chatgpt_web" ? "项目默认生图通道已改为 ChatGPT 网页代办。" : "项目默认生图通道已改为 Codex 内置生图。", { generation_provider: generationProvider, external_request: false });
  return getTask(db, taskId);
}

export function markCodexTaskConnecting(db, taskId) {
  if (!getTask(db, taskId)) throw new Error("TASK_NOT_FOUND");
  db.prepare("UPDATE tasks SET codex_thread_status = 'connecting', codex_thread_error = NULL, updated_at = ? WHERE id = ?")
    .run(now(), taskId);
  return getTask(db, taskId);
}

export function markCodexTaskRunning(db, taskId, { threadId, threadName }) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.codex_thread_id && task.codex_thread_id !== threadId)
    throw new Error("CODEX_THREAD_ALREADY_BOUND");
  const stamp = now();
  db.prepare("UPDATE tasks SET codex_thread_id = ?, codex_thread_name = ?, codex_thread_status = 'running', codex_thread_error = NULL, codex_thread_created_at = COALESCE(codex_thread_created_at, ?), codex_thread_initialized_at = COALESCE(codex_thread_initialized_at, ?), updated_at = ? WHERE id = ?")
    .run(threadId, threadName, stamp, stamp, stamp, taskId);
  addEvent(db, taskId, "codex_thread_running", "info", "项目任务正在后台继续制作；完成或需要处理后即可打开。", {
    thread_id: threadId,
    starts_model_turn: true,
  });
  return getTask(db, taskId);
}

export function rememberCodexTaskThread(
  db,
  taskId,
  threadId,
  { replaceUninitialized = false, replaceExisting = false } = {},
) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const replacingStaleThread = Boolean(
    task.codex_thread_id &&
      task.codex_thread_id !== threadId &&
      (replaceExisting || (replaceUninitialized && !task.codex_thread_initialized_at)),
  );
  if (task.codex_thread_id && task.codex_thread_id !== threadId && !replacingStaleThread) throw new Error("CODEX_THREAD_ALREADY_BOUND");
  const stamp = now();
  db.prepare("UPDATE tasks SET codex_thread_id = ?, codex_thread_name = CASE WHEN ? = 1 THEN NULL ELSE codex_thread_name END, codex_thread_status = 'connecting', codex_thread_error = NULL, codex_thread_created_at = CASE WHEN ? = 1 THEN ? ELSE COALESCE(codex_thread_created_at, ?) END, codex_thread_initialized_at = CASE WHEN ? = 1 THEN NULL ELSE codex_thread_initialized_at END, updated_at = ? WHERE id = ?")
    .run(
      threadId,
      replacingStaleThread ? 1 : 0,
      replacingStaleThread ? 1 : 0,
      stamp,
      stamp,
      replacingStaleThread ? 1 : 0,
      stamp,
      taskId,
    );
  return getTask(db, taskId);
}

export function finishCodexTaskBinding(db, taskId, { threadId, threadName, initialTurnStarted = false }) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.codex_thread_id && task.codex_thread_id !== threadId) throw new Error("CODEX_THREAD_ALREADY_BOUND");
  const stamp = now();
  db.prepare("UPDATE tasks SET codex_thread_id = ?, codex_thread_name = ?, codex_thread_status = 'ready', codex_thread_error = NULL, codex_thread_created_at = COALESCE(codex_thread_created_at, ?), codex_thread_initialized_at = CASE WHEN ? = 1 THEN COALESCE(codex_thread_initialized_at, ?) ELSE codex_thread_initialized_at END, updated_at = ? WHERE id = ?")
    .run(threadId, threadName, stamp, initialTurnStarted ? 1 : 0, stamp, stamp, taskId);
  addEvent(db, taskId, "codex_thread_bound", "info", initialTurnStarted ? "项目专属 Codex 任务已打开，并完成首次项目交接。" : "项目专属 Codex 任务已建立。", { thread_id: threadId, starts_model_turn: initialTurnStarted });
  return getTask(db, taskId);
}

export function failCodexTaskBinding(db, taskId, error) {
  if (!getTask(db, taskId)) throw new Error("TASK_NOT_FOUND");
  const safeMessage = String(error || "Codex 任务暂时无法建立").replace(/[\r\n]+/g, " ").slice(0, 500);
  db.prepare("UPDATE tasks SET codex_thread_status = 'failed', codex_thread_error = ?, updated_at = ? WHERE id = ?")
    .run(safeMessage, now(), taskId);
  addEvent(db, taskId, "codex_thread_binding_failed", "warning", "工作台项目已保存，但 Codex 任务暂未连接。", { external_request: false });
  return getTask(db, taskId);
}

export function recordWorkflowHandoff(db, taskId, envelope) {
  if (!getTask(db, taskId)) throw new Error("TASK_NOT_FOUND");
  if (
    envelope?.contract_name !== "ai_content_workbench_handoff" ||
    envelope?.schema_version !== 1 ||
    envelope?.project?.task_id !== taskId
  ) throw new Error("WORKFLOW_HANDOFF_INVALID");
  db.prepare("UPDATE tasks SET workflow_handoff_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(envelope), now(), taskId);
  addEvent(db, taskId, "workflow_exception_handed_off", "warning", "当前问题已连同项目事实和执行状态交给项目任务；不会自动重试。", {
    handoff_id: envelope.handoff_id,
    stage: envelope.responsibility?.stage || null,
    outcome: envelope.outcome?.state || null,
    external_request_started: envelope.execution?.external_request_started ?? null,
    automatic_retry: false,
  });
  return getTask(db, taskId);
}

export function registerLibTVProject(db, taskId, { projectUuid, projectName }) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (!/^[a-f0-9]{32}$/.test(String(projectUuid || ""))) throw new Error("LIBTV_PROJECT_UUID_INVALID");
  if (!String(projectName || "").trim()) throw new Error("LIBTV_PROJECT_NAME_REQUIRED");
  const registeredAt = now();
  const pack = task.generation_pack_result ? {
    ...task.generation_pack_result,
    submission_preview: {
      ...(task.generation_pack_result.submission_preview || {}),
      project_binding_status: "dedicated_project_ready",
      project_uuid: projectUuid,
      project_name: projectName,
      project_selection_mode: "explicit_per_task",
    },
  } : null;
  db.prepare("UPDATE tasks SET libtv_project_uuid = ?, libtv_project_name = ?, libtv_project_registered_at = ?, generation_pack_result_json = COALESCE(?, generation_pack_result_json), updated_at = ? WHERE id = ?")
    .run(projectUuid, projectName, registeredAt, pack ? JSON.stringify(pack) : null, registeredAt, taskId);
  addEvent(db, taskId, "libtv_project_registered", "info", "本任务的专属 LibTV 画布已就绪；尚未上传素材或生成视频。", {
    project_uuid: projectUuid,
    project_name: projectName,
    project_selection_mode: "explicit_per_task",
    external_request: false,
    video_generation_started: false,
  });
  return getTask(db, taskId);
}

export function beginStage(db, taskId, stage) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const retryColumn = stage === "decomposition" ? "decompose_retry_count" : "rewrite_retry_count";
  if (task[retryColumn] >= 2 && [STATUSES.FAILED, STATUSES.INTERRUPTED].includes(task.status)) {
    db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, user_message = ?, updated_at = ? WHERE id = ?")
      .run(STATUSES.BLOCKED_DIAGNOSTIC, stage, "同一步骤已经失败或中断两次，请先诊断根因，不再自动重试。", now(), taskId);
    addEvent(db, taskId, "retry_blocked", "error", "有界重试已耗尽，任务已转为待诊断。", { stage });
    throw new Error("RETRY_LIMIT_REACHED");
  }
  const status = stage === "decomposition" ? STATUSES.RUNNING_DECOMPOSITION : STATUSES.RUNNING_REWRITE;
  db.prepare(`UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, ${retryColumn} = ${retryColumn} + 1, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?`)
    .run(status, stage, stage, stage === "decomposition" ? "正在拆解参考视频。" : "正在重构商品脚本。", now(), taskId);
  addEvent(db, taskId, "stage_started", "info", stage === "decomposition" ? "参考视频拆解已开始。" : "商品脚本重构已开始。", { stage });
}

export function finishStage(db, taskId, stage, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const resultColumn = stage === "decomposition" ? "decomposition_result_json" : "rewrite_result_json";
  const nextStatus = stage === "decomposition" ? STATUSES.AWAITING_CONFIRMATION : STATUSES.COMPLETED;
  const nextStep = stage === "decomposition" ? "user_confirmation" : "completed";
  const message = stage === "decomposition" ? "拆解完成，请确认后再进入商品脚本重构。" : "第一阶段闭环已完成。";
  const stageCost = Number(result.estimated_cost_cny || 0);
  const totalCost = stage === "decomposition" ? stageCost : Number(task.estimated_cost_cny || 0) + stageCost;
  db.prepare(`UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, ${resultColumn} = ?, estimated_cost_cny = ?, user_message = ?, updated_at = ? WHERE id = ?`)
    .run(nextStatus, nextStep, JSON.stringify(result), totalCost, message, now(), taskId);
  storeArtifacts(db, taskId, stage, result.artifacts || []);
  addEvent(db, taskId, "stage_completed", "info", message, { stage, estimated_cost_cny: result.estimated_cost_cny || 0 });
}

export function pauseStage(db, taskId, stage, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const resultColumn = stage === "decomposition" ? "decomposition_result_json" : "rewrite_result_json";
  const stageCost = Number(result.estimated_cost_cny || 0);
  const totalCost = stage === "decomposition" ? stageCost : Number(task.estimated_cost_cny || 0) + stageCost;
  db.prepare(`UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, ${resultColumn} = ?, estimated_cost_cny = ?, user_message = ?, updated_at = ? WHERE id = ?`)
    .run(STATUSES.AWAITING_CONFIRMATION, `${stage}_input`, JSON.stringify(result), totalCost, result.user_message || "需要你补充或确认后才能继续。", now(), taskId);
  addEvent(db, taskId, "stage_paused", "warning", result.user_message || "任务已暂停，等待补充信息。", { stage });
}

export function blockStage(db, taskId, stage, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const resultColumn = stage === "decomposition" ? "decomposition_result_json" : "rewrite_result_json";
  const retryColumn = stage === "decomposition" ? "decompose_retry_count" : "rewrite_retry_count";
  const stageCost = Number(result.estimated_cost_cny || 0);
  const totalCost = stage === "decomposition"
    ? Math.max(Number(task.estimated_cost_cny || 0), stageCost)
    : Number(task.estimated_cost_cny || 0) + stageCost;
  const message = result.user_message || "当前缺少必要配置，任务已安全暂停；未占用失败重试次数。";
  db.prepare(`UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, ${resultColumn} = ?, estimated_cost_cny = ?, ${retryColumn} = MAX(${retryColumn} - 1, 0), last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?`)
    .run(STATUSES.BLOCKED_CONFIGURATION, stage, JSON.stringify(result), totalCost, message, now(), taskId);
  storeArtifacts(db, taskId, stage, result.artifacts || []);
  addEvent(db, taskId, "stage_configuration_blocked", "warning", "任务因配置条件不足而暂停，未记作执行失败。", { stage, estimated_cost_cny: stageCost });
}

export function failStage(db, taskId, stage, error) {
  const task = getTask(db, taskId);
  const retryColumn = stage === "decomposition" ? "decompose_retry_count" : "rewrite_retry_count";
  const blocked = task && task[retryColumn] >= 2;
  const status = blocked ? STATUSES.BLOCKED_DIAGNOSTIC : STATUSES.FAILED;
  const message = blocked ? "同一步骤连续失败，已停止重试，请先诊断根因。" : "执行失败。你可以检查说明后手动重试一次。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(status, stage, String(error).slice(0, 2000), message, now(), taskId);
  addEvent(db, taskId, "stage_failed", "error", message, { stage, error: String(error).slice(0, 500) });
}

export function updateProductInputs(db, taskId, productBrief, productImagePaths, rewriteMode = "replace_product", productScope = "unspecified") {
  db.prepare("UPDATE tasks SET product_brief = ?, product_scope = ?, product_image_paths_json = ?, rewrite_mode = ?, updated_at = ? WHERE id = ?")
    .run(productBrief, productScope, JSON.stringify(productImagePaths), rewriteMode, now(), taskId);
  const message = rewriteMode === "exact_original"
    ? "你已选择精确复刻原款。"
    : rewriteMode === "keep_original_style"
      ? "你已选择保留原片产品，不做换品。"
      : "你已确认换成自己的产品。";
  addEvent(db, taskId, "rewrite_confirmed", "info", message, { rewrite_mode: rewriteMode, product_scope: productScope, product_image_count: productImagePaths.length });
}

export function updateProductScope(db, taskId, productScope) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (!["full_look", "top_only", "bottom_only", "custom"].includes(productScope))
    throw new Error("PRODUCT_SCOPE_INVALID");
  db.prepare("UPDATE tasks SET product_scope = ?, product_assets_result_json = NULL, updated_at = ? WHERE id = ?")
    .run(productScope, now(), taskId);
  addEvent(db, taskId, "product_scope_updated", "info", productScope === "full_look" ? "产品范围已改为整套穿搭。" : productScope === "top_only" ? "产品范围已改为上衣。" : productScope === "bottom_only" ? "产品范围已改为下装。" : "产品范围已按补充说明更新。", { product_scope: productScope });
  return getTask(db, taskId);
}

export function completeWithoutRewrite(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.AWAITING_CONFIRMATION || task.current_step !== "user_confirmation" || !task.decomposition_result) throw new Error("ROUTE_SELECTION_UNAVAILABLE");
  const result = {
    status: "completed",
    summary: "参考视频拆解已经完成；按你的选择保留原产品或穿搭风格，本阶段不做商品脚本重构。",
    estimated_cost_cny: 0,
    artifacts: [],
    requires_confirmation: false,
    user_message: "第一阶段已完成。后续可直接使用复刻 DNA 继续人物/服装资产、分镜或视频提示词流程。",
  };
  const stamp = now();
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, rewrite_mode = ?, rewrite_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.COMPLETED, "completed", "keep_original_style", JSON.stringify(result), result.user_message, stamp, taskId);
  addEvent(db, taskId, "rewrite_skipped", "info", "你选择保留原产品或穿搭风格，商品脚本重构已跳过。", { rewrite_mode: "keep_original_style" });
  return getTask(db, taskId);
}

export function saveDecompositionOnly(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (![STATUSES.COMPLETED, STATUSES.PERSON_INPUTS_READY].includes(task.status)) throw new Error("CONTINUATION_UNAVAILABLE");
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, continuation_choice = ?, person_route = NULL, person_brief = '', person_authorization_confirmed = 0, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.COMPLETED, "completed", "save_decomposition_only", "拆解结果已保存在本机；当前不会继续生成人物、分镜或视频。", now(), taskId);
  addEvent(db, taskId, "continuation_saved_only", "info", "你选择只保存拆解结果，第二阶段未启动。", {});
  return getTask(db, taskId);
}

export function preparePersonInputs(db, taskId, { personRoute, personBrief, authorizationConfirmed }) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (![STATUSES.COMPLETED, STATUSES.PERSON_INPUTS_READY].includes(task.status)) throw new Error("CONTINUATION_UNAVAILABLE");
  if (!["authorized_person", "auto_ai_person", "generic_no_fixed_face"].includes(personRoute)) throw new Error("INVALID_PERSON_ROUTE");
  if (personRoute === "authorized_person" && authorizationConfirmed !== true) throw new Error("PERSON_AUTHORIZATION_REQUIRED");
  const message = "人物路线和要求已保存在本机，第二阶段尚未执行；未上传素材、未生图、未产生新费用。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, continuation_choice = ?, person_route = ?, person_brief = ?, person_authorization_confirmed = ?, person_source_upload_authorized = 0, person_generation_provider = NULL, person_generation_result_json = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.PERSON_INPUTS_READY, "person_inputs_ready", "continue_video", personRoute, personBrief, authorizationConfirmed ? 1 : 0, message, now(), taskId);
  addEvent(db, taskId, "person_inputs_ready", "info", "人物路线已在本机登记，等待正式人物资产执行。", { person_route: personRoute, external_request: false, additional_cost_cny: 0 });
  return getTask(db, taskId);
}

export function registerAuthorizedPersonSource(db, taskId, sourcePaths) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.PERSON_INPUTS_READY) throw new Error("PERSON_SOURCE_UPLOAD_UNAVAILABLE");
  if (task.person_route !== "authorized_person" || !task.person_authorization_confirmed)
    throw new Error("PERSON_AUTHORIZATION_REQUIRED");
  const paths = [...new Set((sourcePaths || []).filter(Boolean))];
  if (paths.length !== 1) throw new Error("PERSON_SOURCE_IMAGE_COUNT_INVALID");
  const result = {
    schema_version: 1,
    status: "completed",
    source_kind: "authorized_upload",
    summary: "已收到 1 张本人或已授权人物照片，等待确认作为人物母版。",
    estimated_cost_cny: 0,
    external_request_started: false,
    image_generation_started: false,
    video_generation_started: false,
    artifacts: [{ label: "授权人物母版候选", path: paths[0], published: false }],
    requires_confirmation: true,
    user_message: "人物照片已保存在本机，请确认是否作为本项目的人物母版。",
  };
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, person_source_image_paths_json = ?, person_generation_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.PERSON_REVIEW, "person_review", JSON.stringify(paths), JSON.stringify(result), result.user_message, now(), taskId);
  storeArtifacts(db, taskId, "person", result.artifacts);
  addEvent(db, taskId, "authorized_person_source_received", "info", "已在工作台收到 1 张授权人物照片，等待确认采用。", { image_count: 1, external_request: false, additional_cost_cny: 0 });
  return getTask(db, taskId);
}

export function beginPersonGeneration(db, taskId, { sourceUploadAuthorized, generationProvider }) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (![STATUSES.PERSON_INPUTS_READY, STATUSES.PERSON_REVIEW, STATUSES.PERSON_GENERATION_FAILED].includes(task.status)) throw new Error("PERSON_GENERATION_UNAVAILABLE");
  if (task.person_route !== "auto_ai_person") throw new Error("PERSON_ROUTE_NOT_SUPPORTED_YET");
  if (sourceUploadAuthorized !== true) throw new Error("PERSON_SOURCE_UPLOAD_AUTHORIZATION_REQUIRED");
  const selectedProvider = generationProvider || task.default_image_generation_provider || "codex_builtin";
  if (!["codex_builtin", "chatgpt_web"].includes(selectedProvider)) throw new Error("PERSON_GENERATION_PROVIDER_INVALID");
  const checkpointResume = task.status === STATUSES.PERSON_GENERATION_FAILED
    && /PERSON_CHATGPT_INTERNAL_REQUEST_MISSING|CHATGPT_INTERNAL_REQUEST_EXECUTION_INVALID|CHATGPT_WEB_PRE_SUBMIT_BLOCKED|等待参考图上传完成超时|等待页面控件超时|EEXIST: file already exists.*\/person-(?:skill-contract-attempt|task-attempt|web-request-prompt)-\d+/.test(task.last_error || "")
    && selectedProvider === "chatgpt_web";
  if (task.person_attempt_count >= 2 && !checkpointResume) throw new Error("PERSON_ATTEMPT_LIMIT_REACHED");
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, person_source_upload_authorized = 1, person_generation_provider = ?, person_attempt_count = person_attempt_count + ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_PERSON_GENERATION, "person_generation", "person", selectedProvider, checkpointResume ? 0 : 1, checkpointResume ? "正在接回网页提交前已经准备好的人物请求；不会重新整理提示词，也不增加生成次数。" : "正在创建 1 张虚构人物候选图；本次不会自动追加候选或重试。", now(), taskId);
  addEvent(db, taskId, "person_generation_started", "info", "人物候选生成已开始。", {
    generation_provider: selectedProvider,
    source_frame_upload_authorized: true,
    requested_output_count: 1,
    automatic_retry: false,
    checkpoint_resume: checkpointResume,
  });
  return getTask(db, taskId);
}

export function finishPersonGeneration(db, taskId, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const imageArtifact = (result.artifacts || []).find((item) => /\.(png|jpe?g|webp)$/i.test(item.path || ""));
  if (!imageArtifact) throw new Error("PERSON_IMAGE_MISSING");
  const message = result.user_message || "人物候选已生成并通过基础检查，请确认是否采用。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, person_generation_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.PERSON_REVIEW, "person_review", JSON.stringify(result), message, now(), taskId);
  storeArtifacts(db, taskId, "person", result.artifacts || []);
  addEvent(db, taskId, "person_generation_completed", "info", "人物候选已生成，等待你的审美确认。", { approval_status: "needs_review", additional_cost_cny: Number(result.estimated_cost_cny || 0) });
  return getTask(db, taskId);
}

export function failPersonGeneration(db, taskId, error) {
  const runtimeStartupBlocked = error?.code === "CODEX_RUNTIME_UNAVAILABLE" && error?.business_started === false;
  const preflightBlocked = error?.external_request_started === false || runtimeStartupBlocked;
  const message = runtimeStartupBlocked
    ? "后台发动机连续两次都没有成功启动，人物生图尚未开始；本次生成次数已退还，稍后可直接重新尝试。"
    : preflightBlocked
      ? "问题发生在网页提交前，人物生图尚未开始；本次生成次数已退还，可继续使用已经准备好的提示词和参考图。"
    : "人物候选没有生成成功，现有拆解成果不受影响；系统不会自动重试。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, person_attempt_count = CASE WHEN ? = 1 THEN MAX(person_attempt_count - 1, 0) ELSE person_attempt_count END, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.PERSON_GENERATION_FAILED, "person_generation", preflightBlocked ? 1 : 0, String(error).slice(0, 2000), message, now(), taskId);
  addEvent(db, taskId, runtimeStartupBlocked ? "person_runtime_startup_blocked" : "person_generation_failed", preflightBlocked ? "warning" : "error", message, { error: String(error).slice(0, 500), automatic_retry: false, attempt_refunded: preflightBlocked, business_started: error?.business_started ?? null, external_request_started: error?.external_request_started ?? null });
  return getTask(db, taskId);
}

export function approvePersonAsset(db, taskId, publishedArtifact = null) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.PERSON_REVIEW || !task.person_generation_result) throw new Error("PERSON_APPROVAL_UNAVAILABLE");
  const result = { ...task.person_generation_result, approval_status: "approved" };
  if (publishedArtifact?.path) {
    result.artifacts = (result.artifacts || []).map((item) => /\.(png|jpe?g|webp)$/i.test(item.path || "") ? { ...item, path: publishedArtifact.path, published: true } : item);
    storeArtifacts(db, taskId, "person", [publishedArtifact]);
  }
  const message = "人物母版已确认。现在可以进入锚帧分镜准备；点击后只整理本地输入，不会直接生图或产生费用。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, person_generation_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.PERSON_APPROVED, "person_approved", JSON.stringify(result), message, now(), taskId);
  addEvent(db, taskId, "person_asset_approved", "info", "你已确认采用当前人物母版。", { next_stage: "storyboard_prepare_available" });
  return getTask(db, taskId);
}

export function beginProductAssets(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.remix_precision_route !== "prompt_driven_remix" || task.rewrite_mode !== "replace_product")
    throw new Error("PRODUCT_ASSETS_ROUTE_UNAVAILABLE");
  if (![STATUSES.PERSON_APPROVED, STATUSES.GENERATION_PACK_BLOCKED, STATUSES.PRODUCT_ASSETS_BLOCKED, STATUSES.PRODUCT_ASSETS_REVIEW].includes(task.status))
    throw new Error("PRODUCT_ASSETS_UNAVAILABLE");
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, product_assets_result_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_PRODUCT_ASSETS, "product_assets", "product_assets", "正在用现有商品图整理干净产品参考；不会上传、不会生图、不会产生费用。", now(), taskId);
  addEvent(db, taskId, "product_assets_started", "info", "正在整理现有商品图；原图会保留。", { external_request: false, image_generation_started: false });
  return getTask(db, taskId);
}

export function finishProductAssets(db, taskId, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const images = (result.artifacts || []).filter((item) => item.path && /\.(png|jpe?g|webp)$/i.test(item.path));
  if (!images.length) throw new Error("CLEAN_PRODUCT_REFERENCE_MISSING");
  const finalized = { ...result, approval_status: "approved" };
  const message = result.user_message || "产品参考已按项目开始时选择的范围整理完成，正在继续准备视频提示词。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, product_assets_result_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.VIDEO_PROMPT_BLOCKED, "video_prompt", JSON.stringify(finalized), message, now(), taskId);
  storeArtifacts(db, taskId, "product_assets", result.artifacts || []);
  const publish = db.prepare("UPDATE artifacts SET published = 1 WHERE task_id = ? AND stage = ? AND id = ?");
  for (const image of getTask(db, taskId).artifacts.filter((item) => item.stage === "product_assets" && /\.(png|jpe?g|webp)$/i.test(item.path)))
    publish.run(taskId, "product_assets", image.id);
  addEvent(db, taskId, "product_assets_ready", "info", "产品参考已按预先选择的产品范围自动整理并采用。", { approval_status: "approved", external_request: false, next_stage: "video_prompt" });
  return getTask(db, taskId);
}

export function failProductAssets(db, taskId, error, result = null) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const message = result?.user_message || "现有商品图暂时无法整理成安全可用的产品参考；原图和已有提示词仍然保留。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, product_assets_result_json = ?, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.PRODUCT_ASSETS_BLOCKED, "product_assets", result ? JSON.stringify(result) : null, String(error).slice(0, 2000), message, now(), taskId);
  if (result) storeArtifacts(db, taskId, "product_assets", result.artifacts || []);
  addEvent(db, taskId, "product_assets_blocked", "warning", message, { external_request: false, automatic_retry: false });
  return getTask(db, taskId);
}

export function approveProductAssets(db, taskId) {
  const task = getTask(db, taskId);
  if (!task || task.status !== STATUSES.PRODUCT_ASSETS_REVIEW || !task.product_assets_result)
    throw new Error("PRODUCT_ASSETS_APPROVAL_UNAVAILABLE");
  const images = task.artifacts.filter((item) => item.stage === "product_assets" && /\.(png|jpe?g|webp)$/i.test(item.path));
  if (!images.length) throw new Error("CLEAN_PRODUCT_REFERENCE_MISSING");
  const result = { ...task.product_assets_result, approval_status: "approved" };
  const publish = db.prepare("UPDATE artifacts SET published = 1 WHERE id = ?");
  for (const image of images) publish.run(image.id);
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, product_assets_result_json = ?, video_prompt_result_json = NULL, generation_pack_result_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.VIDEO_PROMPT_BLOCKED, "video_prompt", JSON.stringify(result), "干净产品参考已采用。下一步按当前视频设置重新整理提示词，不需要分镜或动态预演。", now(), taskId);
  addEvent(db, taskId, "product_assets_approved", "info", "你已采用干净产品参考；接下来重新整理正式提示词。", { next_stage: "video_prompt" });
  return getTask(db, taskId);
}

export function prepareStoryboardInputs(db, taskId, { storyboardMode, storyboardBrief }) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (![STATUSES.PERSON_APPROVED, STATUSES.STORYBOARD_INPUTS_READY].includes(task.status)) throw new Error("STORYBOARD_PREPARATION_UNAVAILABLE");
  if (storyboardMode !== "anchor_storyboard") throw new Error("STORYBOARD_MODE_INVALID");
  const approvedPerson = task.artifacts.find((item) => item.stage === "person" && item.published && /人物/.test(item.label));
  if (!approvedPerson || !task.decomposition_result) throw new Error("STORYBOARD_REQUIRED_INPUTS_MISSING");
  const result = {
    schema_version: 1,
    status: "inputs_ready",
    mode: storyboardMode,
    brief: storyboardBrief || "",
    inputs: {
      decomposition_ready: true,
      approved_person_artifact_id: approvedPerson.id,
      rewrite_mode: task.rewrite_mode,
    },
    external_request_started: false,
    image_generation_started: false,
    video_generation_started: false,
    estimated_cost_cny: 0,
  };
  const message = "锚帧分镜所需资料已在本机对齐。尚未生成分镜图；下一步将接入分镜 Skill 的正式执行与确认闭环。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, storyboard_mode = ?, storyboard_brief = ?, storyboard_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.STORYBOARD_INPUTS_READY, "storyboard_inputs_ready", storyboardMode, storyboardBrief || "", JSON.stringify(result), message, now(), taskId);
  addEvent(db, taskId, "storyboard_inputs_ready", "info", "分镜入口已启动，人物母版和拆解证据已完成本地对齐。", { mode: storyboardMode, external_request: false, additional_cost_cny: 0 });
  return getTask(db, taskId);
}

export function beginStoryboardGeneration(db, taskId, { sourceUploadAuthorized, generationProvider, ratioRepairAuthorized, resumeIncomplete = false }) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (![STATUSES.STORYBOARD_INPUTS_READY, STATUSES.STORYBOARD_REVIEW, STATUSES.STORYBOARD_GENERATION_FAILED].includes(task.status)) throw new Error("STORYBOARD_GENERATION_UNAVAILABLE");
  if (sourceUploadAuthorized !== true) throw new Error("STORYBOARD_SOURCE_UPLOAD_AUTHORIZATION_REQUIRED");
  const selectedProvider = generationProvider || task.default_image_generation_provider || "codex_builtin";
  if (!["codex_builtin", "chatgpt_web"].includes(selectedProvider)) throw new Error("STORYBOARD_GENERATION_PROVIDER_INVALID");
  if (selectedProvider === "chatgpt_web" && ratioRepairAuthorized !== true) throw new Error("STORYBOARD_RATIO_REPAIR_AUTHORIZATION_REQUIRED");
  if (task.storyboard_attempt_count >= 2 && !resumeIncomplete) throw new Error("STORYBOARD_ATTEMPT_LIMIT_REACHED");
  if (resumeIncomplete && task.status !== STATUSES.STORYBOARD_GENERATION_FAILED) throw new Error("STORYBOARD_RESUME_UNAVAILABLE");
  const approvedPerson = task.artifacts.find((item) => item.stage === "person" && item.published && /人物/.test(item.label));
  const sceneReferencePaths = task.remix_change_contract?.scene?.image_paths || [];
  const productReferencePaths = task.remix_change_contract?.product?.mode === "replace_product"
    ? (task.remix_change_contract?.product?.image_paths || task.product_image_paths || [])
    : [];
  const uploadScope = {
    schema_version: 1,
    source_anchor_frames_authorized: true,
    approved_person_paths: approvedPerson?.path ? [approvedPerson.path] : [],
    scene_reference_paths: sceneReferencePaths,
    product_reference_paths: productReferencePaths,
    full_video_authorized: false,
    unlisted_assets_authorized: false,
  };
  const message = selectedProvider === "chatgpt_web"
    ? "正在按最新版分镜 Skill 判断短片宫格或长片分段路线；每段只生成 1 张，错误路线会在提交前拦截。"
    : "正在按最新版分镜 Skill 准备目标分镜；短片生成一张宫格，长片按自然段落分别生成。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, storyboard_generation_provider = ?, storyboard_source_upload_authorized = 1, storyboard_upload_scope_json = ?, storyboard_ratio_repair_authorized = ?, storyboard_attempt_count = storyboard_attempt_count + ?, storyboard_generation_result_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_STORYBOARD_GENERATION, "storyboard_generation", "storyboard", selectedProvider, JSON.stringify(uploadScope), selectedProvider === "chatgpt_web" && ratioRepairAuthorized ? 1 : 0, resumeIncomplete ? 0 : 1, resumeIncomplete ? "正在接回本次未完成的分段分镜；已完成段落不会重复提交，只继续缺失段落。" : message, now(), taskId);
  addEvent(db, taskId, resumeIncomplete ? "storyboard_generation_resumed" : "storyboard_generation_started", "info", resumeIncomplete ? "正在从已完成分段继续本次任务，不占用新的尝试次数。" : "目标分镜开始生成，数量和分段由最新版分镜 Skill 决定。", { generation_provider: selectedProvider, requested_output_count: "skill_decides_by_duration_and_natural_segments", objective_ratio_repair_max: selectedProvider === "chatgpt_web" ? 1 : 0, upload_scope: uploadScope, resume_incomplete: resumeIncomplete });
  return getTask(db, taskId);
}

export function finishStoryboardGeneration(db, taskId, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const imageArtifact = (result.artifacts || []).find((item) => /\.(png|jpe?g|webp)$/i.test(item.path || ""));
  if (!imageArtifact) throw new Error("STORYBOARD_IMAGE_MISSING");
  const message = result.user_message || "第一版目标分镜已生成，请确认采用或重做。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, storyboard_generation_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.STORYBOARD_REVIEW, "storyboard_review", JSON.stringify(result), message, now(), taskId);
  storeArtifacts(db, taskId, "storyboard", result.artifacts || []);
  addEvent(db, taskId, "storyboard_generation_completed", "info", "目标分镜已生成，等待你的视觉确认。", { approval_status: "needs_review", additional_cost_cny: Number(result.estimated_cost_cny || 0) });
  return getTask(db, taskId);
}

export function failStoryboardGeneration(db, taskId, error, result = null) {
  const hasRejectedCandidate = Boolean((result?.artifacts || []).find((item) => /\.(png|jpe?g|webp)$/i.test(item.path || "")));
  const refundAttempt = !hasRejectedCandidate && result?.external_request_started === false;
  const message = refundAttempt
    ? (result.user_message || "分镜在生图提交前安全停止，本次没有占用生成次数；修复阻断后可以重新尝试。")
    : hasRejectedCandidate
    ? (result.user_message || "图片已经生成，但没有通过分镜硬检查，当前候选不能采用；系统不会自动重试。")
    : "第一版分镜没有生成成功；人物母版和现有拆解成果不受影响，系统不会自动重试。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, storyboard_generation_result_json = ?, last_error = ?, user_message = ?, storyboard_attempt_count = CASE WHEN ? = 1 THEN MAX(storyboard_attempt_count - 1, 0) ELSE storyboard_attempt_count END, updated_at = ? WHERE id = ?")
    .run(STATUSES.STORYBOARD_GENERATION_FAILED, "storyboard_generation", result ? JSON.stringify(result) : null, String(error).slice(0, 2000), message, refundAttempt ? 1 : 0, now(), taskId);
  if (result) storeArtifacts(db, taskId, "storyboard", result.artifacts || []);
  addEvent(db, taskId, refundAttempt ? "storyboard_preflight_blocked" : "storyboard_generation_failed", refundAttempt ? "warning" : "error", hasRejectedCandidate ? "分镜候选已生成，但被硬检查拦截。" : message, { error: String(error).slice(0, 500), automatic_retry: false, rejected_candidate_preserved: hasRejectedCandidate, external_request_started: result?.external_request_started ?? null, attempt_refunded: refundAttempt });
  return getTask(db, taskId);
}

export function approveStoryboard(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.STORYBOARD_REVIEW || !task.storyboard_generation_result) throw new Error("STORYBOARD_APPROVAL_UNAVAILABLE");
  const result = { ...task.storyboard_generation_result, approval_status: "approved" };
  const images = (result.artifacts || []).filter((item) => /\.(png|jpe?g|webp)$/i.test(item.path || ""));
  if (!images.length) throw new Error("STORYBOARD_IMAGE_MISSING");
  result.artifacts = (result.artifacts || []).map((item) => images.some((image) => image.path === item.path) ? { ...item, label: images.length > 1 ? "分段目标分镜（已采用）" : "目标宫格分镜（已采用）", published: true } : item);
  storeArtifacts(db, taskId, "storyboard", images.map((image) => ({ ...image, label: images.length > 1 ? "分段目标分镜（已采用）" : "目标宫格分镜（已采用）", published: true })));
  const message = images.length > 1 ? `已采用 ${images.length} 段目标分镜。第三阶段确认闭环完成；下一步按段做动态预演。` : "目标宫格分镜已采用。第三阶段确认闭环完成；视频动态预演和真实视频生成尚未启动。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, storyboard_generation_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.STORYBOARD_APPROVED, "storyboard_approved", JSON.stringify(result), message, now(), taskId);
  addEvent(db, taskId, "storyboard_approved", "info", "你已确认采用当前目标宫格分镜。", { next_stage: "motion_preflight_not_started" });
  return getTask(db, taskId);
}

export function beginMotionPreflight(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (![STATUSES.STORYBOARD_APPROVED, STATUSES.MOTION_PREFLIGHT_BLOCKED].includes(task.status)) throw new Error("MOTION_PREFLIGHT_UNAVAILABLE");
  const approvedStoryboard = task.artifacts.find((item) => item.stage === "storyboard" && item.published && /分镜/.test(item.label));
  if (!approvedStoryboard?.path) throw new Error("APPROVED_STORYBOARD_MISSING");
  const message = "正在进行动态预演：逐镜检查人物动作、镜头运动和衣物跟随关系；不会生成视频或产生外部费用。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, motion_preflight_result_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_MOTION_PREFLIGHT, "motion_preflight", "motion_preflight", message, now(), taskId);
  addEvent(db, taskId, "motion_preflight_started", "info", "动态预演已开始；本阶段只生成运动蓝图，不会提交视频生成。", { external_request: false, video_generation_started: false });
  return getTask(db, taskId);
}

export function finishMotionPreflight(db, taskId, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const message = result.user_message || "动态预演已经完成，可查看运动蓝图；真实视频生成仍未启动。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, motion_preflight_result_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.MOTION_PREFLIGHT_READY, "motion_preflight_ready", JSON.stringify(result), message, now(), taskId);
  storeArtifacts(db, taskId, "motion_preflight", result.artifacts || []);
  addEvent(db, taskId, "motion_preflight_completed", "info", "动态预演完成，运动蓝图已准备好。", { external_request: false, video_generation_started: false });
  return getTask(db, taskId);
}

export function failMotionPreflight(db, taskId, error, result = null) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const runtimeStartupBlocked = error?.code === "CODEX_RUNTIME_UNAVAILABLE" && error?.business_started === false;
  const message = result?.user_message || (runtimeStartupBlocked
    ? "后台发动机已自动恢复一次，但仍未成功启动；动态预演业务尚未开始，分镜和人物不受影响，稍后可直接重试。"
    : "动态预演没有完成；分镜、人物和拆解成果不受影响，可修复后重新开始。");
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, motion_preflight_result_json = ?, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.MOTION_PREFLIGHT_BLOCKED, "motion_preflight", result ? JSON.stringify(result) : null, String(error).slice(0, 2000), message, now(), taskId);
  if (result) storeArtifacts(db, taskId, "motion_preflight", result.artifacts || []);
  addEvent(db, taskId, runtimeStartupBlocked ? "motion_preflight_runtime_blocked" : "motion_preflight_blocked", runtimeStartupBlocked ? "warning" : "error", message, { error: String(error).slice(0, 500), external_request: false, video_generation_started: false, business_started: error?.business_started ?? null });
  return getTask(db, taskId);
}

export function beginVideoPrompt(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const promptRecoveryStatuses = [
    STATUSES.VIDEO_PROMPT_BLOCKED,
    STATUSES.VIDEO_PROMPT_READY,
    STATUSES.GENERATION_PACK_READY,
    STATUSES.GENERATION_PACK_BLOCKED,
    STATUSES.VIDEO_GENERATION_COMPLETED,
  ];
  const quickRouteReady = task.remix_precision_route === "prompt_driven_remix"
    && ([STATUSES.PERSON_APPROVED, ...promptRecoveryStatuses].includes(task.status)
      || (task.person_route === "generic_no_fixed_face" && task.status === STATUSES.PERSON_INPUTS_READY));
  const contractRecoveryReady = promptRecoveryStatuses.includes(task.status)
    && (task.full_video_quality_revalidation_authorized === true || task.contract_repair_full_video_authorized === true || [STATUSES.VIDEO_PROMPT_READY, STATUSES.GENERATION_PACK_READY, STATUSES.GENERATION_PACK_BLOCKED].includes(task.status));
  const approvedPersonPackageReady = task.status === STATUSES.PERSON_PACKAGE_REVIEW
    && task.person_package_result?.approval_status === "approved";
  if (![STATUSES.MOTION_PREFLIGHT_READY, STATUSES.VIDEO_PROMPT_BLOCKED].includes(task.status) && !quickRouteReady && !contractRecoveryReady && !approvedPersonPackageReady) throw new Error("VIDEO_PROMPT_UNAVAILABLE");
  if (!quickRouteReady && task.motion_preflight_result?.status !== "completed") throw new Error("MOTION_PREFLIGHT_NOT_READY");
  const message = "正在把已通过的分镜和运动蓝图编译成正式视频提示词；不会上传素材或生成视频。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, video_prompt_result_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_VIDEO_PROMPT, "video_prompt", "video_prompt", message, now(), taskId);
  addEvent(db, taskId, "video_prompt_started", "info", "视频提示词编译已开始；当前不会进入付费生成。", { external_request: false, video_generation_started: false });
  return getTask(db, taskId);
}

export function finishVideoPrompt(db, taskId, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const message = result.user_message || "正式视频提示词已经准备好；下一步需要准备视频任务包并单独确认模型和费用。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, video_prompt_result_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.VIDEO_PROMPT_READY, "video_prompt_ready", JSON.stringify(result), message, now(), taskId);
  storeArtifacts(db, taskId, "video_prompt", result.artifacts || []);
  addEvent(db, taskId, "video_prompt_completed", "info", "正式视频提示词和自检已经准备好。", { external_request: false, video_generation_started: false, next_stage: "generation_pack_not_started" });
  return getTask(db, taskId);
}

export function failVideoPrompt(db, taskId, error, result = null) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const message = result?.user_message || "视频提示词没有完成；已有拆解、人物、分镜和运动蓝图不受影响。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, video_prompt_result_json = ?, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.VIDEO_PROMPT_BLOCKED, "video_prompt", result ? JSON.stringify(result) : null, String(error).slice(0, 2000), message, now(), taskId);
  if (result) storeArtifacts(db, taskId, "video_prompt", result.artifacts || []);
  addEvent(db, taskId, "video_prompt_blocked", "error", message, { error: String(error).slice(0, 500), external_request: false, video_generation_started: false });
  return getTask(db, taskId);
}

export function resolveVideoPromptBusinessClaims(db, taskId, { resolution, text = "" } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const legacyContentAuthorityContract =
    task.remix_change_contract?.script?.business_claim_resolution === "remove_unverified_claims"
    || /删除.*逐字口播|人物不说话/.test(task.remix_change_contract?.script?.brief || "");
  const legacyRecoveryStatuses = [
    STATUSES.VIDEO_PROMPT_READY,
    STATUSES.GENERATION_PACK_READY,
    STATUSES.GENERATION_PACK_BLOCKED,
    STATUSES.VIDEO_GENERATION_COMPLETED,
  ];
  if (
    task.status !== STATUSES.VIDEO_PROMPT_BLOCKED
    && !(legacyContentAuthorityContract && legacyRecoveryStatuses.includes(task.status))
  ) throw new Error("VIDEO_PROMPT_RESOLUTION_UNAVAILABLE");
  const cleanText = String(text || "").trim();
  const preserveSourceContent = [
    "preserve_source_content",
    // 兼容旧页面尚未刷新时提交的值，但不再执行删台词或静音逻辑。
    "remove_unverified_claims",
    "confirmed_claims",
  ].includes(resolution);
  const script = preserveSourceContent
    ? {
        mode: "keep_structure",
        brief: "忠实执行参考片中可提取的逐字内容以及用户已提交的文案和营销表达。它们是本次创作输入，工作台不审查、不要求举证、不擅自删改、不把人物改成静音。只禁止 AI 凭空新增输入中不存在的价格、功效、销量、服务范围或其他事实。",
        content_authority: "user_and_source_inputs",
        review_policy: "warn_only_non_blocking",
        business_claim_resolution: "preserve_source_content",
      }
    : resolution === "use_own_copy"
        ? {
            mode: "use_own_copy",
            brief: cleanText,
            business_claim_resolution: resolution,
          }
        : null;
  if (!script) throw new Error("VIDEO_PROMPT_RESOLUTION_INVALID");
  if (!preserveSourceContent && !cleanText) throw new Error("VIDEO_PROMPT_RESOLUTION_TEXT_REQUIRED");
  const contract = {
    ...(task.remix_change_contract || {}),
    script,
  };
  const message = preserveSourceContent
    ? "已保留参考片和用户提交的内容；工作台不再审查或擅自改成静音，正在重新整理生成方案。"
    : "已改用你提供的完整文案，正在重新整理生成方案。";
  db.prepare("UPDATE tasks SET remix_change_contract_json = ?, video_prompt_result_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(contract), message, now(), taskId);
  addEvent(db, taskId, "video_prompt_business_claims_resolved", "info", message, {
    resolution: preserveSourceContent ? "preserve_source_content" : resolution,
    review_policy: preserveSourceContent ? "warn_only_non_blocking" : undefined,
    legacy_contract_repaired: legacyContentAuthorityContract,
    external_request: false,
    video_generation_started: false,
  });
  return getTask(db, taskId);
}

export function beginGenerationPack(db, taskId, generationRouteChoice, generationModelSelection) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const h3SafetyPackageRecovery = generationModelSelection?.provider === "runninghub_h3_multiref"
    && [STATUSES.PERSON_PACKAGE_REQUIRED, STATUSES.PERSON_PACKAGE_FAILED].includes(task.status)
    && task.video_prompt_result?.status === "completed";
  const authorizedFullContinuation = task.status === STATUSES.VIDEO_GENERATION_COMPLETED
    && (task.full_video_generation_authorized === true || task.full_video_quality_revalidation_authorized === true || task.contract_repair_full_video_authorized === true)
    && generationRouteChoice === "in_chat_libtv_generation";
  if (![STATUSES.VIDEO_PROMPT_READY, STATUSES.GENERATION_PACK_READY, STATUSES.GENERATION_PACK_BLOCKED, STATUSES.PERSON_PACKAGE_REVIEW].includes(task.status) && !authorizedFullContinuation && !h3SafetyPackageRecovery) throw new Error("GENERATION_PACK_UNAVAILABLE");
  if (!["smoke_test_first", "full_external_manual", "in_chat_libtv_generation"].includes(generationRouteChoice)) throw new Error("GENERATION_ROUTE_INVALID");
  if (!generationModelSelection?.model_key) throw new Error("GENERATION_MODEL_REQUIRED");
  if (task.video_prompt_result?.status !== "completed") throw new Error("VIDEO_PROMPT_NOT_READY");
  const message = "正在按你选择的路线整理视频任务包，并核对素材、提示词和生成参数；不会提交真实视频生成。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, generation_route_choice = ?, generation_provider = ?, generation_quality_profile = ?, generation_model_key = ?, generation_model_snapshot_json = ?, generation_pack_result_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_GENERATION_PACK, "generation_pack", "generation_pack", generationRouteChoice, generationModelSelection.provider || "libtv", generationModelSelection.quality_profile || "high", generationModelSelection.model_key, JSON.stringify(generationModelSelection), message, now(), taskId);
  addEvent(db, taskId, "generation_pack_started", "info", "视频任务包准备已开始；当前不会上传素材或产生视频生成费用。", { generation_route_choice: generationRouteChoice, generation_model_key: generationModelSelection.model_key, external_request: false, video_generation_started: false });
  return getTask(db, taskId);
}

export function prepareDirectVideoGeneration(db, taskId, generationRouteChoice = "smoke_test_first", generationModelSelection) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (![STATUSES.VIDEO_PROMPT_READY, STATUSES.GENERATION_PACK_BLOCKED, STATUSES.PERSON_PACKAGE_REQUIRED, STATUSES.PERSON_PACKAGE_FAILED].includes(task.status)) throw new Error("VIDEO_GENERATION_PREPARATION_UNAVAILABLE");
  if (!['smoke_test_first', 'full_external_manual', 'in_chat_libtv_generation'].includes(generationRouteChoice)) throw new Error("GENERATION_ROUTE_INVALID");
  if (!generationModelSelection?.model_key) throw new Error("GENERATION_MODEL_REQUIRED");
  if (task.video_prompt_result?.status !== "completed") throw new Error("VIDEO_PROMPT_NOT_READY");
  const fixedFace = ["auto_ai_person", "authorized_person"].includes(task.person_route);
  const seedanceSafetyRoute = fixedFace && (generationModelSelection.provider || "libtv") === "libtv";
  const requiredAssets = seedanceSafetyRoute ? [
    "服装人物多视图锚点",
    "三道红线遮脸版",
    "局部材质拼图",
    ...(task.remix_precision_route === "anchor_frame_alignment" ? ["分镜安全提交版"] : []),
  ] : [];
  const approvedLabels = task.artifacts.filter((item) => item.stage === "person_package" && item.published).map((item) => item.label || "");
  const assetAliases = {
    "服装人物多视图锚点": /服装人物多视图/,
    "三道红线遮脸版": /三道红线|人物三条红线安全参考/,
    "局部材质拼图": /局部材质拼图/,
    "分镜安全提交版": /分镜安全提交版|目标故事板安全提交版/,
  };
  const missingAssets = requiredAssets.filter((label) => !approvedLabels.some((actual) => (assetAliases[label] || new RegExp(`^${label}$`)).test(actual)));
  if (seedanceSafetyRoute && missingAssets.length > 0) {
    const result = {
      status: "requires_person_package",
      required_assets: requiredAssets,
      missing_assets: missingAssets,
      optional_assets: [],
      estimated_cost_cny: 0,
      external_request_started: false,
      video_generation_started: false,
    };
    const message = `开始生成前检查发现固定人物脸还缺少 ${missingAssets.join("、")}。系统会合并补齐并一次确认，不会把这些必需资产拆成多次人工操作。`;
    db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, generation_route_choice = ?, generation_provider = ?, generation_quality_profile = ?, generation_model_key = ?, generation_model_snapshot_json = ?, person_package_result_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
      .run(STATUSES.PERSON_PACKAGE_REQUIRED, "person_package_required", generationRouteChoice, generationModelSelection.provider || "libtv", generationModelSelection.quality_profile || "high", generationModelSelection.model_key, JSON.stringify(generationModelSelection), JSON.stringify(result), message, now(), taskId);
    addEvent(db, taskId, "person_package_required", "warning", "生成前检查发现人物资产不完整，已暂停在一次性授权前。", { required_assets: result.required_assets, generation_provider: generationModelSelection.provider || "libtv", generation_model_key: generationModelSelection.model_key, external_request: false, video_generation_started: false });
    return { task: getTask(db, taskId), readyForPack: false };
  }
  return { task, readyForPack: true };
}

export function beginPersonPackageGeneration(db, taskId, { sourceUploadAuthorized, generationProvider }) {
  let task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (![STATUSES.PERSON_PACKAGE_REQUIRED, STATUSES.PERSON_PACKAGE_REVIEW, STATUSES.PERSON_PACKAGE_FAILED].includes(task.status)) throw new Error("PERSON_PACKAGE_GENERATION_UNAVAILABLE");
  if (sourceUploadAuthorized !== true) throw new Error("PERSON_PACKAGE_UPLOAD_AUTHORIZATION_REQUIRED");
  if (task.status === STATUSES.PERSON_PACKAGE_REVIEW && task.person_package_result?.business_qc_status !== "pass") {
    const findings = task.person_package_result?.qc_findings || [];
    const missingAssets = [
      ...(findings.some((item) => /局部材质|五官材质/.test(item)) ? ["局部材质拼图"] : []),
      ...(findings.some((item) => /红线/.test(item)) ? ["三道红线遮脸版"] : []),
    ];
    if (!missingAssets.length) throw new Error("PERSON_PACKAGE_REWORK_SCOPE_UNKNOWN");
    const rejectedArtifacts = (task.person_package_result.artifacts || []).filter((item) => missingAssets.includes(item.label));
    const preservedArtifacts = (task.person_package_result.artifacts || []).filter((item) => !missingAssets.includes(item.label) && /\.(png|jpe?g|webp)$/i.test(item.path || ""));
    const rework = {
      ...task.person_package_result,
      status: "partial_blocked",
      checkpoint_resume_available: true,
      checkpoint_source_run_id: task.person_package_result?.checkpoint_resume?.source_run_id || null,
      required_assets: ["服装人物多视图锚点", "三道红线遮脸版", "局部材质拼图", ...(task.remix_precision_route === "anchor_frame_alignment" ? ["分镜安全提交版"] : [])],
      missing_assets: missingAssets,
      artifacts: preservedArtifacts,
      rejected_artifacts: rejectedArtifacts,
      requires_confirmation: true,
      user_message: `已保留 ${preservedArtifacts.length} 项合格资产，只修复${missingAssets.join("、")}。`,
    };
    db.prepare("UPDATE tasks SET status = ?, current_step = ?, person_package_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
      .run(STATUSES.PERSON_PACKAGE_FAILED, "person_package", JSON.stringify(rework), rework.user_message, now(), taskId);
    addEvent(db, taskId, "person_package_rework_prepared", "warning", "人物资产已进入断点修复，只处理质检未通过的项目。", { missing_assets: missingAssets, preserved_count: preservedArtifacts.length });
    task = getTask(db, taskId);
  }
  const checkpointResume = task.person_package_result?.checkpoint_resume_available === true;
  if (task.person_package_attempt_count >= 2 && !checkpointResume) throw new Error("PERSON_PACKAGE_ATTEMPT_LIMIT_REACHED");
  const selectedProvider = generationProvider || task.default_image_generation_provider || "codex_builtin";
  if (!["codex_builtin", "chatgpt_web"].includes(selectedProvider)) throw new Error("PERSON_GENERATION_PROVIDER_INVALID");
  const runId = randomUUID();
  const startedAt = now();
  const message = checkpointResume
    ? `正在复用已有 ${task.person_package_result?.artifacts?.length || 0} 项人物资产，只补缺失内容；不会重新生成已有图片。`
    : "正在一次性补齐固定人物脸的视频安全资产；不会生成无关资产，也不会提交视频。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, active_run_id = ?, active_run_started_at = ?, active_external_request_started = 0, person_package_generation_provider = ?, person_package_source_upload_authorized = 1, person_package_attempt_count = person_package_attempt_count + ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_PERSON_PACKAGE, "person_package", "person_package", runId, startedAt, selectedProvider, checkpointResume ? 0 : 1, message, startedAt, taskId);
  addEvent(db, taskId, "person_package_generation_started", "info", checkpointResume ? "人物资产断点续做已开始，只处理缺失项。" : "固定人物脸安全资产包补全已开始。", { run_id: runId, generation_provider: selectedProvider, required_assets: task.person_package_result?.missing_assets || task.person_package_result?.required_assets || [], automatic_retry: false, checkpoint_resume: checkpointResume });
  return getTask(db, taskId);
}

export function isCurrentTaskRun(db, taskId, stage, runId) {
  if (!runId) return false;
  const row = db.prepare("SELECT status, active_stage, active_run_id FROM tasks WHERE id = ?").get(taskId);
  const expectedStatus = stage === "person_package" ? STATUSES.RUNNING_PERSON_PACKAGE : null;
  return Boolean(row && row.active_stage === stage && row.active_run_id === runId && (!expectedStatus || row.status === expectedStatus));
}

export function recordTaskRunProgress(db, taskId, stage, runId, message) {
  const visible = String(message || "").slice(0, 300);
  if (!visible || !isCurrentTaskRun(db, taskId, stage, runId)) return false;
  const stamp = now();
  const changed = db.prepare("UPDATE tasks SET user_message = ?, updated_at = ? WHERE id = ? AND active_stage = ? AND active_run_id = ?").run(visible, stamp, taskId, stage, runId);
  if (changed.changes !== 1) return false;
  addEvent(db, taskId, `${stage}_progress`, "info", visible, { run_id: runId });
  return true;
}

export function markTaskRunExternalRequestStarted(db, taskId) {
  const changed = db.prepare("UPDATE tasks SET active_external_request_started = 1, updated_at = ? WHERE id = ? AND active_run_id IS NOT NULL AND active_stage = ?").run(now(), taskId, "person_package");
  return changed.changes === 1;
}

export function finishPersonPackageGeneration(db, taskId, result, { runId = null } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (runId && !isCurrentTaskRun(db, taskId, "person_package", runId)) return task;
  const requiredAssets = task.person_package_result?.missing_assets || task.person_package_result?.required_assets || [];
  const labels = new Set((result.artifacts || []).filter((item) => /\.(png|jpe?g|webp)$/i.test(item.path || "")).map((item) => item.label));
  const missing = requiredAssets.filter((label) => !labels.has(label) && !task.artifacts.some((item) => item.stage === "person_package" && item.published && item.label === label));
  if (missing.length > 0) throw new Error(`PERSON_PACKAGE_ASSETS_MISSING:${missing.join("、")}`);
  const message = result.user_message || "固定人物脸安全资产包已经生成，请合并确认人物、穿搭和安全衍生图是否一致。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, active_run_id = NULL, active_run_started_at = NULL, active_external_request_started = 0, person_package_result_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.PERSON_PACKAGE_REVIEW, "person_package_review", JSON.stringify(result), message, now(), taskId);
  storeArtifacts(db, taskId, "person_package", result.artifacts || []);
  addEvent(db, taskId, "person_package_generation_completed", "info", "固定人物脸安全资产包已生成，等待一次合并确认。", { approval_status: "needs_review", required_assets: requiredAssets });
  return getTask(db, taskId);
}

export function failPersonPackageGeneration(db, taskId, error, result = null, { runId = null } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (runId && !isCurrentTaskRun(db, taskId, "person_package", runId)) return task;
  const externalRequestStarted = result?.external_request_started === false
    ? false
    : task.active_external_request_started === true || result?.external_request_started === true;
  const explicitlyBeforeExternalRequest = result?.external_request_started === false || error?.external_request_started === false;
  const checkpointResume = task.person_package_result?.checkpoint_resume_available === true;
  const refundedBeforeExternalRequest = explicitlyBeforeExternalRequest && !externalRequestStarted && !checkpointResume;
  const failureResult = result ? {
    ...result,
    required_assets: result.required_assets || task?.person_package_result?.required_assets || [],
    missing_assets: result.missing_assets || task?.person_package_result?.missing_assets || task?.person_package_result?.required_assets || [],
  } : task?.person_package_result || null;
  const message = checkpointResume
    ? `已有 ${task.person_package_result?.artifacts?.length || 0} 项人物资产仍然保留，只剩 ${task.person_package_result?.missing_assets?.length || 1} 项未完成。系统不会自动重复提交。`
    : externalRequestStarted
      ? "人物资产没有生成完整，现有人物和分镜仍然保留。系统不会自动重复提交；继续前会先核对已有结果。"
      : "人物资产还未生成，本次没有产生新的生图费用。系统会复用已确认的人物和分镜继续处理；不会提交视频。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, active_run_id = NULL, active_run_started_at = NULL, active_external_request_started = 0, person_package_result_json = ?, person_package_attempt_count = CASE WHEN ? = 1 THEN MAX(person_package_attempt_count - 1, 0) ELSE person_package_attempt_count END, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.PERSON_PACKAGE_FAILED, "person_package", failureResult ? JSON.stringify(failureResult) : null, refundedBeforeExternalRequest ? 1 : 0, String(error).slice(0, 2000), message, now(), taskId);
  if (result) storeArtifacts(db, taskId, "person_package", result.artifacts || []);
  addEvent(db, taskId, "person_package_generation_failed", "error", message, { automatic_retry: false, attempt_refunded: refundedBeforeExternalRequest, external_request_started: externalRequestStarted, error: String(error).slice(0, 500) });
  return getTask(db, taskId);
}

export function approvePersonPackage(db, taskId) {
  const task = getTask(db, taskId);
  if (!task || task.status !== STATUSES.PERSON_PACKAGE_REVIEW || !task.person_package_result) throw new Error("PERSON_PACKAGE_APPROVAL_UNAVAILABLE");
  if (task.person_package_result.business_qc_status !== "pass") throw new Error("PERSON_PACKAGE_BUSINESS_QC_NOT_PASSED");
  const result = { ...task.person_package_result, approval_status: "approved" };
  const images = task.artifacts.filter((item) => item.stage === "person_package" && /\.(png|jpe?g|webp)$/i.test(item.path));
  if (!images.length) throw new Error("PERSON_PACKAGE_IMAGE_MISSING");
  const publish = db.prepare("UPDATE artifacts SET published = 1 WHERE id = ?");
  for (const image of images) publish.run(image.id);
  db.prepare("UPDATE tasks SET person_package_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(result), "必要人物资产已经确认，系统正在后台完成生成前检查。", now(), taskId);
  addEvent(db, taskId, "person_package_approved", "info", "必要人物资产已采用，后台继续编译生成前检查。", { next_stage: "generation_pack_internal" });
  return getTask(db, taskId);
}

export function getArtifact(db, taskId, artifactId) {
  return db.prepare("SELECT * FROM artifacts WHERE task_id = ? AND id = ?").get(taskId, artifactId) || null;
}

export function finishGenerationPack(db, taskId, result) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const message = result.user_message || "视频任务包已经准备好；真实生成仍需单独确认模型、积分和费用。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, generation_pack_result_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.GENERATION_PACK_READY, "generation_pack_ready", JSON.stringify(result), message, now(), taskId);
  storeArtifacts(db, taskId, "generation_pack", result.artifacts || []);
  addEvent(db, taskId, "generation_pack_completed", "info", "视频任务包和生成前检查已经准备好。", { generation_route_choice: task.generation_route_choice, external_request: false, video_generation_started: false, billable_confirmation_required: task.generation_route_choice === "in_chat_libtv_generation" });
  return getTask(db, taskId);
}

export function failGenerationPack(db, taskId, error, result = null) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const message = result?.user_message || "视频任务包预检没有通过；上游人物、分镜、动态预演和提示词仍然保留。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, generation_pack_result_json = ?, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.GENERATION_PACK_BLOCKED, "generation_pack", result ? JSON.stringify(result) : null, String(error).slice(0, 2000), message, now(), taskId);
  if (result) storeArtifacts(db, taskId, "generation_pack", result.artifacts || []);
  addEvent(db, taskId, "generation_pack_blocked", "error", message, { error: String(error).slice(0, 500), generation_route_choice: task.generation_route_choice, external_request: false, video_generation_started: false });
  return getTask(db, taskId);
}

export function beginVideoGeneration(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.GENERATION_PACK_READY) throw new Error("VIDEO_GENERATION_UNAVAILABLE");
  const expectedPromptUnit = task.generation_route_choice === "smoke_test_first" ? "smoke_test" : "full_sequence";
  if (task.video_prompt_result?.prompt_generation_unit_choice !== expectedPromptUnit || task.video_prompt_result?.prompt_generation_asset_contract_status !== "matched") {
    throw new Error("VIDEO_PROMPT_NOT_ALIGNED_WITH_CURRENT_GENERATION_SELECTION");
  }
  const provider = task.generation_model_snapshot?.provider || task.generation_provider || "libtv";
  if (provider === "libtv" && !task.libtv_project_uuid) throw new Error("LIBTV_PROJECT_NOT_REGISTERED");
  const preview = task.generation_pack_result?.submission_preview;
  if (!preview || !Number.isInteger(preview.generation_count) || preview.generation_count < 1 || preview.generation_count > 5 || preview.automatic_retry !== false) throw new Error("VIDEO_GENERATION_CONTRACT_INVALID");
  const fullSequence = preview.generation_kind === "full_sequence" || task.generation_route_choice === "in_chat_libtv_generation";
  const qualityRevalidation = task.video_generation_attempt_count === 1 && task.video_quality_revalidation_authorized === true;
  const legacyRestoredFullQualityAuthorization = task.full_video_generation_attempt_count === 1
    && task.full_video_generation_authorized === true
    && task.full_video_quality_revalidation_authorized !== true;
  const fullQualityRevalidation = task.full_video_generation_attempt_count === 1
    && (task.full_video_quality_revalidation_authorized === true || legacyRestoredFullQualityAuthorization);
  const contractRepairFullValidation = task.full_video_generation_attempt_count === 2
    && task.contract_repair_full_video_authorized === true;
  if (fullSequence) {
    const firstFullAuthorized = task.full_video_generation_attempt_count === 0;
    if (!firstFullAuthorized && !fullQualityRevalidation && !contractRepairFullValidation) throw new Error("FULL_VIDEO_GENERATION_NOT_AUTHORIZED");
  } else if (task.video_generation_attempt_count >= 1 && !qualityRevalidation) throw new Error("VIDEO_GENERATION_ATTEMPT_ALREADY_USED");
  const runId = randomUUID();
  const startedAt = now();
  const message = provider === "libtv"
    ? "正在把已确认的安全素材送入专属画布，并执行一次视频生成；不会自动重试或换模型。"
    : "正在把本次清晰人物、分镜与材质参考送入 RunningHub，并执行一次视频生成；不会自动重试或换模型。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, active_run_id = ?, active_run_started_at = ?, active_external_request_started = 0, video_generation_attempt_count = video_generation_attempt_count + ?, full_video_generation_attempt_count = full_video_generation_attempt_count + ?, video_quality_revalidation_authorized = 0, full_video_generation_authorized = 0, full_video_quality_revalidation_authorized = 0, contract_repair_full_video_authorized = 0, video_generation_result_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_VIDEO_GENERATION, "video_generation", "video_generation", runId, startedAt, fullSequence ? 0 : 1, fullSequence ? 1 : 0, message, startedAt, taskId);
  addEvent(db, taskId, "video_generation_started", "info", "一次性视频生成流程已开始。", {
    run_id: runId,
    provider,
    project_uuid: provider === "libtv" ? task.libtv_project_uuid : null,
    model_key: preview.model_key,
    duration_seconds: preview.duration_seconds,
    generation_count: preview.generation_count,
    automatic_retry: false,
  });
  return getTask(db, taskId);
}

export function authorizeFullVideoGeneration(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.VIDEO_GENERATION_COMPLETED || task.full_video_generation_attempt_count !== 0 || !task.video_generation_result) throw new Error("FULL_VIDEO_GENERATION_UNAVAILABLE");
  const message = "已保留现有小样；正在按同一模型准备一次完整版生成。不会自动重试或换模型。";
  db.prepare("UPDATE tasks SET full_video_generation_authorized = 1, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(message, now(), taskId);
  addEvent(db, taskId, "full_video_generation_authorized", "info", message, { preserved_samples: true, allowed_full_submissions: 1, automatic_retry: false });
  return getTask(db, taskId);
}

export function authorizeVideoQualityRevalidation(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.VIDEO_GENERATION_COMPLETED || task.video_generation_attempt_count !== 1 || !task.video_generation_result) {
    throw new Error("VIDEO_QUALITY_REVALIDATION_UNAVAILABLE");
  }
  const message = "旧小样已作为质量对照保留；正在重建一次修复后的 4 秒验证资料。不会自动重试或换模型。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, video_quality_revalidation_authorized = 1, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.GENERATION_PACK_READY, "generation_pack_ready", message, now(), taskId);
  addEvent(db, taskId, "video_quality_revalidation_authorized", "warning", message, { preserved_attempt: 1, allowed_additional_submissions: 1, automatic_retry: false });
  return getTask(db, taskId);
}

export function authorizeFullVideoQualityRevalidation(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.VIDEO_GENERATION_COMPLETED || task.full_video_generation_attempt_count !== 1 || task.video_generation_result?.generation_kind !== "full_sequence") {
    throw new Error("FULL_VIDEO_QUALITY_REVALIDATION_UNAVAILABLE");
  }
  const message = "旧完整版已作为失败证据保留；正在按新版提示词和参考图绑定合同重建一次正式版资料。当前不会提交或扣积分。";
  db.prepare("UPDATE tasks SET full_video_quality_revalidation_authorized = 1, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(message, now(), taskId);
  addEvent(db, taskId, "full_video_quality_revalidation_authorized", "warning", message, { preserved_full_attempt: 1, allowed_additional_submissions: 1, automatic_retry: false, external_request_started: false });
  return getTask(db, taskId);
}

export function prepareVideoReworkRequest(db, taskId, request) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (
    task.status !== STATUSES.VIDEO_GENERATION_COMPLETED ||
    task.video_generation_result?.generation_kind !== "full_sequence"
  )
    throw new Error("VIDEO_REWORK_UNAVAILABLE");
  const selectedSegmentIds = Array.isArray(request?.selected_segment_ids)
    ? [...new Set(request.selected_segment_ids.map((value) => String(value)))]
    : [];
  const issueCodes = Array.isArray(request?.issue_codes)
    ? [...new Set(request.issue_codes.map((value) => String(value)))]
    : [];
  if (!selectedSegmentIds.length) throw new Error("VIDEO_REWORK_SEGMENT_REQUIRED");
  if (!issueCodes.length && !String(request?.note || "").trim())
    throw new Error("VIDEO_REWORK_REASON_REQUIRED");
  const normalized = {
    schema_version: 1,
    status: "prepared",
    created_at: now(),
    selected_segment_ids: selectedSegmentIds,
    preserved_segment_ids: Array.isArray(request.preserved_segment_ids)
      ? request.preserved_segment_ids.map((value) => String(value))
      : [],
    issue_codes: issueCodes,
    note: String(request.note || "").trim().slice(0, 800),
    provider: request.provider || task.generation_provider || "libtv",
    model_key:
      request.model_key ||
      task.generation_model_key ||
      task.video_generation_result?.model_key ||
      null,
    quality_profile:
      request.quality_profile || task.generation_quality_profile || "high",
    estimated_submission_count: Number(request.estimated_submission_count || 1),
    resolution_mode:
      request.resolution_mode === "direct_retry"
        ? "direct_retry"
        : "analyze_then_retry",
    automatic_retry: false,
    external_request_started: false,
    next_action:
      request.resolution_mode === "direct_retry"
        ? "confirm_direct_retry"
        : "codex_prepare_rework_plan",
  };
  const message = `已记录 ${selectedSegmentIds.length} 个需要调整的片段；其他片段继续保留。当前没有提交生成，也没有产生新费用。`;
  db.prepare(
    "UPDATE tasks SET video_rework_request_json = ?, video_rework_plan_json = NULL, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(normalized), message, now(), taskId);
  addEvent(db, taskId, "video_rework_request_prepared", "info", message, {
    selected_segment_ids: selectedSegmentIds,
    preserved_segment_ids: normalized.preserved_segment_ids,
    issue_codes: issueCodes,
    provider: normalized.provider,
    model_key: normalized.model_key,
    quality_profile: normalized.quality_profile,
    estimated_submission_count: normalized.estimated_submission_count,
    automatic_retry: false,
    external_request_started: false,
  });
  return getTask(db, taskId);
}

export function saveVideoReworkPlan(db, taskId, plan) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.video_rework_request?.status !== "prepared")
    throw new Error("VIDEO_REWORK_REQUEST_NOT_PREPARED");
  const selected = task.video_rework_request.selected_segment_ids || [];
  if (
    plan?.status !== "ready_for_confirmation" ||
    JSON.stringify(plan.selected_segment_ids || []) !== JSON.stringify(selected)
  )
    throw new Error("VIDEO_REWORK_PLAN_MISMATCH");
  if (
    task.video_rework_plan?.source_fingerprint === plan.source_fingerprint &&
    task.video_rework_plan?.status === plan.status
  )
    return task;
  const message = `返工方案已经准备好：保留 ${plan.preserved_segment_ids.length} 段，重新生成 ${plan.selected_segment_ids.length} 段。确认前不会上传或扣费。`;
  db.prepare(
    "UPDATE tasks SET video_rework_plan_json = ?, user_message = ?, last_error = NULL, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(plan), message, now(), taskId);
  addEvent(db, taskId, "video_rework_plan_ready", "info", message, {
    selected_segment_ids: plan.selected_segment_ids,
    preserved_segment_ids: plan.preserved_segment_ids,
    provider: plan.provider,
    model_key: plan.model_key,
    quality_profile: plan.quality_profile,
    estimated_submission_count: plan.estimated_submission_count,
    automatic_retry: false,
    external_request_started: false,
  });
  return getTask(db, taskId);
}

export function beginVideoReworkGeneration(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const plan = task.video_rework_plan;
  if (
    task.status !== STATUSES.VIDEO_GENERATION_COMPLETED ||
    plan?.status !== "ready_for_confirmation" ||
    plan.external_request_started !== false ||
    plan.automatic_retry !== false
  )
    throw new Error("VIDEO_REWORK_GENERATION_UNAVAILABLE");
  const runId = randomUUID();
  const startedAt = now();
  const runningPlan = {
    ...plan,
    status: "running",
    confirmed_at: startedAt,
    base_version_result: task.video_generation_result,
  };
  const nextVersion = Number(plan.version_contract?.next_version || 2);
  const message = `正在重新生成 ${plan.selected_segment_ids.length} 个选中片段并建立版本 ${nextVersion}；所有旧版本保持不变，不会自动重试。`;
  db.prepare(
    "UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, active_run_id = ?, active_run_started_at = ?, active_external_request_started = 0, video_rework_plan_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?",
  ).run(
    STATUSES.RUNNING_VIDEO_GENERATION,
    "video_rework_generation",
    "video_rework_generation",
    runId,
    startedAt,
    JSON.stringify(runningPlan),
    message,
    startedAt,
    taskId,
  );
  addEvent(db, taskId, "video_rework_generation_started", "info", message, {
    run_id: runId,
    selected_segment_ids: plan.selected_segment_ids,
    preserved_segment_ids: plan.preserved_segment_ids,
    estimated_submission_count: plan.estimated_submission_count,
    automatic_retry: false,
  });
  return getTask(db, taskId);
}

export function finishVideoReworkGeneration(db, taskId, result, { runId = null } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (
    runId &&
    (task.active_stage !== "video_rework_generation" || task.active_run_id !== runId)
  )
    return task;
  const resultVersion = Number(
    result.rework_version || task.video_rework_plan?.version_contract?.next_version || 2,
  );
  const completedPlan = {
    ...task.video_rework_plan,
    status: "completed",
    completed_at: now(),
    external_request_started: true,
    result_version: resultVersion,
  };
  const message = result.user_message || `选中片段已经重新生成并合成为版本 ${resultVersion}；所有旧版本继续保留。`;
  db.prepare(
    "UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, active_run_id = NULL, active_run_started_at = NULL, active_external_request_started = 0, video_generation_result_json = ?, video_rework_plan_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?",
  ).run(
    STATUSES.VIDEO_GENERATION_COMPLETED,
    "video_rework_completed",
    JSON.stringify(result),
    JSON.stringify(completedPlan),
    message,
    now(),
    taskId,
  );
  storeArtifacts(db, taskId, "video_generation", result.artifacts || []);
  addEvent(db, taskId, "video_rework_generation_completed", "info", message, {
    run_id: runId,
    result_version: resultVersion,
    replaced_segment_ids: completedPlan.selected_segment_ids,
    preserved_segment_ids: completedPlan.preserved_segment_ids,
    points_used: result.points_used ?? null,
  });
  return getTask(db, taskId);
}

export function approveVideoResult(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (
    task.status !== STATUSES.VIDEO_GENERATION_COMPLETED ||
    !task.video_generation_result
  )
    throw new Error("VIDEO_RESULT_APPROVAL_UNAVAILABLE");

  if (task.video_generation_result.user_approval_status === "approved")
    return task;

  const approvedAt = now();
  const resultVersion = Number(
    task.video_generation_result.rework_version ||
      task.video_rework_plan?.result_version ||
      1,
  );
  const qualityQc = task.video_generation_result.quality_qc || {};
  const qualityWarningKept =
    qualityQc.decision === "reject" ||
    qualityQc.business_qc_status === "needs_rework" ||
    task.video_generation_result.quality_qc_status === "needs_rework";
  const result = {
    ...task.video_generation_result,
    user_approval_status: "approved",
    user_approved_at: approvedAt,
    user_approved_version: resultVersion,
    user_approval_overrode_qc: qualityWarningKept,
  };
  const message = qualityWarningKept
    ? `你已看过并采用版本 ${resultVersion}；自动质检提醒继续保留，旧版本也不会删除。`
    : `你已确认采用版本 ${resultVersion}，旧版本继续保留。`;
  db.prepare(
    "UPDATE tasks SET current_step = ?, video_generation_result_json = ?, user_message = ?, updated_at = ? WHERE id = ?",
  ).run(
    "video_result_approved",
    JSON.stringify(result),
    message,
    approvedAt,
    taskId,
  );
  addEvent(db, taskId, "video_result_approved", "info", message, {
    result_version: resultVersion,
    quality_warning_kept: qualityWarningKept,
    old_versions_preserved: true,
  });
  return getTask(db, taskId);
}

export function failVideoReworkGeneration(db, taskId, error, { runId = null } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (
    runId &&
    (task.active_stage !== "video_rework_generation" || task.active_run_id !== runId)
  )
    return task;
  const externalRequestStarted = task.active_external_request_started === true || error?.external_request_started === true;
  const restoredPlan = {
    ...task.video_rework_plan,
    status: "ready_for_confirmation",
    external_request_started: false,
    last_failure_after_submission: externalRequestStarted,
  };
  const localStitchFailed = /RUNNINGHUB_H3_STITCH_FAILED/.test(String(error));
  const message = localStitchFailed
    ? "新返工片段已经返回，但本地重新合成没有完成；新片段和所有旧版本均已保留，再次继续只恢复本地合成，不会重复提交。"
    : externalRequestStarted
    ? "返工片段没有正常返回；版本 1 和所有旧片段仍然保留，系统没有自动重试。"
    : "返工提交前检查没有通过；版本 1 和本次返工方案仍然保留，没有产生费用。";
  db.prepare(
    "UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, active_run_id = NULL, active_run_started_at = NULL, active_external_request_started = 0, video_rework_plan_json = ?, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?",
  ).run(
    STATUSES.VIDEO_GENERATION_COMPLETED,
    "video_rework_ready",
    JSON.stringify(restoredPlan),
    String(error).slice(0, 2000),
    message,
    now(),
    taskId,
  );
  addEvent(db, taskId, "video_rework_generation_failed", externalRequestStarted ? "error" : "warning", message, {
    run_id: runId,
    external_request_started: externalRequestStarted,
    automatic_retry: false,
    error: String(error).slice(0, 500),
  });
  return getTask(db, taskId);
}

export function authorizeContractRepairFullVideoValidation(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const qcText = [task.video_generation_result?.quality_qc?.summary, task.video_generation_result?.quality_qc?.user_message].filter(Boolean).join("\n");
  const rejected = task.video_generation_result?.quality_qc?.decision === "reject"
    || task.video_generation_result?.quality_qc?.business_qc_status === "needs_rework"
    || /不通过|不能采用|暂时不能采用|命中.*硬闸门|reject|needs_rework/i.test(qcText);
  if (task.status !== STATUSES.VIDEO_GENERATION_COMPLETED || task.full_video_generation_attempt_count !== 2 || task.video_generation_result?.generation_kind !== "full_sequence" || !rejected) {
    throw new Error("CONTRACT_REPAIR_FULL_VIDEO_VALIDATION_UNAVAILABLE");
  }
  const message = "旧完整版继续保留；已按本次明确授权开放一次三方合同修复后的完整验证。先重新编译提示词和任务包，当前尚未提交或扣积分。";
  db.prepare("UPDATE tasks SET contract_repair_full_video_authorized = 1, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(message, now(), taskId);
  addEvent(db, taskId, "contract_repair_full_video_authorized", "warning", message, { preserved_full_attempts: 2, allowed_additional_submissions: 1, automatic_retry: false, external_request_started: false });
  return getTask(db, taskId);
}

export function resumeVideoGenerationResult(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== STATUSES.VIDEO_GENERATION_FAILED || (task.video_generation_attempt_count < 1 && task.full_video_generation_attempt_count < 1)) throw new Error("VIDEO_GENERATION_RESULT_RESUME_UNAVAILABLE");
  if (task.video_generation_result?.external_request_started !== true) {
    const fullSequence = task.generation_route_choice === "in_chat_libtv_generation";
    const restoreQualityRevalidation = !fullSequence && task.video_generation_attempt_count === 2;
    const restoreFirstFullAuthorization = fullSequence && task.full_video_generation_attempt_count === 1;
    const restoreFullQualityAuthorization = fullSequence && task.full_video_generation_attempt_count === 2;
    const restoreContractRepairAuthorization = fullSequence && task.full_video_generation_attempt_count === 3;
    const restoredAt = now();
    const restoredMessage = "上次停在上传前检查，没有提交或扣积分；正在沿用原确认继续同一次检查。";
    db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, active_run_id = NULL, active_run_started_at = NULL, active_external_request_started = 0, video_generation_attempt_count = CASE WHEN ? = 0 THEN MAX(video_generation_attempt_count - 1, 0) ELSE video_generation_attempt_count END, full_video_generation_attempt_count = CASE WHEN ? = 1 THEN MAX(full_video_generation_attempt_count - 1, 0) ELSE full_video_generation_attempt_count END, video_quality_revalidation_authorized = CASE WHEN ? = 1 THEN 1 ELSE video_quality_revalidation_authorized END, full_video_generation_authorized = CASE WHEN ? = 1 THEN 1 ELSE full_video_generation_authorized END, full_video_quality_revalidation_authorized = CASE WHEN ? = 1 THEN 1 ELSE full_video_quality_revalidation_authorized END, contract_repair_full_video_authorized = CASE WHEN ? = 1 THEN 1 ELSE contract_repair_full_video_authorized END, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
      .run(STATUSES.GENERATION_PACK_READY, "generation_pack_ready", fullSequence ? 1 : 0, fullSequence ? 1 : 0, restoreQualityRevalidation ? 1 : 0, restoreFirstFullAuthorization ? 1 : 0, restoreFullQualityAuthorization ? 1 : 0, restoreContractRepairAuthorization ? 1 : 0, restoredMessage, restoredAt, taskId);
    addEvent(db, taskId, "video_generation_preflight_resumed", "info", restoredMessage, { external_request_started: false, attempt_refunded: true, resubmission: false });
    return beginVideoGeneration(db, taskId);
  }
  const runId = randomUUID();
  const startedAt = now();
  const message = "已找到先前提交的视频任务，正在接回进度和结果；不会再次提交或扣第二次积分。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = ?, active_run_id = ?, active_run_started_at = ?, active_external_request_started = 1, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.RUNNING_VIDEO_GENERATION, "video_generation", "video_generation", runId, startedAt, message, startedAt, taskId);
  addEvent(db, taskId, "video_generation_result_resume_started", "info", message, { run_id: runId, generation_count: 1, resubmission: false });
  return getTask(db, taskId);
}

export function markVideoGenerationExternalRequestStarted(db, taskId, runId) {
  const task = getTask(db, taskId);
  const provider = task?.generation_model_snapshot?.provider || task?.generation_provider || "libtv";
  const providerLabel = provider === "runninghub_h3_multiref" ? "RunningHub H3" : "LibTV";
  const changed = db.prepare("UPDATE tasks SET active_external_request_started = 1, updated_at = ? WHERE id = ? AND active_stage = 'video_generation' AND active_run_id = ?")
    .run(now(), taskId, runId);
  if (changed.changes === 1) addEvent(db, taskId, "video_generation_submitted", "info", `视频生成已提交一次，系统正在等待 ${providerLabel} 返回结果。`, { run_id: runId, provider, automatic_retry: false });
  return changed.changes === 1;
}

export function markVideoReworkExternalRequestStarted(db, taskId, runId) {
  const changed = db.prepare("UPDATE tasks SET active_external_request_started = 1, updated_at = ? WHERE id = ? AND active_stage = 'video_rework_generation' AND active_run_id = ?")
    .run(now(), taskId, runId);
  if (changed.changes === 1)
    addEvent(db, taskId, "video_rework_submitted", "info", "已提交选中的返工片段；版本 1 和未选片段保持不变。", {
      run_id: runId,
      automatic_retry: false,
    });
  return changed.changes === 1;
}

export function finishVideoGeneration(db, taskId, result, { runId = null } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (runId && (task.active_stage !== "video_generation" || task.active_run_id !== runId)) return task;
  const message = result.user_message || "视频已经生成并返回工作台，可以直接查看结果。";
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, active_run_id = NULL, active_run_started_at = NULL, active_external_request_started = 0, video_generation_result_json = ?, last_error = NULL, user_message = ?, updated_at = ? WHERE id = ?")
    .run(STATUSES.VIDEO_GENERATION_COMPLETED, "video_generation_completed", JSON.stringify(result), message, now(), taskId);
  storeArtifacts(db, taskId, "video_generation", result.artifacts || []);
  addEvent(db, taskId, "video_generation_completed", "info", "视频已生成并登记为项目成果。", { run_id: runId, points_used: result.points_used ?? null, model_key: result.model_key });
  return getTask(db, taskId);
}

export function failVideoGeneration(db, taskId, error, result = null, { runId = null } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (runId && (task.active_stage !== "video_generation" || task.active_run_id !== runId)) return task;
  const externalRequestStarted = typeof result?.external_request_started === "boolean"
    ? result.external_request_started
    : task.active_external_request_started === true;
  const capacityRejected = /LIBTV_CAPACITY_UNAVAILABLE|算力不足/.test(String(error));
  const message = externalRequestStarted
    ? "这次视频生成没有正常返回。系统已停止，不会自动再次提交；现有画布和素材仍然保留。"
    : capacityRejected
      ? "LibTV 当前算力不足，没有创建生成任务，也没有占用本次生成次数；专属画布和素材已保留，稍后可直接继续。"
      : "视频尚未提交，系统已退回本次尝试，可以修复后沿用原授权继续。";
  const nextStatus = externalRequestStarted ? STATUSES.VIDEO_GENERATION_FAILED : STATUSES.GENERATION_PACK_READY;
  const nextStep = externalRequestStarted ? "video_generation" : "generation_pack_ready";
  const fullSequence = task.generation_route_choice === "in_chat_libtv_generation";
  const restoreQualityRevalidation = !externalRequestStarted && !fullSequence && task.video_generation_attempt_count === 2;
  const restoreFirstFullAuthorization = !externalRequestStarted && fullSequence && task.full_video_generation_attempt_count === 1;
  const restoreFullQualityAuthorization = !externalRequestStarted && fullSequence && task.full_video_generation_attempt_count === 2;
  const restoreContractRepairAuthorization = !externalRequestStarted && fullSequence && task.full_video_generation_attempt_count === 3;
  db.prepare("UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, active_run_id = NULL, active_run_started_at = NULL, active_external_request_started = 0, video_generation_result_json = ?, video_generation_attempt_count = CASE WHEN ? = 1 AND ? = 0 THEN MAX(video_generation_attempt_count - 1, 0) ELSE video_generation_attempt_count END, full_video_generation_attempt_count = CASE WHEN ? = 1 AND ? = 1 THEN MAX(full_video_generation_attempt_count - 1, 0) ELSE full_video_generation_attempt_count END, video_quality_revalidation_authorized = CASE WHEN ? = 1 THEN 1 ELSE video_quality_revalidation_authorized END, full_video_generation_authorized = CASE WHEN ? = 1 THEN 1 ELSE full_video_generation_authorized END, full_video_quality_revalidation_authorized = CASE WHEN ? = 1 THEN 1 ELSE full_video_quality_revalidation_authorized END, contract_repair_full_video_authorized = CASE WHEN ? = 1 THEN 1 ELSE contract_repair_full_video_authorized END, last_error = ?, user_message = ?, updated_at = ? WHERE id = ?")
    .run(nextStatus, nextStep, result ? JSON.stringify(result) : null, externalRequestStarted ? 0 : 1, fullSequence ? 1 : 0, externalRequestStarted ? 0 : 1, fullSequence ? 1 : 0, restoreQualityRevalidation ? 1 : 0, restoreFirstFullAuthorization ? 1 : 0, restoreFullQualityAuthorization ? 1 : 0, restoreContractRepairAuthorization ? 1 : 0, String(error).slice(0, 2000), message, now(), taskId);
  if (result) storeArtifacts(db, taskId, "video_generation", result.artifacts || []);
  addEvent(db, taskId, externalRequestStarted ? "video_generation_failed" : "video_generation_preflight_restored", externalRequestStarted ? "error" : "warning", message, { run_id: runId, external_request_started: externalRequestStarted, attempt_refunded: !externalRequestStarted, automatic_retry: false, error: String(error).slice(0, 500) });
  return getTask(db, taskId);
}

export function blockRuntimeStage(db, taskId, stage, error) {
  const retryColumn = stage === "decomposition" ? "decompose_retry_count" : "rewrite_retry_count";
  const message = "后台发动机已自动恢复一次，但仍未成功启动；本阶段业务没有开始，也没有占用失败重试次数。稍后可直接继续。";
  db.prepare(`UPDATE tasks SET status = ?, current_step = ?, active_stage = NULL, ${retryColumn} = MAX(${retryColumn} - 1, 0), last_error = ?, user_message = ?, updated_at = ? WHERE id = ?`)
    .run(STATUSES.BLOCKED_RUNTIME, stage, String(error).slice(0, 2000), message, now(), taskId);
  addEvent(db, taskId, "stage_runtime_startup_blocked", "warning", message, { stage, attempt_refunded: true, business_started: false, execution_attempts: error?.execution_attempts || null });
  return getTask(db, taskId);
}

function storeArtifacts(db, taskId, stage, artifacts) {
  for (const artifact of artifacts) {
    if (!artifact?.path) continue;
    db.prepare(`INSERT INTO artifacts (task_id, stage, label, path, published, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, path) DO UPDATE SET label = excluded.label, published = MAX(artifacts.published, excluded.published)`)
      .run(taskId, stage, artifact.label || "成果", artifact.path, artifact.published ? 1 : 0, now());
  }
}
