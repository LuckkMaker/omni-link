"""`omni boards` 离线回归测试（不需要硬件/后端）。

用法::

    cd python
    python test_boards_cli.py
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
from omni_cli.context import ProjectError
from omni_cli.boards.model import (
    hal_config_template,
    iter_boards,
    load_board,
    missing_upstream,
    upstream_files,
)
from omni_cli.boards.scaffold import check_project, sync_project

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(name)
        print(f"FAIL {name} {detail}")


BOARD_YML = """\
board:
  name: {name}
  full_name: Test {name}
  vendor: omni
  revision: "1.0"
  socs:
    - name: {soc}
      variants:
        - name: default
  omni:
    device: {device}
    hal: stm32
    series: stm32f4xx
    device_define: STM32F407xx
    cpu: cortex-m4
    fpu: fpv4-sp-d16
    startup: {startup}
    scatter: {scatter}
"""


def make_repo(root: Path, *, with_scatter: bool = True, name: str = "testmcu") -> dict:
    omni = root / "omni"
    (omni / "boards" / name).mkdir(parents=True)
    (omni / "Kconfig").write_text("mainmenu \"t\"\n", encoding="utf-8")
    (omni / "Kconfig.omni").write_text("", encoding="utf-8")
    (omni / "boards" / name / "board.yml").write_text(
        BOARD_YML.format(
            name=name,
            soc="stm32f407xg",
            device="STM32F407IGTx",
            startup="startup_stm32f407xx.s",
            scatter="stm32f407xg_flash.sct",
        ),
        encoding="utf-8",
    )

    src = root / "modules" / "hal_stm32" / "stm32cube" / "stm32f4xx" / "device" / "src"
    (src / "arm").mkdir(parents=True)
    (src / "arm" / "startup_stm32f407xx.s").write_text("; startup\n", encoding="utf-8")
    (src / "system_stm32f4xx.c").write_text("/* system */\n", encoding="utf-8")
    if with_scatter:
        (src / "arm" / "stm32f407xg_flash.sct").write_text("; sct\n", encoding="utf-8")

    include = root / "modules" / "hal_stm32" / "stm32cube" / "stm32f4xx" / "drivers" / "include"
    include.mkdir(parents=True)
    (include / "stm32f4xx_hal_conf_template.h").write_text("/* conf */\n", encoding="utf-8")

    project = root / "proj"
    (project / "boards").mkdir(parents=True)
    (project / "prj.conf").write_text("CONFIG_SOC_STM32F407XG=y\n", encoding="utf-8")
    (project / "Kconfig").write_text("mainmenu \"t\"\n", encoding="utf-8")
    return {"omni": str(omni), "project": str(project), "name": name}


def test_parser() -> None:
    parser = build_parser()
    args = parser.parse_args(["boards", "list"])
    check("parser.list", args.boards_sub == "list")
    args = parser.parse_args(["boards", "show", "stm32f407ig"])
    check("parser.show", args.board == "stm32f407ig")
    args = parser.parse_args(["boards", "check", "-b", "stm32f407ig"])
    check("parser.check", args.board == "stm32f407ig")
    args = parser.parse_args(["boards", "sync", "-b", "x", "--force", "--dry-run"])
    check("parser.sync", args.force and args.dry_run)


def test_name_mismatch() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        omni = root / "omni"
        (omni / "boards" / "foo").mkdir(parents=True)
        (omni / "boards" / "foo" / "board.yml").write_text(
            BOARD_YML.format(
                name="bar",
                soc="stm32f407xg",
                device="STM32F407IGTx",
                startup="startup_stm32f407xx.s",
                scatter="stm32f407xg_flash.sct",
            ),
            encoding="utf-8",
        )
        try:
            load_board(str(omni), "foo")
        except ProjectError as exc:
            check("name_mismatch", "不一致" in str(exc))
        else:
            check("name_mismatch", False, "没有报错")


def test_scaffold_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        fixture = make_repo(Path(tmp))
        spec = load_board(fixture["omni"], fixture["name"])

        files = upstream_files(spec)
        check("upstream.count", len(files) == 3, f"got {len(files)}")
        check("upstream.missing", missing_upstream(spec) == [])

        template = hal_config_template(spec)
        check("hal_conf.template", template is not None)
        if template:
            check("hal_conf.name", template[1] == "stm32f4xx_hal_conf.h", template[1])

        result = sync_project(spec, fixture["project"])
        check("sync.created", len(result["created"]) == 7, str(len(result["created"])))
        check(
            "sync.clayer",
            os.path.isfile(os.path.join(fixture["project"], "boards", fixture["name"], "board.clayer.yml")),
        )
        check(
            "sync.bsp",
            os.path.isfile(os.path.join(fixture["project"], "boards", fixture["name"], "bsp.c")),
        )

        state = check_project(spec, fixture["project"])
        check("check.identical", state["modified"] == [] and state["missing"] == [],
              f"{state['modified']} / {state['missing']}")
        check("check.required", state["missing_required"] == [], str(state["missing_required"]))

        # 工程修改后 check 能识别，sync 默认不覆盖。
        target = os.path.join(fixture["project"], "boards", fixture["name"], "startup",
                              "startup_stm32f407xx.s")
        Path(target).write_text("; modified\n", encoding="utf-8")
        state = check_project(spec, fixture["project"])
        check("check.modified", state["modified"] == ["startup_stm32f407xx.s"], str(state["modified"]))

        again = sync_project(spec, fixture["project"])
        check("sync.idempotent", again["created"] == [] and len(again["skipped"]) == 7)

        forced = sync_project(spec, fixture["project"], force=True)
        check("sync.force", len(forced["updated"]) == 7, str(len(forced["updated"])))
        state = check_project(spec, fixture["project"])
        check("sync.force.verified", state["modified"] == [])

        # dry-run 不写文件。
        target_path = Path(target)
        target_path.write_text("; modified again\n", encoding="utf-8")
        before = target_path.read_text(encoding="utf-8")
        dry = sync_project(spec, fixture["project"], force=True, dry_run=True)
        check("sync.dry_run.report", len(dry["updated"]) == 7, str(len(dry["updated"])))
        check("sync.dry_run.no_write", target_path.read_text(encoding="utf-8") == before)


def test_missing_scatter_warns() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        fixture = make_repo(Path(tmp), with_scatter=False)
        spec = load_board(fixture["omni"], fixture["name"])
        check("missing_scatter.detected", missing_upstream(spec) == ["stm32f407xg_flash.sct"])
        result = sync_project(spec, fixture["project"])
        check("missing_scatter.warned", len(result["warnings"]) == 1, str(result["warnings"]))


def test_repo_boards() -> None:
    """真实仓库里应有 6 块板（找不到工作区时跳过）。"""

    candidates = []
    env = os.environ.get("OMNI_WORKSPACE_DIR")
    if env:
        candidates.append(Path(env))
    repo_root = Path(__file__).resolve().parents[1]
    candidates.append(repo_root.parent / "omni-emb")
    for candidate in candidates:
        omni = candidate / "omni"
        if (omni / "boards").is_dir():
            names = sorted(spec.name for spec in iter_boards(str(omni)))
            expected = sorted(
                [
                    "g32f463rc",
                    "stm32f103cb",
                    "stm32f407ig",
                    "stm32f407ig_vendor",
                    "stm32g474re",
                    "stm32h743ii",
                ]
            )
            check("repo.boards", names == expected, str(names))
            return
    print("skip repo boards (workspace layout not found)")


def main() -> int:
    test_parser()
    test_name_mismatch()
    test_scaffold_roundtrip()
    test_missing_scatter_warns()
    test_repo_boards()
    if failures:
        print(f"{len(failures)} failure(s): {', '.join(failures)}")
        return 1
    print("all boards tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
