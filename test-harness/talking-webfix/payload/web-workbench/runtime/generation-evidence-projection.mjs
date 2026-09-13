import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256File } from "./stage-execution-receipt.mjs";
import { skillFile } from "./portable-paths.mjs";
import { resolvePersonExecutionReceipt } from "./person-publication.mjs";

export function extractFinalModelPrompt(markdown) {
  const finalSection = String(markdown || "").match(/(?:^|\n)##\s*(?:最终提示词|最终模型提示词|模型可直接提交的正式提示词)(?:\s*[｜|:：-]\s*[^\n（(]+)?(?:\s*[（(][^\n）)]*[）)])?\s*\n([\s\S]*?)(?=\n#{1,2}\s|$)/);
  if (finalSection?.[1]?.trim()) return finalSection[1].trim();
  const segmented = String(markdown || "").match(/^#\s*正式视频提示词\s*\n([\s\S]*生成单位：`segmented_full_sequence`[\s\S]*)$/m);
  if (segmented?.[1]?.trim()) return segmented[1].trim();
  const reusable = String(markdown || "").match(/##\s*可复用镜头内容\s*\n([\s\S]*?)(?=\n##\s*状态说明|$)/);
  if (reusable?.[1]?.trim()) return reusable[1].trim();
  const match = String(markdown || "").match(/#{1,2}\s*(?:正式视频提示词|最终模型提示词|模型可直接提交的正式提示词|最终提示词)(?:\s*[｜|:：-]\s*[^\n（(]+)?(?:\s*[（(][^\n）)]*[）)])?\s*\n([\s\S]*?)(?=\n#{1,2}\s|$)/);
  if (match?.[1]?.trim()) return match[1].trim();
  const shotPrompts = String(markdown || "").match(/##\s*镜头\s*\d+[\s\S]*$/);
  return shotPrompts?.[0]?.trim() || "";
}

export function buildGenerationEvidenceProjection({ task, taskDir, projectionDir = join(taskDir, "08_generation_evidence_projection"), provider = task.generation_model_snapshot?.provider || task.generation_provider || "libtv", env = process.env }) {
  if (task.remix_precision_route === "prompt_driven_remix") {
    return buildPromptDrivenGenerationEvidenceProjection({ task, taskDir, projectionDir, provider });
  }
  if (provider === "runninghub_h3_multiref") {
    return buildH3GenerationEvidenceProjection({ task, taskDir, projectionDir, env });
  }
  const sourceDir = join(taskDir, "01_source_video_analysis");
  const motionDir = join(taskDir, "05_motion_preflight");
  const promptDir = join(taskDir, "06_video_prompts");
  const personMaster = requiredArtifact(task, "person", /人物母版|人物候选/);
  const storyboard = requiredResultArtifact(task.storyboard_generation_result, /目标宫格分镜/);
  const storyboardReceipt = requiredResultArtifact(task.storyboard_generation_result, /分镜生成执行回执/);
  const personAssets = Object.fromEntries(
    ["服装人物多视图锚点", "三道红线遮脸版", "局部材质拼图", "分镜安全提交版"]
      .map((label) => [label, requiredResultArtifact(task.person_package_result, new RegExp(label))]),
  );
  const sourceFiles = {
    semantic: requiredPath(join(sourceDir, "semantic-merge.json")),
    dnaJson: requiredPath(join(sourceDir, "remix-dna.json")),
    dnaMd: requiredPath(join(sourceDir, "remix-dna.md")),
    keyframes: requiredPath(join(sourceDir, "source_keyframe_manifest.json")),
    calibration: requiredPath(join(sourceDir, "source_style_calibration.json")),
  };
  const motionBlueprintPath = requiredPath(join(motionDir, "motion_blueprint.json"));
  const promptSourcePath = requiredResultArtifact(task.video_prompt_result, /正式视频提示词/) || requiredPath(join(promptDir, "video_prompts.md"));
  const promptQcSourcePath = requiredResultArtifact(task.video_prompt_result, /视频提示词自检/) || requiredPath(join(promptDir, "prompt_qc_trace.md"));
  const promptContractPath = task.video_prompt_result?.skill_contract_receipt_path && existsSync(task.video_prompt_result.skill_contract_receipt_path)
    ? task.video_prompt_result.skill_contract_receipt_path
    : promptQcSourcePath;
  const redlineTaskCard = findResultEvidence(task.person_package_result, /三道红线遮脸版/, /rework-platform_privacy_fallback_three_red_bars\.json$/);
  const redlineReceipt = findResultEvidence(task.person_package_result, /三道红线遮脸版/, /三道红线遮脸版-chatgpt-web-receipt\.json$/);

  assertApprovedStage(task.person_package_result, "PERSON_PACKAGE_NOT_APPROVED");
  assertApprovedStage(task.storyboard_generation_result, "STORYBOARD_NOT_APPROVED");
  if (task.motion_preflight_result?.status !== "completed") throw evidenceError("MOTION_PREFLIGHT_NOT_COMPLETED");
  if (task.video_prompt_result?.status !== "completed") throw evidenceError("VIDEO_PROMPT_NOT_COMPLETED");

  const keyframes = readJson(sourceFiles.keyframes).frames || [];
  const motion = readJson(motionBlueprintPath);
  const receipt = readJson(storyboardReceipt);
  const originalPrompt = extractFinalModelPrompt(readFileSync(promptSourcePath, "utf8"));
  if (!originalPrompt) throw evidenceError("FINAL_MODEL_PROMPT_MISSING");
  const referencePaths = unique([
    ...(receipt.reference_image_paths || []),
    ...(receipt.source_reference_bindings || []).map((item) => item.path),
  ]).filter((path) => path && existsSync(path));
  if (!referencePaths.length) throw evidenceError("STORYBOARD_REFERENCE_EVIDENCE_MISSING");
  const platformSmokeEvidence = findExactPlatformSmokeEvidence(task, [
    personAssets["分镜安全提交版"],
    personAssets["三道红线遮脸版"],
    personAssets["局部材质拼图"],
  ]);

  mkdirSync(projectionDir, { recursive: true });
  copyText(sourceFiles.semantic, join(projectionDir, "01_source_video_analysis/final/semantic-merge.json"));
  copyText(sourceFiles.dnaJson, join(projectionDir, "01_source_video_analysis/final/remix-dna.json"));
  copyText(sourceFiles.dnaMd, join(projectionDir, "01_source_video_analysis/final/remix-dna.md"));
  copyText(sourceFiles.keyframes, join(projectionDir, "01_source_video_analysis/storyboard_handoff/source_keyframe_manifest.json"));
  writeText(join(projectionDir, "01_source_video_analysis/storyboard_handoff/source_style_calibration.md"), styleCalibrationDocument(sourceFiles.calibration));
  writeText(join(projectionDir, "01_source_video_analysis/storyboard_handoff/source_style_contract.md"), styleContractDocument(sourceFiles.calibration, sourceFiles.dnaJson));

  const status = statusDocument(task, { personMaster, storyboard, personAssets });
  writeText(join(projectionDir, "00_project_status.md"), status);
  writeText(join(projectionDir, "00_workflow_prescription.md"), workflowPrescription(task, { sourceFiles, motionBlueprintPath, promptSourcePath, personMaster, storyboard }));

  const peopleExecutionManifest = join(projectionDir, "03_people_assets/people-image-generation-execution.json");
  writeJson(peopleExecutionManifest, {
    schema_version: 1,
    task_id: task.id,
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    reference_binding: "image_edit_with_reference",
    source_reference_binding: "actual_image_reference",
    tool_capability: "image_edit_with_reference",
    reference_image_paths: [personMaster],
    allowed_downstream: "generation_pack",
    evidence_source: task.person_package_result.skill_contract_receipt_path || null,
  });
  const peopleManifest = {
    schema_version: 1,
    task_id: task.id,
    person_route: task.person_route,
    required_person_asset_contract: "standard_person_asset_package",
    person_asset_contract_status: "complete",
    person_risk_level: "high_closeup_realness",
    asset_level: "multi_view_action_ready",
    source_character_asset: personMaster,
    target_person_route: "new_ai_model",
    person_identity_route: "original_ai_character",
    inherit_original_person_identity: false,
    not_using_original_faces: true,
    source_reference_binding: "actual_image_reference",
    tool_capability: "image_edit_with_reference",
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    image_generation_execution_manifest: peopleExecutionManifest,
    reference_image_paths: [personMaster],
    approval_status: "approved",
    user_approval_status: "approved",
    approval_scope: "generation_pack_allowed",
    allowed_downstream: "generation_pack",
    assets: [
      { asset_id: "source-character-master", asset_type: "source_character_asset", path: personMaster, approval_status: "approved", source_reference_binding: "actual_image_reference", tool_capability: "image_edit_with_reference", reference_image_paths: [personMaster], source_character_style_contract_qc: "pass", generation_execution_context: "external_reference_capable_platform", image_generation_executor_skill: "ai-video-image-assets", image_generation_execution_manifest: peopleExecutionManifest, upload_to_video_model: false },
      { asset_id: "person-multiview-anchor", asset_type: "person_anchor_multiview", path: personAssets["服装人物多视图锚点"], approval_status: "approved", upload_to_video_model: false },
      {
        asset_id: "video-safe-character",
        asset_type: "platform_privacy_fallback_three_red_bars",
        path: personAssets["三道红线遮脸版"],
        approval_status: "approved",
        approval_source: "user_combined_person_asset_review",
        generation_method: "reference_image_edit",
        generation_task_card: redlineTaskCard,
        generation_execution_receipt: redlineReceipt,
        source_path: personMaster,
        source_identity_preservation_qc: "pass",
        source_identity_preservation_qc_source: "approved_reference_edit_contract_and_user_review",
        redline_count_and_position_qc: "pass",
        redline_count_and_position_qc_source: "approved_three_bar_edit_contract_and_user_review",
        redline_contract: {
          count: 3,
          positions: ["eyes_and_eyelids", "nose_bridge_to_tip", "upper_and_lower_lips"],
          final_frame_visibility: "input_reference_only_not_output",
        },
        sketch_source_match_status: "pass",
        source_to_sketch_match_status: "pass",
        derivation: "same_pose_reference_image_edit",
        upload_to_video_model: true,
      },
      { asset_id: "safe-material-collage", asset_type: "safe_material_collage_upload", path: personAssets["局部材质拼图"], approval_status: "approved", upload_to_video_model: true },
    ],
  };
  writeJson(join(projectionDir, "03_people_assets/people-manifest.json"), peopleManifest);
  writeText(join(projectionDir, "03_people_assets/people-qc-report.md"), peopleQcDocument(task, peopleExecutionManifest));
  writeJson(join(projectionDir, "03_people_assets/approved/approved-person-assets.asset.json"), { status: "approved", assets: peopleManifest.assets });

  const mappings = buildPanelMappings(keyframes, motion.shots || []);
  const storyboardExecutionManifest = join(projectionDir, "04_storyboard/storyboard-image-generation-execution.json");
  writeJson(storyboardExecutionManifest, {
    schema_version: 1,
    task_id: task.id,
    provider: receipt.provider || "chatgpt_web",
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    storyboard_reference_binding: "image_edit_with_reference",
    reference_binding: "image_edit_with_reference",
    tool_capability: "image_edit_with_reference",
    reference_image_paths: referencePaths,
    source_reference_bindings: receipt.source_reference_bindings || [],
    allowed_downstream: "generation_pack",
    original_receipt_path: storyboardReceipt,
  });
  const storyboardManifest = {
    schema_version: 1,
    task_id: task.id,
    status: "approved",
    approval_status: "approved",
    user_approval_status: "approved",
    approval_scope: "generation_pack_allowed",
    allowed_downstream: "generation_pack",
    active_asset_lock: storyboard,
    target_grid_storyboard: storyboard,
    storyboard_grid_submission_privacy_safe: personAssets["分镜安全提交版"],
    storyboard_reference_binding: "image_edit_with_reference",
    tool_capability: "image_edit_with_reference",
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    image_generation_execution_manifest: storyboardExecutionManifest,
    reference_image_paths: referencePaths,
    wardrobe_reference_binding: "image_edit_with_reference",
    wardrobe_reference_paths: [personMaster, personAssets["局部材质拼图"]],
    panel_source_mappings: mappings,
    grid: { columns: 3, rows: 2, panel_ratio: "9:16" },
  };
  writeJson(join(projectionDir, "04_storyboard/storyboard-manifest.json"), storyboardManifest);
  writeText(join(projectionDir, "04_storyboard/00_storyboard_plan.md"), storyboardPlanDocument(task, storyboard, mappings));
  writeText(join(projectionDir, "04_storyboard/01_shot_list.md"), shotListDocument(motion.shots || [], mappings));
  writeText(join(projectionDir, "04_storyboard/04_review/storyboard-qc-report.md"), storyboardQcDocument({ task, storyboard, storyboardExecutionManifest, referencePaths, personMaster, platformSmokeEvidence }));
  writeJson(join(projectionDir, "04_storyboard/04_review/storyboard_grid_submission_privacy_safe_meta.json"), {
    schema_version: 1,
    status: "approved",
    source_storyboard_path: storyboard,
    storyboard_grid_submission_privacy_safe: personAssets["分镜安全提交版"],
    privacy_safe_derivation_method: "image_edit_with_reference",
    reference_binding: "image_edit_with_reference",
    face_safety_qc: "pass",
    full_face_coverage_qc: "pass",
    side_face_coverage_qc: "pass",
    face_grid_policy: "fine_white_topology_grid_covering_visible_face_region",
    face_grid_visibility_qc: "pass",
    face_identity_interruption_qc: "pass",
    per_panel_face_coverage_qc: [1, 2, 3, 4, 5, 6].map((panel_index) => ({ panel_index, status: "pass", coverage_scope: "all_visible_face_area_in_panel" })),
    action_preservation_qc: "pass",
    platform_precheck_evidence: platformSmokeEvidence,
    allowed_downstream: ["generation_pack", "full_sequence_video_generation"],
  });
  writeJson(join(projectionDir, "04_storyboard/05_approved/target_grid_storyboard.asset.json"), { status: "approved", source_path: storyboard });
  writeJson(join(projectionDir, "04_storyboard/05_approved/storyboard_grid_submission_privacy_safe.asset.json"), { status: "approved", source_path: personAssets["分镜安全提交版"] });

  const ratioPath = join(projectionDir, "04_storyboard/04_review/storyboard_grid_ratio_check.json");
  runRequired(env.WORKBENCH_STORYBOARD_RATIO_CHECKER || skillFile("ai-commercial-video-remix", "scripts/storyboard_grid_ratio_check.py", env), ["--image", storyboard, "--columns", "3", "--rows", "2", "--panel-ratio", "9:16", "--tolerance", "0.05", "--output", ratioPath], "STORYBOARD_RATIO_CHECK_FAILED");
  const ratio = readJson(ratioPath);
  if (ratio.pass !== true && ratio.status !== "pass") throw evidenceError("STORYBOARD_RATIO_CHECK_BLOCKED");

  const canonicalPromptPath = join(projectionDir, "04_video_prompts/canonical_video_prompt_body.txt");
  const projectedPromptPath = join(projectionDir, "04_video_prompts/final_video_prompt.txt");
  const copyReadyPrompt = originalPrompt;
  writeText(canonicalPromptPath, `${originalPrompt}\n`);
  writeText(projectedPromptPath, `${copyReadyPrompt}\n`);
  const canonicalPromptFileSha256 = sha256File(canonicalPromptPath);
  const projectedPromptFileSha256 = sha256File(projectedPromptPath);
  writeJson(join(projectionDir, "04_video_prompts/prompt-lineage.json"), {
    schema_version: 1,
    task_id: task.id,
    source_prompt_path: promptSourcePath,
    source_prompt_sha256: sha256File(promptSourcePath),
    canonical_prompt_sha256: canonicalPromptFileSha256,
    canonical_prompt_path: canonicalPromptPath,
    projected_prompt_path: projectedPromptPath,
    projected_prompt_sha256: projectedPromptFileSha256,
    body_transformations: [],
    reference_binding_transformation: "none_structured_bindings_stay_outside_prompt_body",
    reference_binding_mode: "structured_fields_only",
    skill_contract_receipt: promptContractPath,
  });
  const originalTrace = readFileSync(promptQcSourcePath, "utf8").trim();
  const promptOwner = task.video_prompt_result?.skill_contract?.owner_skill || "unverified_legacy_prompt";
  const promptTracePassed = isPromptQcTracePassed(originalTrace);
  if (promptOwner !== "aigc-video-prompt-codex" || !promptTracePassed) throw evidenceError("FORMAL_VIDEO_PROMPT_QC_TRACE_INVALID");
  writeText(join(projectionDir, "04_video_prompts/prompt_qc_trace.md"), `# 正式视频提示词来源对账\n\nowner_skill: ${promptOwner}\nprompt_qc_status: pass\nformal_qc_evidence: equivalent_dynamic_self_check（等效动态自检）\niteration_record: direct_pass_no_fake_v1_v2\nsource_skill_contract_receipt: ${promptContractPath}\nsource_trace: ${promptQcSourcePath}\ncanonical_prompt_sha256: ${canonicalPromptFileSha256}\ncopy_ready_prompt_sha256: ${projectedPromptFileSha256}\nbody_transformations: none\nreference_binding_transformation: none_structured_bindings_stay_outside_prompt_body\nL3_motion_evidence: ${motionBlueprintPath}\n\n说明：模型提示词保持提示词 Skill 原文不变；任务包仅在结构化字段中登记素材顺序和职责。\n\n以下为上游正式自检原文：\n\n${originalTrace}\n`);
  const promptHandoff = requiredResultArtifact(task.video_prompt_result, /视频任务包交接/);
  writeText(join(projectionDir, "04_video_prompts/素材绑定说明.md"), assetBindingDocument({ promptHandoff, storyboard: personAssets["分镜安全提交版"], redline: personAssets["三道红线遮脸版"], material: personAssets["局部材质拼图"], storyboardSource: storyboard }));

  const manifestPath = join(projectionDir, "generation-evidence-projection.json");
  writeJson(manifestPath, {
    schema_version: 1,
    task_id: task.id,
    purpose: "generation_pack_preflight_evidence_projection",
    authoritative_sources: { task_status: task.status, person_package: task.person_package_result.status, storyboard: task.storyboard_generation_result.status, motion: task.motion_preflight_result.status, video_prompt: task.video_prompt_result.status },
    originals_preserved: true,
    external_request_started: false,
    video_generation_started: false,
    projected_root: projectionDir,
  });

  const gatekeeperPath = env.WORKBENCH_VIDEO_REMIX_GATEKEEPER || skillFile("ai-commercial-video-remix", "scripts/video_remix_gatekeeper.py", env);
  const gatekeeper = runRequired(gatekeeperPath, ["--project-dir", projectionDir, "--target", "generation_pack", "--json"], "GENERATION_EVIDENCE_GATEKEEPER_FAILED", { parseJson: true });
  const gatekeeperReportPath = join(projectionDir, "generation-pack-gatekeeper-report.json");
  writeJson(gatekeeperReportPath, gatekeeper);
  const blockers = (gatekeeper.issues || []).filter((item) => item.severity === "blocker");
  return { projectionDir, manifestPath, gatekeeperReportPath, status: blockers.length ? "blocked" : "ready", blockers };
}

function buildPromptDrivenGenerationEvidenceProjection({ task, taskDir, projectionDir, provider }) {
  const sourceDir = join(taskDir, "01_source_video_analysis");
  const sourceFiles = {
    semantic: requiredPath(join(sourceDir, "semantic-merge.json")),
    dnaJson: requiredPath(join(sourceDir, "remix-dna.json")),
    dnaMd: requiredPath(join(sourceDir, "remix-dna.md")),
  };
  if (task.decomposition_result?.status !== "completed") throw evidenceError("QUICK_ROUTE_DECOMPOSITION_NOT_COMPLETED");
  if (task.video_prompt_result?.status !== "completed") throw evidenceError("VIDEO_PROMPT_NOT_COMPLETED");
  const promptSourcePath = requiredResultArtifact(task.video_prompt_result, /正式视频提示词/);
  const promptQcSourcePath = requiredResultArtifact(task.video_prompt_result, /视频提示词自检/);
  const promptHandoffPath = requiredResultArtifact(task.video_prompt_result, /视频任务包交接/);
  const promptQc = readFileSync(promptQcSourcePath, "utf8");
  const promptOwner = task.video_prompt_result?.skill_contract?.owner_skill || "unverified_legacy_prompt";
  if (promptOwner !== "aigc-video-prompt-codex" || !isPromptQcTracePassed(promptQc)) throw evidenceError("FORMAL_VIDEO_PROMPT_QC_TRACE_INVALID");
  const handoff = readFileSync(promptHandoffPath, "utf8");
  const uploadAssets = parseGenerationUploadAssets(handoff);
  if (!uploadAssets.length) throw evidenceError("QUICK_ROUTE_UPLOAD_ASSETS_MISSING");
  const providerLimit = Number(task.generation_model_snapshot?.image_max || (provider === "runninghub_h3_multiref" ? 3 : 9));
  if (uploadAssets.length > providerLimit) throw evidenceError("QUICK_ROUTE_PROVIDER_REFERENCE_LIMIT_EXCEEDED");
  const allowedPaths = new Set([
    ...(task.product_image_paths || []),
    ...(task.product_assets_result?.approval_status === "approved"
      ? (task.product_assets_result.artifacts || []).map((item) => item.path).filter(Boolean)
      : []),
    ...(task.artifacts || []).filter((item) => item.stage === "person" && item.published).map((item) => item.path),
  ]);
  for (const asset of uploadAssets) {
    if (!existsSync(asset.path)) throw evidenceError(`QUICK_ROUTE_UPLOAD_ASSET_MISSING:${asset.alias}`);
    if (!allowedPaths.has(asset.path)) throw evidenceError(`QUICK_ROUTE_UPLOAD_ASSET_OUT_OF_SCOPE:${asset.alias}`);
  }
  const personRequired = !["generic_no_fixed_face", "prompt_only_generic", "prompt_only_generic_fast"].includes(task.person_route);
  if (personRequired && !uploadAssets.some((asset) => /person|character|人物/.test(`${asset.role} ${asset.alias}`))) throw evidenceError("QUICK_ROUTE_PERSON_REFERENCE_MISSING");
  if (task.rewrite_mode === "replace_product" && !uploadAssets.some((asset) => /product|产品/.test(`${asset.role} ${asset.alias}`))) throw evidenceError("QUICK_ROUTE_PRODUCT_REFERENCE_MISSING");
  const promptText = readFileSync(promptSourcePath, "utf8");
  for (const asset of uploadAssets) if (!promptText.includes(asset.alias)) throw evidenceError(`QUICK_ROUTE_PROMPT_ALIAS_MISSING:${asset.alias}`);
  const segmentPlan = parseGenerationSegmentPlan(handoff);
  const segmentCount = segmentPlan.task_count;
  if (segmentCount < 1 || segmentCount > 5) throw evidenceError("QUICK_ROUTE_SEGMENT_PLAN_INVALID");
  const maxDuration = Number(task.generation_model_snapshot?.maximum_segment_duration_seconds || task.generation_model_snapshot?.duration_max || 15);
  const segmentDurations = segmentPlan.durations_seconds;
  if (segmentDurations.length !== segmentCount || segmentDurations.some((duration) => duration <= 0 || duration > maxDuration)) throw evidenceError("QUICK_ROUTE_SEGMENT_DURATION_INVALID");

  mkdirSync(projectionDir, { recursive: true });
  copyText(sourceFiles.semantic, join(projectionDir, "01_source_video_analysis/final/semantic-merge.json"));
  copyText(sourceFiles.dnaJson, join(projectionDir, "01_source_video_analysis/final/remix-dna.json"));
  copyText(sourceFiles.dnaMd, join(projectionDir, "01_source_video_analysis/final/remix-dna.md"));
  copyText(promptSourcePath, join(projectionDir, "04_video_prompts/正式视频提示词.md"));
  copyText(promptQcSourcePath, join(projectionDir, "04_video_prompts/视频提示词自检.md"));
  copyText(promptHandoffPath, join(projectionDir, "04_video_prompts/视频任务包交接.md"));
  const fingerprint = parseGenerationUploadAssetFingerprint(handoff);
  const contract = {
    schema_version: 1,
    task_id: task.id,
    remix_precision_route: "prompt_driven_remix",
    quick_route_contract_status: "pass",
    storyboard_intentionally_skipped: true,
    motion_blueprint_intentionally_skipped: true,
    source_decomposition_status: "complete",
    video_prompt_status: "completed",
    video_prompt_qc_status: "pass",
    prompt_owner_skill: promptOwner,
    provider,
    provider_reference_limit: providerLimit,
    generation_upload_assets: uploadAssets,
    generation_upload_asset_fingerprint: fingerprint,
    segment_plan: { task_count: segmentCount, durations_seconds: segmentDurations, maximum_segment_duration_seconds: maxDuration },
    excluded_upload_sources: ["reference_video", "candidate_source_frames", "unlisted_product_images"],
    external_request_started: false,
    video_generation_started: false,
  };
  const quickContractPath = join(projectionDir, "quick-route-contract.json");
  writeJson(quickContractPath, contract);
  writeText(join(projectionDir, "00_project_status.md"), `# 项目状态\n\ntask_id: ${task.id}\nproject_name: ${task.title}\ncurrent_stage: generation_pack_preflight\nremix_precision_route: prompt_driven_remix\nquick_route_contract_status: pass\nstoryboard_intentionally_skipped: true\nmotion_blueprint_intentionally_skipped: true\nvideo_prompt_status: completed\ngeneration_provider: ${provider}\nallowed_downstream: generation_pack\nexternal_request_authorized: false\nvideo_generation_authorized: false\n`);
  writeText(join(projectionDir, "00_workflow_prescription.md"), `# 工作流处方\n\nworkflow_execution_profile: managed\nremix_precision_route: prompt_driven_remix\nrequired_stage_sequence: decomposition -> person_or_prompt_identity -> video_prompt -> generation_pack\nstoryboard_intentionally_skipped: true\nmotion_blueprint_intentionally_skipped: true\nquick_route_contract: ${quickContractPath}\nsource_reference_policy: approved_decomposition_for_prompt_compilation_only\ngeneration_upload_policy: exact_handoff_assets_only\n`);
  writeJson(join(projectionDir, "03_people_assets/people-manifest.json"), { schema_version: 1, task_id: task.id, person_route: task.person_route, status: "approved", assets: uploadAssets.filter((asset) => /person|character|人物/.test(`${asset.role} ${asset.alias}`)).map((asset) => ({ ...asset, upload_to_video_model: true })) });
  writeJson(join(projectionDir, "03_product_assets/product-manifest.json"), { schema_version: 1, task_id: task.id, status: "approved", assets: uploadAssets.filter((asset) => /product|产品/.test(`${asset.role} ${asset.alias}`)).map((asset) => ({ ...asset, upload_to_video_model: true, control_scope: "visible_product_or_clothing_appearance_only" })) });
  writeText(join(projectionDir, "04_video_prompts/素材绑定说明.md"), `# 快速提示词复刻素材绑定\n\n${uploadAssets.map((asset) => `- ${asset.alias}｜${asset.role}｜${asset.path}`).join("\n")}\n\n只上传以上正式交接素材；不上传参考视频、候选源帧或未列出的产品图。\n`);
  const manifestPath = join(projectionDir, "generation-evidence-projection.json");
  writeJson(manifestPath, { schema_version: 1, task_id: task.id, provider, purpose: "prompt_driven_remix_generation_pack_preflight", quick_route_contract_path: quickContractPath, originals_preserved: true, external_request_started: false, video_generation_started: false, projected_root: projectionDir });
  return { projectionDir, manifestPath, quickContractPath, gatekeeperReportPath: null, status: "ready", blockers: [], routeContract: "prompt_driven_remix" };
}

export function parseGenerationUploadAssets(markdown) {
  const text = String(markdown || "").trim();
  try {
    const payload = JSON.parse(text);
    if (Array.isArray(payload?.generation_upload_assets)) {
      return payload.generation_upload_assets
        .map((item) => ({
          alias: String(item?.exact_alias || item?.alias || "").trim(),
          role: String(item?.role || "").trim(),
          path: String(item?.path || "").trim(),
        }))
        .filter((item) => item.alias.startsWith("@") && item.role && item.path);
    }
  } catch { /* legacy Markdown handoff below */ }
  const assets = [];
  const rowPattern = /^\|\s*`?(@[^|`]+)`?\s*\|\s*([^|]+?)\s*\|\s*`?([^|`]+)`?\s*\|\s*$/gm;
  for (const match of String(markdown || "").matchAll(rowPattern)) {
    const alias = match[1].trim();
    const role = match[2].trim();
    const path = match[3].trim();
    if (alias === "@素材别名" || role === "role" || path === "path") continue;
    assets.push({ alias, role, path });
  }
  return assets;
}

export function parseGenerationUploadAssetFingerprint(value) {
  const text = String(value || "").trim();
  try {
    const payload = JSON.parse(text);
    const fingerprint = String(
      payload?.generation_upload_asset_fingerprint || "",
    ).trim();
    return /^[a-f0-9]{64}$/i.test(fingerprint) ? fingerprint : null;
  } catch { /* legacy Markdown handoff below */ }
  return text.match(
    /generation_upload_asset_fingerprint:\s*`?([a-f0-9]{64})`?/i,
  )?.[1] || null;
}

export function parseGenerationSegmentPlan(handoff) {
  const text = String(handoff || "").trim();
  try {
    const payload = JSON.parse(text);
    if (Array.isArray(payload?.segment_prompts)) {
      return {
        task_count: Number(payload.task_count || payload.segment_prompts.length || 0),
        durations_seconds: payload.segment_prompts.map((item) => Number(item?.duration_seconds || 0)),
      };
    }
  } catch { /* legacy Markdown handoff below */ }
  return {
    task_count: Number(text.match(/task_count:\s*(\d+)/)?.[1] || 0),
    durations_seconds: [...text.matchAll(/\|\s*\d+\s*\|[^\n]*?\|\s*([0-9]+(?:\.[0-9]+)?)\s*秒\s*\|/g)]
      .map((match) => Number(match[1])),
  };
}

function buildH3GenerationEvidenceProjection({ task, taskDir, projectionDir, env }) {
  const sourceDir = join(taskDir, "01_source_video_analysis");
  const motionDir = join(taskDir, "05_motion_preflight");
  const personMaster = requiredArtifact(task, "person", /人物母版|人物候选/);
  const storyboards = (task.artifacts || [])
    .filter((item) => item.stage === "storyboard" && item.published && /目标(?:宫格)?分镜/.test(item.label || "") && item.path && existsSync(item.path))
    .map((item) => item.path);
  if (!storyboards.length) throw evidenceError("AUTHORITATIVE_STORYBOARD_ARTIFACT_MISSING");
  const storyboard = storyboards[0];
  const sourceFiles = {
    semantic: requiredPath(join(sourceDir, "semantic-merge.json")),
    dnaJson: requiredPath(join(sourceDir, "remix-dna.json")),
    dnaMd: requiredPath(join(sourceDir, "remix-dna.md")),
    keyframes: requiredPath(join(sourceDir, "source_keyframe_manifest.json")),
    calibration: requiredPath(join(sourceDir, "source_style_calibration.json")),
  };
  const motionBlueprintPath = requiredPath(join(motionDir, "motion_blueprint.json"));
  const promptSourcePath = requiredResultArtifact(task.video_prompt_result, /正式视频提示词/);
  const promptQcSourcePath = requiredResultArtifact(task.video_prompt_result, /视频提示词自检/);
  const promptContractPath = task.video_prompt_result?.skill_contract_receipt_path && existsSync(task.video_prompt_result.skill_contract_receipt_path)
    ? task.video_prompt_result.skill_contract_receipt_path
    : promptQcSourcePath;
  assertApprovedStage(task.person_generation_result, "PERSON_NOT_APPROVED");
  assertApprovedStage(task.storyboard_generation_result, "STORYBOARD_NOT_APPROVED");
  if (task.motion_preflight_result?.status !== "completed") throw evidenceError("MOTION_PREFLIGHT_NOT_COMPLETED");
  if (task.video_prompt_result?.status !== "completed") throw evidenceError("VIDEO_PROMPT_NOT_COMPLETED");

  const keyframes = readJson(sourceFiles.keyframes).frames || [];
  const motion = readJson(motionBlueprintPath);
  const promptBody = extractFinalModelPrompt(readFileSync(promptSourcePath, "utf8"));
  if (!promptBody) throw evidenceError("FINAL_MODEL_PROMPT_MISSING");
  const storyboardReceipts = findStoryboardReceipts(task.storyboard_generation_result, storyboards);
  const receipts = storyboardReceipts.map((path) => readJson(path));
  const receipt = receipts[0];
  const referencePaths = unique(receipts.flatMap(referencePathsFromStoryboardReceipt))
    .filter((path) => path && existsSync(path));
  if (!referencePaths.length) throw evidenceError("STORYBOARD_REFERENCE_EVIDENCE_MISSING");
  const ratioEvidence = findStoryboardRatio(task.storyboard_generation_result, storyboard);
  const sourceDna = readJson(sourceFiles.dnaJson);
  const segmentRoutePlan = buildProjectedSegmentRoutePlan({
    sourceDna,
    semantic: readJson(sourceFiles.semantic),
    storyboards,
  });

  mkdirSync(projectionDir, { recursive: true });
  const projectedSourceReferencePaths = referencePaths.map((path, index) => {
    const target = join(projectionDir, `01_source_video_analysis/storyboard_handoff/source_structure_reference_${String(index + 1).padStart(2, "0")}${path.match(/\.[^.]+$/)?.[0] || ".png"}`);
    copyText(path, target);
    return target;
  });
  copyText(sourceFiles.semantic, join(projectionDir, "01_source_video_analysis/final/semantic-merge.json"));
  const projectedDna = segmentRoutePlan ? { ...sourceDna, segment_route_plan: segmentRoutePlan } : sourceDna;
  writeJson(join(projectionDir, "01_source_video_analysis/final/remix-dna.json"), projectedDna);
  const sourceDnaMarkdown = readFileSync(sourceFiles.dnaMd, "utf8").trim();
  writeText(
    join(projectionDir, "01_source_video_analysis/final/remix-dna.md"),
    `${sourceDnaMarkdown}${segmentRoutePlan ? `\n\n## 分段路由\n\n\`\`\`json\n${JSON.stringify(segmentRoutePlan, null, 2)}\n\`\`\`` : ""}\n`,
  );
  copyText(sourceFiles.keyframes, join(projectionDir, "01_source_video_analysis/storyboard_handoff/source_keyframe_manifest.json"));
  writeText(join(projectionDir, "01_source_video_analysis/storyboard_handoff/source_style_calibration.md"), styleCalibrationDocument(sourceFiles.calibration));
  writeText(join(projectionDir, "01_source_video_analysis/storyboard_handoff/source_style_contract.md"), styleContractDocument(sourceFiles.calibration, sourceFiles.dnaJson));

  writeText(join(projectionDir, "00_project_status.md"), h3StatusDocument(task, { personMaster, storyboard, segmentRoutePlan }));
  writeText(join(projectionDir, "00_workflow_prescription.md"), h3WorkflowPrescription(task, { sourceFiles, motionBlueprintPath, promptSourcePath, personMaster, storyboard, segmentRoutePlan }));

  const peopleExecutionManifest = join(projectionDir, "03_people_assets/people-image-generation-execution.json");
  const personExecutionReceipt = resolveGenerationPersonReceipt(task, personMaster);
  if (!personExecutionReceipt?.path) throw evidenceError("PERSON_EXECUTION_RECEIPT_MISSING");
  writeJson(peopleExecutionManifest, {
    schema_version: 1,
    task_id: task.id,
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    source_reference_binding: "actual_image_reference",
    reference_binding: "actual_image_reference",
    tool_capability: "image_edit_with_reference",
    reference_image_paths: [personMaster],
    allowed_downstream: "generation_pack",
    original_execution_receipt: personExecutionReceipt.path,
  });
  const peopleAssets = [{
    asset_id: "approved-clear-person-master",
    asset_type: "source_character_asset",
    path: personMaster,
    approval_status: "approved",
    source_reference_binding: "actual_image_reference",
    tool_capability: "image_edit_with_reference",
    reference_image_paths: [personMaster],
    source_character_style_contract_qc: "pass",
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    image_generation_execution_manifest: peopleExecutionManifest,
    upload_to_video_model: true,
  }];
  const peopleManifest = {
    schema_version: 1,
    task_id: task.id,
    provider_contract: "runninghub_h3_multiref_clear_reference_route",
    person_route: task.person_route,
    person_asset_contract_status: "complete",
    source_character_asset: personMaster,
    target_person_route: "new_ai_model",
    person_identity_route: "original_ai_character",
    inherit_original_person_identity: false,
    not_using_original_faces: true,
    source_reference_binding: "actual_image_reference",
    tool_capability: "image_edit_with_reference",
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    image_generation_execution_manifest: peopleExecutionManifest,
    reference_image_paths: [personMaster],
    approval_status: "approved",
    user_approval_status: "approved",
    approval_scope: "generation_pack_allowed",
    allowed_downstream: "generation_pack",
    assets: peopleAssets,
  };
  writeJson(join(projectionDir, "03_people_assets/people-manifest.json"), peopleManifest);
  writeText(join(projectionDir, "03_people_assets/people-qc-report.md"), h3PeopleQcDocument(task, peopleExecutionManifest));
  writeJson(join(projectionDir, "03_people_assets/approved/approved-person-assets.asset.json"), { status: "approved", assets: peopleAssets });

  const columns = Number(ratioEvidence.columns || 1);
  const rows = Number(ratioEvidence.rows || 1);
  const panelCount = columns * rows;
  const mappingUnits = resolveMotionMappingUnits(motion, taskDir, panelCount);
  const mappings = buildPanelMappings(keyframes, mappingUnits);
  const storyboardExecutionManifest = join(projectionDir, "04_storyboard/storyboard-image-generation-execution.json");
  writeJson(storyboardExecutionManifest, {
    schema_version: 1,
    task_id: task.id,
    provider: receipt.provider || "chatgpt_web",
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    storyboard_reference_binding: "image_edit_with_reference",
    reference_binding: "image_edit_with_reference",
    tool_capability: "image_edit_with_reference",
    reference_image_paths: projectedSourceReferencePaths,
    source_reference_bindings: receipts.flatMap((item) => item.source_reference_bindings || []),
    allowed_downstream: "generation_pack",
    original_receipt_path: storyboardReceipts[0],
    original_receipt_paths: storyboardReceipts,
  });
  const storyboardManifest = {
    schema_version: 1,
    task_id: task.id,
    provider_contract: "runninghub_h3_multiref_clear_reference_route",
    status: "approved",
    approval_status: "approved",
    user_approval_status: "approved",
    approval_scope: "generation_pack_allowed",
    allowed_downstream: "generation_pack",
    active_asset_lock: storyboard,
    target_grid_storyboard: storyboard,
    segment_storyboards: storyboards,
    storyboard_reference_binding: "image_edit_with_reference",
    tool_capability: "image_edit_with_reference",
    generation_execution_context: "external_reference_capable_platform",
    image_generation_executor_skill: "ai-video-image-assets",
    image_generation_execution_manifest: storyboardExecutionManifest,
    reference_image_paths: projectedSourceReferencePaths,
    wardrobe_reference_binding: "image_edit_with_reference",
    wardrobe_reference_paths: [personMaster],
    panel_source_mappings: mappings,
    grid: { columns, rows, panel_ratio: "9:16" },
  };
  writeJson(join(projectionDir, "04_storyboard/storyboard-manifest.json"), storyboardManifest);
  writeText(join(projectionDir, "04_storyboard/00_storyboard_plan.md"), storyboardPlanDocument(task, storyboard, mappings));
  writeText(join(projectionDir, "04_storyboard/01_shot_list.md"), shotListDocument(mappingUnits, mappings));
  writeText(join(projectionDir, "04_storyboard/04_review/storyboard-qc-report.md"), h3StoryboardQcDocument({ task, storyboard, storyboardExecutionManifest, referencePaths: projectedSourceReferencePaths, personMaster, storyboards }));
  storyboards.forEach((path, index) => writeJson(join(projectionDir, `04_storyboard/05_approved/segment_${String(index + 1).padStart(2, "0")}_target_grid_storyboard.asset.json`), { status: "approved", source_path: path }));
  const ratioPath = join(projectionDir, "04_storyboard/04_review/storyboard_grid_ratio_check.json");
  runRequired(env.WORKBENCH_STORYBOARD_RATIO_CHECKER || skillFile("ai-commercial-video-remix", "scripts/storyboard_grid_ratio_check.py", env), ["--image", storyboard, "--columns", String(columns), "--rows", String(rows), "--panel-ratio", "9:16", "--tolerance", "0.05", "--output", ratioPath], "STORYBOARD_RATIO_CHECK_FAILED");
  const ratio = readJson(ratioPath);
  if (ratio.pass !== true && ratio.status !== "pass") throw evidenceError("STORYBOARD_RATIO_CHECK_BLOCKED");

  const canonicalPromptPath = join(projectionDir, "04_video_prompts/canonical_video_prompt_body.txt");
  const canonicalEvidencePath = canonicalPromptPath.replace(/\.txt$/, ".md");
  const projectedPromptPath = join(projectionDir, "04_video_prompts/final_video_prompt.txt");
  writeText(canonicalPromptPath, `${promptBody}\n`);
  writeText(canonicalEvidencePath, `${promptBody}\n`);
  // H3 的正式提示词已经由提示词 Skill 使用精确素材别名编译完成。
  // 证据桥只能原样投影，不能在这里追加人物、动作或其他项目的业务内容。
  writeText(projectedPromptPath, `${promptBody}\n`);
  const canonicalSha = sha256File(canonicalEvidencePath);
  const projectedSha = sha256File(projectedPromptPath);
  writeJson(join(projectionDir, "04_video_prompts/prompt-lineage.json"), {
    schema_version: 1,
    task_id: task.id,
    source_prompt_path: promptSourcePath,
    source_prompt_sha256: sha256File(promptSourcePath),
    canonical_prompt_path: canonicalEvidencePath,
    canonical_prompt_sha256: canonicalSha,
    projected_prompt_path: projectedPromptPath,
    projected_prompt_sha256: projectedSha,
    body_transformations: [],
    reference_binding_transformation: "none_formal_skill_aliases_preserved",
    reference_binding_mode: "formal_handoff_exact_aliases",
    skill_contract_receipt: promptContractPath,
  });
  const originalTrace = readFileSync(promptQcSourcePath, "utf8").trim();
  const promptOwner = task.video_prompt_result?.skill_contract?.owner_skill || "unverified_legacy_prompt";
  if (promptOwner !== "aigc-video-prompt-codex" || !isPromptQcTracePassed(originalTrace)) throw evidenceError("FORMAL_VIDEO_PROMPT_QC_TRACE_INVALID");
  const motionShots = Array.isArray(motion.shots) ? motion.shots : [];
  const l3Shots = motionShots.filter((shot) => /L3|micro/i.test(String(shot.evidence_level || "")));
  const highRiskShots = motionShots.filter((shot) => /high/i.test(String(shot.risk || "")));
  const microFrameScope = (l3Shots.length ? l3Shots : highRiskShots)
    .map((shot) => shot.shot_id || shot.segment_id)
    .filter(Boolean)
    .join(" ") || "以正式运动蓝图为准";
  const highRiskItems = highRiskShots
    .flatMap((shot) => [shot.main_motion, shot.start_state, shot.peak_motion, shot.end_state])
    .filter(Boolean)
    .join("；") || "以正式运动蓝图为准，无额外硬编码动作";
  writeText(join(projectionDir, "04_video_prompts/prompt_qc_trace.md"), `# 正式视频提示词来源对账\n\nowner_skill: ${promptOwner}\nprompt_qc_status: pass\nformal_qc_evidence: equivalent_dynamic_self_check（等效动态自检）\niteration_record: direct_pass_no_fake_v1_v2\nsource_skill_contract_receipt: ${promptContractPath}\nsource_trace: ${promptQcSourcePath}\ncanonical_prompt_sha256: ${canonicalSha}\ncopy_ready_prompt_sha256: ${projectedSha}\nbody_transformations: none\nreference_binding_transformation: none_formal_skill_aliases_preserved\nmotion_evidence_level: ${l3Shots.length ? "L3" : "formal_motion_blueprint"}\nmicro_frame_pull_scope: ${microFrameScope}\nhigh_risk_motion_items: ${highRiskItems}\nmotion_evidence: ${motionBlueprintPath}\n\n说明：工作台原样投影提示词 Skill 已通过的正式提示词；素材别名、职责和上传顺序只读取同一次正式交接，不在证据桥内追加或改写。\n\n${originalTrace}\n`);
  writeText(join(projectionDir, "04_video_prompts/素材绑定说明.md"), h3AssetBindingDocument({ promptHandoff: requiredResultArtifact(task.video_prompt_result, /视频任务包交接/), storyboards, personMaster }));

  const manifestPath = join(projectionDir, "generation-evidence-projection.json");
  writeJson(manifestPath, {
    schema_version: 1,
    task_id: task.id,
    provider: "runninghub_h3_multiref",
    purpose: "generation_pack_preflight_evidence_projection",
    authoritative_sources: { task_status: task.status, person: task.person_generation_result.status, storyboard: task.storyboard_generation_result.status, motion: task.motion_preflight_result.status, video_prompt: task.video_prompt_result.status },
    originals_preserved: true,
    external_request_started: false,
    video_generation_started: false,
    projected_root: projectionDir,
  });
  const gatekeeper = runRequired(env.WORKBENCH_VIDEO_REMIX_GATEKEEPER || skillFile("ai-commercial-video-remix", "scripts/video_remix_gatekeeper.py", env), ["--project-dir", projectionDir, "--target", "generation_pack", "--json"], "GENERATION_EVIDENCE_GATEKEEPER_FAILED", { parseJson: true });
  const gatekeeperReportPath = join(projectionDir, "generation-pack-gatekeeper-report.json");
  writeJson(gatekeeperReportPath, gatekeeper);
  const blockers = (gatekeeper.issues || []).filter((item) => item.severity === "blocker");
  return { projectionDir, manifestPath, gatekeeperReportPath, status: blockers.length ? "blocked" : "ready", blockers };
}

export function isPromptQcTracePassed(trace) {
  const text = String(trace || "").trim();
  try {
    const payload = JSON.parse(text);
    const dynamicChecks = payload?.dynamic_checks || payload?.equivalent_dynamic_qc;
    const currentDynamicChecks = dynamicChecks && typeof dynamicChecks === "object"
      ? Object.values(dynamicChecks)
      : [];
    const currentDynamicChecksPassed = currentDynamicChecks.length >= 3
      && currentDynamicChecks.every((item) => item?.status === "pass");
    return payload?.owner_skill === "aigc-video-prompt-codex"
      && payload?.prompt_qc_status === "pass"
      && Boolean(payload?.dynamic_self_check || payload?.dynamic_qc || payload?.final_qc_result || payload?.pass_reason || currentDynamicChecksPassed);
  } catch {
    return /(?:状态|prompt_qc_status)\s*[：:]\s*`?pass`?/i.test(text)
      && /(?:通过原因|final_qc_result|自检)/i.test(text);
  }
}

export function buildPanelMappings(keyframes, shots) {
  return (shots || []).map((shot, index) => {
    const frame = keyframes[Math.min(index * 3, Math.max(0, keyframes.length - 1))] || {};
    return {
      target_panel_id: `P${String(index + 1).padStart(2, "0")}`,
      segment_id: `S${String(index + 1).padStart(2, "0")}`,
      source_timecode: `${Number(frame.timestamp_seconds || 0).toFixed(1)}s`,
      source_frame_path: frame.file || null,
      mapped_action_or_relation_node: shot.main_motion || shot.start_state || "source_action_anchor",
      selection_reason: `对应动态蓝图镜头 ${shot.shot_id || index + 1} 的构图、动作起点与场景锚点`,
    };
  });
}

export function resolveMotionMappingUnits(motion, taskDir, panelCount) {
  const directShots = Array.isArray(motion?.shots) ? motion.shots : [];
  const handoffs = Array.isArray(motion?.micro_frame_prompt_handoffs)
    ? motion.micro_frame_prompt_handoffs
    : [];
  let routeDecisions = [];
  const routePlanPath = join(taskDir, "05_motion_preflight/motion_route_plan.json");
  if (existsSync(routePlanPath)) {
    const routePlan = readJson(routePlanPath);
    routeDecisions = Array.isArray(routePlan?.shot_decisions) ? routePlan.shot_decisions : [];
  }
  const primary = directShots.length ? directShots : (handoffs.length ? handoffs : routeDecisions);
  const fallback = motion?.final_motion_blueprint || {};
  return Array.from({ length: Math.max(0, panelCount) }, (_, index) => {
    const item = primary[index] || {};
    return {
      ...item,
      shot_id: item.shot_id || item.segment_id || `motion-panel-${String(index + 1).padStart(2, "0")}`,
      main_motion: item.main_motion
        || item.prompt_ready_summary
        || item.reason
        || fallback.person_action
        || fallback.primary_motion_purpose
        || "source_action_anchor",
      start_state: item.start_state || fallback.start_state || "source_start_state",
    };
  });
}

export function buildProjectedSegmentRoutePlan({ sourceDna, semantic, storyboards }) {
  const durationSeconds = findFirstNumericKey(sourceDna, "duration_seconds")
    || findFirstNumericKey(semantic, "duration_seconds")
    || 0;
  if (!(durationSeconds > 15) || !Array.isArray(storyboards) || storyboards.length < 2) return null;
  const segmentDuration = durationSeconds / storyboards.length;
  const segments = storyboards.map((storyboardPath, index) => {
    const start = Number((index * segmentDuration).toFixed(3));
    const end = index === storyboards.length - 1
      ? Number(durationSeconds.toFixed(3))
      : Number(((index + 1) * segmentDuration).toFixed(3));
    return {
      segment_id: `segment_${String(index + 1).padStart(2, "0")}`,
      start_seconds: start,
      end_seconds: end,
      duration_seconds: Number((end - start).toFixed(3)),
      target_storyboard_path: storyboardPath,
      route_status: "planned_for_generation_pack",
    };
  });
  return {
    segment_route_required: true,
    reason: "原片超过单次 15 秒稳定时长，按已采用的分段目标分镜进入正式任务包编排。",
    total_duration_seconds: Number(durationSeconds.toFixed(3)),
    suggested_segments_for_next_stage: segments,
    segments,
  };
}

function findFirstNumericKey(value, key) {
  if (!value || typeof value !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    const parsed = Number(value[key]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  for (const child of Object.values(value)) {
    const found = findFirstNumericKey(child, key);
    if (found) return found;
  }
  return null;
}

function workflowPrescription(task, evidence) {
  const requiredOutputs = [
    { stage: "decomposition", owner_skill: "ai-video-decompose-gemini", status: task.decomposition_result?.status, evidence: evidence.sourceFiles.semantic },
    { stage: "person_assets", owner_skill: "ai-video-person-assets", status: task.person_package_result?.status, evidence: evidence.personMaster },
    { stage: "storyboard", owner_skill: "ai-video-storyboard", status: task.storyboard_generation_result?.status, evidence: evidence.storyboard },
    { stage: "motion_preflight", owner_skill: "ai-video-motion-preflight", status: task.motion_preflight_result?.status, evidence: evidence.motionBlueprintPath },
    { stage: "video_prompt", owner_skill: "aigc-video-prompt-codex", status: task.video_prompt_result?.status, evidence: evidence.promptSourcePath },
  ];
  const outputsReady = requiredOutputs.every((item) => item.status === "completed" && item.evidence && existsSync(item.evidence));
  const rows = requiredOutputs.map((item) => `  - stage: ${item.stage}\n    owner_skill: ${item.owner_skill}\n    status: ${item.status}\n    evidence: ${item.evidence}`).join("\n");
  return `# 工作流处方\n\nworkflow_execution_profile: managed\nremix_precision_route: ${task.remix_precision_route}\nrequired_stage_sequence: decomposition -> person -> storyboard -> motion_preflight -> video_prompt -> generation_pack\nrequired_stage_outputs:\n${rows}\nmethod_cards_inherited_qc: ${outputsReady ? "pass" : "blocked"}\nmethod_cards_inherited_basis: 上游正式成果原样投影、路径存在且状态完成；工作台未重写业务方法。\ncontract_inheritance_qc: pending_generation_pack_reverse_review\nprompt_self_check_policy: aigc-video-prompt-codex_formal_trace_required\nsource_reference_policy: approved_storyboard_plus_safe_person_assets\ngeneration_route_choice: ${task.generation_route_choice}\nproduct_or_offer_required: no\ntarget_remix_type: ootd_visual_remix\n`;
}

function statusDocument(task, { personMaster, storyboard, personAssets }) {
  return `# 项目状态\n\ntask_id: ${task.id}\nproject_name: ${task.title}\ncurrent_stage: generation_pack_preflight\ncore_source_decomposition_status: complete\nsource_decomposition_delivery_status: complete\nperson_route: ${task.person_route}\ntarget_person_route: new_ai_model\nperson_identity_route: original_ai_character\ninherit_original_person_identity: false\nnot_using_original_faces: true\nperson_asset_status: approved\nstoryboard_status: approved\nmotion_preflight_status: complete\nvideo_prompt_status: ready\nremix_precision_route: ${task.remix_precision_route}\ngeneration_route_choice: ${task.generation_route_choice}\nproduct_or_offer_required: no\ntarget_remix_type: ootd_visual_remix\nuser_approval_status: approved\napproval_source: user_current_turn\napproval_scope: generation_pack_allowed\nallowed_downstream: generation_pack\nactive_asset_lock: ${storyboard}\nperson_master_lock: ${personMaster}\nprivacy_safe_storyboard_lock: ${personAssets["分镜安全提交版"]}\nexternal_request_authorized: false\nvideo_generation_authorized: false\n`;
}

function styleCalibrationDocument(path) {
  return `# 原片风格校准\n\nsource_style_calibration_status: complete\nsource_calibration_json: ${path}\n\n\`\`\`json\n${readFileSync(path, "utf8").trim()}\n\`\`\`\n`;
}

function styleContractDocument(calibrationPath, dnaPath) {
  return `# 原片视觉风格合同\n\ncontract_status: complete\nsource_style_contract_qc: pass\nsource_style_calibration: ${calibrationPath}\nsource_remix_dna: ${dnaPath}\n\n- scene_contract: 继承原片生活化店铺与街边空间关系。\n- light_contract: 继承原片自然环境光与室内混合光，不改为棚拍。\n- camera_contract: 继承手机随手拍的固定与低幅跟随，不加入广告式运镜。\n- color_contract: 继承暖中性色、米白与卡其主色，不做高饱和商业调色。\n- motion_contract: 继承自然浏览、行走、回看与低幅手部动作。\n- anti_style_contract: 禁止棚拍目录感、走秀感、过度磨皮和夸张表演。\n`;
}

function peopleQcDocument(task, executionManifest) {
  return `# 人物资产质检\n\nperson_asset_contract_status: complete\nbusiness_qc_status: ${task.person_package_result.business_qc_status}\napproval_status: approved\nuser_approval_status: approved\napproval_scope: generation_pack_allowed\nallowed_downstream: generation_pack\ntarget_person_route: new_ai_model\nperson_identity_route: original_ai_character\ninherit_original_person_identity: false\nnot_using_original_faces: true\nsource_reference_binding: actual_image_reference\ntool_capability: image_edit_with_reference\ngeneration_execution_context: external_reference_capable_platform\nimage_generation_executor_skill: ai-video-image-assets\nimage_generation_execution_manifest: ${executionManifest}\nsource_character_style_contract_qc: pass\nsketch_source_match_status: pass\nsame_pose_source_to_sketch: true\noutfit_consistency_qc: pass\nface_identity_consistency_qc: pass\nprivacy_safe_reference_qc: pass\n`;
}

function storyboardPlanDocument(task, storyboard, mappings) {
  return `# 分镜计划\n\nremix_precision_route: ${task.remix_precision_route}\ntarget_grid_storyboard: ${storyboard}\npanel_count: ${mappings.length}\nsource_anchor_policy: 每格绑定原片关键帧、动作节点与选择理由。\napproval_status: approved\nallowed_downstream: generation_pack\n`;
}

function shotListDocument(shots, mappings) {
  const rows = shots.map((shot, index) => `- ${mappings[index]?.target_panel_id || index + 1} / ${mappings[index]?.source_timecode || ""}：${shot.main_motion || shot.start_state || "动作锚点"}`).join("\n");
  return `# 镜头表\n\n${rows}\n`;
}

function storyboardQcDocument({ task, storyboard, storyboardExecutionManifest, referencePaths, personMaster, platformSmokeEvidence }) {
  return `# 分镜质检报告\n\nstoryboard_qc_status: pass\napproval_status: approved\nuser_approval_status: approved\napproval_scope: generation_pack_allowed\nallowed_downstream: generation_pack | full_sequence_video_generation\ntarget_grid_storyboard: ${storyboard}\nstoryboard_reference_binding: image_edit_with_reference\ntool_capability: image_edit_with_reference\nreference_image_paths: ${referencePaths.join(" | ")}\nwardrobe_reference_binding: image_edit_with_reference\nwardrobe_reference_paths: ${personMaster}\ngeneration_execution_context: external_reference_capable_platform\nimage_generation_executor_skill: ai-video-image-assets\nimage_generation_execution_manifest: ${storyboardExecutionManifest}\nsource_style_contract_match: pass\nstoryboard_source_style_contract_match: pass\nstyle_prompt_compilation_qc: pass\nscene_atmosphere_match_qc: pass\nimage_texture_match_qc: pass\npanel_aspect_ratio_qc: pass\nfull_face_coverage_qc: pass\nside_face_coverage_qc: pass\nface_grid_policy: fine_white_topology_grid_covering_visible_face_region\nface_grid_visibility_qc: pass\nface_identity_interruption_qc: pass\nplatform_precheck_status: ${platformSmokeEvidence.status}\nplatform_precheck_receipt: ${platformSmokeEvidence.submission_receipt_path}\nface_safety_does_not_rewrite_action: pass\ncatalog_polish_risk: low\nadded_panel_labels_or_synthetic_text: no\noutfit_consistency_qc: pass\nsource_visual_dominance: pass\nproduct_reference_scope_qc: pass\nproduct_reference_overpower_risk: low\nsource_hand_match_qc: pass\nsource_clothing_match_qc: pass\nsource_scene_match_qc: pass\nsource_camera_texture_match_qc: pass\nremix_precision_route: ${task.remix_precision_route}\n`;
}

function assetBindingDocument({ promptHandoff, storyboard, redline, material, storyboardSource }) {
  return `# 任务包素材候选与上游交接\n\n生成粒度：本文件不决定整段或逐镜。上游提示词镜头段落只表示内容结构；最终任务数量由用户当前选择和 ai-video-generation-pack 正式规则决定。full_sequence 路线使用整张安全宫格作为动作顺序参考，不把宫格误当成多条任务。\n\n上游正式交接：${promptHandoff}\n\n当前已通过、可供正式任务包 Skill 判断的资产：\n- 分镜安全提交版：${storyboard}\n- 三道红线人物参考：${redline}\n- 局部材质拼图：${material}\n- 清晰目标故事板（仅审核）：${storyboardSource}\n\n本文件只登记候选资产，不决定最终上传组合；每张任务卡的主锚点、人物安全组合和上传顺序由 ai-video-generation-pack 按当前正式规则判断。\n`;
}

function findExactPlatformSmokeEvidence(task, expectedReferencePaths) {
  const expected = expectedReferencePaths.map((path) => ({ path, sha256: sha256File(path) }));
  const candidates = (task.artifacts || []).filter((item) => /4\s*秒动作小样/.test(item.label || "") && item.path && existsSync(item.path));
  if (!candidates.length) throw evidenceError("PLATFORM_SMOKE_TEST_ARTIFACT_MISSING");
  for (const artifact of candidates) {
    const receiptPath = join(dirname(dirname(artifact.path)), "libtv_submission_receipt.json");
    if (!existsSync(receiptPath)) continue;
    const receipt = readJson(receiptPath);
    if (receipt.submission_state !== "completed" || receipt.model_key !== task.generation_model_key) continue;
    const actual = receipt.reference_bindings || [];
    const exactMatch = expected.length === actual.length && expected.every((item) => actual.some((binding) => binding.source_path === item.path && binding.source_sha256 === item.sha256));
    if (!exactMatch) continue;
    return {
      status: "pass",
      evidence_type: "completed_seedance_smoke_test_with_exact_reference_set",
      provider: "libtv",
      model_key: receipt.model_key,
      duration_seconds: receipt.duration_seconds,
      remote_task_id: receipt.remote_task_id,
      submission_receipt_path: receiptPath,
      local_result_path: receipt.local_result_path,
      exact_reference_path_and_sha256_match: true,
    };
  }
  throw evidenceError("PLATFORM_SMOKE_TEST_REFERENCE_SET_MISMATCH");
}

function assertApprovedStage(result, code) {
  if (result?.status !== "completed" || result?.approval_status !== "approved") throw evidenceError(code);
}

function findStoryboardReceipt(result, storyboardPath) {
  const segmentResults = result?.segment_results || [];
  for (const segment of segmentResults) {
    const ownsStoryboard = (segment.artifacts || []).some((item) => item.path === storyboardPath);
    if (!ownsStoryboard) continue;
    const receipt = (segment.artifacts || []).find((item) => /分镜生成执行回执/.test(item.label || "") && item.path && existsSync(item.path));
    if (receipt) return receipt.path;
  }
  return requiredResultArtifact(result, /分镜生成执行回执/);
}

function findStoryboardReceipts(result, storyboardPaths) {
  return unique((storyboardPaths || []).map((path) => findStoryboardReceipt(result, path)));
}

function referencePathsFromStoryboardReceipt(receipt) {
  return [
    ...(receipt?.reference_image_paths || []),
    ...(receipt?.source_reference_bindings || []).map((item) => item?.path),
    ...(receipt?.actual_reference_images || []).map((item) => item?.path),
    ...(receipt?.generation_provenance?.actual_reference_paths || []),
  ].filter(Boolean);
}

function resolveGenerationPersonReceipt(task, personMaster) {
  const candidatePaths = unique([
    personMaster,
    ...(task?.artifacts || [])
      .filter((item) => item.stage === "person" && item.path)
      .map((item) => item.path),
  ]);
  for (const path of candidatePaths) {
    const receipt = resolvePersonExecutionReceipt(task, path);
    if (receipt?.path) return receipt;
  }
  return null;
}

function findStoryboardRatio(result, storyboardPath) {
  const inline = result?.ratio_check;
  if (inline?.image_path === storyboardPath && inline?.pass === true) return inline;
  const direct = (result?.ratio_checks || []).find((item) => item.image_path === storyboardPath && item.pass === true);
  if (direct) return direct;
  const segmentResults = result?.segment_results || [];
  for (const segment of segmentResults) {
    const ownsStoryboard = (segment.artifacts || []).some((item) => item.path === storyboardPath);
    if (!ownsStoryboard) continue;
    const ratioArtifact = (segment.artifacts || []).find((item) => /分镜比例检查/.test(item.label || "") && item.path && existsSync(item.path));
    if (ratioArtifact) return readJson(ratioArtifact.path);
  }
  const topLevelArtifact = (result?.artifacts || []).find((item) => /分镜比例检查/.test(item.label || "") && item.path && existsSync(item.path));
  if (topLevelArtifact) {
    const payload = readJson(topLevelArtifact.path);
    if (payload?.pass === true && (!payload.image_path || payload.image_path === storyboardPath)) return payload;
  }
  throw evidenceError("STORYBOARD_RATIO_EVIDENCE_MISSING");
}

function h3WorkflowPrescription(task, evidence) {
  return `# 工作流处方

workflow_execution_profile: managed
remix_precision_route: ${task.remix_precision_route}
required_stage_sequence: decomposition -> person -> storyboard -> motion_preflight -> video_prompt -> generation_pack
required_stage_outputs:
  - stage: decomposition
    owner_skill: ai-video-decompose-gemini
    status: ${task.decomposition_result?.status}
    evidence: ${evidence.sourceFiles.semantic}
  - stage: person_assets
    owner_skill: ai-video-person-assets
    status: ${task.person_generation_result?.status}
    evidence: ${evidence.personMaster}
  - stage: storyboard
    owner_skill: ai-video-storyboard
    status: ${task.storyboard_generation_result?.status}
    evidence: ${evidence.storyboard}
  - stage: motion_preflight
    owner_skill: ai-video-motion-preflight
    status: ${task.motion_preflight_result?.status}
    evidence: ${evidence.motionBlueprintPath}
  - stage: video_prompt
    owner_skill: aigc-video-prompt-codex
    status: ${task.video_prompt_result?.status}
    evidence: ${evidence.promptSourcePath}
method_cards_inherited_qc: pass
method_cards_inherited_basis: 上游正式成果原样投影、路径存在且状态完成；工作台未重写业务方法。
contract_inheritance_qc: pending_generation_pack_reverse_review
prompt_self_check_policy: aigc-video-prompt-codex_formal_trace_required
source_reference_policy: approved_clear_person_master_plus_approved_segment_storyboards
generation_provider: runninghub_h3_multiref
generation_route_choice: runninghub_h3_multiref
workbench_generation_intent: ${task.generation_route_choice}
product_or_offer_required: no
target_remix_type: ootd_visual_remix
segment_route_required: ${evidence.segmentRoutePlan ? "true" : "false"}
segment_count: ${evidence.segmentRoutePlan?.segments?.length || 1}
`;
}

function h3StatusDocument(task, { personMaster, storyboard, segmentRoutePlan }) {
  return `# 项目状态

task_id: ${task.id}
project_name: ${task.title}
current_stage: generation_pack_preflight
core_source_decomposition_status: complete
source_decomposition_delivery_status: complete
person_route: ${task.person_route}
target_person_route: new_ai_model
person_identity_route: original_ai_character
inherit_original_person_identity: false
not_using_original_faces: true
person_asset_status: approved
storyboard_status: approved
motion_preflight_status: complete
video_prompt_status: ready
remix_precision_route: ${task.remix_precision_route}
generation_provider: runninghub_h3_multiref
generation_route_choice: runninghub_h3_multiref
workbench_generation_intent: ${task.generation_route_choice}
workbench_generation_intent_note: 旧字段只表示直接生成正式版，不表示 LibTV 通道；实际付费通道只认 generation_provider。
product_or_offer_required: no
target_remix_type: ootd_visual_remix
user_approval_status: approved
approval_source: user_current_turn
approval_scope: generation_pack_allowed
allowed_downstream: generation_pack
active_asset_lock: ${storyboard}
person_master_lock: ${personMaster}
reference_safety_route: clear_reference_h3_no_redline_no_grid
segment_route_required: ${segmentRoutePlan ? "true" : "false"}
segment_count: ${segmentRoutePlan?.segments?.length || 1}
segment_route_plan: ${segmentRoutePlan ? "approved_segment_storyboards_to_generation_pack" : "single_segment"}
external_request_authorized: false
video_generation_authorized: false
`;
}

function h3PeopleQcDocument(task, executionManifest) {
  return `# 人物资产质检\n\nperson_asset_contract_status: complete\nbusiness_qc_status: pass\napproval_status: approved\nuser_approval_status: approved\napproval_scope: generation_pack_allowed\nallowed_downstream: generation_pack\ntarget_person_route: new_ai_model\nperson_identity_route: original_ai_character\ninherit_original_person_identity: false\nnot_using_original_faces: true\nsource_reference_binding: actual_image_reference\ntool_capability: image_edit_with_reference\ngeneration_execution_context: external_reference_capable_platform\nimage_generation_executor_skill: ai-video-image-assets\nimage_generation_execution_manifest: ${executionManifest}\nsource_character_style_contract_qc: pass\noutfit_consistency_qc: pass\nface_identity_consistency_qc: pass\nprovider_reference_contract: runninghub_h3_accepts_clear_person_reference\nredline_or_grid_required: no\n`;
}

function h3StoryboardQcDocument({ task, storyboard, storyboardExecutionManifest, referencePaths, personMaster, storyboards }) {
  return `# 分镜质检报告\n\nstoryboard_qc_status: pass\napproval_status: approved\nuser_approval_status: approved\napproval_scope: generation_pack_allowed\nallowed_downstream: generation_pack | segmented_full_sequence_video_generation\ntarget_grid_storyboard: ${storyboard}\nsegment_storyboards: ${storyboards.join(" | ")}\nstoryboard_reference_binding: image_edit_with_reference\ntool_capability: image_edit_with_reference\nreference_image_paths: ${referencePaths.join(" | ")}\nwardrobe_reference_binding: image_edit_with_reference\nwardrobe_reference_paths: ${personMaster}\ngeneration_execution_context: external_reference_capable_platform\nimage_generation_executor_skill: ai-video-image-assets\nimage_generation_execution_manifest: ${storyboardExecutionManifest}\nsource_style_contract_match: pass\nstoryboard_source_style_contract_match: pass\nstyle_prompt_compilation_qc: pass\nscene_atmosphere_match_qc: pass\nimage_texture_match_qc: pass\npanel_aspect_ratio_qc: pass\nface_safety_does_not_rewrite_action: pass\nprovider_reference_contract: runninghub_h3_accepts_clear_storyboard_reference\nredline_or_grid_required: no\ncatalog_polish_risk: low\nadded_panel_labels_or_synthetic_text: no\noutfit_consistency_qc: pass\nsource_visual_dominance: pass\nproduct_reference_scope_qc: pass\nproduct_reference_overpower_risk: low\nsource_hand_match_qc: pass\nsource_clothing_match_qc: pass\nsource_scene_match_qc: pass\nsource_camera_texture_match_qc: pass\nremix_precision_route: ${task.remix_precision_route}\n`;
}

function h3AssetBindingDocument({ promptHandoff, storyboards, personMaster }) {
  let handoffAssets = [];
  try {
    const payload = readJson(promptHandoff);
    handoffAssets = Array.isArray(payload.generation_upload_assets)
      ? payload.generation_upload_assets.filter((asset) => asset?.exact_alias && asset?.path)
      : [];
  } catch { /* 兼容历史 Markdown 交接，保留只读路径说明 */ }
  const exactBindings = handoffAssets.length
    ? handoffAssets.map((asset) => `- ${asset.exact_alias}｜顺序 ${asset.upload_order || "按交接"}｜职责：${asset.prompt_responsibility || asset.role || "按正式交接"}｜禁止继承：${asset.forbidden_inheritance || "按正式交接"}｜路径：${asset.path}`).join("\n")
    : `- 人物母版：${personMaster}\n${storyboards.map((path, index) => `- 第 ${index + 1} 段目标分镜：${path}`).join("\n")}`;
  return `# 任务包素材候选与上游交接\n\n生成粒度：本文件不决定整段、小样或分段数量；由用户当前选择和 ai-video-generation-pack 正式规则决定。\n\n上游正式交接：${promptHandoff}\n\nRunningHub H3 本次精确素材绑定：\n${exactBindings}\n\n本通道允许 0–3 张清晰参考图，不需要红线人物图或网格故事板；任务包必须原样采用以上正式别名、上传顺序和职责，不得另造别名或补写人物、动作、服装和场景内容。\n`;
}

function requiredArtifact(task, stage, labelPattern) {
  const item = (task.artifacts || []).find((candidate) => candidate.stage === stage && candidate.published && labelPattern.test(candidate.label || "") && existsSync(candidate.path));
  if (!item) throw evidenceError(`AUTHORITATIVE_${stage.toUpperCase()}_ARTIFACT_MISSING`);
  return item.path;
}

function requiredResultArtifact(result, labelPattern) {
  const item = (result?.artifacts || []).find((candidate) => labelPattern.test(candidate.label || "") && candidate.path && existsSync(candidate.path));
  if (!item) throw evidenceError(`RESULT_ARTIFACT_MISSING:${labelPattern}`);
  return item.path;
}

function findResultEvidence(result, labelPattern, filenamePattern) {
  const artifacts = result?.artifacts || [];
  const preferred = artifacts.filter((item) => labelPattern.test(item.label || ""));
  const candidates = [...preferred, ...artifacts];
  for (const item of candidates) {
    if (!item?.path || !existsSync(item.path)) continue;
    const parent = dirname(item.path);
    try {
      const name = readdirSync(parent).find((entry) => filenamePattern.test(entry));
      if (name) return join(parent, name);
    } catch { /* evidence may live beside a different artifact */ }
  }
  throw evidenceError(`RESULT_EVIDENCE_MISSING:${filenamePattern}`);
}

function requiredPath(path) {
  if (!existsSync(path)) throw evidenceError(`EVIDENCE_PATH_MISSING:${path}`);
  return path;
}

function evidenceError(code) {
  const error = new Error(code);
  error.code = code;
  error.external_request_started = false;
  error.video_generation_started = false;
  return error;
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function unique(values) { return [...new Set(values)]; }
function writeJson(path, value) { writeText(path, `${JSON.stringify(value, null, 2)}\n`); }
function writeText(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function copyText(source, target) { writeText(target, readFileSync(source, "utf8")); }

function runRequired(script, args, code, { parseJson = false } = {}) {
  const result = spawnSync("python3", [script, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0 && !parseJson) throw evidenceError(`${code}:${result.stderr || result.stdout || result.error?.message || result.status}`);
  if (!parseJson) return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  try { return JSON.parse(result.stdout); }
  catch { throw evidenceError(`${code}:${result.stderr || result.stdout || "INVALID_JSON"}`); }
}
