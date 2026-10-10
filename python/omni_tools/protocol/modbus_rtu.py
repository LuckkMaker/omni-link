# OMNI Link - OMNI Tool boot Modbus RTU
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""Modbus RTU 组帧 + CRC16 + 事务收发（boot IAP 通道）。

移植自固件侧参考实现 ``omni_tool_boot/boot_iap_test.py``（已实机验证）。
多字节字段一律 **大端 BE**。
"""

import struct

from omni_tools.protocol.serial_link import SerialLink

UNIT_ID = 1
BAUDRATE = 115200

# 功能码
FC_DOWNLOAD = 0x65
FC_UPLOAD = 0x66
FC_CONTROL = 0x67
FC_GET_INFO = 0x68

# FC103 子功能
SUB_SET_ADDR = 0x01
SUB_ERASE = 0x02
SUB_LEAVE = 0x03

# 单帧数据上限（boot 侧 MODBUS_PDU_DATA_MAX_LEN=252）
FC101_MAX_DATA = 244  # 252-6=246，4 字节对齐后 244
FC102_MAX_DATA = 248  # 252-4=248

# 响应 PDU 长度（不含 unit_id/fc/crc）
FC101_RESP_LEN = 6    # 4B addr + 2B written_len
FC104_RESP_LEN = 16   # 4B version + 12B MCU UID


class IAPError(Exception):
    """IAP 通讯/协议错误。"""


def crc16_modbus(data: bytes) -> int:
    """Modbus RTU CRC16（poly 0xA001，init 0xFFFF）。"""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc


def build_frame(fc: int, payload: bytes, unit_id: int = UNIT_ID) -> bytes:
    frame = bytes([unit_id, fc]) + payload
    return frame + struct.pack("<H", crc16_modbus(frame))


class ModbusRTU:
    """在一段串口连接上执行 Modbus RTU 事务。"""

    # 等待首个响应字节的超时（F407 擦除一个扇区需 1~2s，需留足余量）
    RESP_FIRST_BYTE_TIMEOUT = 5.0
    # 帧内字节间空闲超时（用于读满整帧）
    INTER_BYTE_TIMEOUT = 0.05

    def __init__(self, link: SerialLink, unit_id: int = UNIT_ID):
        self.link = link
        self.unit_id = unit_id

    @staticmethod
    def _expected_frame_len(fc: int, payload: bytes) -> int:
        """计算期望响应帧总字节数（unit + fc + pdu + crc）。无法预测时返回 0。"""
        if fc == FC_DOWNLOAD:
            return 1 + 1 + FC101_RESP_LEN + 2
        if fc == FC_UPLOAD:
            read_len = struct.unpack(">H", payload[4:6])[0]
            return 1 + 1 + 4 + read_len + 2
        if fc == FC_CONTROL:
            return 1 + 1 + 6 + 2
        if fc == FC_GET_INFO:
            return 1 + 1 + FC104_RESP_LEN + 2
        return 0

    def _recv_frame(self, expect_len: int) -> bytes:
        """读取一帧响应；长度可预测时按固定长度精确读取。"""
        first = self.link.read(1, timeout=self.RESP_FIRST_BYTE_TIMEOUT)
        if not first:
            return b""
        if expect_len > 1:
            rest = self.link.read_exact(expect_len - 1, timeout=self.INTER_BYTE_TIMEOUT)
            return first + rest
        return first

    def transact(self, fc: int, payload: bytes) -> bytes:
        """发送请求并接收响应，返回 PDU 数据（不含 unit_id/fc/crc）。"""
        frame = build_frame(fc, payload, self.unit_id)
        self.link.reset_input_buffer()
        self.link.write(frame)

        resp = self._recv_frame(self._expected_frame_len(fc, payload))
        if len(resp) < 4:
            raise IAPError(
                f"FC{fc:02X} 无响应或响应太短 ({len(resp)} bytes)。"
                "请确认已进入 bootloader 模式且串口正确"
            )

        rfc = resp[1]
        crc = struct.unpack("<H", resp[-2:])[0]
        if crc != crc16_modbus(resp[:-2]):
            raise IAPError(f"FC{fc:02X} 响应 CRC 校验失败")

        if rfc == (fc | 0x80):
            exc = resp[2] if len(resp) > 2 else 0
            raise IAPError(f"FC{fc:02X} Modbus 异常响应, 异常码 0x{exc:02X}")
        if rfc != fc:
            raise IAPError(f"FC{fc:02X} 功能码不匹配: 期望 0x{fc:02X}, 收到 0x{rfc:02X}")

        return resp[2:-2]