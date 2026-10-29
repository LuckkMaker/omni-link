"""`omni config` 离线回归测试（不需要硬件/后端）。

用法::

    cd python
    ..\\.venv\\Scripts\\python.exe test_config_cli.py
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PY_DIR)

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, OSError, ValueError):
        pass

from omni_cli.cli import build_parser
from omni_cli import context
from omni_cli.config.bspgen import run_bspgen
from omni_cli.context import ProjectError
from omni_cli.config.generate import generate_project_config
from omni_cli.config.uvproj_sync import sync_uvprojx_project

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not cond else ""))


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def make_tree(root: Path) -> Path:
    """创建最小 OMNI 工程：repo/omni + repo/app。"""

    write(root / "omni" / "Kconfig", 'mainmenu "Test"\n\nsource "Kconfig.omni"\n')
    write(
        root / "omni" / "Kconfig.omni",
        'config TEST_BOOL\n\tbool "test bool"\n\tdefault y\n\n'
        'config TEST_INT\n\tint "test int"\n\tdefault 3\n',
    )
    app = root / "app"
    write(app / "prj.conf", "CONFIG_APP_VALUE=9\n")
    write(
        app / "Kconfig",
        'config APP_VALUE\n\tint "app value"\n\tdefault 7\n',
    )
    write(app / "boards" / "board1" / "board.conf", "CONFIG_TEST_BOOL=y\n")
    write(app / "boards" / "board2" / "board.conf", "CONFIG_TEST_INT=5\n")
    write(app / "src" / "app.c", "GPIO_DEVICE_DEFINE(demo, NULL);\n")
    return app


def test_context(root: Path) -> None:
    print("== 1. 上下文解析 ==")
    app = root / "app"
    ctx = context.resolve_context(project_dir=str(app), target="board1")
    check("工程目录", Path(ctx.project_dir) == app.resolve())
    check("omni 根目录", Path(ctx.omni_root) == (root / "omni").resolve())
    check("repo 根目录", Path(ctx.repo_root) == root.resolve())
    check("目标板", ctx.target == "board1")

    check(
        "--omni-root 接受仓库根",
        context.resolve_omni_root(str(app), str(root)) == str((root / "omni").resolve()),
    )
    check(
        "--omni-root 接受 omni 目录",
        context.resolve_omni_root(str(app), str(root / "omni")) == str((root / "omni").resolve()),
    )

    try:
        context.resolve_target(str(app), None)
    except ProjectError as exc:
        check("多目标报错并列出候选", exc.code == 2 and "board1" in str(exc) and "board2" in str(exc), str(exc))
    else:
        check("多目标报错并列出候选", False)


def test_generate(root: Path) -> None:
    print("== 2. Kconfig 合并 / BSP 生成 ==")
    app = root / "app"
    result = generate_project_config(
        project_dir=str(app),
        omni_root=str(root / "omni"),
        target="board1",
        log=lambda _message: None,
    )
    dot_config = (app / ".config").read_text(encoding="utf-8")
    header = (app / "boards" / "board1" / "config" / "omni_config.h").read_text(encoding="utf-8")
    bsp = (app / "boards" / "board1" / "config" / "bsp_config.h").read_text(encoding="utf-8")

    check("写入 .config", "CONFIG_APP_VALUE=9" in dot_config, dot_config)
    check("写入 omni_config.h", "CONFIG_TEST_BOOL" in header or "CONFIG_APP_VALUE" in header, header[:200])
    check("写入 bsp_config.h", "extern const struct device _dev_demo;" in bsp, bsp)
    check("返回生成文件列表", len(result.generated) >= 3, str(result.generated))


def make_uvprojx(path: Path, group: str = "omni/subsys") -> None:
    write(
        path,
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
        "<Project>\n"
        "  <Groups>\n"
        f'    <Group><GroupName>{group}</GroupName><Files></Files></Group>\n'
        "  </Groups>\n"
        "  <Cads><VariousControls><IncludePath></IncludePath><Define></Define></VariousControls></Cads>\n"
        "</Project>\n",
    )


def test_uvproj(root: Path) -> None:
    print("== 3. Keil 工程同步 ==")
    app = root / "app"
    make_uvprojx(app / "one.uvprojx")
    make_uvprojx(app / "two.uvprojx")
    dot_config = app / ".config"
    write(dot_config, "CONFIG_LOG=y\nCONFIG_SEGGER_RTT=y\nCONFIG_TIMING=y\n")

    changed, files = sync_uvprojx_project(
        str(app),
        str(dot_config),
        repo_root=str(root),
        log=lambda _message: None,
    )
    check("默认同步全部 uvprojx", changed and len(files) == 2, str(files))
    one = (app / "one.uvprojx").read_text(encoding="utf-8")
    check("加入 log.c", "log.c" in one, one[:500])
    check("加入 rtt.c", "rtt.c" in one, one[:500])

    # 过滤：只同步一个文件
    make_uvprojx(app / "one.uvprojx")
    make_uvprojx(app / "two.uvprojx")
    changed, files = sync_uvprojx_project(
        str(app),
        str(dot_config),
        uvprojx_paths=[str(app / "one.uvprojx")],
        repo_root=str(root),
        log=lambda _message: None,
    )
    check("--uvprojx 只同步指定文件", changed and len(files) == 1, str(files))
    check(
        "未指定的文件不变",
        "log.c" not in (app / "two.uvprojx").read_text(encoding="utf-8"),
    )

    # FS_FATFS 是当前框架的符号；旧的 CONFIG_FATFS 不应再命中
    make_uvprojx(app / "one.uvprojx")
    write(dot_config, "CONFIG_FS_FATFS=y\n")
    changed, _ = sync_uvprojx_project(
        str(app),
        str(dot_config),
        uvprojx_paths=[str(app / "one.uvprojx")],
        repo_root=str(root),
        log=lambda _message: None,
    )
    one = (app / "one.uvprojx").read_text(encoding="utf-8")
    check("FS_FATFS 规则加入 fatfs_arch.c", changed and "fatfs_arch.c" in one, one[:500])

    make_uvprojx(app / "one.uvprojx")
    write(dot_config, "CONFIG_FATFS=y\n")
    changed, _ = sync_uvprojx_project(
        str(app),
        str(dot_config),
        uvprojx_paths=[str(app / "one.uvprojx")],
        repo_root=str(root),
        log=lambda _message: None,
    )
    one = (app / "one.uvprojx").read_text(encoding="utf-8")
    check("旧 CONFIG_FATFS 不命中", not changed and "fatfs_arch.c" not in one, one[:500])

    # 预置 log.c，随后 config 生成的 .config 不含 LOG，sync 会删掉它 -> 应返回 2
    make_uvprojx(app / "one.uvprojx")
    write(dot_config, "CONFIG_LOG=y\n")
    sync_uvprojx_project(
        str(app),
        str(dot_config),
        uvprojx_paths=[str(app / "one.uvprojx")],
        repo_root=str(root),
        log=lambda _message: None,
    )

    # config --sync-keil --stop-on-change：配置把规则关掉后，工程文件应变化并返回 2
    code, out, _ = run_cli(
        [
            "config", "generate",
            "--project-dir", str(app),
            "-b", "board1",
            "--sync-keil",
            "--stop-on-change",
            "--json",
        ]
    )
    data = json.loads(out)
    check(
        "--stop-on-change 返回 2",
        code == 2 and data["exit_code"] == 2 and data["uvprojx_changed"] is True,
        out[:300],
    )


def run_cli(argv: list[str]) -> tuple[int, str, str]:
    parser = build_parser()
    args = parser.parse_args(argv)
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = args.func(args)
    return code, out.getvalue(), err.getvalue()


def test_removed_names() -> None:
    print("== 4b. 旧命令/旧参数已移除 ==")
    import contextlib as _ctx
    import io as _io

    def parse_or_exit(argv):
        parser = build_parser()
        with _ctx.redirect_stderr(_io.StringIO()), _ctx.redirect_stdout(_io.StringIO()):
            try:
                parser.parse_args(argv)
            except SystemExit as exc:
                return exc.code
        return 0

    check("omni project 已移除（exit 2）", parse_or_exit(["project"]) == 2)
    check("config 不再接受 --target（exit 2）", parse_or_exit(["config", "--target", "board1"]) == 2)

def test_menuconfig_cleanup(root: Path) -> None:
    print("== 4. menuconfig 临时文件清理 ==")
    from omni_cli.config import menuconfig as menuconfig_mod

    app = root / "app"
    original = menuconfig_mod._find_menuconfig

    def fail():
        raise ProjectError("menuconfig not found", code=1)

    menuconfig_mod._find_menuconfig = fail
    try:
        try:
            menuconfig_mod.run_menuconfig(
                project_dir=str(app),
                omni_root=str(root / "omni"),
                target="board1",
                log=lambda _message: None,
            )
        except ProjectError:
            pass
    finally:
        menuconfig_mod._find_menuconfig = original

    leftovers = list((root / "omni").glob("omni-app-*.Kconfig"))
    check("查找 menuconfig 失败时不残留临时 Kconfig", not leftovers, str(leftovers))


def test_cli(root: Path) -> None:
    print("== 5. CLI 集成 ==")
    app = root / "app"
    code, out, err = run_cli(
        [
            "config", "generate",
            "--project-dir", str(app),
            "-b", "board1",
            "--no-bsp",
            "--json",
        ]
    )
    data = json.loads(out)
    check("config --json 成功", code == 0 and data["success"] is True, out[:300])
    check("JSON 含 board", data.get("board") == "board1", str(data))
    check("--json stdout 无日志污染", out.lstrip().startswith("{"), out[:100])

    code, out, _ = run_cli(
        ["config", "bsp", "--project-dir", str(app), "-b", "board1", "--json"]
    )
    data = json.loads(out)
    check("bsp --json 成功", code == 0 and data["success"] is True, out[:300])
    check("bsp 生成路径存在", os.path.exists(data["bsp_config"]), data.get("bsp_config", ""))

    code, out, _ = run_cli(
        ["config", "generate", "--project-dir", str(app), "--json"]
    )
    data = json.loads(out)
    check("多目标 JSON 错误码 2", code == 2 and data["exit_code"] == 2, out[:300])
    check("多目标错误信息含候选", "board1" in data["error"] and "board2" in data["error"], str(data))


def test_bsp_no_omni(root: Path) -> None:
    print("== 6. bsp 不依赖 omni 根目录 ==")
    app = root / "app"
    path = run_bspgen(str(app), "board1", log=lambda _message: None)
    check("只凭工程目录即可生成", os.path.exists(path), path)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="omni-project-test-") as tmp:
        root = Path(tmp)
        app = make_tree(root)
        test_context(root)
        test_generate(root)
        test_uvproj(root)
        test_removed_names()
        test_menuconfig_cleanup(root)
        test_cli(root)
        test_bsp_no_omni(root)

    print()
    if failures:
        print(f"FAILED ({len(failures)}): " + ", ".join(failures))
        return 1
    print("ALL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
