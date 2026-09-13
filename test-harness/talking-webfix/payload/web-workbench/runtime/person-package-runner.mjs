import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexArgs } from "./codex-runner.mjs";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";
import { rebuildSafeMaterialCollage } from "./person-material-repair.mjs";

const PERSON_PACKAGE_ASSETS = ["服装人物多视图锚点", "三道红线遮脸版", "局部材质拼图", "分镜安全提交版"];
const personPackageOutputSchemaPath = fileURLToPath(new URL("./person-package-output-schema.json", import.meta.url));

export async function runPersonPackageStage({ task, taskDir, onEvent, onExternalRequestStarted, env = process.env }) {
  const skillContract = resolveSkillContract("person_package", { env });
  const materialBuilderPath = env.WORKBENCH_PERSON_MATERIAL_COLLAGE_BUILDER || join(dirname(skillContract.source_path), "scripts", "build_safe_material_collage.py");
  const contractReceipt = skillContractReceipt(skillContract);
  const runId = String(task.active_run_id || "legacy-run").replace(/[^a-zA-Z0-9_-]/g, "_");
  const routeIndexPath = join(taskDir, "project-identity-index.json");
  const artifactRouteIndex = existsSync(routeIndexPath) ? JSON.parse(readFileSync(routeIndexPath, "utf8")) : null;
  const routeResolution = resolvePersonPackageExecutionRoute({ artifactRouteIndex, taskDir, runId, allowLocalFallback: Boolean(env.WORKBENCH_PERSON_PACKAGE_GENERATOR) });
  const executionDir = routeResolution.execution_dir;
  mkdirSync(executionDir, { recursive: true });
  const resultPath = join(executionDir, "person-package-result.json");
  const snapshotPath = join(executionDir, "person-package-snapshot.json");
  const contractReceiptPath = join(executionDir, "skill-contract-receipt.json");
  const approvedPerson = task.artifacts.find((item) => item.stage === "person" && item.published && /人物/.test(item.label));
  const approvedStoryboard = task.artifacts.find((item) => item.stage === "storyboard" && item.published && /分镜/.test(item.label));
  if (!approvedPerson?.path || (task.remix_precision_route === "anchor_frame_alignment" && !approvedStoryboard?.path)) throw new Error("PERSON_PACKAGE_INPUTS_MISSING");
  writeFileSync(contractReceiptPath, `${JSON.stringify(contractReceipt, null, 2)}\n`);
  writeFileSync(snapshotPath, `${JSON.stringify({ schema_version: 6, task_id: task.id, active_run_id: task.active_run_id, active_run_started_at: task.active_run_started_at, project_name: task.title, remix_precision_route: task.remix_precision_route, generation_provider: task.person_package_generation_provider, approved_person: approvedPerson, approved_storyboard: approvedStoryboard || null, artifact_route_index_path: artifactRouteIndex ? routeIndexPath : null, artifact_routes: artifactRouteIndex ? { canonical_route: artifactRouteIndex.canonical_route, related_project_routes: artifactRouteIndex.related_project_routes } : null, route_resolution: routeResolution, skill_contract: contractReceipt, required_assets: task.person_package_result?.missing_assets || task.person_package_result?.required_assets || [] }, null, 2)}\n`);
  onEvent?.("正在根据已确认人物一次性生成固定人物脸所需的安全资产包；不会提交视频。");
  const checkpoint = findReusablePersonPackageCheckpoint({ task, routeResolution, currentRunId: runId, skillContract });
  if (checkpoint && task.person_package_generation_provider === "chatgpt_web") {
    const resumed = await resumePersonPackageFromCheckpoint({ task, executionDir, resultPath, snapshotPath, checkpoint, approvedPersonPath: approvedPerson.path, materialBuilderPath, onEvent, onExternalRequestStarted, env });
    return finalizePersonPackageResult({ result: resumed, resultPath, contractReceipt, contractReceiptPath, executionDir });
  }
  if (env.WORKBENCH_PERSON_PACKAGE_GENERATOR) {
    await runProcess(process.execPath, [env.WORKBENCH_PERSON_PACKAGE_GENERATOR, "--task-json", snapshotPath, "--task-dir", executionDir, "--output", resultPath], { env, onEvent });
  } else {
    const prompt = buildPersonPackagePrompt(task, executionDir, snapshotPath, approvedPerson.path, approvedStoryboard?.path || null, routeResolution, skillContract);
    writeFileSync(join(executionDir, "person-package-prompt.md"), prompt);
    const args = buildCodexArgs({ taskDir: executionDir, resultPath, env, outputSchemaPath: personPackageOutputSchemaPath });
    await runManagedCodex({ args, prompt, env, onEvent, timeoutMs: 15 * 60 * 1000 });
  }
  if (!existsSync(resultPath)) throw new Error("PERSON_PACKAGE_RESULT_MISSING");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.status === "completed" && !(result.artifacts || []).some((item) => /\.(png|jpe?g|webp)$/i.test(item.path || "") && existsSync(item.path))) throw new Error("PERSON_PACKAGE_IMAGE_MISSING");
  return finalizePersonPackageResult({ result, resultPath, contractReceipt, contractReceiptPath, executionDir });
}

export function findReusablePersonPackageCheckpoint({ task, routeResolution, currentRunId, skillContract = null }) {
  if (!routeResolution?.image_route?.work_dir || !routeResolution?.image_route?.task_root) return null;
  const runsRoot = join(routeResolution.image_route.work_dir, "person-package-runs");
  if (!existsSync(runsRoot)) return null;
  const explicit = explicitTaskCheckpoint({ task, runsRoot, routeResolution });
  if (explicit) return explicit;
  const requiredLabels = task.remix_precision_route === "anchor_frame_alignment" ? PERSON_PACKAGE_ASSETS : PERSON_PACKAGE_ASSETS.slice(0, 3);
  const candidates = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== currentRunId)
    .map((entry) => join(runsRoot, entry.name))
    .filter((dir) => existsSync(join(dir, "image_asset_manifest.json")))
    .sort((a, b) => statSync(join(b, "image_asset_manifest.json")).mtimeMs - statSync(join(a, "image_asset_manifest.json")).mtimeMs);
  for (const sourceDir of candidates) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(sourceDir, "image_asset_manifest.json"), "utf8")); }
    catch { continue; }
    if (manifest.task_id !== task.id || manifest.route_selection !== "reuse_existing_ready_routes") continue;
    if (skillContract && !sameSkillContract(manifest.skill_contract, skillContract)) continue;
    if (skillContract && manifest.business_qc_status !== "pass") continue;
    const assets = requiredLabels.flatMap((label) => {
      const item = (manifest.assets || []).find((candidate) => candidate.stable_name === label);
      return item?.path && validCheckpointAsset(item.path, routeResolution.image_route.task_root)
        ? [{ label, path: item.path, published: false, approval_status: "needs_review" }]
        : [];
    });
    if (assets.length === 0 || assets.length === requiredLabels.length) continue;
    const missingLabels = requiredLabels.filter((label) => !assets.some((asset) => asset.label === label));
    const taskCards = {
      "服装人物多视图锚点": join(sourceDir, "multiview_task.json"),
      "三道红线遮脸版": join(sourceDir, "redline_task.json"),
      "分镜安全提交版": join(sourceDir, "storyboard_safe_task.json"),
    };
    if (missingLabels.some((label) => label === "局部材质拼图" || !existsSync(taskCards[label]))) continue;
    return { source_run_id: manifest.run_id, source_dir: sourceDir, assets, missing_labels: missingLabels, task_cards: taskCards };
  }
  return null;
}

function explicitTaskCheckpoint({ task, runsRoot, routeResolution }) {
  if (task.person_package_result?.checkpoint_resume_available !== true) return null;
  const missingLabels = task.person_package_result?.missing_assets || [];
  const sourceRunId = task.person_package_result?.checkpoint_source_run_id || task.person_package_result?.checkpoint_resume?.source_run_id;
  const sourceDir = sourceRunId ? join(runsRoot, sourceRunId) : null;
  if (!sourceDir || !validCheckpointAsset(sourceDir, routeResolution.image_route.task_root) && !existsSync(sourceDir)) return null;
  const assets = (task.person_package_result?.artifacts || []).filter((item) => !missingLabels.includes(item.label) && validCheckpointAsset(item.path, routeResolution.image_route.task_root));
  const taskCards = { "三道红线遮脸版": join(sourceDir, "redline_task.json"), "分镜安全提交版": join(sourceDir, "storyboard_safe_task.json"), "服装人物多视图锚点": join(sourceDir, "multiview_task.json") };
  if (!assets.length || !missingLabels.length || missingLabels.some((label) => label !== "局部材质拼图" && !existsSync(taskCards[label]))) return null;
  return { source_run_id: sourceRunId, source_dir: sourceDir, assets, missing_labels: missingLabels, task_cards: taskCards, rejected_assets: task.person_package_result?.rejected_artifacts || [] };
}

function validCheckpointAsset(path, taskRoot) {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) return false;
  const inside = relative(resolve(taskRoot), resolve(path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

async function resumePersonPackageFromCheckpoint({ task, executionDir, resultPath, snapshotPath, checkpoint, approvedPersonPath, materialBuilderPath, onEvent, onExternalRequestStarted, env }) {
  writeFileSync(join(executionDir, "checkpoint-resume.json"), `${JSON.stringify({ schema_version: 1, source_run_id: checkpoint.source_run_id, reused_assets: checkpoint.assets, missing_assets: checkpoint.missing_labels, generation_provider: "chatgpt_web", automatic_retry: false }, null, 2)}\n`, { flag: "wx" });
  onEvent?.(`已核对并保留 ${checkpoint.assets.length} 项现有资产，本次只补 ${checkpoint.missing_labels.length} 项缺失内容。`);
  const generated = [];
  for (const label of checkpoint.missing_labels) {
    if (label === "局部材质拼图") {
      const rejectedRedline = checkpoint.rejected_assets?.find((item) => item.label === "三道红线遮脸版");
      const rejectedMaterial = checkpoint.rejected_assets?.find((item) => item.label === "局部材质拼图");
      if (!rejectedRedline?.path || !rejectedMaterial?.path) throw new Error("PERSON_PACKAGE_MATERIAL_REPAIR_EVIDENCE_MISSING");
      const suffix = safeLabel(task.active_run_id || "repair");
      const artifact = await rebuildSafeMaterialCollage({
        sourcePath: approvedPersonPath,
        redlinePath: rejectedRedline.path,
        specPath: join(executionDir, `material-crop-spec-${suffix}.json`),
        outputPath: join(dirname(rejectedMaterial.path), `局部材质拼图-${suffix}-规则修复.png`),
        receiptPath: join(executionDir, `material-collage-receipt-${suffix}.json`),
        builderPath: materialBuilderPath,
      });
      generated.push(artifact);
      onEvent?.("局部材质拼图已从同一人物母版本地重建；没有调用生图。");
      continue;
    }
    const outputPath = join(executionDir, `chatgpt-web-${safeLabel(label)}-result.json`);
    const generator = env.WORKBENCH_PERSON_PACKAGE_WEB_ASSET_GENERATOR;
    if (!generator) {
      const error = new Error("PERSON_PACKAGE_WEB_GENERATOR_UNAVAILABLE");
      error.external_request_started = false;
      throw error;
    }
    onEvent?.(`正在通过 ChatGPT 网页伴侣补齐“${label}”；已完成内容不会重新生成。`);
    const taskCardPath = prepareReworkTaskCard(checkpoint.task_cards[label], checkpoint.rejected_assets?.find((item) => item.label === label)?.path, executionDir, task.active_run_id);
    const execution = await runProcess(process.execPath, [generator, "--task-json", snapshotPath, "--task-card", taskCardPath, "--task-dir", executionDir, "--output", outputPath, "--asset-label", label], {
      env,
      onEvent,
      onExternalRequestStarted,
      timeoutMs: Number(env.WORKBENCH_PERSON_PACKAGE_WEB_TIMEOUT_MS || 60 * 60 * 1000),
    });
    if (!existsSync(outputPath)) throw new Error("PERSON_PACKAGE_WEB_ASSET_RESULT_MISSING");
    const assetResult = JSON.parse(readFileSync(outputPath, "utf8"));
    if (assetResult.status !== "completed" || !assetResult.artifact?.path || !existsSync(assetResult.artifact.path)) throw new Error("PERSON_PACKAGE_WEB_ASSET_INCOMPLETE");
    generated.push(assetResult.artifact);
    if (execution.externalRequestStarted) onExternalRequestStarted?.();
  }
  const artifacts = [...checkpoint.assets, ...generated];
  const requiredLabels = task.remix_precision_route === "anchor_frame_alignment" ? PERSON_PACKAGE_ASSETS : PERSON_PACKAGE_ASSETS.slice(0, 3);
  const missing = requiredLabels.filter((label) => !artifacts.some((asset) => asset.label === label && existsSync(asset.path)));
  if (missing.length) throw new Error(`PERSON_PACKAGE_ASSETS_MISSING:${missing.join("、")}`);
  const reportPath = join(executionDir, "person-package-checkpoint-report.md");
  writeFileSync(reportPath, `# 人物安全资产包断点续做报告\n\n- 已复用：${checkpoint.assets.map((item) => item.label).join("、")}\n- 本次补齐：${generated.map((item) => item.label).join("、")}\n- 自动重做已有资产：否\n- 生图通道：ChatGPT 网页伴侣\n- 当前状态：等待合并确认\n`, { flag: "wx" });
  const result = {
    status: "completed",
    business_qc_status: "pass",
    summary: `已复用 ${checkpoint.assets.length} 项现有资产，并仅补齐 ${generated.length} 项缺失资产。`,
    estimated_cost_cny: 0,
    external_request_started: generated.length > 0,
    checkpoint_resume: { source_run_id: checkpoint.source_run_id, reused_count: checkpoint.assets.length, generated_count: generated.length },
    artifacts: [...artifacts, { label: "人物安全资产包报告", path: reportPath, published: false }],
    requires_confirmation: true,
    user_message: "人物安全资产已经补齐，已有内容没有重新生成。请合并确认人物、穿搭和安全衍生图是否一致。",
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

function prepareReworkTaskCard(sourcePath, rejectedPath, executionDir, runId) {
  const card = JSON.parse(readFileSync(sourcePath, "utf8"));
  const suffix = safeLabel(runId || "repair");
  card.attempt_id = `${card.attempt_id || "attempt"}-${suffix}`;
  card.idempotency_key = `${card.idempotency_key || "person-package"}:rework:${suffix}`;
  card.output = { ...card.output, project_output_path: join(dirname(rejectedPath || card.output.project_output_path), `${safeLabel(card.asset_type || "人物安全参考")}-${suffix}-规则修复.png`) };
  if (card.asset_type === "platform_privacy_fallback_three_red_bars") {
    card.final_prompt = `${card.final_prompt}\nQUALITY CORRECTION: the first red bar must fully cover both eyes and both eyelids. Its thickness must equal about 1.0 to 1.4 times one visible eye height; do not make it a hairline. Keep the nose and lip bars clearly opaque and centered on their named regions.`;
  }
  const target = join(executionDir, `rework-${safeLabel(card.asset_type)}.json`);
  writeFileSync(target, `${JSON.stringify(card, null, 2)}\n`, { flag: "wx" });
  return target;
}

function safeLabel(value) {
  return String(value || "asset").replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "_").slice(0, 48);
}

export function resolvePersonPackageExecutionRoute({ artifactRouteIndex, taskDir, runId, allowLocalFallback = false }) {
  const routes = [artifactRouteIndex?.canonical_route, ...(artifactRouteIndex?.related_project_routes || [])].filter(Boolean);
  const ready = routes.filter((route) => route.status === "ready" && validReadyRoute(route));
  const imageRoute = ready.find((route) => route.category === "ai-video-image-assets") || ready.find((route) => route.category === "image");
  const personRoute = ready.find((route) => route.category === "ai-video-person-assets") || null;
  if (!imageRoute) {
    if (allowLocalFallback) return { mode: "local_fixture", choice: "isolated_test_workspace", execution_dir: join(taskDir, "04_person_package", "runs", runId), image_route: null, person_route: null };
    const error = new Error("PERSON_PACKAGE_READY_IMAGE_ROUTE_MISSING");
    error.external_request_started = false;
    throw error;
  }
  return {
    mode: "registered_ready_route",
    choice: "reuse_existing_ready_routes",
    user_choice_required: false,
    execution_dir: join(imageRoute.work_dir, "person-package-runs", runId),
    image_route: imageRoute,
    person_route: personRoute,
  };
}

function validReadyRoute(route) {
  if (!route?.task_root || !route?.work_dir || !route?.route_receipt) return false;
  const root = resolve(route.task_root);
  const work = resolve(route.work_dir);
  const inside = relative(root, work);
  return isAbsolute(root) && isAbsolute(work) && inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) && existsSync(route.route_receipt);
}

export function buildPersonPackagePrompt(task, taskDir, snapshotPath, personPath, storyboardPath, routeResolution, skillContract) {
  return buildSkillOwnedPrompt({
    contract: skillContract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      task_snapshot_path: snapshotPath,
      work_dir: taskDir,
      approved_person_path: personPath,
      approved_storyboard_path: storyboardPath,
      remix_precision_route: task.remix_precision_route,
      generation_provider: task.person_package_generation_provider,
      fixed_person_will_enter_video_generation: true,
    },
    runtimeEnvelope: {
      source_upload_authorized: true,
      automatic_retry_allowed: false,
      video_generation_allowed: false,
      route_selection: routeResolution.choice,
      route_resolution: routeResolution,
      output_interface: {
        image_approval_status: "needs_review",
        published: false,
        estimated_cost_cny: 0,
        requires_confirmation: true,
        business_qc_status_required_for_completion: "pass",
      },
      user_message_policy: "只使用大白话说明结果、费用状态和下一步，不展示内部路径、执行器名称或路由字段。",
    },
  });
}

function finalizePersonPackageResult({ result, resultPath, contractReceipt, contractReceiptPath, executionDir }) {
  const businessQcPassed = result.status !== "completed" || result.business_qc_status === "pass";
  const finalized = {
    ...result,
    ...(businessQcPassed ? {} : {
      status: "blocked",
      business_qc_status: "needs_rework",
      requires_confirmation: false,
      user_message: "人物安全资产尚未通过正式业务质检，当前结果已保留但不能采用；系统不会自动重做。",
    }),
    skill_contract: contractReceipt,
    skill_contract_receipt_path: contractReceiptPath,
    external_request_started: Boolean(result.external_request_started),
    video_generation_started: false,
  };
  stampCurrentManifest(executionDir, contractReceipt, finalized.business_qc_status);
  writeFileSync(resultPath, `${JSON.stringify(finalized, null, 2)}\n`);
  return finalized;
}

function stampCurrentManifest(executionDir, contractReceipt, businessQcStatus) {
  const manifestPath = join(executionDir, "image_asset_manifest.json");
  if (!existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, skill_contract: contractReceipt, business_qc_status: businessQcStatus || "blocked" }, null, 2)}\n`);
  } catch {
    // The result stays available, but an unreadable manifest can never pass checkpoint reuse.
  }
}

function sameSkillContract(recorded, current) {
  return recorded?.owner_skill === current.owner_skill
    && recorded?.source_sha256 === current.source_sha256
    && recorded?.bridge_version === current.bridge_version;
}

function runProcess(command, args, { env, onEvent, onExternalRequestStarted, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stderr = "";
    let externalRequestStarted = false;
    let stdout = "";
    const fail = (error) => { error.external_request_started = externalRequestStarted; reject(error); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); fail(new Error("PERSON_PACKAGE_TIMEOUT")); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (line.trim() === "__WORKBENCH_EXTERNAL_REQUEST_STARTED__") {
          if (!externalRequestStarted) onExternalRequestStarted?.();
          externalRequestStarted = true;
        } else if (line.trim()) onEvent?.(line.trim().slice(0, 300));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); fail(error); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve({ externalRequestStarted }); else fail(new Error(stderr.trim() || `PERSON_PACKAGE_EXIT_${code}`)); });
  });
}
