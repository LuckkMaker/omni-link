"""Flash 操作 API 路由"""

import asyncio
import contextlib
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from core.pyocd_backend import backend
from core.events import event_manager
from core.monitor_backend import monitor_backend
from core.rtt_backend import rtt_backend

router = APIRouter()

# 同一探针同一时刻只允许一个 Flash 操作。
# HTTP 客户端超时后，后端线程仍在执行；若用户此时重试，两个操作会并发操作同一个
# target（擦除/烧录互相破坏）。这里让新请求立刻返回 409，而不是排队到同样的超时。
_flash_busy: set[str] = set()
_flash_busy_guard = asyncio.Lock()
# 等待调试协调锁（commander/寄存器读取/RTT 轮询共用）的秒数
FLASH_LOCK_TIMEOUT = 10.0


class EraseRequest(BaseModel):
    type: str = "chip"  # "chip" | "sector" | "sector_range"
    address: int = 0
    size: int = 0


class ProgramRequest(BaseModel):
    file_path: str = ""
    data: str = ""  # base64 编码的数据（与 file_path 二选一）
    verify: bool = True
    reset: bool = True
    base_address: int | None = None


class VerifyRequest(BaseModel):
    file_path: str = ""
    data: str = ""  # base64 编码的数据（与 file_path 二选一）
    base_address: int | None = None


class ResetRequest(BaseModel):
    type: str = "hw"  # "hw" | "sw"
    run: bool = True


class BlankCheckRequest(BaseModel):
    address: int | None = None
    size: int | None = None


class ReadBackRequest(BaseModel):
    type: str = "chip"  # "chip" | "range"
    address: int = 0
    size: int = 0
    output_path: str = ""


class FillMemoryRequest(BaseModel):
    address: int
    size: int
    value: int = 0xFF  # 填充字节 (0-255)


async def _stop_rtt_for_flash(uid: str) -> bool:
    """Flash 操作前停止 RTT 轮询。

    Flash 算法运行期间需要独占 SWD：RTT 每 10ms 的读会拖慢擦除（实测 1MB 全片擦除
    约 16s），还可能与 Flash 算法并发访问 target。之前只在 ``rtt_backend.stop()``
    的注释里预留了 ``reason="flash"``，却没有调用方，用户必须手动先 ``rtt stop``。
    """
    if not rtt_backend.is_running(uid):
        return False
    await asyncio.to_thread(rtt_backend.stop, uid, "flash")
    event_manager.log("info", "RTT: 已在 Flash 操作前自动停止（Flash 算法需要独占 SWD）")
    return True


@contextlib.asynccontextmanager
async def _flash_operation(uid: str, stop_rtt: bool = True):
    """串行化同一探针的 Flash 操作，并按需暂停 Monitor / 停止 RTT。"""
    async with _flash_busy_guard:
        if uid in _flash_busy:
            raise HTTPException(
                status_code=409,
                detail=("已有 Flash 操作正在进行（上一次可能仍未结束）。请等待其完成；"
                        "若命令已超时可执行 `omni backend stop` 后重启后端。"),
            )
        _flash_busy.add(uid)

    # 与 commander 调试命令、寄存器读取互斥：Flash 算法运行期间不应有其它 SWD 操作。
    # 用非阻塞加锁 + 异步重试（而不是在线程里阻塞 acquire）：请求被取消时不会留下
    # “幽灵线程稍后拿到锁却无人释放”的死锁。
    op_lock = backend.get_op_lock(uid)
    deadline = time.monotonic() + FLASH_LOCK_TIMEOUT
    while not op_lock.acquire(blocking=False):
        if time.monotonic() >= deadline:
            async with _flash_busy_guard:
                _flash_busy.discard(uid)
            raise HTTPException(
                status_code=409,
                detail=(f"调试操作仍在进行（等待 {int(FLASH_LOCK_TIMEOUT)} 秒未释放），"
                        "请等当前调试命令结束或先执行 `omni debug run` 后重试。"),
            )
        await asyncio.sleep(0.05)

    state = {"rtt_stopped": False}
    try:
        if stop_rtt:
            state["rtt_stopped"] = await _stop_rtt_for_flash(uid)
        with monitor_backend.pause_during(uid):
            yield state
    finally:
        try:
            op_lock.release()
        except RuntimeError:
            pass
        async with _flash_busy_guard:
            _flash_busy.discard(uid)


def _flash_payload(result, state: dict, omit_zero_written: bool = False) -> dict:
    payload = result.to_payload(omit_zero_written=omit_zero_written)
    payload["rtt_stopped"] = bool(state.get("rtt_stopped"))
    return payload


@router.post("/probes/{uid}/flash/erase")
async def erase_flash(uid: str, req: EraseRequest):
    """擦除 Flash

    响应使用 ``bytes_erased``（erase 不写 Flash）；``rtt_stopped=true`` 表示操作前
    自动停止了 RTT 会话，需要时请重新 ``omni rtt start``。
    """
    async with _flash_operation(uid) as state:
        result = await asyncio.to_thread(backend.erase, uid, req.type, req.address, req.size)
    return _flash_payload(result, state, omit_zero_written=True)


@router.post("/probes/{uid}/flash/program")
async def program_flash(uid: str, req: ProgramRequest):
    """烧录固件（支持文件路径或 base64 数据）"""
    async with _flash_operation(uid) as state:
        result = await asyncio.to_thread(
            backend.program, uid, req.file_path, req.verify, req.reset, req.base_address, req.data
        )
    payload = _flash_payload(result, state)
    event_manager.emit("flash.complete", payload)
    return payload


@router.post("/probes/{uid}/flash/verify")
async def verify_flash(uid: str, req: VerifyRequest):
    """校验 Flash 内容（支持文件路径或 base64 数据）

    校验不写 Flash，响应使用 ``bytes_verified`` 而不是 ``bytes_written``（P3-1）。
    """
    async with _flash_operation(uid) as state:
        result = await asyncio.to_thread(backend.verify, uid, req.file_path, req.data, req.base_address)
    return _flash_payload(result, state, omit_zero_written=True)


@router.post("/probes/{uid}/flash/blank-check")
async def blank_check(uid: str, req: BlankCheckRequest):
    """检查 Flash 是否为空白"""
    async with _flash_operation(uid) as state:
        result = await asyncio.to_thread(backend.check_blank, uid, req.address, req.size)
    result["rtt_stopped"] = bool(state.get("rtt_stopped"))
    return result


@router.post("/probes/{uid}/flash/read")
async def read_flash(uid: str, req: ReadBackRequest):
    """读取 Flash 内容，返回 base64 数据"""
    async with _flash_operation(uid) as state:
        result = await asyncio.to_thread(
            backend.read_back, uid, req.type, req.address, req.size, req.output_path
        )
    result["rtt_stopped"] = bool(state.get("rtt_stopped"))
    return result


@router.post("/probes/{uid}/reset")
async def reset_target(uid: str, req: ResetRequest):
    """复位目标（与 Flash 操作串行，但不停止 RTT；RTT 会在复位后自动恢复）"""
    async with _flash_operation(uid, stop_rtt=False):
        success = await asyncio.to_thread(backend.reset, uid, req.type, req.run)
    return {"success": success}


@router.post("/probes/{uid}/flash/cancel")
async def cancel_flash_operation(uid: str):
    """取消正在进行的 Flash 操作"""
    backend.cancel_operation()
    return {"success": True}


@router.post("/probes/{uid}/flash/fill")
async def fill_memory(uid: str, req: FillMemoryRequest):
    """填充内存区域（支持 Flash 和 RAM）

    注意：当前前端 Fill Memory 功能已改为纯前端数据操作（仅在数据 Tab 中填充），
    不再调用此后端接口。此路由保留供未来可能的直接设备填充用途。
    """
    async with _flash_operation(uid) as state:
        result = await asyncio.to_thread(
            backend.fill_memory, uid, req.address, req.size, req.value
        )
    payload = _flash_payload(result, state)
    event_manager.emit("flash.complete", payload)
    return payload
