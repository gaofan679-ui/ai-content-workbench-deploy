"""Run the installed editing entry on a new Mandarin clip without a transcript."""
from argparse import ArgumentParser
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from zipfile import ZipFile

from validate_editing_r11 import command, digest, read_json, write_json

EXPECTED = "今天我们一起学习视频剪辑先听清楚原声然后检查每一句字幕"
SIMPLIFIED = str.maketrans("們學習視頻剪輯聽聲後檢查", "们学习视频剪辑听声后检查")


def run(bundle, model, root):
    root.mkdir()
    inputs = root / "private"
    with ZipFile(bundle) as archive:
        archive.extractall(inputs)
    skill = inputs / "测试用户 profile/.workbuddy/skills/ai-video-editing-post"
    manifest = read_json(skill / "distribution.json")
    assert manifest["version"] == "0.3.3-r11-win2"
    for name, sha in manifest["files"].items():
        assert digest(skill / name) == sha, name
    paths = skill / "scripts"
    review = paths / "talking_head_review.py"
    source = root / "新口播原片 take 02.mp4"
    prepared = root / "prepared"
    command("ffmpeg", "-hide_banner", "-loglevel", "error", "-n",
            "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25",
            "-i", inputs / "mandarin-example.aiff", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source)
    command(sys.executable, review, "prepare", "--source", source,
            "--template", inputs / "template-r11.zip", "--out", prepared)
    config = (root / "speech-config.json").resolve()
    environment = dict(os.environ, HF_HUB_OFFLINE="1", PYTHONUTF8="1")
    subprocess.run([sys.executable, str(paths / "windows_speech/asr_registered_consumer.py"),
                    "--setup-model", str(model), "--out", str(config)], env=environment, check=True)
    environment["SYNESTIA_EDITING_SPEECH_CONFIG"] = str(config)
    transcript = root / "transcript"
    invocation = [sys.executable, str(review), "transcript", "--prepared", str(prepared / "prepared.json")]
    try:
        subprocess.run([*invocation, "--out", str(transcript)], env=environment, check=True)
    except subprocess.CalledProcessError:
        # This runner only ever processes its generated speech sample.
        for name in ("backend-process.internal.json", "backend-result.internal.json"):
            detail = transcript / name
            if detail.is_file():
                print(detail.read_text(encoding="utf-8"), file=sys.stderr)
        raise
    receipt = read_json(transcript / "evidence/transcript-consumption.internal.json")
    bound_output = read_json(Path(receipt["word_evidence"]["path"]))
    raw_text = bound_output["analysis"]["text"]
    normalized = re.sub(r"[^\w]", "", raw_text.translate(SIMPLIFIED))
    assert normalized == EXPECTED, f"Unexpected synthetic sample transcript: {raw_text}"
    assert receipt["provenance"]["language"] == "zh"
    assert receipt["source_sha256"] == digest(source)
    assert receipt["cloud_requests"] == 0 and receipt["new_backend_operations"] == 1
    assert receipt["backend_query"]["new_transcription_executed"]
    words = bound_output["analysis"]["words"]
    assert words[-1]["end"] > words[0]["start"] and len(words) > 5
    operation = receipt["backend_query"]["operation_files"]
    query_config = root / "query-only.json"
    query = dict(read_json(config), mode="completed_operation_query_only", completed_operation=operation)
    write_json(query_config, query)
    query_receipt_dir = root / "queried"
    subprocess.run([*invocation, "--speech-config", str(query_config), "--out", str(query_receipt_dir)],
                   env=environment, check=True)
    queried = read_json(query_receipt_dir / "transcript-consumption.internal.json")
    assert queried["word_evidence"] == receipt["word_evidence"]
    assert queried["backend_query"]["operation_id"] == receipt["backend_query"]["operation_id"]
    assert queried["backend_query"]["completed_operation_reused"] and queried["inference_calls"] == 0
    write_json(root / "asr-verification.json", {
        "state": "passed", "platform": platform.system(), "machine": platform.machine(),
        "skillVersion": manifest["version"], "transcript": raw_text, "wordCount": len(words),
        "timingSeconds": [words[0]["start"], words[-1]["end"]],
        "matchedCurrentSource": True, "expectedTranscriptMatched": True,
        "originalOperationReused": True, "cloudRequests": 0,
    })


if __name__ == "__main__":
    parser = ArgumentParser()
    for option in ("bundle", "model", "output"):
        parser.add_argument("--" + option, type=Path, required=True)
    arguments = parser.parse_args()
    run(arguments.bundle.resolve(), arguments.model.resolve(), arguments.output.resolve())
