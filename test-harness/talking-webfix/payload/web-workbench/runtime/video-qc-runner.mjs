import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexArgs } from "./codex-runner.mjs";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";
import { createStageExecutionReceipt, writeStageExecutionReceipt } from "./stage-execution-receipt.mjs";

export async function runVideoQcStage({ task, taskDir, generationResult, onEvent, env = process.env }) {
  const video = (generationResult?.artifacts || []).find((item) => /\.(mp4|mov|webm)$/i.test(item.path || ""));
  if (!video?.path || !existsSync(video.path)) throw qcError("VIDEO_QC_RESULT_FILE_MISSING");
  const packPath = task.generation_pack_result?.artifacts?.find((item) => item.label === "视频生成任务包")?.path;
  if (!packPath || !existsSync(packPath)) throw qcError("VIDEO_QC_TASK_PACK_MISSING");
  const contract = resolveSkillContract("video_qc", { env });
  const contractReceipt = skillContractReceipt(contract);
  const qcDir = join(taskDir, "10_video_qc", generationResult.generation_kind || "generated_video");
  mkdirSync(qcDir, { recursive: true });
  const snapshotPath = join(qcDir, "video-qc-input.json");
  const resultPath = join(qcDir, "video-qc-result.json");
  const contractPath = join(qcDir, "video-qc-skill-contract.json");
  const executionReceiptPath = join(qcDir, "video-qc-execution-receipt.json");
  const snapshot = {
    schema_version: 1,
    task_id: task.id,
    project_name: task.title,
    generated_video_path: video.path,
    generation_kind: generationResult.generation_kind,
    task_pack_path: packPath,
    reference_video_path: task.reference_video_path,
    explicit_qc_authorization: true,
    automatic_regeneration_allowed: false,
  };
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(contractPath, `${JSON.stringify(contractReceipt, null, 2)}\n`);
  const prompt = buildSkillOwnedPrompt({
    contract,
    facts: { task_snapshot_path: snapshotPath, work_dir: qcDir },
    runtimeEnvelope: {
      external_requests_allowed: false,
      source_upload_allowed: false,
      video_generation_allowed: false,
      automatic_regeneration_allowed: false,
      user_explicit_qc_authorization: true,
      output_interface: { required_artifact_labels: ["视频质检报告"], published: false, estimated_cost_cny: 0 },
      user_message_policy: "用大白话说明能否采用、主要问题和应退回哪一步；不得自动重生。",
    },
  });
  onEvent?.("视频已返回，正在按正式质检规则检查画面与任务包；不会自动重生。");
  if (env.WORKBENCH_VIDEO_QC_GENERATOR) {
    await env.WORKBENCH_VIDEO_QC_GENERATOR({ task, snapshotPath, qcDir, resultPath, contract });
  } else {
    const args = buildCodexArgs({ taskDir: qcDir, resultPath, env });
    await runManagedCodex({ args, prompt, env, onEvent, timeoutMs: 15 * 60 * 1000 });
  }
  if (!existsSync(resultPath)) throw qcError("VIDEO_QC_RESULT_MISSING");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const report = (result.artifacts || []).find((item) => /视频质检报告/.test(item.label || "") && item.path && existsSync(item.path));
  if (!report) throw qcError("VIDEO_QC_REPORT_MISSING");
  const receipt = createStageExecutionReceipt({
    stage: "video_qc",
    executionType: env.WORKBENCH_VIDEO_QC_GENERATOR ? "test_fixture" : "codex_skill_execution",
    ownerSkill: contract.owner_skill,
    skillContract: contract,
    invoked: !env.WORKBENCH_VIDEO_QC_GENERATOR,
    adapter: env.WORKBENCH_VIDEO_QC_GENERATOR ? "test-fixture" : "managed-codex",
    inputs: [{ label: "生成视频", path: video.path }, { label: "视频任务包", path: packPath }],
    outputs: [{ label: "视频质检报告", path: report.path }],
    allowedTransformations: ["只读诊断与返工路由"],
  });
  writeStageExecutionReceipt(executionReceiptPath, receipt);
  const normalizedDecision = normalizeQcDecision(result, readFileSync(report.path, "utf8"));
  return { ...result, ...normalizedDecision, skill_contract: contractReceipt, execution_receipt_path: executionReceiptPath, automatic_regeneration_started: false, external_request_started: false };
}

export function normalizeQcDecision(result, reportText = "") {
  if (result?.decision === "pass" || result?.decision === "reject") return { decision: result.decision };
  const evidence = [result?.summary, result?.user_message, reportText].filter(Boolean).join("\n");
  if (/不通过|不能采用|暂时不能采用|reject|needs_rework/i.test(evidence)) return { decision: "reject", business_qc_status: "needs_rework" };
  if (/通过|可以采用|可采用|pass/i.test(evidence)) return { decision: "pass", business_qc_status: "pass" };
  return { decision: "review", business_qc_status: "blocked" };
}

function qcError(code) {
  const error = new Error(code);
  error.code = code;
  error.external_request_started = false;
  return error;
}
