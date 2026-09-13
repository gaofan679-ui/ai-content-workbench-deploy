import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harnessRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const toolsRoot = join(harnessRoot, "payload", "scripts", "workbench-artifacts");
const adapter = join(toolsRoot, "skill_artifact_adapter.py");
const manager = join(toolsRoot, "artifact_manager.py");
const registry = join(toolsRoot, "artifact_profiles.json");
const python = process.env.TEST_PYTHON || (process.platform === "win32" ? "python.exe" : "python3");

function initializeWorkbench(workbench) {
  for (const name of ["01_素材入口", "02_项目工作区", "03_最终成果"])
    mkdirSync(join(workbench, name), { recursive: true });
}

function cp1252ParentEnv() {
  return { ...process.env, PYTHONUTF8: "0", PYTHONIOENCODING: "cp1252" };
}

test("artifact adapter emits valid UTF-8 JSON under a cp1252 parent", () => {
  const fixture = mkdtempSync(join(tmpdir(), "aicw-python-encoding-"));
  const workbench = join(fixture, "中文 工作台");
  try {
    initializeWorkbench(workbench);
    const raw = execFileSync(
      python,
      [adapter, "prepare", "--skill", "talking-head-video-workflow", "--task-id", "windows-encoding-contract", "--project-name", "中文口播测试", "--workbench", workbench, "--registry", registry, "--intent", "process"],
      { encoding: "utf8", env: cp1252ParentEnv() },
    );
    const result = JSON.parse(raw);
    assert.equal(result.status, "prepared");
    assert.match(result.task_root, /中文 工作台/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("artifact manager and adapter error streams stay UTF-8", () => {
  const fixture = mkdtempSync(join(tmpdir(), "aicw-manager-encoding-"));
  const workbench = join(fixture, "中文 工作台");
  try {
    initializeWorkbench(workbench);
    const raw = execFileSync(
      python,
      [manager, "init-project", "--workbench", workbench, "--task-id", "windows-manager-encoding", "--project-name", "中文成果测试", "--category", "video"],
      { encoding: "utf8", env: cp1252ParentEnv() },
    );
    assert.equal(JSON.parse(raw).status, "ready");
    const blocked = spawnSync(
      python,
      [adapter, "prepare", "--skill", "不存在的工作流", "--task-id", "blocked", "--project-name", "中文错误", "--intent", "process"],
      { encoding: "utf8", env: cp1252ParentEnv() },
    );
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /Skill 未登记文件合同/);
    assert.doesNotMatch(blocked.stderr, /UnicodeEncodeError/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
