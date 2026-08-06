# OMNI Link

嵌入式开发工具集，提供类似 SEGGER J-Link 工具链的完整体验，以开源 pyOCD + DAPLink 硬件为基础，降低嵌入式开发者的工具成本。

![OMNI Link Advertisement](assets/images/advertisement.png)

## 项目简介

OMNI Link 是一个跨平台桌面应用，内置 Flash 烧录、交互式命令行、RTT 实时数据收发、变量波形监控等核心调试能力，对标 SEGGER J-Link 工具链。底层基于开源的 pyOCD，支持 DAPLink / ST-Link / J-Link 等常见主流调试器，无需额外购买专用调试硬件。

支持 70+ 款 Arm Cortex-M MCU，包括 STM32、GD32、APM32、NXP 等主流系列，通过 CMSIS Device Family Packs 可进一步扩展覆盖范围。

## 功能概览

| 模块 | 对标产品 | 说明 |
|------|----------|------|
| Flash 烧录工具 | J-Flash | 固件烧录、擦除（chip/sector）、校验、回读、Hex 查看器、Fill Memory、Compare |
| Commander 命令行 | J-Link Commander | 交互式 REPL，复用 pyOCD Commander，支持 `source` 命令配置源码路径 |
| RTT Viewer | J-Link RTT Viewer | SEGGER RTT 实时数据收发，多 tab 通道管理，文件发送/录制 |
| Monitor 变量监控 | J-Scope | DWARF 符号解析、SWD/RTT 传输、uPlot 波形图、触发、游标测量 |
| Tools 工具集 | — | Fault Analyzer、Map Analyzer、Number Converter、File Checksum |

### Flash 烧录工具

![Flash 烧录工具](assets/images/flash_page.png)

### Commander 命令行

![Commander 命令行](assets/images/commander_page.png)

### RTT Viewer

![RTT Viewer](assets/images/rtt_viewer_page.png)

### Monitor 变量监控

![Monitor 变量监控](assets/images/monitor_page.png)

### Map Analyzer

![Map Analyzer](assets/images/map_analyzer_page.png)

### Number Converter

![Number Converter](assets/images/number_converter_page.png)

## 文档导航

## 快速开始

```bash
# 安装前端依赖
npm install

# 创建 Python 虚拟环境并安装依赖
npm run python:install

# 启动开发模式
npm run dev
```

详细步骤见 [GitHub 仓库 README](https://github.com/LuckkMaker/omni-link#readme)。

## 许可证

MIT License，Copyright (c) 2026 LuckkMaker。
