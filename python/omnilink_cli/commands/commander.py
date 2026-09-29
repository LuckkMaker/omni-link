"""Commander 命令：exec（单条）+ shell（交互式 REPL）。

复用后端 commander_backend 的全部 pyOCD 命令（reg/read32/write32/break/step/
disasm 等）。离线命令（list/help/exit/quit/!...）无需连接探针也可执行。
"""

import argparse
import sys

from ..client import ApiClient
from ..options import common_parser
from ..runtime import finish, run_command
from ..util import resolve_uid


def add_parser(sub):
    p = sub.add_parser("commander", help="执行 pyOCD Commander 命令（read32/write32/reg…）")
    ps = p.add_subparsers(dest="commander_sub", metavar="<sub>")

    s = ps.add_parser(
        "exec", parents=[common_parser()], help="执行单条命令",
        epilog="注意: 全局选项（--uid/--backend-port/--json）必须写在命令之前，"
               "例如 `omni commander exec --uid 852001270 read32 0x080000C0 4`。",
    )
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针；离线命令可省略）")
    s.add_argument("command", nargs=argparse.REMAINDER, help="命令及其参数，如 read32 0x20000000 16")
    s.set_defaults(func=run_command(_exec))

    s = ps.add_parser("shell", parents=[common_parser()], help="进入交互式 REPL")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针；离线命令可省略）")
    s.add_argument("--command", dest="batch", default="", metavar="CMD",
                   help="非交互执行给定命令后退出（可配合 ; 分隔多条）")
    s.set_defaults(func=run_command(_shell))


def _exec(c: ApiClient, args):
    if not args.command:
        print("错误: 请输入命令。参考 `omni commander exec list` 查看可用命令。")
        return 1
    cmd = " ".join(args.command)
    uid = resolve_uid(c, args) or "0"
    data = c.post(f"/api/probes/{uid}/commander/exec", {"command": cmd})
    _print_exec_result(args, data)
    return 0 if data.get("success") else 1


def _shell(c: ApiClient, args):
    if args.batch:
        for line in args.batch.split(";"):
            line = line.strip()
            if not line:
                continue
            if _should_exit(line):
                break
            _exec_cmd(c, args, line)
        return 0
    print("OMNI Link Commander REPL（输入 exit/quit 或 Ctrl+D 退出）")
    while True:
        try:
            line = input("omni> ")
        except EOFError:
            print()
            break
        line = line.strip()
        if not line:
            continue
        if _should_exit(line):
            break
        _exec_cmd(c, args, line)
    return 0


def _should_exit(line: str) -> bool:
    first = line.split()[0].lower() if line.split() else ""
    return first in ("exit", "quit")


def _exec_cmd(c: ApiClient, args, line: str):
    uid = resolve_uid(c, args) or "0"
    try:
        data = c.post(f"/api/probes/{uid}/commander/exec", {"command": line})
    except Exception as e:  # 网络/底层错误在 REPL 中不应中断会话
        print(f"错误: {e}")
        return
    out = data.get("output", "").rstrip()
    if out:
        print(out)
    err = data.get("error")
    if err:
        print(f"错误: {err}", file=sys.stderr)
        _print_hint(err)


def _print_hint(err: str) -> None:
    """pyOCD 的参数错误信息过于笼统，补一句可操作的指引。"""
    if "argument" in err.lower():
        print("提示: 检查参数个数/格式（如 read32 0x080000C0 4）。"
              "用 `omni commander exec help <命令>` 查看用法，`omni commander exec list` 列出全部命令。")


def _print_exec_result(args, data: dict):
    if args.json_:
        finish(args, data, "")
        return
    out = data.get("output", "").rstrip()
    if out:
        print(out)
    if not data.get("success") and data.get("error"):
        print(f"错误: {data['error']}")
        _print_hint(data["error"])