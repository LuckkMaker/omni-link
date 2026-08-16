"""软断点命中处理 + execute 只读命令白名单

log / execute / 条件不满足的断点命中时，FPB 硬件断点会让目标 halt。若不做处理，目标
停在断点指令处，再次 resume 会立刻再次命中，形成死循环。本模块在目标 HALTED 时：

    1. 读 PC，匹配应用层断点表（zone.py 的 _BREAKPOINTS[uid]）中 address==PC 且 enabled 的断点
    2. 判定是否需要"真正中断"：
       - mode=break 且（无 condition 或 condition 求值为 true）→ 真正暂停，交给用户，不干预
       - 否则 → 软跳过：卸 FPB → 执行动作(log/execute) → step → 重装 FPB → resume
    3. 软跳过时发出事件标记 zone.breakpoint.skip，并落一条 zone 日志

execute 模式执行多条只读调试命令（condition 字段内以换行分隔），在 zone 当前 core 上
直接执行，不经 commander session、不切换内核、不重新连接，确保不破坏当前调试会话。
命令首 token 必须命中只读白名单，否则拒绝该行并输出警告。

线程模型：pyOCD 的 HALTED 事件回调运行在调试序列线程，**不能在其中做调试操作**
（step/resume 会嵌套序列，有死锁风险）。因此回调只记录状态并置一个 threading.Event，
由独立 watcher 线程执行软跳过序列，并用 threading.Lock 串行化；用户显式执行
halt/step/run/reset 时置抑制标志跳过处理。
"""

from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

from core.events import event_manager
from core.expr_eval import eval_condition, eval_log

logger = logging.getLogger(__name__)

# 软跳过原因（事件标记 reason 字段取值）
REASON_LOG = "log"
REASON_EXECUTE = "execute"
REASON_CONDITION_FALSE = "condition_false"

# execute 命令白名单：仅纯只读、无任何状态副作用
# 首 token 命中才执行，否则拒绝该行并输出警告。
EXECUTE_READONLY_COMMANDS: set[str] = {
    # 读寄存器
    "reg", "rr",
    # 读内存
    "read8", "read16", "read32", "read64", "rb", "rh", "rw", "rd",
    # 反汇编
    "disasm", "d",
    # 符号/源码定位（依赖 ELF，尽力而为）
    "where", "symbol",
    # 状态
    "status", "st",
}

# 明确禁止的破坏性命令（命中时拒绝并警告，不改动目标状态）
_BLOCKED_COMMANDS: set[str] = {
    "write8", "write16", "write64", "wb", "wh", "ww", "wd", "wreg", "set",
    "fill", "load", "erase", "save",
    "step", "halt", "reset", "continue", "go",
    "break", "remove", "watch",
    "script", "exec", "eval", "run", "list", "core", "gdbserver", "probeserver",
    "unlock", "reinit", "initdp", "flushprobe", "makeap", "sleep",
}

# 寄存器名（小写）→ pyOCD 寄存器名
_REG_ALIAS = {
    "r0": "r0", "r1": "r1", "r2": "r2", "r3": "r3", "r4": "r4", "r5": "r5",
    "r6": "r6", "r7": "r7", "r8": "r8", "r9": "r9", "r10": "r10", "r11": "r11",
    "r12": "r12", "sp": "sp", "lr": "lr", "pc": "pc", "xpsr": "xpsr",
    "apsr": "apsr", "primask": "primask", "basepri": "basepri",
    "faultmask": "faultmask", "control": "control",
}


def _fmt_addr(v: int) -> str:
    return f"0x{v:08x}"


def _readonly_regs(core, names: list[str]) -> list[str]:
    """读一组寄存器，返回 ["name=value" ...]"""
    rows: list[str] = []
    regs = names or ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7",
                     "r8", "r9", "r10", "r11", "r12", "sp", "lr", "pc"]
    for name in regs:
        key = name.lower()
        if key not in _REG_ALIAS:
            rows.append(f"{name}: <unknown reg>")
            continue
        try:
            val = int(core.read_core_register(_REG_ALIAS[key]))
            if key == "pc":
                val &= ~1
            rows.append(f"{name}=0x{val:x}")
        except Exception as e:
            rows.append(f"{name}: <err {e}>")
    return rows


def _readonly_mem(core, size: int, addr: int, count: int) -> list[str]:
    """读内存 size 字节宽度，count 个单元，返回 ["addr: hexbytes" ...]"""
    rows: list[str] = []
    try:
        for i in range(count):
            a = addr + i * size
            raw = core.read_memory(a, size)
            if isinstance(raw, (bytes, bytearray)):
                rows.append(f"{_fmt_addr(a)}: {raw.hex(' ')}")
            else:
                rows.append(f"{_fmt_addr(a)}: 0x{int(raw):x}")
    except Exception as e:
        rows.append(f"<read mem {_fmt_addr(addr)} err {e}>")
    return rows


def _run_readonly(core, target, uid: str, cmd: str, args: list[str]) -> list[str]:
    """在 zone 当前 core 上执行一条只读命令，返回输出行（不抛异常）。"""
    if cmd in ("reg", "rr"):
        return _readonly_regs(core, args)
    if cmd in ("read8", "rb"):
        return _readonly_mem(core, 1, int(args[0], 0) if args else 0, 1)
    if cmd in ("read16", "rh"):
        return _readonly_mem(core, 2, int(args[0], 0) if args else 0, 1)
    if cmd in ("read32",):
        return _readonly_mem(core, 4, int(args[0], 0) if args else 0, 1)
    if cmd in ("read64", "rd"):
        return _readonly_mem(core, 8, int(args[0], 0) if args else 0, 1)
    if cmd in ("rw",):
        return _readonly_mem(core, 4, int(args[0], 0) if args else 0, 1)
    if cmd in ("status", "st"):
        try:
            halted = core.is_halted()
            pc = int(core.read_core_register("pc")) & ~1 if halted else None
            state = "halted" if halted else "running"
            return [f"state: {state}", f"pc: {_fmt_addr(pc)}" if pc is not None else "pc: -"]
        except Exception as e:
            return [f"<status err {e}>"]
    if cmd in ("disasm", "d"):
        addr = int(args[0], 0) if args else None
        count = int(args[1], 0) if len(args) > 1 else 8
        if addr is None:
            addr = (int(core.read_core_register("pc")) & ~1) if core.is_halted() else 0
        try:
            dis = target.disassemble_dumb(addr, count)
            return [f"{_fmt_addr(i.address)}: {i.mnemonic} {i.op_str}".rstrip() for i in dis]
        except Exception as e:
            return [f"<disasm err {e}>"]
    if cmd in ("where", "symbol"):
        # 依赖 ELF：where 解析当前 PC 所在符号；symbol NAME 解析名字
        from core.elf_backend import elf_backend
        rows: list[str] = []
        try:
            if cmd == "where":
                pc = (int(core.read_core_register("pc")) & ~1) if core.is_halted() else None
                if pc is None:
                    return ["pc: -"]
                sym = elf_backend.get_symbol_for_address(uid, pc)
                if sym:
                    rows.append(f"pc={_fmt_addr(pc)} {sym['name']}")
                else:
                    rows.append(f"pc={_fmt_addr(pc)}")
            else:
                name = args[0] if args else ""
                info = elf_backend.resolve_symbol(uid, name)
                if info:
                    rows.append(f"{name} {_fmt_addr(info.get('address', 0))} "
                                f"type={info.get('type', '')}")
                else:
                    rows.append(f"<symbol not found: {name}>")
        except Exception as e:
            rows.append(f"<symbol err {e}>")
        return rows
    return [f"<unsupported readonly cmd: {cmd}>"]


class SoftBreakpointHandler:
    """单个调试会话的软断点命中处理器。

    参数：
        uid      探针 id
        target   pyOCD session.target（用于订阅 HALTED 事件 / 反汇编）
        core     session.target.selected_core_or_raise（调试操作）
        get_bps  () -> dict[address, bp]  应用层断点表读取器
    """

    def __init__(self, uid: str, target, core, get_bps: Callable[[], dict]):
        self.uid = uid
        self.target = target
        self.core = core
        self._get_bps = get_bps
        self._lock = threading.Lock()
        self._event = threading.Event()
        self._stop = threading.Event()
        self._suppressed = False
        self._thread: Optional[threading.Thread] = None
        self._unsub: Optional[Callable[[], None]] = None

    # ── 生命周期 ──────────────────────────
    def install(self):
        """订阅 HALTED 事件并启动 watcher 线程。"""
        try:
            from pyocd.core.target import TargetEvent
            if hasattr(self.target, "subscribe"):
                self._unsub = self.target.subscribe(TargetEvent.HALTED, self._on_halted)
        except Exception as e:
            logger.warning("[soft_bp] HALTED 订阅失败（软断点跳过不可用）: %s", e)
            return
        self._thread = threading.Thread(target=self._watch, name=f"soft-bp-{self.uid}", daemon=True)
        self._thread.start()

    def uninstall(self):
        """停止 watcher 线程并取消订阅。"""
        self._stop.set()
        self._event.set()
        if self._unsub:
            try:
                self._unsub()
            except Exception:
                pass

    def suppress(self):
        """用户显式执行 halt/step/run/reset 时抑制软跳过处理。"""
        self._suppressed = True
        self._event.clear()

    def unsuppress(self):
        self._suppressed = False

    # ── HALTED 回调（pyOCD 调试序列线程，只置事件，不做调试操作）──
    def _on_halted(self, *args):
        if self._suppressed or self._stop.is_set():
            return
        self._event.set()

    # ── watcher 线程 ──────────────────────
    def _watch(self):
        while not self._stop.is_set():
            if not self._event.wait(timeout=0.2):
                continue
            self._event.clear()
            if self._stop.is_set() or self._suppressed:
                continue
            try:
                with self._lock:
                    self._handle()
            except Exception:
                logger.exception("[soft_bp] 软跳过处理异常")

    def _handle(self):
        try:
            if not self.core.is_halted():
                return
            pc = (int(self.core.read_core_register("pc")) & ~1)
        except Exception:
            return
        bp = self._get_bps().get(pc)
        if not bp or not bp.get("enabled", True):
            return
        mode = bp.get("mode", "break")
        cond = bp.get("condition")
        if mode == "break":
            if cond and cond.strip():
                try:
                    if not eval_condition(self.core, cond):
                        self._soft_skip(bp, REASON_CONDITION_FALSE)
                except Exception:
                    # 条件求值出错 → 保守：真正中断，交给用户
                    pass
            # 无条件或条件为真 → 真正中断，不干预
        elif mode == "log":
            self._soft_skip(bp, REASON_LOG)
        elif mode == "execute":
            self._soft_skip(bp, REASON_EXECUTE)

    def _soft_skip(self, bp: dict, reason: str):
        address = int(bp["address"])
        file = bp.get("file", "")
        line = bp.get("line", 0)
        mode = bp.get("mode", "break")
        try:
            # ① 卸下 FPB
            self.core.remove_breakpoint(address)
            try:
                self.core.bp_manager.flush()
            except Exception:
                pass
            # ② 执行动作（目标仍停在断点指令处）
            if mode == "log":
                self._exec_log(bp)
            elif mode == "execute":
                self._exec_commands(bp.get("condition") or "")
            # ③ 单步跨过断点指令
            self.core.step()
            # ④ 重装 FPB
            self.core.set_breakpoint(address)
            try:
                self.core.bp_manager.flush()
            except Exception:
                pass
            # resume 继续运行
            self.core.resume()
            self._emit_skip(bp, reason)
        except Exception as e:
            logger.exception("[soft_bp] 软跳过程失败: %s", e)
            # 出错时尽力恢复，避免目标卡死在断点处
            try:
                self.core.set_breakpoint(address)
                self.core.bp_manager.flush()
            except Exception:
                pass
            try:
                self.core.resume()
            except Exception:
                pass
            self._emit_skip(bp, reason, error=str(e))

    def _emit_skip(self, bp: dict, reason: str, error: Optional[str] = None):
        data = {
            "uid": self.uid,
            "address": int(bp["address"]),
            "file": bp.get("file", ""),
            "line": bp.get("line", 0),
            "mode": bp.get("mode", "break"),
            "reason": reason,
        }
        if error:
            data["error"] = error
        event_manager.emit("zone.breakpoint.skip", data)
        loc = f"{bp.get('file', '')}:{bp.get('line', 0)}"
        extra = " (条件不满足)" if reason == REASON_CONDITION_FALSE else (
            " (日志点)" if reason == REASON_LOG else " (执行命令)"
        )
        event_manager.log("info", f"Zone Breakpoint skipped: {loc}{extra}")

    def _exec_log(self, bp: dict):
        text = eval_log(self.core, bp.get("condition") or "")
        event_manager.log("info", f"Zone Logpoint @ {bp.get('file','')}:{bp.get('line',0)}: {text}")

    def _exec_commands(self, commands: str):
        for raw in commands.splitlines():
            line = raw.strip()
            if not line:
                continue
            parts = line.split()
            cmd = parts[0].lower()
            args = parts[1:]
            if cmd in _BLOCKED_COMMANDS or cmd not in EXECUTE_READONLY_COMMANDS:
                event_manager.log("warning",
                                  f"Zone Breakpoint execute: 非只读命令已拒绝: {cmd}")
                continue
            try:
                rows = _run_readonly(self.core, self.target, self.uid, cmd, args)
            except Exception as e:
                rows = [f"<{cmd} err {e}>"]
            for row in rows:
                event_manager.log("info", f"Zone Breakpoint execute: {row}")


# ── 会话级注册表 ──────────────────────────
# uid -> SoftBreakpointHandler
_handlers: dict[str, SoftBreakpointHandler] = {}
_handlers_lock = threading.Lock()


def install_handler(uid: str, target, core, get_bps: Callable[[], dict]):
    """为目标会话安装软断点处理器（幂等）。"""
    with _handlers_lock:
        old = _handlers.get(uid)
        if old:
            old.uninstall()
        h = SoftBreakpointHandler(uid, target, core, get_bps)
        _handlers[uid] = h
    h.install()
    return h


def uninstall_handler(uid: str):
    """卸载并停止软断点处理器。"""
    with _handlers_lock:
        h = _handlers.pop(uid, None)
    if h:
        h.uninstall()


def get_handler(uid: str) -> Optional[SoftBreakpointHandler]:
    with _handlers_lock:
        return _handlers.get(uid)


def suppress_handler(uid: str):
    h = get_handler(uid)
    if h:
        h.suppress()


def unsuppress_handler(uid: str):
    h = get_handler(uid)
    if h:
        h.unsuppress()