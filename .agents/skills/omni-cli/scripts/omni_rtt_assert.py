#!/usr/bin/env python3
"""抓取并断言 SEGGER RTT 日志（不烧录，适合反复验证运行中的固件）。

默认 stop → start 开新会话（清缓存但 seq 在同一后端进程内单调递增），采样后读取本轮日志；
对每个 --expect 做正则断言，未命中退出码为 1。

注意：如果目标刚执行过 `flash verify`（结束时会暂停），先用 `omni debug run` 恢复运行，
否则本轮采不到新日志。

用法示例：
    python omni_rtt_assert.py --seconds 5 --expect "read from 6" --out rtt.log
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import omni_cli as oc  # noqa: E402


def load_expect(args) -> list[str]:
    patterns = list(args.expect or [])
    if args.expect_file:
        for line in Path(args.expect_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                patterns.append(line)
    return patterns


def main() -> int:
    parser = argparse.ArgumentParser(description="抓取并断言 RTT 日志")
    parser.add_argument("--uid", help="探针 UID（缺省取第一个）")
    parser.add_argument("--seconds", type=float, default=5.0, help="采样秒数（默认 5）")
    parser.add_argument("--expect", action="append", metavar="REGEX", help="必须匹配的正则，可重复")
    parser.add_argument("--expect-file", help="每行一个正则（# 开头忽略）")
    parser.add_argument("--since", type=int, default=0, help="从指定 seq 续读；默认 0=本轮缓存开头")
    parser.add_argument("--no-start", action="store_true", help="不重启 RTT，直接读当前会话（配合 --since）")
    parser.add_argument("--out", help="把文本写入该文件")
    parser.add_argument("--keep-rtt", action="store_true", help="结束后保留 RTT 会话")
    args = parser.parse_args()

    oc.setup_console()
    failures: list[str] = []
    patterns = load_expect(args)

    try:
        if not oc.backend_running():
            raise oc.OmniError("后端未运行：先执行 omni backend start")

        uid = oc.resolve_uid(args.uid)

        if not args.no_start:
            # 0.23.0：start 清空抓取缓存但 seq 在同一后端进程内单调递增，since=0 就是“本轮”
            oc.run(["rtt", "stop", "--uid", uid], allow_fail=True)
            oc.run(["rtt", "start", "--uid", uid])

        mode = "续读当前会话" if args.no_start else "新会话"
        print(f"RTT 采样 {args.seconds:g}s（since={args.since}，{mode}）...")
        time.sleep(args.seconds)

        read_cmd = ["rtt", "read", "--uid", uid, "--json"]
        if args.since > 0:
            read_cmd += ["--since", str(args.since)]
        data = oc.run_json(read_cmd) or {}
        text = oc.strip_ansi(data.get("text") or "") if data.get("text") else ""

        if text:
            for line in text.splitlines():
                if line.strip():
                    print(f"  {line}")
        else:
            print("  （没有新日志）")

        if data.get("lost"):
            failures.append("RTT 缓存被覆盖（lost=true）")

        if args.out:
            oc.write_rtt_log(args.out, text)
            print(f"日志已保存：{args.out}")

        for pattern in patterns:
            if re.search(pattern, text):
                print(f"  命中 /{pattern}/")
            else:
                print(f"  未命中 /{pattern}/")
                failures.append(f"未命中 /{pattern}/")

        if not args.keep_rtt:
            oc.run(["rtt", "stop", "--uid", uid], allow_fail=True)

    except (oc.OmniError, OSError) as exc:
        failures.append(str(exc))
        print(f"错误：{exc}")

    if failures:
        for item in failures:
            print(f"  - {item}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
