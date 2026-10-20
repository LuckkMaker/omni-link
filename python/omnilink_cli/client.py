"""后端 REST 客户端与进程生命周期

- ApiClient：基于标准库 urllib 的轻量 HTTP 客户端，零第三方依赖。
- 破解 allure：managed（每次调用临时拉起/关停）与 persistent（常驻 daemon）两种
  后端进程管理模式，复用 Electron 主进程的 {@code {"port": N}} 握手协议。
"""

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from . import config


class ApiError(Exception):
    """后端业务/HTTP 错误。detail 提取后端 FastAPI 的 detail 字段。

    kind 用于 CLI 区分“后端没启动 / 后端僵死 / 后端返回业务错误”，避免把
    “HTTP 无响应”误报成“未找到后端”：
      - "http"        后端返回了 HTTP 错误（含 detail）
      - "timeout"     端口可连但请求超时（后端僵死或被硬件操作阻塞）
      - "unreachable" 连接失败（端口无监听）
      - "error"       其它本地异常
    """

    def __init__(self, status, detail, kind: str = "http"):
        self.status = status
        self.detail = detail
        self.kind = kind
        super().__init__(detail)


class ApiClient:
    def __init__(self, port: int, timeout: int = 30):
        self.port = int(port)
        self.base = f"http://127.0.0.1:{port}"
        self.timeout = timeout

    def _classify_timeout(self) -> ApiError:
        """超时归因：端口无监听（后端未启动）还是端口可连但 HTTP 不通（僵死）。

        Windows 上连接一个未监听的本机端口也会报 TimeoutError 而不是
        ConnectionRefused，单看异常类型无法区分；用一次短 TCP 探测补充判断，
        避免把“后端没启动”误报成“后端无响应”（实机报告 P1-3）。
        """
        if not port_open(self.port, timeout=0.5):
            return ApiError(0, f"无法连接后端（端口 {self.port} 无监听）", kind="unreachable")
        return ApiError(0, f"请求超时（{self.timeout} 秒）", kind="timeout")

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
            raise ApiError(e.code, detail, kind="http") from None
        except urllib.error.URLError as e:
            reason = getattr(e, "reason", e)
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise self._classify_timeout() from None
            raise ApiError(0, f"无法连接后端: {reason}", kind="unreachable") from None
        except (socket.timeout, TimeoutError):
            raise self._classify_timeout() from None
        except json.JSONDecodeError as e:
            raise ApiError(0, f"后端返回了非 JSON 响应: {e}", kind="error") from None
        except Exception as e:
            raise ApiError(0, str(e), kind="error") from None

    def get(self, path: str) -> dict:
        return self.request("GET", path)

    def post(self, path: str, payload=None) -> dict:
        return self.request("POST", path, payload)

    def put(self, path: str, payload=None) -> dict:
        return self.request("PUT", path, payload)

    def patch(self, path: str, payload=None) -> dict:
        return self.request("PATCH", path, payload)

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


def port_open(port: int, timeout: float = 0.5) -> bool:
    """TCP 层探测端口是否有进程监听（不依赖后端 HTTP 响应）。

    后端事件循环被 J-Link 等同步调用阻塞时 /api/health 恒超时，但监听套接字
    仍在内核 accept 队列里，TCP 连接照样成功——据此区分「进程已退出」与
    「进程僵死仍占着端口/J-Link」。
    """
    import socket

    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def find_pids_by_port(port: int) -> list[int]:
    """返回本机监听指定端口的进程 PID（仅标准库，跨平台）。

    用于定位「手动 server.py / Electron 托管」这类没有运行时 pid 记录的后端。
    """
    pids: list[int] = []
    try:
        if os.name == "nt":
            out = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                                 capture_output=True, text=True, timeout=10).stdout
            for line in out.splitlines():
                parts = line.split()
                # 形如：TCP  127.0.0.1:57123  0.0.0.0:0  LISTENING  17904
                if len(parts) >= 5 and parts[0].upper() == "TCP" \
                        and parts[3].upper() == "LISTENING" \
                        and parts[1].rsplit(":", 1)[-1] == str(port):
                    try:
                        pids.append(int(parts[4]))
                    except ValueError:
                        pass
        else:
            out = subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                                 capture_output=True, text=True, timeout=10).stdout
            pids = [int(x) for x in out.split() if x.strip().isdigit()]
    except Exception:
        pass
    return sorted(set(pids))


def pid_alive(pid: int) -> bool:
    """进程是否仍存活。

    不能用 os.kill(pid, 0) 判活：Windows 上 os.kill 只支持发送终止信号，
    传 0 会直接把进程 TerminateProcess 掉。故 Windows 走 tasklist。
    """
    if not pid:
        return False
    try:
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {int(pid)}", "/NH"],
                                 capture_output=True, text=True, timeout=10).stdout
            # 输出每行形如：python.exe  17904  Console  1  115,932 K
            for line in out.splitlines():
                cols = line.split()
                if len(cols) >= 2 and cols[1] == str(int(pid)):
                    return True
            return False
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


# ── 后端进程管理 ────────────────────────────────────────────

def _backend_command() -> list[str]:
    """构造启动后端的命令：

    - 打包态：使用与 CLI 同目录的 omni-backend.exe。
    - 源码态：用当前解释器运行 server.py，保证改动即时生效。
    与 Electron 主进程约定一致：传 --port 0（自动分配），读 stdout 首行
    {"port": N} 即就绪。
    """
    explicit = os.environ.get("OMNI_BACKEND_EXE")
    if explicit and os.path.exists(explicit):
        return [explicit, "--port", "0"]

    if getattr(sys, "frozen", False):
        exes = _candidate_backend_exes()
    else:
        # 源码态优先 server.py，避免误用 dist/ 里的旧 exe
        exes = _candidate_backend_exes()
        if os.path.exists(config.BACKEND_SERVER_PY):
            return [sys.executable, config.BACKEND_SERVER_PY, "--port", "0"]

    for exe in exes:
        if os.path.exists(exe):
            return [exe, "--port", "0"]

    raise ApiError(
        0,
        f"未找到后端 server.py: {config.BACKEND_SERVER_PY}\n"
        "  wheel 安装的 CLI 请设置 OMNI_BACKEND_DIR 指向后端目录，"
        "或先手动启动后端并用 --backend-port 指定端口。",
        kind="error",
    )


def _candidate_backend_exes() -> list[str]:
    """收集可能的打包后端可执行文件路径：

    1. 安装态：CLI（resources/python/omni.exe）与后端
       （resources/python/omni-backend.exe）同目录。
    2. 构建态：python/dist/omni-backend/omni-backend.exe（onedir）。
    """
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    return [
        os.path.join(exe_dir, "omni-backend.exe"),
        os.path.join(config.BACKEND_DIR, "dist", "omni-backend", "omni-backend.exe"),
    ]


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
        raise ApiError(0, "后端启动超时或握手失败（未从 stdout 收到端口 JSON）", kind="error")
    # 端口 JSON 在 uvicorn 绑定 socket 之前就已打印，需等到真正可连才返回
    if not _wait_reachable(port, deadline):
        proc.kill()
        raise ApiError(0, "后端端口未在期限内就绪", kind="error")
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
        raise ApiError(0, "后端常驻进程启动失败或超时", kind="error")
    if not _wait_reachable(port, deadline):
        proc.kill()
        raise ApiError(0, "后端常驻进程端口未在期限内就绪", kind="error")
    config.write_runtime({"pid": proc.pid, "port": port, "managed": False})
    return {"pid": proc.pid, "port": port}


def stop(pid: int) -> None:
    """终止后端进程及其子进程（兼容 Windows/Unix）。

    Windows 下 venv 启动器会再派生一个真实解释器子进程，只杀父进程会留下
    仍持有 J-Link 句柄的子进程，故用 /T 连整棵进程树一起终止。
    """
    if not pid:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, timeout=10)
        else:
            os.kill(pid, signal.SIGTERM)
    except Exception:
        pass