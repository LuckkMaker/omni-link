"""pyOCD 后端实现

基于 pyOCD 库实现 BackendInterface，提供 DAPLink 探针管理和 Flash 操作。
维护探针连接状态、会话生命周期，并支持热插拔检测。
"""

import time
import os
import array
import threading
import logging
from typing import Optional
from dataclasses import dataclass, field
from enum import Enum

from core.interface import BackendInterface, ProbeInfo, TargetInfo, FlashResult, FlashRegionInfo, SectorInfo, RamRegionInfo
from core.events import event_manager

logger = logging.getLogger(__name__)

# 拔出判定所需的连续缺失轮询次数（去抖）：CMSIS-DAP 探针连接成功后可能短暂
# 重新枚举（USB reset），并非真正拔出，需连续缺失多轮才判定为拔出。
# 每次轮询间隔 2s，2 轮=约 4s 确认时间。
REMOVAL_GRACE_POLLS = 2


class ProbeState(Enum):
    """探针连接状态"""
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


@dataclass
class ProbeSession:
    """探针会话信息"""
    uid: str
    session: object = None
    state: ProbeState = ProbeState.DISCONNECTED
    target_info: Optional[TargetInfo] = None
    connected_at: float = 0.0
    error: Optional[str] = None


# 会话关闭回调：供其他模块（如 zone）注册以清理其按 uid 维护的会话态（如断点表）。
# 在 pyOCD session 真正关闭后同步触发，线程由调用方保证（_close_session 在后台线程执行）。
_session_closed_handlers: list = []


def register_session_closed(handler):
    """注册会话关闭回调 handler(uid)"""
    _session_closed_handlers.append(handler)


class PyOCDBackend(BackendInterface):
    """pyOCD 后端实现"""

    # 默认目标型号（DAPLink 无法自动探测 MCU 型号，需指定）
    DEFAULT_TARGET = "stm32f407xg"

    def __init__(self):
        self._sessions: dict[str, ProbeSession] = {}
        self._lock = threading.Lock()
        # 按探针 UID 记录“关闭中”事件：断开时在后台线程关闭 session，
        # 供下一次连接等待旧 J-Link 句柄真正释放后再 open，避免并发抢占同一仿真器。
        self._close_events: dict[str, threading.Event] = {}
        self._known_probe_uids: set[str] = set()
        # 探针连续缺失轮询次数计数：CMSIS-DAP 探针（如 Geehy Link V2）连接成功后
        # 会在 USB 总线上短暂重新枚举（USB reset），导致误判为拔出。只有连续缺失
        # REMOVAL_GRACE_POLLS 次才真正判定拔出，避免误拆刚建立的会话。
        self._missing_polls: dict[str, int] = {}
        self._pending_target: str | None = None  # 连接时使用的目标型号
        self._probe_info_cache: dict[str, ProbeInfo] = {}  # 缓存探针初始信息（避免连接后名称变化）
        self._cancel_flag: threading.Event = threading.Event()
        # 调试/刷新协调锁（per-UID）：用户调试操作（halt/step/continue/reset）持有
        # （阻塞获取），周期刷新（read_memory_direct 等）try-acquire，获取不到直接跳过，
        # 保证调试操作不被周期性刷新并发访问 pyOCD target 影响。
        self._op_locks: dict[str, threading.Lock] = {}
        self._op_locks_guard = threading.Lock()

    # ── 探针扫描 ──────────────────────────────────────────────

    def cancel_operation(self):
        """取消正在进行的 Flash 操作（check_blank / read_back / erase / program）"""
        self._cancel_flag.set()
        event_manager.log("warning", "操作取消请求已发送")

    def _check_cancel(self) -> bool:
        """检查取消标志，如果已取消则重置并返回 True"""
        if self._cancel_flag.is_set():
            self._cancel_flag.clear()
            return True
        return False

    def list_probes(self) -> list[ProbeInfo]:
        """返回所有可见探针（缓存初始信息，避免连接后名称变化）。

        Windows 上 WinUSB 探针被 pyOCD 会话独占打开后，ConnectHelper 枚举会
        看不到它（详见 detect_probe_changes 注释）。因此这里把"正持有活动会话
        但仍插着的探针"补充进来，避免会话建立后探针从设备列表/拔出检测中消失。
        """
        from pyocd.core.helpers import ConnectHelper

        probes = ConnectHelper.get_all_connected_probes(blocking=False)
        result = []
        seen = set()
        for probe in probes:
            uid = probe.unique_id
            seen.add(uid)
            # 首次发现时缓存探针信息；已连接的探针 product_name 会变化，用缓存保持一致
            if uid not in self._probe_info_cache:
                info = ProbeInfo(
                    uid=uid,
                    vendor=probe.vendor_name or "Unknown",
                    product=probe.product_name or "Unknown",
                    vid=getattr(probe, 'vid', 0) or 0,
                    pid=getattr(probe, 'pid', 0) or 0,
                    serial=getattr(probe, 'serial_number', None) or uid,
                )
                self._probe_info_cache[uid] = info
            result.append(self._probe_info_cache[uid])

        # 补上"我们正持有活动会话、但被枚举隐藏"的探针（用缓存的初始信息）
        with self._lock:
            session_ids = {uid for uid, s in self._sessions.items()
                           if s.state == ProbeState.CONNECTED}
        for uid in session_ids - seen:
            if uid in self._probe_info_cache:
                result.append(self._probe_info_cache[uid])

        return result

    def get_probe_states(self) -> list[dict]:
        """返回所有探针及其连接状态"""
        probes = self.list_probes()
        result = []
        with self._lock:
            for p in probes:
                session = self._sessions.get(p.uid)
                state = session.state.value if session else ProbeState.DISCONNECTED.value
                target = session.target_info if session else None
                result.append({
                    **p.__dict__,
                    "state": state,
                    "target": target.to_dict() if target else None,
                })
        return result

    # ── 热插拔检测 ──────────────────────────────────────────────

    def detect_probe_changes(self) -> tuple[list[ProbeInfo], list[str]]:
        """检测探针变化，返回 (新增探针列表, 消失探针uid列表)

        关键约束：Windows 上 WinUSB 探针被 pyOCD 会话独占打开后，
        ConnectHelper.get_all_connected_probes() 枚举不到它（实测验证：会话
        打开期间探针从枚举中消失，关闭会话后恢复）。因此：
          1. 我们正持有活动会话的探针一律视为"存在"，绝不判为拔出；
             否则刚建立的会话会被误拆（连接图标回退未连接）。
          2. 无会话的探针做去抖（debounce）：需连续缺失 REMOVAL_GRACE_POLLS
             次轮询才判为真正拔出，避免个别轮询的偶发抖动误报。
        """
        current_probes = self.list_probes()
        current_uids = {p.uid for p in current_probes}

        with self._lock:
            # 正持有活动会话的探针 = 物理上仍存在，即使枚举看不到
            engaged = {uid for uid, s in self._sessions.items()
                       if s.state == ProbeState.CONNECTED}
            present = current_uids | engaged

            added = []
            removed = []

            # 1) 新出现的探针：本次存在且此前既不已知也非待确认拔除
            for p in current_probes:
                if p.uid not in self._known_probe_uids and p.uid not in self._missing_polls:
                    added.append(p)
                    self._known_probe_uids.add(p.uid)

            # 2) 处理缺失/重新出现
            for uid in list(self._known_probe_uids):
                if uid in present:
                    # 存在（被枚举或由活跃会话持有）：恢复，清除待确认拔除计数
                    self._missing_polls.pop(uid, None)
                else:
                    # 本次缺失：累计缺失轮次，达阈值才确认拔出
                    self._missing_polls[uid] = self._missing_polls.get(uid, 0) + 1
                    if self._missing_polls[uid] >= REMOVAL_GRACE_POLLS:
                        removed.append(uid)
                        self._known_probe_uids.discard(uid)
                        self._missing_polls.pop(uid, None)
                        self._probe_info_cache.pop(uid, None)

        return added, removed

    # ── 连接管理 ──────────────────────────────────────────────

    def connect(self, probe_uid: str, target: str | None = None,
                interface: str = "swd", speed: int | None = None,
                connect_mode: str | None = None, force: bool = False,
                device: str | None = None) -> bool:
        """连接指定探针

        Args:
            probe_uid: 探针唯一 ID
            target: 目标型号（如 stm32f407xg），None 则使用默认
            interface: 调试接口 "swd" 或 "jtag"
            speed: 时钟频率 (Hz)，None 则使用默认
            connect_mode: 连接模式，None 则使用默认 'attach'
                - attach: 附加模式，不复位、不暂停，保持目标当前状态（默认，推荐用于故障分析）
                - halt: 复位并暂停在复位向量
                - pre-reset: 连接前执行复位
                - under-reset: 拉低复位线时连接（用于深度睡眠/被锁目标）
            force: 是否强制重连。为 True 时即使已连接也会关闭旧会话并以新参数重连
                （用于切换连接模式，如 Zone 会话的 attach/halt 绑定）。
            device: J-Link 目标设备名（如 G32F463X8），None 则不用或走接口默认。
                对 J-Link 探针，SWD 也必须设置 jlink.device 才会建立目标连接
                （否则 pyOCD 只调 coresight_configure()，目标 target_connected=False，
                表现为"连不上"，实际是 J-Link 根本没做设备连接）。
        """
        from pyocd.core.helpers import ConnectHelper

        # 等上一次断开的旧句柄真正释放后再重建连接。
        # 否则 J-Link 等探针会因旧 session.close() 尚未完成（在后台线程）而并发抢占
        # 同一仿真器，新 open() 报 "No emulator with serial number ... found"。
        self._wait_for_close(probe_uid)

        with self._lock:
            existing = self._sessions.get(probe_uid)
            if existing and existing.state == ProbeState.CONNECTED:
                if not force:
                    return True
                # force=True：关闭旧会话后以新参数重连
            old_session = existing.session if existing else None

            # 创建或更新会话记录
            session_info = ProbeSession(uid=probe_uid, state=ProbeState.CONNECTING)
            self._sessions[probe_uid] = session_info

        # 在锁外关闭旧会话（session.close() 可能耗时，避免阻塞其他探针操作）
        # 这是修复 JTAG 失败后 SWD 无法重连的关键步骤：
        # 即使旧会话的 session 字段为 None（_do_connect 中已关闭），
        # 也要清理可能残留的旧 session 对象。
        if old_session is not None:
            try:
                # 强制重连时关闭旧会话：恢复目标运行（resume_on_disconnect=True）。
                # 若保持 halted 断开，芯片会停在暂停/低功耗状态，后续重连常需手动复位才能恢复。
                old_session.options.set('resume_on_disconnect', True)
                # 清除旧会话在目标上的硬件断点（FPB），避免残留影响重连后的调试
                self._clear_hw_breakpoints(old_session)
                old_session.close()
                event_manager.log("info", f"Closed stale session for {probe_uid[:16]} before reconnect")
            except Exception:
                pass
            finally:
                self._notify_session_closed(probe_uid)

        event_manager.log("info", f"Connecting to probe {probe_uid[:16]}...")

        # 确定目标型号
        target_override = target or self._pending_target or self.DEFAULT_TARGET

        # 构建 pyOCD 选项
        options = {
            # 启用延迟传输：将多个寄存器读写批量打包到 USB 包中，减少 USB 往返次数
            # 对 CMSIS-DAP v2 (WinUSB bulk) 提升尤为显著，读取速度可提升 5-10 倍
            'cmsis_dap.deferred_transfers': True,
            # 连接模式：默认 'halt'（与 pyOCD 原生默认一致，不影响 flash/Commander/RTT 等
            # 依赖"连接即复位并暂停"的原有行为）。
            # 故障分析等需要保留现场的场景，可在连接配置窗口手动选择 'attach'
            # （不复位、不暂停，保持目标当前状态）。
            # 烧录/擦除/读回等操作内部仍显式 reset_and_halt，不受连接模式影响。
            'connect_mode': connect_mode or 'halt',
        }
        # 默认 1MHz SWD 时钟（与前端默认值一致）。
        # 若探针不支持该频率，pyOCD 会自动选择最接近的支持值。
        actual_speed = speed if speed else 1000000
        options['frequency'] = actual_speed
        # 接口协议通过 dap_protocol 选项设置
        if interface == 'jtag':
            options['dap_protocol'] = 'jtag'
        else:
            options['dap_protocol'] = 'swd'
        # J-Link 设备名：显式传入优先；JTAG 走历史兼容的 STM32F4 配置。
        # 关键：SWD 下 J-Link 也必须设置 jlink.device 才会调用 JLink.connect(device)
        # 建立目标连接，否则 pyOCD 只调 pylink 的 coresight_configure()，
        # 目标 target_connected=False（表现为连不上，但探针/软件层都正常）。
        # SWD 的 device 名由前端 J-Link 输入框提供（如 G32F463X8）。
        if device:
            options['jlink.device'] = device
        elif interface == 'jtag':
            # JTAG 模式必须设置 jlink.device,触发 J-Link 固件执行完整 JTAG 链扫描和 DP 初始化。
            # 否则 pyOCD 走 low-level CoreSight 路径,pylink 的 coresight_configure() 会破坏
            # JTAG DP 访问(实测 DP IDR 变 0x00000000,内存读全零)。
            # APM32F407IG 与 STM32F407VG 的 CoreSight JTAG-DP ID 一致(0x4BA00477),
            # JTAG 链结构相同,可借用 STM32F4 设备配置。
            # 配合 jlink_probe.py 中对 coresight_configure() 的条件跳过使用。
            options['jlink.device'] = 'STM32F407VG'

        # 连接超时（秒）。目标未 reset 或无响应时，pyOCD 内部 DP 连接会重试 4 次 SWJ 序列，
        # 可能阻塞数秒到数十秒。用线程池 + future.result(timeout) 强制中断。
        # CMSIS-DAP v1 (HID) 单包仅 64B、轮询慢，完整 SWJ 序列需更长时间，故放宽到 15s。
        CONNECT_TIMEOUT = 15.0
        # JTAG 连接失败时的降速重试频率（Hz）
        JTAG_FALLBACK_SPEED = 1000000

        def _do_connect(freq: int, proto: str):
            """实际的连接逻辑，在线程池中执行"""
            opts = dict(options)
            opts['frequency'] = freq
            opts['dap_protocol'] = proto
            sess = ConnectHelper.session_with_chosen_probe(
                blocking=False,
                unique_id=probe_uid,
                target_override=target_override,
                init_board=False,
                options=opts,
            )
            if sess is None:
                return None
            try:
                sess.open()
                return sess
            except Exception:
                # 连接失败时必须关闭 session，释放 USB 句柄。
                # 否则探针会被锁定，后续重连（如 JTAG 失败后切换 SWD）
                # 会因探针被占用而失败，只能物理拔插。
                try:
                    sess.options.set('resume_on_disconnect', False)
                    sess.close()
                except Exception:
                    pass
                raise

        session = None
        last_error = None
        try:
            import concurrent.futures
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            try:
                future = executor.submit(_do_connect, actual_speed, interface)
                try:
                    session = future.result(timeout=CONNECT_TIMEOUT)
                except concurrent.futures.TimeoutError:
                    future.cancel()
                    last_error = f"连接超时（{int(CONNECT_TIMEOUT)}秒），目标可能未上电或未复位"
                    event_manager.log("error", f"Connection timeout: {last_error}")
                except Exception as e:
                    last_error = str(e)
                    # JTAG 模式下通信失败，降速重试
                    if interface == 'jtag':
                        # JTAG 通信失败的常见原因：
                        # 1. JTAG 接线问题（TCK/TMS/TDI/TDO 未正确连接）
                        # 2. 目标芯片未上电或未复位
                        # 3. JTAG scan chain 未正确配置（多设备链）
                        # 4. 探针固件不支持 JTAG（部分 J-Link 型号）
                        if actual_speed > JTAG_FALLBACK_SPEED:
                            event_manager.log("warning",
                                              f"JTAG connect failed at {actual_speed}Hz: {e}; "
                                              f"retrying at {JTAG_FALLBACK_SPEED}Hz...")
                            try:
                                future2 = executor.submit(_do_connect, JTAG_FALLBACK_SPEED, interface)
                                session = future2.result(timeout=CONNECT_TIMEOUT)
                                if session is not None:
                                    last_error = None
                                    event_manager.log("info",
                                                      f"JTAG connected at fallback {JTAG_FALLBACK_SPEED}Hz")
                            except Exception as e2:
                                last_error = str(e2)
                        # JTAG 降速重试仍失败，提供明确的错误信息
                        if session is None:
                            last_error = (
                                f"JTAG 连接失败: {last_error}\n"
                                "可能原因：\n"
                                "1. JTAG 接线问题（检查 TCK/TMS/TDI/TDO/GND）\n"
                                "2. 目标芯片未上电或未复位\n"
                                "3. 探针不支持 JTAG 模式\n"
                                "建议：尝试使用 SWD 接口连接"
                            )
                            event_manager.log("error", f"JTAG connection failed: {last_error}")

            finally:
                # 不等待 worker 线程完成：DAPLink/USB 卡死时，
                # shutdown(wait=True) 会在此处阻塞，进而卡死 asyncio 事件循环。
                # wait=False 立即返回，让卡住的底层线程在后台自行结束。
                executor.shutdown(wait=False, cancel_futures=True)

            if session is None:
                # _do_connect 返回 None 表示探针未找到
                if last_error is None:
                    last_error = f"Probe {probe_uid[:16]} not found"
                    event_manager.log("error", last_error)
                    event_manager.emit("probe.disconnected", {"uid": probe_uid, "reason": "not_found"})
                else:
                    event_manager.emit("probe.disconnected", {"uid": probe_uid, "reason": "error"})
                with self._lock:
                    session_info.state = ProbeState.ERROR
                    session_info.error = last_error
                return False

            with self._lock:
                session_info.session = session
                session_info.state = ProbeState.CONNECTED
                session_info.connected_at = time.time()
                session_info.error = None

            # 获取目标信息
            target_info = self._extract_target_info(session)
            with self._lock:
                session_info.target_info = target_info

            event_manager.log("info", f"Connected to {probe_uid[:16]}")
            if target_info:
                event_manager.log("info", f"Target: {target_info.part_number} ({target_info.core})")

            # 诊断：输出 CMSIS-DAP 传输参数
            try:
                probe = session.probe
                link = getattr(probe, '_link', None)
                if link:
                    # is_bulk 在 _interface 上，不是 link 本身
                    iface = getattr(link, '_interface', None)
                    if iface is not None:
                        is_bulk = getattr(iface, 'is_bulk', False)
                        pkt_size = link.identify(link.ID.MAX_PACKET_SIZE) if hasattr(link, 'identify') else '?'
                        pkt_count = link.identify(link.ID.MAX_PACKET_COUNT) if hasattr(link, 'identify') else '?'
                        proto = "v2 (WinUSB bulk)" if is_bulk else "v1 (HID)"
                        event_manager.log("info", f"CMSIS-DAP {proto}, packet_size={pkt_size}, packet_count={pkt_count}, deferred=True")
            except Exception:
                pass

            event_manager.emit("probe.connected", {
                "uid": probe_uid,
                "target": target_info.to_dict() if target_info else None,
            })

            # force reconnect 成功后，旧 session 已关闭，commander 上下文残留的旧 session 引用
            # 会导致后续 commander_backend.execute("reset halt") 失败——它访问的是已关闭的旧
            # session 而非新 session。重置 commander 上下文，下次执行命令时自动重建新上下文。
            if force and old_session is not None:
                from core.commander_backend import commander_backend
                commander_backend.reset_context(probe_uid)

            return True

        except Exception as e:
            with self._lock:
                session_info.state = ProbeState.ERROR
                session_info.error = str(e)
            event_manager.log("error", f"Connection failed: {e}")
            event_manager.emit("probe.disconnected", {"uid": probe_uid, "reason": "error"})
            return False

    def disconnect(self, probe_uid: str) -> bool:
        """断开探针"""
        with self._lock:
            session_info = self._sessions.pop(probe_uid, None)

        if session_info and session_info.session:
            # 先通知前端探针已断开，UI 立即更新
            event_manager.emit("probe.disconnected", {"uid": probe_uid, "reason": "user"})

            # session.close() 耗时取决于底层 USB 通信，可能数秒。
            # 放入后台线程执行以避免阻塞前端，同时登记一个"关闭中"事件，
            # 供下一次连接（connect）等待旧句柄真正释放后再 open，
            # 避免 J-Link 等探针跑到一半就重建连接导致 "No emulator found"。
            import threading
            session = session_info.session
            close_event = threading.Event()
            with self._lock:
                self._close_events[probe_uid] = close_event
            t = threading.Thread(target=self._close_session,
                                 args=(probe_uid, session, close_event), daemon=True)
            t.start()

        return True

    def _clear_hw_breakpoints(self, session):
        """清除目标 core 上的全部硬件断点（FPB）

        在关闭会话前显式调用，避免 stop session 后芯片残留断点。
        逐个 core 容错处理，单个失败不影响其余清理。
        """
        target = getattr(session, 'target', None)
        if target is None:
            return
        try:
            cores = getattr(target, 'cores', None) or [target.selected_core]
        except Exception:
            cores = []
        for core in cores:
            try:
                core.bp_manager.remove_all_breakpoints()
            except Exception:
                pass  # 单个 core 清理失败忽略，继续处理其余

    def _notify_session_closed(self, uid):
        """同步触发已注册的会话关闭回调（用于清理各模块按 uid 维护的会话态）"""
        for handler in _session_closed_handlers:
            try:
                handler(uid)
            except Exception:
                pass  # 单个回调失败不影响其余

    def _close_session(self, uid, session, close_event=None):
        """后台关闭 pyOCD session，避免 blocking 前端"""
        try:
            # 断开时恢复目标运行，让芯片退出会话后 free-run，避免停在 halt/低功耗导致下次连接需手动复位。
            # 刻意不走 board.uninit()/target.disconnect()：它们内部会调 dp.power_down_debug()，
            # 而该步在本目标（J-Link + STM32F407 等）不响应掉电 ACK，会死等 5 秒超时才放弃，
            # 直接拖慢“断开→立即重连”。掉电对本目标并非必需，跳过即可。
            target = getattr(session, 'target', None)
            if target is not None:
                cores = list(getattr(target, 'cores', None) or [target.selected_core])
                for core in cores:
                    try:
                        # resume=True：恢复执行 + 清调试控制(DHCSR/DEMCR)，亚秒级
                        core.disconnect(resume=True)
                    except Exception:
                        pass
            # 清除目标上所有硬件断点（FPB），避免 stop session 后芯片残留断点
            self._clear_hw_breakpoints(session)
            probe = getattr(session, 'probe', None) or getattr(session, '_probe', None)
            if probe is not None and probe.is_open and probe.wire_protocol is not None:
                try:
                    probe.disconnect()
                except Exception:
                    pass
            if probe is not None and probe.is_open:
                try:
                    probe.close()
                except Exception:
                    pass
        except Exception as e:
            event_manager.log("warning", f"close session {uid[:16]} exception: {e}")
        finally:
            # 无论成败都通知旧句柄已释放，并清掉"关闭中"登记，允许下一次连接 proceed
            self._notify_session_closed(uid)
            with self._lock:
                # 仅当仍登记本事件的 event 时移除，避免误删新一次的关闭登记
                if self._close_events.get(uid) is close_event:
                    self._close_events.pop(uid, None)
            if close_event is not None:
                try:
                    close_event.set()
                except Exception:
                    pass

    def _wait_for_close(self, probe_uid: str, timeout: float = 8.0):
        """等待该探针上一次断开的后台关闭完成（如仍在进行），避免重建连接时抢占旧句柄。

        仅等待已登记的 close_event；无登记或已结束则立即返回。超时后不再等待，
        由 connect 的 open 超时兜底（J-Link DLL 会因旧句柄未释放而报错）。
        """
        with self._lock:
            ev = self._close_events.get(probe_uid)
        if ev is None:
            return
        try:
            ev.wait(timeout=timeout)
        except Exception:
            pass
        # 已不需要该登记，清理（connect 后续 self._lock 保护的新登记不受影响）
        with self._lock:
            if self._close_events.get(probe_uid) is ev:
                self._close_events.pop(probe_uid, None)

    def get_state(self, probe_uid: str) -> ProbeState:
        """获取探针连接状态"""
        with self._lock:
            session = self._sessions.get(probe_uid)
            return session.state if session else ProbeState.DISCONNECTED

    def is_connected(self, probe_uid: str) -> bool:
        """检查探针是否已连接"""
        return self.get_state(probe_uid) == ProbeState.CONNECTED

    def _get_session(self, probe_uid: str):
        """获取已连接的 pyOCD session，未连接则返回 None"""
        with self._lock:
            session_info = self._sessions.get(probe_uid)
            if not session_info or session_info.state != ProbeState.CONNECTED:
                return None
            return session_info.session

    def _extract_target_info(self, session) -> Optional[TargetInfo]:
        """从 pyOCD session 中提取目标芯片信息"""
        target = session.target
        if not target:
            return None

        flash_start = 0
        flash_size = 0
        page_size = 0
        sector_size = 0
        flash_regions_info: list[FlashRegionInfo] = []
        sectors_info: list[SectorInfo] = []
        ram_start = 0
        ram_size = 0
        ram_regions_info: list[RamRegionInfo] = []

        try:
            from pyocd.core.memory_map import MemoryType

            # Flash 区域
            flash_regions = [r for r in target.memory_map if r.type == MemoryType.FLASH]
            if flash_regions:
                first = flash_regions[0]
                flash_start = first.start
                page_size = getattr(first, 'page_size', 0) or 0
                sector_size = getattr(first, 'sector_size', 0) or 2048
                flash_size = sum(r.length for r in flash_regions)

                # 构建完整的 Flash 区域列表和扇区列表
                sector_index = 0
                for r in flash_regions:
                    r_sector_size = getattr(r, 'sector_size', 0) or 2048
                    r_page_size = getattr(r, 'page_size', 0) or page_size
                    r_is_boot = getattr(r, 'is_boot_memory', False)

                    flash_regions_info.append(FlashRegionInfo(
                        start=r.start,
                        length=r.length,
                        sector_size=r_sector_size,
                        page_size=r_page_size,
                        is_boot_memory=r_is_boot,
                    ))

                    # 该 region 内的所有扇区
                    for offset in range(0, r.length, r_sector_size):
                        sectors_info.append(SectorInfo(
                            index=sector_index,
                            address=r.start + offset,
                            size=r_sector_size,
                        ))
                        sector_index += 1

            # RAM 区域
            ram_regions = [r for r in target.memory_map if r.type == MemoryType.RAM]
            if ram_regions:
                ram_start = ram_regions[0].start
                ram_size = sum(r.length for r in ram_regions)
                # 构建完整的 RAM 区域列表
                for idx, r in enumerate(ram_regions):
                    ram_regions_info.append(RamRegionInfo(
                        start=r.start,
                        length=r.length,
                        is_default=(idx == 0),
                    ))
        except Exception:
            pass

        # 优先使用 session.options 中的 target_override
        try:
            part_number = session.options.get('target_override')
        except Exception:
            part_number = None
        if not part_number:
            part_number = getattr(target, 'part_number', None) or 'Unknown'

        # 获取 CPU 核心信息
        core = 'Unknown'
        try:
            # 优先使用 selected_core（pyOCD 新版 API）
            sel_core = getattr(target, 'selected_core', None)
            if sel_core is not None:
                core_type = type(sel_core).__name__
                # CortexM -> Cortex-M
                core_map = {
                    'CortexM': 'Cortex-M',
                    'CortexM4': 'Cortex-M4',
                    'CortexM7': 'Cortex-M7',
                    'CortexM0': 'Cortex-M0',
                    'CortexM0Plus': 'Cortex-M0+',
                }
                core = core_map.get(core_type, core_type)
            elif hasattr(target, '_core') and target._core is not None:
                core = str(target._core)
        except Exception:
            pass

        # 如果 core 仍是 Unknown，根据 part_number 推断
        if core == 'Unknown' and part_number != 'Unknown':
            if 'stm32f4' in part_number.lower() or 'apm32f4' in part_number.lower():
                core = 'Cortex-M4'
            elif 'stm32f1' in part_number.lower() or 'apm32f1' in part_number.lower():
                core = 'Cortex-M3'
            elif 'stm32l4' in part_number.lower():
                core = 'Cortex-M4'
            elif 'stm32h7' in part_number.lower():
                core = 'Cortex-M7'
            elif 'g32' in part_number.lower():
                core = 'Cortex-M0+'
            else:
                core = part_number

        # 读取 Core ID (DPIDR)
        core_id = ""
        try:
            # 方式1: target.dp.dpidr.idr（最直接）
            dp = getattr(target, 'dp', None)
            if dp is not None:
                dpidr_obj = getattr(dp, 'dpidr', None)
                if dpidr_obj is not None:
                    raw_idr = getattr(dpidr_obj, 'idr', 0)
                    if raw_idr:
                        core_id = f"0x{raw_idr:08X}"
            # 方式2: 通过 core -> ap -> dp -> dpidr
            if not core_id:
                sel_core = getattr(target, 'selected_core', None)
                if sel_core is not None:
                    ap = getattr(sel_core, 'ap', None)
                    if ap is not None:
                        dp = getattr(ap, 'dp', None)
                        if dp is not None:
                            dpidr_obj = getattr(dp, 'dpidr', None)
                            if dpidr_obj is not None:
                                raw_idr = getattr(dpidr_obj, 'idr', 0)
                                if raw_idr:
                                    core_id = f"0x{raw_idr:08X}"
        except Exception:
            pass

        # 读取 Device ID 和 Revision ID（DBGMCU_IDCODE 寄存器）
        # 地址 0xE0042000：bits[31:16]=Revision ID, bits[11:0]=Device ID
        device_id = ""
        revision_id = ""
        try:
            idcode = target.read32(0xE0042000)
            dev_id = idcode & 0xFFF  # 低 12 位
            rev_id = (idcode >> 16) & 0xFFFF  # 高 16 位
            device_id = f"0x{dev_id:03X}"
            revision_id = f"0x{rev_id:04X}"
            logger.info(f"DBGMCU_IDCODE @ 0xE0042000 = 0x{idcode:08X}, Device ID={device_id}, Revision ID={revision_id}")
        except Exception as e:
            logger.warning(f"Failed to read DBGMCU_IDCODE at 0xE0042000: {e}")

        return TargetInfo(
            part_number=part_number,
            core=core,
            flash_start=flash_start,
            flash_size=flash_size,
            page_size=page_size,
            sector_size=sector_size,
            core_id=core_id,
            device_id=device_id,
            revision_id=revision_id,
            endian="Little",
            flash_regions=flash_regions_info,
            sectors=sectors_info,
            ram_start=ram_start,
            ram_size=ram_size,
            ram_regions=ram_regions_info,
        )

    # ── 目标管理 ──────────────────────────────────────────────

    def get_target_info(self, probe_uid: str) -> Optional[TargetInfo]:
        """获取当前连接目标的芯片信息"""
        with self._lock:
            session_info = self._sessions.get(probe_uid)
            if session_info and session_info.target_info:
                return session_info.target_info

        session = self._get_session(probe_uid)
        if not session:
            return None

        target_info = self._extract_target_info(session)
        with self._lock:
            if probe_uid in self._sessions:
                self._sessions[probe_uid].target_info = target_info

        return target_info

    def set_target(self, probe_uid: str, part_number: str) -> bool:
        """手动设置目标芯片型号（需要重新连接）"""
        self.disconnect(probe_uid)
        self._pending_target = part_number

        from pyocd.core.helpers import ConnectHelper

        event_manager.log("info", f"Setting target to {part_number}...")

        try:
            session = ConnectHelper.session_with_chosen_probe(
                blocking=False,
                unique_id=probe_uid,
                target_override=part_number,
            )
            if session is None:
                event_manager.log("error", f"Probe {probe_uid[:16]} not found")
                return False

            session.open()

            with self._lock:
                session_info = ProbeSession(
                    uid=probe_uid,
                    session=session,
                    state=ProbeState.CONNECTED,
                    connected_at=time.time(),
                )
                session_info.target_info = self._extract_target_info(session)
                self._sessions[probe_uid] = session_info

            event_manager.log("info", f"Target set to {part_number}")
            event_manager.emit("probe.connected", {
                "uid": probe_uid,
                "target": session_info.target_info.to_dict() if session_info.target_info else None,
            })
            return True
        except Exception as e:
            logger.exception(f"Failed to set target {part_number}")
            event_manager.log("error", f"Failed to set target {part_number}: {e}")
            with self._lock:
                self._sessions[probe_uid] = ProbeSession(
                    uid=probe_uid,
                    state=ProbeState.ERROR,
                    error=str(e),
                )
            return False

    # ── Flash 操作 ──────────────────────────────────────────────

    def erase(
        self,
        probe_uid: str,
        erase_type: str = "chip",
        address: int = 0,
        size: int = 0,
    ) -> FlashResult:
        """擦除 Flash"""
        session = self._get_session(probe_uid)
        if not session:
            return FlashResult(success=False, error="Not connected")

        start_time = time.time()
        try:
            from pyocd.flash.flash import Flash

            # 擦除前复位并暂停目标，确保目标处于已知状态。
            # 目标可能正在运行用户代码，Flash 控制器状态未知，直接擦除
            # 会导致 flash algorithm 在目标上 HardFault（IPSR=3）。
            # 这与 pyocd erase CLI (subcommands/erase_cmd.py) 和
            # program() 方法的 pre_reset 行为一致。
            session.target.reset_and_halt()

            region = session.target.memory_map.get_boot_memory()
            if not region:
                return FlashResult(success=False, error="No flash memory found")

            flash = region.flash  # Flash 实例（非 FlashRegion）

            if erase_type == "chip":
                event_manager.log("info", "Erasing chip...")
                # 使用 Flash.erase_all() 进行全片擦除
                flash.init(Flash.Operation.ERASE)
                try:
                    if flash.is_erase_all_supported:
                        event_manager.emit("flash.progress", {
                            "phase": "erase", "current": 0, "total": 1, "percent": 0,
                            "unit": "operations",
                        })
                        flash.erase_all()
                        event_manager.emit("flash.progress", {
                            "phase": "erase", "current": 1, "total": 1, "percent": 100,
                            "unit": "operations",
                        })
                    else:
                        # 不支持 erase_all 时，逐扇区擦除
                        sector_size = getattr(region, 'sector_size', 0) or 16384
                        total_sectors = region.length // sector_size
                        for i in range(total_sectors):
                            flash.erase_sector(region.start + i * sector_size)
                            event_manager.emit("flash.progress", {
                                "phase": "erase", "current": i + 1, "total": total_sectors,
                                "percent": round((i + 1) / total_sectors * 100, 2),
                                "unit": "sectors",
                            })
                        event_manager.emit("flash.progress", {
                            "phase": "erase", "current": total_sectors, "total": total_sectors, "percent": 100,
                            "unit": "sectors",
                        })
                finally:
                    flash.uninit()
            elif erase_type == "sector_range":
                # 范围擦除：遍历 address ~ address+size 内的所有扇区
                # 关键：需要找到每个地址所在的 region，用 region.sector_size 对齐
                from pyocd.core.memory_map import MemoryType

                flash_regions = [r for r in session.target.memory_map if r.type == MemoryType.FLASH]
                end_addr = address + size
                event_manager.log("info", f"Erasing sectors 0x{address:08X}~0x{end_addr:08X}...")

                # 按 region 分组擦除，避免每扇区 init/uninit
                # 先找出需要擦除的地址范围，按 region 分组
                region_sectors: dict[int, list[int]] = {}
                cur = address
                while cur < end_addr:
                    region = None
                    for r in flash_regions:
                        if r.start <= cur < r.start + r.length:
                            region = r
                            break
                    if not region:
                        event_manager.log("warning", f"No flash region at 0x{cur:08X}, skipping")
                        cur += 0x1000
                        continue

                    sector_size = region.sector_size
                    sector_aligned = region.start + ((cur - region.start) // sector_size) * sector_size
                    # 只擦除范围内的扇区（sector_aligned 可能越界）
                    if sector_aligned >= end_addr:
                        break
                    region_key = id(region)
                    if region_key not in region_sectors:
                        region_sectors[region_key] = []
                    region_sectors[region_key].append(sector_aligned)
                    cur = sector_aligned + sector_size

                total_sectors = sum(len(v) for v in region_sectors.values())
                erased = 0

                for region_key, sector_addrs in region_sectors.items():
                    # 找到对应的 region 对象
                    region = None
                    for r in flash_regions:
                        if id(r) == region_key:
                            region = r
                            break
                    if not region:
                        continue

                    flash = region.flash
                    flash.init(Flash.Operation.ERASE)
                    try:
                        for addr in sector_addrs:
                            flash.erase_sector(addr)
                            erased += 1
                            event_manager.emit("flash.progress", {
                                "phase": "erase", "current": erased, "total": total_sectors,
                                "percent": round(erased / total_sectors * 100, 2) if total_sectors > 0 else 100,
                                "unit": "sectors",
                            })
                    finally:
                        flash.uninit()

                event_manager.emit("flash.progress", {
                    "phase": "erase", "current": total_sectors, "total": total_sectors, "percent": 100,
                    "unit": "sectors",
                })
            else:
                event_manager.log("info", f"Erasing sector at 0x{address:08X}...")
                event_manager.emit("flash.progress", {
                    "phase": "erase", "current": 0, "total": 1, "percent": 0,
                    "unit": "operations",
                })
                # 扇区擦除
                flash.init(Flash.Operation.ERASE)
                try:
                    flash.erase_sector(address)
                finally:
                    flash.uninit()
                event_manager.emit("flash.progress", {
                    "phase": "erase", "current": 1, "total": 1, "percent": 100,
                    "unit": "operations",
                })

            duration = int((time.time() - start_time) * 1000)
            event_manager.log("info", f"Erase complete ({duration}ms)")
            return FlashResult(success=True, duration_ms=duration)
        except Exception as e:
            logger.exception("Erase failed")
            event_manager.log("error", f"Erase failed: {e}")
            return FlashResult(
                success=False,
                error=str(e),
                duration_ms=int((time.time() - start_time) * 1000),
            )

    def program(
        self,
        probe_uid: str,
        file_path: str,
        verify: bool = True,
        reset: bool = True,
        base_address: int | None = None,
        data: str = "",
    ) -> FlashResult:
        """烧录固件

        Args:
            file_path: 固件文件路径（与 data 二选一）
            data: base64 编码的固件数据（与 file_path 二选一）
            verify: 烧录后是否校验
            reset: 烧录后是否复位
            base_address: BIN 文件的烧录基地址
        """
        session = self._get_session(probe_uid)
        if not session:
            return FlashResult(success=False, error="Not connected")

        # 如果提供了 base64 数据，写入临时文件
        temp_path = None
        if data:
            import base64 as b64mod
            import tempfile
            try:
                raw = b64mod.b64decode(data)
                # 创建临时 .bin 文件
                fd, temp_path = tempfile.mkstemp(suffix='.bin', prefix='flash_data_')
                with os.fdopen(fd, 'wb') as f:
                    f.write(raw)
                file_path = temp_path
            except Exception as e:
                return FlashResult(success=False, error=f"Failed to decode data: {e}")
        elif not file_path or not os.path.exists(file_path):
            return FlashResult(success=False, error=f"File not found: {file_path}")

        start_time = time.time()
        file_size = os.path.getsize(file_path)

        try:
            from pyocd.flash.file_programmer import FileProgrammer

            event_manager.log("info", f"Programming {file_size} bytes from {os.path.basename(file_path)}...")

            # 确定文件格式和基地址
            ext = os.path.splitext(file_path)[1].lower()
            kwargs = {}
            if ext == ".bin":
                # BIN 文件需要指定基地址：优先使用用户传入的，回退到 boot_memory
                if base_address is not None:
                    kwargs["base_address"] = base_address
                else:
                    region = session.target.memory_map.get_boot_memory()
                    if region:
                        kwargs["base_address"] = region.start
                event_manager.log("info", f"BIN file, base address: 0x{kwargs.get('base_address', 0):08X}")

            # 计算实际数据大小（HEX/ELF 文件大小 ≠ 数据大小）
            data_segments = self._extract_file_data(session, file_path, ext)
            actual_data_size = sum(len(d) for _, d in data_segments) if data_segments else file_size

            # 烧录前先复位并暂停目标（与 pyocd flash CLI 的 pre_reset 行为一致）
            # 原因：目标可能正在运行用户代码，Flash 控制器状态未知，直接编程会失败
            session.target.reset_and_halt()

            # 第一阶段：擦除（chip erase 可能耗时较长，在前端展示 Erasing... 状态）
            event_manager.emit("flash.progress", {
                "phase": "erase", "current": 0, "total": actual_data_size, "percent": 0,
            })

            def progress_callback(percent: float):
                # FlashLoader 报告的是 0.0-1.0 的浮点数，前端需要 0-100 的百分比
                progress_pct = round(percent * 100, 2)
                event_manager.emit("flash.progress", {
                    "phase": "program",
                    "current": int(file_size * percent),
                    "total": file_size,
                    "percent": progress_pct,
                })

            # 使用 chip_erase="sector" 仅擦除需要编程的扇区
            # 原因：chip_erase="auto" 在已擦除的 Flash 上会跳过擦除，导致编程静默失败
            # chip_erase="chip" 全片擦除太慢（1MB Flash 约 10-15s），改为按需擦除
            programmer = FileProgrammer(session, progress=progress_callback, chip_erase="sector")

            # 注意：FileProgrammer.program() 不支持 verify 参数（pyOCD 0.44 的 FlashLoader.commit 中 verify 为 TODO）
            # 烧录后如需校验，调用独立的 verify() 方法
            programmer.program(file_path, **kwargs)

            # 第二阶段完成：发送 program 100% 确保进度条走到终点
            event_manager.emit("flash.progress", {
                "phase": "program", "current": actual_data_size, "total": actual_data_size, "percent": 100,
            })

            duration = int((time.time() - start_time) * 1000)
            speed_kbps = (file_size / 1024) / (duration / 1000) if duration > 0 else 0

            # 烧录后自动校验
            verify_ok = True
            if verify:
                event_manager.log("info", "Verifying...")
                event_manager.emit("flash.progress", {
                    "phase": "verify", "current": 0, "total": actual_data_size, "percent": 0,
                })
                verify_result = self.verify(probe_uid, file_path, base_address=base_address)
                verify_ok = verify_result.success
                if not verify_ok:
                    event_manager.log("error", f"Verify failed: {verify_result.error}")
                    return FlashResult(
                        success=False,
                        error=f"Verify failed: {verify_result.error}",
                        bytes_written=actual_data_size,
                        duration_ms=duration + verify_result.duration_ms,
                    )

            if reset:
                event_manager.log("info", "Reset and run")
                session.target.reset()

            event_manager.log("info", f"Done in {duration}ms ({speed_kbps:.1f} KB/s)")

            return FlashResult(
                success=True,
                bytes_written=actual_data_size,
                duration_ms=duration,
            )
        except Exception as e:
            logger.exception("Programming failed")
            event_manager.log("error", f"Programming failed: {e}")
            return FlashResult(
                success=False,
                error=str(e),
                duration_ms=int((time.time() - start_time) * 1000),
            )
        finally:
            # 清理临时文件
            if temp_path and os.path.exists(temp_path):
                try:
                    os.unlink(temp_path)
                except Exception:
                    pass

    def verify(self, probe_uid: str, file_path: str, data: str = "", base_address: int | None = None) -> FlashResult:
        """校验 Flash 内容：读取 Flash 并与文件/数据逐字节对比

        Args:
            file_path: 固件文件路径（与 data 二选一）
            data: base64 编码的固件数据（与 file_path 二选一）
            base_address: 数据的基地址（使用 data 时必须提供）
        """
        session = self._get_session(probe_uid)
        if not session:
            return FlashResult(success=False, error="Not connected")

        # 如果提供了 base64 数据，构造数据段
        temp_path = None
        segments = []
        if data:
            import base64 as b64mod
            try:
                raw = b64mod.b64decode(data)
                addr = base_address if base_address is not None else (session.target.memory_map.get_boot_memory().start if session.target.memory_map.get_boot_memory() else 0)
                segments = [(addr, raw)]
                event_manager.log("info", f"Verifying {len(raw)} bytes from memory data at 0x{addr:08X}...")
            except Exception as e:
                return FlashResult(success=False, error=f"Failed to decode data: {e}")
        elif not file_path or not os.path.exists(file_path):
            return FlashResult(success=False, error=f"File not found: {file_path}")

        start_time = time.time()
        try:
            # 停止目标，确保 Flash 读取稳定
            session.target.halt()

            if not segments:
                ext = os.path.splitext(file_path)[1].lower()
                event_manager.log("info", f"Verifying {ext} file...")

                # 提取文件中的数据段 [(address, data_bytes), ...]
                segments = self._extract_file_data(session, file_path, ext, base_address)
                if not segments:
                    return FlashResult(success=False, error="No data segments found in file")

            total_bytes = sum(len(d) for _, d in segments)
            verified_bytes = 0
            event_manager.emit("flash.progress", {
                "phase": "verify", "current": 0, "total": total_bytes, "percent": 0,
            })

            # 32KB 分块读取（v2 WinUSB 单次事务上限 ~8192 words = 32KB）
            # 4字节对齐时用 block32（比 block8 快 2-3 倍），非对齐回退 block8
            chunk_size = 32768
            for seg_addr, seg_data in segments:
                for offset in range(0, len(seg_data), chunk_size):
                    read_len = min(chunk_size, len(seg_data) - offset)
                    addr = seg_addr + offset

                    if addr % 4 == 0 and read_len % 4 == 0:
                        # block32 + array 转换：USB 传输量减半，速度提升 2-3 倍
                        words = session.target.read_memory_block32(addr, read_len // 4)
                        flash_data = array.array('I', words).tobytes()
                    else:
                        flash_data = bytes(session.target.read_memory_block8(addr, read_len))

                    file_chunk = seg_data[offset:offset + read_len]

                    if flash_data != file_chunk:
                        # 找到第一个不匹配的字节
                        for i in range(read_len):
                            if flash_data[i] != file_chunk[i]:
                                mismatch_addr = addr + i
                                event_manager.log("error",
                                    f"Verify failed at 0x{mismatch_addr:08X}: "
                                    f"expected 0x{file_chunk[i]:02X}, got 0x{flash_data[i]:02X}")
                                break
                        return FlashResult(
                            success=False,
                            error=f"Verification failed at 0x{mismatch_addr:08X}",
                            duration_ms=int((time.time() - start_time) * 1000),
                        )

                    verified_bytes += read_len
                    event_manager.emit("flash.progress", {
                        "phase": "verify",
                        "current": verified_bytes,
                        "total": total_bytes,
                        "percent": round(verified_bytes / total_bytes * 100, 2),
                    })

            event_manager.emit("flash.progress", {
                "phase": "verify", "current": total_bytes, "total": total_bytes, "percent": 100,
            })
            duration = int((time.time() - start_time) * 1000)
            event_manager.log("info", f"Verify OK ({total_bytes} bytes, {duration}ms)")
            return FlashResult(success=True, duration_ms=duration)
        except Exception as e:
            logger.exception("Verify failed")
            event_manager.log("error", f"Verify failed: {e}")
            return FlashResult(success=False, error=str(e))

    def _extract_file_data(self, session, file_path: str, ext: str, base_address: int | None = None) -> list[tuple[int, bytes]]:
        """从固件文件中提取数据段，返回 [(address, data_bytes), ...]"""
        if ext == ".bin":
            if base_address is not None:
                base_addr = base_address
            else:
                region = session.target.memory_map.get_boot_memory()
                base_addr = region.start if region else 0
            with open(file_path, 'rb') as f:
                data = f.read()
            return [(base_addr, data)]

        elif ext == ".hex":
            return self._parse_hex_data(file_path)

        elif ext in (".elf", ".axf"):
            return self._parse_elf_data(file_path, session)

        else:
            return []

    def _parse_hex_data(self, file_path: str) -> list[tuple[int, bytes]]:
        """解析 Intel HEX 文件，返回 [(address, data_bytes), ...]"""
        segments = []
        current_addr = 0
        base_addr = 0
        seg_start = None
        seg_data = bytearray()

        with open(file_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line or not line.startswith(":"):
                    continue

                data_str = line[1:]
                byte_count = int(data_str[0:2], 16)
                address = int(data_str[2:6], 16)
                record_type = int(data_str[6:8], 16)
                data_hex = data_str[8:8 + byte_count * 2]

                if record_type == 0:  # Data record
                    full_addr = base_addr + address
                    if seg_start is None:
                        seg_start = full_addr
                    elif full_addr != seg_start + len(seg_data):
                        # 地址不连续，保存当前段并开始新段
                        segments.append((seg_start, bytes(seg_data)))
                        seg_start = full_addr
                        seg_data = bytearray()
                    seg_data.extend(bytes.fromhex(data_hex))
                elif record_type == 4:  # Extended linear address
                    if seg_start is not None and seg_data:
                        segments.append((seg_start, bytes(seg_data)))
                        seg_start = None
                        seg_data = bytearray()
                    base_addr = int(data_str[8:12], 16) << 16
                elif record_type == 1:  # End of file
                    break

        if seg_start is not None and seg_data:
            segments.append((seg_start, bytes(seg_data)))

        return segments

    def _parse_elf_data(self, file_path: str, session=None) -> list[tuple[int, bytes]]:
        """解析 ELF/AXF 文件，返回 [(address, data_bytes), ...]

        仅提取落在 Flash 内存区域的 section，避免 verify 时比较 RAM 区域（如 .data）导致失败。
        """
        from elftools.elf.elffile import ELFFile

        # 收集所有 Flash 区域的地址范围
        flash_ranges = []
        if session is not None:
            for region in session.target.memory_map:
                # region.type 是 MemoryType 枚举，需取 .value 或用 is_flash 属性
                rtype = region.type
                is_flash = (getattr(rtype, 'value', str(rtype)) == 'flash'
                            or getattr(rtype, 'name', '') == 'FLASH'
                            or getattr(region, 'is_flash', False))
                if is_flash:
                    flash_ranges.append((region.start, region.start + region.length))

        segments = []
        with open(file_path, 'rb') as f:
            elf = ELFFile(f)
            for section in elf.iter_sections():
                if (section.header.sh_type == 'SHT_PROGBITS'
                        and section.header.sh_size > 0
                        and section.header.sh_flags & 0x2):  # SHF_ALLOC
                    sh_addr = section.header.sh_addr
                    sh_size = section.header.sh_size
                    # 如果有 Flash 区域信息，只保留落在 Flash 中的 section
                    if flash_ranges:
                        in_flash = any(start <= sh_addr < end for start, end in flash_ranges)
                        if not in_flash:
                            continue
                    data = section.data()
                    if data:
                        segments.append((sh_addr, data))
        return segments

    def fill_memory(
        self,
        probe_uid: str,
        address: int,
        size: int,
        value: int = 0xFF,
    ) -> FlashResult:
        """填充内存区域（支持 Flash 和 RAM）

        注意：当前前端 Fill Memory 功能已改为纯前端数据操作（仅在数据 Tab 中填充），
        不再调用此后端方法。此方法保留供未来可能的直接设备填充用途。

        Args:
            address: 起始地址
            size: 填充字节数
            value: 填充字节值 (0-255)
        """
        session = self._get_session(probe_uid)
        if not session:
            return FlashResult(success=False, error="Not connected")

        if size <= 0:
            return FlashResult(success=False, error="Size must be positive")
        if not (0 <= value <= 255):
            return FlashResult(success=False, error="Value must be 0-255")

        start_time = time.time()
        try:
            data = bytes([value]) * size

            # 判断目标地址是 Flash 还是 RAM
            region = session.target.memory_map.get_region_for_address(address)
            if region and region.is_flash:
                # Flash：使用 FlashLoader（自动处理擦除+编程）
                from pyocd.flash.flash_loader import FlashLoader
                event_manager.log("info", f"Filling flash 0x{address:08X}..0x{address + size - 1:08X} with 0x{value:02X}")

                # 填充前先复位并暂停目标（与 program 函数的 pre_reset 行为一致）
                # 原因：目标可能正在运行用户代码，Flash 控制器状态未知，直接编程会失败
                session.target.reset_and_halt()

                # 分块处理（避免大块内存占用）
                # 注意：FlashLoader 需要传入 session（提供 .board/.options），传入 session.target
                # 会因缺少 .board/.options 属性导致 AttributeError（参照 program 函数 FileProgrammer(session, ...) 用法）
                CHUNK_SIZE = 0x10000  # 64KB
                loader = FlashLoader(session)
                for offset in range(0, size, CHUNK_SIZE):
                    chunk = data[offset:offset + CHUNK_SIZE]
                    loader.add_data(address + offset, chunk)
                    event_manager.emit("flash.progress", {
                        "phase": "fill",
                        "current": offset + len(chunk),
                        "total": size,
                        "percent": round((offset + len(chunk)) / size * 100, 2),
                    })
                loader.commit()
            else:
                # RAM：直接写入
                event_manager.log("info", f"Filling RAM 0x{address:08X}..0x{address + size - 1:08X} with 0x{value:02X}")
                CHUNK_SIZE = 0x10000  # 64KB
                for offset in range(0, size, CHUNK_SIZE):
                    chunk = data[offset:offset + CHUNK_SIZE]
                    session.target.write_memory_block8(address + offset, chunk)
                    event_manager.emit("flash.progress", {
                        "phase": "fill",
                        "current": offset + len(chunk),
                        "total": size,
                        "percent": round((offset + len(chunk)) / size * 100, 2),
                    })

            duration = int((time.time() - start_time) * 1000)
            event_manager.log("info", f"Fill done in {duration}ms ({size / 1024:.1f} KB)")
            return FlashResult(success=True, bytes_written=size, duration_ms=duration)
        except Exception as e:
            logger.exception("Fill memory failed")
            event_manager.log("error", f"Fill memory failed: {e}")
            return FlashResult(success=False, error=str(e))

    def check_blank(
        self,
        probe_uid: str,
        address: int | None = None,
        size: int | None = None,
    ) -> dict:
        """检查 Flash 是否为空白（全 0xFF）

        优化策略（对标 STM32CubeProgrammer <10s 方案）：
        1. 提升 SWD 频率至 ST-LINK 支持的最高值（4.6MHz V2 / 9MHz V3）
        2. 使用 read_memory_block32 批量读取（比 block8 快 2-3 倍），4字节对齐时自动启用
        3. 大块读取（32KB = 8192 words），仅每 5% 发送一次进度事件
        4. 空白检查用 data.count(0xFF) == len(data)（C 级，O(n) 但常数极小）
        5. 提前终止：找到首个非 0xFF 字节即停止扫描（非空场景下节省绝大部分读取时间）

        Args:
            address: 起始地址，None 则从 flash 起始
            size: 检查大小，None 则检查整个 flash
        Returns:
            dict: success, is_blank, blank_bytes, total_bytes, scanned_bytes,
                  first_nonblank_addr, early_terminated, duration_ms
        """
        session = self._get_session(probe_uid)
        if not session:
            return {"success": False, "error": "Not connected"}

        start_time = time.time()
        try:
            from pyocd.core.memory_map import MemoryType

            flash_regions = [r for r in session.target.memory_map if r.type == MemoryType.FLASH]
            if not flash_regions:
                return {"success": False, "error": "No flash memory found"}

            # 确定检查范围
            if address is not None and size is not None:
                regions_to_check = []
                for r in flash_regions:
                    if r.start + r.length > address and r.start < address + size:
                        regions_to_check.append(r)
            else:
                regions_to_check = flash_regions

            # reset_and_halt 确保目标处于已知状态，避免用户代码干扰 Flash 读取
            session.target.reset_and_halt()

            total_bytes = 0
            scanned_bytes = 0
            blank_bytes = 0
            first_nonblank_addr = None
            early_terminated = False
            chunk_words = 8192  # 8192 words = 32KB per chunk — block32 最优批量大小

            # 计算总大小用于进度
            check_total = 0
            for region in regions_to_check:
                if address is not None and size is not None:
                    start = max(region.start, address)
                    end = min(region.start + region.length, address + size)
                    check_total += max(0, end - start)
                else:
                    check_total += region.length

            event_manager.log("info", f"Check blank: {check_total} bytes, {len(regions_to_check)} region(s)")
            event_manager.emit("flash.progress", {
                "phase": "blank", "current": 0, "total": check_total, "percent": 0,
            })

            last_progress_pct = -1

            for region in regions_to_check:
                start = max(region.start, address) if address else region.start
                end = min(region.start + region.length, address + size) if (address and size) else region.start + region.length
                region_total = end - start

                offset = 0
                while offset < region_total:
                    if self._check_cancel():
                        event_manager.emit("flash.progress", {
                            "phase": "blank", "current": total_bytes, "total": check_total, "percent": 100,
                        })
                        event_manager.log("warning", f"Check blank cancelled at {total_bytes} bytes")
                        return {"success": False, "error": "Cancelled", "duration_ms": int((time.time() - start_time) * 1000)}

                    # block32 读取（比 block8 快 2-3 倍），非对齐地址/长度回退 block8
                    read_bytes = min(chunk_words * 4, region_total - offset)
                    addr = start + offset
                    if addr % 4 == 0 and read_bytes % 4 == 0:
                        words = session.target.read_memory_block32(addr, read_bytes // 4)
                        data = array.array('I', words).tobytes()
                    else:
                        data = session.target.read_memory_block8(addr, read_bytes)

                    # C 级操作：count(0xFF) 是 bytearray 的内置 C 方法，极快
                    ff_count = data.count(0xFF)

                    if ff_count == len(data):
                        # 整块全 0xFF — 最快路径，无需 Python 循环
                        blank_bytes += len(data)
                    else:
                        # 有非 0xFF 字节 — 需要找到位置
                        blank_bytes += ff_count
                        if first_nonblank_addr is None:
                            # Python 循环仅在非空白块中执行（罕见路径）
                            for i in range(len(data)):
                                if data[i] != 0xFF:
                                    first_nonblank_addr = start + offset + i
                                    break
                            # 提前终止：已找到首个非空地址，无需继续扫描剩余 Flash
                            # 非空场景下可节省绝大部分 SWD 读取时间
                            early_terminated = True
                            total_bytes += read_bytes
                            scanned_bytes = total_bytes
                            break

                    total_bytes += read_bytes
                    scanned_bytes = total_bytes
                    offset += read_bytes

                    # 减少进度事件频率：仅在百分比变化 >= 5% 时发送
                    pct = round(total_bytes / check_total * 100, 2) if check_total > 0 else 100
                    if pct >= last_progress_pct + 5 or pct >= 100:
                        last_progress_pct = pct
                        event_manager.emit("flash.progress", {
                            "phase": "blank",
                            "current": total_bytes,
                            "total": check_total,
                            "percent": pct,
                        })

                # 提前终止时跳出外层 region 循环，不再扫描剩余 region
                if early_terminated:
                    break

            is_blank = (first_nonblank_addr is None)
            duration = int((time.time() - start_time) * 1000)
            event_manager.emit("flash.progress", {
                "phase": "blank", "current": total_bytes, "total": total_bytes, "percent": 100,
            })

            if is_blank:
                event_manager.log("info", f"Check blank: PASSED ({total_bytes} bytes all 0xFF, {duration}ms)")
            else:
                pct_scanned = round(scanned_bytes / check_total * 100, 1) if check_total > 0 else 100
                event_manager.log("info", f"Check blank: FAILED (first non-blank at 0x{first_nonblank_addr:08X}, scanned {scanned_bytes}/{check_total} bytes ({pct_scanned}%), {duration}ms)")

            return {
                "success": True,
                "is_blank": is_blank,
                "blank_bytes": blank_bytes,
                "total_bytes": total_bytes,
                "scanned_bytes": scanned_bytes,
                "first_nonblank_addr": first_nonblank_addr,
                "early_terminated": early_terminated,
                "duration_ms": duration,
            }
        except Exception as e:
            logger.exception("Check blank failed")
            event_manager.log("error", f"Check blank failed: {e}")
            return {"success": False, "error": str(e), "duration_ms": int((time.time() - start_time) * 1000)}

    def read_back(
        self,
        probe_uid: str,
        read_type: str = "chip",
        address: int = 0,
        size: int = 0,
        output_path: str = "",
    ) -> dict:
        """读取 Flash 内容，返回 base64 编码数据

        使用 read_memory_block32 批量读取（4字节对齐），比 block8 快 2-3 倍。
        Flash 起始地址和大小总是 4 字节对齐，可安全使用 block32。

        Args:
            read_type: "chip" 遍历所有 flash region，"range"/"sectors" 读取指定范围
            address: 起始地址（range/sectors 模式）
            size: 读取大小（range/sectors 模式）
            output_path: 可选，如果提供则同时保存到文件
        Returns:
            dict: success, base64_data, base_address, bytes_read, duration_ms
        """
        session = self._get_session(probe_uid)
        if not session:
            return {"success": False, "error": "Not connected"}

        start_time = time.time()
        try:
            import base64
            import struct
            from pyocd.core.memory_map import MemoryType

            flash_regions = [r for r in session.target.memory_map if r.type == MemoryType.FLASH]
            if not flash_regions:
                return {"success": False, "error": "No flash memory found"}

            # reset_and_halt 确保目标处于已知状态，避免用户代码干扰 Flash 读取
            session.target.reset_and_halt()

            # chunk_words: 每次 read_memory_block32 调用的 word 数
            # v2 (WinUSB 512B packet, 64 packets): 单次事务最多 ~8000 words，用 8192 接近上限
            # v1 (HID 64B packet, 4 packets): 单次事务最多 ~60 words，但 pyOCD 内部会自动分包
            chunk_words = 8192  # 8192 words = 32KB per chunk
            total_read = 0
            all_data = bytearray()

            def read_block32(addr: int, byte_len: int) -> bytes:
                """用 block32 读取，返回 bytes。byte_len 自动向下对齐到 4 字节。"""
                word_count = byte_len // 4
                if word_count == 0:
                    return b''
                words = session.target.read_memory_block32(addr, word_count)
                # 用 array 批量转换，比 struct.pack 快 3-5 倍（避免 Python 函数调用开销）
                import array
                arr = array.array('I', words)
                return arr.tobytes()

            if read_type == "chip":
                # 遍历所有 flash region
                base_addr = flash_regions[0].start
                total_size = sum(r.length for r in flash_regions)

                event_manager.log("info", f"Read back entire chip: {total_size} bytes, {len(flash_regions)} region(s)")
                event_manager.emit("flash.progress", {
                    "phase": "read", "current": 0, "total": total_size, "percent": 0,
                })

                for region in flash_regions:
                    offset = 0
                    while offset < region.length:
                        if self._check_cancel():
                            event_manager.emit("flash.progress", {
                                "phase": "read", "current": total_read, "total": total_size, "percent": 100,
                            })
                            event_manager.log("warning", f"Read back cancelled at {total_read} bytes")
                            return {"success": False, "error": "Cancelled", "duration_ms": int((time.time() - start_time) * 1000)}

                        read_bytes = min(chunk_words * 4, region.length - offset)
                        data = read_block32(region.start + offset, read_bytes)
                        all_data.extend(data)
                        total_read += len(data)
                        offset += read_bytes
                        event_manager.emit("flash.progress", {
                            "phase": "read",
                            "current": total_read,
                            "total": total_size,
                            "percent": round(total_read / total_size * 100, 2),
                        })
            else:
                # range / sectors 模式：从 address 读取 size 字节
                base_addr = address
                total_size = size

                event_manager.log("info", f"Read back range: 0x{address:08X} ~ 0x{address + size:08X} ({size} bytes)")
                event_manager.emit("flash.progress", {
                    "phase": "read", "current": 0, "total": total_size, "percent": 0,
                })

                offset = 0
                while offset < size:
                    if self._check_cancel():
                        event_manager.emit("flash.progress", {
                            "phase": "read", "current": total_read, "total": total_size, "percent": 100,
                        })
                        event_manager.log("warning", f"Read back cancelled at {total_read} bytes")
                        return {"success": False, "error": "Cancelled", "duration_ms": int((time.time() - start_time) * 1000)}

                    read_bytes = min(chunk_words * 4, size - offset)
                    data = read_block32(address + offset, read_bytes)
                    all_data.extend(data)
                    total_read += len(data)
                    offset += read_bytes
                    event_manager.emit("flash.progress", {
                        "phase": "read",
                        "current": total_read,
                        "total": total_size,
                        "percent": round(total_read / total_size * 100, 2),
                    })

            event_manager.emit("flash.progress", {
                "phase": "read", "current": total_read, "total": total_read, "percent": 100,
            })

            # 可选：同时保存到文件
            if output_path:
                with open(output_path, "wb") as f:
                    f.write(bytes(all_data))

            duration = int((time.time() - start_time) * 1000)
            speed_kbps = (total_read / 1024) / (duration / 1000) if duration > 0 else 0
            event_manager.log("info", f"Read back {total_read} bytes from 0x{base_addr:08X} ({duration}ms, {speed_kbps:.1f} KB/s)")
            return {
                "success": True,
                "base64_data": base64.b64encode(bytes(all_data)).decode("ascii"),
                "base_address": base_addr,
                "bytes_read": total_read,
                "duration_ms": duration,
            }
        except Exception as e:
            logger.exception("Read back failed")
            event_manager.log("error", f"Read back failed: {e}")
            return {"success": False, "error": str(e), "duration_ms": int((time.time() - start_time) * 1000)}

    def reset(self, probe_uid: str, reset_type: str = "hw", run: bool = True) -> bool:
        """复位目标"""
        session = self._get_session(probe_uid)
        if not session:
            return False

        try:
            event_manager.log("info", f"Reset ({reset_type}, {'run' if run else 'halt'})")
            if reset_type == "hw":
                session.probe.reset()
            else:
                session.target.reset()

            if run:
                session.target.resume()

            event_manager.log("info", f"Reset done")
            return True
        except Exception as e:
            event_manager.log("error", f"Reset failed: {e}")
            return False

    def read_memory(self, probe_uid: str, address: int, size: int) -> bytes:
        """读取内存（自动 halt，通过内存缓存层）"""
        session = self._get_session(probe_uid)
        if not session:
            raise RuntimeError("Not connected")

        session.target.halt()
        return bytes(session.target.read_memory_block8(address, size))

    def get_op_lock(self, probe_uid: str) -> threading.Lock:
        """获取该探针的调试/刷新协调锁（per-UID，惰性创建）。

        用户调试操作（halt/step/continue/reset 等，经 commander_backend）持有该锁
        （阻塞获取）；周期刷新（read_memory_direct / 外设寄存器读取）try-acquire，
        获取不到直接跳过，保证调试操作不被周期性刷新并发访问 pyOCD target 影响。
        """
        with self._op_locks_guard:
            lock = self._op_locks.get(probe_uid)
            if lock is None:
                lock = threading.Lock()
                self._op_locks[probe_uid] = lock
            return lock

    def read_memory_direct(self, probe_uid: str, address: int, size: int) -> Optional[bytes]:
        """直接读取内存（不 halt、不经过缓存层），仅适用于目标已暂停场景。

        与 read_memory 的区别：
          - 不调用 session.target.halt()：避免在已暂停目标上产生不必要的状态变更
          - 通过 core 的 AP 直接读取，绕过 MemoryCache 缓存层，确保返回最新值
          - try-acquire 协调锁：用户调试操作（halt/step/continue/reset）执行期间
            返回 None，调用方跳过本轮刷新，避免与调试操作并发访问 pyOCD target
        """
        lock = self.get_op_lock(probe_uid)
        if not lock.acquire(blocking=False):
            return None
        try:
            session = self._get_session(probe_uid)
            if not session:
                raise RuntimeError("Not connected")
            core = session.target.selected_core_or_raise
            return bytes(core.read_memory_block8(address, size))
        finally:
            lock.release()

    def write_memory_direct(self, probe_uid: str, address: int, data: bytes) -> None:
        """直接写内存（不 halt、不经过缓存层），仅适用于目标已暂停场景。

        与 read_memory_direct 对称：通过 core 的 AP 直接写入，绕过 MemoryCache 缓存层，
        避免写入后缓存仍返回旧值导致回显不一致。
        """
        session = self._get_session(probe_uid)
        if not session:
            raise RuntimeError("Not connected")
        core = session.target.selected_core_or_raise
        core.write_memory_block8(address, data)

    def write_core_register(self, probe_uid: str, name: str, value: int) -> None:
        """写核心寄存器（仅目标暂停时有效）。"""
        session = self._get_session(probe_uid)
        if not session:
            raise RuntimeError("Not connected")
        core = session.target.selected_core_or_raise
        core.write_core_register(name.lower(), value)

    # ── 清理 ──────────────────────────────────────────────

    def cleanup(self):
        """关闭所有会话"""
        with self._lock:
            uids = list(self._sessions.keys())

        for uid in uids:
            self.disconnect(uid)


# 全局单例
backend = PyOCDBackend()
