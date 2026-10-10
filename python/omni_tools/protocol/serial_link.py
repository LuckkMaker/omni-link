# OMNI Link - OMNI Tool 串口底座
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""pyserial 收发封装：打开/关闭、读写超时、按操作分级重试、统一日志。"""

import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import serial
    from serial import SerialException
    SERIAL_AVAILABLE = True
except ImportError:  # pragma: no cover
    serial = None
    SerialException = Exception
    SERIAL_AVAILABLE = False

DEFAULT_BAUDRATE = 115200


class SerialLinkError(Exception):
    """串口打开/读写失败。"""


class SerialLink:
    """对一个 COM 口的薄封装。

    超时策略：读超时由调用方按操作分级传入（擦除 1~2s / 常规命令短超时），
    写超时固定较短，避免拔线后阻塞。
    """

    def __init__(
        self,
        port: str,
        baudrate: int = DEFAULT_BAUDRATE,
        timeout: float = 0.2,
        write_timeout: float = 2.0,
        retries: int = 2,
    ):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.write_timeout = write_timeout
        self.retries = retries
        self._ser: Optional["serial.Serial"] = None

    # ---- 生命周期 ----
    def open(self) -> None:
        if not SERIAL_AVAILABLE:
            raise SerialLinkError("缺少 pyserial，请安装: pip install pyserial")
        if self._ser is not None and self._ser.is_open:
            return
        try:
            self._ser = serial.Serial(
                self.port,
                self.baudrate,
                timeout=self.timeout,
                write_timeout=self.write_timeout,
            )
            self._ser.reset_input_buffer()
        except Exception as e:
            self._ser = None
            raise SerialLinkError(f"打开串口 {self.port} 失败: {e}") from e
        logger.info("SerialLink opened %s @ %d", self.port, self.baudrate)

    def close(self) -> None:
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None
            logger.info("SerialLink closed %s", self.port)

    @property
    def is_open(self) -> bool:
        return self._ser is not None and self._ser.is_open

    # ---- 收发 ----
    def reset_input_buffer(self) -> None:
        if self._ser is not None:
            try:
                self._ser.reset_input_buffer()
            except Exception:
                pass

    def write(self, data: bytes) -> None:
        """写数据，带轻量重试（CDC 偶发写失败）。"""
        if self._ser is None:
            raise SerialLinkError("串口未打开")
        last_err: Optional[Exception] = None
        for attempt in range(self.retries + 1):
            try:
                self._ser.write(data)
                self._ser.flush()
                return
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < self.retries:
                    time.sleep(0.05)
        raise SerialLinkError(f"串口写失败: {last_err}") from last_err

    def read(self, size: int, timeout: Optional[float] = None) -> bytes:
        """读取至多 ``size`` 字节；``timeout`` 指定时临时覆盖读超时。"""
        if self._ser is None:
            raise SerialLinkError("串口未打开")
        old = self._ser.timeout
        try:
            if timeout is not None:
                self._ser.timeout = timeout
            return self._ser.read(size)
        except Exception as e:  # noqa: BLE001
            raise SerialLinkError(f"串口读失败: {e}") from e
        finally:
            self._ser.timeout = old

    def read_exact(self, size: int, timeout: float) -> bytes:
        """在 ``timeout`` 预算内读满 ``size`` 字节，提前结束则返回已读部分。

        与 ``read`` 的区别：超时为整段预算（非每字节），避免多字节响应被单次超时截断。
        """
        if self._ser is None:
            raise SerialLinkError("串口未打开")
        if size <= 0:
            return b""
        old = self._ser.timeout
        buf = bytearray()
        deadline = time.monotonic() + timeout
        try:
            # 单次读的超时用剩余预算，保证总耗时不超过 timeout
            while len(buf) < size:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._ser.timeout = min(old or 0.2, remaining)
                chunk = self._ser.read(size - len(buf))
                if not chunk:
                    break
                buf.extend(chunk)
        except Exception as e:  # noqa: BLE001
            raise SerialLinkError(f"串口读失败: {e}") from e
        finally:
            self._ser.timeout = old
        return bytes(buf)