#!/usr/bin/env python3
"""Summarize deployment receipts without exposing ticket or package URLs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="汇总 AI 内容工作台多机部署回执")
    parser.add_argument("receipts", nargs="+")
    args = parser.parse_args()

    rows: list[dict] = []
    errors: list[str] = []
    ticket_ids: set[str] = set()
    for raw in args.receipts:
        path = Path(raw).expanduser().resolve()
        try:
            receipt = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"无法读取 {path.name}: {exc}")
            continue
        ticket_id = str(receipt.get("ticket_id") or "")
        if not ticket_id or ticket_id in ticket_ids:
            errors.append(f"票据重复或缺失：{path.name}")
        ticket_ids.add(ticket_id)
        passed = (
            receipt.get("status") == "installed_and_verified"
            and receipt.get("post_install_tree_verification") == "passed"
            and int(receipt.get("post_install_identity_actions_checked") or 0) > 0
            and receipt.get("paid_calls") == 0
            and receipt.get("external_uploads") == 0
        )
        if not passed:
            errors.append(f"回执未通过：{path.name}")
        rows.append(
            {
                "receipt_file": path.name,
                "ticket_id": ticket_id,
                "customer_id": receipt.get("customer_id"),
                "platform": receipt.get("platform"),
                "version": receipt.get("version"),
                "release_tag": receipt.get("release_tag"),
                "package_sha256": receipt.get("package_sha256"),
                "identity_actions_checked": receipt.get("post_install_identity_actions_checked"),
                "status": "pass" if passed else "blocked",
            }
        )
    platforms = sorted({str(row.get("platform")) for row in rows if row.get("status") == "pass"})
    result = {
        "status": "pass" if not errors else "blocked",
        "receipt_count": len(rows),
        "unique_ticket_count": len(ticket_ids),
        "platforms_passed": platforms,
        "stable_promotion_ready": not errors and {"macos", "windows"}.issubset(platforms),
        "rows": rows,
        "errors": errors,
        "sensitive_urls_included": False,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())

