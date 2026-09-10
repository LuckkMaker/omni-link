# OMNI Link

[![Version](https://img.shields.io/github/v/release/LuckkMaker/omni-link)](https://github.com/LuckkMaker/omni-link/releases/latest)
[![License](https://img.shields.io/github/license/LuckkMaker/omni-link)](https://github.com/LuckkMaker/omni-link/blob/main/LICENSE)

OMNI Link 是一站式嵌入式开发工作台，提供 Zone 代码和性能调试、 Flash 烧录、Commander 交互式命令行、RTT Viewer 实时数据收发、Monitor 变量波形监控等核心调试功能，支持 DAPLink、JLink 等工具接入，适用于 STM32、GD32、APM32、NXP 等主流 Arm Cortex-M MCU 系列，支持厂商提供的 Keil Pack 包扩展芯片型号。

![Advertisement](assets/images/advertisement.png)

## 功能概览

| 模块 | 说明 |
|------|------|
| Zone 调试工作台 | 源码调试、汇编窗口、寄存器、外设、调用栈、Watch 变量监视与内存查看整合于一个视图，全链路可视化调试 |
| Flash 烧录工具 | 固件烧录、擦除（chip/sector）、校验、回读、Hex 查看器、Fill Memory、Compare |
| Commander 命令行 | 交互式 REPL，`source` 命令配置源码路径 |
| RTT Viewer | RTT 实时数据收发，多 tab 通道管理，文件发送/录制 |
| Monitor 变量监控 | DWARF 符号解析、SWD/RTT 传输、uPlot 波形图、触发、游标测量 |
| Tools 工具集 | Fault Analyzer、Map Analyzer、Number Converter、File Checksum |
| Settings | 终端主题、版本信息、增加芯片支持 |

## 内置芯片支持

内置支持以下芯片型号：

### ST

**STM32F0 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| STM32F051 | Cortex-M0 | 64 KB | 8 KB |

**STM32F1 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| STM32F103C8 | Cortex-M3 | 64 KB | 20 KB |
| STM32F103CB | Cortex-M3 | 128 KB | 20 KB |
| STM32F103RB | Cortex-M3 | 128 KB | 20 KB |
| STM32F103RC | Cortex-M3 | 512 KB | 64 KB |
| STM32F103VE | Cortex-M3 | 512 KB | 64 KB |
| STM32F103ZE | Cortex-M3 | 512 KB | 64 KB |
| STM32F103ZG | Cortex-M3 | 1 MB | 96 KB |
| STM32F105RB | Cortex-M3 | 128 KB | 64 KB |
| STM32F105RC | Cortex-M3 | 256 KB | 64 KB |
| STM32F105VC | Cortex-M3 | 256 KB | 64 KB |
| STM32F107RB | Cortex-M3 | 128 KB | 64 KB |
| STM32F107RC | Cortex-M3 | 256 KB | 64 KB |
| STM32F107VC | Cortex-M3 | 256 KB | 64 KB |

**STM32F4 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| STM32F407xG | Cortex-M4 | 1 MB | 192 KB |
| STM32F412xE | Cortex-M4 | 512 KB | 256 KB |
| STM32F412xG | Cortex-M4 | 1 MB | 256 KB |
| STM32F429xG | Cortex-M4 | 1 MB | 256 KB |
| STM32F429xI | Cortex-M4 | 2 MB | 192 KB |
| STM32F439xG | Cortex-M4 | 512 KB | 256 KB |
| STM32F439xI | Cortex-M4 | 2 MB | 192 KB |

**STM32F7 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| STM32F767xx | Cortex-M7 | 2 MB | 512 KB |

**STM32H7 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| STM32H723xx | Cortex-M7 | 1 MB | 176 KB |
| STM32H743xx | Cortex-M7 | 2 MB | 480 KB |
| STM32H750xx | Cortex-M7 | 128 KB | 480 KB |
| STM32H7B0xx | Cortex-M7 | 512 KB | 1.25 MB |

**STM32L0 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| STM32L031x6 | Cortex-M0+ | 32 KB | 8 KB |

**STM32L4 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| STM32L432xC | Cortex-M4 | 256 KB | 64 KB |
| STM32L475xC | Cortex-M4 | 256 KB | 128 KB |
| STM32L475xE | Cortex-M4 | 512 KB | 128 KB |
| STM32L475xG | Cortex-M4 | 1 MB | 128 KB |

### Geehy

**APM32F4 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| APM32F402xB | Cortex-M4F | 128 KB | 32 KB |
| APM32F403xB | Cortex-M4F | 128 KB | 32 KB |
| APM32F405xG | Cortex-M4F | 1 MB | 192 KB |
| APM32F407xE | Cortex-M4F | 512 KB | 192 KB |
| APM32F407xG | Cortex-M4F | 1 MB | 192 KB |
| APM32F411xC | Cortex-M4F | 256 KB | 128 KB |
| APM32F411xE | Cortex-M4F | 512 KB | 128 KB |
| APM32F415xG | Cortex-M4F | 1 MB | 192 KB |
| APM32F417xE | Cortex-M4F | 512 KB | 192 KB |
| APM32F417xG | Cortex-M4F | 1 MB | 192 KB |
| APM32F423xG | Cortex-M4F | 1 MB | 384 KB |
| APM32F425xG | Cortex-M4F | 1 MB | 192 KB |
| APM32F427xG | Cortex-M4F | 1 MB | 448 KB |
| APM32F465xE | Cortex-M4F | 512 KB | 192 KB |

**G32F4 系列**

| 型号 | 内核 | Flash | RAM |
|------|------|-------|-----|
| G32F401x8 | Cortex-M4F | 64 KB | 16 KB |
| G32F463xC | Cortex-M4F | 256 KB | 128 KB |

> APM32F4xx 系列按 Flash 容量合并为通用型号：xB=128 KB、xC=256 KB、xE=512 KB、xG=1 MB，覆盖同容量不同封装的细分型号（如 APM32F407xE 覆盖 APM32F407RE/VE/ZE/IE）。


## Keil Pack 扩展芯片支持

支持通过厂商提供的 Keil Pack 包扩展芯片型号，在设置页面中选 "芯片管理" Tab，点击 "DFP 导入芯片" 按钮选择 `.pack` 文件即可。Pack 文件可从芯片厂商官网下载。

![Chip Import Page](assets/images/chip_import_page.png)

## Zone 调试和性能分析

支持源码调试、汇编窗口、寄存器、外设、调用栈、Watch 变量监视与内存查看整合于一个视图，全链路可视化调试。

![Zone 调试工作台](assets/images/zone_page.png)

## Flash 烧录工具

支持 bin/hex/elf 格式固件烧录，提供整片擦除与扇区擦除两种模式，烧录后可自动校验。Hex 查看器支持 1B/2B/4B 分组显示，配合 Fill Memory 与 Compare 功能完成数据级别的比对与填充操作。左侧设备面板实时显示探针连接状态与目标芯片信息，底部状态栏展示 SWD 接口、通信速率等连接参数。

![Flash 烧录工具](assets/images/flash_page.png)

## Commander 命令行

复用 pyOCD Commander 的交互式 REPL，支持 `reg`、`read32`/`write32`、`halt`/`continue`、`step`、`load`、`erase`、`disasm`、`where`、`symbol`、`elf`、`source` 等命令。`source` 命令参考 GDB 的 `directory`/`substitute-path` 设计，解决跨机器源码路径映射问题。右侧命令面板将 halt/step/reset 等常用命令归类为快捷按钮，并提供「调试」「断点调试」「解锁刷写」三套一键工作流，将多步命令链简化为单击操作。

![Commander 命令行](assets/images/commander_page.png)

## RTT Viewer

RTT 实时数据收发，支持多 tab 通道管理、terminal/bar 两种输入模式、文件发送、录制到 `.dat` 文件。RTT 会话在应用顶层启用，切换页面不中断数据流。右侧配置面板提供 HEX 发送、定时发送、协议校验等选项，终端区域按日志级别（info/debug/warn/error）着色显示，底部状态栏实时展示数据速率与帧计数。

![RTT Viewer](assets/images/rtt_viewer_page.png)

## Monitor 变量监控

通过 DWARF 符号解析自动从 ELF 文件提取变量地址，提供 SWD（HSS 非侵入模式）与 RTT（侵入高速模式）两种传输方式。波形图基于 uPlot 渲染，支持上升沿/下降沿/阈值触发、游标测量、CSV 导出。右侧变量树按源文件分组，勾选即可添加到监视列表；底部表格实时显示变量当前值、最值与移动均值。

![Monitor 变量监控](assets/images/monitor_page.png)

## Tools 工具集

- **Fault Analyzer** — Cortex-M 故障寄存器分析，解析 CFSR/HFSR/MMFSR/BFSR/UFSR 等寄存器，定位 fault 类型与原因
- **Map Analyzer** — ARM `.map` 链接器输出文件解析与可视化（基于 ECharts），分析 ROM/RAM/Stack 占用分布
- **Number Converter** — 十进制/十六进制/二进制互转，支持 32 位逐位点击编辑
- **File Checksum** — CRC32/MD5/SHA-1/SHA-256 校验和计算

Fault Analyzer 解析 Cortex-M 系列 MCU 的故障寄存器，帮助快速定位 HardFault/BusFault/UsageFault/MemoryFault 等异常类型与原因。用户可通过「寄存器值」或「异常类型」两种方式输入，工具将自动解析并显示详细信息。

![Fault Analyzer](assets/images/fault_analyzer_page.png)

Map Analyzer 顶部指标卡汇总 ROM/RAM 总量与 Code/RO Data/RW Data/ZI Data 分布，中部环形图展示 ROM 与 RAM 构成比例，底部柱状图按模块分类排列 Top 15 占用，帮助快速定位体积异常的代码段。

![Map Analyzer](assets/images/map_analyzer_page.png)

Number Converter 支持十进制、十六进制、二进制实时联动转换，32 位位网格可逐位点击翻转，并同步显示字节分解、八进制、ASCII 字符与置位计数。

![Number Converter](assets/images/number_converter_page.png)

## 环境要求

- **Node.js** 20+
- **Python** 3.11+（需包含 venv 模块）
- **DAPLink 仿真器**（CMSIS-DAP v1 或 v2）
- **目标 MCU 开发板**（建议 STM32 系列用于测试）
- Windows 10 或更高版本

## 快速开始

### 安装

```bash
# 安装前端依赖
npm install

# 创建 Python 虚拟环境并安装依赖
# Windows
python -m venv .venv
.venv\Scripts\pip.exe install -r python/requirements.txt
# macOS / Linux
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt
```

或使用 npm 脚本一键创建虚拟环境：

```bash
npm run python:install
```

### 运行

```bash
# 启动 Electron 开发模式（自动启动 Python 后端）
npm run dev
```

开发模式下 Python 后端使用固定端口 `8765`，Electron 通过 IPC 获取端口后前端自动连接。

### 单独运行 Python 后端（调试用）

```bash
# 使用 npm 脚本
npm run python:dev

# 或直接调用
.venv\Scripts\python.exe python/server.py --port 8765
```

### 类型检查

```bash
npm run typecheck
```

### 端口占用与进程清理

开发模式下 Python 后端固定监听 `8765` 端口。若上次后端进程未正常退出，重新启动会遇到绑定失败（`[Errno 10048]`）。使用以下命令查看并清理占用端口的进程：

```powershell
# 1. 查看 8765 端口被哪个进程占用（记录 OwningProcess 列返回的 PID）
Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue |
    Select-Object State, LocalAddress, LocalPort, OwningProcess

# 2. 查看占用进程的详细信息（确认是否为本项目遗留的 Python 进程）
Get-Process -Id <PID> -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, Path, StartTime

# 3. 强制结束该进程
Stop-Process -Id <PID> -Force

# 4. 确认端口已释放（无输出即说明已释放）
Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue
```

> 提示：`Stop-Process` 后端口可能因 `TIME_WAIT` 状态短暂占用，稍等 1-2 秒再启动即可。若存在多个遗留进程，可重复步骤 1-3 直到步骤 4 无输出。

### 打包

```bash
# 一体化打包（构建前端 + PyInstaller 打包后端 + electron-builder 生成 NSIS 安装包）
npm run package

# 清理后重新打包
npm run package:clean
```

## 支持的目标芯片

用户可通过厂商提供的 `Keil Pack` 包增加对新芯片的支持。

## 文档

## 许可证

OMNI Link 采用 [MIT 许可证](LICENSE)，Copyright (c) 2026 LuckkMaker。

内置的 pyOCD 源码采用 [Apache 2.0 许可证](python/pyocd/LICENSE)，Copyright (c) 2006-2026 pyOCD Authors。

## 赞赏

如果这个工具对你有帮助，可以请作者喝杯咖啡。

![Buy Me A Coffee](assets/images/buy_me_a_coffee.jpg)
