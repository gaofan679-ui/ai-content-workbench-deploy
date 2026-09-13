import { existsSync, readFileSync, realpathSync } from "node:fs";

export function inspectStoryboardRatio(result) {
  const artifacts = result?.artifacts || [];
  const imageArtifact = artifacts.find((item) => /\.(png|jpe?g|webp)$/i.test(item.path || ""));
  const reportArtifact = artifacts.find((item) => /比例检查/.test(item.label || "") || /storyboard_grid_ratio_check.*\.json$/i.test(item.path || ""));
  if (!imageArtifact?.path || !existsSync(imageArtifact.path)) return failed("storyboard_image_missing", "目标宫格图片不存在。");
  if (!reportArtifact?.path || !existsSync(reportArtifact.path)) return failed("storyboard_ratio_check_missing", "缺少生成后的宫格比例数字检查。");

  let report;
  try { report = JSON.parse(readFileSync(reportArtifact.path, "utf8")); }
  catch { return failed("storyboard_ratio_check_invalid", "宫格比例检查文件无法读取。"); }

  const columns = Number(report.columns);
  const rows = Number(report.rows);
  const panelRatio = parseRatio(report.panel_ratio);
  const tolerance = Math.min(Number(report.tolerance ?? 0.05), 0.05);
  if (!Number.isInteger(columns) || columns <= 0 || !Number.isInteger(rows) || rows <= 0 || !panelRatio || !Number.isFinite(tolerance) || tolerance < 0) {
    return failed("storyboard_ratio_contract_invalid", "宫格比例检查缺少有效的行列或单格比例。");
  }
  if (report.image && safeRealpath(report.image) !== safeRealpath(imageArtifact.path)) {
    return failed("storyboard_ratio_image_mismatch", "比例检查对应的不是当前候选图。");
  }

  let size;
  try { size = imageSize(imageArtifact.path); }
  catch { return failed("storyboard_image_dimensions_unreadable", "无法读取当前候选图尺寸。"); }
  const actualGridRatio = size.width / size.height;
  const expectedGridRatio = (columns * panelRatio.value) / rows;
  const relativeError = Math.abs(actualGridRatio - expectedGridRatio) / expectedGridRatio;
  const pass = relativeError <= tolerance && report.pass === true && report.status === "pass";
  return {
    pass,
    code: pass ? null : "storyboard_grid_canvas_ratio_mismatch",
    message: pass
      ? "宫格画布比例与单格目标比例一致。"
      : `图片已经生成，但整张画布为 ${size.width}×${size.height}；按 ${columns}×${rows} 宫格、每格 ${panelRatio.label} 计算，单格会被压窄或压宽。`,
    image_path: realpathSync(imageArtifact.path),
    report_path: realpathSync(reportArtifact.path),
    image_width: size.width,
    image_height: size.height,
    columns,
    rows,
    panel_ratio: panelRatio.label,
    expected_grid_ratio: Number(expectedGridRatio.toFixed(6)),
    actual_grid_ratio: Number(actualGridRatio.toFixed(6)),
    relative_error: Number(relativeError.toFixed(6)),
    tolerance,
  };
}

function failed(code, message) { return { pass: false, code, message }; }

function safeRealpath(path) {
  try { return realpathSync(path); } catch { return null; }
}

function parseRatio(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0 && height > 0)) return null;
  return { value: width / height, label: `${width}:${height}` };
}

function imageSize(path) {
  const data = readFileSync(path);
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  throw new Error("unsupported image");
}
