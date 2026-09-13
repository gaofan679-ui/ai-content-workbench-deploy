import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { artifactRoot, skillFile } from "./portable-paths.mjs";

export async function runSocialExtraction(job, { env = process.env } = {}) {
  const executionEnv = loadWorkbenchEnvironment(env);
  const downloadsMedia = job.extraction_scope !== "copy_only";
  const local = findRegisteredSocialSource(job.source_url, executionEnv);
  if (local && (!downloadsMedia || local.downloaded_files?.length)) {
    return {
      ...local,
      source_url: job.source_url,
      reused_from_social_library: true,
      provider_usage: {
        ...(local.provider_usage || {}),
        original_confirmed_cost_usd: Number(local.provider_usage?.confirmed_cost_usd || 0),
        confirmed_cost_usd: 0,
        request_attempt_count: 0,
        retry_count: 0,
      },
    };
  }
  const command = executionEnv.WORKBENCH_SOCIAL_EXTRACTOR || "python3";
  // 小红书的完整分享文本能帮助详情接口避开短链偶发错配；抖音和
  // 视频号的提取器则需要一个纯 URL，不能把整段分享口令当成 URL。
  const sourceInput = /(?:xiaohongshu\.com|xhslink\.(?:com|cn))/i.test(job.source_url)
    ? job.source_text || job.source_url
    : job.source_url;
  const args = executionEnv.WORKBENCH_SOCIAL_EXTRACTOR
    ? [sourceInput, downloadsMedia ? "copy_and_media" : "copy_only"]
    : [skillFile("social-copy-extract", "scripts/extract.py", executionEnv), sourceInput, ...(downloadsMedia ? ["--download"] : [])];
  const output = await run(command, args, executionEnv);
  let result;
  try { result = JSON.parse(output.stdout); }
  catch { throw new Error("提取工具没有返回可读取的结果。"); }
  if (result?.error) throw new Error(result.error);
  return { ...result, source_url: job.source_url };
}

export function findRegisteredSocialSource(sourceUrl, env = process.env) {
  const root = env.WORKBENCH_SOCIAL_LIBRARY_ROOT || join(artifactRoot(env), "06_社媒素材库");
  if (!sourceUrl || !existsSync(root)) return null;
  const months = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const month of months) {
    const monthDir = join(root, month);
    const entries = readdirSync(monthDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of entries) {
      const manifestPath = join(monthDir, name, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (!sameRegisteredSource(manifest.source_url, sourceUrl)) continue;
        const outputDir = manifest.output_dir || dirname(manifestPath);
        const files = (manifest.downloaded_files || []).filter((file) => existsSync(join(outputDir, file)));
        return { ...manifest, output_dir: outputDir, downloaded_files: files };
      } catch { /* unrelated or incomplete historical source */ }
    }
  }
  return null;
}

export function sameRegisteredSource(registeredSource, requestedSource) {
  const requested = String(requestedSource || "").trim();
  const registered = String(registeredSource || "").trim();
  if (!requested || !registered) return false;
  if (registered === requested) return true;
  const urls = registered.match(/https?:\/\/[^\s\]()<>，。！？]+/gi) || [];
  return urls.some((url) => url.replace(/[，。！？,.!?]+$/, "") === requested);
}

export function inspectSocialExtractionAvailability({ env = process.env } = {}) {
  const executionEnv = loadWorkbenchEnvironment(env);
  const fixture = executionEnv.WORKBENCH_SOCIAL_EXTRACTOR;
  return {
    available: Boolean(fixture || executionEnv.TIKHUB_API_KEY),
    mode: fixture ? "fixture" : "live",
    user_message: fixture || executionEnv.TIKHUB_API_KEY
      ? "爆款提取已就绪。"
      : "爆款提取凭证尚未配置，当前不会创建任务或发起付费请求。",
  };
}

export function loadWorkbenchEnvironment(baseEnv = process.env) {
  const env = { ...baseEnv };
  const pointer = join(artifactRoot(baseEnv), "系统文件_无需打开", "config", ".env");
  const visited = new Set();
  for (const path of [pointer]) loadEnvFile(path, env, visited);
  return env;
}

function loadEnvFile(path, env, visited) {
  if (!path || visited.has(path) || !existsSync(path)) return;
  visited.add(path);
  const parsed = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[2].trim().startsWith("#")) continue;
    parsed[match[1]] = unquote(match[2].trim());
  }
  const nested = parsed.AI_WORKBENCH_ENV;
  if (nested) loadEnvFile(isAbsolute(nested) ? nested : resolve(dirname(path), nested), env, visited);
  for (const [key, value] of Object.entries(parsed)) if (key !== "AI_WORKBENCH_ENV" && !env[key]) env[key] = value;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      try {
        const parsed = JSON.parse(stderr || stdout);
        reject(new Error(parsed.error || "爆款提取没有完成。"));
      } catch {
        reject(new Error((stderr || stdout || `提取工具退出：${code}`).trim().slice(0, 1200)));
      }
    });
  });
}
