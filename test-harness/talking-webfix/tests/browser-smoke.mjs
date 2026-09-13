// Reusable against the installed cloud Windows service or an isolated local copy.
// Browser uses the actual bundled page and actual backend; no fake job responses.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const require = createRequire(process.env.AICW_TEST_DEPENDENCY_ANCHOR);
const { chromium, expect } = require('@playwright/test');
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const report = { kind: 'browser_to_real_local_preflight', platform: process.platform,
  responses_mocked: false, synthetic_materials: true, remote_generation: 'not_executed',
  checks: {}, blocked_requests: [], errors: [] };
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort();
const decoyBefore = tree(spec.decoy_workbench);
const options = { headless: true };
if (!existsSync(chromium.executablePath())) options.channel = 'chrome';
const browser = await chromium.launch(options);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
let created;
page.on('pageerror', error => report.errors.push(error.message));
page.on('response', async response => {
  if (new URL(response.url()).pathname === '/talking-head/jobs' && response.request().method() === 'POST') {
    const data = await response.json().catch(() => ({}));
    report.submission = { status: response.status(), error: data.error || null };
    if (data.job) created = data.job;
  }
});
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    report.blocked_requests.push({ kind: ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname) ? 'external_font_blocked' : 'unexpected_external', host: url.hostname });
    return route.abort();
  }
  if (url.port === '4318') url.port = String(new URL(spec.runtime_url).port);
  const isBackend = url.port === new URL(spec.runtime_url).port;
  if (isBackend && !['GET', 'OPTIONS'].includes(request.method()) &&
      !(request.method() === 'POST' && ['/talking-head/jobs', '/talking-head/person-assets'].includes(url.pathname))) {
    report.blocked_requests.push({ kind: 'non_preflight_action', path: url.pathname });
    return route.abort();
  }
  await route.continue({ url: url.toString() });
});

try {
  await page.goto(spec.web_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await expect(page.getByText('工作台运行正常')).toBeVisible({ timeout: 15000 });
  report.checks.web_health = 'pass';
  await page.getByRole('button', { name: /AI 口播/ }).first().click();
  await page.getByRole('button', { name: /标准口播/ }).click();
  await page.getByRole('button', { name: '继续设置内容与人物 →' }).click();
  await page.getByRole('button', { name: /上传录好音频/ }).click();
  await page.getByLabel('已录好的口播音频').setInputFiles(join(spec.assets, 'synthetic-test-tone.wav'));
  await page.getByLabel('人物母版图').setInputFiles(join(spec.assets, 'synthetic-test-rectangle.png'));
  await expect(page.getByRole('button', { name: '查看制作方案 →' })).toBeEnabled();
  await page.getByRole('button', { name: '查看制作方案 →' }).click();
  await expect.poll(() => report.submission, { timeout: 30000 }).toBeTruthy();
  await expect.poll(() => Boolean(created), { timeout: 5000 }).toBe(true);
  assert.equal(report.submission.status, 201);
  assert.equal(created.mode, 'standard');
  assert.equal(created.state, 'preflight');
  assert.ok(resolve(created.task_root).startsWith(resolve(spec.workbench) + sep));
  const jobPath = join(spec.data_root, 'talking-head-jobs', `${created.id}.json`);
  assert.ok(existsSync(jobPath));
  const stored = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(stored.id, created.id);
  assert.equal(stored.person_asset.asset_id, created.person_asset.asset_id);
  assert.ok(stored.preflight.includes('本地预检通过'));
  assert.ok(!existsSync(stored.output), 'Preflight must not fabricate a completed video');
  assert.deepEqual(tree(spec.decoy_workbench), decoyBefore);
  report.checks.form_to_job_record_actual_root = 'pass';
  report.checks.decoy_unchanged = 'pass';
  report.checks.actual_provider_script_dry_run = 'pass';
  report.job = { id: created.id, mode: created.mode, state: created.state,
    task_root: created.task_root, job_file: jobPath, person_asset_id: created.person_asset.asset_id };
  const jobs = await fetch(`${spec.runtime_url}/talking-head/jobs`).then(r => r.json());
  assert.ok(jobs.jobs.some(j => j.id === created.id));
  report.checks.job_api_readback = 'pass';
  await page.screenshot({ path: join(spec.evidence_root, 'preflight-page.png'), fullPage: true });
  const text = await page.locator('body').innerText();
  writeFileSync(join(spec.evidence_root, 'preflight-page.txt'), text);
  const hasMissingConfig = /(?:未配置|缺少.{0,12}配置|完成.{0,12}配置|配置.{0,12}未完成)/.test(text);
  report.checks.missing_configuration_visible = hasMissingConfig ? 'pass' : 'fail';
  if (!hasMissingConfig) report.errors.push('No provider credentials are supplied, but the page does not explain missing generation configuration.');
  assert.ok(['missing', 'unverified'].includes(created.generation_configuration?.status));
  await expect(page.getByTestId('talking-generation-configuration')).toBeVisible();
  if (created.generation_configuration.status === 'missing') {
    await expect(page.locator('button[disabled]').filter({hasText: /提交|生成|样片/}).last()).toBeVisible();
    report.checks.windows_missing_configuration_disables_submit = 'pass';
  } else report.checks.windows_missing_configuration_disables_submit = 'not_applicable_on_mac';
  // Direct request deliberately exercises the backend guard. The separate runtime
  // and Python guards still prohibit external calls and OS credential access.
  const beforeGuard = readFileSync(jobPath, 'utf8');
  const denied = await fetch(`${spec.runtime_url}/talking-head/jobs/${created.id}/start`, {method:'POST'});
  assert.equal(denied.status, 409);
  const denial = await denied.json();
  assert.match(denial.error, /本次尚未提交/);
  assert.equal(readFileSync(jobPath, 'utf8'), beforeGuard);
  assert.ok(!existsSync(stored.output));
  report.checks.direct_submit_blocked_before_state_change = 'pass';
  report.configuration_denial = {status:denied.status, message:denial.error};
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /AI 口播/ }).first().click();
  await expect(page.getByText(/方案已经整理好|本次生成|方案确认/).first()).toBeVisible({ timeout: 10000 });
  report.checks.reload_reopens_task = 'pass';
  await page.screenshot({ path: join(spec.evidence_root, 'reopened-task.png'), fullPage: true });
  await page.getByRole('button', { name: '任务', exact: true }).click();
  const taskRow = page.getByRole('button', { name: new RegExp(created.id.slice(0, 6)) });
  await expect(taskRow).toBeVisible();
  await page.screenshot({ path: join(spec.evidence_root, 'task-center.png'), fullPage: true });
  report.checks.task_center_visible = 'pass';
  await taskRow.click();
  await expect(page.getByText(/方案已经整理好|本次生成|方案确认/).first()).toBeVisible();
  report.checks.task_center_reopens_job = 'pass';
  await page.getByRole('button', { name: '成果', exact: true }).click();
  await expect(page.getByText('还没有可用成果')).toBeVisible();
  await page.screenshot({ path: join(spec.evidence_root, 'results-center.png'), fullPage: true });
  report.checks.preflight_not_shown_as_completed_result = 'pass';
} catch (error) {
  report.errors.push(error.stack || String(error));
  await page.screenshot({ path: join(spec.evidence_root, 'failure-page.png'), fullPage: true }).catch(() => {});
  writeFileSync(join(spec.evidence_root, 'failure-page.txt'), await page.locator('body').innerText().catch(() => ''));
} finally {
  report.pass = report.errors.length === 0 && report.blocked_requests.every(item => item.kind === 'external_font_blocked');
  writeFileSync(join(spec.evidence_root, 'browser-smoke-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
