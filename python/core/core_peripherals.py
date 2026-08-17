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