"""设备目录管理（内置库 + 用户库双层存储）

采用「两份数据库文件」方案，解决内置型号升级时会覆盖用户数据的问题：

- 内置库（只读）：源码/打包内 `data/OMNILinkDevices.xml`，存放 `source="builtin"` 的设备。
  随应用版本发布更新，只读；升级时替换文件即可，绝不影响用户库。
- 用户库（可写）：`<OMNI_DATA_DIR>/user-devices.xml`，存放用户自建的
  `source="custom"` / `"pack"` / `"flm"` 设备。随用户操作增删改，永不因升级而变化。

兼容性迁移：首次启动时会扫描旧式单一文件 `OMNILinkDevices.xml`（开发模式下可能与内置
seed 同一路径），把其中 `source != "builtin"` 的用户设备一次性迁入用户库；内置设备一律
以 seed 为准。迁移通过目录下的 `.omnilink_migrated` 标记防止重复执行。

路径解析：
- 开发模式：内置 seed = 源码 `data/OMNILinkDevices.xml`；用户库 = OMNI_DATA_DIR 或源码
  `data/` 下的 `user-devices.xml`。
- 生产模式（PyInstaller frozen）：内置 seed = 打包内 `data/OMNILinkDevices.xml`（随
  --add-data 打包）；用户库 = OMNI_DATA_DIR 或 exe 同级的 `user-devices.xml`。
"""

import json
import os
import sys
import threading
import xml.etree.ElementTree as ET
from typing import Optional
from xml.dom import minidom

# 线程锁（保护用户库文件读写；RLock 以支持 ensure_initialized 重入）
_lock = threading.RLock()

# XML schema 版本
_XML_VERSION = 1

# 迁移标记文件名（放在用户数据目录下，防止旧文件重复迁移）
_MIGRATE_MARKER = ".omnilink_migrated"

# 用户库文件名
_USER_FILENAME = "user-devices.xml"

# 旧式单一文件文件名（兼容性迁移来源）
_LEGACY_FILENAME = "OMNILinkDevices.xml"


def _resolve_paths() -> tuple[str, str, str, str, str]:
    """解析内置库 / 用户库 / 旧文件 / JSON / 数据目录 路径。

    返回 (builtin_xml, user_xml, legacy_xml, json_path, data_dir)
    """
    src_dir = os.path.dirname(os.path.abspath(__file__))
    src_data_dir = os.path.normpath(os.path.join(src_dir, "..", "data"))

    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        bundled_data_dir = (
            os.path.join(meipass, "data")
            if meipass and os.path.exists(os.path.join(meipass, "data", _LEGACY_FILENAME))
            else os.path.join(os.path.dirname(sys.executable), "data")
        )
        builtin_xml = os.path.join(bundled_data_dir, _LEGACY_FILENAME)
        json_path = os.path.join(bundled_data_dir, "device_info.json")
        data_dir = os.environ.get("OMNI_DATA_DIR") or os.path.dirname(sys.executable)
    else:
        builtin_xml = os.path.join(src_data_dir, _LEGACY_FILENAME)
        json_path = os.path.join(src_data_dir, "device_info.json")
        data_dir = os.environ.get("OMNI_DATA_DIR") or src_data_dir

    user_xml = os.path.join(data_dir, _USER_FILENAME)
    legacy_xml = os.path.join(data_dir, _LEGACY_FILENAME)
    return builtin_xml, user_xml, legacy_xml, json_path, data_dir


_BUILTIN_XML, _USER_XML, _LEGACY_XML, _JSON_PATH, _DATA_DIR = _resolve_paths()


# ── 生命周期 ─────────────────────────────


def _do_init() -> None:
    """确保用户数据目录存在，并执行一次性旧文件迁移。"""
    if _DATA_DIR:
        os.makedirs(_DATA_DIR, exist_ok=True)

    marker = os.path.join(_DATA_DIR, _MIGRATE_MARKER)
    if os.path.exists(marker):
        return

    if not os.path.exists(_USER_XML):
        _write_user([])

    # 迁移旧式单一文件中的用户设备（source != builtin），内置一律以 seed 为准
    if _LEGACY_XML and os.path.exists(_LEGACY_XML):
        if os.path.abspath(_LEGACY_XML) != os.path.abspath(_USER_XML):
            legacy = _scan_file(_LEGACY_XML)
            movable = [d for d in legacy if (d.get("source", "builtin")) != "builtin"]
            if movable:
                merged = {d["part_number"]: d for d in _scan_file(_USER_XML)}
                for d in movable:
                    merged.setdefault(d["part_number"], _normalize_source(d))
                _write_user(list(merged.values()))

    # 写入迁移标记，避免重复迁移
    try:
        with open(marker, "w", encoding="utf-8") as f:
            f.write("migrated")
    except Exception:
        pass


def ensure_initialized() -> None:
    """惰性初始化（目录创建 + 旧文件迁移），线程安全。"""
    global _initialized
    with _lock:
        if _initialized:
            return
        _do_init()
        _initialized = True


_initialized = False


# ── 底层读写 ─────────────────────────────


def _scan_file(path: str) -> list[dict]:
    """解析 XML 文件为设备 dict 列表；文件不存在或出错返回 []。"""
    if not path or not os.path.exists(path):
        return []
    try:
        tree = ET.parse(path)
        root = tree.getroot()
        return [_element_to_device_dict(elem) for elem in root.findall("device")]
    except Exception:
        return []


def _read_builtin() -> list[dict]:
    """读取内置库（只读），仅返回 source='builtin' 的设备。"""
    ensure_initialized()
    return [d for d in _scan_file(_BUILTIN_XML) if d.get("source", "builtin") == "builtin"]


def _read_user() -> list[dict]:
    """读取用户库全部设备。"""
    ensure_initialized()
    return _scan_file(_USER_XML)


def _read_all() -> list[dict]:
    """合并内置库 + 用户库；part_number 冲突时内置优先。"""
    bmap = {d["part_number"]: d for d in _read_builtin()}
    umap = {d["part_number"]: d for d in _read_user()}
    merged = dict(umap)
    merged.update(bmap)  # 内置覆盖同名用户设备
    return list(merged.values())


def _normalize_source(device: dict) -> dict:
    """用户库不允许出现 builtin 类型；缺省/误标为 builtin 的强制改为 custom。"""
    d = dict(device)
    if (d.get("source", "builtin")) == "builtin":
        d["source"] = "custom"
    return d


def _is_builtin_name(part_number: str) -> bool:
    return part_number in {d["part_number"] for d in _read_builtin()}


# ── XML 序列化 ───────────────────────────


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

    ram_regions = device.get("ram_regions")
    if ram_regions:
        ram_regions_elem = ET.SubElement(dev_elem, "ram_regions")
        for r in ram_regions:
            ET.SubElement(ram_regions_elem, "region", {
                "start": r["start"],
                "length": r["length"],
                "is_default": "true" if r.get("is_default") else "false",
            })

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


def _write_xml(root: ET.Element, path: str) -> None:
    """写入 XML 文件（pretty print）"""
    rough = ET.tostring(root, encoding="unicode")
    pretty = minidom.parseString(rough).toprettyxml(indent="  ", encoding="utf-8")
    with open(path, "wb") as f:
        f.write(pretty)


def _write_user(devices: list[dict]) -> None:
    """将设备列表保存到用户库文件"""
    root = ET.Element("devices", {"version": str(_XML_VERSION)})
    for d in devices:
        _device_dict_to_element(_normalize_source(d), root)
    _write_xml(root, _USER_XML)


def _upsert_user(device: dict) -> None:
    """在用户库中插入或更新设备（不校验内置冲突）"""
    devices = _read_user()
    found = False
    for i, d in enumerate(devices):
        if d["part_number"] == device["part_number"]:
            devices[i] = _normalize_source(device)
            found = True
            break
    if not found:
        devices.append(_normalize_source(device))
    _write_user(devices)


# ── 公共查询 ─────────────────────────────


def get_db_path() -> str:
    """返回用户库可写文件的路径"""
    ensure_initialized()
    return _USER_XML


def get_builtin_path() -> str:
    """返回内置库（只读 seed）的路径"""
    ensure_initialized()
    return _BUILTIN_XML


def get_db_version() -> int:
    return _XML_VERSION


def list_devices() -> list[dict]:
    """列出所有设备（内置 + 用户，含 flash_regions）"""
    with _lock:
        devices = _read_all()
        devices.sort(key=lambda d: (d.get("vendor", ""), d.get("display_name", "")))
        return devices


def get_device(part_number: str) -> Optional[dict]:
    """获取指定设备（含 flash_regions）"""
    with _lock:
        for d in _read_all():
            if d["part_number"] == part_number:
                return d
        return None


def list_devices_by_source(source: str) -> list[dict]:
    """按来源筛选设备"""
    with _lock:
        return [d for d in _read_all() if d.get("source", "builtin") == source]


def get_source_summary() -> dict:
    """获取各来源的设备数量统计"""
    with _lock:
        devices = _read_all()
        # custom 为手动新增、不带 FLM 算法的自定义芯片（source=custom）
        summary = {"builtin": 0, "pack": 0, "flm": 0, "custom": 0, "total": len(devices)}
        for d in devices:
            source = d.get("source", "builtin")
            if source in summary:
                summary[source] += 1
        return summary


def is_builtin(part_number: str) -> bool:
    """判断设备是否为只读内置型号"""
    with _lock:
        return _is_builtin_name(part_number)


# ── CRUD（仅作用于用户库；内置只读） ─────────────


def add_device(device: dict) -> dict:
    """新增设备（写入用户库；内置型号同名时拒绝）"""
    with _lock:
        ensure_initialized()
        if _is_builtin_name(device["part_number"]):
            raise ValueError(f"内置型号只读：{device['part_number']}")
        _upsert_user(_normalize_source(device))
    return get_device(device["part_number"])


def upsert_device(device: dict) -> None:
    """插入或更新设备（写入用户库；内置型号同名时忽略）"""
    with _lock:
        ensure_initialized()
        if _is_builtin_name(device["part_number"]):
            return
        _upsert_user(_normalize_source(device))


def update_device(part_number: str, device: dict) -> Optional[dict]:
    """更新设备（part_number 不可变；内置型号只读，返回 None）"""
    with _lock:
        ensure_initialized()
        if _is_builtin_name(part_number):
            return None
        if not any(d["part_number"] == part_number for d in _read_user()):
            return None
        device["part_number"] = part_number
        _upsert_user(_normalize_source(device))
    return get_device(part_number)


def delete_device(part_number: str) -> bool:
    """删除设备（内置型号只读，返回 False）"""
    with _lock:
        ensure_initialized()
        if _is_builtin_name(part_number):
            return False
        devices = _read_user()
        new_devices = [d for d in devices if d["part_number"] != part_number]
        if len(new_devices) == len(devices):
            return False
        _write_user(new_devices)
        return True


def reimport_from_json() -> int:
    """从 device_info.json 把历史用户设备（source != builtin）导入用户库。

    内置设备一律以 seed 为准，不再从 JSON 导入。
    Returns: 导入的设备数量
    """
    if not os.path.exists(_JSON_PATH):
        return 0

    with open(_JSON_PATH, "r", encoding="utf-8") as f:
        devices = json.load(f)

    movable = [d for d in devices if (d.get("source", "builtin")) != "builtin"]
    if not movable:
        return 0

    with _lock:
        ensure_initialized()
        merged = {d["part_number"]: d for d in _read_user()}
        for d in movable:
            merged.setdefault(d["part_number"], _normalize_source(d))
        _write_user(list(merged.values()))

    return len(movable)


# ── 可用性与烧录 ─────────────────────────


def is_target_registered(part_number: str) -> bool:
    """检查设备是否可实际烧录。"""
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
    """获取设备的可用状态"""
    if is_target_registered(part_number):
        return "available"
    return "metadata_only"