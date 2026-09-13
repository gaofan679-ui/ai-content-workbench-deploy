import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexArgs } from "./codex-runner.mjs";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import {
  buildSkillOwnedPrompt,
  resolveSkillContract,
  skillContractReceipt,
} from "./skill-contract-bridge.mjs";

export async function runProductAssetsStage({
  task,
  taskDir,
  onEvent,
  env = process.env,
}) {
  const contract = resolveSkillContract("product_assets", { env });
  const receipt = skillContractReceipt(contract);
  const outputDir = join(taskDir, `product-assets-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const resultPath = join(outputDir, "product-assets-result.json");
  const receiptPath = join(outputDir, "product-assets-skill-contract.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const prompt = buildSkillOwnedPrompt({
    contract,
    facts: {
      project_name: task.title,
      task_id: task.id,
      remix_precision_route: task.remix_precision_route,
      remix_change_contract: task.remix_change_contract || null,
      rewrite_mode: task.rewrite_mode,
      product_brief: task.product_brief || null,
      product_scope: task.product_scope || "unspecified",
      product_image_paths: (task.product_image_paths || []).filter((path) =>
        existsSync(path),
      ),
      rewrite_artifacts: task.rewrite_result?.artifacts || [],
      generation_provider:
        task.generation_model_snapshot?.provider || task.generation_provider,
      provider_image_limit: Number(
        task.generation_model_snapshot?.image_max || 3,
      ),
      work_dir: outputDir,
    },
    runtimeEnvelope: {
      source_images_are_local_only: true,
      external_requests_allowed: false,
      image_generation_allowed: false,
      video_generation_allowed: false,
      deterministic_crop_and_grid_allowed: true,
      originals_must_be_preserved: true,
      product_scope_must_be_fully_covered: true,
      full_look_requires_whole_outfit_overview: true,
      detail_crops_cannot_replace_whole_outfit_overview: true,
      completed_means_ready_for_downstream_without_another_user_approval: true,
      output_interface: {
        required_artifact_labels: [
          "产品资产包",
          "干净产品参考图",
        ],
        published: false,
        estimated_cost_cny: 0,
        completed_requires_confirmation: false,
        missing_or_ambiguous_scope_status: "needs_user_input",
      },
      user_message_policy:
        "只用大白话说明系统按用户预先选择的产品范围保留了哪些完整产品依据。选择整套穿搭时，干净产品参考必须至少保留一格完整全身或完整上下装总览，用来锁定上下装长度和比例；局部图只能补充细节，不能替代整套或完整单品。范围完整时自动继续，不再询问满意不满意；缺少必要范围时只说清缺什么。",
    },
  });
  writeFileSync(join(outputDir, "product-assets-prompt.md"), prompt, "utf8");
  onEvent?.("正在按正式产品资产规则审计现有商品图并制作干净裁切；不会上传或生图。");
  const args = buildCodexArgs({ taskDir, resultPath, env });
  await runManagedCodex({
    args,
    prompt,
    env,
    onEvent,
    timeoutMs: 15 * 60 * 1000,
  });
  if (!existsSync(resultPath)) throw new Error("PRODUCT_ASSETS_RESULT_MISSING");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const finalized = {
    ...result,
    approval_status:
      result.status === "completed" && result.requires_confirmation !== true
        ? "approved"
        : "blocked",
    skill_contract: receipt,
    skill_contract_receipt_path: receiptPath,
    external_request_started: false,
    video_generation_started: false,
    estimated_cost_cny: 0,
  };
  writeFileSync(resultPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  return finalized;
}
