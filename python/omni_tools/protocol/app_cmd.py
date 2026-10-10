# OMNI Link - OMNI Tool app 命令通道
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""app 64B 小端命令通道（INFO / MODE）。

协议见 ``omni_tool_app/docs/HOST_COMMANDS.md`` v0.2：

- 请求 ``[0]=命令ID``，其后字段随命令而定；多字节字段 **小端 LE**。
- INFO 响应 ``[0]=0x00 [1]=长度 [2..]=数据``（注意 ``[1]`` 是长度，不是状态码）。
- MODE 响应 ``[0]=0x01 [1]=状态码``（``0x00`` 成功）。
- ``MODE(BOOT=0xFF)`` 写 magic 后立即复位，**不回包**，须按"无响应 = 成功进入 boot"处理。
"""

import struct
from typing import Optional

from omni_tools.protocol.serial_link import SerialLink

# 命令 ID
CMD_INFO = 0x00
CMD_MODE = 0x01
CMD_INVALID = 0xFF

# INFO 子项
INFO_VENDOR = 0x01
INFO_PRODUCT = 0x02
INFO_SER_NUM = 0x03
INFO_FW_VER = 0x04
INFO_CAPABILITIES = 0xF0
INFO_PACKET_COUNT = 0xFE
INFO_PACKET_SIZE = 0xFF

# MODE 目标
MODE_NONE = 0x00
MODE_UART = 0x01
MODE_DAP = 0x02
MODE_FLASHER = 0x03
MODE_BOOT = 0xFF

# 能力位
CAP_GPIO = 1 << 0
CAP_UART = 1 << 1

# errno -> 名称（固件 omni/errno.h 取值，非 Linux）
ERRNO_NAME = {
    0x00: "OK",
    0x05: "EIO",
    0x13: "ENODEV",
    0x16: "EINVAL",
    0x74: "ETIMEDOUT",
    0x78: "EALREADY",
    0x86: "ENOTSUP",
}


def errno_str(status: int) -> str:
    return f"0x{status:02X} ({ERRNO_NAME.get(status, '?')})"


class AppCmdError(Exception):
    """app 命令通道通讯/协议错误。"""


def _decode_str(raw: bytes) -> str:
    """解码固件返回的字符串（含结尾 ``\\0``，容忍非法字节）。"""
    return raw.decode("utf-8", "ignore").rstrip("\x00")


class AppCmd:
    """app 命令通道客户端。"""

    def __init__(self, link: SerialLink, timeout: float = 1.0):
        self.link = link
        self.timeout = timeout

    # ---- 底层 ----
    def _send(self, payload: bytes) -> None:
        self.link.reset_input_buffer()
        self.link.write(bytes(payload))

    def info(self, info_id: int) -> bytes:
        """执行 INFO 子项读取，返回数据段。"""
        self._send(bytes([CMD_INFO, info_id]))
        head = self.link.read_exact(2, timeout=self.timeout)
        if len(head) < 2:
            raise AppCmdError("INFO 无响应（设备可能不在命令模式或已被占用）")
        if head[0] == CMD_INVALID:
            raise AppCmdError("当前固件不支持该 INFO 子项")
        if head[0] != CMD_INFO:
            raise AppCmdError(f"INFO 响应异常 (id=0x{head[0]:02X})")
        length = head[1]
        if length == 0:
            return b""
        data = self.link.read_exact(length, timeout=self.timeout)
        if len(data) < length:
            raise AppCmdError(f"INFO 数据不完整: 期望 {length} 字节, 收到 {len(data)}")
        return data

    def mode(self, target: int) -> int:
        """切换模式，返回状态码（0 = 成功）。"""
        self._send(bytes([CMD_MODE, target]))
        head = self.link.read_exact(2, timeout=self.timeout)
        if len(head) < 2:
            raise AppCmdError("MODE 无响应")
        if head[0] == CMD_INVALID:
            raise AppCmdError("当前固件不支持 MODE 命令")
        if head[0] != CMD_MODE:
            raise AppCmdError(f"MODE 响应异常 (id=0x{head[0]:02X})")
        return head[1]

    def mode_boot(self) -> None:
        """写 magic 并软复位进 bootloader（固件不回包，随后 USB 重新枚举）。"""
        self._send(bytes([CMD_MODE, MODE_BOOT]))

    # ---- 语义封装 ----
    def read_device_info(self) -> dict:
        """读取厂商/产品/序列号/固件版本/能力/包参数。

        单点失败不致命：序列号（固件为 TODO）与能力位（当前 0x00 0x00）允许缺省。
        """
        vendor = _decode_str(self.info(INFO_VENDOR))
        product = _decode_str(self.info(INFO_PRODUCT))
        fw_ver = _decode_str(self.info(INFO_FW_VER))

        serial_number = ""
        try:
            serial_number = _decode_str(self.info(INFO_SER_NUM))
        except AppCmdError:
            serial_number = ""

        capabilities: Optional[int] = None
        try:
            capabilities = struct.unpack("<H", self.info(INFO_CAPABILITIES).ljust(2, b"\x00"))[0]
        except AppCmdError:
            capabilities = None

        packet_size: Optional[int] = None
        try:
            packet_size = struct.unpack("<H", self.info(INFO_PACKET_SIZE).ljust(2, b"\x00"))[0]
        except AppCmdError:
            packet_size = None

        packet_count: Optional[int] = None
        try:
            data = self.info(INFO_PACKET_COUNT)
            packet_count = data[0] if data else None
        except AppCmdError:
            packet_count = None

        return {
            "vendor": vendor,
            "product": product,
            "serial_number": serial_number,
            "fw_ver": fw_ver,
            "capabilities": capabilities,
            "packet_size": packet_size,
            "packet_count": packet_count,
        }