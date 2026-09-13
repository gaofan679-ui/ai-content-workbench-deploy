#!/usr/bin/env python3
"""Resolve AI Content Workbench directories without renaming legacy data."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Tuple


class WorkbenchPathError(RuntimeError):
    """Raised when the workbench directory contract is unsafe or ambiguous."""


VISIBLE_ZH_LAYOUT = {
    "system": "系统文件_无需打开",
    "core_config": "系统文件_无需打开/config",
    "inbox": "01_素材入口",
    "projects": "02_项目工作区",
    "outputs": "03_最终成果",
    "external_packs": "05_外部任务包",
    "social_library": "06_社媒素材库",
    "customer_packages": "07_客户升级包",
    "queue": "系统文件_无需打开/queue",
    "logs": "系统文件_无需打开/logs",
    "backups": "系统文件_无需打开/backups",
    "tools": "系统文件_无需打开/tools",
    "skills_backup": "系统文件_无需打开/skills",
    "docs": "04_使用教程",
}

LEGACY_LAYOUT = {
    "system": ".",
    "core_config": "00_DO_NOT_DELETE_Core_Config",
    "inbox": "01_Inbox",
    "projects": "02_Projects",
    "outputs": "03_Outputs",
    "external_packs": "03_Outputs/外部任务包",
    "social_library": "01_Inbox/社媒素材库",
    "customer_packages": "03_Outputs/客户升级包",
    "queue": "04_TaskQueue",
    "logs": "05_Logs",
    "backups": "06_Backups",
    "tools": "07_Tools",
    "skills_backup": "08_Skills_Backup",
    "docs": "09_Docs",
}

BASE_REQUIRED_KEYS = (
    "system",
    "core_config",
    "inbox",
    "projects",
    "outputs",
    "queue",
    "logs",
    "backups",
    "tools",
    "skills_backup",
    "docs",
)
OPTIONAL_ARTIFACT_KEYS = ("external_packs", "social_library", "customer_packages")
REQUIRED_KEYS = BASE_REQUIRED_KEYS + OPTIONAL_ARTIFACT_KEYS
ZH_MARKERS = ("01_素材入口", "02_项目工作区", "03_最终成果", "系统文件_无需打开")
LEGACY_MARKERS = (
    "01_Inbox",
    "02_Projects",
    "03_Outputs",
    "07_Tools",
    "08_Projects_Tasks",
    "10_Output",
)


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _validated_mapping(
    root: Path,
    raw: dict,
    *,
    defaults: dict | None = None,
) -> Dict[str, Path]:
    merged = dict(defaults or {})
    merged.update(raw)
    missing = [key for key in REQUIRED_KEYS if not merged.get(key)]
    if missing:
        raise WorkbenchPathError("directory_contract_missing_keys:" + ",".join(missing))

    result: Dict[str, Path] = {}
    for key in REQUIRED_KEYS:
        value = merged[key]
        if not isinstance(value, str):
            raise WorkbenchPathError(f"directory_contract_value_not_string:{key}")
        relative = Path(value)
        if relative.is_absolute() or ".." in relative.parts:
            raise WorkbenchPathError(f"directory_contract_path_unsafe:{key}")
        resolved = (root / relative).resolve()
        if not _inside(root, resolved):
            raise WorkbenchPathError(f"directory_contract_path_outside_root:{key}")
        result[key] = resolved
    return result


def _active_manifest(root: Path) -> Tuple[Path | None, dict | None]:
    candidates = (
        root / "系统文件_无需打开" / "config" / "workbench_manifest.json",
        root / "00_DO_NOT_DELETE_Core_Config" / "workbench_manifest.json",
    )
    active = []
    for path in candidates:
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            raise WorkbenchPathError(f"workbench_manifest_unreadable:{path}:{exc}") from exc
        if (
            int(payload.get("layout_version", 0)) >= 2
            and payload.get("directory_contract_status") == "active"
        ):
            active.append((path, payload))
    if len(active) > 1:
        raise WorkbenchPathError("multiple_active_workbench_manifests")
    return active[0] if active else (None, None)


def _existing_marker_count(root: Path, markers: tuple[str, ...]) -> int:
    return sum(1 for marker in markers if (root / marker).exists())


def _legacy_mapping(root: Path) -> Dict[str, Path]:
    raw = dict(LEGACY_LAYOUT)
    if not (root / "02_Projects").exists() and (root / "08_Projects_Tasks").exists():
        raw["projects"] = "08_Projects_Tasks"
    if not (root / "03_Outputs").exists() and (root / "10_Output").exists():
        raw["outputs"] = "10_Output"
    return _validated_mapping(root, raw, defaults=LEGACY_LAYOUT)


def resolve_workbench_paths(
    workspace_root: str | Path,
    *,
    create: bool = False,
    preferred_layout: str = "zh_visible_v2",
) -> dict:
    """Return the single safe directory contract for a workbench.

    Existing legacy directories remain legacy. New empty workbenches default to
    the simplified Chinese-visible layout. If both layouts are present without a
    single active manifest, resolution stops instead of guessing.
    """

    root = Path(workspace_root).expanduser().resolve()
    if create:
        root.mkdir(parents=True, exist_ok=True)
    if not root.exists() or not root.is_dir():
        raise WorkbenchPathError(f"workbench_root_missing:{root}")

    manifest_path, manifest = _active_manifest(root)
    zh_count = _existing_marker_count(root, ZH_MARKERS)
    legacy_count = _existing_marker_count(root, LEGACY_MARKERS)

    if manifest is not None:
        paths = _validated_mapping(
            root,
            manifest.get("directories", {}),
            defaults=VISIBLE_ZH_LAYOUT,
        )
        layout_id = str(manifest.get("layout_id") or "manifest_v2")
    else:
        if zh_count and legacy_count:
            raise WorkbenchPathError("mixed_layout_conflict_manual_review_required")
        if legacy_count:
            layout_id = "legacy_v1"
            paths = _legacy_mapping(root)
        else:
            if preferred_layout != "zh_visible_v2":
                raise WorkbenchPathError(f"unsupported_preferred_layout:{preferred_layout}")
            layout_id = "zh_visible_v2"
            paths = _validated_mapping(
                root,
                VISIBLE_ZH_LAYOUT,
                defaults=VISIBLE_ZH_LAYOUT,
            )

    if create:
        for path in dict.fromkeys(paths.values()):
            path.mkdir(parents=True, exist_ok=True)

    return {
        "workspace_root": root,
        "layout_id": layout_id,
        "manifest_path": manifest_path,
        "paths": paths,
        "legacy_detected": layout_id == "legacy_v1",
        "zh_marker_count": zh_count,
        "legacy_marker_count": legacy_count,
    }


def _has_workbench_identity(contract: dict) -> bool:
    return bool(
        contract.get("manifest_path")
        or int(contract.get("zh_marker_count", 0)) >= 3
        or int(contract.get("legacy_marker_count", 0)) >= 2
    )


def discover_workbench_paths(
    workspace_root: str | Path | None = None,
    *,
    start: str | Path | None = None,
    home_root: str | Path | None = None,
) -> dict:
    """Find the formal workbench from an ordinary Codex conversation.

    Explicit configuration fails closed. Without it, search the current
    directory and its parents, then the portable default
    ``~/AIContentWorkbench``. Discovery never creates or migrates directories.
    """

    if workspace_root:
        contract = resolve_workbench_paths(workspace_root, create=False)
        if not _has_workbench_identity(contract):
            raise WorkbenchPathError("explicit_workbench_identity_missing")
        return {**contract, "discovery_source": "explicit"}

    configured = os.environ.get("AI_WORKBENCH_HOME", "").strip()
    if configured:
        contract = resolve_workbench_paths(configured, create=False)
        if not _has_workbench_identity(contract):
            raise WorkbenchPathError("configured_workbench_identity_missing")
        return {**contract, "discovery_source": "environment"}

    start_path = Path(start or Path.cwd()).expanduser().resolve()
    if start_path.is_file():
        start_path = start_path.parent
    for candidate in (start_path, *start_path.parents):
        try:
            contract = resolve_workbench_paths(candidate, create=False)
        except WorkbenchPathError:
            continue
        if _has_workbench_identity(contract):
            return {**contract, "discovery_source": "current_or_parent"}

    home = Path(home_root).expanduser().resolve() if home_root else Path.home()
    default_root = home / "AIContentWorkbench"
    try:
        contract = resolve_workbench_paths(default_root, create=False)
    except WorkbenchPathError as exc:
        raise WorkbenchPathError("formal_workbench_not_found") from exc
    if not _has_workbench_identity(contract):
        raise WorkbenchPathError("formal_workbench_not_found")
    return {**contract, "discovery_source": "home_default"}


def serializable_contract(contract: dict) -> dict:
    return {
        "workspace_root": str(contract["workspace_root"]),
        "layout_id": contract["layout_id"],
        "manifest_path": (
            str(contract["manifest_path"]) if contract.get("manifest_path") else None
        ),
        "legacy_detected": bool(contract.get("legacy_detected")),
        "discovery_source": contract.get("discovery_source"),
        "paths": {key: str(value) for key, value in contract["paths"].items()},
    }
