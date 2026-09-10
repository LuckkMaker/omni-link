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
# APM32F405 generic target: 1MB Flash, 128KB SRAM + 64KB CCM.
# Replaces APM32F405RG/VG/ZG (same flash capacity).
#

from ....coresight.coresight_target import CoreSightTarget
from ....core.memory_map import (FlashRegion, RamRegion, MemoryMap)
from ....debug.svd.loader import SVDFile
from .target_APM32F4xx_flash import FLASH_ALGO_1MB

CHIP_ERASE_WEIGHT = 15.0


class APM32F405xG(CoreSightTarget):
    """APM32F405: 1MB Flash, 128KB SRAM + 64KB CCM."""

    VENDOR = "Geehy"

    # 1MB Flash layout:
    #   Sector 0-3:  16KB  each @ 0x08000000 (total 64KB)
    #   Sector 4:    64KB        @ 0x08010000
    #   Sector 5-7:  128KB each  @ 0x08020000 (total 384KB)
    MEMORY_MAP = MemoryMap(
        FlashRegion(start=0x08000000, length=0x10000, sector_size=0x4000,
                    page_size=0x400, is_boot_memory=True,
                    erase_all_weight=CHIP_ERASE_WEIGHT, algo=FLASH_ALGO_1MB),
        FlashRegion(start=0x08010000, length=0x10000, sector_size=0x10000,
                    page_size=0x400,
                    erase_all_weight=CHIP_ERASE_WEIGHT, algo=FLASH_ALGO_1MB),
        FlashRegion(start=0x08020000, length=0xe0000, sector_size=0x20000,
                    page_size=0x400,
                    erase_all_weight=CHIP_ERASE_WEIGHT, algo=FLASH_ALGO_1MB),
        RamRegion(start=0x20000000, length=0x20000),
        RamRegion(start=0x10000000, length=0x10000),
    )

    def __init__(self, session):
        super().__init__(session, self.MEMORY_MAP)
        self._svd_location = SVDFile.from_builtin("APM32F40x.svd")
