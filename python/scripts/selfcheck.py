#!/usr/bin/env python3
# OMNI Link
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""后端自检：验证后端「能独立站着」——不依赖当前目录是仓库根。

用法（在任意目录，例如 %TEMP%）::

    python D:\\workspace\\embedded\\omni-link\\python\\scripts\\selfcheck.py

    # 指定后端目录 / 期望服务名 / 超时
    python ...\\scripts\\selfcheck.py --backend-dir <backend-dir> --service bus --timeout 60

检查项（任一失败即以非 0 退出，并打印可定位的原因）:

1. ``chdir`` 到临时目录后，用当前解释器 spawn ``<backend-dir>/server.py --port 0``；
2. stdout 首行握手 ``{"port": N}``；
3. ``GET /api/health``：``status=ok``、``service`` 与期望一致、``protocol`` 存在且为整数、
   ``pid`` 与登记表一致；
4. 状态目录下的 ``backend.json`` 存在，字段齐全且 ``pid``/``port`` 与握手一致；
5. ``POST /api/system/shutdown`` 后进程在宽限期内自行退出；
6. 进程退出后 ``backend.json`` 被清理。

状态目录通过 ``OMNI_STATE_DIR`` 指到临时目录（不污染 ``%LOCALAPPDATA%``），
数据目录通过 ``OMNI_DATA_DIR`` 指到临时目录（不在源码目录里建库）。
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

# 脚本位于 <backend-dir>/scripts/，后端根目录是上一级
DEFAULT_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 与 omni-cli / Electron 约定的握手与关停宽限
HANDSHAKE_TIMEOUT_S = 45.0
SHUTDOWN_GRACE_S = 15.0

_REPO_ROOT = os.path.dirname(os.path.dirname(DEFAULT_BACKEND_DIR))


def _log(msg: str) -> None:
    print(f"[selfcheck] {msg}", flush=True)


class CheckFailure(Exception):
    """某项检查失败（携带可定位原因）。"""


# ---------------------------------------------------------------------------
# HTTP helpers（只用标准库，与 omni-cli 的零依赖约束一致）
# ---------------------------------------------------------------------------
def _request(port: int, path: str, method: str = "GET", timeout: float = 5.0) -> dict:
    url = f"http://127.0.0.1:{int(port)}{path}"
    req = urllib.request.Request(url, method=method, headers={"Accept": "application/json"})
    if method != "GET":
        req.data = b""
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def _health(port: int, timeout: float = 2.0) -> dict | None:
    """返回 /api/health；不可达或非 200/非 JSON 时返回 None。"""
    try:
        info = _request(port, "/api/health", timeout=timeout)
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None
    return info if info.get("status") == "ok" else None


def _wait_health(port: int, deadline: float) -> dict:
    """轮询 /api/health 直到可达或超时。"""
    while time.time() < deadline:
        info = _health(port)
        if info is not None:
            return info
        time.sleep(0.05)
    raise CheckFailure(f"后端端口 {port} 在期限内未就绪（/api/health 无响应）")


def _port_open(port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout):
            return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# 进程与握手
# ---------------------------------------------------------------------------
def _read_handshake(stream, deadline: float) -> dict:
    """从后端 stdout 读首行 ``{"port": N}``。

    单独线程读管道：后端启动慢（加载 pyOCD / CMSIS-Pack）时阻塞读不能拖住
    超时判断，也不能让主线程无法感知子进程已崩溃。
    """
    q: "queue.Queue[str]" = queue.Queue()

    def _pump() -> None:
        try:
            while True:
                line = stream.readline()
                if not line:
                    q.put("")
                    return
                if line.strip():
                    q.put(line)
                    return
        except Exception:  # pragma: no cover - 管道被关闭
            q.put("")

    threading.Thread(target=_pump, name="handshake", daemon=True).start()
    try:
        line = q.get(timeout=max(0.1, deadline - time.time()))
    except queue.Empty:
        raise CheckFailure("等待后端 stdout 握手超时（未收到端口 JSON）") from None
    if not line:
        raise CheckFailure("后端在输出握手前就退出了（见上方 stderr 末尾）")
    try:
        obj = json.loads(line.strip())
    except json.JSONDecodeError:
        raise CheckFailure(f"后端 stdout 首行不是 JSON: {line.strip()!r}") from None
    if not isinstance(obj, dict) or not obj.get("port"):
        raise CheckFailure(f"后端握手缺少 port 字段: {obj!r}")
    return obj


def _tail(path: str, lines: int = 30) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.readlines()
    except OSError:
        return "(无 stderr 输出)"
    return "".join(data[-lines:]).rstrip() or "(无 stderr 输出)"


def _wait_exit(proc: subprocess.Popen, timeout: float) -> int | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        code = proc.poll()
        if code is not None:
            return code
        time.sleep(0.05)
    return None


def _kill_tree(proc: subprocess.Popen) -> None:
    """结束后端进程树。

    Windows 上 venv 的 python.exe 会再派生真实解释器子进程，只 kill 父进程会
    留下仍持有探针句柄的子进程；必须按进程树终止。
    """
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=15)
        else:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=10)
    except Exception:
        pass


def _registry_path(state_dir: str) -> str:
    return os.path.join(state_dir, "backend.json")


def _read_registry(state_dir: str) -> dict | None:
    try:
        with open(_registry_path(state_dir), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def run(args: argparse.Namespace) -> None:
    backend_dir = os.path.abspath(args.backend_dir)
    server_py = os.path.join(backend_dir, "server.py")
    if not os.path.isfile(server_py):
        raise CheckFailure(f"找不到后端入口: {server_py}")

    _log(f"后端目录: {backend_dir}")
    _log(f"解释器:   {sys.executable}")

    work_dir = tempfile.mkdtemp(prefix="omni-selfcheck-")
    state_dir = os.path.join(work_dir, "state")
    data_dir = os.path.join(work_dir, "data")
    cwd_dir = os.path.join(work_dir, "cwd")
    for d in (state_dir, data_dir, cwd_dir):
        os.makedirs(d, exist_ok=True)
    log_path = os.path.join(work_dir, "backend.stderr.log")

    env = dict(os.environ)
    env["OMNI_STATE_DIR"] = state_dir
    env["OMNI_DATA_DIR"] = data_dir
    env["PYTHONIOENCODING"] = "utf-8"
    # 自检不要继承外部显式端口配置，避免固定端口被占用导致假失败
    env.pop("OMNI_BACKEND_PORT", None)
    env.pop("OMNI_DEV_CONFIG", None)

    _log(f"临时工作目录: {work_dir}（cwd 也在这里，模拟“不在仓库根”）")

    proc: subprocess.Popen | None = None
    try:
        with open(log_path, "w", encoding="utf-8") as logf:
            proc = subprocess.Popen(
                [sys.executable, server_py, "--port", "0"],
                cwd=cwd_dir,
                env=env,
                stdout=subprocess.PIPE,
                stderr=logf,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        deadline = time.time() + args.timeout

        # 1) 握手
        handshake = _read_handshake(proc.stdout, deadline)
        port = int(handshake["port"])
        _log(f"[1/6] 握手成功: port={port}")

        # 2) health
        health = _wait_health(port, deadline)
        if health.get("service") != args.service:
            raise CheckFailure(
                f"/api/health 的 service={health.get('service')!r}，期望 {args.service!r}"
            )
        protocol = health.get("protocol")
        if not isinstance(protocol, int):
            raise CheckFailure(f"/api/health 缺少整数 protocol 字段: {health!r}")
        if protocol < 1:
            raise CheckFailure(f"/api/health 的 protocol 非法: {protocol!r}")
        if not health.get("pid"):
            raise CheckFailure(f"/api/health 缺少 pid 字段: {health!r}")
        _log(f"[2/6] /api/health 正常: service={health['service']} protocol={protocol} pid={health['pid']}")

        # 3) 登记表
        registry = _read_registry(state_dir)
        if registry is None:
            raise CheckFailure(f"登记表不存在或不是合法 JSON: {_registry_path(state_dir)}")
        for key in ("service", "pid", "host", "port", "version", "protocol", "started_at"):
            if key not in registry:
                raise CheckFailure(f"登记表缺少字段 {key!r}: {registry!r}")
        if registry["service"] != args.service:
            raise CheckFailure(
                f"登记表 service={registry['service']!r}，期望 {args.service!r}"
            )
        if int(registry["port"]) != port:
            raise CheckFailure(f"登记表 port={registry['port']} 与握手 port={port} 不一致")
        if int(registry["pid"]) != int(health["pid"]):
            raise CheckFailure(
                f"登记表 pid={registry['pid']} 与 /api/health pid={health['pid']} 不一致"
            )
        if int(registry["protocol"]) != protocol:
            raise CheckFailure(
                f"登记表 protocol={registry['protocol']} 与 health protocol={protocol} 不一致"
            )
        if proc.pid != int(registry["pid"]):
            _log(f"      注意: 子进程 pid={proc.pid} 与后端 pid={registry['pid']} 不同（解释器包装，可接受）")
        _log(f"[3/6] 登记表正常: {_registry_path(state_dir)}")

        # 4) 优雅关停
        try:
            resp = _request(port, "/api/system/shutdown", method="POST", timeout=5.0)
        except (urllib.error.URLError, OSError, ValueError):
            # 后端可能在响应写完之前就开始退出，连接中断属正常
            resp = {}
        if resp and resp.get("shutdown") is not True:
            raise CheckFailure(f"/api/system/shutdown 返回异常: {resp!r}")
        _log("[4/6] 已发出关停请求")

        # 5) 进程退出
        code = _wait_exit(proc, SHUTDOWN_GRACE_S)
        if code is None:
            raise CheckFailure(f"关停请求后 {SHUTDOWN_GRACE_S:.0f}s 内进程未退出（pid={proc.pid}）")
        _log(f"[5/6] 进程已退出: exit={code}")

        # 6) 登记表清理
        if _read_registry(state_dir) is not None:
            raise CheckFailure(f"进程退出后登记表未被清理: {_registry_path(state_dir)}")
        if _port_open(port):
            raise CheckFailure(f"进程退出后端口 {port} 仍在监听")
        _log("[6/6] 登记表已清理、端口已释放")

        _log("PASS")
    except CheckFailure:
        _log("FAIL")
        _log(f"后端 stderr 末尾（{log_path}）:")
        print(_tail(log_path), flush=True)
        raise
    except Exception as exc:  # 未预期异常也按失败处理，打印 stderr 便于定位
        _log(f"FAIL（未预期异常: {type(exc).__name__}: {exc}）")
        _log(f"后端 stderr 末尾（{log_path}）:")
        print(_tail(log_path), flush=True)
        raise
    finally:
        if proc is not None and proc.poll() is None:
            _log(f"强制结束残留后端进程树 pid={proc.pid}")
            _kill_tree(proc)
        if proc is not None and proc.stdout is not None:
            try:
                proc.stdout.close()
            except Exception:
                pass
        if args.keep:
            _log(f"保留临时目录: {work_dir}")
        else:
            shutil.rmtree(work_dir, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="OMNI 后端独立自检（任意 cwd 启动 → health → 登记表 → 优雅关停）")
    parser.add_argument("--backend-dir", default=DEFAULT_BACKEND_DIR,
                        help=f"后端目录（含 server.py），默认 {DEFAULT_BACKEND_DIR}")
    parser.add_argument("--service", default="link",
                        help="期望的服务名（/api/health 与登记表的 service 字段），默认 link")
    parser.add_argument("--timeout", type=float, default=HANDSHAKE_TIMEOUT_S,
                        help=f"启动/就绪超时秒数，默认 {HANDSHAKE_TIMEOUT_S:.0f}")
    parser.add_argument("--keep", action="store_true", help="保留临时目录便于排查")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, OSError, ValueError):
            pass

    try:
        run(args)
    except CheckFailure:
        return 1
    except Exception as exc:
        _log(f"ERROR: {type(exc).__name__}: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
