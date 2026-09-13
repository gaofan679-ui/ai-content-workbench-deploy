import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export function userHome(env = process.env) {
  return env.USERPROFILE || env.HOME || homedir();
}

export function artifactRoot(env = process.env) {
  return env.WORKBENCH_ARTIFACT_ROOT || join(userHome(env), "AIContentWorkbench");
}

export function codexWorkspaceRoot(env = process.env) {
  return env.WORKBENCH_ROOT || artifactRoot(env);
}

export function skillRoot(skillName, env = process.env) {
  const configuredRoot = String(env.WORKBENCH_SKILLS_ROOT || env.CODEX_SKILLS_HOME || "").trim();
  if (configuredRoot) return join(configuredRoot, skillName);
  const candidates = [
    join(userHome(env), ".codex", "skills", skillName),
    join(userHome(env), ".agents", "skills", skillName),
  ].filter(existsSync);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error("WORKBENCH_SKILLS_ROOT_AMBIGUOUS");
  }
  return join(userHome(env), ".codex", "skills", skillName);
}

export function skillFile(skillName, relativePath, env = process.env) {
  const suffix = relativePath.split("/");
  const primary = join(skillRoot(skillName, env), ...suffix);
  if (existsSync(primary)) return primary;
  const candidates = [
    join(userHome(env), ".codex", "skills", skillName, ...suffix),
    join(userHome(env), ".agents", "skills", skillName, ...suffix),
    join(fileURLToPath(new URL("../../codex_skills/", import.meta.url)), skillName, ...suffix),
  ];
  return candidates.find(existsSync) || primary;
}

export function currentInstalledSkillFile(skillName, relativePath, env = process.env) {
  const suffix = relativePath.split("/");
  const installed = [
    join(userHome(env), ".codex", "skills", skillName, ...suffix),
    join(userHome(env), ".agents", "skills", skillName, ...suffix),
  ].find(existsSync);
  return installed || skillFile(skillName, relativePath, env);
}

export function workbenchRuntimeFile(relativePath, env = process.env) {
  const installedRuntimePath = join(
    artifactRoot(env),
    "系统文件_无需打开",
    "runtime",
    ...relativePath.split("/"),
  );
  if (existsSync(installedRuntimePath)) return installedRuntimePath;

  // The editable/deployment bundle keeps portable runtime helpers under
  // `scripts/`. Use them when the installed runtime payload has not yet been
  // materialized, so local testing and customer packages share one fallback.
  const bundledRuntimePath = join(
    fileURLToPath(new URL("../../scripts/", import.meta.url)),
    ...relativePath.split("/"),
  );
  return existsSync(bundledRuntimePath) ? bundledRuntimePath : installedRuntimePath;
}

export function artifactToolFile(relativePath, env = process.env) {
  return join(
    artifactRoot(env),
    "系统文件_无需打开",
    "tools",
    "scripts",
    "workbench-artifacts",
    ...relativePath.split("/"),
  );
}

export function configuredBinary(envName, fallback, env = process.env) {
  const configured = String(env[envName] || "").trim();
  if (configured) return configured;
  if (isAbsolute(fallback) && existsSync(fallback)) return fallback;

  const names = process.platform === "win32" ? [fallback, `${fallback}.exe`] : [fallback];
  const searchRoots = [
    ...String(env.PATH || "")
      .split(delimiter)
      .filter(Boolean),
    join(userHome(env), "bin"),
    join(userHome(env), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  for (const root of [...new Set(searchRoots)]) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return fallback;
}
