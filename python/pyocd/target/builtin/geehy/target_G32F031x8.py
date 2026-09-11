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
    0x4960b510, 0x07c069c8, 0x4860d1fc, 0x60034b5e, 0x24016842, 0x60424322, 0x07926842, 0x2400d5fc,
    0x68826084, 0xd4fc0792, 0x610460c4, 0x62846244, 0x630462c4, 0x04122201, 0x48556002, 0x48566003,
    0x60024a54, 0x63824a55, 0x60084855, 0x02402001, 0x69c86148, 0x43902260, 0x200061c8, 0x4849bd10,
    0x60412100, 0x46086001, 0x48464770, 0x07c969c1, 0x494cd1fc, 0x69416041, 0x00890889, 0x69416141,
    0x43112202, 0x49436141, 0x60112200, 0x07c969c1, 0x69c1d1fc, 0xd5fc06c9, 0x221069c1, 0x61c14391,
    0x47702000, 0x69ca4937, 0xd1fc07d2, 0x604a4a3d, 0x0892694a, 0x614a0092, 0x2301694a, 0x614a431a,
    0x60024a34, 0x07c069c8, 0x69c8d1fc, 0xd5fc06c0, 0x221069c8, 0x61c84390, 0x47702000, 0x2300b5f8,
    0x078b9300, 0x24000f9b, 0x1acf466d, 0x193ee003, 0x552e5d96, 0x429c1c64, 0x4e22d3f9, 0x07e469f4,
    0x4c28d1fc, 0x69746074, 0x00a408a4, 0x69746174, 0x432c2503, 0x43a96174, 0x24102760, 0xca20e013,
    0x1f09c020, 0x07ed69f5, 0x69f5d1fc, 0x0fad066d, 0x69f5d116, 0xd5fc06ed, 0x1c6d2500, 0xdbfc2d64,
    0x43a569f5, 0x290061f5, 0x2b00d1e9, 0x9900d017, 0x69f06001, 0xd1fc07c0, 0x064069f0, 0xd0040f80,
    0x43b869f0, 0x200161f0, 0x69f0bdf8, 0xd5fc06c0, 0x1c402000, 0xdbfc2864, 0x43a069f0, 0x200061f0,
    0x0000bdf8, 0x40020800, 0x000087e4, 0x40020400, 0x40000400, 0x0000a5a5, 0x40000500, 0xa5a50001,
    0x3399aa55, 0xabcd6789, 0x00000000
    ],

    # Relative function addresses
    'pc_init': 0x20000005,
    'pc_unInit': 0x20000063,
    'pc_program_page': 0x200000e1,
    'pc_erase_sector': 0x200000a9,
    'pc_eraseAll': 0x2000006f,

    'static_base' : 0x20000000 + 0x00000004 + 0x000001a8,
    'begin_stack' : 0x200015b0,
    'end_stack' : 0x200005b0,
    'begin_data' : 0x20000000 + 0x1000,
    'page_size' : 0x200,
    'analyzer_supported' : False,
    'analyzer_address' : 0x00000000,
    # Enable double buffering
    'page_buffers' : [
        0x200001b0,
        0x200003b0
    ],
    'min_program_length' : 0x200,

    # Relative region addresses and sizes
    'ro_start': 0x4,
    'ro_size': 0x1a8,
    'rw_start': 0x1ac,
    'rw_size': 0x4,
    'zi_start': 0x1b0,
    'zi_size': 0x0,

    # Flash information
    'flash_start': 0x0,
    'flash_size': 0x10000,
    'sector_sizes': (
        (0x0, 0x200),
    )
}

class G32F031x8(CoreSightTarget):

    VENDOR = "Geehy"

    MEMORY_MAP = MemoryMap(
        FlashRegion(start=0x0000_0000, length=0x10000,
            blocksize=0x200, is_boot_memory=True,
            algo=FLASH_ALGO),
        RamRegion(start=0x2000_0000, length=0x4000)
        )
    
    def __init__(self, session):
        super().__init__(session, self.MEMORY_MAP)
        self._svd_location = SVDFile.from_builtin("G32F031.svd")