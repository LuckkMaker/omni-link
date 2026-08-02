"""monitor_backend._build_read_groups 算法离线单测（无硬件依赖）

运行: python test_read_groups.py
"""
import sys
import types

# ── mock 掉依赖，只测纯算法 ──────────────────────────────
fake_backend = types.ModuleType("core.pyocd_backend")
fake_backend.backend = object()
fake_events = types.ModuleType("core.events")
fake_events.event_manager = object()
sys.modules["core.pyocd_backend"] = fake_backend
sys.modules["core.events"] = fake_events

import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core.monitor_backend import MonitorBackend, MonitoredVariable


def var(addr: int, size: int = 4, typ: str = "int32"):
    return MonitoredVariable(id=f"v{addr:x}", name=f"v{addr:x}", address=addr, type=typ, size=size)


def group_repr(groups):
    return [(g["start"], g["length"], [v.address for v in g["vars"]]) for g in groups]


mb = MonitorBackend()
failures = []

def check(name, cond):
    if cond:
        print(f"  PASS  {name}")
    else:
        failures.append(name)
        print(f"  FAIL  {name}")


print("== 密集相邻变量应合并为一组 ==")
groups = mb._build_read_groups([var(0x20000000), var(0x20000004), var(0x20000008)], 2048)
r = group_repr(groups)
print(" ", r)
check("密集3变量=1组", len(groups) == 1)
check("组覆盖[0x20000000,12]", r[0] == (0x20000000, 12, [0x20000000, 0x20000004, 0x20000008]))

print("== 稀疏变量因载荷比过低应拆组 ==")
groups = mb._build_read_groups([var(0x20000000), var(0x20001000)], 2048)
r = group_repr(groups)
print(" ", r)
check("gap4096拆为2组", len(groups) == 2)

print("== 中等gap但载荷比够应合并 ==")
groups = mb._build_read_groups([var(0x20000000), var(0x20000010)], 2048)
r = group_repr(groups)
print(" ", r)
check("gap16合并为1组", len(groups) == 1)

print("== 小变量不对齐时 start/length 对齐4 ==")
groups = mb._build_read_groups([var(0x20000001, 1, "uint8"), var(0x20000002, 1, "uint8")], 2048)
r = group_repr(groups)
print(" ", r)
check("对齐start=0x20000000", r[0][0] == 0x20000000)
check("对齐length=4", r[0][1] == 4)

print("== max_bytes 限制拆组（连续变量总字节超限） ==")
many = [var(0x20000000 + i * 4) for i in range(300)]  # 300*4=1200B > 1024
groups = mb._build_read_groups(many, 1024)
r = group_repr(groups)
print(" ", f"{len(groups)} 组, 首组长度={r[0][1]}, 次组长度={r[1][1]}")
check("max_bytes=1024拆为2组", len(groups) == 2)
check("首组长度<=1024", r[0][1] <= 1024)
check("次组长度<=1024", r[1][1] <= 1024)
check("总变量数=300", sum(len(g[2]) for g in r) == 300)

print("== 稀疏大gap按载荷比拆（gap=1024 冗余过大） ==")
groups = mb._build_read_groups([var(0x20000000), var(0x20000400)], 2048)
r = group_repr(groups)
print(" ", r)
check("gap1024拆为2组(载荷比保护)", len(groups) == 2)

print("== 64KB gap 内仍按载荷比合并（gap=0x8000 载荷比0.5） ==")
groups = mb._build_read_groups([var(0x20000000), var(0x20008000), var(0x20008004)], 2048)
r = group_repr(groups)
print(" ", r)
check("gap32768密集端合并", len(groups) == 2)
check("密集端同组", r[1][2] == [0x20008000, 0x20008004])

print("== 空输入 ==")
groups = mb._build_read_groups([], 2048)
check("空列表返回空", groups == [])

print()
if failures:
    print(f"RESULT: {len(failures)} FAILED -> {failures}")
    sys.exit(1)
print("RESULT: ALL PASS")
