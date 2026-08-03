from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("aicw_deploy", ROOT / "scripts" / "deploy.py")
assert SPEC and SPEC.loader
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
    def ticket(self) -> dict:
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        platform_name = deploy.platform_name()
        if platform_name not in {"macos", "windows"}:
            platform_name = "macos"
        return {
            "schema_version": 1,
            "ticket_id": "test-ticket-0001",
            "customer_id": "test-machine",
            "issued_at": now.isoformat(),
            "expires_at": (now + dt.timedelta(hours=1)).isoformat(),
            "product_id": "ai-content-workbench",
            "version": "1.4.2",
            "platform": platform_name,
            "install_mode": "incremental_upgrade",
            "manifest_url": "https://example.invalid/manifest.json",
            "package_url": "https://example.invalid/package.zip?secret=redacted",
            "package_size_bytes": 123,
            "package_sha256": "a" * 64,
        }

    def test_valid_ticket(self) -> None:
        ticket = self.ticket()
        with mock.patch.object(deploy, "platform_name", return_value=ticket["platform"]):
            deploy.validate_ticket(ticket)

    def test_expired_ticket_is_blocked(self) -> None:
        ticket = self.ticket()
        ticket["issued_at"] = "2020-01-01T00:00:00+00:00"
        ticket["expires_at"] = "2020-01-01T01:00:00+00:00"
        with self.assertRaises(deploy.DeploymentError):
            deploy.validate_ticket(ticket)

    def test_manifest_mismatch_is_blocked(self) -> None:
        ticket = self.ticket()
        manifest = {
            "schema_version": 1,
            "product_id": "ai-content-workbench",
            "module_id": "workbench-cumulative-update",
            "version": "1.4.1",
            "release_tag": "test",
            "release_id": "test",
            "channel": "pilot",
            "status": "single_machine_candidate_not_batch_release",
            "platform": ticket["platform"],
            "install_mode": "incremental_upgrade",
            "package_file_name": "test.zip",
            "package_root": "root",
            "package_subdir": "system",
            "package_size_bytes": 123,
            "package_sha256": "a" * 64,
        }
        with self.assertRaises(deploy.DeploymentError):
            deploy.validate_manifest(manifest, ticket)

    def test_zip_traversal_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            archive = root / "bad.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../escape.txt", "bad")
            with self.assertRaises(deploy.DeploymentError):
                deploy.safe_extract(archive, root / "out")

    def test_redacted_url_drops_query(self) -> None:
        self.assertEqual(
            deploy.redacted_location("https://files.example/a.zip?signature=secret"),
            "https://files.example/a.zip",
        )

    def test_empty_environment_selects_first_install(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            result = deploy.detect_install_context(
                str(root / "AIContentWorkbench"), str(root / ".codex" / "skills")
            )
            self.assertEqual(result["install_mode"], "first_install")

    def test_managed_environment_selects_upgrade(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            skills = root / ".codex" / "skills"
            (workbench / "系统文件_无需打开").mkdir(parents=True)
            managed = skills / "customer-workbench-deployer"
            managed.mkdir(parents=True)
            (managed / "SKILL.md").write_text("managed", encoding="utf-8")
            result = deploy.detect_install_context(str(workbench), str(skills))
            self.assertEqual(result["install_mode"], "incremental_upgrade")

    def test_partial_environment_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            skills = root / ".codex" / "skills" / "customer-workbench-deployer"
            skills.mkdir(parents=True)
            (skills / "SKILL.md").write_text("managed", encoding="utf-8")
            with self.assertRaises(deploy.DeploymentError):
                deploy.detect_install_context(
                    str(root / "AIContentWorkbench"), str(root / ".codex" / "skills")
                )

    def test_bundle_ticket_selects_platform_and_mode(self) -> None:
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        artifacts = []
        for platform_name in ("macos", "windows"):
            for mode in ("first_install", "incremental_upgrade"):
                artifacts.append(
                    {
                        "platform": platform_name,
                        "install_mode": mode,
                        "manifest_url": "https://example.invalid/manifest.json",
                        "package_url": "https://example.invalid/package.zip?secret=redacted",
                        "package_size_bytes": 123,
                        "package_sha256": "a" * 64,
                    }
                )
        ticket = {
            "schema_version": 2,
            "ticket_id": "bundle-ticket-0001",
            "customer_id": "test-machine",
            "issued_at": now.isoformat(),
            "expires_at": (now + dt.timedelta(hours=1)).isoformat(),
            "product_id": "ai-content-workbench",
            "version": "1.5.1",
            "artifacts": artifacts,
        }
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            with mock.patch.object(deploy, "platform_name", return_value="macos"):
                selected, context = deploy.normalize_ticket_for_host(
                    ticket, str(root / "AIContentWorkbench"), str(root / ".codex" / "skills")
                )
            self.assertEqual(selected["platform"], "macos")
            self.assertEqual(selected["install_mode"], "first_install")
            self.assertEqual(context["selection"], "automatic_platform_and_install_state")


if __name__ == "__main__":
    unittest.main()
