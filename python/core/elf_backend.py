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
            from pyocd.debug.elf.decoder import DwarfAddressDecoder

            # 关闭旧实例
            self._close(uid)

            f = open(path, "rb")
            elf = ELFFile(f)
            decoder = DwarfAddressDecoder(elf)
            symbol_decoder = decoder.elffile and decoder.elffile.get_section_by_name('.symtab')

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

    def _collect_source_files(self, decoder) -> list[str]:
        """收集所有源文件路径（去重、排序）"""
        files: set[str] = set()
        tree = getattr(decoder, 'line_tree', None)
        if tree is None:
            return []
        for interval in tree:
            info = interval.data
            rel = getattr(info, 'filename', '') or ''
            comp_dir = getattr(info, 'comp_dir', '') or ''
            dirname = getattr(info, 'dirname', '') or ''
            # 组合完整路径：comp_dir + dirname + filename
            full = rel
            if dirname and rel and not rel.startswith(('/', '\\')):
                full = os.path.join(dirname, rel)
            if comp_dir and full and not os.path.isabs(full):
                full = os.path.join(comp_dir, full)
            files.add(full.replace('\\', '/'))
        return sorted(files)

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
            result["file"] = (line_info.filename or '').replace('\\', '/')
            result["dirname"] = (line_info.dirname or '').replace('\\', '/')
            result["line"] = line_info.line
            result["comp_dir"] = (line_info.comp_dir or '').replace('\\', '/')
        func = decoder.get_function_for_address(address)
        if func is not None:
            result["function"] = getattr(func, 'name', '')
        return result

    def get_function_for_address(self, uid: str, address: int) -> Optional[str]:
        entry = self._get(uid)
        if not entry:
            return None
        func = entry["decoder"].get_function_for_address(address)
        return getattr(func, 'name', '') if func is not None else None

    def get_symbol_for_address(self, uid: str, address: int) -> Optional[dict]:
        """PC 地址 → 符号 {name, address, size, type}"""
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
        """从 ELF program segments 读取代码（兼容无 read 方法的 ELFFile）"""
        for segment in elf.iter_segments():
            seg_addr = segment["p_paddr"]
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