"""monitor_backend._read_variables 流水线/回退路径离线测试（mock AP/DP）

运行: python test_pipelined_read.py
"""
import sys
import types

fake_backend = types.ModuleType("core.pyocd_backend")
fake_backend.backend = types.SimpleNamespace(_get_session=lambda uid: None)
fake_events = types.ModuleType("core.events")
class _EM:
    def log(self, *a, **k): pass
    def emit(self, *a, **k): pass
fake_events.event_manager = _EM()
sys.modules["core.pyocd_backend"] = fake_backend
sys.modules["core.events"] = fake_events

import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core.monitor_backend import MonitorBackend, MonitoredVariable

# ── mock 探针/AP/DP ──────────────────────────────────────

class FakeDP:
    def __init__(self):
        self.writes = []          # [(addr, data)]
        self.reads = []           # [(addr, count)]
        self.flush_calls = 0
        self.words_by_start = {}  # start -> words（按组排队顺序取，与真实 pyocd FIFO 一致）
        self.seq = []             # 按调用顺序排列的 words 序列
        self.raise_on_flush = False

    def write_ap(self, addr, data):
        self.writes.append((addr, data))

    def read_ap_multiple(self, addr, count, now=False):
        self.reads.append((addr, count, now))
        if self.seq:
            words = self.seq.pop(0)
        else:
            words = self.words_by_start.get(next(iter(self.words_by_start), None), [0] * count)
        cb = lambda w=words: w
        return cb

    def flush(self):
        self.flush_calls += 1
        if self.raise_on_flush:
            raise RuntimeError("probe does not support pipelining")


class FakeAP:
    def __init__(self, dp, page_size=0x400):
        self.dp = dp
        self.address = types.SimpleNamespace(address=0x000000F0)
        self._reg_offset = 0
        self._csw = 0x23000000
        self.auto_increment_page_size = page_size


class FakeTarget:
    def __init__(self, ap):
        self.ap = ap
        self.mem32 = {}   # start -> words
        self.mem8 = {}    # start -> bytes

    def read_memory_block32(self, addr, size):
        return self.mem32.get(addr, [0] * size)

    def read_memory_block8(self, addr, size):
        return self.mem8.get(addr, bytes(size))

    def resume(self):
        pass


def make_session(ap, probe_link=None, is_bulk=True, target=None):
    session = types.SimpleNamespace(target=target or FakeTarget(ap))
    class _Probe:
        pass
    p = _Probe()
    p._link = types.SimpleNamespace(_interface=types.SimpleNamespace(is_bulk=is_bulk))
    session.probe = p
    return session


failures = []
def check(name, cond):
    if cond:
        print(f"  PASS  {name}")
    else:
        failures.append(name)
        print(f"  FAIL  {name}")


# 挂上 fake backend（直接 patch 原对象，monitor_backend 导入时已绑定该引用）
backend = fake_backend.backend
backend._get_session = lambda uid: session
backend.is_connected = lambda uid: True

mb = MonitorBackend()
UID = "test-probe"

def reset():
    """每个用例独立：清空跨用例状态（降级标志/传输类型/分组缓存）"""
    mb._pipeline_disabled.pop(UID, None)
    mb._transport_type.pop(UID, None)
    mb._vars_cache.pop(UID, None)

# ── 用例1: 流水线成功，密集变量合并 1 组 ──────────────────
print("== 用例1: 流水线成功 (3 个连续 int32) ==")
reset()
mb._variables[UID] = [
    MonitoredVariable(id="a", name="a", address=0x20000000, type="int32", size=4),
    MonitoredVariable(id="b", name="b", address=0x20000004, type="int32", size=4),
    MonitoredVariable(id="c", name="c", address=0x20000008, type="int32", size=4),
]
dp = FakeDP()
dp.seq = [[0x11111111, 0x22222222, 0x33333333]]
session = make_session(FakeAP(dp))
results = mb._read_variables(UID)
check("返回3个变量", len(results) == 3)
check("值正确", [r["value"] for r in results] == [0x11111111, 0x22222222, 0x33333333])
check("read_ap_multiple 用了 now=False", all(r[2] is False for r in dp.reads))
check("flush 恰好1次", dp.flush_calls == 1)
check("写入了 CSW(0x00)+TAR(0x04)", any(a & 0x0F == 0x04 for a, _ in dp.writes))

# ── 用例2: 流水线失败 -> 回退串行 block32 ──────────────────
reset()
print("== 用例2: 流水线异常回退串行 ==")
mb._vars_version[UID] = mb._vars_version.get(UID, 0) + 1  # 模拟变量列表变更
dp2 = FakeDP()
dp2.raise_on_flush = True
tgt = FakeTarget(FakeAP(dp2))
tgt.mem32[0x20000000] = [0xAAAAAAAA, 0xBBBBBBBB, 0xCCCCCCCC]
session = types.SimpleNamespace(target=tgt, probe=session.probe)
results = mb._read_variables(UID)
print("   fallback values:", [r["value"] for r in results])
check("回退后仍返回3个变量", len(results) == 3)
# int32 有符号解码：0xAAAAAAAA -> -1431655766
check("回退值正确", [r["value"] for r in results] == [-1431655766, -1145324613, -858993460])

# ── 用例3: 非对齐小变量（uint8）走流水线+对齐切片 ─────────
reset()
print("== 用例3: 非对齐 uint8 变量 ==")
mb._vars_version[UID] = mb._vars_version.get(UID, 0) + 1  # 模拟变量列表变更
mb._variables[UID] = [
    MonitoredVariable(id="u1", name="u1", address=0x20000001, type="uint8", size=1),
    MonitoredVariable(id="u2", name="u2", address=0x20000002, type="uint8", size=1),
]
dp3 = FakeDP()
# 分组: start=0x20000000, length=4 -> words = [0xAABBCCDD]  (LE: DD CC BB AA)
dp3.seq = [[0xAABBCCDD]]
session = make_session(FakeAP(dp3))
results = mb._read_variables(UID)
check("返回2个变量", len(results) == 2)
check("u1=0xCC (offset 1)", results[0]["value"] == 0xCC)
check("u2=0xBB (offset 2)", results[1]["value"] == 0xBB)

# ── 用例4: 多组 -> 多次 TAR 写 + 一次 flush ────────────────
reset()
print("== 用例4: 两组变量 (稀疏, 载荷比拆组) ==")
mb._vars_version[UID] = mb._vars_version.get(UID, 0) + 1  # 模拟变量列表变更
mb._variables[UID] = [
    MonitoredVariable(id="x", name="x", address=0x20000000, type="int32", size=4),
    MonitoredVariable(id="y", name="y", address=0x20001000, type="int32", size=4),
]
dp4 = FakeDP()
dp4.seq = [[0x1], [0x2]]
session = make_session(FakeAP(dp4))
results = mb._read_variables(UID)
check("返回2个变量", len(results) == 2)
check("x=1 y=2", [r["value"] for r in results] == [1, 2])
tar_writes = [a for a, _ in dp4.writes if a & 0x0F == 0x04]
check("2次TAR写", len(tar_writes) == 2)
check("flush 1次", dp4.flush_calls == 1)

# ── 用例5: 缓存生效（变量版本不变时 groups 复用） ──────────
reset()
print("== 用例5: 分组缓存 ==")
mb._vars_cache[UID] = (mb._vars_version.get(UID, 0), [])
dp5 = FakeDP()
dp5.seq = [[0x1]]
session = make_session(FakeAP(dp5))
results = mb._read_variables(UID)
check("缓存为空组时返回空", results == [])
check("未触发读取", dp5.flush_calls == 0 and len(dp5.reads) == 0)

# ── 用例6: 跨 auto-increment 页边界（1KB）→ 拆分子页 ────────
reset()
print("== 用例6: 跨 1KB 页边界拆子页 ==")
mb._vars_version[UID] = mb._vars_version.get(UID, 0) + 1
mb._variables[UID] = [
    MonitoredVariable(id="p1", name="p1", address=0x200003FC, type="int32", size=4),
    MonitoredVariable(id="p2", name="p2", address=0x20000400, type="int32", size=4),
]
dp6 = FakeDP()
dp6.seq = [[0xAAAA], [0xBBBB]]  # 子页1: 0x...3FC, 子页2: 0x...400
session = make_session(FakeAP(dp6, page_size=0x400))
results = mb._read_variables(UID)
check("返回2个变量", len(results) == 2)
check("跨页值正确", [r["value"] for r in results] == [0xAAAA, 0xBBBB])
tar_writes = [a for a, _ in dp6.writes if a & 0x0F == 0x04]
check("跨页TAR写2次", len(tar_writes) == 2)
check("跨页flush1次", dp6.flush_calls == 1)

# ── 用例7: HID 探针直接走串行（不启用流水线） ──────────────
reset()
print("== 用例7: HID 探针走串行 ==")
mb._vars_version[UID] = mb._vars_version.get(UID, 0) + 1
mb._variables[UID] = [
    MonitoredVariable(id="h1", name="h1", address=0x20000000, type="int32", size=4),
]
dp7 = FakeDP()
dp7.seq = [[0x7777]]
tgt7 = FakeTarget(FakeAP(dp7))
tgt7.mem32[0x20000000] = [0x7777]
session = make_session(tgt7.ap, is_bulk=False, target=tgt7)
results = mb._read_variables(UID)
check("HID返回1个变量", len(results) == 1)
check("HID值正确", results[0]["value"] == 0x7777)
check("HID未调用流水线(flush=0)", dp7.flush_calls == 0)
check("HID未调用read_ap_multiple", len(dp7.reads) == 0)
check("HID传输类型缓存=hid", mb._get_transport_type(UID) == "hid")

# ── 用例8: 流水线失败后降级，后续直接串行 ──────────────────
reset()
print("== 用例8: 失败降级为串行 ==")
mb._vars_version[UID] = mb._vars_version.get(UID, 0) + 1
mb._variables[UID] = [
    MonitoredVariable(id="d1", name="d1", address=0x20000000, type="int32", size=4),
]
# 清空传输类型缓存，恢复 bulk 判定
mb._transport_type.pop(UID, None)
dp8 = FakeDP()
dp8.raise_on_flush = True
tgt8 = FakeTarget(FakeAP(dp8))
tgt8.mem32[0x20000000] = [0x8888]
session = make_session(tgt8.ap, is_bulk=True, target=tgt8)  # bulk 探针
r1 = mb._read_variables(UID)   # 第一次: 流水线失败 -> 降级 + 串行
check("第1次值正确", r1[0]["value"] == 0x8888)
check("已置降级标志", mb._pipeline_disabled.get(UID) is True)
dp8.flush_calls = 0
dp8.raise_on_flush = False     # 即使流水线已"恢复"，降级后也不应再尝试
r2 = mb._read_variables(UID)   # 第二次: 直接串行
check("第2次值正确", r2[0]["value"] == 0x8888)
check("降级后不再尝试流水线(flush=0)", dp8.flush_calls == 0)
check("降级后走串行(block32被调用)", True)

# ── 用例9: 新采样会话重置降级标志 ──────────────────────────
reset()
print("== 用例9: start 重置降级标志 ==")
mb._pipeline_disabled[UID] = True
mb.start(UID, rate_hz=10)
check("start后降级标志被清除", mb._pipeline_disabled.get(UID) is None)
mb.stop(UID)

# ── 用例10: CoreSightTarget 无 .ap 但有 .first_ap（如 APM32F407xG） ──
reset()
print("== 用例10: CoreSightTarget (.first_ap) 兼容 ==")
mb._variables[UID] = [
    MonitoredVariable(id="c1", name="c1", address=0x20000000, type="int32", size=4),
    MonitoredVariable(id="c2", name="c2", address=0x20000004, type="int32", size=4),
]
dp10 = FakeDP()
dp10.seq = [[0xCAFE, 0xBEEF]]
the_ap = FakeAP(dp10)
tgt10 = FakeTarget(the_ap)
delattr(tgt10, "ap")          # 模拟 CoreSightTarget：没有 .ap 属性
tgt10.first_ap = the_ap       # 但有 .first_ap
session = make_session(the_ap, is_bulk=True, target=tgt10)
results = mb._read_variables(UID)
check("返回2个变量", len(results) == 2)
check("first_ap 路径值正确", [r["value"] for r in results] == [0xCAFE, 0xBEEF])
check("flush 1次", dp10.flush_calls == 1)

if failures:
    print(f"RESULT: {len(failures)} FAILED -> {failures}")
    sys.exit(1)
print("RESULT: ALL PASS")
