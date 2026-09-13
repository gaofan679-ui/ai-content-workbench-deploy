#!/usr/bin/env python3
"""Run the isolated boutique exact-audio in-segment composition-anchor experiment."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import sys


EXPECTED_GRAPH_SHA256 = "aed20b4fbb93e05973038ed6fdc1dd8cf740eb88a6d5d23e3c424a25fd1a2e4b"


def canonical_sha256(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def validate_graph(graph: dict) -> None:
    if canonical_sha256(graph) != EXPECTED_GRAPH_SHA256:
        raise RuntimeError("精品固定机位实验图已变化，已在上传前停止。")
    required = {
        "119", "120", "126", "136", "137", "142", "171", "172", "177",
        "196", "197", "198", "199", "200",
    }
    if not required.issubset(graph):
        raise RuntimeError("精品固定机位实验图缺少必要节点，已在上传前停止。")
    checks = (
        graph["172"].get("class_type") == "VRGDG_MiniMaxH3AudioDrive",
        graph["172"]["inputs"].get("source_audio") == ["177", 0],
        graph["142"]["inputs"].get("audio") == ["172", 1],
        graph["196"].get("class_type") == "MiniMaxH3AddGuide",
        graph["196"]["inputs"].get("frame_idx") == 0,
        graph["196"]["inputs"].get("latent") == ["172", 0],
        graph["198"].get("class_type") == "MiniMaxH3AddGuide",
        graph["198"]["inputs"].get("positive") == ["196", 0],
        graph["198"]["inputs"].get("latent") == ["172", 0],
        graph["199"].get("class_type") == "MiniMaxH3AddGuide",
        graph["199"]["inputs"].get("positive") == ["198", 0],
        graph["199"]["inputs"].get("latent") == ["172", 0],
        graph["200"].get("class_type") == "MiniMaxH3AddGuide",
        graph["200"]["inputs"].get("positive") == ["199", 0],
        graph["200"]["inputs"].get("latent") == ["172", 0],
        graph["197"].get("class_type") == "MiniMaxH3AddGuide",
        graph["197"]["inputs"].get("positive") == ["200", 0],
        graph["197"]["inputs"].get("frame_idx") == -1,
        graph["197"]["inputs"].get("latent") == ["172", 0],
        graph["126"]["inputs"].get("conditioning") == ["197", 0],
    )
    if not all(checks):
        raise RuntimeError("精品固定机位实验图未保持完整音频与段内多点锚定合同，已在上传前停止。")


def apply_dynamic_anchor_positions(graph: dict, argv: list[str]) -> None:
    try:
        duration_index = argv.index("--duration") + 1
        duration_seconds = float(argv[duration_index])
    except (ValueError, IndexError):
        raise RuntimeError("精品固定机位实验缺少片段时长，已在上传前停止。")
    nominal_frames = max(5, round(duration_seconds * 24))
    padded_frames = nominal_frames + (5 - (nominal_frames % 17)) % 17
    last_index = max(4, padded_frames - 1)
    anchors = (
        max(1, round(last_index * 0.25)),
        max(2, round(last_index * 0.50)),
        max(3, round(last_index * 0.75)),
    )
    if len(set(anchors)) != 3 or anchors[-1] >= last_index:
        raise RuntimeError("精品固定机位实验无法建立合法的段内锚点，已在上传前停止。")
    for node_id, frame_idx in zip(("198", "199", "200"), anchors):
        graph[node_id]["inputs"]["frame_idx"] = frame_idx


def main() -> int:
    if len(sys.argv) < 4 or sys.argv[1] != "--base-runner":
        print("错误：精品固定机位实验缺少正式执行器。", file=sys.stderr)
        return 1
    base_runner = pathlib.Path(sys.argv[2]).expanduser().resolve()
    if not base_runner.is_file():
        print("错误：精品固定机位实验找不到正式执行器。", file=sys.stderr)
        return 1
    graph_path = (
        pathlib.Path(__file__).resolve().parents[1]
        / "release-center"
        / "test-runs"
        / "20260828-boutique-dual-anchor-experiment"
        / "boutique-workflow-api-dual-anchor-candidate.json"
    )
    if not graph_path.is_file():
        print("错误：精品固定机位实验图不存在。", file=sys.stderr)
        return 1
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    validate_graph(graph)
    apply_dynamic_anchor_positions(graph, sys.argv[3:])

    spec = importlib.util.spec_from_file_location("talking_head_boutique_runner", base_runner)
    if spec is None or spec.loader is None:
        print("错误：精品固定机位实验无法加载正式执行器。", file=sys.stderr)
        return 1
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    graph_digest = canonical_sha256(graph)
    module.load_workflow_json = lambda _path_value: (graph, graph_digest)
    sys.argv = [str(base_runner), *sys.argv[3:]]
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
