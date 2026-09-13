function parseRatio(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height, value: width / height } : null;
}

function gcd(left, right) {
  let a = Math.round(Math.abs(left));
  let b = Math.round(Math.abs(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function normalizeStoryboardGrid(value) {
  const columns = Number(value?.columns);
  const rows = Number(value?.rows);
  const panel = parseRatio(value?.panel_ratio);
  const tolerance = Number(value?.tolerance ?? 0.05);
  if (!Number.isInteger(columns) || columns <= 0 || !Number.isInteger(rows) || rows <= 0 || !panel) return null;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.05) return null;
  const rawWidth = columns * panel.width;
  const rawHeight = rows * panel.height;
  const divisor = Number.isInteger(rawWidth) && Number.isInteger(rawHeight) ? gcd(rawWidth, rawHeight) : 1;
  const canvasRatio = `${rawWidth / divisor}:${rawHeight / divisor}`;
  const declaredCanvas = parseRatio(value?.canvas_ratio);
  const expectedCanvasRatio = (columns * panel.value) / rows;
  if (!declaredCanvas || Math.abs(declaredCanvas.value - expectedCanvasRatio) / expectedCanvasRatio > 0.001) return null;
  return {
    columns,
    rows,
    panel_ratio: `${panel.width}:${panel.height}`,
    canvas_ratio: canvasRatio,
    expected_canvas_ratio: Number(expectedCanvasRatio.toFixed(6)),
    tolerance,
  };
}

export function storyboardRatioPriorityHeader(gridValue, { repair = false } = {}) {
  const grid = normalizeStoryboardGrid(gridValue);
  if (!grid) throw new Error("STORYBOARD_GRID_CONTRACT_INVALID");
  const exampleHeight = 1600;
  const exampleWidth = Math.round(exampleHeight * grid.expected_canvas_ratio);
  return `${repair ? "【客观比例纠正｜最高优先级】" : "【最高优先级输出规格】"}\n整张成图必须是 ${grid.canvas_ratio} 画布（宽高比约 ${grid.expected_canvas_ratio}，例如 ${exampleWidth}×${exampleHeight}），绝不能把整张成图做成 ${grid.panel_ratio}。\n整张图固定为 ${grid.columns} 列×${grid.rows} 行；只有每一个单格是 ${grid.panel_ratio}。整图比例优先级高于人物、场景和画面风格。`;
}

export function assertStoryboardRequestContract(value) {
  const grid = normalizeStoryboardGrid(value?.storyboard_grid);
  if (!grid) throw new Error("STORYBOARD_GRID_CONTRACT_MISSING_OR_INVALID");
  const prompt = String(value?.final_model_prompt || value?.final_prompt || "").trim();
  const expectedHeader = storyboardRatioPriorityHeader(grid);
  const repairHeader = storyboardRatioPriorityHeader(grid, { repair: true });
  const priorityBlock = prompt.slice(0, 420);
  const normalizedPriorityBlock = priorityBlock
    .replace(/\s+/gu, "")
    .replace(/[×xX*]/gu, "×");
  const semanticHeaderValid = /^【(?:客观比例纠正｜)?最高优先级输出规格】/u.test(priorityBlock)
    && normalizedPriorityBlock.includes(grid.canvas_ratio)
    && normalizedPriorityBlock.includes(`${grid.columns}列×${grid.rows}行`)
    && normalizedPriorityBlock.includes(`单格`) && normalizedPriorityBlock.includes(grid.panel_ratio);
  if (!prompt.startsWith(expectedHeader) && !prompt.startsWith(repairHeader) && !semanticHeaderValid)
    throw new Error("STORYBOARD_RATIO_PRIORITY_HEADER_MISSING");
  return grid;
}

export function createStoryboardRatioRepairPrompt(prompt, gridValue) {
  const grid = normalizeStoryboardGrid(gridValue);
  if (!grid) throw new Error("STORYBOARD_GRID_CONTRACT_INVALID");
  const base = String(prompt || "").replace(/^【最高优先级输出规格】[\s\S]*?整图比例优先级高于人物、场景和画面风格。\s*/u, "").trim();
  return `${storyboardRatioPriorityHeader(grid, { repair: true })}\n上一次结果错误地把整张画布生成成了 ${grid.panel_ratio}。本次只纠正整张画布与单格比例，六格顺序、人物、穿搭、动作、场景和参考图职责全部保持不变。\n\n${base}`;
}
