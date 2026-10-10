# OMNI Link - OMNI Tool boot IAP 语义封装
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""boot IAP 通道语义封装（FC101 下载 / FC102 上传 / FC103 控制 / FC104 信息）。

移植自 ``omni_tool_boot/boot_iap_test.py``，保留其帧结构与超时策略：
地址/长度 4 字节对齐；单帧下载 ≤ 244B、读取 ≤ 248B；擦除一次只擦一个扇区（1~2s）。
"""

import struct
from typing import Callable, Optional

from omni_tools.protocol.modbus_rtu import (
    FC101_MAX_DATA,
    FC102_MAX_DATA,
    FC104_RESP_LEN,
    FC_CONTROL,
    FC_DOWNLOAD,
    FC_GET_INFO,
    FC_UPLOAD,
    SUB_ERASE,
    SUB_LEAVE,
    SUB_SET_ADDR,
    IAPError,
    ModbusRTU,
)

# 进度回调：on_progress(stage, current, total, message)
ProgressCallback = Optional[Callable[[str, int, int, str], None]]

APP_DEFAULT_ADDRESS = 0x08010000
APP_END_ADDRESS = 0x080E0000
FLASH_WRITE_ALIGN = 4

# F407 app 区扇区表（boot 的 FC103 ERASE 一次只擦一个扇区）
F407_APP_SECTORS = [
    (0x08010000, 64 * 1024),
    (0x08020000, 128 * 1024),
    (0x08040000, 128 * 1024),
    (0x08060000, 128 * 1024),
    (0x08080000, 128 * 1024),
    (0x080A0000, 128 * 1024),
    (0x080C0000, 128 * 1024),
]


def _emit(cb: ProgressCallback, stage: str, current: int, total: int, message: str) -> None:
    if cb is not None:
        cb(stage, current, total, message)


class BootIAP:
    """boot IAP 操作集。"""

    def __init__(self, modbus: ModbusRTU):
        self.mb = modbus

    # ---- FC103 控制 ----
    def _control(self, sub: int, data: int) -> tuple[int, int]:
        payload = struct.pack(">HI", sub, data)
        resp = self.mb.transact(FC_CONTROL, payload)
        if len(resp) != 6:
            raise IAPError(f"FC103 响应长度错误: {len(resp)}")
        return struct.unpack(">HI", resp)

    def set_addr(self, addr: int) -> int:
        rsub, rdata = self._control(SUB_SET_ADDR, addr)
        return rdata

    def erase(self, addr: int) -> int:
        rsub, rdata = self._control(SUB_ERASE, addr)
        return rdata

    def leave(self) -> int:
        rsub, rdata = self._control(SUB_LEAVE, 0)
        return rdata

    def ping(self) -> int:
        return self.set_addr(APP_DEFAULT_ADDRESS)

    # ---- FC104 信息 ----
    def get_info(self) -> tuple[int, str]:
        """读取 boot 版本（uint32 BE）与 MCU UID（12B BE，十六进制字符串）。"""
        resp = self.mb.transact(FC_GET_INFO, b"")
        if len(resp) != FC104_RESP_LEN:
            raise IAPError(f"FC104 响应长度错误: 期望 {FC104_RESP_LEN}, 收到 {len(resp)}")
        ver = struct.unpack(">I", resp[:4])[0]
        uid = resp[4:].hex().upper()
        return ver, uid

    # ---- 擦除 ----
    @staticmethod
    def sectors_for_range(addr: int, length: int) -> list[tuple[int, int]]:
        """返回与 [addr, addr+length) 相交的扇区列表。"""
        end = addr + length
        sel = []
        for base, size in F407_APP_SECTORS:
            if base < end and (base + size) > addr:
                sel.append((base, size))
        return sel

    def erase_sectors(
        self, sectors: list[tuple[int, int]], on_progress: ProgressCallback = None
    ) -> None:
        total = len(sectors)
        for i, (base, size) in enumerate(sectors):
            _emit(on_progress, "erase", i, total, f"擦除扇区 0x{base:08X} ({size // 1024}KB)")
            self.erase(base)
        _emit(on_progress, "erase", total, total, "擦除完成")

    def erase_app(self, on_progress: ProgressCallback = None) -> None:
        self.erase_sectors(F407_APP_SECTORS, on_progress)

    # ---- FC101 下载 ----
    def download(self, data: bytes, addr: int, on_progress: ProgressCallback = None) -> None:
        if addr % FLASH_WRITE_ALIGN != 0:
            raise IAPError(f"地址 0x{addr:08X} 未 4 字节对齐")
        if addr < APP_DEFAULT_ADDRESS or addr + len(data) > APP_END_ADDRESS:
            raise IAPError(f"地址范围越界: 0x{addr:08X} + {len(data)}")

        # 末块补齐 4 字节对齐（擦除后 flash 为 0xFF）
        if len(data) % FLASH_WRITE_ALIGN != 0:
            data = data + b"\xFF" * (FLASH_WRITE_ALIGN - len(data) % FLASH_WRITE_ALIGN)

        total = len(data)
        pos = 0
        while pos < total:
            chunk = data[pos:pos + FC101_MAX_DATA]
            if len(chunk) % FLASH_WRITE_ALIGN != 0:
                chunk = chunk + b"\xFF" * (FLASH_WRITE_ALIGN - len(chunk) % FLASH_WRITE_ALIGN)

            payload = struct.pack(">IH", addr + pos, len(chunk)) + chunk
            resp = self.mb.transact(FC_DOWNLOAD, payload)
            if len(resp) != 6:
                raise IAPError(f"FC101 响应长度错误: {len(resp)}")
            raddr, rlen = struct.unpack(">IH", resp)
            if raddr != addr + pos or rlen != len(chunk):
                raise IAPError(
                    f"FC101 响应不匹配: 期望 addr=0x{addr + pos:08X} len={len(chunk)}, "
                    f"收到 addr=0x{raddr:08X} len={rlen}"
                )
            pos += len(chunk)
            _emit(on_progress, "download", pos, total, f"下载 {pos}/{total} bytes")

    # ---- FC102 上传 ----
    def upload(self, addr: int, length: int, on_progress: ProgressCallback = None, stage: str = "verify") -> bytes:
        """分块回读（FC102）。

        ``stage`` 用于进度上报的阶段标签：升级闭环内为 ``verify``（回读校验），
        单独回读时由调用方传入 ``read_back`` 以便前端区分。
        """
        result = bytearray()
        pos = 0
        while pos < length:
            n = min(FC102_MAX_DATA, length - pos)
            payload = struct.pack(">IH", addr + pos, n)
            resp = self.mb.transact(FC_UPLOAD, payload)
            if len(resp) != 4 + n:
                raise IAPError(f"FC102 响应长度错误: 期望 {4 + n}, 收到 {len(resp)}")
            raddr = struct.unpack(">I", resp[:4])[0]
            if raddr != addr + pos:
                raise IAPError(f"FC102 响应地址不匹配: 期望 0x{addr + pos:08X}, 收到 0x{raddr:08X}")
            result.extend(resp[4:])
            pos += n
            _emit(on_progress, stage, pos, length, f"回读 {pos}/{length} bytes")
        return bytes(result)

    # ---- 校验 ----
    def verify(self, data: bytes, addr: int, on_progress: ProgressCallback = None) -> tuple[bool, Optional[int]]:
        """读回逐字节比对。返回 (是否一致, 首个不一致偏移)。"""
        readback = self.upload(addr, len(data), on_progress)
        if readback == data:
            return True, None
        for i, (a, b) in enumerate(zip(readback, data)):
            if a != b:
                return False, i
        return False, min(len(readback), len(data))