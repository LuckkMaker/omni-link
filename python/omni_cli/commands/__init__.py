"""命令注册包：放置各命令模块，由 cli.py 统一采集注册。

新增命令只需在本文件导入并加入 `_MODULES`，`cli.py` 不再维护第二份列表。
"""

from . import backend
from . import commander
from . import config
from . import debug
from . import device
from . import flash
from . import monitor
from . import pack
from . import probe
from . import rtt
from . import system
from . import target

_MODULES = (
    backend,
    commander,
    config,
    debug,
    device,
    flash,
    monitor,
    pack,
    probe,
    rtt,
    system,
    target,
)


def add_all_parsers(sub) -> None:
    """把全部命令模块的 parser 挂到顶层子命令解析器上。"""

    for module in _MODULES:
        module.add_parser(sub)


__all__ = ["add_all_parsers"]
