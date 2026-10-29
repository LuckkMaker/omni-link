"""`omni toolchain` 的离线回归测试（不需要构建工具，也不改用户环境）。

用法::

    cd python
    python test_toolchain.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PY_DIR)

from omni_cli import toolchain

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(name)
        print(f"FAIL {name} {detail}")


def _fake_exe(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    source = shutil.which("where") or shutil.which("true") or shutil.which("echo")
    if source:
        shutil.copyfile(source, path)
    else:
        path.write_bytes(b"")
    try:
        path.chmod(0o755)
    except OSError:
        pass


def main() -> int:
    saved = dict(os.environ)
    saved_prepared = toolchain._PREPARED
    try:
        with tempfile.TemporaryDirectory(prefix="omni-tools-") as tmp:
            root = Path(tmp)
            cmake = root / "cmake" / "bin" / ("cmake.exe" if os.name == "nt" else "cmake")
            ninja = root / "ninja" / ("ninja.exe" if os.name == "nt" else "ninja")
            clang = root / "llvm-embedded" / "19.1.5" / "bin" / ("clang.exe" if os.name == "nt" else "clang")
            gcc_bin = root / "gcc-arm-none-eabi" / "14.2.1" / "bin"
            gcc = gcc_bin / ("arm-none-eabi-gcc.exe" if os.name == "nt" else "arm-none-eabi-gcc")
            for exe in (cmake, ninja, clang, gcc):
                _fake_exe(exe)

            os.environ["OMNI_TOOLS_DIR"] = tmp
            os.environ.pop("OMNI_CMAKE", None)
            toolchain._PREPARED = False

            roots = toolchain.prepare_environment()
            check("root", any(path == tmp for _kind, path in roots))
            # Windows 的 shutil.which 可能返回 PATHEXT 里的大写扩展名，按 normcase 比较。
            check("cmake.bundled",
                  os.path.normcase(toolchain.resolve_tool("cmake") or "") == os.path.normcase(str(cmake)))
            check("ninja.bundled",
                  os.path.normcase(toolchain.resolve_tool("ninja") or "") == os.path.normcase(str(ninja)))
            check("path.prepended", os.environ["PATH"].split(os.pathsep)[0] == str(cmake.parent))
            check("clang.env", os.environ.get("CLANG_TOOLCHAIN_19_1_5") == str(clang.parent))
            check("gcc.env", os.environ.get("GCC_TOOLCHAIN_14_2_1") == str(gcc_bin))

            data = toolchain.describe()
            check("describe.root", data["tools_root"] == tmp)
            # OMNI_TOOLS_DIR 在 describe 里标记为 env（显式目录），shared 才是独立安装器目录。
            check("describe.source", data["tools"]["cmake"]["source"] == "env")

            # 去掉显式目录，改用共享目录（OMNI_TOOLCHAIN_HOME）。
            os.environ.pop("OMNI_TOOLS_DIR", None)
            os.environ["OMNI_TOOLCHAIN_HOME"] = tmp
            toolchain._PREPARED = False
            shared = toolchain.describe()
            check("shared.root", shared["tools_root"] == tmp)
            check("shared.source", shared["tools"]["cmake"]["source"] == "shared")

            # 显式覆盖优先于内置目录。
            override = root / "override-cmake"
            _fake_exe(override)
            os.environ["OMNI_CMAKE"] = str(override)
            check("override",
                  os.path.normcase(toolchain.resolve_tool("cmake") or "") == os.path.normcase(str(override)))

        # 没有实际可执行文件时，describe 不把仅含 README 的 tools/ 当成已配置。
        saved_root = os.environ.pop("OMNI_TOOLS_DIR", None)
        os.environ["OMNI_TOOLS_DIR"] = str(Path(tempfile.gettempdir()) / "omni-tools-does-not-exist")
        os.environ.pop("OMNI_CMAKE", None)
        toolchain._PREPARED = False
        check("missing.root", toolchain.describe()["tools_root"] is None)
        if saved_root is not None:
            os.environ["OMNI_TOOLS_DIR"] = saved_root
    finally:
        os.environ.clear()
        os.environ.update(saved)
        toolchain._PREPARED = saved_prepared

    if failures:
        print(f"{len(failures)} toolchain test(s) failed: {', '.join(failures)}")
        return 1
    print("all toolchain tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
