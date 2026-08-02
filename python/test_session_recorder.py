"""session_recorder 离线单测：写读回一致性、范围过滤、变量轮转、close 后重读、类型边界"""
import os
import shutil
import sys
import tempfile
import types

# 避免依赖 core 包（recorder 无 core 依赖，但保险起见 mock）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.session_recorder import SessionRecorder, _TYPE_SIZE

failures = []


def check(name, cond):
    status = "PASS" if cond else "FAIL"
    if not cond:
        failures.append(name)
    print(f"  {status}  {name}")


class V:
    def __init__(self, id, name, type, address):
        self.id, self.name, self.type, self.address = id, name, type, address


tmp = tempfile.mkdtemp(prefix="omni_rec_")
try:
    # ── 用例1: 写读回一致性（多类型变量） ────────────────
    print("== 用例1: 多类型写读回 ==")
    r = SessionRecorder(tmp, "probe1")
    vars1 = [
        V("a", "s8", "int8", 0x20000000),
        V("b", "u16", "uint16", 0x20000004),
        V("c", "i32", "int32", 0x20000008),
        V("d", "f", "float", 0x2000000C),
        V("e", "u32", "uint32", 0x20000010),
    ]
    r.open_session(vars1)
    r.append(0.0, {"a": -128, "b": 65535, "c": -123456, "d": 3.14159, "e": 0xDEADBEEF})
    r.append(1000.5, {"a": 127, "b": 1, "c": 42, "d": -0.5, "e": 7})
    r.close()
    res = r.read_range()
    check("1个文件", len(res) == 1)
    seg = res[0]
    check("vars 数量正确", len(seg["vars"]) == 5)
    s0, s1 = seg["samples"]
    check("t_ms 正确", abs(s0[0] - 0.0) < 1e-9 and abs(s1[0] - 1000.5) < 1e-9)
    check("int8 值", s0[1]["a"] == -128 and s1[1]["a"] == 127)
    check("uint16 值", s0[1]["b"] == 65535)
    check("int32 值", s0[1]["c"] == -123456)
    check("float 值", abs(s0[1]["d"] - 3.14159) < 1e-4)
    check("uint32 值", s0[1]["e"] == 0xDEADBEEF)

    # ── 用例2: 范围过滤 ────────────────────────────────
    print("== 用例2: 范围过滤 ==")
    r2 = SessionRecorder(tmp, "probe2")
    r2.open_session([V("a", "x", "int32", 0)])
    for i in range(10):
        r2.append(float(i * 100), {"a": i})
    r2.close()
    res2 = r2.read_range(start_ms=200, end_ms=500)
    check("范围点数", len(res2) == 1 and len(res2[0]["samples"]) == 4)
    check("范围起点", res2[0]["samples"][0][1]["a"] == 2)
    check("范围终点", res2[0]["samples"][-1][1]["a"] == 5)
    res2b = r2.read_range(start_ms=0, end_ms=0)
    check("单点范围", len(res2b[0]["samples"]) == 1)
    res2c = r2.read_range(limit=3)
    check("limit 限制", len(res2c[0]["samples"]) == 3)

    # ── 用例3: 变量轮转（sync_variables）跨文件合并 ──────
    print("== 用例3: 变量轮转跨文件合并 ==")
    r3 = SessionRecorder(tmp, "probe3")
    r3.open_session([V("a", "x", "int32", 0)])
    r3.append(0.0, {"a": 1})
    r3.append(1.0, {"a": 2})
    r3.sync_variables([V("a", "x", "int32", 0), V("b", "y", "float", 4)])
    r3.append(2.0, {"a": 3, "b": 1.5})
    r3.append(3.0, {"a": 4, "b": 2.5})
    r3.close()
    res3 = r3.read_range()
    check("2个文件", len(res3) == 2)
    total = sum(len(s["samples"]) for s in res3)
    check("总样本数", total == 4)
    # 文件1 无 b，文件2 有 b
    check("文件1无b", "b" not in res3[0]["samples"][0][1])
    check("文件2有b", abs(res3[1]["samples"][0][1]["b"] - 1.5) < 1e-6)
    # 跨文件范围
    res3b = r3.read_range(start_ms=1.0, end_ms=2.5)
    total_b = sum(len(s["samples"]) for s in res3b)
    check("跨文件范围点数", total_b == 2)

    # ── 用例4: close 后重开（持久化）────────────────────
    print("== 用例4: close 后重读（持久化） ==")
    r4 = SessionRecorder(tmp, "probe4")
    r4.open_session([V("a", "x", "int32", 0)])
    r4.append(0.0, {"a": 99})
    r4.close()
    # 新实例读同一目录
    r4b = SessionRecorder(tmp, "probe4")
    files = [f for f in os.listdir(os.path.join(tmp, "probe4")) if f.endswith(".omniwave")]
    check("文件存在", len(files) >= 1)
    # 手动读文件验证持久化
    from core.session_recorder import SessionRecorder as SR
    v, s = SR._read_file(os.path.join(tmp, "probe4", files[0]))
    check("持久化值", s[0][1]["a"] == 99)

    # ── 用例5: 缺失变量写 0 + 边界值 ────────────────────
    print("== 用例5: 缺失变量写 0 ==")
    r5 = SessionRecorder(tmp, "probe5")
    r5.open_session([V("a", "x", "int8", 0), V("b", "y", "uint8", 1)])
    r5.append(0.0, {"a": 5})   # b 缺失 -> 0
    r5.close()
    res5 = r5.read_range()
    check("缺失写0", res5[0]["samples"][0][1]["b"] == 0)
    check("int8 边界", res5[0]["samples"][0][1]["a"] == 5)

    # ── 用例6: 空会话 / 空数据 ──────────────────────────
    print("== 用例6: 空会话 ==")
    r6 = SessionRecorder(tmp, "probe6")
    r6.open_session([])
    r6.close()
    res6 = r6.read_range()
    check("空会话返回空", res6 == [])

finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
if failures:
    print(f"RESULT: {len(failures)} FAILED -> {failures}")
    sys.exit(1)
print("RESULT: ALL PASS")
