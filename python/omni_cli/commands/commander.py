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

# `commander exec` 的全局选项集合。命令参数用 argparse.REMAINDER 收集，写在命令
# 之后的选项会被当成命令参数（实机报告 P3-2）；cli.main 在解析前调用
# normalize_argv() 把已知选项前移，因此这里必须与实际叶子 parser 的选项保持同步。
_VALUE_OPTIONS = {"--uid", "--backend-port", "--timeout"}
_BOOL_OPTIONS = {"--managed", "--json", "--quiet"}
_ALL_OPTIONS = _VALUE_OPTIONS | _BOOL_OPTIONS


def normalize_argv(argv: list[str]) -> list[str]:
    """把 `commander exec` 之后出现的已知全局选项前移到命令之前。

    例：``omni commander exec "read32 0x08000000 4" --timeout 15``
    →  ``omni commander exec --timeout 15 "read32 0x08000000 4"``

    只处理顶层命令正好是 ``commander exec`` 的情况；遇到 ``--`` 后停止提取
    （其后都是命令参数）。未知选项保持原位，由后端按命令参数报错并给出提示。
    """
    if not argv or argv[0] != "commander":
        return argv
    if len(argv) < 2 or argv[1] != "exec":
        return argv

    head_end = 2
    tail = argv[head_end:]
    extracted: list[str] = []
    kept: list[str] = []
    i = 0
    stop = False
    while i < len(tail):
        token = tail[i]
        if stop:
            kept.append(token)
            i += 1
            continue
        if token == "--":
            stop = True
            kept.append(token)
            i += 1
            continue
        if token in _BOOL_OPTIONS:
            extracted.append(token)
            i += 1
            continue
        if token in _VALUE_OPTIONS:
            if i + 1 < len(tail):
                extracted.extend([token, tail[i + 1]])
                i += 2
            else:
                kept.append(token)
                i += 1
            continue
        if "=" in token and token.split("=", 1)[0] in _ALL_OPTIONS:
            extracted.append(token)
            i += 1
            continue
        kept.append(token)
        i += 1

    if not extracted:
        return argv
    return argv[:head_end] + extracted + kept


def add_parser(sub):
    p = sub.add_parser("commander", help="执行 pyOCD Commander 命令（read32/write32/reg…）")
    ps = p.add_subparsers(dest="commander_sub", metavar="<sub>")

    s = ps.add_parser(
        "exec", parents=[common_parser()], help="执行单条命令",
        epilog="已知全局选项（--uid/--backend-port/--timeout/--json/--managed/--quiet）"
               "写在命令之前或之后都可以（CLI 会自动前移）。"
               "列出 pyOCD 可用命令用 `omni commander exec help`；"
               "`omni commander exec list` 是 pyOCD 的探针/目标列表，不是命令列表。",
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
        print("错误: 请输入命令。参考 `omni commander exec help` 查看可用命令。")
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
        print("提示: 检查参数个数/格式（如 read32 0x080000C0 4）。全局选项写在命令之后也行"
              "（--uid/--json/--timeout 等会被自动前移）；其它以 -- 开头的选项仍须写在命令之前。"
              "用 `omni commander exec help` 查看全部命令，`omni commander exec help <命令>` 查看用法。")


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