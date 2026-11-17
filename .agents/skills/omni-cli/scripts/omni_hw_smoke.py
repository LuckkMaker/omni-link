#!/usr/bin/env python3
"""omni CLI 实机冒烟测试（omni-cli 0.23.0+）。

后端 → 探针 → (擦除) → 烧录 → 校验 → 恢复运行 → (ELF) → RTT 抓取断言 → 清理。
`flash verify` 结束会暂停目标，所以抓 RTT 前必须 `debug run`。
任一断言或命令失败则退出码为 1；默认结束时停止 RTT、断开探针、停止后端。

用法示例：
    python omni_hw_smoke.py --firmware Objects/stm32f407/omni.hex \
        --jlink-device STM32F407IG --elf Objects/stm32f407/omni.axf \
        --expect "read from 6" --expect "free: \\d+ clusters"
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import omni_cli as oc  # noqa: E402

FAILURES: list[str] = []
STEP = 0


def step(text: str) -> None:
    global STEP
    STEP += 1
    print(f"\n[{STEP}] {text}")


def ok(text: str) -> None:
    print(f"    OK  {text}")


def bad(text: str) -> None:
    print(f"    FAIL {text}")
    FAILURES.append(text)


def load_expect(args) -> list[str]:
    patterns = list(args.expect or [])
    if args.expect_file:
        for line in Path(args.expect_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                patterns.append(line)
    return patterns


def main() -> int:
    parser = argparse.ArgumentParser(description="omni CLI 实机冒烟：烧录 + 校验 + RTT 断言")
    parser.add_argument("--uid", help="探针 UID（缺省取第一个）")
    parser.add_argument("--firmware", required=True, help="要烧录的 hex/bin/elf")
    parser.add_argument("--target", default="stm32f407xg", help="目标型号（默认 stm32f407xg）")
    parser.add_argument("--jlink-device", help="J-Link 设备名（J-Link 必填，如 STM32F407IG）")
    parser.add_argument("--speed", type=int, default=4_000_000, help="SWD 频率 Hz（默认 4 MHz）")
    parser.add_argument("--elf", help="可选：烧录后加载 ELF，便于后续调试")
    parser.add_argument("--base-address", help="bin 文件的基地址")
    parser.add_argument("--chip-erase", action="store_true", help="烧录前全片擦除")
    parser.add_argument("--rtt-seconds", type=float, default=3.0, help="RTT 采样秒数（默认 3）")
    parser.add_argument("--expect", action="append", metavar="REGEX", help="RTT 日志必须匹配的正则，可重复")
    parser.add_argument("--expect-file", help="每行一个正则（# 开头忽略）")
    parser.add_argument("--rtt-out", help="把本轮 RTT 文本写入该文件")
    parser.add_argument("--timeout", type=int, default=240, help="Flash 操作 HTTP 超时秒数")
    parser.add_argument("--keep-session", action="store_true", help="结束后保留后端与探针连接")
    args = parser.parse_args()

    oc.setup_console()
    uid = None
    started_rtt = False
    started_backend = False
    opened_probe = False
    patterns = load_expect(args)

    try:
        step("omni 版本")
        _, version, _ = oc.run(["--version"])
        ok(version)

        step("后端")
        if oc.backend_running():
            _, status_text, _ = oc.run(["backend", "status"])
            ok(f"后端已在运行：{status_text}（结束时不会停掉它）")
        else:
            oc.run(["backend", "start"])
            started_backend = True
            ok("已启动常驻后端")

        step("探针")
        uid = oc.resolve_uid(args.uid)
        if not args.uid:
            ok(f"选用第一个探针：{uid}")

        probe = oc.run_json(["probe", "status", uid, "--json"])
        target = (probe or {}).get("target") or {}
        need_connect = (
            probe.get("state") != "connected"
            or not target
            or target.get("part_number") != args.target
        )
        if need_connect:
            cmd = ["probe", "connect", uid, "--target", args.target, "--speed", str(args.speed)]
            if args.jlink_device:
                cmd += ["--jlink-device", args.jlink_device]
            if probe.get("state") == "connected":
                cmd.append("--force")
            oc.run(cmd)
            opened_probe = True
            probe = oc.run_json(["probe", "status", uid, "--json"])
        if probe.get("state") != "connected":
            raise oc.OmniError(f"探针 {uid} 未连接：{probe.get('state')}")
        info = probe.get("target") or {}
        ok(f"{uid} → {info.get('part_number')} / Flash {int(info.get('flash_size', 0)) // 1024} KB")

        if args.chip_erase:
            step("全片擦除")
            erase = oc.run_json(
                ["flash", "erase", "--type", "chip", "--json", "--timeout", str(args.timeout)]
            ) or {}
            if not erase.get("success"):
                raise oc.OmniError(f"擦除失败：{erase.get('error')}")
            ok(
                f"bytes_erased={erase.get('bytes_erased')}  "
                f"{erase.get('duration_ms')} ms  rtt_stopped={erase.get('rtt_stopped')}"
            )

        step(f"烧录 {args.firmware}")
        prog_cmd = ["flash", "program", args.firmware, "--json", "--timeout", str(args.timeout)]
        if args.base_address:
            prog_cmd += ["--base-address", args.base_address]
        prog = oc.run_json(prog_cmd) or {}
        if not prog.get("success"):
            raise oc.OmniError(f"烧录失败：{prog.get('error')}")
        ok(
            f"bytes_written={prog.get('bytes_written')}  "
            f"{prog.get('duration_ms')} ms  rtt_stopped={prog.get('rtt_stopped')}"
        )

        step("校验 Flash")
        verify_cmd = ["flash", "verify", args.firmware, "--json", "--timeout", str(args.timeout)]
        ver = oc.run_json(verify_cmd) or {}
        if not ver.get("success"):
            raise oc.OmniError(f"校验失败：{ver.get('error')}")
        ok(f"bytes_verified={ver.get('bytes_verified')}  {ver.get('duration_ms')} ms")

        # 0.23.0 的 verify 会 reset_and_halt 后再读，结束后目标停在 paused；
        # 不恢复运行，后面的 RTT 采样拿不到任何新日志。
        step("恢复运行")
        oc.run(["debug", "run"], allow_fail=True)
        ok("已 resume（verify 结束时目标处于 paused）")

        if args.elf:
            step("加载 ELF")
            elf = oc.run_json(["debug", "elf", "load", args.elf, "--json"]) or {}
            ok(f"源文件 {len(elf.get('source_files') or [])} 个 / 函数 {elf.get('function_count')} 个")

        step(f"抓取 RTT（{args.rtt_seconds:g} s）")
        # 0.23.0：start 清空抓取缓存但 seq 在同一后端进程内单调递增，stop → start 后直接读就是本轮日志
        oc.run(["rtt", "stop"], allow_fail=True)
        oc.run(["rtt", "start"])
        started_rtt = True
        time.sleep(args.rtt_seconds)

        data = oc.run_json(["rtt", "read", "--json"]) or {}
        text = oc.strip_ansi(data.get("text") or "") if data.get("text") else ""

        if text:
            print("    --- RTT ---")
            for line in text.splitlines():
                if line.strip():
                    print(f"    {line}")
            print("    -----------")
        else:
            print("    （本轮没有新日志）")

        if data.get("lost"):
            bad("RTT 环形缓存被覆盖（lost=true），日志不完整")

        if args.rtt_out:
            oc.write_rtt_log(args.rtt_out, text)
            ok(f"日志已保存：{args.rtt_out}")

        for pattern in patterns:
            if re.search(pattern, text):
                ok(f"RTT 命中 /{pattern}/")
            else:
                bad(f"RTT 未命中 /{pattern}/")

    except (oc.OmniError, OSError) as exc:
        FAILURES.append(str(exc))
        print(f"\n[ERROR] {exc}")
    finally:
        if args.keep_session:
            print("\n[keep-session] 保留后端与探针连接；用完记得 omni backend stop")
        else:
            step("清理")
            cleaned = []
            if started_rtt:
                oc.run(["rtt", "stop"], allow_fail=True)
                cleaned.append("RTT")
            if opened_probe and uid:
                oc.run(["probe", "disconnect", uid], allow_fail=True)
                cleaned.append("探针")
            if started_backend:
                oc.run(["backend", "stop"], allow_fail=True)
                cleaned.append("后端")
            if cleaned:
                ok("已停止/断开本脚本启动的资源：" + "、".join(cleaned))
            else:
                ok("没有需要清理的资源（后端与探针都是复用的，保持原样）")

    print()
    if FAILURES:
        print(f"结果：失败（{len(FAILURES)} 项）")
        for item in FAILURES:
            print(f"  - {item}")
        return 1
    print("结果：通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
