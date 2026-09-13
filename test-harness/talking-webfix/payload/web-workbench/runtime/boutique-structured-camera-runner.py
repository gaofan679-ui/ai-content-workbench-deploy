#!/usr/bin/env python3
"""Run isolated boutique camera experiments with MiniMax's Ref2VA prompt contract."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import sys


EXPECTED_BASE_GRAPH_SHA256 = (
    "61209855e7e1c4cd8c9de2f72b743d0ed63c83ce6331ac80dbd757ae405e9a20"
)
SUPPORTED_VARIANTS = {
    "structured_prompt_v0_1",
    "structured_prompt_v0_2",
    "structured_prompt_v0_3",
    "structured_reference_v0_2",
}


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
        raise RuntimeError("精品机位实验的基础工作流已变化，已在上传前停止。")
    checks = (
        graph["136"].get("class_type") == "MiniMaxH3ReferenceToVideo",
        graph["136"]["inputs"].get("ref_images.ref_image_0") == ["137", 0],
        graph["136"]["inputs"].get("ref_audios.ref_audio_0") == ["177", 0],
        graph["172"].get("class_type") == "VRGDG_MiniMaxH3AudioDrive",
        graph["172"]["inputs"].get("source_audio") == ["177", 0],
        graph["172"]["inputs"].get("av_latent") == ["136", 1],
        graph["142"]["inputs"].get("audio") == ["172", 1],
        graph["126"]["inputs"].get("conditioning") == ["136", 0],
    )
    if not all(checks):
        raise RuntimeError("精品机位实验未保持原始音频驱动合同，已在上传前停止。")


def add_soft_camera_reference(graph: dict) -> None:
    graph["196"] = {
        "class_type": "RepeatImageBatch",
        "inputs": {"image": ["137", 0], "amount": 48},
        "_meta": {"title": "两秒静态机位软参考"},
    }
    graph["136"]["inputs"]["ref_videos.ref_video_0"] = ["196", 0]


def structured_prompt(variant: str) -> str:
    video_definition = (
        "\n<Video 1> is a two-second static camera-and-composition reference created from "
        "<Picture 1>; it supplies only viewpoint, framing, perspective, subject scale, and "
        "background placement, not a frozen facial pose."
        if variant == "structured_reference_v0_2"
        else ""
    )
    video_summary = (
        " <Video 1> weakly guides only the stationary camera relationship."
        if variant == "structured_reference_v0_2"
        else ""
    )
    video_retention = (
        "\n<Video 1> (camera and composition structure): weak_reference - retain only the "
        "stationary viewpoint, framing, subject scale, perspective, and background placement; "
        "do not copy its static lips, face, breath, or body pose."
        if variant == "structured_reference_v0_2"
        else ""
    )
    video_detail = (
        " The camera relationship follows <Video 1> only as a weak structural reference."
        if variant == "structured_reference_v0_2"
        else ""
    )
    return (
        "subject_definitions:\n"
        "<Subject 1> is the same visible person, clothing, hair, accessories, environment, "
        "lighting, and composition shown in <Picture 1>.\n"
        "<Picture 1> is the composition anchor for [Shot 1], defining the original camera "
        "height, viewing angle, perspective, crop, subject scale, headroom, and background layout."
        f"{video_definition}\n"
        "<Audio 1> is the complete source speech track that drives <Subject 1> (S1) and is "
        "copied exactly into the target video.\n\n"
        "summary:\n"
        "[reference generation + audio reuse] Create one continuous live-action talking-head "
        "shot of <Subject 1> using <Picture 1> for identity and composition."
        f"{video_summary} <Audio 1> is reused in full and remains the only speech authority.\n\n"
        "retention_analysis:\n"
        "<Subject 1> (appears in [Shot 1]): fully_preserved - keep the same identity, facial "
        "structure, hair, wardrobe, accessories, background, and lighting.\n"
        "<Picture 1> ([Shot 1] composition anchor): fully_preserved - retain the original "
        "camera height, angle, perspective, crop, subject size, headroom, and background layout."
        f"{video_retention}\n"
        "<Audio 1>: fully_copy - reuse the complete source audio signal 1:1 as the target "
        "video's complete final audio track.\n\n"
        "detailed_description:\n"
        "Live-action natural talking-head footage with the original lighting and image texture. "
        "[Shot 1] One continuous take with no cuts. <Subject 1> (S1) remains at the same base "
        "distance and orientation established by <Picture 1>. The camera is stationary: no zoom, "
        "push-in, pull-back, pan, tilt, roll, orbit, reframe, focus pull, or change of focal-length "
        "feel. The frame boundaries, subject scale, headroom, perspective, and background layout "
        "remain constant from beginning to end."
        f"{video_detail} <Subject 1> speaks naturally in exact synchrony with <Audio 1>. The lips, "
        "jaw, cheeks, eyes, breathing, and micro-expressions remain fluid and continuous rather "
        "than frozen. Natural blinks, small gaze changes, subtle breathing, gentle head-and-shoulder "
        "motion are allowed when motivated by the speech. "
        "Because this shot may be generated as an independent segment, its opening and closing states "
        "match the relaxed base pose in <Picture 1>: the same head-and-shoulder orientation, gaze region, "
        "hand and prop position, and body support. Any optional gesture finishes at least half a second "
        "before the final frame and returns to that relaxed base pose. Lip motion remains driven by "
        "<Audio 1> through the final audible syllable; after speech ends, the mouth settles naturally. "
        "The person does not lean toward or "
        "away from the lens and does not move sideways enough to change framing. No captions, "
        "stickers, overlays, new objects, or scene changes.\n\n"
        "overall_soundscape:\n"
        "<Audio 1> is fully copied as the exact final soundtrack. Do not generate, replace, "
        "translate, paraphrase, or add speech, ambience, sound effects, or room tone.\n\n"
        "non_diegetic_music:\n"
        "N/A"
    )


def main() -> int:
    if len(sys.argv) < 6 or sys.argv[1] != "--experiment-variant" or sys.argv[3] != "--base-runner":
        print("错误：精品机位实验缺少版本或正式执行器。", file=sys.stderr)
        return 1
    variant = sys.argv[2]
    if variant not in SUPPORTED_VARIANTS:
        print("错误：精品机位实验版本无效。", file=sys.stderr)
        return 1
    base_runner = pathlib.Path(sys.argv[4]).expanduser().resolve()
    if not base_runner.is_file():
        print("错误：精品机位实验找不到正式执行器。", file=sys.stderr)
        return 1
    run_argv = list(sys.argv[5:])
    try:
        prompt_index = run_argv.index("--prompt-file") + 1
        original_prompt_path = pathlib.Path(run_argv[prompt_index]).expanduser().resolve()
    except (ValueError, IndexError):
        print("错误：精品机位实验缺少提示词文件。", file=sys.stderr)
        return 1
    if not original_prompt_path.is_file():
        print("错误：精品机位实验找不到提示词文件。", file=sys.stderr)
        return 1

    graph_path = (
        pathlib.Path(__file__).resolve().parents[1]
        / "release-center"
        / "test-runs"
        / "20260828-boutique-dual-anchor-experiment"
        / "boutique-workflow-api-original.json"
    )
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    validate_base_graph(graph)
    if variant == "structured_reference_v0_2":
        add_soft_camera_reference(graph)

    prompt_path = original_prompt_path.with_name(f"{variant}_prompt.txt")
    prompt_path.write_text(structured_prompt(variant) + "\n", encoding="utf-8")
    run_argv[prompt_index] = str(prompt_path)

    spec = importlib.util.spec_from_file_location("talking_head_structured_camera_runner", base_runner)
    if spec is None or spec.loader is None:
        print("错误：精品机位实验无法加载正式执行器。", file=sys.stderr)
        return 1
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    graph_digest = canonical_sha256(graph)
    module.load_workflow_json = lambda _path_value: (graph, graph_digest)
    sys.argv = [str(base_runner), *run_argv]
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
