from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("aicw_deploy_autopilot", ROOT / "scripts" / "deploy.py")
assert SPEC and SPEC.loader
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def ticket_and_manifest() -> tuple[dict, dict]:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    package_sha = "a" * 64
    ticket = {
        "schema_version": 1,
        "ticket_id": "autopilot-test-ticket",
        "customer_id": "test-machine",
        "issued_at": now.isoformat(),
        "expires_at": (now + dt.timedelta(hours=1)).isoformat(),
        "product_id": "ai-content-workbench",
        "version": "1.8.0-rc.2n",
        "platform": "windows",
        "install_mode": "incremental_upgrade",
        "manifest_url": "https://example.invalid/manifest.json",
        "package_url": "https://example.invalid/package.zip?secret=must-not-persist",
        "package_size_bytes": 3,
        "package_sha256": package_sha,
    }
    manifest = {
        "version": ticket["version"],
        "platform": ticket["platform"],
        "install_mode": ticket["install_mode"],
        "package_sha256": package_sha,
        "package_size_bytes": 3,
    }
    return ticket, manifest


class AutopilotTests(unittest.TestCase):
    def canonical_source_text(self, relative_path: str) -> str:
        path = ROOT.parents[1] / "AI内容工作台部署包" / relative_path
        if not path.is_file():
            self.skipTest("canonical workbench source is not part of the public deployment repository")
        return path.read_text(encoding="utf-8-sig")

    def test_rc2n_path_contamination_is_a_package_defect_not_a_retry(self) -> None:
        decision = deploy.classify_deployment_failure(
            "安装器把构建日志误作路径，随后没有返回唯一构建目录",
            platform_id="windows",
            version="1.8.0-rc.2n",
        )
        self.assertEqual(decision["rule_id"], "windows-rc2n-build-output-path-contamination")
        self.assertEqual(decision["category"], "package_defect")
        self.assertFalse(decision["safe_to_retry"])

    def test_network_failure_is_safe_for_bounded_retry(self) -> None:
        decision = deploy.classify_deployment_failure(
            "stream disconnected before completion",
            platform_id="windows",
            version="1.8.0-rc.2o",
        )
        self.assertEqual(decision["category"], "network")
        self.assertTrue(decision["safe_to_retry"])

    def test_checkpoint_contains_no_signed_url(self) -> None:
        ticket, manifest = ticket_and_manifest()
        with tempfile.TemporaryDirectory() as name, mock.patch.dict(
            deploy.os.environ, {deploy.DEPLOYER_STATE_ENV: name}
        ):
            checkpoint = deploy.write_checkpoint(
                ticket,
                manifest,
                stage="package_verified",
                status="running",
                attempts={"download": 1},
            )
            text = checkpoint.read_text(encoding="utf-8")
            self.assertNotIn("must-not-persist", text)
            self.assertNotIn("package_url", text)
            self.assertEqual(json.loads(text)["stage"], "package_verified")

    def test_verified_cache_is_reused_without_network(self) -> None:
        ticket, manifest = ticket_and_manifest()
        manifest["package_sha256"] = deploy.hashlib.sha256(b"zip").hexdigest()
        ticket["package_sha256"] = manifest["package_sha256"]
        with tempfile.TemporaryDirectory() as name, mock.patch.dict(
            deploy.os.environ, {deploy.DEPLOYER_STATE_ENV: name}
        ):
            cache = deploy.session_paths(ticket)["cache"]
            cache.parent.mkdir(parents=True)
            cache.write_bytes(b"zip")
            attempts: dict[str, int] = {}
            with mock.patch.object(deploy, "download_package") as download:
                result = deploy.acquire_verified_package(ticket, manifest, attempts)
            self.assertEqual(result, cache)
            download.assert_not_called()
            self.assertEqual(attempts["download"], 0)

    def test_download_transport_is_retried_at_most_twice(self) -> None:
        ticket, manifest = ticket_and_manifest()
        with tempfile.TemporaryDirectory() as name, mock.patch.dict(
            deploy.os.environ, {deploy.DEPLOYER_STATE_ENV: name}
        ), mock.patch.object(
            deploy, "download_package", side_effect=deploy.DeploymentError("stream disconnected")
        ) as download:
            with self.assertRaises(deploy.DeploymentError):
                deploy.acquire_verified_package(ticket, manifest, {})
            self.assertEqual(download.call_count, deploy.MAX_SAFE_RECOVERY_ATTEMPTS)

    def test_windows_installer_uses_verified_prebuilt_runtime_and_validates_one_path(self) -> None:
        installer = self.canonical_source_text("installer/Install_AI_Content_Workbench.ps1")
        self.assertIn("prebuilt\\windows-x64.tar.gz", installer)
        self.assertIn("verify-prebuilt-runtime.mjs", installer)
        self.assertNotIn("& $buildScript -WebRoot $stageWebRoot | Out-Host", installer)
        self.assertIn("$preparedCandidates.Count -ne 1", installer)
        self.assertIn("返回了无效构建目录", installer)

    def test_windows_service_activation_happens_after_installer_return(self) -> None:
        install_services = self.canonical_source_text(
            "web-workbench/service/windows/install-services.ps1"
        )
        deploy_source = (ROOT / "scripts" / "deploy.py").read_text(encoding="utf-8")
        self.assertNotIn("& $startScript -WebRoot $WebRoot -WorkbenchRoot $WorkbenchRoot", install_services)
        self.assertIn("def activate_windows_web_services", deploy_source)
        self.assertIn("post_installer_detached", deploy_source)
        self.assertIn("stdout=stdout_handle", deploy_source)
        self.assertIn("stderr=stderr_handle", deploy_source)
        self.assertIn("service_activation = activate_windows_web_services", deploy_source)
        self.assertLess(
            deploy_source.index("if result.returncode != 0:"),
            deploy_source.index("service_activation = activate_windows_web_services"),
        )

    def test_macos_shortcuts_start_services_and_open_the_web_port(self) -> None:
        installer = self.canonical_source_text("mac/tools/install_ai_content_workbench.sh")
        setup = self.canonical_source_text("mac/tools/complete_workbench_setup.sh")
        for source in (installer, setup):
            self.assertIn("workbench-service.sh", source)
            self.assertIn('"$SERVICE_SCRIPT" start', source)
            self.assertIn("http://127.0.0.1:3000", source)
            self.assertNotIn("http://127.0.0.1:4317", source)

    def test_macos_activation_barrier_precedes_module_readiness(self) -> None:
        deploy_source = (ROOT / "scripts" / "deploy.py").read_text(encoding="utf-8")
        self.assertIn("def activate_macos_web_services", deploy_source)
        self.assertEqual(
            deploy_source.count("service_activation = activate_macos_web_services(workbench)"),
            2,
        )
        self.assertIn("post_installer_launchctl_bounded_wait", deploy_source)
        self.assertEqual(deploy_source.count('"service_activation": service_activation'), 2)

    def test_fresh_install_accepts_a_not_yet_created_explicit_skill_root(self) -> None:
        deploy_source = (ROOT / "scripts" / "deploy.py").read_text(encoding="utf-8")
        self.assertIn('if mode == "incremental_upgrade" and not path.is_dir():', deploy_source)
        self.assertIn('resolve_skills_home(skills_arg, str(ticket["install_mode"]))', deploy_source)

    def test_installer_capture_uses_explicit_utf8_decoding(self) -> None:
        deploy_source = (ROOT / "scripts" / "deploy.py").read_text(encoding="utf-8")
        self.assertGreaterEqual(deploy_source.count('encoding="utf-8",\n            errors="replace",'), 4)

    def test_winget_package_install_location_is_discovered_after_bootstrap(self) -> None:
        deploy_source = (ROOT / "scripts" / "deploy.py").read_text(encoding="utf-8")
        self.assertIn('Microsoft/WinGet/Packages', deploy_source)
        self.assertIn('recursive=True', deploy_source)

    def test_windows_installer_hashing_does_not_depend_on_powershell_modules(self) -> None:
        installer = self.canonical_source_text("installer/Install_AI_Content_Workbench.ps1")
        self.assertIn("function Get-Sha256Hex", installer)
        self.assertNotIn("Get-FileHash", installer)


if __name__ == "__main__":
    unittest.main()
