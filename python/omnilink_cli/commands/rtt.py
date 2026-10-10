"""RTT 命令：status / start / stop / channels / send / send-text / device run|halt|reset|state。

对标前端 RTT Viewer 面板，提供 SEGGER RTT 会话控制与目标内核控制。
"""

import base64
import time

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser
from ..runtime import finish, run_command
from ..util import parse_int, resolve_uid


def add_parser(sub):
    p = sub.add_parser("rtt", help="SEGGER RTT（启动/停止会话、收发数据、内核控制）")
    ps = p.add_subparsers(dest="rtt_sub", metavar="<sub>")

    s = ps.add_parser("status", parents=[common_parser()], help="查询 RTT 会话状态")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_status))

    s = ps.add_parser("start", parents=[common_parser()], help="启动 RTT 会话")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--address", type=parse_int, help="控制块搜索起始地址（hex，默认自动检测）")
    s.add_argument("--size", type=parse_int, help="搜索范围大小")
    s.add_argument("--up-channel", type=int, default=0, help="监听的 up channel（默认 0）")
    s.add_argument("--down-channel", type=int, default=0, help="发送的 down channel（默认 0）")
    s.set_defaults(func=run_command(_start))

    s = ps.add_parser("stop", parents=[common_parser()], help="停止 RTT 会话")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_stop))

    s = ps.add_parser("channels", parents=[common_parser()], help="列出 RTT 通道")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_channels))

    s = ps.add_parser("send", parents=[common_parser()], help="发送二进制数据到 down channel")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--channel", type=int, help="down channel 索引（缺省用启动时选中的）")
    s.add_argument("--base64", metavar="DATA", help="发送 base64 编码的原始字节")
    s.add_argument("--text", metavar="TEXT", help="或直接发送文本（追加换行用 --no-newline 关闭）")
    s.add_argument("--no-newline", action="store_true", help="文本发送时不追加换行符")
    s.set_defaults(func=run_command(_send))

    # 中间层 parser 不挂 common_parser：否则 `rtt device --uid X run` 的 --uid
    # 会被子 parser 的同名默认值(None)覆盖，静默丢失。全局选项只挂叶子 parser。
    s = ps.add_parser("device", help="目标内核控制（run/halt/reset/state）")
    sd = s.add_subparsers(dest="rtt_device_sub", metavar="<sub>")
    for name, help_ in [("run", "运行目标内核（resume）"), ("halt", "暂停目标内核"),
                        ("status", "查询内核状态"), ("reset", "复位目标并重初始化 RTT")]:
        ss = sd.add_parser(name, parents=[common_parser()], help=help_)
        ss.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
        if name == "reset":
            ss.add_argument("--no-run", action="store_true", help="复位后停留在 HALTED（默认复位并运行）")
        ss.set_defaults(func=run_command(_device))
    s.set_defaults(func=run_command(_device_help))


def _status(c: ApiClient, args):
    uid = resolve_uid(c, args)
    if not uid:
        print("错误: 未发现探针。请确认探针已连接或用 --uid 指定。")
        return 1
    data = c.get(f"/api/probes/{uid}/rtt/status")
    finish(args, data,
           f"RTT running={data.get('running')}   target connected={data.get('connected')}")
    return 0


def _start(c: ApiClient, args):
    uid = _require_uid(c, args)
    payload = {
        "address": args.address,
        "size": args.size,
        "up_channel": args.up_channel,
        "down_channel": args.down_channel,
    }
    data = c.post(f"/api/probes/{uid}/rtt/start", payload)
    finish(args, data, _render_start(data))
    return 0 if data.get("success") else 1


def _stop(c: ApiClient, args):
    uid = _require_uid(c, args)
    data = c.post(f"/api/probes/{uid}/rtt/stop")
    finish(args, data, f"RTT 已停止 (uid={uid})")
    return 1 if not data.get("success") else 0


def _channels(c: ApiClient, args):
    uid = _require_uid(c, args)
    data = c.get(f"/api/probes/{uid}/rtt/channels")
    if args.json_:
        finish(args, data, "")
        return 0
    if not data.get("success"):
        print(f"错误: {data.get('error')}")
        return 1
    lines = [f"RTT 通道（up_channel={data.get('up_channel')}, down_channel={data.get('down_channel')}）"]
    lines.append("Up channels (target -> host):")
    lines.append(render_table(
        ["#", "名称", "大小"],
        [[ch.get("index"), ch.get("name"), ch.get("size")] for ch in data.get("up_channels", [])],
    ))
    lines.append("Down channels (host -> target):")
    lines.append(render_table(
        ["#", "名称", "大小"],
        [[ch.get("index"), ch.get("name"), ch.get("size")] for ch in data.get("down_channels", [])],
    ))
    print("\n".join(lines))
    return 0


def _send(c: ApiClient, args):
    uid = _require_uid(c, args)
    if args.base64:
        data = c.post(f"/api/probes/{uid}/rtt/send",
                      {"data": args.base64.replace(" ", ""), "channel": args.channel})
        verb = f"已发送 {len(base64.b64decode(args.base64.replace(' ', '')))} 字节"
    elif args.text is not None:
        data = c.post(f"/api/probes/{uid}/rtt/send-text",
                      {"text": args.text, "channel": args.channel,
                       "append_newline": not args.no_newline})
        verb = f"已发送文本: {args.text!r}"
    else:
        print("错误: 请提供 --base64 DATA 或 --text TEXT。")
        return 1
    if args.json_:
        finish(args, data, "")
        return 0
    print(verb + ("  (success)" if data.get("success") else "  (failed)"))
    return 0 if data.get("success") else 1


def _device(c: ApiClient, args):
    sub = args.rtt_device_sub
    if sub == "status":
        uid = _require_uid(c, args)
        data = c.get(f"/api/probes/{uid}/rtt/device/state")
        finish(args, data, f"内核状态: {data.get('state')}")
        return 0
    uid = _require_uid(c, args)
    if sub == "reset":
        data = c.post(f"/api/probes/{uid}/rtt/device/reset", {"run": not args.no_run})
    else:
        data = c.post(f"/api/probes/{uid}/rtt/device/{sub}")
    verb = {"run": "已运行", "halt": "已暂停", "reset": "已复位"}.get(sub, sub)
    finish(args, data, f"{verb} (uid={uid})")
    return 0 if data.get("success") else 1


def _device_help(c: ApiClient, args):
    print("用法: omni rtt device <run|halt|status|reset> [--uid ...]")
    return 2


def _render_start(data: dict) -> str:
    if not data.get("success"):
        return f"RTT 启动失败: {data.get('error', '未知错误')}"
    up = data.get("up_channels", [])
    down = data.get("down_channels", [])
    return (f"RTT 启动成功（up={len(up)} 通道, down={len(down)} 通道, "
            f"up_channel={data.get('up_channel')}, down_channel={data.get('down_channel')}）")


def _require_uid(c: ApiClient, args) -> str:
    uid = resolve_uid(c, args)
    if not uid:
        raise SystemExit("未发现探针。请确认探针已连接或用 --uid 指定。")
    return uid