#!/usr/bin/env python3
"""
Build script: package the Python backend into a standalone executable using PyInstaller.

Usage:
    python build.py                    # Build using current Python
    python build.py --clean            # Clean build artifacts before building
    python build.py --python PATH      # Use specific Python executable

Output:
    dist/omni-backend/omni-backend.exe   # Backend executable (Windows)
    dist/omni.exe                        # CLI executable (Windows)

The output is placed in dist/ and is consumed by electron-builder
when building the Electron installer.
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent
DIST_DIR = BACKEND_DIR / "dist"
BUILD_DIR = BACKEND_DIR / "build"

ENTRY_SCRIPT = BACKEND_DIR / "server.py"
APP_NAME = "omni-backend"

# CLI 打包（单文件 omni.exe，随安装包分发，实现"装完即用命令行"）
CLI_ENTRY_SCRIPT = BACKEND_DIR / "omni_cli_main.py"
CLI_APP_NAME = "omni"

# Required runtime packages that must be importable by the building Python.
# 注意：pyocd 是内置源码（python/pyocd/），check_package 会把 BACKEND_DIR 加入
# sys.path 使其可导入；pyusb / hidapi 是 pyOCD 可选 USB 后端，项目实际用
# libusb_package，不强制检测。
REQUIRED_PACKAGES = [
    "fastapi", "uvicorn", "pyocd", "cmsis_pack_manager",
    "capstone", "intelhex", "libusb_package",
    "jinja2", "yaml",
]

# Hidden imports for FastAPI / uvicorn / pyOCD modules that PyInstaller can't auto-detect
HIDDEN_IMPORTS = [
    # uvicorn
    "uvicorn.logging",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    # pyOCD - probe backends
    "pyocd.probe.cmsis_dap_probe",
    "pyocd.probe.stlink_probe",
    "pyocd.probe.jlink_probe",
    "pyocd.probe.picoprobe",
    "pyocd.probe.pydapaccess.dap_access_cmsis_dap",
    "pyocd.probe.pydapaccess.interface.pyusb_backend",
    "pyocd.probe.pydapaccess.interface.pyusb_v2_backend",
    "pyocd.probe.pydapaccess.interface.hidapi_backend",
    "pyocd.probe.pydapaccess.interface.pywinusb_backend",
    # pyOCD - USB backends
    "usb",
    "usb.backend.libusb1",
    "usb.backend.libusb0",
    "usb.backend.openusb",
    "libusb_package",
    "hid",
    # pyOCD - target families (builtin targets)
    "pyocd.target.builtin",
    "pyocd.target.family",
    # pyOCD - core
    "pyocd.core.helpers",
    "pyocd.core.session",
    "pyocd.core.soc_target",
    "pyocd.core.memory_map",
    "pyocd.flash.loader",
    "pyocd.flash.eraser",
    "pyocd.flash.file_programmer",
    # pyOCD - debug
    "pyocd.debug.elf.elf_reader",
    "pyocd.debug.svd.loader",
    # App modules
    "api.probes",
    "api.flash",
    "api.targets",
    "api.files",
    "api.devices",
    "api.commander",
    "api.rtt",
    "api.monitor",
    "api.tools",
    "core.pyocd_backend",
    "core.events",
    "core.probe_monitor",
    "core.interface",
    "core.rtt_backend",
    "core.commander_backend",
    "core.monitor_backend",
    "core.database",
    "core.map_parser",
    "core.command_examples",
    # OMNI Tool（多功能调试工具）后端模块
    "omni_tools",
    "omni_tools.router",
    "omni_tools.session",
    "omni_tools.device_finder",
    "omni_tools.protocol.serial_link",
    "omni_tools.protocol.modbus_rtu",
    "omni_tools.protocol.boot_iap",
    "omni_tools.protocol.app_cmd",
    # pyserial（OMNI Tool 串口底座，serialwin32 为运行时动态导入，需显式声明）
    "serial",
    "serial.tools",
    "serial.tools.list_ports",
    "serial.tools.list_ports_windows",
    "serial.serialwin32",
    # ELF 解析依赖
    "elftools.elf.elffile",
    "elftools.elf.sections",
    "elftools.dwarf.dwarfinfo",
]

# Data files to include
DATA_DIRS = [
    ("data", "data"),       # device_info.json
    ("flm", "flm"),         # Flash algorithms
]

# ---------------------------------------------------------------------------
# Source encoding checks
# ---------------------------------------------------------------------------
# 目的：防止“中文源码在某个环节被按错误编码处理 → 字符串里留下 U+FFFD”的产物
# 再次发版（实机报告 P1-4）。替换字符一旦出现在源码中，运行期无论怎么设置
# stdout 编码都无法恢复原文，必须在构建前拦下。
#
# 排除项：pyocd/ 是内置的第三方源码；dist/、build/ 是打包产物；
# omni_cli/build/ 是旧 setuptools 的 build/lib 副本。
ENCODING_CHECK_EXCLUDE_PREFIXES = (
    "pyocd/",
    "dist/",
    "build/",
    "omni_cli/build/",
)
ENCODING_CHECK_EXCLUDE_DIR_NAMES = {"__pycache__"}
REPLACEMENT_CHAR = "\ufffd"


def _iter_first_party_sources(root: Path):
    """遍历第一方 .py 文件（跳过第三方/构建产物目录）。"""
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in ENCODING_CHECK_EXCLUDE_DIR_NAMES and not d.endswith(".egg-info")
        )
        rel_dir = Path(dirpath).resolve().relative_to(root).as_posix()
        rel_prefix = (rel_dir + "/") if rel_dir != "." else ""
        if any(rel_prefix.startswith(p) for p in ENCODING_CHECK_EXCLUDE_PREFIXES):
            dirnames[:] = []
            continue
        for name in sorted(filenames):
            if name.endswith(".py"):
                yield Path(dirpath) / name


def check_source_encoding(root: Path = BACKEND_DIR) -> list[str]:
    """检查第一方 .py：必须是合法 UTF-8 且不含 U+FFFD。返回问题列表。"""
    root = root.resolve()
    problems: list[str] = []
    for path in _iter_first_party_sources(root):
        rel = path.relative_to(root).as_posix()
        try:
            raw = path.read_bytes()
        except OSError as e:  # noqa: PERF203
            problems.append(f"{rel}: 无法读取: {e}")
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as e:
            problems.append(f"{rel}: 不是合法 UTF-8（{e}）")
            continue
        if REPLACEMENT_CHAR in text:
            line = text[: text.index(REPLACEMENT_CHAR)].count("\n") + 1
            problems.append(f"{rel}:{line}: 含 U+FFFD 替换字符")
    return problems


def report_source_encoding(root: Path = BACKEND_DIR) -> bool:
    """执行源码编码检查并打印结果（通过返回 True）。"""
    problems = check_source_encoding(root)
    if problems:
        log(f"ERROR: 源码编码检查失败（{len(problems)} 处）")
        for item in problems[:20]:
            log(f"  {item}")
        if len(problems) > 20:
            log(f"  ... 其余 {len(problems) - 20} 处省略")
        return False
    log("源码编码检查通过（UTF-8，无 U+FFFD）")
    return True


def verify_cli_help_encoding(exe_path: Path) -> bool:
    """构建后检查：CLI 帮助输出必须可严格按 UTF-8 解码且不含 U+FFFD。"""
    if not exe_path.exists():
        log(f"WARNING: 未找到 CLI 产物 {exe_path}，跳过帮助编码检查")
        return True
    try:
        proc = subprocess.run(
            [str(exe_path), "backend", "-h"],
            capture_output=True,
            timeout=120,
        )
    except Exception as e:
        log(f"WARNING: 运行 {exe_path.name} 失败，跳过帮助编码检查: {e}")
        return True
    output = proc.stdout + proc.stderr
    try:
        text = output.decode("utf-8")
    except UnicodeDecodeError as e:
        log(f"ERROR: CLI 帮助输出不是合法 UTF-8: {e}")
        return False
    if REPLACEMENT_CHAR in text:
        log("ERROR: CLI 帮助输出含 U+FFFD（stdout 未固定为 UTF-8）")
        return False
    if "后端" not in text:
        log("ERROR: CLI 帮助输出缺少预期中文（输出为空或编码异常）")
        return False
    log("CLI 帮助编码检查通过（UTF-8，无 U+FFFD）")
    return True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log(msg: str):
    """Print a build log message."""
    print(f"[build] {msg}")


def _configure_stdio() -> None:
    """构建日志也固定 UTF-8（管道下中文 Windows 默认 cp936，CI 里会变乱码）。"""
    if os.environ.get("PYTHONIOENCODING"):
        return
    for stream in (sys.stdout, sys.stderr):
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, OSError, ValueError):
            pass


def check_package(python_exe: str, package: str) -> bool:
    """Check if a package is importable in the given Python.

    把 BACKEND_DIR 加入 sys.path，让内置的 pyocd 源码包可被 import。
    """
    try:
        subprocess.run(
            [python_exe, "-c",
             f"import sys; sys.path.insert(0, r'{BACKEND_DIR}'); import {package}"],
            check=True,
            capture_output=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def ensure_python(python_exe: str | None, require_packages: bool = True) -> str:
    """
    Resolve the Python executable to use.

    Priority:
      1. Explicit --python argument
      2. Current interpreter (sys.executable)
    Then verify required packages are available (backend build only).
    """
    py = python_exe or sys.executable

    # Verify the Python exists
    try:
        result = subprocess.run(
            [py, "--version"], capture_output=True, text=True, check=True
        )
        log(f"Using Python: {py} ({result.stdout.strip()})")
    except (FileNotFoundError, subprocess.CalledProcessError):
        log(f"ERROR: Python not found at '{py}'")
        sys.exit(1)

    # Check required packages（CLI 只依赖标准库，--cli-only 时跳过）
    if require_packages:
        missing = [pkg for pkg in REQUIRED_PACKAGES if not check_package(py, pkg)]
        if missing:
            log(f"ERROR: Missing packages in {py}: {', '.join(missing)}")
            log(f"  Install them with:  {py} -m pip install -r requirements.txt")
            sys.exit(1)

    return py


def ensure_pyinstaller(python_exe: str):
    """Install PyInstaller if it's not already available."""
    if check_package(python_exe, "PyInstaller"):
        return
    log("PyInstaller not found, installing...")
    subprocess.check_call(
        [python_exe, "-m", "pip", "install", "pyinstaller>=6.0"]
    )
    log("PyInstaller installed.")


def clean():
    """Remove previous build artifacts."""
    for d in [DIST_DIR, BUILD_DIR]:
        if d.exists():
            log(f"Cleaning {d}")
            shutil.rmtree(d)
    spec_file = BACKEND_DIR / f"{APP_NAME}.spec"
    if spec_file.exists():
        spec_file.unlink()
    cli_spec = BACKEND_DIR / f"{CLI_APP_NAME}.spec"
    if cli_spec.exists():
        cli_spec.unlink()


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def build(python_exe: str):
    """Run PyInstaller to create the standalone executable."""
    ensure_pyinstaller(python_exe)

    # Data files to include
    datas = []
    for src_dir, dst_dir in DATA_DIRS:
        src_path = BACKEND_DIR / src_dir
        if src_path.exists():
            datas.append(f"--add-data={src_path}{os.pathsep}{dst_dir}")

    # Collect all pyOCD data files (YAML sequences, SVD zip, etc.)
    collect_args = [
        "--collect-all", "pyocd",
        "--collect-all", "cmsis_pack_manager",
        "--collect-all", "libusb_package",
    ]

    # Assemble the PyInstaller command
    cmd = [
        python_exe, "-m", "PyInstaller",
        "--name", APP_NAME,
        "--noconfirm",
        "--console",
        f"--distpath={DIST_DIR}",
        f"--workpath={BUILD_DIR}",
        f"--specpath={BACKEND_DIR}",
        *datas,
        *collect_args,
    ]

    for imp in HIDDEN_IMPORTS:
        cmd.extend(["--hidden-import", imp])

    # Add the backend dir to the Python path for PyInstaller
    cmd.extend(["--paths", str(BACKEND_DIR)])
    cmd.append(str(ENTRY_SCRIPT))

    log("Running PyInstaller...")
    log(f"Command: {' '.join(cmd)}")
    subprocess.check_call(cmd, cwd=str(BACKEND_DIR))

    # Verify output
    if sys.platform == "win32":
        exe_path = DIST_DIR / APP_NAME / f"{APP_NAME}.exe"
    else:
        exe_path = DIST_DIR / APP_NAME / APP_NAME

    if exe_path.exists():
        size_mb = exe_path.stat().st_size / (1024 * 1024)
        log(f"Build successful!")
        log(f"Executable: {exe_path}")
        log(f"Size: {size_mb:.1f} MB")

        # Check _internal directory size
        internal_dir = DIST_DIR / APP_NAME / "_internal"
        if internal_dir.exists():
            total_size = sum(f.stat().st_size for f in internal_dir.rglob("*") if f.is_file())
            log(f"Total package size: {total_size / (1024 * 1024):.1f} MB")
    else:
        log(f"ERROR: Expected output not found at {exe_path}")
        sys.exit(1)


def build_cli(python_exe: str):
    """把 CLI 打成单文件 omni.exe（输出到 dist/omni.exe）。

    单文件便于随安装包分发并直接放进 PATH。调试/烧录命令只依赖标准库；
    ``omni project`` 额外依赖 kconfiglib，PyInstaller 需要显式收集。
    """
    ensure_pyinstaller(python_exe)

    cmd = [
        python_exe, "-m", "PyInstaller",
        "--name", CLI_APP_NAME,
        "--noconfirm",
        "--console",
        "--onefile",
        f"--distpath={DIST_DIR}",
        f"--workpath={BUILD_DIR}",
        f"--specpath={BACKEND_DIR}",
        "--collect-submodules", "omni_cli",
        "--hidden-import", "kconfiglib",
        "--paths", str(BACKEND_DIR),
        str(CLI_ENTRY_SCRIPT),
    ]

    log("Running PyInstaller (CLI)...")
    log(f"Command: {' '.join(cmd)}")
    subprocess.check_call(cmd, cwd=str(BACKEND_DIR))

    exe_path = DIST_DIR / (f"{CLI_APP_NAME}.exe" if sys.platform == "win32" else CLI_APP_NAME)
    if exe_path.exists():
        size_mb = exe_path.stat().st_size / (1024 * 1024)
        log("CLI build successful!")
        log(f"Executable: {exe_path}")
        log(f"Size: {size_mb:.1f} MB")
    else:
        log(f"ERROR: Expected CLI output not found at {exe_path}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    _configure_stdio()
    parser = argparse.ArgumentParser(description="Build OMNI Link backend")
    parser.add_argument(
        "--clean", action="store_true",
        help="Clean build artifacts before building",
    )
    parser.add_argument(
        "--python", default=None,
        help="Path to Python executable to use (default: current interpreter)",
    )
    parser.add_argument(
        "--cli-only", action="store_true",
        help="Only build the CLI (dist/omni.exe); skip the omni-backend bundle",
    )
    parser.add_argument(
        "--check-sources", action="store_true",
        help="Only run the source encoding check (UTF-8 / no U+FFFD); do not build",
    )
    args = parser.parse_args()

    if args.clean:
        clean()

    # 编码检查先于任何打包：含 U+FFFD 的源码无法靠运行期设置修复
    if not report_source_encoding():
        sys.exit(1)
    if args.check_sources:
        return

    py = ensure_python(args.python, require_packages=not args.cli_only)
    if not args.cli_only:
        build(py)
    build_cli(py)

    cli_exe = DIST_DIR / (f"{CLI_APP_NAME}.exe" if sys.platform == "win32" else CLI_APP_NAME)
    if not verify_cli_help_encoding(cli_exe):
        sys.exit(1)


if __name__ == "__main__":
    main()
