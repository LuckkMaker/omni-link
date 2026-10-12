# OMNI Link - OMNI Tool 会话编排
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""OMNI Tool 会话编排：持有串口连接、按设备人格选择协议，并推送进度/日志。

单功能互斥：boot 与 app 是同一物理工具的两套固件人格，同一时刻只持有一条连接。
"""

import base64
import os
import threading
import time
from typing import NamedTuple, Optional

from core.events import event_manager

from omni_tools import device_finder
from omni_tools.device_finder import PERSONALITY_APP, PERSONALITY_BOOT, PERSONALITY_UNKNOWN
from omni_tools.protocol.app_cmd import FLASH_MAX_PAYLOAD, AppCmd, AppCmdError
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

# 在线烧录各阶段占整体进度的权重（base, span）
# 整片擦除最慢（固件预算 180s），故占比最大。
_FLASHER_STAGE_SPAN = {
    "mode": (0.00, 0.02),
    "open": (0.02, 0.03),
    "erase": (0.05, 0.45),
    "write": (0.50, 0.30),
    "verify": (0.80, 0.18),
    "close": (0.98, 0.02),
}

# 目标侧等待预算（秒）——对应固件 Kconfig CONFIG_FLASHER_*_TIMEOUT_MS，
# 上位机略留余量，保证固件先回错误而不是上位机先超时。
# 整片擦除固件预算 180s，但实际可能更久（1MB/2MB 擦除本身要十几秒起），
# 这里给足 240s，避免上位机先放弃而固件还在擦。
_FLASH_MODE_TIMEOUT = 10.0
_FLASH_HALT_TIMEOUT = 5.0
_FLASH_PROGRAM_TIMEOUT = 15.0
_FLASH_ERASE_CHIP_TIMEOUT = 240.0


class FlasherTarget(NamedTuple):
    """在线烧录支持的目标芯片。

    固件 ``FLASHER_PLAN`` 阶段 B（在线下发 FLM）尚未实现，FLM 由固件内置，
    因此目标表只覆盖固件硬编码的型号。后续接入在线 FLM 后在此追加即可。
    """

    name: str
    base: int
    end: int


FLASHER_TARGETS = (
    FlasherTarget("stm32f407ig", 0x08000000, 0x08100000),
)


def _weighted(stage: str, current: int, total: int, table: dict) -> float:
    """按分段权重累计出整体百分比。"""
    base, span = table.get(stage, (0.0, 0.0))
    frac = (current / total) if total > 0 else 1.0
    frac = max(0.0, min(1.0, frac))
    return round((base + span * frac) * 100, 1)


def _percent(stage: str, current: int, total: int) -> float:
    """升级闭环内各阶段的整体百分比（按分段权重累计）。"""
    base, span = _STAGE_SPAN.get(stage, (0.0, 0.0))
    frac = (current / total) if total > 0 else 1.0
    frac = max(0.0, min(1.0, frac))
    return round((base + span * frac) * 100, 1)


def _percent_standalone(current: int, total: int) -> float:
    """单步操作（Verify / Read Back）的百分比：独立走 0~100%，不复用升级分段权重。

    否则独立校验只会落在 67%~98% 区间，既到不了 100%，也会与升级进度混淆。
    """
    frac = (current / total) if total > 0 else 1.0
    frac = max(0.0, min(1.0, frac))
    return round(frac * 100, 1)


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

    # ---- 在线烧录（app 作为 CMSIS-DAP / SWD 探针，烧外部目标 MCU） ----
    def flasher_status(self) -> dict:
        """查询在线烧录可用性：需连接 app 人格设备。"""
        with self._lock:
            return {
                "available": self._app is not None,
                "personality": self._personality,
                "port": self._port,
                "max_payload": FLASH_MAX_PAYLOAD,
                "targets": [t.name for t in FLASHER_TARGETS],
            }

    def flasher_flash(
        self,
        file_path: str,
        address: Optional[int] = None,
        target: str = "stm32f407ig",
        erase: bool = True,
        verify: bool = True,
    ) -> dict:
        """在线烧录外部目标：MODE(FLASHER) -> OPEN -> (ERASE) -> WRITE -> CLOSE
        -> 重 OPEN -> READ 校验 -> CLOSE -> MODE(DAP)。

        进度经 WebSocket ``omni_tool.progress`` 推送。
        """
        app = self._require_app()

        flash = next((t for t in FLASHER_TARGETS if t.name == target), None)
        if flash is None:
            raise OmniToolError(f"不支持的目标型号: {target}")

        # 目标镜像按「地址 + 数据」载入；.hex 自带地址，.bin 取指定/该型号 Flash 起点
        data, addr = self._load_firmware(file_path, address, flash.base)
        if addr < flash.base or addr + len(data) > flash.end:
            raise OmniToolError(
                f"镜像超出 {flash.name} Flash 区: 0x{addr:08X}+{len(data)} "
                f"∉ 0x{flash.base:08X}~0x{flash.end:08X}"
            )

        def report(stage: str, current: int, total: int, message: str) -> None:
            event_manager.emit("omni_tool.progress", {
                "stage": stage,
                "message": message,
                "current": current,
                "total": total,
                "percent": _weighted(stage, current, total, _FLASHER_STAGE_SPAN),
            })

        with self._lock:
            if self._busy:
                raise OmniToolError("已有操作正在进行")
            self._busy = True
            name = os.path.basename(file_path)
            session_opened = False
            try:
                event_manager.log("info", f"[OMNI Tool] 开始在线烧录 {name} "
                                          f"({len(data)} bytes @ 0x{addr:08X})")

                # 1) 切换 FLASHER 模式：固件执行 swd_init() 连接目标
                report("mode", 0, 0, "切换 FLASHER 模式")
                app.mode_flasher(_FLASH_MODE_TIMEOUT)

                # 2) 开启会话：halt 目标 + 装载 FLM
                report("open", 0, 0, "开启烧写会话")
                app.flash_open(_FLASH_HALT_TIMEOUT)
                session_opened = True

                # 3) 可选整片擦除（必须在 WRITE 之前，绕过懒擦除记账）
                if erase:
                    report("erase", 0, 0, "整片擦除（可能需数十秒）")
                    app.flash_erase_chip(_FLASH_ERASE_CHIP_TIMEOUT)

                # 4) 分块写入（≤56B/包；FLASH_MANAGER 内部做扇区懒擦除）
                report("write", 0, len(data), "写入目标 Flash")
                written = 0
                while written < len(data):
                    chunk = data[written:written + FLASH_MAX_PAYLOAD]
                    app.flash_write(addr + written, chunk, _FLASH_PROGRAM_TIMEOUT)
                    written += len(chunk)
                    report("write", written, len(data), f"已写入 {written}/{len(data)}")

                # 5) 关闭会话：刷残留缓冲 + 复位目标运行
                report("close", 0, 0, "关闭烧写会话")
                app.flash_close(_FLASH_HALT_TIMEOUT)
                session_opened = False

                # 6) 回读校验：CLOSE 后目标在 RUN 态无法回读，必须重 OPEN 重新 halt
                verified = False
                first_mismatch: Optional[int] = None
                if verify:
                    report("verify", 0, len(data), "重新开启会话以回读校验")
                    app.flash_open(_FLASH_HALT_TIMEOUT)
                    session_opened = True
                    read_total = 0
                    while read_total < len(data):
                        want = min(FLASH_MAX_PAYLOAD, len(data) - read_total)
                        chunk = data[read_total:read_total + want]
                        got = app.flash_read(addr + read_total, want, _FLASH_PROGRAM_TIMEOUT)
                        if got != chunk:
                            for i, (g, w) in enumerate(zip(got, chunk)):
                                if g != w:
                                    first_mismatch = read_total + i
                                    break
                            break
                        read_total += want
                        report("verify", read_total, len(data), f"已校验 {read_total}/{len(data)}")
                    verified = first_mismatch is None and read_total >= len(data)
                    app.flash_close(_FLASH_HALT_TIMEOUT)
                    session_opened = False
                    if verified:
                        event_manager.log("info", "[OMNI Tool] 回读校验通过")
                    else:
                        where = (f"0x{addr + first_mismatch:08X}"
                                 if first_mismatch is not None else "?")
                        event_manager.log("error", f"[OMNI Tool] 回读校验失败 @ {where}")

                # 7) 交还 SWD 给 DAP，避免占用调试链路
                report("close", 0, 0, "切回 DAP 模式")
                app.mode_dap(_FLASH_MODE_TIMEOUT)

                if first_mismatch is not None:
                    raise OmniToolError(
                        f"回读校验失败（首个不一致位置 0x{addr + first_mismatch:08X}）"
                    )

                event_manager.log("info", "[OMNI Tool] 在线烧录完成")
                return {
                    "success": True,
                    "verified": verified,
                    "address": addr,
                    "size": len(data),
                    "message": "在线烧录完成",
                }
            except Exception:
                # 失败即作废会话并重建 SWD 链路，让用户能直接重试而不必重插。
                # 这里吞掉清场异常：不能因清场失败而盖掉真正的烧录错误。
                if session_opened:
                    try:
                        app.flash_recover(_FLASH_HALT_TIMEOUT)
                    except Exception:  # noqa: BLE001
                        pass
                try:
                    app.mode_dap(_FLASH_MODE_TIMEOUT)
                except Exception:  # noqa: BLE001
                    pass
                raise
            finally:
                self._busy = False

    def flasher_recover(self) -> dict:
        """显式恢复：作废会话 + 硬复位目标 + 重建 SWD 链路 + 放开运行。

        仅在设备处于 FLASHER 模式时有意义：烧录失败会自动清场并切回 DAP，
        此时手动 RECOVER 会收到固件的 ``ENODEV``（Flasher 未激活），属预期。
        """
        with self._lock:
            app = self._require_app()
            try:
                app.flash_recover(_FLASH_HALT_TIMEOUT)
            except AppCmdError as e:
                if "0x13" in str(e):
                    raise OmniToolError(
                        "设备当前不在 FLASHER 模式（ENODEV），无需恢复。"
                        "烧录失败时已自动清场，可直接重新烧录"
                    ) from e
                raise
            event_manager.log("info", "[OMNI Tool] 已执行 RECOVER，目标已复位并重建 SWD 链路")
            return {"success": True, "message": "已恢复，可重新开始烧录"}

    # ---- 升级（完整闭环） ----
    def upgrade(self, file_path: str, address: Optional[int] = None) -> dict:
        """执行 boot 自升级：SET_ADDR -> ERASE -> DOWNLOAD -> VERIFY -> LEAVE。

        校验失败**不执行** LEAVE（避免跳转到不完整镜像）。
        """
        if self._boot is None:
            raise OmniToolError("当前设备不是 bootloader（请先进入 boot 模式并连接 boot 串口）")

        data, addr = self._load_firmware(file_path, address)
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
            data, addr = self._load_firmware(file_path, address)
            self._validate_range(data, addr)
            boot.download(data, addr, self._report)
            return {"success": True, "address": addr, "size": len(data)}

    def verify(self, file_path: str, address: Optional[int] = None) -> dict:
        with self._lock:
            boot = self._require_boot()
            data, addr = self._load_firmware(file_path, address)
            self._validate_range(data, addr)
            ok, offset = boot.verify(data, addr, self._report_standalone)
            return {"verified": ok, "offset": offset, "address": addr, "size": len(data)}

    def read_back(self, address: Optional[int] = None, size: Optional[int] = None) -> dict:
        """回读设备 Flash，返回 base64 数据与地址（不落盘）。"""
        with self._lock:
            boot = self._require_boot()
            addr = address if address is not None else APP_DEFAULT_ADDRESS
            length = size if size is not None else 0
            if length <= 0:
                raise OmniToolError("请指定回读长度（size > 0）")
            if length % FLASH_WRITE_ALIGN != 0:
                raise OmniToolError(f"回读长度 {length} 未 4 字节对齐")
            if addr % FLASH_WRITE_ALIGN != 0:
                raise OmniToolError(f"起始地址 0x{addr:08X} 未 4 字节对齐")
            if addr < APP_DEFAULT_ADDRESS or addr + length > APP_END_ADDRESS:
                raise OmniToolError(
                    f"回读范围越界（App 区 0x{APP_DEFAULT_ADDRESS:08X}~0x{APP_END_ADDRESS:08X}）"
                )
            data = boot.upload(addr, length, self._report_standalone, stage="read_back")
            return {
                "success": True,
                "address": addr,
                "size": length,
                "data": base64.b64encode(data).decode("ascii"),
            }

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

    @staticmethod
    def _report_standalone(stage: str, current: int, total: int, message: str) -> None:
        """单步操作的进度上报：百分比独立走 0~100%。"""
        event_manager.emit("omni_tool.progress", {
            "stage": stage,
            "message": message,
            "current": current,
            "total": total,
            "percent": _percent_standalone(current, total),
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

    def _require_app(self) -> AppCmd:
        """取 app 命令通道；boot 设备无法烧外部目标（在线烧录只走 app 人格）。"""
        self._require_link()
        if self._app is None:
            raise OmniToolError("在线烧录需连接 app 模式的 OMNI Tool（当前设备是 bootloader）")
        return self._app

    @staticmethod
    def _load_firmware(
        file_path: str,
        addr: Optional[int] = None,
        default_address: int = APP_DEFAULT_ADDRESS,
    ) -> tuple[bytes, int]:
        """读取固件镜像，返回 ``(数据, 实际起始地址)``。

        - ``.bin``：不含地址，起始地址取 ``addr``（缺省 ``default_address``）
        - ``.hex``：Intel HEX 自带地址；未显式指定 ``addr`` 时采用文件内的起始地址
          （忽略 HEX 里可能高于 App 区起点的 vector table 偏移，保证写入 App 区）

        ``default_address`` 区分两种用途：boot 自升级用 App 区起点，
        在线烧录外部目标用目标芯片的 Flash 起点。
        """
        if not file_path or not os.path.exists(file_path):
            raise OmniToolError(f"固件文件不存在: {file_path}")
        ext = os.path.splitext(file_path)[1].lower()

        if ext == ".hex":
            # 延迟导入：复用 files 模块的 HEX 解析，保证与前端预览结果一致
            from api.files import parse_intel_hex

            parsed = parse_intel_hex(file_path)
            raw = parsed.get("data", b"")
            file_base = parsed.get("base_address", 0) or 0
            if addr is not None and addr > 0:
                # 显式指定地址：以文件内容为基准整体平移
                shift = addr - file_base
                data = (b"\xFF" * shift + raw) if shift > 0 else raw[-shift:]
            else:
                data = raw
            target = addr if (addr is not None and addr > 0) else file_base
        elif ext == ".bin":
            with open(file_path, "rb") as f:
                data = f.read()
            target = addr if addr is not None else default_address
        else:
            raise OmniToolError(f"仅支持 .bin / .hex 文件，当前: {ext or '无后缀'}")

        if not data:
            raise OmniToolError("固件文件为空")
        return data, target

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