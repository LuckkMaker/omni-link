"""从模块的 layer（``*.clayer.yml``）解析 Keil 同步规则。

模块的 ``omni/module.yml`` 已经声明了这里需要的两件事：``enable``（对应
``CONFIG_<enable>``）和 ``settings.layer``。layer 是 csolution 的单一事实源：
``add-path`` 就是头文件目录，``groups`` 就是「组 + 文件」的划分，组名与 Keil
工程里的命名一致（``lwip/core`` → ``module/lwip/core``，``device/driver`` 原样
保留）。

所以 ``modules/*`` 不再需要往 :data:`uvproj_rules.EXTRA_RULE_SETS` 里手写
「符号 → 源文件」表：模块只要声明了 layer，就自动进同步范围，加文件时不用再
同步改 CLI。

两类不纳入同步：

* ``type: Device`` 的 SoC/HAL 层——启动文件与 HAL 源文件取决于板级，各工程历史
  写法也不统一（``device/startup`` 与 ``startup`` 组并存），仍由工程自己维护；
* 没有 ``settings.layer`` 的模块（cmsis-* 等）——没有分组信息，不猜。
"""

from __future__ import annotations

import os
import posixpath
from typing import Callable, Optional

import yaml

from ..context import ProjectError
from ..modules.model import iter_modules

#: layer 里会列出的源文件后缀；其它（脚本、数据文件）跳过不猜。
SOURCE_EXTENSIONS = (".c", ".cc", ".cpp", ".s", ".S", ".asm")

#: 组名已经带这些前缀时不再补 ``module/``。
GROUP_PREFIXES = ("module/", "device/", "omni/")


def _read_layer(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    except yaml.YAMLError as exc:
        raise ProjectError(f"{path} 不是合法 YAML: {exc}", code=1) from exc
    if not isinstance(data, dict) or not isinstance(data.get("layer"), dict):
        raise ProjectError(f"{path} 缺少 layer 段", code=1)
    return data["layer"]


def _join(base: str, value: object) -> str:
    return posixpath.normpath(posixpath.join(base, str(value)))


def group_for_layer(name: str) -> str:
    """layer 里的组名转成 Keil 工程里的 GroupName。"""

    if name.startswith(GROUP_PREFIXES):
        return name
    return f"module/{name}"


def parse_layer(
    path: str,
    repo_root: str,
    module_dir: str,
    symbol: str,
    *,
    log: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """解析一个 layer，返回 :mod:`uvproj_sync` 需要的规则列表。

    ``module_dir`` 是模块根目录（仓库相对、``/`` 分隔），layer 里的 ``./src/...``
    都相对它解析；返回的 ``files`` 相对模块根，``include_paths`` 相对仓库根
    （与 :data:`uvproj_rules.LEGACY_RULE_SETS` 的约定一致）。声明了但磁盘上不
    存在的文件直接报错，不静默猜测。
    """

    layer = _read_layer(path)
    location = os.path.relpath(path, repo_root).replace(os.sep, "/")

    if str(layer.get("type") or "").strip() == "Device":
        if log is not None:
            log(f"Skip device layer: {location}")
        return []

    include_paths: list[str] = []
    for entry in layer.get("add-path") or []:
        include = _join(module_dir, entry)
        if include not in include_paths:
            include_paths.append(include)

    rules: list[dict] = []
    for group in layer.get("groups") or []:
        if not isinstance(group, dict):
            raise ProjectError(f"{location}: groups 里的条目必须是映射", code=1)
        name = str(group.get("group") or "").strip()
        if not name:
            raise ProjectError(f"{location}: 有 group 缺少名字", code=1)

        files: list[str] = []
        for item in group.get("files") or []:
            value = item.get("file") if isinstance(item, dict) else item
            if not value:
                raise ProjectError(f"{location}: {name} 里有 file 缺少路径", code=1)
            if not str(value).endswith(SOURCE_EXTENSIONS):
                if log is not None:
                    log(f"Skip non-source file in {location}: {value}")
                continue
            # files 相对 base_path（模块根），与 uvproj_rules 的约定一致
            relative = posixpath.normpath(str(value))
            file_path = _join(module_dir, relative)
            if not os.path.isfile(os.path.join(repo_root, file_path.replace("/", os.sep))):
                raise ProjectError(
                    f"{location}: 声明的文件不存在 {file_path}",
                    code=1,
                )
            files.append(relative)

        if not files:
            continue

        rules.append(
            {
                "symbol": symbol,
                "group": group_for_layer(name),
                "base_path": module_dir,
                "files": files,
                "include_paths": list(include_paths),
            }
        )

    return rules


def load_module_rule_sets(
    repo_root: str,
    *,
    log: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """扫描仓库里所有带 layer 的模块，返回 Keil 同步规则。

    没有 ``settings.layer`` 的模块（cmsis-* 等）在 Keil 里是用 pack 组件
    （``::CMSIS``/``::RTOS`` 组）编的，源码不来自 ``modules/``，因此不参与同步；
    这里把它显式列出来，避免「模块被 Kconfig 打开了却没进工程」被当成 bug 排查。
    """

    rules: list[dict] = []
    without_layer: list[str] = []

    for spec in iter_modules(repo_root):
        if not spec.enable:
            continue
        if not spec.layer:
            without_layer.append(spec.name)
            continue
        layer_path = os.path.join(repo_root, spec.layer.replace("/", os.sep))
        if not os.path.isfile(layer_path):
            raise ProjectError(
                f"模块 {spec.name} 声明的 layer 不存在: {spec.layer}",
                code=1,
            )
        rules.extend(
            parse_layer(
                layer_path,
                repo_root,
                spec.module_dir,
                f"CONFIG_{spec.enable}",
                log=log,
            )
        )

    if log is not None and without_layer:
        log(
            "Modules without layer (Keil uses pack components; source sync skipped): "
            + ", ".join(without_layer)
        )

    return rules
