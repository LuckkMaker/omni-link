"""模块注册命令：modules [list|check|generate]。

本地执行，不经过后端。模块声明来自 ``module.yml``（模块仓库或框架侧 glue），
``generate`` 写出 ``omni/cmake/omni_modules.cmake`` 与 ``omni/Kconfig.modules``。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .. import context
from ..context import ProjectError
from ..modules import generate, iter_modules, module_issues
from ..options import local_parser


def add_parser(sub):
    p = sub.add_parser(
        "modules",
        parents=[local_parser()],
        help="模块注册表（列出/检查/生成；本地执行）",
    )
    ps = p.add_subparsers(dest="modules_sub", metavar="<sub>")

    s = ps.add_parser("list", parents=[local_parser()], help="列出已声明的模块")
    s.add_argument("--omni-root", default=None, metavar="PATH",
                   help="omni 框架根目录（默认从当前目录向上查找）")
    s.set_defaults(func=_run(_list))

    s = ps.add_parser("check", parents=[local_parser()], help="检查模块声明是否自洽")
    s.add_argument("--omni-root", default=None, metavar="PATH",
                   help="omni 框架根目录（默认从当前目录向上查找）")
    s.set_defaults(func=_run(_check))

    s = ps.add_parser("generate", parents=[local_parser()],
                      help="生成 omni_modules.cmake 与 Kconfig.modules")
    s.add_argument("--omni-root", default=None, metavar="PATH",
                   help="omni 框架根目录（默认从当前目录向上查找）")
    s.add_argument("--check", action="store_true", default=False,
                   help="只校验生成物是否与声明一致（不一致返回退出码 2）")
    s.set_defaults(func=_run(_generate))

    p.set_defaults(func=_run(_list), modules_sub="list")


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


def _roots(args) -> tuple[str, str]:
    """返回 (repo_root, omni_root)。"""

    explicit = getattr(args, "omni_root", None)
    try:
        omni_root = context.resolve_omni_root(str(Path.cwd()), explicit)
    except ProjectError:
        if explicit:
            raise
        raise ProjectError(
            "未找到 omni 框架根目录；请在仓库内运行，或用 --omni-root 指定。",
            code=2,
        ) from None
    return os.path.dirname(omni_root), omni_root


def _list(args) -> int:
    repo_root, omni_root = _roots(args)
    modules = iter_modules(repo_root)
    payload = {
        "success": True,
        "exit_code": 0,
        "repo_root": repo_root,
        "omni_root": omni_root,
        "modules": [spec.as_dict() for spec in modules],
    }
    if getattr(args, "json_", False) or getattr(args, "quiet", False):
        _finish(args, payload)
        return 0

    if not modules:
        _finish(args, payload, "没有声明任何模块（module.yml）")
        return 0

    rows = [("MODULE", "LOCATION", "CMAKE", "KCONFIG", "ENABLE")]
    for spec in modules:
        rows.append((
            spec.name,
            spec.location,
            spec.cmake or "-",
            spec.kconfig or "-",
            spec.enable or "-",
        ))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    text = "\n".join(
        "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip()
        for row in rows
    )
    _finish(args, payload, text)
    return 0


def _check(args) -> int:
    repo_root, omni_root = _roots(args)
    modules = iter_modules(repo_root)
    report = []
    for spec in modules:
        report.append({"name": spec.name, "issues": module_issues(repo_root, spec)})

    payload = {
        "success": True,
        "exit_code": 0,
        "repo_root": repo_root,
        "modules": report,
        "with_issues": [item["name"] for item in report if item["issues"]],
    }
    if getattr(args, "json_", False) or getattr(args, "quiet", False):
        _finish(args, payload)
        return 0

    lines = []
    for item in report:
        if item["issues"]:
            lines.append(f"{item['name']}:")
            lines.extend(f"  - {issue}" for issue in item["issues"])
        else:
            lines.append(f"{item['name']}: ok")
    lines.append("")
    lines.append(f"模块数: {len(report)}，有问题: {len(payload['with_issues'])}")
    _finish(args, payload, "\n".join(lines))
    return 0


def _generate(args) -> int:
    repo_root, omni_root = _roots(args)
    check = bool(getattr(args, "check", False))
    result = generate(repo_root, omni_root, check=check)

    exit_code = 2 if (check and result["drifted"]) else 0
    payload = {
        "success": exit_code == 0,
        "exit_code": exit_code,
        "repo_root": repo_root,
        "omni_root": omni_root,
        **result,
    }
    if getattr(args, "json_", False) or getattr(args, "quiet", False):
        _finish(args, payload)
        return exit_code

    lines = [f"模块数: {len(result['modules'])}"]
    for rel in result["written"]:
        lines.append(f"  written   {rel}")
    for rel in result["unchanged"]:
        lines.append(f"  unchanged {rel}")
    for rel in result["drifted"]:
        lines.append(f"  drifted   {rel}")
    if check and result["drifted"]:
        lines.append("")
        lines.append("注册表与 module.yml 不一致；运行 omni modules generate 重新生成。")
    _finish(args, payload, "\n".join(lines))
    return exit_code
