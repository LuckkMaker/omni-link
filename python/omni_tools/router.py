# OMNI Link - OMNI Tool REST API
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""OMNI Tool 路由（前缀 /api/omni-tool）。

所有串口操作都在工作线程执行（``asyncio.to_thread``），避免阻塞事件循环导致
WebSocket 进度无法推送、HTTP 请求无法取消。

端点覆盖：扫描 / 连接 / 读信息 / 进入 boot / 擦除 / 下载 / 校验 / 跳转 / 一键升级。
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from omni_tools.protocol.app_cmd import AppCmdError
from omni_tools.protocol.modbus_rtu import IAPError
from omni_tools.protocol.serial_link import SerialLinkError
from omni_tools.session import OmniToolError, session

logger = logging.getLogger(__name__)
router = APIRouter()

# 可预期的操作类错误统一返回 400，附带可读 detail
_EXPECTED = (OmniToolError, SerialLinkError, IAPError, AppCmdError)


def _fail(e: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(e))


class ConnectRequest(BaseModel):
    port: str


class EraseRequest(BaseModel):
    address: Optional[int] = None
    full: bool = False


class PathRequest(BaseModel):
    file_path: str
    address: Optional[int] = None


class UpgradeRequest(BaseModel):
    file_path: str
    address: Optional[int] = None


class ReadBackRequest(BaseModel):
    address: Optional[int] = None
    size: Optional[int] = None


@router.get("/omni-tool/devices")
async def list_devices():
    """扫描串口，标注 OMNI Tool 设备人格（boot/app）。"""
    return await asyncio.to_thread(session.scan)


@router.get("/omni-tool/state")
async def get_state():
    """当前会话状态（连接/端口/人格/忙）。"""
    return session.state()


@router.post("/omni-tool/connect")
async def connect(req: ConnectRequest):
    try:
        return await asyncio.to_thread(session.connect, req.port)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool connect failed")
        raise HTTPException(status_code=500, detail=f"连接失败: {e}")


@router.post("/omni-tool/disconnect")
async def disconnect():
    return await asyncio.to_thread(session.disconnect)


@router.get("/omni-tool/info")
async def read_info():
    """读取设备信息：boot 返回版本 + MCU UID；app 返回厂商/产品/版本/能力/包参数。"""
    try:
        return await asyncio.to_thread(session.read_info)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool read info failed")
        raise HTTPException(status_code=500, detail=f"读取信息失败: {e}")


@router.post("/omni-tool/enter-boot")
async def enter_boot():
    """app 一键进入 bootloader（MODE_BOOT，写 magic + 软复位，固件不回包）。"""
    try:
        return await asyncio.to_thread(session.enter_boot)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool enter boot failed")
        raise HTTPException(status_code=500, detail=f"进入 boot 失败: {e}")


@router.post("/omni-tool/erase")
async def erase(req: EraseRequest):
    """擦除：给定 address 擦其所在扇区；full=true 擦整个 App 区。"""
    try:
        return await asyncio.to_thread(session.erase, req.address, req.full)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool erase failed")
        raise HTTPException(status_code=500, detail=f"擦除失败: {e}")


@router.post("/omni-tool/download")
async def download(req: PathRequest):
    """下载 .bin 到指定地址（默认 0x08010000）。"""
    try:
        return await asyncio.to_thread(session.download, req.file_path, req.address)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool download failed")
        raise HTTPException(status_code=500, detail=f"下载失败: {e}")


@router.post("/omni-tool/verify")
async def verify(req: PathRequest):
    """回读校验，返回首个不一致偏移。"""
    try:
        return await asyncio.to_thread(session.verify, req.file_path, req.address)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool verify failed")
        raise HTTPException(status_code=500, detail=f"校验失败: {e}")


@router.post("/omni-tool/leave")
async def leave():
    """下发 LEAVE，跳转到 app。"""
    try:
        return await asyncio.to_thread(session.leave)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool leave failed")
        raise HTTPException(status_code=500, detail=f"跳转失败: {e}")


@router.post("/omni-tool/read-back")
async def read_back(req: ReadBackRequest):
    """回读设备 Flash（FC102），返回 base64 数据与地址，不落盘。"""
    try:
        return await asyncio.to_thread(session.read_back, req.address, req.size)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool read back failed")
        raise HTTPException(status_code=500, detail=f"回读失败: {e}")


@router.post("/omni-tool/upgrade")
async def upgrade(req: UpgradeRequest):
    """一键升级完整闭环：SET_ADDR -> ERASE -> DOWNLOAD -> VERIFY -> LEAVE。

    校验失败不执行 LEAVE。进度经 WebSocket ``omni_tool.progress`` 推送。
    """
    try:
        return await asyncio.to_thread(session.upgrade, req.file_path, req.address)
    except _EXPECTED as e:
        raise _fail(e)
    except Exception as e:  # noqa: BLE001
        logger.exception("omni-tool upgrade failed")
        raise HTTPException(status_code=500, detail=f"升级失败: {e}")


def cleanup() -> None:
    """lifespan 关闭时释放串口。"""
    try:
        session.disconnect()
    except Exception:
        pass