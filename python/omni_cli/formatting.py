"""格式化与统一输出

默认输出可读表格；--json 时输出结构化 JSON，供脚本/CI 消费。
"""

import json
import os
import sys


def configure_stdio() -> None:
    """把 CLI 的 stdout/stderr 固定为 UTF-8。

    背景：在管道/重定向下（PowerShell 7、CI、Node 子进程、`omni ... > log`），
    Python 按系统 locale 选择输出编码（中文 Windows 为 cp936/GBK），而消费端
    通常按 UTF-8 解码，中文就会变成 U+FFFD（实机测试报告 P1-4）。

    注意：
    - 只在未显式设置 ``PYTHONIOENCODING`` 时接管，尊重用户显式配置；
    - ``errors="backslashreplace"`` 而不是 ``strict``：任何字符都能输出，
      不会因 Windows 文件名代理字符等极端输入直接抛异常；同时也不会再产生 U+FFFD
      （U+FFFD 只会来自“按错误编码解码已有字节”，不会再由本进程引入）。
    - 交互式控制台本就由 Python 走 UTF-8（_WindowsConsoleIO），此处只影响重定向/管道。
    """
    if os.environ.get("PYTHONIOENCODING"):
        return
    for stream in (sys.stdout, sys.stderr):
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, OSError, ValueError):
            # pythonw / 已关闭的流 / 非 TextIOWrapper：保持原样即可
            pass


class OutputWriter:
    """管理整体输出风格（json/quiet），并归一化退出码。"""

    def __init__(self, as_json: bool = False, quiet: bool = False):
        self.as_json = as_json
        self.quiet = quiet

    def emit(self, data, *, exit_code: int = 0) -> None:
        """输出结构化结果。data 为任意可 JSON 序列化对象。"""
        if self.quiet:
            sys.exit(exit_code)
        if self.as_json:
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            print(data)
        sys.exit(exit_code)


def print_json(data) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def render_table(headers: list[str], rows: list[list]) -> str:
    """无第三方依赖的简单表格渲染（等宽对齐，保证 --json 之外也好看）。"""
    rows_s = [[_to_str(c) for c in r] for r in rows]
    widths = [len(h) for h in headers]
    for r in rows_s:
        for i, c in enumerate(r):
            if i < len(widths):
                widths[i] = max(widths[i], len(c))
    widths = [min(w, 60) for w in widths]

    def fmt_row(cells):
        pad = []
        for i, c in enumerate(cells):
            w = widths[i] if i < len(widths) else 0
            pad.append(c if len(c) <= w else c[: w - 1] + "…")
        return "  ".join(cell.ljust(widths[i]) if i < len(widths)
                         else cell for i, cell in enumerate(pad))

    lines = [fmt_row(headers), "  ".join("-" * w for w in widths)]
    for r in rows_s:
        lines.append(fmt_row(r))
    return "\n".join(lines)


def print_table(headers: list[str], rows: list[list]) -> None:
    print(render_table(headers, rows))


def _to_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def ctx_error(msg: str) -> int:
    print(f"错误: {msg}", file=sys.stderr)
    return 1