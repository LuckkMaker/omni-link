"""Monitor 后端：下位机变量实时监控与采样

对标 STM32CubeMonitor Direct 模式 + J-Scope，通过 SWD 非侵入读取目标 RAM 变量，
后台采样线程按固定频率批量读取，通过 WebSocket 推送到前端波形显示。

核心约束：
- 采样线程直接调用 session.target.read_memory_block8/block32，绝不调用 target.halt()，
  避免暂停 CPU（现有 PyOCDBackend.read_memory 会 halt，不能复用）。
- 多变量按地址排序后合并邻近地址为批量读，减少 SWD 事务开销。
- 与 RTT 互斥运行（同一探针下两者只能运行其一），避免 SWD 并发冲突。
- Flash/Commander 操作时自动暂停采样，操作完成后恢复。
"""

import time
import struct
import array
import threading
import logging
from typing import Optional
from collections import deque
from dataclasses import dataclass, field

from core.pyocd_backend import backend
from core.events import event_manager

# pyOCD AP/DP 寄存器级常量（用于跨 Block 流水线批量读）
# 借鉴 plink: 直接操作 AP/DP 层，将多个 Block 的 DAP 命令一次 flush 发出，
# 减少 USB 往返次数（deferred_transfers=True 时命令先缓冲、flush 才发送）。
try:
    from pyocd.coresight.ap import (
        MEM_AP_CSW,
        MEM_AP_TAR,
        MEM_AP_DRW,
        CSW_SIZE32,
        DEFAULT_CSW_VALUE,
    )
except Exception:  # pragma: no cover - 编译环境可能无 pyocd，运行时有
    MEM_AP_CSW = 0x00
    MEM_AP_TAR = 0x04
    MEM_AP_DRW = 0x0C
    CSW_SIZE32 = 0x00000002
    DEFAULT_CSW_VALUE = 0x00000010

logger = logging.getLogger(__name__)

# 数据类型 -> (struct 格式, 字节大小)
TYPE_MAP = {
    "int8":   ("<b", 1),
    "uint8":  ("<B", 1),
    "int16":  ("<h", 2),
    "uint16": ("<H", 2),
    "int32":  ("<i", 4),
    "uint32": ("<I", 4),
    "float":  ("<f", 4),
}

# 批量读合并阈值：相邻变量地址间隔 <= 此值时合并为一次 USB 事务（字节）
# 64KB：合并条件退化为纯 Block 大小约束（"带宽换时间"，USB 延迟与往返次数
# 成正比、与数据量几乎无关），变量分散时也能聚成少量 Block。
MERGE_GAP = 64 * 1024
# Block 覆盖字节上限（按探针传输类型区分，避免单个 Block 过大）
# - Bulk (CMSIS-DAP v2 / WinUSB)：单包可携带更多命令，2048B = 512 words
# - HID (CMSIS-DAP v1)：包小，1024B 更稳妥
# - unknown：保守 512B
BLOCK_MAX_BYTES_BULK = 2048
BLOCK_MAX_BYTES_HID = 1024
BLOCK_MAX_BYTES_DEFAULT = 512
# Block 最小有效载荷比例：合并后有效变量字节 / 覆盖总字节 低于此值则不合并，
# 避免为少量变量读取大段无关 RAM（防止带宽浪费）
MIN_PAYLOAD_RATIO = 0.20
# 高频推送批量阈值：当待推送样本数达到此值时打包一次 WS 推送
PUSH_BATCH = 8
# 错误退避上限
MAX_BACKOFF = 0.5


@dataclass
class MonitoredVariable:
    """被监视的变量"""
    id: str
    name: str
    address: int
    type: str               # int8/uint8/int16/uint16/int32/uint32/float
    size: int               # 字节数
    remark: str = ""        # 用户备注
    refresh_sec: float = 0  # 独立刷新周期（0=跟随全局采样率）


@dataclass
class SamplePoint:
    """单个采样点"""
    t_ms: float             # 相对采样起点的毫秒时间戳
    values: dict            # {var_id: value}


class RingBuffer:
    """环形缓冲区，存储最近 N 个采样点

    高频采样时自动覆盖最旧数据。支持暂停后回看、CSV 导出。
    """

    def __init__(self, max_points: int = 100000):
        self._buf: deque = deque(maxlen=max_points)
        self._lock = threading.Lock()

    def push(self, t_ms: float, values: dict):
        with self._lock:
            self._buf.append(SamplePoint(t_ms, values))

    def get_recent(self, n: int) -> list:
        """获取最近 n 个采样点"""
        with self._lock:
            n = min(n, len(self._buf))
            return list(self._buf)[-n:] if n > 0 else []

    def get_all(self) -> list:
        with self._lock:
            return list(self._buf)

    def clear(self):
        with self._lock:
            self._buf.clear()

    def __len__(self):
        with self._lock:
            return len(self._buf)


class MonitorBackend:
    """Monitor 采样后端

    为每个探针维护一个采样线程。线程安全：每探针一把锁，协调读/写变量与采样。
    """

    def __init__(self):
        # uid -> 变量列表
        self._variables: dict[str, list[MonitoredVariable]] = {}
        # uid -> 采样线程
        self._threads: dict[str, threading.Thread] = {}
        # uid -> 运行标志（Event，set=运行中）
        self._running: dict[str, threading.Event] = {}
        # uid -> 暂停标志（Event，set=未暂停；clear=已暂停）
        self._paused: dict[str, threading.Event] = {}
        # uid -> 锁（保护变量列表与采样协调）
        self._locks: dict[str, threading.Lock] = {}
        # uid -> 采样率
        self._rate_hz: dict[str, float] = {}
        # uid -> 实际采样率（每秒实际采样次数，用于诊断 HSS 性能瓶颈）
        self._actual_rate_hz: dict[str, float] = {}
        # uid -> 采样计数器与时间戳（用于计算 actual_rate）
        self._sample_counter: dict[str, int] = {}
        self._sample_counter_time: dict[str, float] = {}
        # uid -> RingBuffer
        self._ring_buffers: dict[str, RingBuffer] = {}
        # uid -> ELF 符号解码器（缓存）
        self._elf_decoders: dict[str, object] = {}
        # uid -> ELF 文件句柄（保持打开以复用 decoder）
        self._elf_files: dict[str, object] = {}
        # uid -> DWARF 信息对象（elftools DwarfInfo，保持引用避免被回收）
        self._dwarf_info: dict[str, object] = {}
        # uid -> {符号名 -> 类型信息} 缓存（load_elf 时一次性构建，get_symbols 查表）
        # 类型信息: {is_array, elem_type, elem_count, elem_size}
        self._dwarf_cache: dict[str, dict] = {}
        # uid -> 已加载 ELF 文件的 mtime（用于检测文件变化提醒重载）
        self._elf_mtimes: dict[str, float] = {}
        # uid -> 已加载 ELF 文件路径（用于检测文件变化）
        self._elf_paths: dict[str, str] = {}
        # uid -> 采样起点（monotonic）
        self._start_time: dict[str, float] = {}
        # uid -> 暂停起始时间（monotonic），用于恢复时消除时间间隙
        self._pause_start: dict[str, float] = {}
        # uid -> 传输模式（"swd" 轮询 / "rtt" 同步）
        self._transport: dict[str, str] = {}
        # uid -> RTT 模式下的 RTTControlBlock（直接持有，避免与 rtt_backend 的 poll loop 争抢）
        self._rtt_cbs: dict[str, object] = {}
        # uid -> 缓存的变量分组（排序+合并后的结构，避免每帧重复排序）
        self._vars_cache: dict[str, tuple] = {}
        # uid -> 变量列表版本号（add/remove 时递增，用于缓存失效）
        self._vars_version: dict[str, int] = {}
        # uid -> 探针传输类型缓存（"bulk" / "hid" / "unknown"），用于选择 Block 合并参数
        self._transport_type: dict[str, str] = {}
        # uid -> 流水线读取降级标志：失败一次即置 True，后续走串行读取
        # （防止"每帧尝试流水线失败 + 整批串行重读"的双倍开销导致采样率暴跌）
        self._pipeline_disabled: dict[str, bool] = {}
        # AP 对象 id -> 已写入的 CSW 值（缓存避免每帧重复写 CSW + DP SELECT）
        self._pipelined_csw: dict[int, int] = {}
        # 全局锁，保护字典操作
        self._global_lock = threading.Lock()

    # ── 采样控制 ──────────────────────────────────────────────

    def start(self, uid: str, rate_hz: float = 1000.0,
              max_points: int = 100000, transport: str = "swd") -> dict:
        """启动采样

        Args:
            rate_hz: 采样率（Hz）
            max_points: RingBuffer 容量
            transport: 传输模式
                - "swd": SWD 轮询采样（HSS 异步模式，host 主动读 RAM）
                - "rtt": RTT 同步模式（固件按节拍把采样数据写入 RTT up channel，
                  host 读取并解析数据帧）
        """
        # 互斥检查：同一探针下 RTT 与 Monitor 不能同时运行
        try:
            from core.rtt_backend import rtt_backend
            if rtt_backend.is_running(uid):
                return {"success": False,
                        "error": "RTT 正在运行，请先停止 RTT 再启动 Monitor 采样"}
        except Exception:
            pass

        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接"}

        # 兜底：确保内核处于运行状态。
        # connect() 使用 init_board=False，pyOCD 在 sess.open() 阶段会 halt 内核做
        # CoreSight 发现，但因不执行 board.init() 的 resume 流程，内核会停留在 halt。
        # 此外 Flash/Commander 的 erase/verify/check_blank/read_back 等操作 halt 后
        # 也不 resume。这些都会导致固件主循环不执行、监视变量值冻结不变化。
        # Monitor 本身是非侵入运行时监控，启动采样前必须保证内核在跑。
        try:
            session.target.resume()
            event_manager.log("info", "Monitor: 启动前确认内核运行状态（resume 兜底）")
        except Exception as e:
            event_manager.log("warning", f"Monitor: 启动前 resume 内核失败（可能已在运行）: {e}")

        with self._global_lock:
            # 已在运行则先停止
            if uid in self._running and self._running[uid].is_set():
                self._stop_internal(uid)

            self._rate_hz[uid] = rate_hz
            self._actual_rate_hz[uid] = 0.0
            self._sample_counter[uid] = 0
            self._sample_counter_time[uid] = time.perf_counter()
            self._ring_buffers[uid] = RingBuffer(max_points)
            self._transport[uid] = transport
            # 新采样会话：重置流水线降级标志，给流水线读取一次机会
            self._pipeline_disabled.pop(uid, None)
            # 清空 CSW 缓存：确保新会话首帧重写 CSW（其他探针受影响也仅多写一次，无害）
            self._pipelined_csw.clear()
            running = threading.Event()
            running.set()
            self._running[uid] = running
            paused = threading.Event()
            paused.set()  # 初始未暂停
            self._paused[uid] = paused
            self._locks[uid] = threading.Lock()
            self._start_time[uid] = time.perf_counter()

        variables = self._variables.get(uid, [])
        event_manager.log("info",
                          f"Monitor: 启动采样 (rate={rate_hz}Hz, vars={len(variables)}, "
                          f"transport={transport}, probe_transport={self._get_transport_type(uid)})")
        event_manager.emit("monitor.started", {
            "uid": uid,
            "rate_hz": rate_hz,
            "transport": transport,
            "variables": [self._var_to_dict(v) for v in variables],
        })

        # 按 transport 分派采样线程：rtt 走 RTT 同步解析循环，否则走 SWD 轮询循环
        if transport == "rtt":
            target_loop = self._rtt_sample_loop
        else:
            target_loop = self._sample_loop

        thread = threading.Thread(target=target_loop, args=(uid,), daemon=True,
                                  name=f"monitor-{uid[:8]}")
        with self._global_lock:
            self._threads[uid] = thread
        thread.start()

        return {"success": True, "rate_hz": rate_hz, "transport": transport}

    def stop(self, uid: str) -> dict:
        """停止采样"""
        with self._global_lock:
            self._stop_internal(uid)
        event_manager.log("info", "Monitor: 采样已停止")
        event_manager.emit("monitor.stopped", {"uid": uid, "reason": "user"})
        return {"success": True}

    def _stop_internal(self, uid: str):
        """内部停止（不加锁，调用方持有全局锁）

        关键：先通知线程退出并等待其结束，再清理共享字典。
        若先 pop 字典再 clear running，采样线程可能在 _start_time 被 pop 后
        仍读取到默认值 t0，产生 t_ms=0 的异常样本，导致波形横向回到起点。
        """
        # 1) 先通知采样线程退出
        running = self._running.get(uid)
        if running:
            running.clear()
        # 2) 等待线程退出（此时线程仍能读到正确的 _start_time 等共享状态）
        thread = self._threads.get(uid)
        if thread:
            thread.join(timeout=2)
        # 3) 线程已退出，安全清理所有共享字典
        self._running.pop(uid, None)
        self._threads.pop(uid, None)
        self._paused.pop(uid, None)
        self._locks.pop(uid, None)
        self._rate_hz.pop(uid, None)
        self._start_time.pop(uid, None)
        self._pause_start.pop(uid, None)
        self._transport.pop(uid, None)
        # 保留 ring_buffer 供回看，直到下次 start 或探针断开
        # RTT 模式：线程退出后兜底清理控制块（正常退出时线程已在 finally 清理）
        cb = self._rtt_cbs.pop(uid, None)
        if cb is not None:
            try:
                if hasattr(cb, "stop"):
                    cb.stop()
            except Exception:
                pass

    def pause(self, uid: str):
        """暂停采样（Flash/Commander 操作前调用）

        采样线程保持运行但跳过实际读取，保留会话状态。
        记录暂停起始时间，供 resume() 消除时间间隙。
        """
        paused = self._paused.get(uid)
        if paused and paused.is_set():
            paused.clear()
            self._pause_start[uid] = time.perf_counter()
            event_manager.emit("monitor.info", {
                "uid": uid, "paused": True, "reason": "flash/commander 操作",
            })

    def resume(self, uid: str):
        """恢复采样

        调整 _start_time 以消除暂停期间的时间间隙，使恢复后采样时间戳
        连续递进（对标 JScope：暂停不推进时间轴）。

        关键：必须先更新 start_time，再解除暂停标志。
        若先 paused.set() 再更新 start_time，采样线程可能在 start_time
        更新前读取旧值，产生包含暂停时长的时间戳，导致时间间隙和值畸变。
        """
        paused = self._paused.get(uid)
        if paused and not paused.is_set():
            # 1) 先调整 start_time，消除暂停期间的时间间隙
            #    这样恢复后的 t_ms = (now - start_time) * 1000 不包含暂停时长
            pause_start = self._pause_start.pop(uid, None)
            if pause_start is not None:
                pause_duration = time.perf_counter() - pause_start
                start_time = self._start_time.get(uid)
                if start_time is not None:
                    self._start_time[uid] = start_time + pause_duration
            # 2) 再解除暂停标志，此时 start_time 已更新，采样线程读到的是正确值
            paused.set()
            event_manager.emit("monitor.info", {"uid": uid, "paused": False})

    def pause_during(self, uid: str):
        """上下文管理器：在 Flash/Commander 等独占操作期间自动暂停/恢复采样

        用法：
            with monitor_backend.pause_during(uid):
                await asyncio.to_thread(backend.erase, ...)
        """
        import contextlib

        @contextlib.contextmanager
        def _ctx():
            was_running = self.is_running(uid)
            if was_running and not self.is_paused(uid):
                self.pause(uid)
                try:
                    yield
                finally:
                    self.resume(uid)
            else:
                yield

        return _ctx()

    def is_running(self, uid: str) -> bool:
        running = self._running.get(uid)
        return running is not None and running.is_set()

    def is_paused(self, uid: str) -> bool:
        paused = self._paused.get(uid)
        return paused is not None and not paused.is_set()

    # ── 目标设备控制（Run/Halt/Reset）─────────────────────────
    # 直接操作 session.target，不暂停采样线程。
    # Run/Halt/Reset 是毫秒级操作，采样线程的 SWD 读取有错误恢复机制，
    # 短暂冲突由采样线程的 consecutive_errors 退避处理。

    def run_target(self, uid: str) -> dict:
        """运行目标内核（resume）"""
        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接"}
        try:
            session.target.resume()
            event_manager.log("info", f"Monitor: 目标内核已运行 (run)")
            return {"success": True, "state": "running"}
        except Exception as e:
            event_manager.log("warning", f"Monitor: run 目标失败: {e}")
            return {"success": False, "error": str(e)}

    def halt_target(self, uid: str) -> dict:
        """暂停目标内核（halt）"""
        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接"}
        try:
            session.target.halt()
            event_manager.log("info", f"Monitor: 目标内核已暂停 (halt)")
            return {"success": True, "state": "halted"}
        except Exception as e:
            event_manager.log("warning", f"Monitor: halt 目标失败: {e}")
            return {"success": False, "error": str(e)}

    def reset_target(self, uid: str, run: bool = True) -> dict:
        """复位目标芯片

        Args:
            run: True=复位后运行，False=复位后保持 halt
        """
        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接"}
        try:
            session.target.reset(reset_type=None)
            if run:
                session.target.resume()
            event_manager.log("info",
                              f"Monitor: 目标已复位 (reset, run={run})")
            state = "running" if run else "halted"
            return {"success": True, "state": state}
        except Exception as e:
            event_manager.log("warning", f"Monitor: reset 目标失败: {e}")
            return {"success": False, "error": str(e)}

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

    # ── 采样循环 ──────────────────────────────────────────────

    def _sample_loop(self, uid: str):
        """采样线程主循环

        按固定频率批量读取所有变量，推送到前端并写入 RingBuffer。
        """
        rate = self._rate_hz.get(uid, 1000.0)
        interval = 1.0 / rate if rate > 0 else 0.01
        # 推送批量阈值：随采样率动态放大，把 WS 消息数控制在 ~rate/batch 条/秒
        # （5kHz -> 100 条/s，1kHz -> 20 条/s），减少 JSON 序列化与前端消息处理开销
        push_batch = max(PUSH_BATCH, int(rate // 50))
        consecutive_errors = 0
        pending_samples: list = []  # 批量推送缓冲
        last_t_ms = 0.0  # 上一个采样点时间戳，确保严格单调递增（uPlot 要求）

        while True:
            running = self._running.get(uid)
            if running is None or not running.is_set():
                break

            lock = self._locks.get(uid)
            if lock is None:
                break

            # 探针已断开
            if not backend.is_connected(uid):
                event_manager.emit("monitor.stopped", {"uid": uid, "reason": "disconnected"})
                break

            t0 = time.perf_counter()

            # 暂停状态：跳过采样但保持线程存活
            paused = self._paused.get(uid)
            if paused is not None and not paused.is_set():
                time.sleep(min(0.1, interval))
                continue

            try:
                with lock:
                    values = self._read_variables(uid)

                if values:
                    start_t = self._start_time.get(uid, t0)
                    t_ms = (t0 - start_t) * 1000.0
                    # 确保时间戳严格单调递增（uPlot 要求）
                    # 防止暂停/恢复时序不精确导致时间戳回退
                    if t_ms <= last_t_ms:
                        t_ms = last_t_ms + 0.001  # 向前推进 1μs
                    last_t_ms = t_ms
                    sample = {"t_ms": t_ms, "values": values}
                    pending_samples.append(sample)

                    # 更新实际采样率统计
                    cnt = self._sample_counter.get(uid, 0) + 1
                    self._sample_counter[uid] = cnt
                    now = time.perf_counter()
                    last_t = self._sample_counter_time.get(uid, now)
                    elapsed = now - last_t
                    if elapsed >= 1.0:
                        self._actual_rate_hz[uid] = cnt / elapsed
                        self._sample_counter[uid] = 0
                        self._sample_counter_time[uid] = now

                    # 写入 RingBuffer
                    # 注意：RingBuffer 定义了 __len__，空缓冲区时 bool(rb) 为 False，
                    # 故用 is not None 判定，避免首条样本因缓冲区为空被丢弃。
                    # values 是 list[{"id":..., "value":...}]，需转为 {id: value} 映射，
                    # 不能用 dict(values)（会把 list-of-dict 错误转为 {'id':'value'}）。
                    rb = self._ring_buffers.get(uid)
                    if rb is not None:
                        rb.push(t_ms, {item["id"]: item["value"] for item in values})

                    # 批量推送，降低 WS 消息数（阈值随采样率动态放大）
                    if len(pending_samples) >= push_batch:
                        self._emit_samples(uid, pending_samples)
                        pending_samples.clear()

                consecutive_errors = 0
            except Exception as e:
                consecutive_errors += 1
                if consecutive_errors <= 3:
                    logger.warning(f"Monitor sample error (#{consecutive_errors}): {e}")
                if consecutive_errors == 1:
                    event_manager.emit("monitor.error", {"uid": uid, "error": str(e)})
                time.sleep(min(MAX_BACKOFF, interval * (2 ** consecutive_errors)))
                continue

            # 精确间隔控制：混合节流（先 sleep 大部分时间，最后忙等微调）
            # Windows 上 time.sleep 最小精度约 1ms，直接 sleep(interval-elapsed) 会把
            # 每帧额外撑长 ~1ms（实测设定 1kHz 只剩 ~500Hz）；忙等消除该精度损耗，
            # 让实际采样率贴近读取硬上限。
            elapsed = time.perf_counter() - t0
            sleep_time = interval - elapsed
            if sleep_time > 0:
                if sleep_time > 0.002:
                    time.sleep(sleep_time - 0.001)
                while time.perf_counter() - t0 < interval:
                    pass

        # 线程退出前刷出残留样本
        if pending_samples:
            self._emit_samples(uid, pending_samples)
        event_manager.log("info", f"Monitor: 采样线程退出 (probe {uid[:16]})")

    def _read_variables(self, uid: str) -> list:
        """批量读取所有变量

        按地址排序后合并邻近变量为批量读取，减少 SWD 事务。
        优化：
        - 缓存排序+分组结果，变量列表未变更时复用（避免每帧重复排序）
        - 跨 Block 流水线读取：多个分组的 DAP 命令一次性打包发出（减少 USB 往返）
        - 失败自动回退到逐组串行读取（read_memory_block32/block8），保证兼容性
        关键：直接用 session.target 读取，绝不 halt。
        """
        variables = self._variables.get(uid, [])
        if not variables:
            return []

        session = backend._get_session(uid)
        if not session:
            return []
        target = session.target

        max_bytes = self._block_max_bytes(uid)

        # 检查缓存：变量列表未变更时复用已排序+分组的结构
        current_version = self._vars_version.get(uid, 0)
        cached = self._vars_cache.get(uid)
        if cached is None or cached[0] != current_version:
            sorted_vars = sorted(variables, key=lambda v: v.address)
            groups = self._build_read_groups(sorted_vars, max_bytes)
            self._vars_cache[uid] = (current_version, groups)
        else:
            groups = cached[1]

        # 仅 Bulk (CMSIS-DAP v2/WinUSB) 探针启用流水线：
        # - HID 探针 pipeline_depth=1，命令本就是逐条往返，流水线无收益还可能引入风险
        # - 流水线此前失败过则降级为串行（避免每帧重试+重读的双倍开销）
        transport = self._get_transport_type(uid)
        if transport != "bulk" or self._pipeline_disabled.get(uid):
            return self._read_variables_serial(target, groups)

        results: list = []
        try:
            raw_map = self._pipelined_read(target, groups)
            for group in groups:
                raw = self._group_words_to_raw(raw_map, group)
                for v in group['vars']:
                    offset = v.address - group['start']
                    val_bytes = raw[offset:offset + v.size]
                    if len(val_bytes) < v.size:
                        continue
                    value = self._decode(val_bytes, v.type)
                    results.append({"id": v.id, "value": value})
        except Exception as e:
            # 流水线失败（个别探针兼容性问题等）：降级为串行读取并禁止重试，
            # 保证最差性能回到改动前，而不是每帧"失败+整批重读"拖垮采样率
            logger.warning(
                f"Monitor pipelined read failed, disable pipelining for probe "
                f"{uid[:16]}: {e}"
            )
            event_manager.log("warning",
                              f"Monitor: 流水线读取失败，已降级为串行读取 ({e})")
            self._pipeline_disabled[uid] = True
            results = self._read_variables_serial(target, groups)

        return results

    def _pipelined_read(self, target, groups: list) -> dict:
        """跨 Block 流水线读取：将多个 Block 的 DAP 命令一次打包发出

        借鉴 plink 的 _pipelined_batch_read：
        - 直接操作 AP/DP 层（比 target 层更底层，跳过 CortexM 的事务边界）
        - 依赖 pyOCD deferred transfers（连接时 cmsis_dap.deferred_transfers=True），
          命令先缓冲进 _crnt_cmd，一次 dp.flush() 才真正发送
        - 效果：N 个 Block 串行 N 次 USB 往返 -> 一次往返（Bulk V2 下 pipeline_depth=6+）
        - 按 MEM-AP auto-increment 页边界（默认 1KB）拆分，防止 TAR 自增跨页读错
          （与 pyOCD _read_memory_block32 内部 _read_block32_page 行为一致）

        返回 {page_addr: raw_bytes}，key 为每个子页的起始地址。
        """
        # 获取 MEM-AP：标准 CortexM target 暴露 .ap；CoreSightTarget 直接子类
        # （如 APM32F407xG 等 CMSIS-Pack/自定义 target）没有 .ap，但有 .first_ap
        ap = getattr(target, 'ap', None)
        if ap is None:
            ap = getattr(target, 'first_ap', None)
        if ap is None:
            raise AttributeError(
                f"target {type(target).__name__} has no accessible AP"
            )
        dp = ap.dp
        ap_base = ap.address.address + getattr(ap, '_reg_offset', 0)
        page_size = getattr(ap, 'auto_increment_page_size', 0x400)

        # 1. 设置 CSW 为 32 位传输（保留原 CSW 其余控制位）
        #    缓存已写入值：CSW 一旦设好就保持不变，每帧重复写会多一次 AP 写 + DP SELECT
        csw = getattr(ap, '_csw', DEFAULT_CSW_VALUE) | CSW_SIZE32
        ap_key = id(ap)
        if self._pipelined_csw.get(ap_key) != csw:
            dp.write_ap(ap_base + MEM_AP_CSW, csw)
            self._pipelined_csw[ap_key] = csw

        # 2. 为每个 Block（按页拆分子块）排队：写 TAR + 批量读 DRW（延迟执行）
        deferred = []  # [(page_addr, word_count, callback)]
        for group in groups:
            start = group['start']
            end = start + group['length']
            addr = start
            while addr < end:
                page_avail = page_size - (addr & (page_size - 1))
                chunk = min(page_avail, end - addr)
                word_count = chunk // 4
                if word_count > 0:
                    dp.write_ap(ap_base + MEM_AP_TAR, addr)
                    cb = dp.read_ap_multiple(ap_base + MEM_AP_DRW, word_count, now=False)
                    deferred.append((addr, word_count, cb))
                addr += chunk

        if not deferred:
            return {}

        # 3. 一次 flush，同时发出所有命令
        dp.flush()

        # 4. 逐个取回结果，组装为字节序列
        raw_map = {}
        for addr, word_count, cb in deferred:
            raw_map[addr] = array.array('I', cb()).tobytes()
        return raw_map

    @staticmethod
    def _group_words_to_raw(raw_map: dict, group: dict) -> bytes:
        """将分组对应的各子页原始字节按地址顺序拼接"""
        start = group['start']
        length = group['length']
        out = bytearray()
        addr = start
        end = start + length
        while addr < end:
            raw = raw_map.get(addr)
            if raw is None:
                return b""
            out += raw
            addr += len(raw)
        return bytes(out[:length])

    def _read_variables_serial(self, target, groups: list) -> list:
        """逐组串行读取（流水线失败时的回退路径）"""
        results: list = []
        for group in groups:
            start_addr = group['start']
            length = group['length']
            group_vars = group['vars']

            try:
                # 4字节对齐时用 block32（比 block8 快 2-3 倍），否则回退 block8
                if start_addr % 4 == 0 and length % 4 == 0:
                    words = target.read_memory_block32(start_addr, length // 4)
                    raw = array.array('I', words).tobytes()
                else:
                    raw = bytes(target.read_memory_block8(start_addr, length))

                for v in group_vars:
                    offset = v.address - start_addr
                    val_bytes = raw[offset:offset + v.size]
                    if len(val_bytes) < v.size:
                        continue
                    value = self._decode(val_bytes, v.type)
                    results.append({"id": v.id, "value": value})
            except Exception as e:
                logger.debug(f"Monitor read failed @0x{start_addr:08X}: {e}")
                raise
        return results

    def _get_transport_type(self, uid: str) -> str:
        """检测探针传输类型（bulk/hid/unknown），用于选择 Block 合并参数。带缓存。

        - bulk:  CMSIS-DAP v2 (WinUSB bulk)，单包可携带多个 DAP 命令
        - hid:   CMSIS-DAP v1 (HID)
        """
        cached = self._transport_type.get(uid)
        if cached:
            return cached
        t = "unknown"
        try:
            session = backend._get_session(uid)
            if session is not None:
                probe = getattr(session, 'probe', None)
                link = getattr(probe, '_link', None)
                interface = getattr(link, '_interface', None)
                if interface is not None:
                    t = "bulk" if getattr(interface, 'is_bulk', False) else "hid"
        except Exception:
            t = "unknown"
        self._transport_type[uid] = t
        return t

    def _block_max_bytes(self, uid: str) -> int:
        """按探针传输类型返回 Block 覆盖字节上限"""
        transport = self._get_transport_type(uid)
        if transport == "bulk":
            return BLOCK_MAX_BYTES_BULK
        if transport == "hid":
            return BLOCK_MAX_BYTES_HID
        return BLOCK_MAX_BYTES_DEFAULT

    def _build_read_groups(self, sorted_vars: list, max_bytes: int) -> list:
        """将已排序的变量合并为读取组，返回 [{start, length, vars}, ...]

        合并条件（借鉴 plink 聚合读取引擎）：
        - gap <= MERGE_GAP（64KB）：相邻变量不因间距拆块（带宽换时间）
        - 覆盖字节数 <= max_bytes：按传输类型限制单块大小
        - payload_ratio >= MIN_PAYLOAD_RATIO：有效字节占比不足时拆块
        返回的 start 向下对齐 4、length 向上对齐 4（保证 32 位传输可用）。
        """
        groups = []
        i = 0
        n = len(sorted_vars)
        while i < n:
            # 合并邻近变量为一组
            j = i
            raw_start = sorted_vars[i].address
            raw_end = sorted_vars[i].address + sorted_vars[i].size
            while j + 1 < n:
                gap = sorted_vars[j + 1].address - raw_end
                if gap > MERGE_GAP:
                    break
                candidate_end = max(raw_end,
                                    sorted_vars[j + 1].address + sorted_vars[j + 1].size)
                if candidate_end - raw_start > max_bytes:
                    break
                # 有效载荷比检查：避免为稀疏变量读取大段无关 RAM
                payload = sum(v.size for v in sorted_vars[i:j + 2])
                covered = candidate_end - raw_start
                if covered > 0 and payload / covered < MIN_PAYLOAD_RATIO:
                    break
                j += 1
                raw_end = candidate_end

            # 32 位对齐（block32 比 block8 快 2-3 倍，流水线也要求 32 位对齐）
            start_addr = raw_start & ~3
            aligned_end = (raw_end + 3) & ~3
            groups.append({
                'start': start_addr,
                'length': aligned_end - start_addr,
                'vars': sorted_vars[i:j + 1],
            })
            i = j + 1
        return groups

    def _decode(self, raw: bytes, var_type: str):
        """按数据类型解码原始字节（小端）"""
        fmt, _ = TYPE_MAP.get(var_type, ("<I", 4))
        try:
            return struct.unpack(fmt, raw)[0]
        except struct.error:
            return None

    def _emit_samples(self, uid: str, samples: list):
        """批量推送采样点到前端"""
        event_manager.emit("monitor.sample", {"uid": uid, "samples": samples})

    # ── RTT 同步采样循环 ──────────────────────────────────────

    def _rtt_sample_loop(self, uid: str):
        """RTT 同步模式采样线程

        固件侧集成 SEGGER_RTT，按采样节拍把采样数据写入 RTT up channel 0，
        host 侧读取原始字节流并按帧格式解析为 SamplePoint，推 RingBuffer + emit。

        数据帧格式（小端）::

            [t_ms:u32][n:u8][{var_id:u8, value:f32} * n]

        - t_ms:   相对采样起点的毫秒时间戳（由固件填写）
        - n:      本帧变量个数（0-255）
        - var_id: 变量索引（0-255，对应 variables 列表顺序，固件按此顺序写）
        - value:  该变量的浮点值（所有类型统一按 float 传输）

        变量 id 映射：RTT 模式下用 variables 列表顺序作为 id (0,1,2...)，
        解析时映射回 MonitoredVariable.id。

        设计说明（为何不直接调用 rtt_backend.start）：
          1. rtt_backend.start 内部有 monitor_backend.is_running 互斥检查，
             monitor 自身启动 RTT 会触发互斥导致失败；
          2. rtt_backend.start 会启动 _poll_loop 消费式读取所有 up channel 并
             emit rtt.data 事件，与本线程读取 up channel 0 会争抢数据
             （RTT 读取是消费式的，双读会导致帧被拆散）；
          3. 事件系统（core/events.py）仅有 emit 广播，无订阅机制，无法让
             monitor 监听 rtt.data。
        因此 RTT 模式直接使用 pyOCD 的 RTTControlBlock（底层 RTT API），
        仍通过 rtt_backend.is_running 做互斥协调（start 入口已检查）。
        """
        cb = None
        try:
            session = backend._get_session(uid)
            if not session:
                event_manager.emit("monitor.error",
                                   {"uid": uid, "error": "探针未连接"})
                return
            target = session.target

            # 搜索 RTT 控制块：遍历所有 RAM region（对标 rtt_backend/J-Link RTT Viewer）
            ram_regions = []
            try:
                from pyocd.core.memory_map import MemoryType
                mem_map = target.get_memory_map()
                ram_regions = list(mem_map.iter_matching_regions(type=MemoryType.RAM))
            except Exception as e:
                logger.warning(f"Monitor RTT: 获取 RAM region 失败: {e}")

            try:
                from pyocd.debug.rtt import RTTControlBlock
            except Exception as e:
                event_manager.emit("monitor.error",
                                   {"uid": uid, "error": f"pyOCD RTT 模块不可用: {e}"})
                return

            # halt 目标后搜索控制块（对标 rtt_backend.start 的流程）
            try:
                target.halt()
            except Exception:
                pass

            for r in ram_regions:
                try:
                    cb_obj = RTTControlBlock.from_target(
                        target, address=r.start, size=r.length)
                    cb_obj.start()
                    if len(cb_obj.up_channels) > 0:
                        cb = cb_obj
                        event_manager.log(
                            "info",
                            f"Monitor RTT: 控制块找到 @0x{r.start:08X}, "
                            f"{len(cb.up_channels)} up channels")
                        break
                except Exception:
                    continue

            # 搜索完成后恢复目标运行，使固件可写 RTT 缓冲区
            try:
                target.resume()
            except Exception:
                pass

            if cb is None or len(cb.up_channels) == 0:
                event_manager.emit(
                    "monitor.error",
                    {"uid": uid,
                     "error": "RTT 控制块未找到，请确认固件已集成 SEGGER_RTT 并已初始化"})
                return

            up_ch = cb.up_channels[0]
            with self._global_lock:
                self._rtt_cbs[uid] = cb

            event_manager.log("info", "Monitor RTT: 开始采样 (up channel 0)")

            # 帧解析缓冲：不完整帧缓存剩余字节等下一批
            buf = bytearray()
            pending_samples: list = []

            while True:
                running = self._running.get(uid)
                if running is None or not running.is_set():
                    break
                if not backend.is_connected(uid):
                    event_manager.emit("monitor.stopped",
                                       {"uid": uid, "reason": "disconnected"})
                    break

                # 暂停状态：跳过读取但保持线程存活
                paused = self._paused.get(uid)
                if paused is not None and not paused.is_set():
                    time.sleep(0.02)
                    continue

                # 读取 up channel 0 原始字节
                try:
                    data = up_ch.read()
                except Exception as e:
                    logger.debug(f"Monitor RTT read error: {e}")
                    data = None

                if data:
                    buf.extend(data)
                    self._parse_rtt_frames(uid, buf, pending_samples)

                # 批量推送，降低 WS 消息数
                if len(pending_samples) >= PUSH_BATCH:
                    self._emit_samples(uid, pending_samples)
                    pending_samples.clear()

                time.sleep(0.01)

            # 线程退出前：尝试解析残留缓冲并刷出未推送样本
            if buf:
                self._parse_rtt_frames(uid, buf, pending_samples)
            if pending_samples:
                self._emit_samples(uid, pending_samples)

            event_manager.log("info",
                              f"Monitor RTT: 采样线程退出 (probe {uid[:16]})")
        except Exception as e:
            logger.exception("Monitor RTT sample loop failed")
            event_manager.emit("monitor.error", {"uid": uid, "error": str(e)})
        finally:
            # 清理 RTT 控制块
            if cb is not None:
                try:
                    if hasattr(cb, "stop"):
                        cb.stop()
                except Exception:
                    pass
            with self._global_lock:
                self._rtt_cbs.pop(uid, None)

    def _parse_rtt_frames(self, uid: str, buf: bytearray, pending_samples: list):
        """从字节缓冲区解析 RTT 数据帧

        帧格式（小端）：``[t_ms:u32][n:u8][{var_id:u8, value:f32} * n]``
        最小帧长 5 字节（n=0），完整帧长 5 + 5*n 字节。
        帧不完整时保留在 buf 中等待下一批数据补齐。
        每个完整帧转为 SamplePoint：写 RingBuffer + 加入 pending_samples 批量推送。

        变量 id 映射：RTT 模式下用 variables 列表顺序作为 id (0,1,2...)，
        解析时把 var_id（固件写的顺序索引）映射回 MonitoredVariable.id。
        """
        # 顺序索引 -> MonitoredVariable.id（每次按当前变量列表重建，支持运行时增删）
        variables = self._variables.get(uid, [])
        id_map = {i: v.id for i, v in enumerate(variables)}

        while len(buf) >= 5:
            t_ms_raw = struct.unpack_from("<I", buf, 0)[0]
            n = buf[4]
            frame_len = 5 + 5 * n
            if len(buf) < frame_len:
                # 帧不完整，等待更多数据
                break

            values: dict = {}
            offset = 5
            for _ in range(n):
                var_idx = buf[offset]
                value = struct.unpack_from("<f", buf, offset + 1)[0]
                offset += 5
                real_id = id_map.get(var_idx)
                if real_id is not None:
                    values[real_id] = value

            t_ms = float(t_ms_raw)
            pending_samples.append({"t_ms": t_ms, "values": values})

            # 写入 RingBuffer
            # 注意：RingBuffer 定义了 __len__，空缓冲区时 bool(rb) 为 False，
            # 故用 is not None 判定，避免首条样本因缓冲区为空被丢弃。
            rb = self._ring_buffers.get(uid)
            if rb is not None:
                rb.push(t_ms, dict(values))

            # 消费已解析帧
            del buf[:frame_len]

    # ── 变量管理 ──────────────────────────────────────────────

    def add_variable(self, uid: str, name: str, address: int, var_type: str,
                     remark: str = "", refresh_sec: float = 0,
                     elem_index: Optional[int] = None) -> dict:
        """添加监视变量

        Args:
            name: 变量名（数组元素时为原数组名，实际显示名会追加 [elem_index]）
            address: 变量地址（数组元素时为数组基地址）
            var_type: 数据类型 int8/uint8/int16/uint16/int32/uint32/float；
                      数组元素时传元素类型
            remark: 用户备注
            refresh_sec: 独立刷新周期（0=跟随全局采样率）
            elem_index: 数组元素索引。传入时实际地址 = address + elem_index * elem_size，
                        监视变量名变为 name[elem_index]，type/size 用元素类型/大小；
                        不传则按标量处理。
        """
        if var_type not in TYPE_MAP:
            return {"success": False, "error": f"不支持的数据类型: {var_type}"}
        _, elem_size = TYPE_MAP[var_type]

        # 数组元素：计算实际地址与显示名，type/size 用元素类型/大小
        if elem_index is not None:
            real_address = address + elem_index * elem_size
            display_name = f"{name}[{elem_index}]"
            size = elem_size
        else:
            real_address = address
            display_name = name
            size = elem_size

        # 探针已连接时探测地址可读性（一次读，失败则拒绝添加）
        session = backend._get_session(uid)
        if session:
            try:
                session.target.read_memory_block8(real_address, size)
            except Exception as e:
                return {"success": False,
                        "error": f"地址 0x{real_address:08X} 不可读: {e}"}
        # 探针未连接时跳过探测（允许先配置变量再连接）

        import uuid
        var_id = uuid.uuid4().hex[:12]
        var = MonitoredVariable(
            id=var_id, name=display_name, address=real_address, type=var_type,
            size=size, remark=remark, refresh_sec=refresh_sec,
        )

        with self._global_lock:
            self._variables.setdefault(uid, []).append(var)
            self._vars_version[uid] = self._vars_version.get(uid, 0) + 1

        return {"success": True, "variable": self._var_to_dict(var)}

    def remove_variable(self, uid: str, var_id: str) -> dict:
        with self._global_lock:
            vars_list = self._variables.get(uid, [])
            before = len(vars_list)
            self._variables[uid] = [v for v in vars_list if v.id != var_id]
            removed = before - len(self._variables[uid])
            if removed:
                self._vars_version[uid] = self._vars_version.get(uid, 0) + 1
        return {"success": removed > 0}

    def get_variables(self, uid: str) -> list:
        with self._global_lock:
            return [self._var_to_dict(v) for v in self._variables.get(uid, [])]

    def write_variable(self, uid: str, var_id: str, value: int) -> dict:
        """写入变量值到目标内存（P1：实时改参）"""
        with self._global_lock:
            var = next((v for v in self._variables.get(uid, []) if v.id == var_id), None)
        if not var:
            return {"success": False, "error": "变量不存在"}

        session = backend._get_session(uid)
        if not session:
            return {"success": False, "error": "探针未连接"}

        try:
            fmt, size = TYPE_MAP[var.type]
            # 数值钳制到类型范围
            packed = struct.pack(fmt, value)
            session.target.write_memory_block8(var.address, list(packed))
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── ELF 符号解析 ──────────────────────────────────────────────

    def load_elf(self, uid: str, path: str) -> dict:
        """加载 ELF/AXF 文件，构建符号解码器

        复用 pyOCD 的 ElfSymbolDecoder（python/pyocd/debug/elf/decoder.py）。
        同时解析 DWARF 信息，构建 {符号名 -> 类型信息} 缓存供 get_symbols 查表，
        识别数组类型与元素信息。
        """
        try:
            from elftools.elf.elffile import ELFFile
            from pyocd.debug.elf.decoder import ElfSymbolDecoder

            # 关闭旧文件句柄
            old_file = self._elf_files.pop(uid, None)
            if old_file:
                try:
                    old_file.close()
                except Exception:
                    pass
            # 清理旧的 DWARF 缓存（重新加载时重建）
            self._dwarf_info.pop(uid, None)
            self._dwarf_cache.pop(uid, None)

            f = open(path, "rb")
            elf = ELFFile(f)
            decoder = ElfSymbolDecoder(elf)

            # 解析 DWARF（若有），一次性构建 {符号名 -> 类型信息} 缓存。
            # DWARF 遍历较慢，在 load_elf 时构建一次，get_symbols 直接查表。
            try:
                if elf.has_dwarf_info():
                    dwarfinfo = elf.get_dwarf_info()
                    self._dwarf_info[uid] = dwarfinfo
                    self._dwarf_cache[uid] = self._build_dwarf_cache(dwarfinfo)
                    event_manager.log(
                        "info",
                        f"Monitor: DWARF 已解析，"
                        f"{len(self._dwarf_cache[uid])} 个全局变量类型缓存")
                else:
                    self._dwarf_cache[uid] = {}
                    event_manager.log("info",
                                      "Monitor: ELF 无 DWARF 信息，类型按 size 猜测")
            except Exception as e:
                # DWARF 解析失败不影响主流程，回退到 size 猜测
                logger.warning(f"Monitor: DWARF 解析失败，回退到 size 猜测: {e}")
                self._dwarf_cache[uid] = {}

            with self._global_lock:
                self._elf_decoders[uid] = decoder
                self._elf_files[uid] = f
                # 记录 mtime 与路径，供 check_elf_changed 检测文件变化
                import os
                self._elf_paths[uid] = path
                try:
                    self._elf_mtimes[uid] = os.path.getmtime(path)
                except OSError:
                    self._elf_mtimes[uid] = 0.0

            # 统计变量符号数
            var_count = sum(
                1 for info in decoder.symbol_dict.values()
                if info.type == "STT_OBJECT"
            )
            event_manager.log("info",
                              f"Monitor: ELF 已加载 ({path}), {var_count} 个变量符号")
            return {"success": True, "symbol_count": var_count, "path": path}
        except Exception as e:
            logger.exception("ELF load failed")
            return {"success": False, "error": str(e)}

    def get_symbols(self, uid: str, filter_str: str = "",
                    sym_type: str = "object", page: int = 1,
                    page_size: int = 200) -> dict:
        """查询符号列表（分页）

        Args:
            filter_str: 名称模糊过滤
            sym_type: "object"=仅变量, "func"=仅函数, "all"=全部
            page: 页码（1-based）
            page_size: 每页条数

        每个符号字段：
            name, address, size（整个符号大小）, type（数组时为元素类型，向后兼容），
            is_array, elem_type, elem_count, elem_size, source_file（源文件名）。
        DWARF 解析失败或未命中时回退到按 size 猜测，is_array=False，
        source_file 为 "unknown"。
        """
        decoder = self._elf_decoders.get(uid)
        if not decoder:
            return {"success": False, "error": "未加载 ELF 文件"}

        dwarf_cache = self._dwarf_cache.get(uid, {})

        # 过滤
        symbols = []
        for name, info in decoder.symbol_dict.items():
            if sym_type == "object" and info.type != "STT_OBJECT":
                continue
            if sym_type == "func" and info.type != "STT_FUNC":
                continue
            if filter_str and filter_str.lower() not in name.lower():
                continue

            # 优先用 DWARF 类型信息；未命中或类型解析失败回退到 size 猜测
            ti = dwarf_cache.get(name)
            source_file = ti.get("source_file", "unknown") if ti is not None else "unknown"
            if ti is not None and "is_array" in ti:
                # 类型解析成功
                is_array = bool(ti["is_array"])
                elem_type = ti["elem_type"]
                elem_count = int(ti["elem_count"])
                elem_size = int(ti["elem_size"])
                # 数组时 type 设为 elem_type，size 仍为整个符号大小（向后兼容）
                sym_type_str = elem_type
            else:
                # 无 DWARF 或类型解析失败：回退 size 猜测，但仍保留 source_file
                is_array = False
                elem_type = self._type_from_symbol(info)
                elem_count = 1
                elem_size = info.size if info.size else TYPE_MAP[elem_type][1]
                sym_type_str = elem_type

            symbols.append({
                "name": name,
                "address": info.address,
                "size": info.size,
                "type": sym_type_str,
                "is_array": is_array,
                "elem_type": elem_type,
                "elem_count": elem_count,
                "elem_size": elem_size,
                "source_file": source_file,
            })

        # 排序：按地址
        symbols.sort(key=lambda s: s["address"])

        total = len(symbols)
        start = (page - 1) * page_size
        end = start + page_size
        page_items = symbols[start:end]

        return {
            "success": True,
            "symbols": page_items,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def _type_from_symbol(self, info) -> str:
        """从符号信息推断 Monitor 数据类型

        DWARF 详细类型信息需要解析 DIE，这里按 size 简单映射，
        默认按有符号处理（用户可在 UI 修正为 unsigned）。
        """
        size = info.size
        if size == 1:
            return "int8"
        if size == 2:
            return "int16"
        if size == 4:
            return "int32"  # 也可能是 float，用户可在 UI 切换
        return "int32"

    # ── DWARF 类型解析 ──────────────────────────────────────────

    def _build_dwarf_cache(self, dwarfinfo) -> dict:
        """遍历 DWARF，构建 {符号名 -> 类型信息} 缓存

        一次性遍历所有 CU 的 DIE，先建 {offset -> DIE} 索引以便解析 DW_AT_type
        引用，再收集全局变量（DW_TAG_variable，直接隶属于 CU）的类型信息。

        每个变量额外存 source_file：取 CU 顶层 DIE 的 DW_AT_name（源文件名），
        取不到则 "unknown"，供前端按文件分组展示。

        Returns:
            {name: {is_array, elem_type, elem_count, elem_size, source_file}}
        """
        # 第一遍：建立 offset -> DIE 索引（用于解析 DW_AT_type 引用）
        die_by_offset: dict[int, object] = {}
        for cu in dwarfinfo.iter_CUs():
            for die in cu.iter_DIEs():
                die_by_offset[die.offset] = (die, cu)

        # 第二遍：收集全局变量类型
        cache: dict[str, dict] = {}
        for cu in dwarfinfo.iter_CUs():
            # 取 CU 对应的源文件名（顶层 DIE 的 DW_AT_name），失败回退 "unknown"
            try:
                top_die = cu.get_top_DIE()
                cu_name_attr = top_die.attributes.get("DW_AT_name")
                if cu_name_attr is not None:
                    cu_name = cu_name_attr.value
                    if isinstance(cu_name, bytes):
                        cu_name = cu_name.decode("utf-8", errors="replace")
                else:
                    cu_name = "unknown"
            except Exception:
                cu_name = "unknown"

            for die in cu.iter_DIEs():
                if die.tag != "DW_TAG_variable":
                    continue
                # 仅处理全局变量（直接隶属于 CU 的变量，跳过函数内局部变量）
                parent = die.get_parent()
                if parent is None or parent.tag != "DW_TAG_compile_unit":
                    continue
                name_attr = die.attributes.get("DW_AT_name")
                if name_attr is None:
                    continue
                name = name_attr.value
                if isinstance(name, bytes):
                    name = name.decode("utf-8", errors="replace")
                # 单个符号解析失败不影响其他符号
                try:
                    ti = self._resolve_var_type(die, die_by_offset, cu)
                    if ti is not None:
                        # 类型解析成功：在类型信息基础上追加 source_file
                        cache[name] = {**ti, "source_file": cu_name}
                    else:
                        # 类型解析失败（如 struct/union/pointer/无 DW_AT_type）：
                        # 仍记录 source_file，类型字段留空，get_symbols 时走 size 猜测回退。
                        # 这样即使类型不可解析，变量仍能按源文件分组显示。
                        cache[name] = {"source_file": cu_name}
                except Exception as e:
                    logger.debug(f"Monitor: DWARF 解析符号 {name} 失败: {e}")
        return cache

    def _follow_type_ref(self, die, die_by_offset: dict, cu):
        """沿 DW_AT_type 引用解析到目标 DIE

        根据 form 判断偏移是绝对（DW_FORM_ref_addr）还是相对 CU（ref4 等）。
        """
        type_attr = die.attributes.get("DW_AT_type")
        if type_attr is None:
            return None
        ref = type_attr.value
        if type_attr.form == "DW_FORM_ref_addr":
            # 绝对偏移
            entry = die_by_offset.get(ref)
        else:
            # 相对 CU 头的偏移
            entry = die_by_offset.get(cu.cu_offset + ref)
        return entry[0] if entry is not None else None

    def _resolve_to_base_type(self, type_die, die_by_offset: dict, cu, depth: int = 0):
        """沿 typedef/const/volatile/restrict 链解析到 DW_TAG_base_type

        返回 base_type DIE 或 None。depth 防止异常循环引用。
        """
        if depth > 16 or type_die is None:
            return None
        if type_die.tag == "DW_TAG_base_type":
            return type_die
        if type_die.tag in ("DW_TAG_typedef", "DW_TAG_const_type",
                            "DW_TAG_volatile_type", "DW_TAG_restrict_type"):
            next_die = self._follow_type_ref(type_die, die_by_offset, cu)
            return self._resolve_to_base_type(next_die, die_by_offset, cu, depth + 1)
        # 非链式节点（如 pointer/struct），无法归约为 base_type
        return None

    def _base_type_to_monitor(self, base_die) -> Optional[str]:
        """将 DW_TAG_base_type DIE 映射为 Monitor 数据类型字符串

        DW_AT_encoding:
            DW_ATE_signed = 0x05 -> int
            DW_ATE_unsigned = 0x07 -> uint
            DW_ATE_float = 0x04 -> float
        结合 DW_AT_byte_size 决定具体 int8/16/32 或 float。
        """
        if base_die is None or base_die.tag != "DW_TAG_base_type":
            return None
        enc_attr = base_die.attributes.get("DW_AT_encoding")
        size_attr = base_die.attributes.get("DW_AT_byte_size")
        if enc_attr is None or size_attr is None:
            return None
        enc = enc_attr.value
        bs = size_attr.value
        if enc == 0x05:        # DW_ATE_signed
            if bs == 1:
                return "int8"
            if bs == 2:
                return "int16"
            if bs == 4:
                return "int32"
        elif enc == 0x07:      # DW_ATE_unsigned
            if bs == 1:
                return "uint8"
            if bs == 2:
                return "uint16"
            if bs == 4:
                return "uint32"
        elif enc == 0x04:      # DW_ATE_float
            if bs == 4:
                return "float"
            if bs == 8:
                # double 归并为 float（Monitor 暂不支持 double）
                return "float"
        return None

    def _resolve_var_type(self, var_die, die_by_offset: dict, cu) -> Optional[dict]:
        """解析变量 DIE 的类型信息

        沿类型链查找：
            - DW_TAG_array_type：取元素类型与 subrange 元素个数，is_array=True
            - DW_TAG_base_type（或经 typedef/const 链归约）：标量，is_array=False
        Returns:
            {is_array, elem_type, elem_count, elem_size} 或 None（无法解析）
        """
        current = self._follow_type_ref(var_die, die_by_offset, cu)
        seen = set()
        while current is not None and current.offset not in seen:
            seen.add(current.offset)

            if current.tag == "DW_TAG_array_type":
                # 元素类型 = array_type 的 DW_AT_type，归约到 base_type
                elem_die = self._follow_type_ref(current, die_by_offset, cu)
                base_die = self._resolve_to_base_type(elem_die, die_by_offset, cu)
                if base_die is None:
                    return None
                elem_type = self._base_type_to_monitor(base_die)
                if elem_type is None:
                    return None
                _, elem_size = TYPE_MAP[elem_type]
                # 元素个数：取 DW_TAG_subrange_type 的 DW_AT_upper_bound+1
                # 或 DW_AT_count
                count = 1
                for child in current.iter_children():
                    if child.tag == "DW_TAG_subrange_type":
                        cnt_attr = child.attributes.get("DW_AT_count")
                        ub_attr = child.attributes.get("DW_AT_upper_bound")
                        if cnt_attr is not None:
                            try:
                                count = int(cnt_attr.value)
                            except Exception:
                                count = 1
                        elif ub_attr is not None:
                            try:
                                count = int(ub_attr.value) + 1
                            except Exception:
                                count = 1
                        break
                return {
                    "is_array": True,
                    "elem_type": elem_type,
                    "elem_count": count,
                    "elem_size": elem_size,
                }

            if current.tag in ("DW_TAG_typedef", "DW_TAG_const_type",
                               "DW_TAG_volatile_type", "DW_TAG_restrict_type"):
                current = self._follow_type_ref(current, die_by_offset, cu)
                continue

            # 标量：归约到 base_type
            base_die = (current if current.tag == "DW_TAG_base_type"
                        else self._resolve_to_base_type(current, die_by_offset, cu))
            if base_die is None:
                return None
            elem_type = self._base_type_to_monitor(base_die)
            if elem_type is None:
                return None
            _, elem_size = TYPE_MAP[elem_type]
            return {
                "is_array": False,
                "elem_type": elem_type,
                "elem_count": 1,
                "elem_size": elem_size,
            }
        return None

    # ── 录制导出 ──────────────────────────────────────────────

    def export_csv(self, uid: str) -> dict:
        """导出 RingBuffer 数据为 CSV 字符串"""
        rb = self._ring_buffers.get(uid)
        if not rb:
            return {"success": False, "error": "无录制数据"}

        variables = self._variables.get(uid, [])
        var_map = {v.id: v for v in variables}

        lines = ["t_ms," + ",".join(v.name for v in variables)]
        for pt in rb.get_all():
            row = [f"{pt.t_ms:.3f}"]
            for v in variables:
                val = pt.values.get(v.id, "")
                row.append(str(val) if val is not None else "")
            lines.append(",".join(row))

        return {"success": True, "csv": "\n".join(lines), "count": len(lines) - 1}

    # ── 工具 ──────────────────────────────────────────────

    def _var_to_dict(self, v: MonitoredVariable) -> dict:
        return {
            "id": v.id,
            "name": v.name,
            "address": v.address,
            "type": v.type,
            "size": v.size,
            "remark": v.remark,
            "refresh_sec": v.refresh_sec,
        }

    def check_elf_changed(self, uid: str) -> dict:
        """检测已加载的 ELF 文件是否在磁盘上发生变化（mtime 变化）。

        供前端轮询：采样未运行时定期调用，变化则提示用户是否重新加载。
        """
        import os
        path = self._elf_paths.get(uid)
        recorded = self._elf_mtimes.get(uid)
        if not path or recorded is None:
            return {"loaded": False, "changed": False}
        try:
            current = os.path.getmtime(path)
        except OSError:
            # 文件被删除或不可访问
            return {"loaded": True, "changed": False, "path": path, "error": "文件不可访问"}
        return {
            "loaded": True,
            "changed": current != recorded,
            "path": path,
            "mtime": current,
        }

    def get_status(self, uid: str) -> dict:
        return {
            "running": self.is_running(uid),
            "paused": self.is_paused(uid),
            "connected": backend.is_connected(uid),
            "rate_hz": self._rate_hz.get(uid, 0),
            "actual_rate_hz": round(self._actual_rate_hz.get(uid, 0.0), 1),
            "variable_count": len(self._variables.get(uid, [])),
            "elf_loaded": uid in self._elf_decoders,
            "buffer_size": len(self._ring_buffers.get(uid, RingBuffer(1))),
        }

    def on_probe_disconnected(self, uid: str):
        """探针断开时调用，清理 Monitor 会话"""
        if uid in self._running or uid in self._variables:
            self.stop(uid)
        # 清理 ELF 与 DWARF 缓存
        f = self._elf_files.pop(uid, None)
        if f:
            try:
                f.close()
            except Exception:
                pass
        self._elf_decoders.pop(uid, None)
        self._dwarf_info.pop(uid, None)
        self._dwarf_cache.pop(uid, None)
        # 清理 RTT 模式残留的控制块（兜底）
        cb = self._rtt_cbs.pop(uid, None)
        if cb is not None:
            try:
                if hasattr(cb, "stop"):
                    cb.stop()
            except Exception:
                pass
        self._transport.pop(uid, None)
        self._transport_type.pop(uid, None)  # 探针断开后清除传输类型缓存，重连时重新检测
        self._pipeline_disabled.pop(uid, None)  # 同步清除流水线降级标志
        self._variables.pop(uid, None)
        self._ring_buffers.pop(uid, None)

    def cleanup_all(self):
        """清理所有 Monitor 会话（应用退出时调用）"""
        for uid in list(self._running.keys()):
            self.stop(uid)
        for uid in list(self._elf_files.keys()):
            try:
                self._elf_files[uid].close()
            except Exception:
                pass
        self._elf_files.clear()
        self._elf_decoders.clear()
        self._dwarf_info.clear()
        self._dwarf_cache.clear()
        # 兜底清理 RTT 控制块
        for cb in self._rtt_cbs.values():
            try:
                if hasattr(cb, "stop"):
                    cb.stop()
            except Exception:
                pass
        self._rtt_cbs.clear()
        self._transport.clear()


# 全局单例
monitor_backend = MonitorBackend()
