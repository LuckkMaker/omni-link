"""omni build 的实现包（CMake 配置 + 构建）。

包名用 ``builder`` 而不是 ``build``：``python/omni_cli/build`` 会与 setuptools 的
构建中间目录同名，容易误删。
"""

from .runner import (
    ARTIFACTS,
    BUILD_TYPES,
    COMPILERS,
    DEFAULT_BUILD_TYPE,
    DEFAULT_COMPILER,
    BuildResult,
    build_directory,
    collect_artifacts,
    parse_size,
    run_build,
    toolchain_file,
)

__all__ = [
    "ARTIFACTS",
    "BUILD_TYPES",
    "COMPILERS",
    "DEFAULT_BUILD_TYPE",
    "DEFAULT_COMPILER",
    "BuildResult",
    "build_directory",
    "collect_artifacts",
    "parse_size",
    "run_build",
    "toolchain_file",
]
