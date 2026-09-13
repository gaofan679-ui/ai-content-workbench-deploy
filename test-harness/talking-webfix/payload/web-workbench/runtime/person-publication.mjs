import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export function linkedOriginPublishArgs(projectOutputPath, rawGenerationPath) {
  try {
    const output = statSync(projectOutputPath);
    const origin = statSync(rawGenerationPath);
    return output.dev === origin.dev && output.ino === origin.ino ? ["--linked-origin", rawGenerationPath] : [];
  } catch { return []; }
}

export function resolvePersonExecutionReceipt(task, imagePath) {
  const declared = (task?.person_generation_result?.artifacts || []).find(
    (item) => /执行回执/.test(item.label || "") && item.path && existsSync(item.path),
  );
  if (declared) return declared;

  const route = findTaskRoute(imagePath);
  const attempt = Number(task?.person_attempt_count || 1);
  const fallbackPath = route?.task_root
    ? join(
        route.task_root,
        "work",
        "02_生产过程",
        "ai-video-person-assets",
        `execution_receipt_attempt_${attempt}.json`,
      )
    : null;
  if (!fallbackPath || !existsSync(fallbackPath)) return null;
  try {
    const receipt = JSON.parse(readFileSync(fallbackPath, "utf8"));
    const promotedFromThisRoute =
      route?.task_id === task.id &&
      receipt.project_output_path === imagePath;
    if (
      receipt.task_id !== task.id ||
      !receipt.raw_generation_path ||
      !existsSync(receipt.raw_generation_path) ||
      !receipt.project_output_path ||
      (!existsSync(receipt.project_output_path) && !promotedFromThisRoute)
    ) return null;
    return { label: "人物生成执行回执", path: fallbackPath, published: false };
  } catch {
    return null;
  }
}

export function resolvePersonArtifactRoute(imagePath, receipt) {
  const direct = findTaskRoute(imagePath);
  if (direct) return direct;
  const requestPath = receipt?.internal_generation_request_path;
  if (!requestPath || !existsSync(requestPath)) return null;
  try {
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    if (request.route_receipt && existsSync(request.route_receipt)) {
      return JSON.parse(readFileSync(request.route_receipt, "utf8"));
    }
  } catch {
    return findTaskRoute(requestPath);
  }
  return findTaskRoute(requestPath);
}

export function ensureFormalPersonCandidate(route, imagePath, receipt) {
  if (findTaskRoute(imagePath)) return imagePath;
  const origin = receipt?.raw_generation_path;
  if (!route?.task_root || !route?.category || !origin || !existsSync(origin))
    return imagePath;
  const extension = /^\.(png|jpe?g|webp)$/i.test(extname(imagePath))
    ? extname(imagePath).toLowerCase()
    : ".png";
  const candidateDir = join(route.task_root, "03_预览候选", route.category);
  mkdirSync(candidateDir, { recursive: true });
  const target = join(candidateDir, `${basename(imagePath, extname(imagePath))}${extension}`);
  if (!existsSync(target)) linkSync(origin, target);
  const targetStat = statSync(target);
  const originStat = statSync(origin);
  if (targetStat.dev !== originStat.dev || targetStat.ino !== originStat.ino)
    throw new Error("PERSON_FORMAL_CANDIDATE_IDENTITY_MISMATCH");
  return target;
}

function findTaskRoute(startPath) {
  if (!startPath) return null;
  let cursor = dirname(startPath);
  for (let depth = 0; depth < 10; depth += 1) {
    const routePath = join(cursor, "task_route.json");
    if (existsSync(routePath)) {
      try { return JSON.parse(readFileSync(routePath, "utf8")); }
      catch { return null; }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}
