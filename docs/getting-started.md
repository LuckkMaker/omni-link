# 快速开始

OMNI Link 提供两种使用方式：直接下载安装包使用，或从源码构建开发。

## 使用

### 下载安装

前往 [GitHub Releases](https://github.com/LuckkMaker/omni-link/releases/latest) 下载最新版本的安装包 `OMNI Link-x.x.x-x64-setup.exe`。

双击运行安装包，按向导完成安装。安装包已内置 Python 后端与 pyOCD 源码，无需额外配置 Python 环境。

### 连接硬件

1. 通过 USB 将 DAPLink 仿真器连接到电脑
2. 用 SWD 排线将仿真器接到目标开发板（SWDIO、SWCLK、GND、VTref 四根线至少接通）
3. 启动 OMNI Link，顶部设备切换器会自动检测已连接的探针
4. 选择探针后，应用会尝试自动识别目标芯片型号；若识别为通用 `cortex_m`，需在设备面板手动选择具体型号

> 首次连接时 pyOCD 可能识别为通用 `cortex_m` 类型（无 Flash 布局信息），此时需手动选择具体 MCU 型号以获取正确的 Flash 参数。

### 首次使用流程

1. 连接 DAPLink 仿真器与目标开发板
2. 启动 OMNI Link，在顶部设备切换器中选择探针
3. 选择目标芯片型号（或使用自动识别结果）
4. 进入 [Flash](guide/flash.md) 页面加载固件并烧录
5. 使用 [Commander](guide/commander.md) 交互调试，或 [RTT Viewer](guide/rtt-viewer.md) 收发实时数据，或 [Monitor](guide/monitor.md) 监控变量波形

## 开发

### 环境要求

- **Node.js** 20+
- **Python** 3.11+（需包含 venv 模块）
- **DAPLink 仿真器**（CMSIS-DAP v1 或 v2），也可以是 JLink、STLink 等支持的探针
- **目标 MCU 开发板**（建议 STM32 系列用于首次测试）
- Windows 10 或更高版本

### 安装依赖

```bash
# 安装前端依赖
npm install

# 创建 Python 虚拟环境并安装依赖
# Windows（使用系统 Python，非 TRAE 内置版本）
C:\Users\<用户名>\AppData\Local\Programs\Python\Python311\python.exe -m venv .venv
.venv\Scripts\pip.exe install -r python/requirements.txt
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

### 打包

```bash
# 一体化打包（构建前端 + PyInstaller 打包后端 + electron-builder 生成 NSIS 安装包）
npm run package

# 清理后重新打包
npm run package:clean
```

打包产物：`release/OMNI Link-0.3.3-x64-setup.exe`（NSIS 安装包）
