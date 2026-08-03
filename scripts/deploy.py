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
import hashlib
import json
import os
from pathlib import Path
import platform as platform_lib
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any
import urllib.parse
import urllib.request
import zipfile


PRODUCT_ID = "ai-content-workbench"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


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


def fetch_bytes(source: str, *, timeout: int = 60) -> bytes:
    local = _local_path(source)
    if local is not None:
        if not local.is_file():
            raise DeploymentError("找不到本地文件。")
        return local.read_bytes()
    parsed = urllib.parse.urlsplit(source)
    if parsed.scheme != "https":
        raise DeploymentError("远程地址必须使用 HTTPS。")
    request = urllib.request.Request(source, headers={"User-Agent": "AIContentWorkbench-Deployer/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except Exception as exc:
        raise DeploymentError(f"无法读取远程文件：{type(exc).__name__}") from exc


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


def disk_check(workbench: Path, package_size: int) -> None:
    anchor = workbench if workbench.exists() else workbench.parent
    while not anchor.exists() and anchor != anchor.parent:
        anchor = anchor.parent
    free = shutil.disk_usage(anchor).free
    required = max(package_size * 4, 500 * 1024 * 1024)
    if free < required:
        raise DeploymentError("磁盘空间不足，至少需要约 500 MB 可用空间。")


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
        raise DeploymentError(f"客户包下载失败：{type(exc).__name__}") from exc


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
) -> Path:
    record = json.loads(backup_record.read_text(encoding="utf-8"))
    if record.get("status") != "installed":
        raise DeploymentError("备份记录没有标记为安装完成。")
    identity_actions = 0
    module_receipt_path: Path | None = None
    for action in record.get("actions") or []:
        if action.get("label") == "模块安装记录":
            module_receipt_path = Path(str(action.get("target") or "")).expanduser().resolve()
            continue
        if action.get("status") == "kept_existing":
            continue
        if action.get("status") != "installed":
            raise DeploymentError("备份记录包含未完成的安装动作。")
        source_sha = str(action.get("source_tree_sha256") or "")
        installed_sha = str(action.get("installed_tree_sha256") or "")
        if not source_sha or source_sha != installed_sha:
            raise DeploymentError("安装后文件指纹核验没有通过。")
        identity_actions += 1
    if module_receipt_path is None or not module_receipt_path.is_file():
        raise DeploymentError("找不到升级包生成的模块安装记录。")
    module_receipt = json.loads(module_receipt_path.read_text(encoding="utf-8"))
    if module_receipt.get("post_install_tree_verification") != "passed":
        raise DeploymentError("模块安装记录没有通过安装后指纹核验。")
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
        "paid_calls": 0,
        "external_uploads": 0,
        "rollback": "requires_separate_explicit_confirmation",
    }
    temporary = receipt_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, receipt_path)
    return receipt_path


def load_context(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], Path, Path]:
    ticket = fetch_json(args.ticket)
    validate_ticket(ticket)
    manifest_source = args.manifest or str(ticket["manifest_url"])
    manifest = fetch_json(manifest_source)
    validate_manifest(manifest, ticket)
    workbench = resolve_workbench(args.workbench, str(ticket["install_mode"]))
    skills_home = resolve_skills_home(args.skills_home)
    disk_check(workbench, int(ticket["package_size_bytes"]))
    return ticket, manifest, workbench, skills_home


def inspect(args: argparse.Namespace) -> int:
    ticket, manifest, workbench, skills_home = load_context(args)
    result = {
        "status": "ready_for_confirmation",
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
        "workbench": str(workbench),
        "skills_home": str(skills_home),
        "package_sha256": manifest["package_sha256"],
        "next_step": "Explain scope and backup boundary, then wait for explicit approval.",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def apply(args: argparse.Namespace) -> int:
    if args.confirm_write != "YES":
        raise DeploymentError("尚未获得明确写入确认；当前没有下载或安装。")
    ticket, manifest, workbench, skills_home = load_context(args)
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
            workbench, skills_home, ticket, manifest, args.ticket, backup_record
        )
    print(
        json.dumps(
            {
                "status": "installed_and_verified",
                "version": manifest["version"],
                "platform": manifest["platform"],
                "package_sha256": manifest["package_sha256"],
                "backup_record": str(backup_record),
                "receipt": str(receipt),
                "paid_calls": 0,
                "external_uploads": 0,
                "next_step": "Restart Codex and run the no-cost business recognition checks.",
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
