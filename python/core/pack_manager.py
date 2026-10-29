"""CMSIS-Pack 管理

提供 CMSIS-Pack (.pack) 文件的导入、管理和卸载功能。
导入的 Pack 会通过 pyOCD 的 PackTargets 动态注册芯片到 TARGET 字典，
同时提取设备元数据写入 XML 设备目录。

Pack 文件存储在用户数据目录的 packs/ 子目录下。
安装清单存储在 packs/installed_packs.json。
"""

import gc
import json
import logging
import os
import shutil
import sys
import threading
from datetime import datetime
from typing import Optional

from core import database

_LOG = logging.getLogger(__name__)

_lock = threading.Lock()

# TARGET 注册锁：持久导入、启动加载、临时挂包都可能在并发请求里触发，
# 统一串行化，避免同一个 Pack 被重复解析。
_target_lock = threading.Lock()

# 临时/持久 Pack 的解析缓存：abs_path -> (mtime_ns, size)。
# 命中时跳过 pyOCD 的整包解析（大 DFP 解析很慢），只保留 TARGET 中的注册结果。
_pack_load_cache: dict[str, tuple[int, int]] = {}

# 持久 Pack 的“所有权”：pack_name -> 本 Pack 实际新增的 TARGET 键。
# 卸载时只删这些键，绝不误删内置型号或其它 Pack 提供的同名型号。
_pack_owned: dict[str, set[str]] = {}


def _get_data_dir() -> str:
    """获取用户数据目录"""
    if getattr(sys, "frozen", False):
        return os.environ.get("OMNI_DATA_DIR") or os.path.dirname(sys.executable)
    else:
        omni_data_dir = os.environ.get("OMNI_DATA_DIR")
        if omni_data_dir:
            return omni_data_dir
        src_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.normpath(os.path.join(src_dir, "..", "data"))


def get_packs_dir() -> str:
    """获取 Pack 文件存储目录"""
    packs_dir = os.path.join(_get_data_dir(), "packs")
    os.makedirs(packs_dir, exist_ok=True)
    return packs_dir


def get_manifest_path() -> str:
    """获取安装清单文件路径"""
    return os.path.join(get_packs_dir(), "installed_packs.json")


def load_manifest() -> list[dict]:
    """加载安装清单"""
    manifest_path = get_manifest_path()
    if not os.path.exists(manifest_path):
        return []
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_manifest(manifest: list[dict]) -> None:
    """保存安装清单"""
    manifest_path = get_manifest_path()
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)


def _resolve_manifest_path(entry: dict) -> str:
    """返回清单条目的可用路径。

    旧版本/拷贝来的清单可能记录了失效的绝对路径（例如指向另一份源码树），
    但 Pack 文件仍在 ``packs/`` 下。此时按 filename 回退并回写 entry["path"]，
    避免启动时整包被跳过（表现为 `omni target list` 看不到已导入型号）。
    """
    path = entry.get("path") or ""
    if path and os.path.isfile(path):
        return path

    filename = entry.get("filename") or os.path.basename(path)
    if filename:
        candidate = os.path.join(get_packs_dir(), filename)
        if os.path.isfile(candidate):
            entry["path"] = candidate
            return candidate
    return path


def _file_signature(path: str) -> tuple[int, int]:
    """Pack 文件的缓存签名；mtime_ns 精度足够检测重新导入/替换。"""
    st = os.stat(path)
    return (st.st_mtime_ns, st.st_size)


def validate_pack_paths(paths) -> list[str]:
    """规范化并校验 .pack 路径列表。

    支持单个字符串或列表；返回去重后的绝对路径。缺失文件抛
    ``FileNotFoundError``，扩展名/空路径抛 ``ValueError``。
    """
    if paths is None:
        return []
    if isinstance(paths, str):
        paths = [paths]

    result: list[str] = []
    seen: set[str] = set()
    for raw in paths:
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError("Pack 路径不能为空")
        path = os.path.abspath(os.path.expanduser(raw.strip()))
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Pack 文件不存在: {path}")
        if not path.lower().endswith(".pack"):
            raise ValueError(f"不是 .pack 文件: {path}")
        key = os.path.normcase(path)
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result


def _register_pack_targets(pack_path: str) -> set[str]:
    """把整个 Pack 注册进 pyOCD TARGET，返回本 Pack 新增的键。

    调用方（持久导入/启动加载）用返回集合记录“所有权”，卸载时只删这些键。
    """
    from pyocd.target import TARGET
    from pyocd.target.pack.pack_target import PackTargets

    with _target_lock:
        before = set(TARGET)
        PackTargets.populate_targets_from_pack(pack_path)
        added = set(TARGET) - before
        try:
            _pack_load_cache[pack_path] = _file_signature(pack_path)
        except OSError:
            pass
        return added


def ensure_pack_targets(paths) -> list[str]:
    """临时挂包：把 Pack 中的型号注册到当前后端进程的 pyOCD TARGET。

    与 pyOCD ``--pack`` 的进程内语义一致：不复制文件、不写设备库、不写清单；
    后端重启后失效。已加载且 (mtime_ns, size) 未变化的 Pack 直接命中缓存。
    """
    normalized = validate_pack_paths(paths)
    if not normalized:
        return []

    from pyocd.target.pack.pack_target import PackTargets

    with _target_lock:
        for path in normalized:
            try:
                signature = _file_signature(path)
            except OSError as e:
                raise FileNotFoundError(f"Pack 文件不可访问: {path}: {e}") from e

            if _pack_load_cache.get(path) == signature:
                continue

            try:
                PackTargets.populate_targets_from_pack(path)
            except Exception as e:
                raise ValueError(f"加载 CMSIS-Pack 失败: {path}: {e}") from e
            _pack_load_cache[path] = signature

    return normalized


def _extract_pack_info(pack_path: str) -> dict:
    """从 Pack 文件名提取基本信息

    CMSIS-Pack 标准命名: Vendor.Family_DFP.version.pack
    例如: Keil.STM32F4xx_DFP.3.0.0.pack
         Geehy.G32F020_DFP.0.0.8.pack

    版本号是最后一段连续的 dot-separated 数字（至少两段），
    例如 "3.0.0", "0.0.8", "1.2"。
    如果只有一段数字则视为非版本号（如 "DFP.3" 中的 3 不是版本）。
    """
    import re

    filename = os.path.basename(pack_path)
    name_part = filename
    if name_part.endswith(".pack"):
        name_part = name_part[:-5]

    # 尝试从末尾匹配版本号：至少两段 dot-separated 数字
    # 例如 "Geehy.G32F020_DFP.0.0.8" → name="Geehy.G32F020_DFP", version="0.0.8"
    match = re.match(r'^(.+?)\.(\d+\.\d+(?:\.\d+)*)$', name_part)
    if match:
        name = match.group(1)
        version = match.group(2)
    else:
        name = name_part
        version = "unknown"

    return {"name": name, "version": version, "filename": filename}


def _extract_devices_from_pack(pack_path: str, strict: bool = False) -> list[dict]:
    """从 Pack 中提取设备元数据列表

    直接解析 .pack（ZIP）中的 PDSC XML，不依赖 pyOCD 导入。
    提取每个设备的: part_number, vendor, core, flash_size, ram_size, flash_base, ram_base

    ``strict=True`` 时，非 ZIP、缺少 PDSC 或 XML 解析失败会抛 ``ValueError``。
    预览/导入用它拒绝 IDE 之外的文件，避免把无效 .pack 安装成 0 设备条目。

    PDSC 结构:
    <package>
      <vendor>Geehy</vendor>
      <devices>
        <family Dfamily="..." Dvendor="Geehy:163">
          <processor Dcore="Cortex-M0+" .../>       ← family 级别
          <subFamily DsubFamily="G32F020">
            <processor Dclock="64000000"/>           ← subFamily 级别（补充）
            <device Dname="G32F020K8">
              <memory id="IROM1" start="0x0" size="0x10000" startup="1"/>
              <memory id="IRAM1" start="0x20000000" size="0x2000"/>
              <algorithm name="Flash/G32F020.FLM" .../>
            </device>
            <device Dname="G32F020K8"> ... </device>
          </subFamily>
          <device Dname="STM32F407VG">              ← 也支持直接在 family 下
            <memory name="FLASH" .../>
          </device>
          <variant Dvariant="STM32F407IG"> ... </variant>
        </family>
      </devices>
    </package>
    """
    import zipfile
    import xml.etree.ElementTree as ET

    devices = []

    try:
        with zipfile.ZipFile(pack_path, 'r') as zf:
            # 查找 PDSC 文件
            pdsc_files = [f for f in zf.namelist() if f.endswith('.pdsc')]
            if not pdsc_files:
                if strict:
                    raise ValueError(f"CMSIS-Pack 中缺少 .pdsc 文件: {pack_path}")
                return devices

            with zf.open(pdsc_files[0]) as pf:
                tree = ET.parse(pf)
                root = tree.getroot()

            # 提取厂商名：优先 <vendor> 标签，回退 <vendors><vendor>
            vendor_name = ""
            vendor_elem = root.find('vendor')
            if vendor_elem is not None and vendor_elem.text:
                vendor_name = vendor_elem.text.strip()
            else:
                vendor_elem = root.find('.//vendors/vendor')
                if vendor_elem is not None and vendor_elem.text:
                    vendor_name = vendor_elem.text.strip()

            # 从 Pack 中解析所有 FLM 文件，获取真实的 page_size / sector_size
            flm_map = _parse_flm_map_from_pack(zf, root)

            # 遍历设备 family
            for family in root.findall('.//devices/family'):
                family_vendor = family.get('Dvendor', vendor_name)
                # Dvendor 可能带 ":数字" 后缀（如 "Geehy:163"），取冒号前
                if ':' in family_vendor:
                    family_vendor = family_vendor.split(':')[0]

                # 收集 family 级别的 processor 信息（可被 subFamily/device 覆盖）
                family_proc = family.find('processor')

                # 处理 <subFamily> 下的 <device>（Geehy/STM32 等常见结构）
                for sub_family in family.findall('subFamily'):
                    sub_proc = sub_family.find('processor')
                    # subFamily 级别的 processor 可补充 family 级别的属性
                    merged_proc = _merge_processor(family_proc, sub_proc)

                    for dev_elem in sub_family.findall('device'):
                        # 查找 device 级别的 <algorithm>，获取对应 FLM 信息
                        algo_elem = dev_elem.find('algorithm')
                        flm_info = None
                        if algo_elem is not None:
                            flm_name = algo_elem.get('name', '')
                            flm_info = flm_map.get(flm_name)
                        device_info = _parse_pdsc_device(dev_elem, family_vendor, merged_proc, flm_info)
                        if device_info:
                            devices.append(device_info)

                    # subFamily 下的 variant
                    for dev_elem in sub_family.findall('device'):
                        for variant_elem in dev_elem.findall('variant'):
                            # variant 可继承 device 的 algorithm
                            algo_elem = variant_elem.find('algorithm')
                            flm_info = None
                            if algo_elem is not None:
                                flm_name = algo_elem.get('name', '')
                                flm_info = flm_map.get(flm_name)
                            else:
                                # 回退到 device 级别的 algorithm
                                parent_algo = dev_elem.find('algorithm')
                                if parent_algo is not None:
                                    flm_info = flm_map.get(parent_algo.get('name', ''))
                            device_info = _parse_pdsc_device(variant_elem, family_vendor, merged_proc, flm_info)
                            if device_info:
                                devices.append(device_info)

                # 处理直接在 family 下的 <device>（无 subFamily 的情况）
                for dev_elem in family.findall('device'):
                    algo_elem = dev_elem.find('algorithm')
                    flm_info = None
                    if algo_elem is not None:
                        flm_name = algo_elem.get('name', '')
                        flm_info = flm_map.get(flm_name)
                    device_info = _parse_pdsc_device(dev_elem, family_vendor, family_proc, flm_info)
                    if device_info:
                        devices.append(device_info)

                    # 处理 <variant> 子元素（容量变体）
                    for variant_elem in dev_elem.findall('variant'):
                        algo_elem = variant_elem.find('algorithm')
                        flm_info = None
                        if algo_elem is not None:
                            flm_name = algo_elem.get('name', '')
                            flm_info = flm_map.get(flm_name)
                        else:
                            parent_algo = dev_elem.find('algorithm')
                            if parent_algo is not None:
                                flm_info = flm_map.get(parent_algo.get('name', ''))
                        device_info = _parse_pdsc_device(variant_elem, family_vendor, family_proc, flm_info)
                        if device_info:
                            devices.append(device_info)

    except Exception as e:
        if strict:
            raise ValueError(f"CMSIS-Pack 解析失败: {e}") from e
        _LOG.warning("Failed to extract devices from pack: %s", e)

    return devices


def _merge_processor(parent_proc, child_proc):
    """合并 parent 和 child 的 <processor> 属性，child 优先"""
    if parent_proc is None:
        return child_proc
    if child_proc is None:
        return parent_proc
    # 创建合并后的元素
    import xml.etree.ElementTree as ET
    merged = ET.Element('processor')
    for k, v in parent_proc.attrib.items():
        merged.set(k, v)
    for k, v in child_proc.attrib.items():
        merged.set(k, v)  # child 覆盖 parent
    return merged


def _parse_flm_from_pack(zf, algorithm_name: str) -> Optional[dict]:
    """从 Pack ZIP 中提取 FLM 文件并解析 Flash 算法信息

    使用 pyOCD 的 PackFlashAlgo 解析 FLM (ELF) 文件，获取真实的
    page_size 和 sector_sizes。

    Args:
        zf: 已打开的 ZipFile 对象
        algorithm_name: PDSC <algorithm name="..."> 引用的 FLM 路径

    Returns: {"page_size": int, "sector_sizes": [(start, size), ...]} 或 None
    """
    import tempfile
    import logging
    LOG = logging.getLogger(__name__)

    try:
        # FLM 路径在 ZIP 中可能是绝对路径（以 / 开头）或相对路径
        flm_path = algorithm_name.lstrip('/')
        if flm_path not in zf.namelist():
            # 尝试模糊匹配（部分 Pack 使用不同大小写或路径前缀）
            matches = [n for n in zf.namelist() if n.endswith(flm_path.split('/')[-1])]
            if not matches:
                LOG.debug("FLM '%s' not found in pack", algorithm_name)
                return None
            flm_path = matches[0]

        # 提取到临时文件
        with tempfile.NamedTemporaryFile(suffix='.FLM', delete=False) as tmp:
            tmp.write(zf.read(flm_path))
            tmp_path = tmp.name

        try:
            from pyocd.target.pack.flash_algo import PackFlashAlgo
            algo = PackFlashAlgo(tmp_path)
            page_size = algo.page_size or 0x400
            # sector_sizes 是 [(start_addr, sector_size), ...] 列表
            sector_sizes = algo.sector_sizes or [(0, 0x400)]
            # 取第一个 sector_size 作为统一值
            first_sector_size = sector_sizes[0][1] if sector_sizes else 0x400
            return {
                "page_size": page_size,
                "sector_size": first_sector_size,
            }
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as e:
        logging.getLogger(__name__).debug("Failed to parse FLM '%s': %s", algorithm_name, e)
        return None


def _parse_flm_map_from_pack(zf, root) -> dict:
    """从 Pack ZIP 中解析所有 <algorithm> 引用的 FLM，构建映射表

    遍历 PDSC 中所有 <algorithm> 元素，提取每个 FLM 的 page_size/sector_size。
    由于多个 device 可能共用同一个 FLM，按 FLM 路径缓存解析结果。

    Returns: {flm_name: {"page_size": int, "sector_size": int}, ...}
    """
    flm_map = {}
    for algo_elem in root.findall('.//algorithm'):
        flm_name = algo_elem.get('name', '')
        if not flm_name or flm_name in flm_map:
            continue
        info = _parse_flm_from_pack(zf, flm_name)
        if info:
            flm_map[flm_name] = info
    return flm_map


def _parse_pdsc_device(elem, vendor: str, parent_processor=None,
                       flm_info: Optional[dict] = None) -> Optional[dict]:
    """从 PDSC XML 的 <device> 或 <variant> 元素解析设备元数据

    Args:
        elem: <device> 或 <variant> XML 元素
        vendor: 厂商名
        parent_processor: 从 family/subFamily 继承的 <processor> 元素
        flm_info: 从 FLM 文件解析的 Flash 信息 {"page_size": int, "sector_size": int}，
                  如果为 None 则回退到默认值 0x400
    """
    # 获取型号名
    part_number = elem.get('Dname') or elem.get('Dvariant') or ''
    if not part_number:
        return None

    # 从 FLM 信息获取真实值，回退到默认 0x400
    default_sector_size = f"0x{flm_info['sector_size']:X}" if flm_info else "0x400"
    default_page_size = f"0x{flm_info['page_size']:X}" if flm_info else "0x400"

    # 解析内存区域
    # PDSC 有两种内存标记方式：
    #   Keil 风格: id="IROM1" (Flash) / id="IRAM1" (RAM)
    #   CMSIS 风格: name="FLASH" / name="RAM"
    flash_size = 0
    ram_size = 0
    flash_base = "0x00000000"
    ram_base = "0x20000000"
    flash_regions = []
    # 收集所有 RAM 区域（一个设备可能有多个 RAM，如 SRAM1 + CCM）
    ram_regions = []
    # 默认 RAM（PDSC default="1"），用于回填 ram_base/ram_size
    default_ram_start = None
    default_ram_size_bytes = 0

    for mem in elem.findall('memory'):
        mem_name = (mem.get('name') or '').upper()
        mem_id = (mem.get('id') or '').upper()
        start_str = mem.get('start', '0x00000000')
        size_str = mem.get('size', '0x0')
        is_default = mem.get('default', '0') == '1'

        try:
            start = int(start_str, 16) if start_str.startswith('0x') else int(start_str)
            size = int(size_str, 16) if size_str.startswith('0x') else int(size_str)
        except ValueError:
            continue

        # 判断是否为 Flash（IROM / FLASH / 带 startup=1）
        is_flash = ('FLASH' in mem_name or
                    mem_id.startswith('IROM') or
                    mem.get('startup') == '1')
        # 判断是否为 RAM（IRAM / RAM）
        is_ram = ('RAM' in mem_name or mem_id.startswith('IRAM'))

        if is_flash:
            flash_size = size // 1024
            flash_base = f"0x{start:08X}"
            flash_regions.append({
                "start": f"0x{start:08X}",
                "length": f"0x{size:X}",
                "sector_size": default_sector_size,
                "page_size": default_page_size,
                "is_boot_memory": True,
            })
        elif is_ram:
            ram_regions.append({
                "start": f"0x{start:08X}",
                "length": f"0x{size:X}",
                "is_default": is_default,
            })
            # 记录默认 RAM（PDSC default="1"）；若无 default 标记则取第一个
            if is_default:
                default_ram_start = start
                default_ram_size_bytes = size
            elif default_ram_start is None:
                default_ram_start = start
                default_ram_size_bytes = size

    # 回填主 RAM 信息（保持 ram_base_address/ram_size 字段向后兼容）
    if default_ram_start is not None:
        ram_base = f"0x{default_ram_start:08X}"
        ram_size = default_ram_size_bytes // 1024

    # 若没有任何 RAM 区域被标记 default，将第一个标为默认
    if ram_regions and not any(r["is_default"] for r in ram_regions):
        ram_regions[0]["is_default"] = True

    # 解析内核信息：优先 device 自身的 <processor>，回退 parent_processor
    # 注意：device 级别的 <processor> 可能只包含部分属性（如 Dfpu/Dmpu），
    # 不一定包含 Dcore。需要合并 parent_processor 的 Dcore。
    core = "Cortex-M4"  # 默认值
    proc_elem = elem.find('processor')
    if proc_elem is not None:
        # device 有自己的 processor，但可能缺少 Dcore，需要从 parent 补充
        dcore = proc_elem.get('Dcore', '')
        if not dcore and parent_processor is not None:
            dcore = parent_processor.get('Dcore', '')
        if dcore:
            core = dcore
    elif parent_processor is not None:
        dcore = parent_processor.get('Dcore', '')
        if dcore:
            core = dcore

    if not flash_regions:
        flash_regions.append({
            "start": flash_base,
            "length": f"0x{flash_size * 1024:X}" if flash_size > 0 else "0x0",
            "sector_size": default_sector_size,
            "page_size": default_page_size,
            "is_boot_memory": True,
        })

    return {
        "part_number": part_number.lower(),
        "source": "pack",
        "vendor": vendor,
        "display_name": part_number,
        "core": core,
        "num_cores": 1,
        "flash_size": flash_size,
        "ram_size": ram_size,
        "flash_base_address": flash_base,
        "ram_base_address": ram_base,
        "device_id_address": "0xE0042000",
        "flash_regions": flash_regions,
        "ram_regions": ram_regions,
    }


def preview_pack(pack_path: str) -> list[dict]:
    """预览 Pack 中的设备列表（不导入）

    Returns: 设备元数据列表
    """
    if not os.path.exists(pack_path):
        raise FileNotFoundError(f"Pack 文件不存在: {pack_path}")
    return _extract_devices_from_pack(pack_path, strict=True)


def import_pack(pack_path: str, selected_parts: Optional[list[str]] = None) -> dict:
    """导入 CMSIS-Pack 文件

    1. 复制 Pack 文件到 packs/ 目录
    2. 调用 pyOCD 注册芯片到 TARGET 字典
    3. 提取设备元数据写入 XML 目录
    4. 更新安装清单

    Args:
        pack_path: Pack 文件路径
        selected_parts: 选择的设备 part_number 列表。None=全部导入。

    Returns: 导入结果 {"pack": {...}, "devices": [...], "device_count": N}
    Raises: Exception on failure
    """
    with _lock:
        if not os.path.isfile(pack_path):
            raise FileNotFoundError(f"Pack 文件不存在: {pack_path}")

        pack_info = _extract_pack_info(pack_path)

        # 先解析并校验源文件，再复制/注册：无效 .pack 不会留下半成品安装。
        all_devices = _extract_devices_from_pack(pack_path, strict=True)
        if not all_devices:
            raise ValueError(f"CMSIS-Pack 中未找到芯片定义: {pack_path}")

        # 按 selected_parts 过滤（只影响设备库展示，不影响整包 TARGET 注册）
        if selected_parts is not None:
            selected_set = {p.lower() for p in selected_parts}
            devices = [d for d in all_devices if d["part_number"].lower() in selected_set]
            if not devices:
                raise ValueError(
                    "--parts 未匹配到 Pack 中的任何芯片: " + ", ".join(selected_parts)
                )
        else:
            devices = all_devices

        packs_dir = get_packs_dir()
        dest_path = os.path.join(packs_dir, pack_info["filename"])

        # 复制 Pack 文件
        shutil.copy2(pack_path, dest_path)

        # 注册整包芯片到 TARGET 字典（失败不影响设备目录写入）。
        # 选择部分设备只影响设备库展示，不到 TARGET：与 pyOCD 加载整包一致。
        added_targets: set[str] = set()
        try:
            added_targets = _register_pack_targets(dest_path)
        except Exception as e:
            _LOG.warning(
                "pyOCD target registration skipped (devices still added to catalog): %s", e
            )
        # 同名旧版本可能已注册过：保留旧所有权并合并，避免重导入后卸载漏删
        _pack_owned[pack_info["name"]] = _pack_owned.get(pack_info["name"], set()) | added_targets

        # 同步设备库：移除本 Pack 之前导入、但本次未选中的条目。
        # 重新导入是“替换选择”语义；否则 full → --parts 重导入后，未选中的旧条目
        # 仍会留在 device list 中，与 pack list 的 device_count 不一致。
        selected_part_numbers = {d["part_number"] for d in devices}
        try:
            for existing in database.list_devices():
                if (
                    existing.get("source") == "pack"
                    and existing.get("pack") == pack_info["name"]
                    and existing.get("part_number") not in selected_part_numbers
                ):
                    database.delete_device(existing["part_number"])
        except Exception as e:
            _LOG.warning("Failed to prune old devices for pack %s: %s",
                         pack_info["name"], e)

        # 写入 XML 设备目录
        for dev in devices:
            dev["pack"] = pack_info["name"]
            database.upsert_device(dev)

        # 更新安装清单
        manifest = load_manifest()
        # 移除同名的旧版本
        manifest = [m for m in manifest if m["name"] != pack_info["name"]]
        manifest_entry = {
            "name": pack_info["name"],
            "version": pack_info["version"],
            "filename": pack_info["filename"],
            "path": dest_path,
            # devices = 用户勾选（设备库展示）；all_devices = 整包型号（卸载兜底）
            "devices": [d["part_number"] for d in devices],
            "all_devices": [d["part_number"] for d in all_devices],
            "device_count": len(devices),
            "installed_at": datetime.now().isoformat(),
        }
        manifest.append(manifest_entry)
        save_manifest(manifest)

        return {
            "pack": manifest_entry,
            "devices": devices,
            "device_count": len(devices),
        }


def get_pack_devices(pack_name: str) -> dict:
    """获取已安装 Pack 中的所有设备（含当前导入状态）

    Returns: {"pack": manifest_entry, "devices": [...]}
    """
    manifest = load_manifest()
    entry = next((m for m in manifest if m["name"] == pack_name), None)
    if entry is None:
        raise ValueError(f"未找到 Pack: {pack_name}")

    pack_path = _resolve_manifest_path(entry)
    if not os.path.isfile(pack_path):
        raise FileNotFoundError(f"Pack 文件缺失: {pack_path}")

    # 从 Pack 文件重新提取所有设备
    all_devices = _extract_devices_from_pack(pack_path)

    # 标记当前已导入的设备
    currently_imported = {p.lower() for p in entry.get("devices", [])}
    for dev in all_devices:
        dev["imported"] = dev["part_number"].lower() in currently_imported

    return {
        "pack": entry,
        "devices": all_devices,
    }


def update_pack_devices(pack_name: str, selected_parts: list[str]) -> dict:
    """更新 Pack 的设备选择（仅影响设备库展示，不改变 TARGET 注册）

    整包在导入时已注册到 pyOCD TARGET；取消勾选只从设备库移除条目，
    型号仍可通过 ``--target`` 连接（与 pyOCD 加载整包的语义一致）。
    这样也避免误删内置型号或其它 Pack 提供的同名目标。

    Returns: {"pack": manifest_entry, "added": [...], "removed": [...], "device_count": N}
    """
    with _lock:
        manifest = load_manifest()
        entry = next((m for m in manifest if m["name"] == pack_name), None)
        if entry is None:
            raise ValueError(f"未找到 Pack: {pack_name}")

        pack_path = _resolve_manifest_path(entry)
        currently_imported = {p.lower() for p in entry.get("devices", [])}
        selected_set = {p.lower() for p in selected_parts}

        to_add = selected_set - currently_imported
        to_remove = currently_imported - selected_set

        # 从 Pack 文件提取所有设备信息
        all_devices = _extract_devices_from_pack(pack_path)
        dev_map = {d["part_number"].lower(): d for d in all_devices}

        # 添加新选择的设备
        for part in to_add:
            if part in dev_map:
                dev = dev_map[part].copy()
                dev["pack"] = pack_name
                database.upsert_device(dev)

        # 移除取消选择的设备（只删设备库条目；TARGET 保持整包可用）
        for part in to_remove:
            database.delete_device(part)

        # 更新清单
        entry["devices"] = list(selected_set)
        entry["device_count"] = len(selected_set)
        if not entry.get("all_devices"):
            entry["all_devices"] = [d["part_number"] for d in all_devices]
        save_manifest(manifest)

        return {
            "pack": entry,
            "added": list(to_add),
            "removed": list(to_remove),
            "device_count": len(selected_set),
        }


def list_installed_packs() -> list[dict]:
    """列出已安装的 Pack

    加载时会从文件名重新解析 name/version，修复旧清单中的错误数据。
    如果发现差异，自动更新清单文件。
    """
    manifest = load_manifest()
    needs_update = False
    result = []
    for entry in manifest:
        original_path = entry.get("path", "")
        pack_path = _resolve_manifest_path(entry)
        if pack_path != original_path:
            needs_update = True
        entry["file_exists"] = os.path.isfile(pack_path)

        # 从文件名重新解析 name/version，修复旧清单数据
        if pack_path and os.path.isfile(pack_path):
            fresh_info = _extract_pack_info(pack_path)
            if entry.get("name") != fresh_info["name"] or entry.get("version") != fresh_info["version"]:
                # 更新 XML 目录中设备的 pack 引用名
                old_name = entry.get("name", "")
                new_name = fresh_info["name"]
                if old_name != new_name:
                    try:
                        all_devices = database.list_devices()
                        for dev in all_devices:
                            if dev.get("source") == "pack" and dev.get("pack") == old_name:
                                dev["pack"] = new_name
                                database.upsert_device(dev)
                    except Exception:
                        pass

                entry["name"] = fresh_info["name"]
                entry["version"] = fresh_info["version"]
                needs_update = True

        result.append(entry)

    if needs_update:
        save_manifest(result)

    return result


def _pack_removable_keys(manifest: list[dict], pack_name: str,
                         owned: set[str] | None = None) -> set[str]:
    """计算卸载时可安全从 TARGET 删除的键。

    规则：本 Pack 的候选型号（实际注册所有权 ∪ all_devices ∪ devices）
    减去内置型号、减去其它已安装 Pack 声明的型号。纯函数，便于测试。
    """
    entry = next((m for m in manifest if m.get("name") == pack_name), None)
    if entry is None:
        return set()

    candidates = {p.lower() for p in (owned or set())}
    candidates |= {p.lower() for p in entry.get("all_devices") or []}
    candidates |= {p.lower() for p in entry.get("devices") or []}

    other_parts: set[str] = set()
    for m in manifest:
        if m.get("name") == pack_name:
            continue
        for p in (m.get("all_devices") or m.get("devices") or []):
            other_parts.add(p.lower())

    try:
        from pyocd.target.builtin import BUILTIN_TARGETS
        builtin_keys = {k.lower() for k in BUILTIN_TARGETS}
    except Exception:
        builtin_keys = set()

    return candidates - builtin_keys - other_parts


def remove_pack(pack_name: str) -> bool:
    """卸载 Pack

    1. 仅从 TARGET 移除**本 Pack 拥有**的芯片（内置型号与其它 Pack 的同名型号保持不动）
    2. 从 XML 目录中移除 source="pack" 且 pack=name 的设备
    3. 删除 Pack 文件
    4. 更新安装清单

    Returns: True if pack was found and removed
    """
    with _lock:
        manifest = load_manifest()
        entry = None
        for m in manifest:
            if m["name"] == pack_name:
                entry = m
                break

        if entry is None:
            return False

        # 计算本 Pack 可安全移除的型号（排除内置与其它 Pack 声明的型号）。
        owned = _pack_owned.pop(pack_name, None) or set()
        removable = _pack_removable_keys(manifest, pack_name, owned)

        # 从 TARGET 字典中移除本 Pack 独有的键；内置目标永不删除
        try:
            from pyocd.target import TARGET
            keys_to_remove = [k for k in list(TARGET.keys()) if k.lower() in removable]
            with _target_lock:
                for key in keys_to_remove:
                    TARGET.pop(key, None)
                _pack_load_cache.pop(_resolve_manifest_path(entry), None)
        except Exception as e:
            _LOG.warning("Failed to unregister TARGET entries for pack %s: %s", pack_name, e)

        # 从 XML 目录中移除
        all_devices = database.list_devices()
        for dev in all_devices:
            if dev.get("source") == "pack" and dev.get("pack") == pack_name:
                database.delete_device(dev["part_number"])

        # 删除 Pack 文件。pyOCD 的 CmsisPack 会持有 ZipFile 句柄，且目标类/设备
        # 之间可能存在引用环；仅从 TARGET 删除键后直接 os.remove 在 Windows 上常因
        # 句柄尚未释放而失败（表现为 pack remove 成功但 packs/ 下留下孤儿 .pack）。
        # 先触发一轮 GC 析构，再删除；活动会话仍占用时保留文件并告警。
        pack_path = _resolve_manifest_path(entry)
        if pack_path and os.path.isfile(pack_path):
            gc.collect()
            try:
                os.remove(pack_path)
            except OSError as e:
                _LOG.warning(
                    "Pack file still in use, left on disk: %s (%s)", pack_path, e
                )

        # 更新清单
        manifest = [m for m in manifest if m["name"] != pack_name]
        save_manifest(manifest)

        return True


def load_installed_packs() -> int:
    """启动时加载所有已安装的 Pack（重新注册到 TARGET 字典）

    路径失效时按 filename 从 packs/ 自愈；每个包注册后记录所有权，
    供 ``remove_pack`` 精确卸载。

    Returns: 成功加载的 Pack 数量
    """
    manifest = load_manifest()
    count = 0
    needs_update = False
    for entry in manifest:
        original_path = entry.get("path", "")
        pack_path = _resolve_manifest_path(entry)
        if pack_path != original_path:
            needs_update = True
        if not os.path.isfile(pack_path):
            _LOG.warning("Installed CMSIS-Pack file missing, skipped: %s (%s)",
                         entry.get("name", "?"), pack_path)
            continue
        try:
            added = _register_pack_targets(pack_path)
            _pack_owned[entry.get("name", "")] = _pack_owned.get(entry.get("name", ""), set()) | added
            count += 1
        except Exception as e:
            _LOG.warning("Failed to load installed CMSIS-Pack %s (%s): %s",
                         entry.get("name", "?"), pack_path, e)
            continue
    if needs_update:
        try:
            save_manifest(manifest)
        except Exception:
            pass
    return count
