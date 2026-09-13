import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";

const PACK_SCHEMA = "xhs-jewelry-product-pack-v0.3";
const BOARD_SPEC = "jewelry-structure-anchor-builder-v1";
const MAX_BOARD_SOURCES = 5;
const MAX_DIRECT_SOURCES = 3;
const structurePlanSchemaPath = fileURLToPath(new URL("./xhs-jewelry-structure-plan.schema.json", import.meta.url));

export function classifyJewelryCategory(targetSlot) {
  if (targetSlot === "ring") return "ring";
  if (targetSlot === "necklace") return "necklace";
  if (targetSlot === "earrings") return "earrings";
  if (targetSlot === "bracelet") return "bracelet";
  if (targetSlot === "brooch_hair") return "brooch_hair";
  return "generic_jewelry";
}

export async function buildXhsJewelryProductPack({ task, taskDir, onEvent, env = process.env }) {
  const sourcePaths = [...new Set((task.product_image_paths || []).map((path) => resolve(path)))];
  if (sourcePaths.length === 0) throw packError("XHS_JEWELRY_PRODUCT_SOURCE_REQUIRED");
  const sources = [];
  for (const [index, path] of sourcePaths.entries()) {
    if (!existsSync(path) || !statSync(path).isFile()) throw packError("XHS_JEWELRY_PRODUCT_SOURCE_UNAVAILABLE");
    const metadata = await sharp(path).rotate().metadata();
    sources.push({
      order: index + 1,
      path,
      filename: basename(path),
      sha256: sha256File(path),
      width: metadata.width || null,
      height: metadata.height || null,
      format: metadata.format || null,
    });
  }
  const category = classifyJewelryCategory(task.target_slot);
  const verifiedProductFacts = normalizeVerifiedFacts(task.product_facts);
  const fingerprint = sha256Text(JSON.stringify({
    schema: PACK_SCHEMA,
    board_spec: BOARD_SPEC,
    category,
    target_slot: task.target_slot || null,
    verified_product_facts: verifiedProductFacts,
    sources: sources.map(({ order, sha256, width, height, format }) => ({ order, sha256, width, height, format })),
  }));
  const packDir = join(taskDir, "product-pack-v03");
  mkdirSync(packDir, { recursive: true });
  const short = fingerprint.slice(0, 16);
  const boardPath = join(packDir, `product-structure-anchor-${short}.png`);
  const manifestPath = join(packDir, `product-pack-${short}.json`);
  const planPath = join(packDir, `structure-plan-${short}.json`);
  const plannerMode = env.WORKBENCH_XHS_JEWELRY_STRUCTURE_PLANNER_MODE
    || (env.WORKBENCH_XHS_JEWELRY_GENERATOR ? "deterministic" : "codex_visual");
  const requireVisualPlan = env.WORKBENCH_XHS_JEWELRY_REQUIRE_VISUAL_PLAN === "1";
  if (requireVisualPlan && plannerMode !== "codex_visual") {
    throw packError("XHS_JEWELRY_VISUAL_PLAN_REQUIRED");
  }
  let plannerUsed = false;
  let plannerFallbackReason = null;
  let plan;
  if (existsSync(planPath)) {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
    plannerUsed = plan.planner === "codex_visual";
    if (requireVisualPlan && !plannerUsed) {
      onEvent?.("现有结构资料是简化拼版，已保留原文件；请重新建立完整产品资料后再生成。");
      throw packError("XHS_JEWELRY_CACHED_PLAN_IS_SIMPLIFIED");
    }
  } else if (plannerMode === "codex_visual") {
    try {
      onEvent?.("正在为这款新产品建立一次性结构资料；以后本项目换品会直接复用。");
      plan = await buildVisualStructurePlan({ sources, category, verifiedProductFacts, taskDir, planPath, env });
      plannerUsed = true;
    } catch (error) {
      if (requireVisualPlan) {
        onEvent?.("本次结构分析未完成，尚未提交生图；请检查结构分析结果后再继续。");
        throw error;
      }
      plannerFallbackReason = String(error?.code || error?.message || error).slice(0, 300);
      plan = deterministicStructurePlan(sources, category, verifiedProductFacts);
      writeImmutableJson(planPath, plan);
    }
  } else {
    plan = deterministicStructurePlan(sources, category, verifiedProductFacts);
    writeImmutableJson(planPath, plan);
  }
  validateStructurePlan(plan, sources.length);
  if (!existsSync(boardPath)) {
    await renderStructureAnchorBoard({ sources, outputPath: boardPath, category, verifiedProductFacts, plan });
  }
  const selectedOrders = uniqueOrders([
    panelSource(plan, "A"),
    panelSource(plan, "D"),
    panelSource(plan, "E"),
    ...sources.map((item) => item.order),
  ]).slice(0, MAX_DIRECT_SOURCES);
  const selectedOriginalPaths = selectedOrders.map((order) => sources[order - 1]?.path).filter(Boolean);
  const manifest = {
    schema: PACK_SCHEMA,
    schema_version: 3,
    fingerprint_sha256: fingerprint,
    category,
    target_slot: task.target_slot || null,
    source_images: sources,
    evidence_board: {
      path: boardPath,
      sha256: sha256File(boardPath),
      format: "png",
      pixel_dimensions: { width: 3000, height: 2000 },
      construction: "deterministic_original_pixel_crop_resize_composite_no_ai_redraw",
      builder_spec: BOARD_SPEC,
      source_orders: uniqueOrders(plan.panels.map((panel) => panel.source_order)),
      traceability_manifest: plan.panels.map((panel) => ({
        panel: panel.panel,
        source_order: panel.source_order,
        source_path: sources[panel.source_order - 1]?.path || null,
        crop_normalized: panel.crop,
        rotation_degrees: 0,
        maximum_enlargement: 2,
        focus: panel.focus,
      })),
    },
    structure_plan: {
      path: planPath,
      planner: plan.planner,
      additional_visual_reasoning_call_used: plannerUsed,
      fallback_reason: plannerFallbackReason,
      rigidity: plan.rigidity,
      core_failure_risk: plan.core_failure_risk,
      identity_tiers: plan.identity_tiers,
      forbidden_misreads: plan.forbidden_misreads,
      visual_observations_are_not_verified_parameters: plan.visual_observations,
      unknowns: plan.unknowns,
    },
    product_facts: {
      verified_from_user_input: verifiedProductFacts,
      operation_context_not_product_fact: { target_slot: task.target_slot || null },
      unknown_without_user_evidence: missingFactKeys(verifiedProductFacts),
      visual_inference_is_not_a_verified_product_fact: true,
    },
    sku_constraint_card: buildSkuConstraintCard({ category, verifiedProductFacts, plan }),
    generation_reference_plan: {
      maximum_total_images: 5,
      first_image_reserved_for_generation_base: true,
      product_evidence_paths: [boardPath, ...selectedOriginalPaths],
      product_evidence_roles: [
        "product_structure_anchor_board",
        ...selectedOriginalPaths.map((_, index) => `product_source_evidence_${String(index + 1).padStart(2, "0")}`),
      ],
      additional_image_generation_call_used: false,
      cached_by_product_fingerprint: true,
    },
    file_behavior: "process_only",
  };
  writeImmutableJson(manifestPath, manifest);
  return { ...manifest, manifest_path: manifestPath };
}

async function buildVisualStructurePlan({ sources, category, verifiedProductFacts, taskDir, planPath, env }) {
  const args = [
    "exec", "-", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write",
    "--model", env.WORKBENCH_CODEX_MODEL || "gpt-5.6-sol",
    "--config", `model_reasoning_effort=${env.WORKBENCH_XHS_JEWELRY_STRUCTURE_REASONING_EFFORT || "low"}`,
    "-C", taskDir,
  ];
  for (const source of sources.slice(0, MAX_BOARD_SOURCES)) args.push("--image", source.path);
  args.push("--output-schema", structurePlanSchemaPath, "--output-last-message", planPath);
  const prompt = `你只负责观察上传的同一款珠宝图片并输出结构规划 JSON，不生成或编辑图片，不写文件，不调用其他工具。

品类：${categoryLabel(category)}
用户已核实参数（唯一可称为事实的文字）：${JSON.stringify(verifiedProductFacts)}

请按图片上传顺序 1-${sources.length} 规划 A-E 五个原图证据面板：A 整体身份，B 第二立体角度，C 厚度/体积，D 核心拓扑且最重要，E 最容易误判的反射或第二混淆点。允许同一源图承担多个面板。crop 使用 0-1 归一化坐标，必须落在图片内部。只写看得见的结构，不猜材质、尺寸、隐藏背面、组件数量或工艺；不确定就写入 unknowns。永久几何与临时高光必须分开。找出最容易生成错的方向、数量、连接或重复节奏。所有文本简短中文。`;
  await runManagedCodex({ args, prompt, env, timeoutMs: 4 * 60 * 1000 });
  if (!existsSync(planPath)) throw packError("XHS_JEWELRY_STRUCTURE_PLAN_MISSING");
  const raw = JSON.parse(readFileSync(planPath, "utf8"));
  const plan = { ...raw, planner: "codex_visual", schema_version: 1 };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

function deterministicStructurePlan(sources, category, verifiedProductFacts) {
  const order = (index) => sources[Math.min(index, sources.length - 1)]?.order || 1;
  const known = Object.entries(verifiedProductFacts).filter(([, value]) => String(value || "").trim());
  return {
    schema_version: 1,
    planner: "deterministic_fallback",
    category,
    rigidity: category === "necklace" || category === "bracelet" ? "mixed" : category === "ring" ? "rigid" : "unknown",
    core_failure_risk: "未进行视觉语义判断；生成时必须同时对照原始产品图。",
    identity_tiers: { tier_1: [], tier_2: [], tier_3: [] },
    forbidden_misreads: ["禁止镜像或翻面", "禁止把高光和倒影当成永久结构"],
    visual_observations: [],
    unknowns: known.length ? ["图片未能可靠确认的隐藏结构仍为 NOT VERIFIED"] : ["材质、尺寸、数量、隐藏结构均为 NOT VERIFIED"],
    panels: [
      { panel: "A", source_order: order(0), focus: "完整产品身份", crop: fullCrop() },
      { panel: "B", source_order: order(1), focus: "第二观察角度", crop: fullCrop() },
      { panel: "C", source_order: order(2), focus: "厚度与体积证据", crop: fullCrop() },
      { panel: "D", source_order: order(0), focus: "核心结构与连接关系", crop: fullCrop() },
      { panel: "E", source_order: order(1), focus: "反射与结构混淆检查", crop: fullCrop() },
    ],
  };
}

async function renderStructureAnchorBoard({ sources, outputPath, category, verifiedProductFacts, plan }) {
  const width = 3000;
  const height = 2000;
  const slots = {
    A: { x: 70, y: 210, w: 930, h: 740, title: "A｜完整产品身份" },
    B: { x: 70, y: 1010, w: 610, h: 550, title: "B｜第二立体角度" },
    C: { x: 720, y: 1010, w: 610, h: 550, title: "C｜厚度与体积" },
    D: { x: 1050, y: 210, w: 1180, h: 920, title: "D｜核心结构 / 拓扑" },
    E: { x: 1370, y: 1190, w: 860, h: 370, title: "E｜反射与混淆检查" },
  };
  const composites = [];
  const labels = [];
  for (const panel of plan.panels) {
    const slot = slots[panel.panel];
    const source = sources[panel.source_order - 1] || sources[0];
    const image = await sourceCropBuffer(source, panel.crop, slot.w - 36, slot.h - 104);
    composites.push({ input: image, left: slot.x + 18, top: slot.y + 72 });
    labels.push(`<rect x="${slot.x}" y="${slot.y}" width="${slot.w}" height="${slot.h}" rx="22" fill="#ffffff" stroke="#d4c9b8" stroke-width="3"/>`);
    labels.push(`<text x="${slot.x + 22}" y="${slot.y + 43}" font-family="Arial, PingFang SC, sans-serif" font-size="27" font-weight="700" fill="#332a21">${escapeXml(slot.title)}</text>`);
    labels.push(`<text x="${slot.x + slot.w - 22}" y="${slot.y + 43}" text-anchor="end" font-family="Arial, PingFang SC, sans-serif" font-size="20" fill="#75695d">原图 ${source.order}</text>`);
  }
  const factLines = verifiedFactLines(verifiedProductFacts);
  const ruleLines = constraintLines(plan);
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f3efe8"/>
    <text x="72" y="70" font-family="Arial, PingFang SC, sans-serif" font-size="46" font-weight="700" fill="#2b231b">珠宝产品结构证据板</text>
    <text x="72" y="125" font-family="Arial, PingFang SC, sans-serif" font-size="25" fill="#6d6256">${escapeXml(categoryLabel(category))}｜原始像素裁切拼版，不重画产品；高光与倒影不作为永久身份</text>
    ${labels.join("\n")}
    <rect x="2270" y="210" width="660" height="1350" rx="22" fill="#fffaf0" stroke="#d4c9b8" stroke-width="3"/>
    <text x="2300" y="265" font-family="Arial, PingFang SC, sans-serif" font-size="31" font-weight="700" fill="#332a21">F｜已核实事实</text>
    ${svgLines(factLines, 2300, 315, 26, 43, "#51473d")}
    <line x1="2300" y1="${315 + Math.max(factLines.length, 1) * 43 + 18}" x2="2900" y2="${315 + Math.max(factLines.length, 1) * 43 + 18}" stroke="#dccfbc" stroke-width="2"/>
    <text x="2300" y="${370 + Math.max(factLines.length, 1) * 43}" font-family="Arial, PingFang SC, sans-serif" font-size="31" font-weight="700" fill="#332a21">生成约束卡</text>
    ${svgLines(ruleLines, 2300, 420 + Math.max(factLines.length, 1) * 43, 25, 41, "#51473d")}
    <text x="72" y="1685" font-family="Arial, PingFang SC, sans-serif" font-size="28" font-weight="700" fill="#332a21">核心失败风险</text>
    <text x="72" y="1730" font-family="Arial, PingFang SC, sans-serif" font-size="24" fill="#5f5449">${escapeXml(clip(plan.core_failure_risk, 120))}</text>
    <text x="72" y="1815" font-family="Arial, PingFang SC, sans-serif" font-size="23" fill="#7b6f63">NOT VERIFIED：${escapeXml(clip((plan.unknowns || []).join("；") || "没有额外已核实参数", 155))}</text>
    <text x="72" y="1915" font-family="Arial, PingFang SC, sans-serif" font-size="21" fill="#8c8074">所有裁切均可追溯到原图；禁止 AI 补画、修饰、美化、扩图或生成新角度。</text>
  </svg>`);
  await sharp({ create: { width, height, channels: 3, background: "#f3efe8" } })
    .composite([{ input: svg, left: 0, top: 0 }, ...composites])
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

async function sourceCropBuffer(source, crop, maxWidth, maxHeight) {
  const width = source.width || 1;
  const height = source.height || 1;
  const normalized = normalizeCrop(crop);
  const left = Math.min(width - 1, Math.max(0, Math.floor(normalized.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(normalized.y * height)));
  const extractWidth = Math.max(1, Math.min(width - left, Math.floor(normalized.width * width)));
  const extractHeight = Math.max(1, Math.min(height - top, Math.floor(normalized.height * height)));
  const resizeWidth = Math.max(1, Math.min(maxWidth, extractWidth * 2));
  const resizeHeight = Math.max(1, Math.min(maxHeight, extractHeight * 2));
  return sharp(source.path)
    .rotate()
    .extract({ left, top, width: extractWidth, height: extractHeight })
    .resize({ width: resizeWidth, height: resizeHeight, fit: "contain", background: "#ffffff", withoutEnlargement: false })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

function validateStructurePlan(plan, sourceCount) {
  const panels = Array.isArray(plan?.panels) ? plan.panels : [];
  const ids = new Set(panels.map((panel) => panel.panel));
  if (panels.length !== 5 || ["A", "B", "C", "D", "E"].some((id) => !ids.has(id))) {
    throw packError("XHS_JEWELRY_STRUCTURE_PLAN_INVALID");
  }
  for (const panel of panels) {
    if (!Number.isInteger(panel.source_order) || panel.source_order < 1 || panel.source_order > sourceCount) {
      throw packError("XHS_JEWELRY_STRUCTURE_PLAN_SOURCE_INVALID");
    }
    normalizeCrop(panel.crop);
  }
}

function normalizeCrop(crop = {}) {
  const x = clamp(Number(crop.x), 0, 0.98);
  const y = clamp(Number(crop.y), 0, 0.98);
  const width = clamp(Number(crop.width), 0.02, 1 - x);
  const height = clamp(Number(crop.height), 0.02, 1 - y);
  return { x, y, width, height };
}

function normalizeVerifiedFacts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [String(key).slice(0, 80), String(item || "").trim().slice(0, 300)])
    .filter(([, item]) => item));
}

function buildSkuConstraintCard({ category, verifiedProductFacts, plan }) {
  return {
    category,
    verified_facts_only: verifiedProductFacts,
    permanent_identity: plan.identity_tiers,
    core_failure_risk: plan.core_failure_risk,
    forbidden_misreads: plan.forbidden_misreads,
    reflection_policy: "产品图中的高光、倒影和棚拍环境色不得继承；只继承永久结构，并按目标画面重新受光。",
    unknown_policy: "未核实内容保持 NOT VERIFIED，不得由文字或模型自行补造。",
  };
}

function missingFactKeys(facts) {
  const expected = ["material", "color", "dimensions", "component_count", "front_orientation", "connection_structure"];
  const missing = expected.filter((key) => !facts[key]);
  return missing.length ? missing : ["hidden_back_or_clasp_structure_when_not_provided"];
}

function verifiedFactLines(facts) {
  const labels = {
    product_name: "产品名", sku: "SKU", material: "材质/镀层", color: "颜色", dimensions: "尺寸",
    component_count: "组件数量", front_orientation: "正面/方向", connection_structure: "连接结构", must_not_change: "不可出错项",
  };
  const lines = Object.entries(facts).map(([key, value]) => `${labels[key] || key}：${value}`);
  return lines.length ? lines.slice(0, 11) : ["未提供可核实参数", "图片观察不冒充事实"];
}

function constraintLines(plan) {
  const tier1 = plan.identity_tiers?.tier_1 || [];
  return [
    ...tier1.slice(0, 3),
    ...(plan.forbidden_misreads || []).slice(0, 4),
    "只继承永久几何，不继承棚拍高光",
    "按目标场景重建比例、遮挡和受光",
  ].filter(Boolean).slice(0, 8);
}

function svgLines(lines, x, startY, fontSize, lineHeight, fill) {
  return lines.map((line, index) => `<text x="${x}" y="${startY + index * lineHeight}" font-family="Arial, PingFang SC, sans-serif" font-size="${fontSize}" fill="${fill}">${escapeXml(`• ${clip(line, 42)}`)}</text>`).join("\n");
}

function panelSource(plan, id) {
  return plan.panels.find((panel) => panel.panel === id)?.source_order || 1;
}

function uniqueOrders(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function fullCrop() { return { x: 0, y: 0, width: 1, height: 1 }; }
function clamp(value, min, max) { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min; }
function clip(value, max) { const text = String(value || ""); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
function escapeXml(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char])); }

function categoryLabel(category) {
  if (category === "ring") return "戒指";
  if (category === "necklace") return "项链 / 吊坠";
  if (category === "earrings") return "耳环 / 耳饰";
  if (category === "bracelet") return "手链 / 手镯";
  if (category === "brooch_hair") return "胸针 / 发饰";
  return "珠宝";
}

function writeImmutableJson(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (!existsSync(path)) return writeFileSync(path, serialized, { flag: "wx" });
  if (readFileSync(path, "utf8") !== serialized) throw packError("XHS_JEWELRY_PRODUCT_PACK_CONFLICT");
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function sha256Text(value) { return createHash("sha256").update(String(value), "utf8").digest("hex"); }
function packError(code) { const error = new Error(code); error.code = code; error.external_request_started = false; return error; }
