"""RTT 命令：status / start / stop / channels / read / send / send-text /
device run|halt|reset|state。

对标前端 RTT Viewer 面板，提供 SEGGER RTT 会话控制、上行日志读取与目标内核控制。
"""

import base64
import codecs
import json
import os
import sys
import time

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser
from ..runtime import finish, run_command
from ..util import parse_int, resolve_uid


def add_parser(sub):
    p = sub.add_parser("rtt", help="SEGGER RTT（启动/停止会话、读取上行日志、收发数据、内核控制）")
    ps = p.add_subparsers(dest="rtt_sub", metavar="<sub>")

    s = ps.add_parser("status", parents=[common_parser()], help="查询 RTT 会话状态（含上行缓存统计）")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_status))

    s = ps.add_parser("start", parents=[common_parser()], help="启动 RTT 会话")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--address", type=parse_int, help="控制块搜索起始地址（hex，默认自动检测）")
    s.add_argument("--size", type=parse_int, help="搜索范围大小")
    s.add_argument("--up-channel", type=int, default=0, help="监听的 up channel（默认 0）")
    s.add_argument("--down-channel", type=int, default=0, help="发送的 down channel（默认 0）")
    # 后端 RTT_START_TIMEOUT=30s：CLI 的 HTTP 超时必须比它长，否则会把后端仍在
    # 正常扫描的启动误判成 "timed out"（随后日志里又出现"已启动"）。
    # set_defaults 优先于 common_parser 的 --timeout=30 默认值，用户显式传入仍生效。
    s.set_defaults(func=run_command(_start), timeout=45)

    s = ps.add_parser("stop", parents=[common_parser()], help="停止 RTT 会话（已缓存的上行数据仍可读取）")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_stop))

    s = ps.add_parser("channels", parents=[common_parser()], help="列出 RTT 通道")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.set_defaults(func=run_command(_channels))

    s = ps.add_parser(
        "read", parents=[common_parser()],
        help="读取 RTT 上行数据（一次性或 --follow 持续跟踪）",
        epilog="示例: omni rtt read --uid 852001270        # 读取当前已缓存日志\n"
               "      omni rtt read --follow --out rtt.log  # 持续跟踪并落盘\n"
               "      omni rtt read --json                  # 输出可断言的 JSON（含 seq/text）",
    )
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--channel", type=int, help="只看指定 up channel（缺省全部通道）")
    s.add_argument("--since", type=int, default=0,
                   help="从指定 seq 开始读取（0=从当前最旧可用数据；默认 0）")
    s.add_argument("--max-bytes", type=int, default=65536,
                   help="单次最多读取的字节数（默认 65536）")
    s.add_argument("--follow", action="store_true", help="持续跟踪新数据（Ctrl+C 结束）")
    s.add_argument("--interval", type=float, default=0.2,
                   help="follow 轮询间隔秒数（默认 0.2）")
    s.add_argument("--duration", type=float, default=0.0,
                   help="follow 持续秒数（默认 0=一直跟踪到 Ctrl+C）")
    s.add_argument("--out", metavar="FILE", help="把原始字节追加写入文件（二进制）")
    s.add_argument("--encoding", default="utf-8",
                   help="文本解码编码（默认 utf-8；非法字节用替换符，--json 的 base64 无损）")
    s.set_defaults(func=run_command(_read))

    s = ps.add_parser("send", parents=[common_parser()], help="发送二进制数据到 down channel")
    s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")
    s.add_argument("--channel", type=int, help="down channel 索引（缺省用启动时选中的）")
    s.add_argument("--base64", metavar="DATA", help="发送 base64 编码的原始字节")
    s.add_argument("--text", metavar="TEXT", help="或直接发送文本（追加换行用 --no-newline 关闭）")
    s.add_argument("--file", metavar="PATH", help="或发送文件的原始字节（二进制）")
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
    cap = data.get("capture") or {}
    if cap.get("available"):
        capture = (f"缓存 {cap.get('buffered_bytes', 0)} 字节 "
                   f"(seq {cap.get('oldest_seq')}..{cap.get('next_seq')}"
                   f"，丢弃 {cap.get('dropped_bytes', 0)} 字节)")
    else:
        capture = "缓存: 未启动过 RTT"
    finish(args, data,
           f"RTT running={data.get('running')}   target connected={data.get('connected')}\n"
           f"  {capture}")
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


def _read(c: ApiClient, args):
    """读取 RTT 上行缓存：一次性打印/落盘，或 --follow 持续跟踪。

    - 与 GUI 共用后端的同一份环形缓存，不消费服务端游标，多客户端互不影响。
    - 文本模式用增量解码器，避免多字节字符跨块被切坏；--json 保留 base64 原始块，
      CI 可无损断言。
    """
    uid = _require_uid(c, args)
    if args.follow and args.json_ and args.quiet:
        print("错误: --quiet 与 --json --follow 不能同时使用（JSONL 需要输出）。", file=sys.stderr)
        return 2
    if args.max_bytes < 1:
        print("错误: --max-bytes 必须 ≥ 1。", file=sys.stderr)
        return 2
    if args.follow and args.interval < 0.05:
        args.interval = 0.05

    decoder = None
    if not args.json_:
        try:
            decoder = codecs.getincrementaldecoder(args.encoding)(errors="replace")
        except LookupError:
            print(f"错误: 不支持的编码: {args.encoding}", file=sys.stderr)
            return 2

    out = None
    if args.out:
        try:
            out = open(args.out, "ab")
        except OSError as e:
            print(f"错误: 无法打开输出文件 {args.out}: {e}", file=sys.stderr)
            return 1

    since = max(0, int(args.since or 0))
    deadline = time.time() + args.duration if (args.follow and args.duration > 0) else None
    printed_any = False
    tail = ""
    read_any = False
    follow = bool(args.follow)
    session_reset_warned = False

    try:
        while True:
            query = f"since={since}&max_bytes={int(args.max_bytes)}"
            if args.channel is not None:
                query += f"&channel={int(args.channel)}"
            data = c.get(f"/api/probes/{uid}/rtt/data?{query}")
            chunks = data.get("chunks") or []
            raw = b"".join(base64.b64decode(ch.get("data") or "") for ch in chunks)
            read_any = read_any or bool(raw)

            if out is not None and raw:
                out.write(raw)
                out.flush()

            # 警告的处理必须区分输出模式：
            # - --json：绝不写 stderr（调用方常把 2>&1 合并捕获，会把警告混进 JSON），
            #   改为放进 JSON 的 warning 字段，stdout 始终是纯 JSON/JSONL。
            # - 人类可读模式：警告写 stderr，不污染正文。
            warnings: list[str] = []
            if data.get("session_reset") and not session_reset_warned:
                # --since 超出当前后端进程的序号（通常是后端重启后 seq 从 1 开始）
                warnings.append("指定的 --since 超出当前后端进程的 RTT 序号"
                                "（后端重启后 seq 从 1 开始），已从当前缓存最旧数据读取。")
                session_reset_warned = True
            if data.get("lost"):
                warnings.append("RTT 环形缓存已覆盖部分历史数据（lost），如需完整日志请及时 --follow。")

            if warnings and not args.json_ and not args.quiet:
                for warning in warnings:
                    print(f"警告: {warning}", file=sys.stderr)

            if args.json_:
                # follow 模式：有数据/有警告时才输出一行，避免空行刷屏；
                # 非 follow 模式：即使没有数据也输出一个完整对象。
                if raw or warnings or not follow:
                    payload = {k: v for k, v in data.items() if k != "chunks"}
                    payload["chunks"] = chunks
                    if warnings:
                        payload["warning"] = "；".join(warnings)
                    if not args.quiet:
                        # follow 模式输出 JSONL（每批一行），便于流式消费
                        print(json.dumps(payload, ensure_ascii=False, indent=None if follow else 2))
            elif raw and not args.quiet:
                text = decoder.decode(raw)
                if text:
                    sys.stdout.write(text)
                    sys.stdout.flush()
                    printed_any = True
                    tail = text[-1:]

            since = int(data.get("cursor", since))
            if not follow:
                break
            if deadline is not None and time.time() >= deadline:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        # follow 是无限流，Ctrl+C 是正常结束方式
        pass
    finally:
        if out is not None:
            out.close()

    if not args.json_ and not args.quiet:
        if not read_any:
            print("（暂无 RTT 数据：确认固件已初始化 SEGGER RTT 并产生输出，"
                  "或先执行 `omni rtt start`）", file=sys.stderr)
        else:
            # 刷出增量解码器可能残留的半个多字节字符
            rest = decoder.decode(b"", final=True) if decoder is not None else ""
            if rest:
                sys.stdout.write(rest)
                tail = rest[-1:]
            if tail not in ("", "\n"):
                sys.stdout.write("\n")
            sys.stdout.flush()
    if out is not None and not args.json_ and not args.quiet:
        print(f"已追加写入: {args.out}", file=sys.stderr)
    return 0


def _send(c: ApiClient, args):
    uid = _require_uid(c, args)
    if args.file:
        path = os.path.abspath(os.path.expanduser(args.file))
        if not os.path.isfile(path):
            print(f"错误: 文件不存在: {path}")
            return 1
        try:
            raw = open(path, "rb").read()
        except OSError as e:
            print(f"错误: 读取失败: {e}")
            return 1
        data = c.post(f"/api/probes/{uid}/rtt/send",
                      {"data": base64.b64encode(raw).decode("ascii"),
                       "channel": args.channel})
        verb = f"已发送 {len(raw)} 字节（{os.path.basename(path)}）"
    elif args.base64:
        data = c.post(f"/api/probes/{uid}/rtt/send",
                      {"data": args.base64.replace(" ", ""), "channel": args.channel})
        verb = f"已发送 {len(base64.b64decode(args.base64.replace(' ', '')))} 字节"
    elif args.text is not None:
        data = c.post(f"/api/probes/{uid}/rtt/send-text",
                      {"text": args.text, "channel": args.channel,
                       "append_newline": not args.no_newline})
        verb = f"已发送文本: {args.text!r}"
    else:
        print("错误: 请提供 --file PATH、--base64 DATA 或 --text TEXT。")
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