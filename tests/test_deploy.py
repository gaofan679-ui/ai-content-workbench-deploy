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

    def test_customer_summary_distinguishes_ready_and_configuration_pending_modules(self):
        summary = deploy.customer_summary(
            {"platform": "windows", "version": "1.8.0"},
            {"install_mode": "incremental_upgrade"},
            {"status": "ready", "optional_local_components": {}},
            phase="apply",
            module_readiness={
                "customer_modules": [
                    {"label": "网页工作台", "status": "ready"},
                    {"label": "AI 口播", "status": "configuration_required"},
                ]
            },
        )
        self.assertEqual(summary["已经可以使用"], ["网页工作台"])
        self.assertEqual(summary["配置后可以使用"], ["AI 口播"])
        self.assertIn("部分功能", summary["当前结论"])
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

    def test_verified_internal_pilot_manifest_is_installable(self) -> None:
        ticket = self.ticket()
        manifest = {
            "schema_version": 1,
            "product_id": "ai-content-workbench",
            "module_id": "workbench-full-cumulative-upgrade",
            "version": ticket["version"],
            "release_tag": "workbench-test",
            "release_id": "release-test",
            "channel": "pilot",
            "status": "verified_internal_pilot_not_batch_release",
            "platform": ticket["platform"],
            "install_mode": ticket["install_mode"],
            "package_file_name": "test.zip",
            "package_root": "test",
            "package_subdir": "系统文件_无需打开",
            "package_size_bytes": ticket["package_size_bytes"],
            "package_sha256": ticket["package_sha256"],
        }
        deploy.validate_manifest(manifest, ticket)

    def test_unknown_pilot_manifest_status_is_blocked(self) -> None:
        ticket = self.ticket()
        manifest = {
            "schema_version": 1,
            "product_id": "ai-content-workbench",
            "module_id": "workbench-full-cumulative-upgrade",
            "version": ticket["version"],
            "release_tag": "workbench-test",
            "release_id": "release-test",
            "channel": "pilot",
            "status": "new_unregistered_status",
            "platform": ticket["platform"],
            "install_mode": ticket["install_mode"],
            "package_file_name": "test.zip",
            "package_root": "test",
            "package_subdir": "系统文件_无需打开",
            "package_size_bytes": ticket["package_size_bytes"],
            "package_sha256": ticket["package_sha256"],
        }
        with self.assertRaises(deploy.DeploymentError):
            deploy.validate_manifest(manifest, ticket)

    def test_full_workbench_manifest_requires_dynamic_skill_count(self) -> None:
        ticket = self.ticket()
        manifest = {
            "schema_version": 1,
            "product_id": "ai-content-workbench",
            "module_id": "workbench-cumulative-update",
            "version": ticket["version"],
            "release_tag": "test",
            "release_id": "test",
            "channel": "pilot",
            "status": "single_machine_candidate_not_batch_release",
            "platform": ticket["platform"],
            "install_mode": ticket["install_mode"],
            "package_file_name": "test.zip",
            "package_root": "root",
            "package_subdir": "system",
            "package_size_bytes": ticket["package_size_bytes"],
            "package_sha256": ticket["package_sha256"],
            "package_contract": "full_workbench_v1",
            "payload_version": "1.6.0",
            "installed_skill_count": 37,
        }
        deploy.validate_manifest(manifest, ticket)
        manifest["installed_skill_count"] = 0
        with self.assertRaises(deploy.DeploymentError):
            deploy.validate_manifest(manifest, ticket)

    def test_full_workbench_payload_uses_package_manifest_not_module_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / "sample.txt").write_text("ok", encoding="utf-8")
            digest = deploy.sha256_file(root / "sample.txt")
            (root / "package_manifest.json").write_text(
                json.dumps(
                    {
                        "release_id": "release-test",
                        "version": "1.6.0",
                        "workflow_count": 37,
                        "checksums": {"sample.txt": digest},
                    }
                ),
                encoding="utf-8",
            )
            result = deploy.verify_full_workbench_payload(
                root,
                {
                    "release_id": "release-test",
                    "payload_version": "1.6.0",
                    "installed_skill_count": 37,
                },
            )
            self.assertEqual(result["workflow_count"], 37)
            self.assertFalse((root / "module_manifest.json").exists())

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

    def _write_active_zh_layout(self, workbench: Path) -> None:
        directories = {
            "core_config": "系统文件_无需打开/config",
            "inbox": "01_素材入口",
            "projects": "02_项目工作区",
            "outputs": "03_最终成果",
            "tools": "系统文件_无需打开/tools",
            "docs": "04_使用教程",
        }
        for relative in directories.values():
            (workbench / relative).mkdir(parents=True, exist_ok=True)
        manifest = workbench / "系统文件_无需打开" / "config" / "workbench_manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "layout_version": 2,
                    "layout_id": "zh_visible_v2",
                    "directory_contract_status": "active",
                    "directories": directories,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    def test_historical_mixed_layout_uses_unique_active_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            skills = root / ".codex" / "skills"
            self._write_active_zh_layout(workbench)
            for relative in ("01_Inbox", "02_Projects", "03_Outputs", "07_Tools"):
                (workbench / relative).mkdir(parents=True)
                (workbench / relative / "protected.txt").write_text("legacy", encoding="utf-8")
            managed = skills / "customer-workbench-deployer"
            managed.mkdir(parents=True)
            (managed / "SKILL.md").write_text("managed", encoding="utf-8")

            result = deploy.detect_install_context(str(workbench), str(skills))

            self.assertEqual(result["install_mode"], "incremental_upgrade")
            self.assertEqual(result["layout_contract"]["layout_id"], "zh_visible_v2")
            self.assertEqual(
                result["layout_contract"]["recovery"],
                "legacy_preserved_use_active_manifest",
            )

    def test_partial_historical_layout_allows_managed_directories_to_be_recreated(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            directories = {
                "core_config": "系统文件_无需打开/config",
                "inbox": "01_素材入口",
                "projects": "02_项目工作区",
                "outputs": "03_最终成果",
                "tools": "系统文件_无需打开/tools",
                "docs": "04_使用教程",
            }
            for key in ("core_config", "projects", "outputs"):
                (workbench / directories[key]).mkdir(parents=True)
            manifest = workbench / directories["core_config"] / "workbench_manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "layout_version": 2,
                        "layout_id": "zh_visible_v2",
                        "directory_contract_status": "active",
                        "directories": directories,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            for relative in ("01_Inbox", "07_Tools", "09_Docs"):
                (workbench / relative).mkdir(parents=True)

            report = deploy.inspect_workbench_layout(workbench)

            self.assertEqual(report["state"], "managed")
            self.assertEqual(report["layout_id"], "zh_visible_v2")
            self.assertEqual(report["recovery"], "legacy_preserved_use_active_manifest")

    def test_ambiguous_mixed_layout_stops_before_install_selection(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            skills = root / ".codex" / "skills" / "customer-workbench-deployer"
            (workbench / "01_Inbox").mkdir(parents=True)
            (workbench / "01_素材入口").mkdir(parents=True)
            skills.mkdir(parents=True)
            (skills / "SKILL.md").write_text("managed", encoding="utf-8")

            with self.assertRaisesRegex(deploy.DeploymentError, "下载客户包前停止"):
                deploy.detect_install_context(str(workbench), str(skills.parent))

    def test_mixed_layout_with_unsafe_manifest_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            self._write_active_zh_layout(workbench)
            (workbench / "01_Inbox").mkdir(parents=True)
            manifest = workbench / "系统文件_无需打开" / "config" / "workbench_manifest.json"
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            payload["directories"]["projects"] = "../outside"
            manifest.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            report = deploy.inspect_workbench_layout(workbench)

            self.assertEqual(report["state"], "conflict")
            self.assertEqual(report["recovery"], "manual_plan_required")
            self.assertIn("unsafe", report["reason"])

    def test_partial_environment_is_recovered_as_first_install(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            skills = root / ".codex" / "skills" / "customer-workbench-deployer"
            skills.mkdir(parents=True)
            (skills / "SKILL.md").write_text("managed", encoding="utf-8")
            result = deploy.detect_install_context(
                str(root / "AIContentWorkbench"), str(root / ".codex" / "skills")
            )
            self.assertEqual(result["install_mode"], "first_install")
            self.assertEqual(
                result["skills_recovery"],
                "backup_existing_managed_residue_and_complete_first_install",
            )

    def test_two_standard_skill_roots_select_dominant_root_and_plan_mirror_sync(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            (workbench / "系统文件_无需打开").mkdir(parents=True)
            codex_root = root / ".codex" / "skills"
            agents_root = root / ".agents" / "skills"
            for skill_name in ("topic-selection-workflow",):
                skill = codex_root / skill_name
                skill.mkdir(parents=True)
                (skill / "SKILL.md").write_text("old", encoding="utf-8")
            for skill_name in (
                "customer-workbench-deployer",
                "topic-selection-workflow",
                "social-copy-extract",
            ):
                skill = agents_root / skill_name
                skill.mkdir(parents=True)
                (skill / "SKILL.md").write_text("current", encoding="utf-8")

            with mock.patch.object(deploy.Path, "home", return_value=root):
                result = deploy.detect_install_context(None, None)

            self.assertEqual(result["install_mode"], "incremental_upgrade")
            self.assertEqual(Path(result["skills_home"]), agents_root.resolve())
            self.assertEqual(result["skills_mirrors"], [str(codex_root.resolve())])
            self.assertEqual(
                result["skills_recovery"],
                "backup_and_sync_existing_managed_duplicates",
            )

    def test_missing_skills_are_recreated_for_managed_workbench(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            (workbench / "系统文件_无需打开").mkdir(parents=True)
            with mock.patch.object(deploy.Path, "home", return_value=root):
                result = deploy.detect_install_context(None, None)
            self.assertEqual(result["install_mode"], "incremental_upgrade")
            self.assertEqual(result["skills_recovery"], "recreate_missing_managed_skills")

    def test_managed_skill_residue_is_backed_up_during_first_install(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            residue = root / ".codex" / "skills" / "topic-selection-workflow"
            residue.mkdir(parents=True)
            (residue / "SKILL.md").write_text("old", encoding="utf-8")
            with mock.patch.object(deploy.Path, "home", return_value=root):
                result = deploy.detect_install_context(None, None)
            self.assertEqual(result["install_mode"], "first_install")
            self.assertEqual(
                result["skills_recovery"],
                "backup_existing_managed_residue_and_complete_first_install",
            )

    def test_existing_duplicate_managed_skills_are_backed_up_and_synchronized(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            (workbench / "系统文件_无需打开" / "backups").mkdir(parents=True)
            source = root / "package-skills"
            primary = root / ".agents" / "skills"
            mirror = root / ".codex" / "skills"
            current = source / "topic-selection-workflow"
            current.mkdir(parents=True)
            (current / "SKILL.md").write_text("new", encoding="utf-8")
            old = mirror / "topic-selection-workflow"
            old.mkdir(parents=True)
            (old / "SKILL.md").write_text("old", encoding="utf-8")
            personal = mirror / "my-personal-skill"
            personal.mkdir(parents=True)
            (personal / "SKILL.md").write_text("personal", encoding="utf-8")

            with mock.patch.object(deploy.Path, "home", return_value=root):
                records = deploy.sync_existing_managed_skill_mirrors(
                    source,
                    primary,
                    workbench,
                    {"skills_mirrors": [str(mirror)]},
                    "test-ticket",
                )

            self.assertEqual((old / "SKILL.md").read_text(encoding="utf-8"), "new")
            self.assertEqual((personal / "SKILL.md").read_text(encoding="utf-8"), "personal")
            self.assertEqual(records[0]["managed_skills_synchronized"], 1)
            backup = Path(records[0]["backup_root"]) / "topic-selection-workflow" / "SKILL.md"
            self.assertEqual(backup.read_text(encoding="utf-8"), "old")

    def test_skill_mirror_symlink_is_blocked_before_sync(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            workbench = root / "AIContentWorkbench"
            (workbench / "系统文件_无需打开" / "backups").mkdir(parents=True)
            source = root / "package-skills" / "topic-selection-workflow"
            source.mkdir(parents=True)
            (source / "SKILL.md").write_text("new", encoding="utf-8")
            external = root / "external-topic"
            external.mkdir()
            (external / "SKILL.md").write_text("external", encoding="utf-8")
            mirror = root / ".codex" / "skills"
            mirror.mkdir(parents=True)
            (mirror / "topic-selection-workflow").symlink_to(external, target_is_directory=True)

            with mock.patch.object(deploy.Path, "home", return_value=root):
                with self.assertRaisesRegex(deploy.DeploymentError, "软链接"):
                    deploy.sync_existing_managed_skill_mirrors(
                        source.parent,
                        root / ".agents" / "skills",
                        workbench,
                        {"skills_mirrors": [str(mirror)]},
                        "test-ticket",
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
