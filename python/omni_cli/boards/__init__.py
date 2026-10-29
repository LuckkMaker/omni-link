"""板定义与工程板目录（list / show / check / sync）。"""

from .model import (
    BoardSpec,
    UpstreamFile,
    device_src_dir,
    has_board,
    iter_boards,
    load_board,
    missing_upstream,
    upstream_files,
)
from .scaffold import (
    BOARD_BSP,
    BOARD_CONF,
    BOARD_LAYER,
    check_project,
    sync_project,
)

__all__ = [
    "BOARD_BSP",
    "BOARD_CONF",
    "BOARD_LAYER",
    "BoardSpec",
    "UpstreamFile",
    "check_project",
    "device_src_dir",
    "has_board",
    "iter_boards",
    "load_board",
    "missing_upstream",
    "sync_project",
    "upstream_files",
]
