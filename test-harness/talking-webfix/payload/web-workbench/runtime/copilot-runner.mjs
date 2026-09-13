import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexArgs } from "./codex-runner.mjs";
import { runManagedCodex } from "./codex-execution-supervisor.mjs";
import { answerQuickQuestion, buildTaskContext, projectUserState } from "./task-user-state.mjs";

const schemaPath = fileURLToPath(new URL("./copilot-output-schema.json", import.meta.url));

export async function answerTaskQuestion({ task, taskDir, message, onEvent }) {
  const quick = answerQuickQuestion(task, message);
  if (quick) return quick;

  const copilotDir = join(taskDir, "copilot");
  mkdirSync(copilotDir, { recursive: true });
  const resultPath = join(copilotDir, `answer-${Date.now()}.json`);
  const prompt = `你是本地 AI 内容工作台里的只读副驾驶。\n\n任务上下文：\n${JSON.stringify(buildTaskContext(task), null, 2)}\n\n用户问题：\n${String(message).slice(0, 600)}\n\n规则：\n1. 只根据任务上下文，用直白中文回答；证据不足就明确说不知道。\n2. 不调用任何业务 Skill、工具或外部 API，不修改文件，不提交、不上传、不生成、不重试、不产生业务费用。\n3. 不声称后台做了上下文没有记载的事情。\n4. answer 先给结论；next_step 只给一个最稳妥的下一步；risk_note 说明本次只是只读解释。\n5. 严格按输出结构返回。`;
  const args = buildCodexArgs({ taskDir: copilotDir, resultPath, outputSchemaPath: schemaPath, sandbox: "read-only", includeWorkspaceDirs: false });
  await runManagedCodex({ args, prompt, env: process.env, onEvent });
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  return { ...result, source: "codex_read_only" };
}

export function fallbackTaskAnswer(task) {
  const state = projectUserState(task);
  return {
    answer: `${state.label}：${state.headline}。${state.summary}`,
    current_state: state.key,
    next_step: state.next_step,
    risk_note: "副驾驶暂时无法补充分析；没有提交、上传、重试或修改任务。",
    source: "fallback",
  };
}
