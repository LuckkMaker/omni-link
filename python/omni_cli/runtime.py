"""叶子命令运行时：后端连接解析、统一输出与退出码。

独立于 cli.py，避免命令模块与分发器循环导入。
"""

import json

from . import client, settings
from .formatting import ctx_error


def run_command(handler):
    """包装叶子命令：建立后端客户端并执行，托管模式结束自动关停。"""

    def _run(args):
        c, cleanup, hung_ports = _resolve(args)
        if c is None:
            if hung_ports:
                ports = ", ".join(str(p) for p in hung_ports)
                return ctx_error(
                    f"后端在端口 {ports} 上有监听但 HTTP 无响应（进程可能已僵死，"
                    "或正被挂起的硬件操作阻塞）。\n"
                    "  请执行 `omni backend stop` 停止后重新 `omni backend start`。"
                )
            return ctx_error(
                "未找到正在运行的后端。请先执行 `omni backend start` 启动常驻后端，"
                "或加 --managed 由本命令临时拉起。"
            )
        try:
            return handler(c, args) or 0
        finally:
            if cleanup:
                cleanup()

    return _run


def _resolve(args):
    """返回 (client, cleanup, hung_ports)。

    - managed：临时拉起；
    - 否则附加到第一个“可达”端口；
    - 全部不可达时，记录“端口在监听但 HTTP 不通”的端口（僵死后端），
      交给调用方给出可执行的提示，而不是误报“后端未启动”。
    """
    if args.managed:
        proc, port = client.start_managed(args.timeout)
        return client.ApiClient(port, args.timeout), lambda: client.stop(proc.pid), []

    ports = []
    if args.backend_port:
        ports.append(args.backend_port)
    ports += settings.candidate_ports()

    hung: list[int] = []
    for p in ports:
        if client.reachable(p):
            return client.ApiClient(p, args.timeout), None, []
        # 健康检查失败：区分“没进程”（连接被拒）与“进程僵死”（TCP 可连但 HTTP 超时）
        if client.port_open(p):
            hung.append(p)
    return None, None, hung


def finish(args, raw, human):
    """统一输出：json 模式打印 raw 对象，否则打印 human 文本。"""
    if args.quiet:
        return
    if args.json_:
        print(json.dumps(raw, ensure_ascii=False, indent=2))
    else:
        print(human)