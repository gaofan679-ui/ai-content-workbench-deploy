import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { buildSkillOwnedPrompt, resolveSkillContract, skillContractReceipt } from "./skill-contract-bridge.mjs";
import { artifactRoot, codexWorkspaceRoot } from "./portable-paths.mjs";
import {
  extractFinalVisualReconstructionPrompt,
  loadLockedRealPersonPrompt,
} from "./real-person-stage-contracts.mjs";

const outputSchemaPath = fileURLToPath(new URL("./model-style-analysis-output-schema.json", import.meta.url));
const LOCKED_TEMPLATE_SHA256 = "af51d24bc887c33c1273c72920839b377b19cf6b5ad26dc14489229ba1401fbb";

export async function runModelStyleAnalysis({ project, benchmark, projectDir, onEvent, env = process.env }) {
  const analysis = project.talking_style_analysis;
  if (!analysis) throw new Error("MODEL_STYLE_ANALYSIS_MISSING");
  const taskDir = join(projectDir, "runs", `style-analysis-${analysis.attempt_number}`);
  mkdirSync(taskDir, { recursive: true });
  const isRealPerson = project.route === "real_person";
  const contract = resolveSkillContract(isRealPerson ? "real_person_generation" : "talking_head_style_reverse", { env });
  const lockedRealPersonPrompt = isRealPerson ? loadLockedRealPersonPrompt("style_compiler", { env }) : null;
  const templatePath = lockedRealPersonPrompt?.path || join(dirname(contract.source_path), "references", "talking-head-master-style-reverse-prompt.md");
  if (!existsSync(templatePath)) throw new Error("MODEL_STYLE_LOCKED_TEMPLATE_MISSING");
  const template = readFileSync(templatePath);
  const templateSha256 = createHash("sha256").update(template).digest("hex");
  if (!isRealPerson && templateSha256 !== LOCKED_TEMPLATE_SHA256) throw new Error("MODEL_STYLE_LOCKED_TEMPLATE_CHANGED");

  const resultPath = join(taskDir, "style-analysis-result.json");
  const receiptPath = join(taskDir, "style-analysis-skill-contract.json");
  writeFileSync(receiptPath, `${JSON.stringify(skillContractReceipt(contract), null, 2)}\n`, { flag: "wx" });
  const prompt = isRealPerson ? lockedRealPersonPrompt.prompt : buildSkillOwnedPrompt({
    contract,
    facts: {
      project_id: project.id,
      project_name: project.name,
      benchmark_reference: {
        asset_id: benchmark.asset_id,
        path: benchmark.path,
        sha256: benchmark.sha256,
        usage: "analysis_only",
      },
      locked_template_path: templatePath,
      locked_template_sha256: templateSha256,
      reverse_prompt_type: "talking_head_master_style",
      approved_person_asset_contract: project.route === "real_person"
        ? {
            mode: "identity_appearance_and_wardrobe_locked",
            identity_asset_id: project.active_asset_lock?.v0_asset_id || null,
            appearance_asset_id: project.active_asset_lock?.appearance_bridge_asset_id || null,
            wardrobe_asset_id: project.active_asset_lock?.styled_anchor_asset_id || null,
            benchmark_may_control: ["pose", "camera", "composition", "scene", "lighting", "color", "image_quality", "capture_characteristics"],
            benchmark_must_not_control: ["identity", "hair", "glasses", "makeup", "clothing", "jewelry", "body_traits"],
          }
        : {
            mode: "single_approved_model_master",
            identity_asset_id: project.approved_asset_id || null,
            benchmark_may_control: ["pose", "camera", "composition", "scene", "lighting", "color", "image_quality", "capture_characteristics"],
            benchmark_must_not_control: ["identity"],
          },
    },
    runtimeEnvelope: {
      operation: "analyze_benchmark_and_reverse_talking_head_master_style",
      image_generation_allowed: false,
      video_generation_allowed: false,
      automatic_retry_allowed: false,
      provider_switch_allowed: false,
      benchmark_must_not_enter_final_generation: true,
      required_output: {
        status: "completed_or_blocked",
        summary: "short_user_facing_summary",
        reverse_conclusion: "complete_first_section_requested_by_locked_template",
        generation_prompt: "complete_second_section_directly_usable_for_generation",
      },
      user_message_policy: project.route === "real_person"
        ? "只分析用户提供的口播对标图。项目已锁定人物身份、发型和穿搭：对标人物的脸、发型、眼镜、妆容、服装、首饰、身材、文字、字幕和水印都不得进入最终提示词。最终提示词必须说明已确认的人物资产优先。"
        : "只分析用户提供的口播对标图。对标图文字、字幕、水印、人物身份都不进入最终提示词。",
    },
  });
  const promptPath = join(taskDir, "style-analysis-prompt.md");
  writeFileSync(promptPath, prompt, { flag: "wx" });

  if (env.WORKBENCH_MODEL_STYLE_ANALYZER) {
    const { spawn } = await import("node:child_process");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [env.WORKBENCH_MODEL_STYLE_ANALYZER, "--benchmark", benchmark.path, "--output", resultPath], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stdout.on("data", (chunk) => onEvent?.(chunk.toString().trim()));
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `画面分析器退出码 ${code}`)));
    });
  } else {
    const args = [
      "exec", "-", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write",
      "--model", env.WORKBENCH_CODEX_MODEL || "gpt-5.6-sol",
      "-C", taskDir,
      "--add-dir", codexWorkspaceRoot(env),
      "--add-dir", dirname(contract.source_path),
      "--image", benchmark.path,
    ];
    const formalRoot = artifactRoot(env);
    if (existsSync(formalRoot)) args.push("--add-dir", formalRoot);
    if (!isRealPerson) args.push("--output-schema", outputSchemaPath);
    args.push("--output-last-message", resultPath);
    onEvent?.(isRealPerson
      ? "正在按 V3 锁定编译器分析对标图；这里只生成文字画面提示词，不会生图。"
      : "正在按锁定模板分析对标图；这一步只反推画面，不会生图。");
    await runManagedCodex({ args, prompt, env, onEvent, timeoutMs: Number(env.WORKBENCH_CODEX_STYLE_TIMEOUT_MS || 20 * 60 * 1000) });
  }
  if (!existsSync(resultPath)) throw new Error("MODEL_STYLE_ANALYSIS_RESULT_MISSING");
  const rawResult = readFileSync(resultPath, "utf8");
  const result = isRealPerson ? normalizeRealPersonStyleResult(rawResult) : JSON.parse(rawResult);
  if (result.status !== "completed") throw new Error(result.summary || "对标图分析没有完成。");
  return result;
}

function normalizeRealPersonStyleResult(rawResult) {
  const text = String(rawResult || "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed?.status === "completed" && parsed?.generation_prompt) return parsed;
  } catch {
    // The locked V3 compiler intentionally returns Markdown, not the old JSON envelope.
  }
  const generationPrompt = extractFinalVisualReconstructionPrompt(text);
  const markerIndex = text.indexOf("# FINAL_VISUAL_RECONSTRUCTION_PROMPT");
  const conclusion = markerIndex > 0 ? text.slice(0, markerIndex).trim() : "已完成对标画面的因果归因与目标强度校准。";
  return {
    status: "completed",
    summary: "对标画面已经完成分析，最终画面提示词已从锁定标记区域提取。",
    reverse_conclusion: conclusion.slice(0, 12000),
    generation_prompt: generationPrompt,
  };
}
