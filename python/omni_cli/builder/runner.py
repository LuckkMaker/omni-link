"""omni build 的实现：为一个工程上下文做 CMake 配置 + 构建（本地命令，不经过后端）。

约定与 ``omni/cmake`` 一致：

- 构建目录 ``<project>/build/<board>/<COMPILER>/<buildtype>``
- 工具链文件 ``<omni_root>/cmake/toolchains/<compiler>.cmake``
- 产物 ``omni.axf`` / ``omni.hex`` / ``omni.bin`` / ``omni.axf.map`` / ``omni.size.txt``
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable, Optional

from .. import __version__
from ..context import ProjectError

COMPILERS = ("ac6", "gcc", "clang", "ac5")
DEFAULT_COMPILER = "ac6"
BUILD_TYPES = ("Debug", "Release")
DEFAULT_BUILD_TYPE = "Debug"

TOOLCHAIN_FILES = {
    "ac6": "armclang6.cmake",
    "gcc": "gcc.cmake",
    "clang": "clang.cmake",
    "ac5": "armcc5.cmake",
}

ARTIFACTS = ("omni.axf", "omni.hex", "omni.bin", "omni.axf.map", "omni.size.txt")
SIZE_RE = re.compile(
    r"Program Size:\s*Code=(\d+)\s+RO-data=(\d+)\s+RW-data=(\d+)\s+ZI-data=(\d+)"
)
VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")


@dataclass
class BuildResult:
    project_dir: str
    board: str
    compiler: str
    build_type: str
    build_dir: str
    toolchain: str
    target: Optional[str] = None
    configured: bool = False
    built: bool = False
    success: bool = False
    exit_code: int = 0
    artifacts: dict = field(default_factory=dict)
    size: Optional[dict] = None
    log: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "success": self.success,
            "exit_code": self.exit_code,
            "project_dir": self.project_dir,
            "board": self.board,
            "compiler": self.compiler,
            "build_type": self.build_type,
            "build_dir": self.build_dir,
            "toolchain": self.toolchain,
            "target": self.target,
            "configured": self.configured,
            "built": self.built,
            "artifacts": self.artifacts,
            "size": self.size,
            "log": self.log,
        }


def _version_tuple(text: str) -> tuple:
    match = VERSION_RE.search(text or "")
    return tuple(int(part) for part in match.groups()) if match else (0, 0, 0)


#: CMakeCache 里需要核对的上下文变量（构建目录只能服务一个上下文）。
CACHE_CONTEXT = {
    "OMNI_BOARD": "board",
    "OMNI_COMPILER": "compiler",
    "CMAKE_BUILD_TYPE": "build_type",
}


def read_cache_context(build_dir: str) -> dict:
    """读取已有构建目录的上下文（board / compiler / build_type）。"""

    path = os.path.join(build_dir, "CMakeCache.txt")
    if not os.path.isfile(path):
        return {}
    values: dict = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("//") or line.startswith("#"):
                    continue
                key, sep, value = line.partition("=")
                if not sep:
                    continue
                key = key.split(":", 1)[0]
                field_name = CACHE_CONTEXT.get(key)
                if field_name:
                    values[field_name] = value
    except OSError:
        return {}
    return values


def cache_conflicts(cache: dict, board: str, compiler: str, build_type: str) -> list:
    """构建目录与当前请求的上下文是否冲突。"""

    wanted = {"board": board, "compiler": compiler, "build_type": build_type}
    conflicts = []
    for key, expected in wanted.items():
        actual = cache.get(key)
        if actual and actual != expected:
            conflicts.append(f"{key}: 构建目录里是 '{actual}'，当前是 '{expected}'")
    return conflicts


def toolchain_file(omni_root: str, compiler: str) -> str:
    name = TOOLCHAIN_FILES.get(compiler)
    if not name:
        raise ProjectError(
            f"未知编译器 '{compiler}'（支持: {', '.join(COMPILERS)}）", code=2
        )
    path = os.path.join(omni_root, "cmake", "toolchains", name)
    if not os.path.isfile(path):
        raise ProjectError(
            f"编译器 {compiler} 的工具链文件尚未提供: {path}\n"
            f"  当前只有 ac6 可用；GCC/CLANG/AC5 见 omni/cmake/README.md 的阶段 4–6。",
            code=1,
        )
    return path


def build_directory(project_dir: str, board: str, compiler: str, build_type: str) -> str:
    return os.path.join(project_dir, "build", board, compiler.upper(), build_type)


def parse_size(map_path: str) -> Optional[dict]:
    if not os.path.isfile(map_path):
        return None
    try:
        with open(map_path, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        return None
    match = SIZE_RE.search(text)
    if not match:
        return None
    code, ro, rw, zi = (int(value) for value in match.groups())
    return {"code": code, "ro_data": ro, "rw_data": rw, "zi_data": zi}


def collect_artifacts(build_dir: str) -> dict:
    found = {}
    for name in ARTIFACTS:
        path = os.path.join(build_dir, name)
        if os.path.isfile(path):
            found[name] = path
    return found


def _cli_configure_args() -> list:
    """让 CMake 用「当前这个 CLI」生成配置，避免 PATH 上的旧版本。"""

    if getattr(sys, "frozen", False):
        return [f"-DOMNI_CLI={sys.executable}"]

    exe = shutil.which("omni")
    if exe:
        try:
            out = subprocess.run(
                [exe, "--version"], capture_output=True, text=True, timeout=20
            )
            if _version_tuple(out.stdout) >= _version_tuple(__version__):
                return [f"-DOMNI_CLI={exe}"]
        except (OSError, subprocess.SubprocessError):
            pass

    return [
        f"-DOMNI_CLI_PYTHON={sys.executable}",
        "-DOMNI_CLI_MODULE=omni_cli",
    ]


def _require_tool(name: str, hint: str) -> str:
    path = shutil.which(name)
    if not path:
        raise ProjectError(f"未找到 {name}（{hint}）", code=1)
    return path


def _run(cmd: list, log: Callable[[str], None], verbose: bool) -> tuple:
    log("$ " + " ".join(cmd))
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except OSError as exc:
        raise ProjectError(f"执行失败: {cmd[0]}: {exc}", code=1) from exc

    output = (proc.stdout or "") + (proc.stderr or "")
    if verbose and output:
        log(output.rstrip())
    return proc.returncode, output


def run_build(
    *,
    project_dir: str,
    omni_root: str,
    board: str,
    compiler: str = DEFAULT_COMPILER,
    build_type: str = DEFAULT_BUILD_TYPE,
    clean: bool = False,
    force_configure: bool = False,
    configure_only: bool = False,
    target: Optional[str] = None,
    jobs: Optional[int] = None,
    cmake_args: Optional[list] = None,
    verbose: bool = False,
    log: Optional[Callable[[str], None]] = None,
) -> BuildResult:
    log = log or (lambda message: None)
    compiler = (compiler or DEFAULT_COMPILER).lower()
    if compiler not in COMPILERS:
        raise ProjectError(f"未知编译器 '{compiler}'（支持: {', '.join(COMPILERS)}）", code=2)
    if build_type not in BUILD_TYPES:
        raise ProjectError(
            f"未知构建类型 '{build_type}'（支持: {', '.join(BUILD_TYPES)}）", code=2
        )

    repo_root = os.path.dirname(omni_root)
    toolchain = toolchain_file(omni_root, compiler)
    build_dir = build_directory(project_dir, board, compiler, build_type)

    result = BuildResult(
        project_dir=project_dir,
        board=board,
        compiler=compiler,
        build_type=build_type,
        build_dir=build_dir,
        toolchain=toolchain,
        target=target,
    )

    if clean and os.path.isdir(build_dir):
        # 只允许删工程目录下的构建目录。
        expected = os.path.abspath(os.path.join(project_dir, "build"))
        if not os.path.abspath(build_dir).startswith(expected):
            raise ProjectError(f"拒绝清理非构建目录: {build_dir}", code=1)
        log(f"clean {build_dir}")
        shutil.rmtree(build_dir)

    # 一个构建目录只服务一个上下文（与 west 的行为一致）。
    cache = read_cache_context(build_dir)
    conflicts = cache_conflicts(cache, board, compiler, build_type)
    if conflicts:
        raise ProjectError(
            "构建目录已配置为其它上下文，请用 --clean 重建:\n  " + "\n  ".join(conflicts),
            code=1,
        )

    cmake = _require_tool("cmake", "安装 CMake 或用 vcpkg/Keil 自带的 cmake")
    _require_tool("ninja", "安装 Ninja（CMake 生成器固定为 Ninja）")

    cache_file = os.path.join(build_dir, "CMakeCache.txt")
    need_configure = (
        force_configure
        or configure_only
        or clean
        or not os.path.isfile(cache_file)
    )
    if need_configure:
        configure_cmd = [
            cmake,
            "-S", project_dir,
            "-B", build_dir,
            "-G", "Ninja",
            f"-DOMNI_WORKSPACE_DIR={repo_root}",
            f"-DOMNI_BOARD={board}",
            f"-DOMNI_COMPILER={compiler}",
            f"-DCMAKE_TOOLCHAIN_FILE={toolchain}",
            f"-DCMAKE_BUILD_TYPE={build_type}",
            *(cmake_args or []),
            *_cli_configure_args(),
        ]
        rc, output = _run(configure_cmd, log, verbose)
        result.log.append(output)
        if rc != 0:
            result.exit_code = rc
            return result
        result.configured = True
    else:
        log("(CMake 已配置，跳过 configure；需要强制时加 --cmake)")

    if configure_only:
        result.success = True
        return result

    build_cmd = [cmake, "--build", build_dir]
    if target:
        build_cmd += ["--target", target]
    if jobs:
        build_cmd += ["--parallel", str(jobs)]
    rc, output = _run(build_cmd, log, verbose)
    result.log.append(output)
    result.exit_code = rc
    if rc != 0:
        return result

    result.built = True
    result.artifacts = collect_artifacts(build_dir)
    result.size = parse_size(os.path.join(build_dir, "omni.axf.map"))
    result.success = True
    return result
