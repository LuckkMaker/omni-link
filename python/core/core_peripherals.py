"""Core Peripheral controller (Zone panel "Core Peripherals" data source)

Phase 1 implements NVIC only, in Keil style: one row per interrupt source,
listing Enable / Pending / Active / Priority, with Enable and Pending writable.

Interrupt source names are aggregated from each vendor SVD <interrupt> entry
when available, otherwise fall back to generic "IRQn" names.
"""

import logging
import struct
import threading

logger = logging.getLogger(__name__)

NVIC_BASE = 0xE000E100
_NVIC_ISER = 0x000
_NVIC_ICER = 0x080
_NVIC_ISPR = 0x100
_NVIC_ICPR = 0x180
_NVIC_IABR = 0x200
_NVIC_IPR = 0x300

DEFAULT_NVIC_COUNT = 32


def _get_session(uid):
    from core.pyocd_backend import backend
    if not backend.is_connected(uid):
        raise RuntimeError("Probe not connected")
    session = backend._get_session(uid)
    if session is None:
        raise RuntimeError("Probe not connected")
    return session


def get_interrupt_sources(uid):
    """Interrupt source rows [(number, name)].

    Aggregate <interrupt> entries from the vendor SVD peripherals (dedup by
    value, ascending). Fall back to generic IRQn names if unavailable.
    """
    sources = _interrupt_sources_from_svd(uid)
    if sources is not None:
        return sources
    return [(n, f'IRQ{n}') for n in range(DEFAULT_NVIC_COUNT)]


def _interrupt_sources_from_svd(uid):
    """Aggregate (number, name) from SVD <interrupt>; None when unavailable.

    Combines device-level <interrupt> entries (Geehy defines all interrupts at
    device level) with any peripheral-level interrupts, deduped by value.
    """
    try:
        session = _get_session(uid)
        svd = getattr(session.target, 'svd_device', None)
        if svd is None:
            return None
        collected: dict[int, str] = {}
        for grp in (getattr(svd, 'interrupts', None) or [],):
            for irq in (grp or []):
                _collect_svd_irq(collected, irq)
        for p in (svd.peripherals or []):
            for irq in (getattr(p, 'interrupts', None) or []):
                _collect_svd_irq(collected, irq)
        if not collected:
            return None
        return sorted(collected.items())
    except Exception as e:
        logger.warning(f"Failed to read NVIC interrupt sources: {e}")
        return None


def _collect_svd_irq(collected: dict, irq):
    v = getattr(irq, 'value', None)
    if not isinstance(v, int) or v < 0:
        return
    name = getattr(irq, 'name', '') or f'IRQ{v}'
    collected.setdefault(v, name)


def _read_words(uid, base_addr, word_count):
    """Read word_count 32-bit words via non-invasive direct AP read.

    Returns (words, None) on success, or (None, error). A None return from
    read_memory_direct means the per-uid op lock was busy (debug operation in
    progress), which the caller treats as "skip this refresh round".
    """
    from core.pyocd_backend import backend
    try:
        raw = backend.read_memory_direct(uid, base_addr, word_count * 4)
        if raw is None:
            return None, "busy"
        return list(struct.unpack(f'<{word_count}I', raw)), None
    except Exception as e:
        return None, str(e)


def read_nvic(uid):
    """Read current state of every interrupt source.

    Works while the target is running (NVIC sits in the system AHB space, so
    reads are non-invasive). Uses read_memory_direct (bypasses cache, no halt)
    so per-refresh snapshots are always fresh. When another debug operation
    holds the bus lock we return success=True with skipped=True so the caller
    can silently keep the previous snapshot instead of surfacing an error.

    Returns:
        {success, [skipped], interrupts: [{number, name, enabled, pending,
         active, priority}], errors: [{address, error}]}
    """
    try:
        session = _get_session(uid)
        sources = get_interrupt_sources(uid)
        n = len(sources)
        banks = (n + 31) // 32
        pri_words = (n + 3) // 4

        iser, e_iser = _read_words(uid, NVIC_BASE + _NVIC_ISER, banks)
        ispr, e_ispr = _read_words(uid, NVIC_BASE + _NVIC_ISPR, banks)
        iabr, e_iabr = _read_words(uid, NVIC_BASE + _NVIC_IABR, banks)
        ipr, e_ipr = _read_words(uid, NVIC_BASE + _NVIC_IPR, pri_words)

        # 任一读取因占用协调锁而跳过 → 本轮刷新跳过，保留上次快照
        if None in (iser, ispr, iabr, ipr):
            return {"success": True, "skipped": True}

        errors = []
        for addr, err in (
            (NVIC_BASE + _NVIC_ISER, e_iser),
            (NVIC_BASE + _NVIC_ISPR, e_ispr),
            (NVIC_BASE + _NVIC_IABR, e_iabr),
            (NVIC_BASE + _NVIC_IPR, e_ipr),
        ):
            if err:
                errors.append({"address": addr, "error": err})

        interrupts = []
        for number, name in sources:
            bit = number % 32
            bank = number // 32
            enabled = bool(iser[bank] >> bit & 1) if iser and bank < len(iser) else False
            pending = bool(ispr[bank] >> bit & 1) if ispr and bank < len(ispr) else False
            active = bool(iabr[bank] >> bit & 1) if iabr and bank < len(iabr) else False
            pri_w = number // 4
            pri_byte = (number % 4) * 8
            priority = (ipr[pri_w] >> pri_byte) & 0xFF if ipr and pri_w < len(ipr) else 0
            interrupts.append({
                "number": number,
                "name": name,
                "enabled": enabled,
                "pending": pending,
                "active": active,
                "priority": priority,
            })
        return {"success": True, "interrupts": interrupts, "errors": errors}
    except Exception as e:
        logger.warning(f"Read NVIC failed: {e}")
        return {"success": False, "error": str(e)}


def set_enable(uid, number, enabled):
    """Enable/disable an interrupt (ISER to set, ICER to clear)."""
    return _set_nvic_bit(uid, "enable", number, enabled, _NVIC_ISER, _NVIC_ICER)


def set_pending(uid, number, pending):
    """Set/clear an interrupt's pending state (ISPR to set, ICPR to clear)."""
    return _set_nvic_bit(uid, "pending", number, pending, _NVIC_ISPR, _NVIC_ICPR)


def _set_nvic_bit(uid, label, number, value, set_ofs, clear_ofs):
    try:
        session = _get_session(uid)
        if number < 0:
            return {"success": False, "error": "Invalid interrupt number"}
        from core.pyocd_backend import backend
        lock = backend.get_op_lock(uid)
        if not lock.acquire(blocking=False):
            return {"success": False, "error": "debug operation in progress"}
        try:
            # Keil 允许在程序运行状态下操作 Enable/Pending：NVIC 寄存器位于系统 AHB
            # 空间，运行中经 AP 做单次 32 位写入不会打断程序执行，因此不要求目标暂停。
            # 用 write32（而非字节块写）确保一次对齐的 32 位传输，对 ISER/ICER 这类
            # set/clear 寄存器最可靠。
            target = session.target
            reg_ofs = set_ofs if value else clear_ofs
            reg_value = 1 << (number % 32)
            target.write32(NVIC_BASE + reg_ofs + (number // 32) * 4, reg_value)
            return {"success": True, "number": number, label: bool(value)}
        finally:
            lock.release()
    except Exception as e:
        logger.warning(f"Set NVIC {label} failed: {e}")
        return {"success": False, "error": str(e)}


# ── System Control and Configuration（SCB 寄存器）──────────────────────────
SCB_ICSR = 0xE000ED04
SCB_VTOR = 0xE000ED08
SCB_AIRCR = 0xE000ED0C
SCB_STIR = 0xE000EF00

_PRG_GROUPS = [
    ("7.1", 0), ("6.2", 1), ("5.3", 2), ("4.4", 3),
    ("3.5", 4), ("2.6", 5), ("1.7", 6), ("0.8", 7),
]


def _scb_field(name, description, bit_offset, bit_width, values=None, access="ro"):
    d = {
        "name": name,
        "description": description,
        "bit_offset": bit_offset,
        "bit_width": bit_width,
        "access": access,  # ro 只读；rw 可读可写；w 写1触发（一般不回读）
    }
    if values:
        d["values"] = [{"name": n, "value": v} for n, v in values]
    return d


# 字段/位域定义参考 ARMv7-M（Cortex-M3/M4）System Control Block，顺序即展示顺序
# access 标注：只读位按位宽显示值；可写位由前端以复选框/下拉操作。
_SCB_REGS = [
    {
        "name": "SCB->ICSR",
        "address": SCB_ICSR,
        "description": "Interrupt Control and State Register",
        "group": "Interrupt Control and State",
        "group_desc": "ICSR 中断控制与状态",
        "fields": [
            _scb_field("VECTPENDING", "挂起的最高优先级异常的编号", 12, 9),
            _scb_field("RETTOBASE", "除当前异常外是否有其他活动异常", 11, 1),
            _scb_field("ISRPREEMPT", "是否存在可抢占当前异常的挂起异常", 24, 1),
            _scb_field("ISRPENDING", "是否有外部中断处于挂起状态", 23, 1),
            _scb_field("VECTACTIVE", "当前活动异常的编号", 0, 9),
        ],
    },
    {
        "name": "SCB->AIRCR",
        "address": SCB_AIRCR,
        "description": "Application Interrupt and Reset Control Register",
        "group": "Application Interrupt and Reset Control",
        "group_desc": "AIRCR 应用中断与复位控制",
        "fields": [
            _scb_field("ENDIANNESS", "数据端序（1=大端/0=小端）", 15, 1),
            _scb_field("PRIGROUP", "优先级分组（抢占/子优先级）", 8, 3,
                       values=_PRG_GROUPS, access="rw"),
            _scb_field("SYSRESETREQ", "请求系统复位（写 1 触发）", 2, 1, access="w"),
            _scb_field("VECTCLRACTIVE", "清除异常活动状态", 1, 1, access="w"),
            _scb_field("VECTRESET", "系统复位（调试时，写 1 触发）", 0, 1, access="w"),
        ],
    },
    {
        "name": "SCB->VTOR",
        "address": SCB_VTOR,
        "description": "Vector Table Offset Register",
        "group": "Vector Table Offset",
        "group_desc": "VTOR 向量表偏移",
        "fields": [
            _scb_field("TBLBASE", "向量表基址所在区域（1=SRAM/0=Flash）", 28, 1, access="rw"),
            _scb_field("TBLOFF", "向量表在基地址区域的字偏移", 7, 25, access="rw"),
        ],
    },
    {
        "name": "SCB->STIR",
        "address": SCB_STIR,
        "description": "Software Trigger Interrupt Register",
        "group": "Software Interrupt Trigger",
        "group_desc": "STIR 软件中断触发",
        "write_only": True,
        "fields": [
            _scb_field("INTID", "待触发的软件中断编号（写触发）", 0, 9, access="w"),
        ],
    },
]


# ── System Tick Timer（SysTick：CTRL/LOAD/VAL/CALIB）──────────────────────
SYSTICK_BASE = 0xE000E010
STK_CTRL = 0xE000E010
STK_LOAD = 0xE000E014
STK_VAL = 0xE000E018
STK_CALIB = 0xE000E01C


def _stk_field(name, description, bit_offset, bit_width, values=None, access="ro"):
    return _scb_field(name, description, bit_offset, bit_width, values, access)


# 位域定义参考 ARMv7-M System Tick Timer，顺序即展示顺序（与 Keil SysTick 一致）
_SYSTICK_REGS = [
    {
        "name": "SysTick->CTRL",
        "address": STK_CTRL,
        "description": "SysTick Control and Status Register",
        "group": "Control and Status",
        "group_desc": "CTRL 控制与状态",
        "fields": [
            _stk_field("ENABLE", "计数器使能", 0, 1, access="rw"),
            _stk_field("TICKINT", "计数到 0 时挂起 SysTick 异常", 1, 1, access="rw"),
            _stk_field("CLKSOURCE", "时钟源（1=处理器时钟/0=外部参考时钟）", 2, 1, access="rw"),
            _stk_field("COUNTFLAG", "计数器计数到 0 标志（读本位自动清零，只读）", 16, 1),
        ],
    },
    {
        "name": "SysTick->LOAD",
        "address": STK_LOAD,
        "description": "SysTick Reload Value Register",
        "group": "Reload and Current Value",
        "group_desc": "LOAD/VAL 重载与当前值",
        "fields": [
            _stk_field("RELOAD", "重载值（计数器从 RELOAD 递减到 0）", 0, 24, access="rw"),
        ],
    },
    {
        "name": "SysTick->VAL",
        "address": STK_VAL,
        "description": "SysTick Current Value Register",
        "group": "Reload and Current Value",
        "group_desc": "LOAD/VAL 重载与当前值",
        "write_only": False,
        "fields": [
            _stk_field("CURRENT", "当前计数值（读返回当前递减值，只读）", 0, 24),
        ],
    },
    {
        "name": "SysTick->CALIB",
        "address": STK_CALIB,
        "description": "SysTick Calibration Value Register",
        "group": "Calibration",
        "group_desc": "CALIB 校准值",
        "fields": [
            _stk_field("TENMS", "10ms 时间校准值", 0, 24),
            _stk_field("SKEW", "校准值并非精确的 10ms", 30, 1),
            _stk_field("NOREF", "无独立参考时钟（处理器时钟仍可用）", 31, 1),
        ],
    },
]


def read_systick(uid):
    """Read SysTick registers (CTRL/LOAD/VAL/CALIB).

    Non-invasive reads work while the target is running. VAL/CALIB read-only
    fields surface value=None if a read fails (e.g. unsupported CALIB).
    """
    session = _get_session(uid)
    banks = [(r["address"], r) for r in _SYSTICK_REGS]
    results = {}
    for addr, _cfg in banks:
        words, err = _read_words(uid, addr, 1)
        results[addr] = (words, err)

    out = []
    for addr, cfg in banks:
        words, _err = results[addr]
        reg = dict(cfg)
        reg["value"] = words[0] if words is not None else None
        out.append(reg)
    return {"success": True, "registers": out}


def read_scb(uid):
    """Read SCB registers (ICSR/AIRCR/VTOR/STIR) with read-only values.

    Non-invasive (system AHB space via direct AP read), so it works while the
    target is running. STIR is write-only: a read failure there only yields
    value=None, not an overall error. When the op lock is held by another debug
    operation we return success=True with skipped=True.
    """
    session = _get_session(uid)
    banks = [(r["address"], r) for r in _SCB_REGS]
    results = {}
    for addr, _cfg in banks:
        words, err = _read_words(uid, addr, 1)
        results[addr] = (words, err)
        if addr == SCB_ICSR and words is None and err == "busy":
            return {"success": True, "skipped": True}

    out = []
    for addr, cfg in banks:
        words, _err = results[addr]
        reg = dict(cfg)
        reg["value"] = words[0] if words is not None else None
        out.append(reg)
    return {"success": True, "registers": out}


def trigger_stir(uid, intid):
    """Write software-triggered interrupt (STIR.INTID), works while running."""
    try:
        session = _get_session(uid)
        if intid < 0:
            return {"success": False, "error": "Invalid interrupt number"}
        from core.pyocd_backend import backend
        lock = backend.get_op_lock(uid)
        if not lock.acquire(blocking=False):
            return {"success": False, "error": "debug operation in progress"}
        try:
            session.target.write32(SCB_STIR, intid & 0x1FF)
            return {"success": True, "intid": intid}
        finally:
            lock.release()
    except Exception as e:
        logger.warning(f"Trigger STIR failed: {e}")
        return {"success": False, "error": str(e)}


def write_scb_field(uid, address, field_name, value):
    """Read-modify-write a writable core bitfield (SCB or SysTick).

    Works while the target is running (these sit in the system AHB space, so a
    single 32-bit AP write is non-invasive). Only fields marked access in
    ("rw", "w") are writable; writes to read-only fields are rejected.

    AIRCR is a keyed register: writing it requires VECTKEY = 0x05FA in the
    upper half-word, which we force here irrespective of the value read back.
    """
    try:
        session = _get_session(uid)
        reg_table = _SCB_REGS + _SYSTICK_REGS
        reg_cfg = next((r for r in reg_table if r["address"] == address), None)
        if reg_cfg is None:
            return {"success": False, "error": f"Unknown SCB register 0x{address:08X}"}
        field_cfg = next((f for f in reg_cfg["fields"] if f["name"] == field_name), None)
        if field_cfg is None:
            return {"success": False, "error": f"Unknown field {field_name}"}
        if field_cfg["access"] not in ("rw", "w"):
            return {"success": False, "error": f"{field_name} is read-only"}

        width = field_cfg["bit_width"]
        offset = field_cfg["bit_offset"]
        if width >= 32:
            mask = 0xFFFFFFFF
        else:
            mask = ((1 << width) - 1) << offset
        value = int(value) & ((1 << width) - 1)

        from core.pyocd_backend import backend
        lock = backend.get_op_lock(uid)
        if not lock.acquire(blocking=False):
            return {"success": False, "error": "debug operation in progress"}
        try:
            target = session.target
            if address == SCB_AIRCR:
                # 读回当前值以便保留其它位域；AIRCR 是 keyed 寄存器，
                # 高位强制写入 VECTKEY 0x05FA。
                cur = target.read32(address) & 0x0000FFFF
                cur &= ~mask
                new = cur | (value << offset) | (0x05FA << 16)
            else:
                cur = target.read32(address)
                new = (cur & ~mask) | (value << offset)
            target.write32(address, new)
            return {
                "success": True,
                "address": address,
                "field": field_name,
                "value": value,
            }
        finally:
            lock.release()
    except Exception as e:
        logger.warning(f"Write SCB field {field_name} failed: {e}")
        return {"success": False, "error": str(e)}