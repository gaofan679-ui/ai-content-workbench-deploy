import { talkingConfiguration } from "./talking-configuration.mjs";
import "./load-customer-env.mjs";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import {
  runRunningHubH3VideoGeneration,
  runRunningHubH3VideoRework,
} from "./runninghub-h3-video-runner.mjs";
import { fileURLToPath } from "node:url";
import {
  STATUSES,
  addCopilotMessage,
  addEvent,
  approvePersonAsset,
  approveProductAssets,
  approvePersonPackage,
  approveStoryboard,
  beginGenerationPack,
  beginMotionPreflight,
  beginPersonGeneration,
  beginProductAssets,
  beginPersonPackageGeneration,
  beginStage,
  beginStoryboardGeneration,
  beginVideoGeneration,
  beginVideoPrompt,
  blockStage,
  blockRuntimeStage,
  completeWithoutRewrite,
  createTask,
  failPersonGeneration,
  failProductAssets,
  failStage,
  failStoryboardGeneration,
  finishPersonGeneration,
  finishProductAssets,
  failGenerationPack,
  failMotionPreflight,
  failPersonPackageGeneration,
  failVideoGeneration,
  failVideoPrompt,
  finishGenerationPack,
  finishMotionPreflight,
  finishPersonPackageGeneration,
  finishStage,
  finishStoryboardGeneration,
  finishVideoGeneration,
  finishVideoPrompt,
  getArtifact,
  getTask,
  listTasks,
  openDatabase,
  pauseStage,
  prepareDirectVideoGeneration,
  preparePersonInputs,
  registerAuthorizedPersonSource,
  prepareStoryboardInputs,
  recordTaskRunProgress,
  markTaskRunExternalRequestStarted,
  markVideoGenerationExternalRequestStarted,
  markVideoReworkExternalRequestStarted,
  authorizeVideoQualityRevalidation,
  authorizeFullVideoGeneration,
  authorizeFullVideoQualityRevalidation,
  authorizeContractRepairFullVideoValidation,
  prepareVideoReworkRequest,
  saveVideoReworkPlan,
  beginVideoReworkGeneration,
  finishVideoReworkGeneration,
  approveVideoResult,
  failVideoReworkGeneration,
  resumeVideoGenerationResult,
  resolveVideoPromptBusinessClaims,
  saveDecompositionOnly,
  setDefaultImageGenerationProvider,
  updateProductInputs,
  updateProductScope,
  markCodexTaskConnecting,
  markCodexTaskRunning,
  rememberCodexTaskThread,
  finishCodexTaskBinding,
  failCodexTaskBinding,
  createSocialExtraction,
  listSocialExtractions,
  getSocialExtraction,
  finishSocialExtraction,
  failSocialExtraction,
  recordWorkflowHandoff,
} from "./db.mjs";
import { runCodexStage } from "./codex-runner.mjs";
import { runPersonStage } from "./person-runner.mjs";
import { runProductAssetsStage } from "./product-assets-runner.mjs";
import { runStoryboardStage } from "./storyboard-runner.mjs";
import { runMotionPreflightStage } from "./motion-preflight-runner.mjs";
import {
  generationPackPromptRevisionFeedback,
  generationUploadAssetFingerprint,
  generationUploadAssetsForTask,
  mayReuseCompletedVideoPromptRetry,
  runVideoPromptStage,
} from "./video-prompt-runner.mjs";
import { runGenerationPackStage } from "./generation-pack-runner.mjs";
import { runLibTVVideoGeneration } from "./libtv-video-runner.mjs";
import {
  discoverVideoReworkPlan,
  prepareDirectRetryPlan,
} from "./video-rework-plan.mjs";
import { runPersonPackageStage } from "./person-package-runner.mjs";
import { resolveSkillContract } from "./skill-contract-bridge.mjs";
import { userVisibleProgress } from "./user-progress.mjs";
import {
  buildWorkflowHandoffEnvelope,
} from "./workflow-handoff.mjs";
import {
  loadVideoModelCatalog,
  resolveExistingVideoGenerationSelection,
  resolveVideoGenerationSelection,
} from "./video-generation-options.mjs";
import { inspectCodexExecutionSupervisor } from "./codex-execution-supervisor.mjs";
import {
  ensureFormalPersonCandidate,
  linkedOriginPublishArgs,
  resolvePersonArtifactRoute,
  resolvePersonExecutionReceipt,
} from "./person-publication.mjs";
import { answerTaskQuestion, fallbackTaskAnswer } from "./copilot-runner.mjs";
import {
  createProjectCodexTask,
  inspectCodexProjectTaskBridge,
  openCodexThreadInDesktop,
  projectTaskExecutionMessage,
  projectTaskFullVideoMessage,
  projectTaskRegisteredProductScopeMessage,
  isCodexTransportDisconnect,
  resolveCodexBinary,
} from "./codex-project-task.mjs";
import {
  loadRuntimeGenerationRequest,
  recordRuntimeGenerationRequestFailure,
  readRuntimeGenerationStatus,
  runConfirmedRuntimeGeneration,
  runRuntimeGenerationPreflight,
} from "./runninghub-runtime-bridge.mjs";
import {
  loadRuntimeDecompositionRequest,
  readRuntimeDecompositionStatus,
  runRuntimeDecomposition,
} from "./doubao-runtime-bridge.mjs";
import {
  artifactRoot,
  artifactToolFile,
  configuredBinary,
} from "./portable-paths.mjs";

import {
  BRIDGE_CLIENT,
  bridgeRoot,
  browserJobAsset,
  completeBrowserJob,
  confirmManualBrowserSubmission,
  getBrowserJob,
  inspectChatGPTBridge,
  manualPendingBrowserJob,
  nextBrowserJob,
  publicBrowserJob,
  recordHeartbeat,
  resumableBrowserJob,
  updateBrowserJob,
} from "./chatgpt-web-bridge.mjs";
import {
  findRegisteredSocialSource,
  inspectSocialExtractionAvailability,
  runSocialExtraction,
} from "./social-extract-runner.mjs";
import {
  approveXhsJewelryBase,
  approveXhsJewelryFinal,
  approveXhsJewelryVideo,
  beginXhsJewelryStage,
  bindXhsJewelryBrowserJob,
  setXhsJewelryResultCheck,
  beginXhsJewelryVideo,
  canRetryFailedXhsJewelryStage,
  createXhsJewelryTask,
  failXhsJewelryStage,
  failXhsJewelryVideo,
  finishXhsJewelryStage,
  finishXhsJewelryVideo,
  getXhsJewelryTask,
  initializeXhsJewelryTables,
  listXhsJewelryTasks,
  markXhsJewelryExternalRequestStarted,
  recoverXhsJewelryCompletedResult,
  requestXhsJewelryRework,
  updateXhsJewelryProgress,
  xhsJewelryStageForStart,
} from "./xhs-jewelry-tasks.mjs";
import {
  inspectXhsJewelryRuntime,
  runXhsJewelryStage,
  validateXhsJewelryResult,
} from "./xhs-jewelry-runner.mjs";
import { inspectXhsJewelryOriginalWebResult } from "./xhs-jewelry-web-generator.mjs";
import { pendingBrowserJobForTask } from "./chatgpt-web-bridge.mjs";
import { runXhsJewelryVideo } from "./xhs-jewelry-video-runner.mjs";
import {
  approveTalkingHeadVideo,
  approveTalkingHeadVoice,
  cancelTalkingHeadJob,
  createNativeTalkingHeadJob,
  createTalkingHeadJob,
  createTalkingHeadVoiceJob,
  ensureTalkingHeadJobRecovery,
  getTalkingHeadJob,
  listTalkingHeadJobs,
  regenerateNativeTalkingHeadVersion,
  startTalkingHeadJob,
  startTalkingHeadVoiceJob,
  updateTalkingHeadJob,
} from "./talking-head-runner.mjs";
import {
  createTalkingHeadPersonAssetBinding,
  createTalkingHeadPersonAsset,
  getTalkingHeadPersonAsset,
  isTalkingHeadProjectId,
  personAssetFile,
  publicTalkingHeadPersonAsset,
} from "./talking-head-person-assets.mjs";
import {
  addModelAssetSource,
  adoptModelAsset,
  approveModelStylePrompt,
  createModelAssetProject,
  failModelAssetGeneration,
  failModelStyleAnalysis,
  finishModelAssetGeneration,
  finishModelStyleAnalysis,
  getApprovedModelAsset,
  getInternalModelAssetProject,
  getModelAssetFile,
  getModelAssetProject,
  importReadyModelMaster,
  listModelAssetProjects,
  prepareModelAssetGeneration,
  prepareModelStyleAnalysis,
  recoverInterruptedModelAssetGenerations,
  recordModelAssetGenerationProgress,
  setModelAssetLibraryArchived,
} from "./model-assets.mjs";
import {
  reconcileBlockedModelAssetResult,
  runModelAssetGeneration,
} from "./model-asset-runner.mjs";
import { runModelStyleAnalysis } from "./model-style-analysis-runner.mjs";
import {
  dialectDraftCacheKey,
  runDialectDraftWithCodex,
} from "./dialect-draft-runner.mjs";

const REMIX_EXECUTION_OWNER = "project_codex_task";
const LEGACY_REMIX_BUSINESS_ACTIONS = new Set([
  "start",
  "confirm-rewrite",
  "skip-rewrite",
  "resume",
  "save-decomposition",
  "prepare-person",
  "upload-person-source",
  "generate-person",
  "approve-person",
  "prepare-product-assets",
  "approve-product-assets",
  "product-scope",
  "prepare-storyboard",
  "generate-storyboard",
  "approve-storyboard",
  "start-motion-preflight",
  "start-video-prompt",
  "resolve-video-prompt",
  "start-video-generation",
  "start-generation-pack",
  "generate-person-package",
  "approve-person-package",
  "generate-video",
  "revalidate-video-quality",
  "revalidate-full-video-quality",
  "revalidate-contract-repair-full-video",
]);
const CODEX_ARTIFACT_ID_BASE = 900_000_000;
const RUNTIME_ARTIFACT_ID_BASE = 910_000_000;
const runtimeDir = fileURLToPath(new URL(".", import.meta.url));
const dataRoot =
  process.env.WORKBENCH_DATA_ROOT || join(runtimeDir, "..", "data");
const db = openDatabase(join(dataRoot, "task-center.sqlite"));
initializeXhsJewelryTables(db);
const port = Number(process.env.WORKBENCH_RUNTIME_PORT || 4318);
const activeJobs = new Map();
const activeCodexTaskBindings = new Map();
const activeRuntimeGenerationJobs = new Map();
const activeRuntimeDecompositionJobs = new Map();
const activeSocialExtractions = new Map();
const activeXhsJewelryJobs = new Map();
const activeTalkingHeadCodexBindings = new Map();
const activeDialectDraftRequests = new Map();
const activeModelAssetJobs = new Map();
const activeModelStyleJobs = new Map();
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MAX_BRIDGE_IMAGE_BYTES = 30 * 1024 * 1024;
const browserBridgeRoot = process.env.WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT || bridgeRoot(dataRoot);
const talkingHeadJobsRoot = join(dataRoot, "talking-head-jobs");
const talkingHeadPersonAssetsRoot = join(dataRoot, "talking-head-person-assets");
const modelAssetsRoot = join(dataRoot, "model-assets");
const skipStartupRecovery = process.env.WORKBENCH_SKIP_STARTUP_RECOVERY === "1";
if (!skipStartupRecovery) recoverInterruptedModelAssetGenerations(modelAssetsRoot);
const bundledChatGPTGenerator = fileURLToPath(
  new URL("./chatgpt-web-generator.mjs", import.meta.url),
);
const bundledPersonPackageWebAssetGenerator = fileURLToPath(
  new URL("./person-package-web-asset-generator.mjs", import.meta.url),
);
const codexBuiltinGenerationAvailable = Boolean(
  process.env.WORKBENCH_PERSON_GENERATOR ||
    resolveCodexBinary(process.env) !== "codex" ||
    (() => {
      try {
        execFileSync("/usr/bin/which", ["codex"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })(),
);

const server = createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return end(res, 204);
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "127.0.0.1"}`,
    );
    const testRunId = String(req.headers["x-workbench-test-run"] || "");
    if (
      testRunId &&
      testRunId !== String(process.env.WORKBENCH_TEST_RUN_ID || "")
    ) {
      return json(res, 409, {
        error: "测试实例与当前任务中心不匹配，已阻止请求进入真实项目。",
      });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      const chatgptBridge = inspectChatGPTBridge(browserBridgeRoot);
      const socialExtraction = inspectSocialExtractionAvailability();
      const xhsJewelry = inspectXhsJewelryRuntime();
      return json(res, 200, {
        ok: true,
        mode: "local",
        active_jobs: activeJobs.size,
        execution: "explicit_confirmation_required",
        codex_execution_supervisor: inspectCodexExecutionSupervisor(),
        codex_project_tasks: inspectCodexProjectTaskBridge(),
        person_generation_providers: {
          codex_builtin: codexBuiltinGenerationAvailable
            ? { available: true, mode: "live", state: "ready", user_message: "Codex 内置生图执行器已就绪。" }
            : { available: false, mode: "local", state: "codex_cli_not_found", user_message: "当前电脑没有找到可用的 Codex 执行器。" },
          chatgpt_web: chatgptBridge,
        },
        model_asset_routes: {
          ai_model: {
            available: true,
            state: "formal",
            owner_chain: ["ai-model-asset-codex"],
          },
          real_person: {
            available: true,
            state: "formal",
            owner_chain: ["ai-video-real-person-assets", "ai-video-person-assets"],
            evidence_level: "single_authorized_subject_end_to_end",
          },
        },
        talking_head_person_routes: {
          uploaded_master: {
            available: true,
            state: "formal",
            owner: "workbench_upload_and_ai_video_person_assets_validation",
          },
          ai_created_presenter: {
            available: true,
            state: "formal_via_model_assets",
            owner_chain: ["ai-model-asset-codex"],
          },
          authorized_real_person: {
            available: true,
            state: "formal_via_model_assets",
            owner: "ai-video-real-person-assets",
            evidence_level: "single_authorized_subject_end_to_end",
          },
        },
        social_extraction: socialExtraction,
        xhs_jewelry_visual_remix: xhsJewelry,
      });
    }
    if (req.method === "GET" && url.pathname === "/video-models") {
      return json(res, 200, loadVideoModelCatalog({ env: process.env }));
    }
    if (req.method === "GET" && url.pathname === "/model-assets/projects")
      return json(res, 200, { projects: listModelAssetProjects(modelAssetsRoot) });
    if (req.method === "POST" && url.pathname === "/model-assets/projects") {
      const body = await readJson(req);
      const project = createModelAssetProject(modelAssetsRoot, {
        name: body.name,
        route: body.route,
        aiSourceMethod: body.aiSourceMethod,
        brief: body.brief,
        designDirectionConfirmed: body.designDirectionConfirmed === true,
        authorizationConfirmed: body.authorizationConfirmed === true,
        defaultGenerationProvider: body.defaultGenerationProvider,
      });
      return json(res, 201, { project });
    }
    const modelAssetFileMatch = url.pathname.match(
      /^\/model-assets\/projects\/([a-f0-9-]{36})\/assets\/([a-f0-9-]{36})\/file$/,
    );
    if (modelAssetFileMatch && req.method === "GET") {
      const [, projectId, assetId] = modelAssetFileMatch;
      const asset = getModelAssetFile(modelAssetsRoot, projectId, assetId);
      if (!asset) return json(res, 404, { error: "没有找到这张模特图片。" });
      return streamRegisteredArtifact(res, asset.path);
    }
    const modelAssetProjectMatch = url.pathname.match(
      /^\/model-assets\/projects\/([a-f0-9-]{36})(?:\/(assets|import-master|generate|adopt|use-for-talking|analyze-style|style-prompt|library-status))?$/,
    );
    if (modelAssetProjectMatch) {
      const [, projectId, action] = modelAssetProjectMatch;
      const project = getModelAssetProject(modelAssetsRoot, projectId);
      if (!project) return json(res, 404, { error: "没有找到这个模特资产项目。" });
      if (req.method === "GET" && !action) return json(res, 200, { project });
      if (req.method === "POST" && action === "assets") {
        enforceUploadLimit(req);
        const form = await requestFromNode(req).formData();
        const result = await addModelAssetSource({
          root: modelAssetsRoot,
          projectId,
          file: form.get("image"),
          category: cleanText(form.get("category"), 40),
          assetStage: cleanText(form.get("assetStage"), 40),
          revisesAssetId: cleanText(form.get("revisesAssetId"), 50),
        });
        return json(res, 201, result);
      }
      if (req.method === "POST" && action === "import-master") {
        enforceUploadLimit(req);
        const form = await requestFromNode(req).formData();
        const result = await importReadyModelMaster({
          root: modelAssetsRoot,
          projectId,
          file: form.get("image"),
        });
        return json(res, 201, result);
      }
      if (req.method === "POST" && action === "generate") {
        const body = await readJson(req);
        const provider = body.provider === "chatgpt_web" ? "chatgpt_web" : "codex_builtin";
        if (provider === "chatgpt_web") {
          const bridge = inspectChatGPTBridge(browserBridgeRoot);
          if (!bridge.available) return json(res, 409, { error: bridge.user_message });
        }
        const prepared = prepareModelAssetGeneration(modelAssetsRoot, projectId, {
          provider,
          referenceAssetIds: body.referenceAssetIds,
          instruction: body.instruction,
          uploadAuthorized: body.uploadAuthorized === true,
          assetStage: body.assetStage,
          parentAssetIds: body.parentAssetIds,
          useTalkingStyleAnalysis: body.useTalkingStyleAnalysis === true,
          auxiliaryMode: body.auxiliaryMode,
        });
        scheduleModelAssetGeneration(projectId, prepared.references, provider);
        return json(res, 202, { project: getModelAssetProject(modelAssetsRoot, projectId) });
      }
      if (req.method === "POST" && action === "analyze-style") {
        const body = await readJson(req);
        const prepared = prepareModelStyleAnalysis(modelAssetsRoot, projectId, {
          benchmarkAssetId: body.benchmarkAssetId,
          uploadAuthorized: body.uploadAuthorized === true,
        });
        scheduleModelStyleAnalysis(projectId, prepared.benchmark);
        return json(res, 202, { project: getModelAssetProject(modelAssetsRoot, projectId) });
      }
      if (req.method === "POST" && action === "style-prompt") {
        const body = await readJson(req);
        return json(res, 200, {
          project: approveModelStylePrompt(modelAssetsRoot, projectId, body.prompt),
        });
      }
      if (req.method === "POST" && action === "adopt") {
        const body = await readJson(req);
        const adopted = adoptModelAsset(modelAssetsRoot, projectId, cleanText(body.assetId, 50));
        return json(res, 200, {
          ...adopted,
          project: getModelAssetProject(modelAssetsRoot, projectId),
        });
      }
      if (req.method === "POST" && action === "library-status") {
        const body = await readJson(req);
        return json(res, 200, {
          project: setModelAssetLibraryArchived(modelAssetsRoot, projectId, body.archived === true),
        });
      }
      if (req.method === "POST" && action === "use-for-talking") {
        const body = await readJson(req);
        const talkingProjectId = cleanText(body.talkingProjectId, 50);
        const approved = getApprovedModelAsset(modelAssetsRoot, projectId);
        if (!approved) return json(res, 409, { error: "请先采用一张正式模特母版。" });
        const asset = createTalkingHeadPersonAssetBinding({
          root: talkingHeadPersonAssetsRoot,
          modelAsset: approved.asset,
          projectId: talkingProjectId,
        });
        return json(res, 201, { asset: publicTalkingHeadPersonAsset(asset) });
      }
      return json(res, 405, { error: "当前模特资产操作不支持。" });
    }
    if (req.method === "GET" && url.pathname === "/social-extractions") {
      return json(res, 200, { extractions: listSocialExtractions(db) });
    }
    if (req.method === "GET" && url.pathname === "/talking-head/jobs")
      return json(res, 200, { jobs: listTalkingHeadJobs(talkingHeadJobsRoot).map(job => ({ ...job, generation_configuration: talkingConfiguration() })) });
    if (req.method === "POST" && url.pathname === "/talking-head/dialect-drafts")
      return await handleCreateDialectDraft(req, res);
    if (req.method === "POST" && url.pathname === "/talking-head/person-assets")
      return await handleCreateTalkingHeadPersonAsset(req, res);
    const talkingHeadPersonAssetMatch = url.pathname.match(
      /^\/talking-head\/person-assets\/([a-f0-9-]{36})(?:\/(file))?$/,
    );
    if (talkingHeadPersonAssetMatch) {
      const [, assetId, action] = talkingHeadPersonAssetMatch;
      const asset = getTalkingHeadPersonAsset(talkingHeadPersonAssetsRoot, assetId);
      if (!asset) return json(res, 404, { error: "没有找到这张人物母版。" });
      if (req.method === "GET" && action === "file")
        return streamRegisteredArtifact(res, asset.path);
      if (req.method === "GET" && !action)
        return json(res, 200, { asset: publicTalkingHeadPersonAsset(asset) });
      return json(res, 405, { error: "当前人物母版操作不支持。" });
    }
    if (req.method === "POST" && url.pathname === "/talking-head/jobs")
      return await handleCreateTalkingHeadJob(req, res);
    const talkingHeadMatch = url.pathname.match(
      /^\/talking-head\/jobs\/([a-f0-9-]{36})(?:\/(start|start-voice|approve-voice|approve-video|regenerate-native|cancel|audio|video|master-image|codex-task))?$/,
    );
    if (talkingHeadMatch) {
      const [, jobId, action] = talkingHeadMatch;
      const job = getTalkingHeadJob(talkingHeadJobsRoot, jobId);
      if (!job) return json(res, 404, { error: "没有找到这次口播任务。" });
      if (req.method === "GET" && !action) {
        writeTalkingHeadProjectContext(job);
        ensureTalkingHeadJobRecovery(talkingHeadJobsRoot, job);
        return json(res, 200, { job: { ...job, generation_configuration: talkingConfiguration() } });
      }
      if (req.method === "POST" && action === "start")
        return json(res, 202, {
          job: startTalkingHeadJob(talkingHeadJobsRoot, jobId),
        });
      if (req.method === "POST" && action === "start-voice")
        return json(res, 202, {
          job: startTalkingHeadVoiceJob(talkingHeadJobsRoot, jobId),
        });
      if (req.method === "POST" && action === "approve-voice")
        return json(res, 200, {
          job: approveTalkingHeadVoice(talkingHeadJobsRoot, jobId),
        });
      if (req.method === "POST" && action === "approve-video") {
        const body = await readJson(req);
        return json(res, 200, {
          job: approveTalkingHeadVideo(talkingHeadJobsRoot, jobId, {
            nativeDialogueConfirmed:
              body.nativeDialogueConfirmed === true,
            version: body.version,
          }),
        });
      }
      if (req.method === "POST" && action === "regenerate-native") {
        const body = await readJson(req);
        return json(res, 202, {
          job: regenerateNativeTalkingHeadVersion(talkingHeadJobsRoot, jobId, {
            reason: body.reason,
          }),
        });
      }
      if (req.method === "POST" && action === "cancel")
        return json(res, 200, {
          job: cancelTalkingHeadJob(talkingHeadJobsRoot, jobId),
        });
      if (req.method === "GET" && action === "audio")
        return streamRegisteredArtifact(res, job.voice_output);
      if (req.method === "GET" && action === "video") {
        const requestedSegment = Number(url.searchParams.get("segment"));
        const segmentOutput = Number.isInteger(requestedSegment) && requestedSegment > 0
          ? job.segments?.[requestedSegment - 1]?.output
          : null;
        if (url.searchParams.has("segment") && !segmentOutput)
          return json(res, 404, { error: "这个独立片段当前不可用。" });
        const requestedVersion = Number(url.searchParams.get("version"));
        const currentVersion = job.current_version || 1;
        const versionOutput = Number.isInteger(requestedVersion) && requestedVersion > 0
          ? requestedVersion === job.approved_version && job.published_output
            ? job.published_output
            : requestedVersion === currentVersion
            ? job.output
            : job.generation_versions?.find((item) => item.version === requestedVersion)?.output
          : null;
        if (url.searchParams.has("version") && !versionOutput)
          return json(res, 404, { error: "这个历史版本当前不可用。" });
        return streamRegisteredArtifact(
          res,
          segmentOutput || versionOutput || job.published_output || job.output,
        );
      }
      if (req.method === "GET" && action === "master-image")
        return streamRegisteredArtifact(res, job.image);
      if (req.method === "POST" && action === "codex-task")
        return await handleTalkingHeadCodexTask(req, res, job);
      return json(res, 405, { error: "当前口播操作不支持。" });
    }
    if (req.method === "POST" && url.pathname === "/social-extractions")
      return await handleCreateSocialExtraction(req, res);
    const socialArtifactMatch = url.pathname.match(
      /^\/social-extractions\/([a-f0-9-]{36})\/artifacts\/(\d+)$/,
    );
    if (req.method === "GET" && socialArtifactMatch)
      return serveSocialArtifact(
        res,
        socialArtifactMatch[1],
        Number(socialArtifactMatch[2]),
      );
    const socialMatch = url.pathname.match(
      /^\/social-extractions\/([a-f0-9-]{36})$/,
    );
    if (req.method === "GET" && socialMatch) {
      const extraction = getSocialExtraction(db, socialMatch[1]);
      return extraction
        ? json(res, 200, { extraction })
        : json(res, 404, { error: "没有找到这次提取任务。" });
    }
    if (url.pathname.startsWith("/xhs-jewelry/")) {
      const availability = inspectXhsJewelryRuntime();
      if (!availability.visible)
        return json(res, 404, { error: "没有这个入口。" });
      if (req.method === "GET" && url.pathname === "/xhs-jewelry/tasks")
        return json(res, 200, { tasks: listXhsJewelryTasks(db).map(xhsJewelryTaskForClient) });
      if (req.method === "POST" && url.pathname === "/xhs-jewelry/tasks")
        return await handleCreateXhsJewelryTask(req, res, availability);
      const xhsProductImageMatch = url.pathname.match(
        /^\/xhs-jewelry\/tasks\/([a-f0-9-]{36})\/product-image\/(\d+)$/,
      );
      if (req.method === "GET" && xhsProductImageMatch) {
        const [, xhsTaskId, requestedIndex] = xhsProductImageMatch;
        const xhsTask = getXhsJewelryTask(db, xhsTaskId);
        if (!xhsTask) return json(res, 404, { error: "没有找到这个珠宝种草任务。" });
        const productPath = xhsTask.product_image_paths[Number(requestedIndex)];
        if (!productPath) return json(res, 404, { error: "没有找到这张产品参考图。" });
        return streamRegisteredArtifact(res, productPath);
      }
      const xhsMatch = url.pathname.match(
        /^\/xhs-jewelry\/tasks\/([a-f0-9-]{36})(?:\/(start|check-result|approve-base|approve-final|generate-video|approve-video|request-rework|base-image|production-base-image|structure-board|final-image|video-file))?$/,
      );
      if (xhsMatch) {
        const [, xhsTaskId, action] = xhsMatch;
        const xhsTask = getXhsJewelryTask(db, xhsTaskId);
        if (!xhsTask) return json(res, 404, { error: "没有找到这个珠宝种草图任务。" });
        if (req.method === "GET" && !action)
          return json(res, 200, { task: xhsJewelryTaskForClient(xhsTask) });
        if (req.method === "GET" && action === "base-image")
          return streamRegisteredArtifact(res, xhsTask.base_result?.image?.path);
        if (req.method === "GET" && action === "production-base-image") {
          const productionBasePath = xhsJewelryProductionBasePath(xhsTask);
          return productionBasePath
            ? streamRegisteredArtifact(res, productionBasePath)
            : json(res, 404, { error: "这个项目还没有已确认的人物底片。" });
        }
        if (req.method === "GET" && action === "structure-board") {
          const structureBoardPath = xhsJewelryStructureBoardPath(xhsTask);
          return structureBoardPath
            ? streamRegisteredArtifact(res, structureBoardPath)
            : json(res, 404, { error: "这个项目还没有产品结构参考板。" });
        }
        if (req.method === "GET" && action === "final-image")
          return streamRegisteredArtifact(res, xhsTask.final_result?.image?.path);
        if (req.method === "GET" && action === "video-file")
          return streamRegisteredArtifact(res, xhsTask.video_result?.video?.path);
        if (req.method === "POST" && action === "check-result")
          return await handleCheckXhsJewelryResult(req, res, xhsTask);
        if (req.method === "POST" && action === "start")
          return await handleStartXhsJewelryTask(req, res, xhsTask, availability);
        if (req.method === "POST" && action === "approve-base")
          return await handleApproveXhsJewelryBase(req, res, xhsTask, availability);
        if (req.method === "POST" && action === "approve-final")
          return await handleApproveXhsJewelryFinal(req, res, xhsTask);
        if (req.method === "POST" && action === "generate-video")
          return await handleGenerateXhsJewelryVideo(req, res, xhsTask);
        if (req.method === "POST" && action === "approve-video")
          return await handleApproveXhsJewelryVideo(req, res, xhsTask);
        if (req.method === "POST" && action === "request-rework")
          return await handleRequestXhsJewelryRework(req, res, xhsTask, availability);
        return json(res, 405, { error: "当前珠宝种草图操作不支持。" });
      }
      return json(res, 404, { error: "没有这个入口。" });
    }
    if (url.pathname.startsWith("/browser-bridge/"))
      return await handleBrowserBridge(req, res, url);
    if (req.method === "GET" && url.pathname === "/tasks") {
      let tasks = listTasks(db);
      for (const task of tasks) syncVideoReworkPlan(task);
      tasks = listTasks(db);
      for (const task of tasks) {
        syncCodexProjectContext(task);
        autoResumeRegisteredProductScope(task);
        scheduleRuntimeDecomposition(task);
        scheduleRuntimeGenerationPreflight(task);
      }
      tasks = listTasks(db);
      return json(res, 200, { tasks: tasks.map(taskForClient) });
    }
    if (req.method === "POST" && url.pathname === "/tasks")
      return await handleCreateTask(req, res);

    const artifactMatch = url.pathname.match(
      /^\/tasks\/([a-f0-9-]{36})\/artifacts\/(\d+)$/,
    );
    if (["GET", "HEAD"].includes(req.method || "") && artifactMatch)
      return serveArtifact(req, res, artifactMatch[1], Number(artifactMatch[2]));
    const match = url.pathname.match(
      /^\/tasks\/([a-f0-9-]{36})(?:\/(start|confirm-rewrite|skip-rewrite|resume|save-decomposition|prepare-person|upload-person-source|generate-person|approve-person|prepare-product-assets|approve-product-assets|product-scope|prepare-storyboard|generate-storyboard|approve-storyboard|start-motion-preflight|start-video-prompt|resolve-video-prompt|start-video-generation|start-generation-pack|generate-person-package|approve-person-package|generate-video|approve-video-result|prepare-video-rework|confirm-video-rework|revalidate-video-quality|revalidate-full-video-quality|revalidate-contract-repair-full-video|prepare-full-video|generation-provider|codex-task|runtime-generation|project-context|copilot|person-image|storyboard-image|person-package-image))?$/,
    );
    if (!match) return json(res, 404, { error: "没有这个入口。" });
    const [, taskId, action] = match;
    const task = getTask(db, taskId);
    if (!task) return json(res, 404, { error: "没有找到这个任务。" });
    if (req.method === "GET" && !action) {
      syncVideoReworkPlan(task);
      const fresh = getTask(db, task.id);
      syncCodexProjectContext(fresh);
      autoResumeRegisteredProductScope(fresh);
      scheduleRuntimeDecomposition(fresh);
      scheduleRuntimeGenerationPreflight(fresh);
      return json(res, 200, { task: taskForClient(getTask(db, task.id)) });
    }
    if (req.method === "GET" && action === "person-image")
      return servePersonImage(res, task);
    if (req.method === "GET" && action === "storyboard-image")
      return serveStoryboardImage(res, task);
    if (req.method === "GET" && action === "person-package-image")
      return serveStageImage(
        res,
        task,
        "person_package",
        "当前人物多视图不可用。",
      );
    if (req.method === "GET" && action === "project-context") {
      const project = syncCodexProjectContext(task);
      return json(res, 200, { project });
    }
    if (req.method === "POST" && action === "copilot")
      return await handleCopilot(req, res, task);
    if (req.method === "POST" && action === "codex-task")
      return await handleCodexTask(req, res, task);
    if (req.method === "POST" && action === "runtime-generation")
      return await handleRuntimeGeneration(req, res, task);
    if (
      req.method === "POST" &&
      isCodexOwnedRemixTask(task) &&
      LEGACY_REMIX_BUSINESS_ACTIONS.has(action)
    )
      return json(res, 409, {
        error:
          "这个项目由项目 Codex 任务和正式 Skill 执行。网页旧编排器已停止写入，请使用“打开项目任务”从当前断点继续。",
        code: "LEGACY_REMIX_ORCHESTRATOR_READ_ONLY",
        execution_owner: REMIX_EXECUTION_OWNER,
      });
    if (req.method === "POST" && action === "start")
      return await handleStart(req, res, task);
    if (req.method === "POST" && action === "confirm-rewrite")
      return await handleConfirmRewrite(req, res, task);
    if (req.method === "POST" && action === "skip-rewrite")
      return await handleSkipRewrite(req, res, task);
    if (req.method === "POST" && action === "save-decomposition")
      return await handleSaveDecomposition(req, res, task);
    if (req.method === "POST" && action === "prepare-person")
      return await handlePreparePerson(req, res, task);
    if (req.method === "POST" && action === "upload-person-source")
      return await handleUploadPersonSource(req, res, task);
    if (req.method === "POST" && action === "generation-provider")
      return await handleGenerationProvider(req, res, task);
    if (req.method === "POST" && action === "generate-person")
      return await handleGeneratePerson(req, res, task);
    if (req.method === "POST" && action === "approve-person")
      return await handleApprovePerson(req, res, task);
    if (req.method === "POST" && action === "prepare-product-assets")
      return await handlePrepareProductAssets(req, res, task);
    if (req.method === "POST" && action === "approve-product-assets")
      return await handleApproveProductAssets(req, res, task);
    if (req.method === "POST" && action === "product-scope")
      return await handleProductScope(req, res, task);
    if (req.method === "POST" && action === "prepare-storyboard")
      return await handlePrepareStoryboard(req, res, task);
    if (req.method === "POST" && action === "generate-storyboard")
      return await handleGenerateStoryboard(req, res, task);
    if (req.method === "POST" && action === "approve-storyboard")
      return await handleApproveStoryboard(req, res, task);
    if (req.method === "POST" && action === "start-motion-preflight")
      return await handleStartMotionPreflight(req, res, task);
    if (req.method === "POST" && action === "start-video-prompt")
      return await handleStartVideoPrompt(req, res, task);
    if (req.method === "POST" && action === "resolve-video-prompt")
      return await handleResolveVideoPrompt(req, res, task);
    if (req.method === "POST" && action === "start-video-generation")
      return await handleStartVideoGeneration(req, res, task);
    if (req.method === "POST" && action === "start-generation-pack")
      return await handleStartGenerationPack(req, res, task);
    if (req.method === "POST" && action === "generate-person-package")
      return await handleGeneratePersonPackage(req, res, task);
    if (req.method === "POST" && action === "approve-person-package")
      return await handleApprovePersonPackage(req, res, task);
    if (req.method === "POST" && action === "generate-video")
      return await handleGenerateVideo(req, res, task);
    if (req.method === "POST" && action === "approve-video-result")
      return await handleApproveVideoResult(req, res, task);
    if (req.method === "POST" && action === "prepare-video-rework")
      return await handlePrepareVideoRework(req, res, task);
    if (req.method === "POST" && action === "confirm-video-rework")
      return await handleConfirmVideoRework(req, res, task);
    if (req.method === "POST" && action === "revalidate-video-quality")
      return await handleRevalidateVideoQuality(req, res, task);
    if (req.method === "POST" && action === "revalidate-full-video-quality")
      return await handleRevalidateFullVideoQuality(req, res, task);
    if (
      req.method === "POST" &&
      action === "revalidate-contract-repair-full-video"
    )
      return await handleContractRepairFullVideoValidation(req, res, task);
    if (req.method === "POST" && action === "prepare-full-video")
      return await handlePrepareFullVideo(req, res, task);
    if (req.method === "POST" && action === "resume")
      return await handleResume(req, res, task);
    return json(res, 405, { error: "当前操作不支持。" });
  } catch (error) {
    console.error(error);
    const status = error?.code === "TALKING_CONFIGURATION_REQUIRED" || String(error?.code || "").startsWith("MODEL_ASSET_") ? 409 : 500;
    return json(res, status, { error: safeError(error) });
  }
});

async function handleCreateSocialExtraction(req, res) {
  const body = await readJson(req);
  const sourceText = cleanText(body.sourceText, 3000);
  const sourceUrl = extractSupportedSocialUrl(sourceText);
  const extractionScope = ["copy_only", "media_only", "copy_and_media"].includes(
    body.extractionScope,
  )
    ? body.extractionScope
    : "copy_and_media";
  const downloadAuthorized = body.downloadAuthorized === true;
  if (
    !sourceUrl ||
    !/(douyin\.com|v\.douyin\.com|xiaohongshu\.com|xhslink\.(?:com|cn)|weixin\.qq\.com\/sph)/i.test(
      sourceUrl,
    )
  ) {
    return json(res, 400, {
      error: "请粘贴一条支持的抖音、小红书或视频号链接。",
    });
  }
  const downloadsMedia = extractionScope !== "copy_only";
  if (downloadsMedia && !downloadAuthorized) {
    return json(res, 400, {
      error: "下载图片或视频前，请先确认允许保存这条内容的素材。",
    });
  }
  const id = randomUUID();
  const downstreamUse = cleanText(body.downstreamUse, 300);
  const reusable = listSocialExtractions(db).find(
    (item) =>
      item.source_url === sourceUrl &&
      item.status === "completed" &&
      item.result &&
      (!downloadsMedia || item.result.downloaded_files?.length),
  );
  const registered = reusable
    ? null
    : findRegisteredSocialSource(sourceUrl);
  const availability = inspectSocialExtractionAvailability();
  if (!reusable && !registered && !availability.available)
    return json(res, 409, { error: availability.user_message });
  createSocialExtraction(db, {
    id,
    title:
      cleanText(body.title, 100) ||
      `爆款提取 ${sourceUrl.includes("douyin") ? "抖音" : ""}`.trim(),
    sourceText,
    sourceUrl,
    extractionScope,
    downstreamUse,
    downloadAuthorized,
  });
  if (reusable) {
    finishSocialExtraction(db, id, {
      ...reusable.result,
      source_url: sourceUrl,
      reused_from_extraction_id: reusable.id,
      provider_usage: {
        ...(reusable.result.provider_usage || {}),
        original_confirmed_cost_usd: Number(
          reusable.result.provider_usage?.confirmed_cost_usd || 0,
        ),
        confirmed_cost_usd: 0,
        request_attempt_count: 0,
        retry_count: 0,
      },
    });
    return json(res, 200, {
      extraction: getSocialExtraction(db, id),
      reused: true,
    });
  }
  if (registered) {
    finishSocialExtraction(db, id, {
      ...registered,
      source_url: sourceUrl,
      reused_from_social_library: true,
      provider_usage: {
        ...(registered.provider_usage || {}),
        original_confirmed_cost_usd: Number(
          registered.provider_usage?.confirmed_cost_usd || 0,
        ),
        confirmed_cost_usd: 0,
        request_attempt_count: 0,
        retry_count: 0,
      },
    });
    return json(res, 200, {
      extraction: getSocialExtraction(db, id),
      reused: true,
    });
  }
  scheduleSocialExtraction(id);
  return json(res, 202, { extraction: getSocialExtraction(db, id) });
}

async function handleCreateXhsJewelryTask(req, res, availability) {
  if (!availability.available) return json(res, 409, { error: availability.user_message });
  enforceUploadLimit(req);
  const form = await requestFromNode(req).formData();
  const title = cleanText(form.get("title"), 100);
  const visualMode = cleanText(form.get("visual_mode"), 40);
  const targetSlot = cleanText(form.get("target_slot"), 30);
  const targetRatio = cleanText(form.get("target_ratio"), 20) || "follow_source";
  const brief = cleanText(form.get("brief"), 1000);
  const productFacts = Object.fromEntries([
    ["product_name", cleanText(form.get("product_name"), 120)],
    ["sku", cleanText(form.get("product_sku"), 100)],
    ["material", cleanText(form.get("product_material"), 160)],
    ["color", cleanText(form.get("product_color"), 120)],
    ["dimensions", cleanText(form.get("product_dimensions"), 160)],
    ["component_count", cleanText(form.get("product_component_count"), 120)],
    ["front_orientation", cleanText(form.get("product_front_orientation"), 240)],
    ["connection_structure", cleanText(form.get("product_connection_structure"), 240)],
    ["must_not_change", cleanText(form.get("product_must_not_change"), 500)],
  ].filter(([, value]) => value));
  const personAuthorizationConfirmed = form.get("person_authorization_confirmed") === "true";
  const personStrategy = visualMode === "direct_product_edit" ? "existing_base" : cleanText(form.get("person_strategy"), 40) || "authorized_real_person";
  if (!["authorized_real_person", "partial_body", "existing_base"].includes(personStrategy)
      || (visualMode === "rebuild_two_stage" && personStrategy === "existing_base")) return json(res, 400, { error: "请选择指定模特或不露脸局部展示。" });
  const referenceFiles = form.getAll("referenceImages").filter(validUploadedFile);
  const personFiles = form.getAll("personImages").filter(validUploadedFile);
  const productFiles = form.getAll("productImages").filter(validUploadedFile);
  if (!title) return json(res, 400, { error: "请填写这次珠宝种草图的项目名称。" });
  if (!["rebuild_two_stage", "direct_product_edit"].includes(visualMode))
    return json(res, 400, { error: "请选择换模特和珠宝，或只换珠宝。" });
  if (!["necklace", "earrings", "bracelet", "ring", "brooch_hair"].includes(targetSlot))
    return json(res, 400, { error: "请选择这次要替换的珠宝位置。" });
  if (!["follow_source", "3:4", "4:5", "9:16", "1:1"].includes(targetRatio))
    return json(res, 400, { error: "请选择页面提供的图片比例。" });
  if (referenceFiles.length !== 1)
    return json(res, 400, { error: visualMode === "direct_product_edit" ? "请上传 1 张已经满意的人物底片。" : "请先上传 1 张想参考的珠宝人物图。" });
  if (visualMode === "rebuild_two_stage" && personStrategy !== "partial_body" && personFiles.length !== 1)
    return json(res, 400, { error: "当前内测先上传 1 张最清晰的原创或已授权模特照片。" });
  if (personFiles.length > 1)
    return json(res, 400, { error: "当前内测一次只使用 1 张模特照片。" });
  if (!personAuthorizationConfirmed)
    return json(res, 400, { error: "请确认你拥有本次素材使用授权；不露脸素材同样需要相应使用权。" });
  if (productFiles.length < 1 || productFiles.length > 5)
    return json(res, 400, { error: "请上传 1–5 张同一款珠宝的清晰产品图。" });

  const id = randomUUID();
  const inputDir = join(dataRoot, "xhs-jewelry-tasks", id, "inputs");
  mkdirSync(inputDir, { recursive: true });
  const referenceImagePaths = await saveFiles(referenceFiles, inputDir, visualMode === "direct_product_edit" ? "approved-base" : "source-visual");
  const personImagePaths = await saveFiles(personFiles, inputDir, "authorized-person");
  const productImagePaths = await saveFiles(productFiles, inputDir, "product");
  const task = createXhsJewelryTask(db, {
    id,
    title,
    visualMode,
    targetSlot,
    targetRatio,
    brief,
    referenceImagePaths,
    personImagePaths,
    productImagePaths,
    personStrategy,
    productFacts,
    personAuthorizationConfirmed,
  });
  return json(res, 201, { task: xhsJewelryTaskForClient(task) });
}

async function handleStartXhsJewelryTask(req, res, task, availability) {
  if (!availability.available) return json(res, 409, { error: availability.user_message });
  const body = await readJson(req);
  if (body.confirmed !== true || body.uploadAuthorized !== true)
    return json(res, 400, { error: "开始前请确认当前步骤页面列出的上传范围。" });
  try {
    const requestId = cleanText(body.requestId, 80);
    if (requestId && task.last_start_request_id === requestId) return json(res, 200, { task: xhsJewelryTaskForClient(task), replayed: true });
    const generationProvider = resolveXhsJewelryGenerationProvider(body.generationProvider);
    const stage = xhsJewelryStageForStart(task);
    if (task.result_check_required || pendingBrowserJobForTask(browserBridgeRoot, task.id, stage)) {
      return json(res, 409, { error: "原任务尚待核实，请先检查原任务；现在不会重新生成。" });
    }
    assertXhsJewelryProviderAvailable(generationProvider);
    const recovered = recoverVerifiedXhsJewelryResult(task, stage);
    if (recovered) return json(res, 200, { task: xhsJewelryTaskForClient(recovered), recovered: true });
    const started = beginXhsJewelryStage(db, task.id, stage, { uploadAuthorized: true, generationProvider });
    if (requestId) db.prepare("UPDATE xhs_jewelry_tasks SET last_start_request_id = ? WHERE id = ?").run(requestId, task.id);
    scheduleXhsJewelryStage(task.id, stage, started.active_run_id);
    return json(res, 202, { task: xhsJewelryTaskForClient(started) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleCheckXhsJewelryResult(req, res, task) {
  await readJson(req);
  if (!["base_failed", "product_failed"].includes(task.status)) return json(res, 200, { task: xhsJewelryTaskForClient(task) });
  if (activeXhsJewelryJobs.has(task.id)) return json(res, 409, { error: "原任务仍在处理，请稍后检查。" });
  const stage = xhsJewelryStageForStart(task);
  try {
    const saved = recoverVerifiedXhsJewelryResult(task, stage);
    if (saved) return json(res, 200, { task: xhsJewelryTaskForClient(saved), recovered: true });
    const result = await inspectXhsJewelryOriginalWebResult({ task, taskDir: join(dataRoot, "xhs-jewelry-tasks", task.id), stage,
      env: { ...process.env, WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT: browserBridgeRoot } });
    if (result.state === "completed") {
      const verified = validateXhsJewelryResult(result.raw, join(dataRoot, "xhs-jewelry-tasks", task.id), stage,
        { task: result.executionTask, env: process.env, productPack: result.productPack });
      const recovered = recoverXhsJewelryCompletedResult(db, task.id, stage, verified);
      return json(res, 200, { task: xhsJewelryTaskForClient(recovered), recovered: true });
    }
    const updated = setXhsJewelryResultCheck(db, task.id, result.state !== "failed", result.message);
    return json(res, 200, { task: xhsJewelryTaskForClient(updated) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

function recoverVerifiedXhsJewelryResult(task, stage) {
  if (!['base_failed', 'product_failed'].includes(task.status)) return null;
  const currentResult = stage === "visual_base" ? task.base_result : task.final_result;
  if (task.pending_rework || currentResult?.approval_status === "rejected") return null;
  const taskDir = join(dataRoot, "xhs-jewelry-tasks", task.id);
  const stageRoot = join(taskDir, stage);
  if (!existsSync(stageRoot)) return null;
  const candidates = readdirSync(stageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(stageRoot, entry.name, "result.json"))
    .filter(existsSync)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const resultPath of candidates) {
    try {
      const snapshotPath = join(dirname(resultPath), "task-snapshot.json");
      if (!existsSync(snapshotPath)) continue;
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      const currentAttempt = stage === "visual_base" ? task.base_attempt_count : task.product_attempt_count;
      if (snapshot.task_id !== task.id || snapshot.stage !== stage || snapshot.attempt !== currentAttempt) continue;
      const raw = JSON.parse(readFileSync(resultPath, "utf8"));
      const result = validateXhsJewelryResult(raw, taskDir, stage, {
        task,
        productPack: snapshot.product_pack,
        env: process.env,
      });
      return recoverXhsJewelryCompletedResult(db, task.id, stage, {
        ...result,
        recovered_from_successful_receipt: true,
      });
    } catch {
      // Only a fully valid image + execution receipt may bypass a new generation request.
    }
  }
  return null;
}

async function handleApproveXhsJewelryBase(req, res, task, availability) {
  if (!availability.available) return json(res, 409, { error: availability.user_message });
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认人物、氛围、构图和珠宝佩戴位置都可以继续。" });
  try {
    const generationProvider = resolveXhsJewelryGenerationProvider(body.generationProvider);
    assertXhsJewelryProviderAvailable(generationProvider);
    approveXhsJewelryBase(db, task.id);
    const started = beginXhsJewelryStage(db, task.id, "product_replacement", { uploadAuthorized: true, generationProvider });
    scheduleXhsJewelryStage(task.id, "product_replacement", started.active_run_id);
    return json(res, 202, { task: xhsJewelryTaskForClient(started) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleApproveXhsJewelryFinal(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认已经对照产品图检查款式、比例和佩戴效果。" });
  try {
    return json(res, 200, { task: xhsJewelryTaskForClient(approveXhsJewelryFinal(db, task.id)) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleGenerateXhsJewelryVideo(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true || body.uploadAuthorized !== true || body.feeConfirmed !== true) {
    return json(res, 400, { error: "生成前请确认视频模型、画幅、时长、上传素材和本次可能产生的费用。" });
  }
  if (activeXhsJewelryJobs.has(task.id)) return json(res, 409, { error: "这个任务已经在执行。" });
  try {
    const started = beginXhsJewelryVideo(db, task.id, {
      provider: cleanText(body.provider, 40),
      modelKey: cleanText(body.modelKey, 40),
      aspectRatio: cleanText(body.aspectRatio, 12),
      durationSeconds: Number(body.durationSeconds),
      uploadAuthorized: true,
      feeConfirmed: true,
    });
    scheduleXhsJewelryVideo(task.id, started.active_run_id);
    return json(res, 202, { task: xhsJewelryTaskForClient(started) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleApproveXhsJewelryVideo(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true) return json(res, 400, { error: "请确认已经检查人物、珠宝结构和动态稳定性。" });
  try {
    return json(res, 200, { task: xhsJewelryTaskForClient(approveXhsJewelryVideo(db, task.id)) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleRequestXhsJewelryRework(req, res, task, availability) {
  if (!availability.available) return json(res, 409, { error: availability.user_message });
  const body = await readJson(req);
  try {
    if (task.status === "video_review") {
      const prepared = requestXhsJewelryRework(db, task.id, {
        issueCodes: body.issueCodes,
        userText: cleanText(body.userText, 1000),
        reworkMode: "targeted_refine",
      });
      // Saving a quality issue must never itself start a billable retry.
      // The user reviews the compiled diagnosis first, then explicitly
      // confirms the provider, upload and fee through generate-video.
      return json(res, 200, { task: xhsJewelryTaskForClient(prepared) });
    }
    const generationProvider = resolveXhsJewelryGenerationProvider(body.generationProvider);
    assertXhsJewelryProviderAvailable(generationProvider);
    const prepared = requestXhsJewelryRework(db, task.id, {
      issueCodes: body.issueCodes,
      userText: cleanText(body.userText, 1000),
      reworkMode: cleanText(body.reworkMode, 40),
    });
    const stage = xhsJewelryStageForStart(prepared);
    const started = beginXhsJewelryStage(db, task.id, stage, { uploadAuthorized: true, generationProvider });
    scheduleXhsJewelryStage(task.id, stage, started.active_run_id);
    return json(res, 202, { task: xhsJewelryTaskForClient(started) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

function scheduleXhsJewelryStage(taskId, stage, runId) {
  if (activeXhsJewelryJobs.has(taskId)) return;
  const promise = (async () => {
    try {
      const task = getXhsJewelryTask(db, taskId);
      if (!task || task.active_stage !== stage || task.active_run_id !== runId) return;
      const taskDir = join(dataRoot, "xhs-jewelry-tasks", taskId);
      const stageEnv = task.active_generation_provider === "chatgpt_web"
        ? {
            ...process.env,
            WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT: browserBridgeRoot,
            WORKBENCH_CHATGPT_WEB_MODE: "live",
          }
        : process.env;
      const result = await runXhsJewelryStage({
        task,
        taskDir,
        stage,
        env: stageEnv,
        onEvent: (message) => updateXhsJewelryProgress(db, taskId, stage, runId, message),
        onExternalRequestStarted: () => markXhsJewelryExternalRequestStarted(db, taskId, runId),
        onBrowserJob: (jobId) => bindXhsJewelryBrowserJob(db, taskId, stage, runId, jobId),
      });
      finishXhsJewelryStage(db, taskId, stage, runId, result);
    } catch (error) {
      console.error("xhs jewelry stage failed", safeError(error));
      try { failXhsJewelryStage(db, taskId, stage, runId, error); }
      catch (staleError) { console.error("xhs jewelry stale failure ignored", safeError(staleError)); }
    } finally {
      activeXhsJewelryJobs.delete(taskId);
    }
  })();
  activeXhsJewelryJobs.set(taskId, promise);
}

function scheduleXhsJewelryVideo(taskId, runId) {
  if (activeXhsJewelryJobs.has(taskId)) return;
  const promise = (async () => {
    try {
      const task = getXhsJewelryTask(db, taskId);
      if (!task || task.active_stage !== "video_generation" || task.active_run_id !== runId) return;
      const taskDir = join(dataRoot, "xhs-jewelry-tasks", taskId);
      const result = await runXhsJewelryVideo({
        task,
        taskDir,
        env: process.env,
        onEvent: (message) => updateXhsJewelryProgress(db, taskId, "video_generation", runId, message),
        onExternalRequestStarted: () => markXhsJewelryExternalRequestStarted(db, taskId, runId),
      });
      finishXhsJewelryVideo(db, taskId, runId, result);
    } catch (error) {
      console.error("xhs jewelry video failed", safeError(error));
      try { failXhsJewelryVideo(db, taskId, runId, error); }
      catch (staleError) { console.error("xhs jewelry stale video failure ignored", safeError(staleError)); }
    } finally {
      activeXhsJewelryJobs.delete(taskId);
    }
  })();
  activeXhsJewelryJobs.set(taskId, promise);
}

function xhsJewelryTaskForClient(task) {
  if (!task) return null;
  const productionBasePath = xhsJewelryProductionBasePath(task);
  const structureBoardPath = xhsJewelryStructureBoardPath(task);
  return {
    id: task.id,
    title: task.title,
    visual_mode: task.visual_mode,
    target_slot: task.target_slot,
    target_ratio: task.target_ratio,
    brief: task.brief,
    status: task.status,
    current_stage: task.current_stage,
    person_authorization_confirmed: task.person_authorization_confirmed,
    person_strategy: task.person_strategy,
    result_check_required: task.result_check_required || Boolean(["base_failed", "product_failed"].includes(task.status) && pendingBrowserJobForTask(browserBridgeRoot, task.id, xhsJewelryStageForStart(task))),
    external_upload_authorized: task.external_upload_authorized,
    reference_image_count: task.reference_image_paths.length,
    person_image_count: task.person_image_paths.length,
    product_image_count: task.product_image_paths.length,
    product_facts: task.product_facts || {},
    has_production_base_image: Boolean(productionBasePath),
    has_product_structure_board: Boolean(structureBoardPath),
    base_attempt_count: task.base_attempt_count,
    product_attempt_count: task.product_attempt_count,
    video_attempt_count: task.video_attempt_count,
    base_generation_provider: task.base_generation_provider || null,
    product_generation_provider: task.product_generation_provider || null,
    active_generation_provider: task.active_generation_provider || null,
    active_stage: task.active_stage,
    active_run_started_at: task.active_run_started_at,
    active_external_request_started: task.active_external_request_started,
    base_result: task.base_result ? { ...task.base_result, image: task.base_result.image ? { ...task.base_result.image, path: undefined } : null } : null,
    final_result: task.final_result ? { ...task.final_result, image: task.final_result.image ? { ...task.final_result.image, path: undefined } : null } : null,
    video_provider: task.video_provider || null,
    video_model_key: task.video_model_key || null,
    video_aspect_ratio: task.video_aspect_ratio || null,
    video_duration_seconds: task.video_duration_seconds || null,
    video_result: task.video_result ? { ...task.video_result, video: task.video_result.video ? { ...task.video_result.video, path: undefined } : null } : null,
    pending_rework: task.pending_rework ? {
      feedback_id: task.pending_rework.feedback_id,
      stage: task.pending_rework.stage,
      issue_codes: task.pending_rework.issue_codes,
      user_observation: task.pending_rework.user_observation,
      mode: task.pending_rework.mode || "targeted_refine",
    } : null,
    latest_feedback: task.feedback_history?.length ? (() => {
      const feedback = task.feedback_history[task.feedback_history.length - 1];
      return {
        feedback_id: feedback.feedback_id,
        stage: feedback.stage,
        issue_codes: feedback.issue_codes,
        user_observation: feedback.user_observation,
        mode: feedback.mode || "targeted_refine",
        created_at: feedback.created_at,
      };
    })() : null,
    can_rework_base: task.status === "base_review",
    can_rework_product: task.status === "final_review",
    can_rework_video: task.status === "video_review",
    can_retry_failed_stage: canRetryFailedXhsJewelryStage(task),
    user_message: task.user_message,
    last_error: task.last_error ? "内部已保留故障记录。" : null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    events: (task.events || []).map((event) => ({
      id: event.id,
      event_type: event.event_type,
      level: event.level,
      message: event.message,
      created_at: event.created_at,
    })),
  };
}

function xhsJewelryProductionBasePath(task) {
  const candidate = task.visual_mode === "direct_product_edit"
    ? task.reference_image_paths?.[0]
    : task.base_result?.approval_status === "approved"
      ? task.base_result?.image?.path
      : null;
  return registeredFilePath(candidate);
}

function xhsJewelryStructureBoardPath(task) {
  const recorded = task.final_result?.product_pack?.evidence_board?.path;
  const recordedPath = registeredFilePath(recorded);
  if (recordedPath) return recordedPath;

  const packDir = join(dataRoot, "xhs-jewelry-tasks", task.id, "product-pack-v03");
  if (!existsSync(packDir)) return null;
  const manifests = readdirSync(packDir)
    .filter((name) => /^product-pack-[a-f0-9]{16}\.json$/.test(name))
    .map((name) => join(packDir, name))
    .filter((path) => registeredFilePath(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const candidate = registeredFilePath(manifest?.evidence_board?.path);
      if (!candidate) continue;
      const realPackDir = realpathSync(packDir);
      const realCandidate = realpathSync(candidate);
      if (realCandidate.startsWith(`${realPackDir}${sep}`)) return candidate;
    } catch {
      // Ignore incomplete historical packs and continue to the next valid manifest.
    }
  }
  return null;
}

function registeredFilePath(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const absolute = resolve(candidate);
  try {
    return existsSync(absolute) && lstatSync(absolute).isFile() ? absolute : null;
  } catch {
    return null;
  }
}

function resolveXhsJewelryGenerationProvider(value) {
  const provider = String(value || "codex_builtin");
  if (!["codex_builtin", "chatgpt_web"].includes(provider)) {
    const error = new Error("XHS_JEWELRY_GENERATION_PROVIDER_INVALID");
    error.code = "XHS_JEWELRY_GENERATION_PROVIDER_INVALID";
    throw error;
  }
  return provider;
}

function assertXhsJewelryProviderAvailable(provider) {
  if (provider === "chatgpt_web") {
    const bridge = inspectChatGPTBridge(browserBridgeRoot);
    if (!bridge.available) throw new Error(bridge.user_message);
    return;
  }
  if (!codexBuiltinGenerationAvailable) throw new Error("当前电脑没有找到可用的 Codex 执行器。");
}

function validUploadedFile(file) {
  return file instanceof File && file.size > 0;
}

async function handleCreateTalkingHeadJob(req, res) {
  enforceUploadLimit(req);
  const form = await requestFromNode(req).formData();
  const speechSource = cleanText(form.get("speech_source"), 20) || "audio";
  const uploadedVoice = form.get("voice");
  const uploadedVoiceLeft = form.get("voice_left");
  const uploadedVoiceRight = form.get("voice_right");
  const uploadedImage = form.get("image");
  const hasUploadedVoice = uploadedVoice instanceof File && uploadedVoice.size > 0;
  const hasUploadedImage = uploadedImage instanceof File && uploadedImage.size > 0;
  let voiceFile = hasUploadedVoice ? uploadedVoice : null;
  let voiceFileLeft = uploadedVoiceLeft instanceof File && uploadedVoiceLeft.size > 0
    ? uploadedVoiceLeft
    : null;
  let voiceFileRight = uploadedVoiceRight instanceof File && uploadedVoiceRight.size > 0
    ? uploadedVoiceRight
    : null;
  const reusedVoiceJobId = cleanText(form.get("reuse_voice_job_id"), 50);
  const reusedVoiceJobIdLeft = cleanText(form.get("reuse_voice_job_id_left"), 50);
  const reusedVoiceJobIdRight = cleanText(form.get("reuse_voice_job_id_right"), 50);
  if (!voiceFile && reusedVoiceJobId) {
    const sourceVoiceJob = getTalkingHeadJob(talkingHeadJobsRoot, reusedVoiceJobId);
    const voicePath = sourceVoiceJob?.voice_reference || "";
    if (
      !sourceVoiceJob ||
      !voicePath ||
      !sourceVoiceJob.task_root ||
      !voicePath.startsWith(`${sourceVoiceJob.task_root}/`) ||
      !existsSync(voicePath)
    )
      return json(res, 409, {
        error: "这条历史授权声音已失效，请重新选择声音文件。",
      });
    voiceFile = new File(
      [readFileSync(voicePath)],
      basename(voicePath) || "authorized_voice_reference.wav",
      { type: "audio/wav" },
    );
  }
  const restoreSpeakerVoice = (sourceJobId, side) => {
    if (!sourceJobId) return null;
    const sourceVoiceJob = getTalkingHeadJob(talkingHeadJobsRoot, sourceJobId);
    const voicePath =
      side === "left"
        ? sourceVoiceJob?.voice_reference_left || ""
        : sourceVoiceJob?.voice_reference_right || "";
    if (
      !sourceVoiceJob ||
      sourceVoiceJob.native_dialogue_mode !== "two_speaker_alternating" ||
      !voicePath ||
      !sourceVoiceJob.task_root ||
      !voicePath.startsWith(`${sourceVoiceJob.task_root}/`) ||
      !existsSync(voicePath)
    )
      return null;
    return new File(
      [readFileSync(voicePath)],
      basename(voicePath) || `authorized_voice_reference_${side}.wav`,
      { type: "audio/wav" },
    );
  };
  if (!voiceFileLeft && reusedVoiceJobIdLeft) {
    voiceFileLeft = restoreSpeakerVoice(reusedVoiceJobIdLeft, "left");
    if (!voiceFileLeft)
      return json(res, 409, {
        error: "左侧人物的授权音色参考已失效，请重新选择声音文件。",
      });
  }
  if (!voiceFileRight && reusedVoiceJobIdRight) {
    voiceFileRight = restoreSpeakerVoice(reusedVoiceJobIdRight, "right");
    if (!voiceFileRight)
      return json(res, 409, {
        error: "右侧人物的授权音色参考已失效，请重新选择声音文件。",
      });
  }
  const requestedPersonAssetId = cleanText(form.get("person_asset_id"), 50);
  const requestedPersonProjectId = cleanText(form.get("person_project_id"), 50);
  if (requestedPersonProjectId && !isTalkingHeadProjectId(requestedPersonProjectId))
    return json(res, 400, { error: "当前口播项目标识无效，请新建项目后重试。" });
  let personAsset = requestedPersonAssetId
    ? getTalkingHeadPersonAsset(talkingHeadPersonAssetsRoot, requestedPersonAssetId)
    : null;
  if (requestedPersonAssetId && !personAsset)
    return json(res, 409, {
      error: "这张人物母版已失效或不属于当前记录，请重新选择图片。",
    });
  if (
    personAsset &&
    requestedPersonProjectId &&
    personAsset.project_id !== requestedPersonProjectId
  )
    return json(res, 409, {
      error: "这张人物母版不属于当前口播项目，请重新选择图片。",
    });
  if (!personAsset && hasUploadedImage)
    personAsset = await createTalkingHeadPersonAsset({
      root: talkingHeadPersonAssetsRoot,
      file: uploadedImage,
      projectId: requestedPersonProjectId,
    });
  if (!personAsset)
    return json(res, 400, { error: "后台没有收到本次人物母版，请重新选择图片。" });
  const imageFile = personAssetFile(personAsset);
  const mode = cleanText(form.get("mode"), 20);
  const qualityMode =
    cleanText(form.get("quality_mode"), 20) || (["boutique", "native"].includes(mode) ? "clear" : "daily");
  const targetRatio = cleanText(form.get("target_ratio"), 10) || "9:16";
  const job =
    mode === "native"
      ? await createNativeTalkingHeadJob({
          root: talkingHeadJobsRoot,
          scriptText: cleanText(form.get("script"), 10000),
          performanceRequirement: cleanText(form.get("performance_requirement"), 1000),
          voiceFile,
          voiceFileLeft,
          voiceFileRight,
          imageFile,
          voiceAuthorized: form.get("voice_authorized") === "true",
          voiceMode: cleanText(form.get("native_voice_mode"), 20) || "random",
          runStrategy: cleanText(form.get("native_run_strategy"), 20) || "economy",
          qualityMode,
          targetRatio,
          cameraContinuity: cleanText(form.get("camera_continuity"), 30) || "strict_locked",
          workflowVariant: (() => {
            const requested = cleanText(form.get("native_workflow_variant"), 50);
            return ["composition_anchor_v0_1", "composition_first_last_v0_2"].includes(requested)
              ? requested
              : "production";
          })(),
          dialogueMode: (() => {
            const requested = cleanText(form.get("native_dialogue_mode"), 50);
            return requested === "two_speaker_alternating"
              ? requested
              : "single";
          })(),
          dialogueStyle: (() => {
            const requested = cleanText(form.get("native_dialogue_style"), 50);
            return requested === "structured_discussion"
              ? requested
              : "natural_interview";
          })(),
          neutralHandPoseConfirmed:
            form.get("native_neutral_hand_pose_confirmed") === "true",
          durationPlanning:
            cleanText(form.get("native_duration_planning"), 50) ===
            "adaptive_6_15_candidate"
              ? "adaptive_6_15_candidate"
              : "fixed_10_verified",
          concurrency: cleanText(form.get("concurrency"), 10) || "1",
          personAsset,
        })
      : speechSource === "clone"
      ? await createTalkingHeadVoiceJob({
          root: talkingHeadJobsRoot,
          mode,
          scriptText: cleanText(form.get("script"), 10000),
          voiceFile,
          imageFile,
          voiceAuthorized: form.get("voice_authorized") === "true",
          languageMode: cleanText(form.get("voice_language_mode"), 20) || "mandarin",
          dialect: cleanText(form.get("voice_dialect"), 40),
          cloneRoute: cleanText(form.get("voice_clone_route"), 20) || "legacy",
          referenceAudioTranscript: cleanText(form.get("reference_audio_transcript"), 10000),
          emotionPreset: cleanText(form.get("voice_emotion_preset"), 20) || "natural",
          speechPace: cleanText(form.get("voice_speech_pace"), 20) || "normal",
          dialectScriptConfirmed: form.get("dialect_script_confirmed") === "true",
          qualityMode,
          targetRatio,
          concurrency: cleanText(form.get("concurrency"), 10) || "1",
          generationStrategy:
            cleanText(form.get("generation_strategy"), 30) || "sample_first",
          directGenerationAcknowledged:
            form.get("direct_generation_acknowledged") === "true",
          cameraContinuity:
            cleanText(form.get("camera_continuity"), 30) ||
            (mode === "boutique" ? "stable_natural" : "natural"),
          boutiqueCameraExperiment: cleanText(
            form.get("boutique_camera_experiment"),
            50,
          ),
          personAsset,
        })
      : await createTalkingHeadJob({
          root: talkingHeadJobsRoot,
          mode,
          audioFile: form.get("audio"),
          imageFile,
          qualityMode,
          targetRatio,
          concurrency: cleanText(form.get("concurrency"), 10) || "1",
          generationStrategy:
            cleanText(form.get("generation_strategy"), 30) || "sample_first",
          directGenerationAcknowledged:
            form.get("direct_generation_acknowledged") === "true",
          cameraContinuity:
            cleanText(form.get("camera_continuity"), 30) ||
            (mode === "boutique" ? "stable_natural" : "natural"),
          boutiqueCameraExperiment: cleanText(
            form.get("boutique_camera_experiment"),
            50,
          ),
          personAsset,
        });
  writeTalkingHeadProjectContext(job);
  scheduleTalkingHeadCodexBinding(job.id, false);
  return json(res, 201, { job: { ...job, generation_configuration: talkingConfiguration() } });
}

async function handleCreateDialectDraft(req, res) {
  const body = await readJson(req);
  const input = {
    sourceText: body.sourceText,
    dialect: body.dialect,
    regionHint: body.regionHint,
    referenceExamples: body.referenceExamples,
  };
  let key;
  try {
    key = dialectDraftCacheKey(
      input,
      process.env.WORKBENCH_CODEX_MODEL || "gpt-5.6-sol",
    );
  } catch (error) {
    return json(res, 400, { error: safeError(error) });
  }
  let request = activeDialectDraftRequests.get(key);
  if (!request) {
    request = runDialectDraftWithCodex({
      input,
      cacheRoot: join(dataRoot, "dialect-drafts"),
    });
    activeDialectDraftRequests.set(key, request);
  }
  try {
    const draft = await request;
    return json(res, 200, { draft });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  } finally {
    if (activeDialectDraftRequests.get(key) === request)
      activeDialectDraftRequests.delete(key);
  }
}

async function handleCreateTalkingHeadPersonAsset(req, res) {
  enforceUploadLimit(req);
  const form = await requestFromNode(req).formData();
  const asset = await createTalkingHeadPersonAsset({
    root: talkingHeadPersonAssetsRoot,
    file: form.get("image"),
    projectId: cleanText(form.get("project_id"), 50),
  });
  return json(res, 201, { asset: publicTalkingHeadPersonAsset(asset) });
}

async function handleTalkingHeadCodexTask(req, res, job) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, {
      error:
        "请确认建立并打开对应的 Codex 项目任务；这一步不会自动发送消息或使用 Token。",
    });
  if (job.codex_thread_id && job.codex_thread_status === "ready") {
    await openCodexThreadInDesktop(job.codex_thread_id);
    return json(res, 200, { job });
  }
  scheduleTalkingHeadCodexBinding(job.id, true);
  return json(res, 202, {
    job: getTalkingHeadJob(talkingHeadJobsRoot, job.id),
  });
}

function talkingHeadContextRoot(jobId) {
  return join(dataRoot, "talking-head-projects", jobId);
}

function writeTalkingHeadProjectContext(job) {
  const root = talkingHeadContextRoot(job.id);
  mkdirSync(root, { recursive: true });
  const context = {
    schema_version: 1,
    project: {
      id: job.id,
      title: job.project_name,
      workflow: "talking-head-video-workflow",
      skill_version: job.skill_version,
    },
    current: {
      state: job.state,
      mode: job.mode,
      generation_strategy: job.generation_strategy,
      direct_generation_blocked_reason: job.direct_generation_blocked_reason || null,
      duration: job.duration,
      measured_duration: job.measured_duration,
      updated_at: job.updated_at || job.finished_at || job.created_at,
    },
    setup: {
      audio: job.audio,
      master_image: job.image,
      person_asset: job.person_asset || null,
      performance_prompt: job.prompt,
      candidate_video: existsSync(job.output) ? job.output : null,
    },
    execution: {
      estimated_rh_coins: job.estimated_rh_coins,
      concurrency: job.concurrency,
      actual_usage: job.usage || null,
      qc_status: job.qc_status || "pending",
      automatic_retry: false,
    },
    boundaries: {
      workbench_role: "collect_display_persist",
      business_rules_owner: "talking-head-video-workflow",
      external_upload_or_cost_requires_explicit_confirmation: true,
    },
  };
  writeFileSync(
    join(root, "PROJECT_CONTEXT.json"),
    `${JSON.stringify(context, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function scheduleTalkingHeadCodexBinding(jobId, openAfterBinding) {
  if (
    process.env.WORKBENCH_CODEX_TASK_BRIDGE === "disabled" ||
    activeTalkingHeadCodexBindings.has(jobId)
  )
    return;
  const job = getTalkingHeadJob(talkingHeadJobsRoot, jobId);
  if (!job) return;
  if (!openAfterBinding && job.codex_thread_id) return;
  updateTalkingHeadJob(talkingHeadJobsRoot, jobId, {
    codex_thread_status: "connecting",
    codex_thread_error: null,
  });
  const cwd = writeTalkingHeadProjectContext(job);
  const binding = createProjectCodexTask({
    taskId: `talking-${job.id}`,
    title: job.project_name,
    cwd,
    existingThreadId: job.codex_thread_id || null,
    startVisibleTurn: false,
    onThreadStarted: (threadId) =>
      updateTalkingHeadJob(talkingHeadJobsRoot, jobId, {
        codex_thread_id: threadId,
        codex_thread_status: "connecting",
        codex_thread_created_at: new Date().toISOString(),
      }),
  })
    .then(async (result) => {
      let next = updateTalkingHeadJob(talkingHeadJobsRoot, jobId, {
        codex_thread_id: result.threadId,
        codex_thread_name: result.threadName,
        codex_thread_status: "ready",
        codex_thread_error: null,
        codex_thread_created_at:
          job.codex_thread_created_at || new Date().toISOString(),
        codex_thread_initialized_at: job.codex_thread_initialized_at || null,
      });
      if (openAfterBinding) {
        await openCodexThreadInDesktop(result.threadId);
        next = updateTalkingHeadJob(talkingHeadJobsRoot, jobId, {
          codex_thread_opened_at: new Date().toISOString(),
        });
      }
      return next;
    })
    .catch((error) =>
      updateTalkingHeadJob(talkingHeadJobsRoot, jobId, {
        codex_thread_status: "failed",
        codex_thread_error: safeError(error),
      }),
    )
    .finally(() => activeTalkingHeadCodexBindings.delete(jobId));
  activeTalkingHeadCodexBindings.set(jobId, binding);
}

function scheduleSocialExtraction(id) {
  if (activeSocialExtractions.has(id)) return;
  const extraction = getSocialExtraction(db, id);
  if (!extraction) return;
  const job = runSocialExtraction(extraction)
    .then((result) => finishSocialExtraction(db, id, result))
    .catch((error) => {
      console.error("social extraction failed", safeError(error));
      failSocialExtraction(db, id, safeError(error));
    })
    .finally(() => activeSocialExtractions.delete(id));
  activeSocialExtractions.set(id, job);
}

function serveSocialArtifact(res, id, index) {
  const extraction = getSocialExtraction(db, id);
  const artifact = socialArtifacts(extraction)[index];
  if (!artifact?.path || !existsSync(artifact.path))
    return json(res, 404, { error: "这个素材当前不可用。" });
  return streamRegisteredArtifact(res, artifact.path);
}

function socialArtifacts(extraction) {
  const result = extraction?.result;
  if (!result?.output_dir || !existsSync(result.output_dir)) return [];
  const preferred = ["video.mp4", "cover.jpg", "manifest.json"];
  const names = readdirSync(result.output_dir).filter(
    (name) =>
      !name.startsWith(".") && existsSync(join(result.output_dir, name)),
  );
  return [
    ...preferred.filter((name) => names.includes(name)),
    ...names.filter((name) => !preferred.includes(name)),
  ]
    .map((name) => ({ name, path: join(result.output_dir, name) }))
    .filter((item) =>
      /\.(mp4|mov|webm|png|jpe?g|webp|json|txt|md)$/i.test(item.name),
    );
}

async function handleCopilot(req, res, task) {
  const body = await readJson(req);
  const message = cleanText(body.message, 600);
  if (!message) return json(res, 400, { error: "请输入你想问的问题。" });
  addCopilotMessage(db, task.id, "user", message, "user");
  let answer;
  try {
    answer = await answerTaskQuestion({
      task: getTask(db, task.id),
      taskDir: join(dataRoot, "tasks", task.id, "run"),
      message,
    });
  } catch (error) {
    console.error("copilot read-only answer failed", safeError(error));
    answer = fallbackTaskAnswer(getTask(db, task.id));
  }
  const saved = addCopilotMessage(
    db,
    task.id,
    "assistant",
    answer.answer,
    answer.source,
  );
  return json(res, 200, { message: saved, answer, task: getTask(db, task.id) });
}

async function handleCodexTask(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, {
      error:
        "请确认在 Codex 中继续；首次打开会发送一条精简项目交接并使用少量 Token。",
    });
  // A project that was initially saved without running becomes Codex-owned
  // when the user explicitly opens its project task. From this point onward
  // the legacy web orchestrator remains read-only for this project.
  if (!task.managed_mode) {
    db.prepare(
      "UPDATE tasks SET managed_mode = 1, updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), task.id);
    task = getTask(db, task.id);
    syncCodexProjectContext(task);
  }
  const prepareVideoRework = body.intent === "prepare_video_rework";
  const prepareFullVideo = body.intent === "prepare_full_video";
  if (prepareVideoRework && task.video_rework_request?.status !== "prepared")
    return json(res, 409, { error: "请先在工作台保存返工要求。" });
  const executeProject =
    body.intent === "execute_project" || !task.codex_thread_initialized_at;
  const visibleTurnMessage = prepareVideoRework
    ? videoReworkCodexMessage(task)
    : prepareFullVideo
      ? projectTaskFullVideoMessage(task)
    : executeProject
      ? projectTaskExecutionMessage(task)
      : null;
  // Codex only allows one active writer for a task. While the background turn
  // is running, opening the same task in the desktop app produces the confusing
  // "already open in another app" error. Keep the single task and let the web
  // UI show live progress; it becomes openable after the turn releases it.
  if (activeCodexTaskBindings.has(task.id) && task.codex_thread_id) {
    return json(res, 202, {
      task: getTask(db, task.id),
      message: "项目任务正在后台执行，完成或需要你处理后即可打开。",
    });
  }
  if (
    task.codex_thread_id &&
    task.codex_thread_initialized_at &&
    task.codex_thread_status === "ready" &&
    !visibleTurnMessage
  ) {
    await openCodexThreadInDesktop(task.codex_thread_id);
    return json(res, 200, { task });
  }
  scheduleCodexTaskBinding(task.id, { visibleTurnMessage });
  return json(res, 202, { task: getTask(db, task.id) });
}

async function handleRuntimeGeneration(req, res, task) {
  const body = await readJson(req);
  if (
    body.confirmed !== true ||
    !["确认付费提交1次", "确认按本次清单付费提交"].includes(body.confirmation) ||
    body.automaticRetry !== false
  )
    return json(res, 400, {
      error: "请确认按本次清单付费提交，每段最多 1 次且不自动重试。",
    });
  const taskRoot = managedExecutionRoot(task, join(dataRoot, "tasks", task.id));
  const runtimeStatus = readRuntimeGenerationStatus(taskRoot);
  const capacityRetry =
    body.capacityRetry === true &&
    runtimeStatus?.status === "generation_failed" &&
    runtimeStatus?.failure_kind === "capacity_oom";
  if (!capacityRetry && runtimeStatus?.status !== "preflight_passed")
    return json(res, 409, {
      error: "生成前免费检查尚未通过，当前不会上传或扣费。",
    });
  if (activeRuntimeGenerationJobs.has(task.id))
    return json(res, 202, { task: taskForClient(getTask(db, task.id)) });
  const job = (capacityRetry
    ? runRuntimeGenerationPreflight({ task, taskRoot }).then(() =>
        runConfirmedRuntimeGeneration({ task, taskRoot }),
      )
    : runConfirmedRuntimeGeneration({ task, taskRoot }))
    .catch((error) => console.error("runtime generation failed", safeError(error)))
    .finally(() => activeRuntimeGenerationJobs.delete(task.id));
  activeRuntimeGenerationJobs.set(task.id, job);
  return json(res, 202, { task: taskForClient(getTask(db, task.id)) });
}

function videoReworkCodexMessage(task) {
  const request = task.video_rework_request;
  return [
    `我已在工作台登记“${task.title}”的视频返工要求。`,
    "请先读取当前目录的 PROJECT_CONTEXT.json，并核对其中 video_rework_request。",
    `用户选中需要调整：${request.selected_segment_ids.join("、")}；必须保留：${request.preserved_segment_ids.join("、") || "无"}。`,
    request.note ? `用户补充：${request.note}` : null,
    "请调用对应正式质检、提示词和视频任务包 Skill，只准备一份返工方案：说明真实根因是否能确认、保留什么、重做什么、沿用的通道/模型/清晰度、实际需要提交几次以及提交前还需确认什么。",
    "每个返工片段必须在 run/07_generation_pack 下新建同一 rework_preflight_时间目录，并写成 <segment_id>_rework.json；字段至少包含 original_segment_id、provider、model_key、quality_profile、duration_seconds、trim_to_seconds、preflight_status=pass_ready_for_billable_confirmation、external_request_started=false、upload_order_plan、prompt_summary、root_fix、estimated_cost_rh_coins。工作台会自动读取这些结构化结果并显示返工确认单。",
    "本轮禁止上传素材、禁止生成视频、禁止产生外部费用、禁止自动重试；方案给出后等待用户确认。",
  ].filter(Boolean).join("\n");
}

function syncVideoReworkPlan(task) {
  if (task.video_rework_request?.status !== "prepared") return task;
  if (["ready_for_confirmation", "running", "completed"].includes(task.video_rework_plan?.status)) return task;
  try {
    const plan = discoverVideoReworkPlan({
      task,
      taskDir: join(dataRoot, "tasks", task.id, "run"),
    });
    return plan ? saveVideoReworkPlan(db, task.id, plan) : task;
  } catch (error) {
    console.error("video rework plan sync failed", safeError(error));
    return task;
  }
}

server.listen(port, "127.0.0.1", () => {
  console.log(`AI 内容任务中心运行在 http://127.0.0.1:${port}`);
  // A runtime restart releases the in-memory app-server writer. If the
  // durable project ledger still says the managed Codex task was running,
  // resume that same task from its saved checkpoint instead of leaving the
  // page in a permanent false-running state.
  if (!skipStartupRecovery) setTimeout(() => {
    for (const task of listTasks(db)) {
      if (
        !task.managed_mode ||
        !task.codex_thread_id ||
        task.codex_thread_status !== "running" ||
        readCodexProgress(task)?.task_state !== "running"
      )
        continue;
      addEvent(
        db,
        task.id,
        "codex_thread_runtime_restart_recovery",
        "warning",
        "工作台重启后已从同一项目断点自动接续；不会重复外部付费提交。",
        {
          thread_id: task.codex_thread_id,
          automatic_model_turn_recovery: true,
          automatic_paid_retry: false,
        },
      );
      scheduleCodexTaskBinding(task.id, {
        visibleTurnMessage: projectTaskExecutionMessage(task),
      });
    }
  }, 1_000).unref?.();
});

async function handleCreateTask(req, res) {
  enforceUploadLimit(req);
  const form = await requestFromNode(req).formData();
  const title = cleanText(form.get("title"), 100);
  const productBrief = cleanText(form.get("productBrief"), 8000);
  const personBrief = cleanText(form.get("personBrief"), 2000);
  const sceneBrief = cleanText(form.get("sceneBrief"), 2000);
  const scriptBrief = cleanText(form.get("scriptBrief"), 8000);
  // 用户无需为必经的参考片拆解设置额度；5 元只作为后台异常保护线。
  const budgetLimitCny = 5;
  const remixPrecisionRoute = [
    "anchor_frame_alignment",
    "prompt_driven_remix",
  ].includes(String(form.get("remixPrecisionRoute")))
    ? String(form.get("remixPrecisionRoute"))
    : "anchor_frame_alignment";
  const rewriteMode = [
    "keep_original_style",
    "replace_product",
    "exact_original",
  ].includes(String(form.get("rewriteMode")))
    ? String(form.get("rewriteMode"))
    : "keep_original_style";
  const productScope = ["full_look", "top_only", "bottom_only", "custom"].includes(
    String(form.get("productScope")),
  )
    ? String(form.get("productScope"))
    : "unspecified";
  const personRoute = [
    "auto_ai_person",
    "authorized_person",
    "generic_no_fixed_face",
  ].includes(String(form.get("personRoute")))
    ? String(form.get("personRoute"))
    : "auto_ai_person";
  const sceneRoute = [
    "source_like",
    "auto_match",
    "user_location",
    "described_scene",
  ].includes(String(form.get("sceneRoute")))
    ? String(form.get("sceneRoute"))
    : "source_like";
  const scriptRoute = [
    "keep_structure",
    "auto_rewrite",
    "partial_adjustment",
    "use_own_copy",
  ].includes(String(form.get("scriptRoute")))
    ? String(form.get("scriptRoute"))
    : "keep_structure";
  const defaultImageGenerationProvider = [
    "codex_builtin",
    "chatgpt_web",
  ].includes(String(form.get("defaultImageGenerationProvider")))
    ? String(form.get("defaultImageGenerationProvider"))
    : "codex_builtin";
  const generationProvider = ["libtv", "runninghub_h3_multiref"].includes(String(form.get("generationProvider")))
    ? String(form.get("generationProvider"))
    : "libtv";
  const generationQualityProfile = ["normal", "high", "ultra"].includes(String(form.get("generationQualityProfile")))
    ? String(form.get("generationQualityProfile"))
    : "high";
  const generationRouteChoice = ["smoke_test_first", "in_chat_libtv_generation"].includes(String(form.get("generationRouteChoice")))
    ? String(form.get("generationRouteChoice"))
    : "smoke_test_first";
  const requestedGenerationModelKey = String(form.get("generationModelKey") || "");
  const generationModelKey = generationProvider === "runninghub_h3_multiref"
    ? "minimax-h3-multiref-owned-clean"
    : ["star-video2-mini", "star-video2-fast", "star-video2", "star-video2.5"].includes(requestedGenerationModelKey)
      ? requestedGenerationModelKey
      : "star-video2";
  const personAuthorizationConfirmed =
    String(form.get("personAuthorizationConfirmed")) === "true";
  const setupUploadAuthorized =
    String(form.get("setupUploadAuthorized")) === "true";
  const managedMode = String(form.get("managedMode")) === "true";
  const plannedExecutionAuthorized =
    managedMode &&
    setupUploadAuthorized &&
    String(form.get("plannedExecutionAuthorized")) === "true";
  const reference = form.get("referenceVideo");
  if (!title) return json(res, 400, { error: "请填写项目名称。" });
  if (!(reference instanceof File) || reference.size === 0)
    return json(res, 400, { error: "请添加一条参考视频。" });
  if (!looksLikeVideo(reference))
    return json(res, 400, { error: "参考素材必须是常见视频文件。" });
  const productFiles = form
    .getAll("productImages")
    .filter((file) => file instanceof File && file.size > 0);
  const personFiles = form
    .getAll("personImages")
    .filter((file) => file instanceof File && file.size > 0);
  const sceneFiles = form
    .getAll("sceneImages")
    .filter((file) => file instanceof File && file.size > 0);
  if (
    rewriteMode === "replace_product" &&
    productScope === "unspecified"
  )
    return json(res, 400, {
      error: "换成自己的产品时，请先选择图片代表整套穿搭、上衣还是下装。",
    });
  if (
    rewriteMode === "replace_product" &&
    !productBrief &&
    productFiles.length === 0
  )
    return json(res, 400, {
      error: "换成我的产品时，请填写真实资料或至少上传一张产品图片。",
    });
  if (rewriteMode === "exact_original" && productFiles.length === 0)
    return json(res, 400, {
      error: "精确复刻原款需要至少一张清晰商品或服装图。",
    });
  if (personRoute === "authorized_person" && !personAuthorizationConfirmed)
    return json(res, 400, {
      error: "使用本人或已授权人物前，请先确认人物授权。",
    });
  if (personRoute === "authorized_person" && personFiles.length === 0)
    return json(res, 400, {
      error: "使用本人或已授权人物时，请上传 1 张清晰人物母版照片。",
    });
  if (personFiles.length > 1)
    return json(res, 400, { error: "人物母版请先上传 1 张最清晰、最接近正脸的照片。" });
  if (sceneRoute === "user_location" && sceneFiles.length === 0)
    return json(res, 400, { error: "使用自己的店铺或场地时，请至少上传一张空间照片。" });
  if (sceneRoute === "described_scene" && !sceneBrief)
    return json(res, 400, { error: "换成指定场景时，请用一句话说明想要的环境。" });
  if (["partial_adjustment", "use_own_copy"].includes(scriptRoute) && !scriptBrief)
    return json(res, 400, { error: scriptRoute === "use_own_copy" ? "使用自己的文案时，请先粘贴文案。" : "只修改指定部分时，请说明哪些保留、哪些调整。" });
  if (managedMode && !setupUploadAuthorized)
    return json(res, 400, {
      error: "全托管开始前，请确认参考视频的上传范围。",
    });

  const id = randomUUID();
  const inputDir = join(dataRoot, "tasks", id, "inputs");
  mkdirSync(inputDir, { recursive: true });
  const referencePath = join(
    inputDir,
    `reference${safeExtension(reference.name, ".mp4")}`,
  );
  writeFileSync(referencePath, Buffer.from(await reference.arrayBuffer()), {
    flag: "wx",
  });
  const productImagePaths = await saveFiles(productFiles, inputDir, "product");
  const personSourceImagePaths = await saveFiles(personFiles, inputDir, "person-source");
  const sceneImagePaths = await saveFiles(sceneFiles, inputDir, "scene-source");
  const remixChangeContract = {
    schema_version: 1,
    production_preference: remixPrecisionRoute,
    product: {
      mode: rewriteMode,
      scope: productScope,
      brief: productBrief,
      image_paths: productImagePaths,
    },
    person: {
      mode: personRoute,
      brief: personBrief,
      source_image_paths: personSourceImagePaths,
      authorization_confirmed: personAuthorizationConfirmed,
    },
    scene: {
      mode: sceneRoute,
      brief: sceneBrief,
      image_paths: sceneImagePaths,
    },
    script: {
      mode: scriptRoute,
      brief: scriptBrief,
    },
  };
  createTask(db, {
    id,
    title,
    referenceVideoPath: referencePath,
    productBrief,
    productScope,
    productImagePaths,
    budgetLimitCny,
    remixPrecisionRoute,
    rewriteMode,
    personRoute,
    personBrief,
    personAuthorizationConfirmed,
    personSourceImagePaths,
    remixChangeContract,
    defaultImageGenerationProvider,
    generationRouteChoice,
    generationProvider,
    generationQualityProfile,
    generationModelKey,
    setupUploadAuthorized,
    plannedExecutionAuthorized,
    managedMode,
  });
  const task = getTask(db, id);
  if (managedMode && setupUploadAuthorized) {
    try {
      ensureManagedProjectRoute(task, join(dataRoot, "tasks", id));
    } catch (error) {
      console.error("managed project route initialization failed", safeError(error));
      failCodexTaskBinding(db, id, `正式项目目录准备失败：${safeError(error)}`);
      syncCodexProjectContext(getTask(db, id));
      return json(res, 201, { task: taskForClient(getTask(db, id)) });
    }
  }
  syncCodexProjectContext(task);
  if (managedMode && setupUploadAuthorized)
    scheduleCodexTaskBinding(id, {
      visibleTurnMessage: projectTaskExecutionMessage(task),
    });
  return json(res, 201, { task: taskForClient(getTask(db, id)) });
}

function scheduleCodexTaskBinding(
  taskId,
  { visibleTurnMessage = null, startVisibleTurn = true } = {},
) {
  if (
    process.env.WORKBENCH_CODEX_TASK_BRIDGE === "disabled" ||
    activeCodexTaskBindings.has(taskId)
  )
    return;
  const existing = getTask(db, taskId);
  if (!existing)
    return;
  if (
    !visibleTurnMessage &&
    existing.codex_thread_id &&
    existing.codex_thread_initialized_at &&
    existing.codex_thread_status === "ready"
  )
    return;
  markCodexTaskConnecting(db, taskId);
  const bridgeTaskRoot = join(dataRoot, "tasks", taskId);
  mkdirSync(bridgeTaskRoot, { recursive: true });
  const managedRoute = readManagedProjectRoute(bridgeTaskRoot, taskId);
  const executionRoot = managedRoute?.task_root || bridgeTaskRoot;
  const writableRoots = projectWritableRoots(existing, bridgeTaskRoot);
  const createBinding = (existingThreadId, replaceExisting = false) =>
    createProjectCodexTask({
      taskId,
      title: existing.title,
      cwd: executionRoot,
      writableRoots,
      contextUrl: `http://127.0.0.1:${port}/tasks/${taskId}/project-context`,
      existingThreadId,
      startVisibleTurn,
      visibleTurnMessage,
      onThreadStarted: (threadId, metadata = {}) =>
        rememberCodexTaskThread(db, taskId, threadId, {
          replaceUninitialized: Boolean(metadata.replacedThreadId),
          replaceExisting,
        }),
      onVisibleTurnStarted: (threadId) =>
        markCodexTaskRunning(db, taskId, {
          threadId,
          threadName: `项目｜${String(existing.title || "未命名项目").trim()}`.slice(0, 100),
        }),
    });
  // A failed/timeout status belongs to the last turn, not necessarily to the
  // whole task. Always try the saved task first; createProjectCodexTask already
  // replaces it only when Codex explicitly reports "thread not found".
  const resumableThreadId = existing.codex_thread_id || null;
  const codexRecoveryStartedAt = Date.now();
  const codexRecoveryWindowMs = 30 * 60_000;
  const interruptionRecoveryLimit = Math.max(
    1,
    Number(process.env.WORKBENCH_CODEX_INTERRUPTION_RECOVERY_LIMIT || 8),
  );
  let interruptionRecoveryCount = 0;
  let transportRecoveryCount = 0;
  const retryBindingAfter = async (delayMs) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await createBinding(existing.codex_thread_id || null, false);
    } catch (nextError) {
      return recoverCodexBinding(nextError);
    }
  };
  const recoverCodexBinding = async (error) => {
    const message = String(error?.message || error);
    const lowerMessage = message.toLowerCase();
    const isLiveWriter =
      lowerMessage.includes("thread_already_bound") ||
      lowerMessage.includes("thread already bound") ||
      lowerMessage.includes("already has an active writer");
    if (existing.codex_thread_id && isLiveWriter) {
      console.warn("codex project task is already active; keeping the same task", {
        taskId,
        threadId: existing.codex_thread_id,
      });
      return {
        threadId: existing.codex_thread_id,
        threadName:
          existing.codex_thread_name ||
          `项目｜${String(existing.title || "未命名项目").trim()}`.slice(0, 100),
        url: `codex://thread/${existing.codex_thread_id}`,
        source: null,
        initialTurnStarted: Boolean(existing.codex_thread_initialized_at),
      };
    }

    const elapsedMs = Date.now() - codexRecoveryStartedAt;
    if (isCodexTransportDisconnect(message)) {
      if (elapsedMs >= codexRecoveryWindowMs) throw error;
      transportRecoveryCount += 1;
      const delayMs = Math.min(
        60_000,
        5_000 * 2 ** Math.min(transportRecoveryCount - 1, 4),
      );
      addEvent(
        db,
        taskId,
        "codex_transport_reconnecting",
        "warning",
        "项目任务网络连接中断，正在释放旧连接并从同一断点自动重连；不会重做成果或重复付费提交。",
        {
          thread_id: existing.codex_thread_id || null,
          recovery_attempt: transportRecoveryCount,
          retry_delay_ms: delayMs,
          automatic_paid_retry: false,
        },
      );
      return retryBindingAfter(delayMs);
    }

    if (message.includes("CODEX_INITIAL_TURN_INTERRUPTED")) {
      if (
        elapsedMs >= codexRecoveryWindowMs ||
        interruptionRecoveryCount >= interruptionRecoveryLimit
      )
        throw error;
      interruptionRecoveryCount += 1;
      const delayMs = Math.min(
        30_000,
        2_000 * 2 ** Math.min(interruptionRecoveryCount - 1, 4),
      );
      addEvent(
        db,
        taskId,
        "codex_thread_interruption_recovering",
        "warning",
        "项目任务意外中断，正在从同一项目断点自动接续；不会重复外部付费提交。",
        {
          thread_id: existing.codex_thread_id || null,
          recovery_attempt: interruptionRecoveryCount,
          retry_delay_ms: delayMs,
          automatic_model_turn_recovery: true,
          automatic_paid_retry: false,
        },
      );
      return retryBindingAfter(delayMs);
    }

    throw error;
  };
  const job = createBinding(resumableThreadId, false)
    .catch(recoverCodexBinding)
    .then((binding) => finishCodexTaskBinding(db, taskId, binding))
    .catch((error) => {
      console.error("codex project task binding failed", safeError(error));
      failCodexTaskBinding(db, taskId, safeError(error));
    })
    .finally(() => activeCodexTaskBindings.delete(taskId));
  activeCodexTaskBindings.set(taskId, job);
}

function scheduleRuntimeGenerationPreflight(task) {
  if (!task || activeRuntimeGenerationJobs.has(task.id)) return;
  const taskRoot = managedExecutionRoot(task, join(dataRoot, "tasks", task.id));
  let request;
  try {
    request = loadRuntimeGenerationRequest({ task, taskRoot });
  } catch (error) {
    console.error("runtime generation request rejected", safeError(error));
    recordRuntimeGenerationRequestFailure({ task, taskRoot, error });
    return;
  }
  if (!request) return;
  const status = readRuntimeGenerationStatus(taskRoot);
  if (status?.pack_path === request.request.pack_path && status?.status === "generation_running") {
    const job = runConfirmedRuntimeGeneration({ task, taskRoot })
      .catch((error) => console.error("runtime generation resume failed", safeError(error)))
      .finally(() => activeRuntimeGenerationJobs.delete(task.id));
    activeRuntimeGenerationJobs.set(task.id, job);
    return;
  }
  if (status?.pack_path === request.request.pack_path && ["preflight_running", "generation_completed", "generation_failed"].includes(status?.status))
    return;
  const job = runRuntimeGenerationPreflight({
    task,
    taskRoot,
    autoSubmitAfterPreflight: Boolean(task.planned_execution_authorized),
  })
    .then((preflight) => {
      if (
        preflight?.status === "preflight_passed" &&
        plannedExecutionCoversGeneration(task, request)
      )
        return runConfirmedRuntimeGeneration({ task, taskRoot });
      return preflight;
    })
    .catch((error) => console.error("runtime generation preflight failed", safeError(error)))
    .finally(() => activeRuntimeGenerationJobs.delete(task.id));
  activeRuntimeGenerationJobs.set(task.id, job);
}

function plannedExecutionCoversGeneration(task, context) {
  if (!task?.planned_execution_authorized || !context?.items?.length) return false;
  if (task.generation_provider !== "runninghub_h3_multiref") return false;
  if (context.items.length > 5) return false;
  if (context.items.some((item) => item?.pack?.automatic_retry !== false)) return false;
  if (task.generation_route_choice === "smoke_test_first")
    return (
      context.items.length === 1 &&
      Number(context.items[0]?.pack?.duration_seconds || 0) <= 4
    );
  return task.generation_route_choice === "in_chat_libtv_generation";
}

function scheduleRuntimeDecomposition(task) {
  if (!task || activeRuntimeDecompositionJobs.has(task.id)) return;
  const taskRoot = managedExecutionRoot(task, join(dataRoot, "tasks", task.id));
  let request;
  try {
    request = loadRuntimeDecompositionRequest({ task, taskRoot });
  } catch (error) {
    console.error("runtime decomposition request rejected", safeError(error));
    return;
  }
  if (!request) return;
  const status = readRuntimeDecompositionStatus(taskRoot);
  if (["preflight_running", "running", "completed"].includes(status?.status)) return;
  const job = runRuntimeDecomposition({
    task,
    taskRoot,
    onEvent(message) {
      addEvent(db, task.id, "runtime_decomposition", "info", message);
    },
  })
    .catch((error) => console.error("runtime decomposition failed", safeError(error)))
    .finally(() => activeRuntimeDecompositionJobs.delete(task.id));
  activeRuntimeDecompositionJobs.set(task.id, job);
}

function projectWritableRoots(task, taskRoot) {
  const roots = new Set([taskRoot]);
  const managedRoute = readManagedProjectRoute(taskRoot, task.id);
  if (managedRoute) roots.add(managedRoute.task_root);
  for (const artifact of task?.artifacts || []) {
    let cursor = dirname(String(artifact?.path || ""));
    while (cursor && cursor !== dirname(cursor)) {
      if (basename(cursor).includes(task.id)) {
        roots.add(cursor);
        break;
      }
      cursor = dirname(cursor);
    }
  }
  return [...roots];
}

function managedProjectRoutePath(taskRoot) {
  return join(taskRoot, "ARTIFACT_ROUTE.json");
}

function validateManagedProjectRoute(route, taskId) {
  if (
    !route ||
    route.schema !== "workbench-task-route-v1" ||
    route.status !== "ready" ||
    route.task_id !== taskId ||
    typeof route.task_root !== "string" ||
    !existsSync(route.task_root) ||
    lstatSync(route.task_root).isSymbolicLink()
  )
    throw new Error("MANAGED_PROJECT_ROUTE_INVALID");
  const canonicalRoot = realpathSync(route.task_root);
  const canonicalProjectsRoot = `${realpathSync(join(artifactRoot(), "02_项目工作区"))}${sep}`;
  if (!canonicalRoot.startsWith(canonicalProjectsRoot) || !basename(canonicalRoot).includes(taskId))
    throw new Error("MANAGED_PROJECT_ROUTE_OUTSIDE_WORKBENCH");
  return { ...route, task_root: canonicalRoot };
}

function readManagedProjectRoute(taskRoot, taskId) {
  const path = managedProjectRoutePath(taskRoot);
  if (!existsSync(path)) return null;
  return validateManagedProjectRoute(JSON.parse(readFileSync(path, "utf8")), taskId);
}

function ensureManagedProjectRoute(task, taskRoot) {
  const existing = readManagedProjectRoute(taskRoot, task.id);
  if (existing) {
    syncManagedProjectInputs(task, taskRoot, existing);
    return existing;
  }
  const output = execFileSync(
    configuredBinary("WORKBENCH_PYTHON", "python3"),
    [
      artifactToolFile("artifact_manager.py"),
      "init-project",
      "--workbench",
      artifactRoot(),
      "--start",
      taskRoot,
      "--task-id",
      task.id,
      "--project-name",
      task.title,
      "--category",
      "video",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const route = validateManagedProjectRoute(JSON.parse(output), task.id);
  writeFileSync(
    managedProjectRoutePath(taskRoot),
    `${JSON.stringify(route, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  syncManagedProjectInputs(task, taskRoot, route);
  return route;
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function syncManagedProjectInputs(task, bridgeTaskRoot, route) {
  const source = realpathSync(task.reference_video_path);
  const allowedInputRoot = `${realpathSync(join(bridgeTaskRoot, "inputs"))}${sep}`;
  if (!source.startsWith(allowedInputRoot) || lstatSync(source).isSymbolicLink())
    throw new Error("MANAGED_REFERENCE_VIDEO_OUTSIDE_TASK_INPUTS");
  const target = join(route.source_dir, `reference${extname(source).toLowerCase() || ".mp4"}`);
  if (existsSync(target)) {
    if (statSync(target).size !== statSync(source).size || fileSha256(target) !== fileSha256(source))
      throw new Error("MANAGED_REFERENCE_VIDEO_CONFLICT");
  } else {
    copyFileSync(source, target);
    if (statSync(target).size !== statSync(source).size || fileSha256(target) !== fileSha256(source))
      throw new Error("MANAGED_REFERENCE_VIDEO_COPY_FAILED");
  }
  return target;
}

function managedExecutionRoot(task, bridgeTaskRoot) {
  return readManagedProjectRoute(bridgeTaskRoot, task.id)?.task_root || bridgeTaskRoot;
}

function codexProjectContext(task) {
  const taskRoot = join(dataRoot, "tasks", task.id);
  const managedProjectRoute = readManagedProjectRoute(taskRoot, task.id);
  const managedReferenceVideoPath = managedProjectRoute
    ? join(
        managedProjectRoute.source_dir,
        `reference${extname(task.reference_video_path).toLowerCase() || ".mp4"}`,
      )
    : null;
  const registeredProductImagesAuthorized = Boolean(
    task.setup_upload_authorized &&
      task.rewrite_mode === "replace_product" &&
      Array.isArray(task.product_image_paths) &&
      task.product_image_paths.length > 0,
  );
  const registeredPersonImagesAuthorized = Boolean(
    task.setup_upload_authorized &&
      task.person_route === "authorized_person" &&
      task.person_authorization_confirmed &&
      Array.isArray(task.person_source_image_paths) &&
      task.person_source_image_paths.length > 0,
  );
  const registeredSceneImagePaths = Array.isArray(
    task.remix_change_contract?.scene?.image_paths,
  )
    ? task.remix_change_contract.scene.image_paths
    : [];
  const registeredSceneImagesAuthorized = Boolean(
    task.setup_upload_authorized &&
      task.remix_change_contract?.scene?.mode === "user_location" &&
      registeredSceneImagePaths.length > 0,
  );
  const allowedScope = task.setup_upload_authorized
    ? [
        "本项目参考视频上传豆包做语义拆解",
        "人物与分镜环节使用系统逐张列明、从本项目参考片产生的必要参考图",
        ...(registeredProductImagesAuthorized
          ? ["创建页已登记的产品图，仅用于产品参考净化、目标分镜和本项目后续生成"]
          : []),
        ...(registeredPersonImagesAuthorized
          ? ["创建页已登记且确认授权的人物图，仅用于本项目人物资产和后续生成"]
          : []),
        ...(registeredSceneImagesAuthorized
          ? ["创建页已登记的场景图，仅用于本项目场景资产、目标分镜和后续生成"]
          : []),
      ]
    : [];
  return {
    schema_version: 1,
    project: {
      id: task.id,
      title: task.title,
      workflow: task.workflow,
      execution_owner: REMIX_EXECUTION_OWNER,
    },
    current: {
      status: task.status,
      step: task.current_step,
      user_state: task.user_state,
      updated_at: task.updated_at,
    },
    setup: {
      remix_route: task.remix_precision_route,
      change_contract: task.remix_change_contract || null,
      product_route: task.rewrite_mode,
      person_route: task.person_route,
      person_brief: task.person_brief || "",
      default_image_provider: task.default_image_generation_provider,
      // Keep the generation channel explicit. `video_route` describes whether
      // the user wants a smoke test or the full video; it must not be used to
      // infer LibTV vs RunningHub.
      video_provider: task.generation_provider,
      video_route: task.generation_route_choice,
      video_quality: task.generation_quality_profile,
      video_model:
        task.generation_model_snapshot?.model_name ||
        task.generation_model_key ||
        null,
      budget_limit_cny: task.budget_limit_cny,
      estimated_cost_cny: task.estimated_cost_cny,
      formal_project_route: managedProjectRoute
        ? {
            task_root: managedProjectRoute.task_root,
            source_dir: managedProjectRoute.source_dir,
            intermediate_dir: managedProjectRoute.intermediate_dir,
            final_dir: managedProjectRoute.final_dir,
            work_dir: managedProjectRoute.work_dir,
            reference_video_path: managedReferenceVideoPath,
          }
        : null,
    },
    authorization: {
      setup_upload_authorized: Boolean(task.setup_upload_authorized),
      allowed_scope: allowedScope,
      registered_product_image_paths: registeredProductImagesAuthorized
        ? [...task.product_image_paths]
        : [],
      registered_person_image_paths: registeredPersonImagesAuthorized
        ? [...task.person_source_image_paths]
        : [],
      registered_scene_image_paths: registeredSceneImagesAuthorized
        ? [...registeredSceneImagePaths]
        : [],
      excluded_scope: [
        ...(registeredProductImagesAuthorized ? [] : ["产品图"]),
        ...(registeredPersonImagesAuthorized ? [] : ["授权真人照片"]),
        ...(registeredSceneImagesAuthorized ? [] : ["场景图"]),
        "未列入当前任务的其他素材",
      ],
      planned_execution_authorized: Boolean(task.planned_execution_authorized),
      planned_execution: task.planned_execution_authorized
        ? {
            authorization_status: "authorized_by_project_submission",
            image_generation: {
              allowed: true,
              provider: task.default_image_generation_provider,
              registered_project_inputs_only: true,
              intermediate_candidate_review: "official_skill_contract_only",
            },
            video_generation: {
              allowed: true,
              provider: task.generation_provider,
              route: task.generation_route_choice,
              max_billable_submissions:
                task.generation_route_choice === "smoke_test_first" ? 1 : 5,
              max_submissions_per_segment: 1,
              automatic_retry: false,
            },
            final_result_requires_user_adoption: true,
            additional_paid_submission_requires_new_confirmation: true,
          }
        : null,
      image_and_video_generation_cost_requires_runtime_confirmation:
        !task.planned_execution_authorized,
      source: "用户在工作台创建项目时的上传范围确认",
    },
    video_rework_request: task.video_rework_request || null,
    video_rework_plan: task.video_rework_plan || null,
    workflow_handoff: task.workflow_handoff || null,
    available_artifacts: currentProjectArtifacts(task).map((artifact) => ({
      stage: artifact.stage,
      label: artifact.label,
      path: artifact.path,
    })),
    boundaries: {
      workbench_role: "collect_display_persist",
      business_rules_owner: "formal_skills",
      workflow_orchestrator: "ai-commercial-video-remix",
      legacy_web_orchestrator: "read_only_compatibility",
      external_upload_or_cost_requires_explicit_confirmation:
        !task.planned_execution_authorized,
      automatic_model_turn: "after_project_submission",
      codex_task_initial_turn: "start_from_saved_project_contract",
    },
  };
}

function autoResumeRegisteredProductScope(task) {
  if (
    !task?.managed_mode ||
    !task.setup_upload_authorized ||
    task.rewrite_mode !== "replace_product" ||
    !Array.isArray(task.product_image_paths) ||
    task.product_image_paths.length === 0 ||
    task.codex_thread_status !== "ready"
  )
    return false;
  const progress = readCodexProgress(task);
  if (
    progress?.task_state !== "waiting_user" ||
    progress?.phase_key !== "product_asset_upload_authorization"
  )
    return false;
  const eventType = "registered_product_scope_auto_resumed";
  if (task.events?.some((event) => event.event_type === eventType)) return false;
  addEvent(
    db,
    task.id,
    eventType,
    "info",
    "已识别创建页登记的产品图授权，系统从当前断点自动继续。",
    {
      product_image_count: task.product_image_paths.length,
      automatic_retry: false,
      scope_expanded: false,
    },
  );
  scheduleCodexTaskBinding(task.id, {
    visibleTurnMessage: projectTaskRegisteredProductScopeMessage({
      title: task.title,
      productImageCount: task.product_image_paths.length,
    }),
  });
  return true;
}

function readCodexProgress(task) {
  const bridgeTaskRoot = join(dataRoot, "tasks", task.id);
  const route = readManagedProjectRoute(bridgeTaskRoot, task.id);
  const candidates = [
    route ? join(route.task_root, "CODEX_PROGRESS.json") : null,
    join(bridgeTaskRoot, "CODEX_PROGRESS.json"),
  ].filter(Boolean);
  const path = candidates.find(existsSync);
  if (!path) return null;
  try {
    const progress = JSON.parse(readFileSync(path, "utf8"));
    if (Number(progress?.schema_version) !== 1) return null;
    return progress;
  } catch {
    return null;
  }
}

function taskForClient(task) {
  if (!task) return task;
  const rawCodexProgress = readCodexProgress(task);
  const bridgeTaskRoot = join(dataRoot, "tasks", task.id);
  const taskRoot = managedExecutionRoot(task, bridgeTaskRoot);
  const rawRuntimeGeneration = readRuntimeGenerationStatus(taskRoot);
  const runtimeGeneration = externalProgressIsCurrent(task, rawRuntimeGeneration)
    ? rawRuntimeGeneration
    : null;
  // CODEX_PROGRESS.json lives inside this task's immutable managed project
  // root, so its path already binds it to the project. Database-only metadata
  // updates (thread binding, events, opening the task) must not hide the latest
  // business progress from the page merely because they have a newer timestamp.
  const codexProgress = rawCodexProgress;
  const runtimeState = runtimeGenerationUserState(runtimeGeneration);
  const codexState = codexProgressUserState(codexProgress);
  return {
    ...task,
    execution_owner: isCodexOwnedRemixTask(task)
      ? REMIX_EXECUTION_OWNER
      : "legacy_web_orchestrator",
    user_state: runtimeState || codexState || task.user_state,
    // CODEX_PROGRESS.json is the only business-workflow ledger. Provider
    // runtime status is exposed separately and may temporarily drive the
    // user-facing call to action, but must never overwrite the Skill-owned
    // project phase or its audit history.
    codex_progress: codexProgress,
    runtime_generation: runtimeGeneration,
    artifacts: [
      ...(task.artifacts || []),
      ...codexProgressArtifacts(task, rawCodexProgress),
      ...runtimeGenerationArtifacts(task, rawRuntimeGeneration),
    ],
  };
}

function isCodexOwnedRemixTask(task) {
  return Boolean(task?.managed_mode || task?.codex_thread_id);
}

function codexProgressUserState(progress) {
  if (!progress) return null;
  const state = String(progress.task_state || "").toLowerCase();
  const phase = String(progress.phase_label || "项目正在继续");
  const summary = String(progress.summary || "项目任务已更新进度。");
  const next = String(progress.next_action || "暂时不用操作，工作台会继续更新。");
  if (/failed|blocked|error|interrupted/.test(state))
    return {
      key: "assistance", label: "需要处理", tone: "error",
      headline: phase, summary, next_step: next, needs_attention: true,
    };
  if (/waiting|review|confirm|approval/.test(state))
    return {
      key: "confirmation", label: "等你确认", tone: "waiting",
      headline: phase, summary, next_step: next, needs_attention: true,
    };
  if (/complete|approved|adopted|finished|success/.test(state))
    return {
      key: "completed", label: "已完成", tone: "done",
      headline: phase, summary, next_step: next, needs_attention: false,
    };
  return {
    key: "processing", label: "正在处理", tone: "running",
    headline: phase, summary, next_step: next, needs_attention: false,
  };
}

function externalProgressIsCurrent(task, progress) {
  if (!progress) return false;
  // A completed runtime result is stored in the managed project root and is
  // immutable for that run. Later metadata-only updates (for example binding
  // the project Codex task) must not hide the finished video from the UI.
  if (
    progress.status === "generation_completed" &&
    Array.isArray(progress.artifacts) &&
    progress.artifacts.length > 0
  ) return true;
  const taskUpdatedAt = Date.parse(String(task?.updated_at || ""));
  const progressUpdatedAt = Date.parse(String(progress?.updated_at || ""));
  if (!Number.isFinite(taskUpdatedAt) || !Number.isFinite(progressUpdatedAt))
    return true;
  return progressUpdatedAt >= taskUpdatedAt;
}

function runtimeGenerationUserState(status) {
  if (!status) return null;
  if (status.status === "preflight_running")
    return {
      key: "processing", label: "正在检查", tone: "running",
      headline: status.phase_label, summary: status.summary,
      next_step: "暂时不用操作，检查完成后工作台会自动更新。", needs_attention: false,
    };
  if (status.status === "preflight_passed")
    return {
      key: "confirmation", label: "待确认", tone: "waiting",
      headline: status.phase_label, summary: status.summary,
      next_step: status.next_action, needs_attention: true,
    };
  if (status.status === "generation_running")
    return {
      key: "processing", label: "正在生成", tone: "running",
      headline: status.phase_label, summary: status.summary,
      next_step: status.next_action, needs_attention: false,
    };
  if (status.status === "generation_completed")
    return {
      key: "confirmation", label: "结果已返回", tone: "done",
      headline: status.phase_label, summary: status.summary,
      next_step: status.next_action, needs_attention: true,
    };
  return {
    key: "assistance", label: "需要处理", tone: "error",
    headline: status.phase_label || "当前步骤未完成", summary: status.summary,
    next_step: status.next_action, needs_attention: true,
  };
}

function runtimeGenerationArtifacts(task, status) {
  return (Array.isArray(status?.artifacts) ? status.artifacts : [])
    .map((artifact, index) => ({
      artifact,
      index,
      resolvedPath: safeCodexArtifactPath(task, artifact?.path),
    }))
    .filter(({ resolvedPath }) => resolvedPath)
    .map(({ artifact, index, resolvedPath }) => ({
      id: RUNTIME_ARTIFACT_ID_BASE + index,
      stage: String(artifact.stage || "video_generation"),
      label: String(artifact.label || basename(resolvedPath)),
      path: resolvedPath,
      published: 1,
    }));
}

function codexProgressArtifacts(task, progress = readCodexProgress(task)) {
  return (Array.isArray(progress?.artifacts) ? progress.artifacts : [])
    .map((artifact, index) => ({
      artifact,
      index,
      resolvedPath: safeCodexArtifactPath(task, artifact?.path),
    }))
    .filter(({ artifact, resolvedPath }) => {
      if (!resolvedPath) return false;
      const label = String(artifact?.label || "");
      const type = String(artifact?.type || "");
      const status = String(artifact?.status || "");
      const userFacingType = /character_asset|person_asset|storyboard|video_result|generated_video|final_video|sample_video/i.test(type);
      const userFacingStatus = /needs_review|approved|adopted|formal|completed|ready_for_review/i.test(status);
      if (!userFacingType || !userFacingStatus) return false;
      return !/Keychain|原始错误|预检|回执|任务包|\bQC\b|自检|本地复核|gatekeeper/i.test(label);
    })
    .map(({ artifact, index, resolvedPath }) => {
      const type = String(artifact.type || "");
      const stage = /character_asset|person_asset/i.test(type)
        ? "person"
        : /storyboard/i.test(type)
          ? "storyboard"
          : /video/i.test(type)
            ? "video_generation"
            : "codex_project";
      const label = String(
        artifact.label ||
          (/male/i.test(artifact.path || "")
            ? "男性人物候选"
            : /female/i.test(artifact.path || "")
              ? "女性人物候选"
              : basename(artifact.path)),
      );
      return {
        id: CODEX_ARTIFACT_ID_BASE + index,
        stage,
        label,
        path: resolvedPath,
        published: 1,
      };
    });
}

function safeCodexArtifactPath(task, path) {
  try {
    const taskRoot = join(dataRoot, "tasks", task.id);
    const route = readManagedProjectRoute(taskRoot, task.id);
    const requestedCandidates = String(path || "").startsWith("/")
      ? [String(path)]
      : [
          route?.task_root ? join(route.task_root, String(path || "")) : null,
          join(taskRoot, String(path || "")),
        ].filter(Boolean);
    const requested = requestedCandidates.find(
      (candidate) =>
        existsSync(candidate) && !lstatSync(candidate).isSymbolicLink(),
    );
    if (!path || !requested) return null;
    const candidate = realpathSync(requested);
    if (!lstatSync(candidate).isFile()) return null;
    const allowed = projectWritableRoots(task, taskRoot).some((root) => {
      const allowed = realpathSync(root);
      return candidate === allowed || candidate.startsWith(`${allowed}${sep}`);
    });
    return allowed ? candidate : null;
  } catch {
    return null;
  }
}

function currentProjectArtifacts(task) {
  const latest = new Map();
  for (const artifact of task.artifacts || []) {
    if (
      !artifact.published ||
      /^候选图片[｜|]/.test(artifact.label || "") ||
      /项目状态|阻断|阻塞|交接|自检|任务包|预检|回执|局部深拉证据|质检/.test(
        artifact.label || "",
      )
    )
      continue;
    const key =
      artifact.stage === "person" && /人物/.test(artifact.label)
        ? "person"
        : artifact.stage === "storyboard" && /分镜/.test(artifact.label)
          ? "storyboard"
          : artifact.stage === "video_generation" && /视频/.test(artifact.label)
            ? "video"
            : /DNA/i.test(artifact.label)
              ? "remix_plan"
              : /拆解.*报告|视频拆解验收报告/.test(artifact.label)
                ? "decomposition"
                : `${artifact.stage}:${artifact.label}`;
    const previous = latest.get(key);
    if (!previous || artifact.id > previous.id) latest.set(key, artifact);
  }
  return [...latest.values()].sort((left, right) => left.id - right.id);
}

function syncCodexProjectContext(task) {
  const context = codexProjectContext(task);
  const taskRoot = join(dataRoot, "tasks", task.id);
  mkdirSync(taskRoot, { recursive: true });
  const path = join(taskRoot, "PROJECT_CONTEXT.json");
  const serialized = `${JSON.stringify(context, null, 2)}\n`;
  // PROJECT_CONTEXT.json is the immutable input contract. Business progress
  // belongs to CODEX_PROGRESS.json; polling the page must not rewrite the
  // contract with SQLite state from the legacy orchestrator.
  if (!existsSync(path))
    writeFileSync(path, serialized, { encoding: "utf8", flag: "wx" });
  const managedRoute = readManagedProjectRoute(taskRoot, task.id);
  if (managedRoute) {
    syncManagedProjectInputs(task, taskRoot, managedRoute);
    const managedPath = join(managedRoute.task_root, "PROJECT_CONTEXT.json");
    if (!existsSync(managedPath))
      writeFileSync(managedPath, serialized, { encoding: "utf8", flag: "wx" });
  }
  return context;
}

async function routeExceptionToProjectTask(
  taskId,
  stage,
  { error = null, result = null } = {},
) {
  try {
    const current = getTask(db, taskId);
    if (!current) return null;
    const envelope = await buildWorkflowHandoffEnvelope({
      task: current,
      stage,
      error,
      result,
    });
    const updated = recordWorkflowHandoff(db, taskId, envelope);
    syncCodexProjectContext(updated);
    scheduleCodexTaskBinding(taskId, current.managed_mode
      ? { visibleTurnMessage: projectTaskExecutionMessage(current) }
      : { startVisibleTurn: false });
    return updated;
  } catch (handoffError) {
    console.error("workflow exception handoff failed", safeError(handoffError));
    addEvent(
      db,
      taskId,
      "workflow_exception_handoff_failed",
      "warning",
      "当前成果仍已保留，但项目任务交接暂未完成。",
      { error: safeError(handoffError), automatic_retry: false },
    );
    return null;
  }
}

async function handleStart(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "开始拆解前必须确认本次参考视频的上传范围。" });
  if (
    ![STATUSES.READY, STATUSES.FAILED, STATUSES.INTERRUPTED].includes(
      task.status,
    ) ||
    (task.current_step !== "decomposition" && task.current_step !== "unknown")
  ) {
    return json(res, 409, { error: "当前任务不在可开始拆解的状态。" });
  }
  return launch(res, task.id, "decomposition");
}

async function handleConfirmRewrite(req, res, task) {
  if (
    task.status !== STATUSES.AWAITING_CONFIRMATION ||
    !task.decomposition_result
  )
    return json(res, 409, { error: "必须先完成参考视频拆解。" });
  enforceUploadLimit(req);
  const form = await requestFromNode(req).formData();
  if (String(form.get("confirmed")) !== "true")
    return json(res, 400, { error: "进入商品改写前必须由你明确确认。" });
  const productBrief =
    cleanText(form.get("productBrief"), 8000) || task.product_brief;
  const productScope = ["full_look", "top_only", "bottom_only", "custom"].includes(
    String(form.get("productScope")),
  )
    ? String(form.get("productScope"))
    : task.product_scope || "unspecified";
  const rewriteMode = ["replace_product", "exact_original"].includes(
    String(form.get("rewriteMode")),
  )
    ? String(form.get("rewriteMode"))
    : "replace_product";
  const inputDir = join(dataRoot, "tasks", task.id, "inputs");
  const newImages = await saveFiles(
    form.getAll("productImages"),
    inputDir,
    `product-${Date.now()}`,
  );
  const productImages = [
    ...new Set([...(task.product_image_paths || []), ...newImages]),
  ];
  if (!productBrief && productImages.length === 0)
    return json(res, 400, {
      error: "请填写真实产品资料或至少上传一张产品图片。",
    });
  if (rewriteMode === "replace_product" && productScope === "unspecified")
    return json(res, 400, {
      error: "请先选择产品图片代表整套穿搭、上衣还是下装。",
    });
  if (rewriteMode === "exact_original" && productImages.length === 0)
    return json(res, 400, {
      error: "精确复刻原款需要至少补充一张清晰服装或商品图。",
    });
  updateProductInputs(
    db,
    task.id,
    productBrief,
    productImages,
    rewriteMode,
    productScope,
  );
  return launch(res, task.id, "rewrite");
}

async function handleSkipRewrite(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, {
      error: "请确认保留原产品或穿搭风格并跳过商品改写。",
    });
  try {
    return json(res, 200, { task: completeWithoutRewrite(db, task.id) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleSaveDecomposition(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认只保存拆解结果，暂不继续制作。" });
  try {
    return json(res, 200, { task: saveDecompositionOnly(db, task.id) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handlePreparePerson(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认只在本机登记人物路线。" });
  try {
    return json(res, 200, {
      task: preparePersonInputs(db, task.id, {
        personRoute: String(body.personRoute || ""),
        personBrief: cleanText(body.personBrief, 2000),
        authorizationConfirmed: body.authorizationConfirmed === true,
      }),
    });
  } catch (error) {
    return json(res, 400, { error: safeError(error) });
  }
}

async function handleUploadPersonSource(req, res, task) {
  enforceUploadLimit(req);
  const form = await requestFromNode(req).formData();
  if (String(form.get("confirmed")) !== "true")
    return json(res, 400, { error: "请确认这张照片属于本人或已取得授权，并仅用于当前项目。" });
  const images = form.getAll("personImages").filter((file) => file instanceof File && file.size > 0);
  if (images.length !== 1)
    return json(res, 400, { error: "请上传 1 张最清晰、最接近正脸的人物照片。" });
  try {
    const inputDir = join(dataRoot, "tasks", task.id, "inputs");
    const paths = await saveFiles(images, inputDir, `person-source-${Date.now()}`);
    return json(res, 200, { task: registerAuthorizedPersonSource(db, task.id, paths) });
  } catch (error) {
    return json(res, 400, { error: safeError(error) });
  }
}

async function handleGenerationProvider(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认只修改这个项目的默认生图通道。" });
  const generationProvider = String(body.generationProvider || "");
  try {
    return json(res, 200, {
      task: setDefaultImageGenerationProvider(db, task.id, generationProvider),
    });
  } catch (error) {
    return json(res, 400, { error: safeError(error) });
  }
}

async function handleGeneratePerson(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认生成 1 张人物候选。" });
  if (body.sourceFrameUploadAuthorized !== true)
    return json(res, 400, {
      error: "请确认本次只上传必要的参考片人物关键帧。",
    });
  const generationProvider = String(
    body.generationProvider ||
      task.default_image_generation_provider ||
      "codex_builtin",
  );
  try {
    schedulePersonStage(task.id, generationProvider);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return json(res, 202, { task: getTask(db, task.id) });
}

async function handleApprovePerson(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认采用当前人物候选。" });
  try {
    const candidate = currentPersonImageArtifact(task);
    const published = task.person_generation_result?.source_kind === "authorized_upload"
      ? { ...candidate, label: "授权人物母版", published: true }
      : process.env.WORKBENCH_PERSON_GENERATOR
      ? { ...candidate, label: "AI 人物母版", published: true }
      : publishApprovedPerson(task);
    const approved = approvePersonAsset(db, task.id, published);
    if (approved.managed_mode) {
      continueAfterApprovedPerson(task.id);
      return json(res, 202, { task: getTask(db, task.id) });
    }
    return json(res, 200, { task: approved });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handlePrepareProductAssets(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认只在本机整理现有商品图。" });
  try {
    scheduleProductAssetsStage(task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return json(res, 202, { task: getTask(db, task.id) });
}

async function handleApproveProductAssets(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认采用当前干净产品参考图。" });
  try {
    return json(res, 200, { task: approveProductAssets(db, task.id) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleProductScope(req, res, task) {
  const body = await readJson(req);
  try {
    updateProductScope(db, task.id, String(body.productScope || ""));
    scheduleProductAssetsStage(task.id);
    return json(res, 202, { task: getTask(db, task.id) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

function scheduleProductAssetsStage(taskId) {
  if (activeJobs.has(taskId)) throw new Error("这个任务已经在执行。");
  beginProductAssets(db, taskId);
  const fresh = getTask(db, taskId);
  const taskDir = join(dataRoot, "tasks", taskId, "run");
  let lastProgressAt = 0;
  const job = runProductAssetsStage({
    task: fresh,
    taskDir,
    env: process.env,
    onEvent(message) {
      const stamp = Date.now();
      if (!message || stamp - lastProgressAt < 3000) return;
      lastProgressAt = stamp;
      const visible = userVisibleProgress(message);
      addEvent(db, taskId, "product_assets_progress", "info", visible);
      db.prepare("UPDATE tasks SET user_message = ?, updated_at = ? WHERE id = ?")
        .run(visible, new Date().toISOString(), taskId);
    },
  })
    .then(async (result) => {
      if (result.status === "completed" && result.requires_confirmation !== true) {
        const finished = finishProductAssets(db, taskId, result);
        if (finished.managed_mode)
          setTimeout(() => {
            try {
              const { generationRouteChoice, generationModelSelection } =
                managedGenerationSelection(finished);
              scheduleVideoPromptStage(taskId, {
                continueToGenerationPack: {
                  generationRouteChoice,
                  generationModelSelection,
                },
              });
            } catch (error) {
              addEvent(
                db,
                taskId,
                "managed_flow_paused",
                "warning",
                "产品参考已整理完成，但视频提示词没有自动启动。",
                { error: safeError(error) },
              );
            }
          }, 0);
      } else {
        failProductAssets(
          db,
          taskId,
          result.user_message || result.summary,
          result,
        );
        await routeExceptionToProjectTask(taskId, "product_assets", { result });
      }
    })
    .catch(async (error) => {
      failProductAssets(db, taskId, error);
      await routeExceptionToProjectTask(taskId, "product_assets", { error });
    })
    .finally(() => activeJobs.delete(taskId));
  activeJobs.set(taskId, job);
}

async function handlePrepareStoryboard(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认只在本机准备锚帧分镜资料。" });
  try {
    return json(res, 200, {
      task: prepareStoryboardInputs(db, task.id, {
        storyboardMode: String(body.storyboardMode || "anchor_storyboard"),
        storyboardBrief: cleanText(body.storyboardBrief, 2000),
      }),
    });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleGenerateStoryboard(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认生成目标宫格分镜。" });
  if (body.sourceFrameUploadAuthorized !== true)
    return json(res, 400, {
      error: "请确认本次只上传必要原片锚帧和已确认人物母版。",
    });
  const generationProvider = String(
    body.generationProvider ||
      task.default_image_generation_provider ||
      "codex_builtin",
  );
  if (
    generationProvider === "chatgpt_web" &&
    body.objectiveRatioRepairAuthorized !== true
  )
    return json(res, 400, {
      error: "请确认仅在首图画布比例失败时允许系统自动纠正一次。",
    });
  try {
    scheduleStoryboardStage(
      task.id,
      generationProvider,
      body.objectiveRatioRepairAuthorized === true,
      body.resumeIncomplete === true,
    );
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return json(res, 202, { task: getTask(db, task.id) });
}

function scheduleStoryboardStage(
  taskId,
  generationProvider,
  ratioRepairAuthorized,
  resumeIncomplete = false,
) {
  if (activeJobs.has(taskId)) throw new Error("这个任务已经在执行。");
  if (generationProvider === "chatgpt_web") {
    const bridge = inspectChatGPTBridge(browserBridgeRoot);
    if (!bridge.available) throw new Error(bridge.user_message);
  }
  beginStoryboardGeneration(db, taskId, {
    sourceUploadAuthorized: true,
    generationProvider,
    ratioRepairAuthorized,
    resumeIncomplete,
  });
  const fresh = getTask(db, taskId);
  const taskDir = join(dataRoot, "tasks", taskId, "run");
  let lastProgressAt = 0;
  const job = runStoryboardStage({
    task: fresh,
    taskDir,
    env:
      generationProvider === "chatgpt_web" &&
      !process.env.WORKBENCH_CHATGPT_WEB_GENERATOR
        ? {
            ...process.env,
            WORKBENCH_CHATGPT_WEB_GENERATOR: bundledChatGPTGenerator,
            WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT: browserBridgeRoot,
            WORKBENCH_CHATGPT_WEB_MODE: "live",
          }
        : process.env,
    onEvent(message) {
      const stamp = Date.now();
      if (!message || stamp - lastProgressAt < 5000) return;
      lastProgressAt = stamp;
      addEvent(
        db,
        taskId,
        "storyboard_generation_progress",
        "info",
        String(message).slice(0, 300),
      );
    },
  })
    .then(async (result) => {
      if (result.status === "completed")
        finishStoryboardGeneration(db, taskId, result);
      else {
        failStoryboardGeneration(
          db,
          taskId,
          result.user_message || result.summary || "分镜生成被安全阻断。",
          result,
        );
        await routeExceptionToProjectTask(taskId, "storyboard_generation", { result });
      }
    })
    .catch(async (error) => {
      failStoryboardGeneration(
        db,
        taskId,
        safeError(error),
        error?.external_request_started === false
          ? {
              status: "blocked",
              summary: "分镜在真实生图提交前停止。",
              user_message:
                "分镜在真实生图提交前安全停止，本次没有上传参考图、没有占用生图额度，验证机会已退还。",
              external_request_started: false,
              artifacts: [],
              requires_confirmation: true,
            }
          : null,
      );
      await routeExceptionToProjectTask(taskId, "storyboard_generation", { error });
    })
    .finally(() => activeJobs.delete(taskId));
  activeJobs.set(taskId, job);
}

async function handleApproveStoryboard(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认采用当前目标宫格分镜。" });
  try {
    const approved = approveStoryboard(db, task.id);
    if (approved.managed_mode) {
      scheduleMotionStage(task.id);
      return json(res, 202, { task: getTask(db, task.id) });
    }
    return json(res, 200, { task: approved });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleStartMotionPreflight(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认只启动动态预演，不生成真实视频。" });
  try {
    scheduleMotionStage(task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return json(res, 202, { task: getTask(db, task.id) });
}

function scheduleMotionStage(taskId) {
  if (activeJobs.has(taskId)) throw new Error("这个任务已经在执行。");
  beginMotionPreflight(db, taskId);
  const fresh = getTask(db, taskId);
  const taskDir = join(dataRoot, "tasks", taskId, "run");
  let lastProgressAt = 0;
  const job = runMotionPreflightStage({
    task: fresh,
    taskDir,
    onEvent(message) {
      const stamp = Date.now();
      if (!message || stamp - lastProgressAt < 3000) return;
      lastProgressAt = stamp;
      const visible = userVisibleProgress(message);
      addEvent(db, taskId, "motion_preflight_progress", "info", visible);
      db.prepare(
        "UPDATE tasks SET user_message = ?, updated_at = ? WHERE id = ?",
      ).run(visible, new Date().toISOString(), taskId);
    },
  })
    .then(async (result) => {
      if (result.status === "completed") {
        const finished = finishMotionPreflight(db, taskId, result);
        if (finished.managed_mode)
          setTimeout(() => {
            try {
              const { generationRouteChoice, generationModelSelection } =
                managedGenerationSelection(getTask(db, taskId));
              scheduleVideoPromptStage(taskId, {
                continueToGenerationPack: {
                  generationRouteChoice,
                  generationModelSelection,
                },
              });
            } catch (error) {
              addEvent(
                db,
                taskId,
                "managed_flow_paused",
                "warning",
                "动态预演已完成，但视频提示词没有自动启动。",
                { error: safeError(error) },
              );
            }
          }, 0);
      } else {
        failMotionPreflight(
          db,
          taskId,
          result.user_message || result.summary || "动态预演被安全阻断。",
          result,
        );
        await routeExceptionToProjectTask(taskId, "motion_preflight", { result });
      }
    })
    .catch(async (error) => {
      failMotionPreflight(db, taskId, error);
      await routeExceptionToProjectTask(taskId, "motion_preflight", { error });
    })
    .finally(() => activeJobs.delete(taskId));
  activeJobs.set(taskId, job);
}

async function handleStartVideoPrompt(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, {
      error: "请确认只编译视频提示词，不提交真实视频生成。",
    });
  try {
    if (task.remix_precision_route === "prompt_driven_remix") {
      if (
        task.rewrite_mode === "replace_product" &&
        task.product_assets_result?.approval_status !== "approved"
      ) {
        scheduleProductAssetsStage(task.id);
        return json(res, 202, { task: getTask(db, task.id) });
      }
      const generationRouteChoice = String(body.generationRouteChoice || "smoke_test_first");
      const selection = resolveVideoGenerationSelection({
        generationRouteChoice,
        generationModelKey: String(body.generationModelKey || task.generation_model_key || "star-video2"),
        generationProvider: String(body.generationProvider || task.generation_provider || "libtv"),
        qualityProfile: String(body.qualityProfile || task.generation_quality_profile || "high"),
        referenceVideoPath: task.reference_video_path,
        env: process.env,
      });
      const taskDir = join(dataRoot, "tasks", task.id, "run");
      const selectedPromptTask = {
        ...task,
        generation_route_choice: generationRouteChoice,
        generation_model_key: selection.model_key,
        generation_model_snapshot: selection,
      };
      const reusableOutputDir = mayReuseCompletedVideoPromptRetry(task)
        ? latestCompletedVideoPromptRetry(taskDir, {
            generationUnitChoice:
              generationRouteChoice === "smoke_test_first"
                ? "smoke_test"
                : "full_sequence",
            generationUnitContract:
              selection.segmented_full_sequence_required === true
                ? "segmented_full_sequence"
                : generationRouteChoice === "smoke_test_first"
                  ? "smoke_test"
                  : "full_sequence",
            assetFingerprint: generationUploadAssetFingerprint(
              generationUploadAssetsForTask(selectedPromptTask),
            ),
          })
        : null;
      const outputDir = reusableOutputDir || (task.status === STATUSES.VIDEO_PROMPT_BLOCKED
        ? join(taskDir, `video-prompt-retry-${Date.now()}`)
        : null);
      scheduleVideoPromptStage(task.id, {
        continueToGenerationPack: { generationRouteChoice, generationModelSelection: selection },
        outputDir,
      });
    } else if (
      task.status === STATUSES.VIDEO_PROMPT_BLOCKED &&
      generationPackPromptRevisionFeedback(task)
    ) {
      const generationRouteChoice = task.generation_route_choice || "smoke_test_first";
      const selection = resolveVideoGenerationSelection({
        generationRouteChoice,
        generationModelKey: task.generation_model_key || "star-video2",
        generationProvider: task.generation_provider || "libtv",
        qualityProfile: task.generation_quality_profile || "high",
        referenceVideoPath: task.reference_video_path,
        env: process.env,
      });
      const taskDir = join(dataRoot, "tasks", task.id, "run");
      scheduleVideoPromptStage(task.id, {
        continueToGenerationPack: {
          generationRouteChoice,
          generationModelSelection: selection,
        },
        outputDir: join(taskDir, `video-prompt-retry-${Date.now()}`),
      });
    } else scheduleVideoPromptStage(task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return json(res, 202, { task: getTask(db, task.id) });
}

function latestCompletedVideoPromptRetry(
  taskDir,
  { generationUnitChoice, generationUnitContract, assetFingerprint },
) {
  if (!existsSync(taskDir)) return null;
  const directories = readdirSync(taskDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("video-prompt-retry-"))
    .map((entry) => join(taskDir, entry.name))
    .sort()
    .reverse();
  for (const directory of directories) {
    const resultPath = join(directory, "video-prompt-result.json");
    if (!existsSync(resultPath)) continue;
    try {
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      const snapshotPath = join(directory, "video-prompt-task.json");
      const snapshot = existsSync(snapshotPath)
        ? JSON.parse(readFileSync(snapshotPath, "utf8"))
        : null;
      const completedForCurrentInputs = result.status === "completed" && (
        (
          result.prompt_generation_unit_choice === generationUnitChoice &&
          (result.prompt_generation_unit_contract || result.prompt_generation_unit_choice) === generationUnitContract &&
          result.prompt_generation_asset_fingerprint === assetFingerprint
        ) || (
          !result.prompt_generation_unit_choice &&
          snapshot?.generation_unit_choice === generationUnitChoice &&
          (snapshot.segmented_full_sequence_required === true
            ? "segmented_full_sequence"
            : snapshot.generation_unit_choice) === generationUnitContract &&
          snapshot.generation_upload_asset_fingerprint === assetFingerprint
        )
      );
      if (completedForCurrentInputs) return directory;
    } catch { /* keep looking */ }
  }
  return null;
}

function scheduleVideoPromptStage(
  taskId,
  { continueToGenerationPack = null, outputDir = null } = {},
) {
  if (activeJobs.has(taskId)) throw new Error("这个任务已经在执行。");
  beginVideoPrompt(db, taskId);
  const fresh = getTask(db, taskId);
  const promptTask = continueToGenerationPack
    ? {
        ...fresh,
        generation_route_choice: continueToGenerationPack.generationRouteChoice,
        generation_model_key:
          continueToGenerationPack.generationModelSelection.model_key,
        generation_model_snapshot:
          continueToGenerationPack.generationModelSelection,
      }
    : fresh;
  const taskDir = join(dataRoot, "tasks", taskId, "run");
  let lastProgressAt = 0;
  const job = runVideoPromptStage({
    task: promptTask,
    taskDir,
    ...(outputDir ? { outputDir } : {}),
    onEvent(message) {
      const stamp = Date.now();
      if (!message || stamp - lastProgressAt < 3000) return;
      lastProgressAt = stamp;
      const visible = userVisibleProgress(message);
      addEvent(db, taskId, "video_prompt_progress", "info", visible);
      db.prepare(
        "UPDATE tasks SET user_message = ?, updated_at = ? WHERE id = ?",
      ).run(visible, new Date().toISOString(), taskId);
    },
    env: process.env,
  })
    .then(async (result) => {
      if (result.status === "completed") {
        finishVideoPrompt(db, taskId, result);
        if (continueToGenerationPack)
          setTimeout(() => {
            try {
              scheduleGenerationPackStage(
                taskId,
                continueToGenerationPack.generationRouteChoice,
                continueToGenerationPack.generationModelSelection,
              );
            } catch (error) {
              failGenerationPack(db, taskId, error);
              void routeExceptionToProjectTask(taskId, "generation_pack", { error });
              addEvent(
                db,
                taskId,
                "generation_pack_resume_blocked",
                "error",
                "正式提示词已按当前 Skill 重新准备，但任务包没有自动继续。",
                { error: safeError(error), external_request: false },
              );
            }
          }, 0);
      } else {
        failVideoPrompt(
          db,
          taskId,
          result.user_message || result.summary || "视频提示词编译被安全阻断。",
          result,
        );
        await routeExceptionToProjectTask(taskId, "video_prompt", { result });
      }
    })
    .catch(async (error) => {
      failVideoPrompt(db, taskId, error);
      await routeExceptionToProjectTask(taskId, "video_prompt", { error });
    })
    .finally(() => activeJobs.delete(taskId));
  activeJobs.set(taskId, job);
}

async function handleResolveVideoPrompt(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请先确认按参考片或已提交的内容继续。" });
  try {
    const resolved = resolveVideoPromptBusinessClaims(db, task.id, {
      resolution: String(body.resolution || ""),
      text: String(body.text || ""),
    });
    syncCodexProjectContext(resolved);
    scheduleVideoPromptStage(task.id);
    return json(res, 202, { task: getTask(db, task.id) });
  } catch (error) {
    const code = String(error?.message || error);
    const message = code === "VIDEO_PROMPT_RESOLUTION_TEXT_REQUIRED"
      ? "请填写你希望替换的完整口播文案。"
      : code === "VIDEO_PROMPT_RESOLUTION_INVALID"
        ? "请选择保留原内容或使用自己的文案。"
        : code === "VIDEO_PROMPT_RESOLUTION_UNAVAILABLE"
          ? "当前任务不在内容恢复阶段，请刷新后查看最新进度。"
          : code;
    return json(res, 400, { error: message });
  }
}

async function handleStartGenerationPack(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, {
      error: "请先选择视频生成路线，并确认本步只准备任务包。",
    });
  const generationRouteChoice = String(body.generationRouteChoice || "");
  let selection;
  try {
    selection = resolveVideoGenerationSelection({
      generationRouteChoice,
      generationModelKey: String(
        body.generationModelKey || task.generation_model_key || "star-video2",
      ),
      generationProvider: String(body.generationProvider || task.generation_provider || "libtv"),
      qualityProfile: String(body.qualityProfile || task.generation_quality_profile || "high"),
      referenceVideoPath: task.reference_video_path,
      env: process.env,
    });
  } catch (error) {
    return json(res, 409, { error: generationSelectionError(error) });
  }
  return startGenerationPackJob(res, task.id, generationRouteChoice, selection);
}

async function handleStartVideoGeneration(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, {
      error: "请先确认开始生成视频；真实费用和上传仍会在发生前单独确认。",
    });
  const generationRouteChoice = String(
    body.generationRouteChoice ||
      task.generation_route_choice ||
      "smoke_test_first",
  );
  let selection;
  try {
    selection = resolveVideoGenerationSelection({
      generationRouteChoice,
      generationModelKey: String(
        body.generationModelKey || task.generation_model_key || "star-video2",
      ),
      generationProvider: String(body.generationProvider || task.generation_provider || "libtv"),
      qualityProfile: String(body.qualityProfile || task.generation_quality_profile || "high"),
      referenceVideoPath: task.reference_video_path,
      env: process.env,
    });
  } catch (error) {
    return json(res, 409, { error: generationSelectionError(error) });
  }
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  let readiness;
  try {
    readiness = prepareDirectVideoGeneration(
      db,
      task.id,
      generationRouteChoice,
      selection,
    );
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  if (!readiness.readyForPack)
    return json(res, 200, {
      task: readiness.task,
      next_action: "confirm_person_package_generation",
    });
  return startGenerationPackJob(res, task.id, generationRouteChoice, selection);
}

async function handleGeneratePersonPackage(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true || body.sourceUploadAuthorized !== true)
    return json(res, 400, {
      error:
        "请先确认本次只上传已确认人物母版和必要分镜，用于固定人物脸安全资产包。",
    });
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  try {
    beginPersonPackageGeneration(db, task.id, {
      sourceUploadAuthorized: true,
      generationProvider: String(body.generationProvider || "codex_builtin"),
    });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  const fresh = getTask(db, task.id);
  const runId = fresh.active_run_id;
  const taskDir = join(dataRoot, "tasks", task.id, "run");
  const job = runPersonPackageStage({
    task: fresh,
    taskDir,
    env: {
      ...process.env,
      WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT: browserBridgeRoot,
      WORKBENCH_PERSON_PACKAGE_WEB_ASSET_GENERATOR:
        process.env.WORKBENCH_PERSON_PACKAGE_WEB_ASSET_GENERATOR ||
        bundledPersonPackageWebAssetGenerator,
    },
    onExternalRequestStarted() {
      markTaskRunExternalRequestStarted(db, task.id);
    },
    onEvent(message) {
      if (!message) return;
      recordTaskRunProgress(db, task.id, "person_package", runId, message);
    },
  })
    .then(async (result) => {
      if (result.status === "completed")
        return finishPersonPackageGeneration(db, task.id, result, { runId });
      const failed = failPersonPackageGeneration(
            db,
            task.id,
            result.user_message || result.summary,
            result,
            { runId },
          );
      await routeExceptionToProjectTask(task.id, "person_package", { result });
      return failed;
    })
    .catch(async (error) => {
      const failed = failPersonPackageGeneration(db, task.id, error, null, { runId });
      await routeExceptionToProjectTask(task.id, "person_package", { error });
      return failed;
    })
    .finally(() => {
      if (activeJobs.get(task.id) === job) activeJobs.delete(task.id);
    });
  activeJobs.set(task.id, job);
  return json(res, 202, { task: getTask(db, task.id) });
}

async function handleApprovePersonPackage(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请先确认固定人物脸安全资产包可以采用。" });
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  try {
    approvePersonPackage(db, task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  const fresh = getTask(db, task.id);
  let selection;
  try {
    selection = resolveVideoGenerationSelection({
      generationRouteChoice:
        fresh.generation_route_choice || "smoke_test_first",
      generationModelKey: fresh.generation_model_key || "star-video2",
      generationProvider:
        fresh.generation_model_snapshot?.provider ||
        fresh.generation_provider ||
        "libtv",
      qualityProfile:
        fresh.generation_model_snapshot?.quality_profile ||
        fresh.generation_quality_profile ||
        "high",
      referenceVideoPath: fresh.reference_video_path,
      env: process.env,
    });
  } catch (error) {
    return json(res, 409, { error: generationSelectionError(error) });
  }
  return startGenerationPackJob(
    res,
    task.id,
    fresh.generation_route_choice || "smoke_test_first",
    selection,
  );
}

function startGenerationPackJob(
  res,
  taskId,
  generationRouteChoice,
  generationModelSelection,
) {
  const task = getTask(db, taskId);
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  const expectedPromptUnit =
    generationRouteChoice === "smoke_test_first"
      ? "smoke_test"
      : "full_sequence";
  const expectedPromptContract = generationModelSelection.provider === "runninghub_h3_multiref"
    && generationModelSelection.segmented_full_sequence_required === true
    ? "segmented_full_sequence"
    : expectedPromptUnit;
  const expectedAssetFingerprint = generationUploadAssetFingerprint(
    generationUploadAssetsForTask(task),
  );
  const reusePromptAfterH3Recovery =
    generationModelSelection.provider === "runninghub_h3_multiref" &&
    ["person_package_required", "person_package_failed"].includes(task.status) &&
    task.video_prompt_result?.status === "completed";
  if (
    !reusePromptAfterH3Recovery &&
    (!hasCurrentVideoPromptContract(task) ||
      task.video_prompt_result?.prompt_generation_unit_choice !==
        expectedPromptUnit ||
      (task.video_prompt_result?.prompt_generation_unit_contract || task.video_prompt_result?.prompt_generation_unit_choice) !==
        expectedPromptContract ||
      task.video_prompt_result?.prompt_generation_asset_fingerprint !==
        expectedAssetFingerprint ||
      generationPackPromptRevisionFeedback(task))
  ) {
    const taskDir = join(dataRoot, "tasks", task.id, "run");
    const outputDir = join(
      taskDir,
      "06_video_prompts_revalidation",
      `contract-refresh-${Date.now()}`,
    );
    try {
      scheduleVideoPromptStage(task.id, {
        outputDir,
        continueToGenerationPack: {
          generationRouteChoice,
          generationModelSelection,
        },
      });
      addEvent(
        db,
        task.id,
        "video_prompt_contract_refresh_started",
        "info",
        "当前正式提示词与本次生成方式不一致，正在交回提示词 Skill 重新准备；旧提示词和旧视频继续保留。",
        {
          external_request: false,
          output_dir: outputDir,
          generation_unit_choice: expectedPromptUnit,
        },
      );
    } catch (error) {
      return json(res, 409, { error: safeError(error) });
    }
    return json(res, 202, { task: getTask(db, task.id) });
  }
  try {
    scheduleGenerationPackStage(
      task.id,
      generationRouteChoice,
      generationModelSelection,
    );
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return json(res, 202, { task: getTask(db, task.id) });
}

function scheduleGenerationPackStage(
  taskId,
  generationRouteChoice,
  generationModelSelection,
) {
  const task = getTask(db, taskId);
  if (activeJobs.has(task.id)) throw new Error("这个任务已经在执行。");
  beginGenerationPack(
    db,
    task.id,
    generationRouteChoice,
    generationModelSelection,
  );
  const fresh = getTask(db, task.id);
  const taskDir = join(dataRoot, "tasks", task.id, "run");
  const outputDir =
    fresh.full_video_quality_revalidation_authorized ||
    fresh.contract_repair_full_video_authorized
      ? join(
          taskDir,
          "07_generation_pack_revalidation",
          `contract-refresh-${Date.now()}`,
        )
      : taskDir;
  let lastProgressAt = 0;
  const job = runGenerationPackStage({
    task: fresh,
    taskDir,
    outputDir,
    env: process.env,
    onEvent(message) {
      const stamp = Date.now();
      if (!message || stamp - lastProgressAt < 3000) return;
      lastProgressAt = stamp;
      const visible = userVisibleProgress(message);
      addEvent(db, task.id, "generation_pack_progress", "info", visible);
      db.prepare(
        "UPDATE tasks SET user_message = ?, updated_at = ? WHERE id = ?",
      ).run(visible, new Date().toISOString(), task.id);
    },
  })
    .then(async (result) => {
      if (result.status === "completed")
        finishGenerationPack(db, task.id, result);
      else {
        failGenerationPack(
          db,
          task.id,
          result.user_message || result.summary || "视频任务包预检被安全阻断。",
          result,
        );
        await routeExceptionToProjectTask(task.id, "generation_pack", { result });
      }
    })
    .catch(async (error) => {
      failGenerationPack(db, task.id, error);
      await routeExceptionToProjectTask(task.id, "generation_pack", { error });
    })
    .finally(() => activeJobs.delete(task.id));
  activeJobs.set(task.id, job);
  return getTask(db, task.id);
}

function hasCurrentVideoPromptContract(task) {
  const receipt = task.video_prompt_result?.skill_contract;
  const receiptPath = task.video_prompt_result?.skill_contract_receipt_path;
  if (
    receipt?.owner_skill !== "aigc-video-prompt-codex" ||
    !receiptPath ||
    !existsSync(receiptPath)
  )
    return false;
  try {
    const current = resolveSkillContract("video_prompt", { env: process.env });
    return (
      receipt.bridge_version === current.bridge_version &&
      receipt.source_sha256 === current.source_sha256
    );
  } catch {
    return false;
  }
}

async function handleGenerateVideo(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, {
      error: "点击生成前需要确认当前通道、模型、清晰度和实际上传素材。",
    });
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  let started;
  try {
    started =
      body.resumeExisting === true
        ? resumeVideoGenerationResult(db, task.id)
        : beginVideoGeneration(db, task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  const runId = started.active_run_id;
  const taskDir = join(dataRoot, "tasks", task.id, "run");
  const provider = started.generation_model_snapshot?.provider || started.generation_provider || "libtv";
  const executeVideo = provider === "runninghub_h3_multiref"
    ? runRunningHubH3VideoGeneration
    : runLibTVVideoGeneration;
  const job = executeVideo({
    task: started,
    taskDir,
    env: process.env,
    onExternalRequestStarted() {
      markVideoGenerationExternalRequestStarted(db, task.id, runId);
    },
    onEvent(message) {
      recordTaskRunProgress(db, task.id, "video_generation", runId, message);
    },
  })
    .then((result) => finishVideoGeneration(db, task.id, result, { runId }))
    .catch(async (error) => {
      failVideoGeneration(
        db,
        task.id,
        error,
        {
          ...(typeof error?.external_request_started === "boolean"
            ? { external_request_started: error.external_request_started }
            : {}),
          artifacts: [],
        },
        { runId },
      );
      await routeExceptionToProjectTask(task.id, "video_generation", { error });
    })
    .finally(() => {
      if (activeJobs.get(task.id) === job) activeJobs.delete(task.id);
    });
  activeJobs.set(task.id, job);
  return json(res, 202, { task: getTask(db, task.id) });
}

async function handleApproveVideoResult(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "请确认采用当前完整视频版本。" });
  try {
    return json(res, 200, { task: approveVideoResult(db, task.id) });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleRevalidateVideoQuality(req, res, task) {
  const body = await readJson(req);
  if (
    body.confirmed !== true ||
    body.preserveExistingResult !== true ||
    body.singleSubmissionOnly !== true
  ) {
    return json(res, 400, {
      error: "请确认保留旧结果，并且只额外提交一次 4 秒质量复验。",
    });
  }
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  let selection;
  try {
    selection = resolveVideoGenerationSelection({
      generationRouteChoice: "smoke_test_first",
      generationModelKey: "star-video2-fast",
      referenceVideoPath: task.reference_video_path,
      env: process.env,
    });
    authorizeVideoQualityRevalidation(db, task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return startGenerationPackJob(res, task.id, "smoke_test_first", selection);
}

async function handleRevalidateFullVideoQuality(req, res, task) {
  const body = await readJson(req);
  if (
    body.confirmed !== true ||
    body.preserveExistingResult !== true ||
    body.singleSubmissionOnly !== true ||
    body.rebuildWithCurrentContract !== true
  ) {
    return json(res, 400, {
      error: "请确认保留旧完整版，并且只按新版合同额外开放一次正式版复验。",
    });
  }
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  let selection;
  try {
    selection = resolveExistingVideoGenerationSelection(task, {
      env: process.env,
    });
    authorizeFullVideoQualityRevalidation(db, task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return startGenerationPackJob(
    res,
    task.id,
    "in_chat_libtv_generation",
    selection,
  );
}

async function handlePrepareVideoRework(req, res, task) {
  const body = await readJson(req);
  const preview = task.generation_pack_result?.submission_preview || {};
  const segmentDurations = Array.isArray(preview.segment_durations_seconds)
    ? preview.segment_durations_seconds.map((value) => Number(value))
    : [Number(preview.duration_seconds || task.video_generation_result?.duration_seconds || 0)];
  const allSegmentIds = segmentDurations.map(
    (_, index) => `segment_${String(index + 1).padStart(2, "0")}`,
  );
  const selectedSegmentIds = Array.isArray(body.selectedSegmentIds)
    ? [...new Set(body.selectedSegmentIds.map((value) => String(value)))]
    : [];
  if (
    !selectedSegmentIds.length ||
    selectedSegmentIds.some((segmentId) => !allSegmentIds.includes(segmentId))
  )
    return json(res, 400, { error: "请选择实际需要调整的片段。" });
  const allowedIssueCodes = new Set([
    "missing_or_wrong_shot",
    "person_or_outfit",
    "motion_or_expression",
    "composition_or_clarity",
    "random_retry",
    "other",
  ]);
  const issueCodes = Array.isArray(body.issueCodes)
    ? [...new Set(body.issueCodes.map((value) => String(value)))].filter((value) =>
        allowedIssueCodes.has(value),
      )
    : [];
  const note = cleanText(body.note, 800);
  if (!issueCodes.length && !note)
    return json(res, 400, { error: "请至少说明一项不满意的地方。" });
  const preservedSegmentIds = allSegmentIds.filter(
    (segmentId) => !selectedSegmentIds.includes(segmentId),
  );
  const provider =
    task.generation_model_snapshot?.provider ||
    task.generation_provider ||
    task.video_generation_result?.provider ||
    "libtv";
  const estimatedSubmissionCount =
    provider === "runninghub_h3_multiref" ? selectedSegmentIds.length : 1;
  try {
    const fresh = prepareVideoReworkRequest(db, task.id, {
      selected_segment_ids: selectedSegmentIds,
      preserved_segment_ids: preservedSegmentIds,
      issue_codes: issueCodes,
      note,
      provider,
      model_key:
        task.generation_model_key || task.video_generation_result?.model_key,
      quality_profile:
        task.generation_model_snapshot?.quality_profile ||
        task.generation_quality_profile ||
        "high",
      estimated_submission_count: estimatedSubmissionCount,
      resolution_mode:
        issueCodes.length === 1 && issueCodes[0] === "random_retry"
          ? "direct_retry"
          : "analyze_then_retry",
    });
    if (issueCodes.length === 1 && issueCodes[0] === "random_retry") {
      const plan = prepareDirectRetryPlan({
        task: fresh,
        taskDir: join(dataRoot, "tasks", task.id, "run"),
        selectedSegmentIds,
      });
      const ready = saveVideoReworkPlan(db, task.id, plan);
      syncCodexProjectContext(ready);
      return json(res, 200, { task: ready });
    }
    syncCodexProjectContext(fresh);
    return json(res, 200, { task: fresh });
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
}

async function handleConfirmVideoRework(req, res, task) {
  const body = await readJson(req);
  syncVideoReworkPlan(task);
  const fresh = getTask(db, task.id);
  const plan = fresh.video_rework_plan;
  if (
    body.confirmed !== true ||
    (body.preserveAllVersions !== true && body.preserveVersion1 !== true) ||
    body.replaceSelectedOnly !== true ||
    body.automaticRetry !== false
  )
    return json(res, 400, {
      error: "请确认只重新生成选中片段、保留全部旧版本、生成新的合成版本，并且不自动重试。",
    });
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个项目已有任务正在执行。" });
  if (
    plan?.status !== "ready_for_confirmation" ||
    plan.provider !== "runninghub_h3_multiref" ||
    plan.external_request_started !== false
  )
    return json(res, 409, { error: "返工方案尚未完成免费预检，当前不能提交。" });
  if (
    JSON.stringify(body.selectedSegmentIds || []) !==
    JSON.stringify(plan.selected_segment_ids || [])
  )
    return json(res, 409, { error: "页面选择与返工方案不一致，请刷新后重新确认。" });
  let started;
  try {
    started = beginVideoReworkGeneration(db, task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  const runId = started.active_run_id;
  const taskDir = join(dataRoot, "tasks", task.id, "run");
  const job = runRunningHubH3VideoRework({
    task: started,
    taskDir,
    env: process.env,
    onExternalRequestStarted() {
      markVideoReworkExternalRequestStarted(db, task.id, runId);
    },
    onEvent(message) {
      recordTaskRunProgress(db, task.id, "video_rework_generation", runId, message);
    },
  })
    .then((result) => finishVideoReworkGeneration(db, task.id, result, { runId }))
    .catch(async (error) => {
      const failed = failVideoReworkGeneration(db, task.id, error, { runId });
      await routeExceptionToProjectTask(task.id, "video_rework_generation", { error });
      return failed;
    })
    .finally(() => {
      if (activeJobs.get(task.id) === job) activeJobs.delete(task.id);
    });
  activeJobs.set(task.id, job);
  return json(res, 202, { task: getTask(db, task.id) });
}

async function handleContractRepairFullVideoValidation(req, res, task) {
  const body = await readJson(req);
  if (
    body.confirmed !== true ||
    body.preserveExistingResult !== true ||
    body.singleSubmissionOnly !== true ||
    body.rebuildWithCurrentContract !== true ||
    body.contractRepairValidation !== true
  ) {
    return json(res, 400, {
      error: "请确认保留旧结果，并且只执行一次三方合同修复后的完整版验证。",
    });
  }
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  let selection;
  try {
    selection = resolveExistingVideoGenerationSelection(task, {
      env: process.env,
    });
    const isUnconsumedContractRecovery =
      task.contract_repair_full_video_authorized === true &&
      task.status === STATUSES.VIDEO_PROMPT_BLOCKED &&
      /VIDEO_PROMPT_VISIBLE_SAFETY_MARKS_NOT_COMPILED/.test(
        task.last_error || "",
      );
    if (!isUnconsumedContractRecovery)
      authorizeContractRepairFullVideoValidation(db, task.id);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return startGenerationPackJob(
    res,
    task.id,
    "in_chat_libtv_generation",
    selection,
  );
}

async function handlePrepareFullVideo(req, res, task) {
  const body = await readJson(req);
  if (
    body.confirmed !== true ||
    body.preserveExistingSamples !== true ||
    body.singleSubmissionOnly !== true
  ) {
    return json(res, 400, {
      error: "请确认保留现有小样，并且只提交一次完整版生成。",
    });
  }
  if (activeJobs.has(task.id))
    return json(res, 409, { error: "这个任务已经在执行。" });
  let selection;
  try {
    selection = resolveExistingVideoGenerationSelection(task, {
      env: process.env,
    });
    if (!(
      task.full_video_generation_authorized === true &&
      task.status === STATUSES.GENERATION_PACK_READY
    ))
      authorizeFullVideoGeneration(db, task.id);
  } catch (error) {
    return json(res, 409, { error: generationSelectionError(error) });
  }
  return startGenerationPackJob(
    res,
    task.id,
    "in_chat_libtv_generation",
    selection,
  );
}

function generationSelectionError(error) {
  const message = String(error instanceof Error ? error.message : error);
  if (message.startsWith("GENERATION_MODEL_DURATION_UNSUPPORTED:")) {
    const [, requested, maximum] = message.split(":");
    return `当前正式版需要生成 ${requested} 秒，这个模型最多支持 ${maximum} 秒。请选择 Seedance 2.5，或改为先做 4 秒验证。`;
  }
  if (message === "GENERATION_MODEL_UNAVAILABLE")
    return "当前 LibTV 列表里没有这个模型，请刷新后重新选择。";
  if (message.startsWith("GENERATION_MODEL_RESOLUTION_UNSUPPORTED:"))
    return `这个模型不支持所选清晰度（${message.split(":")[1]}），请换一个清晰度或模型。`;
  if (message === "GENERATION_MODEL_VERTICAL_UNSUPPORTED")
    return "这个模型不支持当前 9:16 竖屏规格，请选择其他模型。";
  if (message === "GENERATION_PROVIDER_INVALID" || message === "GENERATION_QUALITY_INVALID")
    return "当前生成通道或清晰度选择无效，请重新选择。";
  return "暂时无法核对当前生成通道能力；请检查对应通道是否已配置并稍后重试。";
}

function servePersonImage(res, task) {
  const artifact = currentPersonImageArtifact(task);
  if (!artifact?.path || !existsSync(artifact.path))
    return json(res, 404, { error: "当前人物候选图不可用。" });
  const extension = extname(artifact.path).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  if (!contentTypes[extension])
    return json(res, 415, { error: "当前人物候选格式不受支持。" });
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypes[extension]);
  res.setHeader("Cache-Control", "no-store");
  createReadStream(artifact.path).pipe(res);
}

function serveStoryboardImage(res, task) {
  const artifact = currentStoryboardImageArtifact(task);
  if (!artifact?.path || !existsSync(artifact.path))
    return json(res, 404, { error: "当前目标宫格分镜不可用。" });
  const extension = extname(artifact.path).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  if (!contentTypes[extension])
    return json(res, 415, { error: "当前分镜图片格式不受支持。" });
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypes[extension]);
  res.setHeader("Cache-Control", "no-store");
  createReadStream(artifact.path).pipe(res);
}

function serveStageImage(res, task, stage, missingMessage) {
  const artifact = task.artifacts.find(
    (item) =>
      item.stage === stage && /\.(png|jpe?g|webp)$/i.test(item.path || ""),
  );
  if (!artifact?.path || !existsSync(artifact.path))
    return json(res, 404, { error: missingMessage });
  return streamRegisteredArtifact(res, artifact.path);
}

function serveArtifact(req, res, taskId, artifactId) {
  if (artifactId >= CODEX_ARTIFACT_ID_BASE) {
    const task = getTask(db, taskId);
    const bridgeTaskRoot = task ? join(dataRoot, "tasks", task.id) : null;
    const taskRoot = task ? managedExecutionRoot(task, bridgeTaskRoot) : null;
    const artifact = task
      ? [
          ...codexProgressArtifacts(task),
          ...runtimeGenerationArtifacts(
            task,
            readRuntimeGenerationStatus(taskRoot),
          ),
        ].find((item) => item.id === artifactId)
      : null;
    if (!artifact)
      return json(res, 404, { error: "这个项目任务成果当前不可用。" });
    return streamRegisteredArtifact(res, artifact.path, req);
  }
  const artifact = getArtifact(db, taskId, artifactId);
  if (!artifact?.path || !existsSync(artifact.path))
    return json(res, 404, { error: "这个成果文件当前不可用。" });
  return streamRegisteredArtifact(res, artifact.path, req);
}

function streamRegisteredArtifact(res, path, req = null) {
  const extension = extname(path).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".md": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
  };
  if (!contentTypes[extension])
    return json(res, 415, { error: "当前成果格式暂不支持在线预览。" });
  const originalName = basename(path).replace(/["\r\n]/g, "_");
  const asciiName = originalName.replace(/[^\x20-\x7e]/g, "_");
  const encodedName = encodeURIComponent(originalName).replace(
    /['()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const size = statSync(path).size;
  const range = req?.headers?.range;
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (!match) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.end();
    }
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  } else {
    res.statusCode = 200;
  }
  res.setHeader("Content-Type", contentTypes[extension]);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", String(end - start + 1));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
  );
  res.setHeader("Cache-Control", "no-store");
  if (req?.method === "HEAD") return res.end();
  createReadStream(path, { start, end }).pipe(res);
}

function currentPersonImageArtifact(task) {
  return (
    (task.person_generation_result?.artifacts || []).find((item) =>
      /\.(png|jpe?g|webp)$/i.test(item.path || ""),
    ) || null
  );
}

function currentStoryboardImageArtifact(task) {
  return (
    (task.storyboard_generation_result?.artifacts || []).find((item) =>
      /\.(png|jpe?g|webp)$/i.test(item.path || ""),
    ) || null
  );
}

function publishApprovedPerson(task) {
  const image = currentPersonImageArtifact(task);
  const receiptArtifact = resolvePersonExecutionReceipt(task, image?.path);
  if (!image?.path || !existsSync(image.path))
    throw new Error("PERSON_IMAGE_MISSING");
  if (!receiptArtifact?.path || !existsSync(receiptArtifact.path))
    throw new Error("PERSON_EXECUTION_RECEIPT_MISSING");
  const receipt = JSON.parse(readFileSync(receiptArtifact.path, "utf8"));
  const route = resolvePersonArtifactRoute(image.path, receipt);
  if (!route?.artifact_tool || !route?.workspace_root)
    throw new Error("PERSON_ARTIFACT_ROUTE_MISSING");
  if (route.task_id !== task.id)
    throw new Error("PERSON_ARTIFACT_ROUTE_MISSING");
  const formalCandidatePath = ensureFormalPersonCandidate(
    route,
    image.path,
    receipt,
  );
  if (!receipt.raw_generation_path || !existsSync(receipt.raw_generation_path))
    throw new Error("PERSON_LINKED_ORIGIN_MISSING");
  const args = [
    route.artifact_tool,
    "publish",
    "--workbench",
    route.workspace_root,
    "--source",
    formalCandidatePath,
    "--task-id",
    task.id,
    "--project-name",
    task.title,
    "--category",
    "image",
    "--origin-step",
    "ai-video-person-assets",
    "--qc-status",
    "approved",
    "--display-name",
    `${task.title}_AI人物母版.png`,
    "--publication-mode",
    "promote",
  ];
  args.push(
    ...linkedOriginPublishArgs(formalCandidatePath, receipt.raw_generation_path),
  );
  const output = execFileSync("python3", args, { encoding: "utf8" });
  const result = JSON.parse(output);
  const publishedPath = result.published_path || result.final_path;
  if (!publishedPath || !existsSync(publishedPath))
    throw new Error("PERSON_ARTIFACT_PUBLISH_FAILED");
  return { label: "AI 人物母版", path: publishedPath, published: true };
}

async function handleResume(req, res, task) {
  const body = await readJson(req);
  if (body.confirmed !== true)
    return json(res, 400, { error: "中断任务不会自动恢复，请确认后继续。" });
  if (
    ![
      STATUSES.INTERRUPTED,
      STATUSES.FAILED,
      STATUSES.BLOCKED_CONFIGURATION,
      STATUSES.BLOCKED_RUNTIME,
    ].includes(task.status)
  )
    return json(res, 409, { error: "当前任务不需要恢复。" });
  if (task.current_step === "person_generation") {
    return json(res, 409, {
      error: "人物生成不会自动恢复，请在人物页面重新确认上传范围后再试一次。",
    });
  }
  const stage = task.current_step === "rewrite" ? "rewrite" : "decomposition";
  return launch(res, task.id, stage);
}

function launch(res, taskId, stage) {
  try {
    scheduleCodexStage(taskId, stage);
  } catch (error) {
    return json(res, 409, { error: safeError(error) });
  }
  return json(res, 202, { task: getTask(db, taskId) });
}

function scheduleCodexStage(taskId, stage) {
  if (activeJobs.has(taskId)) throw new Error("这个任务已经在执行。");
  beginStage(db, taskId, stage);
  const fresh = getTask(db, taskId);
  const taskDir = join(dataRoot, "tasks", taskId, "run");
  let lastProgressAt = 0;
  const job = Promise.resolve()
    .then(() =>
      runCodexStage({
        task: fresh,
        stage,
        taskDir,
        onEvent(message) {
          const stamp = Date.now();
          if (stamp - lastProgressAt < 5000) return;
          lastProgressAt = stamp;
          addEvent(db, taskId, "codex_progress", "info", message);
        },
      }),
    )
    .then(async (result) => {
      if (result.status === "completed") {
        finishStage(db, taskId, stage, result);
        setTimeout(() => continueManagedFlow(taskId, stage), 0);
      } else if (result.status === "needs_user_input")
        pauseStage(db, taskId, stage, result);
      else {
        blockStage(db, taskId, stage, result);
        await routeExceptionToProjectTask(taskId, stage, { result });
      }
    })
    .catch(async (error) => {
      if (
        [
          "CREDENTIAL_UNAVAILABLE",
          "ARK_NETWORK_UNAVAILABLE",
          "ARK_PROVIDER_BRIDGE_FAILED",
        ].includes(error?.code)
      ) {
        const networkBlocked = error.code === "ARK_NETWORK_UNAVAILABLE";
        const providerBlocked = error.code === "ARK_PROVIDER_BRIDGE_FAILED";
        const current = getTask(db, taskId);
        blockStage(db, taskId, stage, {
          status: "blocked",
          summary: networkBlocked
            ? "火山方舟连通性预检未通过，未启动 Codex 或豆包处理。"
            : providerBlocked
              ? "豆包受限适配器未能取得成功回执，任务已暂停且未启动 Codex。"
              : "安全凭证未能加载，未启动 Codex 或外部请求。",
          estimated_cost_cny: 0,
          artifacts: current?.artifacts || [],
          requires_confirmation: true,
          user_message: networkBlocked
            ? "当前任务环境暂时无法连接火山方舟。请恢复网络后重新预检；本地证据无需重做。"
            : providerBlocked
              ? "豆包请求没有形成可复用的成功回执。现有本地证据已保留，请查看任务说明后再继续；不会改用 Gemini 整片重拆。"
              : "任务中心暂时无法从 macOS 钥匙串加载火山方舟凭证，请完成凭证桥诊断后再继续。",
        });
      } else if (
        error?.code === "CODEX_RUNTIME_UNAVAILABLE" &&
        error?.business_started === false
      ) {
        blockRuntimeStage(db, taskId, stage, error);
      } else failStage(db, taskId, stage, error);
      await routeExceptionToProjectTask(taskId, stage, { error });
    })
    .finally(() => activeJobs.delete(taskId));
  activeJobs.set(taskId, job);
}

function continueManagedFlow(taskId, completedStage) {
  const task = getTask(db, taskId);
  if (!task?.managed_mode || activeJobs.has(taskId)) return;
  try {
    if (completedStage === "decomposition") {
      const scriptRoute = task.remix_change_contract?.script?.mode || "keep_structure";
      const needsContentRewrite = [
        "auto_rewrite",
        "partial_adjustment",
        "use_own_copy",
      ].includes(scriptRoute);
      if (task.rewrite_mode === "keep_original_style" && !needsContentRewrite) {
        completeWithoutRewrite(db, taskId);
        prepareManagedPerson(taskId);
      } else {
        updateProductInputs(
          db,
          taskId,
          task.product_brief,
          task.product_image_paths,
          task.rewrite_mode,
          task.product_scope,
        );
        scheduleCodexStage(taskId, "rewrite");
      }
    } else if (completedStage === "rewrite") {
      prepareManagedPerson(taskId);
    }
  } catch (error) {
    addEvent(
      db,
      taskId,
      "managed_flow_paused",
      "warning",
      "托管流程在安全闸门前暂停，现有成果已保留。",
      { completed_stage: completedStage, error: safeError(error) },
    );
  }
}

function prepareManagedPerson(taskId) {
  const task = getTask(db, taskId);
  preparePersonInputs(db, taskId, {
    personRoute: task.person_route,
    personBrief: task.person_brief,
    authorizationConfirmed: task.person_authorization_confirmed,
  });
  const prepared = getTask(db, taskId);
  if (prepared.person_route === "authorized_person" && prepared.person_source_image_paths?.length === 1) {
    registerAuthorizedPersonSource(db, taskId, prepared.person_source_image_paths);
    continueAfterApprovedPerson(taskId);
  }
  else if (task.person_route === "auto_ai_person" && task.setup_upload_authorized)
    schedulePersonStage(taskId, task.default_image_generation_provider);
  else if (
    task.person_route === "generic_no_fixed_face" &&
    task.remix_precision_route === "prompt_driven_remix"
  ) continueAfterApprovedPerson(taskId);
}

function continueAfterApprovedPerson(taskId) {
  const task = getTask(db, taskId);
  if (!task?.managed_mode) return;
  if (task.remix_precision_route === "anchor_frame_alignment") {
    if (!task.setup_upload_authorized) throw new Error("STORYBOARD_UPLOAD_AUTHORIZATION_REQUIRED");
    prepareStoryboardInputs(db, taskId, {
      storyboardMode: "anchor_storyboard",
      storyboardBrief: "",
    });
    scheduleStoryboardStage(
      taskId,
      task.default_image_generation_provider,
      task.default_image_generation_provider === "chatgpt_web",
    );
    return;
  }
  if (
    task.rewrite_mode === "replace_product" &&
    task.product_assets_result?.approval_status !== "approved"
  ) {
    scheduleProductAssetsStage(taskId);
    return;
  }
  const { generationRouteChoice, generationModelSelection } =
    managedGenerationSelection(task);
  scheduleVideoPromptStage(taskId, {
    continueToGenerationPack: {
      generationRouteChoice,
      generationModelSelection,
    },
  });
}

function managedGenerationSelection(task) {
  const generationRouteChoice = task.generation_route_choice || "smoke_test_first";
  const generationProvider = task.generation_provider || "libtv";
  const generationModelKey = task.generation_model_key ||
    (generationProvider === "runninghub_h3_multiref"
      ? "minimax-h3-multiref-owned-clean"
      : "star-video2-fast");
  return {
    generationRouteChoice,
    generationModelSelection: resolveVideoGenerationSelection({
      generationRouteChoice,
      generationModelKey,
      generationProvider,
      qualityProfile: task.generation_quality_profile || "high",
      referenceVideoPath: task.reference_video_path,
      env: process.env,
    }),
  };
}

function schedulePersonStage(taskId, generationProvider) {
  if (activeJobs.has(taskId)) throw new Error("这个任务已经在执行。");
  if (generationProvider === "chatgpt_web") {
    const bridge = inspectChatGPTBridge(browserBridgeRoot);
    if (!bridge.available) throw new Error(bridge.user_message);
  }
  beginPersonGeneration(db, taskId, {
    sourceUploadAuthorized: true,
    generationProvider,
  });
  const fresh = getTask(db, taskId);
  const taskDir = join(dataRoot, "tasks", taskId, "run");
  let lastProgressAt = 0;
  const job = runPersonStage({
    task: fresh,
    taskDir,
    env:
      generationProvider === "chatgpt_web" &&
      !process.env.WORKBENCH_CHATGPT_WEB_GENERATOR
        ? {
            ...process.env,
            WORKBENCH_CHATGPT_WEB_GENERATOR: bundledChatGPTGenerator,
            WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT: browserBridgeRoot,
            WORKBENCH_CHATGPT_WEB_MODE: "live",
          }
        : process.env,
    onEvent(message) {
      const stamp = Date.now();
      if (!message || stamp - lastProgressAt < 5000) return;
      lastProgressAt = stamp;
      addEvent(
        db,
        taskId,
        "person_generation_progress",
        "info",
        String(message).slice(0, 300),
      );
    },
  })
    .then(async (result) => {
      if (result.status === "completed")
        finishPersonGeneration(db, taskId, result);
      else {
        failPersonGeneration(
          db,
          taskId,
          result.user_message || result.summary || "人物生成被安全阻断。",
        );
        await routeExceptionToProjectTask(taskId, "person_generation", { result });
      }
    })
    .catch(async (error) => {
      failPersonGeneration(db, taskId, error);
      await routeExceptionToProjectTask(taskId, "person_generation", { error });
    })
    .finally(() => activeJobs.delete(taskId));
  activeJobs.set(taskId, job);
}

function scheduleModelAssetGeneration(projectId, references, generationProvider) {
  if (activeModelAssetJobs.has(projectId))
    throw new Error("当前模特项目已经在生成，请等待结果返回。");
  const project = getInternalModelAssetProject(modelAssetsRoot, projectId);
  if (!project?.active_attempt) throw new Error("MODEL_ASSET_ATTEMPT_MISSING");
  const projectDir = join(modelAssetsRoot, projectId);
  const env =
    generationProvider === "chatgpt_web" &&
    !process.env.WORKBENCH_CHATGPT_WEB_GENERATOR
      ? {
          ...process.env,
          WORKBENCH_CHATGPT_WEB_GENERATOR: bundledChatGPTGenerator,
          WORKBENCH_CHATGPT_WEB_BRIDGE_ROOT: browserBridgeRoot,
          WORKBENCH_CHATGPT_WEB_MODE: "live",
        }
      : process.env;
  const job = runModelAssetGeneration({
    project,
    references,
    projectDir,
    env,
    onEvent(message) {
      recordModelAssetGenerationProgress(modelAssetsRoot, projectId, message);
    },
  })
    .then((rawResult) => {
      const result = reconcileBlockedModelAssetResult(project, rawResult, env);
      if (result.status !== "completed") {
        const error = new Error(
          result.user_message || result.summary || "模特候选生成被安全阻断。",
        );
        error.external_request_started = result.external_request_started === true;
        throw error;
      }
      finishModelAssetGeneration(modelAssetsRoot, projectId, result);
    })
    .catch((error) => {
      failModelAssetGeneration(
        modelAssetsRoot,
        projectId,
        error,
        error?.external_request_started === true,
      );
    })
    .finally(() => activeModelAssetJobs.delete(projectId));
  activeModelAssetJobs.set(projectId, job);
}

function scheduleModelStyleAnalysis(projectId, benchmark) {
  if (activeModelStyleJobs.has(projectId))
    throw new Error("当前模特项目已经在分析对标图，请等待结果返回。");
  const project = getInternalModelAssetProject(modelAssetsRoot, projectId);
  if (!project?.talking_style_analysis)
    throw new Error("MODEL_STYLE_ANALYSIS_MISSING");
  const projectDir = join(modelAssetsRoot, projectId);
  const job = runModelStyleAnalysis({
    project,
    benchmark,
    projectDir,
    env: process.env,
  })
    .then((result) => finishModelStyleAnalysis(modelAssetsRoot, projectId, result))
    .catch((error) => failModelStyleAnalysis(modelAssetsRoot, projectId, error))
    .finally(() => activeModelStyleJobs.delete(projectId));
  activeModelStyleJobs.set(projectId, job);
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Workbench-Bridge-Client, X-Workbench-Test-Run",
  );
  res.setHeader("Vary", "Origin");
}

async function handleBrowserBridge(req, res, url) {
  if (req.headers["x-workbench-bridge-client"] !== BRIDGE_CLIENT)
    return json(res, 403, { error: "浏览器伴侣身份不匹配。" });
  if (req.method === "POST" && url.pathname === "/browser-bridge/heartbeat") {
    return json(res, 200, {
      heartbeat: recordHeartbeat(browserBridgeRoot, await readJson(req)),
    });
  }
  if (req.method === "GET" && url.pathname === "/browser-bridge/jobs/next") {
    const job = nextBrowserJob(browserBridgeRoot);
    return json(res, 200, { job: publicBrowserJob(job) });
  }
  if (
    req.method === "GET" &&
    url.pathname === "/browser-bridge/jobs/resumable"
  ) {
    return json(res, 200, {
      job: publicBrowserJob(resumableBrowserJob(browserBridgeRoot)),
    });
  }
  if (
    req.method === "GET" &&
    url.pathname === "/browser-bridge/jobs/manual-pending"
  ) {
    return json(res, 200, {
      job: publicBrowserJob(manualPendingBrowserJob(browserBridgeRoot)),
    });
  }
  const match = url.pathname.match(
    /^\/browser-bridge\/jobs\/([a-f0-9-]{36})(?:\/(status|manual-submission|result|assets\/(\d+)))?$/,
  );
  if (!match) return json(res, 404, { error: "没有这个浏览器伴侣入口。" });
  const [, jobId, action, assetIndex] = match;
  if (req.method === "GET" && !action)
    return json(res, 200, {
      job: publicBrowserJob(getBrowserJob(browserBridgeRoot, jobId)),
    });
  if (req.method === "GET" && action?.startsWith("assets/")) {
    const asset = browserJobAsset(browserBridgeRoot, jobId, assetIndex);
    if (!asset) return json(res, 404, { error: "参考图不可用。" });
    const contentTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    };
    res.statusCode = 200;
    res.setHeader(
      "Content-Type",
      contentTypes[extname(asset.path).toLowerCase()] ||
        "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${basename(asset.name).replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
    );
    return createReadStream(asset.path).pipe(res);
  }
  if (req.method === "POST" && action === "status") {
    const body = await readJson(req);
    const job = updateBrowserJob(browserBridgeRoot, jobId, body);
    if (
      ["submitting", "submitted", "waiting_result", "completed"].includes(
        job.state,
      )
    )
      markTaskRunExternalRequestStarted(db, job.task_id);
    return json(res, 200, { job: publicBrowserJob(job) });
  }
  if (req.method === "POST" && action === "manual-submission") {
    const body = await readJson(req);
    return json(res, 200, {
      job: publicBrowserJob(
        confirmManualBrowserSubmission(browserBridgeRoot, jobId, {
          submissionMarker: body.submission_marker,
          browserTabId: body.browser_tab_id,
          conversationUrl: body.conversation_url,
        }),
      ),
    });
  }
  if (req.method === "POST" && action === "result") {
    const length = Number(req.headers["content-length"] || 0);
    if (length > MAX_BRIDGE_IMAGE_BYTES)
      return json(res, 413, { error: "回传图片必须小于 30MB。" });
    const contentType = String(req.headers["content-type"] || "").split(";")[0];
    const extensions = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
    };
    if (!extensions[contentType])
      return json(res, 415, { error: "回传结果只支持 PNG、JPEG 或 WebP。" });
    const buffer = Buffer.from(await requestFromNode(req).arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_BRIDGE_IMAGE_BYTES)
      return json(res, 413, { error: "回传图片必须小于 30MB。" });
    return json(res, 200, {
      job: publicBrowserJob(
        await completeBrowserJob(
          browserBridgeRoot,
          jobId,
          buffer,
          extensions[contentType],
        ),
      ),
    });
  }
  return json(res, 405, { error: "当前浏览器伴侣操作不支持。" });
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

function end(res, status) {
  res.statusCode = status;
  res.end();
}

function requestFromNode(req) {
  return new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half",
  });
}

async function readJson(req) {
  try {
    return await requestFromNode(req).json();
  } catch {
    return {};
  }
}

function enforceUploadLimit(req) {
  const length = Number(req.headers["content-length"] || 0);
  if (length > MAX_UPLOAD_BYTES)
    throw new Error(
      "单次上传不能超过 250MB。请先压缩参考视频，或后续使用大文件流式入口。",
    );
}

async function saveFiles(files, directory, prefix) {
  const paths = [];
  let index = 0;
  for (const file of files) {
    if (!(file instanceof File) || file.size === 0) continue;
    if (
      !file.type.startsWith("image/") &&
      !/\.(png|jpe?g|webp|heic)$/i.test(file.name)
    )
      throw new Error("产品素材只支持常见图片格式。");
    index += 1;
    const path = join(
      directory,
      `${prefix}-${index}${safeExtension(file.name, ".jpg")}`,
    );
    writeFileSync(path, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
    paths.push(path);
  }
  return paths;
}

function safeExtension(name, fallback) {
  const ext = extname(basename(name)).toLowerCase();
  return /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : fallback;
}

function looksLikeVideo(file) {
  return (
    file.type.startsWith("video/") ||
    /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name)
  );
}

function cleanText(value, limit) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, limit);
}

function extractSupportedSocialUrl(value) {
  const candidates =
    String(value || "").match(
      /https?:\/\/[^\s<>"'，。！？、；：）】》」』’”\])}]+/gi,
    ) || [];
  return (
    candidates
      .map((candidate) =>
        candidate.replace(/[，。！？、；：）】》」』’”\])}]+$/g, ""),
      )
      .find((candidate) =>
        /(douyin\.com|v\.douyin\.com|xiaohongshu\.com|xhslink\.(?:com|cn)|weixin\.qq\.com\/sph)/i.test(
          candidate,
        ),
      ) || ""
  );
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.trim().split(/\s+/)[0];
  const friendly = {
    XHS_JEWELRY_RESULT_CHECK_REQUIRED: "原请求结果尚待核实，请先检查原任务；不会重新生成。",
    XHS_JEWELRY_TASK_NOT_FOUND: "没有找到这个珠宝种草图任务。",
    XHS_JEWELRY_GENERATION_PROVIDER_INVALID:
      "请选择 Codex 内置生图或 ChatGPT 网页生图。",
    XHS_JEWELRY_UPLOAD_AUTHORIZATION_REQUIRED:
      "开始前请确认本次只上传页面列出的参考图、模特图和产品图。",
    XHS_JEWELRY_STAGE_ALREADY_RUNNING:
      "当前步骤已经在处理中，请不要重复提交。",
    XHS_JEWELRY_BASE_ROUTE_UNAVAILABLE:
      "这个项目已经选择直接换珠宝，不需要重新生成人物底片。",
    XHS_JEWELRY_STAGE_UNAVAILABLE:
      "当前还不能执行这一步，请先完成页面显示的上一项。",
    XHS_JEWELRY_BASE_APPROVAL_REQUIRED:
      "请先确认人物种草图，再开始换入真实珠宝。",
    XHS_JEWELRY_ATTEMPT_LIMIT_REACHED:
      "当前步骤已经使用两次，请先检查素材或佩戴位置，不再继续抽取新版本。",
    XHS_JEWELRY_BASE_APPROVAL_UNAVAILABLE:
      "当前没有可确认的人物种草图。",
    XHS_JEWELRY_FINAL_APPROVAL_UNAVAILABLE:
      "当前没有可采用的珠宝种草图结果。",
    XHS_JEWELRY_STALE_RUN:
      "这次后台运行已经失效，现有任务状态未被覆盖。",
    XHS_JEWELRY_RESULT_MISSING:
      "生成服务没有返回完整结果；任务已停在当前步骤，不会自动重复提交。",
    XHS_JEWELRY_RESULT_INVALID:
      "生成结果格式不完整；当前图片没有进入待确认结果。",
    XHS_JEWELRY_IMAGE_ARTIFACT_MISSING:
      "生成结果中没有找到可确认的图片。",
    XHS_JEWELRY_ARTIFACT_OUTSIDE_TASK:
      "生成结果与当前项目不匹配，已阻止串入其他项目图片。",
    XHS_JEWELRY_ARTIFACT_OUTSIDE_WORKBENCH:
      "候选图没有进入本次工作台项目，已阻止误认领其他图片。",
    XHS_JEWELRY_RECEIPT_OUTSIDE_WORKBENCH:
      "生成回执不属于当前工作台，当前结果没有进入待确认状态。",
    XHS_JEWELRY_ARTIFACT_SYMLINK_BLOCKED:
      "候选图或回执不是独立可核对文件，当前结果没有进入待确认状态。",
    XHS_JEWELRY_EXECUTION_RECEIPT_MISSING:
      "生成服务没有返回可核对的执行回执，当前图片没有被认领。",
    XHS_JEWELRY_EXECUTION_RECEIPT_FILE_MISSING:
      "生成回执记录存在，但回执文件当前不可用。",
    XHS_JEWELRY_EXECUTION_RECEIPT_INVALID:
      "生成回执无法核对，当前图片没有进入待确认状态。",
    XHS_JEWELRY_EXECUTION_RECEIPT_MISMATCH:
      "生成回执与本次任务不一致，已阻止串入其他任务结果。",
    XHS_JEWELRY_EXECUTION_IMAGE_MISMATCH:
      "图片与本次生成回执不一致，已阻止误认领。",
    XHS_JEWELRY_GENERATION_PROVENANCE_INVALID:
      "本次图片的生成来源证据不完整，当前结果没有进入待确认状态。",
    XHS_JEWELRY_REFERENCE_BINDING_MISMATCH:
      "实际使用的参考图与本项目不一致，当前结果已被拦截。",
    XHS_JEWELRY_EXECUTION_IMAGE_HASH_MISMATCH:
      "图片内容与生成回执不一致，当前结果已被拦截。",
    XHS_JEWELRY_IMAGE_FILE_MISSING:
      "生成记录存在，但图片文件当前不可用。",
    XHS_JEWELRY_CHECKPOINT_CONFLICT:
      "本次运行记录与当前任务不一致，已在正式提交前停止。",
    TASK_NOT_FOUND: "没有找到这个任务。",
    RETRY_LIMIT_REACHED: "同一步骤的重试次数已用完，请先诊断根因。",
    CONTINUATION_UNAVAILABLE: "当前任务还不能进入第二阶段。",
    INVALID_PERSON_ROUTE: "请选择一种人物路线。",
    PERSON_AUTHORIZATION_REQUIRED:
      "使用本人或指定人物前，请确认你已获得该人物授权。",
    PERSON_GENERATION_UNAVAILABLE: "当前任务还不能生成人物候选。",
    PERSON_ROUTE_NOT_SUPPORTED_YET:
      "本轮先接通 AI 自动创建人物；其他人物路线将在提供对应素材后继续。",
    PERSON_SOURCE_UPLOAD_AUTHORIZATION_REQUIRED:
      "请先确认只上传本任务必要的人物关键帧。",
    IMAGE_GENERATION_PROVIDER_INVALID:
      "请选择 Codex 内置生图或 ChatGPT 网页代办作为项目默认通道。",
    PERSON_GENERATION_PROVIDER_INVALID: "请选择可用的生图方式。",
    STORYBOARD_GENERATION_PROVIDER_INVALID: "请选择可用的分镜生图方式。",
    VIDEO_DIRECT_RETRY_SEGMENT_INVALID:
      "所选片段与旧项目的生成记录暂时无法对应；当前没有提交生成，也没有产生费用。请刷新页面后重新选择。",
    VIDEO_DIRECT_RETRY_CARD_MISSING:
      "旧项目缺少所选片段的生成记录，暂时不能直接重抽；当前没有提交生成，也没有产生费用。",
    VIDEO_DIRECT_RETRY_ASSET_MISSING:
      "旧项目缺少本次重抽所需的原始素材，暂时不能提交；当前没有产生费用。",
    VIDEO_DIRECT_RETRY_CARD_INCOMPLETE:
      "旧项目的片段生成资料不完整，暂时不能直接重抽；当前没有提交生成，也没有产生费用。",
    STORYBOARD_CHATGPT_INTERNAL_REQUEST_MISSING:
      "分镜提示词或参考图职责尚未准备完整，未向 ChatGPT 提交。",
    CHATGPT_STORYBOARD_INTERNAL_REQUEST_INVALID:
      "分镜内部生图请求与当前任务不匹配，未向 ChatGPT 提交。",
    CHATGPT_WEB_BRIDGE_NOT_CONNECTED:
      "ChatGPT 网页代办尚未连接真实浏览器；没有上传图片，也没有消耗额度。",
    CHATGPT_WEB_LOGIN_REQUIRED:
      "ChatGPT 浏览器伴侣已连接，但还需要在伴侣使用的 Chrome 中登录。没有自动重试。",
    CHATGPT_WEB_SUBMISSION_UNKNOWN:
      "ChatGPT 请求可能已经提交，但页面状态无法确认。系统不会自动再发一次，请先检查当前 ChatGPT 对话。",
    CHATGPT_WEB_BRIDGE_TIMEOUT:
      "ChatGPT 浏览器伴侣等待超时。系统不会自动重复提交，请先检查当前 ChatGPT 页面和任务记录。",
    CHATGPT_REFERENCE_IMAGES_MISSING:
      "没有找到可用于本次人物候选的参考关键帧，未向 ChatGPT 提交。",
    CHATGPT_REFERENCE_IMAGE_UNAVAILABLE:
      "本次登记的参考关键帧不可用，未向 ChatGPT 提交。",
    CHATGPT_RESULT_IMAGE_MISSING:
      "ChatGPT 没有返回可保存的人物图片，任务已停止。",
    CHATGPT_REWORK_RETURNED_REJECTED_IMAGE:
      "ChatGPT 返回的仍是上一张被否决图片，工作台已拦截，没有把它当作新结果。请手动再次生成。",
    PERSON_ATTEMPT_LIMIT_REACHED:
      "当前人物候选已经生成两次。为避免继续消耗额度，请先从现有候选中选择，或稍后调整人物要求后再继续。",
    PERSON_APPROVAL_UNAVAILABLE: "当前没有可确认的人物候选。",
    PERSON_IMAGE_MISSING: "人物候选图没有形成可追溯的本地文件，不能标记完成。",
    PERSON_EXECUTION_RECEIPT_MISSING:
      "人物生成缺少来源回执，不能发布为正式人物母版。",
    PERSON_ARTIFACT_ROUTE_MISSING:
      "人物候选没有进入正式工作台项目，不能发布为正式成果。",
    PERSON_LINKED_ORIGIN_MISSING:
      "人物候选缺少原始生成来源，不能发布为正式成果。",
    PERSON_ARTIFACT_PUBLISH_FAILED: "人物母版发布没有完成，候选图仍然保留。",
    GENERATION_ROUTE_INVALID: "请选择一种视频生成路线。",
    GENERATION_PACK_UNAVAILABLE: "当前任务还不能准备视频任务包。",
    VIDEO_GENERATION_PREPARATION_UNAVAILABLE: "当前任务还不能开始生成视频。",
    VIDEO_PROMPT_NOT_READY: "正式视频提示词尚未通过，不能进入任务包。",
    PERSON_PACKAGE_GENERATION_UNAVAILABLE: "当前任务不需要或还不能补人物资产。",
    PERSON_PACKAGE_UPLOAD_AUTHORIZATION_REQUIRED:
      "请先确认本次必要人物资产的参考图上传范围。",
    PERSON_PACKAGE_ATTEMPT_LIMIT_REACHED:
      "人物多视图已尝试两次，系统已停止继续消耗额度。",
    PERSON_PACKAGE_APPROVAL_UNAVAILABLE: "当前没有可确认的人物多视图。",
    PERSON_PACKAGE_INPUTS_MISSING:
      "缺少已确认人物母版或已采用分镜，未开始补图。",
    PERSON_PACKAGE_IMAGE_MISSING:
      "人物多视图没有形成可追溯的本地图片，不能继续。",
  };
  if (message.includes("linked_origin_not_same_physical_entity"))
    return "人物候选的来源登记方式不兼容，尚未采用；候选图仍然保留。";
  if (message.includes("artifact_manager.py publish"))
    return "人物母版发布没有完成，候选图仍然保留。请刷新后再试；系统没有进入后续分镜。";
  return (
    friendly[message] ||
    friendly[code] ||
    message.replace(/\/Users\/[^/]+/g, "当前电脑").slice(0, 1200)
  );
}
