#!/usr/bin/env python3
"""Static guard for the public deployment-entry repository."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SHA_RE = re.compile(r"^[a-f0-9]{64}$")
SECRET_PATTERNS = (
    re.compile(r"(?i)(api[_-]?key|secret[_-]?key|access[_-]?token)\s*[=:]\s*['\"]?[A-Za-z0-9_\-]{12,}"),
    re.compile("X-Amz-" + "Signature=", re.I),
    re.compile("Authorization:" + r"\s*Bearer\s+\S+", re.I),
)


def main() -> int:
    errors: list[str] = []
    required = [
        ROOT / "README.md",
        ROOT / "CODEX_DEPLOYMENT.md",
        ROOT / "PILOT_TEST.md",
        ROOT / "channels" / "pilot.json",
        ROOT / "scripts" / "deploy.py",
        ROOT / "scripts" / "make_ticket.py",
        ROOT / "scripts" / "summarize_receipts.py",
    ]
    for path in required:
        if not path.is_file():
            errors.append(f"缺少文件：{path.relative_to(ROOT)}")

    try:
        channel = json.loads((ROOT / "channels" / "pilot.json").read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"pilot 通道无法解析：{exc}")
        channel = {}
    for platform_name, modes in (channel.get("manifests") or {}).items():
        if not isinstance(modes, dict):
            errors.append(f"平台清单必须区分首次安装和升级：{platform_name}")
            continue
        for install_mode, relative in modes.items():
            path = ROOT / relative
            if not path.is_file():
                errors.append(f"通道引用不存在：{relative}")
                continue
            try:
                manifest = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                errors.append(f"版本清单无法解析：{relative}: {exc}")
                continue
            if manifest.get("platform") != platform_name:
                errors.append(f"平台登记不一致：{relative}")
            if manifest.get("install_mode") != install_mode:
                errors.append(f"安装模式登记不一致：{relative}")
            if manifest.get("version") != channel.get("version"):
                errors.append(f"版本登记不一致：{relative}")
            if manifest.get("release_tag") != channel.get("release_tag"):
                errors.append(f"Release 标签不一致：{relative}")
            if not SHA_RE.fullmatch(str(manifest.get("package_sha256") or "")):
                errors.append(f"包 SHA-256 无效：{relative}")
            if "package_url" in manifest:
                errors.append(f"公开版本清单不得包含客户包 URL：{relative}")

    public_files = [
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and ".git" not in path.parts
        and "__pycache__" not in path.parts
        and path.suffix.lower() != ".pyc"
    ]
    checked_text = 0
    for path in public_files:
        if path.suffix.lower() == ".zip" or path.name.endswith(".ticket.json"):
            errors.append(f"公开仓库包含禁止文件：{path.relative_to(ROOT)}")
            continue
        if path.suffix.lower() not in {".md", ".json", ".py", ".yml", ".yaml", ""}:
            continue
        checked_text += 1
        text = path.read_text(encoding="utf-8")
        for pattern in SECRET_PATTERNS:
            if pattern.search(text):
                errors.append(f"疑似密钥或签名 URL：{path.relative_to(ROOT)}")

    tree = hashlib.sha256()
    for path in sorted(public_files, key=lambda item: str(item.relative_to(ROOT))):
        relative = str(path.relative_to(ROOT)).replace("\\", "/").encode("utf-8")
        tree.update(relative + b"\0")
        tree.update(hashlib.sha256(path.read_bytes()).digest())
    result = {
        "status": "pass" if not errors else "blocked",
        "checked_text_files": checked_text,
        "errors": errors,
        "tree_sha256": tree.hexdigest(),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
