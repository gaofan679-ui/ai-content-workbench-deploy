import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexArgs } from "./codex-runner.mjs";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";

export async function runMotionPreflightStage({ task, taskDir, onEvent, env = process.env }) {
  const skillContract = resolveSkillContract("motion_preflight", { env });
  const contractReceipt = skillContractReceipt(skillContract);
  mkdirSync(taskDir, { recursive: true });
  const resultPath = join(taskDir, "motion-preflight-result.json");
  const snapshotPath = join(taskDir, "motion-preflight-task.json");
  const contractReceiptPath = join(taskDir, "motion-preflight-skill-contract.json");
  const approvedStoryboard = task.artifacts.find((item) => item.stage === "storyboard" && item.published && /分镜/.test(item.label));
  const approvedPerson = task.artifacts.find((item) => item.stage === "person" && item.published && /人物/.test(item.label));
  if (!approvedStoryboard?.path || !existsSync(approvedStoryboard.path)) throw new Error("APPROVED_STORYBOARD_MISSING");
  if (!approvedPerson?.path || !existsSync(approvedPerson.path)) throw new Error("APPROVED_PERSON_MISSING");
  const snapshot = {
    schema_version: 2,
    id: task.id,
    title: task.title,
    generation_stage: "motion_preflight",
    approved_storyboard_path: approvedStoryboard.path,
    approved_person_path: approvedPerson.path,
    reference_video_path: task.reference_video_path,
    source_analysis_dir: join(taskDir, "01_source_video_analysis"),
    existing_artifacts: task.artifacts.map(({ stage, label, path, published }) => ({ stage, label, path, published: Boolean(published) })),
    external_request_authorized: false,
    video_generation_authorized: false,
    skill_contract: contractReceipt,
    skill_contract_receipt_path: contractReceiptPath,
  };
  writeFileSync(contractReceiptPath, `${JSON.stringify(contractReceipt, null, 2)}\n`, { flag: existsSync(contractReceiptPath) ? "w" : "wx" });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: existsSync(snapshotPath) ? "w" : "wx" });
  onEvent?.("正在逐镜整理人物动作、镜头运动、衣物跟随和稳定锚点；本阶段不会生视频。");
  if (env.WORKBENCH_MOTION_PREFLIGHT_GENERATOR) {
    await runProcess(process.execPath, [env.WORKBENCH_MOTION_PREFLIGHT_GENERATOR, "--task-json", snapshotPath, "--task-dir", taskDir, "--output", resultPath], { env, onEvent });
  } else {
    const prompt = buildMotionPreflightPrompt(task, taskDir, snapshotPath, approvedStoryboard.path, approvedPerson.path, skillContract);
    writeFileSync(join(taskDir, "motion-preflight-prompt.md"), prompt, { flag: existsSync(join(taskDir, "motion-preflight-prompt.md")) ? "w" : "wx" });
    const args = buildCodexArgs({ taskDir, resultPath, env });
    await runManagedCodex({ args, prompt, env, onEvent, timeoutMs: 15 * 60 * 1000 });
  }
  if (!existsSync(resultPath)) throw new Error("MOTION_PREFLIGHT_RESULT_MISSING");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.status === "completed") {
    const missing = ["运动蓝图", "动态预演报告", "视频提示词交接"].filter((label) => !(result.artifacts || []).some((item) => item.path && existsSync(item.path) && item.label.includes(label)));
    if (missing.length) throw new Error(`MOTION_PREFLIGHT_ARTIFACTS_MISSING:${missing.join(",")}`);
  }
  const finalized = { ...result, skill_contract: contractReceipt, skill_contract_receipt_path: contractReceiptPath, external_request_started: false, video_generation_started: false, estimated_cost_cny: 0 };
  writeFileSync(resultPath, `${JSON.stringify(finalized, null, 2)}\n`);
  return finalized;
}

export function buildMotionPreflightPrompt(task, taskDir, snapshotPath, storyboardPath, personPath, skillContract) {
  return buildSkillOwnedPrompt({
    contract: skillContract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      task_snapshot_path: snapshotPath,
      work_dir: taskDir,
      approved_storyboard_path: storyboardPath,
      approved_person_path: personPath,
      reference_video_path: task.reference_video_path,
      source_analysis_dir: join(taskDir, "01_source_video_analysis"),
      existing_artifacts: task.artifacts.filter((item) => ["decomposition", "rewrite", "storyboard", "person"].includes(item.stage)).map(({ stage, label, path, published }) => ({ stage, label, path, published: Boolean(published) })),
    },
    runtimeEnvelope: {
      external_requests_allowed: false,
      source_upload_allowed: false,
      image_generation_allowed: false,
      video_generation_allowed: false,
      downstream_stage_execution_allowed: false,
      output_interface: { required_artifact_labels: ["运动蓝图", "动态预演报告", "视频提示词交接"], published: false, estimated_cost_cny: 0 },
      user_message_policy: "只用大白话说明结果和下一步；不能把动态预演写成视频已生成。",
    },
  });
}

function runProcess(command, args, { env, onEvent, stdin = null, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("MOTION_PREFLIGHT_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const message = event.message || event.item?.text || event.type;
          if (message) onEvent?.(String(message).slice(0, 300));
        } catch { if (line.trim()) onEvent?.(line.trim().slice(0, 300)); }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr || stdout || `MOTION_PREFLIGHT_EXIT_${code}`));
    });
    child.stdin.end(stdin || "");
  });
}
