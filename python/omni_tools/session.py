# OMNI Link - OMNI Tool 会话编排
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""OMNI Tool 会话编排：持有串口连接、按设备人格选择协议，并推送进度/日志。

单功能互斥：boot 与 app 是同一物理工具的两套固件人格，同一时刻只持有一条连接。
"""

import os
import threading
import time
from typing import Optional

from core.events import event_manager

from omni_tools import device_finder
from omni_tools.device_finder import PERSONALITY_APP, PERSONALITY_BOOT, PERSONALITY_UNKNOWN
from omni_tools.protocol.app_cmd import AppCmd
from omni_tools.protocol.boot_iap import (
    APP_DEFAULT_ADDRESS,
    APP_END_ADDRESS,
    F407_APP_SECTORS,
    FLASH_WRITE_ALIGN,
    BootIAP,
)
from omni_tools.protocol.modbus_rtu import BAUDRATE, ModbusRTU
from omni_tools.protocol.serial_link import SerialLink


class OmniToolError(Exception):
    """OMNI Tool 操作错误（对外暴露为 HTTP 400）。"""


# 升级流程各阶段占整体进度的权重（base, span）
_STAGE_SPAN = {
    "info": (0.00, 0.01),
    "set_addr": (0.01, 0.01),
    "erase": (0.02, 0.20),
    "download": (0.22, 0.45),
    "verify": (0.67, 0.31),
    "leave": (0.98, 0.02),
}


def _percent(stage: str, current: int, total: int) -> float:
    base, span = _STAGE_SPAN.get(stage, (0.0, 0.0))
    frac = (current / total) if total > 0 else 1.0
    frac = max(0.0, min(1.0, frac))
    return round((base + span * frac) * 100, 1)


class OmniToolSession:
    """全局单例：维护当前工具连接。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._link: Optional[SerialLink] = None
        self._port: Optional[str] = None
        self._personality: str = PERSONALITY_UNKNOWN
        self._boot: Optional[BootIAP] = None
        self._app: Optional[AppCmd] = None
        self._busy: bool = False

    # ---- 查询 ----
    @property
    def connected(self) -> bool:
        return self._link is not None and self._link.is_open

    def state(self) -> dict:
        with self._lock:
            return {
                "connected": self.connected,
                "port": self._port,
                "personality": self._personality,
                "busy": self._busy,
            }

    def scan(self) -> dict:
        devices = device_finder.list_ports()
        return {
            "serial_available": device_finder.SERIAL_AVAILABLE,
            "devices": devices,
            "omni_devices": [d for d in devices if d["personality"] != PERSONALITY_UNKNOWN],
        }

    # ---- 连接 ----
    def connect(self, port: str) -> dict:
        with self._lock:
            self._disconnect_locked()
            match = next((p for p in device_finder.list_ports() if p["port"] == port), None)
            personality = match["personality"] if match else PERSONALITY_UNKNOWN

            link = SerialLink(port, BAUDRATE)
            link.open()
            self._link = link
            self._port = port
            self._personality = personality

            if personality == PERSONALITY_BOOT:
                self._boot = BootIAP(ModbusRTU(link))
                self._app = None
            else:
                # unknown 也按 app 处理：VID/PID 缺失时仍可尝试命令通道
                self._app = AppCmd(link)
                self._boot = None

            event_manager.log("info", f"[OMNI Tool] 已连接 {device_finder.describe(match or {'port': port})}")
            return self.state()

    def disconnect(self) -> dict:
        with self._lock:
            self._disconnect_locked()
            return self.state()

    def _disconnect_locked(self) -> None:
        if self._link is not None:
            try:
                self._link.close()
            except Exception:
                pass
        self._link = None
        self._port = None
        self._personality = PERSONALITY_UNKNOWN
        self._boot = None
        self._app = None

    # ---- 读信息 ----
    def read_info(self) -> dict:
        with self._lock:
            self._require_link()
            if self._boot is not None:
                ver, uid = self._boot.get_info()
                return {
                    "personality": PERSONALITY_BOOT,
                    "port": self._port,
                    "boot_version": ver,
                    "boot_version_str": f"V{(ver >> 16) & 0xFFFF}.{ver & 0xFFFF:02d}",
                    "mcu_uid": uid,
                }
            assert self._app is not None
            info = self._app.read_device_info()
            info.update({"personality": PERSONALITY_APP, "port": self._port})
            return info

    # ---- app -> boot ----
    def enter_boot(self) -> dict:
        """对 app 下发 MODE_BOOT：写 magic + 软复位（固件不回包）。"""
        with self._lock:
            if self._boot is not None:
                raise OmniToolError("当前设备已处于 bootloader 模式")
            if self._app is None:
                raise OmniToolError("未连接设备")

            self._app.mode_boot()
            # 给设备留出接收该包并执行复位的时间，避免过早关闭端口导致 OUT 传输被取消
            time.sleep(0.3)
            event_manager.log("info", "[OMNI Tool] 已下发 MODE_BOOT，等待设备重新枚举为 boot (PID 0x1000)")
            # 设备即将复位，端口将消失；主动关闭以避免占用
            self._disconnect_locked()
            return {"success": True, "message": "已进入 bootloader，等待重新枚举"}

    # ---- 升级（完整闭环） ----
    def upgrade(self, file_path: str, address: Optional[int] = None) -> dict:
        """执行 boot 自升级：SET_ADDR -> ERASE -> DOWNLOAD -> VERIFY -> LEAVE。

        校验失败**不执行** LEAVE（避免跳转到不完整镜像）。
        """
        if self._boot is None:
            raise OmniToolError("当前设备不是 bootloader（请先进入 boot 模式并连接 boot 串口）")

        addr = address if address is not None else APP_DEFAULT_ADDRESS
        data = self._load_bin(file_path)
        self._validate_range(data, addr)

        def report(stage: str, current: int, total: int, message: str) -> None:
            event_manager.emit("omni_tool.progress", {
                "stage": stage,
                "message": message,
                "current": current,
                "total": total,
                "percent": _percent(stage, current, total),
            })

        with self._lock:
            if self._busy:
                raise OmniToolError("已有升级操作正在进行")
            self._busy = True
            try:
                event_manager.log("info", f"[OMNI Tool] 开始升级: {os.path.basename(file_path)} "
                                          f"({len(data)} bytes @ 0x{addr:08X})")
                report("set_addr", 0, 0, f"设置跳转地址 0x{addr:08X}")
                self._boot.set_addr(addr)

                sectors = BootIAP.sectors_for_range(addr, len(data))
                self._boot.erase_sectors(sectors, report)

                self._boot.download(data, addr, report)

                ok, offset = self._boot.verify(data, addr, report)
                if not ok:
                    where = f"0x{addr + offset:08X}" if offset is not None else "?"
                    event_manager.log("error", f"[OMNI Tool] 校验失败 @ {where}，已中止跳转")
                    raise OmniToolError(f"回读校验失败（首个不一致位置 {where}），未执行跳转")

                report("leave", 0, 0, "校验通过，跳转到 app")
                self._boot.leave()
                event_manager.log("info", "[OMNI Tool] 升级完成，已下发 LEAVE，设备将跳转并重新枚举")
                return {
                    "success": True,
                    "verified": True,
                    "address": addr,
                    "size": len(data),
                    "message": "升级完成，设备将跳转并重新枚举为 app (PID 0x1001)",
                }
            finally:
                self._busy = False

    # ---- 细粒度操作（供高级/手动流程） ----
    def erase(self, address: Optional[int] = None, full: bool = False) -> dict:
        """擦除扇区：给定 address 擦其所在扇区，full=True 或未给地址则擦整个 App 区。"""
        with self._lock:
            boot = self._require_boot()
            if full or address is None:
                if not full:
                    raise OmniToolError("请指定 address 或 full=true")
                sectors = list(F407_APP_SECTORS)
            else:
                sectors = BootIAP.sectors_for_range(address, 1)
                if not sectors:
                    raise OmniToolError(f"地址 0x{address:08X} 不在 App 区扇区表内")
            boot.erase_sectors(sectors, self._report)
            return {"success": True, "sectors": [base for base, _ in sectors]}

    def download(self, file_path: str, address: Optional[int] = None) -> dict:
        with self._lock:
            boot = self._require_boot()
            addr = address if address is not None else APP_DEFAULT_ADDRESS
            data = self._load_bin(file_path)
            self._validate_range(data, addr)
            boot.download(data, addr, self._report)
            return {"success": True, "address": addr, "size": len(data)}

    def verify(self, file_path: str, address: Optional[int] = None) -> dict:
        with self._lock:
            boot = self._require_boot()
            addr = address if address is not None else APP_DEFAULT_ADDRESS
            data = self._load_bin(file_path)
            self._validate_range(data, addr)
            ok, offset = boot.verify(data, addr, self._report)
            return {"verified": ok, "offset": offset, "address": addr, "size": len(data)}

    def leave(self) -> dict:
        with self._lock:
            boot = self._require_boot()
            target = boot.leave()
            return {"success": True, "address": target}

    @staticmethod
    def _report(stage: str, current: int, total: int, message: str) -> None:
        event_manager.emit("omni_tool.progress", {
            "stage": stage,
            "message": message,
            "current": current,
            "total": total,
            "percent": _percent(stage, current, total),
        })

    # ---- 内部工具 ----
    def _require_link(self) -> None:
        if not self.connected:
            raise OmniToolError("未连接设备")

    def _require_boot(self) -> BootIAP:
        self._require_link()
        if self._boot is None:
            raise OmniToolError("当前设备不是 bootloader")
        return self._boot

    @staticmethod
    def _load_bin(file_path: str) -> bytes:
        if not file_path or not os.path.exists(file_path):
            raise OmniToolError(f"固件文件不存在: {file_path}")
        ext = os.path.splitext(file_path)[1].lower()
        if ext != ".bin":
            raise OmniToolError(f"仅支持 .bin 文件，当前: {ext or '无后缀'}")
        with open(file_path, "rb") as f:
            data = f.read()
        if not data:
            raise OmniToolError("固件文件为空")
        return data

    @staticmethod
    def _validate_range(data: bytes, addr: int) -> None:
        if addr % FLASH_WRITE_ALIGN != 0:
            raise OmniToolError(f"起始地址 0x{addr:08X} 未 4 字节对齐")
        if addr < APP_DEFAULT_ADDRESS or addr >= APP_END_ADDRESS:
            raise OmniToolError(
                f"起始地址 0x{addr:08X} 越界（App 区 0x{APP_DEFAULT_ADDRESS:08X}~0x{APP_END_ADDRESS:08X}）"
            )
        if addr + len(data) > APP_END_ADDRESS:
            raise OmniToolError(
                f"镜像超出 App 区: 0x{addr:08X}+{len(data)} > 0x{APP_END_ADDRESS:08X}"
            )


# 全局单例
session = OmniToolSession()