"""`omni modules` 离线回归测试（不需要硬件/后端）。

用法::

    cd python
    python test_modules_cli.py
"""

from __future__ import annotations

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
from omni_cli.modules.model import iter_modules, load_module, module_issues
from omni_cli.modules.registry import generate, render_cmake, render_kconfig

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(name)
        print(f"FAIL {name} {detail}")


MODULE_YML = """\
name: {name}
build:
  cmake: {cmake}
{kconfig}enable: {enable}
"""


def make_repo(root: Path) -> dict:
    omni = root / "omni"
    (omni / "modules").mkdir(parents=True)
    (omni / "Kconfig").write_text('mainmenu "t"\n', encoding="utf-8")
    (omni / "Kconfig.omni").write_text('source "Kconfig.modules"\n', encoding="utf-8")

    # 模块仓库自带 glue，且提供 Kconfig。
    mod_a = root / "modules" / "mod_a"
    (mod_a / "omni").mkdir(parents=True)
    (mod_a / "src").mkdir()
    (mod_a / "omni" / "module.yml").write_text(
        MODULE_YML.format(name="mod_a", cmake=".", kconfig="  kconfig: Kconfig\n", enable="MOD_A"),
        encoding="utf-8",
    )
    (mod_a / "omni" / "CMakeLists.txt").write_text("# mod_a\n", encoding="utf-8")
    (mod_a / "omni" / "Kconfig").write_text("config MOD_A\n    bool\n", encoding="utf-8")

    # 上游镜像：glue 在框架侧，指回 modules/mod_b。
    mod_b = root / "modules" / "mod_b"
    mod_b.mkdir(parents=True)
    (omni / "modules" / "mod_b").mkdir(parents=True)
    (omni / "modules" / "mod_b" / "module.yml").write_text(
        "name: mod_b\nmodule: ../../../modules/mod_b\n"
        "build:\n  cmake: .\n  kconfig: Kconfig\nenable: MOD_B\n",
        encoding="utf-8",
    )
    (omni / "modules" / "mod_b" / "CMakeLists.txt").write_text("# mod_b\n", encoding="utf-8")
    (omni / "modules" / "mod_b" / "Kconfig").write_text("config MOD_B\n    bool\n", encoding="utf-8")

    return {"repo": str(root), "omni": str(omni)}


def test_parser() -> None:
    parser = build_parser()
    args = parser.parse_args(["modules", "list"])
    check("parser.list", args.modules_sub == "list")
    args = parser.parse_args(["modules", "generate", "--check"])
    check("parser.generate", args.check)


def test_discovery() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        fixture = make_repo(Path(tmp))
        modules = iter_modules(fixture["repo"])
        names = [spec.name for spec in modules]
        check("discovery.names", names == ["mod_a", "mod_b"], str(names))

        mod_a = load_module(fixture["repo"], "mod_a")
        check("discovery.mod_a.location", mod_a.location == "module")
        check("discovery.mod_a.cmake", mod_a.cmake == "modules/mod_a/omni", str(mod_a.cmake))
        check("discovery.mod_a.kconfig", mod_a.kconfig == "modules/mod_a/omni/Kconfig")
        check("discovery.mod_a.issues", module_issues(fixture["repo"], mod_a) == [])

        mod_b = load_module(fixture["repo"], "mod_b")
        check("discovery.mod_b.location", mod_b.location == "framework")
        check("discovery.mod_b.module_dir", mod_b.module_dir == "modules/mod_b", mod_b.module_dir)
        check("discovery.mod_b.cmake", mod_b.cmake == "omni/modules/mod_b", str(mod_b.cmake))
        check("discovery.mod_b.issues", module_issues(fixture["repo"], mod_b) == [])


def test_broken_declaration() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        fixture = make_repo(Path(tmp))
        yml = Path(fixture["repo"]) / "modules" / "mod_a" / "omni" / "module.yml"
        yml.write_text(
            MODULE_YML.format(name="mod_a", cmake="nowhere", kconfig="", enable="MOD_A"),
            encoding="utf-8",
        )
        spec = load_module(fixture["repo"], "mod_a")
        issues = module_issues(fixture["repo"], spec)
        check("broken.cmake", any("build.cmake" in issue for issue in issues), str(issues))


def test_generate_and_check() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        fixture = make_repo(Path(tmp))
        result = generate(fixture["repo"], fixture["omni"])
        check("generate.written", sorted(result["written"]) == ["Kconfig.modules", os.path.join("cmake", "omni_modules.cmake")],
              str(result["written"]))

        cmake_text = (Path(fixture["omni"]) / "cmake" / "omni_modules.cmake").read_text(encoding="utf-8")
        check("generate.names", "set(OMNI_MODULE_NAMES" in cmake_text and "mod_a" in cmake_text)
        check("generate.enable", 'set(OMNI_MODULE_mod_a_ENABLE "MOD_A")' in cmake_text)
        check("generate.src", "${OMNI_WORKSPACE_DIR}/modules/mod_b" in cmake_text)

        kconfig_text = (Path(fixture["omni"]) / "Kconfig.modules").read_text(encoding="utf-8")
        check("generate.rsource.module", 'rsource "../modules/mod_a/omni/Kconfig"' in kconfig_text, kconfig_text)
        check("generate.rsource.framework", 'rsource "modules/mod_b/Kconfig"' in kconfig_text, kconfig_text)

        again = generate(fixture["repo"], fixture["omni"], check=True)
        check("generate.check.clean", again["drifted"] == [], str(again["drifted"]))

        # 声明变化后 --check 必须报告漂移。
        yml = Path(fixture["repo"]) / "modules" / "mod_a" / "omni" / "module.yml"
        yml.write_text(
            MODULE_YML.format(name="mod_a", cmake=".", kconfig="  kconfig: Kconfig\n", enable="MOD_A2"),
            encoding="utf-8",
        )
        drifted = generate(fixture["repo"], fixture["omni"], check=True)
        check("generate.check.drift", drifted["drifted"] != [], str(drifted))

        # 重新生成后回到干净状态。
        generate(fixture["repo"], fixture["omni"])
        clean = generate(fixture["repo"], fixture["omni"], check=True)
        check("generate.check.reclean", clean["drifted"] == [])


def test_render_deterministic() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        fixture = make_repo(Path(tmp))
        modules = iter_modules(fixture["repo"])
        first = render_cmake(fixture["repo"], modules)
        second = render_cmake(fixture["repo"], modules)
        check("render.cmake.stable", first == second)
        kconfig = render_kconfig(fixture["repo"], fixture["omni"], modules)
        check("render.kconfig.stable", kconfig == render_kconfig(fixture["repo"], fixture["omni"], modules))


def test_repo_modules() -> None:
    """真实仓库里应至少有 hal_stm32 / hal_geehy 两个模块（找不到工作区时跳过）。"""

    candidates = []
    env = os.environ.get("OMNI_WORKSPACE_DIR")
    if env:
        candidates.append(Path(env))
    candidates.append(Path(__file__).resolve().parents[1].parent / "omni-emb")
    for candidate in candidates:
        if (candidate / "omni" / "cmake").is_dir() and (candidate / "modules").is_dir():
            names = [spec.name for spec in iter_modules(str(candidate))]
            check("repo.modules", {"hal_stm32", "hal_geehy"} <= set(names), str(names))
            return
    print("skip repo modules (workspace layout not found)")


def main() -> int:
    test_parser()
    test_discovery()
    test_broken_declaration()
    test_generate_and_check()
    test_render_deterministic()
    test_repo_modules()
    if failures:
        print(f"{len(failures)} failure(s): {', '.join(failures)}")
        return 1
    print("all modules tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
