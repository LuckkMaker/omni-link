"""设备应用库命令：list / info / summary / create / update / delete / custom / reimport。

设备目录支持 builtin / pack / flm 三种来源。内置型号只读；用户自定义设备写入用户库。
"""

import json
import os

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser
from ..runtime import finish, run_command
from ..util import confirm


def add_parser(sub):
    p = sub.add_parser("device", help="设备应用库（列出/新增/编辑自定义芯片）")
    ps = p.add_subparsers(dest="device_sub", metavar="<sub>")

    s = ps.add_parser("list", parents=[common_parser()], help="列出设备目录中的全部芯片")
    s.add_argument("--search", help="按型号子串过滤（不区分大小写）")
    s.add_argument("--source", choices=["builtin", "pack", "flm", "custom", "user"],
                   help="按来源过滤")
    s.add_argument("--limit", type=int, default=0, help="仅显示前 N 个（0=全部）")
    s.set_defaults(func=run_command(_list))

    s = ps.add_parser("info", parents=[common_parser()], help="查询单个设备详情")
    s.add_argument("part", help="设备型号，如 G32F463XC")
    s.set_defaults(func=run_command(_info))

    s = ps.add_parser("summary", parents=[common_parser()], help="各来源设备数量统计")
    s.set_defaults(func=run_command(_summary))

    s = ps.add_parser("create", parents=[common_parser()], help="按 JSON 新增设备（写入用户库）")
    s.add_argument("json_file", help="符合设备 schema 的 JSON 文件（见后端 DeviceCreate）")
    s.set_defaults(func=run_command(_create))

    s = ps.add_parser("update", parents=[common_parser()], help="按 JSON 更新设备（内置型号只读）")
    s.add_argument("part", help="要更新的设备型号")
    s.add_argument("json_file", help="符合设备 schema 的 JSON 文件")
    s.set_defaults(func=run_command(_update))

    s = ps.add_parser("delete", parents=[common_parser()], help="删除设备（内置型号只读）")
    s.add_argument("part", help="要删除的设备型号")
    s.add_argument("-y", "--yes", action="store_true", help="不提示直接删除")
    s.set_defaults(func=run_command(_delete))

    s = ps.add_parser("custom", parents=[common_parser()], help="通过 FLM 算法文件创建自定义芯片")
    s.add_argument("flm", help=".FLM Flash 算法文件路径")
    s.add_argument("--part-number", required=True, help="自定义芯片型号")
    s.add_argument("--core", default="Cortex-M4", help="内核（默认 Cortex-M4）")
    s.add_argument("--flash-base", required=True, help="Flash 基地址（如 0x08000000）")
    s.add_argument("--flash-size", type=int, required=True, help="Flash 大小（KB）")
    s.add_argument("--ram-base", required=True, help="RAM 基地址（如 0x20000000）")
    s.add_argument("--ram-size", type=int, required=True, help="RAM 大小（KB）")
    s.add_argument("--vendor", default="Custom", help="厂商（默认 Custom）")
    s.add_argument("--display-name", default="", help="显示名")
    s.set_defaults(func=run_command(_custom))

    s = ps.add_parser("reimport", parents=[common_parser()], help="从 device_info.json 重新导入初始数据")
    s.set_defaults(func=run_command(_reimport))


def _list(c: ApiClient, args):
    data = c.get("/api/devices")
    devices = data.get("devices", [])
    if args.search:
        needle = args.search.lower()
        devices = [d for d in devices if needle in d.get("part_number", "").lower()
                   or needle in d.get("display_name", "").lower()]
    if args.source:
        if args.source == "user":
            devices = [d for d in devices if d.get("source") != "builtin"]
        else:
            devices = [d for d in devices if d.get("source") == args.source]
    if args.limit and args.limit > 0:
        devices = devices[: args.limit]

    if args.json_:
        finish(args, {"count": len(devices), "devices": devices}, "")
        return 0

    avail = sum(1 for d in devices if d.get("available"))
    print(f"共 {len(devices)} 个设备，其中可烧录 {avail} 个")
    print(render_table(
        ["型号", "显示名", "厂商", "内核", "FlashKB", "RAMKB", "来源", "可烧录"],
        [[d.get("part_number", ""), d.get("display_name", ""), d.get("vendor", ""),
          d.get("core", ""), _n(d.get("flash_size")), _n(d.get("ram_size")),
          d.get("source", ""), "是" if d.get("available") else "否"] for d in devices],
    ))
    return 0


def _info(c: ApiClient, args):
    data = c.get(f"/api/devices/{args.part}")
    if args.json_:
        finish(args, data, "")
        return 0
    lines = _detail_lines(data)
    print("\n".join(f"  {k}: {v}" for k, v in lines if not k.startswith("__")))
    return 0


def _summary(c: ApiClient, args):
    data = c.get("/api/devices/sources/summary")
    finish(args, data, render_table(
        ["来源", "数量"],
        [[k, v] for k, v in data.items() if k != "available" and k != "metadata_only"],
    ) + f"\nutc设备可烧录: {data.get('available')}  （仅元数据: {data.get('metadata_only')}）")
    return 0


def _create(c: ApiClient, args):
    payload = _read_json(args.json_file)
    data = c.post("/api/devices", payload)
    finish(args, data, f"已新增设备: {data.get('part_number')}")
    return 0


def _update(c: ApiClient, args):
    payload = _read_json(args.json_file)
    data = c.put(f"/api/devices/{args.part}", payload)
    finish(args, data, f"已更新设备: {data.get('part_number')}")
    return 0


def _delete(c: ApiClient, args):
    if not args.yes and not confirm(f"确认删除设备 '{args.part}'？内置型号将拒绝删除。"):
        print("已取消")
        return 0
    data = c.delete(f"/api/devices/{args.part}")
    finish(args, data, f"已删除设备: {data.get('part_number')}")
    return 0


def _custom(c: ApiClient, args):
    payload = {
        "flm_path": os.path.abspath(args.flm),
        "part_number": args.part_number,
        "core": args.core,
        "flash_base_address": args.flash_base,
        "flash_size": args.flash_size,
        "ram_base_address": args.ram_base,
        "ram_size": args.ram_size,
        "vendor": args.vendor,
        "display_name": args.display_name,
    }
    data = c.post("/api/devices/custom", payload)
    finish(args, data, f"已创建自定义芯片: {data.get('part_number')}（可通过 `omni probe connect --target {data.get('part_number')}` 连接）")
    return 0


def _reimport(c: ApiClient, args):
    data = c.post("/api/devices/reimport")
    finish(args, data, f"已从 device_info.json 重新导入 {data.get('imported', 0)} 个设备")
    return 0


# ── 辅助 ─────────────────────────────────


def _read_json(path) -> dict:
    if not os.path.exists(path):
        raise SystemExit(f"文件不存在: {path}")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit(f"JSON 必须是对象: {path}")
    return data


def _detail_lines(d: dict) -> list:
    order = ["part_number", "display_name", "vendor", "core", "num_cores",
             "flash_size", "ram_size", "flash_base_address", "ram_base_address",
             "device_id_address", "jlink_device", "source", "available", "flm_path"]
    lines = []
    for k in order:
        if d.get(k) is not None:
            lines.append((k, d[k]))
    for k, v in d.items():
        if k in order:
            continue
        if k in ("flash_regions", "ram_regions") and isinstance(v, list):
            for i, r in enumerate(v):
                lines.append((f"{k}[{i}]", json.dumps(r, ensure_ascii=False)))
        elif isinstance(v, (str, int, float, bool)):
            lines.append((k, v))
    return lines


def _n(v):
    return "" if v is None else str(v)