"""monitor_backend 落盘集成测试：export_csv/read_record 从磁盘读，不受 RingBuffer 上限限制"""
import os
import shutil
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# mock core 依赖
fake_backend = types.ModuleType("core.pyocd_backend")
fake_backend.backend = types.SimpleNamespace(_get_session=lambda uid: None, is_connected=lambda uid: True)
fake_events = types.ModuleType("core.events")
fake_events.event_manager = types.SimpleNamespace(log=lambda *a, **k: None, emit=lambda *a, **k: None)
sys.modules["core.pyocd_backend"] = fake_backend
sys.modules["core.events"] = fake_events

from core.monitor_backend import MonitorBackend, MonitoredVariable, RingBuffer

failures = []


def check(name, cond):
    status = "PASS" if cond else "FAIL"
    if not cond:
        failures.append(name)
    print(f"  {status}  {name}")


# 用临时目录作为落盘目录
tmp = tempfile.mkdtemp(prefix="omni_mb_")
import core.monitor_backend as mb_mod
mb_mod.SESSION_DIR = tmp

mb = MonitorBackend()
uid = "probe-1"

try:
    # ── 用例1: 落盘导出不受 RingBuffer 上限限制 ────────────
    print("== 用例1: export_csv 从落盘读（RingBuffer 仅 10 点，落盘 100 点） ==")
    mb._variables[uid] = [MonitoredVariable(id="a", name="var", address=0x20000000, type="int32", size=4)]
    mb._ring_buffers[uid] = RingBuffer(10)      # 故意缩小 RingBuffer
    mb._start_wall[uid] = 1754100000.0
    rec = mb._recorders.get(uid)
    if rec is None:
        from core.session_recorder import SessionRecorder
        rec = SessionRecorder(tmp, uid)
        mb._recorders[uid] = rec
    rec.open_session(mb._variables[uid])
    for i in range(100):
        rec.append(float(i * 10), {"a": i})
    rec.close()
    r = mb.export_csv(uid, mode="all")
    check("导出 100 点（>RingBuffer 10 点）", r["success"] and r["count"] == 100)
    lines = r["csv"].split("\n")
    check("表头含 time 列", lines[0].startswith("t_ms,time,var"))
    check("首行 t_ms=0", lines[1].startswith("0.000"))

    # ── 用例2: recent 模式从落盘推算 ──────────────────────
    print("== 用例2: export_csv recent 从落盘推算 ==")
    r = mb.export_csv(uid, mode="recent", recent_seconds=0.5)
    # 最新 t=990ms，0.5s=500ms -> t>=490 -> 51 点（t=490..990 步长10）
    check("recent 0.5s 导出 51 点", r["count"] == 51)
    check("recent 起点正确", r["csv"].split("\n")[1].startswith("490."))

    # ── 用例3: read_record 范围读取 ───────────────────────
    print("== 用例3: read_record 范围读取 ==")
    rr = mb.read_record(uid, start_ms=200, end_ms=500)
    check("read_record 成功", rr["success"])
    total = sum(len(s["samples"]) for s in rr["segments"])
    check("范围点数 (t=200..500 步长10 = 31 点)", total == 31)
    check("vars 元信息", rr["segments"][0]["vars"][0]["name"] == "var")
    check("样本值", rr["segments"][0]["samples"][0]["values"]["a"] == 20)

    # ── 用例4: 无落盘时回退 RingBuffer ────────────────────
    print("== 用例4: 无落盘回退 RingBuffer ==")
    mb2 = MonitorBackend()
    mb2._variables[uid] = [MonitoredVariable(id="a", name="var", address=0x20000000, type="int32", size=4)]
    rb = RingBuffer(5)
    mb2._ring_buffers[uid] = rb
    mb2._start_wall[uid] = 1754100000.0
    for i in range(5):
        rb.push(float(i), {"a": i})
    r2 = mb2.export_csv(uid)
    check("回退 RingBuffer 导出 5 点", r2["success"] and r2["count"] == 5)

finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
if failures:
    print(f"RESULT: {len(failures)} FAILED -> {failures}")
    sys.exit(1)
print("RESULT: ALL PASS")
