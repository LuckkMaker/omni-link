"""系统信息 REST API

提供后端版本、数据库版本、运行环境等信息，供前端设置页展示。
"""

import asyncio
import logging
import os
import platform
import threading
import time
from fastapi import APIRouter, HTTPException, Request

from core import database

logger = logging.getLogger(__name__)
router = APIRouter()

# 优雅关停宽限期（秒）：超时后强制退出。lifespan 清理要断开探针才能释放 J-Link，
# 若底层 SWD/DLL 操作卡死则清理永不返回、进程会一直占着 J-Link 句柄——必须有硬兜底。
SHUTDOWN_GRACE_S = 10.0


def _get_pyocd_version() -> str:
    """获取 pyocd 版本号，失败回退 "unknown" """
    try:
        from pyocd._version import __version__  # type: ignore
        return __version__
    except Exception:
        return "unknown"


@router.get("/system/info")
async def system_info(request: Request):
    """返回后端/数据库/运行环境版本信息

    供前端设置页展示后端版本、数据库版本、Python/pyocd 版本等。
    app_version/backend_version 取自 FastAPI 实例的 version
    （即 server.py 中定义的 BACKEND_VERSION）。
    所有外部属性访问均做异常兜底，确保不崩溃。
    """
    try:
        backend_version = request.app.version
    except Exception:
        backend_version = "unknown"

    try:
        db_version = database.get_db_version()
    except Exception:
        db_version = 0

    try:
        db_path = database.get_db_path()
    except Exception:
        db_path = "unknown"

    try:
        source_summary = database.get_source_summary()
    except Exception:
        source_summary = {}

    return {
        "app_version": backend_version,
        "backend_version": backend_version,
        "python_version": platform.python_version(),
        "platform": platform.system(),
        "db_version": db_version,
        "db_path": db_path,
        "pyocd_version": _get_pyocd_version(),
        "source_summary": source_summary,
    }


@router.post("/system/shutdown")
async def system_shutdown(request: Request):
    """优雅关停后端进程。

    CLI 的 `omni backend stop` 在无运行时记录（例如后端由 `server.py` 直接拉起、
    Electron 主进程托管）时调用，确保任意来源的后端都能干净退出并释放探针。
    走 uvicorn 正常退出路径，触发 lifespan 关闭逻辑（断开全部探针、释放 J-Link）。
    """
    server = getattr(request.app.state, "_server", None)
    if server is None:
        # 非 uvicorn.Server 启动（如测试客户端），无法优雅退出——由调用方回退强杀
        raise HTTPException(status_code=503, detail="当前后端不支持优雅关停")

    def _request_exit():
        # uvicorn 各版本 should_exit 类型不同：旧版为 bool，新版为 asyncio.Event
        se = getattr(server, "should_exit", None)
        if hasattr(se, "set"):
            se.set()
        else:
            server.should_exit = True

    def _watchdog():
        # 兜底：优雅退出若因探针清理卡死而不返回，到点强制退出，确保 J-Link 句柄
        # 随进程终止被系统回收（os._exit 不跑清理，但能保证进程真正消失）。
        time.sleep(SHUTDOWN_GRACE_S)
        logger.warning("优雅关停超时（清理可能被探针操作阻塞），强制退出以释放探针")
        os._exit(0)

    threading.Thread(target=_watchdog, daemon=True).start()
    # 让当前请求先返回响应，再触发退出，避免连接被掐断
    asyncio.get_running_loop().call_later(0.2, _request_exit)
    return {"shutdown": True, "pid": os.getpid()}
