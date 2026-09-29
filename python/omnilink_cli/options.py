"""叶子命令共用的全局选项。

仅挂在具体的叶子 parser 上（位于子命令之后，如 `omni probe list --json`），
避免与根 parser 同名选项发生 argparse 默认值覆盖冲突。
"""

import argparse


def common_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--backend-port", type=int, default=None, metavar="PORT",
                   help="后端端口（优先于常驻/配置文件）")
    p.add_argument("--managed", action="store_true", default=False,
                   help="临时拉起托管后端执行完关停（无需先 backend start）")
    p.add_argument("--json", dest="json_", action="store_true", default=False,
                   help="输出 JSON（供脚本/CI 消费）")
    p.add_argument("--quiet", action="store_true", default=False,
                   help="仅设置退出码，不输出任何内容")
    p.add_argument("--timeout", type=int, default=30, metavar="SEC",
                   help="后端 HTTP 超时秒数（默认 30）")
    return p