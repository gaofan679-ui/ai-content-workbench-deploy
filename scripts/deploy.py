#!/usr/bin/env python3
"""Controlled AI Content Workbench deployment from a customer ticket.

The public repository contains this installer and immutable manifests only.
Package URLs live in short-lived customer tickets and are never printed with
their query strings. Writes require --confirm-write YES and are delegated to
the package contract: legacy module packages use their deterministic upgrade
tool, while full workbench packages use their platform installer and manifest.
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
import uuid
from typing import Any
import urllib.parse
import urllib.request
import zipfile


PRODUCT_ID = "ai-content-workbench"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
BROWSER_FALLBACK_TIMEOUT_SECONDS = 90
MINIMUM_TICKET_REMAINING_SECONDS = 20 * 60
AUTOPILOT_SCHEMA_VERSION = 1
MAX_SAFE_RECOVERY_ATTEMPTS = 2
DEPLOYER_STATE_ENV = "AICW_DEPLOYER_STATE_ROOT"
RECOVERY_CATALOG = Path(__file__).resolve().parents[1] / "recovery" / "known-issues.json"
MANAGED_SKILL_IDS = {
    "ai-commercial-video-remix", "ai-model-asset-codex", "ai-network-doctor",
    "ai-video-decompose-gemini", "ai-video-editing-decompose", "ai-video-editing-post",
    "ai-video-experience-deposit",
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
    "viral-content-deconstruction", "xhs-cover-style-replication", "xhs-live-photo",
    "xhs-viral-clone",
}
ZH_LAYOUT_MARKERS = ("系统文件_无需打开", "01_素材入口", "02_项目工作区", "03_最终成果")
LEGACY_LAYOUT_MARKERS = (
    "00_DO_NOT_DELETE_Core_Config", "01_Inbox", "02_Projects", "03_Outputs",
    "07_Tools", "08_Projects_Tasks", "10_Output",
)
ACTIVE_MANIFEST_CANDIDATES = (
    Path("系统文件_无需打开/config/workbench_manifest.json"),
    Path("00_DO_NOT_DELETE_Core_Config/workbench_manifest.json"),
)
REQUIRED_EXISTING_ACTIVE_DIRECTORIES = ("core_config", "projects", "outputs")


class DeploymentError(RuntimeError):
    pass


def safe_identifier(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return cleaned[:120] or "deployment"


def deployer_state_root() -> Path:
    override = os.environ.get(DEPLOYER_STATE_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / ".aicw-deployer").resolve()


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def redact_error_text(value: str) -> str:
    """Keep diagnostic meaning without persisting signed URLs or query tokens."""
    value = re.sub(r"https://[^\s]+", lambda match: redacted_location(match.group(0)), value)
    value = re.sub(r"(?i)(api[_-]?key|token|secret|signature)=\S+", r"\1=<redacted>", value)
    return value[-4000:]


def load_recovery_catalog() -> dict[str, Any]:
    if not RECOVERY_CATALOG.is_file():
        return {"schema_version": AUTOPILOT_SCHEMA_VERSION, "rules": []}
    try:
        payload = json.loads(RECOVERY_CATALOG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DeploymentError("部署恢复规则库无法读取。") from exc
    if payload.get("schema_version") != AUTOPILOT_SCHEMA_VERSION:
        raise DeploymentError("部署恢复规则库版本不兼容。")
    rules = payload.get("rules")
    if not isinstance(rules, list):
        raise DeploymentError("部署恢复规则库格式无效。")
    return payload


def classify_deployment_failure(message: str, *, platform_id: str, version: str) -> dict[str, Any]:
    """Map an error to a bounded next action; never authorize payload mutation."""
    normalized = redact_error_text(message)
    catalog = load_recovery_catalog()
    for rule in catalog["rules"]:
        if not isinstance(rule, dict):
            continue
        platforms = rule.get("platforms") or ["macos", "windows"]
        versions = rule.get("versions") or ["*"]
        if platform_id not in platforms or ("*" not in versions and version not in versions):
            continue
        patterns = rule.get("match_any") or []
        if any(re.search(str(pattern), normalized, re.IGNORECASE) for pattern in patterns):
            return {
                "category": str(rule.get("category") or "unknown"),
                "action": str(rule.get("action") or "release_review"),
                "safe_to_retry": bool(rule.get("safe_to_retry", False)),
                "rule_id": str(rule.get("id") or "catalog-rule"),
                "customer_message": str(rule.get("customer_message") or "部署已安全暂停，需要部署方处理。"),
            }
    generic_rules = (
        (r"SHA-256|哈希|文件大小与不可变版本清单不一致|越界路径|软链接", "integrity", "security_block", False,
         "客户包安全校验没有通过，未继续安装；需要部署方重新核对正式包。"),
        (r"timed out|timeout|TLS|certificate|network|网络|下载失败|无法读取远程", "network", "retry_network_routes", True,
         "当前网络通道暂时不可用，部署程序会自动换线路并继续。"),
        (r"Node|npm|Python|ffmpeg|PATH|基础环境|依赖", "dependency", "refresh_environment_and_retry", True,
         "基础工具尚未就绪，部署程序会自动补齐或刷新后继续。"),
        (r"管理员|permission|access.*denied|权限|验证码|登录|付款", "authorization", "user_confirmation", False,
         "需要你在系统或账号界面完成一次本人确认，完成后可以从断点继续。"),
        (r"冲突|两个工作台|清单越界|真实项目数据", "data_conflict", "manual_plan", False,
         "检测到真实数据冲突，已停止写入，需要先确认保留哪一份。"),
        (r"正式安装器|安装包缺少|构建目录|构建结果|安装动作数量|指纹核验", "package_defect", "new_immutable_package", False,
         "客户包自身未通过安装验收，原有内容已保护，需要部署方发布修正版。"),
    )
    for pattern, category, action, safe_to_retry, customer_message in generic_rules:
        if re.search(pattern, normalized, re.IGNORECASE):
            return {
                "category": category,
                "action": action,
                "safe_to_retry": safe_to_retry,
                "rule_id": "generic",
                "customer_message": customer_message,
            }
    return {
        "category": "unknown",
        "action": "diagnose_then_release_review",
        "safe_to_retry": False,
        "rule_id": "unclassified",
        "customer_message": "部署遇到未登记问题，已保留断点和证据，没有继续改动原有内容。",
    }


def session_paths(ticket: dict[str, Any]) -> dict[str, Path]:
    session = deployer_state_root() / "sessions" / safe_identifier(str(ticket["ticket_id"]))
    cache = deployer_state_root() / "cache" / f"{ticket['package_sha256']}.zip"
    return {"root": session, "checkpoint": session / "checkpoint.json", "cache": cache}


def write_checkpoint(
    ticket: dict[str, Any],
    manifest: dict[str, Any],
    *,
    stage: str,
    status: str,
    attempts: dict[str, int] | None = None,
    incident: dict[str, Any] | None = None,
) -> Path:
    paths = session_paths(ticket)
    payload: dict[str, Any] = {
        "schema_version": AUTOPILOT_SCHEMA_VERSION,
        "ticket_id": ticket["ticket_id"],
        "product_id": PRODUCT_ID,
        "version": manifest["version"],
        "platform": manifest["platform"],
        "install_mode": manifest["install_mode"],
        "package_sha256": manifest["package_sha256"],
        "stage": stage,
        "status": status,
        "attempts": attempts or {},
        "updated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "contains_signed_urls": False,
        "rollback": "requires_separate_explicit_confirmation",
    }
    if incident:
        payload["incident"] = incident
    atomic_write_json(paths["checkpoint"], payload)
    return paths["checkpoint"]


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


def ensure_ticket_time_window(ticket: dict[str, Any]) -> None:
    """Avoid installing system dependencies when the package link is nearly expired."""
    remaining = parse_time(str(ticket["expires_at"]), "expires_at") - utc_now()
    if remaining.total_seconds() < MINIMUM_TICKET_REMAINING_SECONDS:
        raise DeploymentError("部署链接剩余有效时间不足，尚未修改电脑；请先申请新的部署链接。")


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
    package_contract = manifest.get("package_contract")
    if package_contract not in {None, "module_upgrade_v1", "full_workbench_v1"}:
        raise DeploymentError("版本清单声明了未知的客户包结构。")
    if package_contract == "full_workbench_v1":
        require_fields(
            manifest,
            ("payload_version", "installed_skill_count"),
            "完整工作台版本清单",
        )
        if not isinstance(manifest["installed_skill_count"], int) or manifest["installed_skill_count"] <= 0:
            raise DeploymentError("完整工作台版本清单的工作流数量无效。")


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


def resolve_skills_home(explicit: str | None, mode: str) -> Path:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if mode == "incremental_upgrade" and not path.is_dir():
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


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def inspect_workbench_layout(path: Path) -> dict[str, Any]:
    """Classify historical layouts without renaming, merging or deleting data."""
    if not path.exists():
        return {"state": "absent", "layout_id": None, "recovery": "not_needed"}
    if not path.is_dir():
        return {"state": "conflict", "layout_id": None, "recovery": "manual_plan_required"}
    try:
        if not any(path.iterdir()):
            return {"state": "empty", "layout_id": None, "recovery": "not_needed"}
    except OSError:
        return {"state": "conflict", "layout_id": None, "recovery": "manual_plan_required"}

    root = path.resolve()
    zh_count = sum(1 for marker in ZH_LAYOUT_MARKERS if (root / marker).exists())
    legacy_count = sum(1 for marker in LEGACY_LAYOUT_MARKERS if (root / marker).exists())
    active: list[tuple[Path, dict[str, Any]]] = []
    manifest_error: str | None = None
    for relative in ACTIVE_MANIFEST_CANDIDATES:
        manifest_path = root / relative
        if not manifest_path.is_file():
            continue
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            manifest_error = "active_manifest_unreadable"
            continue
        if (
            int(payload.get("layout_version", 0)) >= 2
            and payload.get("directory_contract_status") == "active"
        ):
            active.append((manifest_path, payload))

    if len(active) > 1:
        return {
            "state": "conflict", "layout_id": None, "recovery": "manual_plan_required",
            "reason": "multiple_active_workbench_manifests", "zh_marker_count": zh_count,
            "legacy_marker_count": legacy_count,
        }
    if len(active) == 1:
        manifest_path, payload = active[0]
        layout_id = str(payload.get("layout_id") or "manifest_v2")
        directories = payload.get("directories")
        if layout_id != "zh_visible_v2" or not isinstance(directories, dict):
            manifest_error = "unsupported_active_layout"
        else:
            for key, value in directories.items():
                if not isinstance(value, str) or not value:
                    manifest_error = f"active_directory_missing:{key}"
                    break
                relative = Path(value)
                resolved = (root / relative).resolve()
                if relative.is_absolute() or ".." in relative.parts or not _inside(root, resolved):
                    manifest_error = f"active_directory_unsafe:{key}"
                    break
                if key in REQUIRED_EXISTING_ACTIVE_DIRECTORIES and not resolved.is_dir():
                    manifest_error = f"active_directory_not_found:{key}"
                    break
            for key in REQUIRED_EXISTING_ACTIVE_DIRECTORIES:
                if key not in directories:
                    manifest_error = f"active_directory_missing:{key}"
                    break
        if manifest_error is None:
            return {
                "state": "managed", "layout_id": "zh_visible_v2",
                "recovery": "legacy_preserved_use_active_manifest" if legacy_count else "not_needed",
                "manifest_path": str(manifest_path), "zh_marker_count": zh_count,
                "legacy_marker_count": legacy_count,
            }

    if zh_count and legacy_count:
        return {
            "state": "conflict", "layout_id": None, "recovery": "manual_plan_required",
            "reason": manifest_error or "mixed_layout_without_unique_active_manifest",
            "zh_marker_count": zh_count, "legacy_marker_count": legacy_count,
        }
    if legacy_count:
        return {
            "state": "managed", "layout_id": "legacy_v1", "recovery": "not_needed",
            "zh_marker_count": zh_count, "legacy_marker_count": legacy_count,
        }
    if zh_count:
        return {
            "state": "managed", "layout_id": "zh_visible_v2", "recovery": "not_needed",
            "zh_marker_count": zh_count, "legacy_marker_count": legacy_count,
        }
    return {
        "state": "conflict", "layout_id": None, "recovery": "manual_plan_required",
        "reason": manifest_error or "unrecognized_workbench_layout",
        "zh_marker_count": zh_count, "legacy_marker_count": legacy_count,
    }


def _workbench_state(path: Path) -> str:
    return str(inspect_workbench_layout(path)["state"])


def _managed_skill_count(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(1 for skill_id in MANAGED_SKILL_IDS if (path / skill_id / "SKILL.md").is_file())


def _managed_skill_ids(path: Path) -> list[str]:
    if not path.is_dir():
        return []
    return sorted(
        skill_id for skill_id in MANAGED_SKILL_IDS
        if (path / skill_id / "SKILL.md").is_file()
    )


def _default_skill_roots() -> list[Path]:
    return [
        (Path.home() / ".codex" / "skills").resolve(),
        (Path.home() / ".agents" / "skills").resolve(),
    ]


def _skill_root_candidates(explicit: str | None) -> tuple[list[Path], Path | None]:
    defaults = _default_skill_roots()
    preferred: Path | None = None
    if explicit:
        preferred = Path(explicit).expanduser().resolve()
    elif os.environ.get("CODEX_SKILLS_HOME"):
        preferred = Path(os.environ["CODEX_SKILLS_HOME"]).expanduser().resolve()
    candidates = [preferred] if preferred is not None else []
    # A standard root may coexist with the other standard Codex root.  Inspect
    # both so a stale duplicate cannot silently keep winning after an upgrade.
    if preferred is None or preferred in defaults:
        candidates.extend(defaults)
    result: list[Path] = []
    for path in candidates:
        if path not in result:
            result.append(path)
    return result, preferred


def _receipt_skill_roots(workbench: Path) -> list[Path]:
    receipt_dir = workbench / "系统文件_无需打开" / "deployment_receipts"
    if not receipt_dir.is_dir():
        return []
    roots: list[Path] = []
    for receipt_path in sorted(receipt_dir.glob("*.json"), reverse=True):
        try:
            payload = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
            value = payload.get("skills_home")
            if not isinstance(value, str) or not value:
                continue
            root = Path(value).expanduser().resolve()
        except (OSError, json.JSONDecodeError):
            continue
        if root not in roots:
            roots.append(root)
    return roots


def _select_skill_root_plan(
    workbench: Path, candidates: list[Path], preferred: Path | None
) -> dict[str, Any]:
    reports = {path: _managed_skill_ids(path) for path in candidates}
    managed = [path for path, ids in reports.items() if ids]
    primary: Path
    selection: str
    if preferred is not None and preferred in managed:
        primary = preferred
        selection = "explicit_or_environment_managed_root"
    else:
        receipt_matches = [path for path in _receipt_skill_roots(workbench) if path in managed]
        if len(receipt_matches) == 1:
            primary = receipt_matches[0]
            selection = "deployment_receipt_managed_root"
        elif managed:
            highest = max(len(reports[path]) for path in managed)
            leaders = [path for path in managed if len(reports[path]) == highest]
            default_order = _default_skill_roots()
            primary = next((path for path in default_order if path in leaders), leaders[0])
            selection = "most_complete_managed_root"
        else:
            primary = preferred or candidates[0]
            selection = "new_default_root"
    mirrors = [path for path in managed if path != primary]
    recovery = "not_needed"
    if mirrors:
        recovery = "backup_and_sync_existing_managed_duplicates"
    return {
        "primary": primary,
        "mirrors": mirrors,
        "selection": selection,
        "recovery": recovery,
        "managed_skill_roots": {str(path): len(ids) for path, ids in reports.items() if ids},
        "managed_skill_ids": {str(path): ids for path, ids in reports.items() if ids},
    }


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
    layout_reports = [(path, inspect_workbench_layout(path)) for path in workbench_candidates]
    states = [(path, str(report["state"])) for path, report in layout_reports]
    meaningful = [(path, state) for path, state in states if state in {"managed", "conflict"}]
    if len(meaningful) > 1 or any(state == "conflict" for _, state in states):
        conflict = next((report for _, report in layout_reports if report["state"] == "conflict"), {})
        reason = conflict.get("reason", "workbench_directory_conflict")
        raise DeploymentError(
            "工作台存在无法自动判断的新旧目录；已在下载客户包前停止。"
            f"内部原因：{reason}。请先生成只读恢复计划，不会自动改名、合并、移动或删除文件。"
        )
    workbench = meaningful[0][0] if meaningful else workbench_candidates[0]

    skills_candidates, preferred_skills = _skill_root_candidates(skills_arg)
    skill_plan = _select_skill_root_plan(workbench, skills_candidates, preferred_skills)
    skills_home = Path(skill_plan["primary"])
    wb_managed = any(state == "managed" for _, state in states)
    managed_root_count = len(skill_plan["managed_skill_roots"])
    mode = "incremental_upgrade" if wb_managed else "first_install"
    skills_recovery = str(skill_plan["recovery"])
    if wb_managed and managed_root_count == 0:
        skills_recovery = "recreate_missing_managed_skills"
    elif not wb_managed and managed_root_count > 0:
        skills_recovery = "backup_existing_managed_residue_and_complete_first_install"
    return {
        "install_mode": mode,
        "workbench": str(workbench),
        "skills_home": str(skills_home),
        "skills_mirrors": [str(path) for path in skill_plan["mirrors"]],
        "skills_selection": skill_plan["selection"],
        "skills_recovery": skills_recovery,
        "workbench_states": {str(path): state for path, state in states},
        "layout_contract": next(
            (report for path, report in layout_reports if path == workbench),
            {"state": "absent", "layout_id": None, "recovery": "not_needed"},
        ),
        "managed_skill_roots": skill_plan["managed_skill_roots"],
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
            "skills_home": str(resolve_skills_home(skills_arg, str(ticket["install_mode"]))),
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

# The deployment entry may install only the small set of base tools required by
# the selected immutable manifest.  Package IDs are public package-manager
# identifiers, not customer data.  We deliberately do not try to install
# winget/Homebrew themselves or change proxy, DNS, PATH in the registry, or
# antivirus settings.
WINDOWS_BOOTSTRAP_PACKAGES = {
    "python_runtime": ("Python", "Python.Python.3.12"),
    "node": ("Node.js", "OpenJS.NodeJS.LTS"),
    "npm": ("Node.js", "OpenJS.NodeJS.LTS"),
    "ffmpeg": ("ffmpeg", "Gyan.FFmpeg"),
    "ffprobe": ("ffmpeg", "Gyan.FFmpeg"),
}
MACOS_BREW_PACKAGES = {
    "python_runtime": ("Python", "python"),
    "node": ("Node.js", "node"),
    "npm": ("Node.js", "node"),
    "ffmpeg": ("ffmpeg", "ffmpeg"),
    "ffprobe": ("ffmpeg", "ffmpeg"),
}


def _first_existing_executable(names: tuple[str, ...]) -> Path | None:
    """Find a package manager without relying on a stale PATH only."""
    for name in names:
        found = shutil.which(name)
        if found:
            return Path(found)
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
        candidates: list[Path] = []
        if local_app_data:
            candidates.append(Path(local_app_data) / "Microsoft/WindowsApps/winget.exe")
        if system_root:
            candidates.append(Path(system_root) / "System32/winget.exe")
        for candidate in candidates:
            if candidate.is_file():
                return candidate
    else:
        candidates = [Path("/opt/homebrew/bin/brew"), Path("/usr/local/bin/brew")]
        for candidate in candidates:
            if candidate.is_file():
                return candidate
    return None


def refresh_process_path() -> None:
    """Refresh only this process after a package-manager install."""
    if os.name == "nt":
        machine = os.environ.get("Path") or ""
        machine_path = os.environ.get("PATH", "")
        # Read the current user/machine values when available.  This does not
        # write the registry and leaves customer system settings untouched.
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
            if values:
                machine = ";".join(values)
        except ImportError:
            machine = os.environ.get("PATH", "")
        os.environ["PATH"] = ";".join(item for item in (machine, machine_path) if item)
        return
    additions = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    current = os.environ.get("PATH", "")
    os.environ["PATH"] = ":".join(dict.fromkeys(additions + ([current] if current else [])))


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
        if local:
            package_root = Path(local) / "Microsoft/WinGet/Packages"
            for executable in names:
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
    return direct_files + [root / executable for root in directories for executable in names]


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


def dependency_bootstrap_capability(platform_id: str, missing: list[str]) -> dict[str, Any]:
    """Describe whether one confirmed bootstrap can repair the environment.

    This is read-only.  It is intentionally separate from
    ``environment_report`` so inspection never installs software.
    """
    if not missing:
        return {"status": "not_needed", "installer": None, "missing": []}
    if platform_id == "windows":
        unsupported = [item for item in missing if item not in WINDOWS_BOOTSTRAP_PACKAGES]
        installer = _first_existing_executable(("winget",))
        if unsupported:
            return {
                "status": "unsupported_missing_tools",
                "installer": str(installer) if installer else None,
                "missing": missing,
                "unsupported": unsupported,
            }
        if installer is None:
            return {
                "status": "installer_unavailable",
                "installer": None,
                "missing": missing,
                "message": "Windows 当前没有可用的官方安装工具。",
            }
        return {
            "status": "available",
            "installer": str(installer),
            "missing": missing,
            "method": "winget_official_packages",
        }
    if platform_id == "macos":
        unsupported = [item for item in missing if item not in MACOS_BREW_PACKAGES]
        installer = _first_existing_executable(("brew",))
        if unsupported:
            return {
                "status": "unsupported_missing_tools",
                "installer": str(installer) if installer else None,
                "missing": missing,
                "unsupported": unsupported,
            }
        if installer is None:
            return {
                "status": "installer_unavailable",
                "installer": None,
                "missing": missing,
                "message": "Mac 当前没有可用的 Homebrew 安装工具。",
            }
        return {
            "status": "available",
            "installer": str(installer),
            "missing": missing,
            "method": "homebrew_official_packages",
        }
    return {
        "status": "unsupported_platform",
        "installer": None,
        "missing": missing,
    }


def _run_dependency_install(command: list[str], *, env: dict[str, str] | None = None) -> list[int]:
    """Run one official installer with a bounded retry; keep output internal."""
    exit_codes: list[int] = []
    for attempt in range(1, 4):
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=900,
                check=False,
                env=env,
            )
            exit_codes.append(int(result.returncode))
            if result.returncode == 0:
                break
        except (OSError, subprocess.SubprocessError):
            exit_codes.append(-1)
        if attempt < 3:
            time.sleep(1)
    return exit_codes


def bootstrap_missing_dependencies(manifest: dict[str, Any], environment: dict[str, Any]) -> dict[str, Any]:
    """Install missing base tools after the single explicit write confirmation.

    Only official package-manager identifiers are used.  A failed bootstrap
    never changes proxy/DNS/registry settings and never starts workbench
    installation until the post-bootstrap preflight passes.
    """
    missing = [str(item) for item in environment.get("missing_required") or []]
    capability = environment.get("bootstrap") or dependency_bootstrap_capability(
        str(manifest.get("platform")), missing
    )
    if capability.get("status") != "available":
        raise DeploymentError(
            "当前电脑缺少基础环境，但系统没有可用的官方自动安装能力；"
            "请先由电脑管理员启用系统安装工具，完成后重新发送部署指令。"
        )
    platform_id = str(manifest.get("platform"))
    packages: dict[str, tuple[str, str]] = {}
    catalog = WINDOWS_BOOTSTRAP_PACKAGES if platform_id == "windows" else MACOS_BREW_PACKAGES
    for tool_id in missing:
        label, package_id = catalog[tool_id]
        packages[package_id] = (label, package_id)
    installer = str(capability["installer"])
    records: list[dict[str, Any]] = []
    for package_id, (label, _) in packages.items():
        if platform_id == "windows":
            command = [
                installer,
                "install",
                "--id", package_id,
                "--exact",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ]
            env = None
        else:
            command = [installer, "install", package_id]
            env = {
                **os.environ,
                "HOMEBREW_NO_AUTO_UPDATE": "1",
                "HOMEBREW_NO_INSTALL_CLEANUP": "1",
            }
        exit_codes = _run_dependency_install(command, env=env)
        refresh_process_path()
        records.append({
            "tool": label,
            "package_id": package_id,
            "attempts": len(exit_codes),
            "exit_codes": exit_codes,
        })
    refresh_process_path()
    after = environment_report(manifest)
    if after["status"] != "ready":
        unresolved = ",".join(str(item) for item in after.get("missing_required") or [])
        raise DeploymentError(
            "基础环境已尝试自动补齐，但复查仍未通过；没有继续安装工作台。"
            "请确认系统权限提示已允许，并重新发送部署指令。"
            f" unresolved_tools={unresolved or 'unknown'}"
        )
    return {
        "status": "passed",
        "method": capability.get("method"),
        "attempted_tools": [record["tool"] for record in records],
        "records": records,
        "environment_after": after,
    }


def environment_report(manifest: dict[str, Any]) -> dict[str, Any]:
    required = manifest.get("required_tools") or []
    if not isinstance(required, list) or any(not isinstance(item, str) for item in required):
        raise DeploymentError("版本清单 required_tools 格式无效。")
    tools = {tool_id: resolve_required_tool(tool_id) for tool_id in required}
    missing = [tool_id for tool_id, item in tools.items() if item["status"] == "block"]
    bootstrap = dependency_bootstrap_capability(str(manifest.get("platform")), missing)
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
        "bootstrap": bootstrap,
        "optional_local_components": component_report,
        "write_performed": False,
    }


def customer_summary(
    manifest: dict[str, Any],
    detection: dict[str, Any],
    environment: dict[str, Any],
    *,
    phase: str,
    module_readiness: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the same plain-language state used by the customer-facing receipt.

    Technical fields remain available in the internal receipt, but this summary
    is deliberately free of paths, hashes, ticket IDs and implementation names.
    """
    platform_label = {"macos": "Mac", "windows": "Windows", "wsl2": "Windows 子系统"}.get(
        str(manifest.get("platform")), str(manifest.get("platform"))
    )
    mode_label = "首次安装" if detection.get("install_mode") == "first_install" else "已有工作台升级"
    skills_recovery = str(detection.get("skills_recovery") or "not_needed")
    if skills_recovery == "backup_and_sync_existing_managed_duplicates":
        skill_action = "先分别备份，再同步两处工作流目录中的同名工作台能力"
    elif skills_recovery == "recreate_missing_managed_skills":
        skill_action = "自动补回缺失的工作台能力"
    elif skills_recovery == "backup_existing_managed_residue_and_complete_first_install":
        skill_action = "先备份已有同名能力，再补齐完整工作台"
    else:
        skill_action = "保留已有内容，不整理旧目录"
    if phase == "inspect":
        bootstrap = environment.get("bootstrap") or {}
        if environment.get("status") == "ready":
            conclusion = "环境已具备，可以进入确认步骤"
            next_steps = ["确认本次更新范围", "明确回复“同意执行”后才会写入", "写入完成后重新打开工作台"]
        elif bootstrap.get("status") == "available":
            conclusion = "发现缺少基础环境；确认后会自动补齐并继续安装"
            next_steps = [
                "明确回复“同意执行”",
                "允许系统出现的必要权限提示",
                "等待自动补齐环境、安装并验收",
            ]
        else:
            conclusion = "当前电脑暂时不能自动补齐环境"
            next_steps = ["请电脑管理员启用系统安装工具", "重新发送同一部署指令", "检查通过后再确认安装"]
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
            "这次将处理": [f"按当前电脑识别为{mode_label}", f"准备安装或更新 {manifest.get('version')} 版本", skill_action],
            "原有内容": "项目、素材、成果、个人配置和其他个人工作流不会在检查阶段被修改。",
            "还需要你做什么": next_steps,
            "缺少的基础工具": [missing_labels.get(str(item), "必要基础工具") for item in missing],
            "从哪里继续": f"这是 {platform_label} 电脑；检查通过后回到部署入口，完成确认即可。",
        }
    optional = environment.get("optional_local_components") or {}
    next_steps = ["重新打开工作台应用，让本次更新完整生效", "打开“AI 内容工作台｜从这里开始”查看中文入口", "按需要配置自己的账号或授权"]
    if optional:
        next_steps[2] = "首次使用精确字幕等本地能力时，按提示准备约 1.2 GB 的本地模型"
    completed = [f"已完成 {manifest.get('version')} 版本更新", "已完成安装后文件核对", "已补充中文使用入口和新旧目录说明", "没有自动上传素材或产生模型费用"]
    if skills_recovery == "backup_and_sync_existing_managed_duplicates":
        completed[2] = "两处工作流目录中的同名工作台能力已备份并同步"
    elif skills_recovery == "recreate_missing_managed_skills":
        completed[2] = "缺失的工作台能力已自动补齐"
    elif skills_recovery == "backup_existing_managed_residue_and_complete_first_install":
        completed[2] = "已有同名能力已备份，完整工作台已补齐"
    ready_modules: list[str] = []
    pending_modules: list[str] = []
    if module_readiness:
        for row in module_readiness.get("customer_modules") or []:
            if row.get("status") == "ready":
                ready_modules.append(str(row.get("label")))
            elif row.get("status") in {"configuration_required", "user_confirmation_required"}:
                pending_modules.append(str(row.get("label")))
    conclusion = "本次安装或升级已完成，可以继续使用"
    if pending_modules:
        conclusion = "工作台已安装完成；部分功能完成账号配置后即可使用"
        next_steps.insert(0, "按功能状态完成尚缺的账号配置或本人登录确认")
    return {
        "当前结论": conclusion,
        "这次完成了什么": completed,
        "已经可以使用": ready_modules,
        "配置后可以使用": pending_modules,
        "原有内容是否保留": "已有项目、素材、成果、个人配置、个人工作流和历史目录均保留在原处，没有自动改名、移动或删除。",
        "还需要你做什么": next_steps,
        "从哪里继续": "打开工作台根目录中的“AI 内容工作台｜从这里开始”，再进入使用教程。",
    }


def collect_module_readiness(
    workbench: Path,
    skills_home: Path,
    environment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tools_root = workbench / "系统文件_无需打开" / "tools" / "scripts" / "workbench-setup"
    script = tools_root / "setup_status.py"
    registry = tools_root / "customer_setup_registry.json"
    if not script.is_file() or not registry.is_file():
        raise DeploymentError("安装后缺少功能可用性检查器，不能判定客户功能已经可用。")
    readiness_environment = os.environ.copy()
    validated_tool_directories: list[str] = []
    for record in ((environment or {}).get("tools") or {}).values():
        path = str((record or {}).get("path") or "").strip()
        if path and Path(path).is_file():
            validated_tool_directories.append(str(Path(path).parent))
    if validated_tool_directories:
        readiness_environment["PATH"] = os.pathsep.join(
            [*dict.fromkeys(validated_tool_directories), readiness_environment.get("PATH", "")]
        )

    with tempfile.TemporaryDirectory(prefix="aicw-module-readiness-") as directory:
        output = Path(directory) / "module_readiness.json"
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--workbench", str(workbench),
                "--skills-home", str(skills_home),
                "--registry", str(registry),
                "--json-output", str(output),
            ],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=30,
            env=readiness_environment,
        )
        if not output.is_file():
            raise DeploymentError("安装后没有生成功能可用性报告。")
        try:
            report = json.loads(output.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise DeploymentError("安装后的功能可用性报告无法读取。") from exc
    diagnostic_root = workbench / "系统文件_无需打开" / "logs" / "deployment"
    diagnostic_root.mkdir(parents=True, exist_ok=True)
    (diagnostic_root / "module-readiness-latest.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if int(report.get("schema_version") or 0) < 2:
        raise DeploymentError("功能可用性检查器版本过旧，不能判定客户功能已经可用。")
    modules = report.get("customer_modules")
    if not isinstance(modules, list) or not modules:
        raise DeploymentError("功能可用性报告没有覆盖客户网页模块。")
    blocking = [
        str(row.get("label") or row.get("id") or "未知功能")
        for row in modules
        if str(row.get("status") or "").startswith("blocked_")
    ]
    if result.returncode != 0 or blocking:
        missing_tools = [str(item) for item in report.get("required_missing") or []]
        names = "、".join(blocking) if blocking else "、".join(missing_tools) or "基础运行环境"
        raise DeploymentError(f"安装后功能验收未通过：{names}。已停止判定为安装成功。")
    return report


def wait_for_windows_web_services(*, timeout_seconds: int = 90) -> dict[str, Any]:
    """Wait until both installed local services answer after detached activation."""
    urls = (
        "http://127.0.0.1:4318/health",
        "http://127.0.0.1:3000/",
    )
    deadline = time.monotonic() + timeout_seconds
    last_error = "local services did not answer"
    while time.monotonic() < deadline:
        ready = True
        for url in urls:
            try:
                request = urllib.request.Request(
                    url,
                    headers={"User-Agent": "AIContentWorkbench-Deployer/1"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    if response.status != 200:
                        ready = False
                        last_error = f"{url} returned HTTP {response.status}"
                        break
            except (OSError, urllib.error.URLError) as exc:
                ready = False
                last_error = str(exc)
                break
        if ready:
            return {
                "status": "passed",
                "runtime_url": urls[0],
                "web_url": urls[1],
                "activation_mode": "post_installer_detached",
            }
        time.sleep(0.8)
    raise DeploymentError(f"网页工作台服务没有在限定时间内就绪：{last_error}")


def activate_windows_web_services(
    workbench: Path,
    environment: dict[str, Any],
) -> dict[str, Any]:
    """Start long-running services after the captured installer has returned.

    Launch Node directly instead of nesting ``Start-Process`` under a detached
    PowerShell process.  Both services write only to local log files and never
    inherit deployer's captured stdout/stderr pipes.
    """
    web_root = workbench / "系统文件_无需打开" / "tools" / "web-workbench"
    start_script = web_root / "service" / "windows" / "start-services.ps1"
    runtime_entry = web_root / "runtime" / "server.mjs"
    web_entry = web_root / "node_modules" / "vinext" / "dist" / "cli.js"
    if not start_script.is_file() or not runtime_entry.is_file() or not web_entry.is_file():
        raise DeploymentError("安装后缺少网页工作台服务启动文件。")

    log_root = workbench / "系统文件_无需打开" / "logs" / "web-workbench"
    log_root.mkdir(parents=True, exist_ok=True)
    activation_environment = os.environ.copy()
    activation_environment["AI_WORKBENCH_HOME"] = str(workbench)
    node_record = ((environment.get("tools") or {}).get("node") or {})
    node_path = str(node_record.get("path") or "").strip()
    node_executable = Path(node_path) if node_path else None
    if node_executable is None or not node_executable.is_file():
        discovered = shutil.which("node.exe") or shutil.which("node")
        node_executable = Path(discovered) if discovered else None
    if node_executable is None or not node_executable.is_file():
        raise DeploymentError("安装后未找到可执行的 Node.js，无法启动网页工作台。")
    activation_environment["PATH"] = os.pathsep.join(
        (str(node_executable.parent), activation_environment.get("PATH", ""))
    )

    creation_flags = 0
    if os.name == "nt":
        creation_flags = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    specifications = (
        (
            "runtime",
            [str(node_executable), str(runtime_entry)],
            log_root / "runtime-out.log",
            log_root / "runtime-error.log",
        ),
        (
            "web",
            [str(node_executable), str(web_entry), "start", "--host", "127.0.0.1", "--port", "3000"],
            log_root / "web-out.log",
            log_root / "web-error.log",
        ),
    )
    processes: list[tuple[str, subprocess.Popen[bytes], Path]] = []
    for label, command, stdout_path, stderr_path in specifications:
        with stdout_path.open("ab") as stdout_handle, stderr_path.open("ab") as stderr_handle:
            process = subprocess.Popen(
                command,
                cwd=web_root,
                env=activation_environment,
                stdin=subprocess.DEVNULL,
                stdout=stdout_handle,
                stderr=stderr_handle,
                close_fds=True,
                creationflags=creation_flags,
            )
        processes.append((label, process, stderr_path))

    time.sleep(1.2)
    early_failures = []
    for label, process, stderr_path in processes:
        return_code = process.poll()
        if return_code is None:
            continue
        detail = ""
        try:
            detail = stderr_path.read_text(encoding="utf-8", errors="replace")[-800:].strip()
        except OSError:
            pass
        early_failures.append(f"{label} exited {return_code}: {detail}".strip())
    if early_failures:
        for _, process, _ in processes:
            if process.poll() is None:
                process.terminate()
        raise DeploymentError(
            "网页工作台服务启动后立即退出：" + " | ".join(early_failures)
        )

    report = wait_for_windows_web_services()
    report["activation_mode"] = "post_installer_direct_detached_node"
    report["process_ids"] = [process.pid for _, process, _ in processes]
    return report


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


def acquire_verified_package(
    ticket: dict[str, Any],
    manifest: dict[str, Any],
    attempts: dict[str, int],
) -> Path:
    """Reuse a verified immutable package and retry only no-write download failures."""
    paths = session_paths(ticket)
    cache = paths["cache"]
    cache.parent.mkdir(parents=True, exist_ok=True)
    expected_size = int(manifest["package_size_bytes"])
    expected_sha = str(manifest["package_sha256"])
    if cache.is_file():
        if cache.stat().st_size != expected_size or sha256_file(cache) != expected_sha:
            raise DeploymentError("本机部署缓存与不可变版本清单不一致，已停止使用该缓存。")
        attempts["download"] = 0
        return cache

    last_error: DeploymentError | None = None
    for attempt in range(1, MAX_SAFE_RECOVERY_ATTEMPTS + 1):
        attempts["download"] = attempt
        partial = cache.with_name(cache.name + f".{uuid.uuid4().hex}.part")
        try:
            download_package(str(ticket["package_url"]), partial)
            if partial.stat().st_size != expected_size:
                raise DeploymentError("客户包文件大小与不可变版本清单不一致。")
            if sha256_file(partial) != expected_sha:
                raise DeploymentError("客户包 SHA-256 与不可变版本清单不一致。")
            os.replace(partial, cache)
            return cache
        except DeploymentError as exc:
            last_error = exc
            decision = classify_deployment_failure(
                str(exc), platform_id=str(manifest["platform"]), version=str(manifest["version"])
            )
            if not decision["safe_to_retry"] or decision["category"] != "network":
                raise
        finally:
            partial.unlink(missing_ok=True)
    raise last_error or DeploymentError("客户包自动下载没有完成。")


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


def verify_full_workbench_payload(package_dir: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    manifest_path = package_dir / "package_manifest.json"
    if not manifest_path.is_file():
        raise DeploymentError("完整工作台包缺少包体清单。")
    try:
        payload_manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DeploymentError("完整工作台包体清单无法读取。") from exc
    if payload_manifest.get("release_id") != manifest.get("release_id"):
        raise DeploymentError("完整工作台包体清单与发布基线不一致。")
    if payload_manifest.get("version") != manifest.get("payload_version"):
        raise DeploymentError("完整工作台包体版本与不可变清单不一致。")
    if payload_manifest.get("workflow_count") != manifest.get("installed_skill_count"):
        raise DeploymentError("完整工作台包体工作流数量与不可变清单不一致。")
    checksums = payload_manifest.get("checksums")
    if not isinstance(checksums, dict) or not checksums:
        raise DeploymentError("完整工作台包体清单没有文件校验记录。")
    package_root = package_dir.resolve()
    for relative, wanted in checksums.items():
        relative_path = Path(str(relative))
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise DeploymentError("完整工作台包体清单包含越界路径。")
        target = (package_dir / relative_path).resolve()
        if package_root not in target.parents:
            raise DeploymentError("完整工作台包体清单指向包外文件。")
        if not target.is_file() or sha256_file(target) != str(wanted):
            raise DeploymentError("完整工作台包体文件校验没有通过。")
    return payload_manifest


def verify_full_workbench_install(
    source_skills: Path,
    skills_home: Path,
    workbench: Path,
    expected_skill_count: int,
) -> int:
    source_dirs = sorted(path for path in source_skills.iterdir() if path.is_dir())
    if len(source_dirs) != expected_skill_count:
        raise DeploymentError("完整工作台包内工作流数量与不可变清单不一致。")
    checked = 0
    for source_dir in source_dirs:
        target_dir = skills_home / source_dir.name
        if not (target_dir / "SKILL.md").is_file():
            raise DeploymentError(f"安装后缺少工作流：{source_dir.name}")
        for source_file in sorted(path for path in source_dir.rglob("*") if path.is_file()):
            relative = source_file.relative_to(source_dir)
            target_file = target_dir / relative
            if not target_file.is_file() or sha256_file(source_file) != sha256_file(target_file):
                raise DeploymentError(f"安装后工作流文件不一致：{source_dir.name}/{relative}")
            checked += 1
    required = (
        workbench / "AGENTS.md",
        workbench / "00_使用入口.html",
        workbench / "系统文件_无需打开" / "config" / "customer_config.env",
        workbench / "系统文件_无需打开" / "tools" / "web-workbench" / "browser-companion" / "chatgpt-web" / "manifest.json",
    )
    if any(not path.is_file() for path in required):
        raise DeploymentError("安装后缺少工作台核心文件。")
    return checked


def native_backups(workbench: Path) -> set[Path]:
    roots = (
        workbench / "系统文件_无需打开" / "backups",
        workbench / "06_Backups",
    )
    return {
        path
        for root in roots if root.is_dir()
        for path in root.glob("before_install_*") if path.is_dir()
    }


def sync_existing_managed_skill_mirrors(
    source_skills: Path,
    primary_skills_home: Path,
    workbench: Path,
    detection: dict[str, Any],
    ticket_id: str,
) -> list[dict[str, Any]]:
    """Keep pre-existing duplicate managed skills on the same released version.

    Only skill IDs that already exist in a secondary standard root are touched.
    Every touched directory is copied to the workbench backup area first; user
    skills and secondary-only directories are never copied, moved or deleted.
    """
    mirror_values = detection.get("skills_mirrors") or []
    if not isinstance(mirror_values, list) or not mirror_values:
        return []
    source_by_name = {
        path.name: path for path in source_skills.iterdir()
        if path.is_dir() and (path / "SKILL.md").is_file()
    }
    allowed_roots = set(_default_skill_roots())
    backup_parent = (
        workbench / "系统文件_无需打开" / "backups"
        if (workbench / "系统文件_无需打开").is_dir()
        else workbench / "06_Backups"
    )
    safe_ticket = re.sub(r"[^A-Za-z0-9._-]+", "_", ticket_id)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    backup_root = backup_parent / f"before_skill_mirror_sync_{stamp}_{safe_ticket}"
    records: list[dict[str, Any]] = []
    for value in mirror_values:
        mirror = Path(str(value)).expanduser().resolve()
        if mirror == primary_skills_home.resolve():
            continue
        if mirror not in allowed_roots or mirror.is_symlink() or not mirror.is_dir():
            raise DeploymentError("备用工作流目录不属于安全的标准位置，尚未同步。")
        existing = sorted(
            name for name in source_by_name
            if (mirror / name / "SKILL.md").is_file()
        )
        if not existing:
            continue
        label = "codex-skills" if mirror == _default_skill_roots()[0] else "agents-skills"
        checked = 0
        for name in existing:
            source = source_by_name[name]
            target = mirror / name
            if target.is_symlink():
                raise DeploymentError("备用工作流目录包含软链接，尚未同步。")
            backup = backup_root / label / name
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(target, backup)
            shutil.copytree(source, target, dirs_exist_ok=True)
            for source_file in sorted(path for path in source.rglob("*") if path.is_file()):
                relative = source_file.relative_to(source)
                installed = target / relative
                if not installed.is_file() or sha256_file(source_file) != sha256_file(installed):
                    raise DeploymentError("备用工作流目录同步后校验失败；备份已保留。")
                checked += 1
        records.append(
            {
                "skills_home": str(mirror),
                "managed_skills_synchronized": len(existing),
                "source_files_verified": checked,
                "backup_root": str(backup_root / label),
                "unmanaged_skills_preserved": True,
                "directories_deleted_or_moved": False,
            }
        )
    return records


def run_full_workbench_install(
    package_dir: Path,
    workbench: Path,
    skills_home: Path,
    ticket: dict[str, Any],
    manifest: dict[str, Any],
    ticket_source: str,
    environment: dict[str, Any],
    detection: dict[str, Any],
) -> Path:
    install_mode = str(manifest["install_mode"])
    if install_mode == "first_install":
        if workbench.exists() and any(workbench.iterdir()):
            raise DeploymentError("首次安装目标不是空目录，尚未写入。")
    elif _workbench_state(workbench) != "managed":
        raise DeploymentError("累计升级目标不是完整的已安装工作台，尚未写入。")

    verify_full_workbench_payload(package_dir, manifest)
    backups_before = native_backups(workbench)
    layout_contract = detection.get("layout_contract") or inspect_workbench_layout(workbench)
    validated_layout = str(layout_contract.get("layout_id") or "")
    if manifest["platform"] == "macos":
        installer = package_dir / "mac" / "tools" / "install_ai_content_workbench.sh"
        if not installer.is_file():
            raise DeploymentError("Mac 完整工作台包缺少正式安装器。")
        installer_environment = os.environ.copy()
        if validated_layout:
            installer_environment["AICW_VALIDATED_LAYOUT"] = validated_layout
        result = subprocess.run(
            ["bash", str(installer)],
            input=f"{workbench}\n{skills_home}\nYES\n",
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            env=installer_environment,
        )
    else:
        installer = package_dir / "installer" / "Install_AI_Content_Workbench.ps1"
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not installer.is_file() or not powershell:
            raise DeploymentError("Windows 完整工作台包缺少正式安装器或 PowerShell。")
        result = subprocess.run(
            [
                powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(installer),
                "-WorkspaceRoot", str(workbench), "-CodexSkillsHome", str(skills_home),
                "-ValidatedLayout", validated_layout,
            ],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
        )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "正式安装器没有返回说明").strip()
        raise DeploymentError(f"正式安装器阻塞：{message[-1200:]}")

    checked = verify_full_workbench_install(
        package_dir / "codex_skills",
        skills_home,
        workbench,
        int(manifest["installed_skill_count"]),
    )
    mirror_records = sync_existing_managed_skill_mirrors(
        package_dir / "codex_skills",
        skills_home,
        workbench,
        detection,
        str(ticket["ticket_id"]),
    )
    new_backups = native_backups(workbench) - backups_before
    backup_root = next(iter(new_backups)) if len(new_backups) == 1 else None
    if install_mode == "incremental_upgrade" and backup_root is None:
        raise DeploymentError("安装完成但没有找到本次唯一升级备份。")
    service_activation: dict[str, Any]
    if manifest["platform"] == "windows":
        service_activation = activate_windows_web_services(workbench, environment)
    else:
        service_activation = {"status": "managed_by_installer", "activation_mode": "platform_native"}
    module_readiness = collect_module_readiness(workbench, skills_home, environment)
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
        "install_mode": install_mode,
        "package_contract": "full_workbench_v1",
        "package_sha256": manifest["package_sha256"],
        "workbench": str(workbench),
        "skills_home": str(skills_home),
        "skills_recovery": detection.get("skills_recovery", "not_needed"),
        "skills_mirror_sync": mirror_records,
        "layout_contract": layout_contract,
        "backup_record": str(backup_root) if backup_root else "not_applicable_fresh_environment",
        "post_install_tree_verification": "passed",
        "post_install_identity_files_checked": checked,
        "environment_preflight": environment,
        "service_activation": service_activation,
        "module_readiness": module_readiness,
        "customer_summary": customer_summary(
            manifest,
            {"install_mode": install_mode},
            environment,
            phase="apply",
            module_readiness=module_readiness,
        ),
        "paid_calls": 0,
        "external_uploads": 0,
        "rollback": "requires_separate_explicit_confirmation",
    }
    temporary = receipt_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, receipt_path)
    return receipt_path


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
    if manifest["platform"] == "macos":
        installer = package_dir / "mac" / "tools" / "install_ai_content_workbench.sh"
        if not installer.is_file():
            raise DeploymentError("Mac 首次安装包缺少正式安装器。")
        result = subprocess.run(
            ["bash", str(installer)],
            input=f"{workbench}\n{skills_home}\nYES\n",
            text=True,
            encoding="utf-8",
            errors="replace",
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
            encoding="utf-8",
            errors="replace",
            capture_output=True,
        )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "首次安装器没有返回说明").strip()
        raise DeploymentError(f"首次安装器阻塞：{message[-1200:]}")
    checked = verify_first_install(package_dir / "codex_skills", skills_home, workbench)
    module_readiness = collect_module_readiness(workbench, skills_home, environment)
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
        "module_readiness": module_readiness,
        "customer_summary": customer_summary(
            manifest,
            {"install_mode": "first_install"},
            environment,
            phase="apply",
            module_readiness=module_readiness,
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
    can_confirm = environment["status"] == "ready" or (
        environment.get("bootstrap") or {}
    ).get("status") == "available"
    result = {
        # Keep the normal stdout customer-safe.  Detailed ticket, path, hash
        # and dependency evidence remains in the internal receipt/log path.
        "customer_summary": customer_summary(manifest, detection, environment, phase="inspect"),
        "write_performed": False,
        "next_step": (
            "回复“同意执行”后，自动补齐支持的基础环境并继续安装。"
            if can_confirm
            else "请先由电脑管理员启用系统安装工具，再重新检查。"
        ),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if can_confirm else 2


def deployment_status(args: argparse.Namespace) -> int:
    ticket, manifest, _, _, _ = load_context(args)
    checkpoint = session_paths(ticket)["checkpoint"]
    if not checkpoint.is_file():
        result = {
            "current_conclusion": "尚未开始安装。",
            "can_resume_automatically": False,
            "next_step": "先完成只读检查；确认后再开始部署。",
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    try:
        state = json.loads(checkpoint.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DeploymentError("部署断点记录无法读取。") from exc
    for key, expected in (
        ("ticket_id", ticket["ticket_id"]),
        ("package_sha256", manifest["package_sha256"]),
        ("version", manifest["version"]),
    ):
        if state.get(key) != expected:
            raise DeploymentError("部署断点与当前票据不一致，不能自动继续。")
    incident = state.get("incident") if isinstance(state.get("incident"), dict) else {}
    can_resume = state.get("status") == "blocked" and bool(incident.get("safe_to_retry"))
    result = {
        "current_conclusion": (
            "部署已经完成并通过验收。"
            if state.get("status") == "completed"
            else str(incident.get("customer_message") or "部署已经保存进度。")
        ),
        "stage": state.get("stage"),
        "can_resume_automatically": can_resume,
        "next_step": (
            "Codex 可以直接从断点自动继续，不需要再次询问使用者。"
            if can_resume
            else "请按当前结论处理；不要盲目重复安装。"
        ),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def resume(args: argparse.Namespace) -> int:
    ticket, manifest, _, _, _ = load_context(args)
    checkpoint = session_paths(ticket)["checkpoint"]
    if not checkpoint.is_file():
        raise DeploymentError("没有找到已经确认过的部署断点，不能跳过首次确认。")
    try:
        state = json.loads(checkpoint.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DeploymentError("部署断点记录无法读取。") from exc
    incident = state.get("incident") if isinstance(state.get("incident"), dict) else {}
    same_deployment = (
        state.get("ticket_id") == ticket["ticket_id"]
        and state.get("package_sha256") == manifest["package_sha256"]
        and state.get("version") == manifest["version"]
    )
    if not same_deployment:
        raise DeploymentError("部署断点与当前票据不一致，不能自动继续。")
    if state.get("status") != "blocked" or not incident.get("safe_to_retry"):
        raise DeploymentError("当前问题不在安全自动恢复范围内，不能强行继续。")
    args.confirm_write = "YES"
    return apply(args)


def apply(args: argparse.Namespace) -> int:
    if args.confirm_write != "YES":
        raise DeploymentError("尚未获得明确写入确认；当前没有下载或安装。")
    ticket, manifest, workbench, skills_home, detection = load_context(args)
    attempts: dict[str, int] = {}
    stage = "context_validated"
    write_checkpoint(ticket, manifest, stage=stage, status="running", attempts=attempts)
    try:
        ensure_ticket_time_window(ticket)
        environment = environment_report(manifest)
        if environment["status"] != "ready":
            attempts["dependency_bootstrap"] = 1
            bootstrap_result = bootstrap_missing_dependencies(manifest, environment)
            environment = bootstrap_result["environment_after"]
            validate_ticket(ticket)
        else:
            bootstrap_result = {
                "status": "not_needed",
                "method": None,
                "attempted_tools": [],
                "records": [],
            }
        stage = "dependencies_ready"
        write_checkpoint(ticket, manifest, stage=stage, status="running", attempts=attempts)

        archive = acquire_verified_package(ticket, manifest, attempts)
        stage = "package_verified"
        write_checkpoint(ticket, manifest, stage=stage, status="running", attempts=attempts)

        with tempfile.TemporaryDirectory(prefix="aicw-deploy-") as temporary_name:
            temporary = Path(temporary_name)
            extracted = temporary / "extracted"
            extracted.mkdir()
            safe_extract(archive, extracted)
            stage = "package_extracted"
            write_checkpoint(ticket, manifest, stage=stage, status="running", attempts=attempts)
            package_root = extracted / str(manifest["package_root"])
            package_dir = package_root / str(manifest["package_subdir"])
            attempts["installer"] = 1
            stage = "installer_running"
            write_checkpoint(ticket, manifest, stage=stage, status="running", attempts=attempts)
            if manifest.get("package_contract") == "full_workbench_v1":
                receipt = run_full_workbench_install(
                    package_dir, workbench, skills_home, ticket, manifest, args.ticket, environment, detection
                )
                backup_record = None
            elif manifest["install_mode"] == "incremental_upgrade":
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
        stage = "installed_and_verified"
        write_checkpoint(ticket, manifest, stage=stage, status="completed", attempts=attempts)
    except DeploymentError as exc:
        decision = classify_deployment_failure(
            str(exc), platform_id=str(manifest["platform"]), version=str(manifest["version"])
        )
        normalized = redact_error_text(str(exc))
        incident = {
            "category": decision["category"],
            "action": decision["action"],
            "safe_to_retry": decision["safe_to_retry"],
            "rule_id": decision["rule_id"],
            "error_fingerprint": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
            "technical_summary": normalized,
            "customer_message": decision["customer_message"],
            "stage_when_blocked": stage,
        }
        write_checkpoint(
            ticket, manifest, stage=stage, status="blocked", attempts=attempts, incident=incident
        )
        raise DeploymentError(str(decision["customer_message"])) from exc
    print(
        json.dumps(
            {
                # Technical receipt, hashes and backup paths stay on disk;
                # stdout is deliberately limited to the customer result.
                "customer_summary": customer_summary(manifest, detection, environment, phase="apply"),
                "write_performed": True,
                "next_step": "重新打开工作台，再按中文入口做一次不付费、不上传的功能确认。",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI 内容工作台受控部署入口")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, handler in (
        ("inspect", inspect),
        ("apply", apply),
        ("status", deployment_status),
        ("resume", resume),
    ):
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
