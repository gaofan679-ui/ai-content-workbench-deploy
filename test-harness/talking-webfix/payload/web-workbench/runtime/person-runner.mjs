import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";
import { artifactRoot, codexWorkspaceRoot, skillFile } from "./portable-paths.mjs";

const schemaPath = fileURLToPath(new URL("./output-schema.json", import.meta.url));

export async function runPersonStage({ task, taskDir, onEvent, env = process.env, skillContractWorkflow = "person_generation" }) {
  const skillContract = resolveSkillContract(skillContractWorkflow, { env });
  mkdirSync(taskDir, { recursive: true });
  const provider = task.person_generation_provider || "codex_builtin";
  const resultPath = join(taskDir, `person-result-attempt-${task.person_attempt_count}.json`);
  const taskSnapshotPath = join(taskDir, `person-task-attempt-${task.person_attempt_count}.json`);
  const contractReceiptPath = join(taskDir, `person-skill-contract-attempt-${task.person_attempt_count}.json`);
  const reusableRequest = provider === "chatgpt_web"
    ? findReusablePersonWebRequest(
        taskDir,
        task.id,
        task.person_attempt_count,
        personRequestMatchOptions(task),
      )
    : null;
  const contractReceipt = reusableRequest
    ? reusableRequestContractReceipt(
        reusableRequest,
        reusableRequestContractPath(reusableRequest),
        skillContract.workflow,
      )
    : skillContractReceipt(skillContract);
  writeCheckpointJson(contractReceiptPath, contractReceipt, (saved) =>
    saved.workflow === contractReceipt.workflow && saved.source_sha256 === contractReceipt.source_sha256,
  );
  const taskSnapshot = {
    schema_version: 2,
    id: task.id,
    title: task.title,
    reference_video_path: task.reference_video_path,
    remix_change_contract: task.remix_change_contract || null,
    person_route: task.person_route,
    person_brief: task.person_brief,
    person_attempt_count: task.person_attempt_count,
    generation_provider: provider,
    requested_output_count: 1,
    reference_images: task.reference_images || null,
    prior_approval_evidence: task.prior_approval_evidence || null,
    final_prompt: task.final_prompt || null,
    model_asset_context: task.model_asset_context || null,
    reference_count_policy: provider === "chatgpt_web" ? "exact_upstream_request_no_bridge_truncation" : "builtin_provider_capability",
    automatic_retry: false,
    source_frame_upload_authorized: task.person_source_upload_authorized,
    skill_contract: contractReceipt,
    skill_contract_receipt_path: contractReceiptPath,
  };
  writeCheckpointJson(taskSnapshotPath, taskSnapshot, (saved) =>
    saved.id === task.id
      && saved.person_attempt_count === task.person_attempt_count
      && saved.generation_provider === provider,
  );

  if (provider === "chatgpt_web") {
    if (!env.WORKBENCH_CHATGPT_WEB_GENERATOR) throw new Error("CHATGPT_WEB_BRIDGE_NOT_CONNECTED");
    const requestPath = await preparePersonWebRequest({
      task,
      taskDir,
      taskSnapshotPath,
      skillContract,
      contractReceipt,
      reusableRequest,
      onEvent,
      env,
    });
    onEvent?.(env.WORKBENCH_CHATGPT_WEB_MODE === "live"
      ? "ChatGPT 浏览器伴侣正在上传已授权参考图并等待 1 张结果。"
      : "ChatGPT 网页代办正在模拟上传、生成、下载和结果回传。");
    try {
      await runProcess(process.execPath, [env.WORKBENCH_CHATGPT_WEB_GENERATOR, "--task-json", taskSnapshotPath, "--task-dir", taskDir, "--request-json", requestPath, "--output", resultPath], {
        env: { ...env, WORKBENCH_GENERATION_PROVIDER: provider },
        onLine: onEvent,
      });
    } catch (error) {
      if (/CHATGPT_WEB_PRE_SUBMIT_BLOCKED:/.test(String(error))) {
        error.code = "CHATGPT_WEB_PRE_SUBMIT_BLOCKED";
        error.external_request_started = false;
      }
      throw error;
    }
  } else if (env.WORKBENCH_PERSON_GENERATOR) {
    await runProcess(process.execPath, [env.WORKBENCH_PERSON_GENERATOR, "--task-json", taskSnapshotPath, "--task-dir", taskDir, "--output", resultPath], {
      env: { ...env, WORKBENCH_GENERATION_PROVIDER: provider },
      onLine: onEvent,
    });
  } else {
    const cleanImageDispatch = task.final_prompt
      ? prepareExactCleanImageAttempt(task, taskSnapshotPath, env)
      : null;
    const prompt = task.final_prompt
      ? buildExactPromptDispatch(task, taskSnapshotPath, cleanImageDispatch)
      : buildPersonPrompt(task, taskDir, taskSnapshotPath, skillContract);
    const promptPath = join(taskDir, `person-prompt-attempt-${task.person_attempt_count}.md`);
    writeFileSync(promptPath, prompt, { flag: "wx" });
    onEvent?.(task.final_prompt
      ? "人物资产与场景画面已经锁定，正在开始本次唯一一张图片生成。"
      : "人物生成要求已经准备好，正在开始本次唯一一张图片生成。");
    const executionCwd = personGenerationExecutionCwd(task, taskDir);
    await runCodex(
      prompt,
      executionCwd,
      resultPath,
      onEvent,
      env,
      Number(env.WORKBENCH_PERSON_GENERATION_TIMEOUT_MS || 30 * 60 * 1000),
      () => existsSync(resultPath) || Boolean(successfulCleanImageReceipt(task)),
    );
  }

  if (!existsSync(resultPath)) recoverPersonResultFromCleanImageReceipt(task, resultPath);
  if (!existsSync(resultPath)) throw new Error("人物生成执行器没有返回结构化结果。");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  onEvent?.("图片已经返回，正在保存到当前项目并登记来源。");
  const finalized = {
    ...result,
    skill_contract: contractReceipt,
    skill_contract_receipt_path: contractReceiptPath,
    external_request_started: Boolean(result.external_request_started),
    video_generation_started: false,
  };
  writeFileSync(resultPath, `${JSON.stringify(finalized, null, 2)}\n`);
  return finalized;
}

export function personGenerationExecutionCwd(task, taskDir) {
  const formalTaskRoot = task.model_asset_context?.artifact_route?.task_root;
  if (!formalTaskRoot) return taskDir;
  if (!isAbsolute(formalTaskRoot) || !existsSync(formalTaskRoot))
    throw preflightError("PERSON_FORMAL_TASK_ROOT_NOT_READY");
  return resolve(formalTaskRoot);
}

export function recoverPersonResultFromCleanImageReceipt(task, resultPath) {
  if (existsSync(resultPath)) return JSON.parse(readFileSync(resultPath, "utf8"));
  const receipt = successfulCleanImageReceipt(task);
  if (!receipt) return null;
  const recovered = {
    status: "completed",
    summary: "人物候选图已生成并完成来源登记；工作台已从正式生图回执恢复本次结果。",
    estimated_cost_cny: 0,
    artifacts: [{ type: "image", label: "人物候选图", path: receipt.project_output_path, published: false }],
    requires_confirmation: true,
    external_request_started: true,
    user_message: "候选图已经返回，请在工作台查看后采用或重新生成。",
  };
  writeFileSync(resultPath, `${JSON.stringify(recovered, null, 2)}\n`, { flag: "wx" });
  return recovered;
}

function successfulCleanImageReceipt(task) {
  const route = task.model_asset_context?.artifact_route;
  if (!route?.process_dir || !route?.final_dir || !isAbsolute(route.process_dir) || !isAbsolute(route.final_dir))
    return null;
  const attempt = Number(task.person_attempt_count || 0);
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  const receiptPath = join(route.process_dir, `attempt-${attempt}`, "execution-receipt.json");
  if (!existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.status !== "success" || receipt.approval_status !== "needs_review" || receipt.task_id !== task.id)
      return null;
    const candidatePath = resolve(String(receipt.project_output_path || ""));
    const finalRoot = resolve(route.final_dir);
    if (!candidatePath.startsWith(`${finalRoot}/`) || !existsSync(candidatePath)) return null;
    const actualHash = createHash("sha256").update(readFileSync(candidatePath)).digest("hex");
    if (!receipt.file_spec?.sha256 || receipt.file_spec.sha256 !== actualHash) return null;
    return receipt;
  } catch {
    return null;
  }
}

export function prepareExactCleanImageAttempt(task, taskSnapshotPath, env = process.env) {
  const routeValue = task.model_asset_context?.artifact_route;
  if (!routeValue?.route_receipt || !isAbsolute(routeValue.route_receipt))
    throw preflightError("PERSON_CLEAN_IMAGE_ROUTE_MISSING");
  const routePath = resolve(routeValue.route_receipt);
  if (!existsSync(routePath)) throw preflightError("PERSON_CLEAN_IMAGE_ROUTE_MISSING");
  let route;
  try { route = JSON.parse(readFileSync(routePath, "utf8")); }
  catch { throw preflightError("PERSON_CLEAN_IMAGE_ROUTE_INVALID"); }
  if (
    route.status !== "ready"
    || route.route_contract !== "artifact_route_contract_v1"
    || route.task_id !== task.id
    || resolve(route.task_root || "") !== resolve(routeValue.task_root || "")
    || !route.final_dir
    || !isAbsolute(route.final_dir)
    || (routeValue.final_dir && resolve(routeValue.final_dir) !== resolve(route.final_dir))
  ) throw preflightError("PERSON_CLEAN_IMAGE_ROUTE_IDENTITY_CONFLICT");

  const attempt = Number(task.person_attempt_count || 0);
  if (!Number.isInteger(attempt) || attempt < 1)
    throw preflightError("PERSON_CLEAN_IMAGE_ATTEMPT_INVALID");
  const processDir = resolve(routeValue.process_dir || join(route.work_dir, "02_生产过程", route.category));
  const finalDir = resolve(route.final_dir);
  const generatedImagesRoot = resolve(
    env.WORKBENCH_GENERATED_IMAGES_ROOT
      || join(env.CODEX_HOME || join(homedir(), ".codex"), "generated_images"),
  );
  const attemptDir = join(processDir, `attempt-${attempt}`);
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(finalDir, { recursive: true });
  // image_gen writes its tool-owned original below Codex' generated_images
  // root. Declare and create that root before start so the clean executor
  // never guesses a machine-specific temporary directory.
  mkdirSync(generatedImagesRoot, { recursive: true });
  const taskCardPath = join(attemptDir, "clean-image-task-card.json");
  const preflightPath = join(attemptDir, "preflight.json");
  const runStatePath = join(attemptDir, "run-state.json");
  const persistReceiptPath = join(attemptDir, "persist-receipt.json");
  const executionReceiptPath = join(attemptDir, "execution-receipt.json");
  const projectOutputPath = join(finalDir, `person-candidate-attempt-${attempt}.png`);
  if ([taskCardPath, preflightPath, runStatePath, persistReceiptPath, executionReceiptPath, projectOutputPath].some(existsSync))
    throw preflightError("PERSON_CLEAN_IMAGE_ATTEMPT_ALREADY_EXISTS");

  const references = (task.reference_images || []).map((item, index) => ({
    path: resolve(item.path),
    role: index === 0 ? "人物身份主参考" : `人物补充参考 ${index + 1}`,
    must_inherit: "只继承最终提示词明确要求保留的人物身份与指定特征",
    must_not_inherit: "不得扩大继承到最终提示词未声明的背景、构图、姿态、文字或其他身份",
    contains_real_person: task.person_route === "authorized_person",
    contains_customer_private_material: task.person_route === "authorized_person",
    upload_authorized: task.person_source_upload_authorized === true,
  }));
  const isRealPerson = task.person_route === "authorized_person";
  const promptHash = createHash("sha256").update(task.final_prompt, "utf8").digest("hex");
  const referenceHash = createHash("sha256").update(
    references.map((item) => `${item.path}:${createHash("sha256").update(readFileSync(item.path)).digest("hex")}`).join("\n"),
    "utf8",
  ).digest("hex");
  const card = {
    schema_version: 2,
    // The clean executor requires this identity to be exactly the route owner.
    // Attempt and asset identity belong in their own fields, never in task_id.
    task_id: route.task_id,
    attempt_id: `person-attempt-${attempt}`,
    idempotency_key: `${route.task_id}:person-candidate:attempt-${attempt}`,
    asset_type: isRealPerson ? "authorized_person_master_candidate" : "ai_model_person_candidate",
    business_skill: isRealPerson ? "ai-video-real-person-assets" : "ai-model-asset-codex",
    project_dir: route.task_root,
    route_receipt: routePath,
    preflight_receipt_path: preflightPath,
    allowed_read_paths: [taskCardPath, routePath, preflightPath, taskSnapshotPath, ...references.map((item) => item.path)],
    reference_images: references,
    excluded_reference_images: [],
    final_prompt: task.final_prompt,
    // The executable clean-image contract currently consumes `final_prompt`,
    // while its human-facing SKILL text still names `final_model_prompt`.
    // Keep both as an identical, hashed compatibility pair so a clean worker
    // cannot reinterpret or block the already-approved prompt.
    final_model_prompt: task.final_prompt,
    prompt_summary: "工作台已锁定的单张人物口播母版提示词，执行任务只能逐字传递",
    requested_output_count: 1,
    generated_images_root: generatedImagesRoot,
    output: { raw_output_dir: attemptDir, project_output_path: projectOutputPath },
    execution_policy: {
      required_context: "clean_subagent",
      fork_turns: "none",
      backend: "builtin_image_gen",
      allow_external_api: false,
      allow_paid_generation: false,
      allow_platform_switch: false,
      allow_automatic_retry: false,
    },
    authorization: {
      generation_authorized: true,
      real_person_upload_authorized: isRealPerson && task.person_source_upload_authorized === true,
      customer_private_upload_authorized: isRealPerson && task.person_source_upload_authorized === true,
      authorized_upload_paths: references.map((item) => item.path),
      authorization_evidence: isRealPerson
        ? "工作台当前生成轮次已取得本次授权人物参考图上传确认"
        : "工作台当前生成轮次已确认仅上传所选 AI 模特母版参考图",
      extra_cost_authorized: false,
    },
    source_snapshot_path: taskSnapshotPath,
    locked_prompt_sha256: promptHash,
    reference_set_sha256: referenceHash,
    approval_status: "needs_review",
  };
  writeFileSync(taskCardPath, `${JSON.stringify(card, null, 2)}\n`, { flag: "wx" });
  const executorScript = env.WORKBENCH_CLEAN_IMAGE_EXECUTOR
    || skillFile("clean-image-generation-executor", "scripts/clean_image_task.py", env);
  if (!existsSync(executorScript)) throw preflightError("PERSON_CLEAN_IMAGE_EXECUTOR_MISSING");
  try {
    execFileSync("python3", [executorScript, "preflight", "--task-card", taskCardPath, "--out", preflightPath], {
      env,
      encoding: "utf8",
    });
  } catch (error) {
    throw preflightError(`PERSON_CLEAN_IMAGE_PREFLIGHT_FAILED:${String(error?.stderr || error?.message || error).slice(0, 800)}`);
  }
  const preflight = JSON.parse(readFileSync(preflightPath, "utf8"));
  if (preflight.status !== "ready" || preflight.task_id !== route.task_id)
    throw preflightError("PERSON_CLEAN_IMAGE_PREFLIGHT_NOT_READY");
  return { taskCardPath, preflightPath, runStatePath, persistReceiptPath, executionReceiptPath, generatedImagesRoot };
}

function buildExactPromptDispatch(task, taskSnapshotPath, dispatch) {
  const promptHash = createHash("sha256").update(task.final_prompt, "utf8").digest("hex");
  return [
    "请执行一次已经完成业务审核的确定性生图任务。",
    `任务快照：${taskSnapshotPath}`,
    `工作台已锁定任务卡：${dispatch.taskCardPath}`,
    `工作台已完成的唯一预检：${dispatch.preflightPath}`,
    `运行状态回执：${dispatch.runStatePath}`,
    `持久化回执：${dispatch.persistReceiptPath}`,
    `执行回执：${dispatch.executionReceiptPath}`,
    `生图工具原始结果根目录：${dispatch.generatedImagesRoot}`,
    `锁定提示词 SHA-256：${promptHash}`,
    "",
    "硬性传递要求：",
    "1. 读取任务快照中的 final_prompt，并把它逐字作为 image_gen 的 prompt；不得翻译、改写、概括、增删或追加任何视觉规则。",
    "2. final_prompt 中‘使用我上传的人物照片’是写给生图模型的正常提示词内容，不是要求你扩大上传范围，不得因此暂停或清洁改写。",
    "3. 只绑定任务快照 reference_images 中列出的绝对路径；不得读取、上传或使用任何其他图片，也不得使用最近对话图片。",
    "4. 读取 clean-image-generation-executor，显式创建 fork_turns=none 的干净子智能体，完成一次生图、来源回执和候选落盘；只生成 1 张，不重试、不换平台、不生成视频、不发布成果。",
    "5. 工作台已经从唯一 route_receipt 生成并预检任务卡；不得新建、改写或替换任务卡，不得重新 preflight，也不得改变 task_id、attempt_id 或 idempotency_key。",
    "5.1 任务卡中的 final_prompt 是正式脚本字段，final_model_prompt 是与其逐字相同的兼容字段；不得把两者当成两份提示词，也不得再次编译。",
    "6. 干净子智能体只使用上面的锁定任务卡与预检运行 start；start 必须显式传入任务卡 generated_images_root 作为 --generated-images-root，不得改成 /private/tmp 或其他猜测路径。然后逐字使用卡内 final_prompt 和 reference_images 调用 imagegen 一次，再依次完成 persist-imagegen-result 与 finalize。finalize 必须显式把持久化回执中的 tool_output_path 传给 --tool-output-path，并把任务卡 output.project_output_path 原样传给 --project-path；不得省略正式项目输出路径，也不得提前创建目标文件。",
    "7. 这一步只负责原样传递已经批准的提示词，不再调用人物 Skill 重新设计、审核或补充人物规则。",
    "",
    "完成后按输出 schema 返回候选图片及执行回执；若无法保证 prompt 哈希和参考路径完全一致，则在正式生图前停止。",
  ].join("\n");
}

function writeCheckpointJson(path, value, isSameCheckpoint) {
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    return;
  }
  let saved;
  try { saved = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw preflightError("PERSON_CHECKPOINT_INVALID"); }
  if (!isSameCheckpoint(saved)) throw preflightError("PERSON_CHECKPOINT_IDENTITY_CONFLICT");
}

async function preparePersonWebRequest({
  task,
  taskDir,
  taskSnapshotPath,
  skillContract,
  contractReceipt,
  reusableRequest,
  onEvent,
  env,
}) {
  const planningResultPath = join(taskDir, `person-web-request-result-${task.person_attempt_count}.json`);
  const planningPromptPath = join(taskDir, `person-web-request-prompt-${task.person_attempt_count}.md`);
  if (reusableRequest) {
    materializePromptFile(reusableRequest);
    stampRequestContract(reusableRequest, contractReceipt);
    onEvent?.("已复用上次在网页提交前完成的人物提示词和参考图职责，不会重新编译或重复生图。");
    return reusableRequest;
  }
  if (task.final_prompt) {
    const exactRequest = compileExactPersonWebRequest({ task, taskDir, contractReceipt });
    onEvent?.("工作台正在逐字整理已锁定提示词和本次参考图；不会调用旧请求，也不会重新规划人物规则。");
    return exactRequest;
  }
  const reusableBusinessRequest = findReusablePersonBusinessRequest(taskDir, task.id, task.person_attempt_count);
  if (reusableBusinessRequest) {
    const compiledPath = compilePersonBusinessRequest({
      businessRequestPath: reusableBusinessRequest,
      task,
      taskDir,
      contractReceipt,
    });
    onEvent?.("已复用人物 Skill 上次完成的提示词和参考图范围；工作台直接整理网页生图请求，不会重新规划或重复生图。");
    return compiledPath;
  }
  const prompt = buildPersonPrompt(task, taskDir, taskSnapshotPath, skillContract, "prepare_internal_request");
  writeFileSync(planningPromptPath, prompt, { flag: "wx" });
  onEvent?.("正在由人物 Skill 准备正式提示词和参考图职责；此步骤不会生图或占用网页生图次数。");
  const allowEmptyReferences = task.model_asset_context?.ai_source_method === "original";
  const requestMatchOptions = personRequestMatchOptions(task, { allowEmptyReferences });
  let planningError = null;
  try {
    if (env.WORKBENCH_PERSON_REQUEST_PLANNER) {
      await runProcess(process.execPath, [env.WORKBENCH_PERSON_REQUEST_PLANNER, "--task-json", taskSnapshotPath, "--task-dir", taskDir, "--output", planningResultPath], { env, onLine: onEvent });
    } else {
      await runCodex(
        prompt,
        taskDir,
        planningResultPath,
        onEvent,
        env,
        Number(env.WORKBENCH_PERSON_REQUEST_PLANNING_TIMEOUT_MS || 5 * 60 * 1000),
        () => Boolean(
          findReusablePersonWebRequest(taskDir, task.id, task.person_attempt_count, requestMatchOptions)
          || findReusablePersonBusinessRequest(taskDir, task.id, task.person_attempt_count),
        ),
      );
    }
  } catch (error) {
    planningError = error;
  }
  if (existsSync(planningResultPath)) {
    const planningResult = JSON.parse(readFileSync(planningResultPath, "utf8"));
    const requestArtifact = (planningResult.artifacts || []).find((item) =>
      isInternalPersonRequest(item.path, task.id, requestMatchOptions));
    if (requestArtifact?.path) {
      materializePromptFile(requestArtifact.path);
      stampRequestContract(requestArtifact.path, skillContractReceipt(skillContract));
      return requestArtifact.path;
    }
  }
  const directRequest = findReusablePersonWebRequest(taskDir, task.id, task.person_attempt_count, requestMatchOptions);
  if (directRequest) {
    materializePromptFile(directRequest);
    stampRequestContract(directRequest, contractReceipt);
    return directRequest;
  }
  const businessRequestPath = findReusablePersonBusinessRequest(taskDir, task.id, task.person_attempt_count);
  if (businessRequestPath) {
    const compiledPath = compilePersonBusinessRequest({
      businessRequestPath,
      task,
      taskDir,
      contractReceipt,
    });
    onEvent?.("人物 Skill 已完成提示词和参考图范围；工作台正在直接整理网页生图请求，不再等待重复格式回执。");
    return compiledPath;
  }
  if (planningError) throw planningError;
  if (!existsSync(planningResultPath)) throw preflightError("PERSON_CHATGPT_REQUEST_RESULT_MISSING");
  throw preflightError("PERSON_CHATGPT_INTERNAL_REQUEST_MISSING");
}

export function findReusablePersonBusinessRequest(taskDir, taskId, currentAttempt) {
  for (let attempt = Number(currentAttempt); attempt >= 1; attempt -= 1) {
    const candidateDirs = [taskDir];
    if (/^attempt-\d+$/.test(basename(taskDir))) candidateDirs.push(join(dirname(taskDir), `attempt-${attempt}`));
    for (const candidateDir of [...new Set(candidateDirs)]) {
      const candidatePath = join(candidateDir, "person-v0-business-request.json");
      if (!existsSync(candidatePath)) continue;
      try {
        const value = JSON.parse(readFileSync(candidatePath, "utf8"));
        if (value.schema_version !== 2 || !value.final_prompt) continue;
        if (value.task_id && value.task_id !== taskId) continue;
        if (value.operation !== "prepare_internal_request") continue;
        return candidatePath;
      } catch { /* continue to an older valid request */ }
    }
  }
  return null;
}

export function compilePersonBusinessRequest({ businessRequestPath, task, taskDir, contractReceipt }) {
  const business = JSON.parse(readFileSync(businessRequestPath, "utf8"));
  if (business.schema_version !== 2 || !business.final_prompt) throw preflightError("PERSON_BUSINESS_REQUEST_INVALID");
  if (business.task_id && business.task_id !== task.id) throw preflightError("PERSON_BUSINESS_REQUEST_IDENTITY_CONFLICT");
  const references = (task.reference_images || []).map((item, index) => ({
    order: index + 1,
    ref_id: item.ref_id || `MODEL-REF-${String(index + 1).padStart(2, "0")}`,
    display_name: item.display_name || basename(item.path),
    upload_name: `${String(index + 1).padStart(2, "0")}_${item.ref_id || `MODEL-REF-${String(index + 1).padStart(2, "0")}`}_${basename(item.path)}`,
    path: item.path,
    sha256: item.sha256,
    visual_locator: `第 ${index + 1} 张已授权参考图（${item.category || "人物参考"}）`,
    role: `人物 Skill 已选参考图：${item.category || "人物参考"}`,
    must_inherit: ["仅按人物 Skill 已编译提示词声明的职责使用"],
    must_not_inherit: ["不得扩展为提示词未声明或用户未授权的用途"],
    upload_authorized: true,
  }));
  if (business.person_source_method !== "original" && references.length === 0) throw preflightError("PERSON_BUSINESS_REQUEST_REFERENCES_MISSING");
  const finalPrompt = String(business.final_prompt).trim();
  const attempt = Number(task.person_attempt_count);
  const outputPath = join(taskDir, `person-internal-image-request-attempt-${attempt}.json`);
  const compiled = {
    schema_version: 2,
    request_type: "internal_image_generation_request",
    task_id: task.id,
    attempt_id: `person-attempt-${attempt}`,
    idempotency_key: `${task.id}:person-candidate:attempt-${attempt}`,
    asset_id: `person_candidate_attempt_${attempt}`,
    asset_type: business.asset_type || "source_character_asset",
    person_route: task.person_route,
    person_source_method: business.person_source_method || task.model_asset_context?.ai_source_method || null,
    prompt_owner_skill: "ai-video-person-assets",
    request_compiler_skill: "workbench-person-adapter",
    execution_support_skill: "clean-image-generation-executor",
    bridge_version: contractReceipt.bridge_version,
    final_model_prompt: finalPrompt,
    final_model_prompt_sha256: createHash("sha256").update(finalPrompt, "utf8").digest("hex"),
    final_prompt_policy: "skill_compiled_verbatim",
    reference_images: references,
    excluded_reference_images: business.excluded_reference_images || [],
    reference_count_policy: references.length ? "use_the_complete_skill_selected_reference_set" : "original_route_no_reference_images",
    reference_binding: references.length ? "explicit_referenced_image_paths" : "no_reference_images",
    execution_parameters: {
      provider: "chatgpt_web",
      requested_output_count: 1,
      allow_automatic_retry: false,
      allow_provider_switch: false,
      allow_video_generation: false,
      image_generation_allowed_in_current_operation: false,
      num_last_images_to_include_used: false,
    },
    current_operation: "prepare_internal_request",
    generation_execution_context: "not_started",
    approval_status: "needs_review",
    published: false,
    allow_automatic_retry: false,
    manual_pack_equivalence: { same_request_required: true },
    source_business_request_path: businessRequestPath,
    workbench_skill_contract: contractReceipt,
    external_request_started: false,
    estimated_cost_cny: 0,
  };
  writeFileSync(outputPath, `${JSON.stringify(compiled, null, 2)}\n`, { flag: "wx" });
  return outputPath;
}

export function compileExactPersonWebRequest({ task, taskDir, contractReceipt }) {
  const finalPrompt = String(task.final_prompt || "").trim();
  if (!finalPrompt) throw preflightError("PERSON_EXACT_WEB_PROMPT_MISSING");
  const references = (task.reference_images || []).map((item, index) => {
    const order = String(index + 1).padStart(2, "0");
    const refId = item.ref_id || `MODEL-REF-${order}`;
    return {
      order: index + 1,
      ref_id: refId,
      display_name: item.display_name || basename(item.path),
      upload_name: `${order}_${refId}_${basename(item.path)}`,
      path: item.path,
      sha256: item.sha256,
      visual_locator: `第 ${index + 1} 张已授权参考图（${item.category || "人物参考"}）`,
      role: index === 0 ? "人物身份主参考" : "本次提示词明确指定的补充参考",
      must_inherit: ["严格按已锁定提示词声明的职责使用"],
      must_not_inherit: ["不得扩展为提示词未声明或用户未授权的用途"],
      contains_real_person: task.person_route === "authorized_person",
      contains_customer_private_material: task.person_route === "authorized_person",
      upload_authorized: task.person_source_upload_authorized === true,
    };
  });
  const allowEmptyReferences = task.model_asset_context?.ai_source_method === "original";
  if (!allowEmptyReferences && references.length === 0)
    throw preflightError("PERSON_EXACT_WEB_REFERENCES_MISSING");
  const attempt = Number(task.person_attempt_count);
  const outputPath = join(taskDir, `person-internal-image-request-attempt-${attempt}.json`);
  const request = {
    schema_version: 2,
    request_type: "internal_image_generation_request",
    task_id: task.id,
    attempt_id: `person-attempt-${attempt}`,
    idempotency_key: `${task.id}:person-candidate:attempt-${attempt}`,
    asset_id: `person_candidate_attempt_${attempt}`,
    asset_type: "source_character_asset",
    person_route: task.person_route,
    person_source_method: task.model_asset_context?.ai_source_method || null,
    prompt_owner_skill: task.person_route === "authorized_person" ? "ai-video-real-person-assets" : "ai-model-asset-codex",
    request_compiler_skill: "workbench-exact-prompt-adapter",
    execution_support_skill: "clean-image-generation-executor",
    bridge_version: contractReceipt.bridge_version,
    final_model_prompt: finalPrompt,
    final_model_prompt_sha256: createHash("sha256").update(finalPrompt, "utf8").digest("hex"),
    final_prompt_policy: "workbench_locked_verbatim",
    reference_images: references,
    excluded_reference_images: [],
    reference_count_policy: references.length ? "use_the_complete_workbench_selected_reference_set" : "original_route_no_reference_images",
    reference_binding: references.length ? "explicit_referenced_image_paths" : "no_reference_images",
    execution_parameters: {
      provider: "chatgpt_web",
      requested_output_count: 1,
      allow_automatic_retry: false,
      allow_provider_switch: false,
      allow_video_generation: false,
      image_generation_allowed_in_current_operation: false,
      num_last_images_to_include_used: false,
    },
    current_operation: "prepare_internal_request",
    generation_execution_context: "not_started",
    approval_status: "needs_review",
    published: false,
    allow_automatic_retry: false,
    manual_pack_equivalence: { same_request_required: true },
    workbench_skill_contract: contractReceipt,
    external_request_started: false,
    estimated_cost_cny: 0,
  };
  writeFileSync(outputPath, `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
  return outputPath;
}

export function reusableRequestContractReceipt(requestPath, contractReceiptPath, expectedWorkflow = "person_generation") {
  if (!existsSync(contractReceiptPath)) throw preflightError("PERSON_REUSABLE_CONTRACT_RECEIPT_MISSING");
  let savedReceipt;
  let request;
  try {
    savedReceipt = JSON.parse(readFileSync(contractReceiptPath, "utf8"));
    request = materializePromptFile(requestPath);
  } catch {
    throw preflightError("PERSON_REUSABLE_CONTRACT_RECEIPT_INVALID");
  }
  const requestReceipt = request.workbench_skill_contract;
  const sameEmbeddedContract = requestReceipt
    && requestReceipt.workflow === savedReceipt.workflow
    && requestReceipt.owner_skill === savedReceipt.owner_skill
    && requestReceipt.source_path === savedReceipt.source_path
    && requestReceipt.source_sha256 === savedReceipt.source_sha256;
  const sameLegacyContract = !requestReceipt
    && request.prompt_owner_skill === savedReceipt.owner_skill
    && (
      (request.bridge_version === savedReceipt.bridge_version && request.skill_source_sha256 === savedReceipt.source_sha256)
      || (request.skill_contract?.bridge_version === savedReceipt.bridge_version
        && request.skill_contract?.owner_skill_source === savedReceipt.source_path
        && request.skill_contract?.owner_skill_sha256 === savedReceipt.source_sha256)
    );
  const sameLockedContract = savedReceipt.workflow === expectedWorkflow
    && (sameEmbeddedContract || sameLegacyContract);
  if (!sameLockedContract) throw preflightError("PERSON_REUSABLE_CONTRACT_IDENTITY_CONFLICT");
  return savedReceipt;
}

export function findReusablePersonWebRequest(taskDir, taskId, currentAttempt, options = {}) {
  for (let attempt = Number(currentAttempt); attempt >= 1; attempt -= 1) {
    const candidateDirs = [taskDir];
    if (/^attempt-\d+$/.test(basename(taskDir)))
      candidateDirs.push(join(dirname(taskDir), `attempt-${attempt}`));
    for (const candidateDir of [...new Set(candidateDirs)]) {
      const resultPath = join(candidateDir, `person-web-request-result-${attempt}.json`);
      if (existsSync(resultPath)) {
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf8"));
          const artifact = (result.artifacts || []).find((item) => isInternalPersonRequest(item.path, taskId, options));
          if (artifact?.path) return artifact.path;
        } catch { /* continue to direct request files */ }
      }
      if (!existsSync(candidateDir)) continue;
      for (const name of readdirSync(candidateDir).filter((value) => /^person-internal.*attempt-\d+\.json$/.test(value)).sort().reverse()) {
        const directPath = join(candidateDir, name);
        if (isInternalPersonRequest(directPath, taskId, options)) return directPath;
      }
    }
  }
  return null;
}

export function isInternalPersonRequest(path, taskId, options = {}) {
  const { allowEmptyReferences = false } = options;
  if (!path || !existsSync(path)) return false;
  try {
    materializePromptFile(path);
    const request = JSON.parse(readFileSync(path, "utf8"));
    const prompt = String(request.final_model_prompt || request.final_prompt || "").trim();
    const promptHash = createHash("sha256").update(prompt, "utf8").digest("hex");
    const referenceHashes = request.reference_images?.map((item) => String(item.sha256 || "")) || [];
    const expectedPromptMatches = !options.expectedPromptSha256 || options.expectedPromptSha256 === promptHash;
    const expectedReferencesMatch = !Array.isArray(options.expectedReferenceSha256s)
      || JSON.stringify(options.expectedReferenceSha256s) === JSON.stringify(referenceHashes);
    return request.request_type === "internal_image_generation_request"
      && request.task_id === taskId
      && ["person_master_candidate", "source_character_asset", "talking_head_drive_master_candidate"].includes(request.asset_type)
      && Boolean(request.final_model_prompt || request.final_prompt)
      && Array.isArray(request.reference_images)
      && (allowEmptyReferences || request.reference_images.length > 0)
      && request.reference_images.every((item) => item.path && item.sha256 && existsSync(item.path))
      && expectedPromptMatches
      && expectedReferencesMatch;
  } catch { return false; }
}

function personRequestMatchOptions(task, overrides = {}) {
  const prompt = String(task.final_prompt || "").trim();
  return {
    allowEmptyReferences: task.model_asset_context?.ai_source_method === "original",
    expectedPromptSha256: prompt ? createHash("sha256").update(prompt, "utf8").digest("hex") : null,
    expectedReferenceSha256s: Array.isArray(task.reference_images) && task.reference_images.length
      ? task.reference_images.map((item) => String(item.sha256 || ""))
      : null,
    ...overrides,
  };
}

function reusableRequestContractPath(requestPath) {
  const match = basename(requestPath).match(/attempt-(\d+)\.json$/);
  if (!match) throw preflightError("PERSON_REUSABLE_CONTRACT_RECEIPT_MISSING");
  return join(dirname(requestPath), `person-skill-contract-attempt-${match[1]}.json`);
}

function materializePromptFile(path) {
  const request = JSON.parse(readFileSync(path, "utf8"));
  if (request.final_model_prompt || request.final_prompt) {
    const prompt = request.final_model_prompt || request.final_prompt;
    const hash = createHash("sha256").update(prompt, "utf8").digest("hex");
    if (request.final_model_prompt && request.final_model_prompt_sha256 === hash) return request;
    const normalized = { ...request, final_model_prompt: prompt, final_model_prompt_sha256: hash };
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }
  const declared = request.final_model_prompt_path || request.final_prompt_path;
  if (!declared) return request;
  const promptPath = isAbsolute(declared) ? declared : resolve(dirname(path), declared);
  if (!existsSync(promptPath)) throw preflightError("PERSON_CHATGPT_PROMPT_FILE_MISSING");
  const rawPrompt = readFileSync(promptPath, "utf8");
  const prompt = rawPrompt.trim();
  const rawHash = createHash("sha256").update(rawPrompt, "utf8").digest("hex");
  const hash = createHash("sha256").update(prompt, "utf8").digest("hex");
  if (request.final_model_prompt_sha256 && ![rawHash, hash].includes(request.final_model_prompt_sha256)) {
    throw preflightError("PERSON_CHATGPT_PROMPT_FILE_HASH_MISMATCH");
  }
  const normalized = { ...request, final_model_prompt: prompt, final_model_prompt_sha256: hash };
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function stampRequestContract(path, receipt) {
  const request = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...request, workbench_skill_contract: receipt }, null, 2)}\n`);
}

function preflightError(code) {
  const error = new Error(code);
  error.code = code;
  error.external_request_started = false;
  return error;
}

function runCodex(prompt, taskDir, resultPath, onEvent, env, timeoutMs, earlySuccess = null) {
  const args = [
    "exec", "-", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write",
    "--model", env.WORKBENCH_CODEX_MODEL || "gpt-5.6-sol",
    "--config", `model_reasoning_effort=${env.WORKBENCH_PERSON_CODEX_REASONING_EFFORT || "low"}`,
    "-C", taskDir,
    "--add-dir", codexWorkspaceRoot(env),
  ];
  const formalRoot = artifactRoot(env);
  if (existsSync(formalRoot)) args.push("--add-dir", formalRoot);
  args.push("--output-schema", schemaPath, "--output-last-message", resultPath);
  return runManagedCodex({ args, prompt, env, onEvent, timeoutMs, earlySuccess });
}

function runProcess(command, args, { env, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); onLine?.(chunk.toString().trim()); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || `人物生成适配器退出码 ${code}`)));
  });
}

export function buildPersonPrompt(task, taskDir, taskSnapshotPath, skillContract, executionMode = "generate_candidate") {
  const sourceAnalysisDir = join(taskDir, "01_source_video_analysis");
  const hasReusableSourceAnalysis = Boolean(
    task.reference_video_path && existsSync(sourceAnalysisDir),
  );
  return buildSkillOwnedPrompt({
    contract: skillContract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      task_snapshot_path: taskSnapshotPath,
      work_dir: taskDir,
      reference_video_path: task.reference_video_path,
      source_analysis_dir: hasReusableSourceAnalysis ? sourceAnalysisDir : null,
      person_route: task.person_route,
      person_brief: task.person_brief || null,
      model_asset_context: task.model_asset_context || null,
      final_prompt: task.final_prompt || null,
      final_prompt_sha256: task.final_prompt
        ? createHash("sha256").update(task.final_prompt, "utf8").digest("hex")
        : null,
      final_prompt_policy: task.final_prompt ? "verbatim_no_rewrite" : null,
      reference_images: task.reference_images || [],
      prior_approval_evidence: task.prior_approval_evidence || null,
      remix_precision_route: task.remix_precision_route || null,
      remix_change_contract: task.remix_change_contract || null,
      scene_reference_paths: task.remix_change_contract?.scene?.image_paths || [],
      video_generation_provider: task.generation_provider || null,
      video_generation_quality: task.generation_quality_profile || null,
      generation_provider: task.person_generation_provider || "codex_builtin",
      attempt_number: task.person_attempt_count,
    },
    runtimeEnvelope: {
      requested_output_count: 1,
      operation: executionMode,
      image_generation_allowed: executionMode === "generate_candidate",
      source_frame_upload_authorized: Boolean(task.person_source_upload_authorized),
      automatic_retry_allowed: false,
      provider_switch_allowed: false,
      video_generation_allowed: false,
      overall_task_close_forbidden: true,
      intermediate_stage_only: true,
      existing_source_analysis_must_be_reused: hasReusableSourceAnalysis,
      reference_channel_capability: task.person_generation_provider === "chatgpt_web"
        ? "use_the_complete_skill_selected_reference_set"
        : "builtin_provider_current_attachment_capability",
      existing_artifact_route: task.model_asset_context?.artifact_route || null,
      existing_artifact_route_must_be_reused: Boolean(task.model_asset_context?.artifact_route?.task_root),
      create_or_replace_formal_project_forbidden: Boolean(task.model_asset_context?.artifact_route?.task_root),
      internal_request_output_dir: executionMode === "prepare_internal_request" ? taskDir : null,
      internal_request_identity: executionMode === "prepare_internal_request" ? {
        request_type: "internal_image_generation_request",
        task_id: task.id,
        attempt_number: task.person_attempt_count,
        allowed_empty_reference_set: task.model_asset_context?.ai_source_method === "original",
      } : null,
      output_interface: {
        expected_artifact: executionMode === "prepare_internal_request" ? "人物内部生图请求" : "AI 人物候选图",
        approval_status: "needs_review",
        published: false,
        estimated_cost_cny: 0,
        requires_confirmation: true,
      },
      user_message_policy: "只用大白话说明结果和下一步，不展示内部路径、执行器或合同字段。",
    },
  });
}
