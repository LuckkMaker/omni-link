"""Zone 调试工作台 API 路由

提供 Zone 页面的全部后端接口：
    - 调试控制（halt/step/continue/reset/status，复用 commander 执行）
    - ELF 源码 / 反汇编视图
    - 外设 / 寄存器 / 内存检查器
    - 会话配置持久化
"""

import asyncio
import json
import os
import time
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from core.commander_backend import commander_backend
from core.elf_backend import elf_backend
from core.peripheral_backend import peripheral_backend
from core.pyocd_backend import backend

router = APIRouter()


# ── 请求模型 ──────────────────────────────

class ExecRequest(BaseModel):
    command: str


class ElfLoadRequest(BaseModel):
    path: str


class DisasmRequest(BaseModel):
    address: int
    length: int = 64
    max_instructions: int = 32


class ReadRegistersRequest(BaseModel):
    addresses: list[int]


class ReadMemoryRequest(BaseModel):
    address: int
    length: int = 64


class ResetRequest(BaseModel):
    mode: str = 'halt'  # 'halt' | 'run' | 'break_symbol'


class StepRequest(BaseModel):
    mode: str = 'into'  # 'into' | 'over' | 'out'


class BreakpointRequest(BaseModel):
    """源码行断点：file + line 定位，set=True 设断点 / False 移除"""
    file: str
    line: int
    set: bool = True


class RunToCursorRequest(BaseModel):
    """运行到光标所在行：file + line 定位目标地址"""
    file: str
    line: int


class SessionSaveRequest(BaseModel):
    name: str
    data: dict


# ── 调试控制 ──────────────────────────────

@router.post("/probes/{uid}/zone/debug/halt")
async def zone_halt(uid: str):
    """暂停目标"""
    from core.monitor_backend import monitor_backend
    with monitor_backend.pause_during(uid):
        result = await asyncio.to_thread(commander_backend.execute, uid, "halt")
    if not result["success"] and result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return {"success": True}


@router.post("/probes/{uid}/zone/debug/step")
async def zone_step(uid: str, req: StepRequest = StepRequest()):
    """单步执行（源码级）

    借助 ELF 的 DWARF 行号表，使 Step 以「源代码行」为粒度执行：
      - into: 进入（执行到下一条源代码行；若调用函数则进入被调函数的第一条语句）
      - over: 跳过（执行到下一条源代码行；当前行内的函数调用整体跨过，不进入）
      - out:  跳出（执行完当前子程序，返回到调用者后暂停）

    若目标无调试信息（未加载 ELF / 无 DWARF 行表），自动回退为指令级单步。
    """
    from core.monitor_backend import monitor_backend
    mode = req.mode
    session = backend._get_session(uid)
    if not session:
        raise HTTPException(status_code=400, detail="Probe not connected")
    target = session.target

    # 目标未暂停时先自动中断，再单步。
    # 参考 cdt-gdb-adapter customReset 的 pauseIfRunning 语义：单步必须从暂停态发起，
    # 若目标仍在运行（如 download&reset 后），先 halt 使其暂停，避免直接报 "Target not halted"。
    if not target.is_halted():
        with monitor_backend.pause_during(uid):
            halt_result = await asyncio.to_thread(commander_backend.execute, uid, "halt")
        if not halt_result["success"] and halt_result.get("error"):
            raise HTTPException(status_code=400, detail=halt_result["error"])

    core = target.selected_core_or_raise
    with monitor_backend.pause_during(uid):
        if mode == 'into':
            halted = await asyncio.to_thread(_step_source_into, core, session, uid)
        elif mode == 'over':
            halted = await asyncio.to_thread(_step_source_over, core, session, uid)
        else:  # 'out'
            halted = await asyncio.to_thread(_step_over_out, core, session, 'out')
    return {"success": True, "mode": mode, "halted": halted}


@router.post("/probes/{uid}/zone/debug/continue")
async def zone_continue(uid: str):
    """继续运行"""
    from core.monitor_backend import monitor_backend
    with monitor_backend.pause_during(uid):
        result = await asyncio.to_thread(commander_backend.execute, uid, "continue")
    if not result["success"] and result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return {"success": True}


@router.post("/probes/{uid}/zone/debug/run-to-cursor")
async def zone_run_to_cursor(uid: str, req: RunToCursorRequest):
    """运行到光标所在行（Keil「Run to Cursor Line」）

    在目标行地址设置临时断点并 resume，命中后暂停并移除临时断点。
    若目标行已有永久断点则复用，不重复添加。
    """
    from core.monitor_backend import monitor_backend
    if not elf_backend.is_loaded(uid):
        raise HTTPException(status_code=400, detail="No ELF loaded")
    address = elf_backend.get_address_for_line(uid, req.file, req.line)
    if address is None:
        raise HTTPException(status_code=400, detail=f"No code at {req.file}:{req.line}")

    session = backend._get_session(uid)
    if not session:
        raise HTTPException(status_code=400, detail="Probe not connected")
    core = session.target.selected_core_or_raise

    # 目标未暂停时先自动中断，再从暂停态发起（与 step 语义一致）
    if not session.target.is_halted():
        with monitor_backend.pause_during(uid):
            result = await asyncio.to_thread(commander_backend.execute, uid, "halt")
        if not result["success"] and result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])

    # 已停在目标行：无需运行
    if (core.read_core_register('pc') & ~1) == address:
        return {"success": True, "address": address, "halted": True}

    # 移除当前 PC 的武装断点，避免 resume 后立即再次触发；结束后恢复
    restore = _step_over_current_breakpoint(core)
    # 目标行已有永久断点则复用；否则设置临时断点
    is_temp = core.find_breakpoint(address) is None
    try:
        with monitor_backend.pause_during(uid):
            if is_temp:
                core.set_breakpoint(address)
                core.bp_manager.flush()
            halted = await asyncio.to_thread(_resume_until_halted, session)
    finally:
        if is_temp:
            try:
                with monitor_backend.pause_during(uid):
                    core.remove_breakpoint(address)
                    core.bp_manager.flush()
            except Exception:
                pass
        if restore is not None:
            restore()
    return {"success": True, "address": address, "halted": halted}


@router.post("/probes/{uid}/zone/debug/reset")
async def zone_reset(uid: str, req: ResetRequest = ResetRequest()):
    """复位目标

    mode:
      - halt:         复位并暂停（默认，向后兼容）
      - run:          复位后继续运行
      - break_symbol: 复位后运行，直到停在入口符号（main → __main → Reset_Handler）
    """
    from core.monitor_backend import monitor_backend
    mode = req.mode

    # break_symbol：先解析入口符号地址
    symbol_name = None
    symbol_addr = None
    if mode == 'break_symbol':
        for name in ('main', '__main', 'Reset_Handler'):
            addr = elf_backend.get_symbol_address(uid, name)
            if addr is not None:
                symbol_name, symbol_addr = name, addr
                break
        if symbol_addr is None:
            # 无法解析符号（未加载 ELF 或不含入口符号），回退到复位并暂停
            with monitor_backend.pause_during(uid):
                result = await asyncio.to_thread(commander_backend.execute, uid, "reset halt")
            if not result["success"] and result.get("error"):
                raise HTTPException(status_code=400, detail=result["error"])
            return {"success": True, "mode": mode, "symbol": None, "address": None}

    with monitor_backend.pause_during(uid):
        if mode in ('halt', 'break_symbol'):
            # halt / break_symbol：先复位并暂停目标，确保已知状态
            result = await asyncio.to_thread(commander_backend.execute, uid, "reset halt")
            if not result["success"] and result.get("error"):
                # 兼容部分目标无 reset halt，改走 reset
                result = await asyncio.to_thread(commander_backend.execute, uid, "reset")
        else:
            # run：复位后继续运行
            result = await asyncio.to_thread(commander_backend.execute, uid, "reset")
        if not result["success"] and result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])

        # 复位会经 reset-catch（VECTOR_CATCH）清除目标上已武装的全部断点并禁用 FPB
        # （见 pyocd BreakpointManager._pre/_post_reset_catch_handler）。复位暂停后需
        # 重新武装应用层记录的断点，否则用户 Reset 后再 Run 将不会命中任何断点。
        if mode in ('halt', 'break_symbol'):
            await asyncio.to_thread(_rearm_breakpoints, uid)

        if mode == 'break_symbol':
            # 复位暂停后设置入口断点并继续运行，可靠停在 main
            await asyncio.to_thread(commander_backend.execute, uid, f"break 0x{symbol_addr:x}")
            await asyncio.to_thread(commander_backend.execute, uid, "continue")

    # break_symbol：轮询等待目标暂停（超时 8s）
    halted = False
    if mode == 'break_symbol':
        deadline = asyncio.get_event_loop().time() + 8.0
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.1)
            session = backend._get_session(uid)
            if session is None:
                break
            try:
                if session.target.is_halted():
                    halted = True
                    break
            except Exception:
                break

        # 目标已停在入口符号断点。此刻必须移除该一次性断点：
        # 若保留，FPB 断点仍武装，后续 Step 在入口指令 fetch 阶段会立即再次触发断点，
        # 导致 PC 永远停在入口、单步"无反应"（指令不执行、反汇编/源码窗口都不变）。
        if halted:
            await asyncio.to_thread(
                commander_backend.execute, uid, f"rmbreak 0x{symbol_addr:x}"
            )

    return {
        "success": True,
        "mode": mode,
        "symbol": symbol_name,
        "address": symbol_addr,
        "halted": halted,
    }


@router.post("/probes/{uid}/zone/debug/status")
async def zone_status(uid: str):
    """查询目标状态（halted/running）与 PC"""
    if not backend.is_connected(uid):
        return {"success": True, "connected": False, "state": "disconnected", "pc": None}
    session = backend._get_session(uid)
    state = "unknown"
    pc = None
    try:
        if session and session.target.is_halted():
            state = "halted"
            pc = session.target.read_core_register("pc") & ~1
        else:
            state = "running"
    except Exception:
        pass
    return {"success": True, "connected": True, "state": state, "pc": pc}


# ── 源码行断点 ──────────────────────────────
# uid -> {address: {address, file, line}}
_BREAKPOINTS: dict[str, dict[int, dict]] = {}


def _get_session_core(uid: str):
    """获取已连接会话的目标 core，未连接时抛 HTTPException"""
    session = backend._get_session(uid)
    if not session:
        raise HTTPException(status_code=400, detail="Probe not connected")
    try:
        return session.target.selected_core_or_raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Target not available: {e}")


def _rearm_breakpoints(uid: str):
    """复位后重新武装应用层记录的源码断点。

    pyOCD 的 reset-catch 复位（VECTOR_CATCH）会清除目标上已武装的全部断点
    并禁用 FPB（见 BreakpointManager._pre/_post_reset_catch_handler）。此函数
    遍历应用层断点表 _BREAKPOINTS[uid]，把它们重新设置到目标 core 上。
    """
    bps = _BREAKPOINTS.get(uid, {})
    if not bps:
        return
    core = _get_session_core(uid)
    for address in bps:
        core.set_breakpoint(address)
    core.bp_manager.flush()


@router.post("/probes/{uid}/zone/debug/breakpoint")
async def zone_breakpoint(uid: str, req: BreakpointRequest):
    """按源码行设置/移除断点（file + line → 地址 → 目标断点）"""
    from core.monitor_backend import monitor_backend
    if not elf_backend.is_loaded(uid):
        raise HTTPException(status_code=400, detail="No ELF loaded")
    address = elf_backend.get_address_for_line(uid, req.file, req.line)
    if address is None:
        raise HTTPException(status_code=400, detail=f"No code at {req.file}:{req.line}")

    bps = _BREAKPOINTS.setdefault(uid, {})
    if req.set:
        core = _get_session_core(uid)
        with monitor_backend.pause_during(uid):
            core.set_breakpoint(address)
            core.bp_manager.flush()
        bps[address] = {"address": address, "file": req.file, "line": req.line}
    else:
        core = _get_session_core(uid)
        with monitor_backend.pause_during(uid):
            core.remove_breakpoint(address)
            core.bp_manager.flush()
        bps.pop(address, None)

    return {"success": True, "address": address, "file": req.file, "line": req.line, "active": req.set}


@router.get("/probes/{uid}/zone/breakpoints")
async def zone_breakpoints(uid: str):
    """列出当前已设置的源码断点"""
    return {"success": True, "breakpoints": sorted(_BREAKPOINTS.get(uid, {}).values(), key=lambda b: b["address"])}


# ── ELF 源码 / 反汇编 ──────────────────────

@router.post("/probes/{uid}/zone/elf/load")
async def zone_elf_load(uid: str, req: ElfLoadRequest):
    """加载 ELF/AXF 文件，构建源码/反汇编视图"""
    result = await asyncio.to_thread(elf_backend.load_elf, uid, req.path)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "ELF load failed"))
    return result


@router.get("/probes/{uid}/zone/elf/info")
async def zone_elf_info(uid: str):
    """查询已加载 ELF 信息"""
    backend_loaded = elf_backend.is_loaded(uid)
    return {
        "success": True,
        "loaded": backend_loaded,
        "path": elf_backend.get_path(uid),
    }


@router.get("/probes/{uid}/zone/elf/changed")
async def zone_elf_changed(uid: str):
    """检测 ELF 是否变化"""
    return elf_backend.check_elf_changed(uid)


@router.get("/probes/{uid}/zone/source/files")
async def zone_source_files(uid: str):
    """源文件列表（File/Size/Path）"""
    result = elf_backend.get_source_files(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "No ELF loaded"))
    return {"success": True, "files": result["files"]}


@router.get("/probes/{uid}/zone/source/line")
async def zone_source_line(uid: str, address: int):
    """PC 地址 → 源码位置"""
    result = elf_backend.get_line_for_address(uid, address)
    return {"success": result is not None, "line": result}


@router.get("/probes/{uid}/zone/source/executable-lines")
async def zone_source_executable_lines(uid: str, file: str):
    """获取文件中可执行（有代码地址映射）的行号，用于仅在这些行显示断点标记"""
    lines = elf_backend.get_executable_lines(uid, file)
    if lines is None:
        return {"success": False, "error": "No line table available"}
    return {"success": True, "lines": lines}


@router.get("/probes/{uid}/zone/source/symbol")
async def zone_source_symbol(uid: str, name: str):
    """按名字解析符号定义位置（转到定义）"""
    result = elf_backend.resolve_symbol(uid, name)
    return {"success": result is not None, "symbol": result}


@router.get("/probes/{uid}/zone/source/search")
async def zone_source_search(uid: str, query: str, limit: int = 200):
    """在全部源文件中做文本搜索（转到引用的轻量实现）"""
    result = elf_backend.search_source(uid, query, limit)
    return result


@router.get("/probes/{uid}/zone/source/content")
async def zone_source_content(uid: str, file: str):
    """读取源文件内容（按行返回）"""
    file_path = file
    if not os.path.isabs(file_path):
        comp_dir = None
        with elf_backend._lock:
            entry = elf_backend._entries.get(uid)
        if entry:
            # 尝试从 line_tree 找到该文件的 comp_dir
            for interval in entry["decoder"].line_tree:
                info = interval.data
                if (info.filename or '').replace('\\', '/') == file:
                    comp_dir = info.comp_dir
                    break
        if comp_dir:
            file_path = os.path.join(comp_dir, file)
    if not os.path.isfile(file_path):
        return {"success": False, "error": f"File not found: {file_path}"}
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.read().split('\n')
        return {"success": True, "file": file_path.replace('\\', '/'), "lines": lines}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.delete("/probes/{uid}/zone/debug/breakpoints")
async def zone_clear_breakpoints(uid: str):
    """清除全部断点"""
    from core.monitor_backend import monitor_backend
    bps = _BREAKPOINTS.get(uid, {})
    if not bps:
        return {"success": True, "cleared": 0}
    core = _get_session_core(uid)
    with monitor_backend.pause_during(uid):
        for address in list(bps.keys()):
            core.remove_breakpoint(address)
        core.bp_manager.flush()
    count = len(bps)
    _BREAKPOINTS[uid] = {}
    return {"success": True, "cleared": count}


@router.post("/probes/{uid}/zone/disasm")
async def zone_disasm(uid: str, req: DisasmRequest):
    """反汇编指定地址"""
    result = await asyncio.to_thread(
        elf_backend.disassemble, uid, req.address, req.length, req.max_instructions
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Disasm failed"))
    return result


@router.get("/probes/{uid}/zone/functions")
async def zone_functions(uid: str, filter: str = "", offset: int = 0, limit: int = 200):
    """函数列表（分页）"""
    result = elf_backend.get_functions(uid, filter, offset, limit)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "No ELF loaded"))
    return result


@router.get("/probes/{uid}/zone/memory/usage")
async def zone_memory_usage(uid: str):
    """内存使用统计（Flash/RAM 占用）"""
    result = elf_backend.get_memory_usage(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "No ELF loaded"))
    return result


@router.get("/probes/{uid}/zone/stack")
async def zone_stack(uid: str):
    """调用栈回溯（需目标暂停）：基于核心寄存器 + 帧指针链 + 栈扫描恢复调用链"""
    if not backend.is_connected(uid):
        raise HTTPException(status_code=400, detail="Probe not connected")
    session = backend._get_session(uid)
    if not session or not session.target.is_halted():
        raise HTTPException(status_code=400, detail="Target not halted")
    target = session.target
    try:
        core = target.selected_core_or_raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Target not available: {e}")

    # 读取回溯所需寄存器（含帧指针 R11、双栈指针与 CONTROL 以区分上下文）
    reg_names = [
        "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7",
        "r8", "r9", "r10", "r11", "r12",
        "sp", "lr", "pc", "msp", "psp", "control",
    ]
    regs: dict = {}
    for name in reg_names:
        try:
            value = core.read_core_register(name)
            regs[name] = int(value) if isinstance(value, float) else value
        except Exception:
            pass

    def read_mem(addr: int, length: int) -> bytes:
        return backend.read_memory(uid, addr, length)

    try:
        frames = await asyncio.to_thread(elf_backend.unwind, uid, regs, read_mem)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Unwind failed: {e}")

    # 为每帧附加 DWARF 局部变量 / 形参（函数签名、返回值类型、变量值）
    for f in frames:
        faddr = f.get("function_address") or f.get("address")
        if not faddr:
            continue
        loc = await asyncio.to_thread(elf_backend.frame_locals, uid, faddr, regs, read_mem)
        if loc:
            f["signature"] = loc["signature"]
            f["ret"] = loc["ret"]
            f["locals"] = loc["variables"]

    sp = regs.get("sp") or 0
    pc = regs.get("pc") or 0
    lr = regs.get("lr") or 0
    return {"success": True, "frames": frames, "sp": sp, "pc": pc, "lr": lr}


@router.get("/probes/{uid}/zone/callgraph")
async def zone_callgraph(uid: str, address: int):
    """调用图：解析指定函数地址的直接 callees"""
    if not elf_backend.is_loaded(uid):
        raise HTTPException(status_code=400, detail="No ELF loaded")
    result = elf_backend.get_callees(uid, address)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Resolve failed"))
    return result


# ── 外设 / 寄存器 / 内存检查器 ──────────────

@router.get("/probes/{uid}/zone/peripherals")
async def zone_peripherals(uid: str):
    """外设树元数据"""
    result = peripheral_backend.get_peripherals(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "No SVD device"))
    return result


@router.post("/probes/{uid}/zone/registers/read")
async def zone_registers_read(uid: str, req: ReadRegistersRequest):
    """批量读取寄存器值（合并块读）"""
    result = await asyncio.to_thread(peripheral_backend.read_registers, uid, req.addresses)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Read failed"))
    return result


# ── CPU 核心寄存器（Registers 面板） ──────────

# 核心寄存器描述（用于 Registers 面板的 Description 列）
_CORE_REG_DESCRIPTIONS = {
    "r0": "通用寄存器 0", "r1": "通用寄存器 1", "r2": "通用寄存器 2",
    "r3": "通用寄存器 3", "r4": "通用寄存器 4", "r5": "通用寄存器 5",
    "r6": "通用寄存器 6", "r7": "通用寄存器 7", "r8": "通用寄存器 8",
    "r9": "通用寄存器 9", "r10": "通用寄存器 10", "r11": "通用寄存器 11",
    "r12": "通用寄存器 12",
    "sp": "栈指针 (Stack Pointer)",
    "lr": "链接寄存器 (Link Register)",
    "pc": "程序计数器 (Program Counter)",
    "xpsr": "程序状态寄存器 (Program Status Register)",
    "msp": "主栈指针 (Main Stack Pointer)",
    "psp": "进程栈指针 (Process Stack Pointer)",
    "control": "控制寄存器 (CONTROL)",
    "primask": "优先级屏蔽寄存器 (PRIMASK)",
    "basepri": "基础优先级寄存器 (BASEPRI)",
    "faultmask": "错误屏蔽寄存器 (FAULTMASK)",
    "ipsr": "中断程序状态寄存器 (IPSR)",
    "fpscr": "浮点状态与控制寄存器 (FPSCR)",
}

# 读取顺序（按 ARM 惯例排列）
_CORE_REG_ORDER = [
    "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12",
    "sp", "lr", "pc", "xpsr", "msp", "psp",
    "control", "primask", "basepri", "faultmask", "ipsr", "fpscr",
]


@router.get("/probes/{uid}/zone/registers/core")
async def zone_registers_core(uid: str):
    """读取 CPU 核心寄存器（名称/值/描述），供 Registers 面板列表展示"""
    if not backend.is_connected(uid):
        raise HTTPException(status_code=400, detail="Probe not connected")
    session = backend._get_session(uid)
    if not session:
        raise HTTPException(status_code=400, detail="Probe not connected")
    try:
        core = session.target.selected_core_or_raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Target not available: {e}")

    registers = []
    errors = []
    for name in _CORE_REG_ORDER:
        try:
            value = core.read_core_register(name)
            # 浮点寄存器可能返回 float，统一转整数展示
            if isinstance(value, float):
                value = int(value)
            registers.append({
                "name": name.upper(),
                "value": value,
                "description": _CORE_REG_DESCRIPTIONS.get(name, ""),
            })
        except Exception as e:
            errors.append({"name": name, "error": str(e)})

    return {"success": True, "registers": registers, "errors": errors}


@router.post("/probes/{uid}/zone/memory/read")
async def zone_memory_read(uid: str, req: ReadMemoryRequest):
    """读取内存（字节）"""
    if not backend.is_connected(uid):
        raise HTTPException(status_code=400, detail="Probe not connected")
    length = min(max(req.length, 1), 1024)
    try:
        data = await asyncio.to_thread(backend.read_memory, uid, req.address, length)
        return {"success": True, "address": req.address, "length": length, "data_hex": data.hex()}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/probes/{uid}/zone/memory/resolve")
async def zone_memory_resolve(uid: str, expr: str):
    """解析内存地址表达式（纯 hex / &name / name / name[offset]） → 地址"""
    result = await asyncio.to_thread(elf_backend.resolve_memory_address, uid, expr)
    return result


# ── 会话配置持久化 ──────────────────────────

_SESSION_DIR = None


def _get_session_dir() -> str:
    global _SESSION_DIR
    if _SESSION_DIR is None:
        import tempfile
        _SESSION_DIR = os.path.join(tempfile.gettempdir(), "omni-link-zone-sessions")
        os.makedirs(_SESSION_DIR, exist_ok=True)
    return _SESSION_DIR


def _session_path(name: str) -> str:
    safe = name.replace('/', '_').replace('\\', '_').replace(':', '_')
    if not safe.endswith('.json'):
        safe += '.json'
    return os.path.join(_get_session_dir(), safe)


@router.get("/zone/sessions")
async def zone_sessions():
    """列出已保存的会话"""
    sessions = []
    for fn in os.listdir(_get_session_dir()):
        if fn.endswith('.json'):
            path = os.path.join(_get_session_dir(), fn)
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                sessions.append({
                    "name": data.get("name", fn[:-5]),
                    "path": path,
                    "updated_at": data.get("updated_at", ""),
                })
            except Exception:
                pass
    sessions.sort(key=lambda s: s["updated_at"], reverse=True)
    return {"success": True, "sessions": sessions}


@router.post("/zone/sessions")
async def zone_session_save(req: SessionSaveRequest):
    """保存会话配置（写 JSON 文件）"""
    from datetime import datetime
    payload = {
        "name": req.name,
        "data": req.data,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }
    path = _session_path(req.name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return {"success": True, "name": req.name, "path": path}


@router.get("/zone/sessions/{name}")
async def zone_session_get(name: str):
    """读取会话配置"""
    path = _session_path(name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Session not found")
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return {"success": True, "session": data}


@router.delete("/zone/sessions/{name}")
async def zone_session_delete(name: str):
    """删除会话配置"""
    path = _session_path(name)
    if os.path.isfile(path):
        os.remove(path)
    return {"success": True}


# ── Step Over / Step Out 辅助 ────────────────────────────

def _is_call_instruction(core, pc: int) -> bool:
    """判断 PC 处指令是否为 BL/BLX 调用指令（Thumb 模式）"""
    try:
        import capstone
        addr = pc & ~1
        code = core.read_memory_block8(addr, 4)
        md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)
        md.detail = True
        for ins in md.disasm(bytes(bytearray(code)), addr):
            return ins.mnemonic in ('bl', 'blx')
    except Exception:
        return False
    return False


def _call_target(core, pc: int) -> Optional[int]:
    """取 BL/BLX 调用指令的目标地址（Thumb 模式）。

    仅对立即数形式的 BL（最常见，GCC 生成子程序调用即此形式）返回目标地址；
    BLX(寄存器)的目标是运行时值、无法静态解析，返回 None。非调用或解析失败也返回
    None。目标用于判断被调函数是否含调试信息，以决定 Step Into 是进入还是跳过。
    """
    try:
        import capstone
        addr = pc & ~1
        code = core.read_memory_block8(addr, 4)
        md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)
        md.detail = True
        for ins in md.disasm(bytes(bytearray(code)), addr):
            if ins.mnemonic not in ('bl', 'blx'):
                return None
            if ins.operands and ins.operands[0].type == capstone.CS_OP_IMM:
                return ins.operands[0].imm & ~1
            return None  # BLX(寄存器) 目标运行时才能确定
    except Exception:
        return None
    return None


def _resume_until_halted(session, timeout: float = 8.0) -> bool:
    """resume 目标并轮询等待其暂停（命中临时断点）。返回是否成功暂停。"""
    core = session.target.selected_core_or_raise
    core.resume()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.05)
        try:
            if session.target.is_halted():
                return True
        except Exception:
            return False
    return False


def _resume_to_return_ignore_others(session, return_addr: int, timeout: float = 8.0) -> bool:
    """resume 目标，且只在 return_addr 处停下（忽略其他用户断点）。

    Step Over / Step Out 的标准语义：把当前 C 语句（含其中的函数调用）视为一个
    整体，运行期间命中的其他用户断点应被忽略，直到返回到 return_addr 才暂停
    （参考 Keil / GDB `next` 行为）。若 HAL_Init 等被跨过函数的内部执行路径上
    设置了用户断点，不忽略它们会导致 Step Over 错误地停在该断点而非调用点下一行。

    实现：resume 前临时移除除 return_addr 外的所有已武装断点，命中 return_addr
    暂停后再恢复。返回是否成功暂停。
    """
    core = session.target.selected_core_or_raise
    return_addr = return_addr & ~1

    # 收集当前所有已武装断点地址（含调用方刚设置的 LR 临时断点）
    others = [a for a in core.bp_manager.get_breakpoints() if a & ~1 != return_addr]

    # 临时移除其他断点，避免 resume 途中命中它们
    for a in others:
        core.remove_breakpoint(a)
    core.bp_manager.flush()

    try:
        core.resume()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            time.sleep(0.05)
            try:
                if session.target.is_halted():
                    return True
            except Exception:
                return False
        return False
    finally:
        # 恢复被临时移除的断点
        for a in others:
            core.set_breakpoint(a)
        core.bp_manager.flush()


# 源码级单步安全上限（防止调试信息异常导致死循环）
_SOURCE_STEP_LIMIT = 10000
# 指令级单步总时间预算（秒）。CMSIS-DAP v1 (HID) 单步极慢，
# 若某条源码行展开为大量指令，无时间预算会表现为"卡死转圈"。
_STEP_TIME_BUDGET = 2.5


def _read_pc(core) -> int:
    return core.read_core_register('pc')


def _line_at(uid: str, pc: int):
    """PC 的源码定位 (file, line)；无调试信息或行为无效行返回 None。

    DWARF 行号表中 line <= 0 代表「无明确源行」的指令（编译器在优化时对跳转
    延迟槽、分支填充、内联合并等地址会写入 line 0）。这类指令若被当作有效行
    停驻，前端会丢失 C 源码指示（只剩汇编指示）——典型如 `if (ret != 0) { return; }`
    中条件为假时跳过 return 的那条跳转指令。将其视为无效行后，
    单步会继续执行到下一个真实源行才停。
    """
    info = elf_backend.get_line_for_address(uid, pc)
    if not info or info.get('line') is None or info['line'] <= 0:
        return None
    return (info.get('file', ''), info['line'])


def _halt_core(core) -> None:
    """异常时强制暂停目标，避免跨过调用超时后目标失控"""
    try:
        core.halt()
        core.wait_until_halted()
    except Exception:
        pass


def _call_return_lr(core) -> int:
    """读取调用返回地址 LR 并清除 Thumb 位。

    Cortex-M 的 LR 低 bit0 为 Thumb 指示、恒为 1。若直接把含 Thumb 位的
    LR 用作断点地址，FPB 断点将永远无法命中（PC 是偶地址），resume 后会
    一直运行直到超时——这是 Step Over / Step Out "卡死"的根因。
    """
    lr = core.read_core_register('lr')
    return (lr & ~1) if lr else 0


def _call_return_address(pc: int) -> int:
    """BL/BLX 调用指令的返回地址。

    Cortex-M 的 BL / BLX 在执行时会把 LR 自动写为「当前指令地址 + 4」
    （即下一条指令）。因此无论该指令是断点停驻还是单步到达，只要 BL 尚未
    执行，其返回地址都恒等于 (pc & ~1) + 4。

    注意：不能读 LR 寄存器来求返回地址。当目标停在断点处时 BL 尚未执行，
    LR 仍是更早某次调用的陈旧返回值；用它设断点会导致 resume 后目标一路
    自由运行，直到命中其他用户断点或超时强制暂停，而不是停在调用点下一行
    ——这正是「Step Over 停在下一个断点而非下一行源码」的根因。
    """
    return (pc & ~1) + 4


def _step_over_current_breakpoint(core):
    """停在断点上时，临时移除当前 PC 的断点；返回恢复函数（无断点返回 None）。

    Cortex-M 停在断点上时，当前 PC 的那条指令尚未执行。若该断点仍武装，单步/resume
    时 FPB 会在该指令 fetch 阶段立即再次触发，导致 PC 永远停在原地、单步"无反应"。
    参照 GDB/Keil/Ozone 的通用做法：单步前先移除当前 PC 的断点，跨过指令后再装回。
    """
    pc = core.read_core_register('pc') & ~1
    if core.find_breakpoint(pc) is None:
        return None
    core.remove_breakpoint(pc)
    core.bp_manager.flush()

    def restore():
        core.set_breakpoint(pc)
        core.bp_manager.flush()

    return restore


def _step_source_into(core, session, uid: str, max_steps: int = _SOURCE_STEP_LIMIT) -> bool:
    """源码级 Step Into：单步执行直到 PC 进入下一条源代码行。

    进入被调函数时，被调函数首条语句所在行号与调用处不同，因此会自动停在函数体内。
    当前行无调试信息时回退为指令级单步（core.step）。
    以时间预算 + 步数上限双重约束，避免在慢速调试器上表现为卡死。

    关键点：只停在「有有效行号且与起始行不同」的地址。单步可能落到无 DWARF 行号
    的地址（分支、填充、或被调库函数内部），若在此停下会使 C 源码运行指示丢失
    （只剩汇编指示）。参照 GDB：无行号地址继续单步；调用一个无调试信息的函数时
    按 Step Over 跨过（GDB 对无调试信息的 step 等价于 next），避免一路单步进库函数。
    """
    restore = _step_over_current_breakpoint(core)
    try:
        start = _line_at(uid, _read_pc(core))
        if start is None:
            core.step()
            return True
        deadline = time.monotonic() + _STEP_TIME_BUDGET
        for _ in range(max_steps):
            if time.monotonic() > deadline:
                break
            pc = _read_pc(core)
            # 调用目标无调试信息 → 按 Step Over 跨过（在返回地址处暂停）
            if _is_call_instruction(core, pc):
                target = _call_target(core, pc)
                if target is not None and _line_at(uid, target) is None:
                    ret = _call_return_address(pc)
                    core.set_breakpoint(ret)
                    core.bp_manager.flush()
                    try:
                        if not _resume_to_return_ignore_others(session, ret):
                            _halt_core(core)
                            return False
                    finally:
                        core.remove_breakpoint(ret)
                        core.bp_manager.flush()
                    loc = _line_at(uid, _read_pc(core))
                    if loc is not None and loc != start:
                        return True
                    continue
            core.step()
            loc = _line_at(uid, _read_pc(core))
            # 无行号地址（分支/填充/库函数内部）不停留，继续单步到有效行
            if loc is not None and loc != start:
                return True
        return True
    finally:
        if restore is not None:
            restore()


def _step_source_over(core, session, uid: str, max_steps: int = _SOURCE_STEP_LIMIT) -> bool:
    """源码级 Step Over：执行到下一条源代码行；当前行内的函数调用整体跨过。

    遇到 BL/BLX 调用时，在 LR 处设临时断点并 resume，回到调用行后继续，
    直到 PC 进入新的源代码行。当前行无调试信息时回退为指令级 step over。
    """
    restore = _step_over_current_breakpoint(core)
    try:
        start = _line_at(uid, _read_pc(core))
        if start is None:
            return _step_over_out(core, session, 'over')
        deadline = time.monotonic() + _STEP_TIME_BUDGET
        for _ in range(max_steps):
            if time.monotonic() > deadline:
                break
            pc = _read_pc(core)
            if _is_call_instruction(core, pc):
                # 跨过整个函数调用：返回地址恒为 (pc & ~1)+4（BL/BLX 执行时硬件
                # 自动把 LR 写为下一指令地址）。不能读 LR——停在断点处时 BL 尚未
                # 执行，LR 是更早调用的陈旧返回地址，会导致 resume 后一路自由运行
                # 直到命中其他断点/超时（Step Over 失效的根因）。
                ret = _call_return_address(pc)
                core.set_breakpoint(ret)
                core.bp_manager.flush()
                try:
                    # 忽略期间命中的其他用户断点，只在返回地址 ret 处暂停
                    # （Keil/GDB Step Over 语义）
                    if not _resume_to_return_ignore_others(session, ret):
                        _halt_core(core)
                        return False
                finally:
                    core.remove_breakpoint(ret)
                    core.bp_manager.flush()
                loc = _line_at(uid, _read_pc(core))
                if loc is not None and loc != start:
                    return True
                continue
            core.step()
            loc = _line_at(uid, _read_pc(core))
            if loc is not None and loc != start:
                return True
        return True
    finally:
        if restore is not None:
            restore()


def _step_over_out(core, session, mode: str) -> bool:
    """执行 step over / step out（同步，在 to_thread 中运行）

    over: 当前指令为 BL/BLX 时，在返回地址 (pc & ~1)+4 处设临时断点并 resume；
          否则退化为单步（step）。
    out:  已进入函数内部，LR 即函数返回地址，在 LR 处设临时断点并 resume，
          执行完当前子程序后暂停。
    """
    restore = _step_over_current_breakpoint(core)
    try:
        ret = None
        if mode == 'over':
            pc = core.read_core_register('pc')
            if _is_call_instruction(core, pc):
                # 与源码级 Step Over 一致：返回地址取 (pc & ~1)+4 而非 LR
                # （停在断点处时 BL 未执行，LR 是陈旧返回值）
                ret = _call_return_address(pc)
            else:
                core.step()
                return True
        else:  # 'out'
            ret = _call_return_lr(core)

        if not ret:
            core.step()
            return True

        core.set_breakpoint(ret)
        core.bp_manager.flush()
        try:
            # 忽略期间命中的其他用户断点，只在返回地址 ret 处暂停
            return _resume_to_return_ignore_others(session, ret)
        finally:
            core.remove_breakpoint(ret)
            core.bp_manager.flush()
    finally:
        if restore is not None:
            restore()