"""设备目录 API 路由

提供设备元数据的 CRUD 操作，数据存储在 XML 设备目录中。
支持 builtin / pack / flm 三种来源的芯片管理。
首次运行时自动从 device_info.json 转换导入初始数据。
"""

import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from core import database

router = APIRouter()


# ── 请求模型 ─────────────────────────────


class FlashRegionCreate(BaseModel):
    start: str
    length: str
    sector_size: str
    page_size: str
    is_boot_memory: bool = False


class RamRegionCreate(BaseModel):
    """RAM 区域（一个设备可能有多个 RAM region，如 SRAM + CCM）"""
    start: str
    length: str
    is_default: bool = False


class DeviceCreate(BaseModel):
    part_number: str
    vendor: str
    display_name: str
    core: str
    num_cores: int = 1
    flash_size: int  # KB
    ram_size: int  # KB
    flash_base_address: str
    ram_base_address: str
    device_id_address: str = "0xE0042000"
    jlink_device: str | None = None
    jlink_search: str | None = None
    flash_regions: list[FlashRegionCreate] = Field(default_factory=list)
    ram_regions: list[RamRegionCreate] = Field(default_factory=list)


class CustomDeviceCreate(BaseModel):
    """FLM 自定义芯片创建请求"""
    flm_path: str
    part_number: str
    core: str = "Cortex-M4"
    flash_base_address: str
    flash_size: int  # KB
    ram_base_address: str
    ram_size: int  # KB
    vendor: str = "Custom"
    display_name: str = ""
    ram_regions: list[RamRegionCreate] = Field(default_factory=list)


# ── 辅助函数 ─────────────────────────────


def _enrich_device(device: dict) -> dict:
    """为设备 dict 添加 available 字段（是否可实际烧录）"""
    device["available"] = database.is_target_registered(device["part_number"])
    return device


# ── 路由 ─────────────────────────────────


@router.get("")
async def list_devices():
    """列出所有支持的设备（完整目录，含可用状态）"""
    devices = database.list_devices()
    return {"devices": [_enrich_device(d) for d in devices]}


@router.get("/sources/summary")
async def get_source_summary():
    """获取各来源的设备数量统计"""
    summary = database.get_source_summary()
    # 统计可实际烧录的设备数
    devices = database.list_devices()
    available_count = sum(1 for d in devices if database.is_target_registered(d["part_number"]))
    summary["available"] = available_count
    summary["metadata_only"] = summary["total"] - available_count
    return summary


@router.get("/{part_number}")
async def get_device(part_number: str):
    """获取指定设备的详细信息（含可用状态）"""
    device = database.get_device(part_number)
    if device is None:
        raise HTTPException(status_code=404, detail=f"Unknown device: {part_number}")
    return _enrich_device(device)


@router.post("")
async def create_device(req: DeviceCreate):
    """新增设备（写入用户库；内置型号只读，不允许覆盖）"""
    if database.is_builtin(req.part_number):
        raise HTTPException(status_code=409, detail=f"内置型号只读: {req.part_number}")
    device = database.add_device(req.model_dump())
    return device


@router.put("/{part_number}")
async def update_device(part_number: str, req: DeviceCreate):
    """更新设备信息（内置型号只读，不允许修改）"""
    if database.is_builtin(part_number):
        raise HTTPException(status_code=409, detail=f"内置型号只读: {part_number}")
    device = database.update_device(part_number, req.model_dump())
    if device is None:
        raise HTTPException(status_code=404, detail=f"Unknown device: {part_number}")
    return device


@router.delete("/{part_number}")
async def delete_device(part_number: str):
    """删除设备（内置型号只读，不允许删除）"""
    if database.is_builtin(part_number):
        raise HTTPException(status_code=409, detail=f"内置型号只读: {part_number}")
    success = database.delete_device(part_number)
    if not success:
        raise HTTPException(status_code=404, detail=f"Unknown device: {part_number}")
    return {"success": True, "part_number": part_number}


@router.post("/reimport")
async def reimport_devices():
    """从 device_info.json 重新导入数据（覆盖同名设备）"""
    count = database.reimport_from_json()
    return {"success": True, "imported": count}


@router.post("/custom")
async def create_custom_device(req: CustomDeviceCreate):
    """通过 FLM 文件创建自定义芯片

    需要提供 .FLM Flash 算法文件路径和基本内存参数。
    创建后会动态注册到 pyOCD 的 TARGET 字典，可立即使用。
    """
    from core import custom_target

    if not os.path.exists(req.flm_path):
        raise HTTPException(status_code=404, detail=f"FLM 文件不存在: {req.flm_path}")

    if not req.flm_path.upper().endswith(".FLM"):
        raise HTTPException(status_code=400, detail="文件必须是 .FLM 格式")

    try:
        device = custom_target.create_custom_target(
            flm_path=req.flm_path,
            part_number=req.part_number,
            core=req.core,
            flash_base_address=req.flash_base_address,
            flash_size=req.flash_size,
            ram_base_address=req.ram_base_address,
            ram_size=req.ram_size,
            vendor=req.vendor,
            display_name=req.display_name,
            ram_regions=[r.model_dump() for r in req.ram_regions] if req.ram_regions else None,
        )
        return _enrich_device(device)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"创建自定义芯片失败: {str(e)}")


@router.post("/custom/extract-flm-info")
async def extract_flm_info(req: dict):
    """从 FLM 文件自动提取 Flash 参数

    请求体: {"path": "/path/to/file.FLM"}
    """
    from core import custom_target

    flm_path = req.get("path", "")
    if not os.path.exists(flm_path):
        raise HTTPException(status_code=404, detail=f"FLM 文件不存在: {flm_path}")

    info = custom_target.extract_flm_info(flm_path)
    return {"info": info}
