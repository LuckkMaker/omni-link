# AGENTS.md

本文件是面向 AI 编码助手的项目工作指南。开始修改前先读这里，再按需查阅 `docs/` 下的详细文档。

## 项目定位

OMNI Link 是一站式嵌入式开发工作台（Windows 桌面应用），面向 Arm Cortex-M 调试与烧录，支持 DAPLink / JLink 等探针，兼容 STM32、GD32、APM32、NXP 等芯片，并可通过厂商 Keil Pack 扩展型号。

核心模块：Zone 调试工作台、Flash 烧录、Commander 命令行、RTT Viewer、Monitor 变量监控、OMNI Tool（Boot/Flasher）、Tools 工具集、Settings。

## 技术栈与架构

- 桌面框架：Electron（electron-vite 构建） + Vite 5 + TypeScript 5（strict）
- 前端：React 18 + React Router 6 + Tailwind CSS 3 + shadcn/ui（Radix）+ Zustand 5
- 终端/图表：xterm.js（`@xterm/xterm`）、uPlot（Monitor 波形）、ECharts（Map Analyzer）
- 后端：Python + FastAPI + uvicorn，pyOCD 源码内置在 `python/pyocd/`（**不通过 pip 安装**）
- 通信：Electron 主进程 spawn Python 后端，后端 stdout 首行输出 `{"port": 12345}`；前端经 preload 暴露的 IPC 拿到端口后，用 HTTP（Axios）发命令、WebSocket（ws）收事件
- 打包：PyInstaller 打后端 + electron-builder/NSIS 打安装包（`build.ps1`）

```
electron/main.ts       窗口、生命周期、IPC
electron/preload.ts    contextBridge 暴露 API
electron/python-bridge.ts  Python 子进程管理 + 端口发现

src/pages/*            路由页面（flash / zone / commander / rtt / monitor / omni-tool / tools / settings）
src/components/ui/     shadcn/ui 基础组件
src/components/        通用组件（LogConsole、NotificationContainer 等）
src/stores/            Zustand store，按模块拆分
src/services/          HTTP / WebSocket 服务层
src/hooks/             通用 hooks（RTT 会话为跨页面全局会话）
src/shared/            前后端共享类型
src/styles/globals.css 语义色 CSS 变量

python/server.py       FastAPI 入口
python/api/            REST / WebSocket 路由
python/core/           后端抽象层（BackendInterface + pyocd_backend 等）
python/omni_cli/       omni 命令行工具（commands/ 下按功能拆分）
python/data/           设备信息与数据库
python/flm/            Flash 算法文件
```

说明：`/zone` 与 `/commander` 由 `MainLayout` 以 keep-alive 方式常驻渲染，路由表里只是占位（`element={null}`），实际内容在 `MainLayout` 内。切换页面不会卸载，避免丢失终端/调试状态。

## 常用命令

```powershell
npm install                 # 安装前端依赖
npm run dev                 # 启动 Electron + 渲染进程（开发）
npm run typecheck           # 前后端 TS 类型检查（node + web）
npm run test                # Vitest 纯逻辑测试（src/**/*.test.ts(x)）
npm run build               # electron-vite 生产构建

npm run python:install      # 创建 .venv 并安装后端依赖
npm run python:dev          # 单独启动 Python 后端

npm run package             # 一体化打包（pyinstaller + electron-builder）
npm run package:clean       # 清理后重新打包
```

- 前端测试只覆盖渲染进程纯逻辑，位于被测文件同级的 `*.test.ts(x)`，不启动 Electron/后端。
- Python 测试为 `python/test_*.py`，按需直接运行对应文件（项目未配置 pytest 脚本）。
- 提交前至少跑 `npm run typecheck` 和相关测试。

## 开发约定

### 前端

- 路径别名：`@/*` → `src/*`，`@shared/*` → `src/shared/*`（与 `tsconfig.web.json`、`vitest.config.ts` 保持一致）。
- 状态管理：每个功能模块一个 Zustand store（`src/stores/*.store.ts`），组件内用选择器订阅，避免整 store 订阅。
- 数据访问统一走 `src/services/`，不要在组件里直接拼 Axios/WebSocket 调用。
- 类型：共享类型放 `src/shared/`；禁止滥用 `any`，`npm run typecheck` 必须通过。
- className 合并必须用 `cn()`（`src/lib/utils.ts`），禁止模板字符串拼接。
- 全局通知必须用自研 `useNotificationStore` + `NotificationContainer`（支持历史记录与进度更新）；**禁止使用 sonner toast 或第三方通知库**。
- 图标统一用 `lucide-react`，尺寸用 `size-*` 简写，不用 `h-* w-*`。
- flex 滚动区域记得加 `min-h-0`，否则滚动失效。
- 不要把调试用的临时代码、`console.log`、截图产物提交进仓库。

### Python

- 新增接口：在 `python/api/` 下按模块加路由，并在 `python/server.py` 注册。
- 硬件能力通过 `core/interface.py` 的抽象层扩展，实现放 `core/`，不要在路由里直接操作 pyOCD 对象。
- `python/pyocd/` 为内置源码，修改需谨慎，避免破坏与上游版本的兼容性。
- CLI 子命令放 `python/omni_cli/commands/`，并在 `cli.py` 注册；CLI 与 GUI 共享同一后端进程（通过用户级 `backend.json` 注册表发现端口）。
- 后端版本号 `BACKEND_VERSION`（`server.py`）与前端 `package.json` 版本保持同步。

## UI 设计规则

完整规范见 [docs/rule/ui-rules.md](docs/rule/ui-rules.md)，以下为必须遵守的要点：

- **信息表达优先靠布局**：避免不必要的次要标签和说明文字，让布局本身来传达信息。
- 语义色只用 token（`bg-primary`、`text-muted-foreground`、`border-border`），禁止硬编码；状态色（success/warning/error/info）可用 Tailwind 默认色板。
- 圆角：面板/Section 用直角 + 单方向 `border` 分隔；交互元素 `rounded-md`；Card `rounded-lg`；同层级不可混用。
- 字号：正文 `text-sm`，辅助文字 `text-xs`，Dialog 标题 `text-lg font-semibold`，页面标题 `text-2xl font-bold`。
- 右侧边栏（Commander / RTT / Monitor）统一以 `CommandSidebar` 为基准：Section 用 `border-b border-border last:border-b-0`，标题用 `text-xs font-medium text-muted-foreground`；禁止用 `<Separator />` 分隔 Section，禁止用 `<Label>` 当分区标题。
- hover 态加 `transition-colors`；空状态用居中的 `opacity-40` 图标 + `text-xs` 说明。
- 所有全局通知走 `useNotificationStore`（见上）。

## 提交规范

沿用仓库现有风格：Conventional Commits + 中文描述，格式 `type(scope): 描述`。

- type：`feat` / `fix` / `chore` / `docs` / `test` / `refactor` / `perf` / `style` / `build` / `ci`
- scope 常用：`omni cli`、`flash`、`zone`、`commander`、`rtt`、`monitor`、`build`、`config`、`pyocd`、`release`
- 描述聚焦「为什么改」，一句话说清，不加句号
- 只在用户明确要求时提交；提交前检查 `git status`，不要混入无关文件

## 文档索引

| 文档 | 内容 |
|------|------|
| `docs/tech/architecture.md` | 架构、技术栈、目录结构 |
| `docs/tech/modules.md` | 功能模块详解 |
| `docs/tech/api.md` | 后端 REST / WebSocket API |
| `docs/rule/ui-rules.md` | UI 设计规则（颜色、排版、布局、组件） |
| `docs/tech/pyocd-reference.md` | pyOCD 命令参考 |
| `docs/tech/cli-coverage.md` | CLI 命令覆盖情况 |
| `docs/tech/code-signing.md` | 代码签名流程 |
| `README.md` | 功能概览与内置芯片支持列表 |

## 注意事项

- 项目无 ESLint/Prettier 脚本，格式以现有代码风格为准（2 空格缩进、单引号、无分号）。
- 不要提交构建产物：`out/`、`release/`、`python/build/`、`python/dist/` 已被忽略；`build/installer.nsh` 需随仓库分发。
- 涉及硬件时序/协议的改动，优先查看 `python/core/` 与 `docs/tech/pyocd-reference.md`，不要凭猜测修改。
- 修改 UI 前先读 `docs/rule/ui-rules.md`，遵循已有 Section/工具栏/通知模式，避免引入第二套视觉语言。
