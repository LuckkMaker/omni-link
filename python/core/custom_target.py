"""FLM 自定义芯片管理

通过 .FLM Flash 算法文件 + 用户提供的内存参数，
动态创建可烧录的自定义芯片 Target，并注册到 pyOCD 的 TARGET 字典。

FLM 文件是 ARM 编译的 Flash 算法库（ELF 格式），包含擦除/编程/校验函数的
机器码。pyOCD 的 PackFlashAlgo 可以解析 FLM 并提取这些算法。
"""

import os
import shutil
import logging
from typing import Optional

from core import database

logger = logging.getLogger(__name__)


def _parse_int(value, default: int = 0) -> int:
    """解析十进制或 0x 前缀的十六进制数值"""
    if value is None or value == "":
        return default
    if isinstance(value, int):
        return value
    return int(str(value).strip(), 0)


def _normalise_part_number(part_number: str) -> str:
    """按 pyOCD 规则规范化型号名（小写、非法字符转下划线）"""
    from pyocd.target import normalise_target_type_name

    normalized = normalise_target_type_name(part_number.strip())
    if not normalized:
        raise ValueError("芯片型号不能为空")
    return normalized


def _load_flm(flm_path: str):
    """解析并校验 FLM 文件，返回 PackFlashAlgo 对象"""
    from pyocd.target.pack.flash_algo import PackFlashAlgo, FlashAlgoException

    if not os.path.isfile(flm_path):
        raise FileNotFoundError(f"FLM 文件不存在: {flm_path}")

    try:
        algo = PackFlashAlgo(flm_path)
    except FlashAlgoException as e:
        raise ValueError(f"FLM 解析失败: {e}") from e
    except Exception as e:
        raise ValueError(f"FLM 解析失败: {e}") from e

    if algo.flash_size <= 0:
        raise ValueError("FLM 未定义有效的 Flash 容量")
    if algo.page_size <= 0:
        raise ValueError("FLM 未定义有效的页大小")
    if "ProgramPage" not in algo.symbols:
        raise ValueError("FLM 缺少 ProgramPage 函数")
    if "EraseSector" not in algo.symbols and "EraseChip" not in algo.symbols:
        raise ValueError("FLM 缺少 EraseSector/EraseChip 函数")
    if not list(algo.iter_sector_size_ranges()):
        raise ValueError("FLM 未定义有效的扇区布局")
    return algo


def _resolve_flash_range(algo, flash_base_address, flash_size_kb: int) -> tuple[int, int]:
    """结合 FLM 定义与用户输入确定 Flash 范围，并校验不超出 FLM 范围"""
    flm_start = algo.flash_start
    flm_end = flm_start + algo.flash_size - 1

    start = _parse_int(flash_base_address, flm_start)
    length = flash_size_kb * 1024 if flash_size_kb and flash_size_kb > 0 else algo.flash_size
    if length <= 0:
        raise ValueError("Flash 大小必须大于 0")

    end = start + length - 1
    if start < flm_start or end > flm_end:
        raise ValueError(
            f"Flash 范围 0x{start:08X}-0x{end:08X} 超出 FLM 定义范围 "
            f"0x{flm_start:08X}-0x{flm_end:08X}"
        )
    return start, length


def _build_flash_region_metadata(algo, flash_start: int, flash_length: int) -> list[dict]:
    """按 FLM 的扇区布局生成设备目录里的 flash_regions（仅用于展示）"""
    flash_end = flash_start + flash_length - 1
    regions = []
    for sector_range, sector_size in algo.iter_sector_size_ranges():
        start = max(flash_start, sector_range.start)
        end = min(flash_end, sector_range.end)
        if start > end:
            continue
        regions.append({
            "start": f"0x{start:08X}",
            "length": f"0x{end - start + 1:X}",
            "sector_size": f"0x{sector_size:X}",
            "page_size": f"0x{min(algo.page_size, sector_size):X}",
            "is_boot_memory": True,
        })

    if not regions:
        regions.append({
            "start": f"0x{flash_start:08X}",
            "length": f"0x{flash_length:X}",
            "sector_size": f"0x{algo.page_size:X}",
            "page_size": f"0x{algo.page_size:X}",
            "is_boot_memory": True,
        })
    return regions


def create_custom_target(
    flm_path: str,
    part_number: str,
    core: str,
    flash_base_address: str,
    flash_size: int,
    ram_base_address: str,
    ram_size: int,
    vendor: str = "Custom",
    display_name: str = "",
    ram_regions: Optional[list[dict]] = None,
) -> dict:
    """创建并注册 FLM 自定义芯片

    1. 解析 FLM 文件提取 Flash 算法与扇区信息
    2. 动态创建 CoreSightTarget 子类（FLM 交给 pyOCD 的 FlmFlashRegionBuilder 处理）
    3. 写入 XML 设备目录 (source="flm") 并注册到 TARGET 字典

    Args:
        flm_path: .FLM 文件路径
        part_number: 芯片型号（唯一标识）
        core: 内核名称（元数据，实际内核由调试探测自动识别）
        flash_base_address: Flash 基地址；为空时使用 FLM 定义值
        flash_size: Flash 大小（KB）；<=0 时使用 FLM 定义值
        ram_base_address: RAM 基地址
        ram_size: RAM 大小（KB）
        vendor: 厂商名（默认 "Custom"）
        display_name: 显示名（默认同用户输入的 part_number）
        ram_regions: 多 RAM 区域列表 [{"start": "0x...", "length": "0x...", "is_default": bool}]

    Returns: 创建的设备信息 dict
    Raises: ValueError / FileNotFoundError
    """
    raw_part_number = part_number.strip()
    normalized = _normalise_part_number(raw_part_number)

    if database.is_builtin(normalized):
        raise ValueError(f"内置型号只读: {raw_part_number}")

    existing = database.get_device(normalized)
    if existing is None:
        # 用户库中可能存有大小写不同的同型号（如 pack 导入），做一次不区分大小写的冲突检查
        for device in database.list_devices():
            if device["part_number"].lower() == normalized:
                existing = device
                break
    if existing is not None and existing.get("source") != "flm":
        raise ValueError(
            f"型号已存在，不能覆盖: {existing['part_number']}（来源: {existing.get('source')}）"
        )

    flm_path = os.path.abspath(os.path.expanduser(flm_path))
    algo = _load_flm(flm_path)
    flash_start, flash_length = _resolve_flash_range(algo, flash_base_address, flash_size)
    normalized_ram_regions = _normalize_ram_regions(ram_regions, ram_base_address, ram_size)

    if not display_name.strip():
        display_name = raw_part_number

    target_class = _build_custom_target_class(
        part_number=normalized,
        vendor=vendor,
        flm_path=flm_path,
        flash_start=flash_start,
        flash_length=flash_length,
        ram_regions=normalized_ram_regions,
    )

    default_ram = next(
        (r for r in normalized_ram_regions if r["is_default"]),
        normalized_ram_regions[0],
    )

    device_info = {
        "part_number": normalized,
        "source": "flm",
        "vendor": vendor,
        "display_name": display_name,
        "core": core,
        "num_cores": 1,
        "flash_size": flash_length // 1024,
        "ram_size": _parse_int(default_ram["length"]) // 1024,
        "flash_base_address": f"0x{flash_start:08X}",
        "ram_base_address": default_ram["start"],
        "device_id_address": "0xE0042000",
        "flash_regions": _build_flash_region_metadata(algo, flash_start, flash_length),
        "ram_regions": normalized_ram_regions,
    }

    flm_dir = _get_flm_dir()
    os.makedirs(flm_dir, exist_ok=True)
    flm_dest = os.path.join(flm_dir, f"{normalized}.FLM")
    if os.path.abspath(flm_path) != os.path.abspath(flm_dest):
        shutil.copy2(flm_path, flm_dest)
        # 源 FLM 常带只读属性（如从 Keil Pack 解出），复制后会继承，导致删除失败
        try:
            os.chmod(flm_dest, 0o666)
        except OSError:
            pass
    device_info["flm_path"] = flm_dest

    database.upsert_device(device_info)

    # 设备目录写入成功后再注册到 TARGET，避免注册了却未落库的孤儿状态
    from pyocd.target import TARGET
    TARGET[normalized] = target_class

    return device_info


def remove_custom_target(part_number: str, flm_path: str = "") -> None:
    """删除自定义芯片时清理 TARGET 注册与已复制的 FLM 文件"""
    try:
        from pyocd.target import TARGET, normalise_target_type_name

        TARGET.pop(normalise_target_type_name(part_number), None)
    except Exception as e:
        logger.warning("Failed to unregister custom target %s: %s", part_number, e)

    if not flm_path:
        return
    try:
        flm_dir = os.path.abspath(_get_flm_dir())
        target_path = os.path.abspath(flm_path)
        if os.path.commonpath([flm_dir, target_path]) == flm_dir and os.path.isfile(target_path):
            try:
                os.chmod(target_path, 0o666)
            except OSError:
                pass
            os.remove(target_path)
    except Exception as e:
        logger.warning("Failed to remove custom FLM file %s: %s", flm_path, e)


def _normalize_ram_regions(
    ram_regions: Optional[list[dict]],
    ram_base_address: str,
    ram_size: int,
) -> list[dict]:
    """规范化 RAM 区域列表

    若 ram_regions 非空，直接使用（确保每个区域有 start/length/is_default）；
    否则由 ram_base_address + ram_size 合成单个默认区域。
    保证至少有一个区域被标记为 is_default=True。
    """
    if ram_regions:
        normalized = []
        for r in ram_regions:
            start = _parse_int(r.get("start"), 0)
            length = _parse_int(r.get("length"), 0)
            if length <= 0:
                raise ValueError(f"RAM 区域大小无效: {r}")
            normalized.append({
                "start": f"0x{start:08X}",
                "length": f"0x{length:X}",
                "is_default": bool(r.get("is_default", False)),
            })
        # 保证至少一个 default
        if not any(r["is_default"] for r in normalized):
            normalized[0]["is_default"] = True
        return normalized

    ram_start = _parse_int(ram_base_address, 0x20000000)
    ram_length = ram_size * 1024
    if ram_length <= 0:
        raise ValueError("RAM 大小必须大于 0")
    return [{
        "start": f"0x{ram_start:08X}",
        "length": f"0x{ram_length:X}",
        "is_default": True,
    }]


def _build_custom_target_class(
    part_number: str,
    vendor: str,
    flm_path: str,
    flash_start: int,
    flash_length: int,
    ram_regions: list[dict],
):
    """动态构建 CoreSightTarget 子类

    Flash 区域只声明范围并交给 pyOCD 的 FlmFlashRegionBuilder 处理：
    它会解析 FLM、生成 pyOCD 算法字典、按扇区布局拆分子区域并设置页大小。
    """
    from pyocd.coresight.coresight_target import CoreSightTarget
    from pyocd.core import memory_map as mm
    from pyocd.target.pack.flash_algo import PackFlashAlgo

    parsed_ram_regions = [
        (
            _parse_int(r["start"]),
            _parse_int(r["length"]),
            bool(r.get("is_default", False)),
        )
        for r in ram_regions
    ]

    class CustomFlmTarget(CoreSightTarget):
        """由 FLM 文件动态创建的自定义芯片 Target"""

        VENDOR = vendor
        PART_NUMBER = part_number
        _flm_path = flm_path
        _flash_start = flash_start
        _flash_length = flash_length
        _ram_regions = parsed_ram_regions

        def __init__(self, session):
            regions = [
                mm.FlashRegion(
                    name="flash",
                    start=self._flash_start,
                    length=self._flash_length,
                    flm=PackFlashAlgo(self._flm_path),
                    is_boot_memory=True,
                )
            ]
            for idx, (r_start, r_length, is_default) in enumerate(self._ram_regions):
                # 第一个 RAM 区域命名为 "ram"，其余按序号命名
                r_name = "ram" if idx == 0 else f"ram{idx + 1}"
                regions.append(mm.RamRegion(
                    name=r_name,
                    start=r_start,
                    length=r_length,
                    is_default=is_default,
                ))
            super().__init__(session, mm.MemoryMap(*regions))

    # 设置类名
    CustomFlmTarget.__name__ = f"CustomFlmTarget_{part_number}"
    CustomFlmTarget.__qualname__ = CustomFlmTarget.__name__

    return CustomFlmTarget


def _get_flm_dir() -> str:
    """获取 FLM 文件存储目录"""
    from core.pack_manager import _get_data_dir
    return os.path.join(_get_data_dir(), "flm")


def load_custom_targets() -> int:
    """启动时从 XML 目录加载所有 FLM 自定义芯片

    Returns: 成功加载的数量
    """
    custom_devices = database.list_devices_by_source("flm")
    count = 0
    for dev in custom_devices:
        flm_path = dev.get("flm_path", "")
        if not flm_path or not os.path.exists(flm_path):
            logger.warning("Custom FLM target %s skipped: FLM file missing", dev.get("part_number"))
            continue
        try:
            algo = _load_flm(flm_path)
            try:
                flash_start, flash_length = _resolve_flash_range(
                    algo, dev.get("flash_base_address"), dev.get("flash_size", 0)
                )
            except ValueError as e:
                logger.warning(
                    "Custom FLM target %s keeps FLM range instead of stored range: %s",
                    dev.get("part_number"), e,
                )
                flash_start, flash_length = algo.flash_start, algo.flash_size

            part_number = _normalise_part_number(dev["part_number"])
            target_class = _build_custom_target_class(
                part_number=part_number,
                vendor=dev.get("vendor", "Custom"),
                flm_path=flm_path,
                flash_start=flash_start,
                flash_length=flash_length,
                ram_regions=_normalize_ram_regions(
                    dev.get("ram_regions"),
                    dev.get("ram_base_address", "0x20000000"),
                    dev.get("ram_size", 0),
                ),
            )

            from pyocd.target import TARGET
            TARGET[part_number] = target_class
            count += 1
        except Exception as e:
            logger.warning("Failed to load custom FLM target %s: %s", dev.get("part_number"), e)
            continue
    return count


def extract_flm_info(flm_path: str) -> dict:
    """从 FLM 文件中自动提取 Flash 算法信息

    尝试解析 FLM（ELF 格式）提取 Flash 区域信息。
    如果解析失败，返回空 dict。

    Returns: {"flash_base": "0x...", "flash_size": N, "page_size": "0x...", "sector_size": "0x..."} or {}
    """
    if not os.path.isfile(flm_path):
        return {}

    try:
        from pyocd.target.pack.flash_algo import PackFlashAlgo

        algo = PackFlashAlgo(flm_path)
        sector_sizes = [size for _, size in algo.iter_sector_size_ranges()]
        info = {
            "flash_base": f"0x{algo.flash_start:08X}",
            "flash_size": int(algo.flash_size // 1024),
            "page_size": f"0x{algo.page_size:X}",
        }
        if sector_sizes:
            info["sector_size"] = f"0x{max(sector_sizes):X}"
        return info
    except Exception:
        return {}
