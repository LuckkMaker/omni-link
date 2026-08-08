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
    """单步执行

    mode:
      - into: 进入（单步执行一条指令）
      - over: 跳过（若当前指令为 BL/BLX 调用，则执行完子程序返回后暂停；否则单步）
      - out:  跳出（执行完当前子程序，返回到调用者后暂停）
    """
    from core.monitor_backend import monitor_backend
    mode = req.mode
    session = backend._get_session(uid)
    if not session:
        raise HTTPException(status_code=400, detail="Probe not connected")
    target = session.target
    if not target.is_halted():
        raise HTTPException(status_code=400, detail="Target not halted")

    if mode == 'into':
        with monitor_backend.pause_during(uid):
            result = await asyncio.to_thread(commander_backend.execute, uid, "step")
        if not result["success"] and result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])
        return {"success": True, "mode": mode}

    core = target.selected_core_or_raise
    with monitor_backend.pause_during(uid):
        halted = await asyncio.to_thread(_step_over_out, core, session, mode)
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
        if mode == 'halt':
            result = await asyncio.to_thread(commander_backend.execute, uid, "reset halt")
            if not result["success"] and result.get("error"):
                # 兼容部分目标无 reset halt，改走 reset
                result = await asyncio.to_thread(commander_backend.execute, uid, "reset")
        else:
            # run / break_symbol：复位后继续运行
            result = await asyncio.to_thread(commander_backend.execute, uid, "reset")
        if not result["success"] and result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])

        if mode == 'break_symbol':
            # 设置入口断点并运行，直到命中
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
    """调用栈回溯（需目标暂停）：PC + LR + SP 栈扫描识别返回地址"""
    if not backend.is_connected(uid):
        raise HTTPException(status_code=400, detail="Probe not connected")
    session = backend._get_session(uid)
    if not session or not session.target.is_halted():
        raise HTTPException(status_code=400, detail="Target not halted")
    target = session.target
    try:
        pc = target.read_core_register("pc") & ~1
        sp = target.read_core_register("sp") & ~0x3
        lr = target.read_core_register("lr") & ~1
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Read registers failed: {e}")

    def resolve(addr: int):
        try:
            return elf_backend.resolve_address(uid, addr)
        except Exception:
            return None

    frames = []
    # 帧 0：当前 PC
    r0 = resolve(pc) or {"address": pc}
    r0["sp"] = sp
    frames.append(r0)

    # 帧 1：LR（若为有效函数内地址）
    if lr and lr != 0xfffffff9 and lr != 0xfffffff1:
        r = resolve(lr)
        if r:
            r["sp"] = None
            frames.append(r)

    # 从 SP 向上扫描栈字，识别落在函数区间内的返回地址
    try:
        stack_data = await asyncio.to_thread(backend.read_memory, uid, sp, min(1024, 64 * 4))
    except Exception:
        stack_data = b""
    for i in range(0, len(stack_data) - 3, 4):
        val = int.from_bytes(stack_data[i:i + 4], "little") & ~1
        if val == 0 or val == 0xfffffffe:
            continue
        if not elf_backend.is_function_address(uid, val):
            continue
        r = resolve(val)
        if not r or not r.get("function"):
            continue
        frames.append(r)
        if len(frames) >= 40:
            break

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


def _step_over_out(core, session, mode: str) -> bool:
    """执行 step over / step out（同步，在 to_thread 中运行）

    over: 当前指令为 BL/BLX 时，在 LR 处设临时断点并 resume；
          否则退化为单步（step）。
    out:  在 LR 处设临时断点并 resume，执行完当前子程序后暂停。
    """
    ret = None
    if mode == 'over':
        pc = core.read_core_register('pc')
        if _is_call_instruction(core, pc):
            ret = core.read_core_register('lr')
        else:
            core.step()
            return True
    else:  # 'out'
        ret = core.read_core_register('lr')

    if ret is None:
        core.step()
        return True

    core.set_breakpoint(ret)
    core.bp_manager.flush()
    try:
        return _resume_until_halted(session)
    finally:
        core.remove_breakpoint(ret)
        core.bp_manager.flush()