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
# Flash algorithm generated from G32F463_256.FLM using generate_flash_algo.py.
# G32F463: 256KB Flash, 128KB SRAM.
#

from ....coresight.coresight_target import CoreSightTarget
from ....core.memory_map import (FlashRegion, RamRegion, MemoryMap)

CHIP_ERASE_WEIGHT = 15.0


# Generated from G32F463_256.FLM (Geehy G32F463 256KB Flash)
FLASH_ALGO = {
    'load_address': 0x20000000,
    # Flash algorithm as a hex string
    'instructions': [
    0xe7fdbe00,
    0x0e000380, 0x484c4770, 0x6041494a, 0x6041494b, 0x07096801, 0x60010f09, 0x22f668c1, 0x60c14311,
    0x06806940, 0x4847d406, 0x60014945, 0x60412106, 0x60814945, 0x47702000, 0x68c1483f, 0x431122f6,
    0x690160c1, 0x43110542, 0x20006101, 0xb5304770, 0x493c4a3e, 0xe0004838, 0x68c3600a, 0xd4fb03db,
    0x23106904, 0x6104431c, 0x031d6904, 0x6104432c, 0x600ae000, 0x03e468c4, 0x6901d4fb, 0x61014399,
    0xbd302000, 0x4a31b570, 0x492b4b2e, 0x601ae000, 0x03e468cc, 0x241fd4fb, 0x190006e4, 0x68cd0380,
    0x24f60e00, 0x60cd4325, 0x610d2502, 0x0140690e, 0x610e4306, 0x03ee6908, 0x61084330, 0x601ae000,
    0x03c068c8, 0x6908d4fb, 0x610843a8, 0x402068c8, 0x68c8d003, 0x60c84320, 0xbd702001, 0x4d16b5f0,
    0x08891cc9, 0x008968eb, 0x433b27f6, 0x230060eb, 0x4c16612b, 0x692be016, 0x43334e15, 0x6813612b,
    0x4b106003, 0x601ce000, 0x03f668ee, 0x68ebd4fb, 0xd004423b, 0x433868e8, 0x200160e8, 0x1d00bdf0,
    0x1d121f09, 0xd1e62900, 0x08406928, 0x61280040, 0xbdf02000, 0x45670123, 0x40023c00, 0xcdef89ab,
    0x00005555, 0x40003000, 0x00000fff, 0x0000aaaa, 0x00004001, 0x00000000
    ],
    # Relative function addresses
    'pc_init': 0x2000000b,
    'pc_unInit': 0x2000003d,
    'pc_program_page': 0x200000e1,
    'pc_erase_sector': 0x20000089,
    'pc_eraseAll': 0x20000053,
    'static_base': 0x20000000 + 0x00000004 + 0x00000154,
    'begin_stack': 0x20001960,
    'end_stack': 0x20000960,
    'page_size': 0x400,
    'analyzer_supported': False,
    'analyzer_address': 0x00000000,
    # Enable double buffering
    'page_buffers': [
        0x20000160,
        0x20000560
    ],
    'min_program_length': 0x400,
    # Relative region addresses and sizes
    'ro_start': 0x4,
    'ro_size': 0x154,
    'rw_start': 0x158,
    'rw_size': 0x4,
    'zi_start': 0x15c,
    'zi_size': 0x0,
    # Flash information
    'flash_start': 0x8000000,
    'flash_size': 0x40000,
    'sector_sizes': (
        (0x0, 0x400),
    )
}


class G32F463x8(CoreSightTarget):
    """G32F463: 256KB Flash, 128KB SRAM."""

    VENDOR = "Geehy"

    # G32F463 Flash layout (256KB), decode/erase granularity 1KB from FLM.
    MEMORY_MAP = MemoryMap(
        FlashRegion(start=0x08000000, length=0x40000, sector_size=0x400,
                    page_size=0x400, is_boot_memory=True,
                    erase_all_weight=CHIP_ERASE_WEIGHT, algo=FLASH_ALGO),
        # 128KB SRAM
        RamRegion(start=0x20000000, length=0x20000),
    )

    def __init__(self, session):
        super().__init__(session, self.MEMORY_MAP)