#!/usr/bin/env python3
"""Run the isolated H3 composition-anchor experiment through the stable CLI."""

from __future__ import annotations

import importlib.util
import pathlib
import sys


def main() -> int:
    if len(sys.argv) < 4 or sys.argv[1] != "--base-runner":
        print("错误：构图锁定实验缺少正式执行器。", file=sys.stderr)
        return 1
    base_runner = pathlib.Path(sys.argv[2]).expanduser().resolve()
    if not base_runner.is_file():
        print("错误：构图锁定实验找不到正式执行器。", file=sys.stderr)
        return 1
    experiment = (
        base_runner.parents[1]
        / "assets"
        / "h3-native-one-image-one-voice-composition-anchor-v0.1.workflow.json"
    )
    if not experiment.is_file():
        print("错误：构图锁定实验工作流尚未安装。", file=sys.stderr)
        return 1
    spec = importlib.util.spec_from_file_location("talking_head_stable_runner", base_runner)
    if spec is None or spec.loader is None:
        print("错误：构图锁定实验无法加载正式执行器。", file=sys.stderr)
        return 1
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.NATIVE_DEFAULT_WORKFLOW_JSON = experiment
    sys.argv = [str(base_runner), *sys.argv[3:]]
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
