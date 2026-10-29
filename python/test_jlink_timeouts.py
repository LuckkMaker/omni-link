"""J-Link 卡死防护离线回归测试（无需硬件）。

对应实机问题："多次连接/断开 J-Link 后残留，再也连不上 / 整个应用没响应"。
根因是原生 DLL/USB 调用无法取消，超时线程被遗弃后长期持锁，新请求继续排队。

覆盖：

1. ``JLINK_DLL_LOCK`` 等待有上限：卡死时抛 ``JLinkDllBusy``，冷却期内立即失败，
   不会无限排队；
2. ``PyOCDBackend.connect`` 的"同一探针只允许一个连接尝试"闸门：上一次未返回时
   快速失败并给出可执行提示，而不是再制造一个卡死线程；TTL 之后允许重试。

用法::

    cd python
    ..\\.venv\\Scripts\\python.exe test_jlink_timeouts.py
"""

import os
import sys
import threading
import time

PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PY_DIR)

import core.jlink_lock as jl  # noqa: E402
from core.pyocd_backend import PyOCDBackend, ProbeState  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}" + (f"  ({detail})" if detail else ""))
        failures.append(name)


def test_dll_lock_timeout():
    print("[1] J-Link DLL 锁等待上限 + 卡死冷却")
    locked = threading.Event()
    release = threading.Event()

    def holder():
        jl.JLINK_DLL_LOCK.acquire()
        locked.set()
        release.wait(30)
        jl.JLINK_DLL_LOCK.release()

    t = threading.Thread(target=holder, daemon=True)
    t.start()
    check("测试线程已持锁", locked.wait(2))

    t0 = time.monotonic()
    raised = False
    try:
        jl.acquire_dll_lock(timeout=0.2)
    except jl.JLinkDllBusy:
        raised = True
    dt = time.monotonic() - t0
    check("超时抛 JLinkDllBusy", raised, "未抛异常")
    check("等待时长受限（0.2~1.5s）", 0.15 <= dt < 1.5, f"{dt:.3f}s")

    t1 = time.monotonic()
    raised = False
    try:
        jl.acquire_dll_lock(timeout=1.0)
    except jl.JLinkDllBusy:
        raised = True
    dt2 = time.monotonic() - t1
    check("冷却期内立即失败", raised and dt2 < 0.1, f"{dt2:.3f}s")

    release.set()
    t.join(2)
    jl.reset_dll_stuck_state()
    # 冷却清除后可以正常拿锁
    try:
        jl.acquire_dll_lock(timeout=1.0)
        jl.release_dll_lock()
        check("重置后可正常加锁", True)
    except jl.JLinkDllBusy as exc:
        check("重置后可正常加锁", False, str(exc))


def test_connect_gate():
    print("[2] 同一探针的连接尝试不叠加")
    backend = PyOCDBackend()
    backend._connect_inflight["uid1"] = time.monotonic()
    t0 = time.monotonic()
    ok = backend.connect("uid1", target="stm32f407xg")
    dt = time.monotonic() - t0
    check("重复连接被拒绝", ok is False, str(ok))
    check("快速返回（< 0.5s）", dt < 0.5, f"{dt:.3f}s")
    info = backend._sessions.get("uid1")
    check("会话标记 ERROR", info is not None and info.state == ProbeState.ERROR,
          str(info.state if info else None))
    check("错误信息给出恢复方式",
          info is not None and "重启" in (info.error or ""), str(info.error if info else ""))

    print("[3] 超过 TTL 后允许重试，且成功后清除标记")
    backend2 = PyOCDBackend()
    backend2._connect_inflight["uid2"] = time.monotonic() - 10_000
    backend2._connect_impl = lambda *a, **k: True  # 不触碰硬件
    ok = backend2.connect("uid2", target="stm32f407xg")
    check("TTL 后重试成功", ok is True, str(ok))
    check("成功后清除进行中标记", "uid2" not in backend2._connect_inflight)


def test_callback_hub():
    print("[4] pylink 全局回调 hub（修复 0xc000001d / DLL 永久损坏）")
    from core.jlink_lock import install_pylink_lock

    check("install_pylink_lock 成功", install_pylink_lock() is True)

    try:
        import gc
        import pylink
        from pylink import enums
    except Exception as exc:  # noqa: BLE001 - 无 pylink/无 DLL 的环境跳过
        print(f"  SKIP  pylink 不可用: {exc}")
        return

    hub = enums.JLinkFunctions.LOG_PROTOTYPE
    check("LOG_PROTOTYPE 已替换为保持存活的 hub", hasattr(hub, "_callback"), str(type(hub)))
    try:
        a = pylink.JLink()
        b = pylink.JLink()
    except Exception as exc:  # noqa: BLE001
        print(f"  SKIP  无法构造 JLink（无 DLL）: {exc}")
        return
    check("不同实例共用同一 trampoline",
          a._log_handler is b._log_handler is hub._callback,
          "回调仍按实例创建，存在悬垂指针风险")
    bridged = hub._callback
    del a, b
    gc.collect()
    try:
        bridged(b"callback after gc")
        ok = True
    except Exception:  # noqa: BLE001
        ok = False
    check("实例回收后回调仍可安全调用", ok)


def main():
    test_dll_lock_timeout()
    test_connect_gate()
    test_callback_hub()
    print()
    if failures:
        print(f"FAILED: {len(failures)} 项 -> {failures}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
