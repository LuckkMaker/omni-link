"""运维/设备信息命令离线测试（无需硬件）。

覆盖 system info、commander reset/cancel、probe jlink-devices、
device flm-info、rtt send --file，以及对应参数解析。
"""

import base64
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
    def __init__(self, get_result=None, post_result=None, delete_result=None):
        self.calls = []
        self._get = get_result
        self._post = post_result
        self._delete = delete_result

    def get(self, path):
        self.calls.append(("GET", path, None))
        return self._get

    def post(self, path, payload=None):
        self.calls.append(("POST", path, payload))
        return self._post

    def delete(self, path):
        self.calls.append(("DELETE", path, None))
        return self._delete


def _args(**kw):
    base = dict(uid="u1", json_=False, quiet=False)
    base.update(kw)
    return SimpleNamespace(**base)


# ── 1. system info ─────────────────────────────────────────
def test_system_info() -> None:
    print("== 1. system info ==")
    from omni_cli.commands import system

    payload = {
        "app_version": "0.6.0", "backend_version": "0.6.0",
        "python_version": "3.11", "platform": "Windows",
        "pyocd_version": "0.36.0", "db_version": 2,
        "db_path": "data/user-devices.xml",
        "source_summary": {"builtin": 51, "pack": 2, "total": 53},
    }
    stub = StubClient(get_result=payload)
    args = _args(json_=True)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = system._info(stub, args)
    out = json.loads(buf.getvalue())
    check("system info JSON", rc == 0 and out["pyocd_version"] == "0.36.0")
    check("请求 /api/system/info", stub.calls[0][1] == "/api/system/info")

    args = _args(json_=False)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = system._info(stub, args)
    text = buf.getvalue()
    check("system info 人类可读含版本与设备库",
          rc == 0 and "pyOCD" in text and "builtin" in text, text)


# ── 2. commander reset/cancel ──────────────────────────────
def test_commander_control() -> None:
    print("== 2. commander reset/cancel ==")
    from omni_cli.commands import commander

    stub = StubClient(post_result={"success": True})
    args = _args()
    with contextlib.redirect_stdout(io.StringIO()):
        rc = commander._reset(stub, args)
    check("reset 请求", rc == 0 and stub.calls[0][1] == "/api/probes/u1/commander/reset")

    stub = StubClient(post_result={"success": True})
    with contextlib.redirect_stdout(io.StringIO()):
        rc = commander._cancel(stub, args)
    check("cancel 请求", rc == 0 and stub.calls[0][1] == "/api/probes/u1/commander/cancel")

    stub = StubClient(post_result={"success": False})
    with contextlib.redirect_stdout(io.StringIO()):
        rc = commander._cancel(stub, args)
    check("cancel 失败返回 1", rc == 1)


# ── 3. J-Link 设备检索 ─────────────────────────────────────
def test_jlink_devices() -> None:
    print("== 3. probe jlink-devices ==")
    from omni_cli.commands import probe

    payload = {"devices": [
        {"name": "G32F463XC", "flash_size": 256 * 1024, "ram_size": 128 * 1024,
         "manufacturer": "Geehy"},
    ]}
    stub = StubClient(get_result=payload)
    args = _args(search="G32", flash_kb=256, limit=20, json_=False)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = probe._jlink_devices(stub, args)
    check("jlink-devices 输出设备", rc == 0 and "G32F463XC" in buf.getvalue())
    path = stub.calls[0][1]
    check("查询参数含 search/flash_kb/limit",
          "search=G32" in path and "flash_kb=256" in path and "limit=20" in path, path)


# ── 4. FLM 参数提取 ────────────────────────────────────────
def test_flm_info() -> None:
    print("== 4. device flm-info ==")
    from omni_cli.commands import device

    with tempfile.TemporaryDirectory(prefix="omni_flm_") as tmp:
        flm = Path(tmp) / "G32F463.FLM"
        flm.write_bytes(b"dummy-flm")
        stub = StubClient(post_result={"info": {
            "flash_base": 0x08000000, "flash_size": 256,
            "ram_base": 0x20000000, "ram_size": 128,
        }})
        args = _args(file=str(flm), json_=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = device._flm_info(stub, args)
        check("flm-info 输出参数", rc == 0 and "flash_base" in buf.getvalue())
        check("flm-info 传绝对路径",
              stub.calls[0][2]["path"] == os.path.abspath(str(flm)))

        args = _args(file=str(Path(tmp) / "missing.FLM"), json_=False)
        stub = StubClient()
        with contextlib.redirect_stdout(io.StringIO()):
            rc = device._flm_info(stub, args)
        check("FLM 不存在时拦截", rc == 1 and stub.calls == [])


# ── 5. rtt send --file ─────────────────────────────────────
def test_rtt_send_file() -> None:
    print("== 5. rtt send --file ==")
    from omni_cli.commands import rtt

    with tempfile.TemporaryDirectory(prefix="omni_rtt_") as tmp:
        path = Path(tmp) / "payload.bin"
        raw = b"\x01\x02hello\xff"
        path.write_bytes(raw)

        stub = StubClient(post_result={"success": True})
        args = _args(file=str(path), base64=None, text=None, channel=1, no_newline=False)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = rtt._send(stub, args)
        payload = stub.calls[0][2]
        check("rtt send --file 发送原始字节",
              rc == 0 and base64.b64decode(payload["data"]) == raw, str(payload))
        check("rtt send 带 channel", payload["channel"] == 1)

        args = _args(file=str(Path(tmp) / "missing.bin"), base64=None, text=None,
                     channel=None, no_newline=False)
        stub = StubClient()
        with contextlib.redirect_stdout(io.StringIO()):
            rc = rtt._send(stub, args)
        check("rtt send 文件不存在时拦截", rc == 1 and stub.calls == [])


# ── 6. flash read 成功输出 ─────────────────────────────────
def test_flash_read_output() -> None:
    print("== 6. flash read 输出 ==")
    from omni_cli.commands import flash

    stub = StubClient(post_result={
        "success": True, "bytes_read": 32,
        "base_address": 0x08000000, "duration_ms": 12,
    })
    args = _args(type="range", addr="0x08000000", size=32, out=None,
                 json_=False, uid="u1")
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = flash._read(stub, args)
        ok = True
    except Exception as exc:  # noqa: BLE001
        ok = False
        check("flash read 成功输出不抛异常", False, repr(exc))
    if ok:
        check("flash read 成功输出不抛异常", rc == 0)
        check("flash read 输出地址", "0x08000000" in buf.getvalue(), buf.getvalue())


# ── 7. 参数解析 ────────────────────────────────────────────
def test_parser() -> None:
    print("== 7. CLI 参数解析 ==")
    from omni_cli.cli import build_parser

    parser = build_parser()
    check("system info 解析",
          parser.parse_args(["system", "info"]).system_sub == "info")
    check("commander cancel 解析",
          parser.parse_args(["commander", "cancel", "--uid", "u"]).uid == "u")
    args = parser.parse_args(["probe", "jlink-devices", "--search", "G32", "--flash-kb", "256"])
    check("jlink-devices 解析", args.search == "G32" and args.flash_kb == 256)
    check("device flm-info 解析",
          parser.parse_args(["device", "flm-info", "x.FLM"]).file == "x.FLM")
    check("rtt send --file 解析",
          parser.parse_args(["rtt", "send", "--file", "x.bin"]).file == "x.bin")


def main() -> int:
    from omni_cli.formatting import configure_stdio
    configure_stdio()
    test_system_info()
    test_commander_control()
    test_jlink_devices()
    test_flm_info()
    test_rtt_send_file()
    test_flash_read_output()
    test_parser()

    print()
    if failures:
        print(f"RESULT: {len(failures)} FAILED -> {failures}")
        return 1
    print("RESULT: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
