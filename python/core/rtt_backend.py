"""RTT (Real-Time Transfer) 后端

封装 pyOCD 的 RTTControlBlock，为每个已连接探针维护 RTT 会话。
后台轮询线程持续读取 up channel 数据，通过 WebSocket 推送到前端。
支持向 down channel 发送数据。

复用 pyOCD 的 RTT 实现（python/pyocd/debug/rtt.py），对标 J-Link RTT Viewer。
"""

import time
import base64
import threading
import logging
from typing import Optional

from core.pyocd_backend import backend
from core.events import event_manager

logger = logging.getLogger(__name__)

# 轮询间隔（秒）。10ms 平衡了实时性与 CPU 占用。
# pyOCD 的 rtt_cmd.py 用 1ms，但那是 CLI 单线程场景；
# 我们通过 WebSocket 推送，10ms 足够流畅且降低 CPU/USB 压力。
POLL_INTERVAL = 0.01

# RTT 操作锁（reset/start 共用）的等待与僵死判定参数。
# RTT_OP_LOCK_WAIT: 单次等待 per-uid 操作锁的秒数（不可太小，否则会过早报"上一个未完成"）。
# RTT_OP_LOCK_STALE_S: 上一操作持锁超过此时长，视为 to_thread 僵尸线程遗留
# （asyncio.wait_for 超时后线程无法取消、仍持锁），允许新请求强制重建锁并接管，
# 避免用户被永久卡在"已有另一个复位/启动正在进行中"。
RTT_OP_LOCK_WAIT = 6.0
RTT_OP_LOCK_STALE_S = 15.0


class RTTBackend:
    """RTT 后端

    为每个探针维护一个 RTTControlBlock 和轮询线程。
    线程安全：每个探针一把锁，协调 read（轮询线程）与 write（发送数据）。
    """

    def __init__(self):
        # uid -> RTTControlBlock
        self._control_blocks: dict[str, object] = {}
        # uid -> 轮询线程
        self._poll_threads: dict[str, threading.Thread] = {}
        # uid -> 运行标志（Event）
        self._running: dict[str, threading.Event] = {}
        # uid -> 锁（协调 up channel read 与 down channel write）
        self._locks: dict[str, threading.Lock] = {}
        # uid -> 选中的 up/down channel 索引
        self._up_channel: dict[str, int] = {}
        self._down_channel: dict[str, int] = {}
        # uid -> 用户主动 halt 标志（True=用户主动暂停，轮询线程不自动恢复）
        self._user_halted: dict[str, bool] = {}
        # 全局锁，保护字典操作
        self._global_lock = threading.Lock()
        # uid -> RTT 操作互斥锁（start/reset 共用，threading.Lock）。防止 asyncio.wait_for
        # 超时后残留的 to_thread 僵尸线程与下一次启动/复位请求并发操作同一 target
        # （重复复位/重复启轮询）。
        self._ops_locks: dict[str, threading.Lock] = {}
        # uid -> 最近一次成功获取操作锁的时间戳（monotonic），用于识别僵尸线程遗留
        # 长期持有操作锁的场景，从而允许 reset_target 强制接管。
        self._ops_lock_stamp: dict[str, float] = {}

    def start(
        self,
        uid: str,
        address: Optional[int] = None,
        size: Optional[int] = None,
        up_channel: int = 0,
        down_channel: int = 0,
    ) -> dict:
        """启动 RTT（带每探针互斥，防止并发启动操作同一 target）

        此方法经 asyncio.to_thread 调用，外层有 5s 超时兜底；但超时后线程
        并不会真正终止（to_thread 无法取消）。用 per-uid 互斥锁保证同一探针
        同时只有一个启动流程在跑，避免超时残留的僵尸线程与新请求重复复位、
        重复启动轮询。
        """
        with self._global_lock:
            lock = self._ops_locks.setdefault(uid, threading.Lock())
        if not lock.acquire(timeout=6.0):
            return {"success": False,
                    "error": "已有另一个 RTT 启动仍在进行中，请稍后重试"}
        try:
            return self._start_inner(uid, address=address, size=size,
                                     up_channel=up_channel, down_channel=down_channel)
        finally:
            lock.release()

    def _start_inner(
        self,
        uid: str,
        address: Optional[int] = None,
        size: Optional[int] = None,
        up_channel: int = 0,
        down_channel: int = 0,
    ) -> dict:
        """启动 RTT 核心实现（启动流程已在 start() 中加互斥）

        在目标 RAM 中搜索 RTT 控制块（SEGGER RTT 标识），解析 up/down 通道。
        搜索完成后恢复目标运行，使固件可以写入 RTT 缓冲区。

        Args:
            address: 控制块搜索起始地址，None 则自动扫描默认 RAM 区域
            size: 控制块搜索范围大小，None 则自动
            up_channel: 监听的 up channel 索引（target -> host）
            down_channel: 发送的 down channel 索引（host -> target）

        Returns:
            {success, up_channels, down_channels, error?}
        """
        # 已在运行则先返回当前状态
        with self._global_lock:
            if uid in self._control_blocks and self._running.get(uid, threading.Event()).is_set():
                cb = self._control_blocks[uid]
                return self._build_start_result(cb, uid, up_channel, down_channel)

        # 互斥检查：同一探针下 Monitor 与 RTT 不能同时运行
        try:
            from core.monitor_backend import monitor_backend
            if monitor_backend.is_running(uid):
                return {"success": False,
                        "error": "Monitor 采样正在运行，请先停止 Monitor 再启动 RTT"}
        except Exception:
            pass

        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "Probe not connected"}

        target = session.target

        try:
            from pyocd.debug.rtt import RTTControlBlock
            from pyocd.core.memory_map import MemoryType
            from pyocd.core.target import Target

            # 对标 pyocd rtt CLI 的流程：
            # CLI 用 connect_mode='halt'（默认），连接时即 halt 目标，
            # 然后在 halt 状态下搜索控制块（RAM 内容保留），找到后再 resume。
            # 我们复用已有 session，目标可能正在运行，
            # 需要先 halt 再搜索，确保内存读取可靠。
            #
            # 关键修复：必须遍历所有 RAM region 搜索控制块。
            # STM32F407 等芯片有多个 RAM region（CCMRAM 0x10000000 + SRAM 0x20000000），
            # pyOCD 的 get_default_region_of_type(RAM) 只返回一个默认 region（可能是 CCMRAM），
            # 而 RTT 控制块通常在主 SRAM 中。J-Link RTT Viewer 也是扫描所有已知 RAM 区域。

            # 诊断：目标状态
            try:
                state = target.get_state()
                event_manager.log("info", f"RTT: target state before search: {state}")
            except Exception:
                pass

            # 获取所有 RAM region（不能只搜索默认 RAM region）
            ram_regions = []
            try:
                mem_map = target.get_memory_map()
                ram_regions = list(mem_map.iter_matching_regions(type=MemoryType.RAM))
                if ram_regions:
                    event_manager.log("info", f"RTT: found {len(ram_regions)} RAM region(s):")
                    for i, r in enumerate(ram_regions):
                        event_manager.log("info", f"RTT:   [{i}] 0x{r.start:08X} "
                                          f"size=0x{r.length:X} ({r.length} bytes)"
                                          f"{f' (default)' if getattr(r, 'is_default', False) else ''}")
                else:
                    event_manager.log("warning", "RTT: no RAM region found in memory map")
            except Exception as e:
                event_manager.log("warning", f"RTT: failed to get RAM regions: {e}")

            # halt 目标，确保内存读取可靠（对标 CLI 的 connect_mode='halt'）
            try:
                target.halt()
                event_manager.log("info", "RTT: target halted for control block search")
            except Exception as e:
                event_manager.log("warning", f"RTT: halt failed (will try anyway): {e}")

            # 诊断：读取每个 RAM region 起始处的 32 字节
            sig = b'SEGGER RTT'
            for r in ram_regions:
                try:
                    probe_bytes = target.read_memory_block8(r.start, 32)
                    hex_str = ' '.join(f'{b:02X}' for b in probe_bytes)
                    event_manager.log("info", f"RTT: first 32 bytes @0x{r.start:08X}: {hex_str}")
                    if sig in bytes(probe_bytes):
                        offset = bytes(probe_bytes).find(sig)
                        event_manager.log("info", f"RTT: signature found at offset {offset} "
                                          f"(addr 0x{r.start + offset:08X})")
                except Exception as e:
                    event_manager.log("warning", f"RTT: diagnostic read @0x{r.start:08X} failed: {e}")

            cb = None
            last_error = None

            def _search_control_block(limit_bytes: Optional[int] = None):
                """在所有 RAM region 中搜索 RTT 控制块

                如果用户指定了 address，只搜索指定范围；
                否则遍历所有 RAM region（对标 J-Link RTT Viewer 的行为）。
                limit_bytes 非 None 时，每个 RAM region 只扫描起始 limit_bytes
                字节（快速探测）；None 时完整扫描整个 region。
                """
                nonlocal last_error

                # 用户指定了地址，只搜索指定范围
                if address is not None:
                    event_manager.log("info", f"RTT: searching at specified address 0x{address:08X}"
                                      f"{f' size=0x{size:X}' if size else ''}...")
                    try:
                        cb_obj = RTTControlBlock.from_target(target, address=address, size=size)
                        cb_obj.start()
                        if len(cb_obj.up_channels) > 0:
                            return cb_obj
                        last_error = "No up channels found"
                    except Exception as e:
                        last_error = str(e)
                        event_manager.log("warning", f"RTT: search at 0x{address:08X} failed: {e}")
                    return None

                # 自动模式：遍历所有 RAM region，用大块 read32 粗扫定位控制块
                for r in ram_regions:
                    effective = None
                    if limit_bytes is not None and r.length > limit_bytes:
                        effective = limit_bytes
                    scope = f"first {effective // 1024}KiB" if effective else "all"
                    event_manager.log("info", f"RTT: scanning RAM region 0x{r.start:08X} "
                                      f"(size=0x{r.length:X}, scope={scope})...")
                    hit = self._fast_scan_region(target, r, max_bytes=effective)
                    if hit is None:
                        event_manager.log("info", f"RTT: no control block in region 0x{r.start:08X}")
                        continue
                    event_manager.log("info",
                                      f"RTT: signature found @0x{hit:08X}, parsing control block...")
                    try:
                        cb_obj = RTTControlBlock.from_target(target, address=hit, size=0)
                        cb_obj.start()
                        if len(cb_obj.up_channels) > 0:
                            event_manager.log("info",
                                              f"RTT: control block found in region 0x{r.start:08X}")
                            return cb_obj
                    except Exception as e:
                        event_manager.log("info",
                                          f"RTT: parse control block @0x{hit:08X} failed: {e}")
                last_error = "Control block not found in any RAM region"
                return None

            # 第0轮：低地址快速探测（每个 RAM region 前 64KB），覆盖"固件已在运行、
            # RTT 已初始化"的常见场景。不要一上来就全 RAM 扫描——SWD 下 APM32F4
            # 双 RAM 192KB 全扫约 6.5s，势必触发 5s 启动超时。
            event_manager.log("info",
                              "RTT: 先做低地址快速探测（每个 RAM region 前 64KB）...")
            cb = _search_control_block(limit_bytes=0x10000)

            # 探测未命中且目标处于暂停态：主场景（如"下载程序后未复位运行"）固件
            # 尚未初始化 RTT。单纯 resume 不会重跑启动代码，必须复位运行，让固件
            # 初始化控制块后再搜索（对标 J-Link RTT Viewer 的默认行为）。
            target_halted = False
            try:
                target_halted = (target.get_state() == Target.State.HALTED)
            except Exception:
                # 无法读取目标状态时保守按暂停态处理，尝试复位运行
                target_halted = True
            if cb is None and target_halted:
                event_manager.log("info",
                                  "RTT: 未找到控制块，执行【复位并运行】让固件初始化 RTT...")
                reset_attempts = 0
                max_reset_attempts = 2
                reboot_sleep = 1.2  # 等待固件启动并完成 RTT 控制块初始化
                while cb is None and reset_attempts < max_reset_attempts:
                    reset_attempts += 1
                    try:
                        target.reset(reset_type=None)   # 复位使固件从启动代码重新执行
                        target.resume()                 # 运行，让 RTT 初始化代码执行
                    except Exception as e:
                        event_manager.log("warning", f"RTT: 复位运行目标失败: {e}")
                        break

                    time.sleep(reboot_sleep)

                    # 复位后目标可能停在 reset vector（reset catch），halt 确保内存读取可靠
                    try:
                        target.halt()
                    except Exception:
                        pass

                    event_manager.log("info",
                                      f"RTT: 复位运行后重试搜索控制块 "
                                      f"(attempt {reset_attempts}/{max_reset_attempts})...")
                    cb = _search_control_block()
                    if cb is not None:
                        last_error = None
                        break

                    if reset_attempts < max_reset_attempts:
                        event_manager.log("info",
                                          "RTT: 仍未找到控制块，再次复位运行尝试初始化...")

            # 目标正运行但低地址未命中：控制块可能位于 RAM 高地址，做一次完整扫描确认
            if cb is None and not target_halted:
                event_manager.log("info", "RTT: 低地址未命中，对全部 RAM 完整扫描...")
                cb = _search_control_block()

            if cb is None or len(cb.up_channels) == 0:
                reason = f"（{last_error}）" if last_error else ""
                msg = ("未检测到 SEGGER RTT 控制块" + reason +
                       "。已尝试复位并运行固件，但目标 RAM 中仍未找到 RTT 控制块，"
                       "请确认固件已链接并初始化 SEGGER RTT 库（SEGGER_RTT_ConfigUpBuffer）。")
                event_manager.log("error", f"RTT: {msg}")
                return {"success": False, "error": msg}

            num_up = len(cb.up_channels)
            num_down = len(cb.down_channels)

            event_manager.log("info", f"RTT: control block found, {num_up} up channels, {num_down} down channels")

            # 验证 channel 索引有效性
            if up_channel >= num_up:
                up_channel = 0
            if down_channel >= num_down:
                down_channel = 0

            with self._global_lock:
                self._control_blocks[uid] = cb
                self._up_channel[uid] = up_channel
                self._down_channel[uid] = down_channel
                self._user_halted[uid] = False
                running = threading.Event()
                running.set()
                self._running[uid] = running
                self._locks[uid] = threading.Lock()

            # 找到控制块后恢复目标运行（对标 CLI：search → resume）
            try:
                target.resume()
            except Exception:
                pass

            event_manager.log("info", f"RTT: started (up={up_channel}, down={down_channel})")
            event_manager.emit("rtt.started", {"uid": uid})

            # 启动轮询线程
            thread = threading.Thread(target=self._poll_loop, args=(uid,), daemon=True)
            with self._global_lock:
                self._poll_threads[uid] = thread
            thread.start()

            return self._build_start_result(cb, uid, up_channel, down_channel)

        except Exception as e:
            logger.exception("RTT start failed")
            event_manager.log("error", f"RTT: start failed: {e}")
            event_manager.emit("rtt.error", {"uid": uid, "error": str(e)})
            return {"success": False, "error": str(e)}

    def _build_start_result(self, cb, uid: str, up_channel: int, down_channel: int) -> dict:
        """构建 start 成功返回结果"""
        up_channels = []
        for i, ch in enumerate(cb.up_channels):
            up_channels.append({
                "index": i,
                "name": ch.name if ch.name else "",
                "size": ch.size,
            })
        down_channels = []
        for i, ch in enumerate(cb.down_channels):
            down_channels.append({
                "index": i,
                "name": ch.name if ch.name else "",
                "size": ch.size,
            })
        return {
            "success": True,
            "up_channels": up_channels,
            "down_channels": down_channels,
            "up_channel": up_channel,
            "down_channel": down_channel,
        }

    def _poll_loop(self, uid: str):
        """轮询线程：持续读取所有 up channel 数据并推送到前端

        改造说明：遍历所有 up_channels 分别读取，事件 payload 带 channel 索引。
        前端根据 tab 模式（All Channel 或单通道）过滤显示。

        自动恢复机制：定期检查目标内核状态，若检测到内核被暂停（如硬件复位后
        pyOCD 的 reset catch 机制暂停了内核），且非用户主动暂停，则自动 resume，
        使固件重新运行并恢复 RTT 数据流。同时重新读取控制块描述符，确保缓存
        的 buffer 地址/大小与复位后固件重新初始化的值一致。
        """
        poll_interval = POLL_INTERVAL
        consecutive_errors = 0
        # 内核状态检查计数器（每 ~3 秒检查一次，避免高频 SWD 事务增加延迟）
        state_check_counter = 0
        STATE_CHECK_INTERVAL = 300  # 300 * 10ms = 3s

        while True:
            running = self._running.get(uid)
            if running is None or not running.is_set():
                break

            lock = self._locks.get(uid)
            cb = self._control_blocks.get(uid)
            if lock is None or cb is None:
                break

            # 探针已断开
            if not backend.is_connected(uid):
                event_manager.emit("rtt.stopped", {"uid": uid, "reason": "disconnected"})
                break

            # 定期检查目标内核状态，自动恢复因硬件复位而暂停的内核
            state_check_counter += 1
            if state_check_counter >= STATE_CHECK_INTERVAL:
                state_check_counter = 0
                self._check_and_auto_resume(uid, cb, lock)

            try:
                with lock:
                    # 遍历所有 up channels，分别读取并推送
                    for up_idx, up_ch in enumerate(cb.up_channels):
                        try:
                            data = up_ch.read()
                        except Exception:
                            # 单个通道读取失败不影响其他通道
                            data = None
                        if data:
                            event_manager.emit("rtt.data", {
                                "uid": uid,
                                "channel": up_idx,
                                "data": base64.b64encode(data).decode("ascii"),
                                "size": len(data),
                            })
                consecutive_errors = 0
                time.sleep(poll_interval)
            except Exception as e:
                consecutive_errors += 1
                if consecutive_errors <= 3:
                    logger.warning(f"RTT poll error (#{consecutive_errors}): {e}")
                if consecutive_errors == 1:
                    event_manager.emit("rtt.error", {"uid": uid, "error": str(e)})
                # 错误时退避，避免刷屏
                time.sleep(min(0.5, poll_interval * (2 ** consecutive_errors)))

        # 线程退出时清理
        event_manager.log("info", f"RTT: polling stopped for probe {uid[:16]}")

    def _check_and_auto_resume(self, uid: str, cb: object, lock: threading.Lock):
        """检查目标内核状态，若被暂停且非用户主动暂停则自动恢复

        硬件复位后 pyOCD 的 reset catch 机制会暂停内核，导致固件不运行、
        RTT 无数据。此方法检测到该情况后自动 resume，并重新读取控制块描述符
        以同步固件重新初始化后的 buffer 地址/大小。
        """
        if self._user_halted.get(uid, False):
            return  # 用户主动暂停，不自动恢复

        try:
            from pyocd.core.target import Target
            target = getattr(cb, 'target', None)
            if target is None:
                session = backend._get_session(uid)
                if not session:
                    return
                target = session.target

            state = target.get_state()
            if state == Target.State.HALTED:
                event_manager.log("info",
                                  "RTT: 检测到目标内核已暂停（可能由硬件复位触发），自动恢复...")
                try:
                    target.resume()
                except Exception as e:
                    event_manager.log("warning", f"RTT: 自动 resume 失败: {e}")
                    return

                # 等待固件重新初始化 RTT 控制块
                time.sleep(0.3)

                # 重新读取控制块描述符，确保缓存的 buffer 地址/大小与
                # 复位后固件重新初始化的值一致（防止读取到旧地址导致数据异常）
                try:
                    with lock:
                        for up_ch in cb.up_channels:
                            if hasattr(up_ch, '_read_descriptor'):
                                up_ch._read_descriptor()
                except Exception as e:
                    event_manager.log("warning",
                                      f"RTT: 重新读取控制块描述符失败: {e}")

                event_manager.log("info", "RTT: 目标内核已自动恢复运行")
        except Exception:
            pass  # 状态检查失败不影响正常轮询

    # ── 目标设备控制（Run/Halt/Reset）─────────────────────────
    # 直接操作 session.target，不影响轮询线程。
    # Run/Halt/Reset 是毫秒级操作，轮询线程的读取有错误恢复机制，
    # 短暂冲突由 consecutive_errors 退避处理。

    def run_target(self, uid: str) -> dict:
        """运行目标内核（resume）

        清除用户暂停标志，允许轮询线程的自动恢复机制正常工作。
        """
        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接"}
        try:
            session.target.resume()
            with self._global_lock:
                self._user_halted[uid] = False
            event_manager.log("info", "RTT: 目标内核已运行 (run)")
            return {"success": True, "state": "running"}
        except Exception as e:
            event_manager.log("warning", f"RTT: run 目标失败: {e}")
            return {"success": False, "error": str(e)}

    def halt_target(self, uid: str) -> dict:
        """暂停目标内核（halt）

        设置用户暂停标志，防止轮询线程自动恢复内核。
        """
        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接"}
        try:
            session.target.halt()
            with self._global_lock:
                self._user_halted[uid] = True
            event_manager.log("info", "RTT: 目标内核已暂停 (halt)")
            return {"success": True, "state": "halted"}
        except Exception as e:
            event_manager.log("warning", f"RTT: halt 目标失败: {e}")
            return {"success": False, "error": str(e)}

    def reset_target(self, uid: str, run: bool = True) -> dict:
        """复位目标芯片并重新初始化 RTT 控制块

        硬件复位后固件会重新初始化 RTT 控制块（重写 "SEGGER RTT" 签名、
        重置通道读写指针），因此必须重新搜索控制块以获取新的引用，
        否则旧的 RTTControlBlock 对象的缓存状态（buffer 地址等）可能失效。

        Args:
            run: True=复位后运行，False=复位后保持 halt
        """
        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接"}

        # 与 start() 共用同一把 per-uid 操作锁，串行化同一探针的复位/启动流程，
        # 避免并发复位/启动重复复位目标、重复启轮询。
        # 注意：操作锁必须用独立变量 op_lock 保存，绝不能在 try 块内被其他用途
        # 的同名局部变量覆盖，否则 finally 里的 op_lock.release() 会释放一把
        # 本线程从未获取的锁，抛 RuntimeError: release unlocked lock。
        acquired = False
        with self._global_lock:
            op_lock = self._ops_locks.setdefault(uid, threading.Lock())
        if op_lock.acquire(timeout=RTT_OP_LOCK_WAIT):
            acquired = True
        else:
            # 拿不到锁：可能是上一复位/启动仍在进行，也可能是 wait_for 超时后遗留的
            # to_thread 僵尸线程仍长期持锁（J-Link 下 SWD 偶发挂起常见）。
            with self._global_lock:
                held_for = time.monotonic() - self._ops_lock_stamp.get(uid, 0.0)
                is_stale = held_for > RTT_OP_LOCK_STALE_S
            if not is_stale:
                # 上一个操作仍在正常进行（持锁未超时），让其自然完成，不强行干预
                return {"success": False,
                        "error": "上一次复位/启动尚未完成，请稍后再试"}
            # 僵尸线程遗留的僵死锁：强制重建锁并接管，避免用户被永久卡住
            event_manager.log("warning",
                              f"RTT: 检测到僵尸操作锁（已持 {held_for:.1f}s），强制接管重试复位")
            with self._global_lock:
                self._ops_locks.pop(uid, None)
                op_lock = threading.Lock()
                self._ops_locks[uid] = op_lock
            if not op_lock.acquire(timeout=RTT_OP_LOCK_WAIT):
                return {"success": False,
                        "error": "上一次复位/启动尚未完成，请稍后再试"}
            acquired = True
        # 记录本次获取锁的时间戳，供后续请求判断是否僵死
        with self._global_lock:
            self._ops_lock_stamp[uid] = time.monotonic()
        try:
            # 复位分步日志：J-Link 下复位可能在某一步永久挂起（疑似 SWD 或 J-Link 驱动阻塞），
            # 卡住时日志会停在对应 [n/5] 以定位挂起点。
            event_manager.log("info", "RTT: reset[1/5] halt...")
            # 1) halt 目标（确保安全操作）
            try:
                session.target.halt()
            except Exception:
                pass

            event_manager.log("info", "RTT: reset[2/5] core reset...")
            # 2) 复位目标芯片
            session.target.reset(reset_type=None)
            event_manager.log("info", f"RTT: 目标已复位 (run={run})")

            event_manager.log("info", "RTT: reset[3/5] resume...")
            if run:
                # 3a) resume 目标，让固件重新初始化 RTT
                try:
                    session.target.resume()
                except Exception:
                    pass
                # 等待固件启动并初始化 RTT 控制块
                time.sleep(0.5)

                event_manager.log("info", "RTT: reset[4/5] search control block...")
                # 4) 重新搜索 RTT 控制块
                new_cb = self._reinit_control_block(uid, session.target)
                event_manager.log("info", "RTT: reset[5/5] done")
                if new_cb is not None:
                    with self._global_lock:
                        lock = self._locks.get(uid)
                        if lock:
                            with lock:
                                self._control_blocks[uid] = new_cb
                        self._user_halted[uid] = False
                    event_manager.log("info",
                                      "RTT: 控制块已重新初始化")
                else:
                    event_manager.log("warning",
                                      "RTT: 复位后未找到控制块，"
                                      "RTT 数据可能无法恢复（固件可能尚未初始化 RTT）")
            else:
                with self._global_lock:
                    self._user_halted[uid] = True

            state = "running" if run else "halted"
            return {"success": True, "state": state}
        except Exception as e:
            event_manager.log("warning", f"RTT: reset 目标失败: {e}")
            return {"success": False, "error": str(e)}
        finally:
            # 只释放本线程实际获取到的操作锁；绝不释放被内层逻辑覆盖/从未持有的锁
            if acquired:
                op_lock.release()

    def _fast_scan_region(self, target, region, max_bytes: Optional[int] = None,
                          magic: bytes = b'SEGG',
                          control_block_id: bytes = b'SEGGER RTT') -> Optional[int]:
        """在单个 RAM region 中快速定位 4 字节对齐的 RTT 控制块签名。

        用大块 read_memory_block32 批量读取，在 host 侧匹配 'SEGG' 前缀
        （小端 word），命中后再逐字节确认完整 'SEGGER RTT' 签名，返回控制块
        地址或 None。相比 pyOCD 逐 1KB read_memory_block8 的 _find_control_block，
        大幅减少 SWD 事务次数，避免大 RAM region 全量扫描超出 5s 启动窗口。
        max_bytes 非 None 时只扫描 region 起始 max_bytes（0 或 None 表示全扫）。
        """
        magic_int = int.from_bytes(magic, 'little')  # b'SEGG' -> 0x47474553
        start = region.start
        span = region.length if (max_bytes is None or max_bytes <= 0) else min(max_bytes, region.length)
        region_end = start + span
        words_per_read = 4096                        # 一次读 16KB
        cid_len = len(control_block_id)
        addr = start
        while addr < region_end:
            n = min(words_per_read, (region_end - addr) // 4)
            if n <= 0:
                break
            try:
                words = target.read_memory_block32(addr, n)
            except Exception:
                return None
            for i, w in enumerate(words):
                if (w & 0xFFFFFFFF) == magic_int:
                    hit = addr + i * 4
                    try:
                        raw = target.read_memory_block8(hit, cid_len)
                        if bytes(raw) == control_block_id:
                            return hit
                    except Exception:
                        continue
            addr += n * 4
        return None

    def _reinit_control_block(self, uid: str, target) -> Optional[object]:
        """重新搜索 RTT 控制块（复位后调用）

        遍历所有 RAM region 搜索 "SEGGER RTT" 控制块，
        找到后创建新的 RTTControlBlock 对象并返回。
        """
        try:
            from pyocd.debug.rtt import RTTControlBlock
            from pyocd.core.memory_map import MemoryType

            mem_map = target.get_memory_map()
            ram_regions = list(mem_map.iter_matching_regions(type=MemoryType.RAM))
            if not ram_regions:
                return None

            for r in ram_regions:
                hit = self._fast_scan_region(target, r)
                if hit is None:
                    continue
                try:
                    cb_obj = RTTControlBlock.from_target(target, address=hit, size=0)
                    cb_obj.start()
                    if len(cb_obj.up_channels) > 0:
                        event_manager.log("info",
                                          f"RTT: 控制块重新找到 @0x{r.start:08X}, "
                                          f"{len(cb_obj.up_channels)} up channels")
                        return cb_obj
                except Exception:
                    continue
        except Exception as e:
            event_manager.log("warning", f"RTT: 重新搜索控制块失败: {e}")
        return None

    def get_core_state(self, uid: str) -> dict:
        """查询目标内核状态"""
        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接", "state": "unknown"}
        try:
            from pyocd.core.target import Target
            state = session.target.get_state()
            if state == Target.State.RUNNING:
                return {"success": True, "state": "running"}
            elif state == Target.State.HALTED:
                return {"success": True, "state": "halted"}
            else:
                return {"success": True, "state": str(state).lower()}
        except Exception as e:
            return {"success": False, "error": str(e), "state": "unknown"}

    def send(self, uid: str, data: bytes, channel: Optional[int] = None) -> dict:
        """向 down channel 发送数据

        Args:
            data: 原始字节数据
            channel: down channel 索引，None 则使用启动时选中的
        """
        cb = self._control_blocks.get(uid)
        if cb is None:
            return {"success": False, "error": "RTT not started"}

        lock = self._locks.get(uid)
        if lock is None:
            return {"success": False, "error": "RTT not started"}

        down_idx = channel if channel is not None else self._down_channel.get(uid, 0)

        try:
            with lock:
                if down_idx >= len(cb.down_channels):
                    return {"success": False, "error": f"Invalid down channel {down_idx}"}
                if not cb.down_channels:
                    return {"success": False, "error": "No down channels available"}
                written = cb.down_channels[down_idx].write(data)
                return {"success": True, "bytes_written": written}
        except Exception as e:
            logger.exception("RTT send failed")
            return {"success": False, "error": str(e)}

    def send_text(self, uid: str, text: str, channel: Optional[int] = None, append_newline: bool = False) -> dict:
        """发送文本数据（UTF-8 编码）"""
        if append_newline:
            text += "\n"
        data = text.encode("utf-8")
        return self.send(uid, data, channel)

    def get_channels(self, uid: str) -> dict:
        """获取当前 RTT 通道信息"""
        cb = self._control_blocks.get(uid)
        if cb is None:
            return {"success": False, "error": "RTT not started"}
        return self._build_start_result(cb, uid, self._up_channel.get(uid, 0), self._down_channel.get(uid, 0))

    def is_running(self, uid: str) -> bool:
        """RTT 是否正在运行"""
        running = self._running.get(uid)
        return running is not None and running.is_set()

    def stop(self, uid: str, reason: str = "user") -> dict:
        """停止 RTT

        Args:
            reason: 停止原因，传递给前端用于 UI 反馈
                "user" - 用户手动停止
                "flash" - Flash 操作前自动停止（固件下载后 RTT 控制块失效）
                "disconnected" - 探针断开
        """
        with self._global_lock:
            running = self._running.pop(uid, None)
            thread = self._poll_threads.pop(uid, None)
            self._control_blocks.pop(uid, None)
            self._locks.pop(uid, None)
            self._up_channel.pop(uid, None)
            self._down_channel.pop(uid, None)
            self._user_halted.pop(uid, None)

        if running:
            running.clear()
        if thread:
            thread.join(timeout=2)

        event_manager.log("info", f"RTT: stopped (reason={reason})")
        event_manager.emit("rtt.stopped", {"uid": uid, "reason": reason})
        return {"success": True}

    def on_probe_disconnected(self, uid: str):
        """探针断开时调用，清理 RTT 会话"""
        if uid in self._control_blocks:
            self.stop(uid, reason="disconnected")

    def cleanup_all(self):
        """清理所有 RTT 会话（应用退出时调用）"""
        for uid in list(self._control_blocks.keys()):
            self.stop(uid)


# 全局单例
rtt_backend = RTTBackend()
