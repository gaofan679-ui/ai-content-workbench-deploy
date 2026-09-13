#!/usr/bin/env python3
"""Report workbench setup readiness without reading or printing secrets."""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path


_PATH_REFRESHED = False


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8-sig", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def resolve_layout(root: Path) -> tuple[str, Path, Path]:
    zh = root / "系统文件_无需打开"
    legacy = root / "00_DO_NOT_DELETE_Core_Config"
    if (zh / "config" / "customer_config.env").is_file() or zh.is_dir():
        return "zh_visible_v2", zh / "config" / "customer_config.env", zh / "tools"
    if (legacy / "customer_config.env").is_file() or legacy.is_dir():
        return "legacy_v1", legacy / "customer_config.env", root / "07_Tools"
    return "unknown", zh / "config" / "customer_config.env", zh / "tools"


def resolve_tutorials_root(root: Path) -> Path:
    """Return the directory that actually contains module tutorial pages.

    The current Chinese customer layout keeps the portable tutorial entry at
    ``04_使用教程`` and the complete module pages in its ``docs`` child.
    Historical workbenches keep the same pages directly in ``09_Docs``.
    Prefer the current nested layout, then retain both compatibility routes.
    """
    candidates = (
        root / "04_使用教程" / "docs",
        root / "04_使用教程",
        root / "09_Docs",
    )
    return next((path for path in candidates if path.is_dir()), candidates[0])


def refresh_process_path() -> None:
    """Refresh only this process after a Windows package-manager install."""
    global _PATH_REFRESHED
    if os.name != "nt" or _PATH_REFRESHED:
        return
    try:
        import winreg  # type: ignore

        values: list[str] = []
        for hive, subkey in (
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
            (winreg.HKEY_CURRENT_USER, r"Environment"),
        ):
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    value, _ = winreg.QueryValueEx(key, "Path")
                    if value:
                        values.append(str(value))
            except OSError:
                continue
        current = os.environ.get("PATH", "")
        os.environ["PATH"] = ";".join(item for item in values + [current] if item)
        _PATH_REFRESHED = True
    except ImportError:
        return


def known_command_paths(name: str) -> list[Path]:
    executable_names = [name]
    if os.name == "nt" and not name.lower().endswith((".exe", ".cmd")):
        executable_names.extend((f"{name}.exe", f"{name}.cmd"))
    roots: list[Path] = []
    if os.name == "nt":
        for variable, suffixes in (
            ("PROGRAMFILES", ("nodejs", "Git/cmd")),
            ("LOCALAPPDATA", ("Microsoft/WinGet/Links",)),
            ("PROGRAMDATA", ("chocolatey/bin",)),
            ("USERPROFILE", ("scoop/shims",)),
            ("SYSTEMROOT", ("System32",)),
        ):
            base = os.environ.get(variable)
            if base:
                roots.extend(Path(base) / suffix for suffix in suffixes)
        local = os.environ.get("LOCALAPPDATA")
        if local and name in {"python", "python3", "py"}:
            roots.extend(
                Path(item) for item in glob.glob(str(Path(local) / "Programs/Python/Python*/python.exe"))
            )
        if local:
            package_root = Path(local) / "Microsoft/WinGet/Packages"
            for executable in executable_names:
                roots.extend(
                    Path(item)
                    for item in glob.glob(
                        str(package_root / "**" / executable),
                        recursive=True,
                    )
                )
    else:
        roots.extend(Path(item) for item in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"))
    direct_files = [root for root in roots if root.is_file()]
    directories = [root for root in roots if not root.is_file()]
    return direct_files + [root / executable for root in directories for executable in executable_names]


def command_path(names: list[str]) -> str:
    refresh_process_path()
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    for name in names:
        for candidate in known_command_paths(name):
            if candidate.is_file():
                return str(candidate)
    return ""


def chrome_path() -> str:
    candidates: list[Path] = []
    if os.name == "nt":
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
            if base:
                candidates.append(Path(base) / "Google/Chrome/Application/chrome.exe")
    elif sys.platform == "darwin":
        candidates.append(Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
    return next((str(path) for path in candidates if path.is_file()), "")


def libtv_path() -> str:
    found = command_path(["libtv"])
    if found:
        return found
    candidate = Path.home() / ".libtv" / ("libtv.exe" if os.name == "nt" else "libtv")
    return str(candidate) if candidate.is_file() else ""


def libtv_login_ready() -> bool:
    credentials = Path.home() / ".libtv" / "credentials.json"
    return credentials.is_file() and credentials.stat().st_size > 2


def resolve_skills_home(explicit: Path | None, env: dict[str, str]) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(explicit.expanduser())
    configured = env.get("CODEX_SKILLS_HOME", "").strip()
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.extend((Path.home() / ".codex" / "skills", Path.home() / ".agents" / "skills"))
    unique: list[Path] = []
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in unique:
            unique.append(resolved)
    existing = [path for path in unique if path.is_dir()]
    if not existing:
        return unique[0] if unique else (Path.home() / ".codex" / "skills")
    return max(existing, key=lambda path: sum(1 for _ in path.glob("*/SKILL.md")))


def runtime_health() -> dict[str, object]:
    request = urllib.request.Request(
        "http://127.0.0.1:4318/health",
        headers={"User-Agent": "AIContentWorkbench-LocalReadiness/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return {
            "ready": bool(payload.get("ok")),
            "http_status": 200,
            "mode": str(payload.get("mode", "local")),
        }
    except (OSError, urllib.error.URLError, json.JSONDecodeError, UnicodeDecodeError):
        return {"ready": False, "http_status": None, "mode": "local"}


def build_module_rows(
    registry: dict[str, object],
    root: Path,
    tools_root: Path,
    skills_home: Path,
    integrations: list[dict[str, object]],
    health: dict[str, object],
) -> list[dict[str, object]]:
    integration_map = {str(item["id"]): item for item in integrations}
    tutorials_root = resolve_tutorials_root(root)
    rows: list[dict[str, object]] = []
    for module in registry.get("customer_modules", []):
        missing_skills = [
            name for name in module.get("required_skills", [])
            if not (skills_home / name / "SKILL.md").is_file()
        ]
        missing_files = [
            relative for relative in module.get("required_files", [])
            if not (tools_root / relative).is_file()
        ]
        missing_tutorials = [
            relative for relative in module.get("required_tutorials", [])
            if not (tutorials_root / relative).is_file()
        ]
        required_integrations = [
            integration_map.get(str(integration_id), {"id": integration_id, "ready": False, "mode": "unknown"})
            for integration_id in module.get("required_integrations", [])
        ]
        configuration_missing = [
            str(item["label"]) for item in required_integrations
            if not item.get("ready") and item.get("mode") not in {"browser_login"}
        ]
        human_confirmation = [
            str(item["label"]) for item in required_integrations
            if not item.get("ready") and item.get("mode") == "browser_login"
        ]
        if missing_skills or missing_files or missing_tutorials:
            status = "blocked_missing_component"
            customer_state = "安装内容不完整，需要部署方处理"
        elif not health.get("ready"):
            status = "blocked_service_unavailable"
            customer_state = "网页服务未就绪，需要自动重启后复检"
        elif configuration_missing:
            status = "configuration_required"
            customer_state = "功能已安装，请完成账号配置后验证实际任务"
        elif human_confirmation:
            status = "user_confirmation_required"
            customer_state = "功能已安装，需要本人完成登录或浏览器确认"
        else:
            status = "ready"
            customer_state = "基础检查通过，实际任务待验证"
        rows.append({
            "id": module["id"],
            "label": module["label"],
            "status": status,
            "customer_state": customer_state,
            "missing_skills": missing_skills,
            "missing_files": missing_files,
            "missing_tutorials": missing_tutorials,
            "configuration_missing": configuration_missing,
            "human_confirmation": human_confirmation,
            # This checker inspects installation/configuration only. A separate
            # business test must supply its own actual execution evidence.
            "no_cost_dry_run": "not_run",
            "verification_scope": "installation_configuration_and_service_health",
        })
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 AI 内容工作台完整配置状态")
    parser.add_argument("--workbench", required=True, type=Path)
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--skills-home", type=Path)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()

    root = args.workbench.expanduser().resolve()
    registry_path = args.registry or Path(__file__).with_name("customer_setup_registry.json")
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    layout, config_path, tools_root = resolve_layout(root)
    env = read_env(config_path)
    skills_home = resolve_skills_home(args.skills_home, env)

    tool_rows = []
    for item in registry["local_tools"]:
        tool_id = item["id"]
        if tool_id == "libtv":
            path = libtv_path()
            ready = bool(path)
        elif tool_id == "chrome":
            path = chrome_path()
            ready = bool(path)
        elif tool_id == "caption_alignment":
            runtime_config = config_path.parent / "modules" / "smart_editing_runtime.json"
            data = {}
            if runtime_config.is_file():
                try:
                    data = json.loads(runtime_config.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    data = {}
            path = str(data.get("caption_python", ""))
            ready = bool(path and Path(path).is_file() and data.get("caption_model_status") == "ready")
        elif tool_id == "social_spoken_asr":
            runtime_config = config_path.parent / "modules" / "smart_editing_runtime.json"
            data = {}
            if runtime_config.is_file():
                try:
                    data = json.loads(runtime_config.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    data = {}
            path = str(data.get("caption_python", ""))
            ready = bool(path and Path(path).is_file() and data.get("social_asr_model_status") == "ready")
        else:
            path = command_path(item.get("commands", []))
            ready = bool(path)
        tool_rows.append({"id": tool_id, "label": item["label"], "ready": ready, "required": item.get("required", False)})

    integration_rows = []
    for item in registry["integrations"]:
        integration_id = item["id"]
        keys = item.get("config_keys", [])
        if integration_id == "libtv_login":
            ready = libtv_login_ready()
        elif integration_id == "chatgpt_companion":
            companion = tools_root / "web-workbench" / "browser-companion" / "chatgpt-web" / "manifest.json"
            # Login and extension enablement are intentionally not inspected.
            ready = False
            packaged = companion.is_file()
        else:
            ready = bool(keys) and all(bool(env.get(key, "")) for key in keys)
            packaged = True
        row = {
            "id": integration_id,
            "label": item["label"],
            "ready": ready,
            "mode": item["mode"],
            "next_action": "" if ready else item["customer_action"],
        }
        if integration_id == "chatgpt_companion":
            row["component_packaged"] = packaged
            row["status_note"] = "为保护隐私，不读取浏览器登录状态；需由本人确认登录和扩展启用。"
        integration_rows.append(row)

    required_missing = [row["label"] for row in tool_rows if row["required"] and not row["ready"]]
    health = runtime_health()
    module_rows = build_module_rows(registry, root, tools_root, skills_home, integration_rows, health)
    blocking_modules = [
        row["label"] for row in module_rows
        if str(row["status"]).startswith("blocked_")
    ]
    report = {
        "schema_version": 2,
        "status": (
            "blocked_base_tools" if required_missing
            else "blocked_customer_module" if blocking_modules
            else "base_ready_configuration_pending"
        ),
        "workbench_found": root.is_dir(),
        "layout": layout,
        "local_tools": tool_rows,
        "integrations": integration_rows,
        "required_missing": required_missing,
        "web_runtime": health,
        "customer_modules": module_rows,
        "blocking_modules": blocking_modules,
        "security": {
            "secret_values_read": False,
            "browser_login_state_read": False,
            "keychain_scanned": False,
            "paid_calls": 0,
            "external_uploads": 0,
        },
    }
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("AI 内容工作台｜完整配置检查")
    print()
    if required_missing:
        print("结论：基础工具仍未补齐，暂时不能完整使用。")
    else:
        print("结论：基础配置检查已完成；下面列出各功能的配置状态，实际任务需要另行验证。")
    print()
    print("本地工具：")
    for row in tool_rows:
        print(("[已就绪] " if row["ready"] else "[待处理] ") + row["label"])
    print()
    print("账号和服务：")
    for row in integration_rows:
        suffix = "" if row["ready"] else "：" + row["next_action"]
        print(("[已配置] " if row["ready"] else "[待配置] ") + row["label"] + suffix)
    print()
    print("工作台功能：")
    for row in module_rows:
        marker = "[基础检查通过]" if row["status"] == "ready" else "[待完成]" if row["status"] in {"configuration_required", "user_confirmation_required"} else "[需修复]"
        print(f"{marker} {row['label']}：{row['customer_state']}")
    print()
    print("检查没有读取或显示密钥、浏览器 Cookie、登录密码和验证码，也没有产生费用。")
    return 2 if required_missing or blocking_modules else 0


if __name__ == "__main__":
    raise SystemExit(main())
