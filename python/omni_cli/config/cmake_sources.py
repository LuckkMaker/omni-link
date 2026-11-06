"""从 CMakeLists.txt 解析「Kconfig 符号 → 源文件」规则。

Keil 工程同步不再维护一张手写规则表：omni 的每个目录在自己的 ``CMakeLists.txt``
里声明源文件，本模块把这些声明解析成 :mod:`uvproj_sync` 需要的结构。

只认一种写法（就是 omni 自己的 DSL）::

    omni_sources_ifdef(<target> <CONFIG_SYMBOL> <file>...)

约定：

* 注释和跨行都在解析前处理掉，一条声明可以跨多行；
* 参数里出现 ``${...}`` 变量直接报错，不做猜测；
* 声明了但磁盘上不存在的文件也报错——规则错了要在同步时立刻发现；
* 无法用这个宏表达的目录（arch 的 ``list(APPEND)``、第三方 ``modules/``）
  仍放在 :data:`uvproj_rules.EXTRA_RULE_SETS` 里。
"""

from __future__ import annotations

import copy
import os
import re
from typing import Callable, Iterable, Optional

from ..context import ProjectError
from .uvproj_rules import EXTRA_RULE_SETS, LEGACY_RULE_SETS

SOURCE_EXTENSIONS = (".c", ".cc", ".cpp", ".s", ".S", ".asm")

#: 解析时跳过的目录（构建产物与第三方检出的工具链）
SKIP_DIRS = {"build", "RTE", "__pycache__", ".git", "node_modules", ".venv"}

_MACRO = "omni_sources_ifdef"
_COMMENT_RE = re.compile(r"#[^\n]*")


def _strip_comments(text: str) -> str:
    """把注释替换成等长空白，保持字符偏移与行号不变。"""

    return _COMMENT_RE.sub(lambda match: " " * len(match.group(0)), text)


def iter_macro_calls(text: str) -> Iterable[tuple[int, list[str]]]:
    """遍历文本里所有 ``omni_sources_ifdef(...)`` 调用，产出 (行号, 参数列表)。"""

    position = 0
    while True:
        start = text.find(_MACRO, position)
        if start < 0:
            return

        opening = text.find("(", start + len(_MACRO))
        if opening < 0:
            raise ProjectError(f"{_MACRO} 缺少括号", code=1)

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
            raise ProjectError(f"{_MACRO} 括号不匹配", code=1)

        line_no = text.count("\n", 0, start) + 1
        yield line_no, text[opening + 1 : cursor].split()
        position = cursor + 1


def group_for_path(rel_dir: str) -> str:
    """由目录推导 Keil 工程里的 GroupName。"""

    parts = rel_dir.split("/")

    if parts[0] == "modules" and len(parts) > 1:
        return f"module/{parts[1]}"

    if parts[0] == "omni":
        if len(parts) > 1:
            if parts[1] == "subsys":
                return "omni/subsys"
            if parts[1] == "drivers":
                return "omni/driver"
            if parts[1] == "arch" and len(parts) > 2:
                return f"omni/arch/{parts[2]}"
            if parts[1] == "src":
                return "omni/core"
        return "omni/core"

    return "/".join(parts[:2])


def _iter_cmakelists(repo_root: str) -> Iterable[str]:
    for current_dir, sub_dirs, files in os.walk(os.path.join(repo_root, "omni")):
        sub_dirs[:] = [name for name in sub_dirs if name not in SKIP_DIRS]
        if "CMakeLists.txt" in files:
            yield os.path.join(current_dir, "CMakeLists.txt")


def parse_cmakelists(path: str, repo_root: str) -> list[dict]:
    """解析一个 CMakeLists.txt，返回规则列表（同一文件可能声明多个符号）。"""

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = _strip_comments(handle.read())
    except OSError as exc:
        raise ProjectError(f"无法读取 {path}: {exc}", code=1) from exc

    rel_dir = os.path.dirname(os.path.relpath(path, repo_root)).replace(os.sep, "/")
    group = group_for_path(rel_dir)
    rules: list[dict] = []

    for line_no, args in iter_macro_calls(text):
        location = f"{os.path.relpath(path, repo_root)}:{line_no}"

        if len(args) < 3:
            raise ProjectError(
                f"{location}: {_MACRO} 至少要有 <target> <symbol> <file> 三个参数",
                code=1,
            )

        if any("${" in arg for arg in args):
            raise ProjectError(
                f"{location}: {_MACRO} 不支持变量参数，请把源文件直接写出来",
                code=1,
            )

        symbol = args[1]
        declared: list[str] = []
        for name in args[2:]:
            if not name.lower().endswith(SOURCE_EXTENSIONS):
                raise ProjectError(
                    f"{location}: 不支持的文件类型 {name}",
                    code=1,
                )
            if not os.path.isfile(os.path.join(repo_root, rel_dir, name)):
                raise ProjectError(
                    f"{location}: 声明的文件不存在 {rel_dir}/{name}",
                    code=1,
                )
            declared.append(name)

        rules.append(
            {
                "symbol": symbol,
                "group": group,
                "base_path": rel_dir,
                "files": declared,
            }
        )

    return _merge_rules(rules)


def _merge_rules(rules: list[dict]) -> list[dict]:
    """合并同目录同符号的声明，保持出现顺序。"""

    merged: dict[tuple[str, str], dict] = {}
    for rule in rules:
        key = (rule["symbol"], rule["base_path"])
        existing = merged.get(key)
        if existing is None:
            merged[key] = {**rule, "files": list(rule["files"])}
            continue
        for name in rule["files"]:
            if name not in existing["files"]:
                existing["files"].append(name)
    return list(merged.values())


def load_rule_sets(
    repo_root: str,
    *,
    mode: str = "auto",
    log: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """返回 Keil 同步要用的规则集合。

    ``mode``：

    * ``auto``（默认）——解析 ``omni/**/CMakeLists.txt``，再补上
      :data:`uvproj_rules.EXTRA_RULE_SETS` 里无法解析的目录；
    * ``table``——退回手写规则表，解析器出问题时可以临时用。
    """

    if mode == "table":
        return copy.deepcopy(LEGACY_RULE_SETS)
    if mode != "auto":
        raise ProjectError(f"未知的规则来源: {mode}", code=2)

    rules: list[dict] = []
    for path in sorted(_iter_cmakelists(repo_root)):
        rules.extend(parse_cmakelists(path, repo_root))

    if log is not None:
        log(f"Parsed {len(rules)} CMakeLists rule(s) from {repo_root}")
        if not rules:
            # 空规则集会让同步静默地「什么都不做」，这里明确提示
            log(
                "Warning: 没有解析到 omni_sources_ifdef() 声明，Keil 同步不会增删任何源文件；"
                "旧布局可用 --rules table 退回手写规则表"
            )

    rules = _merge_rules(rules)
    rules.extend(copy.deepcopy(EXTRA_RULE_SETS))

    return rules
