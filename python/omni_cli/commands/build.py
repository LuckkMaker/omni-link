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
import sys

from .. import context
from ..builder.runner import (
    BUILD_TYPES,
    COMPILERS,
    DEFAULT_BUILD_TYPE,
    DEFAULT_COMPILER,
    run_build,
    runner_argv,
)
from ..context import ProjectError
from ..options import config_parser


def add_parser(sub):
    p = sub.add_parser(
        "build",
        parents=[config_parser()],
        help="配置并构建工程（CMake + Ninja；本地执行）",
    )
    p.add_argument("-c", "--compiler", default=DEFAULT_COMPILER, choices=COMPILERS,
                   help=f"编译器（默认 {DEFAULT_COMPILER}；当前仅 ac6 提供工具链文件）")
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
                   help="打印 cmake 的完整输出")
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
    log = (lambda message: None) if quiet else (lambda message: print(message))

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
        log=log,
    )
    payload = {"board": ctx.target, **result.as_dict()}

    if not result.success:
        if getattr(args, "quiet", False):
            return result.exit_code
        if getattr(args, "json_", False):
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return result.exit_code
        # 失败时把 cmake 输出打到 stderr，方便定位。
        tail = "\n".join(part for part in result.log if part)
        if tail:
            print(tail.rstrip(), file=sys.stderr)
        print(
            f"构建失败（exit {result.exit_code}）: {ctx.project_dir} "
            f"[{ctx.target} / {args.compiler} / {args.build_type}]",
            file=sys.stderr,
        )
        return result.exit_code

    if not getattr(args, "quiet", False) and not getattr(args, "json_", False):
        print(f"构建目录: {result.build_dir}")
        if result.size:
            size = result.size
            print(
                "Program Size: Code={code} RO-data={ro_data} RW-data={rw_data} "
                "ZI-data={zi_data}".format(**size)
            )
        for name, path in result.artifacts.items():
            print(f"  {name:14s} {path}")
        if args.configure_only:
            print("（仅配置，未编译）")

    # runner 目标（flash / run）：构建完成后调用 omni flash program。
    if result.runner:
        elf = result.artifacts.get("omni.axf")
        if not elf:
            raise ProjectError(
                f"目标 '{result.runner}' 需要 omni.axf，但构建产物里没有", code=1
            )
        argv = runner_argv(result.runner, elf, args.runner_args)
        payload["runner_command"] = argv
        if not getattr(args, "quiet", False) and not getattr(args, "json_", False):
            print(f"runner: {' '.join(argv)}")
        rc = _run_runner(argv, quiet=getattr(args, "quiet", False) or getattr(args, "json_", False),
                         verbose=args.verbose, log=log)
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
