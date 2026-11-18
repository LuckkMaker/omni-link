"""omni CLI 的轻量 Python 包装（适配 omni-cli 0.28.0）。

三个技能脚本共用：调用 `omni` 子命令、解析 `--json`、剥 ANSI。
0.23.0 的 `--json` stdout 已是纯 JSON/JSONL，警告在响应的 `warning` 字段里；
`strip_warnings()` 只用于兜底 ≤0.2.2 的旧安装（会把 `警告: ...` 写进 JSON 内部）。

只依赖标准库，Python 3.9+。**三种运行方式**（按优先级）：

1. ``OMNI_CLI`` —— 显式可执行文件路径（或 ``.py``，会用当前解释器跑）；
2. ``OMNI_CLI_REPO`` —— omni-cli 源码仓库根，等价于 ``python -m omni_cli``
   （并自动把该目录放进 ``PYTHONPATH``），适合没装 wheel 的开发态；
3. PATH 上的 ``omni``。

例：``set OMNI_CLI_REPO=D:\workspace\embedded\omni-cli``。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

OMNI = os.environ.get("OMNI_CLI", "omni")
OMNI_REPO = os.environ.get("OMNI_CLI_REPO", "")


def _base_command() -> list[str]:
    """按 OMNI_CLI / OMNI_CLI_REPO / PATH 的顺序决定怎么调用 CLI。"""
    explicit = os.environ.get("OMNI_CLI")
    if explicit:
        if explicit.lower().endswith(".py"):
            return [sys.executable, explicit]
        return [explicit]
    if OMNI_REPO:
        return [sys.executable, "-m", "omni_cli"]
    return ["omni"]


def _child_env() -> dict:
    """源码态需要把 omni-cli 仓放进 PYTHONPATH。"""
    env = dict(os.environ)
    if not os.environ.get("OMNI_CLI") and OMNI_REPO:
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = OMNI_REPO + (os.pathsep + existing if existing else "")
    return env

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_WARNING_LINE = re.compile(r"^\s*警告[:：]")


class OmniError(RuntimeError):
    """omni 命令返回非零退出码。"""


def setup_console() -> None:
    """把 stdout/stderr 固定成 UTF-8，避免中文 Windows 的 cp936 乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


def strip_warnings(text: str) -> str:
    """删掉混进 stdout 的 `警告:` 行（仅 ≤0.2.2 的 RTT --since 过期提示）。"""
    return "\n".join(line for line in text.splitlines() if not _WARNING_LINE.match(line))


def run(args, *, allow_fail: bool = False, timeout: float = 300.0):
    """执行一条 omni 命令，返回 (exit_code, stdout, stderr)。"""
    cmd = [*_base_command(), *map(str, args)]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=_child_env(),
        )
    except FileNotFoundError as exc:  # omni 不在 PATH
        raise OmniError(
            "找不到 omni 命令：安装 wheel 后把 omni 放进 PATH，"
            "或设 OMNI_CLI_REPO 指向 omni-cli 源码仓库（源码态运行）"
        ) from exc

    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    if proc.returncode != 0 and not allow_fail:
        detail = stderr or stdout or "(无输出)"
        raise OmniError(f"omni {' '.join(map(str, args))} 失败（exit {proc.returncode}）：\n{detail}")
    return proc.returncode, stdout, stderr


def run_json(args, *, allow_fail: bool = False, timeout: float = 300.0):
    """执行命令并把 stdout 当 JSON 解析；空输出返回 None。"""
    _, stdout, _ = run(args, allow_fail=allow_fail, timeout=timeout)
    if not stdout:
        return None
    text = strip_warnings(stdout)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise OmniError(f"omni {' '.join(str(a) for a in args)} 的 --json 输出无法解析：{exc}\n{text[:400]}") from exc


def backend_running() -> bool:
    code, _, _ = run(["backend", "status"], allow_fail=True)
    return code == 0


def ensure_backend() -> None:
    if backend_running():
        return
    run(["backend", "start"])
    print("    已启动常驻后端")


def resolve_uid(uid: str | None) -> str:
    if uid:
        return uid
    data = run_json(["probe", "list", "--json"])
    probes = (data or {}).get("probes") or []
    if not probes:
        raise OmniError("没有找到任何探针（检查 USB / J-Link 连接）")
    return probes[0]["uid"]


def write_rtt_log(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
