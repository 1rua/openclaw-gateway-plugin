#!/usr/bin/env python3
"""Generate the installable contract snapshot from the pinned app commit."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PIN_FILE = PLUGIN_ROOT / "contract-pin.json"
EXPECTED_REPOSITORY = "https://github.com/1rua/open-android-intelligence.git"
CONTRACT_PATHS = (
    "core-dispatched-schemas.json",
    "schemas",
    "src",
    "vectors",
)
REQUIRED_SCHEMAS = (
    "attachment.schema.json",
    "command-catalog.schema.json",
    "conversation-snapshot.schema.json",
    "conversation.schema.json",
    "device-request.schema.json",
    "envelope.schema.json",
    "event.schema.json",
    "negotiate.schema.json",
    "session.schema.json",
    "v1-bootstrap-export.schema.json",
)


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
    source_root = (
        Path(configured_root).expanduser()
        if configured_root
        else PLUGIN_ROOT / ".contract-source" / "gateway-contract"
    )
    if not source_root.is_dir():
        return fail(
            f"找不到 pin 对应的 gateway-contract：{source_root}；"
            "请检出 contract-pin.json 所指提交，或设置 OPEN_ANDROID_GATEWAY_CONTRACT_ROOT"
        )

    try:
        source_root = source_root.resolve(strict=True)
        repository_root_result = subprocess.run(
            ["git", "-C", str(source_root.parent), "rev-parse", "--show-toplevel"],
            capture_output=True,
            check=False,
            text=True,
        )
        if repository_root_result.returncode != 0:
            return fail(f"契约路径不属于 Git 工作树：{source_root}")
        source_repo = Path(repository_root_result.stdout.strip()).resolve(strict=True)
        expected_source_root = (source_repo / "gateway-contract").resolve(strict=True)
        if source_root != expected_source_root:
            return fail(f"契约路径必须是 pin 仓库根目录下的 gateway-contract：{expected_source_root}")
    except OSError as error:
        return fail(f"无法定位契约所属仓库：{error}")

    try:
        present = subprocess.run(
            ["git", "-C", str(source_repo), "cat-file", "-e", f"{revision}^{{commit}}"],
            capture_output=True,
            check=False,
        )
        if present.returncode != 0:
            return fail(f"契约 pin 提交 {revision} 不在当前检出历史中")
        untracked = subprocess.run(
            [
                "git",
                "-C",
                str(source_repo),
                "ls-files",
                "--others",
                "--",
                *(f"gateway-contract/{path}" for path in CONTRACT_PATHS),
            ],
            capture_output=True,
            check=False,
            text=True,
        )
        if untracked.returncode != 0:
            return fail("无法检查 pin 路径下的未跟踪契约文件")
        untracked_paths = [path for path in untracked.stdout.splitlines() if path]
        if untracked_paths:
            return fail(f"pin 路径含有不属于固定提交的未跟踪文件：{', '.join(untracked_paths)}")
        unchanged = subprocess.run(
            [
                "git",
                "-C",
                str(source_repo),
                "diff",
                "--quiet",
                revision,
                "--",
                *(f"gateway-contract/{path}" for path in CONTRACT_PATHS),
            ],
            capture_output=True,
            check=False,
        )
        if unchanged.returncode != 0:
            return fail(f"当前检出的契约内容与 pin 提交 {revision} 不一致")
    except OSError as error:
        return fail(f"无法校验契约 pin 提交：{error}")

    required = [source_root / "schemas" / name for name in REQUIRED_SCHEMAS]
    missing = [path.relative_to(source_root).as_posix() for path in required if not path.is_file()]
    if missing:
        return fail(f"pin 对应提交缺少必需 Schema：{', '.join(missing)}")

    sources = [source_root / relative for relative in CONTRACT_PATHS]
    missing_paths = [relative for relative, source in zip(CONTRACT_PATHS, sources, strict=True) if not source.exists()]
    if missing_paths:
        return fail(f"pin 对应提交缺少契约路径：{', '.join(missing_paths)}")
    for relative, source in zip(CONTRACT_PATHS, sources, strict=True):
        if source.is_symlink():
            return fail(f"契约源不允许符号链接：{relative}")
        if source.is_dir() and any(path.is_symlink() for path in source.rglob("*")):
            return fail(f"契约源目录不允许符号链接：{relative}")

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
