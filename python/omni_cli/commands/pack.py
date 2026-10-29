"""CMSIS-Pack 管理命令：list / preview / import / remove。

对应后端 ``/api/packs``：与 GUI「设置 → 芯片管理 → DFP 导入」共用同一份
设备库与安装清单。临时挂包（`probe connect --pack`）不在这里管理，见 probe 命令。
"""

import os
import urllib.parse

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser
from ..runtime import finish, run_command
from ..util import confirm


def add_parser(sub):
    p = sub.add_parser("pack", help="CMSIS-Pack 管理（列出/预览/导入/卸载 DFP）")
    ps = p.add_subparsers(dest="pack_sub", metavar="<sub>")

    s = ps.add_parser("list", aliases=["show"], parents=[common_parser()],
                      help="列出已安装的 Pack")
    s.set_defaults(func=run_command(_list))

    s = ps.add_parser("preview", parents=[common_parser()],
                      help="预览 .pack 中的芯片（不导入、不改设备库）")
    s.add_argument("file", help=".pack 文件路径")
    s.add_argument("--search", help="按型号/显示名子串过滤（不区分大小写）")
    s.add_argument("--limit", type=int, default=0, help="仅显示前 N 个（0=全部）")
    s.set_defaults(func=run_command(_preview))

    s = ps.add_parser("import", parents=[common_parser()],
                      help="导入 .pack（持久安装，重启后端后仍生效）")
    s.add_argument("file", help=".pack 文件路径")
    s.add_argument("--parts", help="只导入指定型号（逗号分隔；缺省=全部）")
    s.set_defaults(func=run_command(_import))

    s = ps.add_parser("remove", parents=[common_parser()], help="卸载已安装的 Pack")
    s.add_argument("name", help="Pack 名称，如 Keil.STM32F1xx_DFP")
    s.add_argument("-y", "--yes", action="store_true", help="不提示直接卸载")
    s.set_defaults(func=run_command(_remove))


def _abs_file(path: str) -> str | None:
    absolute = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(absolute):
        print(f"错误: 文件不存在: {absolute}")
        return None
    if not absolute.lower().endswith(".pack"):
        print(f"错误: 不是 .pack 文件: {absolute}")
        return None
    return absolute


def _list(c: ApiClient, args):
    data = c.get("/api/packs")
    packs = data if isinstance(data, list) else data.get("packs", [])

    if args.json_:
        finish(args, {"packs": packs}, "")
        return 0
    if not packs:
        print("未安装任何 CMSIS-Pack（可用 `omni pack import <file.pack>` 导入）")
        return 0

    print(f"共 {len(packs)} 个已安装 Pack")
    print(render_table(
        ["名称", "版本", "设备数", "文件"],
        [[p.get("name", ""), p.get("version", ""), str(p.get("device_count", "")),
          "存在" if p.get("file_exists") else "缺失"] for p in packs],
    ))
    missing = [p.get("name", "") for p in packs if not p.get("file_exists")]
    if missing:
        print("提示: 以下 Pack 文件缺失，可重新导入修复: " + ", ".join(missing))
    return 0


def _preview(c: ApiClient, args):
    path = _abs_file(args.file)
    if path is None:
        return 1
    data = c.post("/api/packs/preview", {"path": path})
    devices = data.get("devices", []) or []

    if args.search:
        needle = args.search.lower()
        devices = [d for d in devices if needle in (d.get("part_number") or "").lower()
                   or needle in (d.get("display_name") or "").lower()]
    if args.limit and args.limit > 0:
        devices = devices[: args.limit]

    if args.json_:
        finish(args, {"file": path, "count": len(devices), "devices": devices}, "")
        return 0

    print(f"{os.path.basename(path)}: {len(devices)} 个芯片")
    print(render_table(
        ["型号", "显示名", "厂商", "内核", "FlashKB", "RAMKB"],
        [[d.get("part_number", ""), d.get("display_name", ""), d.get("vendor", ""),
          d.get("core", ""), _n(d.get("flash_size")), _n(d.get("ram_size"))]
         for d in devices],
    ))
    return 0


def _import(c: ApiClient, args):
    path = _abs_file(args.file)
    if path is None:
        return 1

    selected = None
    if args.parts:
        selected = [p.strip() for p in args.parts.split(",") if p.strip()]
        if not selected:
            print("错误: --parts 不能为空（缺省表示导入全部）")
            return 1

    data = c.post("/api/packs/import", {"path": path, "selected_parts": selected})
    pack = data.get("pack", {}) or {}
    count = data.get("device_count", len(data.get("devices", []) or []))

    if args.json_:
        finish(args, data, "")
        return 0
    print(f"已导入 {pack.get('name', '')} {pack.get('version', '')}: {count} 个芯片"
          "（写入设备库与安装清单，重启后端后仍生效）")
    if selected is not None and count == 0:
        print("警告: 指定型号未在 Pack 中找到，未导入任何芯片")
    print("提示: 整包型号均已注册到 pyOCD；--parts 只影响设备库展示。")
    return 0


def _remove(c: ApiClient, args):
    if not args.yes and not confirm(f"确认卸载 Pack '{args.name}'？"):
        print("已取消")
        return 0
    quoted = urllib.parse.quote(args.name, safe="")
    data = c.delete(f"/api/packs/{quoted}")
    if args.json_:
        finish(args, data, "")
        return 0
    print(f"已卸载 Pack: {args.name}")
    print("提示: 已连接的会话不受影响；新连接将不再识别该 Pack 独有的型号。")
    return 0


def _n(v):
    return "" if v is None else str(v)
