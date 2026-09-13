#!/usr/bin/env python3
"""Run the isolated boutique soft static-camera-reference experiment.

The production boutique graph keeps the confirmed audio as the only speech
authority.  This wrapper adds a short repeated-image reference clip to the H3
reference encoder, but deliberately does not add image guides to the denoising
timeline.  That distinction is the experiment: guide composition softly while
leaving lips and micro-expressions free to follow the audio drive.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import sys


EXPECTED_BASE_GRAPH_SHA256 = (
    "61209855e7e1c4cd8c9de2f72b743d0ed63c83ce6331ac80dbd757ae405e9a20"
)
STATIC_REFERENCE_FRAMES = 48  # two seconds at the workflow's verified 24 fps


def canonical_sha256(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def validate_base_graph(graph: dict) -> None:
    if canonical_sha256(graph) != EXPECTED_BASE_GRAPH_SHA256:
        raise RuntimeError("精品软机位实验的基础工作流已变化，已在上传前停止。")
    required = {"119", "120", "126", "136", "137", "142", "172", "177"}
    if not required.issubset(graph):
        raise RuntimeError("精品软机位实验缺少必要节点，已在上传前停止。")
    checks = (
        graph["136"].get("class_type") == "MiniMaxH3ReferenceToVideo",
        graph["136"]["inputs"].get("ref_images.ref_image_0") == ["137", 0],
        graph["172"].get("class_type") == "VRGDG_MiniMaxH3AudioDrive",
        graph["172"]["inputs"].get("source_audio") == ["177", 0],
        graph["172"]["inputs"].get("av_latent") == ["136", 1],
        graph["142"]["inputs"].get("audio") == ["172", 1],
        graph["126"]["inputs"].get("conditioning") == ["136", 0],
    )
    if not all(checks):
        raise RuntimeError("精品软机位实验未保持原始音频驱动合同，已在上传前停止。")


def build_candidate(graph: dict) -> dict:
    graph["196"] = {
        "class_type": "RepeatImageBatch",
        "inputs": {
            "image": ["137", 0],
            "amount": STATIC_REFERENCE_FRAMES,
        },
        "_meta": {"title": "两秒静态机位软参考"},
    }
    graph["136"]["inputs"]["ref_videos.ref_video_0"] = ["196", 0]
    return graph


def augment_prompt(prompt_path: pathlib.Path) -> pathlib.Path:
    original = prompt_path.read_text(encoding="utf-8").strip()
    camera_contract = (
        "<Video 1>只作为静态机位与构图参考。全程继承它的镜头高度、拍摄角度、"
        "透视、人物大小、裁切范围和背景位置，但不要复制静止的嘴部状态。"
        "人物必须跟随输入音频自然说话，嘴唇、眼睛、呼吸和微表情连续自然；"
        "摄影机不推近、不拉远、不平移、不摇镜、不重新取景。"
    )
    candidate_path = prompt_path.with_name("static_camera_reference_prompt.txt")
    candidate_path.write_text(f"{camera_contract}\n{original}\n", encoding="utf-8")
    return candidate_path


def main() -> int:
    if len(sys.argv) < 4 or sys.argv[1] != "--base-runner":
        print("错误：精品软机位实验缺少正式执行器。", file=sys.stderr)
        return 1
    base_runner = pathlib.Path(sys.argv[2]).expanduser().resolve()
    if not base_runner.is_file():
        print("错误：精品软机位实验找不到正式执行器。", file=sys.stderr)
        return 1

    run_argv = list(sys.argv[3:])
    try:
        prompt_index = run_argv.index("--prompt-file") + 1
        prompt_path = pathlib.Path(run_argv[prompt_index]).expanduser().resolve()
    except (ValueError, IndexError):
        print("错误：精品软机位实验缺少提示词文件。", file=sys.stderr)
        return 1
    if not prompt_path.is_file():
        print("错误：精品软机位实验找不到提示词文件。", file=sys.stderr)
        return 1

    graph_path = (
        pathlib.Path(__file__).resolve().parents[1]
        / "release-center"
        / "test-runs"
        / "20260828-boutique-dual-anchor-experiment"
        / "boutique-workflow-api-original.json"
    )
    if not graph_path.is_file():
        print("错误：精品软机位实验找不到基础工作流。", file=sys.stderr)
        return 1
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    validate_base_graph(graph)
    candidate = build_candidate(graph)

    spec = importlib.util.spec_from_file_location("talking_head_soft_camera_runner", base_runner)
    if spec is None or spec.loader is None:
        print("错误：精品软机位实验无法加载正式执行器。", file=sys.stderr)
        return 1
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    run_argv[prompt_index] = str(augment_prompt(prompt_path))
    graph_digest = canonical_sha256(candidate)
    module.load_workflow_json = lambda _path_value: (candidate, graph_digest)
    sys.argv = [str(base_runner), *run_argv]
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
