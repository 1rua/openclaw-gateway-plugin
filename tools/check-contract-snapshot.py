#!/usr/bin/env python3
"""Verify the generated Gateway Protocol snapshot against its pinned commit."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PIN_FILE = PLUGIN_ROOT / "contract-pin.json"
SNAPSHOT_ROOT = PLUGIN_ROOT / "gateway-contract"
CONTRACT_PATHS = (
    "core-dispatched-schemas.json",
    "schemas",
    "src",
    "vectors",
)
EXPECTED_REPOSITORY = "https://github.com/1rua/open-android-intelligence.git"


def fail(message: str) -> int:
    print(f"契约快照校验失败：{message}", file=sys.stderr)
    return 1


def files_under(root: Path, relative: str) -> dict[str, str] | None:
    base = root / relative
    if not base.exists():
        return None
    if base.is_file():
        return {relative: hashlib.sha256(base.read_bytes()).hexdigest()}
    results: dict[str, str] = {}
    for path in sorted(base.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"契约快照不允许符号链接：{path}")
        if path.is_file():
            name = path.relative_to(root).as_posix()
            results[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return results


def main() -> int:
    try:
        pin = json.loads(PIN_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return fail(f"无法读取 {PIN_FILE}: {error}")

    repository = str(pin.get("repository", "")).strip()
    revision = str(pin.get("revision", "")).strip()
    if repository != EXPECTED_REPOSITORY:
        return fail(f"repository 必须为 {EXPECTED_REPOSITORY}")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        return fail("revision 必须是 40 位小写十六进制完整提交 SHA")

    configured_root = os.environ.get("OPEN_ANDROID_GATEWAY_CONTRACT_ROOT", "").strip()
    source_root = Path(configured_root).expanduser() if configured_root else PLUGIN_ROOT / ".contract-source" / "gateway-contract"
    if not source_root.is_dir():
        return fail(
            f"找不到 pin 对应的 gateway-contract：{source_root}；"
            "请检出 contract-pin.json 所指提交，或设置 OPEN_ANDROID_GATEWAY_CONTRACT_ROOT"
        )

    source_repo = source_root.parent
    try:
        checked_out_revision = subprocess.run(
            ["git", "-C", str(source_repo), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        return fail(f"无法验证契约检出提交：{error}")
    if checked_out_revision != revision:
        return fail(f"契约检出为 {checked_out_revision}，pin 要求 {revision}")

    try:
        for relative in CONTRACT_PATHS:
            source_files = files_under(source_root, relative)
            snapshot_files = files_under(SNAPSHOT_ROOT, relative)
            if source_files is None or snapshot_files is None:
                return fail(f"缺少契约路径：{relative}")
            if source_files != snapshot_files:
                return fail(f"生成快照与 pin 内容不一致：{relative}")
    except (OSError, ValueError) as error:
        return fail(str(error))

    print(f"契约快照通过：{revision}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
