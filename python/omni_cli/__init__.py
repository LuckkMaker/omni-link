"""OMNI CLI

调试/烧录类命令通过 OMNI Link Python 后端的 REST/WebSocket 接口工作；
`omni config` 是本地工程构建配置命令，实现在 `omni_cli.config` 内，不经过后端；
`omni boards` 读取框架的板定义，实现在 `omni_cli.boards` 内。
"""

__version__ = "0.9.0"
