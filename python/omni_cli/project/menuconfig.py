"""启动交互式 menuconfig（由 omni_menuconfig.py 移植）。"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

from .context import ProjectError
from .generate import create_combined_kconfig

MENUCONFIG_STYLE = (
    "default path=fg:black,bg:white separator=fg:white,bg:blue,bold "
    "selection=fg:white,bg:red,bold help=path"
)
KCONFIG_CONFIG_HEADER = "#\n# Automatically generated file: Do not edit !!!\n#\n"


def _find_menuconfig() -> list[str]:
    executable = shutil.which("menuconfig")
    if executable:
        return [executable]

    # wheel 安装态：omni.exe 与 menuconfig.exe 通常在同一个 Scripts 目录。
    sibling = Path(sys.executable).with_name("menuconfig.exe" if os.name == "nt" else "menuconfig")
    if sibling.is_file():
        return [str(sibling)]

    if importlib.util.find_spec("menuconfig") is not None:
        return [sys.executable, "-m", "menuconfig"]
    raise ProjectError(
        "未找到 menuconfig 命令。请安装 kconfiglib（pip install kconfiglib），"
        "或把包含 menuconfig.exe 的 Scripts 目录加入 PATH。",
        code=1,
    )


def run_menuconfig(
    *,
    project_dir: str,
    omni_root: str,
    target: str,
    log: Callable[[str], None] = print,
) -> int:
    """打开 menuconfig；返回子进程退出码。"""

    config_dir = os.path.join(project_dir, "boards", target, "config")
    os.makedirs(config_dir, exist_ok=True)
    dot_config = os.path.join(project_dir, ".config")

    kconfig_file, project_kconfig = create_combined_kconfig(omni_root, project_dir)
    default_kconfig = os.path.join(omni_root, "Kconfig")

    env = os.environ.copy()
    env["srctree"] = omni_root
    env["KCONFIG_CONFIG"] = dot_config
    env["KCONFIG_CONFIG_HEADER"] = KCONFIG_CONFIG_HEADER
    env["MENUCONFIG_STYLE"] = MENUCONFIG_STYLE

    log(f"OMNI Root:   {omni_root}")
    log(f"Target:      {target}")
    log(f"Config File: {dot_config}")

    try:
        cmd = [*_find_menuconfig(), kconfig_file]
        if os.name == "nt" and cmd[0].lower().endswith((".cmd", ".bat")):
            cmd = ["cmd", "/c", *cmd]
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
            proc = subprocess.Popen(
                cmd,
                cwd=omni_root,
                env=env,
                creationflags=creationflags,
            )
            return proc.wait()
        return subprocess.call(cmd, cwd=omni_root, env=env)
    except FileNotFoundError as exc:
        raise ProjectError(f"启动 menuconfig 失败: {exc}", code=1) from exc
    finally:
        if kconfig_file != default_kconfig and os.path.exists(kconfig_file):
            try:
                os.remove(kconfig_file)
            except OSError:
                pass
