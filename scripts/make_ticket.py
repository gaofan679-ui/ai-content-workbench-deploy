#!/usr/bin/env python3
"""Create a customer deployment ticket from already-presigned package URLs."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys
import uuid
import urllib.parse


SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


def fail(message: str) -> int:
    print(f"不能创建票据：{message}", file=sys.stderr)
    return 2


def main() -> int:
    parser = argparse.ArgumentParser(description="创建 AI 内容工作台客户部署票据")
    parser.add_argument("--customer-id", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--manifest-url")
    parser.add_argument("--package-url")
    parser.add_argument(
        "--artifact", nargs=3, action="append", metavar=("MANIFEST", "MANIFEST_URL", "PACKAGE_URL"),
        help="可重复四次，依次提供本地版本清单、不可变清单 URL、限时客户包 URL。",
    )
    parser.add_argument("--expires-in-hours", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-local-test", action="store_true")
    args = parser.parse_args()

    output = Path(args.output).expanduser().resolve()
    repository_root = Path(__file__).resolve().parents[1]
    if repository_root == output or repository_root in output.parents:
        return fail("客户票据不得写入 GitHub 仓库目录。")
    if output.exists():
        return fail("输出文件已存在；不得覆盖历史票据。")
    if not 1 <= args.expires_in_hours <= 168:
        return fail("有效期必须在 1 小时到 7 天之间。")
    artifact_args = args.artifact or []
    if not artifact_args:
        if not all((args.manifest, args.manifest_url, args.package_url)):
            return fail("请提供一组旧式参数，或用 --artifact 提供自动识别所需客户包。")
        artifact_args = [[args.manifest, args.manifest_url, args.package_url]]
    artifacts: list[dict] = []
    versions: set[str] = set()
    keys: set[tuple[str, str]] = set()
    for manifest_name, manifest_url, package_url in artifact_args:
        manifest_path = Path(manifest_name).expanduser().resolve()
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return fail(f"版本清单无法读取：{exc}")
        sha = str(manifest.get("package_sha256") or "")
        if not SHA256_RE.fullmatch(sha):
            return fail("版本清单 SHA-256 无效。")
        key = (str(manifest.get("platform")), str(manifest.get("install_mode")))
        if key in keys:
            return fail("平台和安装模式重复。")
        keys.add(key)
        versions.add(str(manifest.get("version")))
        if not args.allow_local_test:
            if urllib.parse.urlsplit(package_url).scheme != "https" or urllib.parse.urlsplit(manifest_url).scheme != "https":
                return fail("正式票据的客户包和版本清单地址必须使用 HTTPS。")
        artifacts.append(
            {
                "platform": key[0],
                "install_mode": key[1],
                "manifest_url": manifest_url,
                "package_url": package_url,
                "package_size_bytes": manifest["package_size_bytes"],
                "package_sha256": sha,
            }
        )
    if len(versions) != 1:
        return fail("同一张票据中的客户包版本必须一致。")

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    expires = now + dt.timedelta(hours=args.expires_in_hours)
    customer_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", args.customer_id).strip("-")
    if len(customer_slug) < 2:
        return fail("客户标识过短或不合格。")
    ticket_id = f"{customer_slug}-auto-{now:%Y%m%d%H%M}-{uuid.uuid4().hex[:8]}"
    ticket = {
        "schema_version": 2 if len(artifacts) > 1 else 1,
        "ticket_id": ticket_id,
        "customer_id": args.customer_id,
        "issued_at": now.isoformat().replace("+00:00", "Z"),
        "expires_at": expires.isoformat().replace("+00:00", "Z"),
        "product_id": "ai-content-workbench",
        "version": next(iter(versions)),
        "note": "部署票据和客户包链接不得公开或转发；到期后重新签发。",
    }
    if len(artifacts) > 1:
        ticket["artifacts"] = artifacts
    else:
        ticket.update(artifacts[0])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(ticket, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": "created",
                "ticket_path": str(output),
                "ticket_id": ticket_id,
                "expires_at": ticket["expires_at"],
                "package_url_logged": False,
                "artifact_count": len(artifacts),
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
