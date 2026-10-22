"""按 Kconfig 符号同步 Keil .uvprojx（由 uvproj_sync.py 移植）。

默认和旧脚本一致：扫描工程目录下所有 ``*.uvprojx`` 并全部同步。
``uvprojx_paths`` 仅作为可选过滤。
"""

from __future__ import annotations

import glob
import os
import xml.etree.ElementTree as ET
from typing import Callable, Iterable, Optional

from ..context import ProjectError
from .uvproj_rules import SOURCE_RULE_SETS


def _rel_path(repo_root: str, relative: str, start_dir: str) -> str:
    absolute = os.path.join(repo_root, relative.replace("/", os.sep))
    return os.path.relpath(absolute, start_dir).replace("/", "\\")


def build_source_rules(rule_sets, repo_root: str, uvprojx_dir: str) -> list[dict]:
    rules = []
    for rule_set in rule_sets:
        file_type = str(rule_set.get("file_type", "1"))
        for file_name in rule_set["files"]:
            rules.append(
                {
                    "symbol": rule_set["symbol"],
                    "group": rule_set["group"],
                    "file_name": file_name,
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
    symbols: dict[str, str] = {}
    if not os.path.exists(dot_config_path):
        return symbols
    with open(dot_config_path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            symbols[key.strip()] = value.strip().strip('"')
    return symbols


def find_group_node(root, group_name: str):
    for group in root.findall(".//Group"):
        node = group.find("GroupName")
        if node is not None and node.text == group_name:
            files = group.find("Files")
            if files is None:
                files = ET.SubElement(group, "Files")
            return files
    return None


def ensure_group_node(root, group_name: str):
    files = find_group_node(root, group_name)
    if files is not None:
        return files, False
    groups = root.find(".//Groups")
    if groups is None:
        return None, False
    group = ET.SubElement(groups, "Group")
    ET.SubElement(group, "GroupName").text = group_name
    files = ET.SubElement(group, "Files")
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
    file_node = ET.SubElement(files_node, "File")
    ET.SubElement(file_node, "FileName").text = file_name
    ET.SubElement(file_node, "FileType").text = str(file_type)
    ET.SubElement(file_node, "FilePath").text = file_path
    return True


def remove_file_node(files_node, file_name: str, file_path: str) -> bool:
    changed = False
    for file_node in list(files_node.findall("File")):
        if file_matches(file_node, file_name, file_path):
            files_node.remove(file_node)
            changed = True
    return changed


def split_include_paths(include_text: Optional[str]) -> list[str]:
    if not include_text:
        return []
    return [path.strip() for path in include_text.split(";") if path.strip()]


def join_include_paths(include_paths: list[str]) -> str:
    return ";".join(include_paths)


def sync_include_paths(root, symbols: dict[str, str], include_rules: list[dict]) -> bool:
    include_nodes = root.findall(".//Cads/VariousControls/IncludePath")
    if not include_nodes:
        return False

    managed_paths: list[str] = []
    managed_path_set: set[str] = set()
    for rule in include_rules:
        path = rule["include_path"]
        if path in managed_path_set:
            continue
        managed_path_set.add(path)
        if symbols.get(rule["symbol"], "n") == "y":
            managed_paths.append(path)

    changed = False
    for include_node in include_nodes:
        current_paths = split_include_paths(include_node.text)
        unmanaged_paths = [path for path in current_paths if path not in managed_path_set]
        next_paths = unmanaged_paths + [
            path for path in managed_paths if path not in unmanaged_paths
        ]
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

    managed_defines: list[str] = []
    managed_define_set: set[str] = set()
    for rule in define_rules:
        define = rule["define"]
        if define in managed_define_set:
            continue
        managed_define_set.add(define)
        if symbols.get(rule["symbol"], "n") == "y":
            managed_defines.append(define)

    changed = False
    for define_node in define_nodes:
        current_defines = split_defines(define_node.text)
        unmanaged_defines = [
            define for define in current_defines if define not in managed_define_set
        ]
        next_defines = unmanaged_defines + [
            define for define in managed_defines if define not in unmanaged_defines
        ]
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
    log: Callable[[str], None] = print,
) -> bool:
    uvprojx_dir = os.path.dirname(os.path.abspath(uvprojx_path))
    source_rules = build_source_rules(SOURCE_RULE_SETS, repo_root, uvprojx_dir)
    include_rules = build_include_rules(SOURCE_RULE_SETS, repo_root, uvprojx_dir)
    define_rules = build_define_rules(SOURCE_RULE_SETS)

    try:
        tree = ET.parse(uvprojx_path)
    except (OSError, ET.ParseError) as exc:
        raise ProjectError(f"无法解析 Keil 工程 {uvprojx_path}: {exc}", code=1) from exc

    root = tree.getroot()
    changed = False

    for rule in source_rules:
        enabled = symbols.get(rule["symbol"], "n") == "y"
        if enabled:
            files_node, group_created = ensure_group_node(root, rule["group"])
            if files_node is None:
                log(f"Warning: <Groups> not found in {uvprojx_path}")
                continue
            changed |= group_created
            changed |= ensure_file_node(
                files_node,
                rule["file_name"],
                rule["file_type"],
                rule["file_path"],
            )
        else:
            files_node = find_group_node(root, rule["group"])
            if files_node is None:
                continue
            changed |= remove_file_node(files_node, rule["file_name"], rule["file_path"])

    changed |= sync_include_paths(root, symbols, include_rules)
    changed |= sync_defines(root, symbols, define_rules)

    if changed:
        try:
            tree.write(uvprojx_path, encoding="utf-8", xml_declaration=True)
        except OSError as exc:
            raise ProjectError(f"无法写入 Keil 工程 {uvprojx_path}: {exc}", code=1) from exc
        log(f"Synced source rules to: {uvprojx_path}")
    return changed


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
    log: Callable[[str], None] = print,
) -> tuple[bool, list[str]]:
    """同步工程目录下的 Keil 工程；默认全部，``uvprojx_paths`` 可选过滤。"""

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

    changed = False
    for uvprojx in files:
        changed |= sync_sources_for_uvprojx(uvprojx, symbols, repo_root, log=log)

    if not changed:
        log("UVPROJX sync finished: no changes.")
    return changed, files
