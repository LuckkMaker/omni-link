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
import xml.etree.ElementTree as ET
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


def make_omni_cmakelists(root: Path) -> None:
    """造出 ``omni/**/CMakeLists.txt``——Keil 同步现在从这些文件解析源文件规则。"""

    modules = {
        "subsys/log": [
            "omni_sources_ifdef(omni_subsys CONFIG_LOG log.c)",
            "omni_sources_ifdef(omni_subsys CONFIG_LOG_BACKEND_RTT log_backend_rtt.c)",
        ],
        "subsys/rtt": [
            "# 注释行不应被解析",
            "omni_sources_ifdef(omni_subsys CONFIG_SEGGER_RTT rtt.c)",
        ],
        "subsys/timing": ["omni_sources_ifdef(omni_subsys CONFIG_TIMING timing.c)"],
        "subsys/fs": [
            "omni_sources_ifdef(omni_subsys CONFIG_FILE_SYSTEM fs.c)",
            "omni_sources_ifdef(omni_subsys CONFIG_FS_FATFS fatfs_arch.c)",
            "omni_sources_ifdef(omni_subsys CONFIG_FS_LITTLEFS littlefs_arch.c)",
        ],
    }
    for rel_dir, lines in modules.items():
        directory = root / "omni" / rel_dir
        write(directory / "CMakeLists.txt", "\n".join(lines) + "\n")
        for line in lines:
            if "omni_sources_ifdef" not in line:
                continue
            for name in line.split()[2:]:
                write(directory / name.rstrip(")"), "/* stub */\n")


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
    make_omni_cmakelists(root)
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

    # 预置 log.c；.config 里「没有」这个符号时不能拿它当「关掉」
    make_uvprojx(app / "one.uvprojx")
    write(dot_config, "CONFIG_LOG=y\n")
    sync_uvprojx_project(
        str(app),
        str(dot_config),
        uvprojx_paths=[str(app / "one.uvprojx")],
        repo_root=str(root),
        log=lambda _message: None,
    )
    check("预置 log.c", "log.c" in (app / "one.uvprojx").read_text(encoding="utf-8"))

    write(dot_config, "CONFIG_SEGGER_RTT=y\n")
    sync_uvprojx_project(
        str(app),
        str(dot_config),
        uvprojx_paths=[str(app / "one.uvprojx")],
        repo_root=str(root),
        log=lambda _message: None,
    )
    one = (app / "one.uvprojx").read_text(encoding="utf-8")
    check(".config 里缺符号时不删文件", "log.c" in one, one[:400])

    # 明确写 “# CONFIG_LOG is not set” 才删
    write(dot_config, "# CONFIG_LOG is not set\nCONFIG_SEGGER_RTT=y\n")
    changed, _ = sync_uvprojx_project(
        str(app),
        str(dot_config),
        uvprojx_paths=[str(app / "one.uvprojx")],
        repo_root=str(root),
        log=lambda _message: None,
    )
    check(
        "明确关闭才删文件",
        changed and "log.c" not in (app / "one.uvprojx").read_text(encoding="utf-8"),
        (app / "one.uvprojx").read_text(encoding="utf-8")[:400],
    )

    # config sync-keil --stop-on-change：配置把规则关掉后，工程文件应变化并返回 2
    write(dot_config, "CONFIG_LOG=y\n")
    sync_uvprojx_project(
        str(app),
        str(dot_config),
        uvprojx_paths=[str(app / "one.uvprojx")],
        repo_root=str(root),
        log=lambda _message: None,
    )
    write(dot_config, "# CONFIG_LOG is not set\n")
    code, out, _ = run_cli(
        [
            "config", "sync-keil",
            "--project-dir", str(app),
            "-b", "board1",
            "--stop-on-change",
            "--json",
        ]
    )
    data = json.loads(out)
    check(
        "--stop-on-change 返回 2",
        code == 2 and data["exit_code"] == 2 and data["changed"] is True,
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


def test_cmake_sources(root: Path) -> None:
    print("== 3b. CMakeLists 规则解析 ==")
    from omni_cli.config.cmake_sources import load_rule_sets, parse_cmakelists
    from omni_cli.context import ProjectError

    repo = root / "cmake-repo"
    (repo / "omni" / "subsys" / "demo").mkdir(parents=True, exist_ok=True)
    for name in ("a.c", "b.c", "multi.c"):
        write(repo / "omni" / "subsys" / "demo" / name, "/* stub */\n")

    cmake = repo / "omni" / "subsys" / "demo" / "CMakeLists.txt"
    write(
        cmake,
        "# 注释里的 omni_sources_ifdef(omni_subsys CONFIG_FAKE fake.c) 不应被解析\n"
        "omni_sources_ifdef(omni_subsys CONFIG_DEMO a.c)\n"
        "omni_sources_ifdef(omni_subsys CONFIG_DEMO\n"
        "    b.c\n"
        "    multi.c)\n",
    )

    rules = parse_cmakelists(str(cmake), str(repo))
    merged = {rule["symbol"]: rule for rule in rules}
    check("跨行声明被合并", list(merged["CONFIG_DEMO"]["files"]) == ["a.c", "b.c", "multi.c"], str(rules))
    check("注释被忽略", "CONFIG_FAKE" not in merged, str(list(merged)))
    check("group 由目录推导", merged["CONFIG_DEMO"]["group"] == "omni/subsys", str(rules))

    from omni_cli.config.cmake_sources import group_for_path

    check("omni/drivers 目录映射", group_for_path("omni/drivers/disk") == "omni/driver")
    check("omni/arch 目录映射", group_for_path("omni/arch/arm/core/cortex_m/src") == "omni/arch/arm")
    check("modules 目录映射", group_for_path("modules/coremark") == "module/coremark")

    # 变量参数必须报错，而不是猜
    write(cmake, "omni_sources_ifdef(omni_subsys CONFIG_DEMO ${SOME_LIST})\n")
    try:
        parse_cmakelists(str(cmake), str(repo))
    except ProjectError as exc:
        check("变量参数报错", "变量" in str(exc), str(exc))
    else:
        check("变量参数报错", False)

    # 声明了不存在的文件也必须报错
    write(cmake, "omni_sources_ifdef(omni_subsys CONFIG_DEMO missing.c)\n")
    try:
        parse_cmakelists(str(cmake), str(repo))
    except ProjectError as exc:
        check("缺失文件报错", "不存在" in str(exc), str(exc))
    else:
        check("缺失文件报错", False)

    write(cmake, "omni_sources_ifdef(omni_subsys CONFIG_DEMO a.c)\n")

    # --rules table 退回手写规则表
    table_rules = load_rule_sets(str(repo), mode="table", log=lambda _m: None)
    check("table 模式返回手写规则表", len(table_rules) > 10, str(len(table_rules)))
    auto_rules = load_rule_sets(str(repo), mode="auto", log=lambda _m: None)
    check("auto 模式解析 CMakeLists", any(r["symbol"] == "CONFIG_DEMO" for r in auto_rules), str(auto_rules))

    # 解析器看不到的目录必须留在手写表里，否则 auto 模式会静默丢规则
    from omni_cli.config.uvproj_rules import EXTRA_RULE_SETS

    extra_symbols = {rule["symbol"] for rule in EXTRA_RULE_SETS}
    check("CONFIG_IAP 留在手写表", "CONFIG_IAP" in extra_symbols, str(sorted(extra_symbols)))
    check(
        "modules 规则不再手写",
        not any(r["base_path"].startswith("modules/") for r in EXTRA_RULE_SETS),
        str(sorted(extra_symbols)),
    )
    auto_symbols = {r["symbol"] for r in auto_rules}
    check("auto 模式保留 CONFIG_IAP", "CONFIG_IAP" in auto_symbols, str(sorted(auto_symbols)))


def make_layer_repo(root: Path) -> Path:
    """造一个带 layer 的模块仓库：modules/demo 与 modules/hal_demo。"""

    repo = root / "layer-repo"
    demo = repo / "modules" / "demo"
    write(
        demo / "omni" / "module.yml",
        "name: demo\nbuild:\n  cmake: .\nenable: DEMO\nsettings:\n  layer: demo.clayer.yml\n",
    )
    for rel in ("src/a.c", "src/core/b.c", "src/core/ipv4/c.c", "tool.py"):
        write(demo / rel, "/* stub */\n")
    write(
        demo / "demo.clayer.yml",
        "layer:\n"
        "  type: Demo\n"
        "  add-path:\n"
        "    - ./src/include\n"
        "  groups:\n"
        "    - group: demo/core\n"
        "      files:\n"
        "        - file: ./src/core/b.c\n"
        "    - group: demo\n"
        "      files:\n"
        "        - file: ./src/a.c\n"
        "        - file: ./tool.py\n",
    )

    # Device 层（SoC/HAL）不进同步范围
    hal = repo / "modules" / "hal_demo"
    write(
        hal / "omni" / "module.yml",
        "name: hal_demo\nbuild:\n  cmake: .\nenable: SOC_FAMILY_DEMO\n"
        "settings:\n  layer: device.clayer.yml\n",
    )
    write(hal / "driver.c", "/* stub */\n")
    write(
        hal / "device.clayer.yml",
        "layer:\n  type: Device\n  add-path:\n    - ./inc\n"
        "  groups:\n    - group: device/driver\n      files:\n        - file: ./driver.c\n",
    )
    return repo


def test_module_sources(root: Path) -> None:
    print("== 3c. 模块 layer 规则解析 ==")
    from omni_cli.config.cmake_sources import load_rule_sets
    from omni_cli.config.module_sources import (
        group_for_layer,
        load_module_rule_sets,
        parse_layer,
    )

    repo = make_layer_repo(root)
    rules = load_module_rule_sets(str(repo))
    by_group = {rule["group"]: rule for rule in rules}

    check("layer 组名补 module/ 前缀", "module/demo/core" in by_group, str(sorted(by_group)))
    check(
        "symbol 来自 module.yml 的 enable",
        all(rule["symbol"] == "CONFIG_DEMO" for rule in rules),
        str(sorted({rule["symbol"] for rule in rules})),
    )
    check(
        "同组文件按 layer 顺序、相对模块根",
        by_group["module/demo"]["files"] == ["src/a.c"],
        str(by_group.get("module/demo")),
    )
    check(
        "add-path 转成 include 路径",
        by_group["module/demo"]["include_paths"] == ["modules/demo/src/include"],
        str(by_group["module/demo"]["include_paths"]),
    )
    check("Device 层被跳过", "CONFIG_SOC_FAMILY_DEMO" not in {r["symbol"] for r in rules}, str(rules))
    check("已带前缀的组名不重复加", group_for_layer("device/driver") == "device/driver")
    check("普通组名加 module/ 前缀", group_for_layer("lwip/core") == "module/lwip/core")

    merged = {
        (rule["group"], rule["symbol"]): rule
        for rule in load_rule_sets(str(repo), mode="auto", log=lambda _m: None)
    }
    check("auto 模式合并 layer 规则", ("module/demo/core", "CONFIG_DEMO") in merged, str(sorted(merged)))

    # 声明了不存在的文件必须报错
    write(repo / "modules" / "demo" / "demo.clayer.yml", "layer:\n  type: Demo\n  groups:\n    - group: demo\n      files:\n        - file: ./missing.c\n")
    try:
        load_module_rule_sets(str(repo))
    except ProjectError as exc:
        check("layer 缺失文件报错", "不存在" in str(exc), str(exc))
    else:
        check("layer 缺失文件报错", False)

    # 中间层没有 layer 段也要报错，而不是静默跳过
    write(repo / "modules" / "demo" / "demo.clayer.yml", "layer: []\n")
    try:
        parse_layer(
            str(repo / "modules" / "demo" / "demo.clayer.yml"),
            str(repo),
            "modules/demo",
            "CONFIG_DEMO",
        )
    except ProjectError as exc:
        check("layer 段非法报错", "layer" in str(exc), str(exc))
    else:
        check("layer 段非法报错", False)


def test_uvproj_dedupe(root: Path) -> None:
    print("== 3d. 同一个文件不重复编译 ==")
    from omni_cli.config.module_sources import load_module_rule_sets
    from omni_cli.config.uvproj_sync import sync_sources_for_uvprojx

    repo = make_layer_repo(root)
    app = repo / "app"
    app.mkdir(parents=True, exist_ok=True)
    uvprojx = app / "p.uvprojx"
    # 历史工程把文件放在别的组名下（modules/demo），同步不应再加一份
    write(
        uvprojx,
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
        "<Project>\n"
        "  <Groups>\n"
        "    <Group><GroupName>modules/demo</GroupName><Files>\n"
        "      <File><FileName>a.c</FileName><FileType>1</FileType>"
        "<FilePath>..\\modules\\demo\\src\\a.c</FilePath></File>\n"
        "    </Files></Group>\n"
        "  </Groups>\n"
        "  <Cads><VariousControls><IncludePath></IncludePath><Define></Define></VariousControls></Cads>\n"
        "</Project>\n",
    )
    changed = sync_sources_for_uvprojx(
        str(uvprojx),
        {"CONFIG_DEMO": "y"},
        str(repo),
        rule_sets=load_module_rule_sets(str(repo)),
        log=lambda _message: None,
    )
    text = uvprojx.read_text(encoding="utf-8")
    check("已存在的文件不重复加入", text.count("modules\\demo\\src\\a.c") == 1, text)
    check("缺失的文件仍然加入", "b.c" in text, text)
    check("有内容变化才写盘", changed, text)
    check("没有多余的空组", "module/demo</GroupName>" not in text, text)


def make_project_repo(root: Path) -> Path:
    """造一个带工程 CMakeLists.txt + board.cmake 的最小工程。"""

    repo = root / "proj-repo"
    app = repo / "app"
    write(
        app / "CMakeLists.txt",
        "cmake_minimum_required(VERSION 3.24)\n"
        "project(demo LANGUAGES C)\n"
        "omni_include_directories(app src)\n"
        "target_sources(app PRIVATE\n"
        "    src/app.c\n"
        "    src/extra.c\n"
        ")\n",
    )
    for rel in ("src/app.c", "src/extra.c"):
        write(app / rel, "/* stub */\n")

    board = app / "boards" / "b1"
    write(
        board / "board.cmake",
        "# CMake board\n"
        "omni_board_sources(\n"
        "    bsp.c\n"
        "    startup/system_stm32f4xx.c\n"
        "    STM32CubeMX/Core/Src/main.c\n"
        ")\n"
        "omni_board_startup(startup/startup_stm32f4xx.s)\n"
        "omni_board_linker(startup/flash.sct)\n"
        "omni_board_include_directories(config)\n",
    )
    for rel in (
        "bsp.c",
        "startup/system_stm32f4xx.c",
        "startup/startup_stm32f4xx.s",
        "STM32CubeMX/Core/Src/main.c",
    ):
        write(board / rel, "/* stub */\n")
    return app


def test_project_sources(root: Path) -> None:
    print("== 3e. 工程 CMakeLists / board.cmake 规则 ==")
    from omni_cli.config.project_sources import (
        discover_board,
        load_project_rule_sets,
        parse_board_cmake,
        parse_project_cmakelists,
    )
    from omni_cli.config.uvproj_sync import sync_sources_for_uvprojx

    app = make_project_repo(root)
    repo = app.parent

    check(
        "target_sources(app) 被解析",
        parse_project_cmakelists(str(app / "CMakeLists.txt")) == ["src/app.c", "src/extra.c"],
        str(parse_project_cmakelists(str(app / "CMakeLists.txt"))),
    )
    board_entries = parse_board_cmake(str(app / "boards" / "b1" / "board.cmake"))
    check(
        "board.cmake 只认源文件宏",
        sorted(name for name, _hint in board_entries)
        == ["STM32CubeMX/Core/Src/main.c", "bsp.c", "startup/startup_stm32f4xx.s", "startup/system_stm32f4xx.c"],
        str(board_entries),
    )
    check("单板目录自动推断", discover_board(str(app)) == "b1", str(discover_board(str(app))))

    rules = load_project_rule_sets(str(app), str(repo), board="b1")
    by_group = {rule["group"]: rule for rule in rules}
    check("工程文件进 application", by_group["application"]["files"] == ["bsp.c"], str(by_group.get("application")))
    check("startup 目录分组", "startup" in by_group and "stm32cubemx" in by_group, str(sorted(by_group)))
    check("工程规则无条件启用", all(rule["symbol"] is None for rule in rules), str(rules))
    check(
        "汇编文件 FileType=2",
        any(rule["file_type"] == "2" for rule in rules if rule["group"] == "startup"),
        str(rules),
    )

    # 端到端：已有的 .\src\app.c 不重复加，新增的带 .\ 前缀
    uvprojx = app / "p.uvprojx"
    write(
        uvprojx,
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
        "<Project>\n"
        "  <Groups>\n"
        "    <Group><GroupName>application</GroupName><Files>\n"
        "      <File><FileName>app.c</FileName><FileType>1</FileType>"
        "<FilePath>.\\src\\app.c</FilePath></File>\n"
        "    </Files></Group>\n"
        "    <Group><GroupName>startup</GroupName><Files></Files></Group>\n"
        "  </Groups>\n"
        "  <Cads><VariousControls><IncludePath></IncludePath><Define></Define></VariousControls></Cads>\n"
        "</Project>\n",
    )
    changed = sync_sources_for_uvprojx(
        str(uvprojx), {}, str(repo), rule_sets=rules, log=lambda _message: None
    )
    text = uvprojx.read_text(encoding="utf-8")
    check("已有工程文件不重复", text.count(".\\src\\app.c") == 1, text)
    check("新增工程文件带 .\\ 前缀", ".\\src\\extra.c" in text, text)
    check("板级文件按组加入", "stm32cubemx" in text and "startup_stm32f4xx.s" in text, text)
    check("工程规则触发写盘", changed, text)

    files = [
        (f.find("FileName").text, f.find("FileType").text)
        for f in ET.fromstring(text).iter("File")
    ]
    check("startup 汇编标记为 FileType 2", ("startup_stm32f4xx.s", "2") in files, str(files))

    # 变量参数必须报错
    write(app / "CMakeLists.txt", "target_sources(app PRIVATE ${APP_SRC})\n")
    try:
        load_project_rule_sets(str(app), str(repo), board="b1")
    except ProjectError as exc:
        check("工程变量参数报错", "变量参数" in str(exc), str(exc))
    else:
        check("工程变量参数报错", False)


def test_multi_board_sync(root: Path) -> None:
    print("== 3f. 多板工程按 uvprojx 分板同步 ==")
    from omni_cli.config.project_sources import detect_board_from_uvprojx
    from omni_cli.config.uvproj_sync import sync_uvprojx_project

    repo = root / "multi-repo"
    app = repo / "app"
    write(app / "CMakeLists.txt", "target_sources(app PRIVATE src/app.c)\n")
    write(app / "src" / "app.c", "/* stub */\n")
    for board in ("b1", "b2"):
        write(
            app / "boards" / board / "board.cmake",
            f"omni_board_sources(\n    bsp_{board}.c\n)\n"
            f"omni_board_startup(startup/startup_{board}.s)\n",
        )
        write(app / "boards" / board / f"bsp_{board}.c", "/* stub */\n")
        write(app / "boards" / board / "startup" / f"startup_{board}.s", "; stub\n")

    def make_uvprojx(path: Path, board: str) -> None:
        write(
            path,
            '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
            "<Project>\n"
            "  <Groups>\n"
            f"    <Group><GroupName>{board}</GroupName><Files>\n"
            "      <File><FileName>app.c</FileName><FileType>1</FileType>"
            "<FilePath>.\\src\\app.c</FilePath></File>\n"
            f"      <File><FileName>bsp_{board}.c</FileName><FileType>1</FileType>"
            f"<FilePath>.\\boards\\{board}\\bsp_{board}.c</FilePath></File>\n"
            "    </Files></Group>\n"
            "  </Groups>\n"
            "  <Cads><VariousControls><IncludePath></IncludePath><Define></Define></VariousControls></Cads>\n"
            "</Project>\n",
        )

    one, two = app / "one.uvprojx", app / "two.uvprojx"
    make_uvprojx(one, "b1")
    make_uvprojx(two, "b2")
    check("按工程内路径认出板", detect_board_from_uvprojx(str(one)) == "b1", str(detect_board_from_uvprojx(str(one))))

    write(app / ".config", "CONFIG_X=y\n")
    # 显式给 b1 也不能把 b1 的文件塞进 b2 的工程
    sync_uvprojx_project(
        str(app),
        str(app / ".config"),
        repo_root=str(repo),
        board="b1",
        log=lambda _message: None,
    )
    text_one = one.read_text(encoding="utf-8")
    text_two = two.read_text(encoding="utf-8")
    check("b1 工程加 b1 的启动文件", "startup_b1.s" in text_one, text_one)
    check("b1 工程没有 b2 的文件", "boards\\b2" not in text_one, text_one)
    check("b2 工程加 b2 的启动文件", "startup_b2.s" in text_two, text_two)
    check("b2 工程没有 b1 的文件", "boards\\b1" not in text_two, text_two)

    # 已经混进来的其它板文件要被清掉
    poisoned = app / "three.uvprojx"
    make_uvprojx(poisoned, "b2")
    text = poisoned.read_text(encoding="utf-8").replace(
        "</Files></Group>",
        '<File><FileName>bsp_b1.c</FileName><FileType>1</FileType>'
        "<FilePath>.\\boards\\b1\\bsp_b1.c</FilePath></File></Files></Group>",
    )
    poisoned.write_text(text, encoding="utf-8")
    check("预置混入 b1 文件", "boards\\b1" in text)
    sync_uvprojx_project(
        str(app),
        str(app / ".config"),
        repo_root=str(repo),
        uvprojx_paths=[str(poisoned)],
        log=lambda _message: None,
    )
    text = poisoned.read_text(encoding="utf-8")
    check("同步清掉其它板的文件", "boards\\b1" not in text, text)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="omni-project-test-") as tmp:
        root = Path(tmp)
        app = make_tree(root)
        test_context(root)
        test_generate(root)
        test_uvproj(root)
        test_cmake_sources(root)
        test_module_sources(root)
        test_project_sources(root)
        test_multi_board_sync(root)
        test_uvproj_dedupe(root)
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
