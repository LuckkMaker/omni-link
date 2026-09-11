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
# Flash algorithms generated from Geehy APM32F4xx_DFP 1.0.11 FLM files
# using generate_flash_algo.py. The 1024/512/256/512(F465) FLMs share the
# same code image and differ only in the flash size field, so one base algo
# is cloned per capacity.
#

FLASH_ALGO_1MB = {
    'load_address': 0x20000000,
    'instructions': [
    0xe7fdbe00,
    0x0e000300, 0xd3022820, 0x1d000940, 0x28104770, 0x0900d302, 0x47701cc0, 0x47700880, 0x49414842,
    0x49426041, 0x21006041, 0x68c16001, 0x431122f0, 0x694060c1, 0xd4060680, 0x493d483e, 0x21066001,
    0x493d6041, 0x20006081, 0x48374770, 0x05426901, 0x61014311, 0x47702000, 0x4833b510, 0x24046901,
    0x61014321, 0x03a26901, 0x61014311, 0x4a314933, 0x6011e000, 0x03db68c3, 0x6901d4fb, 0x610143a1,
    0xbd102000, 0xf7ffb530, 0x4927ffbb, 0x23f068ca, 0x60ca431a, 0x610c2402, 0x06c0690a, 0x43020e00,
    0x6908610a, 0x431003e2, 0x48246108, 0xe0004a21, 0x68cd6010, 0xd4fb03ed, 0x43a06908, 0x68c86108,
    0x0f000600, 0x68c8d003, 0x60c84318, 0xbd302001, 0x4d15b570, 0x08891cc9, 0x008968eb, 0x433326f0,
    0x230060eb, 0x4b16612b, 0x692ce017, 0x612c431c, 0x60046814, 0x03e468ec, 0x692cd4fc, 0x00640864,
    0x68ec612c, 0x0f240624, 0x68e8d004, 0x60e84330, 0xbd702001, 0x1f091d00, 0x29001d12, 0x2000d1e5,
    0x0000bd70, 0x45670123, 0x40023c00, 0xcdef89ab, 0x00005555, 0x40003000, 0x00000fff, 0x0000aaaa,
    0x00000201, 0x00000000
    ],
    'pc_init': 0x20000021,
    'pc_unInit': 0x2000004f,
    'pc_program_page': 0x200000d5,
    'pc_erase_sector': 0x20000089,
    'pc_eraseAll': 0x2000005d,
    'static_base': 0x20000000 + 0x00000004 + 0x00000144,
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
    'ro_size': 0x144,
    'rw_start': 0x148,
    'rw_size': 0x4,
    'zi_start': 0x14c,
    'zi_size': 0x0,
    'flash_start': 0x8000000,
    'flash_size': 0x100000,
    'sector_sizes': (
        (0x0, 0x4000),
        (0x10000, 0x10000),
        (0x20000, 0x20000),
    )
}

FLASH_ALGO_512K = dict(FLASH_ALGO_1MB, flash_size=0x80000)
FLASH_ALGO_256K = dict(FLASH_ALGO_1MB, flash_size=0x40000)
# APM32F465_512.FLM shares the same code image as the generic 512K algo.
FLASH_ALGO_465_512K = FLASH_ALGO_512K

FLASH_ALGO_128K = {
    'load_address': 0x20000000,
    'instructions': [
    0xe7fdbe00,
    0x4603b510, 0x4c452000, 0x48456020, 0x48456060, 0x46206060, 0x240469c0, 0x28004020, 0x4842d106,
    0x60204c42, 0x60602006, 0x60a04841, 0xbd102000, 0x483a4601, 0x22806900, 0x4a384310, 0x20006110,
    0x48364770, 0x21046900, 0x49344308, 0x46086108, 0x21406900, 0x49314308, 0xe0026108, 0x49334835,
    0x482e6008, 0x07c068c0, 0x28000fc0, 0x482bd1f6, 0x21046900, 0x49294388, 0x20006108, 0x46014770,
    0x69004826, 0x43102202, 0x61104a24, 0x61414610, 0x22406900, 0x4a214310, 0xe0026110, 0x4a234825,
    0x481e6010, 0x07c068c0, 0x28000fc0, 0x481bd1f6, 0x22026900, 0x4a194390, 0x20006110, 0xb5104770,
    0x1c484603, 0x00490841, 0x4814e024, 0x24016900, 0x4c124320, 0x88106120, 0xbf008018, 0x68c0480f,
    0x0fc007c0, 0xd1f92800, 0x6900480c, 0x00400840, 0x61204c0a, 0x68c04620, 0x40202414, 0xd0062800,
    0x68c04806, 0x4c054320, 0x200160e0, 0x1c9bbd10, 0x1e891c92, 0xd1d82900, 0xe7f72000, 0x40022000,
    0x45670123, 0xcdef89ab, 0x00005555, 0x40003000, 0x00000fff, 0x0000aaaa, 0x00000000
    ],
    'pc_init': 0x20000005,
    'pc_unInit': 0x20000035,
    'pc_program_page': 0x200000c3,
    'pc_erase_sector': 0x20000083,
    'pc_eraseAll': 0x20000047,
    'static_base': 0x20000000 + 0x00000004 + 0x00000138,
    'begin_stack': 0x20001940,
    'end_stack': 0x20000940,
    'page_size': 0x400,
    'analyzer_supported': False,
    'analyzer_address': 0x00000000,
    'page_buffers': [
        0x20000140,
        0x20000540
    ],
    'min_program_length': 0x400,
    'ro_start': 0x4,
    'ro_size': 0x138,
    'rw_start': 0x13c,
    'rw_size': 0x4,
    'zi_start': 0x140,
    'zi_size': 0x0,
    'flash_start': 0x8000000,
    'flash_size': 0x20000,
    'sector_sizes': (
        (0x0, 0x400),
    )
}
