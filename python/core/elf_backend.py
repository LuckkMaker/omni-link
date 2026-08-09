"""ELF 调试信息后端（Zone 页面源码/反汇编视图数据源）

封装 pyOCD 的 DwarfAddressDecoder（python/pyocd/debug/elf/decoder.py），
为 Zone 页面提供：
    - ELF 加载与管理（持文件句柄）
    - 源码行表 / 函数表 / 符号表
    - 反汇编（复用 capstone，与 pyocd disasm 命令同源）
    - PC 地址 → 源码位置 / 函数 / 符号 的反查

独立的 ELF 解码器，不依赖探针连接，可离线加载。
每个探针一个解码器实例（按 uid 隔离），与 monitor_backend 的符号缓存互不干扰。
"""

import os
import logging
import threading
from typing import Optional

logger = logging.getLogger(__name__)


class ElfBackend:
    """ELF 调试信息后端

    为每个探针维护一个已加载的 ELF（含文件句柄、DwarfAddressDecoder、符号表）。
    线程安全：加锁保护字典访问。
    """

    def __init__(self):
        # uid -> {file, elf, decoder, symbol_decoder, path, mtime}
        self._entries: dict[str, dict] = {}
        self._lock = threading.Lock()

    # ── 加载 / 卸载 ──────────────────────────────

    def load_elf(self, uid: str, path: str) -> dict:
        """加载 ELF/AXF 文件，构建地址解码器

        Args:
            uid: 探针唯一 ID（也用于离线加载，作为会话标识）
            path: ELF 文件绝对路径

        Returns:
            {success, path, source_files, function_count, disasm_available}
        """
        path = os.path.expanduser(path)
        if not os.path.isabs(path):
            path = os.path.join(os.path.expanduser('~'), path)
        if not os.path.isfile(path):
            return {"success": False, "error": f"File not found: {path}"}

        try:
            from elftools.elf.elffile import ELFFile
            from pyocd.debug.elf.decoder import DwarfAddressDecoder, ElfSymbolDecoder

            # 关闭旧实例
            self._close(uid)

            f = open(path, "rb")
            elf = ELFFile(f)
            decoder = DwarfAddressDecoder(elf)
            # 注意：必须用 ElfSymbolDecoder（提供 symbol_dict / get_symbol_for_address），
            # 不能直接拿 pyelftools 的 .symtab Section，否则 get_symbol_address/get_functions 等抛 AttributeError
            symbol_decoder = ElfSymbolDecoder(elf)

            # 收集源文件列表（从 line 行程序式构建）
            source_files = self._collect_source_files(decoder)

            entry = {
                "file": f,
                "elf": elf,
                "decoder": decoder,
                "symbol_decoder": symbol_decoder,
                "path": path,
                "mtime": os.path.getmtime(path),
            }
            with self._lock:
                self._entries[uid] = entry

            # capstone 可用性（反汇编）
            disasm_available = self._capstone_available()

            # 统计函数数
            function_count = len(decoder.function_tree) if hasattr(decoder, 'function_tree') else 0

            return {
                "success": True,
                "path": path,
                "source_files": source_files,
                "function_count": function_count,
                "disasm_available": disasm_available,
            }
        except Exception as e:
            logger.exception("ELF load failed")
            return {"success": False, "error": str(e)}

    @staticmethod
    def _line_full_path(info) -> str:
        """组合 DWARF 行区间信息为完整源码路径（/ 分隔，不带尾斜杠）。

        DWARF 中 filename 常只有 basename（如 `timing.c`），真正的目录来自
        dirname + comp_dir。不同目录下可能存在同名文件（如 omni 的两个 timing.c），
        若只用 basename 会把它们混为一谈。此函数把三者拼成可区分的完整路径，
        供可断点行 / 断点定位等按文件查询时精确匹配。
        """
        rel = (getattr(info, 'filename', '') or '').replace('\\', '/')
        comp_dir = (getattr(info, 'comp_dir', '') or '').replace('\\', '/')
        dirname = (getattr(info, 'dirname', '') or '').replace('\\', '/')
        full = rel
        if dirname and rel and not rel.startswith('/'):
            full = dirname + '/' + rel
        if comp_dir and full and not full.startswith('/') and not comp_dir.startswith('/'):
            full = comp_dir + '/' + full
        return full.rstrip('/')

    @staticmethod
    def _path_matches(full: str, target: str) -> bool:
        """判断 DWARF 完整路径 full 是否匹配查询路径 target。

        优先精确匹配（区分同名但不同目录的文件）；target 为相对路径时去掉
        前导 `./` 再精确匹配；仅当 target 是纯 basename（无斜杠，无法区分同名
        文件）时才退化为 basename 后缀匹配。
        """
        full = full.replace('\\', '/').rstrip('/')
        target = target.replace('\\', '/').rstrip('/')
        if not full or not target:
            return False
        if full == target:
            return True
        t = target.lstrip('./')
        if t and full == t:
            return True
        if '/' not in target and full.endswith('/' + target):
            return True
        return False

    def _collect_source_files(self, decoder) -> list[str]:
        """收集所有源文件路径（去重、排序）"""
        files: set[str] = set()
        tree = getattr(decoder, 'line_tree', None)
        if tree is None:
            return []
        for interval in tree:
            files.add(self._line_full_path(interval.data))
        return sorted(f for f in files if f)

    def get_source_files(self, uid: str) -> dict:
        """源文件列表（含磁盘大小），供左侧 Source Files 表格展示

        Returns:
            {success, files: [{path, name, size}]}，size 为空或不可读时为 None
        """
        entry = self._get(uid)
        if not entry:
            return {"success": False, "error": "No ELF loaded"}
        paths = self._collect_source_files(entry["decoder"])
        files = []
        for p in paths:
            size = None
            try:
                if os.path.isfile(p):
                    size = os.path.getsize(p)
            except OSError:
                size = None
            files.append({
                "path": p,
                "name": p.split('/')[-1] if p else p,
                "size": size,
            })
        return {"success": True, "files": files}

    def _close(self, uid: str):
        """关闭并移除探针的 ELF 实例"""
        with self._lock:
            entry = self._entries.pop(uid, None)
        if entry:
            try:
                entry["file"].close()
            except Exception:
                pass

    def _capstone_available(self) -> bool:
        try:
            import capstone  # noqa: F401
            return True
        except ImportError:
            return False

    # ── 查询 ──────────────────────────────────────

    def _get(self, uid: str):
        with self._lock:
            return self._entries.get(uid)

    def is_loaded(self, uid: str) -> bool:
        return self._get(uid) is not None

    def get_path(self, uid: str) -> Optional[str]:
        entry = self._get(uid)
        return entry["path"] if entry else None

    def check_elf_changed(self, uid: str) -> dict:
        """检测 ELF 是否在磁盘上变化"""
        entry = self._get(uid)
        if not entry:
            return {"success": True, "changed": False, "loaded": False}
        try:
            changed = os.path.getmtime(entry["path"]) != entry["mtime"]
        except OSError:
            changed = False
        return {"success": True, "changed": changed, "loaded": True, "path": entry["path"]}

    # ── 源码 / 函数 / 符号 ─────────────────────────

    def get_line_for_address(self, uid: str, address: int) -> Optional[dict]:
        """PC 地址 → 源码位置 {file, dirname, line, comp_dir, function, symbol}"""
        entry = self._get(uid)
        if not entry:
            return None
        decoder = entry["decoder"]
        line_info = decoder.get_line_for_address(address)
        result = {"address": address}
        if line_info is not None:
            result["file"] = self._line_full_path(line_info)
            result["dirname"] = (line_info.dirname or '').replace('\\', '/')
            result["line"] = line_info.line
            result["comp_dir"] = (line_info.comp_dir or '').replace('\\', '/')
        func = decoder.get_function_for_address(address)
        if func is not None:
            result["function"] = getattr(func, 'name', '')
        return result

    def get_address_for_line(self, uid: str, file: str, line: int) -> Optional[int]:
        """源码位置 → 地址（用于源代码行设置断点）

        在 DWARF 行表中查找与给定文件+行匹配的区间，返回其起始地址。
        按完整路径精确匹配，区分不同目录下的同名文件（如 omni 的两个 timing.c）。
        """
        entry = self._get(uid)
        if not entry:
            return None
        decoder = entry["decoder"]
        tree = getattr(decoder, 'line_tree', None)
        if tree is None:
            return None
        target = file.replace('\\', '/')
        candidates = [interval for interval in tree
                      if interval.data.line == line
                      and self._path_matches(self._line_full_path(interval.data), target)]
        if not candidates:
            return None
        # 取该行区间集合中地址最小者（该源行的第一条指令）
        return min(c.begin for c in candidates)

    def get_executable_lines(self, uid: str, file: str) -> Optional[list[int]]:
        """文件在 DWARF 行表中实际有代码的行号（可打断点）

        仅返回存在代码地址映射的行，注释/空白/声明行不在此列。
        按完整路径精确匹配，区分不同目录下的同名文件（如 omni 的两个 timing.c），
        避免把 A 文件的行号错误地当作 B 文件的可断点行。
        """
        entry = self._get(uid)
        if not entry:
            return None
        decoder = entry["decoder"]
        tree = getattr(decoder, 'line_tree', None)
        if tree is None:
            return None
        target = file.replace('\\', '/')
        lines: set[int] = set()
        for interval in tree:
            if self._path_matches(self._line_full_path(interval.data), target):
                if interval.data.line:
                    lines.add(interval.data.line)
        return sorted(lines)

    def get_function_for_address(self, uid: str, address: int) -> Optional[str]:
        entry = self._get(uid)
        if not entry:
            return None
        func = entry["decoder"].get_function_for_address(address)
        return getattr(func, 'name', '') if func is not None else None

    def get_symbol_address(self, uid: str, name: str) -> Optional[int]:
        """按名字查询符号地址（用于 Reset & Break at Symbol 等）"""
        entry = self._get(uid)
        if not entry:
            return None
        sd = entry.get("symbol_decoder")
        if not sd:
            return None
        info = sd.symbol_dict.get(name)
        return info.address if info else None

    def get_symbol_for_address(self, uid: str, address: int) -> Optional[dict]:
        """PC 地址 → 符号 {name, address, size, type}
        """
        entry = self._get(uid)
        if not entry:
            return None
        sd = entry.get("symbol_decoder")
        if not sd:
            return None
        sym = sd.get_symbol_for_address(address)
        if sym is None:
            return None
        return {
            "name": sym.name,
            "address": sym.address,
            "size": sym.size,
            "type": sym.type,
        }

    def get_functions(self, uid: str, filter_str: str = "",
                      offset: int = 0, limit: int = 200) -> dict:
        """函数列表（分页）"""
        entry = self._get(uid)
        if not entry:
            return {"success": False, "error": "No ELF loaded"}
        # 从 line_tree 无法直接枚举函数，改用 symbol_decoder 的 symbol_dict
        sd = entry.get("symbol_decoder")
        if not sd:
            return {"success": False, "error": "No symbol table in ELF"}
        funcs = [
            {"name": name, "address": info.address, "size": info.size}
            for name, info in sd.symbol_dict.items()
            if info.type == "STT_FUNC"
            and (not filter_str or filter_str.lower() in name.lower())
        ]
        funcs.sort(key=lambda f: f["address"])
        total = len(funcs)
        page = funcs[offset:offset + limit]
        return {"success": True, "functions": page, "total": total}

    def resolve_symbol(self, uid: str, name: str) -> Optional[dict]:
        """按名字解析符号定义位置（供「转到定义」）。

        先在符号表精确匹配；未命中时退化到大小写不敏感的子串匹配
        （优先以 name 开头的符号）。返回
        {name, address, size, type, file, line, function}，无源码位置时 file/line 为 None。
        """
        if not name:
            return None
        entry = self._get(uid)
        if not entry:
            return None
        sd = entry.get("symbol_decoder")
        if not sd:
            return None
        info = sd.symbol_dict.get(name)
        if info is None:
            lower = name.lower()
            cands = [(n, i) for n, i in sd.symbol_dict.items() if lower in n.lower()]
            if not cands:
                return None
            cands.sort(key=lambda x: (not x[0].lower().startswith(lower), x[0].lower()))
            info = cands[0][1]
        if info is None or info.address == 0:
            return None
        loc = self.get_line_for_address(uid, info.address)
        return {
            "name": info.name,
            "address": info.address,
            "size": info.size,
            "type": info.type,
            "file": loc.get("file") if loc else None,
            "line": loc.get("line") if loc else None,
            "function": loc.get("function") if loc else None,
        }

    def search_source(self, uid: str, query: str, limit: int = 200) -> dict:
        """在全部源文件中做文本搜索（供「转到引用」的轻量实现）。

        Returns:
            {success, results: [{file, line, text}], truncated}
        """
        entry = self._get(uid)
        if not entry:
            return {"success": False, "error": "No ELF loaded"}
        if not query:
            return {"success": True, "results": []}
        paths = self._collect_source_files(entry["decoder"])
        results: list[dict] = []
        lower = query.lower()
        for p in paths:
            try:
                if not os.path.isfile(p):
                    continue
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    for line_no, raw in enumerate(fh, 1):
                        if lower in raw.lower():
                            results.append({"file": p, "line": line_no, "text": raw.rstrip("\n")})
                            if len(results) >= limit:
                                return {"success": True, "results": results, "truncated": True}
            except OSError:
                continue
        return {"success": True, "results": results}

    # ── 地址解析 / 函数区间（供调用栈与调用图使用）─────────

    def _function_ranges(self, uid: str) -> list[tuple]:
        """构建并缓存函数地址区间列表 [(start, end, name, addr, size)]"""
        entry = self._get(uid)
        if not entry:
            return []
        ranges = entry.get("_function_ranges")
        if ranges is None:
            sd = entry.get("symbol_decoder")
            ranges = []
            if sd:
                for name, info in sd.symbol_dict.items():
                    if info.type == "STT_FUNC" and info.size > 0:
                        ranges.append((info.address, info.address + info.size, name, info.address, info.size))
                ranges.sort(key=lambda r: r[0])
            entry["_function_ranges"] = ranges
        return ranges

    def is_function_address(self, uid: str, address: int) -> bool:
        """判断地址是否落在某个已知函数内（用于栈回溯的返回地址过滤）"""
        for start, end, *_ in self._function_ranges(uid):
            if start <= address < end:
                return True
            if address < start:
                break
        return False

    def resolve_address(self, uid: str, address: int) -> Optional[dict]:
        """解析地址 → {address, symbol, function, function_address, function_size, file, line}"""
        entry = self._get(uid)
        if not entry:
            return None
        result = {"address": address}
        for start, end, name, faddr, fsize in self._function_ranges(uid):
            if start <= address < end:
                result["function"] = name
                result["function_address"] = faddr
                result["function_size"] = fsize
                break
            if address < start:
                break
        sd = entry.get("symbol_decoder")
        if sd:
            sym = sd.get_symbol_for_address(address)
            if sym is not None:
                result["symbol"] = sym.name
        line_info = entry["decoder"].get_line_for_address(address)
        if line_info is not None:
            result["file"] = self._line_full_path(line_info)
            result["line"] = line_info.line
        return result

    def get_callees(self, uid: str, address: int) -> dict:
        """调用图：解析指定函数地址的直接 callees（反汇编 BL/BLX 指令的目标）"""
        entry = self._get(uid)
        if not entry:
            return {"success": False, "error": "No ELF loaded"}
        if not self._capstone_available():
            return {"success": False, "error": "Capstone not installed"}
        fn = None
        for start, end, name, faddr, fsize in self._function_ranges(uid):
            if start <= address < end:
                fn = {"name": name, "address": faddr, "size": fsize}
                break
            if address < start:
                break
        if not fn:
            return {"success": False, "error": "Address not in a function"}
        try:
            import capstone
        except ImportError:
            return {"success": False, "error": "Capstone not installed"}
        code = self._read_from_segments(entry["elf"], fn["address"], fn["size"])
        if not code:
            return {"success": False, "error": "No code in function"}
        md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)
        md.detail = True
        callees = []
        seen = set()
        try:
            for ins in md.disasm(code, fn["address"]):
                if ins.mnemonic not in ("bl", "blx"):
                    continue
                target = None
                for op in ins.operands:
                    if op.type == capstone.arm.ARM_OP_IMM:
                        target = op.imm & ~1
                        break
                if target is None:
                    continue
                r = self.resolve_address(uid, target)
                if r and r.get("function"):
                    key = (r["function"], r["function_address"])
                    if key not in seen:
                        seen.add(key)
                        callees.append({
                            "name": r["function"],
                            "address": r["function_address"],
                            "size": r.get("function_size", 0),
                        })
        except Exception as e:
            logger.exception("Call graph disasm failed")
            return {"success": False, "error": str(e)}
        callees.sort(key=lambda c: c["address"])
        return {"success": True, "function": fn, "callees": callees}

    def get_memory_usage(self, uid: str) -> dict:
        """内存使用统计（从 ELF section 近似估算 Flash/RAM 占用）

        - Flash(ROM)：可读且不可写的已分配 section（.text/.rodata 等）
        - RAM：可写的已分配 section（.data/.bss 等）

        Returns:
            {success, flash_used, ram_used, total, sections: [{name, address, size, writable, flash}]}
        """
        entry = self._get(uid)
        if not entry:
            return {"success": False, "error": "No ELF loaded"}
        elf = entry["elf"]
        SHF_WRITE, SHF_ALLOC = 0x1, 0x2
        flash_used, ram_used = 0, 0
        sections = []
        try:
            for sec in elf.iter_sections():
                hdr = sec.header
                flags = hdr['sh_flags']
                size = hdr['sh_size']
                name = sec.name
                if size == 0 or not (flags & SHF_ALLOC):
                    continue
                writable = bool(flags & SHF_WRITE)
                if writable:
                    ram_used += size
                else:
                    flash_used += size
                sections.append({
                    "name": name,
                    "address": hdr['sh_addr'],
                    "size": size,
                    "writable": writable,
                    "flash": not writable,
                })
        except Exception as e:
            logger.exception("Memory usage computation failed")
            return {"success": False, "error": str(e)}
        sections.sort(key=lambda s: s["address"])
        return {
            "success": True,
            "flash_used": flash_used,
            "ram_used": ram_used,
            "total": flash_used + ram_used,
            "sections": sections,
        }

    # ── 反汇编 ─────────────────────────────────────

    def disassemble(self, uid: str, address: int, length: int = 64,
                    max_instructions: int = 32) -> dict:
        """从 ELF 读取代码并反汇编

        Args:
            uid: 探针 ID
            address: 起始地址
            length: 读取的字节数（默认 64）
            max_instructions: 最大指令条数（默认 32）

        Returns:
            {success, address, instructions: [{address, bytes, mnemonic, op_str}], pc_marker}
        """
        entry = self._get(uid)
        if not entry:
            return {"success": False, "error": "No ELF loaded"}
        if not self._capstone_available():
            return {"success": False, "error": "Capstone not installed"}

        try:
            import capstone
        except ImportError:
            return {"success": False, "error": "Capstone not installed"}

        # 从 ELF program segments 读取代码（按 load address）
        elf = entry["elf"]
        code = self._read_from_segments(elf, address, length)
        if not code:
            # 请求地址下无代码（如 PC 未知时前端默认地址与二进制装载地址不符），
            # 回退到 ELF 入口点（清 Thumb 位），避免反汇编窗口 400
            entry_point = elf.header["e_entry"] & ~1
            if entry_point != address:
                code = self._read_from_segments(elf, entry_point, length)
                if code:
                    address = entry_point
        if not code:
            return {"success": False, "error": f"No code at 0x{address:08x}"}

        md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)
        md.detail = True
        instructions = []
        for i in md.disasm(code, address):
            hex_bytes = ''.join('%02x' % b for b in i.bytes)
            instructions.append({
                "address": i.address,
                "size": i.size,
                "bytes": hex_bytes,
                "mnemonic": i.mnemonic,
                "op_str": i.op_str,
            })
            if len(instructions) >= max_instructions:
                break
        return {
            "success": True,
            "address": address,
            "instructions": instructions,
            "count": len(instructions),
        }

    def _read_from_segments(self, elf, address: int, length: int) -> bytes:
        """从 ELF program segments 读取代码（兼容无 read 方法的 ELFFile）

        按运行时虚拟地址（p_vaddr）匹配，兼容 LMA(VMA) 不同的链接方式。
        """
        for segment in elf.iter_segments():
            if segment["p_type"] != "PT_LOAD":
                continue
            seg_addr = segment["p_vaddr"]
            seg_size = segment["p_filesz"]
            if address >= seg_addr and address + length <= seg_addr + seg_size:
                data = segment.data()
                start = address - seg_addr
                return data[start:start + length]
        return b""

    # ── 清理 ──────────────────────────────────────

    def close(self, uid: str):
        self._close(uid)

    def cleanup_all(self):
        with self._lock:
            uids = list(self._entries.keys())
        for uid in uids:
            self._close(uid)


# 全局单例
elf_backend = ElfBackend()