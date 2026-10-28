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

## 锁等待上限（2026-10 新增）

``JLINKARM_*`` 是原生阻塞调用，Python 侧无法取消。一旦某次 ``open()`` / 读内存在
DLL 里卡住，它会**永久**持有 ``JLINK_DLL_LOCK``；旧实现用 ``with`` 无限等待，后续
每个线程都排在这把锁上，连关闭/断开也一起卡死，最终把 asyncio 默认线程池耗尽，
表现为「整个应用没响应、再也连不上」（实机报告：多次连接/断开 J-Link 后复现）。

现在所有加锁都带等待上限：拿不到锁就抛 :class:`JLinkDllBusy`（明确可读的错误），
而不是无限排队；同时在超时后进入短暂冷却期，让后续调用立即失败，避免每次调用都
再等一遍超时。卡死的那个原生调用仍在后台（无法强杀），但应用其余部分保持可用，
用户按提示重启后端/重插探针即可恢复。

## 回调 hub（2026-10 新增）

``pylink.JLink`` 会把每个实例的 log/error/warn 回调注册到 DLL 的**全局**函数指针上，
而 trampoline 的生命周期绑在实例上。实例被回收后 DLL 仍指向已释放内存，下一次
DLL 输出日志就会跳进野指针（``0xc0000005`` / ``0xc000001d``），并且进程内无法恢复
（拔插 USB 无效）。本应用每次探针枚举/连接都会创建并丢弃多个 ``pylink.JLink``，
因此连续连接/断开几次后必崩（实测第 6 次）。

:func:`install_pylink_callback_hub` 把回调原型替换成进程内唯一、永久持有的
trampoline，`install_pylink_lock` 会先安装它。详见 :class:`_CallbackHub`。
"""

import functools
import threading
import time

#: 进程内所有 J-Link DLL 调用的串行化锁（可重入，便于嵌套调用）。
JLINK_DLL_LOCK = threading.RLock()

#: 单次等待 DLL 锁的上限（秒）。正常调用都在毫秒级；超过它基本可以判定
#: 「上一次 DLL 调用没有返回」，继续等只会拖死更多线程。
DLL_LOCK_TIMEOUT = 5.0

#: 一次锁等待超时后，接下来这段时间内的 DLL 调用直接失败（秒），
#: 避免每个调用都先等满 DLL_LOCK_TIMEOUT 才报错。
DLL_STUCK_COOLDOWN = 15.0

_INSTALLED = False
_CALLBACK_HUB_INSTALLED = False
_stuck_until = 0.0
_stuck_guard = threading.Lock()


class JLinkDllBusy(RuntimeError):
    """J-Link DLL 正被一个长时间未返回的调用占用。

    这不是「探针离线」：探针可能仍在，只是 DLL 调用卡死了。恢复方式通常是
    重启后端（``omni backend stop`` 后重启）或重新插拔探针。
    """


def _dll_stuck_error() -> JLinkDllBusy:
    return JLinkDllBusy(
        f"J-Link DLL 无响应（上一次调用超过 {DLL_LOCK_TIMEOUT:.0f}s 未返回）。"
        "请重启后端（omni backend stop）或重新插拔探针后重试。")


def acquire_dll_lock(timeout: float | None = None) -> None:
    """获取 J-Link DLL 锁，超时抛 :class:`JLinkDllBusy`（可重入）。"""
    global _stuck_until
    wait = DLL_LOCK_TIMEOUT if timeout is None else float(timeout)
    now = time.monotonic()
    with _stuck_guard:
        stuck_for = _stuck_until - now
    if stuck_for > 0:
        raise _dll_stuck_error()
    if JLINK_DLL_LOCK.acquire(timeout=max(0.0, wait)):
        return
    with _stuck_guard:
        _stuck_until = time.monotonic() + DLL_STUCK_COOLDOWN
    raise _dll_stuck_error()


def release_dll_lock() -> None:
    try:
        JLINK_DLL_LOCK.release()
    except RuntimeError:
        pass


def reset_dll_stuck_state() -> None:
    """清除「DLL 卡死」冷却标记（仅诊断/测试或后端打算重试时使用）。"""
    global _stuck_until
    with _stuck_guard:
        _stuck_until = 0.0


def dll_lock_stuck() -> bool:
    """当前是否处于「DLL 卡死」冷却期（供状态接口/诊断使用）。"""
    with _stuck_guard:
        return time.monotonic() < _stuck_until


class _CallbackHub:
    """把 pylink 注册到 DLL 的**全局**回调换成进程内唯一的 trampoline。

    ## 为什么必须这么做（实机 0xc000001d）

    ``pylink.JLink.__init__`` 会为每个实例创建 4 个 ``ctypes.CFUNCTYPE`` 回调，并
    通过 ``JLINKARM_EnableLog`` / ``EnableLogCom`` / ``SetErrorOutHandler`` /
    ``SetWarnOutHandler`` 注册到 **JLinkARM.dll 的全局函数指针**上。但这些 trampoline
    的生命周期绑在 Python 实例上：实例被回收后，DLL 里仍然留着指向已释放内存的
    指针。下一次 DLL 输出日志/错误时就会跳进野指针，ctypes 把原生异常翻译成：

        OSError: [WinError -1073741795] Windows Error 0xc000001d   (privileged/illegal instruction)

    之后就永久坏掉——拔插 USB 也没用，因为坏的是进程内 DLL 的状态，只能重启后端。

    本应用每次枚举/连接都会创建并丢弃多个 ``pylink.JLink``（pyOCD 的探针聚合器
    每 2s 枚举一次就会建 2 个），所以"连续连接/断开几次后必崩"。

    ## 做法

    把 ``JLinkFunctions.LOG_PROTOTYPE`` 换成本对象：所有实例拿到的都是同一个
    永久持有的 CFUNCTYPE，DLL 指针永远有效；真正要调用的 Python handler 存在
    ``_handler`` 里，构造新实例时替换（日志/错误回调互相通用，行为不变）。
    这样每个进程只多一个 trampoline，不会随枚举次数增长。
    """

    def __init__(self, proto, default_result=None):
        self._proto = proto
        self._default_result = default_result
        self._handler = None
        self._handler_lock = threading.Lock()
        self._callback = proto(self._dispatch)  # 永久持有，DLL 指针不会悬垂

        # 兼容把 LOG_PROTOTYPE 当类型用的代码（当前 pylink 只把它当工厂调用）
        self.argtypes = getattr(proto, "argtypes", None)
        self.restype = getattr(proto, "restype", None)

    def _dispatch(self, *args):
        handler = self._handler
        if handler is None:
            return self._default_result
        try:
            return handler(*args)
        except Exception:  # noqa: BLE001 - 回调在 DLL 线程里，绝不能把异常抛回去
            return self._default_result

    def __call__(self, handler):
        with self._handler_lock:
            self._handler = handler
        return self._callback


def install_pylink_callback_hub() -> bool:
    """把 pylink 的全局 DLL 回调替换为进程内唯一 trampoline（幂等）。

    必须在创建任何 ``pylink.JLink`` 之前调用（后端启动时与 ``install_pylink_lock``
    一起）。返回 ``False`` 表示 pylink 不可用。
    """
    global _CALLBACK_HUB_INSTALLED
    if _CALLBACK_HUB_INSTALLED:
        return True
    try:
        import pylink
        from pylink import enums
    except Exception:  # noqa: BLE001
        return False

    funcs = enums.JLinkFunctions
    try:
        funcs.LOG_PROTOTYPE = _CallbackHub(funcs.LOG_PROTOTYPE)
        funcs.UNSECURE_HOOK_PROTOTYPE = _CallbackHub(
            funcs.UNSECURE_HOOK_PROTOTYPE,
            default_result=int(enums.JLinkFlags.DLG_BUTTON_NO),
        )
    except Exception:  # noqa: BLE001 - 版本差异时宁可退回原行为，不影响启动
        return False

    _CALLBACK_HUB_INSTALLED = True
    return True


def _wrap(func):
    """把函数包成「持有 JLINK_DLL_LOCK 再执行」。"""
    if getattr(func, "_omni_jlink_locked", False):
        return func

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        acquire_dll_lock()
        try:
            return func(*args, **kwargs)
        finally:
            release_dll_lock()

    wrapper._omni_jlink_locked = True  # type: ignore[attr-defined]
    return wrapper


def install_pylink_lock() -> bool:
    """给 ``pylink.JLink`` 的所有公开方法加锁 + 安装回调 hub（幂等）。

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

    # 先装回调 hub，再给方法加锁：两者都必须在任何 JLink 实例出现之前完成。
    install_pylink_callback_hub()

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
