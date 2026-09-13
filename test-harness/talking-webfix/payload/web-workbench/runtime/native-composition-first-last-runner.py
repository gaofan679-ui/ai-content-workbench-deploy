#!/usr/bin/env python3
"""Run an isolated H3 first-and-last-frame composition experiment."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile


def main() -> int:
    if len(sys.argv) < 4 or sys.argv[1] != "--base-runner":
        print("错误：首尾构图实验缺少正式执行器。", file=sys.stderr)
        return 1
    base_runner = pathlib.Path(sys.argv[2]).expanduser().resolve()
    if not base_runner.is_file():
        print("错误：首尾构图实验找不到正式执行器。", file=sys.stderr)
        return 1
    source_graph = (
        base_runner.parents[1]
        / "assets"
        / "h3-native-one-image-one-voice-composition-anchor-v0.1.workflow.json"
    )
    if not source_graph.is_file():
        print("错误：首尾构图实验缺少首帧锚点基础图。", file=sys.stderr)
        return 1
    spec = importlib.util.spec_from_file_location("talking_head_stable_runner", base_runner)
    if spec is None or spec.loader is None:
        print("错误：首尾构图实验无法加载正式执行器。", file=sys.stderr)
        return 1
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    graph = json.loads(source_graph.read_text(encoding="utf-8"))
    graph["153"] = {
        "inputs": {
            "positive": ["152", 0],
            "vae": ["119", 0],
            "latent": ["136", 1],
            "image": ["137", 0],
            "frame_idx": -1,
        },
        "class_type": "MiniMaxH3AddGuide",
        "_meta": {"title": "MiniMax H3 尾帧构图锚点"},
    }
    graph["126"]["inputs"]["conditioning"] = ["153", 0]
    with tempfile.TemporaryDirectory(prefix="h3-composition-first-last-") as temp_dir:
        experiment = pathlib.Path(temp_dir) / "workflow.json"
        experiment.write_text(
            json.dumps(graph, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        module.NATIVE_DEFAULT_WORKFLOW_JSON = experiment
        sys.argv = [str(base_runner), *sys.argv[3:]]
        return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
