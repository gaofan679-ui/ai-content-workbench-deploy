#!/usr/bin/env python3
"""Publish verified final artifacts and inventory a workbench without cleanup."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import unicodedata
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from workbench_paths import (
    WorkbenchPathError,
    discover_workbench_paths,
    resolve_workbench_paths,
    serializable_contract,
)


def _force_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


_force_utf8_stdio()


PUBLISHABLE_QC = {"passed", "approved", "direct_use"}
PROTECTED_LIFECYCLES = {"final", "source", "approved_asset", "config", "evidence"}
CANDIDATE_LIFECYCLES = {"rebuildable_temp", "proxy", "extracted_frame", "temporary_audio"}
ALL_LIFECYCLES = PROTECTED_LIFECYCLES | CANDIDATE_LIFECYCLES | {
    "intermediate",
    "rejected",
    "unknown",
}
PROTECTED_ROOT_KEYS = {
    "inbox",
    "outputs",
    "external_packs",
    "social_library",
    "customer_packages",
    "core_config",
    "skills_backup",
}
WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class ArtifactError(RuntimeError):
    """Raised when publication or inventory would violate the contract."""


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_name(value: str, fallback: str, max_length: int = 56) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").strip()
    normalized = re.sub(r"[\s/\\:&?#%*|<>\"']+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized).strip("._ ")
    if not normalized:
        normalized = fallback
    stem = normalized.split(".", 1)[0].upper()
    if stem in WINDOWS_RESERVED:
        normalized = "_" + normalized
    return normalized[:max_length].rstrip("._ ") or fallback


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False, prefix=".tmp_"
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False, prefix=".tmp_"
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _next_available_path(destination: Path, source_hash: str) -> tuple[Path, bool]:
    if not destination.exists():
        return destination, False
    if destination.is_file() and _sha256(destination) == source_hash:
        return destination, True
    for version in range(2, 1000):
        candidate = destination.with_name(
            f"{destination.stem}_v{version:02d}{destination.suffix}"
        )
        if not candidate.exists():
            return candidate, False
        if candidate.is_file() and _sha256(candidate) == source_hash:
            return candidate, True
    raise ArtifactError("artifact_version_limit_reached")


def _copy_verified(source: Path, destination: Path, expected_hash: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise ArtifactError("artifact_destination_exists_no_overwrite")
    temporary = destination.parent / f".{destination.name}.publishing"
    if temporary.exists():
        raise ArtifactError("artifact_temporary_collision")
    try:
        shutil.copy2(source, temporary)
        actual_hash = _sha256(temporary)
        if actual_hash != expected_hash or temporary.stat().st_size != source.stat().st_size:
            raise ArtifactError("artifact_copy_verification_failed")
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def _move_verified(source: Path, destination: Path, expected_hash: str) -> None:
    """Atomically promote a newly-created task artifact on the same volume."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise ArtifactError("artifact_destination_exists_no_overwrite")
    if source.stat().st_dev != destination.parent.stat().st_dev:
        raise ArtifactError("single_entity_cross_volume_move_blocked")
    source_size = source.stat().st_size
    os.replace(source, destination)
    try:
        if (
            destination.stat().st_size != source_size
            or _sha256(destination) != expected_hash
        ):
            raise ArtifactError("artifact_move_verification_failed")
    except Exception:
        if destination.exists() and not source.exists():
            os.replace(destination, source)
        raise


def _clone_verified(source: Path, destination: Path, expected_hash: str) -> None:
    """Create an APFS copy-on-write clone without silently falling back to copy."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise ArtifactError("artifact_destination_exists_no_overwrite")
    if source.stat().st_dev != destination.parent.stat().st_dev:
        raise ArtifactError("retained_source_cross_volume_clone_blocked")
    if sys.platform != "darwin":
        raise ArtifactError("copy_on_write_clone_not_supported")
    temporary = destination.parent / f".{destination.name}.cloning"
    if temporary.exists():
        raise ArtifactError("artifact_temporary_collision")
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        clonefile = getattr(libc, "clonefile", None)
        if clonefile is None:
            raise ArtifactError("copy_on_write_clone_not_supported")
        clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        clonefile.restype = ctypes.c_int
        if clonefile(os.fsencode(source), os.fsencode(temporary), 0) != 0:
            error_number = ctypes.get_errno()
            raise ArtifactError(
                f"copy_on_write_clone_unavailable_errno_{error_number}"
            )
        if (
            temporary.stat().st_size != source.stat().st_size
            or _sha256(temporary) != expected_hash
        ):
            raise ArtifactError("artifact_clone_verification_failed")
        if os.path.samefile(source, temporary):
            raise ArtifactError("artifact_clone_mutation_isolation_failed")
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def _load_manifest(path: Path) -> dict:
    if not path.exists():
        return {"schema_version": 1, "artifacts": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactError(f"artifact_manifest_unreadable:{path}:{exc}") from exc
    if not isinstance(payload.get("artifacts"), list):
        raise ArtifactError("artifact_manifest_invalid")
    return payload


def _workspace_relative(root: Path, path: Path) -> str:
    if not _inside(root, path):
        raise ArtifactError("path_outside_workbench_blocked")
    return str(path.relative_to(root))


def _task_root_for_file(projects_root: Path, path: Path) -> Path:
    if not _inside(projects_root, path):
        raise ArtifactError("task_file_outside_project_workspace")
    relative = path.relative_to(projects_root)
    if not relative.parts:
        raise ArtifactError("task_root_missing")
    return projects_root / relative.parts[0]


def _load_task_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema": "workbench-task-manifest-v2", "schema_version": 2, "files": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactError(f"task_manifest_unreadable:{path}:{exc}") from exc
    if not isinstance(payload.get("files"), list):
        raise ArtifactError("task_manifest_invalid")
    return payload


def _record_task_file_promotion(
    *,
    contract: dict,
    task_root: Path,
    source: Path,
    destination: Path,
    source_hash: str,
    storage_mode: str,
    promoted_at: str,
) -> None:
    """Retire the old active path while retaining an auditable promotion event."""
    root: Path = contract["workspace_root"]
    manifest_path = task_root / "task_manifest.json"
    manifest = _load_task_manifest(manifest_path)
    source_relative = _workspace_relative(root, source)
    destination_relative = _workspace_relative(root, destination)
    source_records = [
        item for item in manifest["files"] if item.get("path") == source_relative
    ]
    manifest["files"] = [
        item for item in manifest["files"] if item.get("path") != source_relative
    ]
    events = manifest.setdefault("lifecycle_events", [])
    if not isinstance(events, list):
        raise ArtifactError("task_manifest_lifecycle_events_invalid")
    event = {
        "event_type": "promoted",
        "from_path": source_relative,
        "to_path": destination_relative,
        "sha256": source_hash,
        "storage_mode": storage_mode,
        "source_record_count": len(source_records),
        "occurred_at": promoted_at,
    }
    stable_keys = ("event_type", "from_path", "to_path", "sha256")
    if not any(
        all(item.get(key) == event[key] for key in stable_keys)
        for item in events
        if isinstance(item, dict)
    ):
        events.append(event)
    manifest["updated_at"] = promoted_at
    _atomic_json(manifest_path, manifest)


def _upsert_task_file(
    *,
    contract: dict,
    file_path: Path,
    task_id: str,
    project_name: str,
    lifecycle_status: str,
    protection_level: str,
    cleanup_status: str,
    rebuildable: bool,
    origin_step: str,
    category: str,
    related_final: str = "",
    rebuild_recipe: str = "",
    validation_command: str = "",
    task_root: Path | None = None,
    original_path: Path | None = None,
    retained_source_path: Path | None = None,
    retained_source_sha256: str = "",
    source_mutation_isolated: bool = False,
    storage_mode: str = "registered_in_place",
    source_retained: bool = True,
) -> dict[str, Any]:
    root: Path = contract["workspace_root"]
    projects_root: Path = contract["paths"]["projects"]
    if lifecycle_status not in ALL_LIFECYCLES:
        raise ArtifactError(f"unsupported_lifecycle_status:{lifecycle_status}")
    if lifecycle_status in CANDIDATE_LIFECYCLES:
        if not rebuildable or cleanup_status != "candidate" or not rebuild_recipe.strip():
            raise ArtifactError("cleanable_candidate_requires_rebuild_proof")
        if protection_level == "protected":
            raise ArtifactError("cleanable_candidate_cannot_be_protected")
    else:
        if cleanup_status == "candidate":
            raise ArtifactError("non_candidate_lifecycle_cannot_be_cleanable")
    if lifecycle_status in PROTECTED_LIFECYCLES and protection_level != "protected":
        raise ArtifactError("protected_lifecycle_requires_protected_level")

    path = file_path.expanduser().resolve()
    if not path.exists() or not path.is_file():
        raise ArtifactError(f"task_file_missing:{path}")
    if task_root is None:
        task_root = _task_root_for_file(projects_root, path)
    else:
        task_root = task_root.expanduser().resolve()
        if not task_root.is_dir() or not _inside(projects_root, task_root):
            raise ArtifactError("task_root_outside_project_workspace")
        if not _inside(root, path):
            raise ArtifactError("registered_file_outside_workbench")
    manifest_path = task_root / "task_manifest.json"
    manifest = _load_task_manifest(manifest_path)
    record = {
        "path": _workspace_relative(root, path),
        "task_id": _safe_name(task_id, "TASK"),
        "project_name": _safe_name(project_name, "未命名项目"),
        "display_name": path.name,
        "category": category,
        "lifecycle_status": lifecycle_status,
        "origin_step": origin_step,
        "protection_level": protection_level,
        "cleanup_status": cleanup_status,
        "rebuildable": rebuildable,
        "rebuild_recipe": rebuild_recipe,
        "validation_command": validation_command,
        "related_final": related_final,
        "size_bytes": path.stat().st_size,
        "sha256": _sha256(path),
        "registered_at": datetime.now().astimezone().isoformat(),
        "storage_mode": storage_mode,
        "source_retained": source_retained,
    }
    if original_path is not None:
        original = original_path.expanduser().resolve()
        if not _inside(root, original):
            raise ArtifactError("original_path_outside_workbench")
        record["original_path"] = _workspace_relative(root, original)
    if retained_source_path is not None:
        retained = retained_source_path.expanduser().resolve()
        if not retained.is_file():
            raise ArtifactError("retained_source_missing_during_registration")
        record["retained_source_path"] = str(retained)
        record["retained_source_sha256_at_publish"] = retained_source_sha256
        record["source_mutation_isolated"] = source_mutation_isolated
    existing = next(
        (item for item in manifest["files"] if item.get("path") == record["path"]),
        None,
    )
    if existing is None:
        manifest["files"].append(record)
    else:
        existing.clear()
        existing.update(record)
    manifest.update(
        {
            "schema": "workbench-task-manifest-v2",
            "schema_version": 2,
            "task_id": record["task_id"],
            "project_name": record["project_name"],
            "task_root": _workspace_relative(root, task_root),
            "updated_at": record["registered_at"],
            "cleanup_policy": {
                "automatic_cleanup_allowed": False,
                "exact_plan_and_user_phrase_required": True,
                "unknown_files_are_protected": True,
            },
        }
    )
    _atomic_json(manifest_path, manifest)
    return {"manifest_path": str(manifest_path), "record": record}


def register(args: argparse.Namespace) -> dict:
    contract = resolve_workbench_paths(args.workbench, create=False)
    result = _upsert_task_file(
        contract=contract,
        file_path=Path(args.file),
        task_id=args.task_id,
        project_name=args.project_name,
        lifecycle_status=args.lifecycle_status,
        protection_level=args.protection_level,
        cleanup_status=args.cleanup_status,
        rebuildable=args.rebuildable,
        origin_step=args.origin_step,
        category=args.category,
        related_final=args.related_final or "",
        rebuild_recipe=args.rebuild_recipe or "",
        validation_command=args.validation_command or "",
    )
    return {
        "status": "registered",
        "task_manifest": result["manifest_path"],
        "file": result["record"],
        "cleanup_executed": False,
    }


def _delivery_markdown(payload: dict) -> str:
    lines = [
        "# 最终成果",
        "",
        f"任务：{payload.get('project_name', '')} / {payload.get('task_id', '')}",
        "",
        "以下文件已经通过成果发布校验，可用于继续制作或外部平台上传：",
        "",
    ]
    for item in payload.get("artifacts", []):
        lines.append(f"- [{item['display_name']}]({item['file_name']})")
    lines.extend(
        [
            "",
            "说明：本目录保存正式成果；普通单体成果不会在项目区永久保留第二份。"
            "必须保留项目源文件的成果采用独立写时复制快照，后续修改源文件不会改动已发布版本。",
            "",
        ]
    )
    return "\n".join(lines)


def publish(args: argparse.Namespace) -> dict:
    contract = resolve_workbench_paths(args.workbench, create=False)
    root: Path = contract["workspace_root"]
    source_input = Path(args.source).expanduser()
    if source_input.is_symlink():
        raise ArtifactError("source_symlink_blocked")
    source = source_input.resolve()
    if not source.is_file():
        raise ArtifactError(f"source_file_missing:{source}")
    publication_mode = getattr(args, "publication_mode", "copy")
    if publication_mode not in {"copy", "promote", "retain-cow"}:
        raise ArtifactError("unsupported_publication_mode")
    retained_mode = publication_mode == "retain-cow"
    task_root_value = getattr(args, "task_root", None)
    retained_project_root_value = getattr(args, "retained_project_root", None)
    retained_source_role = getattr(args, "retained_source_role", None)
    if retained_mode:
        if not task_root_value:
            raise ArtifactError("retained_source_task_root_required")
        if not retained_project_root_value:
            raise ArtifactError("retained_project_root_required")
        if retained_source_role != "editable_project_export":
            raise ArtifactError("retained_source_role_invalid")
        retained_project_root_input = Path(retained_project_root_value).expanduser()
        if retained_project_root_input.is_symlink():
            raise ArtifactError("retained_project_root_symlink_blocked")
        retained_project_root = retained_project_root_input.resolve()
        if not retained_project_root.is_dir() or not _inside(
            retained_project_root, source
        ):
            raise ArtifactError("source_outside_retained_project_root")
        task_root_input = Path(task_root_value).expanduser()
        if task_root_input.is_symlink():
            raise ArtifactError("retained_source_task_root_symlink_blocked")
        task_root = task_root_input.resolve()
        if not task_root.is_dir() or not _inside(
            contract["paths"]["projects"], task_root
        ):
            raise ArtifactError("retained_source_task_root_invalid")
        if _inside(root, source) and not _inside(
            contract["paths"]["projects"], source
        ):
            raise ArtifactError("retained_source_protected_workbench_area_blocked")
        route_path = task_root / "task_route.json"
        try:
            route = json.loads(route_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ArtifactError("retained_source_task_route_unreadable") from exc
        expected_route = {
            "task_id": _safe_name(args.task_id, "TASK"),
            "project_name": _safe_name(args.project_name, "未命名项目"),
            "category": args.category,
        }
        if any(route.get(key) != value for key, value in expected_route.items()):
            raise ArtifactError("retained_source_task_route_identity_conflict")
    else:
        if task_root_value or retained_project_root_value or retained_source_role:
            raise ArtifactError("retained_source_options_require_retain_cow")
        if not _inside(root, source):
            raise ArtifactError("source_outside_workbench_blocked")
        if not _inside(contract["paths"]["projects"], source):
            raise ArtifactError("source_not_in_project_workspace_blocked")
        task_root = _task_root_for_file(contract["paths"]["projects"], source)
    linked_origin: Path | None = None
    linked_origin_value = getattr(args, "linked_origin", None)
    if linked_origin_value:
        linked_origin_input = Path(linked_origin_value).expanduser()
        if linked_origin_input.is_symlink():
            raise ArtifactError("linked_origin_symlink_blocked")
        linked_origin = linked_origin_input.resolve()
        if not linked_origin.is_file():
            raise ArtifactError("linked_origin_missing")
        if not os.path.samefile(source, linked_origin):
            raise ArtifactError("linked_origin_not_same_physical_entity")
    if retained_mode and linked_origin is not None:
        raise ArtifactError("retained_source_linked_origin_conflict")
    if args.qc_status not in PUBLISHABLE_QC:
        raise ArtifactError("qc_not_publishable")

    completed_at = (
        datetime.fromisoformat(args.completed_at)
        if args.completed_at
        else datetime.now().astimezone()
    )
    task_id = _safe_name(args.task_id, "TASK")
    project_name = _safe_name(args.project_name, "未命名项目")
    folder_name = f"{completed_at:%Y%m%d}_{project_name}_{task_id}"
    output_root: Path = contract["paths"]["outputs"]
    destination_dir = output_root / f"{completed_at:%Y-%m}" / folder_name

    source_hash = _sha256(source)
    requested_name = args.display_name or source.name
    requested = Path(requested_name)
    suffix = requested.suffix or source.suffix
    safe_stem = _safe_name(requested.stem or source.stem, "最终成果")
    destination, idempotent = _next_available_path(
        destination_dir / f"{safe_stem}{suffix}", source_hash
    )
    manifest_path = destination_dir / "artifact_manifest.json"
    manifest = _load_manifest(manifest_path)
    artifact_id = args.artifact_id or f"{task_id}-{source_hash[:12]}"
    existing = next(
        (item for item in manifest["artifacts"] if item.get("artifact_id") == artifact_id),
        None,
    )
    if existing is not None and existing.get("sha256") != source_hash:
        raise ArtifactError("artifact_id_collision_different_content")
    if retained_mode and idempotent:
        if (
            existing is None
            or existing.get("storage_mode") != "copy_on_write_clone_retained"
            or existing.get("source_path") != str(source)
        ):
            raise ArtifactError("retained_source_idempotency_provenance_mismatch")
    if not idempotent:
        if publication_mode == "promote":
            _move_verified(source, destination, source_hash)
        elif retained_mode:
            _clone_verified(source, destination, source_hash)
        else:
            _copy_verified(source, destination, source_hash)
    elif publication_mode == "promote" and source != destination:
        raise ArtifactError("single_entity_duplicate_source_requires_exact_cleanup_plan")

    record = {
        "artifact_id": artifact_id,
        "task_id": task_id,
        "project_name": project_name,
        "display_name": destination.name,
        "file_name": destination.name,
        "source_path": str(source),
        "published_path": str(destination),
        "origin_step": args.origin_step,
        "category": args.category,
        "lifecycle_status": "final",
        "protection_level": "protected",
        "cleanup_status": "keep",
        "rebuildable": False,
        "qc_status": args.qc_status,
        "size_bytes": destination.stat().st_size,
        "sha256": source_hash,
        "published_at": completed_at.isoformat(),
        "storage_mode": (
            "single_entity_hardlink_promoted"
            if publication_mode == "promote" and linked_origin is not None
            else "single_entity_promoted"
            if publication_mode == "promote"
            else "copy_on_write_clone_retained"
            if retained_mode
            else "verified_copy"
        ),
        "source_retained": publication_mode != "promote",
        "physical_entity_shared": linked_origin is not None,
        "payload_blocks_shared_at_publish": retained_mode,
        "source_mutation_isolated": retained_mode,
        "linked_origin_path": str(linked_origin) if linked_origin else None,
        "linked_origin_retained": bool(linked_origin and linked_origin.is_file()),
        "duplicate_payload_bytes": (
            False
            if linked_origin is not None or retained_mode
            else publication_mode != "promote"
        ),
    }
    if existing is None:
        manifest["artifacts"].append(record)

    manifest.update(
        {
            "schema_version": 1,
            "task_id": task_id,
            "project_name": project_name,
            "workspace_layout": contract["layout_id"],
            "updated_at": completed_at.isoformat(),
        }
    )
    _atomic_json(manifest_path, manifest)
    _atomic_text(destination_dir / "交付说明.md", _delivery_markdown(manifest))
    if publication_mode == "promote":
        _record_task_file_promotion(
            contract=contract,
            task_root=task_root,
            source=source,
            destination=destination,
            source_hash=source_hash,
            storage_mode=record["storage_mode"],
            promoted_at=completed_at.isoformat(),
        )
    task_registration = _upsert_task_file(
        contract=contract,
        file_path=destination if publication_mode in {"promote", "retain-cow"} else source,
        task_id=task_id,
        project_name=project_name,
        lifecycle_status="final",
        protection_level="protected",
        cleanup_status="keep",
        rebuildable=False,
        origin_step=args.origin_step,
        category=args.category,
        related_final=str(destination),
        task_root=task_root,
        original_path=source if publication_mode == "promote" else None,
        retained_source_path=source if retained_mode else None,
        retained_source_sha256=source_hash if retained_mode else "",
        source_mutation_isolated=retained_mode,
        storage_mode=record["storage_mode"],
        source_retained=record["source_retained"],
    )

    result = {
        "status": "published",
        "idempotent": idempotent,
        "layout_id": contract["layout_id"],
        "artifact_id": artifact_id,
        "published_path": str(destination),
        "result_folder": str(destination_dir),
        "artifact_manifest": str(manifest_path),
        "task_manifest": task_registration["manifest_path"],
        "size_bytes": destination.stat().st_size,
        "sha256": source_hash,
        "storage_mode": record["storage_mode"],
        "source_retained": record["source_retained"],
        "physical_entity_shared": record["physical_entity_shared"],
        "payload_blocks_shared_at_publish": record["payload_blocks_shared_at_publish"],
        "source_mutation_isolated": record["source_mutation_isolated"],
        "linked_origin_path": record["linked_origin_path"],
        "linked_origin_retained": record["linked_origin_retained"],
        "duplicate_payload_bytes": record["duplicate_payload_bytes"],
    }
    if args.receipt:
        receipt = Path(args.receipt).expanduser().resolve()
        if not _inside(root, receipt):
            raise ArtifactError("receipt_outside_workbench_blocked")
        if receipt.exists():
            raise ArtifactError("receipt_exists_no_overwrite")
        _atomic_json(receipt, result)
    return result


def _bundle_file_records(root: Path) -> list[dict[str, Any]]:
    records = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ArtifactError(f"bundle_symlink_blocked:{path}")
        if not path.is_file():
            continue
        relative = str(path.relative_to(root))
        if relative == "workbench_bundle_manifest.json":
            raise ArtifactError("bundle_reserved_manifest_name_conflict")
        records.append(
            {
                "path": relative,
                "size_bytes": path.stat().st_size,
                "sha256": _sha256(path),
            }
        )
    if not records:
        raise ArtifactError("bundle_has_no_files")
    return records


def _bundle_directories(root: Path) -> list[str]:
    directories = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ArtifactError(f"bundle_symlink_blocked:{path}")
        if path.is_dir():
            directories.append(str(path.relative_to(root)))
    return directories


def _bundle_digest(
    records: list[dict[str, Any]],
    directories: list[str],
) -> str:
    payload = json.dumps(
        {"files": records, "directories": directories},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _next_bundle_destination(base: Path, bundle_hash: str) -> tuple[Path, bool]:
    for version in range(1, 1000):
        candidate = base if version == 1 else base.with_name(f"{base.name}_v{version:02d}")
        manifest_path = candidate / "workbench_bundle_manifest.json"
        if not candidate.exists():
            return candidate, False
        if manifest_path.is_file():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError):
                manifest = {}
            if manifest.get("bundle_sha256") == bundle_hash:
                return candidate, True
    raise ArtifactError("bundle_version_limit_reached")


def _register_bundle_in_task(
    *,
    contract: dict,
    source_dir: Path,
    destination: Path,
    args: argparse.Namespace,
    records: list[dict[str, Any]],
    directories: list[str],
    bundle_hash: str,
    task_root: Path,
    source_retained: bool,
) -> Path:
    root: Path = contract["workspace_root"]
    manifest_path = task_root / "task_manifest.json"
    manifest = _load_task_manifest(manifest_path)
    published_at = datetime.now().astimezone().isoformat()
    base_bundle_id = _safe_name(args.bundle_id or bundle_hash[:16], bundle_hash[:16])
    record = {
        "bundle_id": base_bundle_id,
        "task_id": _safe_name(args.task_id, "TASK"),
        "project_name": _safe_name(args.project_name, "未命名项目"),
        "category": args.category,
        "target_kind": args.target_kind,
        "source_path": _workspace_relative(root, source_dir),
        "published_path": _workspace_relative(root, destination),
        "file_count": len(records),
        "directory_count": len(directories),
        "size_bytes": sum(item["size_bytes"] for item in records),
        "bundle_sha256": bundle_hash,
        "protection_level": "protected",
        "cleanup_status": "keep",
        "published_at": published_at,
        "storage_mode": (
            "single_entity_promoted" if not source_retained else "verified_copy"
        ),
        "source_retained": source_retained,
    }
    bundles = manifest.setdefault("bundles", [])
    existing = next(
        (
            item
            for item in bundles
            if item.get("bundle_id") == record["bundle_id"]
        ),
        None,
    )
    if existing and existing.get("bundle_sha256") != bundle_hash:
        for version in range(2, 1000):
            versioned_id = _safe_name(f"{base_bundle_id}_v{version:02d}", base_bundle_id)
            candidate = next(
                (item for item in bundles if item.get("bundle_id") == versioned_id),
                None,
            )
            if candidate is None or candidate.get("bundle_sha256") == bundle_hash:
                record["bundle_id"] = versioned_id
                existing = candidate
                break
        else:
            raise ArtifactError("bundle_manifest_version_limit_reached")
    if existing is None:
        bundles.append(record)
    else:
        existing.clear()
        existing.update(record)
    manifest.update(
        {
            "schema": "workbench-task-manifest-v2",
            "schema_version": 2,
            "task_id": record["task_id"],
            "project_name": record["project_name"],
            "task_root": _workspace_relative(root, task_root),
            "updated_at": published_at,
            "cleanup_policy": {
                "automatic_cleanup_allowed": False,
                "exact_plan_and_user_phrase_required": True,
                "unknown_files_are_protected": True,
            },
        }
    )
    _atomic_json(manifest_path, manifest)
    return manifest_path


def publish_bundle(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    contract = resolve_workbench_paths(args.workbench, create=False)
    root: Path = contract["workspace_root"]
    source_dir = Path(args.source_dir).expanduser().resolve()
    if not source_dir.is_dir():
        raise ArtifactError(f"bundle_source_missing:{source_dir}")
    if not _inside(contract["paths"]["projects"], source_dir):
        raise ArtifactError("bundle_source_outside_project_workspace")
    task_root = _task_root_for_file(contract["paths"]["projects"], source_dir)
    publication_mode = getattr(args, "publication_mode", "copy")
    if publication_mode not in {"copy", "promote"}:
        raise ArtifactError("unsupported_bundle_publication_mode")
    records = _bundle_file_records(source_dir)
    directories = _bundle_directories(source_dir)
    bundle_hash = _bundle_digest(records, directories)
    completed_at = (
        datetime.fromisoformat(args.completed_at)
        if args.completed_at
        else datetime.now().astimezone()
    )
    display_name = _safe_name(args.display_name, "未命名任务包")
    project_name = _safe_name(args.project_name, "未命名项目")
    task_id = _safe_name(args.task_id, "TASK")
    if args.target_kind == "external_task_pack":
        target_root = contract["paths"]["external_packs"]
        base = (
            target_root
            / f"{completed_at:%Y-%m}"
            / f"{completed_at:%Y%m%d}_{project_name}_{task_id}"
            / display_name
        )
    else:
        target_root = contract["paths"]["social_library"]
        base = target_root / f"{completed_at:%Y-%m}" / display_name
    destination, idempotent = _next_bundle_destination(base, bundle_hash)
    manifest_path = destination / "workbench_bundle_manifest.json"
    if not idempotent:
        destination.parent.mkdir(parents=True, exist_ok=True)
        bundle_manifest = {
                "schema": "workbench-bundle-manifest-v1",
                "schema_version": 1,
                "bundle_id": _safe_name(
                    args.bundle_id or bundle_hash[:16],
                    bundle_hash[:16],
                ),
                "task_id": task_id,
                "project_name": project_name,
                "category": args.category,
                "target_kind": args.target_kind,
                "display_name": display_name,
                "source_path": _workspace_relative(root, source_dir),
                "published_path": _workspace_relative(root, destination),
                "file_count": len(records),
                "directory_count": len(directories),
                "size_bytes": sum(item["size_bytes"] for item in records),
                "bundle_sha256": bundle_hash,
                "files": records,
                "directories": directories,
                "protection_level": "protected",
                "cleanup_status": "keep",
                "published_at": completed_at.isoformat(),
                "storage_mode": (
                    "single_entity_promoted"
                    if publication_mode == "promote"
                    else "verified_copy"
                ),
                "source_retained": publication_mode != "promote",
            }
        if publication_mode == "promote":
            if source_dir.stat().st_dev != destination.parent.stat().st_dev:
                raise ArtifactError("single_entity_cross_volume_move_blocked")
            os.replace(source_dir, destination)
            try:
                if (
                    _bundle_digest(
                        _bundle_file_records(destination),
                        _bundle_directories(destination),
                    )
                    != bundle_hash
                ):
                    raise ArtifactError("bundle_move_verification_failed")
                _atomic_json(destination / "workbench_bundle_manifest.json", bundle_manifest)
            except Exception:
                if destination.exists() and not source_dir.exists():
                    os.replace(destination, source_dir)
                raise
        else:
            temporary = Path(
                tempfile.mkdtemp(
                    prefix=f".{destination.name}.publishing-",
                    dir=destination.parent,
                )
            )
            try:
                for relative_dir in directories:
                    (temporary / relative_dir).mkdir(parents=True, exist_ok=True)
                for record in records:
                    source = source_dir / record["path"]
                    target = temporary / record["path"]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                copied_records = _bundle_file_records(temporary)
                copied_directories = _bundle_directories(temporary)
                if _bundle_digest(copied_records, copied_directories) != bundle_hash:
                    raise ArtifactError("bundle_copy_verification_failed")
                _atomic_json(temporary / "workbench_bundle_manifest.json", bundle_manifest)
                os.replace(temporary, destination)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
    elif publication_mode == "promote":
        raise ArtifactError("single_entity_duplicate_bundle_requires_exact_cleanup_plan")
    task_manifest = _register_bundle_in_task(
        contract=contract,
        source_dir=source_dir,
        destination=destination,
        args=args,
        records=records,
        directories=directories,
        bundle_hash=bundle_hash,
        task_root=task_root,
        source_retained=publication_mode != "promote",
    )
    return {
        "status": "published",
        "idempotent": idempotent,
        "target_kind": args.target_kind,
        "published_path": str(destination),
        "bundle_manifest": str(manifest_path),
        "task_manifest": str(task_manifest),
        "file_count": len(records),
        "directory_count": len(directories),
        "size_bytes": sum(item["size_bytes"] for item in records),
        "bundle_sha256": bundle_hash,
        "elapsed_seconds": round(time.perf_counter() - started, 6),
        "additional_llm_calls": 0,
        "storage_mode": (
            "single_entity_promoted" if publication_mode == "promote" else "verified_copy"
        ),
        "source_retained": publication_mode != "promote",
    }


def publish_customer_package(args: argparse.Namespace) -> dict:
    """Move one validated customer ZIP from an isolated stage to its sole home."""
    contract = resolve_workbench_paths(args.workbench, create=False)
    root: Path = contract["workspace_root"]
    source = Path(args.source).expanduser().resolve()
    staging_root = Path(args.staging_root).expanduser().resolve()
    if not source.is_file() or source.is_symlink() or source.suffix.lower() != ".zip":
        raise ArtifactError("customer_package_source_must_be_zip")
    if not staging_root.is_dir() or not _inside(staging_root, source):
        raise ArtifactError("customer_package_source_outside_registered_stage")
    requested = Path(args.display_name or source.name)
    if requested.suffix.lower() != ".zip":
        raise ArtifactError("customer_package_display_name_must_end_zip")
    safe_name = _safe_name(requested.stem, "客户升级包") + ".zip"
    destination = contract["paths"]["customer_packages"] / safe_name
    source_hash = _sha256(source)
    if destination.exists():
        if destination.is_file() and _sha256(destination) == source_hash:
            raise ArtifactError(
                "customer_package_duplicate_stage_requires_exact_cleanup_plan"
            )
        raise ArtifactError("customer_package_name_collision_use_new_version")
    _move_verified(source, destination, source_hash)
    with zipfile.ZipFile(destination) as handle:
        bad = handle.testzip()
        if bad is not None:
            os.replace(destination, source)
            raise ArtifactError(f"customer_package_zip_check_failed:{bad}")
        files = [item for item in handle.infolist() if not item.is_dir()]
        if not files:
            os.replace(destination, source)
            raise ArtifactError("customer_package_zip_empty")
        roots = {Path(item.filename).parts[0] for item in files if Path(item.filename).parts}
        if len(roots) != 1:
            os.replace(destination, source)
            raise ArtifactError("customer_package_zip_requires_single_root")
    return {
        "schema": "workbench-customer-package-publication-v3",
        "status": "published",
        "idempotent": False,
        "storage_mode": "single_entity_promoted",
        "source_retained": False,
        "published_path": str(destination),
        "workspace_relative_path": _workspace_relative(root, destination),
        "size_bytes": destination.stat().st_size,
        "sha256": source_hash,
        "zip_file_count": len(files),
        "zip_root": next(iter(roots)),
        "additional_llm_calls": 0,
    }


def collect_bundle_return(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    contract = resolve_workbench_paths(args.workbench, create=False)
    root: Path = contract["workspace_root"]
    projects_root: Path = contract["paths"]["projects"]
    task_root = Path(args.task_root).expanduser().resolve()
    if not task_root.is_dir() or not _inside(projects_root, task_root):
        raise ArtifactError("bundle_return_task_root_outside_project_workspace")
    manifest_path = task_root / "task_manifest.json"
    manifest = _load_task_manifest(manifest_path)
    bundle = next(
        (
            item
            for item in manifest.get("bundles", [])
            if item.get("bundle_id") == args.bundle_id
        ),
        None,
    )
    if bundle is None:
        raise ArtifactError("bundle_return_bundle_id_not_found")
    if bundle.get("target_kind") != "external_task_pack":
        raise ArtifactError("bundle_return_only_external_task_pack_supported")
    published_raw = bundle.get("published_path")
    if not isinstance(published_raw, str):
        raise ArtifactError("bundle_return_published_path_missing")
    published = (root / published_raw).resolve()
    if not published.is_dir() or not _inside(contract["paths"]["external_packs"], published):
        raise ArtifactError("bundle_return_published_path_invalid")

    return_relative = Path(args.return_dir_name)
    if (
        return_relative.is_absolute()
        or ".." in return_relative.parts
        or not return_relative.parts
    ):
        raise ArtifactError("bundle_return_directory_name_unsafe")
    return_dir = (published / return_relative).resolve()
    if not _inside(published, return_dir):
        raise ArtifactError("bundle_return_directory_outside_bundle")
    if not return_dir.is_dir() or return_dir.is_symlink():
        raise ArtifactError("bundle_return_directory_missing_or_symlink")

    collection_mode = getattr(args, "collection_mode", "copy")
    if collection_mode not in {"copy", "move"}:
        raise ArtifactError("unsupported_collection_mode")
    return_marker = return_dir / "回收记录_无需操作.json"
    source_files = []
    for path in sorted(return_dir.rglob("*")):
        if path.is_symlink():
            raise ArtifactError(f"bundle_return_symlink_blocked:{path}")
        if path.is_file() and path.name not in {".DS_Store", return_marker.name}:
            if path.stat().st_size == 0:
                raise ArtifactError(f"bundle_return_empty_file_blocked:{path}")
            source_files.append(path)
    if not source_files:
        if bundle.get("return_status") == "collected_needs_review":
            receipt_path = (
                task_root
                / "05_交付记录"
                / f"bundle_return_{_safe_name(args.bundle_id, 'BUNDLE')}.json"
            )
            if receipt_path.is_file():
                previous = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
                return {**previous, "idempotent": True, "receipt": str(receipt_path)}
        raise ArtifactError("bundle_return_empty")

    safe_bundle_id = _safe_name(args.bundle_id, "BUNDLE")
    collected_root = task_root / "03_预览候选" / "外部回填" / safe_bundle_id
    collected = []
    project_name = str(bundle.get("project_name") or "未命名项目")
    task_id = str(bundle.get("task_id") or "TASK")
    category = str(bundle.get("category") or "external_return")
    for source in source_files:
        relative = source.relative_to(return_dir)
        source_hash = _sha256(source)
        destination, idempotent = _next_available_path(
            collected_root / relative,
            source_hash,
        )
        if not idempotent:
            if collection_mode == "move":
                _move_verified(source, destination, source_hash)
            else:
                _copy_verified(source, destination, source_hash)
        registration = _upsert_task_file(
            contract=contract,
            file_path=destination,
            task_id=task_id,
            project_name=project_name,
            lifecycle_status="intermediate",
            protection_level="review",
            cleanup_status="keep",
            rebuildable=False,
            origin_step="external_bundle_return_collect",
            category=category,
            related_final="",
        )
        collected.append(
            {
                "source_path": _workspace_relative(root, source),
                "collected_path": _workspace_relative(root, destination),
                "size_bytes": destination.stat().st_size,
                "sha256": source_hash,
                "idempotent": idempotent,
                "source_moved": collection_mode == "move" and not idempotent,
                "task_manifest": registration["manifest_path"],
            }
        )

    manifest = _load_task_manifest(manifest_path)
    bundle = next(
        item
        for item in manifest.get("bundles", [])
        if item.get("bundle_id") == args.bundle_id
    )
    collected_at = datetime.now().astimezone().isoformat()
    bundle.update(
        {
            "return_status": "collected_needs_review",
            "return_directory": _workspace_relative(root, return_dir),
            "collected_root": _workspace_relative(root, collected_root),
            "return_file_count": len(collected),
            "return_files": collected,
            "collected_at": collected_at,
        }
    )
    manifest["updated_at"] = collected_at
    _atomic_json(manifest_path, manifest)
    receipt = {
        "schema": "workbench-bundle-return-receipt-v1",
        "schema_version": 1,
        "status": "collected_needs_review",
        "bundle_id": args.bundle_id,
        "task_root": _workspace_relative(root, task_root),
        "return_directory": _workspace_relative(root, return_dir),
        "collected_root": _workspace_relative(root, collected_root),
        "file_count": len(collected),
        "files": collected,
        "source_files_moved": collection_mode == "move",
        "storage_mode": (
            "single_entity_collected" if collection_mode == "move" else "verified_copy"
        ),
        "qc_status": "needs_review",
        "published_as_final": False,
        "elapsed_seconds": round(time.perf_counter() - started, 6),
        "full_workbench_scan": False,
        "additional_llm_calls": 0,
        "collected_at": collected_at,
    }
    receipt_path = (
        task_root
        / "05_交付记录"
        / f"bundle_return_{safe_bundle_id}.json"
    )
    _atomic_json(receipt_path, receipt)
    if collection_mode == "move":
        _atomic_json(
            return_marker,
            {
                "status": "results_collected_to_project_for_review",
                "bundle_id": args.bundle_id,
                "collected_root": _workspace_relative(root, collected_root),
                "file_count": len(collected),
                "collected_at": collected_at,
            },
        )
    _upsert_task_file(
        contract=contract,
        file_path=receipt_path,
        task_id=task_id,
        project_name=project_name,
        lifecycle_status="evidence",
        protection_level="protected",
        cleanup_status="keep",
        rebuildable=False,
        origin_step="external_bundle_return_receipt",
        category=category,
        related_final="",
    )
    return {**receipt, "receipt": str(receipt_path), "task_manifest": str(manifest_path)}


def close_task(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    contract = resolve_workbench_paths(args.workbench, create=False)
    root: Path = contract["workspace_root"]
    projects_root: Path = contract["paths"]["projects"]
    task_root = Path(args.task_root).expanduser().resolve()
    if not task_root.is_dir() or not _inside(projects_root, task_root):
        raise ArtifactError("task_close_root_outside_project_workspace")
    route_path = task_root / "task_route.json"
    if not route_path.is_file():
        raise ArtifactError("task_close_route_receipt_missing")
    manifest_path = task_root / "task_manifest.json"
    manifest = _load_task_manifest(manifest_path)
    registered = set()
    missing_registered = []
    for item in manifest.get("files", []):
        raw = item.get("path")
        if not isinstance(raw, str):
            continue
        path = Path(raw)
        if not path.is_absolute():
            path = root / path
        path = path.expanduser().resolve()
        registered.add(path)
        if not path.is_file():
            missing_registered.append(str(path))

    covered_bundle_roots = []
    missing_bundles = []
    for item in manifest.get("bundles", []):
        source_raw = item.get("source_path")
        published_raw = item.get("published_path")
        if isinstance(source_raw, str):
            source = (root / source_raw).resolve()
            if _inside(task_root, source):
                covered_bundle_roots.append(source)
        if isinstance(published_raw, str):
            published = (root / published_raw).resolve()
            if not published.is_dir():
                missing_bundles.append(str(published))

    excluded_names = {
        "task_route.json",
        "task_manifest.json",
        "task_close_receipt.json",
        ".DS_Store",
    }
    unregistered = []
    scanned_files = 0
    for path in _iter_files((task_root,), excluded=set()):
        if path.name in excluded_names:
            continue
        scanned_files += 1
        if path in registered:
            continue
        if any(_inside(bundle_root, path) for bundle_root in covered_bundle_roots):
            continue
        unregistered.append(str(path))

    delivery_count = len(manifest.get("files", [])) + len(manifest.get("bundles", []))
    reasons = []
    if unregistered:
        reasons.append("unregistered_task_files")
    if missing_registered:
        reasons.append("registered_files_missing")
    if missing_bundles:
        reasons.append("published_bundles_missing")
    if args.expected_output == "file" and not manifest.get("files"):
        reasons.append("expected_registered_file_missing")
    if args.expected_output == "bundle" and not manifest.get("bundles"):
        reasons.append("expected_published_bundle_missing")
    if args.expected_output == "any" and delivery_count == 0:
        reasons.append("expected_delivery_missing")

    status = "closed" if not reasons else "blocked"
    receipt = {
        "schema": "workbench-task-close-v1",
        "schema_version": 1,
        "status": status,
        "task_root": _workspace_relative(root, task_root),
        "expected_output": args.expected_output,
        "scanned_files": scanned_files,
        "registered_files": len(manifest.get("files", [])),
        "published_bundles": len(manifest.get("bundles", [])),
        "unregistered_files": unregistered,
        "missing_registered_files": missing_registered,
        "missing_published_bundles": missing_bundles,
        "blocking_reasons": reasons,
        "elapsed_seconds": round(time.perf_counter() - started, 6),
        "full_workbench_scan": False,
        "file_content_rehashed": False,
        "additional_llm_calls": 0,
        "closed_at": datetime.now().astimezone().isoformat(),
    }
    receipt_path = task_root / "05_交付记录" / "task_close_receipt.json"
    _atomic_json(receipt_path, receipt)
    return {**receipt, "receipt": str(receipt_path)}


def init_project(args: argparse.Namespace) -> dict:
    contract = discover_workbench_paths(
        args.workbench or None,
        start=args.start or None,
    )
    root: Path = contract["workspace_root"]
    task_id = _safe_name(args.task_id, "TASK")
    project_name = _safe_name(args.project_name, "未命名项目")
    created_at = datetime.now().astimezone()
    folder_name = f"{created_at:%Y%m%d}_{project_name}_{task_id}"
    task_root = contract["paths"]["projects"] / folder_name
    route_path = task_root / "task_route.json"

    if task_root.exists() and any(task_root.iterdir()) and not route_path.is_file():
        raise ArtifactError("project_route_collision_manual_review_required")

    directories = {
        "source_dir": task_root / "01_原始素材",
        "intermediate_dir": task_root / "06_中间文件",
        "final_dir": task_root / "07_final",
        "work_dir": task_root / "work",
    }
    for path in directories.values():
        path.mkdir(parents=True, exist_ok=True)

    receipt = {
        "schema": "workbench-task-route-v1",
        "status": "ready",
        "route_contract": "artifact_route_contract_v1",
        "workspace_root": str(root),
        "layout_id": contract["layout_id"],
        "discovery_source": contract.get("discovery_source"),
        "task_id": task_id,
        "project_name": project_name,
        "category": args.category,
        "task_root": str(task_root),
        **{key: str(value) for key, value in directories.items()},
        "artifact_tool": str(Path(__file__).resolve()),
        "created_at": created_at.isoformat(),
    }
    idempotent = False
    if route_path.exists():
        existing = json.loads(route_path.read_text(encoding="utf-8-sig"))
        stable_keys = ("route_contract", "workspace_root", "task_id", "project_name", "category")
        if any(existing.get(key) != receipt.get(key) for key in stable_keys):
            raise ArtifactError("project_route_identity_conflict")
        receipt = existing
        idempotent = True
    else:
        _atomic_json(route_path, receipt)
    return {
        **receipt,
        "route_receipt": str(route_path),
        "idempotent": idempotent,
        "cleanup_executed": False,
    }


def _load_registered_files(projects_root: Path, workspace_root: Path) -> dict[str, dict]:
    registered: dict[str, dict] = {}
    if not projects_root.exists():
        return registered
    for manifest_path in projects_root.rglob("task_manifest.json"):
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        for item in payload.get("files", []):
            raw_path = item.get("path")
            if not isinstance(raw_path, str):
                continue
            path = Path(raw_path)
            if not path.is_absolute():
                path = workspace_root / path
            resolved = path.expanduser().resolve()
            if _inside(workspace_root, resolved):
                registered[str(resolved)] = item
    return registered


def _iter_files(roots: Iterable[Path], excluded: set[Path]) -> Iterable[Path]:
    for root in roots:
        if not root.exists():
            continue
        for current, dirs, files in os.walk(root, followlinks=False):
            current_path = Path(current).resolve()
            dirs[:] = [
                name
                for name in dirs
                if (current_path / name).resolve() not in excluded
                and not (current_path / name).is_symlink()
            ]
            for name in files:
                path = current_path / name
                if not path.is_symlink() and path.is_file():
                    yield path.resolve()


def _classification(
    path: Path,
    *,
    inbox_root: Path,
    outputs_root: Path,
    external_packs_root: Path,
    social_library_root: Path,
    customer_packages_root: Path,
    registered: dict[str, dict],
) -> tuple[str, str]:
    if _inside(outputs_root, path):
        return "protected", "final_output_center"
    if _inside(inbox_root, path):
        return "protected", "source_inbox"
    if _inside(external_packs_root, path):
        return "protected", "external_task_pack"
    if _inside(social_library_root, path):
        return "protected", "social_source_library"
    if _inside(customer_packages_root, path):
        return "protected", "customer_package_center"
    item = registered.get(str(path))
    if not item:
        return "unknown_protected", "unregistered_file"
    lifecycle = str(item.get("lifecycle_status") or "")
    protection = str(item.get("protection_level") or "")
    rebuildable = bool(item.get("rebuildable"))
    cleanup_status = str(item.get("cleanup_status") or "")
    if lifecycle in PROTECTED_LIFECYCLES or protection == "protected":
        return "protected", f"registered:{lifecycle or protection}"
    if (
        lifecycle in CANDIDATE_LIFECYCLES
        and rebuildable
        and cleanup_status == "candidate"
    ):
        return "candidate", f"registered:{lifecycle}"
    return "unknown_protected", "registered_but_not_explicitly_cleanable"


def inventory(args: argparse.Namespace) -> dict:
    contract = resolve_workbench_paths(args.workbench, create=False)
    root: Path = contract["workspace_root"]
    paths = contract["paths"]
    registered = _load_registered_files(paths["projects"], root)
    excluded = {paths["backups"].resolve()}
    scan_roots = (
        paths["inbox"],
        paths["projects"],
        paths["outputs"],
        paths["external_packs"],
        paths["social_library"],
        paths["customer_packages"],
    )
    entries = []
    totals = {
        "protected": {"files": 0, "bytes": 0},
        "candidate": {"files": 0, "bytes": 0},
        "unknown_protected": {"files": 0, "bytes": 0},
    }
    for path in _iter_files(scan_roots, excluded):
        status, reason = _classification(
            path,
            inbox_root=paths["inbox"],
            outputs_root=paths["outputs"],
            external_packs_root=paths["external_packs"],
            social_library_root=paths["social_library"],
            customer_packages_root=paths["customer_packages"],
            registered=registered,
        )
        size = path.stat().st_size
        totals[status]["files"] += 1
        totals[status]["bytes"] += size
        entries.append(
            {
                "path": str(path),
                "workspace_relative_path": str(path.relative_to(root)),
                "size_bytes": size,
                "classification": status,
                "reason": reason,
            }
        )

    report = {
        "schema_version": 1,
        "status": "inventory_complete_no_files_changed",
        "generated_at": datetime.now().astimezone().isoformat(),
        "workspace_root": str(root),
        "layout_id": contract["layout_id"],
        "scan_scope": [str(item) for item in scan_roots],
        "excluded": [str(item) for item in excluded],
        "totals": totals,
        "entries": entries,
        "cleanup_executed": False,
        "policy": "unknown_and_unregistered_files_are_protected",
    }
    if args.json_out:
        json_out = Path(args.json_out).expanduser().resolve()
        if not _inside(root, json_out):
            raise ArtifactError("inventory_report_outside_workbench_blocked")
        _atomic_json(json_out, report)
    if args.markdown_out:
        markdown_out = Path(args.markdown_out).expanduser().resolve()
        if not _inside(root, markdown_out):
            raise ArtifactError("inventory_report_outside_workbench_blocked")
        markdown = [
            "# 工作台空间盘点",
            "",
            "本次只做盘点，没有移动或删除任何文件。",
            "",
            f"- 明确保留：{totals['protected']['files']} 个文件，{totals['protected']['bytes']} 字节",
            f"- 可清理候选：{totals['candidate']['files']} 个文件，{totals['candidate']['bytes']} 字节",
            f"- 无法判断并保护：{totals['unknown_protected']['files']} 个文件，{totals['unknown_protected']['bytes']} 字节",
            "",
            "没有明确登记为可重建候选的文件，不会进入清理范围。",
            "",
        ]
        _atomic_text(markdown_out, "\n".join(markdown))
    return report


def _reverse_symlinks(root: Path, candidate: Path) -> list[str]:
    hits: list[str] = []
    resolved_candidate = candidate.resolve(strict=False)
    for current, dirs, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        kept_dirs: list[str] = []
        for name in dirs:
            path = current_path / name
            if path.is_symlink():
                targets = [(path, os.readlink(path))]
            else:
                kept_dirs.append(name)
                targets = []
            for link, raw_target in targets:
                if _inside(candidate, link.absolute()):
                    continue
                target = Path(raw_target)
                if not target.is_absolute():
                    target = link.parent / target
                resolved_target = target.resolve(strict=False)
                if resolved_target == resolved_candidate or _inside(
                    resolved_candidate, resolved_target
                ):
                    hits.append(str(link))
        dirs[:] = kept_dirs
        for name in files:
            link = current_path / name
            if not link.is_symlink():
                continue
            if _inside(candidate, link.absolute()):
                continue
            raw_target = os.readlink(link)
            target = Path(raw_target)
            if not target.is_absolute():
                target = link.parent / target
            resolved_target = target.resolve(strict=False)
            if resolved_target == resolved_candidate or _inside(
                resolved_candidate, resolved_target
            ):
                hits.append(str(link))
    return sorted(set(hits))


def _file_identity(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        return {
            "kind": "symlink",
            "target": os.readlink(path),
            "exists": path.exists(),
        }
    if not path.is_file():
        return {"kind": "missing", "exists": False}
    stat = path.stat()
    return {
        "kind": "file",
        "exists": True,
        "size_bytes": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "sha256": _sha256(path),
    }


def _workbench_health(contract: dict) -> dict[str, Any]:
    paths = contract["paths"]
    skill_files = []
    skills_root: Path = paths["skills_backup"]
    if skills_root.is_dir():
        for skill_file in sorted(skills_root.rglob("SKILL.md")):
            if skill_file.is_file() and not skill_file.is_symlink():
                skill_files.append(
                    {
                        "path": str(skill_file),
                        "sha256": _sha256(skill_file),
                    }
                )
    task_manifests = []
    projects_root: Path = paths["projects"]
    if projects_root.is_dir():
        for manifest in sorted(projects_root.rglob("task_manifest.json")):
            if manifest.is_file() and not manifest.is_symlink():
                task_manifests.append(
                    {
                        "path": str(manifest),
                        "sha256": _sha256(manifest),
                    }
                )
    broken_symlinks = []
    root: Path = contract["workspace_root"]
    for current, dirs, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        kept_dirs: list[str] = []
        for name in dirs:
            path = current_path / name
            if path.is_symlink():
                if not path.exists():
                    broken_symlinks.append(
                        {"path": str(path), "target": os.readlink(path)}
                    )
            else:
                kept_dirs.append(name)
        dirs[:] = kept_dirs
        for name in files:
            path = current_path / name
            if path.is_symlink() and not path.exists():
                broken_symlinks.append(
                    {"path": str(path), "target": os.readlink(path)}
                )
    return {
        "protected_roots": {
            key: {"path": str(paths[key]), "exists": paths[key].exists()}
            for key in sorted(PROTECTED_ROOT_KEYS)
        },
        "skill_files": skill_files,
        "task_manifests": task_manifests,
        "broken_symlinks": sorted(broken_symlinks, key=lambda item: item["path"]),
    }


def _plan_hash(payload: dict[str, Any]) -> str:
    excluded = {"plan_id", "plan_hash", "approval_phrase", "created_at"}
    canonical = {key: value for key, value in payload.items() if key not in excluded}
    encoded = json.dumps(
        canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def cleanup_plan(args: argparse.Namespace) -> dict:
    contract = resolve_workbench_paths(args.workbench, create=False)
    root: Path = contract["workspace_root"]
    report = inventory(
        argparse.Namespace(workbench=str(root), json_out=None, markdown_out=None)
    )
    candidates = {
        item["path"]: item
        for item in report["entries"]
        if item["classification"] == "candidate"
    }
    requested = [str(Path(raw).expanduser().resolve()) for raw in args.candidate]
    if args.all_candidates:
        requested.extend(sorted(candidates))
    requested = sorted(set(requested))
    if not requested:
        raise ArtifactError("cleanup_plan_requires_explicit_candidates")
    unknown = [path for path in requested if path not in candidates]
    if unknown:
        raise ArtifactError("cleanup_candidate_not_eligible:" + ",".join(unknown))

    items = []
    for raw in requested:
        path = Path(raw)
        links = _reverse_symlinks(root, path)
        items.append(
            {
                "path": str(path),
                "workspace_relative_path": _workspace_relative(root, path),
                "classification": "candidate",
                "reason": candidates[raw]["reason"],
                "identity": _file_identity(path),
                "reverse_symlinks": links,
                "gate_status": "blocked" if links else "eligible_for_exact_approval",
                "proposed_action": "move_to_trash_after_validation",
                "recovery": "restore_from_system_trash_before_it_is_emptied",
            }
        )
    payload: dict[str, Any] = {
        "schema": "workbench-cleanup-plan-v2",
        "created_at": datetime.now().astimezone().isoformat(),
        "workspace_root": str(root),
        "layout_id": contract["layout_id"],
        "status": (
            "blocked"
            if any(item["gate_status"] == "blocked" for item in items)
            else "awaiting_exact_user_approval"
        ),
        "items": items,
        "baseline": _workbench_health(contract),
        "policy": {
            "broad_approval_is_invalid": True,
            "plan_or_file_change_invalidates_approval": True,
            "unknown_and_protected_files_are_excluded": True,
            "destructive_action_in_this_command": False,
            "post_action_health_check_required": True,
            "never_empty_trash_automatically": True,
        },
    }
    plan_hash = _plan_hash(payload)
    payload["plan_hash"] = plan_hash
    payload["plan_id"] = plan_hash[:12]
    payload["approval_phrase"] = (
        f"同意执行工作台清理计划 {payload['plan_id']}"
    )
    output = Path(args.output).expanduser().resolve()
    if not _inside(root, output):
        raise ArtifactError("cleanup_plan_output_outside_workbench_blocked")
    if output.exists():
        raise ArtifactError("cleanup_plan_output_exists_no_overwrite")
    _atomic_json(output, payload)
    return {**payload, "plan_path": str(output), "cleanup_executed": False}


def cleanup_verify(args: argparse.Namespace) -> dict:
    plan_path = Path(args.plan).expanduser().resolve()
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactError(f"cleanup_plan_unreadable:{plan_path}:{exc}") from exc
    if plan.get("plan_hash") != _plan_hash(plan):
        raise ArtifactError("cleanup_plan_hash_mismatch")
    contract = resolve_workbench_paths(plan.get("workspace_root", ""), create=False)
    root: Path = contract["workspace_root"]
    if not _inside(root, plan_path):
        raise ArtifactError("cleanup_plan_outside_workbench_blocked")
    reasons = []
    if plan.get("status") != "awaiting_exact_user_approval":
        reasons.append(f"plan_not_ready={plan.get('status')}")
    if args.approval_text != plan.get("approval_phrase"):
        reasons.append("exact_approval_phrase_mismatch")
    evidence = []
    for item in plan.get("items", []):
        path = Path(item["path"])
        identity_matches = _file_identity(path) == item.get("identity")
        links = _reverse_symlinks(root, path)
        if not identity_matches:
            reasons.append(f"candidate_changed:{path}")
        if links:
            reasons.append(f"reverse_symlink_dependency:{path}")
        evidence.append(
            {
                "path": str(path),
                "identity_matches": identity_matches,
                "reverse_symlinks": links,
            }
        )
    health_matches = _workbench_health(contract) == plan.get("baseline")
    if not health_matches:
        reasons.append("workbench_health_changed_since_plan")
    receipt = {
        "schema": "workbench-cleanup-verification-v2",
        "plan_id": plan.get("plan_id"),
        "plan_hash": plan.get("plan_hash"),
        "verified_at": datetime.now().astimezone().isoformat(),
        "status": "ready_for_exact_action" if not reasons else "blocked",
        "blocking_reasons": reasons,
        "evidence": evidence,
        "workbench_health_matches": health_matches,
        "approval_text_matched": args.approval_text == plan.get("approval_phrase"),
        "cleanup_executed": False,
    }
    if args.output:
        output = Path(args.output).expanduser().resolve()
        if not _inside(root, output):
            raise ArtifactError("cleanup_verification_output_outside_workbench_blocked")
        if output.exists():
            raise ArtifactError("cleanup_verification_output_exists_no_overwrite")
        _atomic_json(output, receipt)
    return receipt


def cleanup_postcheck(args: argparse.Namespace) -> dict:
    plan_path = Path(args.plan).expanduser().resolve()
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactError(f"cleanup_plan_unreadable:{plan_path}:{exc}") from exc
    if plan.get("plan_hash") != _plan_hash(plan):
        raise ArtifactError("cleanup_plan_hash_mismatch")
    contract = resolve_workbench_paths(plan.get("workspace_root", ""), create=False)
    root: Path = contract["workspace_root"]
    if not _inside(root, plan_path):
        raise ArtifactError("cleanup_plan_outside_workbench_blocked")
    reasons = []
    presence = {}
    for item in plan.get("items", []):
        path = Path(item["path"])
        exists = path.exists() or path.is_symlink()
        presence[str(path)] = exists
    if args.expect == "absent" and any(presence.values()):
        reasons.append("candidate_still_present")
    if args.expect == "present" and not all(presence.values()):
        reasons.append("candidate_missing_restore_required")
    current_health = _workbench_health(contract)
    if current_health != plan.get("baseline"):
        reasons.append("workbench_health_regression_restore_required")
    receipt = {
        "schema": "workbench-cleanup-postcheck-v2",
        "plan_id": plan.get("plan_id"),
        "plan_hash": plan.get("plan_hash"),
        "checked_at": datetime.now().astimezone().isoformat(),
        "status": "pass" if not reasons else "fail_restore_required",
        "blocking_reasons": reasons,
        "candidate_presence": presence,
        "workbench_health_matches": current_health == plan.get("baseline"),
    }
    if args.output:
        output = Path(args.output).expanduser().resolve()
        if not _inside(root, output):
            raise ArtifactError("cleanup_postcheck_output_outside_workbench_blocked")
        if output.exists():
            raise ArtifactError("cleanup_postcheck_output_exists_no_overwrite")
        _atomic_json(output, receipt)
    return receipt


def resolve(args: argparse.Namespace) -> dict:
    return serializable_contract(
        resolve_workbench_paths(
            args.workbench,
            create=args.create,
            preferred_layout="zh_visible_v2",
        )
    )


def discover(args: argparse.Namespace) -> dict:
    return serializable_contract(
        discover_workbench_paths(
            args.workbench or None,
            start=args.start or None,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI 内容工作台成果与空间工具")
    subparsers = parser.add_subparsers(dest="command", required=True)

    path_parser = subparsers.add_parser("resolve", help="解析唯一工作台目录合同")
    path_parser.add_argument("--workbench", required=True)
    path_parser.add_argument("--create", action="store_true")
    path_parser.set_defaults(handler=resolve)

    discover_parser = subparsers.add_parser(
        "discover", help="从普通对话只读发现正式工作台"
    )
    discover_parser.add_argument("--workbench")
    discover_parser.add_argument("--start")
    discover_parser.set_defaults(handler=discover)

    init_parser = subparsers.add_parser(
        "init-project", help="在正式工作台初始化本次任务目录"
    )
    init_parser.add_argument("--workbench")
    init_parser.add_argument("--start")
    init_parser.add_argument("--task-id", required=True)
    init_parser.add_argument("--project-name", required=True)
    init_parser.add_argument(
        "--category",
        required=True,
        help="任务类型；允许业务 Skill 使用稳定短名，不再只限图片、视频和剪辑",
    )
    init_parser.set_defaults(handler=init_project)

    publish_parser = subparsers.add_parser("publish", help="发布已经通过质检的最终成果")
    publish_parser.add_argument("--workbench", required=True)
    publish_parser.add_argument("--source", required=True)
    publish_parser.add_argument("--task-id", required=True)
    publish_parser.add_argument("--project-name", required=True)
    publish_parser.add_argument("--category", required=True)
    publish_parser.add_argument("--origin-step", required=True)
    publish_parser.add_argument("--qc-status", required=True, choices=sorted(PUBLISHABLE_QC))
    publish_parser.add_argument("--display-name")
    publish_parser.add_argument("--artifact-id")
    publish_parser.add_argument("--completed-at")
    publish_parser.add_argument("--receipt")
    publish_parser.add_argument(
        "--linked-origin",
        help="可选：与项目 source 指向同一物理实体的 image_gen 原始路径",
    )
    publish_parser.add_argument(
        "--publication-mode",
        choices=("copy", "promote", "retain-cow"),
        default="copy",
    )
    publish_parser.add_argument(
        "--task-root",
        help="retain-cow 必填：由 init-project 创建的正式工作台任务目录",
    )
    publish_parser.add_argument(
        "--retained-project-root",
        help="retain-cow 必填：必须保留源文件的当前项目根目录",
    )
    publish_parser.add_argument(
        "--retained-source-role",
        choices=("editable_project_export",),
        help="retain-cow 必填：声明来源是当前任务生成的可编辑项目导出成品",
    )
    publish_parser.set_defaults(handler=publish)

    bundle_parser = subparsers.add_parser(
        "publish-bundle",
        help="把项目内完整文件夹发布到外部任务包或社媒素材库",
    )
    bundle_parser.add_argument("--workbench", required=True)
    bundle_parser.add_argument("--source-dir", required=True)
    bundle_parser.add_argument("--task-id", required=True)
    bundle_parser.add_argument("--project-name", required=True)
    bundle_parser.add_argument("--category", required=True)
    bundle_parser.add_argument(
        "--target-kind",
        required=True,
        choices=("external_task_pack", "social_source"),
    )
    bundle_parser.add_argument("--display-name", required=True)
    bundle_parser.add_argument("--bundle-id")
    bundle_parser.add_argument("--completed-at")
    bundle_parser.add_argument(
        "--publication-mode",
        choices=("copy", "promote"),
        default="copy",
    )
    bundle_parser.set_defaults(handler=publish_bundle)

    customer_package_parser = subparsers.add_parser(
        "publish-customer-package",
        help="把隔离区中已完成构建的唯一客户 ZIP 晋升到 07_客户升级包",
    )
    customer_package_parser.add_argument("--workbench", required=True)
    customer_package_parser.add_argument("--source", required=True)
    customer_package_parser.add_argument("--staging-root", required=True)
    customer_package_parser.add_argument("--display-name")
    customer_package_parser.set_defaults(handler=publish_customer_package)

    collect_parser = subparsers.add_parser(
        "collect-bundle-return",
        help="把外部任务包回填目录中的结果回收到当前项目并登记为待质检",
    )
    collect_parser.add_argument("--workbench", required=True)
    collect_parser.add_argument("--task-root", required=True)
    collect_parser.add_argument("--bundle-id", required=True)
    collect_parser.add_argument(
        "--return-dir-name",
        default="04_生成结果_放这里",
    )
    collect_parser.add_argument(
        "--collection-mode",
        choices=("copy", "move"),
        default="copy",
    )
    collect_parser.set_defaults(handler=collect_bundle_return)

    register_parser = subparsers.add_parser(
        "register", help="把任务文件身份写入 task_manifest.json"
    )
    register_parser.add_argument("--workbench", required=True)
    register_parser.add_argument("--file", required=True)
    register_parser.add_argument("--task-id", required=True)
    register_parser.add_argument("--project-name", required=True)
    register_parser.add_argument("--category", required=True)
    register_parser.add_argument("--origin-step", required=True)
    register_parser.add_argument(
        "--lifecycle-status", required=True, choices=sorted(ALL_LIFECYCLES)
    )
    register_parser.add_argument(
        "--protection-level", required=True, choices=("protected", "review", "ordinary")
    )
    register_parser.add_argument(
        "--cleanup-status", required=True, choices=("keep", "candidate", "unknown")
    )
    register_parser.add_argument("--rebuildable", action="store_true")
    register_parser.add_argument("--rebuild-recipe")
    register_parser.add_argument("--validation-command")
    register_parser.add_argument("--related-final")
    register_parser.set_defaults(handler=register)

    close_parser = subparsers.add_parser(
        "close-task",
        help="只核对当前任务文件是否全部登记，不扫描整个工作台",
    )
    close_parser.add_argument("--workbench", required=True)
    close_parser.add_argument("--task-root", required=True)
    close_parser.add_argument(
        "--expected-output",
        choices=("none", "file", "bundle", "any"),
        default="any",
    )
    close_parser.set_defaults(handler=close_task)

    inventory_parser = subparsers.add_parser("inventory", help="只读盘点工作台文件")
    inventory_parser.add_argument("--workbench", required=True)
    inventory_parser.add_argument("--json-out")
    inventory_parser.add_argument("--markdown-out")
    inventory_parser.set_defaults(handler=inventory)

    plan_parser = subparsers.add_parser(
        "cleanup-plan", help="冻结精确清理计划；不移动、不删除"
    )
    plan_parser.add_argument("--workbench", required=True)
    plan_parser.add_argument("--candidate", action="append", default=[])
    plan_parser.add_argument("--all-candidates", action="store_true")
    plan_parser.add_argument("--output", required=True)
    plan_parser.set_defaults(handler=cleanup_plan)

    verify_parser = subparsers.add_parser(
        "cleanup-verify", help="核对计划和用户确认语；不移动、不删除"
    )
    verify_parser.add_argument("--plan", required=True)
    verify_parser.add_argument("--approval-text", required=True)
    verify_parser.add_argument("--output")
    verify_parser.set_defaults(handler=cleanup_verify)

    postcheck_parser = subparsers.add_parser(
        "cleanup-postcheck", help="清理动作后检查工作台健康；不移动、不删除"
    )
    postcheck_parser.add_argument("--plan", required=True)
    postcheck_parser.add_argument("--expect", choices=("present", "absent"), required=True)
    postcheck_parser.add_argument("--output")
    postcheck_parser.set_defaults(handler=cleanup_postcheck)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = args.handler(args)
    except (ArtifactError, WorkbenchPathError, OSError) as exc:
        print(
            json.dumps({"status": "blocked", "reason": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
