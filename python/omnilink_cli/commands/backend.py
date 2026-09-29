"""后端生命周期命令：backend start / stop / status。"""

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
    info = bclient.start_persistent(args.timeout)
    human = f"后端已启动: pid={info['pid']} 端口={info['port']}"
    finish(args, {"running": True, "pid": info["pid"], "port": info["port"]}, human)
    return 0


def _stop(args):
    rt = config.read_runtime()
    if not rt or not rt.get("pid"):
        return ctx_error("没有正在运行的常驻后端进程记录")
    bclient.stop(rt["pid"])
    config.clear_runtime()
    finish(args, {"stopped": True, "pid": rt["pid"]}, f"后端已停止: pid={rt['pid']}")
    return 0


def _status(args):
    # 以端口可达性为准（进程存在但端口不通=未就绪/已僵死；Windows 上 os.kill 不可靠）
    running_port = None
    rt = config.read_runtime()
    pid = rt.get("pid") if rt else None
    for p in config.candidate_ports():
        if bclient.reachable(p):
            running_port = p
            break
    alive = running_port is not None

    if args.quiet:
        return 0 if alive else 1

    if args.json_:
        import json
        print(json.dumps({"running": alive, "pid": pid, "port": running_port},
                         ensure_ascii=False, indent=2))
        return 0 if alive else 1

    if alive:
        pid_txt = f"  pid={pid}" if pid else ""
        print(f"运行中  端口={running_port}{pid_txt}")
    else:
        print("未运行（可用 `omni backend start` 启动）")
    return 0 if alive else 1