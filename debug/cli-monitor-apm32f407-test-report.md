# OMNI CLI 0.7.0 Monitor / 调试功能实机测试报告（J-Link + APM32F407）

> 测试日期：2026-10-22  
> CLI：`omni 0.7.0`（源码态后端 `python/server.py`）  
> 探针：SEGGER J-Link Compact PLUS，UID `852001270`  
> 目标：APM32F407IGT6（`apm32f407xg`，Cortex-M4F，1 MiB Flash / 128 KiB RAM）  
> J-Link 设备名：`APM32F407IGT6`，SWD 4 MHz  
> 工程：`D:\workspace\embedded\omni-emb\examples\dsp\dsp_sin_cos`  
> 固件：`Objects\stm32f407\omni.hex`（8952 字节）/ `omni.axf`

## 1. 结论

**Monitor、Flash、Debug、Commander、系统信息等主要 CLI 功能在 J-Link + APM32F407 上可用。**
测试中发现并修复了 4 个问题（打包脚本模块改名、`flash read` 输出崩溃、`monitor read --follow`
回放历史、`reset --no-run` 未保持暂停）。

## 2. 测试结果

| 功能 | 命令 | 结果 |
|---|---|---|
| 探针枚举 | `probe list --refresh` | ✅ J-Link Compact PLUS / UID 852001270 |
| 连接 | `probe connect ... -t apm32f407xg --jlink-device APM32F407IGT6` | ✅ Cortex-M，Flash 1 MiB，RAM 192 KiB 映射 |
| J-Link 设备检索 | `probe jlink-devices --search APM32F407` | ✅ 8 个 APM32F407 型号 |
| 烧录 | `flash program omni.hex` | ✅ 8952 字节，763 ms |
| 校验 | `flash verify omni.hex` | ✅ 8952 字节，343 ms |
| Flash 回读 | `flash read --type range --addr 0x08000000 --size 32` | ✅ 32 字节（修复格式串后） |
| 空白检查 | `flash blank-check --addr 0x08000000 --size 32` | ✅ 非空，首个非空 0x08000000 |
| Commander | `commander exec "read32 0x08000000 4"` | ✅ `20000430`（向量表 SP） |
| Debug 状态 | `debug status` | ✅ running/halted，PC 正确 |
| Debug 控制 | `debug halt` / `debug run` | ✅ |
| Debug ELF | `debug elf load omni.axf` | ✅ 20 个源文件 / 55 个函数 |
| 寄存器 | `debug regs --filter pc` | ✅ PC=0x08001424（命中时） |
| 调用栈 | `debug stack` | ✅ 1 帧（Reset_Handler；源码路径来自 ELF 编译环境） |
| 反汇编 | `debug disasm --addr main --count 5` | ✅ 含源码行号 |
| 外设 | `debug periph list` | ✅ 78 个外设 |
| Monitor ELF/符号 | `monitor elf load` + `monitor symbols --filter output` | ✅ sin/cos/test/block_size 符号解析 |
| Monitor 变量 | `monitor var add --symbol ...` | ✅ 4 个变量，地址/类型正确 |
| Monitor 采样 | `monitor start --rate 100` | ✅ 实际 ~100 Hz，4 变量 |
| Monitor 读取 | `monitor read --limit 3` | ✅ 数值与固件一致 |
| Monitor 导出 | `monitor export ... --mode all --force` | ✅ 222/339 个采样点写入 CSV |
| Monitor 跟踪 | `monitor read --follow --duration 1 --json` | ✅ 只输出启动后的新样本（修复后） |
| Monitor 暂停/恢复/停止 | `monitor pause/resume/stop` | ✅ |
| Monitor 写变量 | `monitor var set <block_size> --value 16` | ✅ 后续采样由 32 变为 16 |
| Monitor 删变量 | `monitor var rm <id>` | ✅ |
| Monitor 内核控制 | `monitor device run/halt/reset/state` | ✅ `reset --no-run` 修复后保持 halted |
| 系统信息 | `system info` | ✅ Python/pyOCD/数据库信息 |
| 目标信息 | `target info apm32f407xg` | ✅ 受支持 |
| 设备库 | `device summary` / `device flm-info` | ✅ 50 个内置设备；FLM 参数可提取 |

> `dsp_sin_cos` 固件只在上电时计算一轮 sin/cos 后进入 `while(1)`，因此 Monitor 采到的
> `sin_output/cos_output/test_output` 为常量；这是固件行为，不是采样问题。`block_size`
> 通过 `monitor var set` 从 32 改为 16，后续样本立即变化，验证了读写链路。

## 3. 发现并修复的问题

### P0-1 打包脚本引用已改名的模块

`python/scripts/cli-package.ps1` 仍执行：

```python
from omni_cli import config; config.save_backend_dir(...)
```

0.7.0 后 `omni_cli.config` 是工程配置包，`save_backend_dir` 已移到 `settings`。
已改为 `from omni_cli import settings`，并把脚本提示更新为 `omni config generate --board ...`。

同时补回三个 CLI PowerShell 脚本的 **UTF-8 BOM**：Windows PowerShell 5.1 对无 BOM 的
中文脚本按 GBK 解析，会直接语法报错。

### P1-1 `flash read` 成功输出崩溃

`python/omni_cli/commands/flash.py` 的格式串使用了非法的条件格式说明符：

```python
f"(@0x{base:x if isinstance(base, int) else base})"
```

任何成功的 `flash read` 都会抛 `ValueError: Invalid format specifier`。已改为先计算
`base_txt = f"0x{base:08X}"`，并新增 `test_ops_cli.py` 回归用例。

### P1-2 `monitor read --follow` 回放全部历史

修复前 `--follow` 从 `t=0` 开始，会把采样启动以来的所有历史一次性打印（实测一次输出
12 s 的数据）。已让后端 `/monitor/status` 返回 `latest_t_ms`，CLI 默认以当前最新样本为
游标；需要回放时显式 `--start-ms 0`。

### P1-3 `reset --no-run` 实际未暂停

- `monitor device reset --no-run`：`session.target.reset()` 后未 `halt`，目标继续运行。
- `flash reset --no-run`：`PyOCDBackend.reset()` 同样只 `reset()`，未 `halt`。
- `rtt device reset --no-run`：同一问题。

已分别改为 `reset_and_halt()` / 显式 `halt()`，实机验证复位后状态为 halted。

### P2-1 文档/冒烟脚本残留旧命令

- `cli-smoke.ps1`：`project -h` → `config -h`、`config generate -h`，并新增 `monitor -h`、`system -h`；
  同时让编码检查也校验退出码。
- `cli-install/README.md`：`omni project` / `--target` → `omni config` / `--board`。
- CLI README：配置子命令表改为 `generate`；所有 `-b/--board stm32f407ig` 错误示例改为
  `--board stm32f407ig`；恢复 0.3.x/0.2.x 历史条目原名。
- `docs/tech/cli-coverage.md`：版本升到 0.7.0，移除 trailing whitespace。
- `build.py` 注释、`cli-release.ps1` 清理路径同步为 `config`。

## 4. 观察项（未修改）

- `system info` 显示后端版本 **0.3.1**，与 CLI 0.7.0 / 应用 0.5.3 不一致；`server.py`
  的 `BACKEND_VERSION` 是独立常量，属既有版本管理问题。
- `debug stack` 的源码路径指向编译机 `stm32-workspace`，与当前源码树不同；这是 ELF
  DWARF 记录的编译路径，不影响 CLI。
- `debug stack` 不支持 `--limit`（本次误用，非缺陷）。
- Git 索引目前只有 0.7.0 的**纯重命名**，内容改动未 stage；提交前需按轮次整理。

## 5. 复现命令（简）

```powershell
omni backend start
omni probe list --refresh
omni probe connect 852001270 -t apm32f407xg --jlink-device APM32F407IGT6 --speed 4000000
omni flash program D:\workspace\embedded\omni-emb\examples\dsp\dsp_sin_cos\Objects\stm32f407\omni.hex
omni monitor elf load D:\workspace\embedded\omni-emb\examples\dsp\dsp_sin_cos\Objects\stm32f407\omni.axf
omni monitor var add --symbol sin_output
omni monitor var add --symbol cos_output
omni monitor var add --symbol test_output
omni monitor start --rate 100
omni monitor read --limit 5
omni monitor export .\dsp_monitor.csv --force
omni monitor stop
```
