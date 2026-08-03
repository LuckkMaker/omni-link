# pyOCD debugger
# Copyright (c) 2026 OMNI Link
# SPDX-License-Identifier: Apache-2.0
#
# Flash algorithm generated from STM32F4xx_1024.FLM using generate_flash_algo.py.
# STM32F407IG: 1MB Flash, 192KB RAM (128KB SRAM + 64KB CCM).

from ....coresight.coresight_target import CoreSightTarget
from ....core.memory_map import (FlashRegion, RamRegion, MemoryMap)
from ....debug.svd.loader import SVDFile

CHIP_ERASE_WEIGHT = 15.0

class DBGMCU:
    CR = 0xE0042004
    CR_VALUE = 0x7  # DBG_STANDBY | DBG_STOP | DBG_SLEEP

    APB1_FZ = 0xE0042008
    APB1_FZ_VALUE = 0x06e01dff

    APB2_FZ = 0xE004200C
    APB2_FZ_VALUE = 0x00070003


# Generated from STM32F4xx_1024.FLM (Keil STM32F4xx 1MB Flash)
FLASH_ALGO = {
    'load_address': 0x20000000,
    'instructions': [
    0xe7fdbe00,
    0x0e000300, 0xd3022820, 0x1d000940, 0x28104770, 0x0900d302, 0x47701cc0, 0x47700880, 0x49424843,
    0x49436041, 0x68016041, 0x0f090709, 0x68c16001, 0x431122f0, 0x694060c1, 0xd4060680, 0x493d483e,
    0x21066001, 0x493d6041, 0x20006081, 0x48374770, 0x05426901, 0x61014311, 0x47702000, 0x4833b510,
    0x24046901, 0x61014321, 0x03a26901, 0x61014311, 0x4a314933, 0x6011e000, 0x03db68c3, 0x6901d4fb,
    0x610143a1, 0xbd102000, 0xf7ffb530, 0x4927ffb9, 0x23f068ca, 0x60ca431a, 0x610c2402, 0x06c0690a,
    0x43020e00, 0x6908610a, 0x431003e2, 0x48246108, 0xe0004a21, 0x68cd6010, 0xd4fb03ed, 0x43a06908,
    0x68c86108, 0x0f000600, 0x68c8d003, 0x60c84318, 0xbd302001, 0x4d15b570, 0x08891cc9, 0x008968eb,
    0x433326f0, 0x230060eb, 0x4b16612b, 0x692ce017, 0x612c431c, 0x60046814, 0x03e468ec, 0x692cd4fc,
    0x00640864, 0x68ec612c, 0x0f240624, 0x68e8d004, 0x60e84330, 0xbd702001, 0x1f091d00, 0x29001d12,
    0x2000d1e5, 0x0000bd70, 0x45670123, 0x40023c00, 0xcdef89ab, 0x00005555, 0x40003000, 0x00000fff,
    0x0000aaaa, 0x00000201, 0x00000000
    ],
    'pc_init': 0x20000021,
    'pc_unInit': 0x20000053,
    'pc_program_page': 0x200000d9,
    'pc_erase_sector': 0x2000008d,
    'pc_eraseAll': 0x20000061,
    'static_base': 0x20000000 + 0x00000004 + 0x00000148,
    'begin_stack': 0x20001950,
    'end_stack': 0x20000950,
    'page_size': 0x400,
    'analyzer_supported': False,
    'analyzer_address': 0x00000000,
    'page_buffers': [
        0x20000150,
        0x20000550
    ],
    'min_program_length': 0x400,
    'ro_start': 0x4,
    'ro_size': 0x148,
    'rw_start': 0x14c,
    'rw_size': 0x4,
    'zi_start': 0x150,
    'zi_size': 0x0,
    'flash_start': 0x8000000,
    'flash_size': 0x100000,
    'sector_sizes': (
        (0x0, 0x4000),
        (0x10000, 0x10000),
        (0x20000, 0x20000),
    )
}


class STM32F407xG(CoreSightTarget):
    """STM32F407IG: 1MB Flash, 192KB RAM (128KB SRAM + 64KB CCM)."""

    VENDOR = "STMicroelectronics"

    # STM32F407IG Flash layout (1MB):
    #   Sector 0-3:  16KB  each @ 0x08000000 (total 64KB)
    #   Sector 4:    64KB        @ 0x08010000
    #   Sector 5-7:  128KB each  @ 0x08020000 (total 384KB... wait, 3*128=384, +64+64=512?)
    # Actually: 4*16KB + 1*64KB + 3*128KB = 64+64+384 = 512KB... no.
    # STM32F407IG has 1MB Flash:
    #   Sector 0-3:  16KB  each (64KB total)
    #   Sector 4:    64KB
    #   Sector 5-7:  128KB each (384KB total)
    #   Total: 64 + 64 + 384 = 512KB... that's only 512KB.
    # Wait, for 1MB (1024KB):
    #   Sector 0-3:  16KB  each = 64KB
    #   Sector 4:    64KB        = 64KB
    #   Sector 5-7:  128KB each  = 384KB  → total 512KB
    # Hmm, that's 512KB. For 1MB devices, there are 4 more 128KB sectors (8-11).
    # Actually the FLM says: sectors start at 0x0(16KB), 0x10000(64KB), 0x20000(128KB)
    # The sector_sizes define the *type* of sector, not the count.
    # The flash_size is 0x100000 = 1MB, and the region layout handles the rest.
    MEMORY_MAP = MemoryMap(
        FlashRegion(start=0x08000000, length=0x10000, sector_size=0x4000,
                    page_size=0x400, is_boot_memory=True,
                    erase_all_weight=CHIP_ERASE_WEIGHT, algo=FLASH_ALGO),
        FlashRegion(start=0x08010000, length=0x10000, sector_size=0x10000,
                    page_size=0x400,
                    erase_all_weight=CHIP_ERASE_WEIGHT, algo=FLASH_ALGO),
        FlashRegion(start=0x08020000, length=0xe0000, sector_size=0x20000,
                    page_size=0x400,
                    erase_all_weight=CHIP_ERASE_WEIGHT, algo=FLASH_ALGO),
        # 128KB SRAM (112KB SRAM1 + 16KB SRAM2, contiguous)
        RamRegion(start=0x20000000, length=0x20000),
        # 64KB CCM RAM
        RamRegion(start=0x10000000, length=0x10000),
    )

    def __init__(self, session):
        super().__init__(session, self.MEMORY_MAP)
        self._svd_location = SVDFile.from_builtin("STM32F407.svd")

    def post_connect_hook(self):
        self.write32(DBGMCU.CR, DBGMCU.CR_VALUE)
        self.write32(DBGMCU.APB1_FZ, DBGMCU.APB1_FZ_VALUE)
        self.write32(DBGMCU.APB2_FZ, DBGMCU.APB2_FZ_VALUE)
