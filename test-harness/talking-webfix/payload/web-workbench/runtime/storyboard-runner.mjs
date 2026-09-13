import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectStoryboardRatio } from "./storyboard-ratio.mjs";
import { assertStoryboardRequestContract, createStoryboardRatioRepairPrompt } from "./storyboard-contract.mjs";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";
import { artifactRoot, codexWorkspaceRoot } from "./portable-paths.mjs";

const schemaPath = fileURLToPath(new URL("./output-schema.json", import.meta.url));

export async function runStoryboardStage({ task, taskDir, onEvent, env = process.env }) {
  const skillContract = resolveSkillContract("storyboard_generation", { env });
  const contractReceipt = skillContractReceipt(skillContract);
  mkdirSync(taskDir, { recursive: true });
  const executionRunId = `${task.storyboard_attempt_count}-${randomUUID().slice(0, 8)}`;
  const resultPath = join(taskDir, `storyboard-result-attempt-${executionRunId}.json`);
  const snapshotPath = join(taskDir, `storyboard-task-attempt-${executionRunId}.json`);
  const contractReceiptPath = join(taskDir, `storyboard-skill-contract-attempt-${executionRunId}.json`);
  const approvedPerson = task.artifacts.find((item) => item.stage === "person" && item.published && /人物/.test(item.label));
  if (!approvedPerson?.path || !existsSync(approvedPerson.path)) throw new Error("STORYBOARD_APPROVED_PERSON_MISSING");
  const provider = task.storyboard_generation_provider || task.default_image_generation_provider || "codex_builtin";
  const sourceDurationSeconds = readSourceDurationSeconds(join(taskDir, "01_source_video_analysis"));
  const snapshot = {
    schema_version: 1, id: task.id, title: task.title, execution_run_id: executionRunId, storyboard_mode: task.storyboard_mode,
    storyboard_brief: task.storyboard_brief, storyboard_attempt_count: task.storyboard_attempt_count,
    source_analysis_dir: join(taskDir, "01_source_video_analysis"), approved_person_path: approvedPerson.path,
    rewrite_mode: task.rewrite_mode, product_image_paths: task.product_image_paths,
    generation_stage: "storyboard", generation_provider: provider, source_frame_upload_authorized: task.storyboard_source_upload_authorized,
    upload_authorization_scope: task.storyboard_upload_scope || null,
    source_duration_seconds: sourceDurationSeconds,
    requested_output_count: sourceDurationSeconds > 15 ? "one_per_skill_defined_segment" : 1,
    automatic_retry: false, objective_ratio_repair_authorized: Boolean(task.storyboard_ratio_repair_authorized), approval_status: "needs_review",
    skill_contract: contractReceipt, skill_contract_receipt_path: contractReceiptPath,
  };
  writeFileSync(contractReceiptPath, `${JSON.stringify(contractReceipt, null, 2)}\n`, { flag: "wx" });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
  let requestPath = null;
  let requestPaths = [];
  if (env.WORKBENCH_STORYBOARD_GENERATOR) {
    await runProcess(process.execPath, [env.WORKBENCH_STORYBOARD_GENERATOR, "--task-json", snapshotPath, "--task-dir", taskDir, "--output", resultPath], { env, onLine: onEvent });
  } else if (provider === "chatgpt_web") {
    if (!env.WORKBENCH_CHATGPT_WEB_GENERATOR) throw new Error("CHATGPT_WEB_BRIDGE_NOT_CONNECTED");
    try {
      requestPaths = await prepareStoryboardWebRequests({ task, taskDir, snapshotPath, approvedPersonPath: approvedPerson.path, executionRunId, skillContract, sourceDurationSeconds, onEvent, env });
      requestPath = requestPaths.length === 1 ? requestPaths[0] : null;
    } catch (error) {
      error.external_request_started = false;
      throw error;
    }
    onEvent?.(env.WORKBENCH_CHATGPT_WEB_MODE === "live"
      ? "正式分镜提示词和参考图职责已锁定，ChatGPT 浏览器伴侣正在处理本次单张任务。"
      : "ChatGPT 分镜网页代办正在模拟单次提交与结果回传。");
    if (requestPaths.length === 1) {
      const generatorArgs = [env.WORKBENCH_CHATGPT_WEB_GENERATOR, "--task-json", snapshotPath, "--task-dir", taskDir, "--request-json", requestPaths[0], "--output", resultPath];
      if (env.WORKBENCH_CHATGPT_RESUME_JOB_ID) generatorArgs.push("--resume-job-id", env.WORKBENCH_CHATGPT_RESUME_JOB_ID);
      await runProcess(process.execPath, generatorArgs, { env: { ...env, WORKBENCH_GENERATION_PROVIDER: provider }, onLine: onEvent });
    } else {
      const segmentResults = [];
      for (let index = 0; index < requestPaths.length; index += 1) {
        const segmentResultPath = join(taskDir, `storyboard-segment-result-${executionRunId}-${index + 1}.json`);
        const recoveredResult = findCompletedSegmentResult(taskDir, requestPaths[index]);
        if (recoveredResult) {
          onEvent?.(`已接回第 ${index + 1}/${requestPaths.length} 段现有结果；不会再次提交。`);
          segmentResults.push({ ...recoveredResult, checkpoint_reused: true });
          continue;
        }
        onEvent?.(`正在生成第 ${index + 1}/${requestPaths.length} 段目标分镜；每段只提交 1 张。`);
        await runProcess(process.execPath, [env.WORKBENCH_CHATGPT_WEB_GENERATOR, "--task-json", snapshotPath, "--task-dir", taskDir, "--request-json", requestPaths[index], "--output", segmentResultPath], { env: { ...env, WORKBENCH_GENERATION_PROVIDER: provider }, onLine: onEvent });
        segmentResults.push(JSON.parse(readFileSync(segmentResultPath, "utf8")));
        if (segmentResults.at(-1)?.status !== "completed") break;
      }
      const completed = segmentResults.length === requestPaths.length && segmentResults.every((item) => item.status === "completed");
      writeFileSync(resultPath, `${JSON.stringify({
        status: completed ? "completed" : "blocked",
        summary: completed ? `已按 Skill 分段生成 ${segmentResults.length} 张目标分镜。` : "分段分镜没有全部生成完成，系统已停止后续提交。",
        estimated_cost_cny: segmentResults.reduce((sum, item) => sum + Number(item.estimated_cost_cny || 0), 0),
        artifacts: segmentResults.flatMap((item) => item.artifacts || []),
        requires_confirmation: true,
        external_request_started: segmentResults.some((item) => item.external_request_started),
        user_message: completed ? `已按原片自然结构生成 ${segmentResults.length} 段分镜，请逐段确认画面、人物、穿搭和动作。` : "已有结果和问题证据均已保留，未开始的段落不会继续提交。",
        segment_results: segmentResults,
      }, null, 2)}\n`, { flag: "wx" });
    }
  } else {
    const promptPath = join(taskDir, `storyboard-prompt-attempt-${executionRunId}.md`);
    const prompt = buildStoryboardPrompt(task, taskDir, snapshotPath, approvedPerson.path, skillContract);
    writeFileSync(promptPath, prompt, { flag: "wx" });
    const recovered = recoverCompletedBuiltinStoryboardResult(task, sourceDurationSeconds, env);
    if (recovered) {
      onEvent?.(`已接回上一次超时前完成的 ${recovered.segment_results.length} 张分镜，不会重新生图。`);
      writeFileSync(resultPath, `${JSON.stringify(recovered, null, 2)}\n`, { flag: "wx" });
    } else {
      await runCodex(prompt, taskDir, resultPath, onEvent, env);
    }
  }
  if (!existsSync(resultPath)) throw new Error("分镜执行器没有返回结构化结果。");
  const parsedResult = JSON.parse(readFileSync(resultPath, "utf8"));
  const result = { ...parsedResult, skill_contract: contractReceipt, skill_contract_receipt_path: contractReceiptPath, external_request_started: Boolean(parsedResult.external_request_started), video_generation_started: false };
  if (result.status !== "completed") return result;
  const ratioChecks = result.segment_results?.map((item) => inspectStoryboardRatio(item)) || null;
  if (ratioChecks && ratioChecks.every((item) => item.pass)) return {
    ...result,
    user_message: `已按原片自然结构生成 ${ratioChecks.length} 段分镜并通过各段比例硬检查，请逐段确认画面、人物、穿搭和动作。`,
    ratio_checks: ratioChecks,
  };
  if (ratioChecks) return {
    ...result,
    status: "blocked",
    summary: "至少一段分镜没有通过单格比例硬检查。",
    user_message: "分段图片已经返回，但至少一段比例不合格，当前整组已拦截；系统没有自动重生其它段落。",
    ratio_checks: ratioChecks,
  };
  const ratioCheck = inspectStoryboardRatio(result);
  if (ratioCheck.pass) return {
    ...result,
    user_message: "目标宫格已生成并通过比例硬检查，请确认画面、人物和动作是否可以采用。",
    ratio_check: ratioCheck,
  };
  if (provider === "chatgpt_web" && task.storyboard_ratio_repair_authorized && requestPath) {
    onEvent?.("首张分镜只因整张画布比例未通过，正在按你已确认的范围自动纠正一次；不会改人物、动作、场景或参考图。 ");
    const repairRunId = `${executionRunId}-ratio-repair-1`;
    const repairSnapshotPath = join(taskDir, `storyboard-task-attempt-${repairRunId}.json`);
    const repairResultPath = join(taskDir, `storyboard-result-attempt-${repairRunId}.json`);
    const repairRequestPath = join(taskDir, `storyboard-ratio-repair-request-${repairRunId}.json`);
    const savedRequest = JSON.parse(readFileSync(requestPath, "utf8"));
    const originalPrompt = savedRequest.final_model_prompt || savedRequest.final_prompt;
    const repairPrompt = createStoryboardRatioRepairPrompt(originalPrompt, savedRequest.storyboard_grid);
    const repairRequest = {
      ...savedRequest,
      attempt_id: `${savedRequest.attempt_id || executionRunId}-ratio-repair-1`,
      idempotency_key: `${savedRequest.idempotency_key || task.id}-ratio-repair-1-${executionRunId}`,
      final_prompt: repairPrompt,
      final_model_prompt: repairPrompt,
      final_model_prompt_sha256: createHash("sha256").update(repairPrompt).digest("hex"),
      objective_ratio_repair: { authorized: true, ordinal: 1, max_corrections: 1, reason: ratioCheck.code },
    };
    assertStoryboardRequestContract(repairRequest);
    writeFileSync(repairRequestPath, `${JSON.stringify(repairRequest, null, 2)}\n`, { flag: "wx" });
    writeFileSync(repairSnapshotPath, `${JSON.stringify({ ...snapshot, execution_run_id: repairRunId, objective_ratio_repair: repairRequest.objective_ratio_repair }, null, 2)}\n`, { flag: "wx" });
    await runProcess(process.execPath, [env.WORKBENCH_CHATGPT_WEB_GENERATOR, "--task-json", repairSnapshotPath, "--task-dir", taskDir, "--request-json", repairRequestPath, "--output", repairResultPath], { env: { ...env, WORKBENCH_GENERATION_PROVIDER: provider }, onLine: onEvent });
    if (!existsSync(repairResultPath)) throw new Error("分镜比例纠正没有返回结构化结果。");
    const repairedResult = JSON.parse(readFileSync(repairResultPath, "utf8"));
    if (repairedResult.status !== "completed") return repairedResult;
    const repairedRatioCheck = inspectStoryboardRatio(repairedResult);
    if (repairedRatioCheck.pass) return {
      ...repairedResult,
      summary: "首张分镜画布比例未通过，系统已自动纠正一次并通过比例硬检查。",
      user_message: "正确比例的目标宫格已经生成，请确认画面、人物和动作是否可以采用。",
      ratio_check: repairedRatioCheck,
      objective_ratio_repair: { performed: true, corrections_used: 1, first_ratio_check: ratioCheck },
    };
    return {
      ...repairedResult,
      status: "blocked",
      summary: `系统已自动纠正一次，但画布比例仍未通过：${repairedRatioCheck.message}`,
      user_message: "系统已经自动纠正过一次，但结果仍不符合目标比例，现已停止继续生成，避免重复占用额度。人物母版、拆解成果和两次问题证据都已保留。",
      requires_confirmation: false,
      ratio_check: repairedRatioCheck,
      objective_ratio_repair: { performed: true, corrections_used: 1, first_ratio_check: ratioCheck },
    };
  }
  return {
    ...result,
    status: "blocked",
    summary: `分镜候选已经生成，但没有通过单格比例硬检查：${ratioCheck.message}`,
    user_message: "图片已经生成，但每格比例不符合目标视频比例，当前候选已拦截，不能采用。当前通道没有执行自动比例纠正，系统不会擅自继续生成。",
    requires_confirmation: true,
    ratio_check: ratioCheck,
  };
}

export function findCompletedSegmentResult(taskDir, requestPath) {
  if (!existsSync(taskDir)) return null;
  const candidates = readdirSync(taskDir)
    .filter((name) => name.startsWith("storyboard-segment-result-") && name.endsWith(".json"))
    .map((name) => join(taskDir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const resultPath of candidates) {
    try {
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      if (result.status !== "completed") continue;
      const receiptArtifact = (result.artifacts || []).find((item) => /执行回执/.test(item.label) && item.path && existsSync(item.path));
      if (!receiptArtifact) continue;
      const receipt = JSON.parse(readFileSync(receiptArtifact.path, "utf8"));
      if (receipt.internal_generation_request_path !== requestPath) continue;
      const candidate = (result.artifacts || []).find((item) => /候选图/.test(item.label));
      if (!candidate?.path || !existsSync(candidate.path)) continue;
      return result;
    } catch { /* ignore unrelated or incomplete historical results */ }
  }
  return null;
}

export function recoverCompletedBuiltinStoryboardResult(task, sourceDurationSeconds, env = process.env) {
  const projectsRoot = join(artifactRoot(env), "02_项目工作区");
  if (!existsSync(projectsRoot)) return null;
  const projectName = readdirSync(projectsRoot).find((name) => name.includes(task.id));
  if (!projectName) return null;
  const stageRoot = join(projectsRoot, projectName, "work", "02_生产过程", "ai-video-storyboard");
  if (!existsSync(stageRoot)) return null;
  const reports = readdirSync(stageRoot)
    .filter((name) => /^storyboard_grid_ratio_check_.*\.json$/.test(name))
    .map((name) => join(stageRoot, name))
    .sort();
  const receipts = readdirSync(stageRoot)
    .filter((name) => /^execution_receipt_.*\.json$/.test(name))
    .map((name) => join(stageRoot, name));
  if (!reports.length || reports.length !== receipts.length) return null;
  if (Number(sourceDurationSeconds) > 15 && reports.length < 2) return null;

  const segmentResults = [];
  try {
    for (let index = 0; index < reports.length; index += 1) {
      const reportPath = reports[index];
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      if (report.pass !== true || report.status !== "pass" || !report.image || !existsSync(report.image)) return null;
      const receiptPath = receipts.find((path) => {
        const receipt = JSON.parse(readFileSync(path, "utf8"));
        return receipt.task_id === task.id && receipt.status === "success" && receipt.project_output_path === report.image && receipt.raw_generation_path && existsSync(receipt.raw_generation_path);
      });
      if (!receiptPath) return null;
      segmentResults.push({
        status: "completed",
        summary: `第 ${index + 1} 段目标分镜已生成并通过比例检查。`,
        estimated_cost_cny: 0,
        artifacts: [
          { label: `目标分镜候选图 · 第 ${index + 1} 段`, path: report.image, published: false },
          { label: `分镜比例检查 · 第 ${index + 1} 段`, path: reportPath, published: false },
          { label: `分镜生成执行回执 · 第 ${index + 1} 段`, path: receiptPath, published: false },
        ],
        requires_confirmation: true,
        external_request_started: true,
      });
    }
  } catch {
    return null;
  }
  return {
    status: "completed",
    summary: `已接回 ${segmentResults.length} 张超时前完成的目标分镜。`,
    estimated_cost_cny: 0,
    artifacts: segmentResults.flatMap((item) => item.artifacts),
    requires_confirmation: true,
    external_request_started: true,
    user_message: `已接回 ${segmentResults.length} 段现有分镜，没有重新生图；请逐段确认画面、人物、穿搭和动作。`,
    segment_results: segmentResults,
    recovered_after_supervisor_timeout: true,
  };
}

async function prepareStoryboardWebRequests({ task, taskDir, snapshotPath, approvedPersonPath, executionRunId, skillContract, sourceDurationSeconds, onEvent, env }) {
  const formalRoot = artifactRoot(env);
  const reusable = findReusableStoryboardRequests(task.id, formalRoot, skillContract, sourceDurationSeconds);
  if (reusable.length) return reusable;
  const recoverable = findRecoverableStoryboardRequests(taskDir, task.id, sourceDurationSeconds);
  if (recoverable.length) {
    for (const path of recoverable) stampStoryboardRequestContract(path, skillContractReceipt(skillContract));
    onEvent?.("已接回上一次完成且未外传的三段分镜方案，不会重复编译或改写提示词。");
    return recoverable;
  }
  const planningResultPath = join(taskDir, `storyboard-web-request-result-${executionRunId}.json`);
  const planningPromptPath = join(taskDir, `storyboard-web-request-prompt-${executionRunId}.md`);
  const prompt = buildStoryboardPrompt(task, taskDir, snapshotPath, approvedPersonPath, skillContract, "prepare_internal_request");
  writeFileSync(planningPromptPath, prompt, { flag: "wx" });
  onEvent?.("正在由分镜与图像资产 Skill 准备正式提示词和逐张参考图职责；此步骤不会生图。");
  await runCodex(prompt, taskDir, planningResultPath, onEvent, env);
  const planningResult = JSON.parse(readFileSync(planningResultPath, "utf8"));
  const requestArtifacts = (planningResult.artifacts || []).filter((item) => isInternalStoryboardRequest(item.path, task.id));
  if (!requestArtifacts.length) throw new Error("STORYBOARD_CHATGPT_INTERNAL_REQUEST_MISSING");
  for (const artifact of requestArtifacts) stampStoryboardRequestContract(artifact.path, skillContractReceipt(skillContract));
  const paths = requestArtifacts.map((item) => item.path);
  assertStoryboardDurationRoute(paths, sourceDurationSeconds);
  return paths;
}

export function findRecoverableStoryboardRequests(taskDir, taskId, sourceDurationSeconds = null) {
  if (!existsSync(taskDir)) return [];
  const results = readdirSync(taskDir)
    .filter((name) => name.startsWith("storyboard-web-request-result-") && name.endsWith(".json"))
    .map((name) => join(taskDir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const resultPath of results) {
    try {
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      if (result.status !== "completed" || result.external_request_started !== false) continue;
      const paths = (result.artifacts || []).map((item) => item.path).filter((path) => isInternalStoryboardRequest(path, taskId));
      assertStoryboardDurationRoute(paths, sourceDurationSeconds);
      if (paths.length) return paths;
    } catch { /* ignore unrelated or incomplete interrupted requests */ }
  }
  return [];
}

export function findReusableStoryboardRequest(taskId, artifactRoot, skillContract) {
  return findReusableStoryboardRequests(taskId, artifactRoot, skillContract, null)[0] || null;
}

export function findReusableStoryboardRequests(taskId, artifactRoot, skillContract, sourceDurationSeconds = null) {
  const projectsRoot = join(artifactRoot, "02_项目工作区");
  if (!existsSync(projectsRoot)) return [];
  const candidates = [];
  for (const name of readdirSync(projectsRoot)) {
    if (!name.includes(taskId)) continue;
    collectStoryboardRequestFiles(join(projectsRoot, name, "work"), 5, candidates);
  }
  const matched = candidates
    .filter((path) => isInternalStoryboardRequest(path, taskId, skillContract))
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
  const latestBatch = matched.length ? matched.filter((path) => statSync(path).mtimeMs >= statSync(matched.at(-1)).mtimeMs - 5000) : [];
  try { assertStoryboardDurationRoute(latestBatch, sourceDurationSeconds); return latestBatch; } catch { return []; }
}

function collectStoryboardRequestFiles(root, remainingDepth, output) {
  if (!existsSync(root) || remainingDepth < 0) return;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stats = statSync(path);
    if (stats.isDirectory()) collectStoryboardRequestFiles(path, remainingDepth - 1, output);
    else if (
      name === "clean_image_task.json"
      || name.endsWith("_internal_request.json")
      || (name.endsWith(".json") && path.includes(`${join("03_internal_requests", "")}`))
    ) output.push(path);
  }
}

function isInternalStoryboardRequest(path, taskId, skillContract = null) {
  if (!path || !existsSync(path)) return false;
  try {
    const request = JSON.parse(readFileSync(path, "utf8"));
    assertStoryboardRequestContract(request);
    return request.request_type === "internal_image_generation_request"
      && request.task_id === taskId
      && ["target_grid_storyboard", "segment_storyboard"].includes(request.asset_type)
      && Boolean(request.final_prompt || request.final_model_prompt)
      && Array.isArray(request.reference_images)
      && request.reference_images.length > 0
      && request.reference_images.every((item) => item.path && existsSync(item.path))
      && (!skillContract || sameSkillContract(request.workbench_skill_contract, skillContract));
  } catch { return false; }
}

export function readSourceDurationSeconds(sourceAnalysisDir) {
  for (const name of ["source_manifest.json", "local-baseline.json", "remix-dna.json"]) {
    const path = join(sourceAnalysisDir, name);
    if (!existsSync(path)) continue;
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      const duration = Number(
        value?.source?.duration_seconds
          ?? value?.source_video_meta?.duration_seconds
          ?? value?.video_meta?.duration_seconds
          ?? value?.duration_seconds
          ?? value?.video?.duration_seconds,
      );
      if (Number.isFinite(duration) && duration > 0) return duration;
    } catch { /* ignore malformed duration evidence and continue fallback search */ }
  }
  return null;
}

function assertStoryboardDurationRoute(paths, sourceDurationSeconds) {
  if (!(Number(sourceDurationSeconds) > 15)) return;
  if (paths.length < 2) throw new Error("STORYBOARD_LONG_VIDEO_SEGMENT_ROUTE_MISSING");
  const requests = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  if (requests.some((item) => item.asset_type !== "segment_storyboard" || !item.segment_id || !item.segment_time_range))
    throw new Error("STORYBOARD_LONG_VIDEO_SEGMENT_CONTRACT_INVALID");
}

function stampStoryboardRequestContract(path, receipt) {
  const request = JSON.parse(readFileSync(path, "utf8"));
  assertStoryboardRequestContract(request);
  writeFileSync(path, `${JSON.stringify({ ...request, workbench_skill_contract: receipt }, null, 2)}\n`);
}

function sameSkillContract(recorded, current) {
  return recorded?.owner_skill === current.owner_skill
    && recorded?.source_sha256 === current.source_sha256
    && recorded?.bridge_version === current.bridge_version;
}

function runCodex(prompt, taskDir, resultPath, onEvent, env) {
  const args = ["exec", "-", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "--model", env.WORKBENCH_CODEX_MODEL || "gpt-5.6-sol", "-C", taskDir, "--add-dir", codexWorkspaceRoot(env)];
  const formalRoot = artifactRoot(env);
  if (existsSync(formalRoot)) args.push("--add-dir", formalRoot);
  args.push("--output-schema", schemaPath, "--output-last-message", resultPath);
  return runManagedCodex({ args, prompt, env, onEvent, timeoutMs: Number(env.WORKBENCH_STORYBOARD_TIMEOUT_MS || 30 * 60 * 1000) });
}

function runProcess(command, args, { env, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); onLine?.(chunk.toString().trim()); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || `分镜生成适配器退出码 ${code}`)));
  });
}

export function buildStoryboardPrompt(task, taskDir, snapshotPath, approvedPersonPath, skillContract, executionMode = "generate_candidate") {
  return buildSkillOwnedPrompt({
    contract: skillContract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      task_snapshot_path: snapshotPath,
      work_dir: taskDir,
      source_analysis_dir: join(taskDir, "01_source_video_analysis"),
      source_duration_seconds: readSourceDurationSeconds(join(taskDir, "01_source_video_analysis")),
      approved_person_path: approvedPersonPath,
      storyboard_mode: task.storyboard_mode,
      storyboard_brief: task.storyboard_brief || null,
      remix_precision_route: task.remix_precision_route || null,
      remix_change_contract: task.remix_change_contract || null,
      upload_authorization_scope: task.storyboard_upload_scope || null,
      rewrite_mode: task.rewrite_mode,
      generation_provider: task.storyboard_generation_provider || task.default_image_generation_provider || "codex_builtin",
      attempt_number: task.storyboard_attempt_count,
    },
    runtimeEnvelope: {
      operation: executionMode,
      image_generation_allowed: executionMode === "generate_candidate",
      requested_output_count: "由 Skill 按原片时长与自然段落决定；每段只生成 1 张候选",
      source_frame_upload_authorized: Boolean(task.storyboard_source_upload_authorized),
      scene_reference_upload_authorized: Boolean(task.storyboard_upload_scope?.scene_reference_paths?.length),
      scene_reference_paths: task.storyboard_upload_scope?.scene_reference_paths || [],
      product_reference_upload_authorized: Boolean(task.storyboard_upload_scope?.product_reference_paths?.length),
      product_reference_paths: task.storyboard_upload_scope?.product_reference_paths || [],
      approved_person_reference_paths: task.storyboard_upload_scope?.approved_person_paths || [approvedPersonPath],
      unlisted_asset_upload_allowed: false,
      automatic_retry_allowed: false,
      provider_switch_allowed: false,
      video_generation_allowed: false,
      existing_source_analysis_must_be_reused: true,
      local_source_handoff_preparation_allowed: executionMode === "prepare_internal_request",
      local_source_handoff_preparation_scope: "仅可用现有 remix-dna、semantic-merge、source_style_calibration、source_keyframe_manifest 和原片抽帧补齐正式 Skill 要求的文字分段总览、分段路由、原片风格执行合同与每段结构锚点；不得重新调用外部拆解、不得生图。",
      objective_canvas_contract_required: true,
      objective_canvas_contract_validator: "storyboard_grid_ratio_check",
      output_interface: {
        expected_artifact: executionMode === "prepare_internal_request" ? "由 Skill 决定的一个或多个分镜内部生图请求" : "目标分镜候选图",
        internal_request_type: executionMode === "prepare_internal_request" ? "internal_image_generation_request" : null,
        allowed_internal_request_asset_types: executionMode === "prepare_internal_request" ? ["target_grid_storyboard", "segment_storyboard"] : null,
        segment_request_required_fields: executionMode === "prepare_internal_request" ? ["segment_id", "segment_time_range"] : null,
        segment_request_field_contract: executionMode === "prepare_internal_request" ? "asset_type=segment_storyboard 时，两字段必须位于请求顶层；segment_id 是稳定段号，segment_time_range 是该段起止秒数。它们只用于排序、断点续做和防串段，不改变 Skill 的分段决策。" : null,
        approval_status: "needs_review",
        published: false,
        estimated_cost_cny: 0,
        requires_confirmation: true,
        external_request_started_before_image_generation: false,
      },
      user_message_policy: "只用大白话说明结果和下一步，不展示内部路径、执行器或合同字段。",
    },
  });
}
