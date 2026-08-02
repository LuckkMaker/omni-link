"""Monitor REST API

下位机变量实时监控与波形采样接口。
对标 STM32CubeMonitor Direct 模式：加载 ELF -> 勾选变量 -> 启动采样 -> 波形显示。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from core.monitor_backend import monitor_backend
from core.pyocd_backend import backend

router = APIRouter()


class ElfLoadRequest(BaseModel):
    path: str


class AddVariableRequest(BaseModel):
    name: str
    address: int
    type: str                          # int8/uint8/int16/uint16/int32/uint32/float
    remark: str = ""
    refresh_sec: float = 0
    # 数组元素索引。传入时实际地址 = address + elem_index * elem_size，
    # 监视变量名变为 name[elem_index]，type/size 用元素类型/大小。
    elem_index: Optional[int] = None


class WriteVariableRequest(BaseModel):
    value: int


class StartSamplingRequest(BaseModel):
    rate_hz: float = 1000.0
    max_points: int = 300000
    transport: str = "swd"             # swd | rtt


class DeviceControlRequest(BaseModel):
    run: bool = True                   # reset 后是否自动运行


# ── 状态 ──────────────────────────────────────────────

@router.get("/probes/{uid}/monitor/status")
def monitor_status(uid: str):
    """查询 Monitor 状态"""
    return monitor_backend.get_status(uid)


# ── ELF 符号 ──────────────────────────────────────────────

@router.post("/probes/{uid}/monitor/elf/load")
def load_elf(uid: str, req: ElfLoadRequest):
    """加载 ELF/AXF 文件，解析 DWARF 符号表"""
    result = monitor_backend.load_elf(uid, req.path)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "ELF load failed"))
    return result


@router.get("/probes/{uid}/monitor/elf/changed")
def check_elf_changed(uid: str):
    """检测已加载 ELF 文件是否在磁盘上变化（供前端轮询提醒重载）"""
    return monitor_backend.check_elf_changed(uid)


@router.get("/probes/{uid}/monitor/symbols")
def get_symbols(uid: str, filter: str = "", type: str = "object",
                page: int = 1, page_size: int = 200):
    """查询符号列表（分页）"""
    result = monitor_backend.get_symbols(uid, filter, type, page, page_size)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "No ELF loaded"))
    return result


# ── 变量管理 ──────────────────────────────────────────────

@router.get("/probes/{uid}/monitor/variables")
def list_variables(uid: str):
    """获取监视变量列表"""
    return {"variables": monitor_backend.get_variables(uid)}


@router.post("/probes/{uid}/monitor/variables")
def add_variable(uid: str, req: AddVariableRequest):
    """添加监视变量"""
    result = monitor_backend.add_variable(
        uid, req.name, req.address, req.type, req.remark, req.refresh_sec, req.elem_index
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Add variable failed"))
    return result


@router.delete("/probes/{uid}/monitor/variables/{var_id}")
def remove_variable(uid: str, var_id: str):
    """移除监视变量"""
    result = monitor_backend.remove_variable(uid, var_id)
    if not result["success"]:
        raise HTTPException(status_code=404, detail="Variable not found")
    return result


@router.put("/probes/{uid}/monitor/variables/{var_id}/value")
def write_variable(uid: str, var_id: str, req: WriteVariableRequest):
    """写入变量值到下位机（实时改参）"""
    result = monitor_backend.write_variable(uid, var_id, req.value)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Write failed"))
    return result


# ── 采样控制 ──────────────────────────────────────────────

@router.post("/probes/{uid}/monitor/start")
def start_sampling(uid: str, req: StartSamplingRequest):
    """启动采样"""
    result = monitor_backend.start(uid, req.rate_hz, req.max_points, req.transport)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Start failed"))
    return result


@router.post("/probes/{uid}/monitor/stop")
def stop_sampling(uid: str):
    """停止采样"""
    return monitor_backend.stop(uid)


@router.post("/probes/{uid}/monitor/pause")
def pause_sampling(uid: str):
    """暂停采样（采样线程保持运行但跳过读取，保留会话状态）"""
    monitor_backend.pause(uid)
    return {"success": True, "paused": True}


@router.post("/probes/{uid}/monitor/resume")
def resume_sampling(uid: str):
    """恢复采样"""
    monitor_backend.resume(uid)
    return {"success": True, "paused": False}


# ── 目标设备控制（Run/Halt/Reset）─────────────────────────
# 直接操作 CPU 内核状态，不影响采样线程。
# 采样运行时执行 Run/Halt/Reset，采样继续绘图（波形反映内核状态变化）。

@router.post("/probes/{uid}/monitor/device/run")
def device_run(uid: str):
    """运行目标内核（resume）"""
    result = monitor_backend.run_target(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Run failed"))
    return result


@router.post("/probes/{uid}/monitor/device/halt")
def device_halt(uid: str):
    """暂停目标内核（halt）"""
    result = monitor_backend.halt_target(uid)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Halt failed"))
    return result


@router.post("/probes/{uid}/monitor/device/reset")
def device_reset(uid: str, req: DeviceControlRequest):
    """复位目标芯片"""
    result = monitor_backend.reset_target(uid, run=req.run)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Reset failed"))
    return result


@router.get("/probes/{uid}/monitor/device/state")
def device_state(uid: str):
    """查询目标内核状态（running/halted）"""
    return monitor_backend.get_core_state(uid)


# ── 录制导出 ──────────────────────────────────────────────

@router.get("/probes/{uid}/monitor/record/export")
def export_record(uid: str, format: str = "csv",
                  mode: str = "all",
                  recent_seconds: float | None = None,
                  start_ms: float | None = None,
                  end_ms: float | None = None):
    """导出录制数据（支持时间范围：mode=all/recent/custom；数据源=落盘文件，无上限）"""
    if format != "csv":
        raise HTTPException(status_code=400, detail="Only csv format supported")
    result = monitor_backend.export_csv(
        uid, mode=mode, recent_seconds=recent_seconds,
        start_ms=start_ms, end_ms=end_ms,
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Export failed"))
    return result


@router.get("/probes/{uid}/monitor/record")
def read_record(uid: str, start_ms: float | None = None,
                end_ms: float | None = None, limit: int | None = None):
    """按时间范围读取落盘采样数据（历史无上限，供前端全览/缩放加载）

    返回 {success, segments: [{vars, samples:[{t_ms, values}]}]}
    """
    result = monitor_backend.read_record(uid, start_ms=start_ms, end_ms=end_ms, limit=limit)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("error", "Read failed"))
    return result
