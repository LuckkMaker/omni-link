"""后端生命周期命令：backend start / stop / status。"""

import time

from .. import client as bclient
from .. import config
from ..formatting import ctx_error
from ..options import common_parser
from ..runtime import finish


def add_parser(sub):
    bp = sub.add_parser("backend", help="后端生命周期管理")
    bsub = bp.add_subparsers(dest="backend_sub", metavar="<sub>")

    sp = bsub.add_parser("start", parents=[common_parser()], help="启动常驻后端 daemon")
    sp.set_defaults(func=_start)

    sp = bsub.add_parser("stop", parents=[common_parser()], help="停止常驻后端")
    sp.set_defaults(func=_stop)

    sp = bsub.add_parser("status", parents=[common_parser()], help="查询后端运行状态")
    sp.set_defaults(func=_status)


def _start(args):
    # 已有可达后端（含应用托管 / 共享注册表发现的后端）则直接复用，
    # 否则会再拉起一个后端去抢同一探针。
    ports: list[int] = []
    if args.backend_port:
        ports.append(args.backend_port)
    ports += config.candidate_ports()
    for p in ports:
        if p and bclient.reachable(p):
            finish(args, {"running": True, "reused": True, "port": p},
                   f"后端已在运行: 端口={p}（复用现有后端，未重复启动）")
            return 0

    info = bclient.start_persistent(args.timeout)
    human = f"后端已启动: pid={info['pid']} 端口={info['port']}"
    finish(args, {"running": True, "pid": info["pid"], "port": info["port"]}, human)
    return 0


def _stop(args):
    rt = config.read_runtime()
    pid = rt.get("pid") if rt else None

    # 候选端口：显式指定 > 运行时记录/配置/环境变量
    ports: list[int] = []
    if args.backend_port:
        ports.append(args.backend_port)
    ports += config.candidate_ports()

    # 关停前快照监听进程。必须按 PID 判活而不是看端口：uvicorn 优雅退出会先关闭
    # 监听套接字、再跑 lifespan 清理，清理若被探针卡住则进程仍活着占着 J-Link——
    # 只看端口会把「还在跑」误判成「已停止」。
    listeners = _listener_pids(ports)

    # 1) 优雅关停：仅对能响应 HTTP 的后端有效。事件循环被 J-Link 等同步调用阻塞时
    #    /api/health 恒超时（僵死），走不了优雅路径，直接落到强杀。
    for p in ports:
        if p and bclient.reachable(p):
            try:
                bclient.ApiClient(p, args.timeout).post("/api/system/shutdown")
            except Exception:
                # 服务端在响应后立即退出，连接中断属正常现象
                pass
            # 等后端自身退出：其关停看门狗宽限期 10s（api/system.py SHUTDOWN_GRACE_S），
            # 这里多等几秒即可拿到干净结果，不必抢在它前面强杀。
            if _wait_pids_gone(listeners, timeout=14.0):
                config.clear_runtime()
                pid_txt = f"  pid={pid}" if pid else ""
                finish(args, {"stopped": True, "port": p, "pid": pid},
                       f"后端已停止: 端口={p}{pid_txt}")
                return 0
            break

    # 2) 强杀：按端口定位真实监听进程，不依赖运行时记录——手动 `server.py` /
    #    Electron 托管的后端没有 pid 记录，只有端口能找到它。stop() 连子树一起杀，
    #    避免 venv 启动器留下的子进程继续持有 J-Link。
    #    无监听进程时才回退到运行时 pid（后端存活但没在监听的场景）。
    victims = _listener_pids(ports)
    if not victims and pid and bclient.pid_alive(pid):
        victims = [int(pid)]
    if not victims:
        return ctx_error("没有正在运行的后端（端口不可达，且未定位到监听进程）")

    for v in victims:
        bclient.stop(v)

    # 3) 校验进程真的消失（僵死进程占着监听套接字，不确认就可能漏杀）
    if not _wait_pids_gone(victims, timeout=6.0):
        config.clear_runtime()
        return ctx_error(
            f"后端进程 {victims} 未能停止（可能需管理员权限）"
        )
    config.clear_runtime()
    finish(args, {"stopped": True, "pids": victims},
           f"后端已停止: pid={','.join(str(v) for v in victims)}")
    return 0


def _listener_pids(ports) -> list[int]:
    """汇总候选端口上的监听进程 PID（去重）。"""
    pids: set[int] = set()
    for p in ports:
        if p:
            pids |= set(bclient.find_pids_by_port(p))
    return sorted(pids)


def _wait_pids_gone(pids, timeout: float = 8.0) -> bool:
    """等待给定 PID 全部退出，确认后端进程消失、探针等资源已释放。空集合视为已完成。"""
    pids = [p for p in pids if p]
    if not pids:
        return True
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not any(bclient.pid_alive(p) for p in pids):
            return True
        time.sleep(0.1)
    return False


def _status(args):
    # 以端口监听为准：进程存在但 HTTP 不通=僵死（Windows 上 os.kill 不可靠）
    rt = config.read_runtime()
    pid = rt.get("pid") if rt else None

    ports: list[int] = []
    if args.backend_port:
        ports.append(args.backend_port)
    ports += config.candidate_ports()

    port = None
    hung = False
    for p in ports:
        if not p:
            continue
        if bclient.reachable(p):
            port = p
            break
        if bclient.port_open(p):
            port, hung = p, True
            break

    alive = port is not None
    if args.quiet:
        return 0 if alive else 1

    if args.json_:
        import json
        print(json.dumps({"running": alive, "hung": hung, "pid": pid, "port": port},
                         ensure_ascii=False, indent=2))
        return 0 if alive else 1

    if hung:
        pid_txt = f"  pid={pid}" if pid else ""
        print(f"僵死  端口={port}{pid_txt}（HTTP 无响应，用 `omni backend stop` 强杀）")
    elif alive:
        pid_txt = f"  pid={pid}" if pid else ""
        print(f"运行中  端口={port}{pid_txt}")
    else:
        print("未运行（可用 `omni backend start` 启动）")
    return 0 if alive else 1