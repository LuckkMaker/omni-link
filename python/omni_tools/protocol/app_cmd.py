# OMNI Link - OMNI Tool app 命令通道
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""app 64B 小端命令通道（INFO / MODE / FLASH）。

协议见 ``omni_tool_app/docs/HOST_COMMANDS.md`` v0.2：

- 请求 ``[0]=命令ID``，其后字段随命令而定；多字节字段 **小端 LE**。
- INFO 响应 ``[0]=0x00 [1]=长度 [2..]=数据``（注意 ``[1]`` 是长度，不是状态码）。
- MODE 响应 ``[0]=0x01 [1]=状态码``（``0x00`` 成功）。
- FLASH 响应 ``[0]=0x20 [1]=状态码``，``READ`` 额外在 ``[2..]`` 追加数据。
- ``MODE(BOOT=0xFF)`` 写 magic 后立即复位，**不回包**，须按"无响应 = 成功进入 boot"处理。
"""

import struct
from typing import Optional

from omni_tools.protocol.serial_link import SerialLink

# 命令 ID
CMD_INFO = 0x00
CMD_MODE = 0x01
CMD_FLASH = 0x20
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

# FLASH 子命令
FLASH_OPEN = 0x00
FLASH_WRITE = 0x01
FLASH_ERASE_CHIP = 0x02
FLASH_CLOSE = 0x03
FLASH_READ = 0x04
FLASH_RECOVER = 0x05
# 模式 B（镜像型，协议 v0.3）：地址由固件从文件内容解析，主机只递文件字节
FLASH_OPEN_IMAGE = 0x06
FLASH_IMAGE_DATA = 0x07
FLASH_IMAGE_VERIFY = 0x08

# 单包负载上限：64B 包头占 [0]=cmd [1]=op [2..5]=addr [6..7]=size，共 8 字节
FLASH_MAX_PAYLOAD = 64 - 8
# 模式 B 无地址字段，头占 [0]=cmd [1]=op [2..3]=len 共 4 字节，故比模式 A 多 4 字节
FLASH_MAX_IMAGE_PAYLOAD = 64 - 4

# 能力位
CAP_GPIO = 1 << 0
CAP_UART = 1 << 1

# errno -> 名称（固件 omni/errno.h 取值，非 Linux）
# 0x4D/0x8A 为 v0.3 模式 B 新增：把"文件有问题"与"链路有问题"分开
ERRNO_NAME = {
    0x00: "OK",
    0x05: "EIO",
    0x13: "ENODEV",
    0x16: "EINVAL",
    0x4D: "EBADMSG",
    0x74: "ETIMEDOUT",
    0x78: "EALREADY",
    0x86: "ENOTSUP",
    0x8A: "EILSEQ",
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

    def mode(self, target: int, timeout: Optional[float] = None) -> int:
        """切换模式，返回状态码（0 = 成功）。

        ``timeout`` 用于需要更长的操作（如 ``MODE(FLASHER)`` 内部执行
        ``svc_flasher_start`` → ``swd_init()`` 连接目标，不是瞬时返回）。
        """
        self._send(bytes([CMD_MODE, target]))
        head = self.link.read_exact(2, timeout=timeout or self.timeout)
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

    # ---- FLASH（在线烧录，经 SWD 烧写外部目标 MCU） ----
    def _flash(self, op: int, payload: bytes = b"", timeout: Optional[float] = None) -> int:
        """下发 FLASH 子命令，返回状态码（0 = 成功）。

        响应固定 2 字节（``READ`` 由 :meth:`flash_read` 单独处理）。
        """
        self._send(bytes([CMD_FLASH, op]) + payload)
        head = self.link.read_exact(2, timeout=timeout or self.timeout)
        if len(head) < 2:
            raise AppCmdError("FLASH 无响应（设备可能已离线或不在 FLASHER 模式）")
        if head[0] == CMD_INVALID:
            raise AppCmdError("当前固件不支持 FLASH 命令")
        if head[0] != CMD_FLASH:
            raise AppCmdError(f"FLASH 响应异常 (id=0x{head[0]:02X})")
        return head[1]

    @staticmethod
    def _check(status: int, op_name: str) -> None:
        """非零状态码转成可读异常。"""
        if status != 0:
            raise AppCmdError(f"FLASH {op_name} 失败: {errno_str(status)}")

    def mode_flasher(self, timeout: float) -> None:
        """切换到 FLASHER 模式（执行 ``svc_flasher_start`` → SWD 连接目标）。"""
        self._check(self.mode(MODE_FLASHER, timeout=timeout), "MODE(FLASHER)")

    def mode_dap(self, timeout: Optional[float] = None) -> None:
        """切换回 DAP（调试）模式，释放 SWD 给 omni-link 的 DAP 链路。"""
        self._check(self.mode(MODE_DAP, timeout=timeout), "MODE(DAP)")

    def flash_open(self, timeout: float) -> None:
        """开启烧写会话：目标 halt + 装载 FLM + flash_manager 初始化。"""
        self._check(self._flash(FLASH_OPEN, timeout=timeout), "OPEN")

    def flash_erase_chip(self, timeout: float) -> None:
        """整片擦除（只能在 ``OPEN`` 之后、``WRITE`` 之前）。"""
        self._check(self._flash(FLASH_ERASE_CHIP, timeout=timeout), "ERASE")

    def flash_close(self, timeout: float) -> None:
        """结束会话：刷残留缓冲 + 复位目标运行。"""
        self._check(self._flash(FLASH_CLOSE, timeout=timeout), "CLOSE")

    def flash_recover(self, timeout: float) -> None:
        """清场恢复：作废会话 + 硬复位目标 + 重建 SWD 链路 + 放开运行。"""
        self._check(self._flash(FLASH_RECOVER, timeout=timeout), "RECOVER")

    def flash_write(self, addr: int, data: bytes, timeout: float) -> None:
        """写入一块（``len(data)`` ≤ :data:`FLASH_MAX_PAYLOAD`）。"""
        if len(data) > FLASH_MAX_PAYLOAD:
            raise AppCmdError(f"单包负载超限: {len(data)} > {FLASH_MAX_PAYLOAD}")
        payload = struct.pack("<IH", addr, len(data)) + data
        self._check(self._flash(FLASH_WRITE, payload, timeout=timeout), "WRITE")

    def flash_read(self, addr: int, size: int, timeout: float) -> bytes:
        """回读一块 flash（``size`` ≤ :data:`FLASH_MAX_PAYLOAD`），返回数据。"""
        if size <= 0 or size > FLASH_MAX_PAYLOAD:
            raise AppCmdError(f"单包读取长度非法: {size}（上限 {FLASH_MAX_PAYLOAD}）")
        payload = struct.pack("<IH", addr, size)
        self._send(bytes([CMD_FLASH, FLASH_READ]) + payload)
        head = self.link.read_exact(2, timeout=timeout)
        if len(head) < 2:
            raise AppCmdError("FLASH READ 无响应")
        if head[0] == CMD_INVALID:
            raise AppCmdError("当前固件不支持 FLASH 命令")
        if head[0] != CMD_FLASH:
            raise AppCmdError(f"FLASH 响应异常 (id=0x{head[0]:02X})")
        if head[1] != 0:
            raise AppCmdError(f"FLASH READ 失败: {errno_str(head[1])}")
        data = self.link.read_exact(size, timeout=timeout)
        if len(data) < size:
            raise AppCmdError(f"FLASH READ 数据不完整: 期望 {size} 字节, 收到 {len(data)}")
        return data

    # ---- FLASH 模式 B（镜像型，协议 v0.3） ----
    def flash_open_image(self, base: int, crc32: int, timeout: float) -> None:
        """开启镜像会话：地址由固件从文件内容解析。

        ``base`` 只对 ``.bin`` 有意义（``.hex`` 忽略）；``crc32`` 为期望的整镜像
        CRC32，传 0 表示不做 CRC 校验。
        """
        payload = struct.pack("<II", base & 0xFFFFFFFF, crc32 & 0xFFFFFFFF)
        self._check(
            self._flash(FLASH_OPEN_IMAGE, payload, timeout=timeout),
            "OPEN_IMAGE",
        )

    def flash_image_data(self, chunk: bytes, timeout: float) -> None:
        """喂入一块**文件原始字节**（``len(chunk)`` ≤ :data:`FLASH_MAX_IMAGE_PAYLOAD`）。

        无地址字段，可任意切分，不必对齐 hex 记录边界（固件解析器有状态、可跨包续解）。
        """
        if len(chunk) > FLASH_MAX_IMAGE_PAYLOAD:
            raise AppCmdError(f"单包负载超限: {len(chunk)} > {FLASH_MAX_IMAGE_PAYLOAD}")
        if not chunk:
            raise AppCmdError("IMAGE_DATA 不接受空负载")
        payload = struct.pack("<H", len(chunk)) + chunk
        self._check(self._flash(FLASH_IMAGE_DATA, payload, timeout=timeout), "IMAGE_DATA")

    def flash_image_verify(self, timeout: float) -> None:
        """校验固件侧累加的整镜像 CRC32。"""
        self._check(self._flash(FLASH_IMAGE_VERIFY, timeout=timeout), "IMAGE_VERIFY")

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