import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import sharp from "sharp";

export async function rebuildSafeMaterialCollage({ sourcePath, redlinePath, specPath, outputPath, receiptPath, builderPath }) {
  if (![sourcePath, redlinePath, builderPath].every((path) => path && existsSync(path))) throw new Error("PERSON_PACKAGE_MATERIAL_REPAIR_INPUT_MISSING");
  const sourceMeta = await sharp(sourcePath).metadata();
  const { data, info } = await sharp(redlinePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = [];
  for (let y = 0; y < info.height; y += 1) {
    let minX = info.width; let maxX = -1; let count = 0;
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
      if (r > 170 && r > g * 1.7 && r > b * 1.7) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); count += 1; }
    }
    if (count >= 4) rows.push({ y, minX, maxX });
  }
  const groups = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (!last || row.y > last.maxY + 1) groups.push({ minY: row.y, maxY: row.y, minX: row.minX, maxX: row.maxX });
    else { last.maxY = row.y; last.minX = Math.min(last.minX, row.minX); last.maxX = Math.max(last.maxX, row.maxX); }
  }
  const bars = groups.filter((item) => item.maxX - item.minX >= 8).sort((a, b) => a.minY - b.minY).slice(0, 3);
  if (bars.length !== 3) throw new Error("PERSON_PACKAGE_REDLINE_LANDMARKS_UNREADABLE");
  const sx = (sourceMeta.width || info.width) / info.width;
  const sy = (sourceMeta.height || info.height) / info.height;
  const box = (left, top, right, bottom) => [
    Math.max(0, Math.round(left * sx)), Math.max(0, Math.round(top * sy)),
    Math.min(sourceMeta.width, Math.round(right * sx)), Math.min(sourceMeta.height, Math.round(bottom * sy)),
  ];
  const [eyes, nose, lips] = bars;
  const eyeSpan = Math.max(24, eyes.maxX - eyes.minX);
  const eyeY = (eyes.minY + eyes.maxY) / 2;
  const noseY = (nose.minY + nose.maxY) / 2;
  const lipY = (lips.minY + lips.maxY) / 2;
  const faceUnit = Math.max(36, lipY - eyeY);
  const mid = (eyes.minX + eyes.maxX) / 2;
  const spec = { coordinate_convention: "viewer_orientation", crops: {
    viewer_left_eye: box(eyes.minX - eyeSpan * .08, eyeY - eyeSpan * .22, mid - eyeSpan * .04, eyeY + eyeSpan * .22),
    viewer_right_eye: box(mid + eyeSpan * .04, eyeY - eyeSpan * .22, eyes.maxX + eyeSpan * .08, eyeY + eyeSpan * .22),
    nose_lip: box(Math.min(nose.minX, lips.minX) - eyeSpan * .16, noseY - faceUnit * .25, Math.max(nose.maxX, lips.maxX) + eyeSpan * .16, lipY + faceUnit * .22),
    lips: box(lips.minX - eyeSpan * .16, lipY - faceUnit * .16, lips.maxX + eyeSpan * .16, lipY + faceUnit * .18),
    cheek_jaw: box(eyes.maxX + eyeSpan * .05, noseY - faceUnit * .12, eyes.maxX + eyeSpan * .72, lipY + faceUnit * .62),
    clean_skin: box(eyes.maxX + eyeSpan * .12, eyeY + faceUnit * .18, eyes.maxX + eyeSpan * .62, noseY + faceUnit * .20),
    hairline: box(eyes.minX - eyeSpan * .18, eyeY - faceUnit * .72, eyes.maxX + eyeSpan * .18, eyeY - faceUnit * .20),
    hair_strands: box(eyes.maxX + eyeSpan * .34, eyeY - faceUnit * .35, eyes.maxX + eyeSpan * 1.35, lipY + faceUnit * .72),
    collar: box(eyes.minX - eyeSpan * .10, lipY + faceUnit * .72, eyes.maxX + eyeSpan * 1.45, lipY + faceUnit * 2.25),
  } };
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, { flag: "wx" });
  execFileSync("python3", [builderPath, "--source", sourcePath, "--spec", specPath, "--output", outputPath, "--receipt", receiptPath], { stdio: "pipe" });
  return { label: "局部材质拼图", path: outputPath, published: false, approval_status: "needs_review" };
}
