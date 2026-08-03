#!/usr/bin/env python3
"""
Build script: package the Python backend into a standalone executable using PyInstaller.

Usage:
    python build.py                    # Build using current Python
    python build.py --clean            # Clean build artifacts before building
    python build.py --python PATH      # Use specific Python executable

Output:
    dist/omni-backend/omni-backend.exe   # Executable (Windows)

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
# Helpers
# ---------------------------------------------------------------------------
def log(msg: str):
    """Print a build log message."""
    print(f"[build] {msg}")


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


def ensure_python(python_exe: str | None) -> str:
    """
    Resolve the Python executable to use.

    Priority:
      1. Explicit --python argument
      2. Current interpreter (sys.executable)
    Then verify required packages are available.
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

    # Check required packages
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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Build OMNI Link backend")
    parser.add_argument(
        "--clean", action="store_true",
        help="Clean build artifacts before building",
    )
    parser.add_argument(
        "--python", default=None,
        help="Path to Python executable to use (default: current interpreter)",
    )
    args = parser.parse_args()

    if args.clean:
        clean()

    py = ensure_python(args.python)
    build(py)


if __name__ == "__main__":
    main()
