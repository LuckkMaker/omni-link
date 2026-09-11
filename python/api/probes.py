"""探针管理 API 路由"""

import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from core.pyocd_backend import backend, ProbeState
from core.events import event_manager
from core import database

router = APIRouter()


class SetTargetRequest(BaseModel):
    part_number: str


class ConnectRequest(BaseModel):
    target: str | None = None
    interface: str = "swd"
    speed: int | None = None
    # 连接模式：attach=附加（默认，不复位不暂停）/ halt=复位并暂停 / pre-reset=连接前复位 / under-reset=复位下连接
    connect_mode: str | None = None
    # 是否强制重连：为 True 时即使已连接也按新 connect_mode 重连（用于切换会话连接模式）
    force: bool = False
    # J-Link 目标设备名（如 G32F463XC）：J-Link 探针必须设置才能建立目标连接（SWD/JTAG 均依赖）
    jlink_device: str | None = None


@router.get("")
async def list_probes():
    """列出所有已连接探针（含连接状态）"""
    probes = backend.get_probe_states()
    return {"probes": probes}


@router.get("/states")
async def get_probe_states():
    """获取所有探针状态（轻量级，仅返回 uid + state）"""
    probes = backend.get_probe_states()
    return {
        "probes": [
            {"uid": p["uid"], "state": p["state"]}
            for p in probes
        ]
    }


@router.post("/{uid}/connect")
async def connect_probe(uid: str, req: ConnectRequest | None = None):
    """连接指定探针（可指定目标型号、接口、速度）"""
    target = req.target if req else None
    interface = req.interface if req else "swd"
    speed = req.speed if req else None
    connect_mode = req.connect_mode if req else None
    force = req.force if req else False
    jlink_device = req.jlink_device if req else None
    # J-Link 设备名兜底：未显式指定时，若所选目标设备（内置型号等）自带 jlink_device 则自动使用，
    # 让用户选中内置型号即可开箱连接 J-Link，无需手填。
    if not jlink_device and target:
        try:
            dev = database.get_device(target)
            if dev and dev.get("jlink_device"):
                jlink_device = dev["jlink_device"]
        except Exception:
            pass
    success = backend.connect(uid, target=target, interface=interface, speed=speed,
                              connect_mode=connect_mode, force=force, device=jlink_device)
    if not success:
        # 获取后端存储的具体错误信息，避免丢失诊断细节
        error_detail = "Connection failed"
        with backend._lock:
            session = backend._sessions.get(uid)
            if session and session.error:
                error_detail = session.error
        raise HTTPException(status_code=500, detail=error_detail)

    target = backend.get_target_info(uid)
    return {
        "connected": True,
        "uid": uid,
        "target": target.to_dict() if target else None,
    }


@router.post("/{uid}/disconnect")
async def disconnect_probe(uid: str):
    """断开探针"""
    backend.disconnect(uid)
    # 清理 Commander 命令上下文
    from core.commander_backend import commander_backend
    commander_backend.reset_context(uid)
    return {"disconnected": True, "uid": uid}


@router.get("/{uid}/target")
async def get_target(uid: str):
    """获取当前连接的目标信息"""
    target = backend.get_target_info(uid)
    if not target:
        raise HTTPException(status_code=404, detail="No target connected")
    return target.to_dict()


@router.post("/{uid}/target")
async def set_target(uid: str, req: SetTargetRequest):
    """手动设置目标芯片型号"""
    success = backend.set_target(uid, req.part_number)
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to set target: {req.part_number}")

    # 目标切换后 session 重建，重置 Commander 上下文
    from core.commander_backend import commander_backend
    commander_backend.reset_context(uid)

    target = backend.get_target_info(uid)
    return {
        "success": True,
        "uid": uid,
        "target": target.to_dict() if target else None,
    }


@router.get("/{uid}/status")
async def get_probe_status(uid: str):
    """获取探针连接状态"""
    state = backend.get_state(uid)
    target = backend.get_target_info(uid) if state == ProbeState.CONNECTED else None
    return {
        "uid": uid,
        "state": state.value,
        "target": target.to_dict() if target else None,
    }


_jlink_devices_cache: list[dict] | None = None
_jlink_devices_lock = threading.Lock()


def _dec_bytes(v):
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8", "replace").strip()
        except Exception:
            return ""
    return v if v is not None else ""


def _get_jlink_devices() -> list[dict]:
    """扫描 J-Link 设备库（带进程级缓存）。

    J-Link 支持的全部设备名可通过 pylink 运行时枚举（实测 ~9882 个，全量扫描 <0.2s）。
    设备库在运行期几乎不变（除非 J-Link 软件升级），因此缓存一次即可。
    """
    global _jlink_devices_cache
    if _jlink_devices_cache is not None:
        return _jlink_devices_cache
    with _jlink_devices_lock:
        if _jlink_devices_cache is not None:
            return _jlink_devices_cache
        devices: list[dict] = []
        try:
            import pylink
            jlink = pylink.JLink()
            n = jlink.num_supported_devices()
            for i in range(n):
                d = jlink.supported_device(i)
                devices.append({
                    "name": d.name,
                    "flash_size": int(getattr(d, "FlashSize", 0) or 0),
                    "ram_size": int(getattr(d, "RAMSize", 0) or 0),
                    "core": _dec_bytes(getattr(d, "Core", "")),
                    "manufacturer": _dec_bytes(
                        getattr(d, "manufacturer", None) or getattr(d, "sManu", "")
                    ),
                })
        except Exception:
            devices = []
        _jlink_devices_cache = devices
        return devices


@router.get("/jlink/devices/all")
async def jlink_devices_all():
    """返回 J-Link 设备库全量列表（应用加载时预取到前端，选择设备时本地检索）。

    实测 ~9882 个设备，仅返回名称与容量（精简字段），单次 <0.2s（进程级缓存）。
    """
    devices = _get_jlink_devices()
    return {
        "devices": [
            {
                "name": d["name"],
                "flash_size": d["flash_size"],
                "ram_size": d["ram_size"],
                "manufacturer": d["manufacturer"],
            }
            for d in devices
        ]
    }


@router.get("/jlink/devices")
async def jlink_devices(
    search: str = "",
    flash_kb: int | None = None,
    limit: int = 20,
):
    """根据用户所选目标型号，从 J-Link 设备库动态查询候选设备名。

    解决"逻辑型号（如 STM32F407xG）对应多个 J-Link 物理型号（IG/VG/ZG）"的 1:N 问题：
    不手工维护名单，运行时按前缀（search）过滤，可选按 Flash 容量（flash_kb，KB）精确分组
    （如 1024 命中 xG 组）。
    """
    devices = _get_jlink_devices()
    if search:
        s = search.upper()
        devices = [d for d in devices if d["name"].upper().startswith(s)]
    if flash_kb is not None:
        target_bytes = flash_kb * 1024
        devices = [d for d in devices if d["flash_size"] == target_bytes]
    devices = devices[:limit]
    return {"devices": devices}


@router.post("/refresh")
async def refresh_probes():
    """手动触发探针列表刷新"""
    probes = backend.get_probe_states()
    event_manager.emit("probe.list", {"probes": probes})
    return {"probes": probes}
