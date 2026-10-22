"""`omni build` 离线回归测试（不需要硬件/后端；默认不真正编译）。

用法::

    cd python
    python test_build_cli.py

设置 ``OMNI_BUILD_E2E=1`` 时会真的构建 template（需要 cmake/ninja/AC6）。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PY_DIR)

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, OSError, ValueError):
        pass

from omni_cli.cli import build_parser
from omni_cli.context import ProjectError
from omni_cli.builder.runner import (
    ARTIFACTS,
    _cli_configure_args,
    build_directory,
    collect_artifacts,
    parse_size,
    run_build,
    toolchain_file,
)

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(name)
        print(f"FAIL {name} {detail}")


MAP_TEXT = """\
Component: Arm Compiler for Embedded 6.23 Tool: armlink [5f102400]
Program Size: Code=6138 RO-data=582 RW-data=12 ZI-data=1652
"""


def workspace() -> Path | None:
    candidates = []
    env = os.environ.get("OMNI_WORKSPACE_DIR")
    if env:
        candidates.append(Path(env))
    candidates.append(Path(__file__).resolve().parents[1].parent / "omni-emb")
    for candidate in candidates:
        if (candidate / "omni" / "cmake").is_dir():
            return candidate
    return None


def test_parser() -> None:
    parser = build_parser()
    args = parser.parse_args(["build", "-b", "stm32f407ig"])
    check("parser.board", args.board == "stm32f407ig")
    check("parser.compiler", args.compiler == "ac6")
    check("parser.build_type", args.build_type == "Debug")
    args = parser.parse_args(["build", "-b", "x", "-c", "gcc", "-t", "Release",
                              "--clean", "--configure-only", "-j", "8", "--json"])
    check("parser.options", args.compiler == "gcc" and args.build_type == "Release"
          and args.clean and args.configure_only and args.jobs == 8 and args.json_)


def test_build_directory() -> None:
    path = build_directory(r"D:\proj", "stm32f407ig", "ac6", "Debug")
    check("dir.shape", path.replace("\\", "/").endswith("proj/build/stm32f407ig/AC6/Debug"), path)
    path = build_directory("/proj", "b", "gcc", "Release")
    check("dir.upper", "/proj/build/b/GCC/Release" in path.replace("\\", "/"), path)


def test_toolchain() -> None:
    root = workspace()
    if not root:
        print("skip toolchain (workspace not found)")
        return
    omni_root = str(root / "omni")
    ac6 = toolchain_file(omni_root, "ac6")
    check("toolchain.ac6", ac6.endswith("armclang6.cmake") and os.path.isfile(ac6), ac6)
    try:
        toolchain_file(omni_root, "gcc")
    except ProjectError as exc:
        check("toolchain.gcc", "尚未提供" in str(exc))
    else:
        check("toolchain.gcc", False, "gcc 未报错")


def test_parse_size_and_artifacts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        map_path = os.path.join(tmp, "omni.axf.map")
        with open(map_path, "w", encoding="utf-8") as handle:
            handle.write(MAP_TEXT)
        size = parse_size(map_path)
        check("size.parsed", size == {"code": 6138, "ro_data": 582, "rw_data": 12, "zi_data": 1652}, str(size))
        check("size.missing", parse_size(os.path.join(tmp, "nope.map")) is None)

        for name in ("omni.axf", "omni.hex"):
            with open(os.path.join(tmp, name), "w", encoding="utf-8") as handle:
                handle.write("x")
        found = collect_artifacts(tmp)
        check("artifacts.subset", {"omni.axf", "omni.hex"} <= set(found), str(sorted(found)))
        check("artifacts.list", "omni.axf.map" in ARTIFACTS and len(ARTIFACTS) == 5)


def test_cli_args() -> None:
    args = _cli_configure_args()
    check("cli_args.nonempty", bool(args), str(args))
    joined = " ".join(args)
    check(
        "cli_args.shape",
        joined.startswith("-DOMNI_CLI=") or
        ("-DOMNI_CLI_PYTHON=" in joined and "-DOMNI_CLI_MODULE=omni_cli" in joined),
        joined,
    )


def test_e2e() -> None:
    if os.environ.get("OMNI_BUILD_E2E") != "1":
        print("skip e2e build (set OMNI_BUILD_E2E=1 to enable)")
        return
    root = workspace()
    if not root:
        print("skip e2e build (workspace not found)")
        return
    project = root / "examples" / "basic" / "template"
    result = run_build(
        project_dir=str(project),
        omni_root=str(root / "omni"),
        board="stm32f407ig",
        compiler="ac6",
        build_type="Debug",
    )
    check("e2e.success", result.success, f"exit={result.exit_code}")
    check("e2e.size", result.size is not None and result.size["code"] > 0, str(result.size))
    check("e2e.artifacts", "omni.axf" in result.artifacts, str(sorted(result.artifacts)))


def main() -> int:
    test_parser()
    test_build_directory()
    test_toolchain()
    test_parse_size_and_artifacts()
    test_cli_args()
    test_e2e()
    if failures:
        print(f"{len(failures)} failure(s): {', '.join(failures)}")
        return 1
    print("all build tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
