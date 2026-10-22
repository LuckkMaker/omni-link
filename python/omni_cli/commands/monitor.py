"""Monitor 命令：REST 薄客户端，复用 /api/probes/{uid}/monitor/*。

覆盖：状态、ELF/符号、变量增删改、采样控制、目标内核控制、历史读取与 CSV 导出。
"""

import json
import os
import time
import urllib.parse

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser
from ..runtime import finish, run_command
from ..util import parse_int, require_uid

_TYPE_CHOICES = ["int8", "uint8", "int16", "uint16", "int32", "uint32", "float"]


def add_parser(sub):
    p = sub.add_parser("monitor", help="Monitor 变量采样（ELF/变量/采样/读取/导出）")
    ps = p.add_subparsers(dest="monitor_sub", metavar="<sub>")

    s = ps.add_parser("status", parents=[common_parser()], help="查询 Monitor 状态")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_status))

    elf = ps.add_parser("elf", help="Monitor 的 ELF/符号")
    es = elf.add_subparsers(dest="monitor_elf_sub", metavar="<sub>")
    s = es.add_parser("load", parents=[common_parser()], help="加载 ELF/AXF 并解析符号")
    s.add_argument("file", help="ELF/AXF 文件路径")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_elf_load))
    s = es.add_parser("changed", parents=[common_parser()], help="检测已加载 ELF 是否变化")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_elf_changed))
    elf.set_defaults(func=run_command(_usage("monitor elf <load|changed>")))

    s = ps.add_parser("symbols", parents=[common_parser()], help="查询 ELF 符号（分页）")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--filter", default="", help="名称子串过滤")
    s.add_argument("--type", default="object", choices=["object", "func", "all"],
                   help="符号类型（默认 object=仅变量）")
    s.add_argument("--page", type=int, default=1)
    s.add_argument("--page-size", type=int, default=200)
    s.set_defaults(func=run_command(_symbols))

    var = ps.add_parser("var", help="监视变量管理")
    vs = var.add_subparsers(dest="monitor_var_sub", metavar="<sub>")
    s = vs.add_parser("list", parents=[common_parser()], help="列出监视变量")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_var_list))
    s = vs.add_parser("add", parents=[common_parser()], help="添加监视变量（符号或地址）")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--symbol", help="按 ELF 符号名添加（与 --name/--address/--type 互斥）")
    s.add_argument("--name", help="变量名（手工地址模式必填）")
    s.add_argument("--address", help="变量地址（hex/dec；手工地址模式必填）")
    s.add_argument("--type", choices=_TYPE_CHOICES, help="数据类型（手工地址模式必填）")
    s.add_argument("--index", type=int, help="数组元素索引（数组符号/手工地址数组）")
    s.add_argument("--remark", default="", help="备注")
    s.add_argument("--refresh", type=float, default=0, help="独立刷新周期（秒，0=跟随全局）")
    s.set_defaults(func=run_command(_var_add))
    s = vs.add_parser("rm", parents=[common_parser()], help="移除监视变量")
    s.add_argument("var_id", help="变量 ID（`monitor var list` 查看）")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_var_rm))
    s = vs.add_parser("set", parents=[common_parser()], help="写入变量值（目标内存）")
    s.add_argument("var_id", help="变量 ID")
    s.add_argument("--value", required=True, help="新值（hex/dec）")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_var_set))
    var.set_defaults(func=run_command(_usage("monitor var <list|add|rm|set>")))

    s = ps.add_parser("start", parents=[common_parser()], help="启动采样")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--rate", type=float, default=1000.0, help="采样率 Hz（默认 1000）")
    s.add_argument("--max-points", type=int, default=300000, help="最大采样点数")
    s.add_argument("--transport", default="swd", choices=["swd", "rtt"],
                   help="采样通道（默认 swd）")
    s.set_defaults(func=run_command(_start))

    for name, help_ in (("stop", "停止采样"), ("pause", "暂停采样"), ("resume", "恢复采样")):
        s = ps.add_parser(name, parents=[common_parser()], help=help_)
        s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
        s.set_defaults(func=run_command(_control(name)))

    dev = ps.add_parser("device", help="目标内核控制（run/halt/reset/state）")
    ds = dev.add_subparsers(dest="monitor_device_sub", metavar="<sub>")
    for name, help_ in (("run", "运行目标内核"), ("halt", "暂停目标内核"),
                        ("state", "查询内核状态（running/halted）")):
        s = ds.add_parser(name, parents=[common_parser()], help=help_)
        s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
        s.set_defaults(func=run_command(_device(name)))
    s = ds.add_parser("reset", parents=[common_parser()], help="复位目标内核")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--no-run", action="store_true", help="复位后停留在暂停态")
    s.set_defaults(func=run_command(_device_reset))
    dev.set_defaults(func=run_command(_usage("monitor device <run|halt|reset|state>")))

    s = ps.add_parser("read", parents=[common_parser()], help="读取落盘采样数据")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--start-ms", type=float, help="起始时间（相对采样起点，ms）")
    s.add_argument("--end-ms", type=float, help="结束时间（ms）")
    s.add_argument("--limit", type=int, default=200,
                   help="最多显示样本数（默认 200；0=全部）")
    s.add_argument("--max-points", type=int, help="全览降采样上限")
    s.add_argument("--follow", action="store_true", help="持续跟踪新样本（Ctrl+C 结束）")
    s.add_argument("--interval", type=float, default=0.2, help="follow 轮询间隔（秒）")
    s.add_argument("--duration", type=float, default=0, help="follow 持续秒数（0=一直）")
    s.set_defaults(func=run_command(_read))

    s = ps.add_parser("export", parents=[common_parser()], help="导出 CSV（落盘数据，无上限）")
    s.add_argument("out", help="输出 CSV 路径")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--mode", default="all", choices=["all", "recent", "custom"],
                   help="时间范围模式（默认 all）")
    s.add_argument("--recent", type=float, help="mode=recent 时最近 N 秒")
    s.add_argument("--start-ms", type=float, help="mode=custom 起始 ms")
    s.add_argument("--end-ms", type=float, help="mode=custom 结束 ms")
    s.add_argument("--force", action="store_true", help="覆盖已存在的输出文件")
    s.set_defaults(func=run_command(_export))


# ── status / elf / symbols ────────────────────────────────

def _status(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/monitor/status")
    if args.json_:
        finish(args, data, "")
        return 0
    lines = [
        ("运行中", data.get("running")),
        ("已暂停", data.get("paused")),
        ("探针连接", data.get("connected")),
        ("采样率", f"{data.get('rate_hz')} Hz（实际 {data.get('actual_rate_hz')} Hz）"),
        ("变量数", data.get("variable_count")),
        ("ELF 已加载", data.get("elf_loaded")),
        ("缓冲点数", data.get("buffer_size")),
    ]
    print("\n".join(f"  {k}: {v}" for k, v in lines))
    return 0


def _elf_load(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    path = os.path.abspath(os.path.expanduser(args.file))
    if not os.path.isfile(path):
        print(f"错误: 文件不存在: {path}")
        return 1
    data = c.post(f"/api/probes/{uid}/monitor/elf/load", {"path": path})
    if args.json_:
        finish(args, data, "")
        return 0
    print(f"已加载 ELF: {data.get('path', path)}")
    for key in ("symbols", "functions", "variables"):
        if key in data:
            print(f"  {key}: {data[key]}")
    return 0


def _elf_changed(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/monitor/elf/changed")
    if args.json_:
        finish(args, data, "")
        return 0
    changed = data.get("changed")
    path = data.get("path") or "-"
    print(f"ELF 变化: {'是' if changed else '否'}  {path}")
    if data.get("error"):
        print(f"错误: {data['error']}")
    return 0


def _symbols(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    query = urllib.parse.urlencode({
        "filter": args.filter or "",
        "type": args.type,
        "page": args.page,
        "page_size": args.page_size,
    })
    data = c.get(f"/api/probes/{uid}/monitor/symbols?{query}")
    if args.json_:
        finish(args, data, "")
        return 0
    symbols = data.get("symbols") or []
    print(f"共 {data.get('total', len(symbols))} 个符号（第 {args.page} 页，{len(symbols)} 条）")
    print(render_table(
        ["名称", "地址", "大小", "类型", "数组", "源文件"],
        [[s.get("name", ""), _hex(s.get("address")), _n(s.get("size")),
          s.get("type", ""),
          f"{s.get('elem_count')}x{s.get('elem_type')}" if s.get("is_array") else "",
          s.get("source_file", "")]
         for s in symbols],
    ))
    return 0


# ── variables ─────────────────────────────────────────────

def _var_list(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.get(f"/api/probes/{uid}/monitor/variables")
    if args.json_:
        finish(args, data, "")
        return 0
    variables = data.get("variables") or []
    if not variables:
        print("尚未添加监视变量（`omni monitor var add --symbol <name>`）")
        return 0
    print(render_table(
        ["ID", "名称", "地址", "类型", "刷新(s)", "备注"],
        [[v.get("id", ""), v.get("name", ""), _hex(v.get("address")),
          v.get("type", ""), _n(v.get("refresh_sec")), v.get("remark", "")]
         for v in variables],
    ))
    return 0


def _var_add(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1

    if args.symbol:
        if args.name or args.address or args.type:
            print("错误: --symbol 与 --name/--address/--type 互斥")
            return 2
        try:
            payload = _payload_from_symbol(c, uid, args)
        except ValueError as e:
            print(f"错误: {e}")
            return 1
        if payload is None:
            return 1
    else:
        if not (args.name and args.address and args.type):
            print("错误: 需提供 --symbol，或同时提供 --name/--address/--type")
            return 2
        try:
            address = parse_int(args.address)
        except ValueError as e:
            print(f"错误: {e}")
            return 1
        payload = {
            "name": args.name,
            "address": address,
            "type": args.type,
            "remark": args.remark,
            "refresh_sec": args.refresh,
            "elem_index": args.index,
        }

    data = c.post(f"/api/probes/{uid}/monitor/variables", payload)
    if args.json_:
        finish(args, data, "")
        return 0
    var = data.get("variable") or data
    print(f"已添加变量: {var.get('name', payload['name'])}"
          f"  id={var.get('id', '')}  @{_hex(var.get('address', payload['address']))}")
    return 0


def _payload_from_symbol(c: ApiClient, uid: str, args) -> dict | None:
    name = args.symbol
    query = urllib.parse.urlencode({"filter": name, "type": "all", "page": 1, "page_size": 200})
    data = c.get(f"/api/probes/{uid}/monitor/symbols?{query}")
    symbols = data.get("symbols") or []

    matches = [s for s in symbols if s.get("name") == name]
    if not matches:
        matches = [s for s in symbols if (s.get("name") or "").lower() == name.lower()]
    if not matches:
        print(f"错误: 未找到符号 {name}（先 `omni monitor elf load`，或用 --filter 查符号）")
        return None
    if len(matches) > 1:
        print(f"错误: 符号 {name} 匹配到 {len(matches)} 个，请用更精确的名字：")
        for s in matches[:10]:
            print(f"  {s.get('name')}  @{_hex(s.get('address'))}  {s.get('source_file', '')}")
        return None

    sym = matches[0]
    index = args.index
    if sym.get("is_array"):
        if index is None:
            print(f"错误: {sym.get('name')} 是数组（{sym.get('elem_count')} 个 "
                  f"{sym.get('elem_type')}），请用 --index 指定元素")
            return None
        count = int(sym.get("elem_count") or 0)
        if index < 0 or index >= count:
            print(f"错误: --index 超出范围 0..{count - 1}")
            return None
        element_size = int(sym.get("elem_size") or 0)
        address = int(sym.get("address") or 0) + index * element_size
        var_type = sym.get("elem_type") or sym.get("type")
    else:
        if index is not None:
            print(f"错误: {sym.get('name')} 不是数组，不能使用 --index")
            return None
        address = int(sym.get("address") or 0)
        var_type = sym.get("type")

    return {
        "name": sym.get("name"),
        "address": address,
        "type": var_type,
        "remark": args.remark,
        "refresh_sec": args.refresh,
        "elem_index": index,
    }


def _var_rm(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.delete(f"/api/probes/{uid}/monitor/variables/{urllib.parse.quote(args.var_id, safe='')}")
    finish(args, data, f"已移除变量 {args.var_id}")
    return 0


def _var_set(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    try:
        value = parse_int(args.value)
    except ValueError as e:
        print(f"错误: {e}")
        return 2
    data = c.put(
        f"/api/probes/{uid}/monitor/variables/{urllib.parse.quote(args.var_id, safe='')}/value",
        {"value": value},
    )
    finish(args, data, f"已写入变量 {args.var_id} = {value}")
    return 0


# ── sampling control ──────────────────────────────────────

def _start(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/monitor/start", {
        "rate_hz": args.rate,
        "max_points": args.max_points,
        "transport": args.transport,
    })
    if args.json_:
        finish(args, data, "")
        return 0
    print(f"采样已启动: {args.rate:g} Hz，通道 {args.transport}")
    return 0


def _control(name: str):
    def _run(c: ApiClient, args):
        uid = require_uid(c, args)
        if not uid:
            return 1
        data = c.post(f"/api/probes/{uid}/monitor/{name}")
        if args.json_:
            finish(args, data, "")
            return 0
        print({"stop": "采样已停止", "pause": "采样已暂停",
               "resume": "采样已恢复"}[name])
        return 0

    return _run


# ── device control ────────────────────────────────────────

def _device(name: str):
    def _run(c: ApiClient, args):
        uid = require_uid(c, args)
        if not uid:
            return 1
        if name == "state":
            data = c.get(f"/api/probes/{uid}/monitor/device/state")
        else:
            data = c.post(f"/api/probes/{uid}/monitor/device/{name}")
        if args.json_:
            finish(args, data, "")
            return 0
        if name == "state":
            print(f"内核状态: {data.get('state', data.get('core_state', '?'))}")
        else:
            print({"run": "内核已运行", "halt": "内核已暂停"}[name])
        return 0

    return _run


def _device_reset(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/monitor/device/reset", {"run": not args.no_run})
    if args.json_:
        finish(args, data, "")
        return 0
    print("内核已复位" + ("并运行" if not args.no_run else "并暂停"))
    return 0


# ── read / export ─────────────────────────────────────────

def _record_path(uid: str, args, start_ms, *, include_limit: bool = True) -> str:
    params = {}
    if start_ms is not None:
        params["start_ms"] = f"{start_ms:.6f}"
    if getattr(args, "end_ms", None) is not None:
        params["end_ms"] = f"{args.end_ms:.6f}"
    if include_limit:
        if getattr(args, "limit", 0):
            params["limit"] = str(args.limit)
        if getattr(args, "max_points", None):
            params["max_points"] = str(args.max_points)
    query = ("?" + urllib.parse.urlencode(params)) if params else ""
    return f"/api/probes/{uid}/monitor/record{query}"


def _read(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1

    if args.follow:
        return _follow(c, uid, args)

    data = c.get(_record_path(uid, args, args.start_ms))
    if not data.get("success"):
        print(f"错误: {data.get('error', '读取失败')}")
        return 1
    if args.json_:
        finish(args, data, "")
        return 0
    segments = data.get("segments") or []
    if not segments:
        print("没有采样数据（确认已 `monitor start` 且添加了变量）")
        return 0
    _print_segments(segments)
    return 0


def _follow(c: ApiClient, uid: str, args):
    last_ms = args.start_ms
    if last_ms is None:
        # 默认只跟踪“从现在开始”的新样本；否则会把采样启动以来的历史全部回放。
        # 需要回放时显式传 --start-ms 0。
        try:
            status = c.get(f"/api/probes/{uid}/monitor/status")
            if isinstance(status.get("latest_t_ms"), (int, float)):
                last_ms = float(status["latest_t_ms"])
        except Exception:
            pass
    deadline = (time.monotonic() + args.duration) if args.duration and args.duration > 0 else None
    interval = max(0.05, args.interval)
    header_names: list[str] = []

    try:
        while True:
            data = c.get(_record_path(uid, args, last_ms, include_limit=False))
            if not data.get("success"):
                print(f"错误: {data.get('error', '读取失败')}")
                return 1

            segments = data.get("segments") or []
            rows = 0
            for seg in segments:
                variables = seg.get("vars") or []
                names = [v.get("name", "") for v in variables]
                if not args.json_ and names != header_names:
                    header_names = names
                    print(render_table(["t_ms"] + names, []))
                for sample in seg.get("samples") or []:
                    t_ms = sample.get("t_ms")
                    if last_ms is not None and t_ms is not None and t_ms <= last_ms:
                        continue
                    values = sample.get("values") or {}
                    if args.json_:
                        print(json.dumps({
                            "t_ms": t_ms,
                            "values": {names[i]: values.get(v.get("id"))
                                       for i, v in enumerate(variables)},
                        }, ensure_ascii=False))
                    else:
                        cells = [f"{t_ms:.3f}"] + [_n(values.get(v.get("id"))) for v in variables]
                        print("  ".join(cells))
                    rows += 1
                    if t_ms is not None:
                        last_ms = t_ms

            if deadline is not None and time.monotonic() >= deadline:
                return 0
            if rows == 0:
                time.sleep(interval)
    except KeyboardInterrupt:
        # follow 是无限流，Ctrl+C 是正常结束方式
        return 0


def _print_segments(segments):
    for seg in segments:
        variables = seg.get("vars") or []
        names = [v.get("name", "") for v in variables]
        rows = []
        for sample in seg.get("samples") or []:
            values = sample.get("values") or {}
            rows.append([f"{sample.get('t_ms', 0):.3f}"]
                        + [_n(values.get(v.get("id"))) for v in variables])
        print(render_table(["t_ms"] + names, rows))


def _export(c: ApiClient, args):
    uid = require_uid(c, args)
    if not uid:
        return 1

    out = os.path.abspath(os.path.expanduser(args.out))
    if os.path.exists(out) and not args.force:
        print(f"错误: 输出文件已存在: {out}（用 --force 覆盖）")
        return 1
    if args.mode == "recent" and not args.recent:
        print("错误: --mode recent 需要 --recent SEC")
        return 2
    if args.mode == "custom" and (args.start_ms is None or args.end_ms is None):
        print("错误: --mode custom 需要 --start-ms 与 --end-ms")
        return 2

    params = {"format": "csv", "mode": args.mode}
    if args.mode == "recent":
        params["recent_seconds"] = str(args.recent)
    elif args.mode == "custom":
        params["start_ms"] = str(args.start_ms)
        params["end_ms"] = str(args.end_ms)

    data = c.get(f"/api/probes/{uid}/monitor/record/export?" + urllib.parse.urlencode(params))
    if not data.get("success"):
        print(f"错误: {data.get('error', '导出失败')}")
        return 1
    csv_text = data.get("csv") or ""
    try:
        with open(out, "w", encoding="utf-8", newline="") as f:
            f.write(csv_text)
    except OSError as e:
        print(f"错误: 写入失败: {e}")
        return 1

    if args.json_:
        finish(args, {"success": True, "path": out, "count": data.get("count")}, "")
        return 0
    print(f"已导出 {data.get('count', '?')} 个采样点到 {out}")
    return 0


# ── helpers ───────────────────────────────────────────────

def _usage(text: str):
    def _run(c: ApiClient, args):
        print(f"用法: omni {text} [--uid ...]")
        return 2

    return _run


def _hex(value):
    return f"0x{value:08X}" if isinstance(value, int) else ("-" if value is None else value)


def _n(value):
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)
