#!/usr/bin/env python3
"""按固定间隔轮询一个内存地址/符号，打印取值与变化（寄存器级观察）。

通过 omni 后端读取内存，不改目标状态，目标可继续运行。
单次调用约 0.7–1.1 s，所以实际采样率约 1 Hz；需要更快用 `omni monitor start --rate`（后端内采样）
或 jlink-live-debug 的 pylink 方案。

用法示例：
    python omni_reg_watch.py --addr 0x40021014 --seconds 10 --interval-ms 500
    python omni_reg_watch.py --symbol fat_fs --elf Objects/stm32f407/omni.axf --size 1
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import omni_cli as oc  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="轮询寄存器/内存地址并打印变化")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--addr", help="起始地址（hex，如 0x40021014 = GPIOE->ODR）")
    source.add_argument("--symbol", help="符号名（需 --elf 或后端已加载 ELF）")
    parser.add_argument("--elf", help="加载 ELF 后再解析符号")
    parser.add_argument("--uid", help="探针 UID（缺省取第一个）")
    parser.add_argument("--size", type=int, choices=(1, 2, 4), default=4, help="字节数（按小端解释）")
    parser.add_argument("--interval-ms", type=int, default=500, help="采样间隔毫秒（默认 500）")
    parser.add_argument("--seconds", type=float, default=10.0, help="总时长秒（默认 10）")
    args = parser.parse_args()

    oc.setup_console()

    try:
        uid = oc.resolve_uid(args.uid)
        common = ["--uid", uid]

        addr = args.addr
        if args.symbol:
            if args.elf:
                oc.run(["debug", "elf", "load", args.elf] + common)
            resolved = oc.run_json(["debug", "mem", "resolve", f"&{args.symbol}", "--json"] + common) or {}
            if resolved.get("address") is None:
                raise oc.OmniError(f"无法解析符号 {args.symbol}（先 elf load）")
            addr = f"0x{int(resolved['address']):X}"
            print(f"符号 {args.symbol} → {addr}")

        deadline = time.monotonic() + args.seconds
        prev = None
        changes = 0
        samples = 0
        started = time.monotonic()

        print(
            f"轮询 {addr}（{args.size} 字节，间隔 {args.interval_ms} ms；"
            "单次约 0.7–1.1 s，受命令往返限制）"
        )

        while time.monotonic() < deadline:
            mem = {}
            for _ in range(5):
                mem = oc.run_json(
                    ["debug", "mem", "read", "--addr", addr, "--size", str(args.size), "--json"] + common
                ) or {}
                # 目标端有调试操作进行时后端会返回 skipped=true（不带数据），稍等重试
                if mem.get("data_hex") and not mem.get("skipped"):
                    break
                time.sleep(0.2)

            data_hex = mem.get("data_hex")
            if not data_hex:
                print("  读取失败：后端持续返回 skipped/空数据（有其它调试操作占用目标？）")
                return 1

            value = int.from_bytes(bytes.fromhex(data_hex), "little")
            samples += 1
            changed = prev is not None and value != prev
            if changed:
                changes += 1

            stamp = time.strftime("%H:%M:%S", time.localtime()) + f".{int(time.time() * 1000) % 1000:03d}"
            line = f"{stamp}  {addr} = 0x{value:X} ({value})"
            if changed:
                line += "   <- changed"
            print(line)

            prev = value
            if args.interval_ms > 0:
                time.sleep(args.interval_ms / 1000.0)

        elapsed = max(time.monotonic() - started, 1e-9)
        print(f"\n采样 {samples} 次（{samples / elapsed:.1f} Hz），变化 {changes} 次")
        return 0

    except (oc.OmniError, OSError) as exc:
        print(f"错误：{exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
