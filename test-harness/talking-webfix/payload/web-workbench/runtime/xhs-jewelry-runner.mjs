import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";
import { artifactRoot, codexWorkspaceRoot } from "./portable-paths.mjs";
import { buildXhsJewelryProductPack } from "./xhs-jewelry-product-pack.mjs";
import { runXhsJewelryWebGeneration } from "./xhs-jewelry-web-generator.mjs";
import { ensureXhsJewelryProjectRoute } from "./xhs-jewelry-artifact-route.mjs";

const schemaPath = fileURLToPath(new URL("./output-schema.json", import.meta.url));
const MAX_TOTAL_GENERATION_REFERENCES = 5;

export function inspectXhsJewelryRuntime({ env = process.env } = {}) {
  if (env.WORKBENCH_DISABLE_XHS_JEWELRY === "1") {
    return {
      available: false,
      visible: false,
      state: "feature_disabled_by_deployment",
      user_message: "珠宝种草功能已由部署方临时停用。",
    };
  }
  try {
    const stage1 = resolveSkillContract("xhs_jewelry_stage1", { env });
    const stage2 = resolveSkillContract("xhs_jewelry_stage2", { env });
    return {
      available: true,
      visible: true,
      state: "ready",
      user_message: "珠宝种草功能已就绪。",
      contracts: {
        stage1_sha256: stage1.source_sha256,
        stage2_sha256: stage2.source_sha256,
      },
    };
  } catch (error) {
    return {
      available: false,
      visible: true,
      state: "skill_contract_blocked",
      user_message: "珠宝种草图规则尚未准备完整，当前没有提交图片生成。",
      internal_error: String(error?.code || error?.message || error),
    };
  }
}

export async function runXhsJewelryStage({ task, taskDir, stage, onEvent, onExternalRequestStarted, onBrowserJob, env = process.env }) {
  const workflow = stage === "visual_base" ? "xhs_jewelry_stage1" : "xhs_jewelry_stage2";
  onEvent?.("正在为这款产品确认唯一的成果保存位置；同一项目后续会继续复用。");
  const artifactRoute = ensureXhsJewelryProjectRoute(task, taskDir, env);
  const contract = resolveSkillContract(workflow, { env });
  const attempt = stage === "visual_base" ? task.base_attempt_count : task.product_attempt_count;
  const execution = executionIdentity(task, stage, attempt);
  const stageDir = join(taskDir, stage, execution.attempt_id);
  mkdirSync(stageDir, { recursive: true });
  const productPack = stage === "product_replacement"
    ? await buildXhsJewelryProductPack({ task, taskDir, onEvent, env })
    : null;
  const receipt = skillContractReceipt(contract);
  const contractPath = join(stageDir, "skill-contract.json");
  const snapshotPath = join(stageDir, "task-snapshot.json");
  const promptPath = join(stageDir, "execution-prompt.md");
  const resultPath = join(stageDir, "result.json");
  writeImmutableJson(contractPath, receipt);
  const snapshot = buildSnapshot(task, stage, attempt, receipt, execution, productPack, artifactRoute);
  writeImmutableJson(snapshotPath, snapshot);
  const prompt = buildXhsJewelryPrompt({ task, taskDir, stage, snapshotPath, contract, productPack, artifactRoute });
  writeImmutableText(promptPath, prompt);

  const provider = task.active_generation_provider
    || (stage === "visual_base" ? task.base_generation_provider : task.product_generation_provider)
    || "codex_builtin";
  if (env.WORKBENCH_XHS_JEWELRY_GENERATOR) {
    await runFixtureGenerator(env.WORKBENCH_XHS_JEWELRY_GENERATOR, {
      taskJson: snapshotPath,
      taskDir,
      stageDir,
      stage,
      output: resultPath,
      env,
      onLine: onEvent,
      onExternalRequestStarted,
    });
  } else if (provider === "chatgpt_web") {
    const webResult = await runXhsJewelryWebGeneration({
      task,
      taskDir,
      stage,
      stageDir,
      contract,
      productPack,
      onEvent,
      onExternalRequestStarted,
      onBrowserJob,
      env,
    });
    writeImmutableJson(resultPath, webResult);
  } else {
    await runCodex(
      prompt,
      taskDir,
      resultPath,
      onEvent,
      onExternalRequestStarted,
      env,
      join(artifactRoute.work_dir, "image-generation-records", execution.attempt_id, "run-state.json"),
    );
  }

  if (!existsSync(resultPath)) throw preflightError("XHS_JEWELRY_RESULT_MISSING");
  const raw = JSON.parse(readFileSync(resultPath, "utf8"));
  if (!env.WORKBENCH_XHS_JEWELRY_GENERATOR && raw.external_request_started === true) {
    onExternalRequestStarted?.();
  }
  const result = validateXhsJewelryResult(raw, taskDir, stage, {
    task,
    env,
    fixtureMode: Boolean(env.WORKBENCH_XHS_JEWELRY_GENERATOR),
    productPack,
  });
  const finalized = {
    ...result,
    stage,
    attempt,
    skill_contract: receipt,
    skill_contract_receipt_path: contractPath,
    task_snapshot_path: snapshotPath,
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    generation_provider: provider,
    product_pack: productPack,
    automatic_retry: false,
  };
  writeFileSync(resultPath, `${JSON.stringify(finalized, null, 2)}\n`);
  return finalized;
}

export function buildXhsJewelryPrompt({ task, taskDir, stage, snapshotPath, contract, productPack = null, artifactRoute = null }) {
  const isBase = stage === "visual_base";
  const attempt = isBase ? task.base_attempt_count : task.product_attempt_count;
  const execution = executionIdentity(task, stage, attempt);
  return buildSkillOwnedPrompt({
    contract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      task_snapshot_path: snapshotPath,
      work_dir: taskDir,
      formal_project_dir: artifactRoute?.task_root || null,
      formal_output_dir: artifactRoute?.final_dir || null,
      artifact_route_receipt: artifactRoute,
      route: task.visual_mode,
      current_stage: stage,
      generation_task_id: generationTaskId(task, stage),
      formal_task_id: execution.task_id,
      attempt_id: execution.attempt_id,
      idempotency_key: execution.idempotency_key,
      source_visual_paths: task.reference_image_paths,
      approved_base_image_path: isBase ? null : approvedBasePath(task),
      product_generation_base_image_path: isBase ? null : productGenerationBasePath(task),
      person_strategy: task.person_strategy || "authorized_real_person",
      person_identity_paths: task.person_strategy === "partial_body" ? [] : task.person_image_paths,
      body_reference_paths: task.person_strategy === "partial_body" ? task.person_image_paths : [],
      visibility_contract: task.person_strategy === "partial_body"
        ? "只制作不露脸局部佩戴画面；按参考景别保留手部、颈部或穿搭局部，不新增完整人脸，不扩展成全身人物。不要求人物身份图；有局部参考时仅继承手型、肤色等指定身体特征。无局部参考时生成原创局部身体。"
        : "按已授权人物图锁定人物身份。",
      product_asset_paths: task.product_image_paths,
      product_pack: isBase ? null : productPack,
      product_reference_strategy: isBase ? null : buildProductReferenceStrategy(task, productPack),
      target_jewelry_slot: task.target_slot,
      person_authorization_confirmed: task.person_authorization_confirmed,
      upload_authorized: task.external_upload_authorized,
      target_ratio: task.target_ratio,
      user_brief: task.brief || null,
      user_initiated_rework_contract: task.pending_rework || null,
    },
    runtimeEnvelope: {
      requested_output_count: 1,
      operation: task.pending_rework
        ? isBase
          ? task.pending_rework.mode === "fresh_variant" ? "regenerate_visual_base_variant" : "repair_visual_base_from_user_feedback"
          : task.pending_rework.mode === "fresh_variant" ? "regenerate_product_variant_from_approved_base" : "repair_product_replacement_from_user_feedback"
        : isBase ? "generate_visual_base_candidate" : "replace_product_on_approved_base",
      image_generation_allowed: true,
      artifact_identity: {
        task_id: execution.task_id,
        attempt_id: execution.attempt_id,
        idempotency_key: execution.idempotency_key,
        task_id_must_equal_route_receipt_task_id: true,
        stage_and_attempt_must_not_be_appended_to_task_id: true,
      },
      external_upload_scope: stageReferencePaths(task, stage, productPack),
      partial_body_without_identity_supported: task.person_strategy === "partial_body",
      partial_body_instruction: task.person_strategy === "partial_body"
        ? "原方法的人物身份图要求只适用于锁定人物身份。本次不露脸：完成视觉反推后，生成只含指定局部身体的原创画面；身份图可以为空，不索要或虚构脸照。" : null,
      generation_reference_policy: isBase ? {
        mode: "exact_stage_reference_binding",
        actual_references_must_equal_external_upload_scope: true,
      } : {
        mode: "approved_base_plus_product_pack",
        generation_base_required: true,
        approved_base_retained_as_photography_qc_authority: true,
        product_pack_required: true,
        exact_references_must_equal_external_upload_scope: true,
        maximum_total_generation_references: MAX_TOTAL_GENERATION_REFERENCES,
        front_identity_chirality_locked: true,
        mirror_flip_forbidden: true,
        recent_conversation_images_allowed: false,
      },
      clean_execution_handoff: {
        clean_child_required: true,
        parent_must_not_open_original_resolution_references: true,
        parent_must_not_open_rejected_candidate: true,
        clean_child_owns_reference_path_and_role_verification: true,
        parent_may_use_cached_product_pack_for_prompt_compilation: true,
        optional_diagnostic_views_must_use_resized_high_detail_not_original: true,
      },
      post_generation_review_policy: {
        ai_business_or_visual_qc_enabled: false,
        additional_model_call_allowed: false,
        technical_validation_required: true,
        visual_decision_owner: "user",
        valid_result_must_return_immediately_for_user_review: true,
      },
      automatic_retry_allowed: false,
      rework_policy: task.pending_rework ? {
        user_initiated: true,
        feedback_interpretation_owner: "existing_clean_executor",
        feedback_interpretation_instruction: "查看当前候选、正式参考和用户完整原话，自行理解各项修改目标及保留要求；不限于预设分类，不按关键词推断问题或不确定性。先定位可核实差异，缺少依据或存在会导致相反修改结果的歧义时，在生成前向用户澄清。",
        additional_interpretation_model_call_allowed: false,
        diagnose_rejected_candidate_before_generation: true,
        rejected_candidate_is_product_repair_base: false,
        rejected_candidate_is_diagnostic_only: true,
        repair_only_reported_or_visually_confirmed_failures: true,
        do_not_inherit_rejected_errors: true,
        product_orientation_must_not_be_mirrored: task.pending_rework?.diagnosis?.no_mirror_product_identity === true,
        uncertainty_detected: task.pending_rework?.feedback_interpretation?.uncertainty_detected === true,
        allowed_natural_loss: task.pending_rework?.diagnosis?.allowed_natural_loss || [],
        forbidden_overcorrection: task.pending_rework?.diagnosis?.forbidden_overcorrection || [],
        preserve_requirements: task.pending_rework?.diagnosis?.preserve_requirements || [],
      } : null,
      provider_switch_allowed: false,
      generation_provider: task.active_generation_provider
        || (isBase ? task.base_generation_provider : task.product_generation_provider)
        || "codex_builtin",
      video_generation_allowed: false,
      output_directory: artifactRoute?.final_dir || join(taskDir, stage),
      output_interface: {
        expected_artifact: isBase ? "人物种草图候选" : "珠宝种草图成品候选",
        required_supporting_artifact: "当前所选生图通道的成功执行回执 JSON",
        approval_status: "needs_review",
        published: false,
        requires_confirmation: true,
      },
      user_message_policy: "只用大白话说明结果和下一步，不展示内部路径、Skill、执行器、哈希或合同字段。",
    },
  });
}

function buildSnapshot(task, stage, attempt, contract, execution = executionIdentity(task, stage, attempt), productPack = null, artifactRoute = null) {
  return {
    schema_version: 1,
    task_id: task.id,
    project_name: task.title,
    visual_mode: task.visual_mode,
    stage,
    attempt,
    generation_task_id: generationTaskId(task, stage),
    formal_task_id: execution.task_id,
    attempt_id: execution.attempt_id,
    idempotency_key: execution.idempotency_key,
    artifact_route_receipt: artifactRoute,
    active_run_id: task.active_run_id || null,
    target_slot: task.target_slot,
    target_ratio: task.target_ratio,
    brief: task.brief,
    reference_image_paths: task.reference_image_paths,
    person_image_paths: task.person_image_paths,
    person_strategy: task.person_strategy || "authorized_real_person",
    product_image_paths: task.product_image_paths,
    product_pack: stage === "product_replacement" ? productPack : null,
    product_reference_strategy: stage === "product_replacement" ? buildProductReferenceStrategy(task, productPack) : null,
    approved_base_image_path: stage === "product_replacement" ? approvedBasePath(task) : null,
    product_generation_base_image_path: stage === "product_replacement" ? productGenerationBasePath(task) : null,
    person_authorization_confirmed: task.person_authorization_confirmed,
    external_upload_authorized: task.external_upload_authorized,
    requested_output_count: 1,
    automatic_retry: false,
    user_initiated_rework: task.pending_rework || null,
    provider_switch_allowed: false,
    generation_provider: task.active_generation_provider
      || (stage === "visual_base" ? task.base_generation_provider : task.product_generation_provider)
      || "codex_builtin",
    skill_contract: contract,
  };
}

export function validateXhsJewelryResult(raw, taskDir, stage, { task, env, fixtureMode = false, productPack = null }) {
  if (!raw || !["completed", "needs_user_input", "blocked"].includes(raw.status)) {
    throw preflightError("XHS_JEWELRY_RESULT_INVALID");
  }
  // `needs_user_input` can still contain a technically successful image and a
  // valid execution receipt.  That is a reviewable candidate with a business
  // QA warning, not a failed generation.  Continue through the same artifact
  // and provenance checks so the UI can show it to the user.  A blocked result
  // (or a result without a verifiable candidate) remains a real failure.
  if (raw.status === "blocked") {
    const error = new Error(raw.user_message || raw.summary || "珠宝种草图任务没有完成。");
    error.code = "XHS_JEWELRY_BUSINESS_BLOCKED";
    error.external_request_started = raw.external_request_started === true;
    throw error;
  }
  const artifact = (raw.artifacts || []).find((item) => item?.path && looksLikeImage(item.path));
  if (!artifact) throw preflightError("XHS_JEWELRY_IMAGE_ARTIFACT_MISSING");
  const imagePath = resolve(artifact.path);
  if (!existsSync(imagePath)) throw preflightError("XHS_JEWELRY_IMAGE_FILE_MISSING");
  if (lstatSync(imagePath).isSymbolicLink()) throw preflightError("XHS_JEWELRY_ARTIFACT_SYMLINK_BLOCKED");

  let executionReceiptPath = null;
  if (fixtureMode) {
    assertInside(imagePath, taskDir, "XHS_JEWELRY_ARTIFACT_OUTSIDE_TASK");
  } else {
    const receiptArtifact = findExecutionReceiptArtifact(raw.artifacts || []);
    if (!receiptArtifact) throw preflightError("XHS_JEWELRY_EXECUTION_RECEIPT_MISSING");
    executionReceiptPath = resolve(receiptArtifact.path);
    if (!existsSync(executionReceiptPath)) throw preflightError("XHS_JEWELRY_EXECUTION_RECEIPT_FILE_MISSING");
    if (lstatSync(executionReceiptPath).isSymbolicLink()) throw preflightError("XHS_JEWELRY_ARTIFACT_SYMLINK_BLOCKED");
    const formalRoot = artifactRoot(env);
    assertInside(imagePath, formalRoot, "XHS_JEWELRY_ARTIFACT_OUTSIDE_WORKBENCH");
    assertInside(executionReceiptPath, formalRoot, "XHS_JEWELRY_RECEIPT_OUTSIDE_WORKBENCH");
    const expectedProvider = task.active_generation_provider
      || (stage === "visual_base" ? task.base_generation_provider : task.product_generation_provider)
      || "codex_builtin";
    validateExecutionReceipt({
      receiptPath: executionReceiptPath,
      imagePath,
      expectedTaskId: generationTaskId(task, stage),
      stage,
      approvedBaseImagePath: stage === "product_replacement" ? productGenerationBasePath(task) : null,
      expectedReferences: stage === "visual_base"
        ? expectedProvider === "chatgpt_web"
          ? [...task.reference_image_paths.slice(0, 1), ...task.person_image_paths.slice(0, 1)]
          : stageReferencePaths(task, stage, productPack)
        : null,
      expectedProductReferences: stage === "product_replacement"
        ? productPack?.generation_reference_plan?.product_evidence_paths || task.product_image_paths.slice(0, 4)
        : null,
      expectedProvider,
      expectedDiagnostic: expectedProvider === "chatgpt_web" && task.pending_rework?.mode === "targeted_refine"
        ? task.pending_rework.rejected_candidate : null,
    });
  }
  return {
    ...raw,
    technical_validation_status: "passed",
    business_review_status: "not_run",
    image: {
      label: artifact.label || (stage === "visual_base" ? "人物种草图候选" : "珠宝种草图候选"),
      path: imagePath,
      sha256: createHash("sha256").update(readFileSync(imagePath)).digest("hex"),
      published: false,
    },
    execution_receipt_path: executionReceiptPath,
    external_request_started: raw.external_request_started === true,
  };
}

function findExecutionReceiptArtifact(artifacts) {
  const jsonArtifacts = artifacts.filter((item) => item?.path && /\.json$/i.test(item.path));
  const labeled = jsonArtifacts.find((item) => /执行回执|生成(?:成功)?回执|execution receipt|generation receipt/i
    .test(String(item.label || "")));
  if (labeled) return labeled;
  return jsonArtifacts.find((item) => {
    try {
      const receipt = JSON.parse(readFileSync(resolve(item.path), "utf8"));
      return receipt?.business_skill === "xhs-jewelry-visual-remix"
        && ["clean_subagent", "chatgpt_web_companion"].includes(receipt?.generation_execution_context)
        && receipt?.status === "success";
    } catch {
      return false;
    }
  });
}

function validateExecutionReceipt({
  receiptPath,
  imagePath,
  expectedTaskId,
  stage,
  approvedBaseImagePath,
  expectedReferences,
  expectedProductReferences,
  expectedProvider,
  expectedDiagnostic,
}) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, "utf8")); }
  catch { throw preflightError("XHS_JEWELRY_EXECUTION_RECEIPT_INVALID"); }
  const webReceipt = receipt.generation_execution_context === "chatgpt_web_companion";
  const codexReceipt = receipt.generation_execution_context === "clean_subagent";
  if (receipt.task_id !== expectedTaskId
    || receipt.business_skill !== "xhs-jewelry-visual-remix"
    || (!webReceipt && !codexReceipt)
    || (codexReceipt && receipt.fork_turns !== "none")
    || (webReceipt && receipt.generation_provider !== "chatgpt_web")
    || (expectedProvider === "chatgpt_web" && !webReceipt)
    || (expectedProvider === "codex_builtin" && !codexReceipt)
    || receipt.status !== "success"
    || receipt.approval_status !== "needs_review") {
    throw preflightError("XHS_JEWELRY_EXECUTION_RECEIPT_MISMATCH");
  }
  if (resolve(receipt.project_output_path || "") !== resolve(imagePath)) {
    throw preflightError("XHS_JEWELRY_EXECUTION_IMAGE_MISMATCH");
  }
  const provenance = receipt.generation_provenance || {};
  const provenanceValid = codexReceipt
    ? provenance.tool_call_observed_by_child === true && provenance.num_last_images_used === "false"
    : provenance.browser_job_observed_by_workbench === true
      && provenance.exact_reference_bindings_used === true
      && provenance.recent_conversation_images_used === "false"
      && provenance.automatic_retry === false
      && Boolean(receipt.browser_job_id);
  if (!provenanceValid) {
    throw preflightError("XHS_JEWELRY_GENERATION_PROVENANCE_INVALID");
  }
  validateReceiptReferences({
    actualReferenceImages: receipt.actual_reference_images,
    stage,
    approvedBaseImagePath,
    expectedReferences,
    expectedProductReferences,
    expectedDiagnostic,
  });
  const actualSha = createHash("sha256").update(readFileSync(imagePath)).digest("hex");
  if (!receipt.file_spec?.sha256 || receipt.file_spec.sha256 !== actualSha) {
    throw preflightError("XHS_JEWELRY_EXECUTION_IMAGE_HASH_MISMATCH");
  }
}

export function validateReceiptReferences({
  actualReferenceImages,
  stage,
  approvedBaseImagePath,
  expectedReferences,
  expectedProductReferences,
  expectedDiagnostic = null,
}) {
  let items = Array.isArray(actualReferenceImages) ? actualReferenceImages : [];
  if (expectedDiagnostic) {
    const diagnostic = items.at(-1);
    if (!expectedDiagnostic.path || !expectedDiagnostic.sha256
        || resolve(diagnostic?.path || "") !== resolve(expectedDiagnostic.path)
        || diagnostic?.sha256 !== expectedDiagnostic.sha256
        || diagnostic?.role !== "rejected_candidate_diagnostic_only"
        || !diagnostic?.must_not_inherit || !diagnostic?.must_inherit) {
      throw preflightError("XHS_JEWELRY_REFERENCE_BINDING_MISMATCH");
    }
    items = items.slice(0, -1);
  }
  const actual = items.map((item) => resolve(item?.path || ""));
  if (stage === "visual_base") {
    const expected = expectedReferences.map((path) => resolve(path));
    if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
      throw preflightError("XHS_JEWELRY_REFERENCE_BINDING_MISMATCH");
    }
    return;
  }

  const approvedBase = resolve(approvedBaseImagePath || "");
  const expectedProducts = (expectedProductReferences || []).map((path) => resolve(path));
  const selectedProducts = actual.slice(1);
  const rolesComplete = items.every((item) => String(item?.role || "").trim()
    && String(item?.must_inherit || "").trim()
    && String(item?.must_not_inherit || "").trim());
  const valid = actual.length >= 2
    && actual.length <= MAX_TOTAL_GENERATION_REFERENCES
    && actual[0] === approvedBase
    && selectedProducts.length === expectedProducts.length
    && new Set(actual).size === actual.length
    && selectedProducts.every((path, index) => path === expectedProducts[index])
    && rolesComplete;
  if (!valid) throw preflightError("XHS_JEWELRY_REFERENCE_BINDING_MISMATCH");
}

function assertInside(path, root, code) {
  const realPath = realpathSync(path);
  const realRoot = realpathSync(root);
  if (!(realPath === realRoot || realPath.startsWith(`${realRoot}/`))) throw preflightError(code);
}

function generationTaskId(task) {
  return task.id;
}

function executionIdentity(task, stage, attempt) {
  const runSuffix = String(task.active_run_id || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 8);
  const attemptId = runSuffix ? `attempt-${attempt}-${runSuffix}` : `attempt-${attempt}`;
  return {
    task_id: task.id,
    attempt_id: attemptId,
    idempotency_key: `${task.id}:${stage}:${attemptId}`,
  };
}

function stageReferencePaths(task, stage, productPack = null) {
  return stage === "visual_base"
    ? [...task.person_image_paths]
    : [
        productGenerationBasePath(task),
        ...(productPack?.generation_reference_plan?.product_evidence_paths || task.product_image_paths.slice(0, 4)),
      ].filter(Boolean);
}

export function buildProductReferenceStrategy(task, productPack = null) {
  return {
    mode: "cached_product_pack_v0.3",
    source_product_paths: [...task.product_image_paths],
    product_pack_manifest_path: productPack?.manifest_path || null,
    evidence_board_path: productPack?.evidence_board?.path || null,
    category: productPack?.category || null,
    selected_product_evidence_paths: productPack?.generation_reference_plan?.product_evidence_paths || [],
    maximum_selected_product_references: 4,
    maximum_total_generation_references: MAX_TOTAL_GENERATION_REFERENCES,
    selection_owner: "xhs-jewelry-visual-remix",
    selection_method: "新产品首次由视觉规划器识别证据职责；结构板始终由代码裁切、缩放并拼接原始像素，后续按产品指纹直接复用。",
    additional_image_generation_call_allowed: false,
    one_cached_visual_reasoning_call_allowed_for_new_product_pack: true,
    formal_product_asset_pack_required: true,
    evidence_board_ai_redraw_allowed: false,
    product_facts_must_distinguish_verified_and_unknown: true,
    duplicate_role_reuse_allowed_when_evidence_is_limited: false,
  };
}

function resultImagePath(result) {
  return result?.image?.path || (result?.artifacts || []).find((item) => looksLikeImage(item?.path))?.path || null;
}

function approvedBasePath(task) {
  return resultImagePath(task.base_result)
    || (task.visual_mode === "direct_product_edit" ? task.reference_image_paths?.[0] : null);
}

export function productGenerationBasePath(task) {
  // Every product attempt starts from the approved visual base.  A rejected
  // product candidate is evidence for the feedback contract only; chaining it
  // as the next image input compounds whole-image drift and quality loss.
  return approvedBasePath(task);
}

function looksLikeImage(path) {
  return /\.(png|jpe?g|webp)$/i.test(String(path || ""));
}

function writeImmutableJson(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (!existsSync(path)) return writeFileSync(path, serialized, { flag: "wx" });
  const existing = readFileSync(path, "utf8");
  if (existing !== serialized) throw preflightError("XHS_JEWELRY_CHECKPOINT_CONFLICT");
}

function writeImmutableText(path, value) {
  if (!existsSync(path)) return writeFileSync(path, value, { flag: "wx" });
  if (readFileSync(path, "utf8") !== value) throw preflightError("XHS_JEWELRY_CHECKPOINT_CONFLICT");
}

function runCodex(prompt, taskDir, resultPath, onEvent, onExternalRequestStarted, env, runStatePath = null) {
  const args = [
    "exec", "-", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write",
    "--model", env.WORKBENCH_CODEX_MODEL || "gpt-5.6-sol",
    "--config", `model_reasoning_effort=${env.WORKBENCH_XHS_JEWELRY_REASONING_EFFORT || "medium"}`,
    "-C", taskDir,
    "--add-dir", codexWorkspaceRoot(env),
  ];
  const formalRoot = artifactRoot(env);
  if (existsSync(formalRoot)) args.push("--add-dir", formalRoot);
  args.push("--output-schema", schemaPath, "--output-last-message", resultPath);
  let externalRequestMarked = false;
  const markExternalRequestFromRunState = () => {
    if (externalRequestMarked || !didStartManagedImageGeneration(runStatePath)) return;
    externalRequestMarked = true;
    onExternalRequestStarted?.();
  };
  const runStateTimer = runStatePath ? setInterval(markExternalRequestFromRunState, 500) : null;
  runStateTimer?.unref?.();
  return runManagedCodex({
    args,
    prompt,
    env,
    onEvent,
    onRawLine: (line) => {
      if (didStartImageGeneration(line)) onExternalRequestStarted?.();
    },
    timeoutMs: Number(env.WORKBENCH_XHS_JEWELRY_TIMEOUT_MS || 30 * 60 * 1000),
  }).finally(() => {
    markExternalRequestFromRunState();
    if (runStateTimer) clearInterval(runStateTimer);
  });
}

export function didStartManagedImageGeneration(runStatePath) {
  if (!runStatePath || !existsSync(runStatePath)) return false;
  try {
    const state = JSON.parse(readFileSync(runStatePath, "utf8"));
    return state.tool_name === "builtin_image_gen"
      && ["running", "success"].includes(state.status)
      && Boolean(state.started_at);
  } catch {
    return false;
  }
}

function didStartImageGeneration(line) {
  try {
    const event = JSON.parse(String(line || ""));
    if (event.type !== "item.started") return false;
    const item = event.item || {};
    return /image_gen__imagegen|imagegen\.imagegen|imagegen/i.test(JSON.stringify({
      type: item.type,
      name: item.name,
      tool_name: item.tool_name,
      server: item.server,
    }));
  } catch {
    return false;
  }
}

function runFixtureGenerator(command, { taskJson, taskDir, stageDir, stage, output, env, onLine, onExternalRequestStarted }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [command, "--task-json", taskJson, "--task-dir", taskDir, "--stage-dir", stageDir, "--stage", stage, "--output", output], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      stdout += value;
      for (const line of value.split("\n").filter(Boolean)) {
        if (line === "EXTERNAL_REQUEST_STARTED") onExternalRequestStarted?.();
        else onLine?.(line);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(stderr || stdout || `珠宝种草图执行器退出码 ${code}`)));
  });
}

function preflightError(code) {
  const error = new Error(code);
  error.code = code;
  error.external_request_started = false;
  return error;
}
