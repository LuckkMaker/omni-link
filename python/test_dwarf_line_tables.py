"""DWARF 行表文件/目录索引的回归测试（DWARF 4 与 DWARF 5）。

覆盖两处修复：

1. ``pyocd/debug/elf/decoder.py``：行程序头的文件/目录索引基准。DWARF 5 起是 0 基
   （DWARF <= 4 是 1 基），之前一律按 ``- 1`` 取，导致 DWARF 5 镜像（gcc >= 11 /
   clang 默认）里每个地址的源文件都取到前一项，按 ``main.c:65`` 下断点直接匹配不到。
2. ``core/elf_backend.py``：``_line_full_path()`` 只认前导 ``/`` 为绝对路径，Windows
   的 ``D:/...`` 会被当成相对路径再拼一次 comp_dir，得到 ``…/Debug/D:/…`` 这种坏路径。

用法::

    cd python
    python test_dwarf_line_tables.py

真实镜像上的验证（clang 19 / gcc 13 的 DWARF5、armclang 6.23 的 DWARF4）用同一套
逻辑跑过：main / app_main / SysTick_Handler 都能解析回各自源文件，``main.c:65``
能反查到 main 的地址。
"""

from __future__ import annotations

import os
import sys

PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PY_DIR)

from core.elf_backend import ElfBackend
from pyocd.debug.elf.decoder import _line_source_of, _line_table_index_base

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(name)
        print(f"FAIL {name} {detail}")


class _Header:
    def __init__(self, version: int) -> None:
        self.version = version


class _FileEntry:
    def __init__(self, name, dir_index: int) -> None:
        self.name = name
        self.dir_index = dir_index


class _LineProgram(dict):
    """够用的假行程序：只需要 ['file_entry'] / ['include_directory'] 和 header.version。"""

    def __init__(self, version: int, files, directories) -> None:
        super().__init__(
            file_entry=[_FileEntry(name, dir_index) for name, dir_index in files],
            include_directory=list(directories),
        )
        self.header = _Header(version)


# clang 19（DWARF 5）实际镜像里的表：main.c 在索引 6，目录索引 5 指向 Core/Src。
# 索引 0 是 comp_dir，这是 DWARF 5 与 DWARF 4 的关键差异。
_DWARF5_PROG = _LineProgram(
    5,
    files=[
        ("D:/proj/boards/Core/Src\\main.c", 0),
        ("stm32f4xx_hal_def.h", 1),
        ("stm32f4xx_hal_gpio.h", 1),
        ("_default_types.h", 2),
        ("_stdint.h", 3),
        ("stm32f407xx.h", 4),
        ("main.c", 5),
        ("cmsis_clang.h", 6),
    ],
    directories=[
        "D:/proj/build",
        "D:/hal/drivers/include",
        "D:/toolchain/include/machine",
        "D:/toolchain/include/sys",
        "D:/hal/device/include",
        "D:/proj/boards/Core/Src",
        "D:/cmsis/include",
    ],
)

# armclang 6.23（DWARF 4）：main.c 在索引 4，目录索引 4 指向 Core/Src（1 基）。
_DWARF4_PROG = _LineProgram(
    4,
    files=[
        ("stm32f4xx_hal_def.h", 1),
        ("stm32f4xx_hal_gpio.h", 1),
        ("stdint.h", 2),
        ("stm32f407xx.h", 3),
        ("main.c", 4),
        ("cmsis_armclang.h", 5),
    ],
    directories=[
        "D:/hal/drivers/include",
        "D:/toolchain/include",
        "D:/hal/device/include",
        "D:/proj/boards/Core/Src",
        "D:/cmsis/include",
    ],
)


def test_index_base() -> None:
    check("base.dwarf5", _line_table_index_base(_DWARF5_PROG) == 0)
    check("base.dwarf4", _line_table_index_base(_DWARF4_PROG) == 1)
    check("base.dwarf3", _line_table_index_base(_LineProgram(3, [], [])) == 1)

    class _NoHeader(dict):
        pass

    # 没有 header 的假行程序按 DWARF 4 处理，保持旧行为。
    check("base.no-header", _line_table_index_base(_NoHeader()) == 1)


def test_dwarf5_lookup() -> None:
    # state.file == 6 是 0 基索引，直接指向 main.c。
    name, dirname = _line_source_of(_DWARF5_PROG, 6, 0)
    check("dwarf5.file", name == "main.c", name)
    check("dwarf5.dir", dirname.replace("\\", "/") == "D:/proj/boards/Core/Src", dirname)

    # 旧行为（按 1 基减一）取到的是前一个条目：正是 stm32f407xx.h 的回归指纹。
    old_name, _ = _line_source_of(_DWARF5_PROG, 6, 1)
    check("dwarf5.regression-index", old_name == "stm32f407xx.h", old_name)

    # 索引 0 在 DWARF 5 里合法：第一条是带绝对路径的主源文件。
    name0, dir0 = _line_source_of(_DWARF5_PROG, 0, 0)
    check("dwarf5.first-entry", name0.replace("\\", "/").endswith("main.c"), name0)
    check("dwarf5.first-entry-dir", dir0 == "D:/proj/build", dir0)

    # 越界索引必须安全返回空，交给 comp_dir 兜底。
    check("dwarf5.out-of-range", _line_source_of(_DWARF5_PROG, 99, 0) == ("", ""))


def test_dwarf4_lookup() -> None:
    # state.file == 5（1 基）指向索引 4 的 main.c；目录索引 4 指向 dirs[3]。
    name, dirname = _line_source_of(_DWARF4_PROG, 5, 1)
    check("dwarf4.file", name == "main.c", name)
    check("dwarf4.dir", dirname == "D:/proj/boards/Core/Src", dirname)

    # dir_index == 0 表示「没有目录」，不能因为 -1 而取到最后一项。
    prog = _LineProgram(4, files=[("orphan.c", 0)], directories=["D:/a", "D:/b"])
    name, dirname = _line_source_of(prog, 1, 1)
    check("dwarf4.no-dir", name == "orphan.c" and dirname == "", (name, dirname))

    check("dwarf4.out-of-range", _line_source_of(_DWARF4_PROG, 0, 1) == ("", ""))


def test_full_path() -> None:
    from collections import namedtuple

    Info = namedtuple("Info", "filename dirname comp_dir")

    # 绝对 dirname + 相对文件名：拼出真实绝对路径。
    got = ElfBackend._line_full_path(Info("main.c", "D:/proj/boards/Core/Src", "D:/proj/build"))
    check("path.abs-dirname", got == "D:/proj/boards/Core/Src/main.c", got)

    # 文件名本身是 Windows 绝对路径：不能再拼 comp_dir（修复前会拼成 …/build/D:/…）。
    got = ElfBackend._line_full_path(Info("D:/proj/boards/Core/Src/main.c", "", "D:/proj/build"))
    check("path.abs-filename", got == "D:/proj/boards/Core/Src/main.c", got)

    # 全相对：按 comp_dir 兜底。
    got = ElfBackend._line_full_path(Info("app.c", "src", "build"))
    check("path.relative", got == "build/src/app.c", got)

    # POSIX 绝对路径同样不能重复拼。
    got = ElfBackend._line_full_path(Info("/opt/src/app.c", "", "/opt/build"))
    check("path.posix-abs", got == "/opt/src/app.c", got)

    # 反斜杠统一成正斜杠，末尾斜杠去掉。
    got = ElfBackend._line_full_path(Info("main.c", "D:\\proj\\Core\\Src\\", "D:\\proj\\build"))
    check("path.normalize", got == "D:/proj/Core/Src/main.c", got)


def main() -> int:
    test_index_base()
    test_dwarf5_lookup()
    test_dwarf4_lookup()
    test_full_path()

    if failures:
        print(f"{len(failures)} DWARF line-table test(s) failed: {', '.join(failures)}")
        return 1
    print("all DWARF line-table tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
