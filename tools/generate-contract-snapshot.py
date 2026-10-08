#!/usr/bin/env python3
"""从主仓固定提交生成可安装的 Gateway Protocol 契约快照。"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

from contract_source import CONTRACT_PATHS, ContractPinError, load_pinned_contract

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> int:
    print(f"契约快照生成失败：{message}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="输出根目录；目录必须尚不存在，生成内容位于其 gateway-contract/ 子目录",
    )
    args = parser.parse_args()

    try:
        pinned_contract = load_pinned_contract(PLUGIN_ROOT)
    except ContractPinError as error:
        return fail(str(error))
    revision = pinned_contract.revision
    source_root = pinned_contract.root
    sources = [source_root / relative for relative in CONTRACT_PATHS]

    output_root = args.output.expanduser().resolve()
    if output_root.exists():
        return fail(f"输出目录已存在，为避免混入旧文件拒绝覆盖：{output_root}")
    try:
        output_root.parent.mkdir(parents=True, exist_ok=True)
        staging_parent = output_root.parent / ".contract-staging"
        staging_parent.mkdir(parents=True, exist_ok=True)
        staging_root = Path(tempfile.mkdtemp(prefix=f"{output_root.name}-", dir=staging_parent))
        destination = staging_root / "gateway-contract"
        destination.mkdir()
        for relative, source in zip(CONTRACT_PATHS, sources, strict=True):
            target = destination / relative
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        if output_root.exists():
            return fail(f"生成期间输出目录已被创建，拒绝覆盖：{output_root}")
        staging_root.rename(output_root)
    except (OSError, ValueError) as error:
        return fail(str(error))

    print(f"已从契约 pin {revision} 生成快照：{output_root / 'gateway-contract'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
