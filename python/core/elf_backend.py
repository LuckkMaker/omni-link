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
import re
import bisect
import logging
import threading
from typing import Optional, Callable

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

        # 若同一探针已加载相同路径且磁盘文件未变，直接复用现有 entry，跳过重复解析。
        # 重复 start session 时（固件未重新编译）避免每次重建 DWARF 解码器/符号表的耗时。
        existing = self._get(uid)
        if existing and existing.get("path") == path:
            try:
                if existing.get("mtime") == os.path.getmtime(path):
                    function_count = (
                        len(existing["decoder"].function_tree)
                        if hasattr(existing["decoder"], 'function_tree')
                        else 0
                    )
                    return {
                        "success": True,
                        "path": path,
                        "source_files": self._collect_source_files(existing["decoder"]),
                        "function_count": function_count,
                        "disasm_available": self._capstone_available(),
                    }
            except OSError:
                pass

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

            # DWARF 局部变量 / 形参解析（无调试信息时为 None）
            dwarf_locals = None
            try:
                if elf.has_dwarf_info():
                    from core.dwarf_locals import DwarfLocals
                    dwarf_locals = DwarfLocals(elf.get_dwarf_info())
            except Exception:
                logger.exception("DwarfLocals build failed")
                dwarf_locals = None

            # 收集源文件列表（从 line 行程序式构建）
            source_files = self._collect_source_files(decoder)

            entry = {
                "file": f,
                "elf": elf,
                "decoder": decoder,
                "symbol_decoder": symbol_decoder,
                "dwarf_locals": dwarf_locals,
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
        # 附加源码位置 [file]:[line]（走 line_tree 解析每个函数起始地址，成本低）
        for f in page:
            loc = self.get_line_for_address(uid, f["address"])
            f["file"] = loc.get("file") if loc else None
            f["line"] = loc.get("line") if loc else None
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

    def resolve_memory_address(self, uid: str, expr: str) -> dict:
        """解析内存地址表达式 → {address, name, size, error}。

        支持：
            - 纯 hex：0x08000000 / 08000000
            - &name / name：符号（复用 resolve_symbol 的精确+子串匹配）
            - name[offset]：数组元素，元素大小取自 DWARF（无 DWARF 时按字节偏移）
        失败返回 {"address": None, "error": "..."}。
        """
        addr = None
        try:
            if not expr:
                return {"address": None, "error": "空表达式"}
            expr = expr.strip()

            # 1. 纯 hex
            if re.fullmatch(r"(?:0x)?[0-9a-fA-F]{1,8}", expr):
                return {"address": int(expr, 16), "name": expr}

            # 2. 数组下标 name[offset]
            m = re.fullmatch(r"&?([A-Za-z_]\w*)\[(\d+)\]", expr)
            if m:
                name, idx = m.group(1), int(m.group(2))
                sym = self.resolve_symbol(uid, name)
                if not sym:
                    return {"address": None, "error": f"符号 {name} 未找到"}
                entry = self._get(uid)
                dl = entry.get("dwarf_locals") if entry else None
                elem_size = None
                if dl is not None:
                    info = dl.array_info(name)
                    if info is not None:
                        elem_size, count = info
                        if idx >= count:
                            return {"address": None, "error": f"下标 {idx} 超出数组 {name}[{count}]"}
                if elem_size is None:
                    elem_size = 1  # 无 DWARF 时按字节偏移
                return {"address": sym["address"] + idx * elem_size, "name": f"{name}[{idx}]", "size": elem_size}

            # 3. &name / name
            name = expr[1:] if expr.startswith("&") else expr
            sym = self.resolve_symbol(uid, name)
            if not sym:
                return {"address": None, "error": f"符号 {name} 未找到"}
            return {"address": sym["address"], "name": sym.get("name", name), "size": sym.get("size")}
        except Exception as e:
            return {"address": None, "error": str(e)}

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

    def _find_func(self, uid: str, address: int) -> Optional[tuple]:
        """二分查找覆盖 address 的函数区间 (start, end, name, faddr, fsize)，无则 None"""
        entry = self._get(uid)
        if not entry:
            return None
        ranges = self._function_ranges(uid)
        if not ranges:
            return None
        starts = entry.get("_function_starts")
        if starts is None:
            starts = [r[0] for r in ranges]
            entry["_function_starts"] = starts
        idx = bisect.bisect_right(starts, address) - 1
        if idx < 0:
            return None
        start, end, name, faddr, fsize = ranges[idx]
        if start <= address < end:
            return (start, end, name, faddr, fsize)
        return None

    def is_function_address(self, uid: str, address: int) -> bool:
        """判断地址是否落在某个已知函数内（用于栈回溯的返回地址过滤）"""
        return self._find_func(uid, address) is not None

    def resolve_address(self, uid: str, address: int) -> Optional[dict]:
        """解析地址 → {address, symbol, function, function_address, function_size, file, line}"""
        entry = self._get(uid)
        if not entry:
            return None
        result = {"address": address}
        fn = self._find_func(uid, address)
        if fn:
            _, _, name, faddr, fsize = fn
            result["function"] = name
            result["function_address"] = faddr
            result["function_size"] = fsize
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

    def unwind(self, uid: str, regs: dict, read_mem: Callable) -> list[dict]:
        """重建 ARM Cortex-M 调用栈（返回有序帧列表）。

        regs: {r0..r15, sp, lr, pc, xpsr, msp, psp, control}
        read_mem: callable(addr, length) -> bytes，用于读取目标 RAM。

        策略（由可信到兜底）：
        1. 帧0 = 当前 PC；
        2. 异常上下文（LR 为 EXC_RETURN）：从硬件异常栈帧恢复被中断的 PC；
        3. 普通上下文：LR 作为当前函数返回地址候选；
        4. 帧指针链回溯（R11 指向已保存帧 [fp]=旧fp, [fp+4]=旧lr）；
        5. 栈扫描兜底：SP 向上扫描落在函数区间内的值作为返回地址。
        结果去重、按深度排序，最多 40 帧。
        """
        def rd32(addr: int):
            try:
                b = read_mem(addr, 4)
                return int.from_bytes(b, "little") if len(b) == 4 else None
            except Exception:
                return None

        pc = (regs.get("pc") or regs.get("r15") or 0) & ~1
        sp = (regs.get("sp") or regs.get("r13") or 0) & ~0x3
        lr = regs.get("lr") or regs.get("r14") or 0
        lr_clear = lr & ~1
        msp = (regs.get("msp") or 0) & ~0x3
        psp = (regs.get("psp") or 0) & ~0x3
        control = regs.get("control") or 0
        r11 = (regs.get("r11") or 0) & ~0x3

        frames: list[dict] = []
        # 去重按函数入口地址（同一函数内多条指令地址只保留首个帧），避免同名函数重复出现
        seen: set[int] = set()

        def push(addr: int, sp_val=None, ftype: str = "call"):
            addr &= ~1
            if addr == 0 or addr == 0xffffffff:
                return
            r = self.resolve_address(uid, addr) or {"address": addr}
            # 以函数入口地址作为去重键：同一函数内 PC/LR/调用点地址视为同一函数
            fentry = r.get("function_address") or addr
            if fentry in seen:
                return
            seen.add(fentry)
            r["type"] = ftype
            if sp_val is not None:
                r["sp"] = sp_val
            frames.append(r)

        # 帧0：当前 PC
        push(pc, sp, "top")

        # 异常上下文：LR 为 EXC_RETURN (0xFFFFFFFx)，异常只用 MSP
        exc_return = (lr & 0xffffff00) == 0xffffff00
        if exc_return:
            base = msp if msp else sp
            # 硬件异常栈帧：R0..R3,R12,LR,PC,xPSR（PC 在 +24，被中断上下文 SP 在 +32 / +36(浮点)）
            exc_pc = rd32(base + 24)
            if exc_pc and self.is_function_address(uid, exc_pc & ~1):
                push(exc_pc, None, "except")
            fp_frame = bool(lr & 0x10)
            active_sp = (base + (36 if fp_frame else 32)) & ~0x3
        else:
            # 普通上下文：LR 为当前函数返回地址候选
            if (
                lr_clear
                and lr_clear != 0xffffffff
                and self.is_function_address(uid, lr_clear)
            ):
                push(lr_clear, None, "return")
            # 当前使用 PSP（线程态）时用 PSP，否则用 MSP
            active_sp = (psp if (control & 0x2 and psp) else (msp if msp else sp)) & ~0x3

        # 帧指针链回溯（R11 指向已保存帧）：[fp]=旧fp，[fp+4]=旧lr
        if r11 and r11 >= 0x20000000:
            fp = r11
            guard = 0
            while fp and guard < 64:
                old_lr = rd32(fp + 4)
                if old_lr and self.is_function_address(uid, old_lr & ~1):
                    push(old_lr & ~1, None, "call")
                old_fp = rd32(fp)
                if old_fp and (old_fp & ~0x3) != fp and (old_fp & ~0x3) > fp:
                    fp = old_fp & ~0x3
                else:
                    break
                guard += 1

        # 栈扫描兜底：active_sp 向上扫描，落在函数区间内的值作为返回地址
        try:
            chunk = read_mem(active_sp, 1024)
        except Exception:
            chunk = b""
        for i in range(0, len(chunk) - 3, 4):
            val = int.from_bytes(chunk[i:i + 4], "little") & ~1
            if val == 0 or val == 0xfffffffe or val == 0xffffffff:
                continue
            if not self.is_function_address(uid, val):
                continue
            push(val, None, "call")
            if len(frames) >= 40:
                break
        return frames

    def frame_locals(self, uid: str, address: int, regs: dict,
                     read_mem: Callable) -> Optional[dict]:
        """读取某函数（地址）的 DWARF 局部变量 / 形参及其当前值。

        Args:
            uid: 探针 ID
            address: 帧内地址（函数入口或函数内任意 PC）
            regs: 当前核心寄存器（r0..r12, sp, lr, pc, ...）
            read_mem: callable(addr, length) -> bytes

        Returns:
            {signature, ret, variables}，其中 variables 为
            [{name, type, value, is_param, available, address?}]；
            无 DWARF / 无变量时返回 None。
        """
        entry = self._get(uid)
        if not entry:
            return None
        dl = entry.get("dwarf_locals")
        if dl is None:
            return None
        # 定位函数入口地址（location 求值按入口 PC 定位，更稳定）
        faddr = address
        fn = self._find_func(uid, address)
        if fn:
            faddr = fn[3]
        try:
            signature, ret, variables = dl.get_func_locals(
                faddr, regs, read_mem, pc=address
            )
        except Exception:
            logger.exception("frame_locals failed")
            return None
        # 无变量但有签名（如无参 void 函数）：仍返回签名，前端 Type 列可显示
        if not variables and not signature:
            return None
        return {
            "signature": signature or "",
            # 无显式返回类型（DW_AT_type 缺失，通常为 void）时补 void；有签名但无类型按 void 处理
            "ret": ret or ("void" if signature else ""),
            "variables": variables,
        }

    def get_callees(self, uid: str, address: int) -> dict:
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
            {success, address, instructions: [{address, bytes, mnemonic, op_str}],
             rows: [{type: func|source|ins, ...}], count}
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

        # 清除 Thumb 位：符号表/PC 可能含 bit0（Thumb 指示位），
        # 若直接用奇数地址读取，段内偏移错位 1 字节，反汇编会得到乱码指令。
        address = address & ~1

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
        decoder = entry["decoder"]
        instructions = []
        # 交错行：函数标签 → 源码行 → 指令行
        # 参考 Keil MDK 反汇编：函数以 name + 起始地址 作为标签行。
        rows = []
        last_func = None
        last_func_addr = None
        last_src = None  # (file, line)
        for i in md.disasm(code, address):
            ins = {
                "address": i.address,
                "size": i.size,
                "bytes": ''.join('%02x' % b for b in i.bytes),
                "mnemonic": i.mnemonic,
                "op_str": i.op_str,
            }
            # 解析指令所属函数与源码行（供函数标签 / 源码行交错显示）
            func = None
            func_addr = i.address
            try:
                fi = decoder.get_function_for_address(i.address)
                func = fi.name if fi is not None else None
                # FunctionInfo 为 namedtuple(name, subprogram, low_pc, high_pc)，无 address 字段，
                # 函数标签地址应取函数真实起始地址 low_pc（清 Thumb 位），否则窗口偏移时标签地址错乱。
                if fi is not None:
                    func_addr = fi.low_pc & ~1
            except Exception:
                func = None
            src = None
            try:
                li = decoder.get_line_for_address(i.address)
                if li is not None and getattr(li, 'line', 0):
                    src = (self._line_full_path(li), li.line)
            except Exception:
                src = None

            if func != last_func:
                # 打开新函数：标签行
                rows.append({"type": "func", "name": func or "", "address": func_addr})
                last_func = func
                last_func_addr = func_addr
            if src is not None and src != last_src:
                rows.append({
                    "type": "source",
                    "file": src[0],
                    "line": src[1],
                    "text": self._source_line_text(entry, src[0], src[1]),
                })
                last_src = src
            ins["function"] = func
            rows.append({"type": "ins", **ins})
            instructions.append(ins)
            if len(instructions) >= max_instructions:
                break
        return {
            "success": True,
            "address": address,
            "instructions": instructions,
            "rows": rows,
            "count": len(instructions),
        }

    def _source_line_text(self, entry: dict, file: str, line: int) -> str:
        """读取源码文件中指定行的内容（按 entry 缓存，避免每次反汇编都重读文件）。

        仅用于反汇编视图的源码行交错显示；文件读取失败或行号越界时返回空串。
        """
        cache = entry.setdefault("_src_cache", {})
        lines = cache.get(file)
        if lines is None:
            try:
                with open(file, 'r', encoding='utf-8', errors='replace') as f:
                    lines = f.read().split('\n')
            except Exception:
                lines = []
            cache[file] = lines
        if 1 <= line <= len(lines):
            return lines[line - 1].rstrip()
        return ""

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