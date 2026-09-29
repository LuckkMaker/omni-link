"""路径与后端端口/可执行文件解析"""

import json
import os
from typing import Optional

# 包位于 python/omnilink_cli/
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(_PKG_DIR)
PROJECT_ROOT = os.path.dirname(PYTHON_DIR)


def _resolve_backend_server() -> str:
    """定位后端 server.py，按优先级：

    1. 环境变量 OMNI_BACKEND_SERVER（直接给 server.py 路径）
    2. 环境变量 OMNI_BACKEND_DIR（给后端根目录）
    3. 持久化配置 cli.config.json 里的 backend_dir（打包脚本安装后写入）
    4. 源码树布局（开发态默认）

    wheel 安装后包位于 site-packages，其上层不再是源码树，所以需要 1~3 之一。
    """
    explicit = os.environ.get("OMNI_BACKEND_SERVER")
    if explicit:
        return os.path.abspath(explicit)
    backend_dir = os.environ.get("OMNI_BACKEND_DIR")
    if backend_dir:
        return os.path.join(os.path.abspath(backend_dir), "server.py")
    persisted = _read_cli_config().get("backend_dir")
    if persisted:
        return os.path.join(os.path.abspath(persisted), "server.py")
    return os.path.join(PYTHON_DIR, "server.py")


# 持久化配置：wheel 安装后由打包脚本写入后端目录，免去每次设环境变量
CLI_CONFIG_FILE = os.path.join(_PKG_DIR, "cli.config.json")


def _read_cli_config() -> dict:
    try:
        with open(CLI_CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save_backend_dir(path: str) -> str:
    """记录后端目录到持久化配置，返回写入的绝对路径。"""
    data = _read_cli_config()
    data["backend_dir"] = os.path.abspath(path)
    with open(CLI_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data["backend_dir"]


BACKEND_SERVER_PY = _resolve_backend_server()
BACKEND_DIR = os.path.dirname(BACKEND_SERVER_PY)
# 运行时状态文件：记录常驻后端进程的 pid 与端口
RUNTIME_FILE = os.path.join(_PKG_DIR, ".backend_runtime.json")
# 后端日志文件（stderr 落盘，失败时可排查）
LOG_FILE = os.path.join(_PKG_DIR, ".backend.log")
# 常驻模式握手文件（server.py 的 stdout）——分离式进程无法保留管道，
# 重定向到文件后轮询解析端口 JSON。
HANDSHAKE_FILE = os.path.join(_PKG_DIR, ".backend.handshake.jsonl")

DEV_CONFIG_JSON = os.path.join(PROJECT_ROOT, "backend.config.json")


def read_config_port() -> Optional[int]:
    """读取 backend.config.json 中配置的后端端口"""
    try:
        with open(DEV_CONFIG_JSON, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        port = cfg.get("backendPort")
        return int(port) if port else None
    except Exception:
        return None


def read_runtime() -> Optional[dict]:
    """读取常驻后端运行时状态（pid + port + 启动方式）"""
    try:
        with open(RUNTIME_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_runtime(data: dict) -> None:
    with open(RUNTIME_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def clear_runtime() -> None:
    if os.path.exists(RUNTIME_FILE):
        os.remove(RUNTIME_FILE)


def env_port() -> Optional[int]:
    """环境变量 OMNI_BACKEND_PORT 覆盖（与 Electron 主进程保持一致）"""
    try:
        v = os.environ.get("OMNI_BACKEND_PORT")
        if v and v.isdigit() and int(v) > 0:
            return int(v)
    except Exception:
        pass
    return None


def candidate_ports() -> list[int]:
    """按优先级收集候选后端端口（去重保留顺序）"""
    ports: list[int] = []
    rt = read_runtime()
    if rt and rt.get("port"):
        ports.append(int(rt["port"]))
    cfg = read_config_port()
    if cfg:
        ports.append(cfg)
    env = env_port()
    if env:
        ports.append(env)
    seen = set()
    out = []
    for p in ports:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out