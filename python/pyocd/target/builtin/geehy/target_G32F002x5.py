# pyOCD debugger
# Copyright (c) 2026 luckk
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

from ....coresight.coresight_target import CoreSightTarget
from ....core.memory_map import (FlashRegion, RamRegion, MemoryMap)
from ....debug.svd.loader import SVDFile

FLASH_ALGO = {
    'load_address' : 0x20000000,

    # Flash algorithm as a hex string
    'instructions': [
    0xe7fdbe00,
    0x49404841, 0x4a426001, 0x60114940, 0x4a414942, 0x4a42600a, 0x494262ca, 0x69c16041, 0x43112220,
    0x200061c1, 0x48384770, 0x60412100, 0x60016801, 0x47702000, 0x493bb530, 0x48334a3b, 0x6011e000,
    0x07db69c3, 0x6904d1fb, 0x431c2302, 0x4c316104, 0x602c2500, 0x6011e000, 0x06e469c4, 0x6901d4fb,
    0x61014399, 0xbd302000, 0x4b2eb510, 0x49264a2e, 0x6013e000, 0x07e469cc, 0x2401d1fb, 0x4c25610c,
    0xe0006004, 0x69c86013, 0xd1fb07c0, 0x08406908, 0x61080040, 0x068069c8, 0x69c8d505, 0x43102220,
    0x200161c8, 0x2000bd10, 0xb5f0bd10, 0x1cc94d16, 0x69eb0889, 0x27200089, 0x61eb433b, 0x612b2300,
    0xe0164c18, 0x2603692b, 0x612b4333, 0x60036813, 0xe0004b15, 0x69ee601c, 0xd4fb06f6, 0x069b69eb,
    0x69e8d504, 0x61e84338, 0xbdf02001, 0x1f091d00, 0x29001d12, 0x6928d1e6, 0x00800880, 0x20006128,
    0x0000bdf0, 0x3399aa55, 0x40020400, 0x000087e4, 0x40020000, 0x0000a5a5, 0x40020100, 0xa5a50001,
    0xabcd6789, 0x0000aaaa, 0x40008000, 0x00000000
    ],

    # Relative function addresses
    'pc_init': 0x20000005,
    'pc_unInit': 0x2000002b,
    'pc_program_page': 0x200000af,
    'pc_erase_sector': 0x2000006d,
    'pc_eraseAll': 0x20000039,

    'static_base' : 0x20000000 + 0x00000004 + 0x0000012c,
    'begin_stack' : 0x20000940,
    'end_stack' : 0x20000540,
    'begin_data' : 0x20000140,
    'page_size' : 0x200,
    'analyzer_supported' : False,
    'analyzer_address' : 0x00000000,
    # Enable double buffering
    'page_buffers' : [
        0x20000140,
        0x20000340
    ],
    'min_program_length' : 0x200,

    # Relative region addresses and sizes
    'ro_start': 0x4,
    'ro_size': 0x12c,
    'rw_start': 0x130,
    'rw_size': 0x4,
    'zi_start': 0x134,
    'zi_size': 0x0,

    # Flash information
    'flash_start': 0x0,
    'flash_size': 0x6000,
    'sector_sizes': (
        (0x0, 0x200),
    )
}

class G32F002x5(CoreSightTarget):

    VENDOR = "Geehy"

    MEMORY_MAP = MemoryMap(
        FlashRegion(start=0x0000_0000, length=0x6000,
            blocksize=0x200, is_boot_memory=True,
            algo=FLASH_ALGO),
        RamRegion(start=0x2000_0000, length=0x0C00)
        )
    
    def __init__(self, session):
        super().__init__(session, self.MEMORY_MAP)
        self._svd_location = SVDFile.from_builtin("G32F002.svd")