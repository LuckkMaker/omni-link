"""RTT Viewer REST API

对标 J-Link RTT Viewer，提供 RTT 会话的启动/停止、通道查询、数据发送接口。
"""

import asyncio
import base64
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
#
# 预算核算（实测，CMSIS-DAP v2 @1MHz SWD，192KB RAM = CCMRAM 64KB + SRAM 128KB）：
#   - 每 16KB block32 读约 0.55s，即约 28KB/s（受探针每字 ~0.13ms 限制）
#   - region 起始 16KB 快速探测：                    ~0.6s
#   - 一次复位+等待固件初始化：                       ~1.3s
#   - 一次全 RAM 扫描（192KB）：                      ~6.6s
#   - 最坏路径 = 探测 + 复位 + 全扫 + 复位 + 全扫 ≈ 16s
# 所以 15s 会在"确实需要全扫 + 两次复位重试"时提前掐断：后端仍在正常工作，
# 前端却收到 408"启动超时"，日志里还会看到"已找到控制块"与超时并存。
# 正常路径（ELF 符号命中或控制块在 .bss 前部）是亚秒级，这里只是兜底上限。
RTT_START_TIMEOUT = 30.0

# 设备复位超时（秒）。复位仅 halt + reset +（可选）resume，
# 正常情况下 1~2s 完成；此处用于防止 J-Link 等探针 reset 期间 SWD 挂起。
# 小于前端 rttService.deviceReset 的 axios timeout（20s），确保后端先返回明确的 408。
RTT_DEVICE_RESET_TIMEOUT = 12.0


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
    """查询 RTT 状态（含上行缓存统计，便于 CLI/CI 诊断丢包）"""
    return {
        "running": rtt_backend.is_running(uid),
        "connected": backend.is_connected(uid),
        "capture": rtt_backend.get_capture_stats(uid),
    }


@router.post("/probes/{uid}/rtt/start")
async def rtt_start(uid: str, req: RttStartRequest):
    """启动 RTT 会话

    在目标 RAM 中搜索 SEGGER RTT 控制块，解析通道，恢复目标运行并开始轮询。
    使用 async + asyncio.wait_for 包装，防止 SWD 通信挂起导致请求永不返回。

    超时后不仅返回 408，还会给后端的启动流程发取消令牌：否则那个 to_thread
    线程会继续扫描，稍后把会话装上去并推送 rtt.started——前端已经显示"启动
    失败"，后端却在跑，随后的 Stop/Start 状态完全错乱（实机报告）。
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
        cancelled = await asyncio.to_thread(rtt_backend.cancel_start, uid, "timeout")
        msg = (f"RTT 启动超时（{int(RTT_START_TIMEOUT)}秒）。"
               "可能是外部工具占用调试接口或 session 状态异常，"
               "请断开并重新连接仿真器后重试")
        if cancelled:
            msg += "；已取消后台仍在进行的启动"
        event_manager.log("error", f"RTT: {msg}")
        event_manager.emit("rtt.error", {"uid": uid, "error": msg})
        raise HTTPException(status_code=408, detail=msg)

    if result.get("cancelled"):
        raise HTTPException(status_code=409, detail=result.get("error") or "RTT 启动已取消")
    if result.get("busy"):
        raise HTTPException(status_code=409, detail=result.get("error") or "RTT 启动进行中")
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "RTT start failed"))
    return result


@router.post("/probes/{uid}/rtt/stop")
async def rtt_stop(uid: str):
    """停止 RTT 会话（同时取消仍在进行的启动）

    stop 会等待轮询线程退出（最多 1s），放线程池执行避免阻塞事件循环。
    """
    return await asyncio.to_thread(rtt_backend.stop, uid)


@router.get("/probes/{uid}/rtt/channels")
def rtt_channels(uid: str):
    """获取 RTT 通道信息"""
    result = rtt_backend.get_channels(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "RTT not started"))
    return result


@router.get("/probes/{uid}/rtt/data")
def rtt_data(
    uid: str,
    since: int = 0,
    max_bytes: int = 65536,
    channel: Optional[int] = None,
):
    """增量读取 RTT up channel 数据（REST 出口，与 WebSocket 共用同一份环形缓存）。

    - ``since=0``：从当前最旧可用块开始；CLI ``--follow`` 用上一次返回的 ``cursor`` 续读。
    - ``max_bytes``：单次字节预算（按整块返回，不拆块，因此可能略超）。
    - ``lost=true``：请求的 ``since`` 已被环形缓存覆盖，部分历史数据丢失。
    - ``session_reset=true``：``since`` 超出当前后端进程的 RTT 序号（后端重启后 seq
      从 1 开始），本次已从当前最旧数据重读。同一后端进程内 seq 跨 ``rtt start``
      单调递增，旧游标可以继续使用。
    - ``text``：把本次返回的块按 UTF-8（非法字节替换）解码后的文本，便于 `curl` / 简单断言；
      需要无损数据时用 ``chunks[].data``（base64）。
    """
    result = rtt_backend.read_capture(uid, since=since, max_bytes=max_bytes, channel=channel)
    if not result["success"]:
        raise HTTPException(status_code=404, detail=result.get("error"))
    raw = b"".join(base64.b64decode(chunk["data"]) for chunk in result.get("chunks", []))
    result["text"] = raw.decode("utf-8", "replace")
    return result


@router.post("/probes/{uid}/rtt/send")
def rtt_send(uid: str, req: RttSendRequest):
    """发送二进制数据到 down channel"""
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
# 直接操作 CPU 内核状态（仅芯片复位），不影响 RTT 轮询线程，不做 RTT 控制块重搜。

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
async def rtt_device_reset(uid: str, req: RttDeviceResetRequest):
    """仅复位目标芯片（run=True 时复位后运行固件）

    与 rtt_start 一致，用 async + asyncio.wait_for 保护，防止 J-Link 等探针在
    reset 期间 SWD 偶发挂起导致 endpoint 永不返回、前端收到无响应的
    "Network Error"。超时转为明确的 408 提示。
    """
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(rtt_backend.reset_target, uid, run=req.run),
            timeout=RTT_DEVICE_RESET_TIMEOUT,
        )
    except asyncio.TimeoutError:
        msg = (f"RTT 复位超时（{int(RTT_DEVICE_RESET_TIMEOUT)}秒）。"
               "可能是外部工具占用调试接口或 session 状态异常，"
               "请断开并重新连接仿真器后重试")
        event_manager.log("error", f"RTT: {msg}")
        raise HTTPException(status_code=408, detail=msg)

    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error") or "Reset failed")
    return result


@router.get("/probes/{uid}/rtt/device/state")
def rtt_device_state(uid: str):
    """查询目标内核状态（running/halted）"""
    return rtt_backend.get_core_state(uid)
