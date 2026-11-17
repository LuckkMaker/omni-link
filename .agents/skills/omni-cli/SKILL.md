---
name: "omni-cli"
description: "用 omni CLI（Python 包名 omni_cli）在真实硬件上联调：经本地 HTTP 后端连接探针、烧录/校验/对比/擦除 Flash、抓取 SEGGER RTT 日志、执行 pyOCD Commander 命令、采集 Monitor 变量波形，以及基于 ELF 的源码级调试（断点、寄存器、内存、外设、调用栈）。同时覆盖同一 CLI 的本地工程命令（config/build/boards/modules/toolchain）。适用于实机冒烟测试、RTT 日志断言、运行中目标的寄存器级排查，以及 flash→verify→RTT→断言 的可脚本化 CI 循环。"
---

# OMNI CLI 实机联调

`omni` 把探针、烧录、RTT、Commander、源码级调试和 Monitor 采样统一成命令行，每条命令都带 `--json` 和明确的退出码，因此**实机验证可以写成脚本、放进 CI**。同一二进制还提供 `config` / `build` / `boards` / `modules` / `toolchain` 等本地命令，它们**不需要后端和探针**。

如果你的环境同时装了 `jlink-live-debug` 技能，分工如下：

| 需求 | 用哪个 |
|------|--------|
| 烧录 / 校验 / 对比 / 全片擦除 | **omni**（内置 flash 算法、自动校验、超时语义） |
| RTT 日志抓取与断言 | **omni**（环形缓存 + 游标 + JSONL） |
| 源码级断点、变量求值、外设寄存器、调用栈 | **omni**（ELF 会话保存在后端，跨命令可用） |
| 变量波形、周期采样（1 Hz–1 kHz） | **omni monitor**（SWD HSS 非侵入 / RTT 高速） |
| µs–ms 级连续采样、halt 下直接驱动外设做 A/B | jlink-live-debug（pylink 直连） |

原因：每次 `omni` 调用都是一个新进程 + HTTP 往返，**实测单条命令 0.7–1.1 s**（Python 启动占大头），不适合高频逐条采样；`commander shell --command "a; b; c"` 能在一个进程里批量执行多条命令，`monitor` 则在**后端进程内**连续采样，两者都不受进程启动开销限制。

## 环境与自检

| 项 | 说明 |
|----|------|
| CLI | `omni`（Python 包名 `omni_cli`），版本与 OMNI Link 桌面端/后端同源，以 `omni --version` 为准 |
| 安装 | 便携版：发布包里的 `install.ps1`（装到 `%LOCALAPPDATA%\Programs\OMNI CLI\bin` 并写入用户 PATH）；wheel：`pip install omni_cli-*.whl`；源码态：在仓库根用 `python -m omni_cli` |
| Python | 3.9+；本技能的脚本只用标准库，`python` 在 PATH 即可 |
| 后端 | OMNI Link 桌面端自带的后端，或仓库里的 `python/server.py`；常驻 / `--managed` / `--backend-port` 三种接法 |
| 探针 | DAPLink 或 SEGGER J-Link；UID 用 `omni probe list` 查 |
| 目标 | `--target <part>`（如 `stm32f407xg`）；J-Link 还需 `--jlink-device <SEGGER 设备名>` |
| 固件 | hex / bin / elf 均可；bin 需 `--base-address` |

```powershell
omni --version
omni backend status     # exit 0=运行中，1=未运行
omni system info        # 后端/数据库/Python/pyOCD 版本
omni probe list         # 取探针 UID
omni probe jlink-devices --search STM32F407    # 示例：按前缀查 SEGGER 设备名
omni target info stm32f407xg
omni toolchain          # cmake/ninja/编译器最终解析来源
```

> [!IMPORTANT]
> `--jlink-device` 是 **SEGGER 数据库里的设备名**，和 CMSIS-Pack 的型号字符串不一定相同（有的芯片恰好同名，换芯片时用 `omni probe jlink-devices --search <前缀>` 查）。
> `probe connect` 的 `--target` 是必填项（调试/烧录的芯片型号），与本地命令 `-b/--board`（构建目标板）不是一回事。

## 最小闭环

```powershell
omni backend start
omni probe connect <probe-uid> --target stm32f407xg --jlink-device STM32F407IG --speed 4000000   # 型号按实际替换
omni flash program .\app.hex --json
omni rtt start
omni rtt read --follow --duration 5 --json
omni rtt stop
omni probe disconnect <probe-uid>
omni backend stop
```

构建后直接烧录（runner 会调用 `omni flash program`，仍需后端；在 omni-emb 工程里执行）：

```powershell
omni build -b <board> --project-dir <project> -t flash
```

> [!NOTE]
> `probe connect` 实际默认 `halt`（后端 `connect_mode or 'halt'`，复位并暂停；只有 `-M attach` 才保留现场）。
> 想让它跑起来要 `omni debug run`；而 `omni debug reset` 默认 `--mode halt`，`omni flash reset` 默认复位后运行。

## 命令地图

**硬件类（需要后端）**：

| 区域 | 常用命令 |
|------|---------|
| 后端 | `backend start\|stop\|status`、`system info` |
| 探针 | `probe list\|status\|connect\|disconnect\|target\|jlink-devices` |
| 芯片 | `target list --search stm32f4`、`target info <part>` |
| Pack/设备库 | `pack list\|preview\|import\|remove`、`device list\|info\|summary\|custom\|flm-info` |
| Flash | `flash program\|verify\|compare\|erase\|blank-check\|read\|fill\|reset\|cancel` |
| RTT | `rtt start\|stop\|status\|channels\|read\|send\|device run\|halt\|status\|reset` |
| Commander | `commander exec <cmd...>`、`commander shell --command "a; b"`、`commander reset\|cancel` |
| 调试 | `debug status\|halt\|run\|step\|reset\|run-to-cursor`、`elf load\|info`、`src files\|line\|content\|search\|symbol`、`bp add\|list\|del\|enable\|disable\|clear`、`regs`、`mem read\|resolve\|usage`、`stack\|locals`、`disasm`、`functions`、`callgraph`、`hover`、`watch eval\|set`、`periph list\|regs\|nvic\|scb\|systick`、`session list\|save\|load\|del` |
| Monitor | `monitor status\|elf load\|symbols\|var add\|start\|read\|export` |
| 文件（后端解析） | `file info <bin/hex/elf>` |

**本地类（不需要后端、不需要探针）**：

| 区域 | 命令 |
|------|------|
| 工程配置 | `config generate\|menuconfig\|bsp\|sync-keil` |
| 构建 | `build -b <board> [-c ac6\|gcc\|clang\|ac5] [-t size\|clean\|flash\|run]` |
| 板定义 | `boards list\|show\|check\|sync` |
| 模块注册表 | `modules list\|check\|generate [--check]` |
| 工具链 | `toolchain [--json]` |
| 文件 | `file checksum <file>`（纯本地）、`tool map <file.map>` |

完整参数见仓库内 `python/omni_cli/README.md`，或 `omni <cmd> -h`。

## 核心技巧

### 1. `--json` 是断言接口

| 命令 | 可断言字段 |
|------|-----------|
| `probe status --json` | `state`（connected/disconnected）、`target.part_number`、`target.flash_size` |
| `flash program --json` | `success`、`bytes_written`、`duration_ms`、`rtt_stopped` |
| `flash verify --json` | `success`、`bytes_verified` |
| `flash compare --json` | `success`、`equal`、`mismatch_count`、`first_mismatch`、`compared_bytes`、`total_bytes`、`diffs[].address/.expected/.actual` |
| `flash erase --json` | `bytes_erased`（chip 擦除 = 整片大小） |
| `flash blank-check --json` | `is_blank`、`first_nonblank_addr`、`scanned_bytes`、`total_bytes` |
| `flash read --json` | `success`、`bytes_read`、`base_address`、`output_path`（仅 `--out` 时；`base64_data` 被 CLI 省略） |
| `rtt status --json` | `capture.next_seq` / `buffered_bytes` / `dropped_bytes` / `oldest_seq` |
| `rtt read --json` | `seq`、`channel`、`cursor`、`text`、`lost`、`truncated`、`session_reset`、`oldest_seq`、`next_seq`、`dropped_bytes`、`chunks[].data`(base64) |
| `debug status --json` | `state`（halted/running）、`pc` |
| `debug regs --json` | `registers[].name` / `.value`；目标运行中时返回 `skipped: true` |
| `debug mem read --json` | `address`、`length`、`data_hex`（小端原始字节）；偶发 `skipped: true` |
| `debug mem resolve --json` | `address`、`name`、`size` |
| `debug watch eval --json` | `info.value` / `info.available` / `info.address` |
| `debug periph regs --json` | `values[].address` / `.value` |
| `monitor status --json` | `running`、`rate_hz`、`actual_rate_hz`、`variable_count`、`buffer_size`、`latest_t_ms` |
| `monitor read --json` | `segments[].vars[]`、`segments[].samples[].t_ms` / `.values[]`；`--follow --json` 每行是 `{t_ms, values}` 的 JSONL |

退出码：`0` 成功、`1` 业务/运行失败、`2` 用法错误（含多目标未指定 `-b`）；`omni_config.py` 启动器环境问题返回 `3`。

> [!WARNING]
> `flash compare --json`、`flash blank-check --json`、`flash read --json` **退出码恒为 0**（人类可读模式下 compare 不一致、blank-check 失败才返回 1）。CI 断言必须看 `success`，再叠加 `equal` / `mismatch_count` / `is_blank`。
> `boards check` 在板目录存在时即使有漂移也返回 0（只有缺板目录才返回 1）；`modules generate --check` 漂移时返回 2；`config --stop-on-change` 检测到 Keil 工程变化时返回 2。

`--quiet` 只留退出码，适合 `if ($LASTEXITCODE -ne 0)`。

### 2. RTT：游标、缓存，以及“烧录会打断它”

- 控制块**默认自动检测**；想更快更稳就用 ELF 里的符号直接给地址：

  ```powershell
  omni debug elf load .\app.axf
  omni debug mem resolve "_SEGGER_RTT" --json     # {address, size}
  omni rtt start --address 0x20010020             # 示例地址，按实际解析结果替换
  ```

- **地址会随链接布局变化**。例如把 RAM 盘改成 `.bss.noinit` 后，`_SEGGER_RTT` 从
  `0x20000020` 移到 `0x20010020`；写死地址就会读到旧内容或找不到控制块。
- 后端维护 64 KiB 上行环形缓存，REST / CLI / WebSocket 共用；`lost` / `truncated` 说明被覆盖。
- `rtt start` 会清空抓取缓存，但**同一后端进程内 `seq` 单调递增**：`stop` → `start` 后直接 `read` 就是本轮日志，旧会话的 `next_seq` 也能继续当 `--since` 游标。
- 后端**重启**后 seq 从 1 重新开始：`rtt read --json` 返回 `session_reset: true` 和 `warning` 字段，并自动从当前最旧数据重读。`--json` 的 stdout 始终是纯 JSON/JSONL，警告在字段里，不会污染解析。
- `--since` 由服务端按缓存定位、不被消费；`--follow` 自己用返回的 `cursor` 续读。
- `--max-bytes` 单次字节预算（默认 65536，按整块返回，可能略超）；`--follow --json` 输出 JSONL；`--out` 追加原始字节；`--encoding` 只影响文本渲染。
- **Flash 操作前会自动停 RTT（响应 `rtt_stopped: true`）**，缓存仍可读；要继续收日志必须重新 `rtt start`。
- 想看**开机日志**：先 `rtt start`，再 `flash reset`（不能用 program 前置 start——烧录会把它停掉）；
  目标复位不会停 RTT，抓取会在复位后自动恢复。
- 反向发送：`rtt send --text/--base64/--file`，`--no-newline` 控制文本换行。
- 日志默认带 ANSI 颜色（`CONFIG_LOG_USING_COLOR=y`），断言前先剥掉：

  ```powershell
  $text = $read.text -replace "`e\[[0-9;]*m", ''
  ```

### 3. Flash 的语义

| 命令 | 默认 HTTP 超时 | 行为 |
|------|---------------|------|
| `program` | 180 s | 擦→写→校验→复位运行；`--no-reset` 停在复位态 |
| `erase` | 180 s | `--type chip`（默认）/ `sector --addr` / `sector_range --addr --size`；结束后 `reset_and_halt`（**停在 paused**） |
| `verify` | 120 s | 只读；Flash 数据先 `reset_and_halt` 再读，**结束后目标停在 paused** |
| `compare` | 180 s | 只读；按地址对齐比对，返回差异列表，不写目标；同样以 `reset_and_halt` 收尾 |
| `blank-check` / `read` | 120 s | 只读；Flash 地址先 `reset_and_halt`，结束后保持 paused |
| `fill` | 120 s | Flash 路径先 `reset_and_halt`，按扇区擦除后写入，结束后再复位暂停 |
| `reset` | 30 s | `--type hw|sw`，默认复位并运行；`--no-run` 暂停 |
| `cancel` | 30 s | 取消正在进行的 Flash 操作（长擦除/僵死时的出口） |

- 1 MiB 全片擦除实测 **约 15–16 s**，`program` 约 0.4–2 s（芯片/算法不同差异较大）。
- 超时只是**客户端等待**，后端线程会继续执行；但同一探针的 Flash 操作是串行的，重复请求立即 409，不会排队。
- 想“真正冷启动”不能只靠复位：复位保留 RAM（`.bss.noinit`、未初始化变量都还在），要清 RAM 需断电或重新烧录（Flash 算法会占用低端 RAM）。
- 0.23.x 已包含此前的 Flash 修复（校验前复位、`fill` 导入路径、`erase` 用 `bytes_erased`），不再需要 `--no-verify` 降级兜底。

> [!IMPORTANT]
> 除 `program`（默认复位运行）和 `flash reset`（默认运行）外，**所有 Flash 操作结束时目标都停在 paused**：
> `verify` / `compare` / `blank-check` / `read` / `erase` / `fill`。紧接着抓 RTT 前要 `omni debug run`。
> `fill` 会擦除涉及的扇区，先确认目标区域不在固件占用范围内（`omni debug mem usage --json` 或 map 文件）。

### 4. 符号与地址：不用再解析 `.map`

```powershell
omni debug elf load .\app.axf                           # 后端按 uid 保存会话
omni debug mem resolve "&g_buf" --json                  # {address: ..., size: ...}
omni debug hover main --json                            # 函数地址/大小
omni debug watch eval "obj.field" --json                # 变量值（需目标暂停才可靠）
omni debug src line --addr 0x0800638E --json            # 地址 → 源文件/行/函数
omni debug src files --filter app --json
omni debug src content main.c --start 60 --end 90       # 直接读源码上下文
omni debug src search "disk_ram1" --limit 20            # 全源文件文本搜索
omni debug src symbol main --json                       # 名字 → 定义位置
omni debug callgraph --addr main --json                 # 直接被调函数
```

> [!WARNING]
> ELF 会话存在后端里。`backend stop`/重启后必须重新 `elf load`，否则 `hover` / `watch eval` 返回
> `state: "disconnected"`、`info: null`，而不是报错——脚本里要检查 `success` 和 `info`。

### 5. 断点与现场

```powershell
omni debug bp add --file app.c --line 69 --json     # 返回实际落点地址
omni debug bp add --file app.c --line 69 --condition "count > 3"   # 条件断点
omni debug reset --mode break-symbol                # 复位运行，停在入口符号（8 s 内未命中会提示固件/ELF 不匹配）
omni debug run                                      # 命中后自动暂停
omni debug status --json                            # state=halted, pc
omni debug stack --locals                           # 调用栈 + 每帧局部变量
omni debug locals
omni debug disasm --addr main --count 20
omni debug run-to-cursor --file app.c --line 93     # 运行到指定行后暂停
omni debug bp enable --address main                 # 也支持 --file + --line 定位
omni debug bp clear                                 # 会连 commander 设的断点一起清掉
```

`bp del` / `bp enable` / `bp disable` 支持 `--address`（hex 或符号）或 `--file` + `--line`；
两类地址常落在同一函数的不同位置，命令内部按「精确 → Thumb 位归一 → 同函数」三级匹配。

### 6. 内存与外设

```powershell
omni debug mem read --addr 0x20000000 --size 16 --json    # data_hex 小端，脚本自己换算
omni debug periph list --json
omni debug periph regs GPIOE --filter ODR --json          # values[].value = 64 → bit6
omni debug periph nvic / scb / systick
omni debug mem usage --json                               # flash_used / ram_used / sections
omni debug watch set --address 0x40021014 --value 0x40    # 暂停下写内存
omni debug watch set --register r0 --value 0x1234
```

Commander 能做的事更多，但有几条硬规则（都是实测踩出来的）：

| 写法 | 结果 |
|------|------|
| `read32 0x08000000 4` | ✅ 长度是**字节数**，必须是宽度 4 的倍数；`read32 ... 2` 报 `length (2) is not aligned to width (4)` |
| `read8 0x20000524 16` | ✅ 宽度 1 时长度任意 |
| `find 0x20000524 65536 104 101 108` | ✅ BYTE 参数用**十进制或 `0x` 前缀**；`6c` 会报 `invalid argument '6c'` |
| `read16 0x20000524+510 2` | ❌ 不支持地址算术，先自己算成 `0x20000722` |
| `commander exec list` | ⚠️ 这是 pyOCD 的**探针/目标列表**；列命令用 `commander exec help` |

> [!NOTE]
> 自定义 Flash 算法时注意：FLM 的 `page_size` 会被 pyOCD 当成**最小写入粒度**（STM32H7 常见 1024 字节）。
> 因此 `write32` 这类单字写入会报 `phrase length is unaligned or too small`，验证算法请用一个整页大小的 bin 走 `load`。

### 7. Monitor：比逐条读内存快得多的采样

`debug mem read` 每条约 0.7–1.1 s（约 1 Hz），看波形、找跳变经常不够。`monitor` 在后端进程内采样，
支持 SWD（HSS 非侵入）与 RTT（侵入高速）两种传输，最高默认 1 kHz。

```powershell
omni monitor elf load .\app.axf
omni monitor symbols --filter counter --type object
omni monitor var add --symbol g_counter
omni monitor var add --symbol g_buf --index 3          # 数组必须给索引
omni monitor start --rate 1000 --transport swd
omni monitor read --limit 20 --json
omni monitor read --follow --duration 5                # 只跟新样本，不重复回放
omni monitor export .\monitor.csv --mode recent --recent 10 --force   # 最近 10 秒
omni monitor stop
omni monitor device run|halt|reset|state
```

- `var add --symbol` 精确匹配符号；数组缺 `--index` 或索引越界会直接拒绝。
- `start` 会先 `resume` 兜底（connect/Flash 操作可能把内核留在 halt，否则变量值冻结）；也可显式 `monitor device run`。
- `read` 默认只显示 200 个样本（`--limit 0` 全部）；`--follow` 默认从最新样本之后开始，回放历史需显式 `--start-ms 0`。
- 采样数据落盘，`read/export` 可跨会话读取；读取前后端会 flush 当前文件，采样中也能看到最新样本。

### 8. 临时挂包与设备库

```powershell
# 临时挂包：只注册到当前后端进程，不写设备库；backend 重启后失效
omni probe connect <probe-uid> -t g32f020k8 --pack .\Geehy.G32F020_DFP.0.0.11.pack

# 持久导入/卸载（与 GUI「设置 → 芯片管理」共用设备库）
omni pack preview .\Geehy.G32F020_DFP.0.0.11.pack --search g32f020
omni pack import .\Geehy.G32F020_DFP.0.0.11.pack --parts stm32f103c8,stm32f103rb
omni pack list
omni pack remove Geehy.G32F020_DFP -y

# 自定义芯片
omni device flm-info .\G32F463.FLM
omni device custom .\G32F463.FLM --part-number MYCHIP --flash-base 0x08000000 `
    --flash-size 1024 --ram-base 0x20000000 --ram-size 128
```

同一后端内的后续 `flash/debug/commander/rtt` 直接可用，无需重复 `--pack`。内置型号优先于 Pack 同名型号。

### 9. 批量与轮询

```powershell
# 一个进程执行多条 Commander 命令（开销≈单条）
omni commander shell --command "read32 0x40021014 4; reg pc; read32 0x08000000 4"

# 长命令/僵死命令的出口
omni commander cancel
omni commander reset          # 目标切换/重连后重置 Commander 上下文

# 低频轮询（实测 0.7–1.1 s/次，约 1 Hz）
omni debug mem read --addr 0x40021014 --size 4 --json
```

要更快：`rtt read --follow`（设备侧连续输出）、`monitor start --rate`（后端内采样）或 jlink-live-debug 的 pylink 直连（~0.2–1 ms/次）。

### 10. 句柄与收尾

后端运行期间**独占探针**。用 Keil / Ozone / `JLink.exe` 之前先 `omni backend stop`；脚本里用 `finally` 收尾。
注意 `backend stop` 会停掉**当前记录的那个后端**，包括 OMNI Link 桌面端拉起的——`omni_hw_smoke.py` 因此只清理
「自己启动的后端 / 自己连的探针 / 自己开的 RTT」，复用的资源保持原样：

```powershell
try { ... } finally {
    omni rtt stop
    omni probe disconnect $uid
    omni backend stop      # 仅在你确认这个后端是本脚本/CI 拉起的时候
}
```

`omni backend stop` 不依赖运行时记录：端口在监听但 HTTP 无响应时也能按端口定位进程树强杀，确保 J-Link 句柄释放。
`probe disconnect` 会等待后端真正关闭底层句柄再返回。

## 陷阱（全部实际发生）

| 现象 | 原因 | 处理 |
|------|------|------|
| 刚 `connect` 后 `probe list` 仍显示 `disconnected` | 列表来自 1–2 s 的监控快照 | 以 `probe status <uid>` 为准；或 `probe list --refresh` |
| `rtt read --since <旧 next_seq>` 读到 0 字节或 `session_reset` | 后端重启后 seq 从 1 重新编号 | 接受 `session_reset` 并从当前最旧数据重读；同进程内跨 `rtt start` 游标仍有效 |
| `rtt start` 报找不到控制块 / 读到乱码 | 写死了旧的 `_SEGGER_RTT` 地址 | 不传 `--address` 自动检测，或 `mem resolve "_SEGGER_RTT"` |
| 烧录后 RTT 没日志 | Flash 操作前自动停 RTT（`rtt_stopped: true`） | 重新 `rtt start` |
| 校验/擦除/回读后抓不到 RTT | 这些 Flash 操作结束时目标 halted（`program` 例外） | 先 `omni debug run`，再 `rtt start` |
| `flash compare/blank-check/read --json` 失败但退出码为 0 | 这三个命令的 `--json` 分支恒返回 0 | 断言 `success`，再叠加 `equal` / `mismatch_count` / `is_blank` |
| `flash blank-check` 非空白但退出码 0 | 结果是信息性的（人类可读模式也不报错） | 断言 `is_blank` |
| `debug mem read --json` 偶发 `skipped: true`、`data_hex` 为空 | 有其它调试操作正在占用目标 | 重试即可；`omni_reg_watch.py` 内置了 5 次重试 |
| `debug regs` / `locals` / `stack` 报错或 `skipped` | 目标在运行 | 先 `omni debug halt` |
| `hover` / `watch eval` 返回 `info: null` | 没 `elf load`，或后端重启丢了会话 | `elf load` 后重试 |
| 目标像“死机”、RTT 没新日志 | `probe connect` 默认 halt，或执行了 `debug reset`（默认暂停） | `omni debug run`；要保留现场用 `probe connect -M attach` |
| `find` 参数非法 | 字节用了裸十六进制（`6c`） | 十进制或 `0x6c` |
| `commander exec list` 输出的是探针表 | 那是 pyOCD 的 list 命令 | 列命令用 `commander exec help` |
| `bp clear` 把手工断点也删了 | 与 `commander exec break` 共用 pyOCD 断点管理器 | 只清自己的断点时用 `bp del --address/--file --line` |
| `reset --mode break-symbol` 8 s 未命中 | 固件与 ELF 不匹配，或断点地址不执行 | 确认固件/ELF 一致，先用 `src line` 核对地址 |
| 脚本断言 RTT 失败但人眼看得到 | 文本里有 ANSI 转义和 `\r\n` | 先剥 ANSI（`omni_cli.strip_ansi()`），正则容忍行尾 |
| `probe connect` 报目标未支持 | 型号不在内置库，也没挂 Pack | `pack import` 持久导入，或 `--pack` 临时挂包 |
| `device info` 查不到型号 | 设备库型号为小写 | 用 `g32f463xc` 这类小写写法 |
| Keil/Ozone 连不上探针 | 后端占着 J-Link | `omni backend stop` |
| 手工 `backend stop` 把 OMNI Link 桌面端的后端也停了 | `stop` 停的是当前记录的后端，不区分谁拉起 | 脚本只停自己启动的资源；手工执行前确认 GUI 没在用 |
| `--managed` 下挂的临时 Pack 下一步就没了 | 命令结束即关停后端 | 多步操作先 `omni backend start` |
| `omni config` 报“工程包含多个目标板” | 工程有多个 `boards/<target>` | 加 `-b/--board` |
| PowerShell 终端里中文乱码 | CLI 管道输出已是 UTF-8，但控制台按 cp936 解码 | 先 `chcp 65001`（或 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`）；脚本用 `subprocess(encoding="utf-8")` |

## 打包脚本

| 脚本 | 用途 |
|------|------|
| `scripts/omni_hw_smoke.py` | 一条命令跑完：后端→探针→（可选擦除）→烧录→校验→恢复运行→（可选 ELF）→RTT 抓取→正则断言→清理；失败返回非 0 |
| `scripts/omni_rtt_assert.py` | 只做 RTT：stop→start 开新会话→采样→断言→可选落盘；适合反复验证运行中的固件 |
| `scripts/omni_reg_watch.py` | 轮询一个寄存器/符号并按变化打印（`--symbol` 可自动解析 ELF 符号） |
| `scripts/omni_cli.py` | 三个脚本共用的薄封装：调 `omni`、解析 `--json`、剥 ANSI、兼容旧版警告 |

在仓库根执行（路径按你的 skill 位置调整）：

```powershell
# 完整冒烟 + 两条日志断言（--expect 可重复）
python .agents\skills\omni-cli\scripts\omni_hw_smoke.py `
    --firmware .\app.hex `
    --jlink-device STM32F407IG `
    --elf .\app.axf `
    --expect "read from 6" --expect "free: \d+ clusters"

# 正则写进文件维护
python .agents\skills\omni-cli\scripts\omni_hw_smoke.py --firmware ... --expect-file .\expect.txt

# 只抓 5 秒日志并落盘
python .agents\skills\omni-cli\scripts\omni_rtt_assert.py --seconds 5 --out .\rtt.log --expect "mkfs|mkdir"

# 盯 GPIOE->ODR 10 秒
python .agents\skills\omni-cli\scripts\omni_reg_watch.py --addr 0x40021014 --seconds 10 --interval-ms 500
```

约定：`--uid` 省略时取第一个探针；`--keep-session`（smoke）/ `--keep-rtt`（rtt）保留现场；
失败退出码非 0。只依赖标准库（Python 3.9+），`python` 在 PATH 即可；`omni` 不在 PATH 时可用
环境变量 `OMNI_CLI` 指定路径。`omni_hw_smoke.py` 在 `verify` 之后会自动 `debug run`，
因为校验结束会暂停目标（否则后续 RTT 采样拿不到新日志）。

## 实战配方：FatFS RAM 盘（以 omni-emb 例程为例）

```powershell
# 1) 烧录并抓首启日志
omni flash program .\examples\fatfs\fatfs_ram_disk\Objects\stm32f407\omni.hex --json
omni rtt start
Start-Sleep 2
omni rtt read --json

# 2) 复位后只取新增日志（RTT 会话保持运行，seq 连续递增）
$n = (omni rtt status --json | ConvertFrom-Json).capture.next_seq
omni flash reset
Start-Sleep 2
(omni rtt read --since $n --json | ConvertFrom-Json).text

# 3) 不重启，直接校验 RAM 盘里的文件系统
omni debug elf load .\examples\fatfs\fatfs_ram_disk\Objects\stm32f407\omni.axf
$addr = (omni debug mem resolve "&disk_ram1_storage" --json | ConvertFrom-Json).address
omni commander exec find $addr 65536 104 101 108 108 111 32 102 97 116 102 115 10
omni commander exec read16 0x20000722 2      # 引导扇区签名 0xAA55
omni debug periph regs GPIOE --filter ODR --json   # bit6 在 0x40/0x00 间跳变（LED）
```

预期：首次 `mkfs: 0` / `mkdir: 0`；复位后无 `mkfs`、`mkdir: 8`（`FR_EXIST`）；
`find` 命中 `hello fatfs\n`；`GPIOE->ODR` 的 bit6 在 `0x40`/`0x00` 之间跳变（LED 在跑）。

## 相关

- `python/omni_cli/README.md` — CLI 完整命令参考与版本记录（本仓库）
- `docs/tech/cli-coverage.md` — CLI 命令覆盖情况（本仓库）
- `docs/tech/api.md` — 后端 REST / WebSocket API（本仓库）
- `README.md` — OMNI Link 桌面端功能与安装
- `jlink-live-debug` 技能 — 需要 µs 级采样/寄存器级 A/B 时的 pylink 直连方案
- omni-emb 仓库 — 例程与板级工程（`omni config` / `omni build` 的数据来源）

技能脚本只用 Python 标准库做 `subprocess` + `json` 的薄封装（零第三方依赖）；需要跨平台或写 CI 时优先走 Python 版本。
