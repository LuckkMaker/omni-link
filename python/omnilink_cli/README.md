# OMNI Link CLI（`omni`）

把 OMNI Link 的能力（探针、烧录、RTT、设备库、Commander）以命令行方式开放出来，便于脚本化、CI 与自动化测试。

## 定位

`omnilink_cli` 是**后端能力的瘦客户端**：所有命令都通过 HTTP 复用 OMNI Link Python 后端已有的 REST 接口，**不复制任何业务逻辑**。因此它零第三方依赖（只用标准库 `urllib`），并且行为与前端界面始终一致。

```
omni (本包)  ──HTTP──▶  OMNI Link Python 后端 (server.py)  ──▶  调试探针 ──▶  目标芯片
```

这意味着：**执行任何实际命令前，都需要有一个正在运行的后端**。唯一例外是 `omni backend` 自身（负责拉起/停止后端）。

## 安装

### 方式一：wheel 安装（推荐，日常测试）

```powershell
cd D:\workspace\embedded\omni-link
powershell -File python\scripts\cli-package.ps1
```

该脚本会：`uv build --wheel` → `uv pip install` 到 `.venv` → 记录后端目录 → 验证 `omni --version`。

安装后 `omni` 位于 `.venv\Scripts\omni.exe`，激活 venv 后可直接使用：

```powershell
omni --version
omni -h
```

可用参数：

| 参数 | 说明 |
| --- | --- |
| `-NoBuild` | 跳过构建，仅重装已有 wheel |
| `-StartBackend` | 安装后顺带启动常驻后端 |

### 方式二：源码直接运行（开发调试）

```powershell
cd D:\workspace\embedded\omni-link\python
& "..\.venv\Scripts\python.exe" -m omnilink_cli probe list
```

源码态无需安装，改完代码立即生效；缺点是每次要带解释器和 `-m`。

> 两种方式并存：wheel 安装后源码改动需要重跑一次 `cli-package.ps1` 才会生效。

## 快速开始

```powershell
# 1) 启动常驻后端（只需一次）
omni backend start

# 2) 查看探针
omni probe list

# 3) 连接目标芯片
omni probe connect 852001270 --target stm32f407xg

# 4) 读内存 / 烧录
omni commander exec read32 0x080000C0 4
omni flash program .\app.hex

# 5) 用完停掉后端
omni backend stop
```

## 后端连接的三种模式

| 模式 | 用法 | 适用场景 |
| --- | --- | --- |
| **常驻** | `omni backend start` 后用普通命令 | 连续多次操作，最省事 |
| **托管** | 任意命令加 `--managed` | 单条命令即用即走，执行完自动关停后端 |
| **附加** | `--backend-port 57123` | 后端已由前端/手动启动，直接接管 |

端口查找顺序：`--backend-port` → 常驻运行时记录 → `backend.config.json` → `OMNI_BACKEND_PORT`。

## 全局选项

挂在**叶子命令**上（即写在具体子命令之后），例如 `omni probe list --json`：

| 选项 | 说明 |
| --- | --- |
| `--backend-port PORT` | 指定后端端口，优先于其它来源 |
| `--managed` | 临时拉起托管后端，执行完自动关停 |
| `--json` | 输出结构化 JSON，供脚本/CI 消费 |
| `--quiet` | 不输出内容，仅设置退出码 |
| `--timeout SEC` | 后端 HTTP 超时秒数（默认 30） |

> ⚠️ `omni commander exec` 的全局选项**必须写在命令之前**（因其命令参数用 `REMAINDER` 收集）：
> `omni commander exec --uid 852001270 read32 0x080000C0 4` ✅
> `omni commander exec read32 0x080000C0 4 --uid 852001270` ❌

## 命令参考

### `backend` — 后端生命周期

| 子命令 | 说明 |
| --- | --- |
| `start` | 启动常驻后端 daemon（自动分配端口，pid/port 记入运行时文件） |
| `stop` | 停止后端：先走 HTTP 优雅关停；若后端僵死（事件循环被探针操作阻塞）则按端口定位进程树强杀，并等进程真正退出 |
| `status` | 查询运行状态（退出码 0=运行中，1=未运行；端口在监听但 HTTP 无响应会标为「僵死」） |

```powershell
omni backend start
omni backend status
omni backend status --quiet; echo $LASTEXITCODE   # 仅看退出码，适合脚本
omni backend stop
```

`stop` 不依赖运行时记录：即使后端由手动 `python server.py` 或 Electron 主进程拉起，
也能按端口找到并停止，确保 J-Link 等探针句柄被释放。若优雅关停的清理被探针操作卡住，
后端自身的关停看门狗（`api/system.py` `SHUTDOWN_GRACE_S=10s`）会兜底强制退出。

### `probe` — 探针管理

| 子命令 | 说明 |
| --- | --- |
| `list` | 枚举探针（UID / 厂商 / 产品 / 串号 / 连接状态） |
| `connect <uid>` | 连接探针并指定目标芯片 |
| `disconnect <uid>` | 断开探针（等待底层关闭，释放 J-Link 等探针句柄） |
| `status <uid>` | 查询连接状态与目标信息 |
| `target <uid> [--part PART]` | 查询或设置目标型号 |

`connect` 选项：

| 选项 | 说明 |
| --- | --- |
| `--target` | 目标芯片型号（如 `stm32f407xg`） |
| `--interface` | `swd`（默认）/ `jtag` |
| `--speed` | 时钟频率 Hz |
| `--connect-mode` | `attach` 附加不复位 / `halt` 复位并暂停 / `pre-reset` 连接前复位 / `under-reset` 复位下连接 |
| `--jlink-device` | **J-Link 必填**，SEGGER 数据库中的设备名（如 `G32F463XC`） |
| `--force` | 已连接时强制按新参数重连 |

```powershell
omni probe list
omni probe connect 852001270 --target stm32f407xg
omni probe connect 852001270 --target G32F463XC --jlink-device G32F463XC
omni probe status 852001270
omni probe target 852001270 --part stm32f407xg
omni probe disconnect 852001270
```

### `target` — 目标型号

| 子命令 | 说明 |
| --- | --- |
| `list` | 列出后端支持的全部 MCU 型号（`--search` 过滤 / `--limit` 限量） |
| `info <part>` | 查询某型号是否受支持 |

```powershell
omni target list --search stm32f4 --limit 8
omni target info stm32f407xg
```

### `flash` — 烧录 / 擦除 / 校验 / 回读

除 `--uid` 外，各子命令：

| 子命令 | 说明 |
| --- | --- |
| `program <file>` | 烧录固件（hex/bin/elf），默认烧后校验并复位运行 |
| `erase` | 擦除，`--type chip`（默认）/ `sector` / `sector_range` |
| `verify <file>` | 校验 Flash 与固件文件是否一致 |
| `blank-check` | 检查是否空白（默认整个 Flash），返回首个非空地址 |
| `read` | 回读，`--type chip`（默认）/ `range`；`--out PATH` 让后端另存文件 |
| `fill` | 填充内存区域（Flash/RAM），`--addr` `--size` 必填，`--value` 默认 `0xFF` |
| `cancel` | 取消正在进行的 Flash 操作 |
| `reset` | 复位目标，`--type hw`（默认）/ `sw`；`--no-run` 复位后停在暂停态 |

```powershell
omni flash program .\app.hex
omni flash program .\app.bin --base-address 0x08000000 --no-reset
omni flash verify .\app.hex
omni flash blank-check --addr 0x08000000 --size 64
omni flash read --type range --addr 0x08000000 --size 64 --json
omni flash erase --type chip
omni flash reset --no-run
```

> ⚠️ `program` / `erase` / `fill` 会真实改写芯片内容，执行前请确认目标板可擦写。

### `commander` — pyOCD Commander

直接复用后端的 pyOCD 命令系统（`reg` / `read32` / `write32` / `break` / `step` / `disasm` 等）。

| 子命令 | 说明 |
| --- | --- |
| `exec <command...>` | 执行单条命令 |
| `shell` | 交互式 REPL；`--command CMD` 可非交互批量执行（`;` 分隔） |

```powershell
omni commander exec list                     # 列出全部可用命令
omni commander exec help read32              # 查看某命令用法
omni commander exec read32 0x080000C0 4
omni commander exec reg
omni commander shell                         # 进 REPL，连续调试最省事
omni commander shell --command "status; reg"
```

### `debug` — 调试控制

源码级调试工作台，复用后端 `/api/probes/{uid}/zone/*` 接口。**会话状态（是否已加载 ELF、
断点表、目标是否暂停）保存在后端**，因此每条 `omni` 命令都是独立进程：`elf load` 之后
可直接在下一条命令里下断点、读寄存器，无需在同一进程内维持会话。

| 子命令 | 说明 |
| --- | --- |
| `status` | 查询目标状态（halted/running + PC） |
| `halt` | 暂停目标 |
| `run` | 继续运行（continue） |
| `step` | 单步，`--mode into`（默认）/ `over` / `out` |
| `reset` | 复位，`--mode halt`（默认）/ `run` / `break-symbol`（复位运行并停在入口符号） |
| `run-to-cursor` | 运行到 `--file` + `--line` 后暂停 |
| `elf load <path>` | 加载 ELF/AXF（后端按 uid 保存；下断点与源码查询的前提） |
| `elf info` | 查询已加载的 ELF |
| `src files` | 列出 ELF 中的源文件（`--filter` 过滤） |
| `src line --addr A` | 地址反查源码位置（文件 / 行 / 函数） |
| `bp add --file F --line L` | 按源码行设置断点（`--mode break/log/execute`，`--condition` 条件） |
| `bp list` | 列出全部断点 |
| `bp del` / `bp enable` / `bp disable` | 删除 / 启用 / 停用断点 |
| `bp clear` | 清除全部断点 |
| `regs` | 读取 CPU 核心寄存器（`--filter` 过滤，如 `pc` / `r1`） |
| `mem read --addr A` | 读取内存并 hex dump（`--size` 字节数） |
| `mem resolve <expr>` | 解析地址表达式（hex / `&符号` / `name[下标]`） |
| `mem usage` | 内存占用统计（Flash/RAM 分类与 Section 明细） |
| `stack [--locals]` | 调用栈回溯（`--locals` 同时展开每帧局部变量/形参） |
| `locals` | 当前函数局部变量/形参（需目标暂停） |
| `disasm --addr A` | 反汇编（`--length` 字节数 / `--count` 指令条数） |
| `functions` | 列出函数（`--filter` / `--offset` / `--limit`） |
| `callgraph --addr A` | 指定函数的直接被调函数（callees） |
| `hover <name>` | 悬停求值：函数地址 / 变量值 |
| `watch eval <expr>` | 表达式求值（`var.field` / `arr[i]` / `*ptr` / `&x`） |
| `watch set` | 写内存或寄存器（`--address` 或 `--register`，`--value` 必填） |
| `periph list` | 列出外设（名称/基址/寄存器数） |
| `periph regs <name>` | 读取外设寄存器值（`--filter` 过滤寄存器名） |
| `periph nvic` | NVIC 中断源状态（使能/挂起/活动/优先级） |
| `periph scb` / `periph systick` | SCB / SysTick 内核寄存器（含位域分解） |
| `src content <file>` | 读取源文件内容（`--start` / `--end` 限定行范围） |
| `src search <query>` | 全部源文件文本搜索（`--limit` 限量） |
| `src symbol <name>` | 按名字解析符号定义位置 |
| `session list` | 列出已保存的会话配置 |
| `session save <name>` | 保存会话配置（`--file` 读 JSON 文件，或 `--data` 直接给 JSON） |
| `session load <name>` / `session del <name>` | 读取 / 删除会话配置 |

`bp del` / `bp enable` / `bp disable` 支持两种定位方式（二选一）：`--address`（hex 或符号）
或 `--file` + `--line`。符号地址与源码行断点地址常落在**同一函数的不同位置**，命令内部按
「精确 → Thumb 位归一 → 同函数」三级匹配对齐，因此 `--address main` 也能命中按行设置的断点。

```powershell
omni debug elf load .\app.axf                       # 1) 加载 ELF（后端按 uid 保存）
omni debug src files --filter main                  # 2) 找源文件
omni debug bp add --file main.c --line 93           # 3) 下断点（回显落点地址）
omni debug reset --mode halt                        # 4) 复位并暂停
omni debug run                                      # 5) 继续运行，命中后自动暂停
omni debug status                                   # 6) 查看状态与 PC
omni debug regs --filter pc                         # 7) 读寄存器
omni debug mem read --addr 0x20000000 --size 64     # 8) 看内存
omni debug bp list                                  # 9) 查看断点
omni debug bp clear                                 # 10) 清除全部断点
```

命中后查看现场（调用栈 / 局部变量 / 反汇编 / 外设 / 表达式求值）：

```powershell
omni debug stack --locals                           # 调用栈 + 每帧局部变量
omni debug locals                                   # 当前函数局部变量/形参
omni debug disasm --addr main --count 20            # 反汇编 main 前 20 条
omni debug functions --filter gpio                  # 列出含 gpio 的函数
omni debug mem usage                                # Flash/RAM 占用
omni debug watch eval "counter"                     # 求值表达式
omni debug hover main                               # 查看符号地址/类型
omni debug periph list                              # 外设列表
omni debug periph regs GPIOA --filter ODR           # 读 GPIOA 寄存器
omni debug periph nvic                              # 中断源状态
omni debug periph scb                               # SCB 内核寄存器
omni debug session save my-session --file cfg.json  # 保存会话配置
```

> ⚠️ `reset --mode break-symbol` 依赖**板载固件与 ELF 一致**：后端复位后运行，并在入口符号
> （如 `main`）处下临时断点；若 8s 内未命中会提示确认固件与 ELF 是否匹配。断点若落在实际
> 不执行的地址上，命令不报错但也不会命中——可先用 `src line` 确认目标地址确有所属源码行。
>
> ℹ️ `bp clear` 会清空目标上**全部**硬件断点，包括通过 `commander exec break` 直接设置的
> 断点（二者共用 pyOCD 的断点管理器）。

### `device` — 设备应用库

设备目录有三种来源：`builtin`（内置，只读）、`pack`、`flm`（自定义）。增删改只作用于用户库。

| 子命令 | 说明 |
| --- | --- |
| `list` | 列出设备（`--search` / `--source` / `--limit`） |
| `info <part>` | 查询单个设备详情 |
| `summary` | 各来源数量统计 |
| `create <json_file>` | 按 JSON 新增设备 |
| `update <part> <json_file>` | 按 JSON 更新设备（内置型号只读） |
| `delete <part> [-y]` | 删除设备（内置型号只读） |
| `custom <flm>` | 用 `.FLM` 算法文件创建自定义芯片 |
| `reimport` | 从 `device_info.json` 重新导入初始数据 |

`custom` 必填参数：`--part-number` `--flash-base` `--flash-size`(KB) `--ram-base` `--ram-size`(KB)；可选 `--core`（默认 `Cortex-M4`）`--vendor` `--display-name`。

```powershell
omni device summary
omni device list --search G32
omni device info g32f463xc
omni device custom .\G32F463.FLM --part-number MYCHIP --flash-base 0x08000000 `
    --flash-size 1024 --ram-base 0x20000000 --ram-size 128
omni device delete MYCHIP -y
```

### `rtt` — SEGGER RTT

| 子命令 | 说明 |
| --- | --- |
| `status` | 查询 RTT 会话状态 |
| `start` | 启动 RTT 会话（`--address` / `--size` 指定控制块搜索范围，`--up-channel` / `--down-channel` 选通道） |
| `stop` | 停止 RTT 会话 |
| `channels` | 列出 up/down 通道 |
| `send` | 发送数据：`--base64 DATA` 或 `--text TEXT`（`--no-newline` 关闭自动换行），`--channel` 指定通道 |
| `device run\|halt\|status\|reset` | 目标内核控制；`reset` 会重新初始化 RTT 控制块，`--no-run` 复位后停在暂停态 |

```powershell
omni rtt start --uid 852001270
omni rtt channels --uid 852001270
omni rtt send --uid 852001270 --text "hello"
omni rtt device halt --uid 852001270
omni rtt device reset --uid 852001270
omni rtt stop --uid 852001270
```

## 退出码约定

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 业务失败或运行错误（错误信息输出到 stderr，前缀 `错误:`） |
| `2` | 用法错误：未指定子命令、`argparse` 参数错误、`omni rtt device` 未带子命令 |

脚本中判断后端是否存活：

```powershell
omni backend status --quiet
if ($LASTEXITCODE -ne 0) { omni backend start }
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OMNI_BACKEND_DIR` | 后端根目录（含 `server.py`）。wheel 安装后用于定位后端 |
| `OMNI_BACKEND_SERVER` | 直接指定 `server.py` 路径，优先级最高 |
| `OMNI_BACKEND_PORT` | 后端端口覆盖（与 Electron 主进程一致） |

`server.py` 定位优先级：`OMNI_BACKEND_SERVER` → `OMNI_BACKEND_DIR` → 包内 `cli.config.json`（由 `cli-package.ps1` 安装时写入）→ 源码树布局。

## 运行时文件

均位于包目录（`.venv\Lib\site-packages\omnilink_cli\` 或源码目录）：

| 文件 | 说明 |
| --- | --- |
| `cli.config.json` | 持久化的后端目录（wheel 安装时写入） |
| `.backend_runtime.json` | 常驻后端的 pid / port 记录 |
| `.backend.log` | 后端 stderr 日志，启动失败时排查用 |
| `.backend.handshake.jsonl` | 常驻模式握手文件（stdout 重定向） |

## 测试

```powershell
cd D:\workspace\embedded\omni-link\python

# 安全子集：自检 + 探针/目标 + 设备库 + Commander（不写 Flash）
powershell -File scripts\cli-smoke.ps1 -UseInstalled

# 追加破坏性回环：program → verify → blank-check → erase → blank-check
powershell -File scripts\cli-smoke.ps1 -UseInstalled -Firmware .\app.hex

# 追加调试控制段：elf load → src files → bp add/list/del → regs → mem → stack/locals/disasm → periph → session
powershell -File scripts\cli-smoke.ps1 -UseInstalled -Elf .\app.axf
```

`-UseInstalled` 表示使用 venv 中已安装的 `omni.exe`；省略则用源码 `python -m omnilink_cli`。脚本会自行拉起后端、自动取第一个探针，结束时清理进程，每条命令后打印 `exit=`。

## 常见问题

**`错误: 未找到正在运行的后端`**
先 `omni backend start`，或给命令加 `--managed`。

**`错误: 未找到后端 server.py: ...\site-packages\server.py`**
wheel 安装后未记录后端位置。重跑 `python\scripts\cli-package.ps1`，或临时设置 `OMNI_BACKEND_DIR` 指向 `python\` 目录。

**J-Link 连不上目标**
必须用 `--jlink-device` 指定 SEGGER 数据库中的设备名（大小写敏感），例如 `--jlink-device G32F463XC`。该名称与 CMSIS-PACK 型号不一定相同。

**`错误: incorrect number of arguments`**
命令参数个数或格式有误，常见是地址被拆成多个 token。用 `omni commander exec help <命令>` 查用法，例如 `read32 0x080000C0 4`（地址是一个 token）。

**`device info` 查不到型号**
设备库中型号为小写（如 `g32f463xc`），查询时需保持一致。

**改了源码但 `omni` 行为没变**
wheel 安装态用的是 site-packages 中的副本，重跑 `cli-package.ps1` 重新安装即可。