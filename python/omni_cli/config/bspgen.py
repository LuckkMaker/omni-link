"""从链接 map / 源码生成 bsp_config.h（由 omni_bspgen.py 移植）。"""

from __future__ import annotations

import glob
import os
import re
from typing import Callable, Optional

DEVICE_SECTION = "omni_device"
MIN_NAME_MATCH = 5

BOARD_SOC_RE = re.compile(
    r"^\s*CONFIG_SOC_([A-Za-z0-9_]+)\s*=\s*[yY]\s*$",
    re.MULTILINE,
)
DEVICE_SYMBOL_RE = re.compile(
    r"(_dev_[A-Za-z0-9_]+)\s+0x[0-9A-Fa-f]+\s+\S+\s+\d+\s+\S*\(\s*"
    + DEVICE_SECTION
    + r"\s*\)\s*$"
)
SOURCE_DEFINE_RE = re.compile(
    r"\b([A-Za-z_][A-Za-z0-9_]*_DEVICE_DEFINE)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)"
)


def extract_board_soc(project_dir: str, target: Optional[str]) -> Optional[str]:
    if not target:
        return None
    board_conf = os.path.join(project_dir, "boards", target, "board.conf")
    try:
        with open(board_conf, "r", encoding="utf-8", errors="replace") as handle:
            match = BOARD_SOC_RE.search(handle.read())
    except OSError:
        return None
    return match.group(1).lower() if match else None


def _name_match(parts, name: str) -> int:
    if not name:
        return 0
    best = 0
    for part in parts:
        stem = os.path.splitext(part)[0]
        if stem == name:
            return 3
        if len(stem) >= MIN_NAME_MATCH and name.startswith(stem):
            best = max(best, 2)
        elif len(name) >= MIN_NAME_MATCH and stem.startswith(name):
            best = max(best, 2)
    return best


def _map_match_score(path: str, target: Optional[str], soc: Optional[str]) -> int:
    parts = os.path.normpath(path).replace("\\", "/").lower().split("/")
    return max(
        _name_match(parts, (target or "").lower()),
        _name_match(parts, (soc or "").lower()),
    )


def display_path(path: str, project_dir: str) -> str:
    try:
        return os.path.relpath(path, project_dir).replace("\\", "/")
    except ValueError:
        return path.replace("\\", "/")


def find_map(
    project_dir: str,
    target: Optional[str] = None,
    map_path: Optional[str] = None,
    log: Callable[[str], None] = print,
) -> Optional[str]:
    if map_path:
        if os.path.isfile(map_path):
            return map_path
        log(
            f"Warning: omni_bspgen: linker map '{map_path}' not found; "
            "auto-detecting the map instead."
        )

    candidates = []
    for pattern in (
        os.path.join(project_dir, "Listings", "**", "*.map"),
        os.path.join(project_dir, "Objects", "**", "*.map"),
        os.path.join(project_dir, "out", "**", "*.map"),
        os.path.join(project_dir, "build", "**", "*.map"),
    ):
        candidates.extend(glob.glob(pattern, recursive=True))

    candidates = list(dict.fromkeys(candidates))
    if not candidates:
        return None

    soc = extract_board_soc(project_dir, target)
    ranked = sorted(
        (
            (_map_match_score(path, target, soc), os.path.getmtime(path), path)
            for path in candidates
        ),
        reverse=True,
    )
    best_score = ranked[0][0]
    best = [entry for entry in ranked if entry[0] == best_score]
    chosen = best[0][2]

    if best_score == 0:
        soc_note = f" (SoC {soc})" if soc else ""
        log(
            f"Warning: omni_bspgen: none of the {len(candidates)} linker maps "
            f"of this project can be attributed to target '{target}'"
            f"{soc_note}; using the most recent map "
            f"({display_path(chosen, project_dir)}). Pass the map path "
            "explicitly if that map belongs to another board."
        )
    elif len(best) > 1:
        matches = ", ".join(display_path(entry[2], project_dir) for entry in best)
        log(
            f"Warning: omni_bspgen: {len(best)} linker maps match target "
            f"'{target}' ({matches}); using the most recent one "
            f"({display_path(chosen, project_dir)})."
        )
    return chosen


def extract_device_names(map_path: str) -> list[str]:
    names = set()
    with open(map_path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            match = DEVICE_SYMBOL_RE.search(line)
            if match:
                names.add(match.group(1)[len("_dev_"):])
    return sorted(names)


def extract_device_names_from_sources(project_dir: str, target: str) -> list[str]:
    names = set()
    patterns = [
        os.path.join(project_dir, "boards", target, "bsp.c"),
        os.path.join(project_dir, "boards", target, "bsp", "**", "*.c"),
        os.path.join(project_dir, "src", "**", "*.c"),
    ]
    source_files = []
    for pattern in patterns:
        source_files.extend(glob.glob(pattern, recursive=True))

    for path in sorted(set(source_files)):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                content = handle.read()
        except OSError:
            continue
        for match in SOURCE_DEFINE_RE.finditer(content):
            names.add(match.group(2))
    return sorted(names)


def generate_header(device_names, guard: str, note: Optional[str] = None) -> str:
    if note:
        comment = f"/* Device instances ({note}). */"
    else:
        comment = "/* Device instances from the linker `omni_device` section. */"

    lines = [
        "/**",
        " * @file    bsp_config.h",
        " * @author  LuckkMaker",
        " * @brief   Board Support Package (BSP) configuration - Auto-generated",
        " * @attention",
        " *",
        " * DO NOT MODIFY: this file is generated from the linker symbol table",
        " * by omni/scripts/omni_bspgen.py (invoked by omni_config.py). It",
        " * declares every device instance defined in the `omni_device` linker",
        " * section, so applications can bind to them via DEVICE_GET().",
        " */",
        "",
        "/* Define to prevent recursive inclusion -------------------------------------*/",
        "#ifndef " + guard,
        "#define " + guard,
        "",
        "#ifdef __cplusplus",
        'extern "C" {',
        "#endif",
        "",
        comment,
    ]

    if device_names:
        lines.extend(f"extern const struct device _dev_{name};" for name in device_names)
    else:
        lines.append("/* (no device instances found in linker) */")

    lines += [
        "",
        "#ifdef __cplusplus",
        "}",
        "#endif /* __cplusplus */",
        "",
        "#endif /* " + guard + " */",
        "",
    ]
    return "\n".join(lines)


def run_bspgen(
    project_dir: str,
    target: str,
    map_path: Optional[str] = None,
    config_dir: Optional[str] = None,
    *,
    log: Callable[[str], None] = print,
) -> str:
    project_dir = os.path.abspath(project_dir)
    map_file = find_map(project_dir, target, map_path, log=log)
    device_names: list[str] = []
    note = None

    if map_file:
        map_names = extract_device_names(map_file)
        if map_names:
            device_names = list(map_names)
            note = "from linker map " + display_path(map_file, project_dir)
        else:
            log(
                "Warning: omni_bspgen: no `_dev_*` symbols in linker map; "
                "falling back to source scan."
            )

    source_names = extract_device_names_from_sources(project_dir, target)
    added = sorted(set(source_names) - set(device_names))
    if added:
        device_names = sorted(set(device_names) | set(source_names))
        if map_file and map_names:
            note = "from linker map " + display_path(map_file, project_dir) + " + sources"
        else:
            note = "sources (bootstrap)"

    if not device_names:
        log(
            "Warning: omni_bspgen: no device definitions found in "
            "sources; writing an empty header."
        )

    if config_dir is None:
        config_dir = os.path.join(project_dir, "boards", target, "config")
    os.makedirs(config_dir, exist_ok=True)

    guard = target.upper() + "_BSP_CONFIG_H"
    out_file = os.path.join(config_dir, "bsp_config.h")
    new_header = generate_header(device_names, guard, note)

    header_changed = True
    if os.path.exists(out_file):
        with open(out_file, "r", encoding="utf-8") as prev:
            header_changed = prev.read() != new_header

    with open(out_file, "w", encoding="utf-8") as handle:
        handle.write(new_header)

    if header_changed:
        if not note:
            log(
                "Warning: omni_bspgen: no linker map or source devices found; "
                f"{out_file} written empty."
            )
        log(f"omni_bspgen: {out_file} CHANGED (device set updated).")
        log(
            "  NOTE: bsp_config.h is read at compile time; a rebuild is "
            "required for the new device declarations to take effect."
        )
        for name in device_names:
            log(f"  extern const struct device _dev_{name};")
    else:
        log(f"omni_bspgen: {out_file} already up to date.")
    return out_file
