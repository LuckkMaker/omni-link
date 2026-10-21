"""探针管理 API 路由"""

import asyncio
import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from core.pyocd_backend import backend, ProbeState
from core.events import event_manager
from core import database, pack_manager

router = APIRouter()

# ── 连接参数与超时 ──────────────────────────────────────────
# HTTP 层兜底：backend.connect 内部已有 15s 的 pyOCD open 超时，但那只覆盖
# “拿到会话”这一步；探针枚举/DLL 调用等也可能卡住。这里再加一层，保证请求
# 一定能返回（504），不会出现 CLI 干等 30s 后只看到 “timed out”（实机报告 P1-1）。
CONNECT_HTTP_TIMEOUT = 20.0
# set_target 会 disconnect + 重新 open，与 connect 同量级
SET_TARGET_HTTP_TIMEOUT = 30.0
# 临时挂包（--pack）的解析可能涉及几十 MB 的 DFP 与 FLM 解析，单独计时；
# 不计入上面的硬件连接超时，避免大包把正常连接误判为 504。
PACK_LOAD_HTTP_TIMEOUT = 120.0
# 时钟频率范围（Hz）。J-Link DLL 的下限是 5 kHz，低于它只会得到
# “Given speed is too slow. Minimum is 5.” 这种没有单位的报错（P2-2）。
MIN_SPEED_HZ = 5_000
MAX_SPEED_HZ = 50_000_000


class SetTargetRequest(BaseModel):
    part_number: str
    # 临时挂载的 CMSIS-Pack 路径（可选，pyOCD --pack 语义）
    pack: list[str] | None = None


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
    # 临时挂载的 CMSIS-Pack 路径（可选，可重复，pyOCD --pack 语义）
    pack: list[str] | None = None


async def _ensure_packs(pack_paths: list[str] | None) -> None:
    """在触碰硬件前完成临时 Pack 的注册。

    单独计时（PACK_LOAD_HTTP_TIMEOUT），避免大 DFP 的解析时间挤占
    connect 的 20s 超时；坏包在此直接返回 400，不产生半开会话。
    """
    if not pack_paths:
        return
    try:
        await asyncio.wait_for(
            asyncio.to_thread(pack_manager.ensure_pack_targets, pack_paths),
            timeout=PACK_LOAD_HTTP_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=(f"加载 CMSIS-Pack 超时（{int(PACK_LOAD_HTTP_TIMEOUT)} 秒）。"
                    "请确认 Pack 文件完整、未被其他程序占用后重试。"),
        )
    except (ValueError, FileNotFoundError, OSError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"加载 CMSIS-Pack 失败: {e}")


@router.get("")
async def list_probes(refresh: bool = False):
    """列出所有已连接探针（含连接状态）

    默认返回后台监控线程维护的快照（每 2s 刷新），不逐请求做 USB 枚举：
    后端被挂起的硬件操作拖住时，探针列表不应跟着一起卡死（P1-2）。
    ``?refresh=true`` 才强制重新枚举（GUI 手动刷新/CLI 需要即时结果时使用）。
    """
    if refresh:
        probes = await asyncio.to_thread(backend.get_probe_states)
    else:
        probes = backend.get_cached_probe_states()
    return {"probes": probes}


@router.get("/states")
async def get_probe_states(refresh: bool = False):
    """获取所有探针状态（轻量级，仅返回 uid + state，默认读快照）"""
    if refresh:
        probes = await asyncio.to_thread(backend.get_probe_states)
    else:
        probes = backend.get_cached_probe_states()
    return {
        "probes": [
            {"uid": p["uid"], "state": p["state"]}
            for p in probes
        ]
    }


@router.post("/{uid}/connect")
async def connect_probe(uid: str, req: ConnectRequest | None = None):
    """连接指定探针（目标型号必填，可指定接口、速度）

    ``--target`` 是硬性前置条件：pyOCD 没有目标型号就无法建立内存映射，
    继续猜默认型号既可能选错芯片，也可能在 pyOCD 内部长时间探测（P1-1）。
    """
    target = req.target if req else None
    interface = req.interface if req else "swd"
    speed = req.speed if req else None
    connect_mode = req.connect_mode if req else None
    force = req.force if req else False
    jlink_device = req.jlink_device if req else None
    pack_paths = req.pack if req else None

    # 允许复用此前通过 /target 设置过的默认型号
    if not target:
        target = backend.get_pending_target()
    if not target:
        raise HTTPException(
            status_code=400,
            detail=("缺少目标芯片型号（--target 必填）。可用 `omni target list` 查询型号，"
                    "或在连接前用 `omni probe target <uid> --part <型号>` 设置默认目标。"),
        )
    if speed is not None and not (MIN_SPEED_HZ <= speed <= MAX_SPEED_HZ):
        raise HTTPException(
            status_code=400,
            detail=(f"时钟频率超出范围：--speed {speed} Hz = {speed / 1000:g} kHz。"
                    f"J-Link 支持 {MIN_SPEED_HZ // 1000} kHz ~ {MAX_SPEED_HZ // 1_000_000} MHz，"
                    "例如 --speed 4000000 表示 4 MHz，--speed 5000 为下限 5 kHz。"),
        )

    # 临时挂包必须先于硬件连接完成：目标型号可能只存在于 Pack 中。
    await _ensure_packs(pack_paths)

    # J-Link 设备名兜底：未显式指定时，若所选目标设备（内置型号等）自带 jlink_device 则自动使用，
    # 让用户选中内置型号即可开箱连接 J-Link，无需手填。
    if not jlink_device and target:
        try:
            dev = database.get_device(target)
            if dev and dev.get("jlink_device"):
                jlink_device = dev["jlink_device"]
        except Exception:
            pass
    # 连接涉及 J-Link open / 目标复位等同步阻塞调用（可耗时数秒甚至卡死），
    # 放线程池执行，避免堵死事件循环导致 /api/system/shutdown 等端点无响应。
    try:
        success = await asyncio.wait_for(
            asyncio.to_thread(
                backend.connect, uid,
                target=target, interface=interface, speed=speed,
                connect_mode=connect_mode, force=force, device=jlink_device,
                packs=pack_paths,
            ),
            timeout=CONNECT_HTTP_TIMEOUT,
        )
    except asyncio.TimeoutError:
        msg = (f"连接超时（{int(CONNECT_HTTP_TIMEOUT)} 秒）。目标可能未上电/未复位，"
               "或探针被其他调试工具占用。本次连接尝试已标记失效，请检查接线后重试；"
               "若后端仍无响应，执行 `omni backend stop` 后重启。")
        await asyncio.to_thread(backend.abort_connect, uid, msg)
        raise HTTPException(status_code=504, detail=msg)

    if not success:
        # 获取后端存储的具体错误信息，避免丢失诊断细节
        error_detail = backend.get_session_error(uid) or "Connection failed"
        raise HTTPException(status_code=500, detail=error_detail)

    target = backend.get_target_info(uid)
    return {
        "connected": True,
        "uid": uid,
        "target": target.to_dict() if target else None,
    }


@router.post("/{uid}/disconnect")
async def disconnect_probe(uid: str, wait: bool = False):
    """断开探针

    wait=true 时等待底层关闭完成再返回，确保探针（J-Link 等）句柄真正释放、
    立即对其他调试工具可用；前端保持默认 false（不阻塞 UI）。
    """
    await asyncio.to_thread(backend.disconnect, uid, wait)
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
    """手动设置目标芯片型号

    set_target 内部会 disconnect + 重新 open（同步阻塞），必须放线程池并加
    HTTP 超时，否则会堵死事件循环（/api/probes/states 等全部无响应，P1-2）。
    """
    # 先注册临时 Pack，再断开旧会话；坏包不会拆掉当前正常连接。
    await _ensure_packs(req.pack)
    try:
        success = await asyncio.wait_for(
            asyncio.to_thread(backend.set_target, uid, req.part_number, packs=req.pack),
            timeout=SET_TARGET_HTTP_TIMEOUT,
        )
    except asyncio.TimeoutError:
        msg = (f"设置目标超时（{int(SET_TARGET_HTTP_TIMEOUT)} 秒）：目标或探针无响应。"
               "会话已标记失效，请检查接线后重试。")
        await asyncio.to_thread(backend.abort_connect, uid, msg)
        raise HTTPException(status_code=504, detail=msg)
    if not success:
        error_detail = backend.get_session_error(uid) or f"Failed to set target: {req.part_number}"
        raise HTTPException(status_code=500, detail=error_detail)

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
            from core.jlink_lock import JLINK_DLL_LOCK
            # J-Link DLL 非线程安全：这段要连打近万次 JLINKARM_DEVICE_GetInfo，
            # 必须整段持锁，否则会与探针监控线程（每 2s 枚举）并发调用同一个 DLL，
            # 触发原生访问违例（OSError: exception: access violation reading 0x...）。
            with JLINK_DLL_LOCK:
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
    """手动触发探针列表刷新（强制硬件枚举，结果同时刷新快照并推送前端）"""
    probes = await asyncio.to_thread(backend.get_probe_states)
    event_manager.emit("probe.list", {"probes": probes})
    return {"probes": probes}
