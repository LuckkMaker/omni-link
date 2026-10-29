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
from omni_cli.builder.report import (
    compact_command,
    shorten_path,
    steps_from_log,
    summarize_failure,
)
from omni_cli.builder.runner import (
    ARTIFACTS,
    _cli_configure_args,
    build_directory,
    cache_conflicts,
    collect_artifacts,
    parse_size,
    read_cache_context,
    run_build,
    runner_argv,
    target_kind,
    toolchain_file,
)
from omni_cli.formatting import Palette, color_enabled

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


def test_target_kind() -> None:
    project = os.path.join("D:\\", "proj", "template")
    check("target.none", target_kind(None, project) == ("none", ""))
    check("target.clean", target_kind("clean", project) == ("clean", ""))
    check("target.size", target_kind("size", project) == ("cmake", "omni-size-template"),
          str(target_kind("size", project)))
    check("target.flash", target_kind("flash", project) == ("runner", ""))
    check("target.run", target_kind("run", project) == ("runner", ""))
    check("target.raw", target_kind("omni-size-template", project) ==
          ("cmake", "omni-size-template"))


def test_runner_argv() -> None:
    argv = runner_argv("flash", "/x/omni.axf", ["--no-verify"])
    check("runner.argv", argv[-4:] == ["flash", "program", "/x/omni.axf", "--no-verify"],
          str(argv))
    check("runner.base", bool(argv[0]), str(argv))


def test_parser() -> None:
    parser = build_parser()
    args = parser.parse_args(["build", "-b", "stm32f407ig"])
    check("parser.board", args.board == "stm32f407ig")
    check("parser.compiler", args.compiler == "ac6")
    check("parser.build_type", args.build_type == "Debug")
    args = parser.parse_args(["build", "-b", "x", "-c", "gcc", "--build-type", "Release",
                              "--clean", "--configure-only", "--cmake", "-t", "omni-size-template",
                              "--cmake-arg=-DFOO=1", "-j", "8", "--json"])
    check("parser.options", args.compiler == "gcc" and args.build_type == "Release"
          and args.clean and args.configure_only and args.cmake and args.jobs == 8
          and args.json_ and args.target == "omni-size-template"
          and args.cmake_args == ["-DFOO=1"], str(args))


def test_cache_context() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cache_path = os.path.join(tmp, "CMakeCache.txt")
        with open(cache_path, "w", encoding="utf-8") as handle:
            handle.write("// comment\n")
            handle.write("OMNI_BOARD:STRING=stm32f407ig\n")
            handle.write("OMNI_COMPILER:STRING=ac6\n")
            handle.write("CMAKE_BUILD_TYPE:STRING=Debug\n")
            handle.write("OTHER:STRING=x\n")
        cache = read_cache_context(tmp)
        check("cache.read", cache == {"board": "stm32f407ig", "compiler": "ac6",
                                      "build_type": "Debug"}, str(cache))
        check("cache.same", cache_conflicts(cache, "stm32f407ig", "ac6", "Debug") == [])
        conflicts = cache_conflicts(cache, "stm32h743ii", "ac6", "Debug")
        check("cache.conflict", len(conflicts) == 1 and "board" in conflicts[0], str(conflicts))
        check("cache.empty", read_cache_context(os.path.join(tmp, "nope")) == {})


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
    gcc = toolchain_file(omni_root, "gcc")
    check("toolchain.gcc", gcc.endswith("gcc.cmake") and os.path.isfile(gcc), gcc)
    try:
        toolchain_file(omni_root, "ac5")
    except ProjectError as exc:
        check("toolchain.ac5", "尚未提供" in str(exc))
    else:
        check("toolchain.ac5", False, "ac5 未报错")


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
        check("artifacts.list", "omni.axf.map" in ARTIFACTS and "omni.elf" in ARTIFACTS)


def test_report_helpers() -> None:
    configure = [
        "cmake", "-S", "D:/proj", "-B", "D:/proj/build/stm32f407ig/AC6/Debug",
        "-G", "Ninja", "-DOMNI_BOARD=stm32f407ig",
    ]
    check("report.compact_configure",
          compact_command(configure, "configure") ==
          "cmake -S D:/proj -B D:/proj/build/stm32f407ig/AC6/Debug -G Ninja",
          compact_command(configure, "configure"))

    build = ["cmake", "--build", "D:/proj/build", "--target", "omni-size-x", "--parallel", "8"]
    check("report.compact_build",
          compact_command(build, "build") ==
          "cmake --build D:/proj/build --target omni-size-x --parallel 8",
          compact_command(build, "build"))

    check("report.shorten", shorten_path(r"D:\ws\omni-emb\modules\a.h", r"D:\ws\omni-emb")
          == "modules\\a.h" or shorten_path(r"D:\ws\omni-emb\modules\a.h", r"D:\ws\omni-emb")
          == "modules/a.h", shorten_path(r"D:\ws\omni-emb\modules\a.h", r"D:\ws\omni-emb"))
    check("report.shorten_outside",
          shorten_path(r"D:\other\a.h", r"D:\ws") == r"D:\other\a.h")

    sample = "\n".join([
        "[1/129] Building C object a.o",
        "FAILED: obj/a.o",
        "D:/ws/modules/x/include/y.h:32:10: fatal error: 'Z.h' file not found",
        "[2/129] Building C object b.o",
        "FAILED: obj/a.o",  # 重打日志里重复的目标
        "D:/ws/modules/x/include/y.h:32:10: fatal error: 'Z.h' file not found",
    ])
    summary = summarize_failure(sample)
    check("report.failed_targets", summary["targets"] == 1, str(summary))
    check("report.first_error", summary["first_error"] and summary["first_error"].endswith(
        "fatal error: 'Z.h' file not found"), str(summary))
    check("report.steps", steps_from_log(sample) == 129, str(steps_from_log(sample)))


def test_color() -> None:
    check("color.never", color_enabled("never") is False)
    check("color.always", color_enabled("always") is True)

    old = os.environ.get("NO_COLOR")
    os.environ["NO_COLOR"] = "1"
    try:
        check("color.no_color", color_enabled("auto") is False)
    finally:
        if old is None:
            os.environ.pop("NO_COLOR", None)
        else:
            os.environ["NO_COLOR"] = old

    plain = Palette(False)("x", "\033[31m")
    check("color.palette_off", plain == "x", repr(plain))
    painted = Palette(True)("x", "\033[31m")
    check("color.palette_on", painted.startswith("\033[31m") and painted.endswith("\033[0m"),
          repr(painted))


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
    check("e2e.log_path", bool(result.log_path) and os.path.isfile(result.log_path),
          str(result.log_path))
    if result.log_path:
        with open(result.log_path, encoding="utf-8", errors="replace") as handle:
            raw_log = handle.read()
        check("e2e.log_no_ansi", "\033[" not in raw_log)
    check("e2e.steps", result.steps > 0, str(result.steps))
    check("e2e.timing", result.build_seconds > 0, str(result.build_seconds))
    check("e2e.no_failure", result.failed_targets == 0 and result.first_error is None,
          f"{result.failed_targets} / {result.first_error}")

    # 第二次构建应跳过 configure（构建目录已配置），强制时才重新配置。
    again = run_build(
        project_dir=str(project),
        omni_root=str(root / "omni"),
        board="stm32f407ig",
        compiler="ac6",
        build_type="Debug",
    )
    check("e2e.skip_configure", again.success and not again.configured, str(again.configured))
    forced = run_build(
        project_dir=str(project),
        omni_root=str(root / "omni"),
        board="stm32f407ig",
        compiler="ac6",
        build_type="Debug",
        force_configure=True,
    )
    check("e2e.force_configure", forced.success and forced.configured, str(forced.configured))


def main() -> int:
    test_parser()
    test_target_kind()
    test_runner_argv()
    test_cache_context()
    test_build_directory()
    test_toolchain()
    test_parse_size_and_artifacts()
    test_report_helpers()
    test_color()
    test_cli_args()
    test_e2e()
    if failures:
        print(f"{len(failures)} failure(s): {', '.join(failures)}")
        return 1
    print("all build tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
