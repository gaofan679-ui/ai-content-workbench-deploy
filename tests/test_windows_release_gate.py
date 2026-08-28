from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("aicw_make_ticket", ROOT / "scripts" / "make_ticket.py")
assert SPEC and SPEC.loader
make_ticket = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(make_ticket)


class WindowsReleaseGateTests(unittest.TestCase):
    def report(self, sha_values: list[str]) -> dict:
        return {
            "schema_version": 1,
            "product_id": "ai-content-workbench",
            "version": "1.8.0-rc.2o",
            "platform": "windows",
            "status": "pass",
            "executed_on_windows": True,
            "checks": dict(make_ticket.WINDOWS_GATE_CHECKS),
            "package_sha256": sha_values,
        }

    def test_matching_windows_gate_passes(self) -> None:
        hashes = {"a" * 64, "b" * 64}
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "windows-gate.json"
            path.write_text(json.dumps(self.report(sorted(hashes))), encoding="utf-8")
            make_ticket.validate_windows_gate(
                path, version="1.8.0-rc.2o", package_sha256=hashes
            )

    def test_simulation_or_wrong_package_cannot_unlock_customer_ticket(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "windows-gate.json"
            report = self.report(["a" * 64])
            report["executed_on_windows"] = False
            path.write_text(json.dumps(report), encoding="utf-8")
            with self.assertRaises(ValueError):
                make_ticket.validate_windows_gate(
                    path,
                    version="1.8.0-rc.2o",
                    package_sha256={"a" * 64},
                )

    def test_missing_historical_upgrade_blocks_gate(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "windows-gate.json"
            report = self.report(["a" * 64])
            report["checks"]["historical_upgrade"] = "pending"
            path.write_text(json.dumps(report), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "historical_upgrade"):
                make_ticket.validate_windows_gate(
                    path,
                    version="1.8.0-rc.2o",
                    package_sha256={"a" * 64},
                )

    def test_missing_interrupted_recovery_blocks_gate(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "windows-gate.json"
            report = self.report(["a" * 64])
            report["checks"]["interrupted_recovery"] = "pending"
            path.write_text(json.dumps(report), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "interrupted_recovery"):
                make_ticket.validate_windows_gate(
                    path,
                    version="1.8.0-rc.2o",
                    package_sha256={"a" * 64},
                )

    def test_historical_baseline_uses_real_payload_without_obsolete_activation(self) -> None:
        gate_script = (ROOT / "scripts" / "run_windows_release_gate.ps1").read_text(
            encoding="utf-8"
        )
        self.assertIn("function Disable-HistoricalWebActivation", gate_script)
        self.assertIn("Invoke-PackageInstaller -PackageRoot $baselinePackage", gate_script)
        self.assertIn(
            'historical_baseline_setup = "actual_v1.7.0_payload_installed_with_obsolete_service_activation_skipped"',
            gate_script,
        )

    def test_web_server_activation_is_deferred_then_verified_without_global_scan(self) -> None:
        gate_script = (ROOT / "scripts" / "run_windows_release_gate.ps1").read_text(
            encoding="utf-8"
        )
        self.assertIn("function Defer-PackageWebAutoStart", gate_script)
        self.assertIn("Defer-PackageWebAutoStart -PackageRoot $firstPackage", gate_script)
        self.assertIn("Defer-PackageWebAutoStart -PackageRoot $upgradePackage", gate_script)
        self.assertIn("Cloud gate defers web activation", gate_script)
        self.assertIn("Starting the installed web service for verification", gate_script)
        self.assertIn('$launcher = Start-Process -FilePath "powershell.exe"', gate_script)
        self.assertIn("Wait-Workbench", gate_script)
        self.assertIn("netstat.exe -ano -p tcp", gate_script)
        self.assertIn(
            'Join-Path $Workspace "04_使用教程\\04_打开使用教程.html"',
            gate_script,
        )
        self.assertNotIn("04_使用教程\\docs\\04_打开使用教程.html", gate_script)
        self.assertNotIn("Get-CimInstance Win32_Process", gate_script)


if __name__ == "__main__":
    unittest.main()
