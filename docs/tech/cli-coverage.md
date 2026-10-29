# OMNI CLI 能力覆盖评审（pyOCD / 应用端）

> 评审日期：2026-10-21  
> CLI 版本：0.8.0
> 对照对象：
> - pyOCD 源码内置版：`python/pyocd/subcommands/`、`python/pyocd/core/options.py`
> - 应用后端路由：`python/api/*.py`、`python/omni_tools/router.py`
> - 应用页面：`src/pages/*`
> - CLI 命令：`python/omni_cli/commands/*`

本文回答两个问题：

1. pyOCD CLI 的哪些能力没有对应的 omni 命令？
2. 原应用（GUI + REST）的哪些能力还没有接入 CLI？

约定：**✅ 已覆盖**、**◐ 部分覆盖**、**❌ 未接入**、**— 不适用/不计划**。  
优先级：**P1** 建议下一轮、**P2** 可延后。

---

## 1. pyOCD CLI 对照

pyOCD 顶层子命令：`commander`、`erase`、`load`、`gdbserver`、`json`、`list`、`pack`、
`reset`、`server`、`rtt`、`run`。

| pyOCD | omni 现状 | 状态 | 说明 / 建议 |
|---|---|---|---|
| `--pack PATH`（所有子命令通用，可重复） | `omni probe connect/target --pack` | ✅ | 0.4.0 新增；进程内语义与 pyOCD 一致 |
| `pack show` / `pack clean` | `omni pack list` / `pack remove` | ✅ | 本地文件安装；`clean` 需逐个 `remove` |
| `pack find/install/update`（CMSIS-Pack 网络索引） | 无 | ❌ P2 | 需 `cmsis-pack-manager` 索引下载；应用改用本地 DFP 导入 |
| `commander` | `omni commander exec/shell` | ◐ | 缺 `-x script.txt`、`--no-init`、`--pack`（会话级挂包由 `probe connect` 承担） |
| `commander` 命令集（unlock/compare/savemem/loadmem/DAP/gdbserver 等） | `omni commander exec "<cmd>"` | ✅ | pyOCD 命令集原样透传；GUI 命令面板同源 |
| `erase` | `omni flash erase` | ✅ | 支持 chip / sector / sector_range |
| `load` | `omni flash program` | ◐ | 缺 `--format`、`--trust-crc`；格式按扩展名识别 |
| `reset` | `omni flash reset` / `omni debug reset` | ✅ | 两者默认值相反，文档已说明 |
| `rtt` | `omni rtt *` | ✅ | 比 pyOCD 多环形缓存/JSON/持续跟踪 |
| `run` | `flash program` + `reset` | ◐ | 无 `--timelimit`（应用无对应需求） |
| `gdbserver` | 仅能经 `commander exec "gdbserver start/status/stop"` | ◐ P1 | 无独立子命令、端口参数与进程级生命周期管理 |
| `list --probes` / `--targets` | `omni probe list` / `omni target list` | ✅ | — |
| `list --boards` | 无 | — | 应用没有板卡库 |
| `list --source pack` | `omni device list --source pack`（设备库） | ◐ | `target list` 不区分来源；临时包型号会混入列表 |
| `json` | 各命令 `--json` | ◐ | 无 `json -f`（功能/选项枚举） |
| `-t/--target`、`-f/--frequency`、`-M/--connect` | 0.4.0 已加别名与 `4m`/`2.5khz` 单位 | ✅ | `-u/--uid` 未加（保留位置参数） |
| `-O OPTION=VALUE`（任意会话选项） | 无 | ❌ P2 | Pack 调试序列（`pack.debug_sequences.*`）等需要时可加 |
| `--config` / `--script` / `--cbuild-run` / `--daparg` | 无 | ❌ P2 | 应用未使用 pyOCD 工程脚本体系 |
| SWV / semihosting / telnet / probe server | 无 | — | 应用未暴露；`server` 子命令不计划 |

---

## 2. 应用端 REST/UI 对照

| 应用能力 | 后端接口 | CLI 现状 | 状态 | 优先级 |
|---|---|---|---|---|
| 芯片管理：Pack 列出/预览/导入/卸载 | `/api/packs/*` | `omni pack list/preview/import/remove` | ✅ | — |
| 设备库：列表/详情/统计/增删改/自定义 FLM/重导入 | `/api/devices/*` | `omni device *` | ✅ | — |
| FLM 参数自动提取 | `/api/devices/custom/extract-flm-info` | `omni device flm-info` | ✅ | — |
| 探针枚举/连接/断开/状态/切换目标 | `/api/probes/*` | `omni probe *` | ✅ | — |
| 探针热刷新 | `/api/probes/refresh` | `probe list --refresh`（等价路径） | ✅ | — |
| J-Link 设备库检索 | `/api/probes/jlink/devices*` | `omni probe jlink-devices` | ✅ | — |
| 目标型号列表/详情 | `/api/targets/*` | `omni target *` | ✅ | — |
| Flash 烧录/擦除/校验/回读/填充/取消/复位 | `/api/probes/{uid}/flash/*` | `omni flash *` | ✅ | — |
| RTT 会话/通道/读取/发送/内核控制 | `/api/probes/{uid}/rtt/*` | `omni rtt *` | ✅ | — |
| RTT 发送文件 | 前端组织 `send-text`/base64 | `omni rtt send --file` | ✅ | — |
| Commander 执行/REPL | `/api/probes/{uid}/commander/*` | `omni commander exec/shell` | ✅ | — |
| Commander 取消执行 / 重置上下文 | `/commander/cancel`、`/commander/reset` | `omni commander cancel/reset` | ✅ | — |
| Commander 命令列表 | `/commander/commands` | `commander exec help` 覆盖 | ✅ | — |
| Zone：执行控制/断点/源码/变量/内存/外设 | `/api/probes/{uid}/zone/*` | `omni debug *` | ✅ | — |
| Zone：NVIC 使能/挂起写入 | `.../nvic/{n}/enable|pending` | 仅读 | ❌ | P1 |
| Zone：SCB 位域写入 / STIR 触发 | `.../scb/field`、`.../scb/stir` | 仅读 | ❌ | P1 |
| Zone：源码保存（编辑） | `POST .../zone/source/content` | 仅读 | ❌ | P2 |
| Zone：可执行行 / ELF 变更检测 | `.../source/executable-lines`、`.../elf/changed` | 无 | ❌ | P2 |
| Zone 会话配置存取 | `/api/zone/sessions*` | `omni debug session *` | ✅ | — |
| Monitor：变量/采样/波形/记录/导出 | `/api/probes/{uid}/monitor/*` | `omni monitor *` | ✅ | — |
| 固件文件 stat/parse（Hex 查看） | `/api/files/parse` | `omni file info` | ✅ | — |
| 文件校验和 / 对比 | 本地算法 + flash compare | `omni file checksum` / `omni flash compare` | ✅ | `checksum` 在 CLI 内计算，不需要后端；`compare` 需要探针 |
| 文件校验和 / 数字转换 | 前端本地实现 | 无 | — | 应用侧本地能力，CLI 可按需本地实现 |
| Map 文件分析 | `/api/tools/map-analyzer` | `omni tool map` | ✅ | — |
| 系统/版本信息 | `/api/system/info` | `omni system info` | ✅ | — |
| OMNI Tool：boot 自升级 / 在线烧录 | `/api/omni-tool/*` | 无 | ❌ | — |

---

## 3. 结论与建议

### 3.1 0.4.0–0.8.0 已关闭的缺口

- pyOCD `--pack` 临时挂包（连接/切换目标）。
- Pack 本地管理：list / preview / import / remove。
- Pack 生命周期正确性：卸载不误删内置或其它 Pack 的目标；清单路径自愈；
  `device list` 的“可烧录”判断修正。
- pyOCD 风格连接参数（`-t/-f/-M`、频率单位）。
- **0.7.0**：本地工程配置命令 `omni project` → `omni config`，板级选项
  `--target` → `-b/--board`；工程配置实现迁移到 `omni_cli.config`。
- **0.5.0**：`omni monitor`（ELF/符号/变量/采样/读取/CSV 导出）；
  `SessionRecorder` 读取前 flush，支持采样中 `--follow`。
- **0.6.0**：`system info`、`commander reset|cancel`、`probe jlink-devices`、
  `device flm-info`、`rtt send --file`。
- **0.8.0**：`omni file info/checksum`、`omni flash compare`（新增后端 compare 接口）、
  `omni tool map`。

### 3.2 建议下一轮（P1）

1. `debug periph nvic --enable/--pending`、`debug periph scb --stir/--field`。
2. `debug src executable-lines`、`debug elf changed`；`src save` 需谨慎（默认拒绝）。
3. `omni monitor` 的实机体验优化（完整体/降噪、采样率上限提示）。

### 3.3 可延后（P2）

- `commander shell --file`。
- `file read`（Hex 查看）与源码保存、ELF 变更检测的自动重载。
- pyOCD `-O` 任意选项透传、`pyocd load --format/--trust-crc`。
- Pack 网络索引：`pack find/install/update`。

### 3.4 明确不计划

- 独立 `gdbserver` / probe server 子命令（Commander 已能启动；应用无进程级管理需求）。
- `list --boards`、SWV / semihosting / telnet（应用未暴露）。
- OMNI Tool CLI：`debug/omni-tool-plan.md` D6 明确“暂不同步”，需要时先改该决策。
- 板卡库、`--cbuild-run`、`--script` 工程脚本体系。

---

## 4. 附：本次新增命令速查

```powershell
# 临时挂包（不写入设备库）
omni probe connect <uid> -t <pack-part> --pack <file.pack>
omni probe connect <uid> -t <pack-part> --pack a.pack --pack b.pack
omni probe target <uid> --part <pack-part> --pack <file.pack>
omni target list --search <part>

# 持久安装
omni pack list
omni pack preview <file.pack> --search <substr>
omni pack import <file.pack> [--parts a,b]
omni pack remove <name> [-y]

# 0.5.0 Monitor
omni monitor elf load app.axf
omni monitor var add --symbol g_counter
omni monitor start --rate 1000
omni monitor read --follow --duration 5
omni monitor export monitor.csv --force

# 0.6.0 运维
omni system info
omni commander cancel
omni probe jlink-devices --search G32 --flash-kb 256
omni device flm-info G32F463.FLM
omni rtt send --file payload.bin

# 0.8.0 文件 / 对比 / Map
omni file info app.hex
omni file checksum app.bin --algorithm crc32
omni flash compare app.hex [--max-diffs 20] [--fail-fast]
omni tool map Listings/stm32f407/omni.map --top 10
```
