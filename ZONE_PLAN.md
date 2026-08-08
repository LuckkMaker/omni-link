# Zone 页面开发计划

> 文档状态：草案，待评审
> 更新日期：2026-08-07
> 关联代码库：`d:\workspace\embedded\omni-link`
> 参考项目：[Eclipse CDT Cloud](https://github.com/orgs/eclipse-cdt-cloud/repositories) 系列

## 1 背景与目标

Commander 页面以终端交互为核心，命令行是页面主体。随着外设寄存器视图、内存视图、RTOS 视图等调试能力逐渐引入，仅靠终端已难以承载可视化调试工作台的角色。为此新增 **Zone 页面**，采用类似 SEGGER Ozone 的布局：以源码/反汇编为主视图，检查器面板停靠在侧，终端与日志退居辅助。

Zone 的目标是成为一个轻量级可视化调试工作台，让 halt/step/continue 等调试操作与寄存器、外设、内存等状态查看在同一界面内联动完成。

## 2 现状调研结论

| 能力 | 现状位置 | 对 Zone 的支撑 |
|---|---|---|
| 命令执行 | `python/core/commander_backend.py`，复用 pyOCD REPL，支持 `reg/step/halt/read32/disasm` | 调试控制按钮可直接复用 |
| SVD 外设数据 | `target.svd_device` 暴露 `SVDDevice`（外设/寄存器/位域/枚举） | 外设检查器数据源现成 |
| 源码行号 | `DwarfAddressDecoder.get_line_for_address()` 返回源码行 DIE | 源码视图高亮核心 |
| 函数/符号 | `get_function_for_address()` / `get_symbol_for_address()` | 反汇编标注 |
| Halt 事件 | pyOCD `session.notify(Target.Event.POST_HALT, ...)` | 触发视图刷新 |
| 路由 | `MainLayout.tsx` keep-alive 常驻 Commander | Zone 需新增独立路由 |

## 3 目标布局

Ozone 式四区布局：

```
┌─────────────────────────────────────────────────────────┐
│ 顶部工具栏：halt │ step │ 继续 │ reset │ 下载 │ 连接状态  │
├──────────────────────────────────────────┬──────────────┤
│ 源码 / 反汇编 主视图                      │ 右侧检查器dock │
│  · 高亮当前 PC 行                         │  [寄存器][外设] │
│  · 断点红点                               │  [内存][RTOS]  │
│  · 源码/反汇编切换                        │  (多 tab)     │
├──────────────────────────────────────────┴──────────────┤
│ 底部终端控制台（可折叠，保留 REPL 能力）                  │
├─────────────────────────────────────────────────────────┤
│ 全局日志区（各页面共用）                                 │
└─────────────────────────────────────────────────────────┘
```

## 4 分阶段实施计划

### Phase 1 — 页面骨架

新增 `/zone` 路由与页面空壳，搭建 Ozone 式四区布局骨架。

- 后端：无
- 前端：
  - `src/App.tsx`：新增 `/zone` 占位路由
  - `src/layouts/MainLayout.tsx`：`navItems` 增加 `Zone` 入口
  - `src/pages/zone/ZonePage.tsx`：顶部工具栏 + 主视图占位 + 右侧 dock 占位 + 底部终端占位
  - `src/pages/zone/components/`：按四区拆分组件目录
- 验收：打开 `/zone` 显示空布局，无渲染报错，导航可跳转

### Phase 2 — 调试控制工具栏

接通 halt/step/continue/reset，让工具栏具备真实调试能力。

- 后端：无新增（复用 commander exec API）
- 前端：
  - `src/pages/zone/store.ts`（zustand）：保存连接态、运行态（halted/running）、当前 PC
  - `src/services/zoneDebug.service.ts`：封装 halt/step/continue/reset/status 到现有 commander API
  - `src/pages/zone/components/Toolbar.tsx`：按钮绑定 store 动作
- 验收：连接探针后工具栏可 halt/step/继续，状态正确显示

### Phase 3 — 源码 / 反汇编主视图

加载 ELF 后显示源码与反汇编，halt 时高亮当前 PC。

- 后端：
  - 新增 `python/core/elf_backend.py`：提供 ELF 加载后的源码行表、函数表、反汇编列表
  - 新增 `python/api/zone.py`：注册 `/zone/elf`、`/zone/source`、`/zone/disasm` 路由
  - `python/server.py`：挂载 `zone.router`
- 前端：
  - `src/services/zone.service.ts`：封装 zone 后端 API
  - `src/pages/zone/components/SourceView.tsx`：行号 + PC 高亮 + 断点红点
  - `src/pages/zone/components/DisasmView.tsx`：地址 + 指令 + 符号标注，源码/反汇编切换
- 关键实现：源码行号复用 `DwarfAddressDecoder.get_line_for_address()`；反汇编复用现有 `disasm` 命令
- 验收：加载 ELF 后显示源码，halt 后 PC 所在行高亮

### Phase 4 — 右侧检查器 dock（多 tab）

通用停靠容器 + 外设/寄存器/内存检查器。

- 后端：
  - 新增 `python/core/peripheral_backend.py`：外设树元数据 + 寄存器合并块读（参考 svdAddrGapThreshold 策略，合并连续寄存器地址为整块读取）
  - 新增 `python/api/zone.py` 扩展：`/peripherals`、`/peripherals/read`
- 前端：
  - `src/pages/zone/components/InspectorDock.tsx`：通用容器 + TabRegistry 注册制
  - 寄存器 tab：读核心寄存器（复用 `reg` 命令 / `read_core_register`）
  - 外设 tab：外设树 + 寄存器值 + 位域/枚举解码
  - 内存 tab：地址输入 + 字节/字显示（复用 `read_memory`）
- 关键实现：位域枚举解码参考 [vscode-peripheral-inspector](https://github.com/eclipse-cdt-cloud/vscode-peripheral-inspector)（自 cortex-debug 独立而来）；内存按 MAU/Group/Row 分层显示、按字节序分组，参考 [vscode-memory-inspector](https://github.com/eclipse-cdt-cloud/vscode-memory-inspector)
- 验收：面板可切换 tab，外设寄存器值实时显示

### Phase 5 — 联动刷新机制

调试操作后自动刷新源码高亮与检查器。

- 后端：`commander_backend.execute()` 在 halt/step/continue 后调用 `event_manager.emit("zone.halted", ...)` 并携带 PC
- 前端：扩展 `useProbeWs` 或新增 hook，监听 WS `zone.halted` 事件，刷新源码高亮与各检查器 tab
- 刷新策略：提供 On Stop（暂停时刷新）、Periodic（定时刷新，Always/While Running/Off 三档）两种模式，参考 [vscode-memory-inspector](https://github.com/eclipse-cdt-cloud/vscode-memory-inspector) 的自动刷新设计
- 验收：工具栏 step 后，源码高亮与寄存器值同步更新，无需手动刷新

### Phase 6 — 底部终端控制台

复用现有终端组件作为 Zone 底部 REPL 控制台。

- 前端：复用 `src/pages/commander/components/Terminal.tsx`
- 与 Zone store 共享连接/运行状态，命令执行结果同时写入全局日志
- 验收：底部可输入 REPL 命令，与工具栏操作互通

## 5 会话配置持久化

> 对应 Ozone 项目文件（`.jdebug`）能力：保存 ELF 路径、目标设备、连接参数、断点、检查器布局与观测项，打开即可恢复调试环境。Zone 采用**轻量 JSON 会话配置**，不引入脚本语言。

### 5.1 最小字段集（Phase 3 起）

| 字段 | 说明 |
|---|---|
| `elfPath` | 加载的 ELF 路径 |
| `target` | 目标设备/芯片 |
| `probe` | 探针与连接接口参数 |
| `breakpoints` | 断点（地址/行号）列表，Phase 3 断点功能稳定后并入 |

### 5.2 扩展字段集（Phase 4 后逐步并入）

- 检查器 dock 布局与启用的 tab（`InspectorDock` 状态）
- 内存观测项（地址/宽度/分组）
- 外设忽略列表
- 刷新策略模式（On Stop / Periodic）

### 5.3 存储形态

- 前端默认：`localStorage`，复用现有 `zustand persist` 模式（`tools.store` / `rtt.store` 先例），单用户即时恢复。
- 跨环境共享：后端 JSON 导出/导入（走 `zone.service.ts` 与 `zone.py` 路由），符合项目 JSON 快照习惯，不新增脚本语言。

### 5.4 落地节奏

- Phase 3：先支持最小字段集（ELF + 目标 + 连接），保存/加载。
- Phase 4 / 5：布局、断点、内存观测项逐步并入同一会话 JSON。

## 6 参考项目

Zone 页面深度参考 Eclipse CDT Cloud 系列项目的实现思路与技术选型，作为功能与架构的对照基准。

| 项目 | 角色 | 借鉴要点 |
|---|---|---|
| [vscode-memory-inspector](https://github.com/eclipse-cdt-cloud/vscode-memory-inspector) | 内存检查器 | MAU/Group/Row 分层显示模型、字节序分组、变量高亮、On Stop 与 Periodic 自动刷新、多 Debug Session 切换、内存编辑（WriteMemory） |
| [vscode-peripheral-inspector](https://github.com/eclipse-cdt-cloud/vscode-peripheral-inspector) | 外设/寄存器检查器 | SVD 解析与位域/枚举解码、`svdAddrGapThreshold` 寄存器合并块读策略、外设忽略列表、布局保存、外设搜索 |
| [cdt-gdb-adapter](https://github.com/eclipse-cdt-cloud/cdt-gdb-adapter) | Debug Adapter 协议层 | DAP 读写内存/寄存器请求建模、多线程/多栈深度变量、watchpoint 断点、`AdapterRegistry` 能力注册机制 |
| [eclipse-cdt-cloud 组织](https://github.com/orgs/eclipse-cdt-cloud/repositories) | 项目生态总览 | CDT 工具链在调试器、检查器、适配器层的整体架构与协作方式 |

结合本地 `pyOCD` 能力（`target.svd_device`、`DwarfAddressDecoder`、`read_memory`），上述参考项目主要提供**前端交互模型与数据组织方式**的借鉴，底层数据访问仍走现有 pyOCD 后端，避免引入额外调试协议层。

## 7 关键架构决策

1. **终端不删，降级为底部可折叠控制台**：保留 REPL 灵活性，但不占据主视图。
2. **联动刷新用后端口令埋点 + WS 推送**（Phase 5）：Phase 2-4 先做主动拉取，保证前期即可用，Phase 5 再升级为事件驱动。
3. **检查器 dock 采用 TabRegistry 注册制**：为后续 Memory Inspector / RTOS View 预留扩展点。
4. **源码视图数据走专用后端 API**：前端不直接解析 ELF，避免重复造轮子。
5. **会话配置用轻量 JSON，不引入脚本语言**：前端 `localStorage` 保证单用户即时恢复，后端 JSON 导出/导入支持跨环境共享，对应但不复刻 Ozone 的 `.jdebug`。

## 8 涉及文件清单

| 阶段 | 文件 | 变更 |
|---|---|---|
| P1 | `src/App.tsx` | 新增 `/zone` 路由 |
| P1 | `src/layouts/MainLayout.tsx` | `navItems` 增加 Zone |
| P1 | `src/pages/zone/ZonePage.tsx` | 新建，四区布局 |
| P1 | `src/pages/zone/components/*` | 新建，分区组件 |
| P2 | `src/pages/zone/store.ts` | 新建，zustand store |
| P2 | `src/services/zoneDebug.service.ts` | 新建 |
| P2 | `src/pages/zone/components/Toolbar.tsx` | 新建 |
| P3 | `python/core/elf_backend.py` | 新建 |
| P3 | `python/api/zone.py` | 新建 |
| P3 | `python/server.py` | 挂载 zone router |
| P3 | `src/services/zone.service.ts` | 新建 |
| P3 | `src/pages/zone/components/SourceView.tsx` | 新建 |
| P3 | `src/pages/zone/components/DisasmView.tsx` | 新建 |
| P3 | `python/api/zone.py` | 新增 `/zone/session` 保存/加载路由（会话持久化） |
| P3 | `src/services/zone.service.ts` | 增加会话保存/加载方法 |
| P3 | `src/pages/zone/store.ts` | 会话字段接入 `zustand persist` |
| P4 | `python/core/peripheral_backend.py` | 新建 |
| P4 | `python/api/zone.py` | 扩展外设/寄存器 API |
| P4 | `src/pages/zone/components/InspectorDock.tsx` | 新建 |
| P5 | `python/core/commander_backend.py` | halt/step/continue 后 emit 事件 |
| P5 | `src/hooks/useZoneEvents.ts`（或扩展 useProbeWs） | 监听 zone.halted |
| P6 | `src/pages/zone/components/TerminalDock.tsx` | 复用 Terminal.tsx |

## 9 验收标准汇总

- Phase 1 结束：`/zone` 空布局可访问
- Phase 3 结束：ELF 加载后源码可见，PC 行高亮；会话配置可保存/加载，重新打开后恢复 ELF 与目标设备
- Phase 4 结束：外设/寄存器/内存检查器可读值
- Phase 5 结束：step/halt 后视图自动刷新
- Phase 6 结束：终端与工具栏互通，全流程可闭环