import { spawnSync } from 'node:child_process';
import { configuredBinary } from './portable-paths.mjs';

const guidance = '请通过工作台的配置入口完成 AI 口播生成通道配置，再重新打开工作台继续当前任务。';

// Read-only previews never open a credential store or contact the provider.
export function talkingConfiguration(env = process.env, platform = process.platform) {
  if (String(env.RUNNINGHUB_API_KEY || '').trim()) return {
    status: 'present', message: '已检测到生成通道配置；账号有效性和余额将在实际提交时由服务确认。',
  };
  if (platform === 'darwin') return {
    status: 'unverified', message: '尚未确认生成通道配置。若已使用系统钥匙串配置，提交前会检查；否则请先完成配置。',
  };
  return { status: 'missing', message: `尚未配置 AI 口播生成通道。${guidance}` };
}

// Called only at explicit generation entry points, before task state or files change.
// The existing macOS fallback stays available. No credential leaves the child process.
export function requireTalkingConfiguration({ env = process.env, platform = process.platform, run = spawnSync } = {}) {
  const status = talkingConfiguration(env, platform);
  if (status.status === 'present') return;
  if (platform === 'darwin') {
    const probe = run(configuredBinary('WORKBENCH_PYTHON', 'python3'), ['-c',
      'import subprocess,sys\ntry:\n r=subprocess.run(["security","find-generic-password","-s","RUNNINGHUB_API_KEY","-w"],capture_output=True,timeout=8)\n sys.exit(0 if r.returncode == 0 and r.stdout.strip() else 1)\nexcept Exception:\n sys.exit(1)'],
      { env, stdio: 'ignore', timeout: 10000 });
    if (!probe.error && probe.status === 0) return;
  }
  const error = new Error(`无法确认可用的 AI 口播生成配置，本次尚未提交。${guidance}`);
  error.code = 'TALKING_CONFIGURATION_REQUIRED';
  throw error;
}
