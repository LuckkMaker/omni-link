"""离线工具命令：map 分析（复用后端 /api/tools/map-analyzer）。"""

import os

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser
from ..runtime import finish, run_command

_MAX_MAP_BYTES = 10 * 1024 * 1024


def add_parser(sub):
    p = sub.add_parser("tool", help="离线工具（Map 文件分析）")
    ps = p.add_subparsers(dest="tool_sub", metavar="<sub>")

    s = ps.add_parser("map", parents=[common_parser()], help="分析 ARM 链接器 .map 文件")
    s.add_argument("file", help=".map 文件路径（≤10 MB）")
    s.add_argument("--top", type=int, default=10, help="显示 ROM 占用前 N 项（默认 10）")
    s.set_defaults(func=run_command(_map))


def _map(c: ApiClient, args):
    path = os.path.abspath(os.path.expanduser(args.file))
    if not os.path.isfile(path):
        print(f"错误: 文件不存在: {path}")
        return 1
    if os.path.getsize(path) > _MAX_MAP_BYTES:
        print(f"错误: map 文件超过 10 MB: {path}")
        return 1

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except OSError as e:
        print(f"错误: 读取失败: {e}")
        return 1

    data = c.post("/api/tools/map-analyzer",
                  {"filename": os.path.basename(path), "content": content})
    if args.json_:
        finish(args, data, "")
        return 0

    meta = data.get("meta") or {}
    summary = data.get("summary") or {}
    print(f"Map: {path}")
    if meta.get("component") or meta.get("tool"):
        print(f"  组件: {meta.get('component', '-')}  工具: {meta.get('tool', '-')}"
              + (f"  生成: {meta['generated_at']}" if meta.get("generated_at") else ""))
    print(f"  ROM: {_kb(summary.get('flash_used'))} / {_kb(summary.get('flash_capacity'))}"
          f"   RAM: {_kb(summary.get('ram_used'))} / {_kb(summary.get('ram_capacity'))}")

    regions = data.get("regions") or []
    if regions:
        print(render_table(
            ["区域", "起始", "大小", "上限"],
            [[r.get("name", ""), _hex(r.get("exec_base")), _kb(r.get("size")),
              _kb(r.get("max_size"))] for r in regions],
        ))

    categories = data.get("categories") or []
    if categories:
        print(render_table(
            ["分类", "CODE", "RO", "RW", "ZI", "ROM", "RAM"],
            [[c.get("name", ""), _n(c.get("code")), _n(c.get("ro_data")),
              _n(c.get("rw_data")), _n(c.get("zi_data")), _n(c.get("rom")),
              _n(c.get("ram"))] for c in categories],
        ))

    entries = data.get("top_rom") or []
    top = max(0, args.top)
    if top == 0:
        return 0
    print(render_table(
        ["ROM Top", "类型", "分类", "ROM", "RAM"],
        [[e.get("name", ""), e.get("kind", ""), e.get("category", ""),
          _n(e.get("rom")), _n(e.get("ram"))] for e in entries[:top]],
    ))
    return 0


def _kb(value):
    if not isinstance(value, int) or value < 0:
        return "-"
    if value >= 1024 * 1024:
        return f"{value / 1024 / 1024:.2f} MB"
    if value >= 1024:
        return f"{value / 1024:.1f} KB"
    return f"{value} B"


def _hex(value):
    return f"0x{value:08X}" if isinstance(value, int) else "-"


def _n(value):
    return "" if value is None else str(value)
