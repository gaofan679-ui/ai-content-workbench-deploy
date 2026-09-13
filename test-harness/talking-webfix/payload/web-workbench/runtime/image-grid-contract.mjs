import { writeFileSync } from "node:fs";
import sharp from "sharp";

export async function createStoryboardSafeGridContract(sourcePath, options = {}) {
  const columns = Number(options.columns || 3);
  const rows = Number(options.rows || 2);
  const panelRatio = String(options.panelRatio || "9:16");
  const ratioValue = parseRatio(panelRatio);
  const source = await sharp(sourcePath).metadata();
  if (!source.width || !source.height || !ratioValue || columns <= 0 || rows <= 0) throw new Error("STORYBOARD_SAFE_GRID_CONTRACT_INVALID");
  const expectedGridRatio = (columns * ratioValue) / rows;
  const sourceBuffer = await sharp(sourcePath).png().toBuffer();
  const sourceSeparators = await inspectSeparators(sourceBuffer, { columns, rows });
  return {
    kind: "storyboard_safe_grid",
    columns,
    rows,
    panel_ratio: panelRatio,
    expected_grid_ratio: Number(expectedGridRatio.toFixed(8)),
    ratio_tolerance: 0.05,
    separator_position_tolerance: 0.035,
    separator_min_coverage: 0.72,
    require_equal_grid: sourceSeparators.pass,
    source_width: source.width,
    source_height: source.height,
    source_ratio: Number((source.width / source.height).toFixed(8)),
    source_separator_evidence: sourceSeparators,
  };
}

export function promptWithStoryboardSafeGridContract(prompt, contract, referenceName) {
  if (contract?.kind !== "storyboard_safe_grid") return String(prompt || "").trim();
  const hardRequirement = [
    "OUTPUT CANVAS — HARD REQUIREMENT (obey before all visual edits):",
    `Use ${referenceName || "the uploaded storyboard"} as one fixed ${contract.columns}×${contract.rows} storyboard canvas.`,
    `Keep the complete canvas at the same ${contract.source_width}:${contract.source_height} source aspect, approximately 27:32; never output a square or landscape canvas.`,
    `All ${contract.columns * contract.rows} panels must remain equal-sized in a strict ${contract.columns}-column by ${contract.rows}-row grid; the top and bottom rows must have exactly equal height, and every panel must remain 9:16.`,
    "Do not enlarge one row, shrink another row, merge panels, change divider positions, recrop, reflow, or redesign the sheet.",
    "",
  ].join("\n");
  return `${hardRequirement}${String(prompt || "").trim()}`;
}

export async function inspectGridImageBuffer(buffer, contract) {
  if (contract?.kind !== "storyboard_safe_grid") return { pass: true, status: "not_applicable" };
  const metadata = await sharp(buffer).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) return { pass: false, status: "failed", code: "image_dimensions_unreadable" };
  const actualGridRatio = width / height;
  const relativeError = Math.abs(actualGridRatio - contract.expected_grid_ratio) / contract.expected_grid_ratio;
  const ratioPass = relativeError <= contract.ratio_tolerance;
  const separators = await inspectSeparators(buffer, contract);
  const separatorsPass = contract.require_equal_grid !== true || separators.pass;
  const pass = ratioPass && separatorsPass;
  return {
    pass,
    status: pass ? "pass" : "failed",
    code: pass ? null : !ratioPass ? "storyboard_safe_canvas_ratio_mismatch" : "storyboard_safe_grid_not_equal",
    image_width: width,
    image_height: height,
    expected_grid_ratio: contract.expected_grid_ratio,
    actual_grid_ratio: Number(actualGridRatio.toFixed(8)),
    relative_error: Number(relativeError.toFixed(8)),
    ratio_tolerance: contract.ratio_tolerance,
    equal_grid_required: contract.require_equal_grid === true,
    separators,
  };
}

export function writeGridInspection(path, inspection) {
  writeFileSync(path, `${JSON.stringify(inspection, null, 2)}\n`, { flag: "wx" });
}

async function inspectSeparators(buffer, contract) {
  const columns = Number(contract.columns || 3);
  const rows = Number(contract.rows || 2);
  const positionTolerance = Number(contract.separator_position_tolerance || 0.035);
  const minCoverage = Number(contract.separator_min_coverage || 0.72);
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const vertical = [];
  const horizontal = [];
  for (let index = 1; index < columns; index += 1) {
    const expected = (info.width * index) / columns;
    vertical.push(bestSeparator({ data, width: info.width, height: info.height, expected, axis: "vertical", searchFraction: 0.12 }));
  }
  for (let index = 1; index < rows; index += 1) {
    const expected = (info.height * index) / rows;
    horizontal.push(bestSeparator({ data, width: info.width, height: info.height, expected, axis: "horizontal", searchFraction: 0.12 }));
  }
  const all = [...vertical, ...horizontal];
  const pass = all.every((item) => item.coverage >= minCoverage && item.relative_offset <= positionTolerance);
  return { pass, position_tolerance: positionTolerance, min_coverage: minCoverage, vertical, horizontal };
}

function bestSeparator({ data, width, height, expected, axis, searchFraction }) {
  const dimension = axis === "vertical" ? width : height;
  const orthogonal = axis === "vertical" ? height : width;
  const radius = Math.max(3, Math.round(dimension * searchFraction));
  const start = Math.max(0, Math.round(expected) - radius);
  const end = Math.min(dimension - 1, Math.round(expected) + radius);
  let best = { coordinate: Math.round(expected), coverage: 0 };
  for (let coordinate = start; coordinate <= end; coordinate += 1) {
    let light = 0;
    for (let offset = 0; offset < orthogonal; offset += 1) {
      const pixel = axis === "vertical" ? data[offset * width + coordinate] : data[coordinate * width + offset];
      if (pixel >= 235) light += 1;
    }
    const coverage = light / orthogonal;
    if (coverage > best.coverage) best = { coordinate, coverage };
  }
  return {
    expected_coordinate: Number(expected.toFixed(3)),
    detected_coordinate: best.coordinate,
    coverage: Number(best.coverage.toFixed(6)),
    relative_offset: Number((Math.abs(best.coordinate - expected) / dimension).toFixed(6)),
  };
}

function parseRatio(value) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}
