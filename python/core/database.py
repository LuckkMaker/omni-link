"""XML 设备目录管理

提供设备目录数据的持久化存储，使用人类可读的 XML 格式，替代 SQLite。

用户可直接编辑 XML 文件来自定义芯片列表。支持三种来源：
- builtin：内置芯片（有 pyOCD Python 驱动）
- pack：CMSIS-Pack 导入的芯片（运行时动态注册）
- flm：FLM 自定义芯片（FLM 文件 + 元数据）

支持 overrides 覆盖层，用于修正 Pack 导入芯片的默认行为。

路径解析：
- 开发模式：使用源码目录下 data/OMNILinkDevices.xml（可被 OMNI_DATA_DIR 覆盖）
- 生产模式（PyInstaller frozen）：XML 写入 OMNI_DATA_DIR 指向的用户目录，
  种子文件来自 sys._MEIPASS 或 exe 目录下 data/OMNILinkDevices.xml（随 --add-data 打包）
"""

import json
import os
import shutil
import sys
import threading
import xml.etree.ElementTree as ET
from typing import Optional
from xml.dom import minidom

# 线程锁（保护 XML 文件读写）
_lock = threading.Lock()

# XML schema 版本
_XML_VERSION = 1


def _resolve_paths() -> tuple[str, str, str]:
    """解析 XML、种子 XML、JSON 文件的路径。

    返回 (xml_path, seed_xml_path, json_path)：
    - xml_path：实际使用的 XML 文件路径（必须可写）
    - seed_xml_path：打包内/源码内的种子 XML 路径（仅首次复制用，只读）
    - json_path：device_info.json 路径（旧格式导入回退用，只读）

    优先级：
    1. 生产模式（getattr(sys, 'frozen', False) 为 True）：
       - xml_path = OMNI_DATA_DIR 环境变量指向目录下 OMNILinkDevices.xml
       - seed_xml_path / json_path = sys._MEIPASS 下 data/ 子目录
         若 _MEIPASS 不可用或文件不存在，回退到 exe 同级目录下 data/
    2. 开发模式（非 frozen）：
       - xml_path = 源码目录下 data/OMNILinkDevices.xml
       - 若设置了 OMNI_DATA_DIR，则 xml_path 指向该目录
       - seed_xml_path / json_path 始终指向源码目录下 data/
    """
    src_dir = os.path.dirname(os.path.abspath(__file__))
    src_data_dir = os.path.normpath(os.path.join(src_dir, "..", "data"))

    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        bundled_data_dir = (
            os.path.join(meipass, "data")
            if meipass and os.path.exists(os.path.join(meipass, "data", "OMNILinkDevices.xml"))
            else os.path.join(os.path.dirname(sys.executable), "data")
        )
        seed_xml_path = os.path.join(bundled_data_dir, "OMNILinkDevices.xml")
        json_path = os.path.join(bundled_data_dir, "device_info.json")

        data_dir = os.environ.get("OMNI_DATA_DIR") or os.path.dirname(sys.executable)
        xml_path = os.path.join(data_dir, "OMNILinkDevices.xml")
    else:
        seed_xml_path = os.path.join(src_data_dir, "OMNILinkDevices.xml")
        json_path = os.path.join(src_data_dir, "device_info.json")

        omni_data_dir = os.environ.get("OMNI_DATA_DIR")
        xml_path = (
            os.path.join(omni_data_dir, "OMNILinkDevices.xml")
            if omni_data_dir
            else os.path.join(src_data_dir, "OMNILinkDevices.xml")
        )

    return xml_path, seed_xml_path, json_path


_XML_PATH, _SEED_XML_PATH, _JSON_PATH = _resolve_paths()


def _init_xml_file() -> None:
    """首次启动时初始化 XML 文件。

    优先从种子 XML 复制；若种子不存在则从 device_info.json 转换生成。
    """
    if os.path.exists(_XML_PATH):
        return

    xml_dir = os.path.dirname(_XML_PATH)
    if xml_dir:
        os.makedirs(xml_dir, exist_ok=True)

    # 优先从种子 XML 复制
    if _SEED_XML_PATH and os.path.exists(_SEED_XML_PATH):
        try:
            shutil.copy2(_SEED_XML_PATH, _XML_PATH)
            return
        except Exception:
            pass

    # 回退：从 device_info.json 转换
    if os.path.exists(_JSON_PATH):
        _convert_json_to_xml(_JSON_PATH, _XML_PATH)
        return

    # 最终兜底：创建空 XML
    root = ET.Element("devices", {"version": str(_XML_VERSION)})
    _write_xml(root, _XML_PATH)


def _convert_json_to_xml(json_path: str, xml_path: str) -> None:
    """将 device_info.json 转换为 OMNILinkDevices.xml"""
    with open(json_path, "r", encoding="utf-8") as f:
        devices = json.load(f)

    root = ET.Element("devices", {"version": str(_XML_VERSION)})
    for d in devices:
        _device_dict_to_element(d, root)
    _write_xml(root, xml_path)


def _device_dict_to_element(device: dict, parent: ET.Element) -> ET.Element:
    """将设备 dict 转为 XML Element，附加到 parent"""
    attrs = {"part_number": device["part_number"]}
    source = device.get("source", "builtin")
    attrs["source"] = source
    if device.get("pack"):
        attrs["pack"] = device["pack"]

    dev_elem = ET.SubElement(parent, "device", attrs)
    ET.SubElement(dev_elem, "vendor").text = device.get("vendor", "")
    ET.SubElement(dev_elem, "display_name").text = device.get("display_name", "")
    ET.SubElement(dev_elem, "core").text = device.get("core", "")
    ET.SubElement(dev_elem, "num_cores").text = str(device.get("num_cores", 1))
    ET.SubElement(dev_elem, "flash_size").text = str(device.get("flash_size", 0))
    ET.SubElement(dev_elem, "ram_size").text = str(device.get("ram_size", 0))
    ET.SubElement(dev_elem, "flash_base_address").text = device.get("flash_base_address", "0x00000000")
    ET.SubElement(dev_elem, "ram_base_address").text = device.get("ram_base_address", "0x20000000")
    ET.SubElement(dev_elem, "device_id_address").text = device.get("device_id_address", "0xE0042000")
    if device.get("jlink_device"):
        ET.SubElement(dev_elem, "jlink_device").text = device["jlink_device"]
    if device.get("jlink_search"):
        ET.SubElement(dev_elem, "jlink_search").text = device["jlink_search"]

    regions_elem = ET.SubElement(dev_elem, "flash_regions")
    for r in device.get("flash_regions", []):
        ET.SubElement(regions_elem, "region", {
            "start": r["start"],
            "length": r["length"],
            "sector_size": r["sector_size"],
            "page_size": r["page_size"],
            "is_boot_memory": "true" if r.get("is_boot_memory") else "false",
        })

    # 写入 ram_regions（如果有）
    ram_regions = device.get("ram_regions")
    if ram_regions:
        ram_regions_elem = ET.SubElement(dev_elem, "ram_regions")
        for r in ram_regions:
            ET.SubElement(ram_regions_elem, "region", {
                "start": r["start"],
                "length": r["length"],
                "is_default": "true" if r.get("is_default") else "false",
            })

    # 写入 overrides（如果有）
    overrides = device.get("overrides")
    if overrides:
        overrides_elem = ET.SubElement(dev_elem, "overrides")
        for region in overrides.get("flash_regions", []):
            region_attrs = {"start": region["start"]}
            if "is_boot_memory" in region:
                region_attrs["is_boot_memory"] = "true" if region["is_boot_memory"] else "false"
            if "length" in region:
                region_attrs["length"] = region["length"]
            ET.SubElement(overrides_elem, "flash_region", region_attrs)
        for seq in overrides.get("debug_sequences", []):
            ET.SubElement(overrides_elem, "debug_sequence", {
                "name": seq["name"],
                "enabled": "true" if seq.get("enabled", True) else "false",
            })

    return dev_elem


def _element_to_device_dict(elem: ET.Element) -> dict:
    """将 XML Element 转为设备 dict"""
    device = {
        "part_number": elem.get("part_number", ""),
        "source": elem.get("source", "builtin"),
        "vendor": _get_text(elem, "vendor", ""),
        "display_name": _get_text(elem, "display_name", ""),
        "core": _get_text(elem, "core", ""),
        "num_cores": int(_get_text(elem, "num_cores", "1")),
        "flash_size": int(_get_text(elem, "flash_size", "0")),
        "ram_size": int(_get_text(elem, "ram_size", "0")),
        "flash_base_address": _get_text(elem, "flash_base_address", "0x00000000"),
        "ram_base_address": _get_text(elem, "ram_base_address", "0x20000000"),
        "device_id_address": _get_text(elem, "device_id_address", "0xE0042000"),
    }
    jlink_device = _get_text(elem, "jlink_device", "")
    if jlink_device:
        device["jlink_device"] = jlink_device
    jlink_search = _get_text(elem, "jlink_search", "")
    if jlink_search:
        device["jlink_search"] = jlink_search

    if elem.get("pack"):
        device["pack"] = elem.get("pack")

    # 解析 flash_regions
    device["flash_regions"] = []
    regions_elem = elem.find("flash_regions")
    if regions_elem is not None:
        for r in regions_elem.findall("region"):
            device["flash_regions"].append({
                "start": r.get("start", "0x00000000"),
                "length": r.get("length", "0x0"),
                "sector_size": r.get("sector_size", "0x400"),
                "page_size": r.get("page_size", "0x400"),
                "is_boot_memory": r.get("is_boot_memory", "false").lower() == "true",
            })

    # 解析 ram_regions
    # 若 XML 中存在 <ram_regions>，按其内容加载；
    # 否则从 ram_base_address + ram_size 向后兼容合成一个默认区域。
    device["ram_regions"] = []
    ram_regions_elem = elem.find("ram_regions")
    if ram_regions_elem is not None:
        for r in ram_regions_elem.findall("region"):
            device["ram_regions"].append({
                "start": r.get("start", device["ram_base_address"]),
                "length": r.get("length", f"0x{device['ram_size'] * 1024:X}"),
                "is_default": r.get("is_default", "false").lower() == "true",
            })
    elif device["ram_size"] > 0:
        # 向后兼容：从 ram_base_address + ram_size 合成默认 RAM 区域
        device["ram_regions"].append({
            "start": device["ram_base_address"],
            "length": f"0x{device['ram_size'] * 1024:X}",
            "is_default": True,
        })

    # 解析 overrides
    overrides_elem = elem.find("overrides")
    if overrides_elem is not None:
        overrides = {"flash_regions": [], "debug_sequences": []}
        for r in overrides_elem.findall("flash_region"):
            entry = {"start": r.get("start", "")}
            if "is_boot_memory" in r.attrib:
                entry["is_boot_memory"] = r.get("is_boot_memory", "false").lower() == "true"
            if "length" in r.attrib:
                entry["length"] = r.get("length", "")
            overrides["flash_regions"].append(entry)
        for seq in overrides_elem.findall("debug_sequence"):
            overrides["debug_sequences"].append({
                "name": seq.get("name", ""),
                "enabled": seq.get("enabled", "true").lower() == "true",
            })
        device["overrides"] = overrides

    return device


def _get_text(elem: ET.Element, tag: str, default: str = "") -> str:
    """安全获取子元素文本"""
    child = elem.find(tag)
    return child.text if child is not None and child.text is not None else default


def _read_xml() -> list[dict]:
    """读取 XML 文件，返回设备列表"""
    _init_xml_file()
    try:
        tree = ET.parse(_XML_PATH)
        root = tree.getroot()
        return [_element_to_device_dict(elem) for elem in root.findall("device")]
    except Exception:
        return []


def _write_xml(root: ET.Element, path: str) -> None:
    """写入 XML 文件（pretty print）"""
    rough = ET.tostring(root, encoding="unicode")
    pretty = minidom.parseString(rough).toprettyxml(indent="  ", encoding="utf-8")
    with open(path, "wb") as f:
        f.write(pretty)


def _save_all(devices: list[dict]) -> None:
    """将设备列表保存到 XML 文件"""
    root = ET.Element("devices", {"version": str(_XML_VERSION)})
    for d in devices:
        _device_dict_to_element(d, root)
    _write_xml(root, _XML_PATH)


def get_db_path() -> str:
    """返回 XML 文件路径（保持向后兼容命名）"""
    return _XML_PATH


def get_db_version() -> int:
    """返回 XML schema 版本号"""
    return _XML_VERSION


# ── CRUD 操作 ─────────────────────────────


def list_devices() -> list[dict]:
    """列出所有设备（含 flash_regions）"""
    with _lock:
        devices = _read_xml()
        devices.sort(key=lambda d: (d.get("vendor", ""), d.get("display_name", "")))
        return devices


def get_device(part_number: str) -> Optional[dict]:
    """获取指定设备（含 flash_regions）"""
    with _lock:
        devices = _read_xml()
        for d in devices:
            if d["part_number"] == part_number:
                return d
        return None


def upsert_device(device: dict) -> None:
    """插入或更新设备（含 flash_regions）"""
    with _lock:
        devices = _read_xml()
        # 查找并替换，或追加
        found = False
        for i, d in enumerate(devices):
            if d["part_number"] == device["part_number"]:
                devices[i] = device
                found = True
                break
        if not found:
            devices.append(device)
        _save_all(devices)


def add_device(device: dict) -> dict:
    """新增设备"""
    upsert_device(device)
    return get_device(device["part_number"])


def update_device(part_number: str, device: dict) -> Optional[dict]:
    """更新设备（part_number 不可变）"""
    with _lock:
        devices = _read_xml()
        existing = None
        for d in devices:
            if d["part_number"] == part_number:
                existing = d
                break
        if existing is None:
            return None
        device["part_number"] = part_number
        upsert_device(device)
    return get_device(part_number)


def delete_device(part_number: str) -> bool:
    """删除设备"""
    with _lock:
        devices = _read_xml()
        new_devices = [d for d in devices if d["part_number"] != part_number]
        if len(new_devices) == len(devices):
            return False
        _save_all(new_devices)
        return True


def reimport_from_json() -> int:
    """从 device_info.json 重新导入数据（覆盖同名设备）

    Returns: 导入的设备数量
    """
    if not os.path.exists(_JSON_PATH):
        return 0

    with open(_JSON_PATH, "r", encoding="utf-8") as f:
        devices = json.load(f)

    with _lock:
        existing = _read_xml()
        existing_map = {d["part_number"]: d for d in existing}
        for d in devices:
            d["source"] = "builtin"
            existing_map[d["part_number"]] = d
        _save_all(list(existing_map.values()))

    return len(devices)


def list_devices_by_source(source: str) -> list[dict]:
    """按来源筛选设备"""
    with _lock:
        devices = _read_xml()
        return [d for d in devices if d.get("source", "builtin") == source]


def get_source_summary() -> dict:
    """获取各来源的设备数量统计"""
    with _lock:
        devices = _read_xml()
        summary = {"builtin": 0, "pack": 0, "flm": 0, "total": len(devices)}
        for d in devices:
            source = d.get("source", "builtin")
            if source in summary:
                summary[source] += 1
        return summary


def is_target_registered(part_number: str) -> bool:
    """检查设备是否可实际烧录。

    根据 source 字段判断：
    - builtin：内置芯片，有 pyOCD Python 驱动，始终可用
    - pack：CMSIS-Pack 导入，检查 Pack 是否已安装
    - flm：FLM 自定义芯片，检查 FLM 文件是否存在
    """
    device = get_device(part_number)
    if device is None:
        return False

    source = device.get("source", "builtin")

    if source == "builtin":
        # 内置芯片有 pyOCD 驱动，始终可用
        return True

    if source == "pack":
        # Pack 导入的芯片：检查 Pack 是否在安装清单中
        try:
            from core.pack_manager import load_manifest
            manifest = load_manifest()
            pack_name = device.get("pack", "")
            for entry in manifest:
                if entry.get("name") == pack_name:
                    return entry.get("file_exists", False)
            return False
        except Exception:
            return False

    if source == "flm":
        # FLM 自定义芯片：检查 FLM 文件是否存在
        flm_path = device.get("flm_path", "")
        return bool(flm_path) and os.path.exists(flm_path)

    return False


def get_device_availability(part_number: str) -> str:
    """获取设备的可用状态

    返回值：
    - "available"：已注册到 TARGET，可直接烧录
    - "metadata_only"：仅有元数据，未注册到 TARGET
    """
    if is_target_registered(part_number):
        return "available"
    return "metadata_only"
