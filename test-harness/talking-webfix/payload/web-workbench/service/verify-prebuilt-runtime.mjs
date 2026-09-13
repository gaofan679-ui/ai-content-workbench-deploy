#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const root = resolve(args.get("--root") || ".");
const manifestPath = resolve(args.get("--manifest") || "");
const target = args.get("--target") || "";
if (!manifestPath || !target || !existsSync(manifestPath)) {
  throw new Error("PREBUILT_RUNTIME_ARGUMENTS_INVALID");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const artifact = manifest.artifacts?.[target];
if (!artifact) throw new Error(`PREBUILT_RUNTIME_TARGET_UNKNOWN:${target}`);

for (const relativePath of artifact.required_paths || []) {
  const absolute = resolve(root, relativePath);
  const route = relative(root, absolute);
  if (route.startsWith("..") || isAbsolute(route)) {
    throw new Error(`PREBUILT_RUNTIME_PATH_OUTSIDE_ROOT:${relativePath}`);
  }
  if (!existsSync(absolute)) throw new Error(`PREBUILT_RUNTIME_FILE_MISSING:${relativePath}`);
}

for (const [relative, expected] of Object.entries(artifact.critical_sha256 || {})) {
  const absolute = resolve(root, relative);
  if (!existsSync(absolute)) throw new Error(`PREBUILT_RUNTIME_FILE_MISSING:${relative}`);
  const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  if (actual !== expected) throw new Error(`PREBUILT_RUNTIME_HASH_MISMATCH:${relative}`);
}

console.log(JSON.stringify({ status: "prebuilt_runtime_verified", target }));
