"""工程构建配置命令：config [generate|menuconfig|bsp|sync-keil]。

本地执行，不经过 OMNI Link 后端；实现位于 ``omni_cli.config``。
"""

from __future__ import annotations

import io
import json
import os
import sys

from ..options import config_parser
from .. import context
from ..config.bspgen import run_bspgen
from ..context import ProjectError
from ..config.uvproj_sync import sync_uvprojx_project


def add_parser(sub):
    p = sub.add_parser(
        "config",
        parents=[config_parser()],
        help="工程构建配置（Kconfig/BSP/Keil 同步；本地执行，不依赖后端）",
    )
    ps = p.add_subparsers(dest="config_sub", metavar="<sub>")

    s = ps.add_parser("generate", parents=[config_parser()],
                      help="生成/更新工程配置（Kconfig + BSP，可选 MSP/Keil 同步）")
    s.add_argument("--msp", action="store_true", default=False,
                   help="同时生成 driver_msp_config.h")
    s.add_argument("--no-bsp", action="store_true", default=False,
                   help="跳过 bsp_config.h 生成")
    s.add_argument("--sync-keil", action="store_true", default=False,
                   help="生成后同步 Keil 工程（默认全部 *.uvprojx）")
    s.add_argument("--uvprojx", action="append", default=None, metavar="FILE",
                   help="只同步指定 Keil 工程（可重复；默认全部）")
    s.add_argument("--stop-on-change", action="store_true", default=False,
                   help="Keil 工程有变化时返回退出码 2")
    s.set_defaults(func=_run_local(_generate))

    s = ps.add_parser("menuconfig", parents=[config_parser()],
                      help="打开交互式 menuconfig 并回写配置")
    s.set_defaults(func=_run_local(_menuconfig))

    s = ps.add_parser("bsp", parents=[config_parser()],
                      help="从链接 map/源码生成 bsp_config.h")
    s.add_argument("--map", default=None, metavar="PATH",
                   help="显式指定链接 map（默认自动发现）")
    s.set_defaults(func=_run_local(_bsp))

    s = ps.add_parser("sync-keil", parents=[config_parser()],
                      help="按已有 .config 同步 Keil 工程（默认全部 *.uvprojx）")
    s.add_argument("--uvprojx", action="append", default=None, metavar="FILE",
                   help="只同步指定 Keil 工程（可重复；默认全部）")
    s.add_argument("--stop-on-change", action="store_true", default=False,
                   help="Keil 工程有变化时返回退出码 2")
    s.set_defaults(func=_run_local(_sync_keil))

    # `omni config`（不带子命令）= `omni config generate`
    p.set_defaults(func=_run_local(_generate), config_sub="generate")


def _opt(args, name, default=None):
    return getattr(args, name, default)


def _run_local(handler):
    def _run(args):
        try:
            return handler(args) or 0
        except ProjectError as exc:
            return _report_error(args, str(exc), exc.code)
        except KeyboardInterrupt:
            return _report_error(args, "interrupted", 1)
        except OSError as exc:
            return _report_error(args, f"file/process operation failed: {exc}", 1)
        except Exception as exc:  # 防止工程命令抛出未格式化 traceback
            return _report_error(args, f"{type(exc).__name__}: {exc}", 1)

    return _run


def _report_error(args, message: str, code: int) -> int:
    quiet = getattr(args, "quiet", False)
    if not quiet:
        if getattr(args, "json_", False):
            print(json.dumps(
                {"success": False, "exit_code": code, "error": message},
                ensure_ascii=False,
                indent=2,
            ))
        else:
            print(f"Error: {message}", file=sys.stderr)
    return code


def _json_mode(args) -> bool:
    return bool(getattr(args, "json_", False))


def _log_for(args):
    if _json_mode(args) or getattr(args, "quiet", False):
        return lambda message: None
    return print


def _err_for(args):
    if _json_mode(args) or getattr(args, "quiet", False):
        return io.StringIO()
    return sys.stderr


def _project_path(project_dir: str, value: str) -> str:
    """相对路径按工程目录解析（与旧脚本的 cwd=工程目录一致）。"""

    return value if os.path.isabs(value) else os.path.join(project_dir, value)


def _uvprojx_args(project_dir: str, values):
    return [_project_path(project_dir, value) for value in values] if values else None


def _finish(args, payload: dict, human: str = "") -> None:
    if getattr(args, "quiet", False):
        return
    if _json_mode(args):
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if human:
        print(human)


def _generate(args) -> int:
    from ..config.generate import generate_project_config

    ctx = context.resolve_context(
        project_dir=args.project_dir,
        omni_root=args.omni_root,
        target=args.board,
    )
    err = _err_for(args)
    result = generate_project_config(
        project_dir=ctx.project_dir,
        omni_root=ctx.omni_root,
        target=ctx.target,
        msp=bool(_opt(args, "msp", False)),
        no_bsp=bool(_opt(args, "no_bsp", False)),
        sync_keil=bool(_opt(args, "sync_keil", False)),
        uvprojx_paths=_uvprojx_args(ctx.project_dir, _opt(args, "uvprojx")),
        clean_config=True,
        log=_log_for(args),
        err=err,
    )

    exit_code = 0
    if _opt(args, "stop_on_change", False) and result.uvprojx_changed:
        exit_code = 2

    payload = {
        "success": exit_code == 0,
        "exit_code": exit_code,
        "project_dir": ctx.project_dir,
        "omni_root": ctx.omni_root,
        "board": ctx.target,
        "generated": result.generated,
        "uvprojx_changed": result.uvprojx_changed,
        "uvprojx_files": result.uvprojx_files,
        "warnings": result.warnings,
        "log": result.log_lines,
        "stderr": err.getvalue() if hasattr(err, "getvalue") else "",
    }
    human = "Configuration generated."
    if exit_code == 2:
        human = "Keil project updated; reload/rebuild the project."
    _finish(args, payload, human)
    return exit_code


def _menuconfig(args) -> int:
    from ..config.generate import generate_after_menuconfig
    from ..config.menuconfig import run_menuconfig

    if _json_mode(args) or getattr(args, "quiet", False):
        raise ProjectError("menuconfig 是交互式命令，不支持 --json / --quiet", code=2)
    if not sys.stdin.isatty():
        raise ProjectError(
            "menuconfig 需要交互式终端，请在 PowerShell/CMD 中运行，不要在 CI 管道中使用。",
            code=2,
        )
    ctx = context.resolve_context(
        project_dir=args.project_dir,
        omni_root=args.omni_root,
        target=args.board,
    )
    rc = run_menuconfig(
        project_dir=ctx.project_dir,
        omni_root=ctx.omni_root,
        target=ctx.target,
    )
    if rc != 0:
        return rc
    generate_after_menuconfig(
        project_dir=ctx.project_dir,
        omni_root=ctx.omni_root,
        target=ctx.target,
    )
    print("menuconfig saved; configuration headers updated.")
    return 0


def _bsp(args) -> int:
    ctx = context.resolve_context(
        project_dir=args.project_dir,
        target=args.board,
        require_omni=False,
    )
    map_path = _project_path(ctx.project_dir, args.map) if args.map else None
    before = None
    path = os.path.join(ctx.project_dir, "boards", ctx.target, "config", "bsp_config.h")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            before = handle.read()

    log = _log_for(args)
    out = run_bspgen(ctx.project_dir, ctx.target, map_path, log=log)
    after = None
    if os.path.exists(out):
        with open(out, "r", encoding="utf-8") as handle:
            after = handle.read()

    payload = {
        "success": True,
        "exit_code": 0,
        "project_dir": ctx.project_dir,
        "board": ctx.target,
        "bsp_config": out,
        "changed": before != after,
    }
    _finish(args, payload, f"BSP header: {out}")
    return 0


def _sync_keil(args) -> int:
    ctx = context.resolve_context(
        project_dir=args.project_dir,
        omni_root=args.omni_root,
        require_target=False,
    )
    dot_config = os.path.join(ctx.project_dir, ".config")
    if not os.path.exists(dot_config):
        raise ProjectError(
            f"未找到 {dot_config}；请先运行 omni config 生成配置。",
            code=1,
        )

    log = _log_for(args)
    changed, files = sync_uvprojx_project(
        ctx.project_dir,
        dot_config,
        uvprojx_paths=_uvprojx_args(ctx.project_dir, args.uvprojx),
        repo_root=ctx.repo_root,
        log=log,
    )
    exit_code = 2 if (args.stop_on_change and changed) else 0
    payload = {
        "success": exit_code == 0,
        "exit_code": exit_code,
        "project_dir": ctx.project_dir,
        "changed": changed,
        "uvprojx": files,
    }
    human = "Keil project updated." if changed else "Keil project unchanged."
    _finish(args, payload, human)
    return exit_code
