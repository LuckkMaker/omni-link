"""OMNI Link CLI

通过复用 OMNI Link Python 后端的 REST/WebSocket 接口，以命令行方式开放
探针管理、Flash 烧录、RTT、Monitor、Commander 等能力。本模块为能力层的
瘦客户端，不复制任何后端业务逻辑。
"""

__version__ = "0.1.0"