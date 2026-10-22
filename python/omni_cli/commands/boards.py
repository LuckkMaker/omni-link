"""板定义命令：boards [list|show|check|sync]。

本地执行，不经过 OMNI Link 后端。板事实来自 ``omni/boards/<board>/board.yml``；
``check`` / ``sync`` 只读或补文件，不移动工程现有内容，也不改 cbuild/Keil 路径。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .. import context
from ..boards import (
    BoardSpec,
    check_project,
    has_board,
    iter_boards,
    load_board,
    missing_upstream,
    sync_project,
    upstream_files,
)
from ..context import ProjectError
from ..options import config_parser, local_parser


def add_parser(sub):
    p = sub.add_parser(
        "boards",
        parents=[local_parser()],
        help="板定义（列出/查看/检查/同步工程板目录；本地执行）",
    )
    ps = p.add_subparsers(dest="boards_sub", metavar="<sub>")

    s = ps.add_parser("list", parents=[local_parser()],
                      help="列出 omni/boards 下的板")
    s.add_argument("--omni-root", default=None, metavar="PATH",
                   help="omni 框架根目录（默认从当前目录向上查找）")
    s.set_defaults(func=_run(_list))

    s = ps.add_parser("show", parents=[local_parser()],
                      help="显示单个板的定义与上游文件")
    s.add_argument("board", metavar="BOARD", help="板名（如 stm32f407ig）")
    s.add_argument("--omni-root", default=None, metavar="PATH",
                   help="omni 框架根目录（默认从当前目录向上查找）")
    s.set_defaults(func=_run(_show))

    s = ps.add_parser("check", parents=[config_parser()],
                      help="检查工程板目录与上游的差异（只读）")
    s.add_argument("--all", action="store_true", default=False,
                   help="扫描仓库内所有工程，汇总各板的漂移情况")
    s.set_defaults(func=_run(_check))

    s = ps.add_parser("sync", parents=[config_parser()],
                      help="为工程补齐缺失的板级文件（默认不覆盖已有文件）")
    s.add_argument("--force", action="store_true", default=False,
                   help="覆盖已存在的文件（谨慎使用）")
    s.add_argument("--dry-run", action="store_true", default=False,
                   help="只打印将执行的动作，不写文件")
    s.set_defaults(func=_run(_sync))

    # `omni boards`（不带子命令）= `omni boards list`
    p.set_defaults(func=_run(_list), boards_sub="list")


def _run(handler):
    def _wrapped(args):
        try:
            return handler(args) or 0
        except ProjectError as exc:
            return _error(args, str(exc), exc.code)
        except OSError as exc:
            return _error(args, f"file/process operation failed: {exc}", 1)
        except Exception as exc:  # 防止未格式化的 traceback
            return _error(args, f"{type(exc).__name__}: {exc}", 1)

    return _wrapped


def _error(args, message: str, code: int) -> int:
    if not getattr(args, "quiet", False):
        if getattr(args, "json_", False):
            print(json.dumps(
                {"success": False, "exit_code": code, "error": message},
                ensure_ascii=False,
                indent=2,
            ))
        else:
            print(f"Error: {message}", file=sys.stderr)
    return code


def _finish(args, payload: dict, human: str = "") -> None:
    if getattr(args, "quiet", False):
        return
    if getattr(args, "json_", False):
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if human:
        print(human)


def _resolve_omni_root(args) -> str:
    explicit = getattr(args, "omni_root", None)
    try:
        return context.resolve_omni_root(str(Path.cwd()), explicit)
    except ProjectError:
        if explicit:
            raise
        raise ProjectError(
            "未找到 omni 框架根目录；请在仓库内运行，或用 --omni-root 指定。",
            code=2,
        ) from None


def _resolve_board(args) -> tuple[context.ProjectContext, BoardSpec]:
    """解析工程与板名。

    与 ``omni config`` 不同，``boards check/sync`` 允许板目录尚不存在（脚手架场景），
    因此不要求工程 ``boards/<board>`` 已存在，只要求框架里有对应 ``board.yml``。
    """

    ctx = context.resolve_context(
        project_dir=getattr(args, "project_dir", None),
        omni_root=getattr(args, "omni_root", None),
        require_target=False,
    )
    name = getattr(args, "board", None) or os.environ.get("OMNI_BOARD")

    if not name:
        known = [spec.name for spec in iter_boards(ctx.omni_root)]
        present = [
            child
            for child in (os.listdir(os.path.join(ctx.project_dir, "boards"))
                          if os.path.isdir(os.path.join(ctx.project_dir, "boards")) else [])
            if child in known
        ]
        if len(present) == 1:
            name = present[0]
        elif present:
            raise ProjectError(
                "工程包含多个板，请用 -b/--board 指定。\n  可用: " + ", ".join(sorted(present)),
                code=2,
            )
        else:
            raise ProjectError(
                "工程没有已知的板目录，请用 -b/--board 指定。\n"
                f"  框架可用板: {', '.join(known) or '<无>'}",
                code=2,
            )

    return ctx, load_board(ctx.omni_root, name)


def _list(args) -> int:
    omni_root = _resolve_omni_root(args)
    boards = list(iter_boards(omni_root))
    payload = {
        "success": True,
        "exit_code": 0,
        "omni_root": omni_root,
        "boards": [spec.as_dict() for spec in boards],
    }
    if getattr(args, "json_", False) or getattr(args, "quiet", False):
        _finish(args, payload)
        return 0

    if not boards:
        _finish(args, payload, f"{omni_root}/boards 下没有 board.yml")
        return 0

    rows = [("BOARD", "DEVICE", "CPU", "FPU", "HAL", "SERIES")]
    for spec in boards:
        rows.append((spec.name, spec.device, spec.cpu, spec.fpu, spec.hal, spec.series))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    text = "\n".join(
        "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip()
        for row in rows
    )
    _finish(args, payload, text)
    return 0


def _show(args) -> int:
    omni_root = _resolve_omni_root(args)
    if not has_board(omni_root, args.board):
        available = ", ".join(spec.name for spec in iter_boards(omni_root)) or "<无>"
        raise ProjectError(
            f"板 '{args.board}' 不存在于 {omni_root}/boards。\n  可用板: {available}",
            code=2,
        )
    spec = load_board(omni_root, args.board)
    files = upstream_files(spec)
    payload = {
        "success": True,
        "exit_code": 0,
        "board": spec.as_dict(),
        "board_dir": spec.directory,
        "upstream": [
            {"role": item.role, "name": item.name, "path": item.path} for item in files
        ],
        "missing_upstream": missing_upstream(spec),
    }
    if getattr(args, "json_", False) or getattr(args, "quiet", False):
        _finish(args, payload)
        return 0

    lines = [
        f"board      : {spec.name}",
        f"full name  : {spec.full_name}",
        f"soc        : {spec.soc}" + (f" ({', '.join(spec.variants)})" if spec.variants else ""),
        f"device     : {spec.device}",
        f"hal        : {spec.hal} / {spec.series}",
        f"cpu / fpu  : {spec.cpu} / {spec.fpu}",
        f"device def : {spec.device_define}",
        f"layout     : {spec.layout}",
        f"startup    : {spec.startup}",
        f"scatter    : {spec.scatter}",
        f"board dir  : {spec.directory}",
        "",
        "upstream files:",
    ]
    for item in files:
        lines.append(f"  {item.role:8s} {item.name:32s} {item.path}")
    for name in missing_upstream(spec):
        lines.append(f"  (missing upstream) {name}")
    lines.append("")
    lines.append(f"芯片详情: omni target info {spec.device}")
    _finish(args, payload, "\n".join(lines))
    return 0


def _check(args) -> int:
    if getattr(args, "all", False):
        return _check_all(args)

    ctx, spec = _resolve_board(args)
    result = check_project(spec, ctx.project_dir)
    payload = {"success": True, "exit_code": 0, **result}

    if getattr(args, "json_", False) or getattr(args, "quiet", False):
        _finish(args, payload)
        return 0

    if not result["board_dir_exists"]:
        raise ProjectError(
            f"工程没有板目录: {result['board_dir']}\n"
            f"  可先运行: omni boards sync --project-dir {ctx.project_dir} -b {spec.name}",
            code=1,
        )

    lines = [f"board: {spec.name}    project: {ctx.project_dir}", ""]
    for item in result["files"]:
        lines.append(f"  {item['status']:12s} {item['name']}")
    if result["missing_required"]:
        lines.append("")
        lines.append("缺失的板级文件: " + ", ".join(result["missing_required"]))
    lines.append("")
    lines.append(
        f"identical={sum(1 for f in result['files'] if f['status'] == 'identical')} "
        f"modified={len(result['modified'])} "
        f"missing={len(result['missing'])}"
    )
    _finish(args, payload, "\n".join(lines))
    return 0


def _iter_projects(repo_root: str):
    """遍历 examples/ 与 applications/ 下的工程目录及其板目录。"""

    skip = {"build", ".git", "CMakeFiles", "RTE", "Objects", "Listings", "DebugConfig", "tmp"}
    markers = ("prj.conf", "Kconfig", ".cproject.yml")
    for base in ("examples", "applications"):
        base_dir = os.path.join(repo_root, base)
        if not os.path.isdir(base_dir):
            continue
        for dirpath, dirnames, _ in os.walk(base_dir):
            dirnames[:] = [name for name in dirnames if name not in skip]
            if os.path.basename(dirpath) != "boards":
                continue
            dirnames[:] = []  # 不再深入板目录
            project = os.path.dirname(dirpath)
            if not any(os.path.isfile(os.path.join(project, marker)) for marker in markers):
                continue
            boards = sorted(
                name
                for name in os.listdir(dirpath)
                if os.path.isdir(os.path.join(dirpath, name))
            )
            yield project, boards


def _check_all(args) -> int:
    """汇总仓库内所有工程的板级漂移（只读，始终返回 0）。"""

    omni_root = _resolve_omni_root(args)
    repo_root = os.path.dirname(omni_root)
    known = {spec.name: spec for spec in iter_boards(omni_root)}

    summary: dict = {}
    projects = 0
    for project, boards in _iter_projects(repo_root):
        projects += 1
        for name in boards:
            spec = known.get(name)
            if spec is None:
                continue
            result = check_project(spec, project)
            entry = summary.setdefault(
                name,
                {
                    "board": name,
                    "projects": 0,
                    "identical": 0,
                    "modified": 0,
                    "missing": 0,
                    "project_only": 0,
                    "modified_files": {},
                    "missing_files": {},
                    "missing_projects": {},
                },
            )
            entry["projects"] += 1
            for item in result["files"]:
                status = item["status"]
                key = {
                    "identical": "identical",
                    "modified": "modified",
                    "missing": "missing",
                    "project-only": "project_only",
                }.get(status)
                if not key:
                    continue
                entry[key] += 1
                if key == "modified":
                    entry["modified_files"][item["name"]] = (
                        entry["modified_files"].get(item["name"], 0) + 1
                    )
                elif key == "missing":
                    entry["missing_files"][item["name"]] = (
                        entry["missing_files"].get(item["name"], 0) + 1
                    )
                    entry["missing_projects"].setdefault(item["name"], []).append(
                        os.path.relpath(project, repo_root).replace("\\", "/")
                    )

    boards_summary = [summary[name] for name in sorted(summary)]
    payload = {
        "success": True,
        "exit_code": 0,
        "repo_root": repo_root,
        "projects": projects,
        "boards": boards_summary,
    }

    if getattr(args, "json_", False) or getattr(args, "quiet", False):
        _finish(args, payload)
        return 0

    lines = [f"仓库: {repo_root}    工程数: {projects}", ""]
    header = ("BOARD", "PROJECTS", "IDENTICAL", "MODIFIED", "MISSING", "PROJECT-ONLY")
    rows = [header]
    for entry in boards_summary:
        rows.append((
            entry["board"],
            str(entry["projects"]),
            str(entry["identical"]),
            str(entry["modified"]),
            str(entry["missing"]),
            str(entry["project_only"]),
        ))
    widths = [max(len(row[i]) for row in rows) for i in range(len(header))]
    lines.extend(
        "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip()
        for row in rows
    )
    for entry in boards_summary:
        if entry["modified_files"]:
            detail = ", ".join(
                f"{name} x{count}"
                for name, count in sorted(
                    entry["modified_files"].items(), key=lambda kv: -kv[1]
                )
            )
            lines.append(f"  {entry['board']} modified: {detail}")
    for entry in boards_summary:
        for name, project_list in sorted(entry["missing_projects"].items()):
            lines.append(
                f"  {entry['board']} missing {name}: " + ", ".join(sorted(project_list))
            )
    _finish(args, payload, "\n".join(lines))
    return 0


def _sync(args) -> int:
    ctx, spec = _resolve_board(args)
    result = sync_project(
        spec,
        ctx.project_dir,
        force=bool(getattr(args, "force", False)),
        dry_run=bool(getattr(args, "dry_run", False)),
    )
    payload = {"success": True, "exit_code": 0, **result}

    if getattr(args, "json_", False) or getattr(args, "quiet", False):
        _finish(args, payload)
        return 0

    prefix = "[dry-run] " if result["dry_run"] else ""
    lines = [f"{prefix}board: {spec.name}    project: {ctx.project_dir}", ""]
    for key, label in (("created", "created"), ("updated", "updated"), ("skipped", "skipped")):
        for path in result[key]:
            lines.append(f"  {label:8s} {os.path.relpath(path, ctx.project_dir)}")
    for warning in result.get("warnings", []):
        lines.append(f"  warning  {warning}")
    if result["next"]:
        lines.append("")
        for step in result["next"]:
            lines.append(f"下一步: {step}")
    _finish(args, payload, "\n".join(lines))
    return 0
