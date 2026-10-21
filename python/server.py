# OMNI Link
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""
OMNI Link - Python 后端入口

启动 FastAPI 服务器，通过 stdout 输出端口信息供 Electron 主进程读取。
启动时自动初始化探针热插拔监控。
"""

import sys
import os
import json
import atexit
import asyncio
import argparse
import logging
import uvicorn
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from api import probes, flash, targets, files, devices, commander, rtt, tools, monitor, system, packs, zone
from omni_tools import router as omni_tool_router
from core.events import event_manager
from core.probe_monitor import probe_monitor
from core.pyocd_backend import backend

# 后端版本号（与前端 package.json 保持一致）
BACKEND_VERSION = "0.3.1"

logger = logging.getLogger("omni-link")


# ---------------------------------------------------------------------------
# 共享后端注册表
#
# 后端启动后把 {pid, port} 写入一个用户级、跨安装布局都相同的文件，任何调用方
# （CLI `omni`、其他工具）都能据此发现并复用**同一个**后端进程，而不会各自再拉起
# 一个后端去抢同一探针。路径计算必须与 CLI 侧 omni_cli/config.py 的
# _state_dir 保持一致。
# ---------------------------------------------------------------------------
def _state_dir() -> str:
    env = os.environ.get("OMNI_STATE_DIR")
    if env:
        return env
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "omni-link")


def shared_runtime_file() -> str:
    return os.path.join(_state_dir(), "backend.json")


def publish_runtime(host: str, port: int) -> None:
    """写入共享注册表，供 CLI 等外部进程发现本后端。"""
    path = shared_runtime_file()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = {
            "pid": os.getpid(),
            "host": host,
            "port": port,
            "version": BACKEND_VERSION,
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        logger.warning(f"Failed to publish backend runtime file: {e}")


def unpublish_runtime() -> None:
    """进程退出时删除注册表；仅当记录仍指向本进程时才删，避免误删后启动的后端。"""
    path = shared_runtime_file()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("pid") == os.getpid():
            os.remove(path)
    except Exception:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时初始化探针监控，关闭时清理资源"""
    loop = asyncio.get_event_loop()
    event_manager.set_loop(loop)

    # J-Link DLL 非线程安全：把所有 pylink.JLink 调用串行化。
    # 必须在探针监控线程以及任何 API 请求之前安装（详见 core/jlink_lock.py）。
    from core.jlink_lock import install_pylink_lock
    install_pylink_lock()

    # 启动探针热插拔监控
    probe_monitor.start(loop)

    # 加载已安装的 CMSIS-Pack（重新注册芯片到 TARGET 字典）
    try:
        from core.pack_manager import load_installed_packs
        pack_count = load_installed_packs()
        if pack_count > 0:
            logger.info(f"Loaded {pack_count} CMSIS-Pack(s)")
    except Exception as e:
        logger.warning(f"Failed to load CMSIS-Packs: {e}")

    # 加载 FLM 自定义芯片
    try:
        from core.custom_target import load_custom_targets
        custom_count = load_custom_targets()
        if custom_count > 0:
            logger.info(f"Loaded {custom_count} custom FLM target(s)")
    except Exception as e:
        logger.warning(f"Failed to load custom targets: {e}")

    logger.info("Application started")

    yield

    # 关闭时清理
    probe_monitor.stop()
    backend.cleanup()
    from core.commander_backend import commander_backend
    commander_backend.cleanup_all()
    from core.rtt_backend import rtt_backend
    rtt_backend.cleanup_all()
    from core.monitor_backend import monitor_backend
    monitor_backend.cleanup_all()
    from core.elf_backend import elf_backend
    elf_backend.cleanup_all()
    # OMNI Tool：释放可能占用的串口
    omni_tool_router.cleanup()
    logger.info("Application shutdown")


app = FastAPI(title="OMNI Link Backend", version=BACKEND_VERSION, lifespan=lifespan)

# CORS 配置：允许 Electron 渲染进程（开发模式 localhost:5173/5174）访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(probes.router, prefix="/api/probes", tags=["probes"])
app.include_router(targets.router, prefix="/api/targets", tags=["targets"])
app.include_router(devices.router, prefix="/api/devices", tags=["devices"])
app.include_router(packs.router, prefix="/api/packs", tags=["packs"])
app.include_router(flash.router, prefix="/api", tags=["flash"])
app.include_router(files.router, prefix="/api/files", tags=["files"])
app.include_router(commander.router, prefix="/api", tags=["commander"])
app.include_router(rtt.router, prefix="/api", tags=["rtt"])
app.include_router(monitor.router, prefix="/api", tags=["monitor"])
app.include_router(system.router, prefix="/api", tags=["system"])
app.include_router(tools.router, prefix="/api", tags=["tools"])
app.include_router(zone.router, prefix="/api", tags=["zone"])
app.include_router(omni_tool_router.router, prefix="/api", tags=["omni-tool"])


# WebSocket 端点
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await event_manager.handle_websocket(websocket)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "pid": os.getpid(),
        "ws_connections": event_manager.connection_count,
    }


def load_config_port():
    """从项目根目录的 backend.config.json 读取后端端口，未配置则返回 None。"""
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend.config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        port = cfg.get("backendPort")
        return int(port) if port else None
    except Exception:
        return None


def _configure_stdio() -> None:
    """把后端 stdout/stderr 固定为 UTF-8。

    后端 stderr 由 CLI/Electron 重定向到 UTF-8 日志文件；若 Python 按系统 locale
    （中文 Windows=cp936）写日志，日志文件里就会是 GBK 字节，用 UTF-8 打开即乱码。
    stdout 只输出握手 JSON（ASCII），不受影响。尊重用户显式设置的 PYTHONIOENCODING。
    """
    if os.environ.get("PYTHONIOENCODING"):
        return
    for stream in (sys.stdout, sys.stderr):
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, OSError, ValueError):
            pass


def main():
    _configure_stdio()
    parser = argparse.ArgumentParser(description="OMNI Link Backend Server")
    parser.add_argument("--port", type=int, default=None,
                        help="监听端口 (默认读取 backend.config.json，未配置则自动分配)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="监听地址")
    parser.add_argument("--log-level", type=str, default="info",
                        choices=["debug", "info", "warning", "error"],
                        help="日志级别")
    args = parser.parse_args()

    # 配置日志
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        stream=sys.stderr,  # 日志输出到 stderr，不干扰 stdout 的端口 JSON
    )

    actual_port = args.port
    if actual_port is None:
        actual_port = load_config_port()

    # 如果端口未配置或为 0（自动分配），先绑定一个 socket 获取可用端口
    if actual_port is None or actual_port == 0:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind((args.host, 0))
        actual_port = sock.getsockname()[1]
        sock.close()

    # 输出端口信息（Electron 主进程读取此行）
    print(json.dumps({"port": actual_port}), flush=True)

    # 共享注册表：让 CLI 等外部进程能发现并复用本后端（退出时自动清理）
    publish_runtime(args.host, actual_port)
    atexit.register(unpublish_runtime)

    # 使用 uvicorn 运行
    config = uvicorn.Config(
        app,
        host=args.host,
        port=actual_port,
        log_level="warning",
        access_log=False,
        ws="wsproto",
    )
    server = uvicorn.Server(config)
    # 暴露给 /api/system/shutdown 端点，触发优雅退出（执行 lifespan 关闭清理）
    app.state._server = server
    server.run()


if __name__ == "__main__":
    main()
