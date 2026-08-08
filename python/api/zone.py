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
async def zone_step(uid: str):
    """单步执行"""
    from core.monitor_backend import monitor_backend
    with monitor_backend.pause_during(uid):
        result = await asyncio.to_thread(commander_backend.execute, uid, "step")
    if not result["success"] and result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return {"success": True}


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
async def zone_reset(uid: str):
    """复位目标并暂停"""
    from core.monitor_backend import monitor_backend
    with monitor_backend.pause_during(uid):
        result = await asyncio.to_thread(commander_backend.execute, uid, "reset halt")
        if not result["success"] and result.get("error"):
            # 兼容部分目标无 reset halt，改走 reset
            result = await asyncio.to_thread(commander_backend.execute, uid, "reset")
    if not result["success"] and result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return {"success": True}


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
    """已加载 ELF 的源文件列表"""
    with elf_backend._lock:
        entry = elf_backend._entries.get(uid)
    if not entry:
        raise HTTPException(status_code=400, detail="No ELF loaded")
    files = elf_backend._collect_source_files(entry["decoder"])
    return {"success": True, "files": files}


@router.get("/probes/{uid}/zone/source/line")
async def zone_source_line(uid: str, address: int):
    """PC 地址 → 源码位置"""
    result = elf_backend.get_line_for_address(uid, address)
    return {"success": result is not None, "line": result}


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