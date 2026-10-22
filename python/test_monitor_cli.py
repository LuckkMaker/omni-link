"""Monitor CLI 离线回归测试（无需硬件）。

覆盖：
1. SessionRecorder 采样中 flush 后可见（read --follow 的基础）
2. 符号解析：标量 / 数组 / 歧义 / 越界
3. monitor var add 的请求体（符号模式与手工地址模式）
4. monitor read（普通/JSON）与 --follow 游标去重
5. monitor export 写文件、--force
6. CLI 参数解析

用法::

    cd python
    ..\\.venv\\Scripts\\python.exe test_monitor_cli.py
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
    def __init__(self, get_result=None, post_result=None, put_result=None, delete_result=None):
        self.calls = []
        self._get = get_result
        self._post = post_result
        self._put = put_result
        self._delete = delete_result

    def get(self, path):
        self.calls.append(("GET", path, None))
        return self._get

    def post(self, path, payload=None):
        self.calls.append(("POST", path, payload))
        return self._post

    def put(self, path, payload=None):
        self.calls.append(("PUT", path, payload))
        return self._put

    def delete(self, path):
        self.calls.append(("DELETE", path, None))
        return self._delete


def _args(**kw):
    base = dict(uid="u1", json_=False, quiet=False)
    base.update(kw)
    return SimpleNamespace(**base)


# ── 1. SessionRecorder flush ────────────────────────────────
def test_recorder_flush() -> None:
    print("== 1. SessionRecorder 采样中可读 ==")
    from core.session_recorder import SessionRecorder

    with tempfile.TemporaryDirectory(prefix="omni_mon_rec_") as tmp:
        rec = SessionRecorder(tmp, "uid1")
        var = SimpleNamespace(id="v1", name="counter", type="int32", address=0x20000000)
        rec.open_session([var])
        try:
            rec.append(10.0, {"v1": 1})
            rec.append(20.0, {"v1": 2})
            # 不 close，直接读：read_range 内部先 flush
            segments = rec.read_range()
            samples = [s for seg in segments for s in seg["samples"]]
            check("未 close 也能读到全部样本", len(samples) == 2, str(samples))
            check("样本值正确", [v["v1"] for _, v in samples] == [1, 2], str(samples))
        finally:
            rec.close()


# ── 2. 符号解析 ─────────────────────────────────────────────
def test_symbol_resolution() -> None:
    print("== 2. 符号解析 ==")
    from omni_cli.commands import monitor

    scalar = {
        "name": "g_counter", "address": 0x20000000, "size": 4, "type": "uint32",
        "is_array": False, "elem_type": "uint32", "elem_count": 1, "elem_size": 4,
        "source_file": "main.c",
    }
    array = {
        "name": "g_buf", "address": 0x20000100, "size": 16, "type": "uint16",
        "is_array": True, "elem_type": "uint16", "elem_count": 8, "elem_size": 2,
        "source_file": "main.c",
    }
    symbols = {"success": True, "symbols": [scalar, array], "total": 2}

    stub = StubClient(get_result=symbols, post_result={
        "success": True, "variable": {"id": "v1", "name": "g_counter",
                                      "address": 0x20000000},
    })
    args = _args(symbol="g_counter", name=None, address=None, type=None, index=None,
                 remark="", refresh=0)
    with contextlib.redirect_stdout(io.StringIO()):
        rc = monitor._var_add(stub, args)
    payload = stub.calls[1][2]
    check("标量符号添加成功", rc == 0 and payload["address"] == 0x20000000, str(payload))
    check("标量类型来自符号", payload["type"] == "uint32" and payload["elem_index"] is None)

    stub = StubClient(get_result=symbols, post_result={
        "success": True, "variable": {"id": "v2", "name": "g_buf[3]",
                                      "address": 0x20000106},
    })
    args = _args(symbol="g_buf", name=None, address=None, type=None, index=3,
                 remark="", refresh=0)
    with contextlib.redirect_stdout(io.StringIO()):
        rc = monitor._var_add(stub, args)
    payload = stub.calls[1][2]
    check("数组元素地址 = base + index*elem_size",
          rc == 0 and payload["address"] == 0x20000106, str(payload))
    check("数组元素类型/索引", payload["type"] == "uint16" and payload["elem_index"] == 3)

    # 数组不给 --index：报错且不发 POST
    stub = StubClient(get_result=symbols)
    args = _args(symbol="g_buf", name=None, address=None, type=None, index=None,
                 remark="", refresh=0)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = monitor._var_add(stub, args)
    check("数组缺 --index 被拒绝", rc == 1 and len(stub.calls) == 1, str(stub.calls))
    check("提示需要 --index", "--index" in out.getvalue(), out.getvalue())

    # 越界
    stub = StubClient(get_result=symbols)
    args = _args(symbol="g_buf", name=None, address=None, type=None, index=99,
                 remark="", refresh=0)
    with contextlib.redirect_stdout(io.StringIO()):
        rc = monitor._var_add(stub, args)
    check("数组索引越界被拒绝", rc == 1 and len(stub.calls) == 1)


# ── 3. 手工地址模式 ─────────────────────────────────────────
def test_manual_address() -> None:
    print("== 3. 手工地址添加 ==")
    from omni_cli.commands import monitor

    stub = StubClient(post_result={"success": True, "variable": {
        "id": "v3", "name": "flag", "address": 0x20000010}})
    args = _args(symbol=None, name="flag", address="0x20000010", type="uint8",
                 index=None, remark="r", refresh=0)
    with contextlib.redirect_stdout(io.StringIO()):
        rc = monitor._var_add(stub, args)
    payload = stub.calls[0][2]
    check("手工地址添加成功", rc == 0 and payload["address"] == 0x20000010, str(payload))
    check("手工类型/备注", payload["type"] == "uint8" and payload["remark"] == "r")

    stub = StubClient()
    args = _args(symbol=None, name="flag", address=None, type="uint8",
                 index=None, remark="", refresh=0)
    with contextlib.redirect_stdout(io.StringIO()):
        rc = monitor._var_add(stub, args)
    check("缺 address 被拒绝", rc == 2 and stub.calls == [])


# ── 4. read / follow ────────────────────────────────────────
def _record_payload(samples, names=("counter",)):
    return {
        "success": True,
        "segments": [{
            "vars": [{"id": "v1", "name": names[0], "type": "int32", "address": 0x20000000}],
            "samples": [{"t_ms": t, "values": {"v1": v}} for t, v in samples],
        }],
    }


def test_read_and_follow() -> None:
    print("== 4. monitor read / follow ==")
    from omni_cli.commands import monitor

    stub = StubClient(get_result=_record_payload([(0.0, 1), (10.0, 2)]))
    args = _args(start_ms=None, end_ms=None, limit=200, max_points=None,
                 follow=False, interval=0.2, duration=0)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = monitor._read(stub, args)
    out = buf.getvalue()
    check("read 普通输出含表头与样本", rc == 0 and "counter" in out and "2" in out, out)
    check("read 请求带 limit", "limit=200" in stub.calls[0][1], stub.calls[0][1])

    class FollowClient:
        def __init__(self):
            self.calls = 0

        def get(self, path):
            if path.endswith("/monitor/status"):
                return {"latest_t_ms": 0.0}
            self.calls += 1
            if self.calls == 1:
                return _record_payload([(0.0, 1), (10.0, 2)])
            if self.calls == 2:
                return _record_payload([(10.0, 2), (20.0, 3)])
            return _record_payload([])

    args = _args(start_ms=None, end_ms=None, limit=200, max_points=None,
                 follow=True, interval=0.05, duration=0.05, json_=True)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = monitor._read(FollowClient(), args)
    lines = [json.loads(x) for x in buf.getvalue().splitlines() if x.strip()]
    ts = [x["t_ms"] for x in lines]
    check("follow 退出码 0", rc == 0, str(rc))
    check("follow 默认从当前最新样本之后开始且不重复", ts == [10.0, 20.0], str(ts))


# ── 5. export ──────────────────────────────────────────────
def test_export() -> None:
    print("== 5. monitor export ==")
    from omni_cli.commands import monitor

    with tempfile.TemporaryDirectory(prefix="omni_mon_exp_") as tmp:
        out = os.path.join(tmp, "rec.csv")
        stub = StubClient(get_result={
            "success": True, "count": 2,
            "csv": "t_ms,time,counter\n0.000,0.000,counter\n",
        })
        args = _args(out=out, mode="all", recent=None, start_ms=None, end_ms=None,
                     force=False, json_=False)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = monitor._export(stub, args)
        check("export 写文件", rc == 0 and Path(out).is_file())
        check("CSV 内容正确", Path(out).read_text(encoding="utf-8").startswith("t_ms,time"))

        args.force = False
        with contextlib.redirect_stdout(io.StringIO()):
            rc = monitor._export(stub, args)
        check("已存在且无 --force 拒绝", rc == 1)

        args.force = True
        with contextlib.redirect_stdout(io.StringIO()):
            rc = monitor._export(stub, args)
        check("--force 覆盖", rc == 0)


# ── 6. 设备复位语义 ────────────────────────────────────────
def test_device_reset() -> None:
    print("== 6. monitor device reset ==")
    import core.monitor_backend as mb

    class FakeTarget:
        def __init__(self):
            self.calls = []

        def reset(self, reset_type=None):
            self.calls.append("reset")

        def resume(self):
            self.calls.append("resume")

        def reset_and_halt(self):
            self.calls.append("reset_and_halt")

    class FakeSession:
        def __init__(self):
            self.target = FakeTarget()

    session = FakeSession()
    original = mb.backend._get_session
    mb.backend._get_session = lambda uid: session
    try:
        result = mb.monitor_backend.reset_target("u1", run=False)
        check("reset --no-run 调用 reset_and_halt",
              result.get("state") == "halted" and session.target.calls == ["reset_and_halt"],
              str(session.target.calls))
        session.target.calls.clear()
        result = mb.monitor_backend.reset_target("u1", run=True)
        check("reset run 调用 reset+resume",
              result.get("state") == "running"
              and session.target.calls == ["reset", "resume"], str(session.target.calls))
    finally:
        mb.backend._get_session = original


# ── 7. 参数解析 ────────────────────────────────────────────
def test_parser() -> None:
    print("== 7. CLI 参数解析 ==")
    from omni_cli.cli import build_parser

    parser = build_parser()
    args = parser.parse_args(["monitor", "start", "--rate", "500", "--transport", "rtt"])
    check("monitor start 解析", args.rate == 500 and args.transport == "rtt")

    args = parser.parse_args([
        "monitor", "var", "add", "--symbol", "g_counter", "--index", "2",
        "--remark", "x", "--refresh", "0.5",
    ])
    check("var add 解析", args.symbol == "g_counter" and args.index == 2)

    args = parser.parse_args(["monitor", "read", "--follow", "--duration", "3"])
    check("read follow 解析", args.follow and args.duration == 3)


def main() -> int:
    from omni_cli.formatting import configure_stdio
    configure_stdio()
    test_recorder_flush()
    test_symbol_resolution()
    test_manual_address()
    test_read_and_follow()
    test_export()
    test_device_reset()
    test_parser()

    print()
    if failures:
        print(f"RESULT: {len(failures)} FAILED -> {failures}")
        return 1
    print("RESULT: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
