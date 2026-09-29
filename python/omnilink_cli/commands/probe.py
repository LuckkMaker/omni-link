"""探针命令：list / connect / disconnect / status / target。"""

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser
from ..runtime import finish, run_command


def add_parser(sub):
    p = sub.add_parser("probe", help="探针管理（枚举/连接/断开/状态/目标）")
    ps = p.add_subparsers(dest="probe_sub", metavar="<sub>")

    s = ps.add_parser("list", parents=[common_parser()], help="列出所有已连接探针")
    s.set_defaults(func=run_command(_list))

    s = ps.add_parser("connect", parents=[common_parser()], help="连接指定探针")
    s.add_argument("uid", help="探针唯一 ID（用 `omni probe list` 查看）")
    s.add_argument("--target", help="目标芯片型号（如 stm32f407xg）")
    s.add_argument("--interface", default="swd", choices=["swd", "jtag"], help="调试接口")
    s.add_argument("--speed", type=int, help="时钟频率 Hz")
    s.add_argument("--connect-mode", choices=["attach", "halt", "pre-reset", "under-reset"],
                   help="连接模式：attach=附加/不复位 / halt=复位并暂停 / pre-reset=连接前复位 / under-reset=复位下连接")
    s.add_argument("--jlink-device", help="J-Link 目标设备名（如 G32F463XC），J-Link 必须设置")
    s.add_argument("--force", action="store_true", help="强制按新参数重连（即使已连接）")
    s.set_defaults(func=run_command(_connect))

    s = ps.add_parser("disconnect", parents=[common_parser()],
                      help="断开指定探针（等待底层关闭，释放 J-Link 等探针句柄）")
    s.add_argument("uid")
    s.set_defaults(func=run_command(_disconnect))

    s = ps.add_parser("status", parents=[common_parser()], help="查询探针连接状态")
    s.add_argument("uid")
    s.set_defaults(func=run_command(_status))

    s = ps.add_parser("target", parents=[common_parser()], help="查询或设置目标芯片型号")
    s.add_argument("uid")
    s.add_argument("--part", metavar="PART_NUMBER", help="设置目标型号")
    s.set_defaults(func=run_command(_target))


def _list(c: ApiClient, args):
    data = c.get("/api/probes")
    probes = data.get("probes", [])
    if args.json_:
        finish(args, data, "")
        return 0
    if not probes:
        print("未发现已连接的探针")
        return 0
    print(render_table(
        ["UID", "厂商", "产品", "串号", "连接状态"],
        [[p.get("uid", ""), p.get("vendor", ""), p.get("product", ""),
          p.get("serial", ""), p.get("state", "")] for p in probes],
    ))
    return 0


def _connect(c: ApiClient, args):
    payload = {
        "target": args.target,
        "interface": args.interface,
        "speed": args.speed,
        "connect_mode": args.connect_mode,
        "force": args.force,
        "jlink_device": args.jlink_device,
    }
    data = c.post(f"/api/probes/{args.uid}/connect", payload)
    finish(args, data, _head_block(f"已连接 uid={args.uid}", data.get("target")))
    return 0


def _disconnect(c: ApiClient, args):
    # wait=true：等后端真正关闭底层句柄再返回，避免 J-Link 等探针残留在后台
    data = c.post(f"/api/probes/{args.uid}/disconnect?wait=true")
    finish(args, data, f"已断开 uid={args.uid}")
    return 0


def _status(c: ApiClient, args):
    data = c.get(f"/api/probes/{args.uid}/status")
    head = f"uid={data.get('uid')}  state={data.get('state')}"
    finish(args, data, _head_block(head, data.get("target")))
    return 0


def _target(c: ApiClient, args):
    if args.part:
        data = c.post(f"/api/probes/{args.uid}/target", {"part_number": args.part})
        finish(args, data, _head_block(f"目标已设置为 {args.part}", data.get("target")))
        return 0
    data = c.get(f"/api/probes/{args.uid}/target")
    finish(args, data, _head_block("", data))
    return 0


def _head_block(head: str, target) -> str:
    """拼装人类可读文本：标题行 + 目标信息块（每字段一行）。"""
    lines = [head] if head else []
    for tl in _target_lines(target):
        lines.append(_INDENT + tl)
    return "\n".join(lines)


_INDENT = "  "


def _target_lines(target) -> list[str]:
    """返回 TargetInfo 的 key: value 行列表（跳过缺失字段）。"""
    if not target:
        return []
    lines = [
        ("型号", target.get("part_number")),
        ("内核", target.get("core")),
        ("Flash", str(target.get("flash_size")) if target.get("flash_size") is not None else None),
        ("RAM", str(target.get("ram_size")) if target.get("ram_size") is not None else None),
        ("Flash起始", _hex(target.get("flash_start"))),
        ("页大小", _hex(target.get("page_size"))),
        ("扇区大小", _hex(target.get("sector_size"))),
        ("core_id", target.get("core_id")),
        ("device_id", target.get("device_id")),
    ]
    return [f"{k}: {v}" for k, v in lines if v not in (None, "")]


def _hex(v):
    return f"0x{v:x}" if isinstance(v, int) else v