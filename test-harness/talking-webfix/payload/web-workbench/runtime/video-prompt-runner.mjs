import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexArgs } from "./codex-runner.mjs";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";

export async function runVideoPromptStage({ task, taskDir, outputDir = taskDir, onEvent, env = process.env }) {
  const skillContract = resolveSkillContract("video_prompt", { env });
  const contractReceipt = skillContractReceipt(skillContract);
  mkdirSync(outputDir, { recursive: true });
  const resultPath = join(outputDir, "video-prompt-result.json");
  const snapshotPath = join(outputDir, "video-prompt-task.json");
  const contractReceiptPath = join(outputDir, "video-prompt-skill-contract.json");
  const motionBlueprint = (task.motion_preflight_result?.artifacts || []).find((item) => /运动蓝图/.test(item.label || ""));
  const promptHandoff = (task.motion_preflight_result?.artifacts || []).find((item) => /视频提示词交接/.test(item.label || ""));
  const approvedStoryboards = task.artifacts.filter((item) => item.stage === "storyboard" && item.published && /分镜/.test(item.label) && item.path && existsSync(item.path));
  const approvedStoryboard = approvedStoryboards[0];
  const approvedPerson = task.artifacts.find((item) => item.stage === "person" && item.published && /人物/.test(item.label));
  const quickRoute = task.remix_precision_route === "prompt_driven_remix";
  const generationUnitChoice = generationUnitChoiceForTask(task);
  const generationUploadAssets = generationUploadAssetsForTask(task);
  const h3SegmentedFullSequence = task.generation_model_snapshot?.provider === "runninghub_h3_multiref"
    && task.generation_model_snapshot?.segmented_full_sequence_required === true
    && generationUnitChoice === "full_sequence";
  const generationAssetFingerprint = generationUploadAssetFingerprint(generationUploadAssets);
  const downstreamGenerationPackRejection = generationPackPromptRevisionFeedback(task);
  const requirements = quickRoute
    ? (task.person_route === "generic_no_fixed_face" ? [] : [["APPROVED_PERSON_MISSING", approvedPerson]])
    : [["MOTION_BLUEPRINT_MISSING", motionBlueprint], ["VIDEO_PROMPT_HANDOFF_MISSING", promptHandoff], ["APPROVED_STORYBOARD_MISSING", approvedStoryboard], ["APPROVED_PERSON_MISSING", approvedPerson]];
  for (const [code, artifact] of requirements) {
    if (!artifact?.path || !existsSync(artifact.path)) throw new Error(code);
  }
  const snapshot = {
    schema_version: 3,
    id: task.id,
    title: task.title,
    generation_stage: "video_prompt",
    remix_precision_route: task.remix_precision_route,
    remix_change_contract: task.remix_change_contract || null,
    motion_blueprint_path: motionBlueprint?.path || null,
    prompt_handoff_path: promptHandoff?.path || null,
    approved_storyboard_path: approvedStoryboard?.path || null,
    approved_storyboard_paths: approvedStoryboards.map((item) => item.path),
    approved_person_path: approvedPerson?.path || null,
    decomposition_artifacts: (task.decomposition_result?.artifacts || []).filter((item) => item.path && existsSync(item.path)),
    rewrite_mode: task.rewrite_mode,
    product_brief: task.product_brief || null,
    product_image_paths: task.product_image_paths || [],
    product_fact_scope: quickRoute && task.rewrite_mode === "replace_product"
      ? "approved_visual_reconstruction_only_no_unverified_text_claims"
      : null,
    quick_route_contract: quickRoute ? {
      storyboard_intentionally_skipped: true,
      motion_blueprint_intentionally_skipped: true,
      action_evidence_source: "approved_reference_video_decomposition",
      allowed_action_policy: "only_visually_evidenced_low_risk_actions; downgrade_or_omit_complex_prop_interactions",
      product_reference_policy: "uploaded_product_images_are_approved_for_visible_appearance_only; no_material_price_size_sales_or_offer_claims",
    } : null,
    source_analysis_dir: join(taskDir, "01_source_video_analysis"),
    external_request_authorized: false,
    video_generation_authorized: false,
    generation_unit_choice: generationUnitChoice,
    segmented_full_sequence_required: h3SegmentedFullSequence,
    maximum_segment_duration_seconds: task.generation_model_snapshot?.maximum_segment_duration_seconds || null,
    generation_unit_choice_source: generationUnitChoice === "pending_generation_pack" ? "not_selected" : "workbench_current_generation_choice",
    generation_upload_assets: generationUploadAssets,
    generation_upload_asset_fingerprint: generationAssetFingerprint,
    downstream_generation_pack_rejection: downstreamGenerationPackRejection,
    skill_contract: contractReceipt,
    skill_contract_receipt_path: contractReceiptPath,
  };
  writeFileSync(contractReceiptPath, `${JSON.stringify(contractReceipt, null, 2)}\n`, { flag: existsSync(contractReceiptPath) ? "w" : "wx" });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: existsSync(snapshotPath) ? "w" : "wx" });
  onEvent?.(quickRoute ? "正在从拆解证据编译快速复刻视频提示词；本路线不生成目标分镜。" : "正在把已通过的分镜和运动蓝图编译成视频提示词；当前不会上传素材或生成视频。");
  let reusableResult = null;
  if (existsSync(resultPath)) {
    try {
      const saved = JSON.parse(readFileSync(resultPath, "utf8"));
      if (isReusableVideoPromptResult(saved, {
        generationUnitChoice,
        generationAssetFingerprint,
        promptGenerationUnitContract: h3SegmentedFullSequence
          ? "segmented_full_sequence"
          : generationUnitChoice,
      })) reusableResult = saved;
      else if (
        saved.status === "completed" &&
        !saved.prompt_generation_unit_choice &&
        !saved.prompt_generation_asset_fingerprint
      ) {
        assertPromptHandoffMatchesGenerationChoice(
          saved,
          generationUnitChoice,
          generationUploadAssets,
          { h3SegmentedFullSequence },
        );
        reusableResult = saved;
      }
    } catch { /* invalid or incomplete result will be rebuilt */ }
  }
  if (reusableResult) {
    onEvent?.("已复用刚才完成的正式提示词、自检和任务包交接，只重新执行本地接口验收，不会再次调用模型。");
  } else if (env.WORKBENCH_VIDEO_PROMPT_GENERATOR) {
    await runProcess(process.execPath, [env.WORKBENCH_VIDEO_PROMPT_GENERATOR, "--task-json", snapshotPath, "--task-dir", taskDir, "--output", resultPath], { env, onEvent });
  } else {
    const prompt = buildVideoPromptPrompt(task, taskDir, snapshotPath, skillContract, outputDir);
    const promptPath = join(outputDir, "video-prompt-prompt.md");
    writeFileSync(promptPath, prompt, { flag: existsSync(promptPath) ? "w" : "wx" });
    const args = buildCodexArgs({ taskDir, resultPath, env });
    await runManagedCodex({ args, prompt, env, onEvent, timeoutMs: 15 * 60 * 1000 });
  }
  if (!existsSync(resultPath)) throw new Error("VIDEO_PROMPT_RESULT_MISSING");
  const result = reusableResult || JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.status === "completed") {
    const missing = ["正式视频提示词", "视频提示词自检", "视频任务包交接"].filter((label) => !(result.artifacts || []).some((item) => item.path && existsSync(item.path) && item.label.includes(label)));
    if (missing.length) throw new Error(`VIDEO_PROMPT_ARTIFACTS_MISSING:${missing.join(",")}`);
    assertPromptHandoffMatchesGenerationChoice(result, generationUnitChoice, generationUploadAssets, { h3SegmentedFullSequence });
  }
  const finalized = { ...result, prompt_generation_unit_choice: generationUnitChoice, prompt_generation_unit_contract: h3SegmentedFullSequence ? "segmented_full_sequence" : generationUnitChoice, prompt_generation_unit_choice_source: generationUnitChoice === "pending_generation_pack" ? "not_selected" : "workbench_current_generation_choice", prompt_generation_asset_fingerprint: generationAssetFingerprint, prompt_generation_asset_contract_status: generationUploadAssets.length ? "matched" : "not_available_yet", skill_contract: contractReceipt, skill_contract_receipt_path: contractReceiptPath, external_request_started: false, video_generation_started: false, estimated_cost_cny: 0 };
  writeFileSync(resultPath, `${JSON.stringify(finalized, null, 2)}\n`);
  return finalized;
}

export function isReusableVideoPromptResult(result, {
  generationUnitChoice,
  generationAssetFingerprint,
  promptGenerationUnitContract,
}) {
  return result?.status === "completed"
    && result.prompt_generation_unit_choice === generationUnitChoice
    && result.prompt_generation_unit_contract === promptGenerationUnitContract
    && result.prompt_generation_asset_fingerprint === generationAssetFingerprint;
}

export function buildVideoPromptPrompt(task, taskDir, snapshotPath, skillContract, outputDir = taskDir) {
  const generationUnitChoice = generationUnitChoiceForTask(task);
  const generationUploadAssets = generationUploadAssetsForTask(task);
  const generationAssetFingerprint = generationUploadAssetFingerprint(
    generationUploadAssets,
  );
  const h3SegmentedFullSequence = task.generation_model_snapshot?.provider === "runninghub_h3_multiref"
    && task.generation_model_snapshot?.segmented_full_sequence_required === true
    && generationUnitChoice === "full_sequence";
  return buildSkillOwnedPrompt({
    contract: skillContract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      task_snapshot_path: snapshotPath,
      work_dir: outputDir,
      remix_precision_route: task.remix_precision_route,
      person_route: task.person_route,
      rewrite_mode: task.rewrite_mode,
      product_brief: task.product_brief || null,
      product_image_paths: task.product_image_paths || [],
      product_fact_scope: task.remix_precision_route === "prompt_driven_remix" && task.rewrite_mode === "replace_product"
        ? "approved_visual_reconstruction_only_no_unverified_text_claims"
        : null,
      source_analysis_dir: join(taskDir, "01_source_video_analysis"),
      generation_unit_choice: generationUnitChoice,
      segmented_full_sequence_required: h3SegmentedFullSequence,
      maximum_segment_duration_seconds: task.generation_model_snapshot?.maximum_segment_duration_seconds || null,
      generation_unit_choice_source: generationUnitChoice === "pending_generation_pack" ? "not_selected" : "workbench_current_generation_choice",
      generation_upload_assets: generationUploadAssets,
      generation_upload_asset_fingerprint: generationAssetFingerprint,
      downstream_generation_pack_rejection: generationPackPromptRevisionFeedback(task),
    },
    runtimeEnvelope: {
      external_requests_allowed: false,
      source_upload_allowed: false,
      image_generation_allowed: false,
      video_generation_allowed: false,
      generation_task_creation_allowed: false,
      generation_unit_decision_authority: "user_choice_then_ai-video-generation-pack",
      generation_unit_boundary: generationUnitChoice === "pending_generation_pack"
        ? "本阶段只编译可复用镜头内容；不得决定整段或逐镜、不得决定任务卡数量。视频任务包交接必须登记 generation_unit_choice=pending_generation_pack。"
        : h3SegmentedFullSequence
          ? "用户选择的是完整正式成片；H3 单次最多 15 秒，因此本阶段必须在同一正式提示词文件中按已采用的自然段分镜编译 2–5 个连续段提示词，每段单独可提交且不超过 15 秒，合计覆盖完整时长。不得拆成逐镜碎片。每段必须是可脱离其他段独立执行的完整提示词：必须重复写全人物、产品、画面、动作、声音与禁用项，不得使用‘同上一段、与前两段相同、继续保持’等依赖前文的表达。交接必须登记 generation_unit_choice=segmented_full_sequence、task_count=自然段数量、segment_prompts（含时长范围与对应分镜别名）、model_prompt_path 和 generation_upload_asset_fingerprint。"
        : `用户已经明确选择 ${generationUnitChoice}。本阶段不得改变该选择，必须输出与它一致的 1 份模型可直接提交的正式提示词；镜头段落可以作为同一提示词的内容结构，但不得写成多条生成任务。视频任务包交接必须登记 generation_unit_choice=${generationUnitChoice}、task_count=1 和 model_prompt_path。`,
      generation_asset_alias_boundary: generationUploadAssets.length
        ? `模型提示词只能引用 generation_upload_assets 中列出的 exact_alias，且每个都必须出现；不得继续使用 @目标故事板、@人物母版或其他未上传别名。素材职责以正式 Skill 判断为准，但别名和路径不得改写。`
        : "最终上传素材尚未形成，本阶段不得虚构模型内素材别名。",
      quick_route_method_contract: task.remix_precision_route === "prompt_driven_remix"
        ? "用户明确选择快速提示词复刻：不生成目标故事板或独立运动蓝图。必须使用已通过的参考片拆解作为动作与节奏证据；只保留证据充分的低风险走动、转身、抬手和服装展示，复杂手物互动若没有表演层必须删除或降级。上传的产品图片已获准仅作为可见外观参考，不得推断材质、尺码、价格、优惠、销量或购买承诺。不得因快速路线按设计跳过分镜而误判为缺失；若其余真实输入足以生成，必须编译与用户所选生成单元一致的正式提示词。"
        : null,
      output_interface: { required_artifact_labels: ["正式视频提示词", "视频提示词自检", "视频任务包交接"], published: false, estimated_cost_cny: 0 },
      prompt_qc_trace_contract: "视频提示词自检文件必须明确记录 owner_skill: aigc-video-prompt-codex、prompt_qc_status: pass/blocked，以及 V1/V2/V3 或等效动态自检。若一次写对，记录 iteration_record: direct_pass_no_fake_v1_v2，不得虚构版本迭代。",
      user_message_policy: "只用大白话说明提示词状态和下一步；不能把提示词完成写成视频已生成，也不能要求用户确认逐镜切图。",
    },
  });
}

export function generationUnitChoiceForTask(task) {
  if (task.generation_route_choice === "in_chat_libtv_generation" || task.generation_route_choice === "full_external_manual") return "full_sequence";
  if (task.generation_route_choice === "smoke_test_first") return "smoke_test";
  return "pending_generation_pack";
}

export function generationUploadAssetsForTask(task) {
  const provider = task.generation_model_snapshot?.provider || task.generation_provider || "libtv";
  if (provider === "runninghub_h3_multiref") {
    const smokeRouteAssets = task.generation_route_choice === "smoke_test_first"
      ? generationPackSmokeRouteAssets(task)
      : null;
    if (Array.isArray(smokeRouteAssets) && smokeRouteAssets.length) {
      return smokeRouteAssets
        .filter((asset) => asset?.upload_to_video_model !== false
          && asset?.alias
          && asset?.path
          && existsSync(asset.path))
        .map((asset) => ({
          exact_alias: asset.alias,
          role: asset.role || asset.asset_role || "approved_smoke_test_reference",
          path: asset.path,
        }))
        .slice(0, 3);
    }
    const candidates = [
      ...(task.storyboard_generation_result?.artifacts || []),
      ...(task.person_generation_result?.artifacts || []),
      ...(task.person_package_result?.artifacts || []),
      ...(task.artifacts || []),
    ].filter((item) => item?.path && existsSync(item.path));
    const publishedStoryboards = uniqueArtifactsByPath(
      (task.artifacts || []).filter((item) => item?.stage === "storyboard"
        && item.published
        && item.path
        && existsSync(item.path)
        && /分镜/.test(item.label || "")
        && !/红线|网格|安全提交版/.test(item.label || "")),
    );
    const cleanSpecs = [
      ["@清晰目标分镜", /目标宫格分镜|目标分镜(?!安全)|分镜故事板(?!安全)/, "clear_storyboard_structure_reference"],
      ["@清晰人物母版", /AI 人物母版|人物母版|服装人物多视图锚点/, "clear_character_identity_reference"],
      ["@局部材质参考", /局部材质拼图/, "clean_material_detail_reference"],
    ];
    if (task.remix_precision_route === "prompt_driven_remix") {
      const personArtifact = candidates.find((item) => cleanSpecs[1][1].test(item.label || "") && !/红线|网格|安全提交版/.test(item.label || ""));
      const assets = personArtifact
        ? [{ exact_alias: "@清晰人物母版", role: cleanSpecs[1][2], path: personArtifact.path }]
        : [];
      const currentApprovedProductRefs = task.product_assets_result?.approval_status === "approved"
        ? uniqueArtifactsByPath(
          (task.product_assets_result.artifacts || []).filter((item) =>
            item?.path &&
            existsSync(item.path) &&
            /干净产品参考图|clean_product_grid/.test(item.label || ""),
          ),
        ).map((item) => item.path)
        : [];
      const legacyApprovedProductRefs = currentApprovedProductRefs.length
        ? []
        : uniqueArtifactsByPath(
          (task.artifacts || []).filter((item) =>
            item?.stage === "product_assets" &&
            item.published &&
            item.path &&
            existsSync(item.path) &&
            /干净产品参考图|clean_product_grid/.test(item.label || ""),
          ),
        ).map((item) => item.path);
      const productReferences = currentApprovedProductRefs.length
        ? currentApprovedProductRefs
        : legacyApprovedProductRefs.length
          ? legacyApprovedProductRefs
          : (task.product_assets_result?.approval_status === "approved" ? [] : task.product_image_paths || []);
      for (const [index, path] of productReferences.entries()) {
        if (assets.length >= 3) break;
        if (path && existsSync(path)) assets.push({
          exact_alias: `@产品参考图${index + 1}`,
          role: `product_visible_appearance_reference_${String(index + 1).padStart(2, "0")}`,
          path,
        });
      }
      return assets;
    }
    if (publishedStoryboards.length > 1) {
      const segmentAssets = publishedStoryboards.map((artifact, index) => ({
        exact_alias: `@第${index + 1}段清晰目标分镜`,
        role: `segment_${String(index + 1).padStart(2, "0")}_clear_storyboard_structure_reference`,
        path: artifact.path,
      }));
      const personArtifact = candidates.find((item) => cleanSpecs[1][1].test(item.label || "") && !/红线|网格|安全提交版/.test(item.label || ""));
      return personArtifact
        ? [...segmentAssets, { exact_alias: "@清晰人物母版", role: cleanSpecs[1][2], path: personArtifact.path }]
        : segmentAssets;
    }
    return cleanSpecs.map(([exactAlias, pattern, role]) => {
      const artifact = candidates.find((item) => pattern.test(item.label || "") && !/红线|网格|安全提交版/.test(item.label || ""));
      return artifact ? { exact_alias: exactAlias, role, path: artifact.path } : null;
    }).filter(Boolean).slice(0, 3);
  }
  const artifacts = task.person_package_result?.artifacts || [];
  const specs = [
    ["@分镜安全提交版", /分镜安全提交版/, "storyboard_grid_submission_privacy_safe"],
    ["@三道红线人物参考", /三道红线人物参考|三道红线遮脸版/, "platform_privacy_fallback_character_reference"],
    ["@局部材质拼图", /局部材质拼图/, "safe_material_collage_upload"],
  ];
  return specs.map(([exactAlias, pattern, role]) => {
    const artifact = artifacts.find((item) => pattern.test(item.label || "") && item.path && existsSync(item.path));
    return artifact ? { exact_alias: exactAlias, role, path: artifact.path } : null;
  }).filter(Boolean);
}

function generationPackSmokeRouteAssets(task) {
  const inline = task.generation_pack_result?.experiment_contract?.route_assets;
  if (Array.isArray(inline) && inline.length) return inline;
  const packArtifact = (task.generation_pack_result?.artifacts || [])
    .find((item) => /\u89c6\u9891\u751f\u6210\u4efb\u52a1\u5305/.test(item?.label || ""));
  if (!packArtifact?.path || !existsSync(packArtifact.path)) return null;
  try {
    const payload = JSON.parse(readFileSync(packArtifact.path, "utf8"));
    return Array.isArray(payload?.experiment_contract?.route_assets)
      ? payload.experiment_contract.route_assets
      : null;
  } catch {
    return null;
  }
}

function uniqueArtifactsByPath(artifacts) {
  const seen = new Set();
  return artifacts.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

export function generationUploadAssetFingerprint(assets) {
  if (!assets?.length) return null;
  return createHash("sha256").update(JSON.stringify(assets.map(({ exact_alias, role, path }) => ({ exact_alias, role, path })))).digest("hex");
}

export function generationPackPromptRevisionFeedback(task) {
  const result = task.generation_pack_result;
  const resultStatus = result?.status || result?.artifact_status || result?.preflight_status;
  if (resultStatus !== "blocked") return null;
  const feedback = [result.user_message, result.summary, task.last_error].filter(Boolean).join("\n");
  const structuredPromptRouteBack = Array.isArray(result.route_back)
    && result.route_back.includes("aigc-video-prompt-codex");
  const structuredPromptBlocker = Array.isArray(result.blocked_reasons)
    && result.blocked_reasons.some((reason) => /prompt|prompt_duration_scope_mismatch/i.test(String(reason)));
  const textualPromptRevision = /退回视频提示词阶段|回到正式提示词阶段|正式提示词第|模型提示词|提示词(?:需要|应|先)?改成|小样提示词/.test(feedback);
  if (!structuredPromptRouteBack && !structuredPromptBlocker && !textualPromptRevision) return null;
  return {
    source_stage: "ai-video-generation-pack",
    status: "blocked",
    feedback,
    required_action: "由提示词 Skill 根据下游验收意见修订模型提示词；不得由工作台或任务包改写正文。",
  };
}

export function mayReuseCompletedVideoPromptRetry(task) {
  return task?.status === "video_prompt_blocked"
    && !generationPackPromptRevisionFeedback(task);
}

function assertPromptHandoffMatchesGenerationChoice(result, generationUnitChoice, generationUploadAssets, { h3SegmentedFullSequence = false } = {}) {
  const handoff = (result.artifacts || []).find((item) => /视频任务包交接/.test(item.label || ""));
  if (!handoff?.path || !existsSync(handoff.path)) throw new Error("VIDEO_PROMPT_HANDOFF_MISSING");
  let payload;
  const rawHandoff = readFileSync(handoff.path, "utf8");
  try { payload = JSON.parse(rawHandoff); }
  catch { payload = parseMarkdownPromptHandoff(rawHandoff); }
  if (!payload) throw new Error("VIDEO_PROMPT_HANDOFF_NOT_STRUCTURED");
  const declaredChoice = payload.generation_unit_choice || payload.generation_unit || null;
  const expectedChoice = h3SegmentedFullSequence ? "segmented_full_sequence" : generationUnitChoice;
  if (declaredChoice !== expectedChoice) throw new Error("VIDEO_PROMPT_GENERATION_UNIT_CONFLICT");
  if (generationUnitChoice !== "pending_generation_pack") {
    const taskCount = Number(payload.task_count);
    const validTaskCount = h3SegmentedFullSequence ? taskCount >= 2 && taskCount <= 5 : taskCount === 1;
    const validSegments = !h3SegmentedFullSequence || (Array.isArray(payload.segment_prompts) && payload.segment_prompts.length === taskCount);
    if (!validTaskCount || !validSegments || !payload.model_prompt_path || !existsSync(payload.model_prompt_path)) throw new Error("VIDEO_PROMPT_MODEL_PROMPT_CONTRACT_MISSING");
    const forbiddenRules = JSON.stringify(payload.generation_rules || []);
    if (/逐镜生成|一张[^，。]*对应一条提示词/.test(forbiddenRules) && generationUnitChoice === "full_sequence") throw new Error("VIDEO_PROMPT_FULL_SEQUENCE_SPLIT_CONFLICT");
    if (generationUploadAssets.length) {
      const declaredAssets = Array.isArray(payload.generation_upload_assets)
        ? payload.generation_upload_assets
        : [];
      if (declaredAssets.length && !generationAssetBindingsMatch(declaredAssets, generationUploadAssets))
        throw new Error("VIDEO_PROMPT_GENERATION_ASSET_BINDING_CONFLICT");
      const modelPrompt = readFileSync(payload.model_prompt_path, "utf8");
      for (const asset of generationUploadAssets) {
        const declared = declaredAssets.find((item) => item.exact_alias === asset.exact_alias && item.path === asset.path);
        if (!modelPromptReferencesAsset(modelPrompt, asset, declared))
          throw new Error(`VIDEO_PROMPT_REQUIRED_ASSET_ALIAS_MISSING:${asset.exact_alias}`);
      }
      if (/@目标故事板|@人物母版/.test(modelPrompt)) throw new Error("VIDEO_PROMPT_NON_UPLOADED_ASSET_ALIAS_PRESENT");
      assertPrivacySafeAssetsAreCompiledIntoModelPrompt(modelPrompt, generationUploadAssets);
    }
  }
}

export function generationAssetBindingsMatch(declaredAssets, expectedAssets) {
  const binding = ({ exact_alias, path }) => ({ exact_alias, path });
  return JSON.stringify((declaredAssets || []).map(binding)) ===
    JSON.stringify((expectedAssets || []).map(binding));
}

export function modelPromptReferencesAsset(modelPrompt, expectedAsset, declaredAsset = null) {
  if (String(modelPrompt).includes(expectedAsset?.exact_alias || "")) return true;
  const providerToken = String(declaredAsset?.provider_token || "").trim();
  return /^@图片[1-3]$/.test(providerToken) && String(modelPrompt).includes(providerToken);
}

export function parseMarkdownPromptHandoff(markdown) {
  const field = (name) => {
    const match = String(markdown).match(new RegExp(`^\\s*(?:[-*]\\s*)?${name}:\\s*(.+?)\\s*$`, "m"));
    return match?.[1]?.trim().replace(/^`|`$/g, "") || null;
  };
  const generationUnitChoice = field("generation_unit_choice");
  const modelPromptPath = field("model_prompt_path");
  const rawTaskCount = field("task_count");
  const taskCount = rawTaskCount == null ? null : Number(rawTaskCount);
  if (!generationUnitChoice) return null;
  if (
    generationUnitChoice !== "pending_generation_pack" &&
    (!modelPromptPath || !Number.isFinite(taskCount))
  ) return null;
  const segmentRows = String(markdown)
    .split("\n")
    .filter((line) => /^\|\s*\d+\s*\|\s*segment_prompt_[^|]+\|/.test(line));
  const assetRows = String(markdown)
    .split("\n")
    .filter((line) => /^\|\s*\d+\s*\|\s*`?@[^|`]+`?\s*\|/.test(line));
  return {
    generation_unit_choice: generationUnitChoice,
    task_count: taskCount,
    model_prompt_path: modelPromptPath,
    segment_prompts: segmentRows.map((line) => ({ row: line })),
    generation_upload_assets: assetRows.map((line) => {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ""));
      return { exact_alias: cells[1], path: cells[3] };
    }),
    generation_rules: [],
  };
}

export function assertPrivacySafeAssetsAreCompiledIntoModelPrompt(modelPrompt, generationUploadAssets) {
  const roles = new Set(generationUploadAssets.map((asset) => asset.role));
  const usesVisibleSafetyMarks = roles.has("storyboard_grid_submission_privacy_safe")
    || roles.has("platform_privacy_fallback_character_reference");
  if (!usesVisibleSafetyMarks) return;
  const text = String(modelPrompt || "");
  const namesTheInputMarks = /网格|格栅|红线|遮罩|贴码|马赛克/.test(text);
  const negativeBeforeMark = /(不|不得|不能|禁止|不可|完全不可见|不带入|不继承|不复制|不渲染|不呈现)[^。\n]{0,36}(网格|格栅|红线|遮罩|贴码|马赛克)/.test(text);
  const markBeforeNegative = /(网格|格栅|红线|遮罩|贴码|马赛克)[^。\n]{0,80}(最终画面|最终成片|最终输出|生成结果)[^。\n]{0,36}(不进入|不出现|不可见|不得出现|不能出现|不渲染|不呈现|禁止渲染|禁止呈现)/.test(text);
  const saysTheyMustNotAppear = negativeBeforeMark || markBeforeNegative;
  if (!namesTheInputMarks || !saysTheyMustNotAppear) throw new Error("VIDEO_PROMPT_VISIBLE_SAFETY_MARKS_NOT_COMPILED");
}

function runProcess(command, args, { env, onEvent, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("VIDEO_PROMPT_TIMEOUT")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); onEvent?.(chunk.toString().trim().slice(0, 300)); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr || stdout || `VIDEO_PROMPT_EXIT_${code}`));
    });
  });
}
