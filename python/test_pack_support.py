"""CMSIS-Pack 临时挂包 / 管理命令离线回归测试（无需硬件）。

覆盖：
1. ``validate_pack_paths`` / ``ensure_pack_targets``（校验、去重、缓存、失败不缓存）
2. ``_register_pack_targets`` 的所有权快照
3. ``_pack_removable_keys``：内置型号与其它 Pack 的型号不被误删
4. 清单路径自愈 ``_resolve_manifest_path``
5. ``is_target_registered`` 对 Pack 芯片的可用性判断
6. CLI ``--pack`` / ``-t`` / ``-f`` / ``-M`` 解析与频率单位
7. CLI ``probe connect/target`` 与 ``pack preview/import/remove/list`` 请求体
8. 后端 ``connect`` / ``set_target`` 的 Pack 注册与 target_override

用法::

    cd python
    ..\\.venv\\Scripts\\python.exe test_pack_support.py
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


def _make_pack(path: Path, data: bytes = b"PK\x03\x04dummy") -> str:
    path.write_bytes(data)
    return str(path)


# ── 1. 路径校验与临时挂包缓存 ────────────────────────────────
def test_validate_and_cache() -> None:
    print("== 1. validate_pack_paths / ensure_pack_targets ==")
    from core import pack_manager

    with tempfile.TemporaryDirectory(prefix="omni_pack_") as tmp:
        root = Path(tmp)
        a = _make_pack(root / "a.pack")
        b = _make_pack(root / "B.PACK")
        bad = root / "not.txt"
        bad.write_text("x")

        normalized = pack_manager.validate_pack_paths([a, a, b])
        check("去重后保留两个路径", len(normalized) == 2, str(normalized))
        check("返回绝对路径", all(os.path.isabs(p) for p in normalized))

        try:
            pack_manager.validate_pack_paths(str(root / "missing.pack"))
            check("缺失文件抛错", False)
        except FileNotFoundError:
            check("缺失文件抛 FileNotFoundError", True)

        try:
            pack_manager.validate_pack_paths(str(bad))
            check("非 .pack 抛错", False)
        except ValueError:
            check("非 .pack 抛 ValueError", True)

        calls = []

        def fake_populate(path):
            calls.append(path)

        from pyocd.target.pack import pack_target
        original = pack_target.PackTargets.populate_targets_from_pack
        pack_target.PackTargets.populate_targets_from_pack = staticmethod(fake_populate)
        pack_manager._pack_load_cache.clear()
        try:
            pack_manager.ensure_pack_targets([a, b])
            check("首次挂载解析两个包", len(calls) == 2, str(calls))
            pack_manager.ensure_pack_targets([a, b])
            check("缓存命中不重复解析", len(calls) == 2, str(calls))

            # mtime/size 变化 -> 重新解析
            root.joinpath("a.pack").write_bytes(b"PK\x03\x04changed")
            os.utime(a, None)
            pack_manager.ensure_pack_targets([a])
            check("文件变化后重新解析", len(calls) == 3, str(calls))
        finally:
            pack_target.PackTargets.populate_targets_from_pack = original
            pack_manager._pack_load_cache.clear()

        # 失败不写缓存：下次仍会尝试
        attempts = []

        def boom(path):
            attempts.append(path)
            raise RuntimeError("bad pack")

        pack_target.PackTargets.populate_targets_from_pack = staticmethod(boom)
        try:
            for _ in range(2):
                try:
                    pack_manager.ensure_pack_targets([a])
                except ValueError:
                    pass
            check("解析失败不缓存（重试两次）", len(attempts) == 2, str(attempts))
        finally:
            pack_target.PackTargets.populate_targets_from_pack = original
            pack_manager._pack_load_cache.clear()


# ── 2. TARGET 所有权与卸载安全 ──────────────────────────────
def test_ownership_and_removal() -> None:
    print("== 2. TARGET 所有权 / 卸载安全 ==")
    import pyocd.target as pyocd_target
    from core import pack_manager

    fake_target = {"stm32f103c8": object(), "shared": object()}

    def fake_populate(path):
        fake_target["g32f020k8"] = object()

    from pyocd.target.pack import pack_target
    original = pack_target.PackTargets.populate_targets_from_pack
    pack_target.PackTargets.populate_targets_from_pack = staticmethod(fake_populate)
    original_target = pyocd_target.TARGET
    pyocd_target.TARGET = fake_target
    try:
        added = pack_manager._register_pack_targets("/tmp/fake.pack")
        check("只返回新增键", added == {"g32f020k8"}, str(added))
    finally:
        pyocd_target.TARGET = original_target
        pack_target.PackTargets.populate_targets_from_pack = original

    manifest = [
        {"name": "A", "devices": ["g32f020k8"],
         "all_devices": ["stm32f103c8", "g32f020k8", "shared"]},
        {"name": "B", "devices": ["shared"], "all_devices": ["shared"]},
    ]
    removable = pack_manager._pack_removable_keys(manifest, "A", {"g32f020k8"})
    check("不删内置 stm32f103c8", "stm32f103c8" not in removable, str(removable))
    check("不删其它 Pack 的 shared", "shared" not in removable, str(removable))
    check("删除本 Pack 独有的 g32f020k8", removable == {"g32f020k8"}, str(removable))


# ── 3. 清单路径自愈 ─────────────────────────────────────────
def test_manifest_self_heal() -> None:
    print("== 3. 清单路径自愈 ==")
    from core import pack_manager

    with tempfile.TemporaryDirectory(prefix="omni_pack_heal_") as tmp:
        packs_dir = Path(tmp)
        _make_pack(packs_dir / "Geehy.G32F020_DFP.0.0.11.pack")
        original = pack_manager.get_packs_dir
        pack_manager.get_packs_dir = lambda: str(packs_dir)
        try:
            entry = {
                "name": "Geehy.G32F020_DFP",
                "filename": "Geehy.G32F020_DFP.0.0.11.pack",
                "path": r"D:\another\checkout\python\data\packs\Geehy.G32F020_DFP.0.0.11.pack",
            }
            resolved = pack_manager._resolve_manifest_path(entry)
            check("旧路径失效时按 filename 自愈",
                  resolved == str(packs_dir / entry["filename"]), resolved)
            check("回写 entry['path']", entry["path"] == resolved)
        finally:
            pack_manager.get_packs_dir = original


# ── 4. 设备可用性 ───────────────────────────────────────────
def test_target_availability() -> None:
    print("== 4. is_target_registered（Pack） ==")
    from core import database, pack_manager

    with tempfile.TemporaryDirectory(prefix="omni_pack_avail_") as tmp:
        packs_dir = Path(tmp)
        pack_file = _make_pack(packs_dir / "Vendor.DFP.1.0.0.pack")

        orig_get_device = database.get_device
        orig_manifest = pack_manager.load_manifest
        orig_packs_dir = pack_manager.get_packs_dir

        database.get_device = lambda part: {
            "part_number": part, "source": "pack", "pack": "Vendor.DFP",
        }
        pack_manager.load_manifest = lambda: [{
            "name": "Vendor.DFP", "filename": "Vendor.DFP.1.0.0.pack",
            "path": str(pack_file),
        }]
        pack_manager.get_packs_dir = lambda: str(packs_dir)
        try:
            check("Pack 文件存在 -> 可用", database.is_target_registered("g32f020k8") is True)
            os.remove(pack_file)
            check("Pack 文件删除 -> 不可用", database.is_target_registered("g32f020k8") is False)
        finally:
            database.get_device = orig_get_device
            pack_manager.load_manifest = orig_manifest
            pack_manager.get_packs_dir = orig_packs_dir


# ── 4b. 无效 Pack / --parts 校验 ────────────────────────────
def test_invalid_pack_rejected() -> None:
    print("== 4b. 无效 Pack 拒绝 ==")
    from core import pack_manager

    with tempfile.TemporaryDirectory(prefix="omni_pack_invalid_") as tmp:
        root = Path(tmp)
        bad = root / "Bad.DFP.1.0.0.pack"
        bad.write_bytes(b"not a zip")

        try:
            pack_manager.preview_pack(str(bad))
            check("preview 拒绝非 ZIP", False)
        except ValueError:
            check("preview 拒绝非 ZIP", True)

        packs_dir = root / "packs"
        original = pack_manager.get_packs_dir
        pack_manager.get_packs_dir = lambda: str(packs_dir)
        try:
            try:
                pack_manager.import_pack(str(bad))
                check("import 拒绝非 ZIP", False)
            except ValueError:
                check("import 拒绝非 ZIP", True)
            check("无效 Pack 未复制", not (packs_dir / bad.name).exists())
            check("无效 Pack 未写清单", pack_manager.load_manifest() == [])
        finally:
            pack_manager.get_packs_dir = original


def test_import_unknown_parts() -> None:
    print("== 4c. 导入 --parts 校验 ==")
    from core import pack_manager

    with tempfile.TemporaryDirectory(prefix="omni_pack_parts_") as tmp:
        root = Path(tmp)
        pack_file = _make_pack(root / "Vendor.DFP.1.0.0.pack")

        original_extract = pack_manager._extract_devices_from_pack
        original_register = pack_manager._register_pack_targets
        original_packs_dir = pack_manager.get_packs_dir
        pack_manager._extract_devices_from_pack = lambda path, strict=False: [{
            "part_number": "aaa", "source": "pack", "vendor": "Vendor",
            "display_name": "AAA", "core": "Cortex-M0+", "num_cores": 1,
            "flash_size": 1, "ram_size": 1, "flash_base_address": "0x0",
            "ram_base_address": "0x20000000", "device_id_address": "0xE0042000",
            "flash_regions": [], "ram_regions": [],
        }]
        pack_manager._register_pack_targets = lambda path: set()
        pack_manager.get_packs_dir = lambda: str(root / "packs")
        try:
            try:
                pack_manager.import_pack(str(pack_file), ["nope"])
                check("未知 --parts 被拒绝", False)
            except ValueError:
                check("未知 --parts 被拒绝", True)
            check("拒绝时未复制 Pack", not (root / "packs" / Path(pack_file).name).exists())
        finally:
            pack_manager._extract_devices_from_pack = original_extract
            pack_manager._register_pack_targets = original_register
            pack_manager.get_packs_dir = original_packs_dir


def test_reimport_prunes_unselected() -> None:
    print("== 4d. 重导入替换设备选择 ==")
    from core import pack_manager

    with tempfile.TemporaryDirectory(prefix="omni_pack_prune_") as tmp:
        root = Path(tmp)
        pack_file = _make_pack(root / "Vendor.DFP.1.0.0.pack")
        fake_db = {
            "aaa": {"part_number": "aaa", "source": "pack", "pack": "Vendor.DFP"},
            "bbb": {"part_number": "bbb", "source": "pack", "pack": "Vendor.DFP"},
        }

        def make_dev(part):
            return {
                "part_number": part, "source": "pack", "vendor": "Vendor",
                "display_name": part.upper(), "core": "Cortex-M0+", "num_cores": 1,
                "flash_size": 1, "ram_size": 1, "flash_base_address": "0x0",
                "ram_base_address": "0x20000000", "device_id_address": "0xE0042000",
                "flash_regions": [], "ram_regions": [],
            }

        original_extract = pack_manager._extract_devices_from_pack
        original_register = pack_manager._register_pack_targets
        original_packs_dir = pack_manager.get_packs_dir
        original_list = pack_manager.database.list_devices
        original_delete = pack_manager.database.delete_device
        original_upsert = pack_manager.database.upsert_device
        pack_manager._extract_devices_from_pack = lambda path, strict=False: [
            make_dev("aaa"), make_dev("bbb"),
        ]
        pack_manager._register_pack_targets = lambda path: set()
        (root / "packs").mkdir()
        pack_manager.get_packs_dir = lambda: str(root / "packs")
        pack_manager.database.list_devices = lambda: list(fake_db.values())
        pack_manager.database.delete_device = lambda part: fake_db.pop(part, None)
        pack_manager.database.upsert_device = lambda dev: fake_db.__setitem__(
            dev["part_number"], dev)
        try:
            result = pack_manager.import_pack(str(pack_file), ["aaa"])
            check("只写入选中的 aaa", set(fake_db) == {"aaa"}, str(set(fake_db)))
            check("manifest device_count=1", result["device_count"] == 1)
        finally:
            pack_manager._extract_devices_from_pack = original_extract
            pack_manager._register_pack_targets = original_register
            pack_manager.get_packs_dir = original_packs_dir
            pack_manager.database.list_devices = original_list
            pack_manager.database.delete_device = original_delete
            pack_manager.database.upsert_device = original_upsert


# ── 4e. Flash 起始地址 0x0 的范围检查 ──────────────────────
def test_zero_base_blank_check_range() -> None:
    print("== 4e. base=0x0 的 blank-check 范围 ==")
    from core.pyocd_backend import PyOCDBackend
    from pyocd.core.memory_map import MemoryType

    reads = []

    class FakeRegion:
        type = MemoryType.FLASH
        start = 0
        length = 0x20000
        sector_size = 0x200

    class FakeTarget:
        memory_map = [FakeRegion()]

        def reset_and_halt(self):
            pass

        def read_memory_block32(self, addr, count):
            reads.append((addr, count))
            return [0xFFFFFFFF] * count

    class FakeSession:
        target = FakeTarget()

    backend = PyOCDBackend()
    backend._get_session = lambda uid: FakeSession()
    result = backend.check_blank("uid", 0, 512)
    check("只扫描请求的 512 字节", result.get("total_bytes") == 512, str(result))
    check("只读取 512 字节（128 words）", reads == [(0, 128)], str(reads))


# ── 5. CLI 参数解析 ─────────────────────────────────────────
def test_cli_parser() -> None:
    print("== 5. CLI 参数解析 ==")
    from omni_cli.cli import build_parser
    from omni_cli.util import parse_frequency

    parser = build_parser()
    args = parser.parse_args([
        "probe", "connect", "uid1", "-t", "g32f020k8",
        "--pack", "a.pack", "--pack", "b.pack",
        "-f", "4m", "-M", "attach",
    ])
    check("--pack 可重复", args.pack == ["a.pack", "b.pack"], str(args.pack))
    check("-t 别名", args.target == "g32f020k8")
    check("-f 频率单位", args.speed == 4_000_000, str(args.speed))
    check("-M 连接模式", args.connect_mode == "attach")

    check("2.5khz -> 2500", parse_frequency("2.5khz") == 2500)
    check("1000000 -> 1 MHz", parse_frequency("1000000") == 1_000_000)
    try:
        parse_frequency("abc")
        check("非法频率抛错", False)
    except Exception:
        check("非法频率抛错", True)


# ── 6. CLI 处理器请求体 ─────────────────────────────────────
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


def test_cli_handlers() -> None:
    print("== 6. CLI 请求体 ==")
    from omni_cli.commands import pack as pack_cmd
    from omni_cli.commands import probe as probe_cmd

    with tempfile.TemporaryDirectory(prefix="omni_pack_cli_") as tmp:
        pack_file = _make_pack(Path(tmp) / "Vendor.DFP.1.0.0.pack")

        stub = StubClient(post_result={"connected": True, "target": {"part_number": "g32f020k8"}})
        args = SimpleNamespace(uid="uid1", target="g32f020k8", interface="swd", speed=4_000_000,
                               connect_mode="halt", force=False, jlink_device=None,
                               pack=[pack_file], json_=True, quiet=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = probe_cmd._connect(stub, args)
        payload = stub.calls[0][2]
        check("probe connect 返回 0", rc == 0)
        check("pack 传绝对路径", payload.get("pack") == [os.path.abspath(pack_file)], str(payload))
        check("JSON 输出可解析", json.loads(buf.getvalue()).get("connected") is True)

        stub = StubClient(post_result={"success": True, "target": None})
        args = SimpleNamespace(uid="uid1", part="g32f020k8", pack=[pack_file],
                               json_=True, quiet=False)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = probe_cmd._target(stub, args)
        check("probe target 带 pack", rc == 0 and stub.calls[0][2]["pack"] == [os.path.abspath(pack_file)])

        # 缺失文件：不发请求
        stub = StubClient()
        args = SimpleNamespace(uid="uid1", target="x", interface="swd", speed=None,
                               connect_mode=None, force=False, jlink_device=None,
                               pack=[str(Path(tmp) / "missing.pack")], json_=True, quiet=False)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = probe_cmd._connect(stub, args)
        check("坏 Pack 在客户端拦截", rc == 1 and stub.calls == [])

        # pack preview
        stub = StubClient(post_result={"devices": [
            {"part_number": "g32f020k8", "display_name": "G32F020K8", "vendor": "Geehy",
             "core": "Cortex-M0+", "flash_size": 64, "ram_size": 8},
        ]})
        args = SimpleNamespace(file=pack_file, search=None, limit=0, json_=True, quiet=False)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = pack_cmd._preview(stub, args)
        check("pack preview 请求体", rc == 0 and stub.calls[0][2]["path"] == os.path.abspath(pack_file))

        # pack import --parts
        stub = StubClient(post_result={"pack": {"name": "Vendor.DFP", "version": "1.0.0"},
                                       "devices": [], "device_count": 0})
        args = SimpleNamespace(file=pack_file, parts="g32f020k8, g32f002f5",
                               json_=True, quiet=False)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = pack_cmd._import(stub, args)
        check("pack import 解析 --parts",
              rc == 0 and stub.calls[0][2]["selected_parts"] == ["g32f020k8", "g32f002f5"])

        # pack remove
        stub = StubClient(delete_result={"success": True})
        args = SimpleNamespace(name="Vendor.DFP", yes=True, json_=True, quiet=False)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = pack_cmd._remove(stub, args)
        check("pack remove URL 编码", rc == 0 and stub.calls[0][1] == "/api/packs/Vendor.DFP")

        # pack list
        stub = StubClient(get_result=[{"name": "Vendor.DFP", "version": "1.0.0",
                                       "device_count": 3, "file_exists": True}])
        args = SimpleNamespace(json_=True, quiet=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = pack_cmd._list(stub, args)
        check("pack list JSON", rc == 0 and json.loads(buf.getvalue())["packs"][0]["name"] == "Vendor.DFP")


# ── 7. 后端 connect / set_target ────────────────────────────
def test_backend_connect_options() -> None:
    print("== 7. 后端 connect / set_target ==")
    from core import pack_manager
    from core.pyocd_backend import PyOCDBackend
    from pyocd.core import helpers as pyocd_helpers

    captured = []
    ensure_calls = []

    def fake_ensure(paths):
        ensure_calls.append(list(paths))
        return list(paths)

    def fake_session(**kwargs):
        captured.append(kwargs)
        return None

    orig_ensure = pack_manager.ensure_pack_targets
    orig_session = pyocd_helpers.ConnectHelper.session_with_chosen_probe
    pack_manager.ensure_pack_targets = fake_ensure
    pyocd_helpers.ConnectHelper.session_with_chosen_probe = staticmethod(fake_session)
    try:
        backend = PyOCDBackend()
        ok = backend.connect("uid-x", target="g32f020k8", packs=["/tmp/fake.pack"])
        check("connect 返回 False（假探针会话为空）", ok is False)
        check("connect 触发 Pack 注册", ensure_calls == [["/tmp/fake.pack"]], str(ensure_calls))
        check("connect 传递 target_override",
              captured and captured[0].get("target_override") == "g32f020k8", str(captured))
        check("connect 不把 pack 塞进 session options",
              captured and "pack" not in (captured[0].get("options") or {}), str(captured))

        # set_target：注册失败不应断开旧会话
        backend2 = PyOCDBackend()
        disconnected = []
        backend2.disconnect = lambda uid, wait=False: disconnected.append(uid)

        def fail_ensure(paths):
            raise ValueError("bad pack")

        pack_manager.ensure_pack_targets = fail_ensure
        ok = backend2.set_target("uid-y", "g32f020k8", packs=["/tmp/bad.pack"])
        check("坏 Pack 时 set_target 返回 False", ok is False)
        check("坏 Pack 不拆旧会话", disconnected == [], str(disconnected))
    finally:
        pack_manager.ensure_pack_targets = orig_ensure
        pyocd_helpers.ConnectHelper.session_with_chosen_probe = orig_session


def main() -> int:
    from omni_cli.formatting import configure_stdio
    configure_stdio()
    test_validate_and_cache()
    test_ownership_and_removal()
    test_manifest_self_heal()
    test_target_availability()
    test_invalid_pack_rejected()
    test_import_unknown_parts()
    test_reimport_prunes_unselected()
    test_zero_base_blank_check_range()
    test_cli_parser()
    test_cli_handlers()
    test_backend_connect_options()

    print()
    if failures:
        print(f"RESULT: {len(failures)} FAILED -> {failures}")
        return 1
    print("RESULT: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
