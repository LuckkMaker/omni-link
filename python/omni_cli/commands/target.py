"""目标型号命令：list / info。"""

from ..client import ApiClient
from ..options import common_parser
from ..runtime import finish, run_command
from ..formatting import render_table


def add_parser(sub):
    p = sub.add_parser("target", help="目标芯片型号（列出支持的 MCU / 查询型号信息）")
    ps = p.add_subparsers(dest="target_sub", metavar="<sub>")

    s = ps.add_parser("list", parents=[common_parser()], help="列出所有支持的 MCU 型号")
    s.add_argument("--search", help="按子串过滤型号（不区分大小写）")
    s.add_argument("--limit", type=int, default=0, help="仅显示前 N 个（0=全部）")
    s.set_defaults(func=run_command(_list))

    s = ps.add_parser("info", parents=[common_parser()], help="查询指定型号是否受支持")
    s.add_argument("part", help="型号名，如 stm32f407xg / G32F463XC")
    s.set_defaults(func=run_command(_info))


def _list(c: ApiClient, args):
    data = c.get("/api/targets")
    targets = data.get("targets", [])
    if args.search:
        needle = args.search.lower()
        targets = [t for t in targets if needle in t.lower()]
    if args.limit and args.limit > 0:
        targets = targets[: args.limit]

    if args.json_:
        finish(args, {"count": len(targets), "targets": targets}, "")
        return 0
    print(f"共 {len(targets)} 个支持的型号")
    # 控制台中按列排版
    print(render_table(["型号"], [[t] for t in targets]))
    return 0


def _info(c: ApiClient, args):
    data = c.get(f"/api/targets/{args.part}")
    if args.json_:
        finish(args, data, "")
        return 0
    print(f"型号: {data.get('part_number')}  受支持: {'是' if data.get('supported') else '否'}")
    return 0