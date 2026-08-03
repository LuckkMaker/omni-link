# 架构与技术栈

OMNI Link 采用 Electron + Python 前后端分离架构。前端负责 UI 渲染与交互，后端通过 pyOCD 与硬件通信，两者通过 HTTP 与 WebSocket 双通道连接。

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Electron 33 + Vite 5 | 跨平台桌面应用，electron-vite 构建 |
| 前端框架 | React 18 + React Router 6 | 页面路由，每个工具一个页面 |
| 语言 | TypeScript 5 | 全量类型检查 |
| UI 组件 | shadcn/ui (Radix) + Tailwind CSS 3 | 组件化 UI，可定制 |
| 状态管理 | Zustand 5 | 轻量级状态管理，按模块拆分 store |
| 终端 | xterm.js 5（`@xterm/xterm` + `addon-fit` + `addon-web-links`） | Commander / RTT 终端渲染 |
| 图表 | uPlot 1.6（Monitor 波形）、ECharts 6（Map Analyzer） | 高性能时序波形 + 内存分布可视化 |
| 通信 | Axios、WebSocket（ws 8） | HTTP 请求 + 实时数据推送 |
| 布局 | react-resizable-panels | 面板可拖拽调整 |
| 后端 | Python + FastAPI 0.115 + uvicorn 0.34 | 硬件交互层，REST + WebSocket |
| 硬件库 | pyOCD（源码内置 `python/pyocd/`） | DAPLink 通信与 Flash 操作 |
| 解析库 | pyelftools、capstone | ELF/DWARF 解析、ARM 反汇编 |
| USB 后端 | libusb / hidapi（pyOCD 依赖） | CMSIS-DAP v1/v2 通信 |
| 打包 | PyInstaller（后端）+ electron-builder + NSIS（前端安装包） | 前后端一体化打包 |

## 系统架构

```
┌─────────────────────────────────────────────────┐
│                Electron 应用                      │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │          Renderer Process (React)            │ │
│  │   Flash / Commander / RTT / Monitor / Tools  │ │
│  │        shadcn/ui + Tailwind CSS              │ │
│  └────────────────┬────────────────────────────┘ │
│                   │ IPC (contextBridge)            │
│  ┌────────────────┴────────────────────────────┐ │
│  │          Main Process (Electron)             │ │
│  │     Python Bridge (子进程管理 + 端口发现)      │ │
│  └────────────────┬────────────────────────────┘ │
│                   │ HTTP (Axios) + WebSocket       │
│  ┌────────────────┴────────────────────────────┐ │
│  │       Python Backend (FastAPI + pyOCD)       │ │
│  │    REST API  ·  WebSocket 事件推送             │ │
│  │         BackendInterface 抽象层               │ │
│  └────────────────┬────────────────────────────┘ │
│                   │ USB                           │
│           ┌───────▼───────┐                      │
│           │   DAPLink     │                      │
│           │   仿真器      │                      │
│           └───────┬───────┘                      │
│                   │ SWD/JTAG                     │
│           ┌───────▼───────┐                      │
│           │  目标 MCU      │                      │
│           │  (Cortex-M)   │                      │
│           └───────────────┘                      │
└─────────────────────────────────────────────────┘
```

Electron 主进程启动时 spawn Python 子进程运行 FastAPI 服务，通过 stdout 首行 JSON `{"port": 12345}` 传递动态分配的端口号。前端通过 preload 暴露的 IPC API 获取端口后，使用 HTTP（Axios）与 WebSocket（ws 8）双通道与 Python 后端通信：HTTP 用于命令请求，WebSocket 用于实时事件推送（探针状态、Flash 进度、Monitor 采样数据、RTT 数据等）。pyOCD 源码内置在 `python/pyocd/`，随项目分发，不通过 pip 安装，保证版本一致与离线可用。

## 项目结构

```
omni-link/
├── electron/                    # Electron 主进程
│   ├── main.ts                  # 窗口创建、生命周期、IPC 路由
│   ├── preload.ts               # contextBridge 安全暴露 API
│   └── python-bridge.ts         # Python 子进程管理（启动/停止/端口发现）
│
├── src/                         # React 渲染进程
│   ├── pages/                   # 路由页面
│   │   ├── flash/               # Flash 烧录工具
│   │   │   ├── index.tsx
│   │   │   ├── components/      # HexViewer / FilePanel / TabBar / FlashProgress ...
│   │   │   └── utils/           # sectors.ts
│   │   ├── commander/           # Commander 命令行
│   │   │   ├── index.tsx
│   │   │   └── components/      # Terminal / CommandSidebar
│   │   ├── rtt/                 # RTT Viewer
│   │   │   ├── index.tsx
│   │   │   ├── components/      # RttTerminal / RttTabBar / ConfigPanel ...
│   │   │   └── hooks/           # useRecordToFile
│   │   ├── monitor/             # Monitor 变量监控
│   │   │   ├── index.tsx
│   │   │   └── components/      # WaveformChart / ChannelPanel / WatchPanel
│   │   ├── tools/               # 工具集
│   │   │   ├── index.tsx
│   │   │   ├── fault-analyzer.tsx
│   │   │   ├── map-analyzer.tsx
│   │   │   ├── number-converter.tsx
│   │   │   └── file-checksum.tsx
│   │   └── settings/            # 全局设置
│   ├── components/              # 通用组件
│   │   ├── ui/                  # shadcn/ui 基础组件
│   │   ├── layout/              # DeviceSwitcher / StatusBar
│   │   ├── LogConsole.tsx
│   │   ├── NotificationContainer.tsx
│   │   └── TargetDeviceDialog.tsx
│   ├── stores/                  # Zustand 状态管理
│   │   ├── flash.store.ts
│   │   ├── commander.store.ts
│   │   ├── rtt.store.ts
│   │   ├── monitor.store.ts
│   │   ├── tools.store.ts
│   │   ├── probe.store.ts
│   │   ├── notification.store.ts
│   │   └── ui.store.ts
│   ├── services/                # API 服务层
│   │   ├── api.ts               # HTTP 客户端
│   │   ├── ws.ts                # WebSocket 客户端
│   │   ├── probe.service.ts
│   │   ├── target.service.ts
│   │   ├── device.service.ts
│   │   ├── flash.service.ts
│   │   ├── file.service.ts
│   │   ├── commander.service.ts
│   │   ├── rtt.service.ts
│   │   ├── monitor.service.ts
│   │   └── system.service.ts
│   ├── hooks/                   # 通用 hooks
│   │   ├── useBackendStatus.ts
│   │   ├── useProbeWs.ts
│   │   └── useRttSession.ts     # RTT 全局会话（跨页面不停止）
│   ├── layouts/                 # MainLayout（三段式布局）
│   ├── config/                  # terminal-themes.ts
│   ├── lib/                     # utils.ts（cn 等工具函数）
│   ├── utils/                   # checksum.ts 等工具
│   ├── shared/                  # 共享类型定义
│   └── styles/                  # 全局样式（globals.css）
│
├── python/                      # Python 后端
│   ├── server.py                # FastAPI 入口（版本 0.3.3）
│   ├── api/                     # REST 路由
│   │   ├── probes.py            # 探针管理
│   │   ├── targets.py           # 目标芯片
│   │   ├── devices.py           # 设备目录
│   │   ├── flash.py             # Flash 操作
│   │   ├── files.py             # 文件解析
│   │   ├── commander.py         # Commander REPL
│   │   ├── rtt.py               # RTT 会话
│   │   ├── monitor.py           # Monitor 采样
│   │   ├── tools.py             # Fault/Map 分析
│   │   └── system.py            # 系统信息
│   ├── core/                    # 核心抽象层
│   │   ├── interface.py         # BackendInterface 抽象基类
│   │   ├── pyocd_backend.py     # pyOCD 实现
│   │   ├── commander_backend.py # Commander 会话管理
│   │   ├── rtt_backend.py       # RTT 会话管理
│   │   ├── monitor_backend.py   # Monitor 采样管理
│   │   ├── map_parser.py        # .map 文件解析
│   │   ├── database.py          # 设备数据库
│   │   ├── events.py            # WebSocket 事件系统
│   │   ├── probe_monitor.py     # 探针热插拔监控
│   │   └── command_examples.py  # Commander 示例命令
│   ├── pyocd/                   # pyOCD 源码（内置，不通过 pip 安装）
│   ├── data/                    # 设备信息（device_info.json / devices.db）
│   ├── flm/                     # Flash 算法文件（.FLM）
│   ├── build.py                 # PyInstaller 打包脚本
│   └── requirements.txt
│
├── samples/                     # 测试固件
│   ├── GPIO_Toggle.bin
│   └── GPIO_Toggle.hex
│
├── docs/                        # 文档
│   ├── architecture.md          # 架构与技术栈
│   ├── modules.md               # 功能模块详解
│   ├── api.md                   # 后端 API 参考
│   ├── ui-rules.md              # UI 设计规则
│   └── pyocd-reference.md       # pyOCD 命令参考手册
│
├── build.ps1                    # 一体化打包脚本
└── package.json
```
