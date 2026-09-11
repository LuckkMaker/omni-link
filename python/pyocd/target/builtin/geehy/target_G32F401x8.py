# pyOCD debugger
# Copyright (c) 2026 Geehy
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

#
# Flash algorithm generated from G32F401_64_MFlash.FLM using generate_flash_algo.py.
# G32F401: 64KB Flash, 16KB SRAM.
#

from ....coresight.coresight_target import CoreSightTarget
from ....core.memory_map import (FlashRegion, RamRegion, MemoryMap)
from ....debug.svd.loader import SVDFile

CHIP_ERASE_WEIGHT = 20.0


# Generated from G32F401_64_MFlash.FLM (Geehy G32F401 64KB Flash)
FLASH_ALGO = {
    'load_address': 0x20000000,
    # Flash algorithm as a hex string
    'instructions': [
    0xe7fdbe00,
    0xf64ae003, 0x497720aa, 0x48776008, 0xf00068c0, 0x28000001, 0x4874d1f5, 0xf00068c0, 0xb1200010,
    0x49712030, 0x200160c8, 0x486f4770, 0xf00068c0, 0xb1100020, 0x496c2020, 0x200060c8, 0xb510e7f4,
    0xbf004603, 0x68c04868, 0x0001f000, 0xd1f92800, 0x4c654866, 0x48666060, 0x46206060, 0xf0006900,
    0xb1080080, 0xbd102001, 0x4c5f2000, 0x46206020, 0xf04068c0, 0x60e00030, 0x61202000, 0x4c5e485d,
    0x46206620, 0xf0406a80, 0x62a00001, 0x38554859, 0x60204c5a, 0x60201c80, 0x6a804857, 0x0001f020,
    0x62a04c55, 0x66202000, 0x69c0484f, 0x0002f000, 0x2001b108, 0x484ce7d7, 0xf00069c0, 0xb9400004,
    0x5055f245, 0x60204c47, 0x60602006, 0x70fff640, 0x200060a0, 0x4601e7c7, 0x69004843, 0x0080f040,
    0x61104a41, 0x47702000, 0xf7ffb510, 0xb108ff89, 0xbd102001, 0x493c2030, 0x460860c8, 0xf0406900,
    0x61080004, 0x69004608, 0x0040f040, 0xf7ff6108, 0xb138ff77, 0x69004834, 0x0004f020, 0x61084932,
    0xe7e62001, 0x69004830, 0x0004f020, 0x6108492e, 0xe7de2000, 0x4604b510, 0xff62f7ff, 0x2001b108,
    0x2030bd10, 0x60c84928, 0x69004608, 0x0002f040, 0x46086108, 0x69006144, 0x0040f040, 0xf7ff6108,
    0xb138ff4f, 0x69004820, 0x0002f020, 0x6108491e, 0xe7e52001, 0x6900481c, 0x0002f020, 0x6108491a,
    0xe7dd2000, 0x4604b570, 0x4616460d, 0x0503f025, 0xff36f7ff, 0x2001b108, 0x2030bd70, 0x60c84912,
    0x69004608, 0x0001f040, 0xe0116108, 0x6144480e, 0x60206830, 0xff24f7ff, 0x480bb138, 0xf0206900,
    0x49090001, 0x20016108, 0x1d24e7e6, 0x1f2d1d36, 0xd1eb2d00, 0x69004804, 0x0001f020, 0x61084902,
    0xe7d92000, 0x40003000, 0x40022000, 0x45670123, 0xcdef89ab, 0x55aaaa55, 0x40021000, 0x40012400,
    0x00000000
    ],
    # Relative function addresses
    'pc_init': 0x20000043,
    'pc_unInit': 0x200000db,
    'pc_program_page': 0x20000189,
    'pc_erase_sector': 0x20000139,
    'pc_eraseAll': 0x200000ed,
    'static_base': 0x20000000 + 0x00000004 + 0x00000200,
    'begin_stack': 0x20001a10,
    'end_stack': 0x20000a10,
    'page_size': 0x400,
    'analyzer_supported': False,
    'analyzer_address': 0x00000000,
    # Enable double buffering
    'page_buffers': [
        0x20000210,
        0x20000610
    ],
    'min_program_length': 0x400,
    # Relative region addresses and sizes
    'ro_start': 0x4,
    'ro_size': 0x200,
    'rw_start': 0x204,
    'rw_size': 0x4,
    'zi_start': 0x208,
    'zi_size': 0x0,
    # Flash information
    'flash_start': 0x8000000,
    'flash_size': 0x10000,
    'sector_sizes': (
        (0x0, 0x200),
    )
}


class G32F401x8(CoreSightTarget):
    """G32F401: 64KB Flash, 16KB SRAM."""

    VENDOR = "Geehy"

    # G32F401 Flash layout (64KB), decode/erase granularity 512B from FLM.
    MEMORY_MAP = MemoryMap(
        FlashRegion(start=0x08000000, length=0x10000, sector_size=0x200,
                    page_size=0x400, is_boot_memory=True,
                    erase_all_weight=CHIP_ERASE_WEIGHT, algo=FLASH_ALGO),
        # 16KB SRAM
        RamRegion(start=0x20000000, length=0x4000),
    )

    def __init__(self, session):
        super().__init__(session, self.MEMORY_MAP)
        self._svd_location = SVDFile.from_builtin("G32F401.svd")
