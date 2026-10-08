#!/usr/bin/env python3
"""校验并定位唯一的、由主仓提交固定的 Gateway Protocol 契约目录。"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

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


class ContractPinError(ValueError):
    """契约 pin 或工作树与固定契约不一致。"""


@dataclass(frozen=True)
class PinnedContract:
    revision: str
    repository_root: Path
    root: Path


def _git(repository_root: Path, *arguments: str, text: bool = False) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(repository_root), *arguments],
        capture_output=True,
        check=False,
        text=text,
    )


def load_pinned_contract(plugin_root: Path) -> PinnedContract:
    """确认源目录、Git 工作树和完整提交 pin 指向同一份契约。"""

    pin_file = plugin_root / "contract-pin.json"
    try:
        pin = json.loads(pin_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ContractPinError(f"无法读取 {pin_file}: {error}") from error

    repository = str(pin.get("repository", "")).strip()
    revision = str(pin.get("revision", "")).strip()
    if repository != EXPECTED_REPOSITORY:
        raise ContractPinError(f"repository 必须为 {EXPECTED_REPOSITORY}")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ContractPinError("revision 必须是 40 位小写十六进制完整提交 SHA")

    configured_root = os.environ.get("OPEN_ANDROID_GATEWAY_CONTRACT_ROOT", "").strip()
    source_root = (
        Path(configured_root).expanduser()
        if configured_root
        else plugin_root / ".contract-source" / "gateway-contract"
    )
    if not source_root.is_dir():
        raise ContractPinError(
            f"找不到 pin 对应的 gateway-contract：{source_root}；"
            "请检出 contract-pin.json 所指提交，或设置 OPEN_ANDROID_GATEWAY_CONTRACT_ROOT"
        )
    if source_root.is_symlink():
        raise ContractPinError(f"契约目录本身不允许是符号链接：{source_root}")

    try:
        source_root = source_root.resolve(strict=True)
        repository_result = _git(source_root.parent, "rev-parse", "--show-toplevel", text=True)
        if repository_result.returncode != 0:
            raise ContractPinError(f"契约路径不属于 Git 工作树：{source_root}")
        repository_root = Path(repository_result.stdout.strip()).resolve(strict=True)
        expected_root = repository_root / "gateway-contract"
        if expected_root.is_symlink() or not expected_root.is_dir():
            raise ContractPinError(f"pin 仓库缺少规范契约目录：{expected_root}")
        expected_root = expected_root.resolve(strict=True)
        if source_root != expected_root:
            raise ContractPinError(f"契约路径必须是 pin 仓库根目录下的 gateway-contract：{expected_root}")
    except OSError as error:
        raise ContractPinError(f"无法定位契约所属仓库：{error}") from error

    try:
        present = _git(repository_root, "cat-file", "-e", f"{revision}^{{commit}}")
        if present.returncode != 0:
            raise ContractPinError(f"契约 pin 提交 {revision} 不在当前检出历史中")

        untracked = _git(
            repository_root,
            "ls-files",
            "--others",
            "--",
            *(f"gateway-contract/{path}" for path in CONTRACT_PATHS),
            text=True,
        )
        if untracked.returncode != 0:
            raise ContractPinError("无法检查 pin 路径下的未跟踪契约文件")
        untracked_paths = [path for path in untracked.stdout.splitlines() if path]
        if untracked_paths:
            raise ContractPinError(f"pin 路径含有不属于固定提交的未跟踪文件：{', '.join(untracked_paths)}")

        unchanged = _git(
            repository_root,
            "diff",
            "--quiet",
            revision,
            "--",
            *(f"gateway-contract/{path}" for path in CONTRACT_PATHS),
        )
        if unchanged.returncode != 0:
            raise ContractPinError(f"当前检出的契约内容与 pin 提交 {revision} 不一致")
    except OSError as error:
        raise ContractPinError(f"无法校验契约 pin 提交：{error}") from error

    required = [source_root / "schemas" / name for name in REQUIRED_SCHEMAS]
    missing_schemas = [path.relative_to(source_root).as_posix() for path in required if not path.is_file()]
    if missing_schemas:
        raise ContractPinError(f"pin 对应提交缺少必需 Schema：{', '.join(missing_schemas)}")

    expected_files = {"core-dispatched-schemas.json"}
    for relative in CONTRACT_PATHS:
        path = source_root / relative
        if not path.exists():
            raise ContractPinError(f"pin 对应提交缺少契约路径：{relative}")
        if path.is_symlink():
            raise ContractPinError(f"契约源不允许符号链接：{relative}")
        if relative in expected_files and not path.is_file():
            raise ContractPinError(f"契约路径必须是文件：{relative}")
        if relative not in expected_files and not path.is_dir():
            raise ContractPinError(f"契约路径必须是目录：{relative}")
        if path.is_dir() and any(child.is_symlink() for child in path.rglob("*")):
            raise ContractPinError(f"契约源目录不允许符号链接：{relative}")

    return PinnedContract(revision=revision, repository_root=repository_root, root=source_root)
