"""「清除全部断点」必须把断点从目标上真正摘掉（pyOCD BreakpointManager 回归测试）。

``BreakpointManager.flush()`` 用两个字典的差集决定增删：``_updated_breakpoints``
（期望集合）减 ``_breakpoints``（已下发集合）就是「要新增」的断点。
``remove_all_breakpoints()`` 之前只清了 ``_breakpoints``，没清 ``_updated_breakpoints``，
于是紧接着的 ``flush()``（以及每次 run/reset 触发的 PRE_RUN flush）会把刚清掉的断点
当成「新增」重新装回目标 —— 现象就是：列表清空了，FPB 比较器仍挂着旧地址，复位后
照样停在被删掉的断点上。

用法::

    cd python
    python test_breakpoint_manager.py
"""

from __future__ import annotations

import os
import sys

PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PY_DIR)

from pyocd.core.target import Target
from pyocd.debug.breakpoints.manager import BreakpointManager
from pyocd.debug.breakpoints.provider import Breakpoint

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(name)
        print(f"FAIL {name} {detail}")


class _Session:
    """BreakpointManager 只在构造时订阅事件，测试里全部忽略。"""

    def subscribe(self, *args, **kwargs) -> None:
        pass


class _Region:
    is_writable = False


class _MemoryMap:
    """_select_breakpoint_type() 只需要判断地址落在哪个 region。"""

    def get_region_for_address(self, addr: int):
        return _Region()


class _Core:
    def __init__(self) -> None:
        self.session = _Session()
        self.memory_map = _MemoryMap()


class _RecordingProvider:
    """记录下发/摘除调用的假硬件断点提供者（代替 FPB）。"""

    bp_type = Target.BreakpointType.HW

    def __init__(self) -> None:
        self.added: list[int] = []
        self.removed: list[int] = []
        self.available_breakpoints = 4

    def can_support_address(self, addr: int) -> bool:
        return True

    def set_breakpoint(self, addr: int):
        bp = Breakpoint(self)
        bp.addr = addr
        bp.enabled = True
        self.added.append(addr)
        return bp

    def remove_breakpoint(self, bp) -> None:
        self.removed.append(bp.addr)

    def flush(self) -> None:
        pass


def _manager_with_breakpoint(addr: int = 0x08001070):
    """构造「已下发一个硬件断点」的管理器状态。"""
    manager = BreakpointManager(_Core())
    provider = _RecordingProvider()
    manager._providers[Target.BreakpointType.HW] = provider
    manager._fpb = provider
    bp = provider.set_breakpoint(addr)
    manager._breakpoints = {addr: bp}
    manager._updated_breakpoints = {addr: bp}
    return manager, provider, addr


def test_provider_is_cleared() -> None:
    manager, provider, addr = _manager_with_breakpoint()
    manager.remove_all_breakpoints()

    check("clear.provider-removed", provider.removed == [addr], provider.removed)
    check("clear.live-map-empty", manager._breakpoints == {}, manager._breakpoints)
    check("clear.expected-map-empty", manager._updated_breakpoints == {},
          manager._updated_breakpoints)


def test_not_resurrected_by_next_flush() -> None:
    manager, provider, _addr = _manager_with_breakpoint()
    manager.remove_all_breakpoints()

    # 修复点：清空之后，差集里不应再有「待新增」的断点。
    added, removed = manager._get_updated_breakpoints()
    check("clear.no-pending-add", added == [], [bp.addr for bp in added])
    check("clear.no-pending-remove", removed == [], [bp.addr for bp in removed])

    # 再来一次 flush（zone 的清除接口和每次 run/reset 都会触发）也不能重新下发。
    before = list(provider.added)
    manager.flush()
    check("clear.flush-no-readd", provider.added == before, provider.added)


def test_single_remove_still_works() -> None:
    """单条摘除走的是另一条路径，确认没有被改坏。"""
    manager, provider, addr = _manager_with_breakpoint()
    manager.remove_breakpoint(addr)
    manager.flush()

    check("single.removed", provider.removed == [addr], provider.removed)
    check("single.live-map-empty", manager._breakpoints == {}, manager._breakpoints)


def main() -> int:
    test_provider_is_cleared()
    test_not_resurrected_by_next_flush()
    test_single_remove_still_works()

    if failures:
        print(f"{len(failures)} breakpoint manager test(s) failed: {', '.join(failures)}")
        return 1
    print("all breakpoint manager tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
