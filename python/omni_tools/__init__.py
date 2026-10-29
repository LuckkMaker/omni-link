# OMNI Link - OMNI Tool 上位机模块
# Copyright (c) 2026 LuckkMaker
# SPDX-License-Identifier: MIT
"""OMNI Tool（多功能调试工具）配套上位机后端。

自包含模块，不依赖 api/ 或 core/ 的既有页面逻辑，仅在 server.py 处注册路由。
覆盖：boot 自升级（App -> Bootloader -> 擦除/下载/校验/跳转 -> App）。
"""