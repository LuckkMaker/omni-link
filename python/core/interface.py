"""后端抽象接口

解耦业务逻辑与具体硬件库实现（当前为 pyOCD）。
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class ProbeInfo:
    uid: str
    vendor: str
    product: str
    vid: int
    pid: int
    serial: str


@dataclass
class FlashRegionInfo:
    """Flash 区域信息（一段连续的同构 Flash）"""
    start: int
    length: int
    sector_size: int
    page_size: int
    is_boot_memory: bool = False


@dataclass
class SectorInfo:
    """单个扇区信息"""
    index: int
    address: int
    size: int


@dataclass
class RamRegionInfo:
    """RAM 区域信息（一段连续的 RAM）"""
    start: int
    length: int
    is_default: bool = False


@dataclass
class TargetInfo:
    part_number: str
    core: str
    flash_start: int
    flash_size: int
    page_size: int
    sector_size: int  # 第一个 Flash region 的 sector_size（兼容旧代码）
    core_id: str = ""
    device_id: str = ""
    revision_id: str = ""
    endian: str = "Little"
    # 新增：完整的 Flash 区域列表和扇区列表
    flash_regions: list[FlashRegionInfo] = field(default_factory=list)
    sectors: list[SectorInfo] = field(default_factory=list)
    # 新增：RAM 信息
    ram_start: int = 0
    ram_size: int = 0
    # 新增：完整的 RAM 区域列表（运行时从 pyOCD memory_map 提取）
    ram_regions: list[RamRegionInfo] = field(default_factory=list)

    def to_dict(self) -> dict:
        """递归转换为可 JSON 序列化的字典"""
        return asdict(self)


@dataclass
class FlashResult:
    success: bool
    # 写入类操作（program/fill）实际写入的字节数
    bytes_written: int = 0
    # 校验操作实际比对的字节数（verify 专用）
    bytes_verified: int = 0
    # 擦除操作实际擦除的字节数（erase 专用）
    bytes_erased: int = 0
    duration_ms: int = 0
    error: Optional[str] = None

    def to_payload(self, omit_zero_written: bool = False) -> dict:
        """转为 API 响应字典，只保留本次操作有意义的计数字段。

        - verify 不写 Flash，``bytes_written=0`` 会误导脚本（实机报告 P3-1）；
        - erase 不写 Flash，同理用 ``bytes_erased`` 表达擦除量；
        - 为 0 的 ``bytes_verified`` / ``bytes_erased`` 不输出，避免 program 响应里
          混入与本次操作无关的字段。
        """
        data = asdict(self)
        if omit_zero_written and not data.get("bytes_written"):
            data.pop("bytes_written", None)
        if not data.get("bytes_verified"):
            data.pop("bytes_verified", None)
        if not data.get("bytes_erased"):
            data.pop("bytes_erased", None)
        return data


class BackendInterface(ABC):
    """硬件后端抽象接口"""

    @abstractmethod
    def list_probes(self) -> list[ProbeInfo]:
        """扫描所有已连接探针"""

    @abstractmethod
    def connect(self, probe_uid: str) -> bool:
        """连接指定探针"""

    @abstractmethod
    def disconnect(self, probe_uid: str) -> bool:
        """断开探针"""

    @abstractmethod
    def get_target_info(self, probe_uid: str) -> Optional[TargetInfo]:
        """获取当前连接目标的芯片信息"""

    @abstractmethod
    def set_target(self, probe_uid: str, part_number: str) -> bool:
        """手动设置目标芯片型号"""

    @abstractmethod
    def erase(
        self,
        probe_uid: str,
        erase_type: str = "chip",
        address: int = 0,
        size: int = 0,
    ) -> FlashResult:
        """擦除 Flash"""

    @abstractmethod
    def program(
        self,
        probe_uid: str,
        file_path: str,
        verify: bool = True,
        reset: bool = True,
    ) -> FlashResult:
        """烧录固件"""

    @abstractmethod
    def verify(self, probe_uid: str, file_path: str) -> FlashResult:
        """校验 Flash 内容"""

    @abstractmethod
    def reset(self, probe_uid: str, reset_type: str = "hw", run: bool = True) -> bool:
        """复位目标"""

    @abstractmethod
    def read_memory(self, probe_uid: str, address: int, size: int) -> bytes:
        """读取内存"""
