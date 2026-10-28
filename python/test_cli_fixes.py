"""CLI / 后端离线回归测试（无需硬件，不会触发任何烧录或调试操作）。

覆盖实机报告（debug/cli-hardware-test-report.md）中可离线验证的修复点：

1. RTT 上行环形缓存 ``RttCapture``：seq / 游标 / 预算截断 / 通道过滤 / 溢出丢包
2. ``commander exec`` 尾部全局选项前移（P3-2）
3. 后端错误分类：未监听 → unreachable、只连不响应 → timeout（P1-3）
4. 源码编码检查：合法 UTF-8 通过、U+FFFD / 非 UTF-8 被拦截（P1-4）
5. ``FlashResult.to_payload``：verify 不返回 ``bytes_written``（P3-1）
6. ``api.zone._failure_detail``：error / errors[] / fallback（P2-1）

用法::

    cd python
    ..\\.venv\\Scripts\\python.exe test_cli_fixes.py
"""

import base64
import contextlib
import importlib.util
import io
import json
import os
import socket
import sys
import tempfile
import threading
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


def _load_module(name: str, filename: str):
    """按文件路径加载模块（避免与 python/build 目录同名冲突）。"""
    spec = importlib.util.spec_from_file_location(name, os.path.join(PY_DIR, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── 1. RttCapture ─────────────────────────────────────────────
def test_rtt_capture() -> None:
    print("== 1. RTT 环形缓存 ==")
    from core.rtt_backend import RttCapture

    cap = RttCapture(max_bytes=1024)
    seqs = [cap.append(0, b"<inf> mkfs: 0\n"), cap.append(1, b"down\n")]
    check("seq 从 1 单调递增", seqs == [1, 2], str(seqs))

    all_data = cap.read()
    check("since=0 从最旧开始", all_data["oldest_seq"] == 1 and len(all_data["chunks"]) == 2)
    check("cursor 推进到 next_seq", all_data["cursor"] == 3 and all_data["next_seq"] == 3)
    first = base64.b64decode(all_data["chunks"][0]["data"])
    check("base64 数据可还原", first == b"<inf> mkfs: 0\n", repr(first))

    only_ch1 = cap.read(channel=1)
    check("通道过滤", [c["channel"] for c in only_ch1["chunks"]] == [1])
    check("过滤后 cursor 仍推进", only_ch1["cursor"] == 3)

    # 预算截断：每块 10 字节，预算 15 只能取一块，cursor 必须指向下一块
    cap2 = RttCapture(max_bytes=4096)
    for i in range(4):
        cap2.append(0, bytes([65 + i]) * 10)
    page1 = cap2.read(max_bytes=15)
    check("预算截断标记", page1["truncated"] is True and page1["last_seq"] == 1)
    check("截断时 cursor=last+1", page1["cursor"] == 2, str(page1["cursor"]))
    page2 = cap2.read(since=page1["cursor"], max_bytes=15)
    check("续读不重复不跳块", page2["chunks"][0]["seq"] == 2 and page2["last_seq"] == 2)

    # 单块超过预算也必须整块返回，不能丢数据
    cap3 = RttCapture(max_bytes=4096)
    cap3.append(0, b"x" * 40)
    big = cap3.read(max_bytes=8)
    check("单块大于预算时整块返回", len(base64.b64decode(big["chunks"][0]["data"])) == 40)

    # 溢出：丢最旧整块并累计 dropped，lost 表示 since 已被覆盖
    cap4 = RttCapture(max_bytes=256)
    for _ in range(100):
        cap4.append(0, b"y" * 10)
    stats = cap4.stats()
    check("溢出不超上限", stats["buffered_bytes"] <= 256, str(stats))
    check("记录丢弃字节", stats["dropped_bytes"] > 0, str(stats))
    lost = cap4.read(since=1)
    check("since 被覆盖时报告 lost", lost["lost"] is True)
    fresh = cap4.read(since=stats["next_seq"])
    check("读取最新 seq 不报 lost", fresh["lost"] is False and fresh["chunks"] == [])


# ── 2. commander 选项前移 ────────────────────────────────────
def test_commander_normalize() -> None:
    print("== 2. commander exec 全局选项前移 ==")
    from omni_cli.commands.commander import normalize_argv

    got = normalize_argv(["commander", "exec", "read32 0x08000000 4", "--timeout", "15"])
    check("尾部 --timeout 前移",
          got == ["commander", "exec", "--timeout", "15", "read32 0x08000000 4"], str(got))

    got = normalize_argv(["commander", "exec", "read32 0x0 4", "--json", "--uid", "852001270"])
    check("尾部 --json/--uid 前移",
          got[:2] == ["commander", "exec"] and "--json" in got and "--uid" in got
          and got[-1] == "read32 0x0 4", str(got))

    got = normalize_argv(["commander", "exec", "--timeout=10", "read32", "0x0", "4"])
    check("--opt=value 形式", got == ["commander", "exec", "--timeout=10", "read32", "0x0", "4"], str(got))

    got = normalize_argv(["commander", "exec", "read32", "0x0", "--", "--json"])
    check("-- 之后不提取", got == ["commander", "exec", "read32", "0x0", "--", "--json"], str(got))

    got = normalize_argv(["debug", "regs", "--json"])
    check("非 commander exec 原样返回", got == ["debug", "regs", "--json"])
    got = normalize_argv(["commander", "shell", "--json"])
    check("commander shell 原样返回", got == ["commander", "shell", "--json"])


# ── 3. 后端错误分类 ──────────────────────────────────────────
def test_error_classification() -> None:
    print("== 3. 后端错误分类 ==")
    from omni_cli import client
    from omni_cli.cli import _format_api_error

    # 未监听端口 → unreachable
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    closed_port = probe.getsockname()[1]
    probe.close()
    try:
        client.ApiClient(closed_port, timeout=2).get("/api/health")
        check("未监听端口抛 ApiError", False)
    except client.ApiError as e:
        check("未监听端口 -> unreachable", e.kind == "unreachable", e.kind)
        check("提示引导 backend start", "backend start" in _format_api_error(e))

    # 只 accept 不响应 → timeout
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    hung_port = srv.getsockname()[1]

    def _accept_and_hold():
        try:
            conn, _ = srv.accept()
            threading.Event().wait(3)
            conn.close()
        except Exception:
            pass

    threading.Thread(target=_accept_and_hold, daemon=True).start()
    try:
        client.ApiClient(hung_port, timeout=1).get("/api/health")
        check("无响应端口抛 ApiError", False)
    except client.ApiError as e:
        check("无响应端口 -> timeout", e.kind == "timeout", e.kind)
        check("提示引导 backend stop", "backend stop" in _format_api_error(e))
    finally:
        srv.close()


# ── 4. 源码编码检查 ──────────────────────────────────────────
def test_source_encoding() -> None:
    print("== 4. 源码编码检查 ==")
    build = _load_module("omni_build", "build.py")

    problems = build.check_source_encoding(Path(PY_DIR))
    check("当前源码无 U+FFFD / 非法 UTF-8", problems == [], str(problems[:3]))

    with tempfile.TemporaryDirectory(prefix="omni_enc_") as tmp:
        Path(tmp, "ok.py").write_text('X = "中文"\n', encoding="utf-8")
        Path(tmp, "bad_fffd.py").write_text('X = "\ufffd"\n', encoding="utf-8")
        Path(tmp, "bad_utf8.py").write_bytes(b"X = '\xff\xfe'\n")
        bad = build.check_source_encoding(Path(tmp))
        names = " ".join(bad)
        check("拦截 U+FFFD", "bad_fffd.py" in names, names)
        check("拦截非法 UTF-8", "bad_utf8.py" in names, names)
        check("合法文件不误报", "ok.py" not in names, names)


# ── 5. FlashResult payload ───────────────────────────────────
def test_flash_payload() -> None:
    print("== 5. FlashResult 响应形态 ==")
    from core.interface import FlashResult

    verify = FlashResult(success=True, duration_ms=3, bytes_verified=27836)
    payload = verify.to_payload(omit_zero_written=True)
    check("verify 不含 bytes_written", "bytes_written" not in payload, str(payload))
    check("verify 含 bytes_verified", payload.get("bytes_verified") == 27836, str(payload))

    program = FlashResult(success=True, bytes_written=100, duration_ms=10)
    pp = program.to_payload()
    check("program 保留 bytes_written", pp.get("bytes_written") == 100, str(pp))
    check("program 不混入 bytes_verified/bytes_erased",
          "bytes_verified" not in pp and "bytes_erased" not in pp, str(pp))

    erase = FlashResult(success=True, bytes_erased=1048576, duration_ms=15970)
    ep = erase.to_payload(omit_zero_written=True)
    check("erase 不含 bytes_written", "bytes_written" not in ep, str(ep))
    check("erase 含 bytes_erased", ep.get("bytes_erased") == 1048576, str(ep))


# ── 6. zone 失败判定 ─────────────────────────────────────────
def test_zone_failure_detail() -> None:
    print("== 6. zone 失败判定 ==")
    from api.zone import _failure_detail

    check("优先取 error",
          _failure_detail({"success": False, "error": "boom"}, "fallback") == "boom")
    detail = _failure_detail(
        {"success": False, "errors": [{"name": "r0", "error": "Target is not connected."}]},
        "fallback",
    )
    check("error 为空时取 errors[]", "r0" in detail and "not connected" in detail, detail)
    check("都为空时用 fallback",
          _failure_detail({"success": False, "errors": []}, "fallback") == "fallback")


# ── 7. rtt read 输出（stub client）────────────────────────────
def test_rtt_read_cli() -> None:
    print("== 7. rtt read 输出 ==")
    from omni_cli.commands import rtt

    payload = {
        "success": True,
        "uid": "u1",
        "running": True,
        "channel": None,
        "oldest_seq": 1,
        "next_seq": 2,
        "last_seq": 1,
        "cursor": 2,
        "truncated": False,
        "lost": False,
        "dropped_bytes": 0,
        "dropped_chunks": 0,
        "chunks": [{"seq": 1, "channel": 0, "size": 17,
                    "data": base64.b64encode(b"<inf> [app]: mkfs: 0\n").decode()}],
        "text": "<inf> [app]: mkfs: 0\n",
    }

    class StubClient:
        def __init__(self):
            self.paths = []

        def get(self, path):
            self.paths.append(path)
            return json.loads(json.dumps(payload))

    args = SimpleNamespace(uid="u1", channel=None, since=0, max_bytes=65536, follow=False,
                           interval=0.2, duration=0.0, out=None, encoding="utf-8",
                           json_=True, quiet=False)
    stub = StubClient()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = rtt._read(stub, args)
    out = json.loads(buf.getvalue())
    check("rtt read 退出码 0", rc == 0, str(rc))
    check("请求包含 since/max_bytes", "since=0" in stub.paths[0] and "max_bytes=" in stub.paths[0])
    check("--json 输出含 seq 与文本",
          out["chunks"][0]["seq"] == 1 and out["text"].startswith("<inf>"))
    check("JSON 中 chunks 可解码",
          base64.b64decode(out["chunks"][0]["data"]).startswith(b"<inf>"))


def test_flash_timeout_defaults() -> None:
    print("== 8. Flash 命令默认超时 ==")
    from omni_cli.cli import build_parser

    parser = build_parser()
    check("flash erase 默认 180s", parser.parse_args(["flash", "erase"]).timeout == 180)
    check("flash program 默认 180s",
          parser.parse_args(["flash", "program", "app.hex"]).timeout == 180)
    check("flash verify 默认 120s",
          parser.parse_args(["flash", "verify", "app.hex"]).timeout == 120)
    check("flash blank-check 默认 120s", parser.parse_args(["flash", "blank-check"]).timeout == 120)
    check("flash read 默认 120s", parser.parse_args(["flash", "read"]).timeout == 120)
    check("flash fill 默认 120s",
          parser.parse_args(["flash", "fill", "--addr", "0x0", "--size", "4"]).timeout == 120)
    check("其它命令仍为 30s", parser.parse_args(["probe", "list"]).timeout == 30)
    check("显式 --timeout 覆盖默认值",
          parser.parse_args(["flash", "erase", "--timeout", "40"]).timeout == 40)


def test_regs_filter_failure() -> None:
    print("== 9. debug regs 过滤失败提示 ==")
    from omni_cli.commands import debug

    class Stub:
        def get(self, path):
            return {"success": True, "registers": [],
                    "errors": [{"name": "pc", "error": "Target is not halted."}]}

    args = SimpleNamespace(uid="u1", filter="pc", json_=False, quiet=False)
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = debug._regs(Stub(), args)
    text = err.getvalue()
    check("过滤目标读取失败时退出码非 0", rc == 1, str(rc))
    check("给出真实读取错误而不是“没有匹配的寄存器”",
          "读取寄存器 pc 失败" in text and "没有匹配的寄存器" not in text, text)


def test_flash_payload_rtt_stopped() -> None:
    print("== 10. Flash 响应 rtt_stopped ==")
    from api.flash import _flash_payload

    class _Result:
        def to_payload(self, omit_zero_written=False):
            return {"success": True, "bytes_erased": 64}

    payload = _flash_payload(_Result(), {"rtt_stopped": True}, omit_zero_written=True)
    check("包含 rtt_stopped=true", payload.get("rtt_stopped") is True, str(payload))
    check("保留 bytes_erased", payload.get("bytes_erased") == 64, str(payload))


def test_rtt_user_halted() -> None:
    print("== 11. RTT 用户暂停标志同步 ==")
    from core.rtt_backend import RTTBackend, _RttSession

    uid = "__unit_test_uid__"
    backend = RTTBackend()
    backend.set_user_halted(uid, True)
    check("无 RTT 会话时不登记", uid not in backend._sessions)
    backend._sessions[uid] = _RttSession(uid, object(), 0, 0)
    try:
        backend.set_user_halted(uid, True)
        check("有会话时登记用户暂停", backend._sessions[uid].user_halted is True)
        backend.set_user_halted(uid, False)
        check("继续运行时清除用户暂停", backend._sessions[uid].user_halted is False)
    finally:
        backend._sessions.pop(uid, None)


def test_verify_reset_order() -> None:
    print("== 13. Flash verify 读取前复位 ==")
    import tempfile
    from core.pyocd_backend import PyOCDBackend

    class FakeRegion:
        start = 0x08000000
        length = 0x1000
        is_flash = True

        def contains_range(self, start=None, end=None, length=None, range=None):
            return True

    class FakeMap:
        def get_boot_memory(self):
            return FakeRegion()

        def get_region_for_address(self, addr):
            return FakeRegion() if 0x08000000 <= addr < 0x08001000 else None

    class FakeTarget:
        def __init__(self):
            self.calls = []
            self.memory_map = FakeMap()

        def reset_and_halt(self):
            self.calls.append("reset_and_halt")

        def halt(self):
            self.calls.append("halt")

        def read_memory_block32(self, addr, words):
            self.calls.append("read32")
            return [int.from_bytes(b"AABB", "little")]

        def read_memory_block8(self, addr, size):
            self.calls.append("read8")
            return list(b"AABB")[:size]

    class FakeSession:
        def __init__(self):
            self.target = FakeTarget()

    def _run_verify(addr: int):
        backend = PyOCDBackend()
        fake = FakeSession()
        backend._get_session = lambda uid: fake
        backend._extract_file_data = lambda session, path, ext, base=None: [(addr, b"AABB")]
        with tempfile.NamedTemporaryFile(suffix=".hex", delete=False) as f:
            path = f.name
        try:
            result = backend.verify("u1", path)
        finally:
            os.unlink(path)
        return result, fake.target.calls

    result, calls = _run_verify(0x08000000)
    check("Flash verify 成功", result.success is True, str(result))
    check("Flash verify 首次调用 reset_and_halt", calls[:1] == ["reset_and_halt"], str(calls))

    result, calls = _run_verify(0x20000000)
    check("RAM verify 成功", result.success is True, str(result))
    check("RAM verify 只 halt、不复位", calls[:1] == ["halt"] and "reset_and_halt" not in calls,
          str(calls))


def test_fill_value_and_import() -> None:
    print("== 14. flash fill 模块与 --value ==")
    from pyocd.flash.loader import FlashLoader, MemoryLoader

    check("FlashLoader 来自 pyocd.flash.loader", FlashLoader is MemoryLoader)

    from omni_cli.cli import build_parser
    parser = build_parser()
    args = parser.parse_args(["flash", "fill", "--addr", "0x08000000",
                              "--size", "256", "--value", "0x55"])
    check("--value 接受 0x55", args.value == 0x55, str(args.value))

    from omni_cli.commands import flash as flash_cmd

    class Stub:
        def __init__(self):
            self.calls = []

        def post(self, *a, **kw):
            self.calls.append((a, kw))
            return {"success": True}

    stub = Stub()
    ns = SimpleNamespace(uid="u1", addr="0x08000000", size="256", value=300,
                         json_=True, quiet=False)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = flash_cmd._fill(stub, ns)
    check("非法 --value 退出码 2 且不发请求", rc == 2 and not stub.calls,
          f"rc={rc} calls={stub.calls}")


def test_rtt_session_reset() -> None:
    print("== 15. RTT --since 会话语义 ==")
    from core.rtt_backend import RttCapture

    cap = RttCapture()
    cap.append(0, b"NEW-SESSION")
    old = cap.read(since=99)
    check("旧会话 since 触发 session_reset", old["session_reset"] is True, str(old.get("session_reset")))
    check("旧会话 since 不误报 lost", old["lost"] is False, str(old.get("lost")))
    check("旧会话 since 从最旧数据重读",
          len(old["chunks"]) == 1
          and base64.b64decode(old["chunks"][0]["data"]) == b"NEW-SESSION")

    same = cap.read(since=cap.stats()["next_seq"])
    check("since == next_seq 是正常空读", same["session_reset"] is False and same["chunks"] == [],
          str(same))

    # 同一后端进程内新 rtt start：seq 续用，旧 next_seq 继续有效
    old_next = cap.stats()["next_seq"]
    cap2 = RttCapture(start_seq=old_next)
    cap2.append(0, b"SESSION-2")
    cont = cap2.read(since=old_next)
    check("新会话 seq 续用旧 next_seq", cont["chunks"] and cont["chunks"][0]["seq"] == old_next,
          str(cont))
    check("续用游标不触发 session_reset",
          cont["session_reset"] is False and cont["lost"] is False, str(cont))


def test_readme_commander_docs() -> None:
    print("== 12. README commander 文档 ==")
    readme = Path(PY_DIR, "omni_cli", "README.md").read_text(encoding="utf-8")
    check("文档使用 `commander exec help` 列命令", "omni commander exec help" in readme)
    check("文档不再声称 `exec list` 列出命令",
          "exec list                     # 列出全部可用命令" not in readme)
    check("文档说明 exec list 是探针/目标列表", "探针/目标" in readme)
    check("文档说明 --since 跨 rtt start 有效",
          "跨 `rtt start` 单调递增" in readme or "跨 rtt start 有效" in readme)
    check("文档说明 probe list 快照与权威状态",
          "监控快照" in readme and "probe status" in readme)
    check("文档说明两个 reset 默认值相反",
          "默认复位后运行" in readme and "默认复位并暂停" in readme)


def test_rtt_read_json_warnings() -> None:
    print("== 16. rtt read --json 警告不污染 stdout ==")
    from omni_cli.commands import rtt

    payload = {
        "success": True, "uid": "u1", "running": True, "channel": None,
        "oldest_seq": 1, "next_seq": 2, "last_seq": 1, "cursor": 2,
        "truncated": False, "lost": False, "session_reset": True,
        "dropped_bytes": 0, "dropped_chunks": 0,
        "chunks": [{"seq": 1, "channel": 0, "size": 3,
                    "data": base64.b64encode(b"abc").decode()}],
        "text": "abc",
    }

    class Stub:
        def get(self, path):
            return json.loads(json.dumps(payload))

    args = SimpleNamespace(uid="u1", channel=None, since=99, max_bytes=65536, follow=False,
                           interval=0.2, duration=0.0, out=None, encoding="utf-8",
                           json_=True, quiet=False)
    stdout, stderr = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        rc = rtt._read(Stub(), args)
    text = stdout.getvalue()
    try:
        parsed = json.loads(text)
        parse_ok = True
    except Exception:
        parsed, parse_ok = None, False
    check("--json 模式 stdout 是合法 JSON", parse_ok, repr(text[:80]))
    check("session_reset 保留在 JSON", bool(parsed) and parsed.get("session_reset") is True)
    check("警告写入 JSON warning 字段",
          bool(parsed) and "超出" in str(parsed.get("warning", "")), repr(parsed))
    check("--json 模式 stderr 为空", stderr.getvalue() == "", repr(stderr.getvalue()))

    # lost 场景同理：只进 JSON，不写 stderr
    payload2 = dict(payload, session_reset=False, lost=True)
    class Stub2:
        def get(self, path):
            return json.loads(json.dumps(payload2))
    stdout2, stderr2 = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(stdout2), contextlib.redirect_stderr(stderr2):
        rtt._read(Stub2(), args)
    parsed2 = json.loads(stdout2.getvalue())
    check("lost 警告也在 JSON 内",
          "lost" in str(parsed2.get("warning", "")), repr(parsed2))
    check("lost 场景 stderr 为空", stderr2.getvalue() == "", repr(stderr2.getvalue()))


def main() -> int:
    from omni_cli.formatting import configure_stdio
    configure_stdio()
    try:
        test_rtt_capture()
        test_commander_normalize()
        test_error_classification()
        test_source_encoding()
        test_flash_payload()
        test_zone_failure_detail()
        test_rtt_read_cli()
        test_flash_timeout_defaults()
        test_regs_filter_failure()
        test_flash_payload_rtt_stopped()
        test_rtt_user_halted()
        test_verify_reset_order()
        test_fill_value_and_import()
        test_rtt_session_reset()
        test_rtt_read_json_warnings()
        test_readme_commander_docs()
    except Exception:
        import traceback
        traceback.print_exc()
        failures.append("unexpected exception")
    print()
    if failures:
        print(f"FAILED: {len(failures)} 项")
        for name in failures:
            print(f"  - {name}")
        return 1
    print("ALL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
