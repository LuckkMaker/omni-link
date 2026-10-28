"""RTT 后端离线回归测试（无需硬件）。

覆盖 2026-10 实机问题的根因：

1. 不可读 RAM 区段（如 STM32F407/G32F463 的 CCM 0x10000000）不再被无限二分：
   - 一块 16KB 全失败最多产生少量读请求，失败明细有条数上限；
   - `_fast_scan_region` 起始 16 字节探测失败后整段跳过，不再产生几百条 WARN。
2. 扫描顺序：主 SRAM（0x2000_0000 起）优先于 CCM/DTCM。
3. 轮询线程绑定会话对象：stop 后旧线程不会因为新会话复用同一 uid 而"复活"，
   不会出现多个线程同时读同一 target；stop 也不等待卡死在读里的线程。
4. 启动取消令牌：已被取消（HTTP 超时 / Stop）的启动流程立即返回，不会稍后
   偷偷把会话装上去。

用法::

    cd python
    ..\\.venv\\Scripts\\python.exe test_rtt_scan.py
"""

import os
import sys
import threading
import time
import types

PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PY_DIR)

import core.rtt_backend as rb  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}" + (f"  ({detail})" if detail else ""))
        failures.append(name)


class Region:
    def __init__(self, start, length):
        self.start = start
        self.length = length

    def __repr__(self):
        return f"Region(0x{self.start:08X}, 0x{self.length:X})"


class FakeTarget:
    """按地址区间模拟可读/不可读的 target（只实现扫描用到的两个方法）。"""

    def __init__(self, regions=None, bad_ranges=(), span=None):
        # regions: [(addr, data_bytes)]；span=(lo, hi) 之外一律读失败（模拟坏区段）
        self.mem: dict[int, bytes] = {}
        for addr, data in regions or []:
            self.mem[addr] = data
        self.bad = list(bad_ranges)
        self.span = span
        self.read_calls = 0

    def _is_bad(self, addr, size):
        end = addr + max(size, 1)
        if self.span is not None:
            lo, hi = self.span
            if addr < lo or end > hi:
                return True
        for lo, hi in self.bad:
            if addr < hi and end > lo:
                return True
        return False

    def _read(self, addr, size):
        self.read_calls += 1
        if self._is_bad(addr, size):
            raise RuntimeError("Unspecified error.")
        out = bytearray(size)
        for base, data in self.mem.items():
            lo = max(addr, base)
            hi = min(addr + size, base + len(data))
            if lo < hi:
                out[lo - addr:hi - addr] = data[lo - base:hi - base]
        return bytes(out)

    def read_memory_block32(self, addr, words):
        raw = self._read(addr, words * 4)
        return [int.from_bytes(raw[i:i + 4], "little") for i in range(0, len(raw), 4)]

    def read_memory_block8(self, addr, size):
        return list(self._read(addr, size))


def make_sram_with_cb(addr=0x200000A0):
    """构造一段 RAM：0x20000000 起 0x400 字节，控制块标识放在 addr。"""
    data = bytearray(0x400)
    ident = b"SEGGER RTT" + b"\x00" * 6
    off = addr - 0x20000000
    data[off:off + len(ident)] = ident
    return [(0x20000000, bytes(data))]


def test_bounded_bisection():
    print("[1] 不可读块二分有界 + 失败明细有上限")
    target = FakeTarget(bad_ranges=[(0x10000000, 0x10010000)],
                        span=(0x10000000, 0x10010000))
    fails: list[str] = []
    out = rb.RTTBackend()._read_region_block32(target, 0x10000000, 4096, fails)
    check("读不到数据", out == [], f"out={out}")
    check("读请求次数有界（<= 32 次）", target.read_calls <= 32, f"reads={target.read_calls}")
    check("失败明细不超过上限", len(fails) <= rb.RTT_SCAN_MAX_FAILURES, f"n={len(fails)}")


def test_scan_skips_unreadable_region():
    print("[2] 整段不可读的 region 被快速跳过（起始探测失败即返回）")
    target = FakeTarget(bad_ranges=[(0x10000000, 0x10010000)],
                        span=(0x0, 0xFFFFFFFF))
    res = rb.RTTBackend()._fast_scan_region(target, Region(0x10000000, 0x10000))
    check("unreadable=True", res["unreadable"] is True, str(res))
    check("只发少量读请求（<= 4）", res["reads"] <= 4, f"reads={res['reads']}")
    check("失败明细压缩（<= 2）", len(res["failures"]) <= 2, f"n={len(res['failures'])}")


def test_scan_tolerates_partial_failure():
    print("[3] 局部坏块不影响命中控制块，失败明细有界")
    data = bytearray(make_sram_with_cb()[0][1])
    data += bytearray(0x400)  # 0x20000400 起也保持可读
    target = FakeTarget(regions=[(0x20000000, bytes(data))],
                        bad_ranges=[(0x20000200, 0x20000300)],
                        span=(0x20000000, 0x20000400))
    res = rb.RTTBackend()._fast_scan_region(target, Region(0x20000000, 0x400))
    check("命中控制块 @0x200000A0", res["hit"] == 0x200000A0, str(res))
    check("记录了失败但有界", 0 < len(res["failures"]) <= rb.RTT_SCAN_MAX_FAILURES,
          f"n={len(res['failures'])}")


def test_scan_finds_cb_fast():
    print("[4] 正常 SRAM 扫描命中且读请求很少")
    target = FakeTarget(regions=make_sram_with_cb(),
                        span=(0x20000000, 0x20020000))
    t0 = time.monotonic()
    res = rb.RTTBackend()._fast_scan_region(target, Region(0x20000000, 0x20000),
                                            max_bytes=0x4000)
    dt = time.monotonic() - t0
    check("hit=0x200000A0", res["hit"] == 0x200000A0, str(res))
    check("耗时 < 0.5s", dt < 0.5, f"{dt:.3f}s")
    check("reads <= 3", res["reads"] <= 3, f"reads={res['reads']}")


def test_region_priority():
    print("[5] 扫描顺序：主 SRAM 优先，其次大容量")
    backend = rb.RTTBackend()
    regions = [Region(0x10000000, 0x10000), Region(0x20000000, 0x20000)]
    ordered = sorted(regions, key=backend._rtt_region_priority)
    check("SRAM 排在 CCM 前", ordered[0].start == 0x20000000, str(ordered))
    big = [Region(0x20000000, 0x10000), Region(0x20020000, 0x40000)]
    ordered = sorted(big, key=backend._rtt_region_priority)
    check("大 region 优先", ordered[0].length == 0x40000, str(ordered))


def test_start_cancel_token():
    print("[6] 已取消的启动令牌立即返回，不触碰 target")
    backend = rb.RTTBackend()

    class Boom:
        def _get_session(self, uid):
            raise AssertionError("不应访问 session")

    old_backend = rb.backend
    rb.backend = Boom()
    try:
        token = rb._StartToken()
        token.cancel.set()
        out = backend._start_inner("uid", token=token)
    finally:
        rb.backend = old_backend
    check("返回 cancelled=True", out.get("cancelled") is True, str(out))
    check("success=False", out.get("success") is False, str(out))


class FakeChannel:
    def __init__(self, delay=0.0, payload=b"x"):
        self.delay = delay
        self.payload = payload
        self.reads = 0
        self.closed = threading.Event()

    def read(self):
        self.reads += 1
        if self.delay:
            time.sleep(self.delay)
        return self.payload


class FakeCB:
    def __init__(self, channel):
        self.up_channels = [channel]
        self.down_channels = []
        self.target = None


class FakeProbeBackend:
    def __init__(self):
        self.connected = True
        self.locks: dict[str, threading.Lock] = {}

    def is_connected(self, uid):
        return self.connected

    def get_op_lock(self, uid):
        return self.locks.setdefault(uid, threading.Lock())

    def _get_session(self, uid):
        return None

    def get_core_state(self, uid):
        return None


def test_poll_loop_not_resurrected():
    print("[7] stop 后旧轮询线程不会读新会话（无重复轮询）")
    old_backend = rb.backend
    fake = FakeProbeBackend()
    rb.backend = fake
    try:
        backend = rb.RTTBackend()
        ch1 = FakeChannel(payload=b"a")
        s1 = rb._RttSession("u1", FakeCB(ch1), 0, 0)
        t1 = threading.Thread(target=backend._poll_loop, args=(s1,), daemon=True)
        t1.start()
        backend._sessions["u1"] = s1
        time.sleep(0.1)

        # stop：置位会话并让线程退出
        backend._sessions.pop("u1", None)
        s1.stop.set()
        s1.running.clear()
        t1.join(timeout=2)
        check("旧线程已退出", not t1.is_alive())

        # 新会话：旧线程不能继续读
        ch2 = FakeChannel(payload=b"b")
        s2 = rb._RttSession("u1", FakeCB(ch2), 0, 0)
        backend._sessions["u1"] = s2
        t2 = threading.Thread(target=backend._poll_loop, args=(s2,), daemon=True)
        s2.thread = t2
        t2.start()
        time.sleep(0.1)
        before = ch2.reads
        time.sleep(0.15)
        check("新会话在被读取", ch2.reads > before, f"new={ch2.reads} old={ch1.reads}")
        s2.stop.set()
        s2.running.clear()
        t2.join(timeout=2)
    finally:
        rb.backend = old_backend


def test_stop_does_not_wait_for_blocked_read():
    print("[8] stop 不被卡在读里的轮询线程拖住")
    old_backend = rb.backend
    fake = FakeProbeBackend()
    rb.backend = fake
    try:
        backend = rb.RTTBackend()
        ch = FakeChannel(delay=2.0)
        s = rb._RttSession("u2", FakeCB(ch), 0, 0)
        t = threading.Thread(target=backend._poll_loop, args=(s,), daemon=True)
        s.thread = t
        backend._sessions["u2"] = s
        t.start()
        time.sleep(0.1)
        t0 = time.monotonic()
        backend.stop("u2")
        dt = time.monotonic() - t0
        check("stop 在 1.5s 内返回", dt < 1.5, f"{dt:.2f}s")
        check("会话已移除", backend.is_running("u2") is False)
    finally:
        rb.backend = old_backend


def test_scan_aborts_after_consecutive_block_failures():
    print("[9] 起始可读但后续大块连续失败：判定整段不可读并提前结束")
    # 只有起始 16 字节可读，后面全部失败（模拟"探测能过、实际扫不动"的区段）
    target = FakeTarget(regions=[(0x30000000, bytes(16))],
                        span=(0x30000000, 0x30000010))
    res = rb.RTTBackend()._fast_scan_region(target, Region(0x30000000, 0x8000))
    check("unreadable=True", res["unreadable"] is True, str(res))
    check("读请求有界（<= 64）", res["reads"] <= 64, f"reads={res['reads']}")
    check("失败明细有界", len(res["failures"]) <= rb.RTT_SCAN_MAX_FAILURES,
          f"n={len(res['failures'])}")
    check("失败计数>=明细", res["failure_count"] >= len(res["failures"]),
          f"count={res['failure_count']} n={len(res['failures'])}")


def main():
    test_bounded_bisection()
    test_scan_skips_unreadable_region()
    test_scan_tolerates_partial_failure()
    test_scan_finds_cb_fast()
    test_region_priority()
    test_start_cancel_token()
    test_poll_loop_not_resurrected()
    test_stop_does_not_wait_for_blocked_read()
    test_scan_aborts_after_consecutive_block_failures()

    print()
    if failures:
        print(f"FAILED: {len(failures)} 项 -> {failures}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
