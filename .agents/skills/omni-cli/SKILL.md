---
name: "omni-cli"
description: "用 omni CLI（omni-cli 0.28.0+）在真实硬件上联调：经本地 HTTP 后端连接探针、烧录/校验/对比/擦除 Flash、抓取 SEGGER RTT 日志、执行 pyOCD Commander 命令、采集 Monitor 变量波形，以及基于 ELF 的源码级调试（断点、寄存器、内存、外设、调用栈）。同时覆盖串口调试（收发/游标续读/后端录制/定时发送）、网络调试（TCP 服务器与客户端、UDP、ICMP ping、TFTP 传文件）和 USB 调试（USBPcap 抓包、描述符解析/校验/生成、CDC/HID/WinUSB 请求、离线 pcap 与真机回归用例），以及本地工程命令（config/build/boards/modules/toolchain）。适用于实机冒烟测试、串口/网络协议对读、RTT 日志断言、USB 枚举/描述符/请求排查、运行中目标的寄存器级排查，以及 flash→verify→RTT→断言 的可脚本化 CI 循环。"
---

# OMNI CLI 实机联调

`omni` 把探针、烧录、RTT、Commander、源码级调试和 Monitor 采样统一成命令行，每条命令都带 `--json` 和明确的退出码，因此**实机验证可以写成脚本、放进 CI**。同一二进制还提供 `config` / `build` / `boards` / `modules` / `toolchain` 等本地命令，它们**不需要后端和探针**。

和 `.agents/skills/jlink-live-debug/` 的分工：

| 需求 | 用哪个 |
|------|--------|
| 烧录 / 校验 / 对比 / 全片擦除 | **omni**（内置 flash 算法、自动校验、超时语义） |
| RTT 日志抓取与断言 | **omni**（环形缓存 + 游标 + JSONL） |
| 源码级断点、变量求值、外设寄存器、调用栈 | **omni**（ELF 会话保存在后端，跨命令可用） |
| 变量波形、周期采样（1 Hz–1 kHz） | **omni monitor**（SWD HSS 非侵入 / RTT 高速） |
| µs–ms 级连续采样、halt 下直接驱动外设做 A/B | jlink-live-debug（pylink 直连） |

原因：每次 `omni` 调用都是一个新进程 + HTTP 往返，**实测单条命令 0.7–1.1 s**（Python 启动占大头），不适合高频逐条采样；`commander shell --command "a; b; c"` 能在一个进程里批量执行多条命令，`monitor` 则在**后端进程内**连续采样，两者都不受进程启动开销限制。

## 环境与自检

| 项 | 本机实测值 |
|----|-----------|
| CLI | `omni 0.28.0`（Python 包名 `omni_cli`，独立仓库 `D:\workspace\embedded\omni-cli`） |
| 安装位置 | wheel：`powershell -File scripts\cli-package.ps1`（在 omni-cli 仓）；源码态用 `python -m omni_cli`（`PYTHONPATH` 指向 omni-cli 仓） |
| 后端 | 独立仓库 `D:\workspace\embedded\omni-backend`，两个服务：`link`（探针/烧录/RTT/调试）与 `bus`（串口/网络/USB）；源码态 `link/server.py`、`bus/server.py` |
| 后端接入 | 常驻 `omni backend start [link\|bus]` / `--managed`（临时拉起）/ `--backend-port`（接管已有） |
| Python | 3.11（技能脚本只用标准库，`python` 在 PATH 即可） |
| 探针 | SEGGER J-Link Compact PLUS（UID `852001270`）；Geehy CMSIS-DAP（DAPLink，`VID_314B&PID_0101`） |
| 目标 | STM32F407IG → `--target stm32f407xg`，`--jlink-device STM32F407IG`；APM32F407 → `--target apm32f407xg` |
| 固件 | `Objects\stm32f407\omni.hex` / `omni.axf`（Keil）或 `build\stm32f407ig\AC6\Debug\`（CMake） |
| USB 抓包 | USBPcap 1.5.4+（默认 `D:\Program Files\USBPcap`）；`capture start` 需要**管理员终端** |
| USB 设备 | `examples/usb/usbd_winusb`（C251:0002）、`usbd_hid_custom`（C251:0001）、`usbd_cdc_acm`（C251:0001→COMx） |

```powershell
omni --version
omni backend status     # exit 0=运行中，1=未运行
omni system info        # 后端/数据库/Python/pyOCD 版本
omni probe list
omni probe jlink-devices --search STM32F407    # 查 SEGGER 设备名
omni target info stm32f407xg
omni toolchain          # cmake/ninja/编译器最终解析来源
```

> [!IMPORTANT]
> `--jlink-device` 是 **SEGGER 数据库里的设备名**，和 CMSIS-Pack 的型号字符串不一定相同（本机 STM32F407 恰好同名，换芯片时用 `omni probe jlink-devices --search <前缀>` 查）。
> `probe connect` 的 `--target` 是必填项（调试/烧录的芯片型号），与本地命令 `-b/--board`（构建目标板）不是一回事。

## 最小闭环

```powershell
omni backend start                    # 默认 link 服务
omni probe connect 852001270 --target stm32f407xg --jlink-device STM32F407IG --speed 4000000
omni flash program .\Objects\stm32f407\omni.hex --json
omni rtt start
omni rtt read --follow --duration 5 --json
omni rtt stop
omni probe disconnect 852001270
omni backend stop
```

构建后直接烧录（runner 会调用 `omni flash program`，仍需后端）：

```powershell
omni build -b stm32f407ig --project-dir examples\basic\template -t flash
```

> [!NOTE]
> `probe connect` 实际默认 `halt`（后端 `connect_mode or 'halt'`，复位并暂停；只有 `-M attach` 才保留现场）。
> 想让它跑起来要 `omni debug run`；而 `omni debug reset` 默认 `--mode halt`，`omni flash reset` 默认复位后运行。

## 命令地图

**硬件类（需要后端）**：

| 区域 | 常用命令 |
|------|---------|
| 后端 | `backend start\|stop\|status [link\|bus]`、`backend list`、`system info` |
| 探针 | `probe list\|status\|connect\|disconnect\|target\|jlink-devices` |
| 芯片 | `target list --search stm32f4`、`target info <part>` |
| Pack/设备库 | `pack list\|preview\|import\|remove`、`device list\|info\|summary\|custom\|flm-info` |
| Flash | `flash program\|verify\|compare\|erase\|blank-check\|read\|fill\|reset\|cancel` |
| RTT | `rtt start\|stop\|status\|channels\|read\|send\|device run\|halt\|status\|reset` |
| Commander | `commander exec <cmd...>`、`commander shell --command "a; b"`、`commander reset\|cancel` |
| 调试 | `debug status\|halt\|run\|step\|reset\|run-to-cursor`、`elf load\|info`、`src files\|line\|content\|search\|symbol`、`bp add\|list\|del\|enable\|disable\|clear`、`regs`、`mem read\|resolve\|usage`、`stack\|locals`、`disasm`、`functions`、`callgraph`、`hover`、`watch eval\|set`、`periph list\|regs\|nvic\|scb\|systick`、`session list\|save\|load\|del` |
| Monitor | `monitor status\|elf load\|symbols\|var add\|start\|read\|export` |
| 串口（bus） | `serial ports\|open\|close\|status\|send\|read\|update`、`serial record start\|stop\|status`、`serial auto-send start\|stop\|update` |
| 网络（bus） | `net interfaces\|ping`、`net tcp-server start\|stop\|status\|send\|kick\|echo\|auto-send`、`net tcp-client connect\|disconnect\|status\|send\|auto-send`、`net udp start\|stop\|status\|send\|echo\|auto-send`、`net read`、`net tftp server-start\|server-stop\|server-status\|server-files\|get\|put` |
| USB（bus） | `usb doctor`、`usb capture start\|stop\|status\|transfers\|detail\|devices\|open\|save`、`usb desc parse\|validate\|build\|emit\|template\|from-capture`、`usb winusb list\|info\|open\|control\|read\|write\|pipe\|echo\|close`、`usb hid list\|open\|read\|write\|feature\|close`、`usb cdc list\|open\|send\|read\|break\|close`、`usb test run\|list` |
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

**服务路由**：命令组自动决定连哪个后端——`serial` / `net` 走 `bus`，其余走 `link`；
任何叶子命令都能用 `--service link|bus` 覆盖。两个服务是**独立进程、独立登记表**
（`%LOCALAPPDATA%\omni-link\backend.json` 与 `\omni-bus\backend.json`），互不影响。

完整参数见 `D:\workspace\embedded\omni-cli\README.md`，或 `omni <cmd> -h`。

## 串口与网络（bus 服务）

两类命令都走 `bus` 后端，与 GUI 的串口页/网络页**共用同一个后端实例和同一份接收
环形缓存**——GUI 抓着的日志，CLI 也能按游标读到；反之亦然。

### 串口

```powershell
omni serial ports                                    # 枚举（含 VID:PID、厂商）
omni serial open --port COM73 --baud 460800 --id cdc # 多口并行时各给一个 --id
omni serial open --port COM14 --baud 460800 --id ch340
omni serial send --id cdc --text "AT+GMR"            # 文本（默认补 
，--no-newline 关闭）
omni serial send --id cdc --hex "DE AD BE EF"        # 十六进制
omni serial send --id cdc --file .\payload.bin       # 二进制文件
omni serial read --id ch340 --wait 500 --hex         # 等 500ms 内的新数据
omni serial read --id ch340 --follow --out rx.bin    # 持续接收并落盘
omni serial close --id cdc                           # 缓存保留，仍可 read 回看
```

**三种接收模式的区别**（选错了会白等）：

| 模式 | 语义 | 典型用途 |
|------|------|---------|
| `read`（无参） | 读缓冲区里**已有**的数据 | 抓完再看 |
| `read --wait MS` | 最多等 MS 毫秒**新**数据，首批到达即返回 | 「发一条、收一条」的 AT 命令式交互 |
| `read --follow` | 轮询直到 `--duration` 或 Ctrl+C | 长时间跟踪日志 |

**游标记忆**：`read` 默认续读上次位置（记录在 `%LOCALAPPDATA%\omni-<svc>\.read_cursor.json`），
所以「send 后 read」不会重放历史；首次读从最旧数据开始；`--since 0` 强制从头，
`--since N` 覆盖记录。`rtt` / `serial` / `net` 三个流式命令共用这一行为。

**后端录制 vs 客户端落盘**：

| | `read --out FILE` | `record start --out FILE` |
|---|---|---|
| 落盘方 | CLI 进程 | 后端读取线程 |
| 关掉终端 | 停止 | **继续** |
| 客户端卡顿 | 可能丢 | 不受影响（与显示解耦） |
| GUI 可见 | 否 | 是 |

长时间抓包（挂着抓一夜、抓偶发问题）用 `record`；临时抓一段用 `--out` 更省事。

```powershell
omni serial record start --id cdc --out D:\log\rx.dat
omni serial record status --id cdc      # 路径 + 已写字节
omni serial record stop --id cdc        # 本次字节数
```

### 网络

```powershell
omni net interfaces                                    # 本机 IPv4
omni net ping 192.168.1.100 -n 4                       # 时延 min/avg/max + 丢包率
omni net ping --last                                   # 查最近一次结果（不重新 ping）

# 本机当服务器，等设备连进来
omni net tcp-server start --port 6000
omni net tcp-server status                             # 客户端 id / 对端地址 / 收发字节
omni net tcp-server send --text "hello"                # 广播；--target c1 指定单个
omni net read --kind tcp-server --peer 192.168.1.101:52036 --hex

# 连设备上的服务器
omni net tcp-client connect --host 192.168.1.100 --port 6000
omni net tcp-client send --text "AT" && omni net read --kind tcp-client --wait 500

# UDP（支持广播）
omni net udp start --port 5000
omni net udp send --to 192.168.1.255 --port 5000 --hex "FF"

# TFTP：给板子传固件/配置，或从板子取文件
omni net tftp server-start --root D:\share             # 本机当服务器（板子来取）
omni net tftp server-files
omni net tftp get --host 192.168.1.100 --remote fw.bin --local D:\tmp\fw.bin
omni net tftp put --host 192.168.1.100 --local D:\tmp\cfg.ini --remote cfg.ini
```

**`net read` 的 `--kind` 必填**（默认 `tcp-client`）：`tcp-server` / `tcp-client` / `udp`
三者各有独立缓存与游标；TCP Server 多客户端时用 `--peer host:port` 只看其中一个。

**定时循环发送放在后端**（`auto-send`），不是 CLI 前台循环：

```powershell
omni net tcp-client auto-send start --hex A1B2 --interval 100
omni net tcp-client auto-send stop     # 返回发送/失败计数
omni serial auto-send start --id cdc --hex 55AA --interval 100
omni serial auto-send stop --id cdc
```

关掉终端仍继续、间隔精度不受客户端调度影响、GUI 同步可见——做心跳/压力测试时
比 `while` 循环可靠。

## USB（bus 服务）

抓包、描述符、请求、回归测试都在 `omni usb` 下。**发请求有三条通道，能力不同**：

| 通道 | 设备条件 | 能做什么 | 不能做什么 |
|---|---|---|---|
| `winusb` | 接口绑定 WinUSB（固件 MS OS 2.0 或 INF） | 任意控制传输、批量/中断收发、pipe 控制、echo | 等时传输；被其它驱动占用时打不开 |
| `hid` | 系统 HID 驱动（免驱） | Input/Output/Feature 报告 | 任意 SETUP |
| `cdc` | 系统 `usbser`（免驱） | 数据收发、BREAK、打开时设置 line coding | 任意 SETUP |

### 抓包（USBPcap）

```powershell
omni usb doctor                                  # 安装/权限/可抓 root hub
omni usb capture start --devices 1,2             # 管理员；建议先 start 再插拔设备
omni usb capture transfers --follow              # 实时看 URB（Ctrl+C 结束）
omni usb capture detail 37                       # SETUP / hex / 解码树
omni usb capture devices                         # 从描述符重建的设备树
omni usb capture open --pcap customer.pcap       # 离线分析，不需要 USBPcap/管理员
omni usb capture save --out session.pcap
```

### 描述符

```powershell
omni usb desc parse --hex "80 06 00 01 00 00 12 00"      # Setup 包
omni usb desc parse --hex "12 01 00 02 00 00 00 40 ..."  # 自动识别设备/配置/字符串/BOS
omni usb desc template list
omni usb desc template show cdc-acm --json > cdc.json
omni usb desc validate --file cdc.json                   # 规则校验，退出码即结果
omni usb desc build --file cdc.json                      # 生成分节 hex
omni usb desc emit --file cdc.json --format hex
omni usb desc from-capture --pcap enum.pcap              # 抓包 → 可编辑文档
```

### 请求

```powershell
# WinUSB：枚举 → 打开 → 控制/批量 → echo
omni usb winusb list                         # 只看绑定 WinUSB 的接口
omni usb winusb list --all                   # 全部 USB 设备 + 驱动服务（分诊用）
omni usb winusb open --vid 0xC251 --pid 0x0002
omni usb winusb control --request 0x06 --value 0x0100 --length 18
omni usb winusb write --pipe 0x01 --data "01 02 03 04"
omni usb winusb read  --pipe 0x81 --length 4
omni usb winusb echo  --out-pipe 0x01 --in-pipe 0x81 --size 64 --count 100
omni usb winusb echo  --out-pipe 0x01 --in-pipe 0x81 --size 512 --count 5 --pipeline 32
omni usb winusb pipe  --pipe 0x81 --reset

# HID：报告级
omni usb hid list --vid 0xC251
omni usb hid open --vid 0xC251 --pid 0x0001
omni usb hid write --report-id 1 --data "01 02 03"
omni usb hid read  --length 64 --count 1 --timeout-ms 500
omni usb hid feature --get --report-id 2

# CDC：复用串口后端
omni usb cdc list
omni usb cdc open --port COM73
omni usb cdc send --text "hello omni"
omni usb cdc read --hex --wait 500
omni usb cdc break --duration-ms 100
```

`--capture` 可在 `winusb control/echo` 上同时启停 USBPcap，并核对本次请求产生的 URB
（需要管理员终端）。

### 回归用例

一条用例可以是「离线 pcap 断言」，也可以是「真机动作」，或两者组合：

```json
{
  "name": "winusb-echo-smoke",
  "device": { "channel": "winusb", "vid": "0xC251", "pid": "0x0002", "timeoutMs": 1000 },
  "steps": [
    { "open": {} },
    { "control": { "requestType": "0x80", "request": "0x06", "value": "0x0100", "length": 18 },
      "expect": { "ok": true, "hexStartsWith": "12 01" } },
    { "write": { "pipe": "0x01", "data": "01 02 03 04" } },
    { "read":  { "pipe": "0x81", "length": 4 }, "expect": { "hex": "01 02 03 04" } },
    { "echo":  { "outPipe": "0x01", "inPipe": "0x81", "size": 64, "count": 20 },
      "expect": { "mismatches": 0 } },
    { "close": {} }
  ]
}
```

```powershell
omni usb test list
omni usb test run --file winusb-echo-smoke.json --junit report.xml
omni usb test run --file case.json --keep-going      # 默认失败即停
```

`device.channel` 取 `winusb` / `hid` / `cdc`；动作支持
`open/control/write/read/echo/close`，返回值断言支持
`ok/length/minLength/hex/hexStartsWith/mismatches/bytesWritten`。
样例在 `omni-backend/docs/examples/usb/`。

> 实测（STM32F407IG）：`usbd_winusb` 的 echo 64B×100 约 100–235 KiB/s；
> `--pipeline 32` 在 `usbd_winusb` 上会超时（单缓冲缺陷，**这是预期信号**）；
> `usbd_hid_custom` 可写 64B 报告并读到周期报告；`usbd_cdc_acm` 枚举为 COMx 并回显。

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
  omni debug elf load .\Objects\stm32f407\omni.axf
  omni debug mem resolve "_SEGGER_RTT" --json     # {address, size}
  omni rtt start --address 0x20010020
  ```

- **地址会随链接布局变化**。fatfs 例程把 RAM 盘改成 `.bss.noinit` 后，`_SEGGER_RTT` 从
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

- 1 MiB 全片擦除实测 **约 15–16 s**，`program` 约 0.4–2 s。
- 超时只是**客户端等待**，后端线程会继续执行；但同一探针的 Flash 操作是串行的，重复请求立即 409，不会排队。
- 想“真正冷启动”不能只靠复位：复位保留 RAM（`.bss.noinit`、未初始化变量都还在），要清 RAM 需断电或重新烧录（Flash 算法会占用低端 RAM）。
- 0.23.0 起已包含此前的 Flash 修复（校验前复位、`fill` 导入路径、`erase` 用 `bytes_erased`），不再需要 `--no-verify` 降级兜底。
- 0.25.0 起 `rtt read` 默认改为**原始字节直写 stdout**（与 `serial read` 一致）；要文本解码显示用 `--encoding utf-8`。
- 0.26.0 起流式读取有**游标记忆**；0.27.0 起有 `net tftp` 与各角色 `auto-send`、`serial record`。

> [!IMPORTANT]
> 除 `program`（默认复位运行）和 `flash reset`（默认运行）外，**所有 Flash 操作结束时目标都停在 paused**：
> `verify` / `compare` / `blank-check` / `read` / `erase` / `fill`。紧接着抓 RTT 前要 `omni debug run`。
> `fill` 会擦除涉及的扇区，别填到固件所在的扇区（本机固件占 `0x08000000–0x08007127`）。

### 4. 符号与地址：不用再解析 `.map`

```powershell
omni debug elf load .\Objects\stm32f407\omni.axf        # 后端按 uid 保存会话
omni debug mem resolve "&disk_ram1_storage" --json      # {address: 536870912, size: 65536}
omni debug hover main --json                            # 函数地址/大小
omni debug watch eval "fat_fs.fs_type" --json           # 变量值（需目标暂停才可靠）
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

### 7. Monitor：比逐条读内存快得多的采样

`debug mem read` 每条约 0.7–1.1 s（约 1 Hz），看波形、找跳变经常不够。`monitor` 在后端进程内采样，
支持 SWD（HSS 非侵入）与 RTT（侵入高速）两种传输，最高默认 1 kHz。

```powershell
omni monitor elf load .\Objects\stm32f407\omni.axf
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
omni probe connect 852001270 -t g32f020k8 --pack .\Geehy.G32F020_DFP.0.0.11.pack

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
| `serial read` 每次都把历史重放一遍 | `--since` 默认 0 = 从最旧数据开始 | 已改为**游标记忆**（默认续读上次位置）；要历史用 `--since 0` |
| `serial read --wait` 等不到刚发的响应 | 改成「从当前末尾等新数据」后，响应可能比命令启动更快 | 已改为游标记忆，两者兼顾；若仍空，确认 `status` 里 `buffered_bytes` 在涨 |
| `net read` 报 `session_reset` 警告 | 后端重启后 seq 从 1 重新编号 | 正常；会从最旧数据重读，游标自动纠正 |
| `net tcp-client connect` 报「已连接」但发不出去 | 旧连接还占着（连的是上一个目标） | 先 `net tcp-client disconnect` 再 connect |
| 重启后端后串口/网络状态全丢 | 后端进程内的连接/监听不持久化 | 重开后要重新 `serial open` / `net tcp-server start` |
| TFTP 传输显示成功但文件不对 | 后端把传输做成后台任务，POST 立即返回 | CLI 已改为轮询 `/tftp/client/status` 直到完成再报字节数 |
| 中文 Windows 下 `ping` 时延恒为空 | 系统 ping 输出是 GBK，后端按 utf-8 解码会吞掉「时间」 | 已修（按系统首选编码解码）；GUI 网络页同样受益 |
| `omni.exe` 在仓库目录里报 `Could not create temporary directory!` | PyInstaller onefile 在工作区内的解包限制 | 拷到 `%TEMP%` 再运行；打包脚本已改为在 TEMP 里自检 |
| `npm run package` 在中文系统解析 `.ps1` 失败 | PowerShell 5.1 读无 BOM 的 UTF-8 中文脚本 | 脚本已存为 UTF-8 with BOM |
| 在技能 `scripts/` 目录里跑 `python -m omni_cli` 静默无输出 | 该目录曾有同名 `omni_cli.py`，遮蔽了真正的 CLI 包 | 辅助模块已改名 `omni_runner.py`；仍建议在别的目录执行 `-m omni_cli` |
| `usb capture start` 报 `not_elevated` | 抓包驱动要求管理员 | 管理员终端重开；GUI 用“管理员重启” |
| `usb capture start` 报 `device_busy` | 上次异常退出留下 USBPcapCMD 占用 root hub | 管理员任务管理器结束 `USBPcapCMD.exe`，或重启 |
| 非管理员直接跑 `USBPcapCMD.exe` | 会启动提权 worker 并锁住 pcap，普通权限杀不掉 | 只通过 `omni usb capture`（管理员终端）调用 |
| `usb winusb list` 为空但设备管理器里有 | 接口未绑定 WinUSB，或固件 GUID 与命令不一致 | `usb winusb list --all` 看驱动服务；固件补 MS OS 2.0 描述符或用 INF |
| `usb winusb open` 拒绝访问 | WinUSB 接口独占，被 Keil/厂商工具占着 | 关闭占用进程后重试 |
| `winusb echo --pipeline 32` 超时 | `usbd_winusb` 单缓冲，发送端等不到 IN 完成 | 预期缺陷（正是回归信号）；换环形缓冲固件或修固件 |
| HID 打不开 / 读不到报告 | 被系统 HID 驱动独占；或设备本来就没有 IN 报告 | 关闭占用程序；IN 报告需要设备主动上报 |
| CDC 打开失败 | COM 口被串口助手等工具占用 | 先关闭占用程序 |
| 想发 WinUSB 等时传输 | WinUSB 不支持等时端点 | 只能抓包观察，或上硬件分析仪 |

## 打包脚本

| 脚本 | 用途 |
|------|------|
| `omni_runner.py`（本技能内） | 三个脚本共用的 CLI 包装：调用子命令、解析 `--json`、剥 ANSI；支持 `OMNI_CLI` / `OMNI_CLI_REPO`（源码态）/ PATH 三种调用方式 |
| `omni-cli\scripts\cli-package.ps1` | 构建 wheel → 装进 venv → 记录后端目录（装完即用） |
| `omni-cli\scripts\cli-smoke.ps1` | 全硬件冒烟（connect/read32/blank-check/RTT 一整串） |
| `omni-backend\scripts\selfcheck.py` | 后端契约自检（起服务 → health → 登记表 → 优雅关停），`--service link\|bus` |
| `omni-backend\scripts\build.py` | 按服务打 PyInstaller 产物 + `<exe> --help` 自检 |
| `scripts/omni_hw_smoke.py` | 一条命令跑完：后端→探针→（可选擦除）→烧录→校验→恢复运行→（可选 ELF）→RTT 抓取→正则断言→清理；失败返回非 0 |
| `scripts/omni_rtt_assert.py` | 只做 RTT：stop→start 开新会话→采样→断言→可选落盘；适合反复验证运行中的固件 |
| `scripts/omni_reg_watch.py` | 轮询一个寄存器/符号并按变化打印（`--symbol` 可自动解析 ELF 符号） |
| `scripts/omni_cli.py` | 三个脚本共用的薄封装：调 `omni`、解析 `--json`、剥 ANSI、兼容旧版警告 |

```powershell
# 完整冒烟 + 两条日志断言（--expect 可重复）
python .agents\skills\omni-cli\scripts\omni_hw_smoke.py `
    --firmware .\examples\fatfs\fatfs_ram_disk\Objects\stm32f407\omni.hex `
    --jlink-device STM32F407IG `
    --elf .\examples\fatfs\fatfs_ram_disk\Objects\stm32f407\omni.axf `
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

## 实战配方：fatfs RAM 盘（2026-10-20 实机）

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
`find` 在 `0x20001324` 命中 `hello fatfs\n`；`GPIOE->ODR` 的 bit6 在 `0x40`/`0x00` 之间跳变（LED 在跑）。

## 相关

- `D:\workspace\embedded\omni-cli\README.md` — CLI 完整命令参考与版本记录
- `D:\workspace\embedded\omni-backend\docs\protocol.md` — CLI ↔ 后端协议（服务发现 / 版本 / 流式游标）
- `D:\workspace\embedded\omni-backend\docs\usb-plan.md` — USB 能力里程碑、真机验证记录与用例格式
- `D:\workspace\embedded\omni-backend\docs\usb-raw-access.md` — 任意设备原始访问（UsbDk/自研驱动）的论证
- `D:\workspace\embedded\omni-backend\docs\examples\usb\` — 可直接运行的 USB 回归用例
- `D:\workspace\embedded\omni-backend\docs\migration.md` — 后端独立化过程与取舍
- `D:\workspace\embedded\omni-link\README.md` — OMNI Link 桌面端功能与安装
- `D:\workspace\embedded\omni-bus\README.md` — OMNI Bus 桌面端（串口/网络/USB 页面）
- `.agents/skills/jlink-live-debug/SKILL.md` — 需要 µs 级采样/寄存器级 A/B 时的直连方案
- `examples/fatfs/fatfs_ram_disk/` — 本技能实测所用的例程（RTT + RAM 盘 + `.bss.noinit`）

两个技能都用 Python 3.11：omni 侧只做 `subprocess` + `json` 的薄封装（零第三方依赖），
jlink 侧直接操作 `pylink-square`；需要跨平台或写 CI 时优先走 Python 版本。
