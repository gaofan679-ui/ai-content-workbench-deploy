#!/usr/bin/env python3
"""Controlled AI Content Workbench deployment from a customer ticket.

The public repository contains this installer and immutable manifests only.
Package URLs live in short-lived customer tickets and are never printed with
their query strings. Writes require --confirm-write YES and are delegated to
the package's own deterministic upgrade tool.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import hashlib
import html
import json
import os
from pathlib import Path
import platform as platform_lib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any
import urllib.parse
import urllib.request
import zipfile


PRODUCT_ID = "ai-content-workbench"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
BROWSER_FALLBACK_TIMEOUT_SECONDS = 90
MANAGED_SKILL_IDS = {
    "ai-commercial-video-remix", "ai-model-asset-codex", "ai-network-doctor",
    "ai-video-decompose-gemini", "ai-video-editing-post", "ai-video-experience-deposit",
    "ai-video-generation-api", "ai-video-generation-pack", "ai-video-generation-qc",
    "ai-video-generation-runner", "ai-video-image-assets", "ai-video-motion-preflight",
    "ai-video-motion-transfer", "ai-video-person-assets", "ai-video-product-assets",
    "ai-video-product-rewrite", "ai-video-real-person-assets",
    "ai-video-remix-contract-protocol", "ai-video-scene-assets", "ai-video-storyboard",
    "ai-video-workflow-codex", "aigc-video-prompt-codex",
    "article-visual-publishing-workflow", "clean-image-generation-executor",
    "commerce-ai-workbench", "content-positioning-interview", "copywriting-workflow",
    "customer-workbench-deployer", "libtv-cli", "social-copy-extract",
    "talking-head-video-workflow", "topic-selection-workflow",
    "xhs-cover-style-replication", "xhs-live-photo", "xhs-viral-clone",
}


class DeploymentError(RuntimeError):
    pass


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def parse_time(value: str, field: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise DeploymentError(f"{field} 不是有效时间。") from exc
    if parsed.tzinfo is None:
        raise DeploymentError(f"{field} 必须包含时区。")
    return parsed.astimezone(dt.timezone.utc)


def platform_name() -> str:
    name = platform_lib.system().lower()
    if name == "windows":
        return "windows"
    if name == "darwin":
        return "macos"
    if name == "linux" and "microsoft" in platform_lib.release().lower():
        return "wsl2"
    return name


def redacted_location(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme in {"http", "https"}:
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    if parsed.scheme == "file":
        return "local-file-ticket"
    return "local-ticket"


def _local_path(source: str) -> Path | None:
    parsed = urllib.parse.urlsplit(source)
    if parsed.scheme == "file":
        return Path(urllib.request.url2pathname(parsed.path)).expanduser().resolve()
    if parsed.scheme == "":
        return Path(source).expanduser().resolve()
    return None


def public_source_alternatives(source: str) -> list[str]:
    """Return the immutable jsDelivr equivalent for a public GitHub source."""
    alternatives = [source]
    parsed = urllib.parse.urlsplit(source)
    path = parsed.path.strip("/")
    parts = path.split("/") if path else []
    mirror_path: str | None = None
    if parsed.netloc == "raw.githubusercontent.com" and len(parts) >= 4:
        owner, repo, ref = parts[:3]
        mirror_path = f"/gh/{owner}/{repo}@{ref}/{'/'.join(parts[3:])}"
    elif parsed.netloc == "github.com" and len(parts) >= 5 and parts[3] == "blob":
        owner, repo, _, ref = parts[:4]
        mirror_path = f"/gh/{owner}/{repo}@{ref}/{'/'.join(parts[4:])}"
    if mirror_path:
        alternatives.append(urllib.parse.urlunsplit(("https", "cdn.jsdelivr.net", mirror_path, "", "")))
    return alternatives


def is_windows_host() -> bool:
    return os.name == "nt"


def system_browser_candidates() -> list[Path]:
    """Return installed Windows browsers that can use the system network stack.

    This fallback is deliberately limited to the customer's own Edge/Chrome.
    It never opens a signed package URL in a public log and it stores downloads
    only in the deployment process' temporary directory.
    """
    if not is_windows_host():
        return []
    candidates: list[Path] = []
    for name in ("msedge.exe", "chrome.exe"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    for variable, suffixes in (
        ("ProgramFiles", ("Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe")),
        ("ProgramFiles(x86)", ("Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe")),
        ("LOCALAPPDATA", ("Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe")),
    ):
        base = os.environ.get(variable)
        if base:
            candidates.extend(Path(base) / suffix for suffix in suffixes)
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key not in seen and candidate.is_file():
            unique.append(candidate)
            seen.add(key)
    return unique


def _browser_common_args(browser: Path, profile: Path) -> list[str]:
    return [
        str(browser),
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-data-dir={profile}",
    ]


def _extract_browser_json(output: bytes) -> bytes:
    """Extract JSON from Edge/Chrome --dump-dom output without trusting HTML."""
    text = output.decode("utf-8", errors="replace").strip()
    candidates = [text]
    if "<body" in text.lower():
        body = re.sub(r"(?is).*?<body[^>]*>(.*?)</body>.*", r"\1", text)
        candidates.append(html.unescape(re.sub(r"(?is)<[^>]+>", "", body)).strip())
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return json.dumps(value, ensure_ascii=False).encode("utf-8")
    raise DeploymentError("系统浏览器已打开，但没有读到有效的部署票据。")


def browser_fetch_bytes(source: str) -> bytes:
    """Read a remote JSON resource through Windows Edge/Chrome as a fallback."""
    browsers = system_browser_candidates()
    if not browsers:
        raise DeploymentError("未找到可用的 Windows Edge 或 Chrome。")
    last_error: str | None = None
    for browser in browsers:
        profile = Path(tempfile.mkdtemp(prefix="aicw-browser-profile-"))
        try:
            command = _browser_common_args(browser, profile) + [
                "--virtual-time-budget=3000",
                "--dump-dom",
                source,
            ]
            result = subprocess.run(
                command,
                capture_output=True,
                timeout=BROWSER_FALLBACK_TIMEOUT_SECONDS,
                check=False,
            )
            if result.returncode == 0 and result.stdout:
                return _extract_browser_json(result.stdout)
            last_error = f"{browser.name} 未返回内容"
        except (OSError, subprocess.SubprocessError) as exc:
            last_error = f"{browser.name} 无法启动"
        finally:
            shutil.rmtree(profile, ignore_errors=True)
    raise DeploymentError(last_error or "系统浏览器无法读取部署票据。")


def _curl_candidates() -> list[Path]:
    """Find the built-in curl client without relying on a shell or PATH only."""
    candidates: list[Path] = []
    for name in ("curl", "curl.exe"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
        if system_root:
            candidates.append(Path(system_root) / "System32" / "curl.exe")
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key not in seen and candidate.is_file():
            unique.append(candidate)
            seen.add(key)
    return unique


def curl_fetch_bytes(source: str, *, timeout: int = 60) -> bytes:
    """Read a remote resource with curl/Schannel when Python TLS is unavailable."""
    last_error: str | None = None
    for curl in _curl_candidates():
        command = [
            str(curl), "--fail", "--silent", "--show-error", "--location",
            "--max-time", str(timeout), "--user-agent", "AIContentWorkbench-Deployer/1",
            source,
        ]
        try:
            result = subprocess.run(command, capture_output=True, timeout=timeout + 10, check=False)
            if result.returncode == 0 and result.stdout:
                return result.stdout
            last_error = f"{curl.name} 未返回内容"
        except (OSError, subprocess.SubprocessError):
            last_error = f"{curl.name} 无法启动"
    raise DeploymentError(last_error or "未找到可用的网络访问工具。")


def curl_download_file(source: str, destination: Path, *, timeout: int = 180) -> None:
    """Download to a temporary sibling file, then atomically move it into place."""
    last_error: str | None = None
    for curl in _curl_candidates():
        partial = destination.with_name(destination.name + ".curl-part")
        partial.unlink(missing_ok=True)
        command = [
            str(curl), "--fail", "--silent", "--show-error", "--location",
            "--max-time", str(timeout), "--user-agent", "AIContentWorkbench-Deployer/1",
            "--output", str(partial), source,
        ]
        try:
            result = subprocess.run(command, capture_output=True, timeout=timeout + 15, check=False)
            if result.returncode == 0 and partial.is_file() and partial.stat().st_size > 0:
                os.replace(partial, destination)
                return
            last_error = f"{curl.name} 未完成下载"
        except (OSError, subprocess.SubprocessError):
            last_error = f"{curl.name} 无法启动"
        finally:
            partial.unlink(missing_ok=True)
    raise DeploymentError(last_error or "未找到可用的网络访问工具。")


def browser_download_file(source: str, destination: Path) -> None:
    """Download a package with the system browser after direct HTTPS fails."""
    browsers = system_browser_candidates()
    if not browsers:
        raise DeploymentError("未找到可用的 Windows Edge 或 Chrome。")
    download_dir = destination.parent / "browser-download"
    download_dir.mkdir(parents=True, exist_ok=True)
    for browser in browsers:
        profile = Path(tempfile.mkdtemp(prefix="aicw-browser-profile-"))
        before = {path for path in download_dir.iterdir() if path.is_file()}
        process: subprocess.Popen[bytes] | None = None
        try:
            command = _browser_common_args(browser, profile) + [
                f"--download-dir={download_dir}",
                "--disable-popup-blocking",
                source,
            ]
            process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + BROWSER_FALLBACK_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                candidates = [
                    path for path in download_dir.iterdir()
                    if path.is_file() and path not in before and not path.name.endswith(".crdownload")
                ]
                if candidates:
                    newest = max(candidates, key=lambda path: path.stat().st_mtime)
                    if newest.stat().st_size > 0:
                        shutil.move(str(newest), str(destination))
                        return
                time.sleep(0.5)
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
            shutil.rmtree(profile, ignore_errors=True)
    raise DeploymentError("系统浏览器未能完成客户包下载。")


def fetch_bytes(source: str, *, timeout: int = 60) -> bytes:
    local = _local_path(source)
    if local is not None:
        if not local.is_file():
            raise DeploymentError("找不到本地文件。")
        return local.read_bytes()
    parsed = urllib.parse.urlsplit(source)
    if parsed.scheme != "https":
        raise DeploymentError("远程地址必须使用 HTTPS。")
    for candidate in public_source_alternatives(source):
        request = urllib.request.Request(candidate, headers={"User-Agent": "AIContentWorkbench-Deployer/1"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except Exception:
            pass
        try:
            return curl_fetch_bytes(candidate, timeout=timeout)
        except DeploymentError:
            if is_windows_host():
                try:
                    return browser_fetch_bytes(candidate)
                except DeploymentError:
                    pass
    if is_windows_host():
        raise DeploymentError("自动读取部署票据失败；系统网络工具和浏览器均未能访问入口。")
    raise DeploymentError("无法读取远程部署文件，请检查网络后再试。")


def fetch_json(source: str) -> dict[str, Any]:
    try:
        value = json.loads(fetch_bytes(source).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DeploymentError("JSON 文件无法解析。") from exc
    if not isinstance(value, dict):
        raise DeploymentError("JSON 顶层必须是对象。")
    return value


def require_fields(data: dict[str, Any], fields: tuple[str, ...], label: str) -> None:
    missing = [field for field in fields if data.get(field) in (None, "")]
    if missing:
        raise DeploymentError(f"{label}缺少字段：{', '.join(missing)}")


def validate_ticket(ticket: dict[str, Any]) -> None:
    require_fields(
        ticket,
        (
            "schema_version", "ticket_id", "customer_id", "issued_at", "expires_at",
            "product_id", "version", "platform", "install_mode", "manifest_url",
            "package_url", "package_size_bytes", "package_sha256",
        ),
        "部署票据",
    )
    if ticket["schema_version"] != 1 or ticket["product_id"] != PRODUCT_ID:
        raise DeploymentError("部署票据类型不匹配。")
    if ticket["platform"] not in {"macos", "windows"}:
        raise DeploymentError("部署票据平台无效。")
    if ticket["install_mode"] not in {"incremental_upgrade", "first_install"}:
        raise DeploymentError("部署票据安装模式无效。")
    if not isinstance(ticket["package_size_bytes"], int) or ticket["package_size_bytes"] <= 0:
        raise DeploymentError("部署票据文件大小无效。")
    if not SHA256_RE.fullmatch(str(ticket["package_sha256"])):
        raise DeploymentError("部署票据 SHA-256 无效。")
    issued = parse_time(str(ticket["issued_at"]), "issued_at")
    expires = parse_time(str(ticket["expires_at"]), "expires_at")
    now = utc_now()
    if expires <= issued:
        raise DeploymentError("部署票据有效期无效。")
    if now > expires:
        raise DeploymentError("部署票据已过期，请申请新票据。")
    if issued > now + dt.timedelta(minutes=10):
        raise DeploymentError("部署票据签发时间晚于当前时间，请检查电脑时间。")
    actual_platform = platform_name()
    if actual_platform != ticket["platform"]:
        raise DeploymentError(
            f"票据用于 {ticket['platform']}，当前电脑识别为 {actual_platform}，不能继续。"
        )


def validate_bundle_ticket(ticket: dict[str, Any]) -> None:
    require_fields(
        ticket,
        (
            "schema_version", "ticket_id", "customer_id", "issued_at", "expires_at",
            "product_id", "version", "artifacts",
        ),
        "自动识别部署票据",
    )
    if ticket["schema_version"] != 2 or ticket["product_id"] != PRODUCT_ID:
        raise DeploymentError("自动识别部署票据类型不匹配。")
    issued = parse_time(str(ticket["issued_at"]), "issued_at")
    expires = parse_time(str(ticket["expires_at"]), "expires_at")
    now = utc_now()
    if expires <= issued or now > expires:
        raise DeploymentError("部署票据已过期或有效期无效，请申请新票据。")
    if issued > now + dt.timedelta(minutes=10):
        raise DeploymentError("部署票据签发时间晚于当前时间，请检查电脑时间。")
    artifacts = ticket["artifacts"]
    if not isinstance(artifacts, list) or not artifacts:
        raise DeploymentError("自动识别部署票据没有可用客户包。")
    seen: set[tuple[str, str]] = set()
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise DeploymentError("自动识别部署票据的客户包记录格式无效。")
        require_fields(
            artifact,
            (
                "platform", "install_mode", "manifest_url", "package_url",
                "package_size_bytes", "package_sha256",
            ),
            "客户包记录",
        )
        key = (str(artifact["platform"]), str(artifact["install_mode"]))
        if key[0] not in {"macos", "windows"} or key[1] not in {
            "first_install", "incremental_upgrade",
        }:
            raise DeploymentError("客户包记录的平台或安装模式无效。")
        if key in seen:
            raise DeploymentError("自动识别部署票据包含重复客户包。")
        seen.add(key)
        if not isinstance(artifact["package_size_bytes"], int) or artifact["package_size_bytes"] <= 0:
            raise DeploymentError("客户包记录的文件大小无效。")
        if not SHA256_RE.fullmatch(str(artifact["package_sha256"])):
            raise DeploymentError("客户包记录的 SHA-256 无效。")


def validate_manifest(manifest: dict[str, Any], ticket: dict[str, Any]) -> None:
    require_fields(
        manifest,
        (
            "schema_version", "product_id", "module_id", "version", "release_tag",
            "release_id", "channel", "status", "platform", "install_mode",
            "package_file_name", "package_root", "package_subdir",
            "package_size_bytes", "package_sha256",
        ),
        "版本清单",
    )
    if manifest["schema_version"] != 1 or manifest["product_id"] != PRODUCT_ID:
        raise DeploymentError("版本清单类型不匹配。")
    pairs = (
        ("version", "version"),
        ("platform", "platform"),
        ("install_mode", "install_mode"),
        ("package_size_bytes", "package_size_bytes"),
        ("package_sha256", "package_sha256"),
    )
    for manifest_key, ticket_key in pairs:
        if manifest[manifest_key] != ticket[ticket_key]:
            raise DeploymentError(f"部署票据与版本清单不一致：{manifest_key}")
    if not SHA256_RE.fullmatch(str(manifest["package_sha256"])):
        raise DeploymentError("版本清单 SHA-256 无效。")
    if manifest["status"] not in {
        "single_machine_candidate_not_batch_release",
        "stable",
    }:
        raise DeploymentError("版本状态不允许安装。")


def resolve_workbench(explicit: str | None, mode: str) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser().resolve())
    elif os.environ.get("AI_WORKBENCH_HOME"):
        candidates.append(Path(os.environ["AI_WORKBENCH_HOME"]).expanduser().resolve())
    else:
        if os.name == "nt":
            candidates.append(Path("C:/AIContentWorkbench"))
        candidates.append((Path.home() / "AIContentWorkbench").resolve())
    existing = [path for path in candidates if path.is_dir()]
    if mode == "incremental_upgrade":
        if len(existing) != 1:
            raise DeploymentError("无法唯一确定现有工作台目录，请由 Codex 明确传入 --workbench。")
        return existing[0]
    if explicit:
        return candidates[0]
    if existing:
        return existing[0]
    return candidates[0]


def resolve_skills_home(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not path.is_dir():
            raise DeploymentError("指定的 Skill 目录不存在。")
        return path
    if os.environ.get("CODEX_SKILLS_HOME"):
        path = Path(os.environ["CODEX_SKILLS_HOME"]).expanduser().resolve()
        if path.is_dir():
            return path
    candidates = [
        (Path.home() / ".codex" / "skills").resolve(),
        (Path.home() / ".agents" / "skills").resolve(),
    ]
    existing = [path for path in candidates if path.is_dir()]
    if len(existing) != 1:
        raise DeploymentError("无法唯一确定真实 Skill 目录，请由 Codex 明确传入 --skills-home。")
    return existing[0]


def _workbench_state(path: Path) -> str:
    if not path.exists():
        return "absent"
    if not path.is_dir():
        return "conflict"
    try:
        if not any(path.iterdir()):
            return "empty"
    except OSError:
        return "conflict"
    markers = (
        "系统文件_无需打开", "01_素材入口", "02_项目工作区", "03_最终成果",
        "00_DO_NOT_DELETE_Core_Config", "01_Inbox", "02_Projects", "03_Outputs",
    )
    return "managed" if any((path / marker).exists() for marker in markers) else "conflict"


def _managed_skill_count(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(1 for skill_id in MANAGED_SKILL_IDS if (path / skill_id / "SKILL.md").is_file())


def detect_install_context(workbench_arg: str | None, skills_arg: str | None) -> dict[str, Any]:
    if workbench_arg:
        workbench_candidates = [Path(workbench_arg).expanduser().resolve()]
    elif os.environ.get("AI_WORKBENCH_HOME"):
        workbench_candidates = [Path(os.environ["AI_WORKBENCH_HOME"]).expanduser().resolve()]
    else:
        workbench_candidates = []
        if os.name == "nt":
            workbench_candidates.append(Path("C:/AIContentWorkbench"))
        workbench_candidates.append((Path.home() / "AIContentWorkbench").resolve())
    states = [(path, _workbench_state(path)) for path in workbench_candidates]
    meaningful = [(path, state) for path, state in states if state in {"managed", "conflict"}]
    if len(meaningful) > 1 or any(state == "conflict" for _, state in states):
        raise DeploymentError("工作台目录存在冲突或无法唯一判断；当前只读检查已停止。")
    workbench = meaningful[0][0] if meaningful else workbench_candidates[0]

    if skills_arg:
        skills_candidates = [Path(skills_arg).expanduser().resolve()]
    elif os.environ.get("CODEX_SKILLS_HOME"):
        skills_candidates = [Path(os.environ["CODEX_SKILLS_HOME"]).expanduser().resolve()]
    else:
        skills_candidates = [
            (Path.home() / ".codex" / "skills").resolve(),
            (Path.home() / ".agents" / "skills").resolve(),
        ]
    skill_states = [(path, _managed_skill_count(path)) for path in skills_candidates]
    managed_roots = [(path, count) for path, count in skill_states if count > 0]
    if len(managed_roots) > 1:
        raise DeploymentError("发现两处工作台能力目录，无法安全选择；当前只读检查已停止。")
    skills_home = managed_roots[0][0] if managed_roots else skills_candidates[0]
    wb_managed = any(state == "managed" for _, state in states)
    skills_managed = bool(managed_roots)
    if wb_managed and skills_managed:
        mode = "incremental_upgrade"
    elif not wb_managed and not skills_managed:
        mode = "first_install"
    else:
        raise DeploymentError("工作台和工作流只发现了一部分，属于混合残留状态；不会自动安装或升级。")
    return {
        "install_mode": mode,
        "workbench": str(workbench),
        "skills_home": str(skills_home),
        "workbench_states": {str(path): state for path, state in states},
        "managed_skill_roots": {str(path): count for path, count in skill_states if count > 0},
        "write_performed": False,
    }


def normalize_ticket_for_host(
    ticket: dict[str, Any], workbench_arg: str | None, skills_arg: str | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    if ticket.get("schema_version") == 1:
        validate_ticket(ticket)
        context = {
            "install_mode": ticket["install_mode"],
            "workbench": str(resolve_workbench(workbench_arg, str(ticket["install_mode"]))),
            "skills_home": str(resolve_skills_home(skills_arg)),
            "selection": "legacy_ticket_explicit_mode",
            "write_performed": False,
        }
        return ticket, context
    validate_bundle_ticket(ticket)
    host_platform = platform_name()
    if host_platform not in {"macos", "windows"}:
        raise DeploymentError(f"当前系统识别为 {host_platform}，尚未开放自动部署。")
    context = detect_install_context(workbench_arg, skills_arg)
    matches = [
        item for item in ticket["artifacts"]
        if item["platform"] == host_platform and item["install_mode"] == context["install_mode"]
    ]
    if len(matches) != 1:
        raise DeploymentError("票据中没有唯一匹配当前电脑的客户包。")
    artifact = matches[0]
    normalized = {
        "schema_version": 1,
        "ticket_id": ticket["ticket_id"],
        "customer_id": ticket["customer_id"],
        "issued_at": ticket["issued_at"],
        "expires_at": ticket["expires_at"],
        "product_id": ticket["product_id"],
        "version": ticket["version"],
        **artifact,
    }
    validate_ticket(normalized)
    context["selection"] = "automatic_platform_and_install_state"
    return normalized, context


def disk_check(workbench: Path, package_size: int) -> None:
    anchor = workbench if workbench.exists() else workbench.parent
    while not anchor.exists() and anchor != anchor.parent:
        anchor = anchor.parent
    free = shutil.disk_usage(anchor).free
    required = max(package_size * 4, 500 * 1024 * 1024)
    if free < required:
        raise DeploymentError("磁盘空间不足，至少需要约 500 MB 可用空间。")


TOOL_ALTERNATIVES = {
    "python_runtime": ("python3", "python", "py"),
    "node": ("node",),
    "npm": ("npm", "npm.cmd"),
    "ffmpeg": ("ffmpeg",),
    "ffprobe": ("ffprobe",),
    "curl": ("curl", "curl.exe"),
}


def known_tool_paths(name: str) -> list[Path]:
    names = [name]
    if os.name == "nt" and not name.lower().endswith((".exe", ".cmd")):
        names.extend([f"{name}.exe", f"{name}.cmd"])
    roots: list[Path] = []
    if os.name == "nt":
        for variable, suffixes in (
            ("ProgramFiles", ("nodejs",)),
            ("LOCALAPPDATA", ("Microsoft/WinGet/Links",)),
            ("ProgramData", ("chocolatey/bin",)),
            ("USERPROFILE", ("scoop/shims",)),
        ):
            base = os.environ.get(variable)
            if base:
                roots.extend(Path(base) / suffix for suffix in suffixes)
        local = os.environ.get("LOCALAPPDATA")
        if local and name in {"python", "python3"}:
            roots.extend(
                Path(item) for item in glob.glob(str(Path(local) / "Programs/Python/Python*/python.exe"))
            )
    else:
        roots.extend(Path(item) for item in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"))
    return [root / executable for root in roots for executable in names]


def resolve_required_tool(tool_id: str) -> dict[str, Any]:
    alternatives = TOOL_ALTERNATIVES.get(tool_id)
    if not alternatives:
        raise DeploymentError(f"版本清单包含未知依赖：{tool_id}")
    for name in alternatives:
        found = shutil.which(name)
        if found:
            return {"status": "pass", "path": found, "resolution_source": "path"}
    for name in alternatives:
        for candidate in known_tool_paths(name):
            if candidate.is_file():
                return {
                    "status": "pass",
                    "path": str(candidate),
                    "resolution_source": "known_location",
                    "path_refresh_recommended": True,
                }
    return {
        "status": "block",
        "message": "未找到必需工具；请先运行部署包里的中文环境体检和依赖助手。",
    }


def environment_report(manifest: dict[str, Any]) -> dict[str, Any]:
    required = manifest.get("required_tools") or []
    if not isinstance(required, list) or any(not isinstance(item, str) for item in required):
        raise DeploymentError("版本清单 required_tools 格式无效。")
    tools = {tool_id: resolve_required_tool(tool_id) for tool_id in required}
    missing = [tool_id for tool_id, item in tools.items() if item["status"] == "block"]
    optional_components = manifest.get("optional_local_components") or {}
    if not isinstance(optional_components, dict):
        raise DeploymentError("版本清单 optional_local_components 格式无效。")
    component_report = {}
    for component_id, component in optional_components.items():
        if not isinstance(component, dict):
            raise DeploymentError("版本清单包含无效的本地可选组件。")
        component_report[str(component_id)] = {
            "status": "setup_required_after_install"
            if component.get("delivery_status") == "configured_after_install"
            else "included",
            "first_model_download_gb": component.get("first_model_download_gb"),
            "external_uploads": component.get("external_uploads", 0),
            "paid_calls": component.get("paid_calls", 0),
            "blocking_for_base_install": False,
        }
    return {
        "status": "blocked" if missing else "ready",
        "profile": manifest.get("dependency_profile") or "legacy_manifest",
        "required_tools": required,
        "tools": tools,
        "missing_required": missing,
        "optional_local_components": component_report,
        "write_performed": False,
    }


def customer_summary(
    manifest: dict[str, Any],
    detection: dict[str, Any],
    environment: dict[str, Any],
    *,
    phase: str,
) -> dict[str, Any]:
    """Return the same plain-language state used by the customer-facing receipt.

    Technical fields remain available in the internal receipt, but this summary
    is deliberately free of paths, hashes, ticket IDs and implementation names.
    """
    platform_label = {"macos": "Mac", "windows": "Windows", "wsl2": "Windows 子系统"}.get(
        str(manifest.get("platform")), str(manifest.get("platform"))
    )
    mode_label = "首次安装" if detection.get("install_mode") == "first_install" else "已有工作台升级"
    if phase == "inspect":
        if environment.get("status") == "ready":
            conclusion = "环境已具备，可以进入确认步骤"
            next_steps = ["确认本次更新范围", "明确回复“同意执行”后才会写入", "写入完成后重新打开工作台"]
        else:
            conclusion = "暂时不能继续，需要先补齐环境"
            next_steps = ["按提示补齐缺少的基础工具", "重新打开部署入口做一次检查", "检查通过后再确认写入"]
        missing = environment.get("missing_required") or []
        missing_labels = {
            "python_runtime": "Python",
            "node": "Node.js",
            "npm": "npm",
            "ffmpeg": "ffmpeg",
            "ffprobe": "ffprobe",
            "curl": "网络访问工具",
        }
        return {
            "当前结论": conclusion,
            "这次将处理": [f"按当前电脑识别为{mode_label}", f"准备安装或更新 {manifest.get('version')} 版本", "保留已有内容，不整理旧目录"],
            "原有内容": "项目、素材、成果和个人配置不会在检查阶段被修改。",
            "还需要你做什么": next_steps,
            "缺少的基础工具": [missing_labels.get(str(item), "必要基础工具") for item in missing],
            "从哪里继续": f"这是 {platform_label} 电脑；检查通过后回到部署入口，完成确认即可。",
        }
    optional = environment.get("optional_local_components") or {}
    next_steps = ["重新打开工作台应用，让本次更新完整生效", "打开“AI 内容工作台｜从这里开始”查看中文入口", "按需要配置自己的账号或授权"]
    if optional:
        next_steps[2] = "首次使用精确字幕等本地能力时，按提示准备约 1.2 GB 的本地模型"
    return {
        "当前结论": "本次安装或升级已完成，可以继续使用",
        "这次完成了什么": [f"已完成 {manifest.get('version')} 版本更新", "已完成安装后文件核对", "已补充中文使用入口和新旧目录说明", "没有自动上传素材或产生模型费用"],
        "原有内容是否保留": "已有项目、素材、成果、个人配置和历史目录均保留在原处，没有自动改名、移动或删除。",
        "还需要你做什么": next_steps,
        "从哪里继续": "打开工作台根目录中的“AI 内容工作台｜从这里开始”，再进入使用教程。",
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_package(source: str, destination: Path) -> None:
    local = _local_path(source)
    if local is not None:
        if not local.is_file():
            raise DeploymentError("找不到本地测试包。")
        shutil.copyfile(local, destination)
        return
    parsed = urllib.parse.urlsplit(source)
    if parsed.scheme != "https":
        raise DeploymentError("客户包地址必须使用 HTTPS。")
    request = urllib.request.Request(source, headers={"User-Agent": "AIContentWorkbench-Deployer/1"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
    except Exception as exc:
        destination.unlink(missing_ok=True)
        try:
            curl_download_file(source, destination)
            return
        except DeploymentError as curl_exc:
            if is_windows_host():
                try:
                    browser_download_file(source, destination)
                    return
                except DeploymentError as browser_exc:
                    raise DeploymentError(
                        "客户包自动下载失败；已尝试系统网络工具和浏览器，但当前网络或安全软件仍阻止访问。"
                    ) from browser_exc
            raise DeploymentError("客户包下载失败，请检查网络后再试。") from curl_exc


def safe_extract(archive: Path, destination: Path) -> None:
    try:
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                pure = Path(item.filename)
                if pure.is_absolute() or ".." in pure.parts:
                    raise DeploymentError("压缩包包含越界路径。")
                unix_mode = (item.external_attr >> 16) & 0xFFFF
                if (unix_mode & 0o170000) == 0o120000:
                    raise DeploymentError("压缩包包含软链接，不能继续。")
                target = (destination / pure).resolve()
                if destination.resolve() not in target.parents and target != destination.resolve():
                    raise DeploymentError("压缩包解压目标越界。")
            bundle.extractall(destination)
    except zipfile.BadZipFile as exc:
        raise DeploymentError("客户包不是有效 ZIP。") from exc


def run_upgrade(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "升级工具没有返回说明").strip()
        raise DeploymentError(f"升级工具阻塞：{message[-1200:]}")
    return result


def backup_record_from_output(output: str) -> Path:
    for line in output.splitlines():
        if line.startswith("备份位置："):
            path = Path(line.split("：", 1)[1].strip()).expanduser().resolve()
            record = path / "backup_record.json"
            if record.is_file():
                return record
    raise DeploymentError("安装完成但没有找到备份与指纹核验记录。")


def write_receipt(
    workbench: Path,
    skills_home: Path,
    ticket: dict[str, Any],
    manifest: dict[str, Any],
    ticket_source: str,
    backup_record: Path,
    environment: dict[str, Any],
) -> Path:
    record = json.loads(backup_record.read_text(encoding="utf-8"))
    if record.get("status") != "installed":
        raise DeploymentError("备份记录没有标记为安装完成。")
    identity_actions = 0
    installed_identity_files = 0
    module_receipt_path: Path | None = None
    for action in record.get("actions") or []:
        if action.get("label") == "模块安装记录":
            module_receipt_path = Path(str(action.get("target") or "")).expanduser().resolve()
            continue
        if action.get("status") == "kept_existing":
            identity_actions += 1
            continue
        if action.get("status") != "installed":
            raise DeploymentError("备份记录包含未完成的安装动作。")
        source_sha = str(action.get("source_tree_sha256") or "")
        installed_sha = str(action.get("installed_tree_sha256") or "")
        if not source_sha or source_sha != installed_sha:
            raise DeploymentError("安装后文件指纹核验没有通过。")
        identity_actions += 1
        installed_identity_files += 1
    if module_receipt_path is None or not module_receipt_path.is_file():
        raise DeploymentError("找不到升级包生成的模块安装记录。")
    module_receipt = json.loads(module_receipt_path.read_text(encoding="utf-8"))
    if module_receipt.get("post_install_tree_verification") != "passed":
        raise DeploymentError("模块安装记录没有通过安装后指纹核验。")
    expected_actions = manifest.get("post_install_identity_actions")
    if expected_actions is not None and identity_actions != int(expected_actions):
        raise DeploymentError("安装动作数量与不可变版本清单不一致。")
    receipt_dir = workbench / "系统文件_无需打开" / "deployment_receipts"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", str(ticket["ticket_id"]))
    receipt_path = receipt_dir / f"{safe_id}.json"
    receipt = {
        "schema_version": 1,
        "status": "installed_and_verified",
        "installed_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "ticket_id": ticket["ticket_id"],
        "customer_id": ticket["customer_id"],
        "ticket_source": redacted_location(ticket_source),
        "product_id": PRODUCT_ID,
        "version": manifest["version"],
        "release_tag": manifest["release_tag"],
        "release_id": manifest["release_id"],
        "platform": manifest["platform"],
        "package_sha256": manifest["package_sha256"],
        "workbench": str(workbench),
        "skills_home": str(skills_home),
        "backup_record": str(backup_record),
        "post_install_tree_verification": "passed",
        "post_install_identity_actions_checked": identity_actions,
        "post_install_files_hash_verified": installed_identity_files,
        "environment_preflight": environment,
        "customer_summary": customer_summary(
            manifest,
            {"install_mode": manifest.get("install_mode")},
            environment,
            phase="apply",
        ),
        "paid_calls": 0,
        "external_uploads": 0,
        "rollback": "requires_separate_explicit_confirmation",
    }
    temporary = receipt_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, receipt_path)
    return receipt_path


def verify_first_install(source_skills: Path, skills_home: Path, workbench: Path) -> int:
    source_dirs = sorted(path for path in source_skills.iterdir() if path.is_dir())
    if len(source_dirs) != 35:
        raise DeploymentError("首次安装包内工作流数量不是预期的 35 项。")
    checked = 0
    for source_dir in source_dirs:
        target_dir = skills_home / source_dir.name
        if not (target_dir / "SKILL.md").is_file():
            raise DeploymentError(f"首次安装后缺少工作流：{source_dir.name}")
        for source_file in sorted(path for path in source_dir.rglob("*") if path.is_file()):
            relative = source_file.relative_to(source_dir)
            target_file = target_dir / relative
            if not target_file.is_file() or sha256_file(source_file) != sha256_file(target_file):
                raise DeploymentError(f"首次安装后文件身份不一致：{source_dir.name}/{relative}")
            checked += 1
    required = (
        workbench / "AGENTS.md",
        workbench / "04_使用教程" / "04_打开使用教程.html",
        workbench / "系统文件_无需打开" / "config" / "customer_config.env",
    )
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise DeploymentError("首次安装后缺少工作台核心文件。")
    return checked


def run_first_install(
    package_root: Path,
    package_dir: Path,
    workbench: Path,
    skills_home: Path,
    ticket: dict[str, Any],
    manifest: dict[str, Any],
    ticket_source: str,
    environment: dict[str, Any],
) -> Path:
    if workbench.exists() and any(workbench.iterdir()):
        raise DeploymentError("首次安装目标不是空目录，尚未写入。")
    if _managed_skill_count(skills_home):
        raise DeploymentError("首次安装目标已经存在工作台能力，尚未写入。")
    if manifest["platform"] == "macos":
        installer = package_dir / "mac" / "tools" / "install_ai_content_workbench.sh"
        if not installer.is_file():
            raise DeploymentError("Mac 首次安装包缺少正式安装器。")
        result = subprocess.run(
            ["bash", str(installer)],
            input=f"{workbench}\n{skills_home}\nYES\n",
            text=True,
            capture_output=True,
        )
    else:
        installer = package_dir / "installer" / "Install_AI_Content_Workbench.ps1"
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not installer.is_file() or not powershell:
            raise DeploymentError("Windows 首次安装包缺少正式安装器或 PowerShell。")
        result = subprocess.run(
            [
                powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(installer),
                "-WorkspaceRoot", str(workbench), "-CodexSkillsHome", str(skills_home),
            ],
            text=True,
            capture_output=True,
        )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "首次安装器没有返回说明").strip()
        raise DeploymentError(f"首次安装器阻塞：{message[-1200:]}")
    checked = verify_first_install(package_dir / "codex_skills", skills_home, workbench)
    receipt_dir = workbench / "系统文件_无需打开" / "deployment_receipts"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", str(ticket["ticket_id"]))
    receipt_path = receipt_dir / f"{safe_id}.json"
    receipt = {
        "schema_version": 1,
        "status": "installed_and_verified",
        "installed_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "ticket_id": ticket["ticket_id"],
        "customer_id": ticket["customer_id"],
        "ticket_source": redacted_location(ticket_source),
        "product_id": PRODUCT_ID,
        "version": manifest["version"],
        "release_tag": manifest["release_tag"],
        "release_id": manifest["release_id"],
        "platform": manifest["platform"],
        "install_mode": "first_install",
        "package_sha256": manifest["package_sha256"],
        "workbench": str(workbench),
        "skills_home": str(skills_home),
        "backup_record": "not_applicable_fresh_environment",
        "post_install_tree_verification": "passed",
        "post_install_identity_files_checked": checked,
        "environment_preflight": environment,
        "customer_summary": customer_summary(
            manifest,
            {"install_mode": "first_install"},
            environment,
            phase="apply",
        ),
        "paid_calls": 0,
        "external_uploads": 0,
        "rollback": "fresh_install_cleanup_requires_separate_explicit_confirmation",
    }
    temporary = receipt_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, receipt_path)
    return receipt_path


def load_context(
    args: argparse.Namespace,
) -> tuple[dict[str, Any], dict[str, Any], Path, Path, dict[str, Any]]:
    raw_ticket = fetch_json(args.ticket)
    ticket, detection = normalize_ticket_for_host(raw_ticket, args.workbench, args.skills_home)
    manifest_source = args.manifest or str(ticket["manifest_url"])
    manifest = fetch_json(manifest_source)
    validate_manifest(manifest, ticket)
    workbench = Path(detection["workbench"])
    skills_home = Path(detection["skills_home"])
    disk_check(workbench, int(ticket["package_size_bytes"]))
    return ticket, manifest, workbench, skills_home, detection


def inspect(args: argparse.Namespace) -> int:
    ticket, manifest, workbench, skills_home, detection = load_context(args)
    environment = environment_report(manifest)
    result = {
        "status": "ready_for_confirmation" if environment["status"] == "ready" else "blocked_environment",
        "write_performed": False,
        "ticket_id": ticket["ticket_id"],
        "customer_id": ticket["customer_id"],
        "ticket_source": redacted_location(args.ticket),
        "expires_at": ticket["expires_at"],
        "current_platform": platform_name(),
        "target_version": manifest["version"],
        "release_tag": manifest["release_tag"],
        "release_status": manifest["status"],
        "install_mode": manifest["install_mode"],
        "automatic_detection": detection,
        "workbench": str(workbench),
        "skills_home": str(skills_home),
        "package_sha256": manifest["package_sha256"],
        "environment": environment,
        "customer_summary": customer_summary(manifest, detection, environment, phase="inspect"),
        "next_step": (
            "Explain scope and backup boundary, then wait for explicit approval."
            if environment["status"] == "ready"
            else "Run the Chinese preflight/dependency helper, then inspect again."
        ),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if environment["status"] == "ready" else 2


def apply(args: argparse.Namespace) -> int:
    if args.confirm_write != "YES":
        raise DeploymentError("尚未获得明确写入确认；当前没有下载或安装。")
    ticket, manifest, workbench, skills_home, detection = load_context(args)
    environment = environment_report(manifest)
    if environment["status"] != "ready":
        missing = "、".join(environment["missing_required"])
        raise DeploymentError(f"当前电脑缺少必需工具：{missing}。尚未下载或写入，请先完成环境体检。")
    with tempfile.TemporaryDirectory(prefix="aicw-deploy-") as temporary_name:
        temporary = Path(temporary_name)
        archive = temporary / str(manifest["package_file_name"])
        download_package(str(ticket["package_url"]), archive)
        actual_size = archive.stat().st_size
        actual_sha = sha256_file(archive)
        if actual_size != int(manifest["package_size_bytes"]):
            raise DeploymentError("客户包文件大小与不可变版本清单不一致。")
        if actual_sha != str(manifest["package_sha256"]):
            raise DeploymentError("客户包 SHA-256 与不可变版本清单不一致。")
        extracted = temporary / "extracted"
        extracted.mkdir()
        safe_extract(archive, extracted)
        package_root = extracted / str(manifest["package_root"])
        package_dir = package_root / str(manifest["package_subdir"])
        if manifest["install_mode"] == "incremental_upgrade":
            upgrade_script = package_dir / "scripts" / "module_upgrade.py"
            module_manifest = package_dir / "module_manifest.json"
            if not upgrade_script.is_file() or not module_manifest.is_file():
                raise DeploymentError("客户包缺少升级工具或模块清单。")
            base = [
                sys.executable,
                str(upgrade_script),
                "--package", str(package_dir),
                "--workbench", str(workbench),
                "--skills-home", str(skills_home),
            ]
            run_upgrade(base + ["--check"])
            installed = run_upgrade(base + ["--apply", "--confirm-write", "YES"])
            backup_record = backup_record_from_output(installed.stdout)
            receipt = write_receipt(
                workbench, skills_home, ticket, manifest, args.ticket, backup_record, environment
            )
        else:
            receipt = run_first_install(
                package_root, package_dir, workbench, skills_home, ticket, manifest, args.ticket, environment
            )
            backup_record = None
    print(
        json.dumps(
            {
                "status": "installed_and_verified",
                "version": manifest["version"],
                "platform": manifest["platform"],
                "package_sha256": manifest["package_sha256"],
                "backup_record": str(backup_record) if backup_record else "not_applicable_first_install",
                "receipt": str(receipt),
                "automatic_detection": detection,
                "environment_preflight": environment,
                "customer_summary": customer_summary(manifest, detection, environment, phase="apply"),
                "paid_calls": 0,
                "external_uploads": 0,
                "next_step": (
                    "Restart Codex, run the no-cost business recognition checks, then confirm the one-time local caption component/model setup before precise-caption work."
                    if environment.get("optional_local_components")
                    else "Restart Codex and run the no-cost business recognition checks."
                ),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI 内容工作台受控部署入口")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, handler in (("inspect", inspect), ("apply", apply)):
        command = sub.add_parser(name)
        command.add_argument("--ticket", required=True)
        command.add_argument("--manifest")
        command.add_argument("--workbench")
        command.add_argument("--skills-home")
        if name == "apply":
            command.add_argument("--confirm-write", default="")
        command.set_defaults(handler=handler)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return int(args.handler(args))
    except DeploymentError as exc:
        print(f"不能继续：{exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("已取消；当前步骤没有继续。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
