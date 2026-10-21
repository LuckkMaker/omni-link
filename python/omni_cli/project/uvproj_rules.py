"""Keil uvprojx 同步规则表。

由 omni-emb 的 ``omni/scripts/uvproj_sync.py`` 移植。``base_path`` / ``include_paths``
使用相对 omni 仓库根目录（``omni_root`` 的父目录）的路径，写 XML 时再按
``.uvprojx`` 所在目录计算相对路径，避免旧脚本硬编码 ``..\\..\\..\\omni`` 的深度假设。
"""

SOURCE_RULE_SETS = [
    {
        "symbol": "CONFIG_ARCH_CORTEX_M",
        "group": "omni/arch/arm",
        "base_path": "omni/arch/arm/core/cortex_m/src",
        "files": [
            "timing.c",
            "timebase.c",
        ],
    },
    {
        "symbol": "CONFIG_COREMARK",
        "group": "module/coremark",
        "base_path": "modules/coremark",
        "include_paths": ["modules/coremark"],
        "files": [
            "core_list_join.c",
            "core_main.c",
            "core_matrix.c",
            "core_state.c",
            "core_util.c",
        ],
    },
    {
        "symbol": "CONFIG_DAP",
        "group": "omni/subsys",
        "base_path": "omni/subsys/dap",
        "files": ["dap.c", "sw_dp.c", "jtag_dp.c"],
    },
    {
        "symbol": "CONFIG_FILE_SYSTEM",
        "group": "omni/subsys",
        "base_path": "omni/subsys/fs",
        "files": ["fs.c"],
    },
    {
        "symbol": "CONFIG_FS_LITTLEFS",
        "group": "omni/subsys",
        "base_path": "omni/subsys/fs",
        "files": ["littlefs_arch.c"],
    },
    {
        "symbol": "CONFIG_FS_LITTLEFS",
        "group": "module/littlefs",
        "base_path": "modules/littlefs",
        "include_paths": ["modules/littlefs"],
        "defines": ["LFS_DEFINES=omni/fs/lfs_defines.h"],
        "files": ["lfs.c", "lfs_util.c"],
    },
    {
        "symbol": "CONFIG_FS_FATFS",
        "group": "omni/subsys",
        "base_path": "omni/subsys/fs",
        "files": ["fatfs_arch.c"],
    },
    {
        "symbol": "CONFIG_IAP",
        "group": "omni/subsys",
        "base_path": "omni/subsys/iap",
        "files": ["iap.c"],
    },
    {
        "symbol": "CONFIG_LOG",
        "group": "omni/subsys",
        "base_path": "omni/subsys/log",
        "files": ["log.c"],
    },
    {
        "symbol": "CONFIG_LOG_BACKEND_RTT",
        "group": "omni/subsys",
        "base_path": "omni/subsys/log",
        "files": ["log_backend_rtt.c"],
    },
    {
        "symbol": "CONFIG_MODBUS_STACK",
        "group": "omni/subsys",
        "base_path": "omni/subsys/modbus",
        "files": ["modbus_core.c"],
    },
    {
        "symbol": "CONFIG_MODBUS_CLIENT",
        "group": "omni/subsys",
        "base_path": "omni/subsys/modbus",
        "files": ["modbus_client.c"],
    },
    {
        "symbol": "CONFIG_MODBUS_SERVER",
        "group": "omni/subsys",
        "base_path": "omni/subsys/modbus",
        "files": ["modbus_server.c"],
    },
    {
        "symbol": "CONFIG_SHELL",
        "group": "omni/subsys",
        "base_path": "omni/subsys/shell",
        "files": ["shell.c"],
    },
    {
        "symbol": "CONFIG_SHELL_LOG_BACKEND",
        "group": "omni/subsys",
        "base_path": "omni/subsys/shell",
        "files": ["shell_log_backend.c"],
    },
    {
        "symbol": "CONFIG_SEGGER_RTT",
        "group": "omni/subsys",
        "base_path": "omni/subsys/rtt",
        "files": ["rtt.c", "SEGGER_RTT.c", "SEGGER_RTT_printf.c"],
    },
    {
        "symbol": "CONFIG_TIMING",
        "group": "omni/subsys",
        "base_path": "omni/subsys/timing",
        "files": ["timing.c"],
    },
    {
        "symbol": "CONFIG_USB_DEVICE_STACK",
        "group": "omni/subsys",
        "base_path": "omni/subsys/usb/device",
        "files": ["usbd_core.c"],
    },
    {
        "symbol": "CONFIG_USBD_CDC_ACM",
        "group": "omni/subsys",
        "base_path": "omni/subsys/usb/device/class/cdc",
        "files": ["usbd_cdc_acm.c"],
    },
    {
        "symbol": "CONFIG_USBD_DFU",
        "group": "omni/subsys",
        "base_path": "omni/subsys/usb/device/class/dfu",
        "files": ["usbd_dfu.c"],
    },
    {
        "symbol": "CONFIG_USBD_HID",
        "group": "omni/subsys",
        "base_path": "omni/subsys/usb/device/class/hid",
        "files": ["usbd_hid.c"],
    },
    {
        "symbol": "CONFIG_USBD_MSC",
        "group": "omni/subsys",
        "base_path": "omni/subsys/usb/device/class/msc",
        "files": ["usbd_msc.c"],
    },
    {
        "symbol": "CONFIG_USBD_PRINTER",
        "group": "omni/subsys",
        "base_path": "omni/subsys/usb/device/class/printer",
        "files": ["usbd_printer.c"],
    },
    {
        "symbol": "CONFIG_USBD_VENDOR",
        "group": "omni/subsys",
        "base_path": "omni/subsys/usb/device/class/vendor",
        "files": ["usbd_vendor.c"],
    },
    {
        "symbol": "CONFIG_VFS",
        "group": "omni/subsys",
        "base_path": "omni/subsys/vfs",
        "files": ["vfs.c"],
    },
]
