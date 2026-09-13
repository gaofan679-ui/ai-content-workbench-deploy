import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const workbenchRoot = process.env.AI_WORKBENCH_HOME || join(homedir(), "AIContentWorkbench");
const candidates = [
  join(workbenchRoot, "系统文件_无需打开", "config", "customer_config.env"),
  join(workbenchRoot, "00_DO_NOT_DELETE_Core_Config", "customer_config.env"),
];

for (const path of candidates) {
  if (!existsSync(path)) continue;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  process.env.AI_WORKBENCH_ENV = path;
  break;
}
