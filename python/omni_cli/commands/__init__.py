"""命令注册包：放置各命令模块，由 cli.py 统一采集注册。"""

from . import backend as backend
from . import commander as commander
from . import debug as debug
from . import device as device
from . import flash as flash
from . import pack as pack
from . import probe as probe
from . import project as project
from . import rtt as rtt
from . import target as target

__all__ = [
    "backend", "commander", "debug", "device", "flash", "pack", "probe", "project", "rtt", "target"
]