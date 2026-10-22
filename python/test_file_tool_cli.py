"""R3 离线回归：file info/checksum、flash compare、tool map。

无需硬件；后端 compare 用 fake session/target 验证差异收集。
"""

import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PY_DIR)

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    if not cond:
        failures.append(name)
    print(f"  {status}  {name}" + (f"  ({detail})" if detail and not cond else ""))


class StubClient:
    def __init__(self, post_result=None):
        self.calls = []
        self._post = post_result

    def post(self, path, payload=None):
        self.calls.append(("POST", path, payload))
        return self._post


def _args(**kw):
    base = dict(uid="u1", json_=False, quiet=False)
    base.update(kw)
    return SimpleNamespace(**base)


# ── 1. 校验和向量 ──────────────────────────────────────────
def test_checksums() -> None:
    print("== 1. checksum 算法 ==")
    from omni_cli.commands.file import _compute

    data = b"123456789"
    vectors = {
        "modbus-crc16": "374b",
        "crc16-ccitt": "29b1",
        "crc32": "cbf43926",
        "add8": "dd",
        "xor8": "31",
        "add16": "01dd",
    }
    for algorithm, expected in vectors.items():
        got = _compute(algorithm, data).hex()
        check(f"{algorithm} 向量", got == expected, got)


def test_checksum_cli() -> None:
    print("== 2. file checksum CLI ==")
    from omni_cli.commands import file as file_cmd

    with tempfile.TemporaryDirectory(prefix="omni_file_") as tmp:
        path = Path(tmp) / "data.bin"
        path.write_bytes(b"123456789")

        args = _args(file=str(path), algorithm="crc32", start=None, end=None,
                     json_=True)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = file_cmd._checksum(args)
        out = json.loads(buf.getvalue())
        check("file checksum JSON", rc == 0 and out["checksum_hex"] == "CB F4 39 26", str(out))
        check("长度正确", out["length"] == 9, str(out))

        args = _args(file=str(path), algorithm="add8", start="1", end="4", json_=True)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = file_cmd._checksum(args)
        check("范围截取 1..4", rc == 0)

        args = _args(file=str(path), algorithm="add8", start="10", end="20", json_=True)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = file_cmd._checksum(args)
        check("越界范围被拒绝", rc == 2)


def test_checksum_offline() -> None:
    """checksum 属于本地命令：不建后端客户端，后端未启动也必须成功。"""
    print("== 2b. file checksum 不依赖后端 ==")
    from omni_cli.cli import build_parser

    parser = build_parser()
    with tempfile.TemporaryDirectory(prefix="omni_file_") as tmp:
        path = Path(tmp) / "data.bin"
        path.write_bytes(b"123456789")

        args = parser.parse_args(["file", "checksum", str(path), "--json"])
        check("不暴露后端选项",
              not hasattr(args, "managed") and not hasattr(args, "backend_port"))

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = args.func(args)  # 无 client：后端未启动也应成功
        out = json.loads(buf.getvalue())
        check("无后端也能算校验和",
              rc == 0 and out["checksum_hex"] == "CB F4 39 26", str(out))

        args = parser.parse_args(["file", "checksum", str(path), "--quiet"])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = args.func(args)
        check("--quiet 无输出且退出码 0", rc == 0 and buf.getvalue() == "")

        args = parser.parse_args(["file", "checksum", str(path), "--algorithm", "add8",
                                  "--start", "1", "--end", "4", "--json"])
        with contextlib.redirect_stdout(io.StringIO()):
            rc = args.func(args)
        check("离线范围截取", rc == 0)


# ── 3. file info ───────────────────────────────────────────
def test_file_info() -> None:
    print("== 3. file info ==")
    from omni_cli.commands import file as file_cmd

    with tempfile.TemporaryDirectory(prefix="omni_file_") as tmp:
        path = Path(tmp) / "app.hex"
        path.write_text(":00000001FF\n")
        stub = StubClient(post_result={
            "format": "hex", "size": 128, "entry": 0x08000000,
            "segments": [{"address": 0x08000000, "size": 128}],
        })
        args = _args(file=str(path), base_address=None, json_=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = file_cmd._info(stub, args)
        check("file info 输出段信息", rc == 0 and "0x08000000" in buf.getvalue())
        check("file info 传绝对路径",
              stub.calls[0][2]["file_path"] == os.path.abspath(str(path)))


# ── 4. tool map ────────────────────────────────────────────
def test_tool_map() -> None:
    print("== 4. tool map ==")
    from omni_cli.commands import tool

    with tempfile.TemporaryDirectory(prefix="omni_map_") as tmp:
        path = Path(tmp) / "app.map"
        path.write_text("Image component sizes\n")
        stub = StubClient(post_result={
            "meta": {"source_file": "app.map", "component": "app", "tool": "armlink"},
            "summary": {"flash_used": 1024, "flash_capacity": 2048,
                        "ram_used": 512, "ram_capacity": 1024},
            "categories": [{"name": "App", "code": 100, "ro_data": 10, "rw_data": 4,
                            "zi_data": 8, "rom": 114, "ram": 20}],
            "top_rom": [{"name": "main.o", "kind": "object", "category": "App",
                         "rom": 114, "ram": 20}],
            "regions": [{"name": "ER_IROM1", "exec_base": 0x08000000,
                         "size": 1024, "max_size": 2048}],
        })
        args = _args(file=str(path), top=5, json_=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = tool._map(stub, args)
        out = buf.getvalue()
        check("tool map 输出摘要与 Top", rc == 0 and "ROM" in out and "main.o" in out, out)
        payload = stub.calls[0][2]
        check("tool map 请求体", payload["filename"] == "app.map" and payload["content"])


# ── 5. flash compare CLI ───────────────────────────────────
def test_flash_compare_cli() -> None:
    print("== 5. flash compare CLI ==")
    from omni_cli.commands import flash

    with tempfile.TemporaryDirectory(prefix="omni_cmp_") as tmp:
        path = Path(tmp) / "app.bin"
        path.write_bytes(b"\x00" * 8)

        stub = StubClient(post_result={
            "success": True, "equal": False, "compared_bytes": 8, "total_bytes": 8,
            "mismatch_count": 2, "first_mismatch": 0x08000003,
            "diffs": [
                {"address": 0x08000003, "expected": 0x11, "actual": 0x22},
                {"address": 0x08000007, "expected": 0x33, "actual": 0x44},
            ],
            "duration_ms": 12,
        })
        args = _args(file=str(path), base_address=None, max_diffs=20,
                     fail_fast=False, json_=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = flash._compare(stub, args)
        out = buf.getvalue()
        check("不一致返回 1", rc == 1, str(rc))
        check("输出首个差异与表", "0x08000003" in out and "0x11" in out, out)
        payload = stub.calls[0][2]
        check("compare 请求体", payload["file_path"] == os.path.abspath(str(path))
              and payload["max_diffs"] == 20)

        stub = StubClient(post_result={
            "success": True, "equal": True, "compared_bytes": 8, "total_bytes": 8,
            "mismatch_count": 0, "diffs": [], "duration_ms": 5,
        })
        with contextlib.redirect_stdout(io.StringIO()):
            rc = flash._compare(stub, _args(file=str(path), base_address=None,
                                            max_diffs=20, fail_fast=False, json_=False))
        check("一致返回 0", rc == 0)


# ── 6. 后端 compare ────────────────────────────────────────
def test_backend_compare() -> None:
    print("== 6. 后端 compare ==")
    from core.pyocd_backend import PyOCDBackend

    class Region:
        is_flash = True

    class Map:
        def get_region_for_address(self, addr):
            return Region()

    class Target:
        def __init__(self, data):
            self.data = data
            self.memory_map = Map()
            self.calls = []

        def reset_and_halt(self):
            self.calls.append("reset_and_halt")

        def halt(self):
            self.calls.append("halt")

        def read_memory_block32(self, addr, words):
            self.calls.append(("read32", addr, words))
            data = self.data[addr - 0x08000000: addr - 0x08000000 + words * 4]
            return [int.from_bytes(data[i:i + 4], "little")
                    for i in range(0, len(data), 4)]

        def read_memory_block8(self, addr, length):
            return list(self.data[addr - 0x08000000: addr - 0x08000000 + length])

    class Session:
        def __init__(self, data):
            self.target = Target(data)

    payload = bytes(range(8))
    backend = PyOCDBackend()
    backend._begin_operation = lambda: None
    backend._check_cancel = lambda: False
    backend._extract_file_data = lambda session, path, ext, base=None: [(0x08000000, payload)]

    with tempfile.TemporaryDirectory(prefix="omni_cmp_be_") as tmp:
        path = Path(tmp) / "dummy.bin"
        path.write_bytes(payload)

        session = Session(payload)
        backend._get_session = lambda uid: session
        result = backend.compare("u", str(path))
        check("一致时 equal=True", result.get("success") and result.get("equal") is True, str(result))
        check("Flash 先复位再读", session.target.calls[:1] == ["reset_and_halt"], str(session.target.calls))

        bad = bytearray(payload)
        bad[3] = 0xAA
        backend._extract_file_data = lambda session, path, ext, base=None: [(0x08000000, bytes(bad))]
        session = Session(payload)
        backend._get_session = lambda uid: session
        result = backend.compare("u", str(path), max_diffs=1)
        check("差异地址/值正确",
              result.get("mismatch_count") == 1
              and result["diffs"][0]["address"] == 0x08000003
              and result["diffs"][0]["expected"] == 0xAA
              and result["diffs"][0]["actual"] == 0x03, str(result))

        result = backend.compare("u", str(path), max_diffs=10, fail_fast=True)
        check("fail_fast 只记录首个差异",
              result.get("mismatch_count") == 1 and result.get("fail_fast") is True, str(result))


# ── 7. 参数解析 ────────────────────────────────────────────
def test_parser() -> None:
    print("== 7. CLI 参数解析 ==")
    from omni_cli.cli import build_parser

    parser = build_parser()
    args = parser.parse_args(["file", "checksum", "x.bin", "--algorithm", "crc16-ccitt",
                              "--start", "1", "--end", "4"])
    check("file checksum 解析", args.algorithm == "crc16-ccitt"
          and args.start == "1" and args.end == "4")
    args = parser.parse_args(["flash", "compare", "x.hex", "--max-diffs", "5", "--fail-fast"])
    check("flash compare 解析", args.max_diffs == 5 and args.fail_fast)
    check("tool map 解析", parser.parse_args(["tool", "map", "x.map", "--top", "3"]).top == 3)


def main() -> int:
    from omni_cli.formatting import configure_stdio
    configure_stdio()
    test_checksums()
    test_checksum_cli()
    test_checksum_offline()
    test_file_info()
    test_tool_map()
    test_flash_compare_cli()
    test_backend_compare()
    test_parser()

    print()
    if failures:
        print(f"RESULT: {len(failures)} FAILED -> {failures}")
        return 1
    print("RESULT: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
