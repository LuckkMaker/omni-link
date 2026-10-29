"""生成模块注册表：``omni/cmake/omni_modules.cmake`` 与 ``omni/Kconfig.modules``。

两个文件都是生成物、入库，由 ``omni modules generate --check`` 在 CI 里校验漂移，
对应 Zephyr 的 ``zephyr_modules.txt`` / ``Kconfig.modules``。
"""

from __future__ import annotations

import os
from typing import Optional

from .model import ModuleSpec, iter_modules

CMAKE_REGISTRY = os.path.join("cmake", "omni_modules.cmake")
KCONFIG_REGISTRY = "Kconfig.modules"

_HEADER = "# 由 `omni modules generate` 生成，请勿手改。\n"


def _path_expr(repo_root: str, rel: Optional[str]) -> str:
    """把仓库相对路径写成 CMake 表达式（可随工作区移动）。"""

    if not rel:
        return '""'
    return '"${OMNI_WORKSPACE_DIR}/' + rel + '"'


def render_cmake(repo_root: str, modules: list[ModuleSpec]) -> str:
    lines = [_HEADER, "# 字段含义见 omni/cmake/README.md。\n"]
    if not modules:
        lines.append("set(OMNI_MODULE_NAMES)\n")
        return "".join(lines)

    lines.append("set(OMNI_MODULE_NAMES\n")
    lines.extend(f"    {spec.name}\n" for spec in modules)
    lines.append(")\n\n")

    for spec in modules:
        # 变量名全大写：OMNI_MODULE_U8G2_SRC，避免大小写混用。
        prefix = f"set(OMNI_MODULE_{spec.name.upper()}_"
        lines.append(f"{prefix}SRC {_path_expr(repo_root, spec.module_dir)})\n")
        lines.append(f"{prefix}CMAKE {_path_expr(repo_root, spec.cmake)})\n")
        lines.append(f"{prefix}KCONFIG {_path_expr(repo_root, spec.kconfig)})\n")
        lines.append(f"{prefix}ENABLE \"{spec.enable or ''}\")\n")
        lines.append(f"{prefix}LAYER {_path_expr(repo_root, spec.layer)})\n")
        lines.append(f"{prefix}LOCATION \"{spec.location}\")\n\n")

    return "".join(lines)


def render_kconfig(repo_root: str, omni_root: str, modules: list[ModuleSpec]) -> str:
    """Kconfig 里的 ``rsource`` 路径相对 omni/Kconfig.modules 所在目录。"""

    lines = [_HEADER, "# 每个模块一行；顺序与 omni_modules.cmake 一致。\n"]
    entries = 0
    for spec in modules:
        if not spec.kconfig:
            continue
        rel = os.path.relpath(
            os.path.join(repo_root, spec.kconfig), omni_root
        ).replace("\\", "/")
        lines.append(f'rsource "{rel}"\n')
        entries += 1
    if not entries:
        lines.append("# 当前没有模块提供 Kconfig。\n")
    return "".join(lines)


def _target_path(omni_root: str, rel: str) -> str:
    return os.path.join(omni_root, *rel.split("/"))


def _existing(path: str) -> str:
    if not os.path.isfile(path):
        return ""
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def generate(repo_root: str, omni_root: str, *, check: bool = False) -> dict:
    """生成（或校验）注册表；``check=True`` 时只比较、不写。"""

    modules = iter_modules(repo_root)
    outputs = {
        CMAKE_REGISTRY: render_cmake(repo_root, modules),
        KCONFIG_REGISTRY: render_kconfig(repo_root, omni_root, modules),
    }

    written: list[str] = []
    drifted: list[str] = []
    unchanged: list[str] = []
    for rel, content in outputs.items():
        path = _target_path(omni_root, rel)
        current = _existing(path)
        if current == content:
            unchanged.append(rel)
            continue
        if check:
            drifted.append(rel)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        written.append(rel)

    return {
        "modules": [spec.as_dict() for spec in modules],
        "written": written,
        "unchanged": unchanged,
        "drifted": drifted,
        "check": check,
        "paths": {
            rel: _target_path(omni_root, rel) for rel in outputs
        },
    }
