# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = [('D:\\workspace\\embedded\\omni-work\\python\\data', 'data'), ('D:\\workspace\\embedded\\omni-work\\python\\flm', 'flm')]
binaries = []
hiddenimports = ['uvicorn.logging', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.http.h11_impl', 'uvicorn.protocols.websockets.auto', 'uvicorn.protocols.websockets.websockets_impl', 'uvicorn.lifespan.on', 'uvicorn.lifespan.off', 'pyocd.probe.cmsis_dap_probe', 'pyocd.probe.stlink_probe', 'pyocd.probe.jlink_probe', 'pyocd.probe.picoprobe', 'pyocd.probe.pydapaccess.dap_access_cmsis_dap', 'pyocd.probe.pydapaccess.interface.pyusb_backend', 'pyocd.probe.pydapaccess.interface.pyusb_v2_backend', 'pyocd.probe.pydapaccess.interface.hidapi_backend', 'pyocd.probe.pydapaccess.interface.pywinusb_backend', 'usb', 'usb.backend.libusb1', 'usb.backend.libusb0', 'usb.backend.openusb', 'libusb_package', 'hid', 'pyocd.target.builtin', 'pyocd.target.family', 'pyocd.core.helpers', 'pyocd.core.session', 'pyocd.core.soc_target', 'pyocd.core.memory_map', 'pyocd.flash.loader', 'pyocd.flash.eraser', 'pyocd.flash.file_programmer', 'pyocd.debug.elf.elf_reader', 'pyocd.debug.svd.loader', 'api.probes', 'api.flash', 'api.targets', 'api.files', 'api.devices', 'api.commander', 'api.rtt', 'api.monitor', 'api.tools', 'core.pyocd_backend', 'core.events', 'core.probe_monitor', 'core.interface', 'core.rtt_backend', 'core.commander_backend', 'core.monitor_backend', 'core.database', 'core.map_parser', 'core.command_examples', 'elftools.elf.elffile', 'elftools.elf.sections', 'elftools.dwarf.dwarfinfo']
tmp_ret = collect_all('pyocd')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('cmsis_pack_manager')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('libusb_package')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['D:\\workspace\\embedded\\omni-work\\python\\server.py'],
    pathex=['D:\\workspace\\embedded\\omni-work\\python'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='omni-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='omni-backend',
)
