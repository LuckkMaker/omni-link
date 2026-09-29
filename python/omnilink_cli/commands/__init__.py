"""命令注册包：放置各命令模块，由 cli.py 统一采集注册。"""

from . import backend as backend
from . import commander as commander
from . import device as device
from . import flash as flash
from . import probe as probe
from . import rtt as rtt
from . import target as target

__all__ = ["backend", "commander", "device", "flash", "probe", "rtt", "target"]