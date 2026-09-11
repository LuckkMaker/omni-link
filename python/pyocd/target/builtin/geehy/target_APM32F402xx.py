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
# APM32F402 generic target: 128KB Flash, 32KB RAM.
# Replaces APM32F402TB/CB/RB (same flash capacity).
#

from ....coresight.coresight_target import CoreSightTarget
from ....core.memory_map import (FlashRegion, RamRegion, MemoryMap)
from ....debug.svd.loader import SVDFile
from .target_APM32F4xx_flash import FLASH_ALGO_128K


class APM32F402xB(CoreSightTarget):
    """APM32F402: 128KB Flash, 32KB RAM."""

    VENDOR = "Geehy"

    MEMORY_MAP = MemoryMap(
        FlashRegion(start=0x08000000, length=0x20000, sector_size=0x400,
                    page_size=0x400, is_boot_memory=True, algo=FLASH_ALGO_128K),
        RamRegion(start=0x20000000, length=0x8000),
    )

    def __init__(self, session):
        super().__init__(session, self.MEMORY_MAP)
        self._svd_location = SVDFile.from_builtin("APM32F402.svd")
