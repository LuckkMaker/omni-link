"""Phase 2 共享小工具：整数解析与探针 uid 解析。"""


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


def resolve_uid(c, args) -> str | None:
    """显式 --uid 优先，否则取第一个探针的 uid。无探针时返回 None。"""
    if getattr(args, "uid", None):
        return args.uid
    try:
        probes = c.get("/api/probes").get("probes", [])
        if probes:
            return probes[0]["uid"]
    except Exception:
        pass
    return None


def _err(msg: str) -> None:
    print(f"错误: {msg}")


def require_uid(c, args) -> str | None:
    uid = resolve_uid(c, args)
    if not uid:
        _err("缺少探针 uid：请用 --uid 指定，或确保至少有一个探针已连接")
    return uid