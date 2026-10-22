"""板定义：读取 ``omni/boards/<board>/board.yml`` 并定位上游文件。

板目录只保存「板事实」：器件、CPU/FPU、HAL 系列、启动文件与链接脚本名。
工程自己的 ``boards/<board>/`` 仍然是独立的受管副本（tracked、可修改），
本模块不做任何文件搬移。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

import yaml

from ..context import ProjectError

#: HAL 模块在仓库里的根（相对仓库根）。
HAL_ROOTS = {
    "stm32": ("modules", "hal_stm32", "stm32cube"),
    "geehy": ("modules", "hal_geehy", "g32"),
}

#: 板级文件的角色。
ROLE_STARTUP = "startup"
ROLE_SCATTER = "scatter"
ROLE_SYSTEM = "system"


@dataclass(frozen=True)
class UpstreamFile:
    """一个板级文件在 HAL 模块里的原始版本。"""

    role: str
    name: str
    path: str


@dataclass(frozen=True)
class BoardSpec:
    omni_root: str
    name: str
    full_name: str
    vendor: str
    revision: str
    soc: str
    variants: tuple[str, ...]
    device: str
    hal: str
    series: str
    device_define: str
    cpu: str
    fpu: str
    layout: str
    startup: str
    scatter: str

    @property
    def directory(self) -> str:
        return os.path.join(self.omni_root, "boards", self.name)

    @property
    def repo_root(self) -> str:
        return os.path.dirname(self.omni_root)

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "full_name": self.full_name,
            "vendor": self.vendor,
            "revision": self.revision,
            "soc": self.soc,
            "variants": list(self.variants),
            "device": self.device,
            "hal": self.hal,
            "series": self.series,
            "device_define": self.device_define,
            "cpu": self.cpu,
            "fpu": self.fpu,
            "layout": self.layout,
            "startup": self.startup,
            "scatter": self.scatter,
        }


def _field(mapping: dict, key: str, where: str) -> str:
    value = mapping.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ProjectError(f"{where} 缺少字段 '{key}'", code=1)
    return str(value).strip()


def load_board(omni_root: str, name: str) -> BoardSpec:
    """读取并校验单个 ``board.yml``。"""

    path = os.path.join(omni_root, "boards", name, "board.yml")
    if not os.path.isfile(path):
        raise ProjectError(
            f"板 '{name}' 没有 board.yml: {path}\n"
            f"  可用板: {', '.join(spec.name for spec in iter_boards(omni_root)) or '<无>'}",
            code=2,
        )

    try:
        with open(path, encoding="utf-8") as handle:
            raw = yaml.safe_load(handle) or {}
    except yaml.YAMLError as exc:
        raise ProjectError(f"{path} 不是合法 YAML: {exc}", code=1) from exc

    board = raw.get("board") or {}
    omni = board.get("omni") or {}
    where = f"{path}"

    socs = board.get("socs") or []
    soc = ""
    variants: tuple[str, ...] = ()
    if socs:
        first = socs[0] or {}
        soc = str(first.get("name") or "").strip()
        variants = tuple(
            str(item.get("name"))
            for item in (first.get("variants") or [])
            if isinstance(item, dict) and item.get("name")
        )

    hal = _field(omni, "hal", where)
    if hal not in HAL_ROOTS:
        raise ProjectError(
            f"{where}: 未知 hal '{hal}'（支持: {', '.join(sorted(HAL_ROOTS))}）", code=1
        )

    # 目录名必须与 name 一致，否则 OMNI_BOARD / $TargetType$ 会对不上。
    declared = _field(board, "name", where)
    if declared != name:
        raise ProjectError(
            f"{where}: name '{declared}' 与目录名 '{name}' 不一致", code=1
        )
    if not soc:
        raise ProjectError(f"{where}: socs[0].name 为空", code=1)

    return BoardSpec(
        omni_root=omni_root,
        name=declared,
        full_name=str(board.get("full_name") or declared),
        vendor=str(board.get("vendor") or "omni"),
        revision=str(board.get("revision") or "1.0"),
        soc=soc,
        variants=variants,
        device=_field(omni, "device", where),
        hal=hal,
        series=_field(omni, "series", where),
        device_define=_field(omni, "device_define", where),
        cpu=_field(omni, "cpu", where),
        fpu=str(omni.get("fpu") or "none"),
        layout=str(omni.get("layout") or "cubemx"),
        startup=_field(omni, "startup", where),
        scatter=_field(omni, "scatter", where),
    )


def iter_boards(omni_root: str) -> Iterator[BoardSpec]:
    """按目录名顺序遍历所有带 board.yml 的板。"""

    boards_dir = os.path.join(omni_root, "boards")
    if not os.path.isdir(boards_dir):
        return
    for name in sorted(os.listdir(boards_dir)):
        if os.path.isfile(os.path.join(boards_dir, name, "board.yml")):
            yield load_board(omni_root, name)


def has_board(omni_root: str, name: str) -> bool:
    return os.path.isfile(os.path.join(omni_root, "boards", name, "board.yml"))


def device_src_dir(spec: BoardSpec) -> str:
    base = Path(spec.repo_root).joinpath(*HAL_ROOTS[spec.hal], spec.series, "device", "src")
    if not base.is_dir():
        raise ProjectError(
            f"板 '{spec.name}' 的 HAL 目录不存在: {base}\n"
            f"  检查 modules/ 子模块是否已初始化。",
            code=1,
        )
    return str(base)


def _find_named(base: Path, name: str) -> Optional[str]:
    """在 device/src 的常见子目录里查找同名文件。"""

    for sub in ("arm", "gcc", ""):
        candidate = base / sub / name if sub else base / name
        if candidate.is_file():
            return str(candidate)
    return None


def upstream_files(spec: BoardSpec) -> list[UpstreamFile]:
    """板级文件的原始版本：启动汇编、链接脚本、system 源文件。"""

    base = Path(device_src_dir(spec))
    files: list[UpstreamFile] = []

    startup = _find_named(base, spec.startup)
    if startup:
        files.append(UpstreamFile(ROLE_STARTUP, spec.startup, startup))

    scatter = _find_named(base, spec.scatter)
    if scatter:
        files.append(UpstreamFile(ROLE_SCATTER, spec.scatter, scatter))

    systems = sorted(base.glob("system_*.c"))
    if len(systems) == 1:
        files.append(UpstreamFile(ROLE_SYSTEM, systems[0].name, str(systems[0])))
    return files


def missing_upstream(spec: BoardSpec) -> list[str]:
    """board.yml 声明了、但上游找不到的文件名（供 list/show 提示）。"""

    found = {item.name for item in upstream_files(spec)}
    return [name for name in (spec.startup, spec.scatter) if name not in found]


def hal_config_template(spec: BoardSpec) -> Optional[tuple[str, str]]:
    """HAL 的配置头模板，返回 (模板路径, 目标文件名)。

    STM32 是 ``stm32<series>_hal_conf_template.h`` → ``stm32<series>_hal_conf.h``；
    Geehy 是 ``g32f463_dal_cfg_template.h`` → ``g32f463_dal_cfg.h``。
    新工程没有 CubeMX 生成物时，用它让脚手架可以直接编译。
    """

    series_dir = Path(spec.repo_root).joinpath(
        *HAL_ROOTS[spec.hal], spec.series
    )
    include_dir = series_dir / "drivers" / "include"
    if not include_dir.is_dir():
        return None

    patterns = ("*_hal_conf_template.h", "*_cfg_template.h")
    for pattern in patterns:
        for path in sorted(include_dir.glob(pattern)):
            return str(path), path.name.replace("_template", "")
    return None

