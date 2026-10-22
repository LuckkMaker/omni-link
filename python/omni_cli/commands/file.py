"""固件文件命令：info / checksum。

- ``info`` 复用后端 ``/api/files/parse``（bin/hex/elf 段信息）。
- ``checksum`` 在本地计算原始文件字节的校验和，算法与 GUI 文件校验页一致；
  不建后端客户端，后端未启动也可用。
"""

import os
import zlib

from ..client import ApiClient
from ..formatting import render_table
from ..options import common_parser, local_parser
from ..runtime import finish, run_command, run_local
from ..util import parse_int

_ALGORITHMS = ["modbus-crc16", "crc16-ccitt", "crc32", "add8", "xor8", "add16"]


def add_parser(sub):
    p = sub.add_parser("file", help="固件文件工具（段信息 / 校验和）")
    ps = p.add_subparsers(dest="file_sub", metavar="<sub>")

    s = ps.add_parser("info", parents=[common_parser()], help="解析 bin/hex/elf 的格式与段信息")
    s.add_argument("file", help="固件文件路径（.bin/.hex/.elf/.axf）")
    s.add_argument("--base-address", help="bin 文件的基地址（hex/dec）")
    s.set_defaults(func=run_command(_info))

    s = ps.add_parser("checksum", parents=[local_parser()],
                      help="计算文件字节的校验和（本地执行，不需要后端）")
    s.add_argument("file", help="文件路径")
    s.add_argument("--algorithm", default="crc32", choices=_ALGORITHMS,
                   help="校验算法（默认 crc32）")
    s.add_argument("--start", help="起始字节偏移（含，默认 0）")
    s.add_argument("--end", help="结束字节偏移（不含，默认文件末尾）")
    s.set_defaults(func=run_local(_checksum))


def _abs_file(path: str) -> str | None:
    absolute = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(absolute):
        print(f"错误: 文件不存在: {absolute}")
        return None
    return absolute


def _info(c: ApiClient, args):
    path = _abs_file(args.file)
    if path is None:
        return 1

    try:
        base = parse_int(args.base_address)
    except ValueError as e:
        print(f"错误: {e}")
        return 2

    data = c.post("/api/files/parse", {"file_path": path, "base_address": base})
    if args.json_:
        finish(args, data, "")
        return 0

    print(f"文件: {path}")
    print(f"  格式: {data.get('format')}  文件大小: {os.path.getsize(path)} 字节"
          f"  数据大小: {data.get('size')} 字节"
          + (f"  entry: 0x{data['entry']:08X}" if isinstance(data.get("entry"), int) else ""))
    segments = data.get("segments") or []
    if segments:
        print(render_table(
            ["段", "起始地址", "大小"],
            [[str(i), _hex(s.get("address")), _n(s.get("size"))]
             for i, s in enumerate(segments)],
        ))
    return 0


def _checksum(args):
    path = _abs_file(args.file)
    if path is None:
        return 1

    try:
        start = parse_int(args.start) if args.start is not None else 0
        end = parse_int(args.end) if args.end is not None else None
    except ValueError as e:
        print(f"错误: {e}")
        return 2

    with open(path, "rb") as f:
        raw = f.read()

    if start is None or start < 0:
        print("错误: --start 必须 >= 0")
        return 2
    if end is None:
        end = len(raw)
    if end < start or end > len(raw):
        print(f"错误: 范围无效（start={start}, end={end}, size={len(raw)}）")
        return 2

    data = raw[start:end]
    digest = _compute(args.algorithm, data)
    hex_bytes = " ".join(f"{b:02X}" for b in digest)

    if args.json_:
        finish(args, {
            "file": path,
            "algorithm": args.algorithm,
            "start": start,
            "end": end,
            "length": len(data),
            "checksum_hex": hex_bytes,
            "checksum": "0x" + "".join(f"{b:02X}" for b in digest),
        }, "")
        return 0

    # --quiet 只设置退出码：帮助里承诺“不输出任何内容”，人类可读路径也要守住
    if not args.quiet:
        print(f"{args.algorithm}: {hex_bytes}  (范围 {start}..{end}，{len(data)} 字节)")
    return 0


def _compute(algorithm: str, data: bytes) -> bytes:
    if algorithm == "modbus-crc16":
        crc = 0xFFFF
        for b in data:
            crc ^= b
            for _ in range(8):
                crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
        return bytes((crc & 0xFF, (crc >> 8) & 0xFF))

    if algorithm == "crc16-ccitt":
        crc = 0xFFFF
        for b in data:
            crc ^= (b << 8) & 0xFF00
            for _ in range(8):
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
        return bytes(((crc >> 8) & 0xFF, crc & 0xFF))

    if algorithm == "crc32":
        value = zlib.crc32(data) & 0xFFFFFFFF
        return value.to_bytes(4, "big")

    if algorithm == "add8":
        return bytes((sum(data) & 0xFF,))

    if algorithm == "xor8":
        value = 0
        for b in data:
            value ^= b
        return bytes((value & 0xFF,))

    if algorithm == "add16":
        return bytes(((sum(data) >> 8) & 0xFF, sum(data) & 0xFF))

    raise ValueError(f"未知算法: {algorithm}")


def _hex(value):
    return f"0x{value:08X}" if isinstance(value, int) else ("-" if value is None else value)


def _n(value):
    return "" if value is None else str(value)
