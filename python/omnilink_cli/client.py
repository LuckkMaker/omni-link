"""后端 REST 客户端与进程生命周期

- ApiClient：基于标准库 urllib 的轻量 HTTP 客户端，零第三方依赖。
- 破解 allure：managed（每次调用临时拉起/关停）与 persistent（常驻 daemon）两种
  后端进程管理模式，复用 Electron 主进程的 {@code {"port": N}} 握手协议。
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

from . import config


class ApiError(Exception):
    """后端业务/HTTP 错误。detail 提取后端 FastAPI 的 detail 字段。"""

    def __init__(self, status, detail):
        self.status = status
        self.detail = detail
        super().__init__(detail)


class ApiClient:
    def __init__(self, port: int, timeout: int = 30):
        self.base = f"http://127.0.0.1:{port}"
        self.timeout = timeout

    def request(self, method: str, path: str, payload=None) -> dict:
        url = self.base + path
        headers = {"Accept": "application/json"}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                if not raw:
                    return {}
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                j = json.loads(body)
                detail = j.get("detail", body)
            except Exception:
                detail = body
            raise ApiError(e.code, detail) from None
        except urllib.error.URLError as e:
            raise ApiError(0, f"无法连接后端: {e.reason}") from None
        except Exception as e:
            raise ApiError(0, str(e)) from None

    def get(self, path: str) -> dict:
        return self.request("GET", path)

    def post(self, path: str, payload=None) -> dict:
        return self.request("POST", path, payload)

    def put(self, path: str, payload=None) -> dict:
        return self.request("PUT", path, payload)

    def delete(self, path: str) -> dict:
        return self.request("DELETE", path)

    def health(self, timeout: float = 1.5) -> bool:
        """轻量健康探测，不抛异常。"""
        old = self.timeout
        self.timeout = timeout
        try:
            resp = self.request("GET", "/api/health")
            return resp.get("status") == "ok"
        except Exception:
            return False
        finally:
            self.timeout = old


def reachable(port: int, timeout: float = 1.5) -> bool:
    return ApiClient(int(port), timeout).health(timeout)


# ── 后端进程管理 ────────────────────────────────────────────

def _backend_command() -> list[str]:
    """构造启动后端的命令：

    优先使用打包后的 omni-backend.exe；否则用当前解释器运行 server.py。
    与 Electron 主进程约定一致：传 --port 0（自动分配），读 stdout 首行
    {"port": N} 即就绪。
    """
    exe = os.path.join(config.BACKEND_DIR, "dist", "omni-backend.exe")
    if os.path.exists(exe):
        return [exe, "--port", "0"]
    if not os.path.exists(config.BACKEND_SERVER_PY):
        raise ApiError(
            0,
            f"未找到后端 server.py: {config.BACKEND_SERVER_PY}\n"
            "  wheel 安装的 CLI 请设置 OMNI_BACKEND_DIR 指向后端目录，"
            "或先手动启动后端并用 --backend-port 指定端口。",
        )
    return [sys.executable, config.BACKEND_SERVER_PY, "--port", "0"]


def _open_log() -> object:
    os.makedirs(config.LOG_FILE and os.path.dirname(config.LOG_FILE) or ".", exist_ok=True)
    return open(config.LOG_FILE, "a", encoding="utf-8")


def _read_handshake_line(stream, deadline: float) -> int:
    """从流(文件或管道)中读取一行端正的端口 JSON，返回端口。

    server.py 就绪时向 stdout 打印 {"port": N}。
    """
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            return None
        line = stream.readline()
        if not line:
            # 无更多输出：等待就绪文件中出现内容（文件写完后 readline 会立即返回 EOF；
            # 若进程已退出会因文件为空而持续 EOF——用重开方式兜底）
            if hasattr(stream, "flush"):
                stream.flush()
            time.sleep(0.05)
            continue
        try:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if isinstance(obj, dict) and obj.get("port"):
                return int(obj["port"])
        except Exception:
            pass


def _wait_reachable(port: int, deadline: float) -> bool:
    """轮询端口的 /api/health，直到可达或超时。"""
    while time.time() < deadline:
        if reachable(port):
            return True
        time.sleep(0.05)
    return False


def start_managed(timeout: int = 30) -> tuple[subprocess.Popen, int]:
    """临时托管模式：启动后端，读握手，返回 (进程, 端口)。调用方负责 terminate。"""
    logf = _open_log()
    proc = subprocess.Popen(
        _backend_command(),
        stdout=subprocess.PIPE,
        stderr=logf,
        text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    deadline = time.time() + timeout
    port = None
    try:
        port = _read_handshake_line(proc.stdout, deadline)
    except Exception:
        pass
    finally:
        # 进程会继续往 stderr 打日志；stdout 只剩握手一行，释放读端即可
        proc.stdout.close()
    if port is None:
        proc.kill()
        raise ApiError(0, "后端启动超时或握手失败（未从 stdout 收到端口 JSON）")
    # 端口 JSON 在 uvicorn 绑定 socket 之前就已打印，需等到真正可连才返回
    if not _wait_reachable(port, deadline):
        proc.kill()
        raise ApiError(0, "后端端口未在期限内就绪")
    return proc, port


def start_persistent(timeout: int = 30) -> dict:
    """启动常驻后端 daemon。

    Windows 下子进程不会随父进程退出而被回收；用分离标志 + stdout 重定向到文件，
    轮询握手文件解析端口，写 pid/port 到运行时文件。返回 {pid, port}。
    """
    logf = _open_log()
    handshake = open(config.HANDSHAKE_FILE, "w", encoding="utf-8")
    flags = 0
    flags |= getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(
        _backend_command(),
        stdout=handshake,
        stderr=logf,
        text=True,
        creationflags=flags,
    )
    handshake.close()

    deadline = time.time() + timeout
    port = None
    while time.time() < deadline:
        try:
            with open(config.HANDSHAKE_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("{"):
                        try:
                            obj = json.loads(line)
                            if obj.get("port"):
                                port = int(obj["port"])
                                break
                        except Exception:
                            pass
                if port:
                    break
        except FileNotFoundError:
            pass
        if proc.poll() is not None:
            break
        time.sleep(0.05)

    if port is None:
        proc.kill()
        raise ApiError(0, "后端常驻进程启动失败或超时")
    if not _wait_reachable(port, deadline):
        proc.kill()
        raise ApiError(0, "后端常驻进程端口未在期限内就绪")
    config.write_runtime({"pid": proc.pid, "port": port, "managed": False})
    return {"pid": proc.pid, "port": port}


def stop(pid: int) -> None:
    """终止后端进程（兼容 Windows/Unix）。"""
    if not pid:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                           capture_output=True, timeout=10)
        else:
            os.kill(pid, signal.SIGTERM)
    except Exception:
        pass