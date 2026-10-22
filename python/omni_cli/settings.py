"""路径与后端端口/可执行文件解析"""

import json
import os
import sys
from typing import Optional

# 包位于 python/omni_cli/
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(_PKG_DIR)
PROJECT_ROOT = os.path.dirname(PYTHON_DIR)

# 是否运行在 PyInstaller 打包产物中。onefile 模式下 __file__ 指向的 _MEIPASS
# 是一次性临时目录，不可用于持久化状态文件。
_FROZEN = getattr(sys, "frozen", False)


def _state_dir() -> str:
    """跨进程共享状态目录。

    必须与后端 server.py 的 _state_dir 计算方式保持一致：后端启动后会把
    {pid, port} 写入该目录下的 backend.json，CLI 据此发现并复用同一个后端
    （应用托管的后端 / 手工启动的后端都可被找到）。
    """
    env = os.environ.get("OMNI_STATE_DIR")
    if env:
        return env
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "omni-link")


# 可变状态文件目录：源码态放包目录（便于开发观察）；打包态放用户级目录，
# 因为 onefile 解包目录是一次性的，写入会随进程退出丢失。
_STATE_ROOT = _state_dir() if _FROZEN else _PKG_DIR


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
CLI_CONFIG_FILE = os.path.join(_STATE_ROOT, "cli.config.json")


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
RUNTIME_FILE = os.path.join(_STATE_ROOT, ".backend_runtime.json")
# 后端日志文件（stderr 落盘，失败时可排查）
LOG_FILE = os.path.join(_STATE_ROOT, ".backend.log")
# 常驻模式握手文件（server.py 的 stdout）——分离式进程无法保留管道，
# 重定向到文件后轮询解析端口 JSON。
HANDSHAKE_FILE = os.path.join(_STATE_ROOT, ".backend.handshake.jsonl")

DEV_CONFIG_JSON = os.path.join(PROJECT_ROOT, "backend.config.json")

# 后端写入的共享注册表（含 pid/port）
SHARED_RUNTIME_FILE = os.path.join(_state_dir(), "backend.json")


def read_shared_runtime() -> Optional[dict]:
    """读取后端写入的共享注册表；不存在或损坏时返回 None。"""
    try:
        with open(SHARED_RUNTIME_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


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
    os.makedirs(os.path.dirname(RUNTIME_FILE), exist_ok=True)
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
    # 共享注册表：当前真正在跑的后端（应用托管 / 手工启动）——优先复用，
    # 避免 CLI 另起一个后端去抢同一探针。
    shared = read_shared_runtime()
    if shared and shared.get("port"):
        ports.append(int(shared["port"]))
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