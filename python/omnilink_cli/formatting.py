"""格式化与统一输出

默认输出可读表格；--json 时输出结构化 JSON，供脚本/CI 消费。
"""

import json
import sys


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