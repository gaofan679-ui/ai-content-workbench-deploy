import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const EXECUTION_TYPES = new Set([
  "codex_skill_execution",
  "skill_owned_script",
  "local_deterministic_adapter",
  "test_fixture",
]);

export function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function sha256File(path) {
  if (!path || !existsSync(path)) throw new Error(`EXECUTION_RECEIPT_INPUT_MISSING:${path || "unknown"}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createStageExecutionReceipt({
  stage,
  executionType,
  ownerSkill = null,
  skillContract = null,
  invoked = false,
  adapter = null,
  inputs = [],
  outputs = [],
  allowedTransformations = [],
  notes = null,
}) {
  if (!stage || !EXECUTION_TYPES.has(executionType)) throw new Error("STAGE_EXECUTION_RECEIPT_INVALID");
  if (executionType === "codex_skill_execution" && (!invoked || !ownerSkill || skillContract?.owner_skill !== ownerSkill)) {
    throw new Error("STAGE_SKILL_EXECUTION_EVIDENCE_MISSING");
  }
  if (executionType === "local_deterministic_adapter" && invoked) throw new Error("STAGE_ADAPTER_CANNOT_CLAIM_SKILL_INVOCATION");
  return {
    schema_version: 1,
    stage,
    execution_type: executionType,
    owner_skill: ownerSkill,
    skill_invoked: Boolean(invoked),
    skill_source_path: skillContract?.source_path || null,
    skill_source_sha256: skillContract?.source_sha256 || null,
    adapter,
    allowed_transformations: [...allowedTransformations],
    inputs: inputs.map(normalizeArtifact),
    outputs: outputs.map(normalizeArtifact),
    notes,
    recorded_at: new Date().toISOString(),
  };
}

export function writeStageExecutionReceipt(path, receipt) {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

function normalizeArtifact(item) {
  if (!item?.path && typeof item?.text !== "string") throw new Error("STAGE_EXECUTION_ARTIFACT_INVALID");
  return {
    label: item.label || null,
    path: item.path || null,
    sha256: item.sha256 || (item.path ? sha256File(item.path) : sha256Text(item.text)),
  };
}
