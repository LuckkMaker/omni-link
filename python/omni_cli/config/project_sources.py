"""从工程自己的 ``CMakeLists.txt`` 与 ``boards/<board>/board.cmake`` 解析 Keil 规则。

工程源码由工程自己决定，不跟 Kconfig 走，所以这里产出的规则是「无条件」的
（``symbol=None``）：只按构建口径补文件，不删。

只同步源文件，不动 ``IncludePath``——工程级的头文件目录在 Keil 里写 ``.\\src``，
和 omni/modules 的 ``..\\..\\..`` 不是一套写法，混进 managed 逻辑只会把已有条目
改写成另一种形式。

分组沿用仓库既有工程：

* ``src/*.c``、``boards/<board>/*.c`` → ``application``；
* ``boards/<board>/STM32CubeMX/Core/Src/*`` → ``stm32cubemx``；
* ``boards/<board>/startup/*``、``omni_board_startup()``/``omni_board_armasm()``
  → ``startup``。
"""

from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET
from typing import Callable, Optional

from ..context import ProjectError
from .cmake_text import iter_calls, strip_comments

#: 工程自己的 CMake 目标：``target_sources(app PRIVATE ...)``
PROJECT_TARGET = "app"

#: board.cmake 里登记源文件的宏 → 组名提示（None 表示按路径推导）
BOARD_SOURCE_CALLS = {
    "omni_board_sources": None,
    "omni_board_startup": "startup",
    "omni_board_armasm": "startup",
}

SOURCE_EXTENSIONS = (".c", ".cc", ".cpp", ".s", ".S", ".asm")
ASM_EXTENSIONS = (".s", ".asm")

#: 工程里指向板目录的路径：``.\boards\stm32f407ig\bsp.c``
_BOARD_PATH_RE = re.compile(r"[\\/]boards[\\/]([^\\/\"]+)[\\/]")


def _read(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return strip_comments(handle.read())
    except OSError as exc:
        raise ProjectError(f"无法读取 {path}: {exc}", code=1) from exc


def _resolve_argument(location: str, line_no: int, macro: str, arg: str) -> str:
    if arg.startswith("${"):
        raise ProjectError(
            f"{location}:{line_no}: {macro}() 不支持变量参数 {arg}，请把文件直接写出来",
            code=1,
        )
    relative = arg.replace("\\", "/")
    if os.path.isabs(relative):
        raise ProjectError(
            f"{location}:{line_no}: {macro}() 只接受工程内相对路径，收到 {arg}",
            code=1,
        )
    return relative


def parse_project_cmakelists(path: str) -> list[str]:
    """返回工程 ``CMakeLists.txt`` 里 ``app`` 目标的源文件（工程相对、``/`` 分隔）。"""

    text = _read(path)
    location = os.path.basename(os.path.dirname(path)) + "/CMakeLists.txt"
    files: list[str] = []
    for line_no, args in iter_calls(text, "target_sources"):
        if not args:
            raise ProjectError(f"{location}:{line_no}: target_sources 缺少目标名", code=1)
        if args[0] != PROJECT_TARGET:
            continue
        for arg in args[1:]:
            if arg in ("PRIVATE", "PUBLIC", "INTERFACE"):
                continue
            relative = _resolve_argument(location, line_no, "target_sources", arg)
            if relative not in files:
                files.append(relative)
    return files


def parse_board_cmake(path: str) -> list[tuple[str, Optional[str]]]:
    """返回板级源文件与组名提示（板目录相对、``/`` 分隔）。"""

    text = _read(path)
    location = os.path.basename(os.path.dirname(path)) + "/board.cmake"
    entries: list[tuple[str, Optional[str]]] = []
    for macro, hint in BOARD_SOURCE_CALLS.items():
        for line_no, args in iter_calls(text, macro):
            for arg in args:
                relative = _resolve_argument(location, line_no, macro, arg)
                if (relative, hint) not in entries:
                    entries.append((relative, hint))
    return entries


def group_for_path(relative: str, hint: Optional[str] = None) -> str:
    """按路径推导 Keil 组名，和仓库里既有工程保持一致。"""

    if hint:
        return hint
    if relative.startswith("STM32CubeMX/"):
        return "stm32cubemx"
    if relative.startswith("startup/"):
        return "startup"
    return "application"


def file_type_for(relative: str) -> str:
    """Keil FileType：1=C 源文件，2=汇编。"""

    return "2" if relative.lower().endswith(ASM_EXTENSIONS) else "1"


def _rule_sets(
    repo_root: str,
    base_dir: str,
    entries: list[tuple[str, Optional[str]]],
) -> list[dict]:
    base_path = os.path.relpath(base_dir, repo_root).replace(os.sep, "/")
    grouped: dict[tuple[str, str], list[str]] = {}

    for relative, hint in entries:
        if not relative.endswith(SOURCE_EXTENSIONS):
            continue
        absolute = os.path.join(base_dir, relative.replace("/", os.sep))
        if not os.path.isfile(absolute):
            raise ProjectError(f"{base_path}/{relative}: 声明的文件不存在", code=1)
        key = (group_for_path(relative, hint), file_type_for(relative))
        grouped.setdefault(key, []).append(relative)

    return [
        {
            "symbol": None,
            "group": group,
            "base_path": base_path,
            "files": files,
            "file_type": file_type,
        }
        for (group, file_type), files in grouped.items()
    ]


def discover_board(project_dir: str) -> Optional[str]:
    """工程只有一个板目录时直接用它。"""

    boards_dir = os.path.join(project_dir, "boards")
    if not os.path.isdir(boards_dir):
        return None
    boards = sorted(
        name for name in os.listdir(boards_dir)
        if os.path.isdir(os.path.join(boards_dir, name))
    )
    return boards[0] if len(boards) == 1 else None


def load_project_rules(project_dir: str, repo_root: str) -> list[dict]:
    """工程自身 ``CMakeLists.txt`` 的规则（与板无关）。"""

    project_dir = os.path.abspath(project_dir)
    cmake = os.path.join(project_dir, "CMakeLists.txt")
    if not os.path.isfile(cmake):
        return []
    entries = [(name, None) for name in parse_project_cmakelists(cmake)]
    return _rule_sets(repo_root, project_dir, entries)


def load_board_rules(project_dir: str, repo_root: str, board: str) -> list[dict]:
    """某块板的 ``boards/<board>/board.cmake`` 规则。"""

    board_dir = os.path.join(os.path.abspath(project_dir), "boards", board)
    board_cmake = os.path.join(board_dir, "board.cmake")
    if not os.path.isfile(board_cmake):
        return []
    return _rule_sets(repo_root, board_dir, parse_board_cmake(board_cmake))


def board_from_path(path: Optional[str]) -> Optional[str]:
    """从 ``.\\boards\\<board>\\...`` 这样的路径里取出板名。"""

    match = _BOARD_PATH_RE.search(path or "")
    return match.group(1) if match else None


def _board_names(project_dir: str) -> list[str]:
    boards_dir = os.path.join(project_dir, "boards")
    if not os.path.isdir(boards_dir):
        return []
    return sorted(
        (name for name in os.listdir(boards_dir)
         if os.path.isdir(os.path.join(boards_dir, name))),
        key=len,
        reverse=True,
    )


def detect_board_from_uvprojx(uvprojx_path: str) -> Optional[str]:
    """判断一份 ``*.uvprojx`` 属于哪块板。

    一个工程目录下常常有好几份工程文件（stm32f4xx / stm32h7xx / g32f463xx ...），
    板级源文件只能进它自己那份，否则 g32 工程里会混进 stm32f407 的 bsp.c。

    先在工程文件自己的 ``.\\boards\\<board>\\`` 路径上数票——板与板之间是同一颗芯片
    的不同变体时（``stm32f407ig`` / ``stm32f407ig_vendor``），器件名区分不出来，
    路径才是真凭据。票数并列或没有板级路径时，才用 ``<Device>`` 兜底：
    板目录按器件命名，``STM32F407IGTx`` 对应 ``boards/stm32f407ig``。
    """

    try:
        tree = ET.parse(uvprojx_path)
    except (OSError, ET.ParseError):
        return None

    project_dir = os.path.dirname(os.path.abspath(uvprojx_path))
    boards = _board_names(project_dir)

    counts: dict[str, int] = {}
    for node in tree.getroot().iter("FilePath"):
        name = board_from_path(node.text)
        if name in boards:
            counts[name] = counts.get(name, 0) + 1

    if counts:
        top = max(counts.values())
        winners = [name for name, count in counts.items() if count == top]
        if len(winners) == 1:
            return winners[0]

    device = next(
        (node.text for node in tree.getroot().iter("Device") if node.text),
        None,
    )
    if device:
        lower = device.strip().lower()
        for name in boards:  # 已按长度倒序，最长匹配优先
            if lower.startswith(name.lower()):
                return name

    if counts:
        return max(counts.items(), key=lambda item: item[1])[0]
    return None


def load_project_rule_sets(
    project_dir: str,
    repo_root: str,
    *,
    board: Optional[str] = None,
    log: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """工程自身源码 + 指定板源码的同步规则（``symbol=None``，只增不删）。

    同步多份 ``*.uvprojx`` 时不要用它一次算出全部规则，按工程文件各自的板分别调用
    :func:`load_board_rules`（见 :func:`uvproj_sync.sync_uvprojx_project`）。
    """

    project_dir = os.path.abspath(project_dir)
    rules = load_project_rules(project_dir, repo_root)

    board = board or discover_board(project_dir)
    if not board:
        if log is not None:
            log("No board selected, skip board.cmake source sync.")
        return rules

    if not os.path.isfile(os.path.join(project_dir, "boards", board, "board.cmake")):
        if log is not None:
            log(f"No {board}/board.cmake, skip board source sync.")
        return rules

    return rules + load_board_rules(project_dir, repo_root, board)
