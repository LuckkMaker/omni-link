"""Phase 2 共享小工具：整数/频率/Pack 路径解析、确认与探针 uid 解析。"""

import argparse
import os


def parse_int(value) -> int | None:
    """解析支持 0x/0b/0o 前缀的整数；None 原样返回。"""
    if value is None:
        return None
    s = str(value).strip()
    try:
        if s.lower().startswith("0x"):
            return int(s, 16)
        if s.lower().startswith("0b"):
            return int(s, 2)
        if s.lower().startswith("0o"):
            return int(s, 8)
        return int(s)
    except ValueError:
        raise ValueError(f"不是合法的整数: {value!r}")


def parse_frequency(value) -> int:
    """解析频率为 Hz，兼容 pyOCD 写法：``1000000`` / ``4m`` / ``2.5khz``。"""
    if isinstance(value, int):
        if value <= 0:
            raise argparse.ArgumentTypeError(f"频率必须大于 0: {value!r}")
        return value

    text = str(value).strip().lower()
    if not text:
        raise argparse.ArgumentTypeError("频率不能为空")

    multiplier = 1
    if text.endswith("hz"):
        text = text[:-2]
    if text.endswith("k"):
        multiplier = 1_000
        text = text[:-1]
    elif text.endswith("m"):
        multiplier = 1_000_000
        text = text[:-1]

    try:
        frequency = int(float(text) * multiplier)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"不是合法的频率: {value!r}（示例：1000000、4m、2.5khz）"
        ) from None
    if frequency <= 0:
        raise argparse.ArgumentTypeError(f"频率必须大于 0: {value!r}")
    return frequency


def resolve_pack_paths(values) -> list[str]:
    """把 ``--pack`` 的路径规范化/校验为绝对路径列表（客户端预校验）。

    与后端 ``pack_manager.validate_pack_paths`` 同规则；失败抛 ValueError，
    由命令处理器转成可读错误，避免把坏路径发到后端。
    """
    if not values:
        return []

    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        path = os.path.abspath(os.path.expanduser(str(raw).strip()))
        if not os.path.isfile(path):
            raise ValueError(f"Pack 文件不存在: {path}")
        if not path.lower().endswith(".pack"):
            raise ValueError(f"不是 .pack 文件: {path}")
        key = os.path.normcase(path)
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result


def confirm(prompt: str) -> bool:
    """交互确认；非交互/EOF 视为取消。"""
    try:
        return input(f"{prompt} [y/N] ").strip().lower() in ("y", "yes")
    except (EOFError, KeyboardInterrupt):
        return False


def resolve_uid(c, args) -> str | None:
    """显式 --uid 优先；否则优先取第一个「已连接」探针，均未连接时回退第一个。

    多探针场景不能盲取 probes[0]：机器上可能同时挂着已连接的 J-Link 和未连接的
    CMSIS-DAP，取到后者会让所有依赖探针的命令误报「Probe not connected」。

    注意：后端通信错误（ApiError）必须向上抛，由 cli.main 统一给出「后端无响应 /
    未启动」的提示；吞掉它会变成误导性的「缺少探针 uid」（实机报告 P1-3）。
    """
    if getattr(args, "uid", None):
        return args.uid
    probes = c.get("/api/probes").get("probes", [])
    if not probes:
        return None
    for p in probes:
        if p.get("state") == "connected":
            return p["uid"]
    return probes[0]["uid"]


def _err(msg: str) -> None:
    print(f"错误: {msg}")


def require_uid(c, args) -> str | None:
    uid = resolve_uid(c, args)
    if not uid:
        _err("缺少探针 uid：请用 --uid 指定，或确保至少有一个探针已连接")
    return uid