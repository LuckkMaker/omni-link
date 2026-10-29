"""``omni build`` 的终端呈现：头部、逐行着色、结尾摘要与失败定位。

命令行维持原有行为：ninja/cmake 的每一行照原样实时转发（不缓冲、不过滤），
本模块只决定「怎么显示」——着色哪些行、开头打哪几行、结尾给什么结论。
真正的日志仍然完整保留在 ``BuildResult.log`` 和 ``<build-dir>/build.log`` 里。
"""

from __future__ import annotations

import os
import re
import sys

from ..formatting import BOLD, CYAN, DIM, GRAY, GREEN, RED, YELLOW, Palette

STEP_RE = re.compile(r"^\s*\[(\d+)/(\d+)\]\s*(.*)$")
FAILED_RE = re.compile(r"^FAILED:\s*(\S.*?)\s*$")
#: 编译/链接/配置三类报错的首行特征（用于结尾「首个错误」与红色高亮）。
ERROR_RE = re.compile(
    r"(?:fatal error|error):\s|CMake Error|Error: L\d{4}|undefined reference to"
)
WARNING_RE = re.compile(r"warning:\s")
COMMAND_RE = re.compile(
    r"^(?:[A-Za-z]:[\\/][^\s]*?\.exe\b|@\S+\.rsp\b|cmake(?:\.exe)?\b|ninja(?:\.exe)?\b)",
    re.IGNORECASE,
)


def shorten_path(path: str, base: str | None = None) -> str:
    """把 ``base`` 之下的绝对路径转成相对路径；不在其下则原样返回。

    诊断行常是「绝对路径 + 行列号 + 说明」，整体交给 ``relpath`` 也能得到正确结果
    （额外文本只是文件名的一部分）；但 ``CMake Error at ...`` 这类不以路径开头的
    行必须原样保留，否则会拼出莫名其妙的相对路径。
    """

    if not path:
        return path
    text = str(path)
    if base and (os.path.isabs(text) or (len(text) > 1 and text[1] == ":")):
        try:
            rel = os.path.relpath(text, base)
        except (OSError, ValueError):
            rel = text
        if not rel.startswith(".."):
            return rel
    return text


def _flag_value(cmd: list[str], flag: str) -> str | None:
    try:
        return cmd[cmd.index(flag) + 1]
    except (ValueError, IndexError):
        return None


def compact_command(cmd: list[str], kind: str) -> str:
    """把很长的 cmake 命令压成一行可读形式（``-v`` 时才打全量）。"""

    if not cmd:
        return ""
    if kind == "configure":
        project = _flag_value(cmd, "-S") or "."
        build = _flag_value(cmd, "-B") or "<build>"
        generator = _flag_value(cmd, "-G") or "Ninja"
        return f"cmake -S {project} -B {build} -G {generator}"

    build = _flag_value(cmd, "--build") or "<build>"
    parts = ["cmake", "--build", build]
    target = _flag_value(cmd, "--target")
    if target:
        parts += ["--target", target]
    parallel = _flag_value(cmd, "--parallel")
    if parallel:
        parts += ["--parallel", parallel]
    return " ".join(parts)


def steps_from_log(text: str) -> int:
    """ninja 的 ``[n/m]`` 里最大的 m；失败后重打日志也不影响结果。"""

    total = 0
    for line in text.splitlines():
        match = STEP_RE.match(line)
        if match:
            total = max(total, int(match.group(2)))
    return total


def summarize_failure(text: str) -> dict:
    """从原始日志里提炼「失败目标数 + 首个 error 行」。

    注意：``omni build`` 失败时 stderr 里会再打一份同样的日志，这里按 ``FAILED:``
    目标去重，重打不会把计数翻倍。
    """

    targets: list[str] = []
    first_error: str | None = None
    for line in text.splitlines():
        match = FAILED_RE.match(line)
        if match:
            target = match.group(1)
            if target not in targets:
                targets.append(target)
            continue
        if first_error is None and ERROR_RE.search(line):
            first_error = line.strip()
    return {"targets": len(targets), "first_error": first_error}


class BuildReporter:
    """把构建上下文、实时日志、收尾结论统一成一套可读输出。"""

    def __init__(
        self,
        palette: Palette,
        *,
        quiet: bool = False,
        verbose: bool = False,
        project_dir: str = "",
        build_dir: str = "",
        root: str = "",
    ) -> None:
        self.palette = palette
        self.quiet = quiet
        self.verbose = verbose
        self.project_dir = project_dir
        self.build_dir = build_dir
        self.root = root

    # ------------------------------------------------------------ 头部

    def header(self, name: str, board: str, compiler: str, build_type: str) -> None:
        if self.quiet:
            return
        p = self.palette
        print(f"{p('›', CYAN, BOLD)} {p('omni build', BOLD)}  {p(name, BOLD)}")
        rows = (
            ("board", f"{board} · {compiler} · {build_type}"),
            ("build", shorten_path(self.build_dir, self.project_dir)),
        )
        for key, value in rows:
            print(f"  {p(key.ljust(6), DIM)}  {value}")
        print()

    def info(self, message: str) -> None:
        if self.quiet:
            return
        print(f"  {self.palette.dim(message)}", flush=True)

    # ------------------------------------------------------------ 阶段

    def phase(self, kind: str, cmd: list[str]) -> None:
        """配置/构建阶段开始（``run_build`` 在真正执行前回调）。"""

        if self.quiet:
            return
        text = " ".join(cmd) if self.verbose else compact_command(cmd, kind)
        if not self.verbose and self.project_dir:
            # 命令里的 -S/-B 都是绝对路径，换成相对工程目录更短。
            text = text.replace(self.project_dir + os.sep, "." + os.sep)
            text = text.replace(self.project_dir, ".")
        label = "configure" if kind == "configure" else "build"
        print(f"{self.palette('›', CYAN, BOLD)} {self.palette(label, CYAN)}  {text}",
              flush=True)

    # ------------------------------------------------------------ 实时日志

    def line(self, raw: str) -> None:
        print(self.style_line(raw), flush=True)

    def style_line(self, raw: str) -> str:
        p = self.palette
        if not p.enabled:
            return raw
        stripped = raw.lstrip()
        if STEP_RE.match(raw):
            return p(raw, DIM)
        if stripped.startswith("FAILED:"):
            return p(raw, RED, BOLD)
        if ERROR_RE.search(raw):
            return p(raw, RED)
        if WARNING_RE.search(raw):
            return p(raw, YELLOW)
        if COMMAND_RE.match(stripped):
            return p(raw, GRAY)
        if raw.startswith("ninja:") and "stopped" in raw:
            return p(raw, RED)
        return raw

    # ------------------------------------------------------------ 结尾

    def success(self, result, *, configure_only: bool = False) -> None:
        if self.quiet:
            return
        p = self.palette
        seconds = (result.configure_seconds or 0.0) + (result.build_seconds or 0.0)
        title = "配置完成" if configure_only else "构建完成"
        steps = f"  {result.steps} 步" if result.steps and not configure_only else ""
        print()
        print(f"{p('✓', GREEN, BOLD)} {p(title, GREEN, BOLD)}{steps} · {seconds:.1f}s")

        width = max([len(name) for name in result.artifacts] + [4])
        if result.size:
            size = result.size
            print(
                f"  {p('size'.ljust(width), DIM)} "
                f"Code={size['code']}  RO-data={size['ro_data']}  "
                f"RW-data={size['rw_data']}  ZI-data={size['zi_data']}"
            )
        elif result.gnu_size:
            size = result.gnu_size
            print(
                f"  {p('size'.ljust(width), DIM)} "
                f"text={size['text']}  data={size['data']}  bss={size['bss']}"
            )
        for name, path in result.artifacts.items():
            print(f"  {p(name.ljust(width), DIM)} {path}")
        if result.log_path:
            print(f"  {p('log'.ljust(width), DIM)} {result.log_path}")

    def failure(self, result, *, phase: str = "build") -> None:
        if self.quiet:
            return
        p = self.palette
        seconds = (result.configure_seconds or 0.0) + (result.build_seconds or 0.0)
        summary = summarize_failure("\n".join(result.log))
        title = "配置失败" if phase == "configure" else "构建失败"
        detail = f"{summary['targets']} 个目标 · {seconds:.1f}s" if summary["targets"] else f"{seconds:.1f}s"

        print(file=sys.stderr)
        print(
            f"{p('✗', RED, BOLD)} {p(title, RED, BOLD)}"
            f"（exit {result.exit_code}）  {detail}",
            file=sys.stderr,
        )
        if summary["first_error"]:
            first = shorten_path(summary["first_error"], self.root)
            print(f"  {p('首个错误', DIM)}  {first}", file=sys.stderr)
        if result.log_path:
            print(f"  {p('完整日志', DIM)}  {result.log_path}", file=sys.stderr)
