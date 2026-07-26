"""CMSIS-Pack 管理

提供 CMSIS-Pack (.pack) 文件的导入、管理和卸载功能。
导入的 Pack 会通过 pyOCD 的 PackTargets 动态注册芯片到 TARGET 字典，
同时提取设备元数据写入 XML 设备目录。

Pack 文件存储在用户数据目录的 packs/ 子目录下。
安装清单存储在 packs/installed_packs.json。
"""

import json
import os
import shutil
import sys
import threading
from datetime import datetime
from typing import Optional

from core import database

_lock = threading.Lock()


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


def _extract_devices_from_pack(pack_path: str) -> list[dict]:
    """从 Pack 中提取设备元数据列表

    直接解析 .pack（ZIP）中的 PDSC XML，不依赖 pyOCD 导入。
    提取每个设备的: part_number, vendor, core, flash_size, ram_size, flash_base, ram_base

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
        import logging
        logging.getLogger(__name__).warning(f"Failed to extract devices from pack: {e}")

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
    return _extract_devices_from_pack(pack_path)


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
        if not os.path.exists(pack_path):
            raise FileNotFoundError(f"Pack 文件不存在: {pack_path}")

        pack_info = _extract_pack_info(pack_path)
        packs_dir = get_packs_dir()
        dest_path = os.path.join(packs_dir, pack_info["filename"])

        # 复制 Pack 文件
        shutil.copy2(pack_path, dest_path)

        # 注册芯片到 TARGET 字典（可选，失败不影响设备目录写入）
        try:
            from pyocd.target.pack.pack_target import PackTargets
            PackTargets.populate_targets_from_pack(dest_path)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(
                f"pyOCD target registration skipped (devices still added to catalog): {e}"
            )

        # 提取设备元数据
        all_devices = _extract_devices_from_pack(dest_path)

        # 按 selected_parts 过滤
        if selected_parts is not None:
            selected_set = {p.lower() for p in selected_parts}
            devices = [d for d in all_devices if d["part_number"].lower() in selected_set]
        else:
            devices = all_devices

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
            "devices": [d["part_number"] for d in devices],
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

    pack_path = entry.get("path", "")
    if not os.path.exists(pack_path):
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
    """更新 Pack 的设备选择

    - 新选择的设备：添加到 XML 目录 + 注册 TARGET
    - 取消选择的设备：从 XML 目录删除 + 注销 TARGET

    Returns: {"pack": manifest_entry, "added": [...], "removed": [...], "device_count": N}
    """
    with _lock:
        manifest = load_manifest()
        entry = next((m for m in manifest if m["name"] == pack_name), None)
        if entry is None:
            raise ValueError(f"未找到 Pack: {pack_name}")

        pack_path = entry.get("path", "")
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

        # 移除取消选择的设备
        for part in to_remove:
            database.delete_device(part)
            # 从 TARGET 字典中移除
            try:
                from pyocd.target import TARGET
                keys_to_remove = [k for k in TARGET if k.lower() == part]
                for k in keys_to_remove:
                    TARGET.pop(k, None)
            except Exception:
                pass

        # 更新清单
        entry["devices"] = list(selected_set)
        entry["device_count"] = len(selected_set)
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
        pack_path = entry.get("path", "")
        entry["file_exists"] = os.path.exists(pack_path)

        # 从文件名重新解析 name/version，修复旧清单数据
        if pack_path and os.path.exists(pack_path):
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


def remove_pack(pack_name: str) -> bool:
    """卸载 Pack

    1. 从 TARGET 字典中移除该 Pack 注册的芯片
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

        # 从 TARGET 字典中移除
        try:
            from pyocd.target import TARGET
            parts_to_remove = entry.get("devices", [])
            keys_to_remove = []
            for key in list(TARGET.keys()):
                if key.lower() in [p.lower() for p in parts_to_remove]:
                    keys_to_remove.append(key)
            for key in keys_to_remove:
                TARGET.pop(key, None)
        except Exception:
            pass

        # 从 XML 目录中移除
        all_devices = database.list_devices()
        for dev in all_devices:
            if dev.get("source") == "pack" and dev.get("pack") == pack_name:
                database.delete_device(dev["part_number"])

        # 删除 Pack 文件
        pack_path = entry.get("path", "")
        if pack_path and os.path.exists(pack_path):
            try:
                os.remove(pack_path)
            except Exception:
                pass

        # 更新清单
        manifest = [m for m in manifest if m["name"] != pack_name]
        save_manifest(manifest)

        return True


def load_installed_packs() -> int:
    """启动时加载所有已安装的 Pack（重新注册到 TARGET 字典）

    Returns: 成功加载的 Pack 数量
    """
    manifest = load_manifest()
    count = 0
    for entry in manifest:
        pack_path = entry.get("path", "")
        if not os.path.exists(pack_path):
            continue
        try:
            from pyocd.target.pack.pack_target import PackTargets
            PackTargets.populate_targets_from_pack(pack_path)
            count += 1
        except Exception:
            continue
    return count
