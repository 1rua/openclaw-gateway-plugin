#!/usr/bin/env python3
"""检查包内契约快照是否与主仓固定提交一致。"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from contract_source import CONTRACT_PATHS, ContractPinError, load_pinned_contract

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_ROOT = PLUGIN_ROOT / "gateway-contract"


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
        pinned_contract = load_pinned_contract(PLUGIN_ROOT)
    except ContractPinError as error:
        return fail(str(error))
    revision = pinned_contract.revision
    source_root = pinned_contract.root

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
