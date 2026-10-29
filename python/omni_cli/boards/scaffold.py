"""工程板目录的检查与脚手架。

- ``check_project``：把工程 ``boards/<board>/startup/*`` 与 HAL 模块里的原始
  文件比对，报告 identical / modified / missing / project-only。
- ``sync_project``：只补缺失文件（新工程脚手架），已存在的文件默认不覆盖。

两条命令都不改变现有工程的文件路径，因此对 cbuild 与 Keil 工程零影响。
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Optional

from ..context import ProjectError
from .model import (
    BoardSpec,
    ROLE_SCATTER,
    ROLE_STARTUP,
    ROLE_SYSTEM,
    hal_config_template,
    missing_upstream,
    upstream_files,
)

STATUS_IDENTICAL = "identical"
STATUS_MODIFIED = "modified"
STATUS_MISSING = "missing"
STATUS_PROJECT_ONLY = "project-only"

#: 板目录里由脚手架生成/检查的固定文件。
BOARD_LAYER = "board.clayer.yml"
BOARD_CONF = "board.conf"
BOARD_BSP = "bsp.c"


@dataclass(frozen=True)
class FileState:
    role: str
    name: str
    project_path: str
    upstream_path: Optional[str]
    status: str

    def as_dict(self) -> dict:
        return {
            "role": self.role,
            "name": self.name,
            "project_path": self.project_path,
            "upstream_path": self.upstream_path,
            "status": self.status,
        }


def board_dir(project_dir: str, board: str) -> str:
    return os.path.join(project_dir, "boards", board)


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_project(spec: BoardSpec, project_dir: str) -> dict:
    """比对工程板目录与上游，返回结构化结果（不修改任何文件）。"""

    directory = board_dir(project_dir, spec.name)
    startup_dir = os.path.join(directory, "startup")

    files: list[FileState] = []
    known: set[str] = set()
    for item in upstream_files(spec):
        known.add(item.name)
        target = os.path.join(startup_dir, item.name)
        if not os.path.isfile(target):
            status = STATUS_MISSING
        elif _sha256(target) == _sha256(item.path):
            status = STATUS_IDENTICAL
        else:
            status = STATUS_MODIFIED
        files.append(FileState(item.role, item.name, target, item.path, status))

    # 工程自带、上游没有的文件（例如 *_ram.sct）只做提示，不算问题。
    if os.path.isdir(startup_dir):
        for name in sorted(os.listdir(startup_dir)):
            path = os.path.join(startup_dir, name)
            if os.path.isfile(path) and name not in known:
                files.append(FileState("project", name, path, None, STATUS_PROJECT_ONLY))

    present = {
        BOARD_LAYER: os.path.isfile(os.path.join(directory, BOARD_LAYER)),
        BOARD_CONF: os.path.isfile(os.path.join(directory, BOARD_CONF)),
        BOARD_BSP: os.path.isfile(os.path.join(directory, BOARD_BSP)),
    }
    missing_required = [name for name, ok in present.items() if not ok]
    missing = [item.name for item in files if item.status == STATUS_MISSING]
    modified = [item.name for item in files if item.status == STATUS_MODIFIED]

    return {
        "board": spec.name,
        "project_dir": project_dir,
        "board_dir": directory,
        "board_dir_exists": os.path.isdir(directory),
        "files": [item.as_dict() for item in files],
        "missing": sorted(missing),
        "modified": sorted(modified),
        "missing_required": missing_required,
        "present": present,
    }


def _clayer_text(spec: BoardSpec, project_dir: str) -> str:
    """生成 csolution 板层：只引用脚手架确实创建的文件。"""

    directory = board_dir(project_dir, spec.name)
    layout_dir = (
        os.path.join(directory, "vendor", "include")
        if spec.layout == "vendor"
        else os.path.join(directory, "STM32CubeMX", "Core", "Inc")
    )

    add_paths = ["./config", "./startup"]
    if os.path.isdir(layout_dir):
        add_paths.append(
            "./vendor/include" if spec.layout == "vendor" else "./STM32CubeMX/Core/Inc"
        )

    lines = [
        "layer:",
        "  type: Board",
        f"  description: Board layer for {spec.name}",
        "",
        "  add-path:",
    ]
    lines.extend(f"    - {path}" for path in add_paths)
    lines.extend(
        [
            "",
            "  groups:",
            "    - group: board",
            "      files:",
            f"        - file: ./{BOARD_BSP}",
        ]
    )

    sources = (
        ("vendor", os.path.join(directory, "vendor", "source"))
        if spec.layout == "vendor"
        else ("stm32cubemx", os.path.join(directory, "STM32CubeMX", "Core", "Src"))
    )
    if os.path.isdir(sources[1]):
        lines.append(f"    - group: {sources[0]}")
        lines.append("      files:")
        for name in sorted(os.listdir(sources[1])):
            if name.endswith(".c"):
                prefix = "vendor/source" if spec.layout == "vendor" else "STM32CubeMX/Core/Src"
                lines.append(f"        - file: ./{prefix}/{name}")

    return "\n".join(lines) + "\n"


def _board_conf_text(spec: BoardSpec) -> str:
    return f"CONFIG_SOC_{spec.soc.upper()}=y\n"


def _bsp_text(spec: BoardSpec) -> str:
    header = (
        "/**\n"
        " * @file    bsp.c\n"
        f" * @brief   {spec.full_name} 板级初始化（脚手架生成，请按需修改）\n"
        " */\n"
    )
    includes = (
        '#include "omni/device.h"\n'
        '#include "omni/timing/timebase.h"\n'
        '#include "omni/utils.h"\n'
    )
    body = (
        "\n"
        "void board_system_reset(void)\n"
        "{\n"
        "\tNVIC_SystemReset();\n"
        "}\n"
    )
    if spec.hal == "stm32":
        body += (
            "\n"
            "HAL_StatusTypeDef HAL_InitTick(uint32_t TickPriority)\n"
            "{\n"
            "\tUNUSED(TickPriority);\n"
            "\treturn (timebase_init() == 0) ? HAL_OK : HAL_ERROR;\n"
            "}\n"
            "\n"
            "void HAL_Delay(uint32_t Delay)\n"
            "{\n"
            "\ttimebase_delay_ms(Delay);\n"
            "}\n"
            "\n"
            "void HAL_SuspendTick(void)\n"
            "{\n"
            "}\n"
            "\n"
            "void HAL_ResumeTick(void)\n"
            "{\n"
            "}\n"
        )
    return header + "\n" + includes + body


def _write(path: str, content: str, force: bool, dry_run: bool, actions: dict) -> None:
    exists = os.path.isfile(path)
    if exists and not force:
        actions["skipped"].append(path)
        return
    actions["updated" if exists else "created"].append(path)
    if dry_run:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def _copy(src: str, dst: str, force: bool, dry_run: bool, actions: dict) -> None:
    exists = os.path.isfile(dst)
    if exists and not force:
        actions["skipped"].append(dst)
        return
    actions["updated" if exists else "created"].append(dst)
    if dry_run:
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(src, "rb") as source, open(dst, "wb") as target:
        for chunk in iter(lambda: source.read(1 << 16), b""):
            target.write(chunk)


def sync_project(
    spec: BoardSpec,
    project_dir: str,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> dict:
    """为工程补齐缺失的板级文件；默认不覆盖已存在的文件。"""

    directory = board_dir(project_dir, spec.name)
    startup_dir = os.path.join(directory, "startup")
    actions: dict = {"created": [], "updated": [], "skipped": []}

    if not dry_run:
        os.makedirs(startup_dir, exist_ok=True)
        os.makedirs(os.path.join(directory, "config"), exist_ok=True)

    for item in upstream_files(spec):
        _copy(
            item.path,
            os.path.join(startup_dir, item.name),
            force,
            dry_run,
            actions,
        )

    # HAL 配置头：新工程没有 CubeMX 生成物时，用模板补齐才能编译。
    template = hal_config_template(spec)
    if template:
        source, target_name = template
        _copy(
            source,
            os.path.join(directory, "config", target_name),
            force,
            dry_run,
            actions,
        )

    _write(
        os.path.join(directory, BOARD_LAYER),
        _clayer_text(spec, project_dir),
        force,
        dry_run,
        actions,
    )
    _write(
        os.path.join(directory, BOARD_CONF),
        _board_conf_text(spec),
        force,
        dry_run,
        actions,
    )
    _write(
        os.path.join(directory, BOARD_BSP),
        _bsp_text(spec),
        force,
        dry_run,
        actions,
    )

    return {
        "board": spec.name,
        "project_dir": project_dir,
        "board_dir": directory,
        "dry_run": dry_run,
        "created": sorted(actions["created"]),
        "updated": sorted(actions["updated"]),
        "skipped": sorted(actions["skipped"]),
        "warnings": [
            f"上游没有 {name}；需要从同系列工程复制或手写一份"
            for name in missing_upstream(spec)
        ],
        "next": [] if dry_run else ["运行 omni config 生成配置头文件"],
    }


def require_board_dir(spec: BoardSpec, project_dir: str) -> str:
    directory = board_dir(project_dir, spec.name)
    if not os.path.isdir(directory):
        raise ProjectError(
            f"工程没有板目录: {directory}\n"
            f"  可先运行: omni boards sync --project-dir {project_dir} -b {spec.name}",
            code=1,
        )
    return directory
