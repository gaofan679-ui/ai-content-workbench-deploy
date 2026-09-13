"""Windows CI only: synthetic inputs + untouched default-directory sentinel."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import runpy
import sys

p = argparse.ArgumentParser()
p.add_argument('--workbench', type=Path, required=True)
p.add_argument('--evidence', type=Path, required=True)
p.add_argument('--assets', type=Path, required=True)
args = p.parse_args()
if sys.platform != 'win32' or os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('Only allowed on disposable GitHub Windows runner')
if os.environ.get('RUNNINGHUB_API_KEY', '').strip():
    raise SystemExit('Missing-configuration test must not receive provider credentials')
root = args.workbench.resolve()
tools = root / '系统文件_无需打开/tools/scripts/workbench-artifacts'
sys.path.insert(0, str(tools))
from workbench_paths import resolve_workbench_paths
resolve_workbench_paths(root, create=False)
default = Path.home() / 'AIContentWorkbench'
if root == default:
    raise SystemExit('The test must use a non-default installation root')
marker = default / '.talking-path-ci-sentinel'
if default.exists() and not marker.is_file():
    raise SystemExit('Refusing to modify an unknown existing default workbench')
if not default.exists():
    resolve_workbench_paths(default, create=True)
    marker.write_text('synthetic CI workbench; no customer data', encoding='utf-8')
spec = {
    'workbench': str(root), 'decoy_workbench': str(default),
    'assets': str(args.assets.resolve()), 'evidence_root': str(args.evidence.resolve()),
    'data_root': str(root / '系统文件_无需打开/tools/web-workbench/data'),
    'web_url': 'http://127.0.0.1:3000', 'runtime_url': 'http://127.0.0.1:4318',
    'synthetic_only': True, 'provider_credentials': 'absent',
}
path = args.evidence / 'browser-spec.json'
with path.open('x', encoding='utf-8') as f:
    json.dump(spec, f, ensure_ascii=False, indent=2)
print(str(path))
