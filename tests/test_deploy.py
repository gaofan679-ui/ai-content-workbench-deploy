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


if __name__ == "__main__":
    unittest.main()
