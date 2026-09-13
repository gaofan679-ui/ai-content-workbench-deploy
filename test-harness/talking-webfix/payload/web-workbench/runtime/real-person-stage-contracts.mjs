import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSkillContract } from "./skill-contract-bridge.mjs";

export const REAL_PERSON_STAGE_ORDER = Object.freeze([
  "v0",
  "appearance_bridge",
  "styled_anchor",
  "performance_master",
  "current_shot",
]);

export const REAL_PERSON_PROMPT_FILES = Object.freeze({
  v0: Object.freeze({
    filename: "step-0-commercial-identity-master.md",
    sha256: "5711b4424b36457c3c6dba2ff320d794a91918544c9a9ab3f548cce8a61cde4d",
  }),
  appearance_bridge: Object.freeze({
    filename: "step-1-identity-locked-hair-v2.md",
    sha256: "e96abb48cd03a95d9507af9b729c36192cc6e0e01eb5cf8acd6aa4d62795bbcf",
  }),
  styled_anchor: Object.freeze({
    filename: "step-2-character-locked-outfit-v2.md",
    sha256: "0dd76d35eafe59c90222d53a0f3c0ffeb9552ac88cb7d6219aef06d6f565bf3f",
  }),
  performance_master: Object.freeze({
    filename: "step-3-character-locked-performance-camera.md",
    sha256: "d8f3486be116f2ff37856ec4d17e20a08038b77e5977f72ab14287f81b118637",
  }),
  style_compiler: Object.freeze({
    filename: "step-4-causal-visual-compiler-v3.md",
    sha256: "0df68205eb9059379ed058aeb0066aba84baf4082b01ad2485bf7e4940e7f403",
  }),
});

export const REAL_PERSON_AUXILIARY_PROMPT_FILES = Object.freeze({
  styled_identity_closeup: Object.freeze({
    filename: "styled-identity-closeup-helper.md",
    sha256: "b324bebc279052ec0af2ddc7faa87d18c33be17043cbea6107b909e5713b7204",
  }),
});

export function loadLockedRealPersonPrompt(stage, { env = process.env } = {}) {
  const spec = REAL_PERSON_PROMPT_FILES[stage];
  if (!spec) throw contractError("REAL_PERSON_STAGE_PROMPT_UNKNOWN", `真人模特阶段没有登记锁定提示词：${stage}`);
  const contract = resolveSkillContract("real_person_generation", { env });
  const path = join(dirname(contract.source_path), "prompts", spec.filename);
  if (!existsSync(path)) throw contractError("REAL_PERSON_STAGE_PROMPT_MISSING", `真人模特锁定提示词不可用：${spec.filename}`);
  const buffer = readFileSync(path);
  const actualSha256 = createHash("sha256").update(buffer).digest("hex");
  if (actualSha256 !== spec.sha256)
    throw contractError("REAL_PERSON_STAGE_PROMPT_CHANGED", `真人模特锁定提示词已变化，已在生图前停止：${spec.filename}`);
  return Object.freeze({
    stage,
    path,
    filename: spec.filename,
    sha256: actualSha256,
    prompt: buffer.toString("utf8").trim(),
    skill_contract: contract,
  });
}

export function compileLockedRealPersonGenerationPrompt(stage, instruction = "", options = {}) {
  if (stage === "current_shot")
    throw contractError("REAL_PERSON_CURRENT_SHOT_REQUIRES_ANALYSIS", "画质氛围阶段必须先完成对标图分析并确认最终提示词。");
  const locked = loadLockedRealPersonPrompt(stage, options);
  const supplement = String(instruction || "").replace(/\0/g, "").trim().slice(0, 4000);
  return Object.freeze({
    ...locked,
    final_prompt: supplement
      ? `${locked.prompt}\n\n# 本次用户补充要求\n\n${supplement}`
      : locked.prompt,
  });
}

export function compileStyledIdentityCloseupPrompt(instruction = "", { env = process.env } = {}) {
  const spec = REAL_PERSON_AUXILIARY_PROMPT_FILES.styled_identity_closeup;
  const contract = resolveSkillContract("real_person_generation", { env });
  const path = join(dirname(contract.source_path), "prompts", spec.filename);
  if (!existsSync(path))
    throw contractError("REAL_PERSON_AUXILIARY_PROMPT_MISSING", `真人模特近景身份图提示词不可用：${spec.filename}`);
  const buffer = readFileSync(path);
  const actualSha256 = createHash("sha256").update(buffer).digest("hex");
  if (actualSha256 !== spec.sha256)
    throw contractError("REAL_PERSON_AUXILIARY_PROMPT_CHANGED", `真人模特近景身份图提示词已变化，已在生图前停止：${spec.filename}`);
  const prompt = buffer.toString("utf8").trim();
  const supplement = String(instruction || "").replace(/\0/g, "").trim().slice(0, 2000);
  return Object.freeze({
    auxiliary_mode: "styled_identity_closeup",
    path,
    filename: spec.filename,
    sha256: actualSha256,
    prompt,
    final_prompt: supplement ? `${prompt}\n\n# 本次用户补充要求\n\n${supplement}` : prompt,
    skill_contract: contract,
  });
}

export function extractFinalVisualReconstructionPrompt(value) {
  const text = String(value || "").trim();
  const startMarker = "# FINAL_VISUAL_RECONSTRUCTION_PROMPT";
  const endMarker = "# END_FINAL_VISUAL_RECONSTRUCTION_PROMPT";
  const start = text.indexOf(startMarker);
  if (start < 0) throw contractError("REAL_PERSON_STYLE_PROMPT_START_MISSING", "对标图分析缺少最终画面提示词起始标记。");
  const bodyStart = start + startMarker.length;
  const end = text.indexOf(endMarker, bodyStart);
  if (end < 0) throw contractError("REAL_PERSON_STYLE_PROMPT_END_MISSING", "对标图分析缺少最终画面提示词结束标记。");
  const prompt = text.slice(bodyStart, end).trim();
  if (!prompt) throw contractError("REAL_PERSON_STYLE_PROMPT_EMPTY", "对标图分析没有生成可用的最终画面提示词。");
  return prompt;
}

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.external_request_started = false;
  return error;
}
