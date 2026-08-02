"""会话录制器：采样数据实时顺序落盘（二进制紧凑格式），支持范围读取与跨文件合并

设计背景：内存 RingBuffer 有容量上限（历史受限、重启丢失）。本组件把采样流
实时追加到磁盘（顺序写，SSD 下对采样率影响可忽略），实现"历史无上限 + 持久化"。

文件格式（.omniwave，LE）：
  Header:
    magic        8B  b"OMNIWAV1"
    version      2B  0x0001
    header_size  4B  Header + VarEntry 区总长
    var_count    2B
    reserved     2B
  VarEntry × var_count（顺序与变量列表一致）:
    id        16B  ascii，不足补 \\0
    name_len   1B
    name       name_len B  utf-8
    code       1B  类型 struct code: b/B/h/H/i/I/f
    size       1B  值字节数
    address    4B
  Data 区:
    每样本: t_ms (f8) + values（各变量原始字节，按 Header 顺序，定长）

变量集变化（采样运行中增删变量）由调用方调 sync_variables 轮转新文件
（新 Header）；读取时按文件序号顺序合并（t_ms 单调，天然有序）。
"""

import os
import struct
import threading
from datetime import datetime

MAGIC = b"OMNIWAV1"
VERSION = 1

# 类型 -> struct code（与 monitor_backend.TYPE_MAP 对齐）
_TYPE_CODE = {
    "int8": "b", "uint8": "B",
    "int16": "h", "uint16": "H",
    "int32": "i", "uint32": "I",
    "float": "f",
}
_TYPE_SIZE = {k: struct.calcsize("<" + v) for k, v in _TYPE_CODE.items()}
_CODE_TYPE = {v: k for k, v in _TYPE_CODE.items()}


def _pack_value(value, typ):
    code = _TYPE_CODE.get(typ, "f")
    try:
        return struct.pack("<" + code, value)
    except (struct.error, TypeError, OverflowError):
        return struct.pack("<" + code, 0)


def _unpack_value(data, typ):
    code = _TYPE_CODE.get(typ, "f")
    return struct.unpack("<" + code, data[:struct.calcsize("<" + code)])[0]


class SessionRecorder:
    """管理某探针会话的采样落盘"""

    def __init__(self, session_dir: str, uid: str):
        base = os.path.join(session_dir, uid.replace(":", "_"))
        os.makedirs(base, exist_ok=True)
        self._base_dir = base
        self._lock = threading.Lock()
        self._file = None
        self._vars = []          # [(id, name, type, address)]
        self._files = []         # 本次会话已产生的文件路径（有序）
        self._seq = 0

    # ── 生命周期 ──
    def open_session(self, variables):
        """开始新会话（采样启动）：清空旧文件记录，写第一个文件。

        variables: list[MonitoredVariable]（或含 .id/.name/.type/.address 的对象）
        """
        with self._lock:
            self.close_locked()
            self._files = []
            self._seq = 0
            self._vars = [(v.id, v.name, v.type, v.address) for v in variables]
            self._new_file_locked()

    def sync_variables(self, variables):
        """变量集变化（采样运行中增删变量）：轮转新文件，写入新 Header"""
        with self._lock:
            if self._file is None:
                return
            new_vars = [(v.id, v.name, v.type, v.address) for v in variables]
            if [v[0] for v in new_vars] == [v[0] for v in self._vars]:
                return
            self._vars = new_vars
            self._new_file_locked()

    def append(self, t_ms: float, values: dict):
        """追加一个采样点。values: {id: value}，缺失变量写 0。"""
        with self._lock:
            if self._file is None or not self._vars:
                return
            buf = struct.pack("<d", t_ms)
            for vid, name, typ, addr in self._vars:
                v = values.get(vid)
                if v is None:
                    buf += b"\0" * _TYPE_SIZE.get(typ, 4)
                else:
                    buf += _pack_value(v, typ)
            self._file.write(buf)

    def close(self):
        """停止采样：flush + fsync + 关闭当前文件（文件保留供读取）"""
        with self._lock:
            self.close_locked()

    def close_locked(self):
        if self._file is not None:
            try:
                self._file.flush()
                os.fsync(self._file.fileno())
            except OSError:
                pass
            try:
                self._file.close()
            except OSError:
                pass
            self._file = None

    def _new_file_locked(self):
        self._seq += 1
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(self._base_dir, f"s{self._seq:04d}_{ts}.omniwave")
        f = open(path, "wb")
        self._write_header(f, self._vars)
        self._file = f
        self._files.append(path)

    @staticmethod
    def _write_header(f, vars):
        entries = bytearray()
        for vid, name, typ, addr in vars:
            nb = name.encode("utf-8", "replace")[:255]
            entries += vid.encode("utf-8", "replace")[:16].ljust(16, b"\0")
            entries += bytes([len(nb)])
            entries += nb
            entries += bytes([ord(_TYPE_CODE.get(typ, "f"))])
            entries += bytes([_TYPE_SIZE.get(typ, 4)])
            entries += struct.pack("<I", addr & 0xFFFFFFFF)
        header = MAGIC + struct.pack("<HIHH", VERSION, 0, len(vars), 0)
        header_size = len(header) + len(entries)
        header = MAGIC + struct.pack("<HIHH", VERSION, header_size, len(vars), 0)
        f.write(header + bytes(entries))

    # ── 读取 ──
    def session_files(self):
        """本次会话的文件列表（有序）"""
        with self._lock:
            return list(self._files)

    def latest_t_ms(self):
        """最新样本时间戳（只读最后文件末尾样本，O(1)，避免全量解析）"""
        with self._lock:
            files = list(self._files)
        if not files:
            return None
        path = files[-1]
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return None
        if len(data) < 18 or data[:8] != MAGIC:
            return None
        try:
            _version, header_size, var_count, _ = struct.unpack("<HIHH", data[8:18])
            if header_size > len(data):
                return None
            stride = 8
            pos = 18
            for _ in range(var_count):
                pos += 16
                nlen = data[pos]; pos += 1
                pos += nlen
                pos += 1  # code
                stride += data[pos]; pos += 1
                pos += 4  # address
            # 最后完整样本的 t_ms 在 header_size + (n-1)*stride 处
            tail = len(data) - stride
            if tail < header_size:
                return None
            return struct.unpack("<d", data[tail:tail + 8])[0]
        except (IndexError, struct.error):
            return None

    def read_range(self, start_ms=None, end_ms=None, limit=None):
        """跨全部文件读取 [start_ms, end_ms] 范围内的样本。

        返回 list[dict]: [{vars: [(id,name,type,address), ...], samples: [(t_ms, {id:value}), ...]}, ...]
        每文件一段（变量集可能不同）。
        """
        with self._lock:
            files = list(self._files)
        out = []
        for path in files:
            vars_meta, samples = self._read_file(path)
            if not vars_meta:
                continue
            filtered = []
            for t_ms, values in samples:
                if start_ms is not None and t_ms < start_ms:
                    continue
                if end_ms is not None and t_ms > end_ms:
                    continue
                filtered.append((t_ms, values))
                if limit is not None and len(filtered) >= limit:
                    break
            if filtered:
                out.append({"vars": vars_meta, "samples": filtered})
        return out

    @staticmethod
    def _read_file(path):
        """解析单个文件，返回 (vars, samples)。vars: [(id,name,type,address)]"""
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return [], []
        if len(data) < 18 or data[:8] != MAGIC:
            return [], []
        _version, header_size, var_count, _ = struct.unpack("<HIHH", data[8:18])
        if header_size < 18 or header_size > len(data):
            return [], []
        pos = 18
        vars_meta = []
        stride = 8
        try:
            for _ in range(var_count):
                vid = data[pos:pos + 16].split(b"\0")[0].decode("ascii", "replace")
                pos += 16
                nlen = data[pos]
                pos += 1
                name = data[pos:pos + nlen].decode("utf-8", "replace")
                pos += nlen
                code = chr(data[pos])
                pos += 1
                size = data[pos]
                pos += 1
                addr = struct.unpack("<I", data[pos:pos + 4])[0]
                pos += 4
                typ = _CODE_TYPE.get(code, "float")
                vars_meta.append((vid, name, typ, addr))
                stride += size
        except (IndexError, struct.error):
            return [], []
        # 顺序解样本（stride 定长）
        samples = []
        pos = header_size
        n = len(data)
        try:
            while pos + stride <= n:
                t_ms = struct.unpack("<d", data[pos:pos + 8])[0]
                pos += 8
                values = {}
                for vid, name, typ, addr in vars_meta:
                    size = _TYPE_SIZE.get(typ, 4)
                    values[vid] = _unpack_value(data[pos:pos + size], typ)
                    pos += size
                samples.append((t_ms, values))
        except (struct.error, IndexError):
            pass
        return vars_meta, samples
