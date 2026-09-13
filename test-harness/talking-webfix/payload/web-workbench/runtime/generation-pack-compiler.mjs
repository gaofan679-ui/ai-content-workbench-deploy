import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createStageExecutionReceipt, sha256Text, writeStageExecutionReceipt } from "./stage-execution-receipt.mjs";
import { skillFile } from "./portable-paths.mjs";

export function compileGenerationPack({ task, taskDir, evidenceProjection, resultPath, env = process.env }) {
  if (evidenceProjection?.status !== "ready") throw packError("GENERATION_EVIDENCE_NOT_READY");
  const projectionDir = evidenceProjection.projectionDir;
  const promptPath = join(projectionDir, "04_video_prompts/canonical_video_prompt_body.txt");
  const bindingPath = join(projectionDir, "04_video_prompts/素材绑定说明.md");
  const people = readJson(join(projectionDir, "03_people_assets/people-manifest.json"));
  const storyboard = readJson(join(projectionDir, "04_storyboard/storyboard-manifest.json"));
  const motionPath = join(taskDir, "05_motion_preflight/motion_blueprint.json");
  const motion = readJson(motionPath);
  const canonicalPrompt = readFileSync(promptPath, "utf8").trim();
  const canonicalPromptSha256 = sha256Text(canonicalPrompt);
  const smokeTest = task.generation_route_choice === "smoke_test_first";
  const modelSelection = task.generation_model_snapshot || {
    model_key: task.generation_model_key || "star-video2",
    model_name: "Seedance 2.0 VIP",
    request_duration_seconds: smokeTest ? 4 : 10,
    target_duration_seconds: smokeTest ? 4 : 8.2,
    resolution: "720p",
    aspect_ratio: "9:16",
    generate_audio: true,
  };
  const selectedShot = smokeTest ? selectSmokeTestShot(motion.shots || []) : null;
  const modelPrompt = smokeTest ? buildSmokeTestPrompt(selectedShot) : buildFullSequencePrompt(canonicalPrompt);
  const fingerprint = createHash("sha256").update(JSON.stringify({ compiler_version: 7, task: task.id, route: task.generation_route_choice, model: modelSelection.model_key, canonicalPromptSha256, modelPrompt, people, storyboard, selectedShot })).digest("hex").slice(0, 12);
  const packDir = join(taskDir, "07_generation_pack", `evidence-bridge-${fingerprint}`);
  mkdirSync(packDir, { recursive: true });

  const references = packReferences(people, storyboard);
  const highRiskShot = selectedShot || (motion.shots || []).find((shot) => /high/i.test(String(shot.risk || ""))) || (motion.shots || [])[0] || null;
  const packType = task.generation_route_choice === "smoke_test_first" ? "single_sample_first" : task.generation_route_choice;
  const effectivePromptPath = join(packDir, smokeTest ? "smoke_sample_prompt.txt" : "full_sequence_prompt.txt");
  writeFileSync(effectivePromptPath, `${modelPrompt}\n`);
  const taskPack = {
    schema_version: 2,
    task_id: task.id,
    project_name: task.title,
    pack_id: `pack-${task.id}-${fingerprint}`,
    pack_type: packType,
    pack_status: "ready",
    preflight_status: "pass",
    generation_route_choice: task.generation_route_choice,
    provider: "libtv",
    model: modelSelection.model_key,
    model_name: modelSelection.model_name,
    execution_mode_for_runner: "dry_run",
    external_request_started: false,
    video_generation_started: false,
    estimated_cost_cny: 0,
    task_cards: [{
      task_id: smokeTest ? `motion-smoke-${selectedShot.shot_id}` : "full-sequence-01",
      source_shot: smokeTest ? selectedShot.shot_id : "full_sequence",
      generation_unit: smokeTest ? "single_shot_smoke_test" : "full_sequence",
      seedance_mode: "omnireference",
      quality: "fast",
      resolution: modelSelection.resolution,
      aspect_ratio: modelSelection.aspect_ratio,
      duration_seconds: modelSelection.request_duration_seconds,
      trim_to_seconds: modelSelection.target_duration_seconds,
      generation_count: 1,
      generate_audio: modelSelection.generate_audio,
      reference_audio: "none",
      audio_route: "native_model_audio",
      references,
      canonical_prompt: smokeTest ? null : canonicalPrompt,
      canonical_prompt_sha256: smokeTest ? null : canonicalPromptSha256,
      canonical_prompt_source: smokeTest ? "motion_blueprint_local_sample_adapter" : promptPath,
      provider_prompt_template_sha256: sha256Text(modelPrompt),
      prompt_body_transformations: smokeTest ? ["sample_prompt_compiled_from_motion_blueprint"] : [],
      reference_binding_transformation: "none_structured_bindings_stay_outside_prompt_body",
      model_prompt_path: effectivePromptPath,
      model_prompt: modelPrompt,
      motion_evidence_level: highRiskShot?.evidence_level || motion.motion_evidence_level || "L2_anchor_timeline",
      motion_evidence_source: motionPath,
      motion_evidence_decision: "pass",
      generation_route_reason: task.generation_route_choice === "smoke_test_first" ? "先生成一条单次小样验证人物、穿搭和高风险动作，再决定是否整片生成。" : "按已确认路线准备单次整段任务。",
      ...(smokeTest ? {
        experiment_contract: {
          route_id: `smoke-${selectedShot.shot_id}`,
          duration_seconds: 4,
          route_assets: references.map((item) => item.alias),
          forbidden_assets: ["原片人物关键帧", "完整清晰目标人物自拍", "旧失败候选"],
          pass_criteria: ["人物与穿搭稳定", "手与托盘接触真实", "红线、网格和拼图边界不进入结果", "画面保持单镜头而非宫格"],
        },
      } : {}),
    }],
    evidence: {
      gatekeeper_report: evidenceProjection.gatekeeperReportPath,
      evidence_projection_manifest: evidenceProjection.manifestPath,
      asset_binding_note: bindingPath,
      original_assets_preserved: true,
    },
  };
  const taskPackPath = join(packDir, "video_generation_task_pack.json");
  writeJson(taskPackPath, taskPack);
  writeFileSync(join(packDir, "prompt_一键复制.txt"), `${modelPrompt}\n`);
  writeFileSync(join(packDir, "素材绑定说明.md"), bindingDocument(references, task.remix_precision_route));
  writeJson(join(packDir, "asset_binding_manifest.json"), { schema_version: 1, task_id: task.id, references, upload_order: references.map((item) => item.alias), preflight_status: "pass" });
  writeFileSync(join(packDir, "manual_upload_checklist.md"), uploadChecklist(references));

  const redlinePath = join(packDir, "redline_scan_report.json");
  const scan = runRedline(env.WORKBENCH_VIDEO_PACK_REDLINE_SCAN || skillFile("ai-video-generation-pack", "scripts/video_task_pack_redline_scan.py", env), packDir, redlinePath, task.remix_precision_route);
  if (scan.status !== "passed" && scan.status !== "pass") throw packError(`VIDEO_PACK_REDLINE_BLOCKED:${(scan.blockers || []).map((item) => item.code || item).join(",")}`);
  const preflight = {
    schema_version: 2,
    task_id: task.id,
    status: "passed",
    preflight_status: "pass",
    gatekeeper_status: "passed",
    gatekeeper_blockers: [],
    redline_scan_status: scan.status,
    redline_blockers: [],
    generation_route_choice: task.generation_route_choice,
    provider: "libtv",
    model: modelSelection.model_key,
    model_name: modelSelection.model_name,
    external_request_started: false,
    video_generation_started: false,
    estimated_cost_cny: 0,
  };
  const preflightJsonPath = join(packDir, "pack_preflight.json");
  const preflightReportPath = join(packDir, "pack_preflight_report.md");
  writeJson(preflightJsonPath, preflight);
  writeFileSync(preflightReportPath, preflightReport(task, taskPack, references, evidenceProjection, redlinePath));
  const executionReceiptPath = join(packDir, "generation-pack-execution-receipt.json");
  writeStageExecutionReceipt(executionReceiptPath, createStageExecutionReceipt({
    stage: "generation_pack",
    executionType: "local_deterministic_adapter",
    ownerSkill: null,
    invoked: false,
    adapter: "generation-pack-compiler-v7",
    inputs: [{ label: "正式提示词原文", path: promptPath }, { label: "运动蓝图", path: motionPath }],
    outputs: [{ label: "视频生成任务包", path: taskPackPath }, { label: "任务包预检", path: preflightJsonPath }],
    allowedTransformations: smokeTest
      ? ["从运动蓝图编译4秒测试提示词", "把参考图别名留给提交器按平台最终顺序绑定"]
      : ["在正式提示词原文前增加结构化参考图职责块", "把参考图别名留给提交器按平台最终顺序绑定"],
    notes: smokeTest
      ? "本次小样提示词由本地确定性适配器编译，不声明再次执行提示词 Skill。"
      : "正式提示词正文逐字保留；本阶段没有再次执行 ai-video-generation-pack Skill。",
  }));
  const result = {
    status: "completed",
    summary: task.generation_route_choice === "smoke_test_first" ? "生成前检查已通过，已准备一条单次小样任务；视频尚未提交。" : "生成前检查已通过，视频任务包已经准备好；视频尚未提交。",
    estimated_cost_cny: 0,
    artifacts: [
      { label: "视频生成任务包", path: taskPackPath, published: false },
      { label: "任务包预检", path: preflightReportPath, published: false },
      { label: "任务包预检数据", path: preflightJsonPath, published: false },
      { label: "任务包执行凭证", path: executionReceiptPath, published: false },
    ],
    requires_confirmation: true,
    external_request_started: false,
    submission_preview: {
      provider: "libtv",
      model_key: modelSelection.model_key,
      model_name: modelSelection.model_name,
      sample_type: smokeTest ? "4 秒关键动作小样" : "直接生成正式版",
      generation_kind: smokeTest ? "smoke_test" : "full_sequence",
      duration_seconds: taskPack.task_cards[0].duration_seconds,
      target_duration_seconds: taskPack.task_cards[0].trim_to_seconds,
      aspect_ratio: taskPack.task_cards[0].aspect_ratio,
      resolution: taskPack.task_cards[0].resolution,
      generate_audio: taskPack.task_cards[0].generate_audio,
      generation_count: 1,
      upload_assets: references.map((item) => ({ alias: item.alias, role: item.role, filename: basename(item.path) })),
      billable_submission_count_allowed: 1,
      automatic_retry: false,
      project_binding_status: "not_checked",
      cost_quote_status: "pending_libtv_confirmation",
      billable_submission_allowed: false,
    },
    user_message: task.generation_route_choice === "smoke_test_first" ? "生成资料已经检查完整，并准备好一条单次小样。视频还没有提交，也没有产生生成费用；下一步确认后才会开始真实生成。" : "生成资料已经检查完整，视频任务包已就绪。视频还没有提交，也没有产生生成费用；下一步确认后才会开始真实生成。",
  };
  writeJson(resultPath, result);
  return result;
}

function packReferences(people, storyboard) {
  const findAsset = (type) => (people.assets || []).find((item) => item.asset_type === type)?.path;
  const refs = [
    { alias: "@分镜安全提交版", role: "primary_structure_anchor", asset_role: "primary_structure_anchor", primary_visual_anchor: "yes", path: storyboard.storyboard_grid_submission_privacy_safe, status: "approved", required_for_video: true, upload_to_video_model: true, can_lock_identity: false },
    { alias: "@三道红线人物参考", role: "video_safe_character_reference", path: findAsset("video_safe_character"), status: "approved", required_for_video: true, upload_to_video_model: true, can_lock_identity: "partial" },
    { alias: "@局部材质拼图", role: "safe_material_collage_upload", path: findAsset("safe_material_collage_upload"), status: "approved", required_for_video: true, upload_to_video_model: true, can_lock_identity: "partial" },
  ];
  for (const item of refs) if (!item.path || !existsSync(item.path)) throw packError(`PACK_REFERENCE_MISSING:${item.alias}`);
  return refs;
}

function selectSmokeTestShot(shots) {
  const selected = shots.find((shot) => /high/i.test(String(shot.risk || ""))) || shots.find((shot) => String(shot.evidence_level || "").startsWith("L3")) || shots[0];
  if (!selected?.shot_id) throw packError("SMOKE_TEST_SHOT_MISSING");
  return selected;
}

export function buildSmokeTestPrompt(shot) {
  const microSteps = (shot.micro_steps || []).map((item) => `${item.t}：${item.state}`).join("；");
  const stableAnchors = (shot.stable_anchors || []).join("、");
  const forbidden = (shot.forbidden || []).join("、");
  return `@分镜安全提交版只参考与镜头 ${shot.shot_id} 对应的单格构图、景别、动作起点和空间，不从该素材读取或复制人物五官，不生成宫格、分屏、白边或网格；@三道红线人物参考负责体型、穿搭、发型和脸型方向；@局部材质拼图负责五官材质、肤感、服装纹理和饰品细节。红线、网格和拼图边界只属于输入标记，最终画面必须自然清晰且完全不可见。

朋友用手机随手记录一段生活化穿搭近景，人物像真实逛店的穿搭博主，肩颈松弛，不走秀、不刻意摆拍。开场状态：${shot.start_state || "人物已经进入当前镜头动作起点。"} 触发后，${shot.main_motion || shot.peak_motion || "人物完成自然的小幅动作。"}${microSteps ? ` 动作按自然时间连续发生：${microSteps}。` : ""} 结束时：${shot.end_state || "人物自然停留。"}

镜头表现：${shot.camera_reaction || "固定手机镜头，只保留轻微手持呼吸。"} 次级动态：${shot.secondary_motion || "衣物和道具只保留真实低幅惯性。"} 必须稳定：${stableAnchors || "人物、服装、道具和场景"}。禁止：${forbidden || "人物变形、服装漂移、道具悬浮"}。

声音只保留自然环境声和轻微衣料声，不要人物说话、口播、旁白或可听见的人声对话。画面不新增字幕、水印、价格、二维码、促销文字或乱码。`;
}

export function buildFullSequencePrompt(prompt) {
  const body = String(prompt || "").trim();
  if (!body) throw packError("CANONICAL_VIDEO_PROMPT_EMPTY");
  return body;
}

function uploadChecklist(references) {
  return `# 上传素材清单\n\n按以下顺序上传：\n${references.map((item, index) => `${index + 1}. ${item.alias}（${basename(item.path)}）：${item.role}`).join("\n")}\n\n当前只是任务包准备，尚未上传或生成视频。\n`;
}

function bindingDocument(references, route) {
  return `# 素材职责\n\nremix_precision_route: ${route}\n\n${references.map((item, index) => `## ${index + 1}. ${item.alias}\n\nasset_role: ${item.asset_role || item.role}\nprimary_visual_anchor: ${item.primary_visual_anchor || "no"}\nrole: ${item.role}\npath: ${item.path}\nstatus: ${item.status}\nrequired_for_video: ${item.required_for_video}\nupload_to_video_model: ${item.upload_to_video_model}\ncan_lock_identity: ${item.can_lock_identity}\n`).join("\n")}\n`;
}

function preflightReport(task, taskPack, references, projection, redlinePath) {
  return `# ${task.title}｜生成前检查\n\n## 结论\n\n- 状态：通过\n- 路线：${task.generation_route_choice === "smoke_test_first" ? "先生成一条单次小样" : task.generation_route_choice}\n- 素材：${references.length} 项已确认并完成职责绑定\n- 视频：尚未提交\n- 外部请求：未发起\n- 当前费用：0 元\n\n## 已核对\n\n- 人物安全资产：通过\n- 分镜与 9:16 单格比例：通过\n- 原片逐格映射：通过\n- 高风险动作证据：通过\n- 正式视频提示词与素材别名：通过\n- 任务包红线扫描：通过\n\n## 内部证据\n\n- 统一证据：${projection.manifestPath}\n- 硬检查：${projection.gatekeeperReportPath}\n- 提示词红线：${redlinePath}\n\n下一步只有在确认真实生成后，才交给视频生成执行器。\n`;
}

function runRedline(script, packDir, reportPath, route) {
  const result = spawnSync("python3", [script, "--pack-dir", packDir, "--route", route || "anchor_frame_alignment", "--json", "--write-report", reportPath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  let payload;
  try { payload = JSON.parse(result.stdout); }
  catch { throw packError(`VIDEO_PACK_REDLINE_UNREADABLE:${result.stderr || result.stdout}`); }
  return payload;
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function packError(code) { const error = new Error(code); error.code = code; error.external_request_started = false; error.video_generation_started = false; return error; }
