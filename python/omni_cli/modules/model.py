"""模块注册表：扫描 ``module.yml``，定位 glue 目录与源码目录。

glue（构建/Kconfig 胶水）有两个合法位置：

- ``modules/<dir>/omni/module.yml``：仓库是自己的（如 hal_stm32 / hal_geehy）；
- ``omni/modules/<name>/module.yml``：仓库是上游镜像（lua / lwip / u8g2 ...），
  用 ``module: ../../modules/<dir>`` 指回源码，等价于 Zephyr 的 ``cmake-ext``。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

import yaml

from ..context import ProjectError

GLUE_DIRNAME = "omni"
MODULES_DIRNAME = "modules"

LOCATION_MODULE = "module"
LOCATION_FRAMEWORK = "framework"


@dataclass(frozen=True)
class ModuleSpec:
    name: str
    location: str
    module_dir: str
    glue_dir: str
    cmake: Optional[str]
    kconfig: Optional[str]
    enable: Optional[str]
    layer: Optional[str]
    module_yml: str

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "location": self.location,
            "module_dir": self.module_dir,
            "glue_dir": self.glue_dir,
            "cmake": self.cmake,
            "kconfig": self.kconfig,
            "enable": self.enable,
            "layer": self.layer,
            "module_yml": self.module_yml,
        }


def _rel(repo_root: str, path: str) -> str:
    return os.path.relpath(path, repo_root).replace("\\", "/")


def _read_yaml(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    except yaml.YAMLError as exc:
        raise ProjectError(f"{path} 不是合法 YAML: {exc}", code=1) from exc
    if not isinstance(data, dict):
        raise ProjectError(f"{path} 顶层必须是映射", code=1)
    return data


def _resolve(base: str, value: str) -> str:
    return value if os.path.isabs(value) else os.path.normpath(os.path.join(base, value))


def _spec_from_glue(repo_root: str, glue_dir: str, location: str) -> ModuleSpec:
    """从 glue 目录里的 module.yml 构造 ModuleSpec。"""

    module_yml = os.path.join(glue_dir, "module.yml")
    data = _read_yaml(module_yml)
    name = str(data.get("name") or "").strip()
    if not name:
        raise ProjectError(f"{module_yml} 缺少 name", code=1)

    if location == LOCATION_MODULE:
        module_dir = os.path.dirname(glue_dir)
    else:
        # 框架侧 glue：module 字段相对 glue 目录（Zephyr 的 cmake-ext 语义）。
        module_rel = str(data.get("module") or name).strip()
        module_dir = _resolve(glue_dir, module_rel)

    build = data.get("build") or {}
    cmake_value = build.get("cmake")
    cmake: Optional[str] = None
    if cmake_value:
        cmake = os.path.normpath(_resolve(glue_dir, str(cmake_value)))

    kconfig_value = build.get("kconfig")
    kconfig: Optional[str] = None
    if kconfig_value:
        kconfig = os.path.normpath(_resolve(glue_dir, str(kconfig_value)))

    settings = data.get("settings") or {}
    layer_value = settings.get("layer")
    layer: Optional[str] = None
    if layer_value:
        layer = os.path.normpath(_resolve(module_dir, str(layer_value)))

    enable = data.get("enable")
    return ModuleSpec(
        name=name,
        location=location,
        module_dir=_rel(repo_root, module_dir),
        glue_dir=_rel(repo_root, glue_dir),
        cmake=_rel(repo_root, cmake) if cmake else None,
        kconfig=_rel(repo_root, kconfig) if kconfig else None,
        enable=str(enable).strip() if enable else None,
        layer=_rel(repo_root, layer) if layer else None,
        module_yml=_rel(repo_root, module_yml),
    )


def iter_modules(repo_root: str) -> list[ModuleSpec]:
    """扫描两个 glue 位置，按名字排序返回。"""

    found: dict[str, ModuleSpec] = {}

    modules_dir = os.path.join(repo_root, MODULES_DIRNAME)
    if os.path.isdir(modules_dir):
        for entry in sorted(os.listdir(modules_dir)):
            glue = os.path.join(modules_dir, entry, GLUE_DIRNAME)
            if os.path.isfile(os.path.join(glue, "module.yml")):
                spec = _spec_from_glue(repo_root, glue, LOCATION_MODULE)
                if spec.name in found:
                    raise ProjectError(
                        f"模块名重复: {spec.name}（{spec.module_yml} 与 "
                        f"{found[spec.name].module_yml}）",
                        code=1,
                    )
                found[spec.name] = spec

    framework_dir = os.path.join(repo_root, GLUE_DIRNAME, MODULES_DIRNAME)
    if os.path.isdir(framework_dir):
        for entry in sorted(os.listdir(framework_dir)):
            glue = os.path.join(framework_dir, entry)
            if os.path.isfile(os.path.join(glue, "module.yml")):
                spec = _spec_from_glue(repo_root, glue, LOCATION_FRAMEWORK)
                if spec.name in found:
                    raise ProjectError(
                        f"模块名重复: {spec.name}（{spec.module_yml} 与 "
                        f"{found[spec.name].module_yml}）",
                        code=1,
                    )
                found[spec.name] = spec

    return [found[name] for name in sorted(found)]


def load_module(repo_root: str, name: str) -> ModuleSpec:
    for spec in iter_modules(repo_root):
        if spec.name == name:
            return spec
    available = ", ".join(spec.name for spec in iter_modules(repo_root)) or "<无>"
    raise ProjectError(f"未找到模块 '{name}'。\n  可用模块: {available}", code=2)


def module_issues(repo_root: str, spec: ModuleSpec) -> list[str]:
    """检查单个模块的声明是否自洽（返回问题列表，空表示通过）。"""

    issues: list[str] = []
    for label, rel in (("源码目录", spec.module_dir), ("glue 目录", spec.glue_dir)):
        if not os.path.isdir(os.path.join(repo_root, rel)):
            issues.append(f"{label}不存在: {rel}")
    if spec.cmake is None:
        issues.append("未声明 build.cmake（暂未接入 CMake）")
    elif not os.path.exists(os.path.join(repo_root, spec.cmake)):
        issues.append(f"build.cmake 指向的路径不存在: {spec.cmake}")
    if spec.kconfig is not None and not os.path.isfile(os.path.join(repo_root, spec.kconfig)):
        issues.append(f"build.kconfig 指向的文件不存在: {spec.kconfig}")
    if spec.enable is None:
        issues.append("未声明 enable 符号（无法按配置启用）")
    if spec.layer is not None and not os.path.isfile(os.path.join(repo_root, spec.layer)):
        issues.append(f"settings.layer 指向的文件不存在: {spec.layer}")
    return issues
