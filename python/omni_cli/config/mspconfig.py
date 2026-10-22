"""MSP 引脚配置头文件生成（由 omni_mspconfig.py / omni_config.py 移植）。"""

from __future__ import annotations

import glob
import os
import shutil
from typing import Callable, Optional


def process_msp_config(template_file: str, output_file: str, *, log=print) -> bool:
    """把 SOC 模板复制为 driver_msp_config.h。"""

    if not os.path.exists(template_file):
        log(f"Error: Template file not found: {template_file}")
        return False

    log(f"Reading template: {template_file}")
    output_dir = os.path.dirname(output_file)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    try:
        shutil.copy2(template_file, output_file)
    except OSError as exc:
        log(f"Error copying file: {exc}")
        return False
    log(f"Generated {output_file}")
    return True


def _read_config(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    if not os.path.exists(path):
        return values
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"')
    return values


def find_template(omni_root: str, family: str, series: str) -> Optional[str]:
    for pattern in (
        os.path.join(omni_root, "soc", "*", family, series, "driver_msp_config.h"),
        os.path.join(omni_root, "soc", family, series, "driver_msp_config.h"),
    ):
        found = glob.glob(pattern)
        if found:
            return found[0]
    return None


def run_msp_config(
    omni_root: str,
    project_dir: str,
    target: str,
    dot_config: str,
    *,
    log: Callable[[str], None] = print,
) -> Optional[str]:
    """按 .config 中的 SOC 信息查找模板并生成 MSP 头文件。"""

    log("----------------------------------------------------------------")
    log("Running OMNI MSP Config Generator")

    config_vars = _read_config(dot_config)
    soc_family = config_vars.get("CONFIG_SOC_FAMILY")
    soc_series = config_vars.get("CONFIG_SOC_SERIES")
    if not soc_family or not soc_series:
        log(
            "Warning: Could not determine SOC_FAMILY or SOC_SERIES from .config. "
            "Skipping MSP config."
        )
        return None

    template_file = find_template(omni_root, soc_family, soc_series)
    if not template_file:
        log(f"Warning: MSP Template not found for {soc_family}/{soc_series}")
        log(
            "Searched: "
            + os.path.join(omni_root, "soc", "*", soc_family, soc_series, "driver_msp_config.h")
        )
        return None

    output_dir = os.path.join(project_dir, "boards", target, "config")
    os.makedirs(output_dir, exist_ok=True)
    output_file = os.path.join(output_dir, "driver_msp_config.h")
    if not process_msp_config(template_file, output_file, log=log):
        return None
    return output_file
