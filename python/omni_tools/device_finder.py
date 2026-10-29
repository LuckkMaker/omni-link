# OMNI Link - OMNI Tool 设备发现
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""按 VID/PID 枚举串口并识别 OMNI Tool 设备人格。

工具以 USB 复合设备形式工作，同一 VID ``0xC251``，靠 PID 区分人格：

- ``omni_tool_boot``：PID ``0x1000``，USB CDC 虚拟串口（Modbus RTU，大端）
- ``omni_tool_app`` ：PID ``0x1001``，CDC（命令口）+ WinUSB（CMSIS-DAP v2），自定义 64B 小端包
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

try:  # pyserial 为可选依赖：缺失时只做降级（枚举返回空），不阻断后端启动
    import serial.tools.list_ports as _list_ports
    SERIAL_AVAILABLE = True
except ImportError:  # pragma: no cover
    _list_ports = None
    SERIAL_AVAILABLE = False

# OMNI Tool 身份
OMNI_VID = 0xC251
BOOT_PID = 0x1000
APP_PID = 0x1001

# 人格标识
PERSONALITY_BOOT = "boot"
PERSONALITY_APP = "app"
PERSONALITY_UNKNOWN = "unknown"


def _personality(vid: Optional[int], pid: Optional[int]) -> str:
    """由 VID/PID 推断设备人格。"""
    if vid != OMNI_VID:
        return PERSONALITY_UNKNOWN
    if pid == BOOT_PID:
        return PERSONALITY_BOOT
    if pid == APP_PID:
        return PERSONALITY_APP
    return PERSONALITY_UNKNOWN


def list_ports() -> list[dict]:
    """列出全部串口及其 VID/PID 元数据。"""
    if not SERIAL_AVAILABLE:
        return []

    ports: list[dict] = []
    for p in _list_ports.comports():
        ports.append({
            "port": p.device,
            "vid": p.vid,
            "pid": p.pid,
            "personality": _personality(p.vid, p.pid),
            "serial_number": p.serial_number,
            "description": p.description,
            "product": p.product,
            "manufacturer": p.manufacturer,
        })
    return ports


def list_omni_devices() -> list[dict]:
    """只列出 OMNI Tool 设备（boot 或 app）。"""
    return [p for p in list_ports() if p["personality"] != PERSONALITY_UNKNOWN]


def find_by_personality(personality: str) -> Optional[dict]:
    """按人格查找首个匹配设备。"""
    for p in list_omni_devices():
        if p["personality"] == personality:
            return p
    return None


def describe(port: dict) -> str:
    """生成可读描述，用于日志。"""
    vid = port.get("vid")
    pid = port.get("pid")
    vid_pid = f"VID={vid:04X} PID={pid:04X}" if vid is not None and pid is not None else "VID/PID=?"
    return f"{port.get('port')} ({vid_pid}, {port.get('personality')})"