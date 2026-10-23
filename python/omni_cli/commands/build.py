"""构建命令：build（本地执行，不经过后端）。

等价于手工执行：

    cmake -S <project> -B <project>/build/<board>/<COMPILER>/<buildtype> -G Ninja \\
          -DOMNI_WORKSPACE_DIR=<repo> -DOMNI_BOARD=<board> -DOMNI_COMPILER=<compiler> \\
          -DCMAKE_TOOLCHAIN_FILE=<omni>/cmake/toolchains/<compiler>.cmake \\
          -DCMAKE_BUILD_TYPE=<buildtype>
    cmake --build <build-dir>
"""

from __future__ import annotations

import json
import os
import sys

from .. import context
from ..builder.report import BuildReporter
from ..builder.runner import (
    BUILD_TYPES,
    COMPILERS,
    DEFAULT_BUILD_TYPE,
    DEFAULT_COMPILER,
    _cli_base,
    build_directory,
    run_build,
    runner_argv,
)
from ..context import ProjectError
from ..formatting import Palette, color_enabled
from ..options import config_parser


def add_parser(sub):
    p = sub.add_parser(
        "build",
        parents=[config_parser()],
        help="配置并构建工程（CMake + Ninja；本地执行）",
    )
    p.add_argument("-c", "--compiler", default=DEFAULT_COMPILER, choices=COMPILERS,
                   help=f"编译器（默认 {DEFAULT_COMPILER}；ac6 / gcc / clang 提供工具链文件）")
    p.add_argument("--build-type", dest="build_type", default=DEFAULT_BUILD_TYPE,
                   choices=BUILD_TYPES, help=f"构建类型（默认 {DEFAULT_BUILD_TYPE}）")
    p.add_argument("--cmake", action="store_true", default=False,
                   help="强制重新执行 CMake 配置（默认构建目录已存在时跳过）")
    p.add_argument("--clean", action="store_true", default=False,
                   help="先删除该上下文的构建目录")
    p.add_argument("--configure-only", action="store_true", default=False,
                   help="只做 CMake 配置，不编译")
    p.add_argument("-t", "--target", default=None, metavar="TARGET",
                   help="size | clean | flash | run | <cmake target>；flash/run 构建后调用 runner")
    p.add_argument("--runner-arg", dest="runner_args", action="append", default=None,
                   metavar="ARG", help="额外传给 runner（omni flash program）的参数（可重复）")
    p.add_argument("-o", "--cmake-arg", dest="cmake_args", action="append", default=None,
                   metavar="ARG", help="额外传给 cmake 配置的参数（可重复）")
    p.add_argument("-j", "--jobs", type=int, default=None, metavar="N",
                   help="并行编译任务数（默认交给 Ninja）")
    p.add_argument("-v", "--verbose", action="store_true", default=False,
                   help="打印完整命令（默认只显示缩写）并保留 cmake 全部输出")
    p.add_argument("--color", choices=("auto", "always", "never"), default="auto",
                   help="彩色输出（默认 auto：TTY 下开启；NO_COLOR 可关闭）")
    p.set_defaults(func=_run(_build))


def _run(handler):
    def _wrapped(args):
        try:
            return handler(args) or 0
        except ProjectError as exc:
            return _error(args, str(exc), exc.code)
        except OSError as exc:
            return _error(args, f"file/process operation failed: {exc}", 1)
        except KeyboardInterrupt:
            return _error(args, "已中断", 1)
        except Exception as exc:  # 防止未格式化的 traceback
            return _error(args, f"{type(exc).__name__}: {exc}", 1)

    return _wrapped


def _error(args, message: str, code: int) -> int:
    if not getattr(args, "quiet", False):
        if getattr(args, "json_", False):
            print(json.dumps(
                {"success": False, "exit_code": code, "error": message},
                ensure_ascii=False,
                indent=2,
            ))
        else:
            print(f"Error: {message}", file=sys.stderr)
    return code


def _build(args) -> int:
    ctx = context.resolve_context(
        project_dir=args.project_dir,
        omni_root=args.omni_root,
        target=args.board,
    )
    quiet = getattr(args, "quiet", False) or getattr(args, "json_", False)
    build_dir = build_directory(ctx.project_dir, ctx.target or "", args.compiler,
                                args.build_type)
    reporter = BuildReporter(
        Palette(color_enabled(getattr(args, "color", "auto"))),
        quiet=quiet,
        verbose=args.verbose,
        project_dir=ctx.project_dir,
        build_dir=build_dir,
        root=ctx.repo_root,
    )
    reporter.header(
        os.path.basename(os.path.normpath(ctx.project_dir)),
        ctx.target or "?",
        args.compiler,
        args.build_type,
    )
    if args.verbose and not quiet:
        reporter.info(f"omni root: {ctx.omni_root}")
        reporter.info("omni CLI : " + " ".join(_cli_base()))

    result = run_build(
        project_dir=ctx.project_dir,
        omni_root=ctx.omni_root,
        board=ctx.target,
        compiler=args.compiler,
        build_type=args.build_type,
        clean=args.clean,
        force_configure=args.cmake,
        configure_only=args.configure_only,
        target=args.target,
        jobs=args.jobs,
        cmake_args=args.cmake_args,
        verbose=args.verbose,
        stream_build=not quiet,
        stream=None if quiet else reporter.line,
        on_start=None if quiet else reporter.phase,
        log=reporter.info,
    )
    payload = {"board": ctx.target, **result.as_dict()}

    if not result.success:
        if getattr(args, "quiet", False):
            return result.exit_code
        if getattr(args, "json_", False):
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return result.exit_code
        # 日志已经逐行实时打印过；这里只给结论，不再把整份日志重打一遍。
        reporter.failure(result, phase=result.failed_phase or "build")
        return result.exit_code

    if not getattr(args, "quiet", False) and not getattr(args, "json_", False):
        reporter.success(result, configure_only=args.configure_only)

    # runner 目标（flash / run）：构建完成后调用 omni flash program。
    if result.runner:
        # AC6 产物是 omni.axf，GCC/CLANG 是 omni.elf；两种都接受。
        elf = result.artifacts.get("omni.axf") or result.artifacts.get("omni.elf")
        if not elf:
            raise ProjectError(
                f"目标 '{result.runner}' 需要 omni.axf 或 omni.elf，但构建产物里没有", code=1
            )
        argv = runner_argv(result.runner, elf, args.runner_args)
        payload["runner_command"] = argv
        if not quiet:
            reporter.info(f"runner: {' '.join(argv)}")
        rc = _run_runner(argv, quiet=quiet, verbose=args.verbose, log=reporter.info)
        payload["runner_exit_code"] = rc
        payload["success"] = rc == 0
        payload["exit_code"] = rc
        if getattr(args, "json_", False):
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return rc

    if getattr(args, "json_", False):
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _run_runner(argv: list, *, quiet: bool, verbose: bool, log) -> int:
    """执行 runner 命令（omni flash program ...），输出透传或按需捕获。"""

    import subprocess

    if not quiet:
        log(f"$ {' '.join(argv)}")
    try:
        if quiet:
            proc = subprocess.run(
                argv, capture_output=True, text=True, encoding="utf-8", errors="replace"
            )
        else:
            proc = subprocess.run(argv)
    except OSError as exc:
        raise ProjectError(f"runner 执行失败: {argv[0]}: {exc}", code=1) from exc
    return proc.returncode
