"""叶子命令运行时：后端连接解析、统一输出与退出码。

独立于 cli.py，避免命令模块与分发器循环导入。
"""

import json

from . import client, config
from .formatting import ctx_error


def run_command(handler):
    """包装叶子命令：建立后端客户端并执行，托管模式结束自动关停。"""

    def _run(args):
        c, cleanup = _resolve(args)
        if c is None:
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
    """返回 (client, cleanup)。managed 临时拉起；否则附加到可用端口。"""
    if args.managed:
        proc, port = client.start_managed(args.timeout)
        return client.ApiClient(port, args.timeout), lambda: client.stop(proc.pid)
    ports = []
    if args.backend_port:
        ports.append(args.backend_port)
    ports += config.candidate_ports()
    for p in ports:
        if client.reachable(p):
            return client.ApiClient(p, args.timeout), None
    return None, None


def finish(args, raw, human):
    """统一输出：json 模式打印 raw 对象，否则打印 human 文本。"""
    if args.quiet:
        return
    if args.json_:
        print(json.dumps(raw, ensure_ascii=False, indent=2))
    else:
        print(human)