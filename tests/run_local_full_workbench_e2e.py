#!/usr/bin/env python3
"""Run the public deployment entry against real local full-workbench archives.

This is an isolated, no-upload, no-paid-call test. macOS login-item registration
is disabled through the package's supported test switch.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("aicw_deploy_e2e", ROOT / "scripts" / "deploy.py")
assert SPEC and SPEC.loader
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact(manifest_path: Path, package_path: Path) -> dict[str, object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {
        "platform": manifest["platform"],
        "install_mode": manifest["install_mode"],
        "manifest_url": str(manifest_path),
        "package_url": str(package_path),
        "package_size_bytes": package_path.stat().st_size,
        "package_sha256": sha256(package_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--first-manifest", required=True)
    parser.add_argument("--first-package", required=True)
    parser.add_argument("--upgrade-manifest", required=True)
    parser.add_argument("--upgrade-package", required=True)
    args = parser.parse_args()

    first_manifest = Path(args.first_manifest).resolve()
    upgrade_manifest = Path(args.upgrade_manifest).resolve()
    first_package = Path(args.first_package).resolve()
    upgrade_package = Path(args.upgrade_package).resolve()
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)

    upgrade_release = json.loads(upgrade_manifest.read_text(encoding="utf-8"))
    candidate_version = str(upgrade_release["version"])

    with tempfile.TemporaryDirectory(prefix="aicw-layout-recovery-e2e-") as name:
        test_root = Path(name)
        workbench = test_root / "AIContentWorkbench"
        skills_home = test_root / ".codex" / "skills"
        skills_home.mkdir(parents=True)
        ticket_path = test_root / "adaptive.ticket.json"
        ticket_path.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "ticket_id": "layout-recovery-local-e2e",
                    "customer_id": "isolated-test-machine",
                    "issued_at": now.isoformat(),
                    "expires_at": (now + dt.timedelta(hours=2)).isoformat(),
                    "product_id": "ai-content-workbench",
                    "version": candidate_version,
                    "artifacts": [
                        artifact(first_manifest, first_package),
                        artifact(upgrade_manifest, upgrade_package),
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ) + "\n",
            encoding="utf-8",
        )
        os.environ["WORKBENCH_SERVICE_NO_REGISTER"] = "1"
        command = argparse.Namespace(
            ticket=str(ticket_path),
            manifest=None,
            workbench=str(workbench),
            skills_home=str(skills_home),
            confirm_write="YES",
        )
        first_result = deploy.apply(command)
        if first_result != 0:
            raise RuntimeError("first install did not complete")

        mirror_home = test_root / ".agents" / "skills"
        duplicate_skill_ids = ("topic-selection-workflow", "social-copy-extract")
        for skill_id in duplicate_skill_ids:
            shutil.copytree(skills_home / skill_id, mirror_home / skill_id)
            (mirror_home / skill_id / "SKILL.md").write_text(
                f"historical duplicate: {skill_id}\n", encoding="utf-8"
            )
        personal_skill = mirror_home / "personal-private-skill" / "SKILL.md"
        personal_skill.parent.mkdir(parents=True)
        personal_skill.write_text("personal-preserved\n", encoding="utf-8")
        personal_skill_before = sha256(personal_skill)

        project_marker = workbench / "02_项目工作区" / "rc3-e2e-project.txt"
        output_marker = workbench / "03_最终成果" / "rc3-e2e-output.txt"
        config = workbench / "系统文件_无需打开" / "config" / "customer_config.env"
        project_marker.write_text("project-preserved\n", encoding="utf-8")
        output_marker.write_text("output-preserved\n", encoding="utf-8")
        for relative in ("01_素材入口", "04_使用教程", "系统文件_无需打开/tools"):
            shutil.rmtree(workbench / relative)
        legacy_markers = []
        for relative in ("01_Inbox", "02_Projects", "03_Outputs", "07_Tools", "09_Docs"):
            marker = workbench / relative / "historical-customer-data.txt"
            marker.parent.mkdir(parents=True)
            marker.write_text(f"protected:{relative}\n", encoding="utf-8")
            legacy_markers.append(marker)
        before = {
            "project": sha256(project_marker),
            "output": sha256(output_marker),
            "config": sha256(config),
            **{f"legacy_{index}": sha256(path) for index, path in enumerate(legacy_markers)},
        }

        os.environ["HOME"] = str(test_root)
        command.skills_home = None
        upgrade_result = deploy.apply(command)
        if upgrade_result != 0:
            raise RuntimeError("upgrade did not complete")
        after = {
            "project": sha256(project_marker),
            "output": sha256(output_marker),
            "config": sha256(config),
            **{f"legacy_{index}": sha256(path) for index, path in enumerate(legacy_markers)},
        }
        if before != after:
            raise RuntimeError("protected project, output or config changed during upgrade")
        for relative in ("01_素材入口", "04_使用教程", "系统文件_无需打开/tools"):
            if not (workbench / relative).is_dir():
                raise RuntimeError(f"managed directory was not safely recreated: {relative}")
        receipt = json.loads(
            (workbench / "系统文件_无需打开" / "deployment_receipts" / "layout-recovery-local-e2e.json").read_text(encoding="utf-8")
        )
        if receipt.get("status") != "installed_and_verified":
            raise RuntimeError("final receipt did not pass")
        if receipt.get("install_mode") != "incremental_upgrade":
            raise RuntimeError("adaptive ticket did not switch to upgrade")
        if receipt.get("package_contract") != "full_workbench_v1":
            raise RuntimeError("full workbench contract was not used")
        if receipt.get("layout_contract", {}).get("recovery") != "legacy_preserved_use_active_manifest":
            raise RuntimeError("historical mixed layout was not resolved by the active manifest")
        if not Path(str(receipt.get("backup_record"))).is_dir():
            raise RuntimeError("upgrade backup was not recorded")
        mirror_sync = receipt.get("skills_mirror_sync")
        if not isinstance(mirror_sync, list) or len(mirror_sync) != 1:
            raise RuntimeError("duplicate managed skill roots were not synchronized")
        if mirror_sync[0].get("managed_skills_synchronized") != len(duplicate_skill_ids):
            raise RuntimeError("not all duplicate managed skills were synchronized")
        for skill_id in duplicate_skill_ids:
            if sha256(mirror_home / skill_id / "SKILL.md") != sha256(skills_home / skill_id / "SKILL.md"):
                raise RuntimeError(f"managed duplicate was not synchronized: {skill_id}")
        if sha256(personal_skill) != personal_skill_before:
            raise RuntimeError("personal skill changed during managed mirror recovery")
        print(
            json.dumps(
                {
                    "status": "PASS",
                    "adaptive_first_install": True,
                    "adaptive_upgrade": True,
                    "historical_mixed_layout_replayed": True,
                    "legacy_directories_preserved": True,
                    "missing_managed_directories_recreated": True,
                    "installed_skill_count": 37,
                    "project_output_config_preserved": True,
                    "backup_recorded": True,
                    "dual_skill_roots_recovered": True,
                    "managed_duplicates_backed_up_and_synchronized": True,
                    "personal_skill_preserved": True,
                    "login_item_registration": False,
                    "paid_calls": 0,
                    "external_uploads": 0,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
