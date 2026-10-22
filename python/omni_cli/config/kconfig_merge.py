#!/usr/bin/env python3
"""Kconfig 合并与头文件生成。

本模块由 omni-emb 的 ``omni/scripts/kconfig.py`` 移植而来，保留其行为：

- 合并 ``.config`` 与手写配置片段（``prj.conf`` / ``board.conf``）；
- 检查未定义符号、promptless 符号、依赖不满足等；
- 输出 ``.config``、``omni_config.h`` 和 Kconfig 文件清单。

原文件版权与许可：
Copyright (c) 2018-2023 Nordic Semiconductor ASA and Ulf Magnusson
Originally modified from:
https://github.com/ulfalizer/Kconfiglib/blob/master/examples/merge_config.py
SPDX-License-Identifier: ISC
"""

from __future__ import annotations

import os
import re
import sys
import textwrap
from contextlib import contextmanager
from typing import Callable, Iterable, Optional, TextIO

from kconfiglib import (
    AND,
    BOOL,
    OR,
    TRI_TO_STR,
    TRISTATE,
    Kconfig,
    expr_str,
    expr_value,
    split_expr,
)


class KconfigMergeError(Exception):
    """Kconfig 解析/合并失败。"""


SYM_INFO_HINT = """\
Look up {0.name} in the menuconfig/guiconfig interface.\
"""

WARN_ONLY_RE = re.compile(r"warning:.*set more than once.")


@contextmanager
def _temporary_env(name: str, value: Optional[str]):
    if value is None:
        yield
        return
    old = os.environ.get(name)
    os.environ[name] = value
    try:
        yield
    finally:
        if old is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = old


def merge_config(
    *,
    kconfig_file: str,
    config_out: str,
    header_out: str,
    kconfig_list_out: str,
    configs_in: Iterable[str],
    handwritten_input_configs: bool = False,
    forced_input_configs: bool = False,
    omni_base: Optional[str] = None,
    srctree: Optional[str] = None,
    log: Callable[[str], None] = print,
    err: TextIO = sys.stderr,
) -> None:
    """合并配置片段并写出 ``.config`` / 头文件 / Kconfig 清单。

    失败时抛出 :class:`KconfigMergeError`，由 CLI 统一映射退出码。
    """

    configs = list(configs_in)
    if not configs:
        raise KconfigMergeError("没有输入配置文件")

    with _temporary_env("OMNI_BASE", omni_base), _temporary_env("srctree", srctree):
        try:
            kconf = Kconfig(kconfig_file, warn_to_stderr=False, suppress_traceback=True)
        except Exception as exc:  # kconfiglib 的异常类型随版本略有差异
            raise KconfigMergeError(f"解析 Kconfig 失败: {exc}") from exc

        log("Parsing " + kconfig_file)

        if handwritten_input_configs:
            # Warn for assignments to undefined symbols, but only for handwritten
            # fragments, to avoid warnings-turned-errors when using an old
            # configuration file together with updated Kconfig files.
            kconf.warn_assign_undef = True
            # prj.conf may override settings from the board configuration, so
            # disable warnings about symbols being assigned more than once.
            kconf.warn_assign_override = False
            kconf.warn_assign_redun = False

        if forced_input_configs:
            # Do not warn on a redundant config.
            kconf.warn_assign_redun = False

        log(kconf.load_config(configs[0]))
        for config in configs[1:]:
            # replace=False creates a merged configuration
            log(kconf.load_config(config, replace=False))

        if handwritten_input_configs:
            # Check that there are no assignments to promptless symbols, which
            # have no effect. This only makes sense when loading handwritten
            # fragments, not when loading .config.
            _check_no_promptless_assign(kconf)
            _check_assigned_sym_values(kconf, err)
            _check_assigned_choice_values(kconf, err)

        if kconf.syms.get("WARN_DEPRECATED", kconf.y).tri_value == 2:
            _check_deprecated(kconf, err)

        if kconf.syms.get("WARN_EXPERIMENTAL", kconf.y).tri_value == 2:
            _check_experimental(kconf, err)

        # Force all symbols to be evaluated so warnings are produced before any
        # output file is written.
        kconf.write_config(os.devnull)

        if kconf.warnings:
            error_out = not forced_input_configs
            for warning in kconf.warnings:
                print("\n" + warning, file=err)
                if not error_out and not WARN_ONLY_RE.search(warning):
                    error_out = True
            if error_out:
                raise KconfigMergeError("Aborting due to Kconfig warnings")

        log(kconf.write_config(config_out))
        log(kconf.write_autoconf(header_out))
        _write_kconfig_filenames(kconf, kconfig_list_out)


def _check_no_promptless_assign(kconf: Kconfig) -> None:
    for sym in kconf.unique_defined_syms:
        if sym.user_value is not None and _promptless(sym):
            raise KconfigMergeError(textwrap.fill(
                f"error: {sym.name_and_loc} is assigned in a configuration file, "
                "but is not directly user-configurable (has no prompt). It gets "
                "its value indirectly from other symbols. "
                + SYM_INFO_HINT.format(sym),
                100,
            ))


def _check_assigned_sym_values(kconf: Kconfig, err: TextIO) -> None:
    for sym in kconf.unique_defined_syms:
        if sym.choice:
            continue

        user_value = sym.user_value
        if user_value is None:
            continue

        if sym.type in (BOOL, TRISTATE):
            user_value = TRI_TO_STR[user_value]

        if user_value != sym.str_value:
            msg = (
                f"{sym.name_and_loc} was assigned the value '{user_value}' "
                f"but got the value '{sym.str_value}'. "
            )

            mdeps = _missing_deps(sym)
            if mdeps:
                expr_strs = []
                for expr in mdeps:
                    estr = expr_str(expr)
                    if isinstance(expr, tuple):
                        estr = f"({estr})"
                    expr_strs.append(f"{estr} (={TRI_TO_STR[expr_value(expr)]})")
                msg += "Check these unsatisfied dependencies: " + ", ".join(expr_strs) + ". "

            _warn(msg + SYM_INFO_HINT.format(sym), err)


def _missing_deps(sym):
    deps = split_expr(sym.direct_dep, AND)
    if sym.type in (BOOL, TRISTATE):
        return [dep for dep in deps if expr_value(dep) < sym.user_value]
    return [dep for dep in deps if expr_value(dep) == 0]


def _check_assigned_choice_values(kconf: Kconfig, err: TextIO) -> None:
    for choice in kconf.unique_choices:
        if choice.user_selection and choice.user_selection is not choice.selection:
            _warn(
                "The choice symbol "
                f"{choice.user_selection.name_and_loc} was selected (set =y), "
                f"but {choice.selection.name_and_loc if choice.selection else 'no symbol'} "
                "ended up as the choice selection. "
                + SYM_INFO_HINT.format(choice.user_selection),
                err,
            )


def _check_deprecated(kconf: Kconfig, err: TextIO) -> None:
    deprecated = kconf.syms.get("DEPRECATED")
    dep_expr = kconf.n if deprecated is None else deprecated.rev_dep
    if dep_expr is not kconf.n:
        selectors = [s for s in split_expr(dep_expr, OR) if expr_value(s) == 2]
        for selector in selectors:
            selector_name = split_expr(selector, AND)[0].name
            _warn(f"Deprecated symbol {selector_name} is enabled.", err)


def _check_experimental(kconf: Kconfig, err: TextIO) -> None:
    experimental = kconf.syms.get("EXPERIMENTAL")
    dep_expr = kconf.n if experimental is None else experimental.rev_dep
    if dep_expr is not kconf.n:
        selectors = [s for s in split_expr(dep_expr, OR) if expr_value(s) == 2]
        for selector in selectors:
            selector_name = split_expr(selector, AND)[0].name
            _warn(f"Experimental symbol {selector_name} is enabled.", err)


def _promptless(sym) -> bool:
    return not any(node.prompt for node in sym.nodes)


def _write_kconfig_filenames(kconf: Kconfig, kconfig_list_path: str) -> None:
    with open(kconfig_list_path, "w", encoding="utf-8") as out:
        for path in sorted(
            {
                os.path.realpath(os.path.join(kconf.srctree, path))
                for path in kconf.kconfig_filenames
            }
        ):
            print(path, file=out)


def _warn(msg: str, err: TextIO) -> None:
    print("\n" + textwrap.fill("warning: " + msg, 100) + "\n", file=err)
