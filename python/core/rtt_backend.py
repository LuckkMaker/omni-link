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
from collections import deque
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

# ---- 控制块搜索参数 -------------------------------------------------------
# SEGGER RTT 控制块的 16 字节标识（不足 16 字节时 SEGGER 用 \0 补齐）。
# 必须按 16 字节完整比较：只比较 "SEGGER RTT" 这 10 字节会在控制块尚未初始化
# （全 0）或 RAM 中恰好存在同名常量时产生误判。
RTT_CB_ID = b'SEGGER RTT'
RTT_CB_ID_LEN = 16
# 4 字节粗扫魔数。用 'SEGG' 的整字（小端 0x47474553）做第一道过滤，
# 命中后再回读确认完整标识——把每个候选的读放大从 16 字节降到一次 16 字节读。
RTT_MAGIC = b'SEGG'
# 一次 read_memory_block32 读取的字数。实测 16KB/次在 CMSIS-DAP v2 下吞吐最佳，
# 再大（32KB）不会有额外收益（瓶颈在每字 0.13ms 的传输开销，而非 USB 往返）。
RTT_SCAN_WORDS_PER_READ = 4096
# 遇到坏块时二分下探的最小粒度（字）。到该粒度仍失败即判定为真实读失败，
# 避免把"某段 RAM 读不动"静默当成"没有控制块"。
RTT_SCAN_MIN_WORDS = 16
# 读取失败时的二分下探深度：16KB -> 4KB -> 1KB。再往下只是在确认"这段 RAM
# 读不动"这件事上反复发读请求——实测 J-Link 读不存在的 CCM 段时，16KB 大读会
# 先失败，随后 64KB 区段被放大成 2048 次读 + 1024 条 WARN，把一次扫描拖到几十秒
# （用户看到的 0x1000F2C0~0x1000F300 刷屏即此）。现在最多下探两级，1KB 仍失败
# 就整段跳过并只记一条结论。
RTT_SCAN_MAX_BISECT_DEPTH = 2
# 单个 region 记录的失败明细上限（错误信息只展示前几条，其余汇总成计数）。
RTT_SCAN_MAX_FAILURES = 8
# 扫描前对 region 起始做一次小读（16 字节）探测可读性：读不动就整段跳过，
# 不再用 16KB 大读去"发现"某段 RAM 不可读（J-Link 首次失败可能耗时数秒）。
RTT_SCAN_PROBE_BYTES = 16
# 连续多少个扫描块读取失败就判定整个 region 不可读并提前结束该 region。
RTT_SCAN_MAX_CONSECUTIVE_FAILURES = 2

# ELF 中 RTT 控制块的符号名。pyOCD 官方 rtt_manager 也用这个名字。
# 固件加载 ELF 时优先用符号地址直接定位，可完全跳过 RAM 全扫描（192KB 全扫
# 在 CMSIS-DAP 下约 6.5s，是启动超时的主要来源）。
RTT_CB_SYMBOL = '_SEGGER_RTT'

# RTT 上行缓存上限（每探针）。pyOCD 的 RTTUpChannel.read() 是消费式读取：
# 读走的数据会同步写回目标 RdOff，之后再也读不到。GUI 只经 WebSocket 消费，
# 没有任何“回看”能力；CLI / 脚本 / CI 需要可重复读取，因此轮询线程必须把
# 读到的数据同时落一份有界缓存（对标 J-Link RTT Viewer 的终端滚动缓冲）。
RTT_CAPTURE_MAX_BYTES = 64 * 1024
# 单次 REST 读取允许的最大字节数（防止一次请求拷贝过大）
RTT_CAPTURE_MAX_READ = 1024 * 1024


class RttCapture:
    """RTT 上行数据环形缓存（每个探针一个）。

    - 轮询线程按 ``append(channel, data)`` 追加，每个字节块分配一个单调 ``seq``；
      读端只需记住上次返回的 ``cursor`` 即可增量读取，无需服务端消费游标。
    - ``seq`` 在同一后端进程内跨 ``rtt start`` 单调递增（``start_seq`` 由
      RTTBackend 续用上一次的 ``next_seq``）；只有后端重启才从 1 开始。
    - 总字节数超过 ``max_bytes`` 时丢弃最旧的整块，并累计 ``dropped_bytes`` /
      ``dropped_chunks``；读端通过 ``lost`` 得知自己请求的 ``since`` 已被覆盖。
    - 单块大于总容量时只保留尾部（RTT up buffer 通常 ≤1 KB，这里仅防御异常配置）。

    线程安全：内部锁只保护 chunk 列表与计数；``read()`` 在锁内做浅拷贝后即释放，
    不会因大量读取阻塞轮询线程。
    """

    def __init__(self, max_bytes: int = RTT_CAPTURE_MAX_BYTES, start_seq: int = 1):
        self._max_bytes = max(64, int(max_bytes))
        self._chunks: deque = deque()
        self._bytes = 0
        # seq 在同一次后端进程内跨 RTT 会话单调递增：新 start 只清空缓冲，
        # 不重置编号，旧会话的 next_seq 仍可安全用作 --since 游标。
        self._next_seq = max(1, int(start_seq))
        self._dropped_bytes = 0
        self._dropped_chunks = 0
        self._lock = threading.Lock()

    def append(self, channel: int, data: bytes) -> int:
        """追加一个通道读到的字节块，返回分配到的 seq（空数据返回 0）。"""
        if not data:
            return 0
        data = bytes(data)
        with self._lock:
            seq = self._next_seq
            self._next_seq += 1
            if len(data) > self._max_bytes:
                dropped = len(data) - self._max_bytes
                self._dropped_bytes += dropped
                data = data[-self._max_bytes:]
            while self._chunks and self._bytes + len(data) > self._max_bytes:
                old = self._chunks.popleft()
                self._bytes -= len(old["data"])
                self._dropped_bytes += len(old["data"])
                self._dropped_chunks += 1
            self._chunks.append({"seq": seq, "channel": int(channel), "data": data})
            self._bytes += len(data)
            return seq

    def stats(self) -> dict:
        """缓存概览（供 /rtt/status 与 CLI 诊断）。"""
        with self._lock:
            oldest = self._chunks[0]["seq"] if self._chunks else self._next_seq
            return {
                "oldest_seq": oldest,
                "next_seq": self._next_seq,
                "buffered_bytes": self._bytes,
                "dropped_bytes": self._dropped_bytes,
                "dropped_chunks": self._dropped_chunks,
            }

    def read(
        self,
        since: int = 0,
        max_bytes: int = RTT_CAPTURE_MAX_BYTES,
        channel: Optional[int] = None,
    ) -> dict:
        """按 seq 增量读取。

        Args:
            since: 起始 seq（0 = 从当前最旧可用块开始）
            max_bytes: 单次返回的字节预算。按整块返回（不拆块），因此实际可能略超；
                只有在“已选到至少一块”之后才会因预算截断，绝不丢块内数据。
            channel: 仅返回该 up channel 的数据（None = 全部通道）

        Returns:
            {oldest_seq, next_seq, last_seq, cursor, truncated, lost, session_reset,
             dropped_bytes, dropped_chunks, chunks:[{seq, channel, size, data(base64)}]}

            session_reset: since 超出当前后端进程的序号（后端重启后 seq 从 1 开始），
                本次已从当前最旧数据重读。同一后端进程内 seq 跨 rtt start 单调递增。
        """
        limit = max(1, min(int(max_bytes), RTT_CAPTURE_MAX_READ))
        with self._lock:
            chunks = list(self._chunks)
            next_seq = self._next_seq
            dropped_bytes = self._dropped_bytes
            dropped_chunks = self._dropped_chunks

        oldest_seq = chunks[0]["seq"] if chunks else next_seq
        # since 大于 next_seq 只可能因为后端重启（seq 从 1 重新开始），或调用方
        # 使用了明显超前的游标。此时从当前最旧数据重读，并通过 session_reset 告知，
        # 而不是静默返回 0 字节。
        session_reset = bool(since and since > 0 and int(since) > next_seq)
        if session_reset:
            start = oldest_seq
            lost = False
        else:
            start = int(since) if since and since > 0 else oldest_seq
            lost = bool(since and since > 0 and start < oldest_seq)

        selected = []
        used = 0
        truncated = False
        for chunk in chunks:
            if chunk["seq"] < start:
                continue
            if channel is not None and chunk["channel"] != int(channel):
                continue
            size = len(chunk["data"])
            if selected and used + size > limit:
                truncated = True
                break
            selected.append(chunk)
            used += size

        last_seq = selected[-1]["seq"] if selected else max(start - 1, 0)
        # 预算截断时必须从下一块续读；否则说明已把截至 next_seq 的数据全部看过，
        # 直接推进到 next_seq（被 channel 过滤掉的块无需回看）。
        cursor = last_seq + 1 if truncated else next_seq
        return {
            "oldest_seq": oldest_seq,
            "next_seq": next_seq,
            "last_seq": last_seq,
            "cursor": cursor,
            "truncated": truncated,
            "lost": lost,
            "session_reset": session_reset,
            "dropped_bytes": dropped_bytes,
            "dropped_chunks": dropped_chunks,
            "chunks": [
                {
                    "seq": c["seq"],
                    "channel": c["channel"],
                    "size": len(c["data"]),
                    "data": base64.b64encode(c["data"]).decode("ascii"),
                }
                for c in selected
            ],
        }


def _halted_location(uid: str) -> str:
    """目标处于暂停态时，返回 "PC=0x... (symbol) LR=0x..." 形式的定位串。

    "找不到控制块" 最常见的根因是固件在初始化 RTT 之前就挂了（断言死循环、
    HardFault、PHY 初始化失败后 main 返回…）。只报 "未检测到控制块" 会把用户
    引向扫描逻辑；带上 PC/LR 与符号就能一眼看出真正原因。
    """
    try:
        session = backend._get_session(uid)
        if not session:
            return ""
        target = session.target
        pc = target.read_core_register('pc')
        try:
            lr = target.read_core_register('lr')
        except Exception:
            lr = None
    except Exception:
        return ""

    text = f"目标当前 PC=0x{pc:08X}"
    try:
        from core.elf_backend import elf_backend
        if elf_backend.is_loaded(uid):
            info = elf_backend.get_symbol_for_address(uid, pc)
            if info:
                name = info.get('name') if isinstance(info, dict) else str(info)
                if name:
                    text += f" ({name})"
            try:
                line = elf_backend.get_line_for_address(uid, pc)
                if line:
                    text += f" @ {line.get('file')}:{line.get('line')}"
            except Exception:
                pass
    except Exception:
        pass
    if lr is not None:
        text += f"，LR=0x{lr:08X}"
    return text


class _StartToken:
    """一次 RTT 启动流程的取消令牌。

    启动可能在 ``asyncio.wait_for`` 超时后仍留在后台线程里（to_thread 无法取消），
    也可能被用户 Stop 打断。令牌让仍在跑的启动流程在下一个检查点自行退出，
    而不是在 HTTP 已经返回失败后偷偷把会话装上去（表现为"前端显示超时，稍后日志
    却打印 RTT 启动成功"，随后 Stop/Start 状态完全错乱）。
    """

    __slots__ = ("cancel", "created_at")

    def __init__(self):
        self.cancel = threading.Event()
        self.created_at = time.monotonic()


class _RttSession:
    """一个 RTT 会话的完整状态（每个探针同时最多一个）。

    轮询线程持有会话对象本身，而不再每轮从共享字典按 uid 取状态：这样 stop()
    之后即使旧线程还卡在一次读里，它醒来也会发现"我已经不是当前会话"并退出，
    不会因为新会话复用了同一个 uid 而继续跑（旧实现会因此泄漏轮询线程，多个
    线程同时读同一 target，最终把 J-Link/应用拖死）。
    """

    __slots__ = ("uid", "cb", "lock", "running", "stop", "thread",
                 "up_channel", "down_channel", "user_halted")

    def __init__(self, uid: str, cb, up_channel: int, down_channel: int):
        self.uid = uid
        self.cb = cb
        self.lock = threading.Lock()
        self.running = threading.Event()
        self.running.set()
        self.stop = threading.Event()
        self.thread: Optional[threading.Thread] = None
        self.up_channel = up_channel
        self.down_channel = down_channel
        self.user_halted = False


class RTTBackend:
    """RTT 后端

    为每个探针维护一个 RTTControlBlock 和轮询线程。
    线程安全：每个探针一把锁，协调 read（轮询线程）与 write（发送数据）。
    """

    def __init__(self):
        # uid -> _RttSession（当前活动会话）
        self._sessions: dict[str, _RttSession] = {}
        # uid -> _StartToken（正在进行的启动流程，可被 stop()/超时取消）
        self._starting: dict[str, _StartToken] = {}
        # 全局锁，保护字典操作
        self._global_lock = threading.Lock()
        # uid -> RTT 操作互斥锁（start/reset 共用，threading.Lock）。防止 asyncio.wait_for
        # 超时后残留的 to_thread 僵尸线程与下一次启动/复位请求并发操作同一 target
        # （重复复位/重复启轮询）。
        self._ops_locks: dict[str, threading.Lock] = {}
        # uid -> 最近一次成功获取操作锁的时间戳（monotonic），用于识别僵尸线程遗留
        # 长期持有操作锁的场景，从而允许 reset_target 强制接管。
        self._ops_lock_stamp: dict[str, float] = {}
        # uid -> 上行数据环形缓存（供 REST / CLI 增量读取；stop 后保留历史）
        self._captures: dict[str, RttCapture] = {}

    def start(
        self,
        uid: str,
        address: Optional[int] = None,
        size: Optional[int] = None,
        up_channel: int = 0,
        down_channel: int = 0,
    ) -> dict:
        """启动 RTT（带每探针互斥 + 可取消令牌）

        此方法经 asyncio.to_thread 调用，外层有 RTT_START_TIMEOUT 兜底；但超时后
        线程并不会真正终止（to_thread 无法取消）。这里做两层保护：

        1. ``_starting`` 令牌：同一探针同时只允许一个启动流程，重复请求立即返回
           "启动仍在进行中"，不再排队 6s 后才失败；
        2. 令牌可被 :meth:`cancel_start` / :meth:`stop` 置位，后台线程在下一个
           检查点（每次块读、复位等待前后）自行退出，不会在 HTTP 已经超时之后
           再把会话装上去。
        """
        with self._global_lock:
            lock = self._ops_locks.setdefault(uid, threading.Lock())
            if uid in self._starting:
                return {"success": False, "busy": True,
                        "error": "该探针的 RTT 启动仍在进行中（正在扫描控制块），请稍候"}
        if not lock.acquire(timeout=RTT_OP_LOCK_WAIT):
            return {"success": False,
                    "error": "已有另一个 RTT 复位/启动操作进行中，请稍后重试"}
        token = None
        try:
            # 拿到操作锁后再次检查：避免与 stop() 或另一个刚结束的 start 竞争
            with self._global_lock:
                if uid in self._starting:
                    return {"success": False, "busy": True,
                            "error": "该探针的 RTT 启动仍在进行中（正在扫描控制块），请稍候"}
                token = _StartToken()
                self._starting[uid] = token
            return self._start_inner(uid, address=address, size=size,
                                     up_channel=up_channel,
                                     down_channel=down_channel, token=token)
        finally:
            if token is not None:
                with self._global_lock:
                    if self._starting.get(uid) is token:
                        self._starting.pop(uid, None)
            lock.release()

    def cancel_start(self, uid: str, reason: str = "timeout") -> bool:
        """请求取消该探针仍在进行的 RTT 启动（HTTP 超时 / stop / 断开时调用）。

        Returns:
            True 表示确实有一个启动流程被标记取消。
        """
        with self._global_lock:
            token = self._starting.get(uid)
        if token is None:
            return False
        token.cancel.set()
        event_manager.log("warning", f"RTT: 已请求取消正在进行的启动（{reason}）")
        return True

    def _start_inner(
        self,
        uid: str,
        address: Optional[int] = None,
        size: Optional[int] = None,
        up_channel: int = 0,
        down_channel: int = 0,
        token: Optional[_StartToken] = None,
    ) -> dict:
        """启动 RTT 核心实现（启动流程已在 start() 中加互斥）

        在目标 RAM 中搜索 RTT 控制块（SEGGER RTT 标识），解析 up/down 通道。
        搜索完成后恢复目标运行，使固件可以写入 RTT 缓冲区。

        Args:
            address: 控制块搜索起始地址，None 则自动扫描默认 RAM 区域
            size: 控制块搜索范围大小，None 则自动
            up_channel: 监听的 up channel 索引（target -> host）
            down_channel: 发送的 down channel 索引（host -> target）
            token: 启动取消令牌（None 表示独立调用，不响应取消）

        Returns:
            {success, up_channels, down_channels, error?}
        """
        if token is None:
            token = _StartToken()

        def _cancelled() -> bool:
            return token.cancel.is_set()

        def _cancelled_result() -> dict:
            return {"success": False, "cancelled": True,
                    "error": "RTT 启动已取消（超时/停止）"}

        # 已在运行则先返回当前状态
        with self._global_lock:
            current = self._sessions.get(uid)
            if current is not None and current.running.is_set():
                return self._build_start_result(current.cb, uid, up_channel, down_channel)

        if _cancelled():
            return _cancelled_result()

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
            state = "unknown"
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
                # 扫描顺序：优先主 SRAM（0x2000_0000~0x3FFF_FFFF），再按容量从大到小。
                # 多数 Cortex-M 的控制块在 0x2000_0000 起的 .bss 里，而 CCM/DTCM
                # （如 STM32F407 的 0x1000_0000，64KB）通常没有 RTT 且可能根本读不动。
                # 先扫 SRAM 就能在 0.2s 内命中并完全跳过 CCM，避免开局先吃一次
                # 不可读区段的失败（J-Link 首次失败可达数秒）。
                ram_regions.sort(key=self._rtt_region_priority)
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

            # 目标当前停在哪：这是"控制块不存在"时最有价值的信息。
            # 以前这里 dump 每个 RAM region 前 32 字节，但控制块几乎从不落在
            # region 起始处（本固件在 0x20000840，region 起始 0x20000000 完全是
            # 别的东西），所以那几行 hex 只会把人引向错误方向。
            event_manager.log("info", f"RTT: 目标状态 {state}，开始定位控制块")

            cb = None
            last_error = None
            # ELF 符号已经确认控制块地址上是未初始化数据（固件没跑到 SEGGER_RTT_Init）
            symbol_checked = False
            # 记录每个 region 的扫描结论，失败时汇总成可执行的错误信息
            scan_failures: list[str] = []
            # 本次启动中已确认不可读的地址范围。启动失败会复位重试搜索，
            # 不可读的 CCM 区段没必要每次再花几秒去失败一次（J-Link 首次
            # 访问坏区段可能要 2~9s）。
            dead_ranges: list[tuple[int, int]] = []

            def _in_dead_range(lo: int, hi: int) -> bool:
                for dead_lo, dead_hi in dead_ranges:
                    if lo < dead_hi and hi > dead_lo:
                        return True
                return False

            def _try_parse_at(addr: int, origin: str):
                """在指定地址解析控制块；不成立则返回 None。"""
                if _cancelled():
                    return None
                try:
                    cb_obj = RTTControlBlock.from_target(target, address=addr, size=0)
                    cb_obj.start()
                    if len(cb_obj.up_channels) > 0:
                        event_manager.log("info", f"RTT: 控制块已确认 @0x{addr:08X}（{origin}）")
                        return cb_obj
                    event_manager.log("warning", f"RTT: 0x{addr:08X} 处有 RTT 标识但无 up channel"
                                      f"（{origin}），忽略")
                except Exception as e:
                    event_manager.log("warning", f"RTT: 解析 0x{addr:08X} 失败（{origin}）: {e}")
                return None

            def _log_scan_result(r, res) -> None:
                """把一次 region 扫描的结论压缩成一两条日志（不再逐 64B 段刷屏）。"""
                failures = res.get("failures") or []
                if res.get("unreadable"):
                    event_manager.log(
                        "warning",
                        f"RTT: region 0x{r.start:08X} 不可读，已跳过"
                        + (f"（{failures[0]}）" if failures else ""))
                    return
                if failures:
                    shown = "；".join(failures[:2])
                    more = f" 等共 {res.get('failure_count', len(failures))} 段" \
                        if res.get("failure_count", len(failures)) > 2 else ""
                    event_manager.log(
                        "info",
                        f"RTT: region 0x{r.start:08X} 部分区段不可读（{shown}{more}），"
                        "已扫描可读部分")
                if res["hit"] is None:
                    event_manager.log("info", f"RTT: no control block in region 0x{r.start:08X}")

            def _search_control_block(limit_bytes: Optional[int] = None):
                """在所有 RAM region 中搜索 RTT 控制块

                如果用户指定了 address，只搜索指定范围；
                否则遍历所有 RAM region（对标 J-Link RTT Viewer 的行为）。
                limit_bytes 非 None 时，每个 RAM region 只扫描起始 limit_bytes
                字节（快速探测）；None 时完整扫描整个 region。
                每次块读之间都会检查取消令牌，Stop/HTTP 超时后能在一次读的
                时间内退出，而不是扫完整个 RAM。
                """
                nonlocal last_error
                del scan_failures[:]

                # 用户指定了地址，只搜索指定范围
                if address is not None:
                    range_end = address + (size or 1)
                    if _in_dead_range(address, range_end):
                        # 已经确认读不动：直接给出与首次失败一致的结论，不要用
                        # "跳过重复尝试"覆盖真正的错误（否则用户看不到根因）。
                        msg = f"0x{address:08X} 区段不可读（本次启动中已确认）"
                        scan_failures.append(msg)
                        if not last_error:
                            last_error = msg
                        event_manager.log("info",
                                          f"RTT: 用户指定范围 0x{address:08X} 在本次启动中"
                                          "已确认不可读，跳过重复尝试")
                        return None
                    event_manager.log("info", f"RTT: searching at specified address 0x{address:08X}"
                                      f"{f' size=0x{size:X}' if size else ''}...")
                    if size:
                        res = self._fast_scan_region(target, address, size,
                                                     cancel=token.cancel)
                        hit = res["hit"]
                        if res.get("unreadable"):
                            dead_ranges.append((address, range_end))
                        if res["candidates"]:
                            for cand in res["candidates"]:
                                cb_obj = _try_parse_at(cand, "用户指定范围内候选")
                                if cb_obj is not None:
                                    return cb_obj
                        if hit is None:
                            if res["failures"]:
                                scan_failures.extend(res["failures"])
                                last_error = (f"用户指定范围 0x{address:08X} "
                                              f"(size=0x{size:X}) 有区段无法读取："
                                              + "；".join(res["failures"][:2]))
                            elif not res["candidates"]:
                                last_error = (f"用户指定范围 0x{address:08X} "
                                              f"(size=0x{size:X}) 中未找到控制块")
                            return None
                    cb_obj = _try_parse_at(address, "用户指定地址")
                    if cb_obj is not None:
                        return cb_obj
                    if not last_error:
                        last_error = f"用户指定地址 0x{address:08X} 处没有可用的控制块"
                    return None

                # 自动模式：遍历所有 RAM region，用大块 read32 粗扫定位控制块
                for r in ram_regions:
                    if _cancelled():
                        return None
                    if _in_dead_range(r.start, r.start + r.length):
                        scan_failures.append(
                            f"0x{r.start:08X}~0x{r.start + r.length:08X} 不可读（已确认）")
                        event_manager.log("info",
                                          f"RTT: region 0x{r.start:08X} 本次启动中已确认"
                                          "不可读，跳过")
                        continue
                    effective = None
                    if limit_bytes is not None and r.length > limit_bytes:
                        effective = limit_bytes
                    scope = f"first {effective // 1024}KiB" if effective else "all"
                    event_manager.log("info", f"RTT: scanning RAM region 0x{r.start:08X} "
                                      f"(size=0x{r.length:X}, scope={scope})...")
                    res = self._fast_scan_region(target, r, max_bytes=effective,
                                                 cancel=token.cancel)
                    _log_scan_result(r, res)
                    if res.get("unreadable"):
                        dead_ranges.append((r.start, r.start + r.length))
                    for f in res["failures"]:
                        scan_failures.append(f)
                    if res["candidates"]:
                        for cand in res["candidates"]:
                            cb_obj = _try_parse_at(cand, f"region 0x{r.start:08X} 候选")
                            if cb_obj is not None:
                                return cb_obj
                if _cancelled():
                    return None
                if scan_failures:
                    last_error = ("控制块未找到，且以下 RAM 段无法读取：" +
                                  "；".join(scan_failures[:4]))
                else:
                    last_error = "Control block not found in any RAM region"
                return None

            # 第0优先：ELF 符号 _SEGGER_RTT。固件一般都把控制块放在 .bss 里，
            # 符号地址是确定值，一次读就能确认——完全不需要扫 RAM。
            # 这是把"192KB 全扫 6.5s"降成"1 次读 8ms"的关键优化。
            if address is None:
                sym_addr = None
                try:
                    from core.elf_backend import elf_backend
                    if elf_backend.is_loaded(uid):
                        sym_addr = elf_backend.get_symbol_address(uid, RTT_CB_SYMBOL)
                except Exception as e:
                    event_manager.log("info", f"RTT: 查询 {RTT_CB_SYMBOL} 符号失败: {e}")
                if sym_addr:
                    in_ram = any(r.start <= sym_addr < r.start + r.length for r in ram_regions)
                    if in_ram:
                        event_manager.log("info", f"RTT: ELF 符号 {RTT_CB_SYMBOL} = "
                                          f"0x{sym_addr:08X}，直接校验...")
                        try:
                            head = bytes(target.read_memory_block8(sym_addr, RTT_CB_ID_LEN))
                        except Exception as e:
                            head = b''
                            event_manager.log("warning",
                                              f"RTT: 读符号地址 0x{sym_addr:08X} 失败: {e}")
                        # 只比较 "SEGGER RTT" 这 10 字节：acID 是 16 字节数组，
                        # 后面的字节依 SEGGER 版本/编译期 SEGGER_RTT_SECTION 处理方式
                        # 可能是残留值（我们不比 16 字节，否则会漏掉真实控制块，
                        # 只是额外多走一遍扫描）。完整结构交给 pyOCD 解析器校验。
                        if head.startswith(RTT_CB_ID):
                            cb = _try_parse_at(sym_addr, f"{RTT_CB_SYMBOL} 符号")
                        elif head:
                            event_manager.log("info",
                                              f"RTT: 符号地址 0x{sym_addr:08X} 处不是已初始化的控制块"
                                              f"（当前 acID={head!r}）——固件可能还没跑到 "
                                              f"SEGGER_RTT_Init()")
                            symbol_checked = True
                    elif sym_addr:
                        event_manager.log("info", f"RTT: 符号 {RTT_CB_SYMBOL}=0x{sym_addr:08X} "
                                          f"不在任何 RAM region 内，跳过")

            # 第1轮：低地址快速探测（每个 RAM region 前 16KB）。控制块就在 .bss 前部
            # 时（绝大多数固件）这一步即可命中；16KB@28KB/s ≈ 0.6s，远快于原来的 64KB。
            if cb is None and not _cancelled():
                event_manager.log("info", "RTT: 低地址快速探测（每个 RAM region 前 16KB）...")
                cb = _search_control_block(limit_bytes=0x4000)

            if _cancelled():
                return _cancelled_result()

            # 探测未命中且目标处于暂停态：主场景（如"下载程序后未复位运行"）固件
            # 尚未初始化 RTT。单纯 resume 不会重跑启动代码，必须复位运行，让固件
            # 初始化控制块后再搜索（对标 J-Link RTT Viewer 的默认行为）。
            target_halted = False
            try:
                target_halted = (target.get_state() == Target.State.HALTED)
            except Exception:
                # 无法读取目标状态时保守按暂停态处理，尝试复位运行
                target_halted = True
            # 已经通过 ELF 符号确认控制块地址上放着"未初始化的控制块"时，
            # 说明固件根本没跑到 SEGGER_RTT_Init()（或者压根没在跑）。
            # 此时反复复位运行只是在烧时间（实测每次复位+全扫约 8s，
            # 两轮就是 17s），改用一次完整扫描确认即可。
            if cb is None and target_halted and symbol_checked:
                event_manager.log("info",
                                  "RTT: 控制块地址上仍是未初始化数据，跳过复位重试，"
                                  "只做一次完整扫描确认...")
                cb = _search_control_block()
            elif cb is None and target_halted:
                event_manager.log("info",
                                  "RTT: 未找到控制块，执行【复位并运行】让固件初始化 RTT...")
                reset_attempts = 0
                max_reset_attempts = 2
                reboot_sleep = 1.2  # 等待固件启动并完成 RTT 控制块初始化
                while cb is None and reset_attempts < max_reset_attempts:
                    if _cancelled():
                        return _cancelled_result()
                    reset_attempts += 1
                    try:
                        target.reset(reset_type=None)   # 复位使固件从启动代码重新执行
                        target.resume()                 # 运行，让 RTT 初始化代码执行
                    except Exception as e:
                        event_manager.log("warning", f"RTT: 复位运行目标失败: {e}")
                        break

                    # 用 Event.wait 而不是 sleep：Stop/超时能在 1.2s 等待中立刻打断
                    if token.cancel.wait(reboot_sleep):
                        return _cancelled_result()

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
            if cb is None and not target_halted and not _cancelled():
                event_manager.log("info", "RTT: 低地址未命中，对全部 RAM 完整扫描...")
                cb = _search_control_block()

            if _cancelled():
                return _cancelled_result()

            if cb is None or len(cb.up_channels) == 0:
                # 失败时给出可执行的诊断：
                #   1) 目标"当前停在哪"——固件在初始化 RTT 之前就挂住/跑飞时，
                #      控制块永远不存在，扫描再久也没用。带上 PC+符号一眼可见。
                #   2) 扫描过程中真实读不动的 RAM 段，而不是含糊的"未检测到控制块"。
                reason = f"（{last_error}）" if last_error else ""
                where = _halted_location(uid)
                msg = ("未检测到 SEGGER RTT 控制块" + reason + "。")
                if scan_failures:
                    # 扫描本身有读失败：真正的原因是"这些 RAM 段读不动"，
                    # 不要再让用户去怀疑固件有没有初始化 RTT。
                    msg += ("上述 RAM 段无法读取，通常说明目标内存映射与芯片不符"
                            "（例如把不存在的 CCM 区段列为 RAM）、目标掉电，"
                            "或调试探针访问受限；请确认目标型号/连接后重试。")
                elif where:
                    msg += f"{where}——"
                    msg += ("若该地址停在死循环/异常处理里，说明固件尚未执行到 "
                            "SEGGER_RTT_Init()，控制块还没被写进 RAM；"
                            "请先确认固件能正常启动。")
                else:
                    msg += ("请确认固件已链接并初始化 SEGGER RTT 库"
                            "（SEGGER_RTT_Init / SEGGER_RTT_ConfigUpBuffer），"
                            "或在启动参数中显式指定控制块地址。")
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

            # 收尾竞态：控制块虽然找到了，但请求可能已经超时/被 Stop 取消。
            # 此时绝不能把会话装上去——否则前端已显示"启动失败/已停止"，后端却
            # 在轮询、稍后还推送 rtt.started（用户看到的"通知成功/状态错乱"）。
            with self._global_lock:
                if _cancelled() or self._starting.get(uid) is not token:
                    return _cancelled_result()
                previous = self._sessions.get(uid)
                session = _RttSession(uid, cb, up_channel, down_channel)
                self._sessions[uid] = session
                # 新会话从空缓存开始（固件重新初始化后控制块/缓冲区地址都可能变化），
                # 但 seq 续用上一次的 next_seq：这样旧会话的 --since 游标仍然有效，
                # 不会因为两个会话块数相同而误判成“没有新数据”。
                prev_capture = self._captures.get(uid)
                start_seq = prev_capture.stats()["next_seq"] if prev_capture is not None else 1
                self._captures[uid] = RttCapture(start_seq=start_seq)
                # 旧会话（理论上 stop() 已清理；这里兜底，避免线程泄漏）
                if previous is not None:
                    previous.stop.set()
                    previous.running.clear()

            # 找到控制块后恢复目标运行（对标 CLI：search → resume）
            try:
                target.resume()
            except Exception:
                pass

            event_manager.log("info", f"RTT: started (up={up_channel}, down={down_channel})")
            event_manager.emit("rtt.started", {"uid": uid})

            # 启动轮询线程（线程持有 session 对象，stop 后不会被新会话"复活"）
            thread = threading.Thread(target=self._poll_loop, args=(session,),
                                      daemon=True, name=f"rtt-poll-{uid[:12]}")
            session.thread = thread
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

    @staticmethod
    def _rtt_region_priority(region) -> tuple:
        """RAM region 扫描顺序：主 SRAM 优先，其次容量大的。

        多数 Cortex-M 的 RTT 控制块在 0x2000_0000 起的 .bss 中；CCM/DTCM
        （如 STM32F407 的 0x1000_0000）通常没有 RTT，而且部分 J-Link 配置下
        根本读不动。先扫主 SRAM 可以在亚秒级命中并跳过这些区段。
        """
        start = getattr(region, "start", 0)
        length = getattr(region, "length", 0)
        preferred = 0 if 0x20000000 <= start < 0x40000000 else 1
        return (preferred, -int(length), int(start))

    def _poll_loop(self, session: _RttSession):
        """轮询线程：持续读取所有 up channel 数据并推送到前端

        线程持有创建它时的 ``session`` 对象：每轮先确认自己仍是该 uid 的当前
        会话（``self._sessions[uid] is session``），否则退出。这样 stop() 后
        即使线程还卡在一次读里，醒来也不会因为新会话复用了同一个 uid 而继续
        跑——旧实现会因此泄漏轮询线程，多线程同时读同一 target，最终拖死应用。

        自动恢复机制：定期检查目标内核状态，若检测到内核被暂停（如硬件复位后
        pyOCD 的 reset catch 机制暂停了内核），且非用户主动暂停，则自动 resume，
        使固件重新运行并恢复 RTT 数据流。同时重新读取控制块描述符，确保缓存
        的 buffer 地址/大小与复位后固件重新初始化的值一致。
        """
        uid = session.uid
        poll_interval = POLL_INTERVAL
        consecutive_errors = 0
        # 内核状态检查计数器（每 ~3 秒检查一次，避免高频 SWD 事务增加延迟）
        state_check_counter = 0
        STATE_CHECK_INTERVAL = 300  # 300 * 10ms = 3s

        while not session.stop.is_set():
            if self._sessions.get(uid) is not session:
                break

            # 探针已断开（只由仍持有会话的一方通知，避免 stop() 已通知后重复）
            if not backend.is_connected(uid):
                event_manager.emit("rtt.stopped", {"uid": uid, "reason": "disconnected"})
                break

            # 定期检查目标内核状态，自动恢复因硬件复位而暂停的内核
            state_check_counter += 1
            if state_check_counter >= STATE_CHECK_INTERVAL:
                state_check_counter = 0
                self._check_and_auto_resume(session)

            # 与调试/Flash 操作协调：commander 调试命令、寄存器读取、Flash 操作
            # 都会持有 per-uid op_lock。RTT 轮询用非阻塞方式获取，拿不到就跳过本轮，
            # 避免两者并发访问同一 target（pyOCD target 不是线程安全的），
            # 典型症状是偶发的 "Target is not halted" 或寄存器读取失败。
            op_lock = backend.get_op_lock(uid)
            if not op_lock.acquire(blocking=False):
                session.stop.wait(poll_interval)
                continue

            sleep_for = poll_interval
            try:
                capture = self._captures.get(uid)
                with session.lock:
                    # 遍历所有 up channels，分别读取并推送
                    for up_idx, up_ch in enumerate(session.cb.up_channels):
                        try:
                            data = up_ch.read()
                        except Exception:
                            # 单个通道读取失败不影响其他通道
                            data = None
                        if data:
                            # 先落缓存，再推 WebSocket：GUI 与 CLI/CI 看到的是同一份数据，
                            # 且 REST 侧不会因为 GUI 未连接而拿不到任何日志。
                            if capture is not None:
                                try:
                                    capture.append(up_idx, data)
                                except Exception:
                                    pass
                            event_manager.emit("rtt.data", {
                                "uid": uid,
                                "channel": up_idx,
                                "data": base64.b64encode(data).decode("ascii"),
                                "size": len(data),
                            })
                consecutive_errors = 0
            except Exception as e:
                consecutive_errors += 1
                if consecutive_errors <= 3:
                    logger.warning(f"RTT poll error (#{consecutive_errors}): {e}")
                if consecutive_errors == 1:
                    event_manager.emit("rtt.error", {"uid": uid, "error": str(e)})
                # 错误时退避，避免刷屏
                sleep_for = min(0.5, poll_interval * (2 ** consecutive_errors))
            finally:
                op_lock.release()
            session.stop.wait(sleep_for)

        # 线程退出时清理
        event_manager.log("info", f"RTT: polling stopped for probe {uid[:16]}")

    def _check_and_auto_resume(self, session: _RttSession):
        """检查目标内核状态，若被暂停且非用户主动暂停则自动恢复

        硬件复位后 pyOCD 的 reset catch 机制会暂停内核，导致固件不运行、
        RTT 无数据。此方法检测到该情况后自动 resume，并重新读取控制块描述符
        以同步固件重新初始化后的 buffer 地址/大小。
        """
        uid = session.uid
        if session.user_halted:
            return  # 用户主动暂停，不自动恢复
        if session.stop.is_set() or self._sessions.get(uid) is not session:
            return

        # 与调试/Flash 操作互斥：拿不到就跳过本轮状态检查，避免并发访问 target。
        op_lock = backend.get_op_lock(uid)
        if not op_lock.acquire(blocking=False):
            return
        try:
            from pyocd.core.target import Target
            target = getattr(session.cb, 'target', None)
            if target is None:
                py_session = backend._get_session(uid)
                if not py_session:
                    return
                target = py_session.target

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
                    with session.lock:
                        for up_ch in session.cb.up_channels:
                            if hasattr(up_ch, '_read_descriptor'):
                                up_ch._read_descriptor()
                except Exception as e:
                    event_manager.log("warning",
                                      f"RTT: 重新读取控制块描述符失败: {e}")

                event_manager.log("info", "RTT: 目标内核已自动恢复运行")
        except Exception:
            pass  # 状态检查失败不影响正常轮询
        finally:
            op_lock.release()

    def set_user_halted(self, uid: str, halted: bool) -> None:
        """标记目标是否由用户主动暂停（供 Zone/CLI 的 halt/run/reset 调用）。

        RTT 轮询线程的自动恢复逻辑只认这个标志。若 Zone 的 `debug halt` 不设置它，
        轮询线程会把用户暂停当成“硬件复位导致的暂停”而自动 resume，表现为
        halt 之后目标又跑起来、寄存器读取偶发失败。
        """
        with self._global_lock:
            session = self._sessions.get(uid)
            if session is not None:
                session.user_halted = bool(halted)

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
                rtt_session = self._sessions.get(uid)
                if rtt_session is not None:
                    rtt_session.user_halted = False
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
                rtt_session = self._sessions.get(uid)
                if rtt_session is not None:
                    rtt_session.user_halted = True
            event_manager.log("info", "RTT: 目标内核已暂停 (halt)")
            return {"success": True, "state": "halted"}
        except Exception as e:
            event_manager.log("warning", f"RTT: halt 目标失败: {e}")
            return {"success": False, "error": str(e)}

    def reset_target(self, uid: str, run: bool = True) -> dict:
        """仅复位目标芯片

        只执行芯片硬件复位；run=True 时复位后顺带 resume 让固件继续运行，
        不做 RTT 控制块重搜/重初始化（固件重跑的 RTT 控制块通常在同一地址，
        签名与指针会在下次读取时由固件重新写入）。

        Args:
            run: True=复位后运行（重启固件），False=复位后保持 halt
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
            # 卡住时日志会停在对应 [n/3] 以定位挂起点。
            event_manager.log("info", "RTT: reset[1/3] halt...")
            # 1) halt 目标（确保安全操作）
            try:
                session.target.halt()
            except Exception:
                pass

            event_manager.log("info", "RTT: reset[2/3] core reset...")
            # 2) 复位目标芯片；--no-run 用 reset_and_halt，避免 reset 后自动运行
            if run:
                session.target.reset(reset_type=None)
            else:
                session.target.reset_and_halt()
            event_manager.log("info", f"RTT: 目标已复位 (run={run})")

            event_manager.log("info", "RTT: reset[3/3] resume...")
            if run:
                # 3) resume 目标，让固件继续运行（重启固件），不重搜/重初始化 RTT 控制块
                try:
                    session.target.resume()
                except Exception:
                    pass
                with self._global_lock:
                    rtt_session = self._sessions.get(uid)
                    if rtt_session is not None:
                        rtt_session.user_halted = False
            else:
                with self._global_lock:
                    rtt_session = self._sessions.get(uid)
                    if rtt_session is not None:
                        rtt_session.user_halted = True

            state = "running" if run else "halted"
            event_manager.log("info", "RTT: reset 完成，仅芯片复位")
            return {"success": True, "state": state}
        except Exception as e:
            event_manager.log("warning", f"RTT: reset 目标失败: {e}")
            return {"success": False, "error": str(e)}
        finally:
            # 只释放本线程实际获取到的操作锁；绝不释放被内层逻辑覆盖/从未持有的锁
            if acquired:
                op_lock.release()

    def _read_region_block32(self, target, addr: int, words: int, failures: list,
                             depth: int = 0,
                             counter: Optional[dict] = None) -> list:
        """读取 words 个字；遇到坏块时**有限深度**二分下探定位读不动的段。

        返回实际读到的 (起始地址, 字列表) 列表——可能是 0/1/多段。

        旧实现一路二分到 64 字节：一个 64KB 的不可读区段会被放大成 2048 次读 +
        1024 条失败记录（用户看到的 0x1000F2C0~0x1000F300 刷屏），J-Link 下首次
        16KB 读就可能阻塞数秒，最终把 RTT 启动拖过超时。现在最多下探
        ``RTT_SCAN_MAX_BISECT_DEPTH`` 级（16KB→4KB→1KB），1KB 仍失败就整段记为
        不可读；失败明细还有条数上限，避免日志/内存被刷爆。

        counter 可选：累计真实失败段数（含超出明细上限的部分），调用方据此判断
        「整段不可读」。
        """
        try:
            return [(addr, target.read_memory_block32(addr, words))]
        except Exception as e:
            remaining = RTT_SCAN_MAX_FAILURES - len(failures)
            if counter is not None:
                counter["n"] = counter.get("n", 0) + 1
            if (words <= RTT_SCAN_MIN_WORDS
                    or depth >= RTT_SCAN_MAX_BISECT_DEPTH
                    or remaining <= 0):
                if remaining > 0:
                    failures.append(
                        f"0x{addr:08X}~0x{addr + words * 4:08X} 读取失败（{e}）")
                return []
            # 四等分（比二分少一层、且同一层失败可被调用方判定为整段不可读）
            part = words // 4
            if part < RTT_SCAN_MIN_WORDS:
                part = words // 2
                splits = 2
            else:
                splits = 4
            out: list = []
            for i in range(splits):
                sub_addr = addr + i * part * 4
                sub_words = part if i < splits - 1 else words - part * (splits - 1)
                if sub_words <= 0:
                    break
                out += self._read_region_block32(target, sub_addr, sub_words,
                                                 failures, depth + 1, counter)
            return out

    def _fast_scan_region(self, target, region, max_bytes: Optional[int] = None,
                          magic: bytes = RTT_MAGIC,
                          control_block_id: bytes = RTT_CB_ID,
                          cancel: Optional[threading.Event] = None) -> dict:
        """在单个 RAM region（或任意地址区间）中快速定位 RTT 控制块。

        用大块 read_memory_block32 批量读取，在 host 侧匹配 'SEGG' 前缀
        （小端 word）。命中后再按字内偏移还原真实起始地址并回读 16 字节确认
        完整 'SEGGER RTT' 标识——所以控制块即使不是 4 字节对齐也能找到。

        返回 {"hit", "candidates", "failures", "unreadable", "failure_count",
        "reads"}：
          hit           第一个确认命中的控制块地址（兼容旧调用方）
          candidates    在范围内确认带完整标识的候选地址列表
          failures      读取失败的 RAM 段描述（有上限，调用方必须报出来）
          unreadable    起始探测即失败 / 连续失败：整段不可读，已提前放弃
          failure_count 实际失败段总数（可能大于 len(failures)）
          reads         实际发出的读请求次数（测试与诊断用）

        max_bytes 非 None 时只扫描 region 起始 max_bytes（0 或 None 表示全扫）。
        region 也可以是整数起始地址（此时 max_bytes 必须给出长度）。
        cancel 置位时在块边界立即返回。
        """
        magic_int = int.from_bytes(magic, 'little')  # b'SEGG' -> 0x47474553
        if isinstance(region, int):
            start = region
            if max_bytes is None:
                raise ValueError("region 为整数地址时必须给出 max_bytes 作为长度")
            span = max_bytes
        else:
            start = region.start
            span = region.length if (max_bytes is None or max_bytes <= 0) \
                else min(max_bytes, region.length)
        region_end = start + span
        cid_len = max(RTT_CB_ID_LEN, len(control_block_id))
        failures: list = []
        candidates: list = []
        fail_counter = {"n": 0}
        reads = 0
        hit = None
        unreadable = False

        def _note_failure(text: str) -> None:
            fail_counter["n"] += 1
            if len(failures) < RTT_SCAN_MAX_FAILURES:
                failures.append(text)

        # 起始可读性探测：16 字节，读不动就整段跳过。比"读 16KB 才发现读不动"
        # 少一次可能长达数秒的 J-Link 失败重试，也不会产生大量失败明细。
        if span > 0:
            probe_len = min(RTT_SCAN_PROBE_BYTES, span)
            reads += 1
            try:
                probe = bytes(target.read_memory_block8(start, probe_len))
            except Exception:
                probe = None
                unreadable = True
            if probe is None:
                _note_failure(f"0x{start:08X} 起始 {probe_len} 字节不可读")
                return {"hit": None, "candidates": [], "failures": failures,
                        "unreadable": True, "failure_count": fail_counter["n"],
                        "reads": reads}

        consecutive_failures = 0
        addr = start
        while addr < region_end:
            if cancel is not None and cancel.is_set():
                break
            n = min(RTT_SCAN_WORDS_PER_READ, (region_end - addr) // 4)
            if n <= 0:
                break
            before = fail_counter["n"]
            reads += 1
            for base, words in self._read_region_block32(target, addr, n, failures,
                                                         0, fail_counter):
                for i, w in enumerate(words):
                    w &= 0xFFFFFFFF
                    # 4 字节对齐命中；同时检查跨字的不对齐命中（'SEGG' 落在
                    # 字内偏移 1~3 时会跨到下一个字）。旧实现对每个偏移都回读
                    # 16 字节确认，非对齐偏移永远不可能命中，纯属浪费读请求。
                    offsets = [0] if w == magic_int else []
                    if i + 1 < len(words):
                        nxt = words[i + 1] & 0xFFFFFFFF
                        for off in (1, 2, 3):
                            shifted = ((w >> (8 * off)) |
                                       ((nxt << (32 - 8 * off)) & 0xFFFFFFFF))
                            if shifted == magic_int:
                                offsets.append(off)
                    for off in offsets:
                        cand = base + i * 4 + off
                        if cand < start or cand + cid_len > region_end:
                            continue
                        if cand in candidates:
                            continue
                        reads += 1
                        try:
                            raw = bytes(target.read_memory_block8(cand, cid_len))
                        except Exception as e:
                            _note_failure(f"0x{cand:08X} 候选确认读取失败（{e}）")
                            continue
                        if raw.startswith(control_block_id):
                            candidates.append(cand)
                            if hit is None:
                                hit = cand
            if fail_counter["n"] > before:
                consecutive_failures += 1
                if consecutive_failures >= RTT_SCAN_MAX_CONSECUTIVE_FAILURES:
                    # 连续两个 16KB 块读不动：这不是"局部坏点"，而是整段不可读
                    # （CCM/未上电的 RAM 区…），继续扫只会重复失败。
                    unreadable = True
                    break
            else:
                consecutive_failures = 0
            addr += n * 4
        return {"hit": hit, "candidates": candidates, "failures": failures,
                "unreadable": unreadable, "failure_count": fail_counter["n"],
                "reads": reads}

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
        with self._global_lock:
            session = self._sessions.get(uid)
        if session is None:
            return {"success": False, "error": "RTT not started"}

        down_idx = channel if channel is not None else session.down_channel

        try:
            with session.lock:
                if down_idx >= len(session.cb.down_channels):
                    return {"success": False, "error": f"Invalid down channel {down_idx}"}
                if not session.cb.down_channels:
                    return {"success": False, "error": "No down channels available"}
                written = session.cb.down_channels[down_idx].write(data)
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
        with self._global_lock:
            session = self._sessions.get(uid)
        if session is None:
            return {"success": False, "error": "RTT not started"}
        return self._build_start_result(session.cb, uid,
                                        session.up_channel, session.down_channel)

    def get_capture_stats(self, uid: str) -> dict:
        """上行缓存统计；该探针从未启动过 RTT 时返回 available=False。"""
        capture = self._captures.get(uid)
        if capture is None:
            return {"available": False, "buffered_bytes": 0, "next_seq": 0, "oldest_seq": 0,
                    "dropped_bytes": 0, "dropped_chunks": 0}
        stats = capture.stats()
        stats["available"] = True
        return stats

    def read_capture(
        self,
        uid: str,
        since: int = 0,
        max_bytes: int = RTT_CAPTURE_MAX_BYTES,
        channel: Optional[int] = None,
    ) -> dict:
        """读取上行缓存（供 REST / CLI）。

        RTT 未启动但存在历史缓存（例如 start → stop 后回看）时仍返回数据，
        由 ``running`` 字段告知会话是否仍在采集。
        """
        capture = self._captures.get(uid)
        if capture is None:
            return {
                "success": False,
                "error": "RTT 会话未启动：请先执行 `omni rtt start`（或 POST /api/probes/{uid}/rtt/start）",
            }
        result = capture.read(since=since, max_bytes=max_bytes, channel=channel)
        result.update({
            "success": True,
            "uid": uid,
            "running": self.is_running(uid),
            "channel": channel,
        })
        return result

    def is_running(self, uid: str) -> bool:
        """RTT 是否正在运行"""
        with self._global_lock:
            session = self._sessions.get(uid)
        return session is not None and session.running.is_set()

    def stop(self, uid: str, reason: str = "user") -> dict:
        """停止 RTT（同时取消仍在进行的启动）

        Args:
            reason: 停止原因，传递给前端用于 UI 反馈
                "user" - 用户手动停止
                "flash" - Flash 操作前自动停止（固件下载后 RTT 控制块失效）
                "disconnected" - 探针断开

        实现要点：
        - 先取消 ``_starting`` 令牌，让仍在扫描/复位等待的启动线程尽快退出，
          不会在 stop 之后又把会话装回来（用户看到的"停了又自己启动/状态错乱"）；
        - 只等轮询线程很短时间：线程可能正卡在一次 DLL 读里，join 太久没有意义，
          它持有 session 对象，醒来会因 ``stop`` 置位/会话被替换而自行退出。
        """
        with self._global_lock:
            token = self._starting.pop(uid, None)
            session = self._sessions.pop(uid, None)
        if token is not None:
            token.cancel.set()
        if session is not None:
            session.running.clear()
            session.stop.set()
            thread = session.thread
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=1.0)

        event_manager.log("info", f"RTT: stopped (reason={reason})")
        event_manager.emit("rtt.stopped", {"uid": uid, "reason": reason})
        return {"success": True}

    def on_probe_disconnected(self, uid: str):
        """探针断开时调用，清理 RTT 会话"""
        with self._global_lock:
            has_session = uid in self._sessions
        if has_session or uid in self._starting:
            self.stop(uid, reason="disconnected")

    def cleanup_all(self):
        """清理所有 RTT 会话（应用退出时调用）"""
        with self._global_lock:
            uids = set(self._sessions) | set(self._starting)
        for uid in uids:
            self.stop(uid)
        # 历史缓存随进程退出一起释放，避免 uid 长期累积
        with self._global_lock:
            self._captures.clear()


# 全局单例
rtt_backend = RTTBackend()
