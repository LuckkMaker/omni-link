"""Flash 命令：program / erase / verify / blank-check / read / fill / cancel / reset。"""

import os
import sys

from ..client import ApiClient
from ..options import common_parser
from ..runtime import finish, run_command
from ..util import parse_int, require_uid


def _resolve_file(path: str) -> str | None:
    """把固件路径转为绝对路径并检查存在性。

    后端是按自己的 cwd（源码态为 python/）解析相对路径的；CLI 从别的目录执行时，
    相对路径会在后端侧找不到文件（甚至误命中同名文件），因此这里统一转绝对路径。
    """
    if not path:
        return None
    absolute = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(absolute):
        print(f"错误: 文件不存在: {absolute}")
        return None
    return absolute


def _note_rtt_stopped(data: dict) -> None:
    """后端在 Flash 操作前自动停止了 RTT：提示用户日志需要重新 start。"""
    if data.get("rtt_stopped"):
        print("提示: Flash 操作前已自动停止 RTT 会话；需要日志请重新 `omni rtt start`。",
              file=sys.stderr)


def add_parser(sub):
    p = sub.add_parser("flash", help="Flash 烧录/擦除/校验/回读/填充/复位")
    ps = p.add_subparsers(dest="flash_sub", metavar="<sub>")
    _uid_arg = lambda s: s.add_argument("--uid", help="探针唯一 ID（缺省取第一个探针）")

    s = ps.add_parser("program", parents=[common_parser()], help="烧录固件（默认超时 180s）")
    _uid_arg(s)
    s.add_argument("file", help="固件文件路径（hex/bin/elf）")
    s.add_argument("--no-verify", action="store_true", help="烧录后不校验")
    s.add_argument("--no-reset", action="store_true", help="烧录后不复位运行")
    s.add_argument("--base-address", help="基地址（十六进制或十进制）")
    # 擦除+写入+校验经常超过 30s（1MB 全片擦除实测约 16s），默认放宽到 180s
    s.set_defaults(func=run_command(_program), timeout=180)

    s = ps.add_parser("erase", parents=[common_parser()],
                      help="擦除 Flash（默认超时 180s；操作前会自动停止 RTT）")
    _uid_arg(s)
    s.add_argument("--type", default="chip", choices=["chip", "sector", "sector_range"],
                   help="擦除范围")
    s.add_argument("--addr", help="起始地址（sector/sector_range）")
    s.add_argument("--size", help="大小（sector_range）")
    s.set_defaults(func=run_command(_erase), timeout=180)

    s = ps.add_parser("verify", parents=[common_parser()], help="校验 Flash 与固件文件（默认超时 120s）")
    _uid_arg(s)
    s.add_argument("file", help="固件文件路径")
    s.add_argument("--base-address", help="基地址")
    s.set_defaults(func=run_command(_verify), timeout=120)

    s = ps.add_parser("blank-check", parents=[common_parser()],
                      help="检查 Flash 是否空白（默认超时 120s）")
    _uid_arg(s)
    s.add_argument("--addr", help="起始地址（默认 Flash 起始）")
    s.add_argument("--size", help="大小（默认整个 Flash）")
    s.set_defaults(func=run_command(_blank), timeout=120)

    s = ps.add_parser("read", parents=[common_parser()], help="读取 Flash 内容（默认超时 120s）")
    _uid_arg(s)
    s.add_argument("--type", default="chip", choices=["chip", "range"], help="读取范围")
    s.add_argument("--addr", help="起始地址（range）")
    s.add_argument("--size", help="大小（range）")
    s.add_argument("--out", metavar="PATH", help="后端侧保存路径（可选，另回 base64 数据）")
    s.set_defaults(func=run_command(_read), timeout=120)

    s = ps.add_parser("fill", parents=[common_parser()], help="填充内存区域（Flash/RAM，默认超时 120s）")
    _uid_arg(s)
    s.add_argument("--addr", required=True, help="起始地址")
    s.add_argument("--size", required=True, help="大小")
    s.add_argument("--value", type=parse_int, default=0xFF,
                   help="填充字节 0-255（默认 0xFF，支持 0x55 形式）")
    s.set_defaults(func=run_command(_fill), timeout=120)

    s = ps.add_parser("cancel", parents=[common_parser()], help="取消正在进行的 Flash 操作")
    _uid_arg(s)
    s.set_defaults(func=run_command(_cancel))

    s = ps.add_parser("reset", parents=[common_parser()],
                      help="复位目标（默认 hw + 复位后运行；--no-run 暂停，与 debug reset 相反）")
    _uid_arg(s)
    s.add_argument("--type", default="hw", choices=["hw", "sw"], help="复位类型")
    s.add_argument("--no-run", action="store_true", help="复位后停留在暂停态，不继续运行")
    s.set_defaults(func=run_command(_reset))


def _require(c, args):
    uid = require_uid(c, args)
    if not uid:
        return None
    return uid


def _program(c: ApiClient, args):
    uid = _require(c, args)
    if not uid:
        return 1
    path = _resolve_file(args.file)
    if path is None:
        return 1
    payload = {
        "file_path": path,
        "verify": not args.no_verify,
        "reset": not args.no_reset,
        "base_address": parse_int(args.base_address),
    }
    data = c.post(f"/api/probes/{uid}/flash/program", payload)
    _report_flash_result(args, "烧录", data)
    return 1 if not data.get("success") else 0


def _erase(c: ApiClient, args):
    uid = _require(c, args)
    if not uid:
        return 1
    payload = {
        "type": args.type,
        "address": parse_int(args.addr) or 0,
        "size": parse_int(args.size) or 0,
    }
    data = c.post(f"/api/probes/{uid}/flash/erase", payload)
    _report_flash_result(args, "擦除", data, bytes_key="bytes_erased")
    return 1 if not data.get("success") else 0


def _verify(c: ApiClient, args):
    uid = _require(c, args)
    if not uid:
        return 1
    path = _resolve_file(args.file)
    if path is None:
        return 1
    payload = {"file_path": path, "base_address": parse_int(args.base_address)}
    data = c.post(f"/api/probes/{uid}/flash/verify", payload)
    _report_flash_result(args, "校验", data, bytes_key="bytes_verified")
    return 1 if not data.get("success") else 0


def _blank(c: ApiClient, args):
    uid = _require(c, args)
    if not uid:
        return 1
    payload = {"address": parse_int(args.addr), "size": parse_int(args.size)}
    data = c.post(f"/api/probes/{uid}/flash/blank-check", payload)
    if not args.json_:
        _note_rtt_stopped(data)
    if args.json_:
        finish(args, data, "")
        return 0
    ok = data.get("success")
    if not ok:
        print(f"错误: {data.get('error')}")
        return 1
    is_blank = data.get("is_blank")
    first = data.get("first_nonblank_addr")
    first_txt = f"  首个非空地址: 0x{first:x}" if isinstance(first, int) else ""
    print(f"空白: {'是' if is_blank else '否'}  扫描 {data.get('scanned_bytes')}/{data.get('total_bytes')} 字节"
          f"{first_txt}  耗时 {data.get('duration_ms')}ms")
    # blank-check 成功但非空白不算 CLI 失败（结果信息性）
    return 0


def _read(c: ApiClient, args):
    uid = _require(c, args)
    if not uid:
        return 1
    payload = {
        "type": args.type,
        "address": parse_int(args.addr) or 0,
        "size": parse_int(args.size) or 0,
        # 后端按自己的 cwd 写文件，这里统一转绝对路径，避免落到后端目录
        "output_path": os.path.abspath(os.path.expanduser(args.out)) if args.out else "",
    }
    data = c.post(f"/api/probes/{uid}/flash/read", payload)
    if not args.json_:
        _note_rtt_stopped(data)
    if args.json_:
        # 不打印 base64 全文，避免污染 json 输出长度
        summary = {k: v for k, v in data.items() if k not in ("base64_data",)}
        finish(args, summary, "")
        return 0
    ok = data.get("success")
    if not ok:
        print(f"错误: {data.get('error')}")
        return 1
    base = data.get("base_address")
    base_txt = f"0x{base:08X}" if isinstance(base, int) else str(base)
    print(f"读取成功: {data.get('bytes_read')} 字节 (@{base_txt})"
          + (f"  已保存: {data.get('output_path')}" if data.get("output_path") else "")
          + f"  耗时 {data.get('duration_ms')}ms")
    return 0


def _fill(c: ApiClient, args):
    uid = _require(c, args)
    if not uid:
        return 1
    value = args.value
    if not isinstance(value, int) or not (0 <= value <= 255):
        print(f"错误: --value 必须是 0-255 的整数（支持 0x55 形式），收到 {value!r}")
        return 2
    payload = {
        "address": parse_int(args.addr),
        "size": parse_int(args.size),
        "value": value,
    }
    data = c.post(f"/api/probes/{uid}/flash/fill", payload)
    _report_flash_result(args, "填充", data)
    return 1 if not data.get("success") else 0


def _cancel(c: ApiClient, args):
    uid = _require(c, args)
    if not uid:
        return 1
    data = c.post(f"/api/probes/{uid}/flash/cancel")
    finish(args, data, "已发送取消请求" if data.get("success") else "取消失败")
    return 0 if data.get("success") else 1


def _reset(c: ApiClient, args):
    uid = _require(c, args)
    if not uid:
        return 1
    payload = {"type": args.type, "run": not args.no_run}
    data = c.post(f"/api/probes/{uid}/reset", payload)
    if args.json_:
        finish(args, data, "")
        return 0
    print("复位成功" if data.get("success") else "复位失败")
    return 0 if data.get("success") else 1


def _report_flash_result(args, label: str, data: dict, bytes_key: str = "bytes_written"):
    """统一输出 FlashResult（成功/失败/字节/耗时）。

    verify 用 ``bytes_verified``、erase 用 ``bytes_erased``；缺少该字段时只打印耗时，
    不再显示误导性的 ``0 字节``（P3-1）。
    """
    if args.json_:
        finish(args, data, "")
        return
    _note_rtt_stopped(data)
    if not data.get("success"):
        print(f"{label}失败: {data.get('error')}")
        return
    n = data.get(bytes_key)
    amount = f"{n} 字节  " if n is not None else ""
    print(f"{label}成功: {amount}耗时 {data.get('duration_ms')}ms")