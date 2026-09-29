"""调试控制命令组（Phase 4）：执行控制、ELF、源码断点、寄存器、内存。

对标前端 Zone 调试工作台，复用 `/api/probes/{uid}/zone/*` 接口。

会话状态（ELF 是否已加载、断点表、目标是否 halt）保存在**后端**，
CLI 每条命令都是独立进程，因此 `omni debug elf load` 之后可直接在
下一条命令里下断点、查寄存器，不需要在同一进程内维持会话。
"""

import os
import urllib.parse

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser
from ..runtime import finish, run_command
from ..util import parse_int, require_uid


def add_parser(sub):
    p = sub.add_parser("debug", help="调试控制（执行控制 / ELF / 断点 / 寄存器 / 内存）")
    ps = p.add_subparsers(dest="debug_sub", metavar="<sub>")

    # ── 执行控制 ──────────────────────────────
    s = ps.add_parser("status", parents=[common_parser()], help="查询目标状态（halted/running + PC）")
    _uid(s)
    s.set_defaults(func=run_command(_status))

    s = ps.add_parser("halt", parents=[common_parser()], help="暂停目标")
    _uid(s)
    s.set_defaults(func=run_command(_halt))

    s = ps.add_parser("run", parents=[common_parser()], help="继续运行（continue）")
    _uid(s)
    s.set_defaults(func=run_command(_run))

    s = ps.add_parser("step", parents=[common_parser()], help="单步（源码级；无 DWARF 时回退指令级）")
    _uid(s)
    s.add_argument("--mode", choices=["into", "over", "out"], default="into",
                   help="into=进入(默认) / over=跳过 / out=跳出")
    s.set_defaults(func=run_command(_step))

    s = ps.add_parser("reset", parents=[common_parser()], help="复位目标")
    _uid(s)
    s.add_argument("--mode", choices=["halt", "run", "break-symbol"], default="halt",
                   help="halt=复位暂停(默认) / run=复位运行 / break-symbol=复位运行并停在入口符号")
    s.set_defaults(func=run_command(_reset))

    s = ps.add_parser("run-to-cursor", parents=[common_parser()], help="运行到指定源码行后暂停")
    _uid(s)
    s.add_argument("--file", required=True, help="源文件（ELF 中记录的路径或其后缀）")
    s.add_argument("--line", type=int, required=True, help="行号")
    s.set_defaults(func=run_command(_run_to_cursor))

    # ── ELF ──────────────────────────────────
    s = ps.add_parser("elf", help="ELF/AXF 加载与查询")
    se = s.add_subparsers(dest="debug_elf_sub", metavar="<sub>")
    ss = se.add_parser("load", parents=[common_parser()], help="加载 ELF/AXF（后端按 uid 保存）")
    _uid(ss)
    ss.add_argument("path", help="ELF/AXF 文件路径")
    ss.set_defaults(func=run_command(_elf_load))
    ss = se.add_parser("info", parents=[common_parser()], help="查询已加载的 ELF")
    _uid(ss)
    ss.set_defaults(func=run_command(_elf_info))
    s.set_defaults(func=run_command(_usage("debug elf <load|info>")))

    # ── 源码（用于获取 bp 所需的 file:line）────
    s = ps.add_parser("src", help="源码查询（源文件列表 / 地址反查源码行）")
    sc = s.add_subparsers(dest="debug_src_sub", metavar="<sub>")
    ss = sc.add_parser("files", parents=[common_parser()], help="列出 ELF 中的源文件")
    _uid(ss)
    ss.add_argument("--filter", help="按路径子串过滤")
    ss.set_defaults(func=run_command(_src_files))
    ss = sc.add_parser("line", parents=[common_parser()], help="地址 → 源码位置（文件/行/函数）")
    _uid(ss)
    ss.add_argument("--addr", required=True, help="地址（hex 或符号表达式）")
    ss.set_defaults(func=run_command(_src_line))
    s.set_defaults(func=run_command(_usage("debug src <files|line>")))

    # ── 源码行断点 ────────────────────────────
    s = ps.add_parser("bp", help="源码行断点管理")
    sb = s.add_subparsers(dest="debug_bp_sub", metavar="<sub>")

    ss = sb.add_parser("add", parents=[common_parser()], help="按源码行设置断点")
    _uid(ss)
    ss.add_argument("--file", required=True, help="源文件（ELF 中记录的路径或其后缀）")
    ss.add_argument("--line", type=int, required=True, help="行号")
    ss.add_argument("--mode", choices=["break", "log", "execute"], default="break",
                    help="断点模式（默认 break）")
    ss.add_argument("--condition", help="触发条件表达式")
    ss.set_defaults(func=run_command(_bp_add))

    ss = sb.add_parser("list", parents=[common_parser()], help="列出当前全部断点")
    _uid(ss)
    ss.set_defaults(func=run_command(_bp_list))

    ss = sb.add_parser("del", parents=[common_parser()], help="删除断点（--address 或 --file+--line）")
    _uid(ss)
    _bp_locator(ss)
    ss.set_defaults(func=run_command(_bp_del))

    for name, help_ in [("enable", "启用断点"), ("disable", "停用断点（保留记录）")]:
        ss = sb.add_parser(name, parents=[common_parser()], help=help_)
        _uid(ss)
        _bp_locator(ss)
        ss.set_defaults(func=run_command(_bp_toggle))

    ss = sb.add_parser("clear", parents=[common_parser()], help="清除全部断点")
    _uid(ss)
    ss.set_defaults(func=run_command(_bp_clear))

    s.set_defaults(func=run_command(_usage("debug bp <add|list|del|enable|disable|clear>")))

    # ── 寄存器 ────────────────────────────────
    s = ps.add_parser("regs", parents=[common_parser()], help="读取 CPU 核心寄存器")
    _uid(s)
    s.add_argument("--filter", help="按名称子串过滤（如 pc / r1）")
    s.set_defaults(func=run_command(_regs))

    # ── 内存 ──────────────────────────────────
    s = ps.add_parser("mem", help="内存查看")
    sm = s.add_subparsers(dest="debug_mem_sub", metavar="<sub>")

    ss = sm.add_parser("read", parents=[common_parser()], help="读取内存并 hex dump")
    _uid(ss)
    ss.add_argument("--addr", required=True, help="起始地址（hex 或符号表达式，如 0x20000000 / &counter）")
    ss.add_argument("--size", type=int, default=64, help="读取字节数（1-1024，默认 64）")
    ss.set_defaults(func=run_command(_mem_read))

    ss = sm.add_parser("resolve", parents=[common_parser()], help="解析地址表达式（hex / &符号 / name[下标]）")
    _uid(ss)
    ss.add_argument("expr", help="地址表达式")
    ss.set_defaults(func=run_command(_mem_resolve))

    s.set_defaults(func=run_command(_usage("debug mem <read|resolve>")))


# ── 执行控制 ──────────────────────────────

def _status(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/debug/status")
    finish(args, data, _state_text(data))
    return 0


def _halt(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/debug/halt")
    payload, st = _with_state(c, uid, data)
    finish(args, payload, f"已暂停  ({st})")
    return 0 if data.get("success") else 1


def _run(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/debug/continue")
    payload, st = _with_state(c, uid, data)
    finish(args, payload, f"已继续运行  ({st})")
    return 0 if data.get("success") else 1


def _step(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/debug/step", {"mode": args.mode})
    payload, st = _with_state(c, uid, data)
    finish(args, payload, f"单步({args.mode})完成  ({st})")
    return 0 if data.get("success") else 1


def _reset(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    mode = "break_symbol" if args.mode == "break-symbol" else args.mode
    data = c.post(f"/api/probes/{uid}/zone/debug/reset", {"mode": mode})
    payload, st = _with_state(c, uid, data)
    if args.mode == "break-symbol":
        symbol = data.get("symbol")
        if data.get("halted"):
            what = f"已复位并停在符号 {symbol}"
        elif symbol:
            what = f"已复位并运行（8s 内未停在符号 {symbol}，请确认板载固件与 ELF 一致）"
        else:
            what = "已复位并暂停（ELF 中无入口符号，回退为 halt）"
    else:
        what = "已复位并暂停" if args.mode == "halt" else "已复位并运行"
    finish(args, payload, f"{what}  ({st})")
    return 0 if data.get("success") else 1


def _run_to_cursor(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/debug/run-to-cursor",
                  {"file": args.file, "line": args.line})
    payload, st = _with_state(c, uid, data)
    addr = data.get("address")
    addr_s = f"0x{addr:08X}" if isinstance(addr, int) else "-"
    finish(args, payload, f"已运行到 {args.file}:{args.line} @{addr_s}  ({st})")
    return 0 if data.get("success") else 1


# ── ELF ──────────────────────────────────

def _elf_load(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    path = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isfile(path):
        print(f"错误: 文件不存在: {path}")
        return 1
    data = c.post(f"/api/probes/{uid}/zone/elf/load", {"path": path})
    files = data.get("source_files") or []
    human = (f"ELF 已加载: {data.get('path')}\n"
             f"  源文件 {len(files)} 个  函数 {data.get('function_count')} 个  "
             f"反汇编可用={'是' if data.get('disasm_available') else '否'}")
    finish(args, data, human)
    return 0 if data.get("success") else 1


def _elf_info(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/elf/info")
    loaded = data.get("loaded")
    finish(args, data, f"已加载: {'是' if loaded else '否'}  路径: {data.get('path') or '-'}")
    return 0


# ── 源码 ──────────────────────────────────

def _src_files(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/source/files")
    files = data.get("files", [])
    if args.filter:
        needle = args.filter.lower()
        files = [f for f in files if needle in str(f.get("path", "")).lower()]
    if args.json_ or args.quiet:
        finish(args, {**data, "files": files}, "")
        return 0
    if not files:
        print("没有匹配的源文件")
        return 0
    rows = [[f.get("name"), _size(f.get("size")), f.get("path")] for f in files]
    print(f"共 {len(files)} 个源文件")
    print(render_table(["名称", "大小", "路径"], rows))
    return 0


def _src_line(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    addr = _resolve_addr(c, uid, args.addr)
    if addr is None:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/source/line?address={addr}")
    line = data.get("line") or {}
    if not line.get("file"):
        finish(args, data, f"{_addr(addr)} 无对应源码行（可能未加载 ELF 或该地址无调试信息）")
        return 1
    text = (f"{_addr(addr)}  {line.get('file')}:{line.get('line')}"
            f"  函数 {line.get('function') or '-'}")
    finish(args, data, text)
    return 0


# ── 源码行断点 ────────────────────────────

def _bp_add(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    payload = {
        "file": args.file, "line": args.line, "set": True,
        "enabled": True, "condition": args.condition, "mode": args.mode,
    }
    data = c.post(f"/api/probes/{uid}/zone/debug/breakpoint", payload)
    addr = data.get("address")
    addr_s = f"0x{addr:08X}" if isinstance(addr, int) else "-"
    finish(args, data, f"断点已设置 {args.file}:{args.line} @{addr_s}")
    return 0 if data.get("success") else 1


def _bp_list(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/breakpoints")
    bps = data.get("breakpoints", [])
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    if not bps:
        print("当前没有断点")
        return 0
    rows = [[_addr(b.get("address")), b.get("file") or "", b.get("line") or "",
             "是" if b.get("enabled", True) else "否",
             b.get("mode") or "break", b.get("condition") or ""] for b in bps]
    print(f"共 {len(bps)} 个断点")
    print(render_table(["地址", "文件", "行", "启用", "模式", "条件"], rows))
    return 0


def _bp_del(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    addr = _locate_bp(c, uid, args)
    if addr is None:
        return 1
    data = c.delete(f"/api/probes/{uid}/zone/debug/breakpoint?address={addr}")
    finish(args, data, f"断点已删除 @{_addr(addr)}")
    return 0


def _bp_toggle(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    addr = _locate_bp(c, uid, args)
    if addr is None:
        return 1
    enable = args.debug_bp_sub == "enable"
    data = c.patch(f"/api/probes/{uid}/zone/debug/breakpoint",
                   {"address": addr, "enabled": enable})
    finish(args, data, f"断点已{'启用' if enable else '停用'} @{_addr(addr)}")
    return 0


def _bp_clear(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.delete(f"/api/probes/{uid}/zone/debug/breakpoints")
    finish(args, data, f"已清除 {data.get('cleared', 0)} 个断点")
    return 0


# ── 寄存器 / 内存 ──────────────────────────

def _regs(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/registers/core")
    regs = data.get("registers", [])
    if args.filter:
        needle = args.filter.lower()
        regs = [r for r in regs if needle in str(r.get("name", "")).lower()]
    if args.json_ or args.quiet:
        if args.filter:
            data = {**data, "registers": regs}
        finish(args, data, "")
        return 0
    if not regs:
        print("没有匹配的寄存器")
        return 0
    rows = [[r.get("name"), _addr(r.get("value")), r.get("group") or "", r.get("description") or ""]
            for r in regs]
    print(render_table(["寄存器", "值", "分组", "说明"], rows))
    return 0


def _mem_read(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    addr = _resolve_addr(c, uid, args.addr)
    if addr is None:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/memory/read",
                  {"address": addr, "length": args.size})
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    if data.get("skipped"):
        print(f"跳过本轮读取（有调试操作正在进行）  {_addr(addr)}  {data.get('length')} 字节")
        return 0
    raw = data.get("data_hex") or ""
    if not raw:
        print(f"无数据  {_addr(addr)}")
        return 0
    print(_hex_dump(addr, bytes.fromhex(raw)))
    return 0


def _mem_resolve(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/memory/resolve?expr={urllib.parse.quote(args.expr)}")
    addr = data.get("address")
    if addr is None:
        finish(args, data, f"解析失败: {data.get('error', '未知错误')}")
        return 1
    finish(args, data, f"{args.expr} → {_addr(addr)}")
    return 0


# ── 辅助 ──────────────────────────────────

def _uid(p):
    p.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")


def _bp_locator(p):
    """断点定位参数：--address（hex/符号）或 --file+--line 二选一。"""
    p.add_argument("--address", help="断点地址（hex 或符号），与 --file/--line 二选一")
    p.add_argument("--file", help="源文件，需与 --line 同时提供")
    p.add_argument("--line", type=int, help="行号")


def _usage(text: str):
    """子命令组未指定具体子命令时给出用法提示（退出码 2）。"""

    def _run(c: ApiClient, args):
        print(f"用法: omni {text} [--uid ...]")
        return 2

    return _run


def _with_state(c: ApiClient, uid: str, data: dict) -> tuple[dict, str]:
    """附加执行后的目标状态。返回 (payload, 状态描述)。"""
    try:
        st = c.post(f"/api/probes/{uid}/zone/debug/status")
    except Exception:
        return data, "状态未知"
    payload = dict(data)
    payload["status_after"] = st
    return payload, _state_text(st, bare=True)


def _state_text(data: dict, bare: bool = False) -> str:
    pc = data.get("pc")
    pc_s = _addr(pc) if isinstance(pc, int) else "-"
    state = data.get("state", "unknown")
    if bare:
        return f"{state}  PC {pc_s}"
    connected = "是" if data.get("connected") else "否"
    return f"连接: {connected}  状态: {state}  PC: {pc_s}"


def _resolve_addr(c: ApiClient, uid: str, text: str):
    """地址表达式 → 整数地址。

    0x/0b/0o 前缀本地解析；超过 8 位的纯数字按十进制（--json 输出的地址就是十进制，
    而 32 位地址最多 8 位 hex，不会歧义）；其余交给后端 resolve（裸 hex 按 hex 解析，
    并支持 &符号 / 符号 / 符号[下标]）。失败打印错误并返回 None。
    """
    if text.lower().startswith(("0x", "0b", "0o")):
        try:
            return parse_int(text)
        except ValueError as e:
            print(f"错误: {e}")
            return None
    if text.isdigit() and len(text) > 8:
        return int(text)
    data = c.get(f"/api/probes/{uid}/zone/memory/resolve?expr={urllib.parse.quote(text)}")
    addr = data.get("address")
    if addr is None:
        hint = ""
        if text.isdigit():
            hint = "（十进制地址请直接写数字，hex 请加 0x 前缀）"
        print(f"错误: 无法解析地址 {text!r}{hint}: {data.get('error', '未知错误')}")
        return None
    return addr


def _find_bp(bps: list[dict], file: str, line: int):
    """按 file+line 匹配断点：先精确匹配，再按路径后缀匹配（用户常只写文件名）。"""
    for b in bps:
        if b.get("file") == file and b.get("line") == line:
            return b
    for b in bps:
        if b.get("line") == line and str(b.get("file", "")).replace("\\", "/").endswith(file.replace("\\", "/")):
            return b
    return None


def _locate_bp(c: ApiClient, uid: str, args) -> int | None:
    """定位待操作断点在断点表中的地址。

    `--address` 走符号/hex 解析后按三级匹配对齐；`--file+--line` 直接查表。
    定位失败时打印当前断点列表并返回 None。
    """
    if getattr(args, "address", None):
        addr = _resolve_addr(c, uid, args.address)
        if addr is None:
            return None
        hit = _match_bp_addr(c, uid, addr)
        if hit is None:
            _print_bp_hint(c, uid, f"未找到 {args.address}（{_addr(addr)}）对应的断点")
            return None
        return hit
    if getattr(args, "file", None) and getattr(args, "line", None):
        bps = c.get(f"/api/probes/{uid}/zone/breakpoints").get("breakpoints", [])
        rec = _find_bp(bps, args.file, args.line)
        if rec is None:
            _print_bp_hint(c, uid, f"未找到 {args.file}:{args.line} 对应的断点")
            return None
        return rec["address"]
    print("错误: 请提供 --address，或同时提供 --file 与 --line。")
    return None


def _match_bp_addr(c: ApiClient, uid: str, addr: int) -> int | None:
    """把解析出的地址对齐到断点表中已记录的地址。

    符号地址与源码行断点地址常落在**同一函数的不同位置**（符号表给函数起点，
    行表给该行首条指令），直接比较会 404。故按「精确 → Thumb 位归一 → 同函数」
    三级匹配，返回断点表中真实记录的地址。
    """
    bps = c.get(f"/api/probes/{uid}/zone/breakpoints").get("breakpoints", [])
    if not bps:
        return None
    for b in bps:
        if b.get("address") == addr:
            return b["address"]
    for b in bps:
        if isinstance(b.get("address"), int) and (b["address"] & ~1) == (addr & ~1):
            return b["address"]
    func = _func_at(c, uid, addr)
    if func:
        for b in bps:
            if isinstance(b.get("address"), int) and _func_at(c, uid, b["address"]) == func:
                return b["address"]
    return None


def _func_at(c: ApiClient, uid: str, addr: int) -> str | None:
    """地址所属函数名（无 DWARF 时返回 None）。"""
    try:
        line = c.get(f"/api/probes/{uid}/zone/source/line?address={addr}").get("line") or {}
        return line.get("function") or None
    except Exception:
        return None


def _print_bp_hint(c: ApiClient, uid: str, message: str) -> None:
    print(f"错误: {message}")
    try:
        bps = c.get(f"/api/probes/{uid}/zone/breakpoints").get("breakpoints", [])
    except Exception:
        bps = []
    if not bps:
        print("当前没有断点（用 `omni debug bp add --file <源文件> --line <行号>` 设置）")
        return
    rows = [[_addr(b.get("address")), b.get("file") or "", b.get("line") or ""] for b in bps]
    print("当前断点：")
    print(render_table(["地址", "文件", "行"], rows))


def _addr(v) -> str:
    return f"0x{v:08X}" if isinstance(v, int) else "-"


def _size(v) -> str:
    if not isinstance(v, int):
        return "-"
    if v < 1024:
        return f"{v} B"
    return f"{v / 1024:.1f} KB"


def _hex_dump(base: int, data: bytes, width: int = 16) -> str:
    lines = []
    for off in range(0, len(data), width):
        chunk = data[off:off + width]
        hexs = " ".join(f"{b:02X}" for b in chunk)
        text = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append(f"{_addr(base + off)}  {hexs:<{width * 3 - 1}}  |{text}|")
    return "\n".join(lines)