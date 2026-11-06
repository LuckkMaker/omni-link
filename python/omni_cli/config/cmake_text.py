"""极简 CMake 文本工具：去注释、提取调用、切参数。

Keil 同步只需要回答「某条语句带了哪些参数」，不需要真的解释 CMake，所以同步
用的所有规则来源（``omni/**/CMakeLists.txt``、模块 glue、工程的 CMakeLists.txt、
``board.cmake``）共用这一套切词逻辑，避免每个来源各写一份括号匹配。
"""

from __future__ import annotations

import re
from typing import Iterator

from ..context import ProjectError

_COMMENT_RE = re.compile(r"#[^\n]*")


def strip_comments(text: str) -> str:
    """把注释替换成等长空白，保持字符偏移与行号不变。"""

    return _COMMENT_RE.sub(lambda match: " " * len(match.group(0)), text)


def iter_calls(text: str, name: str) -> Iterator[tuple[int, list[str]]]:
    """遍历 ``name(...)`` 调用，产出 (行号, 参数列表)。

    ``name`` 必须是一个完整标识符（``omni_board_sources`` 不会匹配
    ``omni_board_sources_ifdef``），参数按空白切开并去掉外层双引号。
    括号不匹配直接报错——解析错了要在同步时立刻发现，而不是猜。
    """

    position = 0
    while True:
        start = text.find(name, position)
        if start < 0:
            return

        previous = text[start - 1] if start else " "
        following = start + len(name)
        if previous.isalnum() or previous in "_.":
            position = following
            continue

        opening = following
        while opening < len(text) and text[opening] in " \t\r\n":
            opening += 1
        if opening >= len(text) or text[opening] != "(":
            position = following
            continue

        depth = 0
        cursor = opening
        while cursor < len(text):
            char = text[cursor]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    break
            cursor += 1

        if depth != 0:
            raise ProjectError(f"{name} 括号不匹配", code=1)

        line_no = text.count("\n", 0, start) + 1
        args = [arg.strip('"') for arg in text[opening + 1 : cursor].split()]
        yield line_no, args
        position = cursor + 1
