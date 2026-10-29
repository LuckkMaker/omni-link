"""工具链发现与 PATH 注入。

安装包不再自带工具链：cmake / ninja / 编译器都由用户环境提供。

解析顺序（只对当前进程及其子进程生效，不改用户系统环境）：

1. 显式覆盖：``OMNI_CMAKE`` / ``OMNI_NINJA`` / ``OMNI_CLANG`` /
   ``OMNI_GCC`` / ``OMNI_CBUILD``。
2. 可选工具目录（目录不存在则跳过）：``OMNI_TOOLS_DIR`` 指定的目录、
   ``OMNI_TOOLCHAIN_HOME``（默认 ``%LOCALAPPDATA%/OMNI/toolchains``）、
   安装目录下的 ``tools/``（源码态是仓库根下的 ``tools/``）。这些目录里的
   ``bin``（含带版本号的变体）会前插到 PATH，并为 CMSIS-Toolbox 派生
   ``CLANG_TOOLCHAIN_<ver>`` / ``GCC_TOOLCHAIN_<ver>`` / ``CMSIS_TOOLBOX_ROOT``。
3. 系统 ``PATH``。
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import sys
from typing import Optional

TOOLS_ENV = "OMNI_TOOLS_DIR"
HOME_ENV = "OMNI_TOOLCHAIN_HOME"

#: 工具名 → 显式覆盖用的环境变量。
OVERRIDES = {
    "cmake": "OMNI_CMAKE",
    "ninja": "OMNI_NINJA",
    "clang": "OMNI_CLANG",
    "arm-none-eabi-gcc": "OMNI_GCC",
    "cbuild": "OMNI_CBUILD",
}

#: 工具目录的相对布局。``*`` 用来容纳带版本号的目录。
_BIN_PATTERNS = (
    "bin",
    "cmake/bin",
    "cmake*/bin",
    "ninja",
    "ninja*/bin",
    "llvm-embedded/*/bin",
    "llvm/*/bin",
    "clang*/bin",
    "gcc-arm-none-eabi/*/bin",
    "gcc/*/bin",
    "cmsis-toolbox/*/bin",
    "cmsis-toolbox/bin",
)

_VERSION_RE = re.compile(r"^\d+\.\d+(?:\.\d+)?$")
_PREPARED = False


def _install_root() -> str:
    """安装根目录；源码态退回 omni-link 仓库根。"""

    if getattr(sys, "frozen", False):
        # <install>/resources/python/omni.exe -> <install>
        return os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.abspath(sys.executable)))
        )
    from .settings import PROJECT_ROOT

    return PROJECT_ROOT


def shared_root() -> str:
    """独立安装器的共享目录（默认 %LOCALAPPDATA%/OMNI/toolchains）。"""

    env = os.environ.get(HOME_ENV)
    if env:
        return os.path.abspath(env)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(
            os.path.expanduser("~"), ".local", "share"
        )
    return os.path.join(base, "OMNI", "toolchains")


def tool_roots() -> list[tuple[str, str]]:
    """按优先级返回 (kind, path) 工具目录；只包含实际存在的目录。"""

    candidates: list[tuple[str, str]] = []
    env = os.environ.get(TOOLS_ENV)
    if env:
        candidates.append(("env", os.path.abspath(env)))
    candidates.append(("shared", shared_root()))
    candidates.append(("app", os.path.join(_install_root(), "tools")))

    seen = set()
    roots: list[tuple[str, str]] = []
    for kind, path in candidates:
        if not os.path.isdir(path):
            continue
        key = os.path.normcase(os.path.realpath(path))
        if key in seen:
            continue
        seen.add(key)
        roots.append((kind, path))
    return roots


def tools_root() -> Optional[str]:
    """兼容旧接口：返回优先级最高的工具目录。"""

    roots = tool_roots()
    return roots[0][1] if roots else None


def _exe(name: str) -> str:
    return name + ".exe" if os.name == "nt" else name


def _has_tool(bin_dir: str, name: str) -> bool:
    return os.path.isfile(os.path.join(bin_dir, _exe(name)))


def _bin_dirs(root: str) -> list[str]:
    """枚举工具目录下所有可能存放可执行文件的 bin 目录。"""

    dirs: list[str] = []
    for pattern in _BIN_PATTERNS:
        for path in sorted(glob.glob(os.path.join(root, pattern))):
            if os.path.isdir(path):
                dirs.append(os.path.abspath(path))

    # 允许工具直接放在根或根/bin（后者已被上面覆盖）。
    if any(_has_tool(root, name) for name in ("cmake", "ninja", "clang", "arm-none-eabi-gcc")):
        dirs.insert(0, os.path.abspath(root))

    seen = set()
    unique = []
    for path in dirs:
        key = os.path.normcase(os.path.realpath(path))
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def _version_from_bin(bin_dir: str) -> Optional[str]:
    """从 .../<version>/bin 形态的路径里取版本号。"""

    current = os.path.abspath(bin_dir)
    for _ in range(4):
        current = os.path.dirname(current)
        if not current or current == os.path.dirname(current):
            break
        base = os.path.basename(current)
        if _VERSION_RE.match(base):
            return base
    return None


def _set_toolchain_envs(bin_dirs: list[str]) -> None:
    """为 CMSIS-Toolbox 设置 CLANG_TOOLCHAIN_x_y_z / GCC_TOOLCHAIN_x_y_z。

    ``bin_dirs`` 已按工具目录优先级排列；同一个版本只让第一个目录生效，
    避免低优先级的共享目录覆盖 ``OMNI_TOOLS_DIR``。
    """

    clang_keys: set[str] = set()
    gcc_keys: set[str] = set()
    cmsis_set = False

    for bin_dir in bin_dirs:
        if _has_tool(bin_dir, "clang"):
            version = _version_from_bin(bin_dir)
            if version:
                key = "CLANG_TOOLCHAIN_" + version.replace(".", "_")
                if key not in clang_keys:
                    os.environ[key] = bin_dir
                    clang_keys.add(key)
        if _has_tool(bin_dir, "arm-none-eabi-gcc"):
            version = _version_from_bin(bin_dir)
            if version:
                key = "GCC_TOOLCHAIN_" + version.replace(".", "_")
                if key not in gcc_keys:
                    os.environ[key] = bin_dir
                    gcc_keys.add(key)
        if _has_tool(bin_dir, "cbuild") and not cmsis_set:
            os.environ["CMSIS_TOOLBOX_ROOT"] = os.path.dirname(bin_dir)
            cmsis_set = True


def prepare_environment() -> list[tuple[str, str]]:
    """把所有工具目录前插到 PATH；重复调用无副作用。"""

    global _PREPARED
    if _PREPARED:
        return tool_roots()

    roots = tool_roots()
    all_dirs: list[str] = []
    for _kind, root in roots:
        all_dirs.extend(_bin_dirs(root))

    if all_dirs:
        current = os.environ.get("PATH", "")
        os.environ["PATH"] = os.pathsep.join(all_dirs + ([current] if current else []))
        _set_toolchain_envs(all_dirs)

    _PREPARED = True
    return roots


def resolve_tool(name: str) -> Optional[str]:
    """按“显式覆盖 → 工具目录 → 系统 PATH”的顺序解析一个工具。"""

    prepare_environment()

    env_name = OVERRIDES.get(name)
    if env_name:
        override = os.environ.get(env_name)
        if override:
            if os.path.isfile(override):
                return os.path.abspath(override)
            found = shutil.which(override)
            if found:
                return found

    return shutil.which(name)


def _source(path: Optional[str], roots: list[tuple[str, str]]) -> str:
    if not path:
        return "missing"
    absolute = os.path.abspath(path)
    for kind, root in roots:
        try:
            if os.path.commonpath([absolute, os.path.abspath(root)]) == os.path.abspath(root):
                return kind
        except ValueError:
            continue
    return "system"


def describe() -> dict:
    """给 ``omni toolchain`` 和脚本消费的解析结果。"""

    roots = prepare_environment()
    active_roots = [
        {"kind": kind, "path": path}
        for kind, path in roots
        if _bin_dirs(path)
    ]
    names = (
        "cmake", "ninja", "clang", "arm-none-eabi-gcc", "armclang",
        "cbuild", "llvm-objcopy", "llvm-size",
    )
    tools = {}
    for name in names:
        path = resolve_tool(name)
        tools[name] = {
            "path": path,
            "source": _source(path, roots),
            "override": OVERRIDES.get(name, ""),
        }
    return {
        "tools_root": active_roots[0]["path"] if active_roots else None,
        "roots": active_roots,
        "shared_root": shared_root(),
        "path": os.environ.get("PATH", ""),
        "tools": tools,
    }
