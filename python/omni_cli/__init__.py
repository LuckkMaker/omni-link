"""OMNI CLI

调试/烧录类命令通过 OMNI Link Python 后端的 REST/WebSocket 接口工作；
`omni config` 是本地工程构建配置命令，实现在 `omni_cli.config` 内，不经过后端；
`omni boards` 读取框架的板定义，实现在 `omni_cli.boards` 内；
`omni modules` 生成模块注册表，实现在 `omni_cli.modules` 内；
`omni build` 做 CMake 配置与构建，实现在 `omni_cli.build` 内。
"""

__version__ = "0.12.0"
