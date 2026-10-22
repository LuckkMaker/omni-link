"""工程上下文解析：工程目录、omni 框架根目录、板级目标。

不依赖后端，也不依赖 omni-emb 的 ``omni/scripts`` 目录；CLI 只读取框架的
Kconfig / soc / boards 等数据。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


class ProjectError(Exception):
    """工程配置命令的可预期错误。

    ``code`` 直接作为 CLI 退出码：1=业务/配置错误，2=用法/目标歧义。
    """

    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ProjectContext:
    project_dir: str
    omni_root: str
    repo_root: str
    target: Optional[str]


def _env(name: str) -> Optional[str]:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def _looks_like_project(path: Path) -> bool:
    boards = path / "boards"
    if not boards.is_dir():
        return False
    if (path / "prj.conf").is_file() or (path / "Kconfig").is_file():
        return True
    try:
        for child in boards.iterdir():
            if not child.is_dir():
                continue
            if (child / "board.conf").is_file() or (child / "board.dts").is_file():
                return True
    except OSError:
        return False
    return False


def _ancestors(path: Path) -> Iterable[Path]:
    current = path
    while True:
        yield current
        parent = current.parent
        if parent == current:
            return
        current = parent


def resolve_project_dir(explicit: Optional[str] = None) -> str:
    """按 --project-dir / OMNI_PROJECT_DIR / 当前目录向上发现工程根。"""

    raw = explicit or _env("OMNI_PROJECT_DIR")
    if raw:
        candidate = Path(raw).expanduser().resolve()
        if not candidate.is_dir():
            raise ProjectError(f"工程目录不存在: {candidate}", code=2)
        if not _looks_like_project(candidate):
            raise ProjectError(
                f"不是 OMNI 工程目录（需要 boards/ 与 prj.conf 或 board.conf）: {candidate}",
                code=2,
            )
        return str(candidate)

    start = Path.cwd().resolve()
    for candidate in _ancestors(start):
        if _looks_like_project(candidate):
            return str(candidate)
    raise ProjectError(
        f"当前目录不在 OMNI 工程内: {start}\n"
        "  请用 --project-dir 指定工程根目录（包含 boards/ 与 prj.conf）。",
        code=2,
    )


def _is_omni_root(path: Path) -> bool:
    return (path / "Kconfig").is_file() and (path / "Kconfig.omni").is_file()


def resolve_omni_root(project_dir: str, explicit: Optional[str] = None) -> str:
    """按 --omni-root / OMNI_EMB_ROOT / OMNI_ROOT / 工程目录向上发现 omni/。"""

    raw = explicit or _env("OMNI_EMB_ROOT") or _env("OMNI_ROOT")
    if raw:
        candidate = Path(raw).expanduser().resolve()
        if _is_omni_root(candidate):
            return str(candidate)
        nested = candidate / "omni"
        if _is_omni_root(nested):
            return str(nested)
        raise ProjectError(
            f"不是 OMNI 框架根目录: {candidate}\n"
            "  需要包含 Kconfig 与 Kconfig.omni；也可以指向仓库根（其下有 omni/）。",
            code=2,
        )

    for ancestor in _ancestors(Path(project_dir).resolve()):
        candidate = ancestor / "omni"
        if _is_omni_root(candidate):
            return str(candidate)
        if _is_omni_root(ancestor):
            return str(ancestor)
    raise ProjectError(
        f"未找到 OMNI 框架根目录（从 {project_dir} 向上查找 omni/Kconfig 失败）。\n"
        "  请用 --omni-root 指定，例如 D:\\workspace\\embedded\\omni-emb\\omni。",
        code=2,
    )


def _board_candidates(project_dir: str) -> list[str]:
    boards = Path(project_dir) / "boards"
    if not boards.is_dir():
        return []
    marked: list[str] = []
    all_dirs: list[str] = []
    try:
        for child in boards.iterdir():
            if not child.is_dir():
                continue
            name = child.name
            if name.startswith(".") or name == "config":
                continue
            all_dirs.append(name)
            if (child / "board.conf").is_file() or (child / "board.dts").is_file():
                marked.append(name)
    except OSError as exc:
        raise ProjectError(f"无法读取 boards 目录: {exc}", code=1) from exc
    return sorted(marked or all_dirs)


def resolve_target(project_dir: str, explicit: Optional[str] = None) -> str:
    """按 -b/--board / OMNI_BOARD / boards 下唯一目标解析板级名。"""

    raw = explicit or _env("OMNI_BOARD")
    boards = Path(project_dir) / "boards"
    candidates = _board_candidates(project_dir)

    if raw:
        target = raw.strip()
        if target not in candidates and not (boards / target).is_dir():
            available = ", ".join(candidates) if candidates else "<无>"
            raise ProjectError(
                f"目标板 '{target}' 不存在于 {boards}。\n  可用目标: {available}",
                code=2,
            )
        return target

    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise ProjectError(
            f"{boards} 下没有可用目标；请用 -b/--board 指定。",
            code=2,
        )
    available = ", ".join(candidates)
    raise ProjectError(
        f"工程包含多个目标板，请用 -b/--board 指定。\n  可用目标: {available}",
        code=2,
    )


def resolve_context(
    *,
    project_dir: Optional[str] = None,
    omni_root: Optional[str] = None,
    target: Optional[str] = None,
    require_omni: bool = True,
    require_target: bool = True,
) -> ProjectContext:
    """解析并校验工程上下文。"""

    resolved_project = resolve_project_dir(project_dir)
    resolved_omni = resolve_omni_root(resolved_project, omni_root) if require_omni else ""
    resolved_target = resolve_target(resolved_project, target) if require_target else None
    repo_root = str(Path(resolved_omni).parent) if resolved_omni else ""
    return ProjectContext(
        project_dir=resolved_project,
        omni_root=resolved_omni,
        repo_root=repo_root,
        target=resolved_target,
    )
