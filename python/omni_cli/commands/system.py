"""系统命令：system info（后端/数据库/Python/pyOCD 版本与设备库统计）。"""

import json

from ..client import ApiClient
from ..options import common_parser
from ..runtime import finish, run_command


def add_parser(sub):
    p = sub.add_parser("system", help="系统信息（版本/数据库/运行环境）")
    ps = p.add_subparsers(dest="system_sub", metavar="<sub>")

    s = ps.add_parser("info", parents=[common_parser()], help="查看后端与运行环境版本信息")
    s.set_defaults(func=run_command(_info))


def _info(c: ApiClient, args):
    data = c.get("/api/system/info")
    if args.json_:
        finish(args, data, "")
        return 0

    rows = [
        ("应用版本", data.get("app_version")),
        ("后端版本", data.get("backend_version")),
        ("Python", data.get("python_version")),
        ("平台", data.get("platform")),
        ("pyOCD", data.get("pyocd_version")),
        ("数据库版本", data.get("db_version")),
        ("数据库路径", data.get("db_path")),
    ]
    print("\n".join(f"  {k}: {v}" for k, v in rows))

    summary = data.get("source_summary") or {}
    if summary:
        print("  设备库: " + json.dumps(summary, ensure_ascii=False))
    return 0
