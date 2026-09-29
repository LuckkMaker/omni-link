"""CLI 命令分发。

- 两层子命令结构：`omni <group> <sub> [--全局选项]`
- 每个叶子命令绑定 run_command(handler) 包装：解析后端连接（托管/附加）、
  统一异常与退出码。
"""

import argparse

from . import __version__, client
from .commands import backend, commander, debug, device, flash, probe, rtt, target
from .formatting import ctx_error

PROG = "omni"

_COMMAND_MODULES = (backend, commander, debug, device, flash, probe, rtt, target)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description="OMNI Link CLI - 通过复用 OMNI Link 后端接口开放探针/烧录/RTT 等能力",
    )
    parser.add_argument("--version", action="version", version=f"omni {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    for mod in _COMMAND_MODULES:
        mod.add_parser(sub)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    try:
        return getattr(args, "func")(args)
    except client.ApiError as e:
        return ctx_error(e.detail)
    except KeyboardInterrupt:
        return ctx_error("已中断")