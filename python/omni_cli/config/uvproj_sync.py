"""按 Kconfig 符号同步 Keil .uvprojx（由 uvproj_sync.py 移植）。

默认和旧脚本一致：扫描工程目录下所有 ``*.uvprojx`` 并全部同步。
``uvprojx_paths`` 仅作为可选过滤。
"""

from __future__ import annotations

import glob
import os
import re
import xml.etree.ElementTree as ET
from typing import Callable, Iterable, Optional

from ..context import ProjectError
from .cmake_sources import load_rule_sets
from .project_sources import load_project_rule_sets

#: kconfiglib 对没打开的符号写的那行：``# CONFIG_X is not set``
_NOT_SET_RE = re.compile(r"^#\s*([A-Za-z0-9_]+) is not set$")


def _rel_path(repo_root: str, relative: str, start_dir: str) -> str:
    """仓库相对路径 → 相对 ``.uvprojx`` 的路径，按 Keil 自己的写法。

    Keil 对工程目录内的文件写 ``.\\src\\app.c``，对工程外的写
    ``..\\..\\..\\omni\\app.c``；这里保持一致，免得同步新增的条目和原件只差一个
    ``.\\`` 前缀。
    """

    absolute = os.path.join(repo_root, relative.replace("/", os.sep))
    path = os.path.relpath(absolute, start_dir).replace("/", "\\")
    if not path.startswith(".."):
        path = ".\\" + path
    return path


def build_source_rules(rule_sets, repo_root: str, uvprojx_dir: str) -> list[dict]:
    rules = []
    for rule_set in rule_sets:
        file_type = str(rule_set.get("file_type", "1"))
        for file_name in rule_set["files"]:
            rules.append(
                {
                    "symbol": rule_set["symbol"],
                    "group": rule_set["group"],
                    # Keil 里 FileName 只用于显示，FilePath 才是真实路径；用 basename
                    # 与手写规则表保持一致，避免解析器上线时改写整份工程。
                    "file_name": os.path.basename(file_name),
                    "file_type": file_type,
                    "file_path": _rel_path(
                        repo_root,
                        f"{rule_set['base_path']}/{file_name}",
                        uvprojx_dir,
                    ),
                }
            )
    return rules


def build_include_rules(rule_sets, repo_root: str, uvprojx_dir: str) -> list[dict]:
    rules = []
    for rule_set in rule_sets:
        for include_path in rule_set.get("include_paths", []):
            rules.append(
                {
                    "symbol": rule_set["symbol"],
                    "include_path": _rel_path(repo_root, include_path, uvprojx_dir),
                }
            )
    return rules


def build_define_rules(rule_sets) -> list[dict]:
    rules = []
    for rule_set in rule_sets:
        for define in rule_set.get("defines", []):
            rules.append({"symbol": rule_set["symbol"], "define": define})
    return rules


def load_symbols(dot_config_path: str) -> dict[str, str]:
    """读 ``.config``。

    除了 ``CONFIG_X=y``，还把 ``# CONFIG_X is not set`` 记成 ``"n"``——同步只在
    「明确关掉」时才删文件。``.config`` 里根本没有的符号说明这份配置是旧的
    （或符号已经改名），这时保持原状，不拿「没写」当「关掉」。
    """

    symbols: dict[str, str] = {}
    if not os.path.exists(dot_config_path):
        return symbols
    with open(dot_config_path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            match = _NOT_SET_RE.match(line)
            if match:
                symbols[match.group(1)] = "n"
                continue
            if line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            symbols[key.strip()] = value.strip().strip('"')
    return symbols


def find_group_node(root, group_name: str, *, create: bool = True):
    """按组名找 ``<Files>``；``create=False`` 时不新建（只读查找）。"""

    for group in root.findall(".//Group"):
        node = group.find("GroupName")
        if node is not None and node.text == group_name:
            files = group.find("Files")
            if files is None and create:
                files, _indent = _append_block(group, "Files")
            return files
    return None


INDENT_STEP = "  "


def _sub_indent(container) -> str:
    """容器里子元素前的空白（``<Files>`` 中 ``<File>`` 的缩进）。"""

    text = container.text
    if text and "\n" in text and not text.strip():
        return text
    # 空容器：结束标签缩进再进一级
    return (container.tail or "") + INDENT_STEP


def _close_indent(container) -> str:
    """容器结束标签前的空白（``</Files>`` 的缩进）。

    容器自己的内容缩进退一级就是它的结束标签缩进；这样对刚创建、子元素还没
    补齐 tail 的容器也成立（只看最后一个子元素的 tail 会少退一级）。
    """

    text = container.text
    if text and "\n" in text and not text.strip() and text.endswith(INDENT_STEP):
        return text[: -len(INDENT_STEP)]
    children = list(container)
    if children:
        tail = children[-1].tail
        if tail and "\n" in tail and not tail.strip():
            return tail
    return container.tail or ""


def _append_block(container, tag: str):
    """在容器末尾追加一个块元素，并补齐 Keil 风格的换行/缩进。

    ElementTree 新建的元素没有 ``text``/``tail`` 空白，序列化时会与前一个
    兄弟挤在同一行；uvprojx 是逐行缩进的 XML，这里按容器既有格式补上，
    使同步后的 diff 只包含真正新增/删除的源文件。

    返回 (新元素, 元素内容缩进)。
    """

    child_indent = _sub_indent(container)
    close_indent = _close_indent(container)
    children = list(container)
    if children:
        children[-1].tail = child_indent
    node = ET.SubElement(container, tag)
    node.text = child_indent + INDENT_STEP
    node.tail = close_indent
    return node, child_indent


def _append_leaf(parent, tag: str, value: str, indent: str) -> None:
    """追加一个文本叶子元素，``indent`` 是它结束标签前的空白。"""

    node = ET.SubElement(parent, tag)
    node.text = value
    node.tail = indent


def ensure_group_node(root, group_name: str):
    files = find_group_node(root, group_name)
    if files is not None:
        return files, False
    groups = root.find(".//Groups")
    if groups is None:
        return None, False
    group, group_indent = _append_block(groups, "Group")
    _append_leaf(group, "GroupName", group_name, group_indent)
    files, _files_indent = _append_block(group, "Files")
    return files, True


def file_matches(file_node, file_name: str, file_path: str) -> bool:
    node_name = file_node.find("FileName")
    node_path = file_node.find("FilePath")
    if node_name is None or node_path is None:
        return False
    return node_name.text == file_name and node_path.text == file_path


def ensure_file_node(files_node, file_name: str, file_type: str, file_path: str) -> bool:
    for file_node in files_node.findall("File"):
        if file_matches(file_node, file_name, file_path):
            return False
    file_node, file_indent = _append_block(files_node, "File")
    inner_indent = file_node.text or file_indent
    _append_leaf(file_node, "FileName", file_name, inner_indent)
    _append_leaf(file_node, "FileType", str(file_type), inner_indent)
    _append_leaf(file_node, "FilePath", file_path, file_indent)
    return True


def remove_file_node(files_node, file_name: str, file_path: str) -> bool:
    changed = False
    for file_node in list(files_node.findall("File")):
        if file_matches(file_node, file_name, file_path):
            files_node.remove(file_node)
            changed = True
    return changed


def _normalize_path(path: str) -> str:
    """去掉 ``.\\`` 前缀、统一反斜杠，只用于比较。"""

    path = path.replace("/", "\\")
    while path.startswith(".\\"):
        path = path[2:]
    return path


def project_file_paths(root) -> set[str]:
    """工程里已经引用过的 FilePath 集合（已归一化）。

    组名是按目录/模块推导出来的，历史工程常把同一个文件放在别的组里（例如
    ``modules/u8g2`` 与 ``module/u8g2``）。同一个 FilePath 只允许出现一次，
    否则会被编译两遍、链接时符号重复，所以加文件前先按路径查重。
    """

    return {_normalize_path(node.text) for node in root.iter("FilePath") if node.text}


def split_include_paths(include_text: Optional[str]) -> list[str]:
    if not include_text:
        return []
    return [path.strip() for path in include_text.split(";") if path.strip()]


def join_include_paths(include_paths: list[str]) -> str:
    return ";".join(include_paths)


def _managed_state(entries: list[tuple[str, Optional[str]]], symbols: dict[str, str]) -> dict[str, Optional[str]]:
    """受管条目 → 它在 .config 里的状态（``"y"``/``"n"``/``None``=没写）。"""

    state: dict[str, Optional[str]] = {}
    for value, symbol in entries:
        state.setdefault(value, symbols.get(symbol) if symbol is not None else "y")
    return state


def _apply_managed(current: list[str], state: dict[str, Optional[str]]) -> list[str]:
    """保留原有顺序：只删「明确关掉」的，只补「明确打开」的。"""

    kept = [value for value in current if state.get(value) != "n"]
    appended = [
        value
        for value, symbol_state in state.items()
        if symbol_state == "y" and value not in kept
    ]
    return kept + appended


def sync_include_paths(root, symbols: dict[str, str], include_rules: list[dict]) -> bool:
    include_nodes = root.findall(".//Cads/VariousControls/IncludePath")
    if not include_nodes:
        return False

    state = _managed_state(
        [(rule["include_path"], rule["symbol"]) for rule in include_rules],
        symbols,
    )

    changed = False
    for include_node in include_nodes:
        next_paths = _apply_managed(split_include_paths(include_node.text), state)
        next_text = join_include_paths(next_paths)
        if (include_node.text or "") != next_text:
            include_node.text = next_text
            changed = True
    return changed


def split_defines(define_text: Optional[str]) -> list[str]:
    if not define_text:
        return []
    return [item.strip() for item in define_text.split(",") if item.strip()]


def sync_defines(root, symbols: dict[str, str], define_rules: list[dict]) -> bool:
    define_nodes = root.findall(".//Cads/VariousControls/Define")
    if not define_nodes:
        return False

    state = _managed_state(
        [(rule["define"], rule["symbol"]) for rule in define_rules],
        symbols,
    )

    changed = False
    for define_node in define_nodes:
        next_defines = _apply_managed(split_defines(define_node.text), state)
        next_text = ",".join(next_defines)
        if (define_node.text or "") != next_text:
            define_node.text = next_text
            changed = True
    return changed


def sync_sources_for_uvprojx(
    uvprojx_path: str,
    symbols: dict[str, str],
    repo_root: str,
    *,
    rule_sets: Optional[Iterable[dict]] = None,
    log: Callable[[str], None] = print,
) -> bool:
    uvprojx_dir = os.path.dirname(os.path.abspath(uvprojx_path))
    if rule_sets is None:
        rule_sets = load_rule_sets(repo_root)
    source_rules = build_source_rules(rule_sets, repo_root, uvprojx_dir)
    include_rules = build_include_rules(rule_sets, repo_root, uvprojx_dir)
    define_rules = build_define_rules(rule_sets)

    try:
        tree = ET.parse(uvprojx_path)
    except (OSError, ET.ParseError) as exc:
        raise ProjectError(f"无法解析 Keil 工程 {uvprojx_path}: {exc}", code=1) from exc

    root = tree.getroot()
    changed = False
    known_paths = project_file_paths(root)
    kept_unknown: set[str] = set()

    for rule in source_rules:
        symbol = rule["symbol"]
        if symbol is None:
            # 工程/板级源码：不跟 Kconfig 走，永远算启用
            state = "y"
        else:
            state = symbols.get(symbol)

        if state == "y":
            # 该文件已经在其它组里了：不再重复加，也不为了它新建组。
            if _normalize_path(rule["file_path"]) in known_paths:
                continue
            files_node, _created = ensure_group_node(root, rule["group"])
            if files_node is None:
                log(f"Warning: <Groups> not found in {uvprojx_path}")
                continue
            if ensure_file_node(
                files_node,
                rule["file_name"],
                rule["file_type"],
                rule["file_path"],
            ):
                known_paths.add(_normalize_path(rule["file_path"]))
                changed = True
        elif state == "n":
            # 只读查找：组不存在就跳过，不要为了删除顺手补一个空 <Files>
            files_node = find_group_node(root, rule["group"], create=False)
            if files_node is None:
                continue
            changed |= remove_file_node(files_node, rule["file_name"], rule["file_path"])
        else:
            # .config 里没有这个符号：不猜，保持原状；工程里真有这个文件时提示一次
            if _normalize_path(rule["file_path"]) in known_paths:
                kept_unknown.add(symbol)

    if kept_unknown:
        preview = ", ".join(sorted(kept_unknown)[:6])
        more = "" if len(kept_unknown) <= 6 else f" ... ({len(kept_unknown)} total)"
        log(
            f"Warning: {os.path.basename(uvprojx_path)} still compiles {preview}{more} "
            "but their symbols are missing from .config; left unchanged. "
            "The configuration may be stale; run omni config generate."
        )

    changed |= sync_include_paths(root, symbols, include_rules)
    changed |= sync_defines(root, symbols, define_rules)

    if changed:
        try:
            write_uvprojx(uvprojx_path, tree)
        except OSError as exc:
            raise ProjectError(f"无法写入 Keil 工程 {uvprojx_path}: {exc}", code=1) from exc
        log(f"Synced source rules to: {uvprojx_path}")
    return changed


#: Keil 工程的固定 XML 头。ElementTree 默认会写成 ``<?xml version='1.0' ...?>``，
#: 空元素写成 ``<Cmp />``，与 Keil 自己写出的文件不同——每次同步都会把整份工程
#: 重排一遍。这里保持 Keil 的写法，让 diff 只包含真正的源文件变化。
UVPROJX_XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n'


def write_uvprojx(path: str, tree) -> None:
    """按 Keil 的格式写回 .uvprojx：固定 XML 头、LF 换行、保留空元素写法。

    ElementTree 会把空元素统一写成 ``<Cmp />``（或统一写成成对标签），而 Keil
    自己写出的文件两种写法都有。这里读出原文件里“自闭合”的标签集合，序列化后
    把它们改回自闭合，避免一次同步顺手重排整份工程。
    """

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            original = handle.read()
    except OSError:
        original = ""

    body = ET.tostring(tree.getroot(), encoding="unicode", short_empty_elements=False)
    for tag in set(re.findall(r"<([A-Za-z_][\w.-]*)(?:\s[^>]*)?/>", original)):
        body = re.sub(
            rf"<{tag}(\s[^>]*)?></{tag}>",
            lambda match, name=tag: f"<{name}{match.group(1) or ''}/>",
            body,
        )

    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(UVPROJX_XML_DECLARATION)
        handle.write(body)
        handle.write("\n")


def _resolve_uvprojx_files(
    project_dir: str,
    uvprojx_paths: Optional[Iterable[str]],
) -> list[str]:
    if uvprojx_paths:
        resolved = []
        for path in uvprojx_paths:
            absolute = os.path.abspath(path)
            if not os.path.isfile(absolute):
                raise ProjectError(f"Keil 工程不存在: {absolute}", code=1)
            resolved.append(absolute)
        return resolved
    return sorted(glob.glob(os.path.join(project_dir, "*.uvprojx")))


def sync_uvprojx_project(
    project_dir: str,
    dot_config_path: str,
    *,
    uvprojx_paths: Optional[Iterable[str]] = None,
    repo_root: Optional[str] = None,
    rule_sets: Optional[Iterable[dict]] = None,
    rules_mode: str = "auto",
    board: Optional[str] = None,
    log: Callable[[str], None] = print,
) -> tuple[bool, list[str]]:
    """同步工程目录下的 Keil 工程；默认全部，``uvprojx_paths`` 可选过滤。

    ``rule_sets`` 由调用方直接给出时优先使用；否则按 ``rules_mode`` 从
    ``omni/**/CMakeLists.txt`` + 模块 layer 解析（``auto``）或退回手写规则表
    （``table``）。工程自己的 ``CMakeLists.txt`` / ``boards/<board>/board.cmake``
    始终参与同步（只增不删），``board`` 不给时按 ``boards/`` 目录推断。
    """

    files = _resolve_uvprojx_files(project_dir, uvprojx_paths)
    if not files:
        log(f"No uvprojx found in {project_dir}, skip sync.")
        return False, []

    symbols = load_symbols(dot_config_path)

    if repo_root is None:
        # 兼容旧布局的兜底：工程位于仓库下三层（如 examples/basic/template）。
        candidate = os.path.abspath(project_dir)
        for _ in range(3):
            candidate = os.path.dirname(candidate)
        repo_root = candidate
    repo_root = os.path.abspath(repo_root)

    if rule_sets is None:
        rule_sets = load_rule_sets(repo_root, mode=rules_mode, log=log)

    rules = list(rule_sets)
    rules.extend(load_project_rule_sets(project_dir, repo_root, board=board, log=log))

    changed = False
    for uvprojx in files:
        changed |= sync_sources_for_uvprojx(
            uvprojx, symbols, repo_root, rule_sets=rules, log=log
        )

    if not changed:
        log("UVPROJX sync finished: no changes.")
    return changed, files
