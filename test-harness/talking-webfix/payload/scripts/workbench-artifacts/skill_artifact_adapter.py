#!/usr/bin/env python3
"""Shared file-contract v3 adapter for artifact-producing Skills.

The adapter only performs deterministic local filesystem routing through
artifact_manager.py. It does not call models, upload files, or delete history.
For newly-created task outputs only, approved files and complete bundles are
promoted to their single formal location instead of being permanently copied.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from artifact_manager import (
    ArtifactError,
    close_task,
    collect_bundle_return,
    init_project,
    publish,
    publish_bundle,
    register,
)
from workbench_paths import resolve_workbench_paths


DEFAULT_WORKBENCH = Path.home() / "AIContentWorkbench"
DEFAULT_REGISTRY = Path(__file__).with_name("artifact_profiles.json")
VALID_INTENTS = {"process", "final", "external_pack"}


class SkillAdapterError(RuntimeError):
    pass


def _safe_name(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", str(value or "").strip())
    return cleaned.strip("._") or fallback


def _load_profile(registry_path: Path, skill: str) -> dict[str, Any]:
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SkillAdapterError(f"文件合同注册表不可读：{registry_path}") from exc
    if registry.get("schema") != "workbench-artifact-profile-registry-v1":
        raise SkillAdapterError("文件合同注册表版本不受支持。")
    profile = registry.get("skills", {}).get(skill)
    if not isinstance(profile, dict):
        raise SkillAdapterError(f"Skill 未登记文件合同：{skill}")
    if profile.get("path_risk_status") != "managed":
        raise SkillAdapterError(f"Skill 尚未完成统一路径接入：{skill}")
    allowed = set(profile.get("allowed_intents") or [])
    if not allowed or not allowed.issubset(VALID_INTENTS):
        raise SkillAdapterError(f"Skill 文件合同意图配置无效：{skill}")
    return profile


def _workbench(value: str | None) -> Path:
    # Keep an explicit root authoritative; validation downstream must fail
    # closed instead of silently switching to another installed workbench.
    configured = os.environ.get("AI_WORKBENCH_HOME", "").strip()
    return Path(value or configured or DEFAULT_WORKBENCH).expanduser().resolve()


def _registry(value: str | None) -> Path:
    return Path(value).expanduser().resolve() if value else DEFAULT_REGISTRY.resolve()


def _inside(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _find_task_root(path: Path, workbench: Path) -> Path | None:
    projects = resolve_workbench_paths(workbench, create=False)["paths"]["projects"]
    for parent in (path, *path.parents):
        if parent == projects.parent:
            break
        if (parent / "task_route.json").is_file() and _inside(projects, parent):
            return parent
    return None


def _load_task_manifest(task_root: Path | None) -> dict[str, Any]:
    if task_root is None:
        return {}
    path = task_root / "task_manifest.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SkillAdapterError(f"任务文件清单不可读：{path}") from exc


def _existing_promoted_file(
    *, source: Path, workbench: Path, skill: str
) -> dict[str, Any] | None:
    task_root = _find_task_root(source, workbench)
    manifest = _load_task_manifest(task_root)
    try:
        original = str(source.relative_to(workbench))
    except ValueError:
        return None
    for item in manifest.get("files", []):
        if (
            item.get("original_path") == original
            and item.get("category") == skill
            and item.get("storage_mode") == "single_entity_promoted"
        ):
            published = workbench / str(item.get("path") or "")
            if published.is_file():
                return {
                    "status": "published",
                    "idempotent": True,
                    "published_path": str(published),
                    "result_folder": str(published.parent),
                    "task_manifest": str(task_root / "task_manifest.json"),
                    "size_bytes": published.stat().st_size,
                    "sha256": item.get("sha256"),
                    "storage_mode": "single_entity_promoted",
                    "source_retained": False,
                }
    return None


def _existing_promoted_bundle(
    *,
    source_dir: Path,
    workbench: Path,
    skill: str,
    bundle_id: str | None,
) -> dict[str, Any] | None:
    task_root = _find_task_root(source_dir, workbench)
    manifest = _load_task_manifest(task_root)
    try:
        original = str(source_dir.relative_to(workbench))
    except ValueError:
        return None
    for item in manifest.get("bundles", []):
        if (
            item.get("source_path") == original
            and item.get("category") == skill
            and item.get("storage_mode") == "single_entity_promoted"
            and (not bundle_id or item.get("bundle_id") == bundle_id)
        ):
            published = workbench / str(item.get("published_path") or "")
            bundle_manifest = published / "workbench_bundle_manifest.json"
            if published.is_dir() and bundle_manifest.is_file():
                return {
                    "status": "published",
                    "idempotent": True,
                    "published_path": str(published),
                    "formal_pack_path": str(published),
                    "bundle_manifest": str(bundle_manifest),
                    "task_manifest": str(task_root / "task_manifest.json"),
                    "file_count": item.get("file_count", 0),
                    "directory_count": item.get("directory_count", 0),
                    "size_bytes": item.get("size_bytes", 0),
                    "bundle_sha256": item.get("bundle_sha256"),
                    "storage_mode": "single_entity_promoted",
                    "source_retained": False,
                }
    return None


def _prepare(args: argparse.Namespace) -> dict[str, Any]:
    profile = _load_profile(_registry(args.registry), args.skill)
    if args.intent not in profile["allowed_intents"]:
        raise SkillAdapterError(
            f"{args.skill} 不允许 {args.intent} 落盘路线；允许值为 "
            + "、".join(profile["allowed_intents"])
        )
    route = init_project(
        argparse.Namespace(
            workbench=str(_workbench(args.workbench)),
            start=None,
            task_id=args.task_id,
            project_name=args.project_name,
            category=args.skill,
        )
    )
    work_dir = Path(route["work_dir"])
    skill_name = _safe_name(args.skill, "skill")
    process_dir = work_dir / "02_生产过程" / skill_name
    candidate_dir = Path(route["task_root"]) / "03_预览候选" / skill_name
    process_dir.mkdir(parents=True, exist_ok=True)
    candidate_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {
        **route,
        "status": "prepared",
        "contract": "skill_artifact_file_contract_v3",
        "skill": args.skill,
        "intent": args.intent,
        "allowed_intents": profile["allowed_intents"],
        "process_dir": str(process_dir),
        "candidate_dir": str(candidate_dir),
        "additional_llm_calls": 0,
        "full_workbench_scan": False,
    }
    if args.intent == "external_pack":
        pack_label = _safe_name(args.pack_label, f"{skill_name}_任务包")
        pack_source_dir = work_dir / "04_外部任务包源" / skill_name / pack_label
        if getattr(args, "bundle_id", ""):
            existing = _existing_promoted_bundle(
                source_dir=pack_source_dir,
                workbench=_workbench(args.workbench),
                skill=args.skill,
                bundle_id=args.bundle_id,
            )
            if existing is not None:
                published_path = Path(existing["published_path"])
                return {
                    **result,
                    **existing,
                    "status": "already_published",
                    "bundle_id": args.bundle_id,
                    "pack_source_dir": str(pack_source_dir),
                    "formal_return_dir": str(
                        published_path / "04_生成结果_放这里"
                    ),
                    "source_retained": False,
                }
        return_dir = pack_source_dir / "04_生成结果_放这里"
        result.update(
            {
                "pack_source_dir": str(pack_source_dir),
                "return_source_dir": str(return_dir),
                "scaffold_created": False,
            }
        )
    return result


def _publish_file(args: argparse.Namespace) -> dict[str, Any]:
    profile = _load_profile(_registry(args.registry), args.skill)
    if "final" not in profile["allowed_intents"]:
        raise SkillAdapterError(f"{args.skill} 不允许直接发布最终成果。")
    workbench = _workbench(args.workbench)
    source = Path(args.source).expanduser().resolve()
    if not source.is_file():
        existing = _existing_promoted_file(
            source=source,
            workbench=workbench,
            skill=args.skill,
        )
        if existing is not None:
            return {
                **existing,
                "contract": "skill_artifact_file_contract_v3",
                "skill": args.skill,
                "additional_llm_calls": 0,
            }
    result = publish(
        argparse.Namespace(
            workbench=str(workbench),
            source=str(source),
            task_id=args.task_id,
            project_name=args.project_name,
            category=args.skill,
            origin_step=args.origin_step,
            qc_status=args.qc_status,
            display_name=args.display_name,
            artifact_id=args.artifact_id,
            completed_at=args.completed_at,
            receipt=None,
            publication_mode="promote",
        )
    )
    return {
        **result,
        "contract": "skill_artifact_file_contract_v3",
        "skill": args.skill,
        "source_retained": False,
        "additional_llm_calls": 0,
    }


def _publish_pack(args: argparse.Namespace) -> dict[str, Any]:
    profile = _load_profile(_registry(args.registry), args.skill)
    if "external_pack" not in profile["allowed_intents"]:
        raise SkillAdapterError(f"{args.skill} 不允许发布外部任务包。")
    workbench = _workbench(args.workbench)
    source_dir = Path(args.source_dir).expanduser().resolve()
    task_root = _find_task_root(source_dir, workbench)
    expected_source_root = (
        task_root / "work" / "04_外部任务包源" / _safe_name(args.skill, "skill")
        if task_root is not None
        else None
    )
    if expected_source_root is None or not _inside(expected_source_root, source_dir):
        raise SkillAdapterError(
            "正式外部任务包必须位于 prepare 返回的 pack_source_dir 内；"
            "已阻止从 outputs、桌面、下载目录或项目自建目录直接发布。"
        )
    if not source_dir.is_dir():
        existing = _existing_promoted_bundle(
            source_dir=source_dir,
            workbench=workbench,
            skill=args.skill,
            bundle_id=args.bundle_id,
        )
        if existing is not None:
            published_path = Path(existing["published_path"])
            return {
                **existing,
                "contract": "skill_artifact_file_contract_v3",
                "skill": args.skill,
                "formal_return_dir": str(
                    published_path / "04_生成结果_放这里"
                ),
                "additional_llm_calls": 0,
            }
    return_dir = source_dir / "04_生成结果_放这里"
    if not return_dir.is_dir():
        raise SkillAdapterError("外部任务包缺少 04_生成结果_放这里，已停止发布。")
    result = publish_bundle(
        argparse.Namespace(
            workbench=str(workbench),
            source_dir=str(source_dir),
            task_id=args.task_id,
            project_name=args.project_name,
            category=args.skill,
            target_kind="external_task_pack",
            display_name=args.display_name,
            bundle_id=args.bundle_id,
            completed_at=args.completed_at,
            publication_mode="promote",
        )
    )
    published_path = Path(result["published_path"])
    return {
        **result,
        "contract": "skill_artifact_file_contract_v3",
        "skill": args.skill,
        "formal_pack_path": str(published_path),
        "formal_return_dir": str(published_path / "04_生成结果_放这里"),
        "source_retained": False,
        "additional_llm_calls": 0,
    }


def _collect(args: argparse.Namespace) -> dict[str, Any]:
    profile = _load_profile(_registry(args.registry), args.skill)
    if "external_pack" not in profile["allowed_intents"]:
        raise SkillAdapterError(f"{args.skill} 不允许回收外部任务包结果。")
    result = collect_bundle_return(
        argparse.Namespace(
            workbench=str(_workbench(args.workbench)),
            task_root=str(Path(args.task_root).expanduser().resolve()),
            bundle_id=args.bundle_id,
            return_dir_name="04_生成结果_放这里",
            collection_mode="move",
        )
    )
    return {
        **result,
        "contract": "skill_artifact_file_contract_v3",
        "skill": args.skill,
        "source_results_retained": False,
        "recommended_next_action": "按对应业务 Skill 完成质检；通过后再 publish-file。",
        "additional_llm_calls": 0,
    }


def _register_tree(args: argparse.Namespace) -> dict[str, Any]:
    _load_profile(_registry(args.registry), args.skill)
    workbench = _workbench(args.workbench)
    task_root = Path(args.task_root).expanduser().resolve()
    source_dir = Path(args.source_dir).expanduser().resolve()
    if not source_dir.is_dir() or not _inside(task_root, source_dir):
        raise SkillAdapterError("登记目录必须位于当前任务项目内。")
    files = [
        path
        for path in sorted(source_dir.rglob("*"))
        if path.is_file() and not path.is_symlink() and path.name != ".DS_Store"
    ]
    registrations = []
    for path in files:
        result = register(
            argparse.Namespace(
                workbench=str(workbench),
                file=str(path),
                task_id=args.task_id,
                project_name=args.project_name,
                category=args.skill,
                origin_step=args.origin_step,
                lifecycle_status=args.lifecycle_status,
                protection_level=args.protection_level,
                cleanup_status="keep",
                rebuildable=False,
                rebuild_recipe="",
                validation_command="",
                related_final="",
            )
        )
        registrations.append(result["file"]["path"])
    return {
        "status": "registered",
        "contract": "skill_artifact_file_contract_v3",
        "skill": args.skill,
        "source_dir": str(source_dir),
        "file_count": len(registrations),
        "registered_files": registrations,
        "cleanup_status": "keep",
        "additional_llm_calls": 0,
        "full_workbench_scan": False,
    }


def _close(args: argparse.Namespace) -> dict[str, Any]:
    _load_profile(_registry(args.registry), args.skill)
    result = close_task(
        argparse.Namespace(
            workbench=str(_workbench(args.workbench)),
            task_root=str(Path(args.task_root).expanduser().resolve()),
            expected_output=args.expected_output,
        )
    )
    return {
        **result,
        "contract": "skill_artifact_file_contract_v3",
        "skill": args.skill,
        "additional_llm_calls": 0,
    }


def _shared(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--skill", required=True)
    parser.add_argument("--workbench")
    parser.add_argument("--registry")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Skill 文件合同 v3 公共适配器")
    commands = parser.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare")
    _shared(prepare)
    prepare.add_argument("--task-id", required=True)
    prepare.add_argument("--project-name", required=True)
    prepare.add_argument("--intent", choices=sorted(VALID_INTENTS), required=True)
    prepare.add_argument("--pack-label", default="")
    prepare.add_argument(
        "--bundle-id",
        default="",
        help="外部任务包的稳定编号；已发布时幂等返回正式路径。",
    )
    prepare.set_defaults(handler=_prepare)

    publish_file = commands.add_parser("publish-file")
    _shared(publish_file)
    publish_file.add_argument("--source", required=True)
    publish_file.add_argument("--task-id", required=True)
    publish_file.add_argument("--project-name", required=True)
    publish_file.add_argument("--origin-step", required=True)
    publish_file.add_argument(
        "--qc-status", choices=("approved", "direct_use", "passed"), required=True
    )
    publish_file.add_argument("--display-name")
    publish_file.add_argument("--artifact-id")
    publish_file.add_argument("--completed-at")
    publish_file.set_defaults(handler=_publish_file)

    publish_pack = commands.add_parser("publish-pack")
    _shared(publish_pack)
    publish_pack.add_argument("--source-dir", required=True)
    publish_pack.add_argument("--task-id", required=True)
    publish_pack.add_argument("--project-name", required=True)
    publish_pack.add_argument("--display-name", required=True)
    publish_pack.add_argument("--bundle-id")
    publish_pack.add_argument("--completed-at")
    publish_pack.set_defaults(handler=_publish_pack)

    collect = commands.add_parser("collect")
    _shared(collect)
    collect.add_argument("--task-root", required=True)
    collect.add_argument("--bundle-id", required=True)
    collect.set_defaults(handler=_collect)

    register_tree = commands.add_parser("register-tree")
    _shared(register_tree)
    register_tree.add_argument("--task-root", required=True)
    register_tree.add_argument("--source-dir", required=True)
    register_tree.add_argument("--task-id", required=True)
    register_tree.add_argument("--project-name", required=True)
    register_tree.add_argument("--origin-step", required=True)
    register_tree.add_argument(
        "--lifecycle-status",
        choices=("approved_asset", "config", "evidence", "intermediate", "source"),
        default="intermediate",
    )
    register_tree.add_argument(
        "--protection-level",
        choices=("protected", "review", "ordinary"),
        default="review",
    )
    register_tree.set_defaults(handler=_register_tree)

    close = commands.add_parser("close")
    _shared(close)
    close.add_argument("--task-root", required=True)
    close.add_argument(
        "--expected-output",
        choices=("none", "file", "bundle", "any"),
        default="any",
    )
    close.set_defaults(handler=_close)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = args.handler(args)
    except (ArtifactError, SkillAdapterError, OSError) as exc:
        print(
            json.dumps({"status": "blocked", "reason": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
