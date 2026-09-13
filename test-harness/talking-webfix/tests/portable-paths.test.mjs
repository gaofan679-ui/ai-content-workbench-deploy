import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  artifactRoot,
  artifactToolFile,
  codexWorkspaceRoot,
} from "../payload/web-workbench/runtime/portable-paths.mjs";

test("installed service root drives artifact paths at a custom customer location", () => {
  const customRoot = String.raw`D:\a\_temp\custom-location\AIContentWorkbench`;
  const env = {
    AI_WORKBENCH_HOME: customRoot,
    USERPROFILE: String.raw`C:\Users\runneradmin`,
  };

  assert.equal(artifactRoot(env), customRoot);
  assert.equal(
    artifactToolFile("skill_artifact_adapter.py", env),
    join(
      customRoot,
      "系统文件_无需打开",
      "tools",
      "scripts",
      "workbench-artifacts",
      "skill_artifact_adapter.py",
    ),
  );
});

test("explicit artifact override wins over the installed service root", () => {
  const env = {
    WORKBENCH_ARTIFACT_ROOT: String.raw`E:\formal-artifacts`,
    AI_WORKBENCH_HOME: String.raw`D:\installed-workbench`,
    USERPROFILE: String.raw`C:\Users\runneradmin`,
  };
  assert.equal(artifactRoot(env), env.WORKBENCH_ARTIFACT_ROOT);
});

test("blank overrides fall back to the installed service root", () => {
  const env = {
    WORKBENCH_ARTIFACT_ROOT: "   ",
    AI_WORKBENCH_HOME: String.raw`D:\installed-workbench`,
    USERPROFILE: String.raw`C:\Users\runneradmin`,
  };
  assert.equal(artifactRoot(env), env.AI_WORKBENCH_HOME);
});

test("workspace override remains independent from artifact storage", () => {
  const env = {
    WORKBENCH_ROOT: String.raw`E:\codex-workspace`,
    AI_WORKBENCH_HOME: String.raw`D:\installed-workbench`,
    USERPROFILE: String.raw`C:\Users\runneradmin`,
  };
  assert.equal(codexWorkspaceRoot(env), env.WORKBENCH_ROOT);
  assert.equal(artifactRoot(env), env.AI_WORKBENCH_HOME);
});

test("default remains the current user's AIContentWorkbench", () => {
  const env = { USERPROFILE: String.raw`C:\Users\runneradmin` };
  assert.equal(artifactRoot(env), join(env.USERPROFILE, "AIContentWorkbench"));
});
