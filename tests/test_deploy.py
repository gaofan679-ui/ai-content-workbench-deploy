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
    def test_optional_caption_component_is_visible_but_does_not_block_base_install(self):
        module = deploy
        with mock.patch.object(module, "resolve_required_tool", return_value={"status": "pass", "path": "/test"}):
            report = module.environment_report(
                {
                    "dependency_profile": "full",
                    "required_tools": ["python_runtime"],
                    "optional_local_components": {
                        "caption_alignment": {
                            "delivery_status": "configured_after_install",
                            "first_model_download_gb": 1.2,
                            "external_uploads": 0,
                            "paid_calls": 0,
                        }
                    },
                }
            )
        self.assertEqual(report["status"], "ready")
        self.assertEqual(
            report["optional_local_components"]["caption_alignment"]["status"],
            "setup_required_after_install",
        )
        self.assertFalse(report["optional_local_components"]["caption_alignment"]["blocking_for_base_install"])

    def test_windows_bootstrap_capability_is_read_only_and_available_with_winget(self):
        with mock.patch.object(deploy.shutil, "which", return_value="C:/Windows/winget.exe"):
            capability = deploy.dependency_bootstrap_capability("windows", ["node", "npm", "ffmpeg"])
        self.assertEqual(capability["status"], "available")
        self.assertEqual(capability["method"], "winget_official_packages")
        self.assertEqual(capability["missing"], ["node", "npm", "ffmpeg"])

    def test_bootstrap_deduplicates_node_and_ffmpeg_packages(self):
        manifest = {
            "platform": "windows",
            "required_tools": ["node", "npm", "ffmpeg", "ffprobe"],
        }
        environment = {
            "status": "blocked",
            "missing_required": ["node", "npm", "ffmpeg", "ffprobe"],
            "bootstrap": {
                "status": "available",
                "installer": "C:/Windows/winget.exe",
                "method": "winget_official_packages",
            },
        }
        with mock.patch.object(deploy, "_run_dependency_install", return_value=[0]) as runner, \
             mock.patch.object(deploy, "refresh_process_path"), \
             mock.patch.object(
                 deploy,
                 "environment_report",
                 return_value={"status": "ready", "missing_required": [], "bootstrap": {"status": "not_needed"}},
             ):
            result = deploy.bootstrap_missing_dependencies(manifest, environment)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["attempted_tools"], ["Node.js", "ffmpeg"])
        self.assertEqual(runner.call_count, 2)

    def test_bootstrap_stops_when_official_installer_is_unavailable(self):
        manifest = {"platform": "windows", "required_tools": ["ffmpeg"]}
        environment = {
            "status": "blocked",
            "missing_required": ["ffmpeg"],
            "bootstrap": {"status": "installer_unavailable", "missing": ["ffmpeg"]},
        }
        with self.assertRaises(deploy.DeploymentError):
            deploy.bootstrap_missing_dependencies(manifest, environment)

    def test_customer_summary_promises_auto_repair_only_when_supported(self):
        summary = deploy.customer_summary(
            {"platform": "windows", "version": "1.5.3"},
            {"install_mode": "first_install"},
            {
                "status": "blocked",
                "missing_required": ["python_runtime", "ffmpeg"],
                "bootstrap": {"status": "available"},
                "optional_local_components": {},
            },
            phase="inspect",
        )
        self.assertIn("自动补齐", summary["当前结论"])
        self.assertEqual(summary["还需要你做什么"][0], "明确回复“同意执行”")
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

    def test_ticket_with_short_remaining_window_is_not_used_for_bootstrap(self) -> None:
        ticket = self.ticket()
        ticket["expires_at"] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).isoformat()
        with self.assertRaises(deploy.DeploymentError):
            deploy.ensure_ticket_time_window(ticket)

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

    def test_github_source_has_immutable_jsdelivr_alternative(self) -> None:
        source = "https://raw.githubusercontent.com/owner/repo/workbench-v1.5.3-pilot.3/releases/v1.5.3/windows-first-install.json"
        self.assertEqual(
            deploy.public_source_alternatives(source)[1],
            "https://cdn.jsdelivr.net/gh/owner/repo@workbench-v1.5.3-pilot.3/releases/v1.5.3/windows-first-install.json",
        )

    def test_fetch_bytes_tries_public_mirror_after_direct_and_curl_fail(self) -> None:
        source = "https://raw.githubusercontent.com/owner/repo/workbench-v1.5.3-pilot.3/README.md"
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return None

            def read(self):
                return b"mirror"

        with mock.patch.object(
            deploy.urllib.request, "urlopen", side_effect=[OSError("blocked"), Response()]
        ), mock.patch.object(
            deploy, "curl_fetch_bytes", side_effect=deploy.DeploymentError("blocked")
        ):
            self.assertEqual(deploy.fetch_bytes(source), b"mirror")

    def test_windows_browser_fallback_reads_ticket_after_direct_https_failure(self) -> None:
        with mock.patch.object(deploy, "is_windows_host", return_value=True), \
             mock.patch.object(
                 deploy.urllib.request,
                 "urlopen",
                 side_effect=OSError("TLS blocked"),
             ), \
             mock.patch.object(
                 deploy, "curl_fetch_bytes", side_effect=deploy.DeploymentError("curl blocked")
             ), \
             mock.patch.object(deploy, "browser_fetch_bytes", return_value=b'{"ok": true}'):
            self.assertEqual(deploy.fetch_bytes("https://example.invalid/ticket.json"), b'{"ok": true}')

    def test_curl_fallback_reads_ticket_before_browser(self) -> None:
        with mock.patch.object(deploy.urllib.request, "urlopen", side_effect=OSError("TLS blocked")), \
             mock.patch.object(deploy, "curl_fetch_bytes", return_value=b'{"ok": true}') as curl_fetch, \
             mock.patch.object(deploy, "browser_fetch_bytes") as browser_fetch:
            self.assertEqual(deploy.fetch_bytes("https://example.invalid/ticket.json"), b'{"ok": true}')
        curl_fetch.assert_called_once()
        browser_fetch.assert_not_called()

    def test_browser_json_output_is_normalized(self) -> None:
        output = b'<html><body>{&quot;ticket_id&quot;:&quot;demo&quot;}</body></html>'
        self.assertEqual(deploy._extract_browser_json(output), b'{"ticket_id": "demo"}')

    def test_windows_browser_fallback_downloads_package_after_direct_https_failure(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            destination = Path(name) / "package.zip"
            with mock.patch.object(deploy, "is_windows_host", return_value=True), \
             mock.patch.object(
                 deploy.urllib.request,
                 "urlopen",
                 side_effect=OSError("TLS blocked"),
             ), \
             mock.patch.object(
                 deploy, "curl_download_file", side_effect=deploy.DeploymentError("curl blocked")
             ), \
             mock.patch.object(deploy, "browser_download_file") as browser_download:
                deploy.download_package("https://example.invalid/package.zip", destination)
            browser_download.assert_called_once_with("https://example.invalid/package.zip", destination)

    def test_curl_fallback_downloads_package_before_browser(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            destination = Path(name) / "package.zip"
            with mock.patch.object(deploy.urllib.request, "urlopen", side_effect=OSError("TLS blocked")), \
                 mock.patch.object(deploy, "curl_download_file") as curl_download, \
                 mock.patch.object(deploy, "browser_download_file") as browser_download:
                deploy.download_package("https://example.invalid/package.zip", destination)
            curl_download.assert_called_once_with("https://example.invalid/package.zip", destination)
            browser_download.assert_not_called()

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
