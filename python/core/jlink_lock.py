# OMNI Link
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""J-Link DLL 全局串行化（线程安全保护）。

## 背景

SEGGER 的 ``JLink_x64.dll`` / ``JLinkARM.dll`` **不是线程安全的**：同一进程内多个
线程同时调用它，会破坏 DLL 内部状态，表现为原生访问违例。CPython 的 ctypes 会把
Windows SEH 访问违例转换成 ``OSError``，因此前端看到的是：

    仿真器连接失败（852001270）：exception: access violation reading 0xFFFFFEFC3B296180

（``exception: access violation ...`` 这段文本来自 ctypes，不是应用自己拼的。）

本应用天然存在多个线程同时访问该 DLL 的路径：

* ``core/probe_monitor.py``：后台守护线程**每 2 秒**枚举一次探针
  （``pyocd`` → ``pylink.JLink.connected_emulators()``）；
* ``api/probes.py`` 的 ``/probes/{uid}/connect``：在 ``asyncio.to_thread`` 线程池里
  执行 ``open()`` / ``connect()``；
* ``api/probes.py::_get_jlink_devices``：一次性调用 ``JLINKARM_DEVICE_GetInfo``
  ~9800 次（打开连接配置对话框时预取设备库）。

三者时间上重叠时就会偶发访问违例 —— 这也是「以前都可以、现在突然不行」的原因
（竞态，取决于时序）。更麻烦的是：一旦在 DLL 内部炸掉，探针的 USB 端点常被卡死，
之后所有 ``open()`` 都会失败（``Cannot connect to J-Link``），断电/重启应用都无效，
必须用 SEGGER 自己的工具（JLink.exe 等）重新打开一次才能恢复。

## 做法

提供进程级可重入锁 ``JLINK_DLL_LOCK``，并通过 :func:`install_pylink_lock` 给
``pylink.JLink`` 的所有公开方法自动加锁（``__init__`` 里也会调用 DLL，需一并加锁）。
应用与 pyOCD 对 DLL 的访问全部经由 ``pylink.JLink``，因此一处安装即可全覆盖。
"""

import functools
import threading

#: 进程内所有 J-Link DLL 调用的串行化锁（可重入，便于嵌套调用）。
JLINK_DLL_LOCK = threading.RLock()

_INSTALLED = False


def _wrap(func):
    """把函数包成「持有 JLINK_DLL_LOCK 再执行」。"""
    if getattr(func, "_omni_jlink_locked", False):
        return func

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        with JLINK_DLL_LOCK:
            return func(*args, **kwargs)

    wrapper._omni_jlink_locked = True  # type: ignore[attr-defined]
    return wrapper


def install_pylink_lock() -> bool:
    """给 ``pylink.JLink`` 的所有公开方法加锁（幂等）。

    Returns:
        ``True`` 表示已安装（或此前已安装），``False`` 表示 pylink 不可用。
    """
    global _INSTALLED
    if _INSTALLED:
        return True

    try:
        import pylink
    except Exception:  # noqa: BLE001
        return False

    cls = pylink.JLink
    # 只处理 JLink 自己定义的属性；跳过 property/staticmethod/classmethod 等描述符，
    # 避免替换后破坏绑定语义。_ 开头的方法里只有 __init__ 会调用 DLL。
    for name, attr in list(vars(cls).items()):
        if name.startswith("_") and name != "__init__":
            continue
        if isinstance(attr, (staticmethod, classmethod, property)):
            continue
        if not callable(attr):
            continue
        setattr(cls, name, _wrap(attr))

    _INSTALLED = True
    return True


