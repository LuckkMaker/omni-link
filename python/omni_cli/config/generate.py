"""工程配置生成编排（由 omni-emb 的 omni_config.py 移植）。

CLI 自己拥有这套逻辑，不再 subprocess 调用 omni/scripts/omni_config.py。
"""

from __future__ import annotations

import contextlib
import glob
import os
import tempfile
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional, TextIO

from ..context import ProjectError


@dataclass
class ConfigResult:
    project_dir: str
    omni_root: str
    target: str
    generated: list[str] = field(default_factory=list)
    uvprojx_changed: bool = False
    uvprojx_files: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    log_lines: list[str] = field(default_factory=list)


def resolve_project_configs(project_dir: str, target: str) -> list[str]:
    """按 omni_config.py 的优先级收集输入配置片段。"""

    configs: list[str] = []

    default_config = os.path.join(project_dir, "prj.conf")
    if os.path.exists(default_config):
        configs.append(default_config)

    target_candidates = [
        os.path.join(project_dir, "boards", target, "board.conf"),
        os.path.join(project_dir, "boards", target, "prj.conf"),
        os.path.join(project_dir, "boards", target, "config", "board.conf"),
        os.path.join(project_dir, "boards", target, "config", "prj.conf"),
        os.path.join(project_dir, f"{target}.conf"),
        os.path.join(project_dir, f"prj.{target}.conf"),
    ]
    for config_file in target_candidates:
        if os.path.exists(config_file):
            configs.append(config_file)
            break

    return configs


def resolve_project_kconfig(project_dir: str) -> Optional[str]:
    project_kconfig = os.path.join(project_dir, "Kconfig")
    return project_kconfig if os.path.exists(project_kconfig) else None


def create_combined_kconfig(omni_root: str, project_dir: str) -> tuple[str, Optional[str]]:
    """把应用 Kconfig 挂到 omni 主 Kconfig 树；返回 (kconfig_file, project_kconfig)。"""

    project_kconfig = resolve_project_kconfig(project_dir)
    default_kconfig = os.path.join(omni_root, "Kconfig")
    if not project_kconfig:
        return default_kconfig, None

    project_kconfig_rel = os.path.relpath(
        os.path.abspath(project_kconfig),
        os.path.abspath(omni_root),
    ).replace("\\", "/")

    temp_file = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        suffix=".Kconfig",
        prefix="omni-app-",
        dir=omni_root,
        delete=False,
    )
    with temp_file as handle:
        handle.write('mainmenu "OMNI Configuration"\n\n')
        handle.write('source "Kconfig.omni"\n')
        handle.write(f'source "{project_kconfig_rel}"\n')
    return temp_file.name, project_kconfig


def _clean_old_config(dot_config: str) -> None:
    for path in (dot_config, dot_config + ".old"):
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError as exc:
            raise ProjectError(f"无法清理旧配置文件 {path}: {exc}") from exc


def _collect_env_restore() -> dict[str, Optional[str]]:
    return {
        "srctree": os.environ.get("srctree"),
        "OMNI_BASE": os.environ.get("OMNI_BASE"),
    }


def _restore_env(saved: dict[str, Optional[str]]) -> None:
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@contextlib.contextmanager
def _chdir(path: str):
    old = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)


def generate_project_config(
    *,
    project_dir: str,
    omni_root: str,
    target: str,
    msp: bool = False,
    no_bsp: bool = False,
    sync_keil: bool = False,
    uvprojx_paths: Optional[Iterable[str]] = None,
    clean_config: bool = True,
    log: Optional[Callable[[str], None]] = None,
    err: TextIO = None,
) -> ConfigResult:
    """生成工程配置。

    ``clean_config=False`` 用于 menuconfig 之后：保留用户刚保存的 ``.config``，
    只重新生成头文件。
    """

    import sys

    from .kconfig_merge import KconfigMergeError, merge_config

    log = log or (lambda message: print(message))
    err = err or sys.stderr
    result = ConfigResult(project_dir=project_dir, omni_root=omni_root, target=target)

    def emit(message: str) -> None:
        result.log_lines.append(message)
        log(message)

    configs = resolve_project_configs(project_dir, target)
    if not configs:
        raise ProjectError(
            "没有找到工程配置。需要 prj.conf，或 boards/"
            f"{target}/board.conf、boards/{target}/prj.conf、"
            f"{target}.conf、prj.{target}.conf 之一。",
            code=1,
        )

    config_dir = os.path.join(project_dir, "boards", target, "config")
    os.makedirs(config_dir, exist_ok=True)
    dot_config = os.path.join(project_dir, ".config")
    header_out = os.path.join(config_dir, "omni_config.h")
    log_file = os.path.join(project_dir, "kconfig_log.txt")

    if clean_config:
        _clean_old_config(dot_config)

    if not os.path.exists(dot_config):
        with open(dot_config, "w", encoding="utf-8") as handle:
            handle.write("# Initial config\n")

    kconfig_file, project_kconfig = create_combined_kconfig(omni_root, project_dir)
    default_kconfig = os.path.join(omni_root, "Kconfig")

    emit("----------------------------------------------------------------")
    emit("Running OMNI Kconfig Generator for Keil")
    emit(f"Project Dir: {project_dir}")
    emit(f"OMNI Root:   {omni_root}")
    emit(f"Target:      {target}")
    emit(f"Config Dir:  {config_dir}")
    emit(f"Project Kconfig: {project_kconfig or '<none>'}")
    emit("Input Conf:  " + ", ".join(configs))
    emit(f"Output Hdr:  {header_out}")
    emit("----------------------------------------------------------------")

    saved_env = _collect_env_restore()
    os.environ["srctree"] = omni_root
    try:
        with _chdir(omni_root):
            merge_config(
                kconfig_file=kconfig_file,
                config_out=dot_config,
                header_out=header_out,
                kconfig_list_out=log_file,
                configs_in=[dot_config, *configs] if clean_config else [dot_config],
                handwritten_input_configs=clean_config,
                omni_base=omni_root,
                srctree=omni_root,
                log=emit,
                err=err,
            )
    except KconfigMergeError as exc:
        raise ProjectError(str(exc), code=1) from exc
    finally:
        _restore_env(saved_env)
        if kconfig_file != default_kconfig and os.path.exists(kconfig_file):
            try:
                os.remove(kconfig_file)
            except OSError:
                pass

    result.generated.extend([dot_config, header_out, log_file])

    if not no_bsp:
        try:
            from . import bspgen

            bsp_file = bspgen.run_bspgen(project_dir, target, log=emit)
            if bsp_file:
                result.generated.append(bsp_file)
        except Exception as exc:  # 保持 omni_config.py 的“警告但不中断”行为
            emit(f"Warning: omni_bspgen failed: {exc}")

    if msp:
        from . import mspconfig

        msp_file = mspconfig.run_msp_config(omni_root, project_dir, target, dot_config, log=emit)
        if msp_file:
            result.generated.append(msp_file)

    if sync_keil:
        from . import uvproj_sync

        changed, files = uvproj_sync.sync_uvprojx_project(
            project_dir,
            dot_config,
            uvprojx_paths=uvprojx_paths,
            repo_root=os.path.dirname(omni_root),
            log=emit,
        )
        result.uvprojx_changed = changed
        result.uvprojx_files = files

    return result


def generate_after_menuconfig(
    *,
    project_dir: str,
    omni_root: str,
    target: str,
    no_bsp: bool = False,
    log: Optional[Callable[[str], None]] = None,
    err: TextIO = None,
) -> ConfigResult:
    """menuconfig 保存后重新生成头文件，保留用户刚编辑的 .config。"""

    return generate_project_config(
        project_dir=project_dir,
        omni_root=omni_root,
        target=target,
        no_bsp=no_bsp,
        clean_config=False,
        log=log,
        err=err,
    )


def find_soc_template(omni_root: str, soc_family: str, soc_series: str) -> Optional[str]:
    """按 soc/{vendor}/{family}/{series}/driver_msp_config.h 查找模板。"""

    patterns = [
        os.path.join(omni_root, "soc", "*", soc_family, soc_series, "driver_msp_config.h"),
        os.path.join(omni_root, "soc", soc_family, soc_series, "driver_msp_config.h"),
    ]
    for pattern in patterns:
        found = glob.glob(pattern)
        if found:
            return found[0]
    return None
