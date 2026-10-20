"""调试控制命令组：执行控制、ELF、源码断点、寄存器、内存、调用栈、反汇编、外设、会话。

对标前端 Zone 调试工作台，复用 `/api/probes/{uid}/zone/*` 接口。

会话状态（ELF 是否已加载、断点表、目标是否 halt）保存在**后端**，
CLI 每条命令都是独立进程，因此 `omni debug elf load` 之后可直接在
下一条命令里下断点、查寄存器，不需要在同一进程内维持会话。
"""

import json
import os
import sys
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

    s = ps.add_parser("reset", parents=[common_parser()],
                      help="复位目标（默认复位并暂停，与 flash reset 默认运行相反）")
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
    ss = sc.add_parser("content", parents=[common_parser()], help="读取源文件内容（带行号）")
    _uid(ss)
    ss.add_argument("file", help="源文件（ELF 中记录的路径或其后缀）")
    ss.add_argument("--start", type=int, help="起始行（默认 1）")
    ss.add_argument("--end", type=int, help="结束行（默认文件末尾）")
    ss.set_defaults(func=run_command(_src_content))
    ss = sc.add_parser("search", parents=[common_parser()], help="在全部源文件中做文本搜索")
    _uid(ss)
    ss.add_argument("query", help="搜索关键字")
    ss.add_argument("--limit", type=int, default=200, help="最大结果数（默认 200）")
    ss.set_defaults(func=run_command(_src_search))
    ss = sc.add_parser("symbol", parents=[common_parser()], help="按名字解析符号定义位置")
    _uid(ss)
    ss.add_argument("name", help="符号名")
    ss.set_defaults(func=run_command(_src_symbol))
    s.set_defaults(func=run_command(_usage("debug src <files|line|content|search|symbol>")))

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

    ss = sm.add_parser("usage", parents=[common_parser()], help="内存占用统计（Flash/RAM，需已加载 ELF）")
    _uid(ss)
    ss.set_defaults(func=run_command(_mem_usage))

    s.set_defaults(func=run_command(_usage("debug mem <read|resolve|usage>")))

    # ── 调用栈 / 局部变量 ─────────────────────
    s = ps.add_parser("stack", parents=[common_parser()], help="调用栈回溯（需目标暂停）")
    _uid(s)
    s.add_argument("--locals", action="store_true", help="同时展开每帧的局部变量/形参")
    s.set_defaults(func=run_command(_stack))

    s = ps.add_parser("locals", parents=[common_parser()], help="当前函数局部变量/形参（需目标暂停）")
    _uid(s)
    s.set_defaults(func=run_command(_locals))

    # ── 反汇编 ────────────────────────────────
    s = ps.add_parser("disasm", parents=[common_parser()], help="反汇编指定地址")
    _uid(s)
    s.add_argument("--addr", required=True, help="起始地址（hex 或符号表达式）")
    s.add_argument("--length", type=int, default=64, help="读取字节数（默认 64）")
    s.add_argument("--count", type=int, default=32, help="最大指令条数（默认 32）")
    s.set_defaults(func=run_command(_disasm))

    # ── 函数 / 调用图 ─────────────────────────
    s = ps.add_parser("functions", parents=[common_parser()], help="列出 ELF 中的函数")
    _uid(s)
    s.add_argument("--filter", help="按名称子串过滤")
    s.add_argument("--offset", type=int, default=0, help="分页偏移（默认 0）")
    s.add_argument("--limit", type=int, default=200, help="每页数量（默认 200）")
    s.set_defaults(func=run_command(_functions))

    s = ps.add_parser("callgraph", parents=[common_parser()], help="查看指定函数的直接被调函数（callees）")
    _uid(s)
    s.add_argument("--addr", required=True, help="函数地址（hex 或符号）")
    s.set_defaults(func=run_command(_callgraph))

    # ── 悬停 / Watch 求值 ─────────────────────
    s = ps.add_parser("hover", parents=[common_parser()], help="悬停求值：函数地址 / 变量值")
    _uid(s)
    s.add_argument("name", help="标识符（函数名 / 变量名）")
    s.set_defaults(func=run_command(_hover))

    s = ps.add_parser("watch", help="Watch 表达式求值与写入")
    sw = s.add_subparsers(dest="debug_watch_sub", metavar="<sub>")
    ss = sw.add_parser("eval", parents=[common_parser()], help="按表达式求值（var.field / arr[i] / *ptr / &x）")
    _uid(ss)
    ss.add_argument("expr", help="C 表达式或标识符")
    ss.set_defaults(func=run_command(_watch_eval))
    ss = sw.add_parser("set", parents=[common_parser()], help="写入内存或寄存器（需目标暂停）")
    _uid(ss)
    ss.add_argument("--address", help="内存地址（hex 或符号表达式），与 --register 二选一")
    ss.add_argument("--size", type=int, default=4, help="写入字节数（默认 4，1-8）")
    ss.add_argument("--register", help="寄存器名（如 r0 / pc）")
    ss.add_argument("--value", required=True, help="要写入的值（支持 0x 前缀）")
    ss.set_defaults(func=run_command(_watch_set))
    s.set_defaults(func=run_command(_usage("debug watch <eval|set>")))

    # ── 外设 / 内核外设 ───────────────────────
    s = ps.add_parser("periph", help="外设与内核外设（NVIC/SCB/SysTick）")
    sp = s.add_subparsers(dest="debug_periph_sub", metavar="<sub>")
    ss = sp.add_parser("list", parents=[common_parser()], help="列出外设（名称/基址/寄存器数）")
    _uid(ss)
    ss.set_defaults(func=run_command(_periph_list))
    ss = sp.add_parser("regs", parents=[common_parser()], help="读取某外设的寄存器值")
    _uid(ss)
    ss.add_argument("name", help="外设名（如 GPIOA / TIM1）")
    ss.add_argument("--filter", help="按寄存器名子串过滤")
    ss.set_defaults(func=run_command(_periph_regs))
    for _sub, _fn, _help in [
        ("nvic", _periph_nvic, "NVIC 中断源状态（使能/挂起/活动/优先级）"),
        ("scb", _periph_scb, "SCB 内核寄存器（ICSR/AIRCR/VTOR/STIR）"),
        ("systick", _periph_systick, "SysTick 内核寄存器（CTRL/LOAD/VAL/CALIB）"),
    ]:
        ss = sp.add_parser(_sub, parents=[common_parser()], help=_help)
        _uid(ss)
        ss.set_defaults(func=run_command(_fn))
    s.set_defaults(func=run_command(_usage("debug periph <list|regs|nvic|scb|systick>")))

    # ── 会话配置 ──────────────────────────────
    s = ps.add_parser("session", help="Zone 会话配置存取")
    sn = s.add_subparsers(dest="debug_session_sub", metavar="<sub>")
    ss = sn.add_parser("list", parents=[common_parser()], help="列出已保存的会话")
    ss.set_defaults(func=run_command(_session_list))
    ss = sn.add_parser("save", parents=[common_parser()], help="保存会话配置")
    ss.add_argument("name", help="会话名")
    ss.add_argument("--file", help="从 JSON 文件读取配置")
    ss.add_argument("--data", help="直接提供 JSON 字符串")
    ss.set_defaults(func=run_command(_session_save))
    ss = sn.add_parser("load", parents=[common_parser()], help="读取会话配置")
    ss.add_argument("name", help="会话名")
    ss.set_defaults(func=run_command(_session_load))
    ss = sn.add_parser("del", parents=[common_parser()], help="删除会话配置")
    ss.add_argument("name", help="会话名")
    ss.set_defaults(func=run_command(_session_del))
    s.set_defaults(func=run_command(_usage("debug session <list|save|load|del>")))


# ── 执行控制 ──────────────────────────────

def _status(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/debug/status")
    finish(args, data, _state_text(data))
    # 会话失效/状态不可信时 success=false：必须让脚本拿到非零退出码（P2-1）
    return 0 if data.get("success", True) else 1


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
    failed = data.get("success") is False
    regs = data.get("registers", [])
    if args.filter:
        needle = args.filter.lower()
        regs = [r for r in regs if needle in str(r.get("name", "")).lower()]
    if args.json_ or args.quiet:
        if args.filter:
            data = {**data, "registers": regs}
        finish(args, data, "")
        return 1 if failed else 0
    if failed:
        print(f"错误: {data.get('error') or '读取寄存器失败'}")
        return 1
    errors = data.get("errors") or []
    if not regs:
        # 过滤后为空时不要一律说“没有匹配的寄存器”：该寄存器可能恰好读取失败
        # （RTT 轮询/调试操作并发时可能发生），要给出真实错误而不是误导性的空结果。
        if args.filter and errors:
            needle = args.filter.lower()
            failed_regs = [e for e in errors if needle in str(e.get("name", "")).lower()]
            if failed_regs:
                first = failed_regs[0]
                print(f"错误: 读取寄存器 {first.get('name')} 失败: {first.get('error')}",
                      file=sys.stderr)
                return 1
        print("没有匹配的寄存器")
        return 0
    if errors:
        first = errors[0]
        print(f"警告: {len(errors)} 个寄存器读取失败（首个: {first.get('name')}: {first.get('error')}）",
              file=sys.stderr)
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


# ── 调用栈 / 局部变量 ──────────────────────

_FRAME_TYPES = {
    "top": "当前", "except": "异常", "call": "调用",
    "fp": "帧指针", "scan": "栈扫描",
}


def _stack(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/stack")
    frames = data.get("frames") or []
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    sp, pc, lr = data.get("sp"), data.get("pc"), data.get("lr")
    print(f"共 {len(frames)} 帧  PC {_addr(pc)}  SP {_addr(sp)}  LR {_addr(lr)}")
    if not frames:
        print("（无帧：目标可能未暂停，或未加载带调试信息的 ELF）")
        return 0
    rows = []
    for i, f in enumerate(frames):
        name = f.get("function") or f.get("symbol") or "-"
        addr = f.get("function_address") or f.get("address")
        loc = f"{f.get('file')}:{f.get('line')}" if f.get("file") else "-"
        rows.append([str(i), name, _addr(addr), _FRAME_TYPES.get(f.get("type"), f.get("type") or "-"), loc])
    print(render_table(["#", "函数", "地址", "类型", "源码位置"], rows))
    if getattr(args, "locals", False):
        for i, f in enumerate(frames):
            locs = f.get("locals") or []
            if not locs:
                continue
            print(f"\n#{i} {f.get('function') or '-'}  {f.get('signature') or ''}")
            print(render_table(["变量", "类型", "值", "种类"],
                               [[v.get("name"), v.get("type") or "", _fmt_value(v), _var_kind(v)] for v in locs]))
    return 0


def _locals(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/locals")
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    state = data.get("state")
    if state != "halted":
        print(f"目标状态: {state}（局部变量需目标暂停）")
        return 0
    info = data.get("locals")
    if not info:
        print("当前函数无局部变量/形参（可能未加载 DWARF 调试信息）")
        return 0
    if info.get("signature"):
        print(f"函数签名: {info['signature']}   返回: {info.get('ret') or '-'}")
    variables = info.get("variables") or []
    if not variables:
        print("（无局部变量/形参）")
        return 0
    rows = [[v.get("name"), v.get("type") or "", _fmt_value(v), _var_kind(v)] for v in variables]
    print(render_table(["变量", "类型", "值", "种类"], rows))
    return 0


# ── 反汇编 ────────────────────────────────

def _disasm(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    addr = _resolve_addr(c, uid, args.addr)
    if addr is None:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/disasm",
                  {"address": addr, "length": args.length, "max_instructions": args.count})
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    rows = data.get("rows") or []
    if not rows:
        print(f"无指令  {_addr(addr)}")
        return 0
    print(f"反汇编 {_addr(data.get('address', addr))}  {data.get('count', 0)} 条指令")
    for r in rows:
        t = r.get("type")
        if t == "func":
            print(f"\n{r.get('name') or '<unknown>'}:")
        elif t == "source":
            print(f"    ; {r.get('file')}:{r.get('line')}  {r.get('text') or ''}")
        else:
            b = r.get("bytes") or ""
            print(f"{_addr(r.get('address'))}  {b:<8}  {r.get('mnemonic')} {r.get('op_str')}")
    return 0


# ── 函数 / 调用图 ─────────────────────────

def _functions(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    q = (f"filter={urllib.parse.quote(args.filter or '')}"
         f"&offset={args.offset}&limit={args.limit}")
    data = c.get(f"/api/probes/{uid}/zone/functions?{q}")
    funcs = data.get("functions") or []
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    if not funcs:
        print("没有匹配的函数")
        return 0
    rows = [[f.get("name"), _addr(f.get("address")), _size(f.get("size")),
             (f"{f.get('file')}:{f.get('line')}" if f.get("file") else "-")] for f in funcs]
    print(f"共 {data.get('total', len(funcs))} 个函数，显示 {len(funcs)} 个（offset={args.offset}）")
    print(render_table(["函数", "地址", "大小", "源码位置"], rows))
    return 0


def _callgraph(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    addr = _resolve_addr(c, uid, args.addr)
    if addr is None:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/callgraph?address={addr}")
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    fn = data.get("function") or {}
    callees = data.get("callees") or []
    print(f"函数 {fn.get('name') or '-'}  {_addr(fn.get('address'))}  直接调用 {len(callees)} 个")
    if not callees:
        return 0
    rows = [[cl.get("name"), _addr(cl.get("address")), _size(cl.get("size"))] for cl in callees]
    print(render_table(["被调函数", "地址", "大小"], rows))
    return 0


def _mem_usage(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/memory/usage")
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    print(f"Flash 占用: {_size(data.get('flash_used'))}    RAM 占用: {_size(data.get('ram_used'))}")
    cats = data.get("categories") or []
    if cats:
        print("\n分类占用:")
        print(render_table(["分类", "Flash", "RAM"],
                           [[c.get("name"), _size(c.get("rom")), _size(c.get("ram"))] for c in cats]))
    sections = data.get("sections") or []
    if sections:
        print("\nSection 明细:")
        print(render_table(["Section", "地址", "大小", "区域"],
                           [[s.get("name"), _addr(s.get("address")), _size(s.get("size")),
                             "RAM" if s.get("writable") else "Flash"] for s in sections]))
    return 0


# ── 悬停 / Watch ──────────────────────────

def _hover(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/hover", {"name": args.name})
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    info = data.get("info")
    if not info:
        print(f"无调试信息: {args.name}（状态: {data.get('state')}）")
        return 1
    _print_info_tree(info, 0)
    return 0


def _watch_eval(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/zone/watch/eval", {"name": args.expr})
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    info = data.get("info")
    if not info:
        print(f"无法解析 {args.expr!r}（状态: {data.get('state')}）")
        return 1
    _print_info_tree(info, 0)
    return 0


def _watch_set(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    try:
        value = parse_int(args.value)
    except ValueError as e:
        print(f"错误: {e}")
        return 1
    if args.register:
        payload = {"target": "register", "name": args.register, "value": value}
        what = f"寄存器 {args.register}"
    elif args.address is not None:
        address = _resolve_addr(c, uid, args.address)
        if address is None:
            return 1
        payload = {"target": "address", "address": address, "size": args.size, "value": value}
        what = f"内存 {_addr(address)}"
    else:
        print("错误: 请提供 --address（写内存）或 --register（写寄存器）。")
        return 1
    data = c.post(f"/api/probes/{uid}/zone/watch/set", payload)
    finish(args, data, f"已写入 {what} = {_hexv(data.get('value'))}")
    return 0 if data.get("success") else 1


# ── 外设 / 内核外设 ───────────────────────

def _periph_list(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/peripherals")
    periphs = data.get("peripherals") or []
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    if not periphs:
        print("无外设（未连接目标或该型号无 SVD）")
        return 0
    rows = [[p.get("name"), _addr(p.get("base_address")), str(len(p.get("registers") or [])),
             p.get("description") or ""] for p in periphs]
    print(f"共 {len(periphs)} 个外设")
    print(render_table(["外设", "基址", "寄存器数", "说明"], rows))
    return 0


def _periph_regs(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    meta = c.get(f"/api/probes/{uid}/zone/peripherals")
    periphs = meta.get("peripherals") or []
    target = _find_peripheral(periphs, args.name)
    if target is None:
        names = ", ".join(p.get("name", "") for p in periphs[:20])
        print(f"错误: 未找到外设 {args.name!r}。可用: {names}")
        return 1
    regs = target.get("registers") or []
    if args.filter:
        needle = args.filter.lower()
        regs = [r for r in regs if needle in str(r.get("name", "")).lower()]
    if not regs:
        print(f"{target.get('name')} 没有匹配的寄存器")
        return 0
    data = c.post(f"/api/probes/{uid}/zone/registers/read",
                  {"addresses": [r["address"] for r in regs]})
    if args.json_ or args.quiet:
        finish(args, {**data, "peripheral": target.get("name")}, "")
        return 0
    values = {v["address"]: v.get("value") for v in (data.get("values") or [])}
    rows = [[r.get("name"), _addr(r.get("address")), _addr(values.get(r["address"])),
             r.get("access") or "", r.get("description") or ""] for r in regs]
    print(f"{target.get('name')}  基址 {_addr(target.get('base_address'))}  {len(regs)} 个寄存器")
    print(render_table(["寄存器", "地址", "值", "访问", "说明"], rows))
    return 0


def _periph_nvic(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/peripherals/core/nvic")
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    if data.get("skipped"):
        print("跳过本轮读取（有调试操作正在进行）")
        return 0
    ints = data.get("interrupts") or []
    if not ints:
        print("无中断源")
        return 0
    rows = [[str(i.get("number")), i.get("name") or "",
             "1" if i.get("enabled") else "0",
             "1" if i.get("pending") else "0",
             "1" if i.get("active") else "0",
             str(i.get("priority"))] for i in ints]
    print(f"共 {len(ints)} 个中断源")
    print(render_table(["#", "中断源", "使能", "挂起", "活动", "优先级"], rows))
    return 0


def _core_periph_regs(c: ApiClient, args, path: str, title: str):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/peripherals/core/{path}")
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    if data.get("skipped"):
        print("跳过本轮读取（有调试操作正在进行）")
        return 0
    regs = data.get("registers") or []
    if not regs:
        print(f"无 {title} 寄存器")
        return 0
    for r in regs:
        val = r.get("value")
        print(f"\n{r.get('name')}  {_addr(r.get('address'))}  = {_hexv(val)}   {r.get('description') or ''}")
        fields = r.get("fields") or []
        if fields and isinstance(val, int):
            rows = []
            for f in fields:
                off, wid = f.get("bit_offset", 0), f.get("bit_width", 1)
                fv = (val >> off) & ((1 << wid) - 1)
                rows.append([f.get("name"), f"[{off + wid - 1}:{off}]", _hexv(fv),
                             f.get("access") or "", f.get("description") or ""])
            print(render_table(["位域", "位", "值", "访问", "说明"], rows))
    return 0


def _periph_scb(c: ApiClient, args):
    return _core_periph_regs(c, args, "scb", "SCB")


def _periph_systick(c: ApiClient, args):
    return _core_periph_regs(c, args, "systick", "SysTick")


# ── 源码内容 / 搜索 / 符号 ────────────────

def _src_content(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/source/content?file={urllib.parse.quote(args.file)}")
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0 if data.get("success") else 1
    if not data.get("success"):
        print(f"读取失败: {data.get('error', '未知错误')}")
        return 1
    lines = data.get("lines") or []
    start = max(1, args.start or 1)
    end = min(args.end or len(lines), len(lines))
    print(f"{data.get('file')}  共 {len(lines)} 行，显示 {start}-{end}")
    for no in range(start, end + 1):
        print(f"{no:>5}  {lines[no - 1]}")
    return 0


def _src_search(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/source/search"
                 f"?query={urllib.parse.quote(args.query)}&limit={args.limit}")
    results = data.get("results") or []
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    if not results:
        print("没有匹配结果")
        return 0
    rows = [[r.get("file"), str(r.get("line")), (r.get("text") or "").strip()] for r in results]
    extra = "（已截断）" if data.get("truncated") else ""
    print(f"共 {len(results)} 条匹配{extra}")
    print(render_table(["文件", "行", "内容"], rows))
    return 0


def _src_symbol(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/zone/source/symbol?name={urllib.parse.quote(args.name)}")
    sym = data.get("symbol")
    if not sym:
        finish(args, data, f"未找到符号 {args.name!r}")
        return 1
    loc = f"{sym.get('file')}:{sym.get('line')}" if sym.get("file") else "-"
    finish(args, data, f"{sym.get('name')}  {_addr(sym.get('address'))}  "
                       f"类型 {sym.get('type') or '-'}  大小 {_size(sym.get('size'))}  位置 {loc}")
    return 0


# ── 会话配置 ──────────────────────────────

def _session_list(c: ApiClient, args):
    data = c.get("/api/zone/sessions")
    sessions = data.get("sessions") or []
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    if not sessions:
        print("没有已保存的会话")
        return 0
    rows = [[s.get("name"), s.get("updated_at") or "", s.get("path") or ""] for s in sessions]
    print(render_table(["名称", "更新时间", "路径"], rows))
    return 0


def _session_save(c: ApiClient, args):
    if args.file:
        path = os.path.abspath(os.path.expanduser(args.file))
        if not os.path.isfile(path):
            print(f"错误: 文件不存在: {path}")
            return 1
        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except json.JSONDecodeError as e:
            print(f"错误: JSON 解析失败: {e}")
            return 1
    elif args.data:
        try:
            payload = json.loads(args.data)
        except json.JSONDecodeError as e:
            print(f"错误: --data 不是合法 JSON: {e}")
            return 1
    else:
        print("错误: 请用 --file 指定 JSON 文件，或用 --data 直接提供 JSON。")
        return 1
    data = c.post("/api/zone/sessions", {"name": args.name, "data": payload})
    finish(args, data, f"会话已保存: {data.get('name')}")
    return 0 if data.get("success") else 1


def _session_load(c: ApiClient, args):
    data = c.get(f"/api/zone/sessions/{urllib.parse.quote(args.name)}")
    if args.json_ or args.quiet:
        finish(args, data, "")
        return 0
    session = data.get("session") or {}
    print(f"会话 {session.get('name')}  更新于 {session.get('updated_at') or '-'}")
    print(json.dumps(session.get("data"), ensure_ascii=False, indent=2))
    return 0


def _session_del(c: ApiClient, args):
    data = c.delete(f"/api/zone/sessions/{urllib.parse.quote(args.name)}")
    finish(args, data, f"会话已删除: {args.name}")
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
    error = data.get("error")
    if bare:
        text = f"{state}  PC {pc_s}"
        return f"{text}  错误: {error}" if error else text
    connected = "是" if data.get("connected") else "否"
    text = f"连接: {connected}  状态: {state}  PC: {pc_s}"
    if error:
        text += f"  错误: {error}"
    return text


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


def _hexv(v) -> str:
    """紧凑 hex（不做 8 位补零），非整数返回 '-'。"""
    return f"0x{v:X}" if isinstance(v, int) else "-"


def _fmt_value(v: dict) -> str:
    """变量值格式化：不可用标注，整数按 hex，其余原样。"""
    if not v.get("available", True):
        return "(不可用)"
    val = v.get("value")
    if isinstance(val, int):
        return _addr(val)
    if val is None:
        return "-"
    return str(val)


def _var_kind(v: dict) -> str:
    return "形参" if v.get("is_param") else "局部"


def _find_peripheral(periphs: list[dict], name: str):
    """按名称定位外设：先大小写不敏感精确匹配，再退化为子串匹配。"""
    low = name.lower()
    for p in periphs:
        if str(p.get("name", "")).lower() == low:
            return p
    for p in periphs:
        if low in str(p.get("name", "")).lower():
            return p
    return None


def _print_info_tree(info: dict, depth: int = 0) -> None:
    """递归打印 hover/watch 求值结果（含 struct/array children）。"""
    pad = "  " * depth
    typ = info.get("type") or ""
    if not info.get("available", True):
        val_s = "(不可用)"
    else:
        val = info.get("value")
        val_s = _addr(val) if isinstance(val, int) else (str(val) if val is not None else "-")
    addr = info.get("address")
    addr_s = f"  @{_addr(addr)}" if isinstance(addr, int) else ""
    print(f"{pad}{info.get('name') or '-'}: {typ} = {val_s}{addr_s}")
    for child in (info.get("children") or []):
        _print_info_tree(child, depth + 1)