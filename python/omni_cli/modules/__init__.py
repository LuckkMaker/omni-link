"""模块注册表（module.yml 扫描、注册表生成与校验）。"""

from .model import (
    LOCATION_FRAMEWORK,
    LOCATION_MODULE,
    ModuleSpec,
    iter_modules,
    load_module,
    module_issues,
)
from .registry import (
    CMAKE_REGISTRY,
    KCONFIG_REGISTRY,
    generate,
    render_cmake,
    render_kconfig,
)

__all__ = [
    "CMAKE_REGISTRY",
    "KCONFIG_REGISTRY",
    "LOCATION_FRAMEWORK",
    "LOCATION_MODULE",
    "ModuleSpec",
    "generate",
    "iter_modules",
    "load_module",
    "module_issues",
    "render_cmake",
    "render_kconfig",
]
