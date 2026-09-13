import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { artifactRoot, artifactToolFile, configuredBinary } from "./portable-paths.mjs";

const ROUTE_SCHEMA = "workbench-task-route-v1";

export function ensureXhsJewelryProjectRoute(task, taskDir, env = process.env) {
  const routePath = join(taskDir, "ARTIFACT_ROUTE.json");
  if (existsSync(routePath)) {
    return validateXhsJewelryProjectRoute(JSON.parse(readFileSync(routePath, "utf8")), task, env);
  }
  const output = execFileSync(configuredBinary("WORKBENCH_PYTHON", "python3", env), [
    artifactToolFile("artifact_manager.py", env),
    "init-project",
    "--workbench", artifactRoot(env),
    "--start", taskDir,
    "--task-id", task.id,
    "--project-name", task.title,
    "--category", "xhs-jewelry-visual-remix",
  ], { encoding: "utf8", timeout: 30_000, env });
  const route = validateXhsJewelryProjectRoute(JSON.parse(output), task, env);
  mkdirSync(route.final_dir, { recursive: true });
  mkdirSync(route.work_dir, { recursive: true });
  writeFileSync(routePath, `${JSON.stringify(route, null, 2)}\n`, { flag: "wx" });
  return route;
}

export function validateXhsJewelryProjectRoute(route, task, env = process.env) {
  if (
    !route ||
    route.schema !== ROUTE_SCHEMA ||
    route.status !== "ready" ||
    route.task_id !== task.id ||
    typeof route.task_root !== "string" ||
    typeof route.final_dir !== "string" ||
    typeof route.work_dir !== "string"
  ) throw new Error("XHS_JEWELRY_ARTIFACT_ROUTE_INVALID");

  const workbench = realpathSync(artifactRoot(env));
  const projectsRoot = `${realpathSync(join(workbench, "02_项目工作区"))}${sep}`;
  const taskRoot = realpathSync(route.task_root);
  if (!taskRoot.startsWith(projectsRoot) || !basename(taskRoot).includes(task.id)) {
    throw new Error("XHS_JEWELRY_ARTIFACT_ROUTE_OUTSIDE_WORKBENCH");
  }
  for (const value of [taskRoot, route.final_dir, route.work_dir]) {
    if (!existsSync(value) || lstatSync(value).isSymbolicLink()) {
      throw new Error("XHS_JEWELRY_ARTIFACT_ROUTE_PATH_INVALID");
    }
    const canonical = realpathSync(value);
    if (canonical !== taskRoot && !canonical.startsWith(`${taskRoot}${sep}`)) {
      throw new Error("XHS_JEWELRY_ARTIFACT_ROUTE_PATH_OUTSIDE_PROJECT");
    }
  }
  return { ...route, task_root: taskRoot };
}
