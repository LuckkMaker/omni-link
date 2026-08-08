"""地址区间 / 位域工具（Zone 外设与内存批量读取）

移植自 Eclipse CDT Cloud 的 vscode-peripheral-inspector（MIT 许可）：
    - AddrRange / BitRange / AddressRangesUtils.splitIntoChunks

用途：
    - 将分散的寄存器地址合并成连续段，再按最大字节数切块，减少对目标的往返读取次数
    - 位域掩码计算（含 ≥32 位边界处理）
    - 通用地址区间合并 / 切块
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class AddrRange:
    """连续地址区间 [base, base + length)"""

    base: int
    length: int

    def nxt_addr(self) -> int:
        """区间后的下一个地址"""
        return self.base + self.length

    def end_addr(self) -> int:
        """区间内最后一个地址"""
        return self.nxt_addr() - 1


@dataclass
class BitRange:
    """位域：偏移 + 宽度"""

    offs: int
    width: int

    def mask(self) -> int:
        """返回该位域的掩码（≥32 位时返回全 32 位掩码）"""
        if self.offs + self.width >= 32:
            return 0xFFFFFFFF
        return ((1 << self.width) - 1) << self.offs


def merge_ranges(addresses: list[int], gap_threshold: int = 4) -> list[AddrRange]:
    """将地址列表合并为连续区间

    Args:
        addresses: 地址列表（任意顺序，自动去重排序）
        gap_threshold: 间隙阈值。相邻地址差 <= 阈值时视为连续合并；
                       大于阈值则断开。默认 4（32 位寄存器一个字）。

    Returns:
        合并后的区间列表，按 base 升序。
    """
    if not addresses:
        return []
    addrs = sorted(set(addresses))
    ranges: list[AddrRange] = []
    start = addrs[0]
    prev = start
    for addr in addrs[1:]:
        if addr - prev <= gap_threshold:
            prev = addr
        else:
            ranges.append(AddrRange(start, prev - start + 1))
            start = addr
            prev = addr
    ranges.append(AddrRange(start, prev - start + 1))
    return ranges


def split_into_chunks(ranges: list[AddrRange], max_bytes: int) -> list[AddrRange]:
    """将区间列表按最大字节数切块（对齐 vscode-peripheral-inspector 语义）

    Args:
        ranges: 待切分区间
        max_bytes: 每块最大字节数

    Returns:
        所有长度在 (0, max_bytes] 内的区间。
    """
    chunks: list[AddrRange] = []
    for r in ranges:
        base, length = r.base, r.length
        while length > max_bytes:
            chunks.append(AddrRange(base, max_bytes))
            base += max_bytes
            length -= max_bytes
        if length > 0:
            chunks.append(AddrRange(base, length))
    return chunks


def merge_and_split(addresses: list[int], gap_threshold: int = 4, max_bytes: int = 0) -> list[AddrRange]:
    """合并地址 → 按最大字节数切块（内存读取的通用入口）

    max_bytes <= 0 时不切块，仅合并。
    """
    ranges = merge_ranges(addresses, gap_threshold)
    if max_bytes > 0:
        ranges = split_into_chunks(ranges, max_bytes)
    return ranges