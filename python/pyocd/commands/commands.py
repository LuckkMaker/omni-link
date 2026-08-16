# pyOCD debugger
# Copyright (c) 2015-2020,2025 Arm Limited
# Copyright (c) 2021-2023 Chris Reed
# Copyright (c) 2022 David Runge
# Copyright (c) 2022 Toshiba Electronic Devices & Storage Corporation
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

from __future__ import annotations

import logging
import os
import time
from natsort import natsorted
import textwrap
from time import sleep
from shutil import get_terminal_size
from typing import TYPE_CHECKING

from .. import coresight
from ..core.helpers import ConnectHelper
from ..core import exceptions
from ..probe.tcp_probe_server import DebugProbeServer
from ..core.target import Target
from ..flash.loader import FlashLoader
from ..flash.eraser import FlashEraser
from ..core.memory_map import MemoryType
from ..flash.file_programmer import FileProgrammer
from ..gdbserver.gdbserver import GDBServer
from ..utility import conversion
from ..utility.strings import UniquePrefixMatcher
from ..utility.cmdline import convert_reset_type
from ..utility.hex import (
    format_hex_width,
    dump_hex_data_to_str,
    )
from ..utility.progress import print_progress
from ..utility.columns import ColumnFormatter
from ..utility.mask import (
    msb,
    bfx,
    bfi,
    )
from .base import CommandBase

if TYPE_CHECKING:
    from ..core.core_target import CoreTarget

# Make disasm optional.
try:
    import capstone
    IS_CAPSTONE_AVAILABLE = True
except ImportError:
    IS_CAPSTONE_AVAILABLE = False

LOG = logging.getLogger(__name__)

WATCHPOINT_FUNCTION_NAME_MAP = {
                        Target.WatchpointType.READ: 'r',
                        Target.WatchpointType.WRITE: 'w',
                        Target.WatchpointType.READ_WRITE: 'rw',
                        'r': Target.WatchpointType.READ,
                        'w': Target.WatchpointType.WRITE,
                        'rw': Target.WatchpointType.READ_WRITE,
                        }

class ListCommand(CommandBase):
    INFO = {
            'names': ['list'],
            'group': 'commander',
            'category': 'commander',
            'nargs': None,
            'usage': "",
            'help': "Show available targets.",
            }

    def execute(self):
        ConnectHelper.list_connected_probes()

class ExitCommand(CommandBase):
    INFO = {
            'names': ['exit', 'quit'],
            'group': 'commander',
            'category': 'commander',
            'nargs': 0,
            'usage': "",
            'help': "Quit pyocd commander.",
            }

    def execute(self):
        from .repl import ToolExitException
        raise ToolExitException()

class StatusCommand(CommandBase):
    INFO = {
            'names': ['status', 'st'],
            'group': 'standard',
            'category': 'target',
            'nargs': None,
            'usage': "",
            'help': "Show the target's current state.",
            }

    def execute(self):
        if not self.context.target.is_locked():
            for i, c in enumerate(self.context.target.cores):
                core = self.context.target.cores[c]
                state_desc = core.get_state().name.capitalize()
                desc = f"Core {i} ({core.node_name}):  {state_desc}"
                if len(core.supported_security_states) > 1:
                    desc += " [%s]" % core.get_security_state().name.capitalize()
                self.context.write(desc)
        else:
            self.context.write("Target is locked")

class RegisterCommandBase(CommandBase):
    def dump_register_group(self, group_name):
        regs = natsorted(self.context.selected_core.core_registers.iter_matching(
                lambda r: r.group == group_name), key=lambda r: r.name)
        reg_values = self.context.selected_core.read_core_registers_raw(r.name for r in regs)

        col_printer = ColumnFormatter()
        for info, value in zip(regs, reg_values):
            value_str = self._format_core_register(info, value)
            col_printer.add_items([(info.name, value_str)])

        col_printer.write(self.context.output_stream)

    def dump_registers(self, show_all=False, show_group=None):
        if not self.context.selected_core.is_halted():
            self.context.write("Core is not halted; cannot read core registers")
            return

        all_groups = sorted(self.context.selected_core.core_registers.groups)
        if show_all:
            groups_to_show = all_groups
        elif show_group:
            if show_group not in all_groups:
                raise exceptions.CommandError("invalid register group %s" % show_group)
            groups_to_show = [show_group]
        else:
            groups_to_show = ['general']

        for group in groups_to_show:
            self.context.writei("%s registers:", group)
            self.dump_register_group(group)

    def _dump_peripheral_register(self, periph, reg, show_fields):
        size = reg.size or 32
        addr = periph.base_address + reg.address_offset
        value = self.context.selected_ap.read_memory(addr, size)
        value_str = format_hex_width(value, size)
        self.context.writei("%s.%s @ %08x = %s", periph.name, reg.name, addr, value_str)

        if show_fields:
            for f in reg.fields:
                if f.is_reserved:
                    continue
                msb = f.bit_offset + f.bit_width - 1
                lsb = f.bit_offset
                f_value = bfx(value, msb, lsb)
                v_enum = None
                if f.enumerated_values:
                    for v in f.enumerated_values:
                        if v.value == f_value:
                            v_enum = v
                            break
                if f.bit_width == 1:
                    bits_str = "%d" % lsb
                else:
                    bits_str = "%d:%d" % (msb, lsb)
                f_value_str = "%x" % f_value
                digits = (f.bit_width + 3) // 4
                f_value_str = "0" * (digits - len(f_value_str)) + f_value_str
                f_value_bin_str = bin(f_value)[2:]
                f_value_bin_str = "0" * (f.bit_width - len(f_value_bin_str)) + f_value_bin_str
                if v_enum:
                    if v_enum.name and v_enum.description:
                        f_value_enum_str = f" {v_enum.name}: {v_enum.description}"
                    elif v_enum.name or v_enum.description:
                        f_value_enum_str = f" {v_enum.name or v_enum.description}"
                    else:
                        f_value_enum_str = ""
                else:
                    f_value_enum_str = ""
                self.context.writei("  %s[%s] = %s (%s)%s", f.name, bits_str, f_value_str, f_value_bin_str, f_value_enum_str)

class RegCommand(RegisterCommandBase):
    INFO = {
            'names': ['reg', 'rr'],
            'group': 'standard',
            'category': 'registers',
            'nargs': '*',
            'usage': "[-p] [-f] [REG...]",
            'help': "Print core or peripheral register(s).",
            'extra_help':
                "If no arguments are provided, the 'general' core register group will be printed. Either a core "
                "register name, the name of a peripheral, or a peripheral.register can be provided. When a peripheral "
                "name is provided without a register, all registers in the peripheral will be printed. The -p option "
                "forces evaluating the register name as a peripheral register name. If the -f option is passed, then "
                "individual fields of peripheral registers will be printed in addition to the full value.",
            }

    show_all = False
    show_fields = False
    show_peripheral = False

    def parse(self, args):
        if len(args) == 0:
            self.regs = ["general"]
        else:
            while (len(args) >= 2) and args[0].startswith('-'):
                opt = args.pop(0)
                if opt == '-f':
                    self.show_fields = True
                elif opt == '-p':
                    self.show_peripheral = True
                else:
                    raise exceptions.CommandError(f"unrecognized option {opt}")

            self.regs = args
            self.show_all = (not self.show_peripheral and self.regs[0].lower() == "all")

    def execute(self):
        if self.show_all:
            self.dump_registers(show_all=True)
            return

        matcher = UniquePrefixMatcher(self.context.selected_core.core_registers.groups)

        for reg in self.regs:
            reg = reg.lower()
            if not self.show_peripheral:
                # Check register names first.
                if reg in self.context.selected_core.core_registers.by_name:
                    if not self.context.selected_core.is_halted():
                        self.context.write("Core is not halted; cannot read core registers")
                        return

                    info = self.context.selected_core.core_registers.by_name[reg]
                    value = self.context.selected_core.read_core_register(reg)
                    value_str = self._format_core_register(info, value)
                    self.context.writei("%s = %s", reg, value_str)
                    continue

                # Now look for matching group name.
                group_matches = matcher.find_all(reg)
                if len(group_matches) == 1:
                    self.dump_registers(show_group=group_matches[0])
                    continue

            # And finally check for peripherals.
            subargs = reg.split('.')
            if subargs[0] in self.context.peripherals:
                p = self.context.peripherals[subargs[0]]
                if len(subargs) > 1:
                    r = [x for x in p.registers if x.name.lower() == subargs[1]]
                    if len(r):
                        self._dump_peripheral_register(p, r[0], self.show_fields)
                    else:
                        raise exceptions.CommandError("invalid register '%s' for %s" % (subargs[1], p.name))
                else:
                    for r in p.registers:
                        self._dump_peripheral_register(p, r, self.show_fields)
            else:
                raise exceptions.CommandError("invalid peripheral '%s'" % (subargs[0]))

class WriteRegCommand(RegisterCommandBase):
    INFO = {
            'names': ['wreg', 'wr'],
            'group': 'standard',
            'category': 'registers',
            'nargs': '*',
            'usage': "[-r] [-p] [-f] REG VALUE",
            'help': "Set the value of a core or peripheral register.",
            'extra_help':
                "The REG parameter must be a core register name or a peripheral.register. When a peripheral register "
                "is written, if the -r option is passed then it is read back and the updated value printed. The -p "
                "option forces evaluating the register name as a peripheral register name. If the -f option is passed, "
                "then individual fields of peripheral registers will be printed in addition to the full value.",
            }

    select_peripheral = False
    do_readback = False
    show_fields = False

    def parse(self, args):
        while (len(args) >= 2) and args[0].startswith('-'):
            opt = args.pop(0)
            if opt == '-r':
                self.do_readback = True
            elif opt == '-p':
                self.select_peripheral = True
            elif opt == '-f':
                self.show_fields = True
            else:
                raise exceptions.CommandError(f"unrecognized option {opt}")

        self.reg = args[0].lower()
        self.value = args[1]

    def execute(self):
        if not self.select_peripheral and self.reg in self.context.selected_core.core_registers.by_name:
            if not self.context.selected_core.is_halted():
                self.context.write("Core is not halted; cannot write core registers")
                return

            if (self.reg.startswith('s') and self.reg != 'sp') or self.reg.startswith('d'):
                value = float(self.value)
            else:
                value = self._convert_value(self.value)
            self.context.selected_core.write_core_register(self.reg, value)
            self.context.target.flush()
        else:
            value = self._convert_value(self.value)
            subargs = self.reg.split('.')
            if len(subargs) < 2:
                raise exceptions.CommandError("no register specified")
            if subargs[0] in self.context.peripherals:
                p = self.context.peripherals[subargs[0]]
                r = [x for x in p.registers if x.name.lower() == subargs[1]]
                if len(r):
                    r = r[0]
                    addr = p.base_address + r.address_offset
                    if len(subargs) == 2:
                        self.context.writei("writing 0x%x to 0x%x:%d (%s)", value, addr, r.size, r.name)
                        self.context.selected_ap.write_memory(addr, value, r.size)
                    elif len(subargs) == 3:
                        f = [x for x in r.fields if x.name.lower() == subargs[2]]
                        if len(f):
                            f = f[0]
                            msb = f.bit_offset + f.bit_width - 1
                            lsb = f.bit_offset
                            originalValue = self.context.selected_ap.read_memory(addr, r.size)
                            value = bfi(originalValue, msb, lsb, value)
                            self.context.writei("writing 0x%x to 0x%x[%d:%d]:%d (%s.%s)",
                                    value, addr, msb, lsb, r.size, r.name, f.name)
                            self.context.selected_ap.write_memory(addr, value, r.size)
                    else:
                        raise exceptions.CommandError("too many dots")
                    self.context.target.flush()
                    if self.do_readback:
                        self._dump_peripheral_register(p, r, self.show_fields)
                else:
                    raise exceptions.CommandError("invalid register '%s' for %s" % (subargs[1], p.name))
            else:
                raise exceptions.CommandError("invalid peripheral '%s'" % (subargs[0]))

class ResetCommand(CommandBase):
    INFO = {
            'names': ['reset'],
            'group': 'standard',
            'category': 'device',
            'nargs': [0, 1, 2],
            'usage': "[halt|-halt|-h] [TYPE]",
            'help': "Reset the target, optionally with halt and/or specifying the reset type.",
            'extra_help': "The reset type must be one of 'default', 'hardware', 'system', 'core', "
                          "'n_srst', 'sysresetreq', 'vectreset' or 'emulated'."
            }

    def parse(self, args):
        self.do_halt = False
        self.reset_type = None
        if len(args) >= 1:
            self.do_halt = (args[0] in ('-h', '--halt', 'halt'))
            if self.do_halt:
                args.pop(0)
        if len(args) == 1:
            self.reset_type = convert_reset_type(args[0])

    def execute(self):
        if self.do_halt:
            self.context.write("Resetting target with halt")
            self.context.selected_core.reset_and_halt(self.reset_type)

            status = self.context.selected_core.get_state()
            if status != Target.State.HALTED:
                self.context.writei("Failed to halt device on reset (state is %s)", status.name)
            else:
                self.context.write("Successfully halted device on reset")
        else:
            if self.context.selected_core is None:
                self.context.write("Resetting via probe")
                self.context.probe.reset()
            else:
                self.context.write("Resetting target")
                self.context.selected_core.reset(self.reset_type)

class DisassembleCommand(CommandBase):
    INFO = {
            'names': ['disasm', 'd'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [1, 2, 3],
            'usage': "[-c/--center] ADDR [LEN]",
            'help': "Disassemble instructions at an address.",
            'extra_help':
                "The length argument is in bytes and is optional, with a default of 6. If the -c option "
                "is used, the disassembly is centered on the given address. Otherwise the disassembly "
                "begins at the given address.",
            }

    def parse(self, args):
        self.center = (len(args) > 1) and (args[0] in ('-c', '--center'))
        if self.center:
            del args[0]
        self.addr = self._convert_value(args[0])
        if len(args) < 2:
            self.count = 6
        else:
            self.count = self._convert_value(args[1])

    def execute(self):
        if self.center:
            self.addr -= self.count // 2

        # Since we're disassembling, make sure the Thumb bit is cleared.
        self.addr &= ~1

        # Print disasm of data.
        data = self.context.selected_ap.read_memory_block8(self.addr, self.count)
        print_disasm(self.context, bytes(bytearray(data)), self.addr)

class ReadCommandBase(CommandBase):
    def parse(self, args):
        self.addr = self._convert_value(args[0])
        self.width = self.INFO['width']
        if len(args) < 2:
            self.count = self.width // 8
        else:
            self.count = self._convert_value(args[1])

    def execute(self):
        if (self.count % (self.width // 8)) != 0:
            raise exceptions.CommandError("length ({}) is not aligned to width ({})".format(self.count, self.width // 8))

        if self.width == 8:
            data = self.context.selected_ap.read_memory_block8(self.addr, self.count)
        else:
            byte_data = self.context.selected_ap.read_memory_block8(self.addr, self.count)
            data = conversion.byte_list_to_nbit_le_list(byte_data, self.width)

        # Print hex dump of output.
        self.context.write(dump_hex_data_to_str(data, start_address=self.addr, width=self.width), end='')

class Read8Command(ReadCommandBase):
    INFO = {
            'names': ['read8', 'rb'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [1, 2],
            'usage': "ADDR [LEN]",
            'width': 8,
            'help': "Read 8-bit bytes.",
            'extra_help': "Optional length parameter is the number of bytes to read. If the "
                           "length is not provided, one byte is read.",
            }

class Read16Command(ReadCommandBase):
    INFO = {
            'names': ['read16', 'rh'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [1, 2],
            'usage': "ADDR [LEN]",
            'width': 16,
            'help': "Read 16-bit halfwords.",
            'extra_help': "Optional length parameter is the number of bytes (not half-words) to read. It "
                           "must be divisible by 2. If the length is not provided, one halfword is read. "
                           "The address may be unaligned."
            }

class Read32Command(ReadCommandBase):
    INFO = {
            'names': ['read32', 'rw'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [1, 2],
            'usage': "ADDR [LEN]",
            'width': 32,
            'help': "Read 32-bit words.",
            'extra_help': "Optional length parameter is the number of bytes (not words) to read. It must be "
                           "divisible by 4. If the length is not provided, one word is read. "
                           "The address may be unaligned.",
            }

class Read64Command(ReadCommandBase):
    INFO = {
            'names': ['read64', 'rd'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [1, 2],
            'usage': "ADDR [LEN]",
            'width': 64,
            'help': "Read 64-bit words.",
            'extra_help': "Optional length parameter is the number of bytes (not double-words!) to read. "
                           "It must be divisible by 8. If the length is not provided, one word is read. "
                           "The address may be unaligned."
            }

def is_flash_write(context, addr, width, data):
    mem_map = context.target.get_memory_map()
    region = mem_map.get_region_for_address(addr)
    if (region is None) or (not region.is_flash):
        return False

    l = len(data) * (width // 8)

    return region.contains_range(addr, length=l)

class WriteCommandBase(CommandBase):
    def parse(self, args):
        if len(args) == 0:
            raise exceptions.CommandError("no address specified")
        if len(args) <= 1:
            raise exceptions.CommandError("no data for write")
        self.addr = self._convert_value(args[0])
        self.width = self.INFO['width']
        self.data = [self._convert_value(d) for d in args[1:]]

    def execute(self):
        if self.width != 8:
            self.data = conversion.nbit_le_list_to_byte_list(self.data, self.width)

        if is_flash_write(self.context, self.addr, self.width, self.data):
            # Look up flash region.
            region = self.context.session.target.memory_map.get_region_for_address(self.addr)
            if not region:
                raise exceptions.CommandError("address 0x%08x is not within a memory region", self.addr)
            if not region.is_flash:
                raise exceptions.CommandError("address 0x%08x is not in flash", self.addr)
            assert region.flash is not None

            # Program phrase to flash.
            region.flash.init(region.flash.Operation.PROGRAM)
            region.flash.program_phrase(self.addr, self.data)
            region.flash.cleanup()
        else:
            self.context.selected_ap.write_memory_block8(self.addr, self.data)
            self.context.target.flush()

class Write8Command(WriteCommandBase):
    INFO = {
            'names': ['write8', 'wb'],
            'group': 'standard',
            'category': 'memory',
            'nargs': '*',
            'usage': "ADDR DATA+",
            'width': 8,
            'help': "Write 8-bit bytes to memory.",
            'extra_help': "The data arguments are 8-bit bytes. Can write to both RAM and flash. "
                          "Flash writes are subject to minimum write size and alignment, and the flash "
                          "page must have been previously erased.",
            }

class Write16Command(WriteCommandBase):
    INFO = {
            'names': ['write16', 'wh'],
            'group': 'standard',
            'category': 'memory',
            'nargs': '*',
            'usage': "ADDR DATA+",
            'width': 16,
            'help': "Write 16-bit halfwords to memory.",
            'extra_help': "The data arguments are 16-bit halfwords in big-endian format and are written as "
                          "little-endian. The address may be unaligned. Can write to both RAM and flash. "
                          "Flash writes are subject to minimum write size and alignment, and the flash "
                          "page must have been previously erased.",
            }

class Write32Command(WriteCommandBase):
    INFO = {
            'names': ['write32', 'ww'],
            'group': 'standard',
            'category': 'memory',
            'nargs': '*',
            'usage': "ADDR DATA+",
            'width': 32,
            'help': "Write 32-bit words to memory.",
            'extra_help': "The data arguments are 32-bit words in big-endian format and are written as "
                          "little-endian. The address may be unaligned. Can write to both RAM and flash. "
                          "Flash writes are subject to minimum write size and alignment, and the flash "
                          "page must have been previously erased.",
            }

class Write64Command(WriteCommandBase):
    INFO = {
            'names': ['write64', 'wd'],
            'group': 'standard',
            'category': 'memory',
            'nargs': '*',
            'usage': "ADDR DATA...",
            'width': 64,
            'help': "Write 64-bit double-words to memory.",
            'extra_help': "The data arguments are 64-bit words in big-endian format and are written as "
                          "little-endian. The address may be unaligned. Can write to both RAM and flash. "
                          "Flash writes are subject to minimum write size and alignment, and the flash "
                          "page must have been previously erased."
            }

class SavememCommand(CommandBase):
    INFO = {
            'names': ['savemem'],
            'group': 'standard',
            'category': 'memory',
            'nargs': 3,
            'usage': "ADDR LEN FILENAME",
            'help': "Save a range of memory to a binary file.",
            'extra_help': "Saves raw binary data (not hex format). Use a .bin extension for the filename. "
                    "The file will contain the exact bytes read from memory. "
                    "To view as hex dump, use: $ ' '.join(f'{b:02X}' for b in target.read_memory_block8(0x20000000, 16))",
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])
        self.count = self._convert_value(args[1])
        self.filename = args[2]

    def execute(self):
        region = self.context.session.target.memory_map.get_region_for_address(self.addr)
        flash_init_required = region is not None and region.is_flash and not region.is_powered_on_boot and region.flash is not None
        if flash_init_required:
            try:
                region.flash.init(region.flash.Operation.VERIFY)
            except exceptions.FlashFailure:
                region.flash.init(region.flash.Operation.ERASE)

        data = bytearray(self.context.selected_ap.read_memory_block8(self.addr, self.count))

        if flash_init_required:
            region.flash.cleanup()

        with open(self.filename, 'wb') as f:
            f.write(data)
            self.context.writei("Saved %d bytes to %s", self.count, self.filename)

class LoadmemCommand(CommandBase):
    INFO = {
            'names': ['loadmem'],
            'group': 'standard',
            'category': 'memory',
            'nargs': 2,
            'usage': "ADDR FILENAME",
            'help': "Load a binary file to an address in memory (RAM or flash).",
            'extra_help': "This command is deprecated in favour of the more flexible 'load'.",
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])
        self.filename = args[1]

    def execute(self):
        with open(self.filename, 'rb') as f:
            data = bytearray(f.read())
            if is_flash_write(self.context, self.addr, 8, data):
                FlashLoader.program_binary_data(self.context.session, self.addr, data)
            else:
                self.context.selected_ap.write_memory_block8(self.addr, data)
            self.context.writei("Loaded %d bytes to 0x%08x", len(data), self.addr)

class LoadCommand(CommandBase):
    INFO = {
            'names': ['load'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [1, 2],
            'usage': "FILENAME [ADDR]",
            'help': "Load a binary, hex, or elf file with optional base address.",
            'extra_help': "Supports .bin, .hex, and .elf files. On Windows, use forward slashes (/) in paths "
                    "or use the path converter tool. "
                    "If you get 'flash program page failure', the flash may be protected. "
                    "Try: 1) 'unlock' to remove flash protection, 2) 'erase' to clear flash, 3) 'load' to program.",
            }

    def parse(self, args):
        self.filename = args[0]
        if len(args) > 1:
            self.addr = self._convert_value(args[1])
        else:
            self.addr = None

    def execute(self):
        programmer = FileProgrammer(self.context.session, progress=print_progress())
        programmer.program(self.filename, base_address=self.addr)

class CompareCommand(CommandBase):
    INFO = {
            'names': ['compare', 'cmp'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [2, 3],
            'usage': "ADDR [LEN] FILENAME",
            'help': "Compare a memory range against a binary file.",
            'extra_help': "If the length is not provided, then the length of the file is used.",
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])
        if len(args) < 3:
            self.filename = args[1]
            self.length = None
        else:
            self.filename = args[2]
            self.length = self._convert_value(args[1])

    def execute(self):
        region = self.context.session.target.memory_map.get_region_for_address(self.addr)
        flash_init_required = region is not None and region.is_flash and not region.is_powered_on_boot and region.flash is not None
        if flash_init_required:
            try:
                region.flash.init(region.flash.Operation.VERIFY)
            except exceptions.FlashFailure:
                region.flash.init(region.flash.Operation.ERASE)

        with open(self.filename, 'rb') as f:
            if self.length is None:
                file_data = bytearray(f.read())
            else:
                file_data = bytearray(f.read(self.length))

        if self.length is None:
            length = len(file_data)
        elif len(file_data) < self.length:
            self.context.writei("File is %d bytes long; reducing comparison length to match.", len(file_data))
            length = len(file_data)
        else:
            length = self.length

        # Divide into 32 kB chunks.
        CHUNK_SIZE = 32 * 1024
        chunk_count = (length + CHUNK_SIZE - 1) // CHUNK_SIZE

        addr = self.addr
        end_addr = addr + length
        offset = 0
        mismatch = False

        for chunk in range(chunk_count):
            # Get this chunk's size.
            chunk_size = min(end_addr - addr, CHUNK_SIZE)
            self.context.writei("Comparing %d bytes @ 0x%08x", chunk_size, addr)

            data = bytearray(self.context.selected_ap.read_memory_block8(addr, chunk_size))

            for i in range(chunk_size):
                if data[i] != file_data[offset+i]:
                    mismatch = True
                    self.context.writei("Mismatched byte at 0x%08x (offset 0x%x): 0x%02x (memory) != 0x%02x (file)",
                        addr + i, offset + i, data[i], file_data[offset+i])
                    break

            if mismatch:
                break

            offset += chunk_size
            addr += chunk_size

        if not mismatch:
            self.context.writei("All %d bytes match.", length)

        if flash_init_required:
            region.flash.cleanup()

class FillCommand(CommandBase):
    INFO = {
            'names': ['fill'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [3, 4],
            'usage': "[SIZE] ADDR LEN PATTERN",
            'help': "Fill a range of memory with a pattern.",
            'extra_help': "The optional SIZE parameter must be one of 8, 16, or 32. If not "
                           "provided, the size is determined by the pattern value's most "
                           "significant set bit. Only RAM regions may be filled.",
            }

    def parse(self, args):
        if len(args) == 3:
            self.size = None
            self.addr = self._convert_value(args[0])
            self.length = self._convert_value(args[1])
            self.pattern = self._convert_value(args[2])
        elif len(args) == 4:
            self.size = int(args[0])
            if self.size not in (8, 16, 32):
                raise exceptions.CommandError("invalid size argument")
            self.addr = self._convert_value(args[1])
            self.length = self._convert_value(args[2])
            self.pattern = self._convert_value(args[3])

        # Determine size by the highest set bit in the pattern.
        if self.size is None:
            highest = msb(self.pattern)
            if highest < 8:
                self.size = 8
            elif highest < 16:
                self.size = 16
            elif highest < 32:
                self.size = 32
            else:
                raise exceptions.CommandError("invalid pattern size (MSB is %d)", highest)

    def execute(self):
        # Create word-sized byte lists.
        if self.size == 8:
            pattern_str = "0x%02x" % (self.pattern & 0xff)
            self.pattern = [self.pattern]
        elif self.size == 16:
            pattern_str = "0x%04x" % (self.pattern & 0xffff)
            self.pattern = conversion.u16le_list_to_byte_list([self.pattern])
        elif self.size == 32:
            pattern_str = "0x%08x" % (self.pattern & 0xffffffff)
            self.pattern = conversion.u32le_list_to_byte_list([self.pattern])

        # Divide into 32 kB chunks.
        CHUNK_SIZE = 32 * 1024
        chunk_count = (self.length + CHUNK_SIZE - 1) // CHUNK_SIZE

        addr = self.addr
        end_addr = addr + self.length
        self.context.writei("Filling 0x%08x-0x%08x with pattern %s", addr, end_addr - 1, pattern_str)

        for chunk in range(chunk_count):
            # Get this chunk's size.
            chunk_size = min(end_addr - addr, CHUNK_SIZE)
            self.context.writei("Wrote %d bytes @ 0x%08x", chunk_size, addr)

            # Construct data for the chunk.
            if self.size == 8:
                data = self.pattern * chunk_size
            elif self.size == 16:
                data = (self.pattern * ((chunk_size + 1) // 2))[:chunk_size]
            elif self.size == 32:
                data = (self.pattern * ((chunk_size + 3) // 4))[:chunk_size]

            # Write to target.
            self.context.selected_ap.write_memory_block8(addr, data)
            addr += chunk_size

class FindCommand(CommandBase):
    INFO = {
            'names': ['find'],
            'group': 'standard',
            'category': 'memory',
            'nargs': '*',
            'usage': "[-n] ADDR LEN BYTE+",
            'help': "Search for a value in memory within the given address range.",
            'extra_help': "A pattern of any number of bytes can be searched for. Each BYTE "
                           "parameter must be an 8-bit value. If the -n argument is passed, "
                           "the search is negated and looks for the first set of bytes that "
                           "does not match the provided values.",
            }

    def parse(self, args):
        if len(args) < 3:
            raise exceptions.CommandError("missing argument")
        if args[0] == '-n':
            self.negate = True
            args.pop(0)
        else:
            self.negate = False
        self.addr = self._convert_value(args[0])
        self.length = self._convert_value(args[1])
        self.pattern = bytearray()
        for p in args[2:]:
            self.pattern += bytearray([self._convert_value(p)])
        self.pattern_str = " ".join("%02x" % p for p in self.pattern)

    def execute(self):
        # Divide into 32 kB chunks.
        CHUNK_SIZE = 32 * 1024
        chunk_count = (self.length + CHUNK_SIZE - 1) // CHUNK_SIZE

        addr = self.addr
        end_addr = addr + self.length
        self.context.writei("Searching 0x%08x-0x%08x for pattern [%s]", addr, end_addr - 1, self.pattern_str)

        match = False
        for chunk in range(chunk_count):
            # Get this chunk's size.
            chunk_size = min(end_addr - addr, CHUNK_SIZE)
            self.context.writei("Read %d bytes @ 0x%08x", chunk_size, addr)

            data = bytearray(self.context.selected_ap.read_memory_block8(addr, chunk_size))

            offset = data.find(self.pattern)
            if (offset != -1) ^ self.negate:
                match = True
                self.context.writei("Found pattern at address 0x%08x", addr + offset)
                break

            addr += chunk_size - len(self.pattern)

        if not match:
            self.context.writei("Failed to find pattern in range 0x%08x-0x%08x", self.addr, end_addr - 1)

class EraseCommand(CommandBase):
    INFO = {
            'names': ['erase'],
            'group': 'standard',
            'category': 'memory',
            'nargs': [0, 1, 2],
            'usage': "[ADDR] [COUNT]",
            'help': "Erase all internal flash or a range of sectors.",
            }

    def parse(self, args):
        if len(args) == 0:
            self.erase_chip = True
        else:
            self.erase_chip = False
            self.addr = self._convert_value(args[0])
            if len(args) < 2:
                self.count = 1
            else:
                self.count = self._convert_value(args[1])

    def execute(self):
        if self.erase_chip:
            eraser = FlashEraser(self.context.session, FlashEraser.Mode.CHIP)
            eraser.erase()
            # 统计所有 flash 区域总大小
            pname = self.context.session.target.selected_core.node_name
            total_bytes = sum(
                r.length
                for r in self.context.session.target.memory_map.iter_matching_regions(
                    type=MemoryType.FLASH, pname=pname
                )
            )
            self.context.writei("Erased chip (%d bytes)", total_bytes)
        else:
            eraser = FlashEraser(self.context.session, FlashEraser.Mode.SECTOR)
            total_erased = 0
            remaining = self.count
            while remaining:
                # Look up the flash region so we can get the page size.
                region = self.context.session.target.memory_map.get_region_for_address(self.addr)
                if not region:
                    self.context.writei("address 0x%08x is not within a memory region", self.addr)
                    break
                if not region.is_flash:
                    self.context.writei("address 0x%08x is not in flash", self.addr)
                    break

                # Erase this page.
                eraser.erase([self.addr])
                total_erased += region.blocksize

                # Next page.
                remaining -= 1
                self.addr += region.blocksize
            self.context.writei("Erased %d sector(s) (%d bytes)", self.count - remaining, total_erased)

class UnlockCommand(CommandBase):
    INFO = {
            'names': ['unlock'],
            'group': 'standard',
            'category': 'device',
            'nargs': 0,
            'usage': "",
            'help': "Unlock security on the target.",
            }

    def execute(self):
        self.context.target.mass_erase()

class ElfCommand(CommandBase):
    INFO = {
            'names': ['elf'],
            'group': 'standard',
            'category': 'symbols',
            'nargs': 1,
            'usage': "FILENAME",
            'help': "Load an ELF file for source-level debugging and symbol lookup.",
            'extra_help': "Sets the target's ELF file, enabling source-level info in 'step', "
                    "'where', 'symbol', and 'break' commands. After loading, 'step' will show "
                    "file:line alongside disassembly, and 'where' will resolve addresses to "
                    "source locations.\n"
                    "Full workflow: 1) halt  2) erase  3) load FIRMWARE.axf  "
                    "4) reset -h  5) elf FIRMWARE.axf  6) step",
            }

    def parse(self, args):
        self.filename = os.path.expanduser(args[0])

    def execute(self):
        self.context.session.target.elf = self.filename
        elf = self.context.session.target.elf
        self.context.writei("Loaded ELF: %s", os.path.basename(self.filename))
        # 输出 ELF 的 CPU 信息（可选，帮助确认正确加载）
        if elf and hasattr(elf, 'decoder'):
            pass  # ELF 对象创建成功即可
        # 提示用户配置源码路径：DWARF 中的 comp_dir 指向编译时目录，本机可能不存在，
        # 此时 step 命令无法显示 C 源代码，需用 source 命令配置搜索路径或替换规则
        self.context.write("Tip: if 'step' does not show C source, use "
                           "'source PATH' to add source directories, or "
                           "'source substitute FROM TO' to remap the build path.")

class SourceCommand(CommandBase):
    INFO = {
            'names': ['source'],
            'group': 'standard',
            'category': 'symbols',
            'nargs': '*',
            'usage': "[PATH | substitute FROM TO | list | clear]",
            'help': "Manage source file search paths for source-level debugging.",
            'extra_help': "Configures how 'step' locates C/C++ source files when the "
                    "DWARF compilation directory (comp_dir) does not exist on this "
                    "machine, corresponding to GDB's 'directory' and "
                    "'set substitute-path' commands.\n"
                    "Subcommands:\n"
                    "  source PATH                Add PATH to the source search directories.\n"
                    "  source substitute FROM TO  Add a path prefix substitution rule.\n"
                    "  source list               List configured directories and substitutions.\n"
                    "  source clear              Clear all directories and substitutions.",
            }

    def parse(self, args):
        self.args = args

    def execute(self):
        args = self.args
        if len(args) == 0:
            self.context.write("Usage: source [PATH | substitute FROM TO | list | clear]")
            return

        subcmd = args[0]

        if subcmd == 'substitute':
            if len(args) != 3:
                self.context.write("Usage: source substitute FROM TO")
                return
            frm = os.path.normpath(args[1])
            to = os.path.normpath(args[2])
            # 避免重复添加相同规则
            for existing in self.context.source_substitutions:
                if existing[0] == frm and existing[1] == to:
                    self.context.writei("Substitution already exists: %s -> %s", frm, to)
                    return
            self.context.source_substitutions.append((frm, to))
            self.context.writei("Added substitution: %s -> %s", frm, to)

        elif subcmd == 'list':
            dirs = self.context.source_directories
            subs = self.context.source_substitutions
            if not dirs and not subs:
                self.context.write("No source directories or substitutions configured.")
                return
            if dirs:
                self.context.write("Source directories:")
                for d in dirs:
                    self.context.writei("  %s", d)
            if subs:
                self.context.write("Path substitutions:")
                for frm, to in subs:
                    self.context.writei("  %s -> %s", frm, to)

        elif subcmd == 'clear':
            self.context.source_directories = []
            self.context.source_substitutions = []
            self.context.write("Cleared all source directories and substitutions.")

        else:
            # 将第一个参数视为要添加的源码搜索目录
            path = os.path.normpath(os.path.expanduser(args[0]))
            if not os.path.isdir(path):
                self.context.writei("Warning: '%s' is not an existing directory", path)
            if path not in self.context.source_directories:
                self.context.source_directories.append(path)
            self.context.writei("Added source directory: %s", path)

class ContinueCommand(CommandBase):
    INFO = {
            'names': ['continue', 'c', 'go', 'g'],
            'group': 'standard',
            'category': 'core',
            'nargs': 0,
            'usage': "",
            'help': "Resume execution of the target.",
            'extra_help': "The target's state is read back after resuming. If the target is not running, "
                          "then it's state is reported. For instance, if the target is halted immediately "
                          "after resuming, a debug event such as a breakpoint most likely occurred.",
            }

    def execute(self):
        core = self.context.selected_core
        # 如果 PC 正好在断点上，先临时移除断点并 step 一次跳过断点指令，
        # 否则 resume 后 FPB 会立刻匹配当前 PC 导致瞬间 halt。
        # 注意：Cortex-M 停在断点上时读回的 PC 可能带 Thumb 位（bit0=1，奇数），
        # 而断点存的是偶数地址，因此必须先用 & ~1 掩掉 Thumb 位再匹配，
        # 否则 step-over 不触发，resume 后立即重停同一断点，当前指令永远不执行。
        pc = core.read_core_register('pc') & ~1
        bp = core.find_breakpoint(pc)
        if bp is not None:
            core.remove_breakpoint(bp.addr)
            core.bp_manager.flush()
            core.step(disable_interrupts=True)
            core.set_breakpoint(bp.addr, bp.type)
            core.bp_manager.flush()
        core.resume()
        status = core.get_state()
        if status == Target.State.RUNNING:
            self.context.write("Successfully resumed device")
        elif status == Target.State.SLEEPING:
            self.context.write("Device entered sleep")
        elif status == Target.State.LOCKUP:
            self.context.write("Device entered lockup")
        elif status == Target.State.RESET:
            self.context.write("Device is being held in reset")
        elif status == Target.State.HALTED:
            self.context.write("Device is halted; a debug event may have occurred")
        else:
            self.context.writei("Unknown target status: %s", status)

class StepCommand(CommandBase):
    INFO = {
            'names': ['step', 's'],
            'group': 'standard',
            'category': 'core',
            'nargs': [0, 1],
            'usage': "[COUNT]",
            'help': "Step one or more instructions.",
            }

    def parse(self, args):
        if len(args) == 1:
            self.count = self._convert_value(args[0])
        else:
            self.count = 1

    def execute(self):
        if not self.context.selected_core.is_halted():
            self.context.write("Core is not halted; cannot step")
            return

        core = self.context.selected_core
        # 临时移除当前 PC 处的断点，避免 step 后被同一断点重新捕获。
        # 虽然 Cortex-M 的 C_STEP 模式下 FPB 理论上不触发，但某些实现
        # （如通过 J-Link 连接时）可能不完全遵循此规范。
        pc = core.read_core_register('pc') & ~1
        bp = core.find_breakpoint(pc)
        if bp is not None:
            core.remove_breakpoint(bp.addr)
            core.bp_manager.flush()

        for i in range(self.count):
            core.step(disable_interrupts=not self.context.session.options['step_into_interrupt'])
            addr = core.read_core_register('pc')
            if IS_CAPSTONE_AVAILABLE:
                addr &= ~1
                data = self.context.selected_ap.read_memory_block8(addr, 4)
                # 内联反汇编，以便同行附加源码信息
                md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)
                hex_bytes = ''; mnemonic = ''; op_str = ''
                for insn in md.disasm(bytes(bytearray(data)), addr):
                    hex_bytes = ''.join('%02x' % b for b in insn.bytes)
                    mnemonic = insn.mnemonic
                    op_str = insn.op_str
                    break
                # 查找源码行
                src_tag = ''
                if self.context.elf is not None:
                    line_info = self.context.elf.address_decoder.get_line_for_address(addr)
                    if line_info is not None:
                        dirname = line_info.dirname or ''
                        comp_dir = getattr(line_info, 'comp_dir', '') or ''
                        filename = line_info.filename
                        fname = os.path.basename(filename)
                        code = ''
                        # 构建候选路径列表（参考 GDB source path 解析机制）：
                        #   1. dirname 若为绝对路径：直接 dirname + filename
                        #   2. dirname 为相对路径且 comp_dir 存在：comp_dir + dirname + filename
                        #      （ARM Compiler 常见：dirname="boards/xxx/startup", comp_dir="D:\project"）
                        #   3. comp_dir + filename（dirname 为空时的回退）
                        #   4. filename 本身为绝对路径
                        #   5. substitute-path 前缀替换（对应 GDB set substitute-path）
                        #   6. source_directories 按 basename 搜索（对应 GDB directory）
                        candidates = []
                        if os.path.isabs(dirname):
                            candidates.append(os.path.normpath(os.path.join(dirname, filename)))
                        elif dirname and comp_dir:
                            candidates.append(os.path.normpath(os.path.join(comp_dir, dirname, filename)))
                        elif comp_dir:
                            candidates.append(os.path.normpath(os.path.join(comp_dir, filename)))
                        elif dirname:
                            candidates.append(os.path.normpath(os.path.join(dirname, filename)))
                        if os.path.isabs(filename):
                            candidates.append(os.path.normpath(filename))
                        # substitute-path 对所有已有候选做前缀替换
                        existing = list(candidates)
                        for frm, to in self.context.source_substitutions:
                            for p in existing:
                                if p.startswith(frm):
                                    candidates.append(
                                        os.path.normpath(to + p[len(frm):]))
                        for d in self.context.source_directories:
                            candidates.append(os.path.normpath(os.path.join(d, fname)))
                        resolved = None
                        for cand in candidates:
                            if os.path.isfile(cand):
                                resolved = cand
                                break
                        try:
                            if resolved is not None:
                                with open(resolved, 'r', encoding='utf-8', errors='replace') as f:
                                    for _ in range(line_info.line - 1):
                                        next(f, None)
                                    code = next(f, '').rstrip()
                        except (OSError, StopIteration):
                            pass
                        src_tag = f"  {fname}:{line_info.line}  {code}" if code else f"  {fname}:{line_info.line}"
                # 同行输出：反汇编 + 源码
                # args 固定宽度使源码注释始终对齐
                self.context.writef(
                    "{addr:#010x}:* {bytes:<10}{mnemonic:<8}{args:<22}{src}",
                    addr=addr, bytes=hex_bytes, mnemonic=mnemonic,
                    args=op_str, src=src_tag)
            else:
                self.context.writei("PC = 0x%08x", addr)

        # 恢复临时移除的断点
        if bp is not None:
            core.set_breakpoint(bp.addr, bp.type)
            core.bp_manager.flush()

class HaltCommand(CommandBase):
    INFO = {
            'names': ['halt', 'h'],
            'group': 'standard',
            'category': 'core',
            'nargs': 0,
            'usage': "",
            'help': "Halt the target.",
            }

    def execute(self):
        self.context.selected_core.halt()

        status = self.context.selected_core.get_state()
        if status != Target.State.HALTED:
            self.context.writei("Failed to halt device; target state is %s", status.name.capitalize())
            return 1
        else:
            self.context.write("Successfully halted device")

class BreakpointCommand(CommandBase):
    INFO = {
            'names': ['break'],
            'group': 'standard',
            'category': 'breakpoints',
            'nargs': 1,
            'usage': "ADDR",
            'help': "Set a breakpoint address.",
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])

    def execute(self):
        if self.context.selected_core.set_breakpoint(self.addr):
            self.context.selected_core.bp_manager.flush()
            self.context.writei("Set breakpoint at 0x%08x", self.addr)
        else:
            self.context.writei("Failed to set breakpoint at 0x%08x", self.addr)

class RemoveBreakpointCommand(CommandBase):
    INFO = {
            'names': ['rmbreak'],
            'group': 'standard',
            'category': 'breakpoints',
            'nargs': 1,
            'usage': "ADDR",
            'help': "Remove a breakpoint.",
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])

    def execute(self):
        try:
            self.context.selected_core.remove_breakpoint(self.addr)
            self.context.selected_core.bp_manager.flush()
            self.context.writei("Removed breakpoint at 0x%08x", self.addr)
        except Exception:
            self.context.writei("Failed to remove breakpoint at 0x%08x", self.addr)

class ListBreakpointsCommand(CommandBase):
    INFO = {
            'names': ['lsbreak'],
            'group': 'standard',
            'category': 'breakpoints',
            'nargs': 0,
            'usage': "",
            'help': "List breakpoints.",
            }

    def execute(self):
        availableBpCount = self.context.selected_core.available_breakpoint_count
        self.context.writei("%d hardware breakpoints available", availableBpCount)
        bps = self.context.selected_core.bp_manager.get_breakpoints()
        if not len(bps):
            self.context.write("No breakpoints installed")
        else:
            for i, addr in enumerate(bps):
                self.context.writei("%d: 0x%08x", i, addr)

class WatchpointCommand(CommandBase):
    INFO = {
            'names': ['watch'],
            'group': 'standard',
            'category': 'breakpoints',
            'nargs': [1, 2, 3],
            'usage': "ADDR [r|w|rw] [1|2|4]",
            'help': "Set a watchpoint address, and optional access type (default rw) and size (4).",
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])
        if len(args) > 1:
            try:
                self.wptype = WATCHPOINT_FUNCTION_NAME_MAP[args[1]]
            except KeyError:
                raise exceptions.CommandError("unsupported watchpoint type '%s'" % args[1])
        else:
            self.wptype = Target.WatchpointType.READ_WRITE
        if len(args) > 2:
            self.sz = self._convert_value(args[2])
            if self.sz not in (1, 2, 4):
                raise exceptions.CommandError("unsupported watchpoint size (%d)" % self.sz)
        else:
            self.sz = 4

    def execute(self):
        if self.context.selected_core.dwt is None:
            raise exceptions.CommandError("DWT not present")
        if self.context.selected_core.set_watchpoint(self.addr, self.sz, self.wptype):
            self.context.writei("Set watchpoint at 0x%08x", self.addr)
        else:
            self.context.writei("Failed to set watchpoint at 0x%08x", self.addr)

class RemoveWatchpointCommand(CommandBase):
    INFO = {
            'names': ['rmwatch'],
            'group': 'standard',
            'category': 'breakpoints',
            'nargs': [1, 2, 3],
            'usage': "ADDR [r|w|rw] [1|2|4]",
            'help': "Remove watchpoint(s).",
            'extra_help':
                    "Access type and size are optional. All watchpoints matching the specified parameters "
                    "will be removed."
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])
        if len(args) > 1:
            try:
                self.wptype = WATCHPOINT_FUNCTION_NAME_MAP[args[1]]
            except KeyError:
                raise exceptions.CommandError(f"unsupported watchpoint type '{args[1]}'")
        else:
            self.wptype = None
        if len(args) > 2:
            self.sz = self._convert_value(args[2])
            if self.sz not in (1, 2, 4):
                raise exceptions.CommandError(f"unsupported watchpoint size ({self.sz})")
        else:
            self.sz = None

    def execute(self):
        if self.context.selected_core.dwt is None:
            raise exceptions.CommandError("DWT not present")
        try:
            self.context.selected_core.remove_watchpoint(self.addr, self.sz, self.wptype)
            if self.sz is not None:
                wp_desc = f" ({self.sz} bytes"
                if self.wptype is not None:
                    type_name = WATCHPOINT_FUNCTION_NAME_MAP[self.wptype]
                    wp_desc += f", {type_name}"
                wp_desc += ")"
            else:
                wp_desc = ""
            self.context.write(f"Removed watchpoint(s) at {self.addr:#010x}{wp_desc}")
        except Exception:
            self.context.writei("Failed to remove watchpoint at 0x%08x", self.addr)

class ListWatchpointsCommand(CommandBase):
    INFO = {
            'names': ['lswatch'],
            'group': 'standard',
            'category': 'breakpoints',
            'nargs': 0,
            'usage': "",
            'help': "List watchpoints.",
            }

    def execute(self):
        if self.context.selected_core.dwt is None:
            raise exceptions.CommandError("DWT not present")
        availableWpCount = self.context.selected_core.dwt.watchpoint_count
        self.context.writei("%d hardware watchpoints available", availableWpCount)
        wps = self.context.selected_core.dwt.get_watchpoints()
        if not len(wps):
            self.context.write("No watchpoints installed")
        else:
            for i, wp in enumerate(wps):
                # TODO fix requirement to access WATCH_TYPE_TO_FUNCT
                self.context.writei("%d: 0x%08x, %d bytes, %s",
                    i, wp.addr, wp.size,
                    WATCHPOINT_FUNCTION_NAME_MAP[self.context.selected_core.dwt.WATCH_TYPE_TO_FUNCT[wp.func]])

class SelectCoreCommand(CommandBase):
    INFO = {
            'names': ['core'],
            'group': 'standard',
            'category': 'core',
            'nargs': [0, 1],
            'usage': "[NUMBER | NAME]",
            'help': "Select CPU core by number or name, or print selected core.",
            }

    def parse(self, args):
        if len(args) == 0:
            self.show_core = True
            self.core_num = None
        else:
            self.show_core = False

            # Attempt to parse the core ID as an int.
            try:
                self.core_num = int(args[0], base=0)
            except ValueError:
                # Try to look up the argument as a core name (case-insensitive).
                core = self._find_core_by_name(args[0])
                self.core_num = core.core_number

    def _find_core_by_name(self, name: str) -> CoreTarget:
        assert self.context.session.target
        for core in self.context.session.target.cores.values():
            if core.node_name is None:
                continue
            if core.node_name.casefold() == name.casefold():
                return core
        else:
            raise exceptions.CommandError(f"no core matching name '{name}'")

    def execute(self):
        assert self.context.selected_core
        assert self.context.session.target
        if self.show_core:
            self.context.write(f"Core {self.context.selected_core.core_number} "
                                f"({self.context.selected_core.node_name}) is selected")
            return
        self.context.selected_core = self.context.session.target.cores[self.core_num]
        core_ap = self.context.selected_core.ap
        self.context.selected_ap_address = core_ap.address
        self.context.write(f"Selected core {self.core_num} ({self.context.selected_core.node_name}) ({core_ap.short_description})")

class ReadDpCommand(CommandBase):
    INFO = {
            'names': ['readdp', 'rdp'],
            'group': 'standard',
            'category': 'dap',
            'nargs': 1,
            'usage': "ADDR",
            'help': "Read DP register.",
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])

    def execute(self):
        result = self.context.target.dp.read_reg(self.addr)
        self.context.writei("DP register 0x%x = 0x%08x", self.addr, result)

class WriteDpCommand(CommandBase):
    INFO = {
            'names': ['writedp', 'wdp'],
            'group': 'standard',
            'category': 'dap',
            'nargs': 2,
            'usage': "ADDR DATA",
            'help': "Write DP register.",
            }

    def parse(self, args):
        self.addr = self._convert_value(args[0])
        self.data = self._convert_value(args[1])

    def execute(self):
        self.context.target.dp.write_reg(self.addr, self.data)
        self.context.target.flush()

class ReadApCommand(CommandBase):
    INFO = {
            'names': ['readap', 'rap'],
            'group': 'standard',
            'category': 'dap',
            'nargs': [1, 2],
            'usage': "[APSEL] ADDR",
            'help': "Read AP register.",
            }
    # TODO support ADIv6 AP addresses
    def parse(self, args):
        if len(args) == 1:
            self.addr = self._convert_value(args[0])
        elif len(args) == 2:
            self.addr = (self._convert_value(args[0]) << 24) | self._convert_value(args[1])

    def execute(self):
        result = self.context.target.dp.read_ap(self.addr)
        self.context.writei("AP register 0x%x = 0x%08x", self.addr, result)

class WriteApCommand(CommandBase):
    INFO = {
            'names': ['writeap', 'wap'],
            'group': 'standard',
            'category': 'dap',
            'nargs': [2, 3],
            'usage': "[APSEL] ADDR DATA",
            'help': "Write AP register.",
            }
    # TODO support ADIv6 AP addresses
    def parse(self, args):
        if len(args) == 2:
            self.addr = self._convert_value(args[0])
            data_arg = 1
        elif len(args) == 3:
            self.addr = (self._convert_value(args[0]) << 24) | self._convert_value(args[1])
            data_arg = 2
        self.data = self._convert_value(args[data_arg])

    def execute(self):
        self.context.target.dp.write_ap(self.addr, self.data)
        self.context.target.flush()

class InitDpCommand(CommandBase):
    INFO = {
            'names': ['initdp'],
            'group': 'commander',
            'category': 'bringup',
            'nargs': 0,
            'usage': "",
            'help': "Init DP and power up debug.",
            }

    def execute(self):
        self.context.target.dp.connect()

class MakeApCommand(CommandBase):
    INFO = {
            'names': ['makeap'],
            'group': 'commander',
            'category': 'bringup',
            'nargs': 1,
            'usage': "APSEL",
            'help': "Creates a new AP object for the given APSEL.",
            'extra_help': "The type of AP, MEM-AP or generic, is autodetected.",
            }
    # TODO support ADIv6 AP addresses
    def parse(self, args):
        self.apsel = self._convert_value(args[0])
        self.ap_addr = coresight.ap.APv1Address(self.apsel)

    def execute(self):
        if self.ap_addr in self.context.target.aps:
            self.context.writei("AP with APSEL=%d already exists", self.apsel)
            return
        exists = coresight.ap.AccessPort.probe(self.context.target.dp, self.apsel)
        if not exists:
            self.context.writef("Error: no AP with APSEL={} exists", self.apsel)
            return
        ap = coresight.ap.AccessPort.create(self.context.target.dp, self.ap_addr)
        self.context.target.dp.aps[self.ap_addr] = ap # Same mutable dict as target.aps
        self.context.writef("AP#{:d} IDR = {:#010x}", self.apsel, ap.idr)

class FlushProbeCommand(CommandBase):
    INFO = {
            'names': ['flushprobe'],
            'group': 'commander',
            'category': 'probe',
            'nargs': 0,
            'usage': "",
            'help': "Ensure all debug probe requests have been completed.",
            }

    def execute(self):
        self.context.probe.flush()

class ReinitCommand(CommandBase):
    INFO = {
            'names': ['reinit'],
            'group': 'commander',
            'category': 'bringup',
            'nargs': 0,
            'usage': "",
            'help': "Reinitialize the target object.",
            }

    def execute(self):
        self.context.target.init()
        self.context.set_context_defaults()

class WhereCommand(CommandBase):
    INFO = {
            'names': ['where'],
            'group': 'standard',
            'category': 'symbols',
            'nargs': [0, 1],
            'usage': "[ADDR]",
            'help': "Show symbol, file, and line for address.",
            'extra_help': "The symbol name, source file path, and line number are displayed for the specified address. If no address is given then current PC is used. An ELF file must have been specified with the --elf option.",
            }

    def parse(self, args):
        if len(args) >= 1:
            self.addr = self._convert_value(args[0])
        else:
            self.addr = self.context.selected_core.read_core_register('pc')
        self.addr &= ~0x1 # remove thumb bit

    def execute(self):
        if self.context.elf is None:
            self.context.write("No ELF available")
            return

        lineInfo = self.context.elf.address_decoder.get_line_for_address(self.addr)
        if lineInfo is not None:
            path = os.path.join(lineInfo.dirname, lineInfo.filename) if isinstance(lineInfo.filename, str) else os.path.join(lineInfo.dirname, lineInfo.filename).decode()
            line = lineInfo.line
            pathline = "{}:{}".format(path, line)
        else:
            pathline = "<unknown file>"

        fnInfo = self.context.elf.address_decoder.get_function_for_address(self.addr)
        if fnInfo is not None:
            name = fnInfo.name.decode()
            offset = self.addr - fnInfo.low_pc
        else:
            name = "<unknown symbol>"
            offset = 0

        self.context.writef("{addr:#10x} : {fn}+{offset} : {pathline}",
                addr=self.addr, fn=name, offset=offset, pathline=pathline)

class SymbolCommand(CommandBase):
    INFO = {
            'names': ['symbol'],
            'group': 'standard',
            'category': 'symbols',
            'nargs': 1,
            'usage': "NAME",
            'help': "Show a symbol's value.",
            'extra_help': "An ELF file must have been specified with the --elf option.",
            }

    def parse(self, args):
        self.name = args[0]

    def execute(self):
        if self.context.elf is None:
            self.context.write("No ELF available")
            return

        sym = self.context.elf.symbol_decoder.get_symbol_for_name(self.name)
        if sym is not None:
            if sym.type == 'STT_FUNC':
                self.name += "()"
            self.context.writef("{name}: {addr:#10x} {sz:#x}", name=self.name, addr=sym.address, sz=sym.size)
        else:
            self.context.writef("No symbol named '{}' was found", self.name)

class GdbserverCommand(CommandBase):
    INFO = {
            'names': ['gdbserver'],
            'group': 'standard',
            'category': 'servers',
            'nargs': 1,
            'usage': "{start,stop,status}",
            'help': "Control the gdbserver for the selected core.",
            'extra_help': "The action argument should be either 'start', 'stop', or 'status'. Use the "
                          "'gdbserver_port' and 'telnet_port' session options to control the ports the "
                          "gdbserver uses.",
            }

    def parse(self, args):
        self.action = args[0].lower()
        if self.action not in ('start', 'stop', 'status'):
            raise exceptions.CommandError("invalid action")

    def execute(self):
        core_number = self.context.selected_core.core_number
        if self.action == 'start':
            if core_number not in self.context.session.gdbservers:
                # Persist the gdbserver
                self.context.session.options['persist'] = True
                server = GDBServer(self.context.session, core=core_number)
                self.context.session.gdbservers[core_number] = server
                server.start()
            else:
                self.context.writef("gdbserver for core {0} is already running", core_number)
        elif self.action == 'stop':
            if self.context.session.gdbservers[core_number] is not None:
                server = self.context.session.gdbservers[core_number]
                del self.context.session.gdbservers[core_number]

                # Stop the server and wait for it to terminate.
                server.stop()
                while server.is_alive():
                    sleep(0.1)
            else:
                self.context.writef("gdbserver for core {0} is not running", core_number)
        elif self.action == 'status':
            if core_number in self.context.session.gdbservers:
                self.context.writef("gdbserver for core {0} is running", core_number)
            else:
                self.context.writef("gdbserver for core {0} is not running", core_number)

class ProbeserverCommand(CommandBase):
    INFO = {
            'names': ['probeserver'],
            'group': 'standard',
            'category': 'servers',
            'nargs': 1,
            'usage': "{start,stop,status}",
            'help': "Control the debug probe server.",
            'extra_help': "The action argument should be either 'start', 'stop', or 'status. Use the "
                "'probeserver.port' option to control the TCP port the server uses.",
            }

    def parse(self, args):
        self.action = args[0].lower()
        if self.action not in ('start', 'stop', 'status'):
            raise exceptions.CommandError("invalid action")

    def execute(self):
        if self.action == 'start':
            if self.context.session.probeserver is None:
                self.context.session.probeserver = DebugProbeServer(self.context.session, self.context.probe)
                self.context.session.probeserver.start()
            else:
                self.context.write("probe server is already running")
        elif self.action == 'stop':
            if self.context.session.probeserver is not None:
                self.context.session.probeserver.stop()
                self.context.session.probeserver = None
            else:
                self.context.write("probe server is not running")
        elif self.action == 'status':
            if self.context.session.probeserver is not None:
                self.context.write("probe server is running")
            else:
                self.context.write("probe server is not running")

class SleepCommand(CommandBase):
    INFO = {
            'names': ['sleep'],
            'group': 'standard',
            'category': 'utility',
            'nargs': 1,
            'usage': "MILLISECONDS",
            'help': "Sleep for a number of milliseconds before continuing.",
            }

    def parse(self, args):
        self.delay_secs = self._convert_value(args[0]) / 1000.0

    def execute(self):
        time.sleep(self.delay_secs)

class ShowCommand(CommandBase):
    INFO = {
            'names': ['show'],
            'group': 'standard',
            'category': 'values',
            'nargs': '*',
            'usage': "NAME",
            'help': "Display a value.",
            }

    def parse(self, args):
        if len(args) < 1:
            raise exceptions.CommandError("missing value name argument")
        self.name = args[0]
        self.args = args[1:]

    def execute(self):
        # Look up value class by name.
        try:
            value_class = self.context.command_set.values[self.name]
        except KeyError:
            raise exceptions.CommandError("unknown value name '%s'" % self.name)

        # Check readability.
        if 'r' not in value_class.INFO['access']:
            raise exceptions.CommandError("value '%s' is not readable" % self.name)

        # Execute show operation.
        value_object = value_class(self.context)
        value_object.display(self.args)

    @classmethod
    def format_help(cls, context, max_width=72):
        text = "Usage: {cmd} {usage}\n".format(cmd=cls.INFO['names'][0], usage=cls.INFO['usage'])
        if len(cls.INFO['names']) > 1:
            text += "Aliases: {0}\n".format(", ".join(cls.INFO['names'][1:]))
        text += "\n" + textwrap.fill(cls.INFO['help'], width=max_width) + "\n"
        if 'extra_help' in cls.INFO:
            text += "\n" + textwrap.fill(cls.INFO['extra_help'], width=max_width) + "\n"
        text += "\nReadable values:\n"
        readable_classes = sorted([klass for klass in context.command_set.value_classes
                            if 'r' in klass.INFO['access']], key=lambda k: k.INFO['names'][0])
        for klass in readable_classes:
            text += "- {0}: {1}\n".format(klass.INFO['names'][0], klass.INFO['help'])
        return text

class SetCommand(CommandBase):
    INFO = {
            'names': ['set'],
            'group': 'standard',
            'category': 'values',
            'nargs': '*',
            'usage': "NAME VALUE",
            'help': "Set a value.",
            }

    def parse(self, args):
        if len(args) < 1:
            raise exceptions.CommandError("missing value name argument")
        self.name = args[0]
        self.args = args[1:]

    def execute(self):
        # Look up value class by name.
        try:
            value_class = self.context.command_set.values[self.name]
        except KeyError:
            raise exceptions.CommandError("unknown value name '%s'" % self.name)

        # Check writability.
        if 'w' not in value_class.INFO['access']:
            raise exceptions.CommandError("value '%s' is not modifiable" % self.name)

        # Execute set operation.
        value_object = value_class(self.context)
        value_object.modify(self.args)

    @classmethod
    def format_help(cls, context, max_width=72):
        text = "Usage: {cmd} {usage}\n".format(cmd=cls.INFO['names'][0], usage=cls.INFO['usage'])
        if len(cls.INFO['names']) > 1:
            text += "Aliases: {0}\n".format(", ".join(cls.INFO['names'][1:]))
        text += "\n" + textwrap.fill(cls.INFO['help'], width=max_width) + "\n"
        if 'extra_help' in cls.INFO:
            text += "\n" + textwrap.fill(cls.INFO['extra_help'], width=max_width) + "\n"
        text += "\nWritable values:\n"
        writable_classes = sorted([klass for klass in context.command_set.value_classes
                            if 'w' in klass.INFO['access']], key=lambda k: k.INFO['names'][0])
        for klass in writable_classes:
            text += "- {0}: {1}\n".format(klass.INFO['names'][0], klass.INFO['help'])
        return text

class HelpCommand(CommandBase):
    INFO = {
            'names': ['help', '?'],
            'group': 'standard',
            'category': 'general',
            'nargs': '*',
            'usage': "[CMD]",
            'help': "Show help for commands.",
            }

    HELP_ADDENDUM = """
Any integer argument will accept a register name.
Prefix line with $ to execute a Python expression.
Prefix line with ! to execute a shell command."""

    def parse(self, args):
        self.args = args
        self.term_width = get_terminal_size()[0]

    def execute(self):
        if not self.args:
            self._list_commands("Commands", self.context.command_set.command_classes, "{cmd:<25} {usage:<20} {help}")
            self.context.write(self.HELP_ADDENDUM)
            self.context.write()
            self._list_commands("Values", self.context.command_set.value_classes, "{cmd:<25} {access:<10} {help}")
        else:
            # Look up primary command.
            cmd_name = self.args[0].lower()
            matched_commands = self.context.command_set.command_matcher.find_all(cmd_name)
            if len(matched_commands) > 1:
                self.context.writei("Command '%s' is ambiguous; matches are %s", cmd_name,
                        ", ".join("'%s'" % c for c in matched_commands))
                return
            elif len(matched_commands) == 0:
                raise exceptions.CommandError("Error: unrecognized command '%s'" % cmd_name)
            cmd_name = matched_commands[0]
            cmd_class = self.context.command_set.commands[cmd_name]

            # Handle these commands specially to support help on values.
            if cmd_name in ("show", "set"):
                try:
                    value_name = self.args[1].lower()
                    matched_values = self.context.command_set.value_matcher.find_all(value_name)
                    if len(matched_values) > 1:
                        self.context.writei("Value name '%s' is ambiguous; matches are %s", value_name,
                                ", ".join("'%s'" % c for c in matched_values))
                        return
                    elif len(matched_values) == 0:
                        raise exceptions.CommandError("Error: unrecognized value '%s'" % value_name)
                    value_name = matched_values[0]
                    cmd_class = self.context.command_set.values[value_name]
                    self.context.write(cmd_class.format_help(self.context, self.term_width))
                    return
                except IndexError:
                    pass

            self.context.write(cmd_class.format_help(self.context, self.term_width))

    def _list_commands(self, title, command_list, help_format):
        cmds = {}
        nominal_cmds = []

        for klass in command_list:
            cmd_name = klass.INFO['names'][0]
            cmds[cmd_name] = klass
            nominal_cmds.append(cmd_name)
        nominal_cmds.sort()

        self.context.write(title + ":\n" + ("-" * len(title)))
        for cmd_name in nominal_cmds:
            cmd_klass = cmds[cmd_name]
            info = cmd_klass.INFO
            aliases = ', '.join(sorted(info['names']))
            self.context.writef(help_format, cmd=aliases, **info)

def print_disasm(context, code, start_addr, max_instructions=None):
    if not IS_CAPSTONE_AVAILABLE:
        raise exceptions.CommandError("Disassembly is not available because the Capstone library is not installed. "
              "To install Capstone, run 'pip install capstone'.")

    if context.target.is_halted():
        pc = context.target.read_core_register('pc') & ~1
    else:
        pc = -1
    md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)

    text = ''
    n = 0
    for i in md.disasm(code, start_addr):
        hexBytes = ''
        for b in i.bytes:
            hexBytes += '%02x' % b
        pc_marker = '*' if (pc == i.address) else ' '
        text += "{addr:#010x}:{pc_marker} {bytes:<10}{mnemonic:<8}{args}\n".format(
                addr=i.address, pc_marker=pc_marker, bytes=hexBytes, mnemonic=i.mnemonic, args=i.op_str)
        n += 1
        if (max_instructions is not None) and (n >= max_instructions):
            break

    context.write(text)
