"""RTT Viewer REST API

对标 J-Link RTT Viewer，提供 RTT 会话的启动/停止、通道查询、数据发送接口。
"""

import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from core.rtt_backend import rtt_backend
from core.pyocd_backend import backend
from core.events import event_manager

router = APIRouter()

# RTT 启动超时（秒）。
# 外部工具（如 Keil MDK）下载固件后，pyOCD session 的底层 SWD 通信可能
# 处于异常状态，target.halt() 或内存读取会永久挂起。设此超时保护，
# 确保前端不会一直卡在"RTT会话启动中"。
RTT_START_TIMEOUT = 5.0


class RttStartRequest(BaseModel):
    """RTT 启动请求"""
    address: Optional[int] = None     # 控制块搜索起始地址（hex），None 则自动检测
    size: Optional[int] = None        # 搜索范围
    up_channel: int = 0               # 监听的 up channel（target -> host）
    down_channel: int = 0             # 发送的 down channel（host -> target）


class RttSendRequest(BaseModel):
    """RTT 发送数据请求"""
    data: str                         # base64 编码的原始字节数据
    channel: Optional[int] = None     # down channel 索引，None 则用启动时选中的


class RttSendTextRequest(BaseModel):
    """RTT 发送文本请求"""
    text: str
    channel: Optional[int] = None
    append_newline: bool = True       # 是否追加换行符


class RttDeviceResetRequest(BaseModel):
    """RTT 设备复位请求"""
    run: bool = True                   # reset 后是否自动运行


@router.get("/probes/{uid}/rtt/status")
def rtt_status(uid: str):
    """查询 RTT 状态"""
    return {
        "running": rtt_backend.is_running(uid),
        "connected": backend.is_connected(uid),
    }


@router.post("/probes/{uid}/rtt/start")
async def rtt_start(uid: str, req: RttStartRequest):
    """启动 RTT 会话

    在目标 RAM 中搜索 SEGGER RTT 控制块，解析通道，恢复目标运行并开始轮询。
    使用 async + asyncio.wait_for 包装，防止 SWD 通信挂起导致请求永不返回。
    """
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(
                rtt_backend.start,
                uid,
                address=req.address,
                size=req.size,
                up_channel=req.up_channel,
                down_channel=req.down_channel,
            ),
            timeout=RTT_START_TIMEOUT,
        )
    except asyncio.TimeoutError:
        # SWD 通信挂起（常见于外部工具如 Keil 下载后 session 状态异常）
        msg = (f"RTT 启动超时（{int(RTT_START_TIMEOUT)}秒）。"
               "可能是外部工具占用调试接口或 session 状态异常，"
               "请断开并重新连接仿真器后重试")
        event_manager.log("error", f"RTT: {msg}")
        event_manager.emit("rtt.error", {"uid": uid, "error": msg})
        raise HTTPException(status_code=408, detail=msg)

    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "RTT start failed"))
    return result


@router.post("/probes/{uid}/rtt/stop")
def rtt_stop(uid: str):
    """停止 RTT 会话"""
    return rtt_backend.stop(uid)


@router.get("/probes/{uid}/rtt/channels")
def rtt_channels(uid: str):
    """获取 RTT 通道信息"""
    result = rtt_backend.get_channels(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "RTT not started"))
    return result


@router.post("/probes/{uid}/rtt/send")
def rtt_send(uid: str, req: RttSendRequest):
    """发送二进制数据到 down channel"""
    import base64
    try:
        data = base64.b64decode(req.data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 data")
    result = rtt_backend.send(uid, data, req.channel)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Send failed"))
    return result


@router.post("/probes/{uid}/rtt/send-text")
def rtt_send_text(uid: str, req: RttSendTextRequest):
    """发送文本数据到 down channel"""
    result = rtt_backend.send_text(uid, req.text, req.channel, req.append_newline)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Send failed"))
    return result


# ── 目标设备控制（Run/Halt/Reset）─────────────────────────
# 直接操作 CPU 内核状态，不影响 RTT 轮询线程。
# 复位时会重新搜索 RTT 控制块，确保复位后数据流恢复正常。

@router.post("/probes/{uid}/rtt/device/run")
def rtt_device_run(uid: str):
    """运行目标内核（resume）"""
    result = rtt_backend.run_target(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Run failed"))
    return result


@router.post("/probes/{uid}/rtt/device/halt")
def rtt_device_halt(uid: str):
    """暂停目标内核（halt）"""
    result = rtt_backend.halt_target(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Halt failed"))
    return result


@router.post("/probes/{uid}/rtt/device/reset")
def rtt_device_reset(uid: str, req: RttDeviceResetRequest):
    """复位目标芯片并重新初始化 RTT 控制块"""
    result = rtt_backend.reset_target(uid, run=req.run)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Reset failed"))
    return result


@router.get("/probes/{uid}/rtt/device/state")
def rtt_device_state(uid: str):
    """查询目标内核状态（running/halted）"""
    return rtt_backend.get_core_state(uid)
