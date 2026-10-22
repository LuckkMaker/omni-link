# OMNI CLI 0.4.0 Pack 功能实机测试报告（G32F037 + DAPLink）

> 测试日期：2026-10-21  
> CLI：`omni 0.4.0`（源码态后端 `python/server.py`）  
> 探针：Geehy Link V2 On Board，UID `00350041520000035633344d000258`  
> 目标：G32F037RB，Cortex-M0+，128 KiB Flash / 16 KiB RAM，Flash 起始 `0x00000000`  
> Pack：`samples/Geehy/Geehy.G32F037_DFP.1.0.0.pack`（Geehy.G32F037_DFP 1.0.0，4 个型号）

结论：**Pack 临时挂载、持久导入、设备库联动、连接与 Flash 操作均可用。测试中发现并修复
4 个问题（无效 Pack 被接受、`--parts` 重导入不清理旧条目、卸载残留文件、`blank-check`
对 `--addr 0x0` 忽略范围）。**

---

## 1. 测试结果总览

| 能力 | 验证方式 | 结果 |
|---|---|---|
| `pack list` | 列出原有 2 个 Pack | ✅ |
| `pack preview` | 预览 037 Pack | ✅ 4 个芯片（rb/cb/hb/kb，128 KiB/16 KiB，Cortex-M0+） |
| 无效 Pack | 非 ZIP 的 `.pack` 预览/导入 | ✅ 修复后退出码 1，不再写入清单/设备库 |
| 临时挂包 `probe connect --pack` | 连接 `g32f037rb`，4 MHz | ✅ 连接成功，`target list` 出现 4 个型号 |
| 临时包可见性 | `pack list` / `device list` | ✅ 均不可见（符合 pyOCD `--pack` 进程内语义） |
| 临时包生命周期 | `backend stop/start` 后查询 | ✅ 型号消失，无需清理 |
| 同后端后续命令免 `--pack` | `target list` / `commander` / `flash read` | ✅ 直接使用 `g32f037rb` |
| `probe target --pack` | 037 Pack 内切换 `rb` ↔ `cb` | ✅ 切换成功，状态同步 |
| 多包 `--pack`（可重复） | 031 Pack + 037 Pack 一起挂载 | ✅ 两个 Pack 的型号均注册；重启后临时型号全部消失 |
| 持久导入 `pack import` | 全量 4 个型号 | ✅ 写入设备库与清单，重启后仍可用 |
| `--parts` 部分导入 | 仅 `g32f037rb` / 仅 `g32f037cb` | ✅ `pack list` 设备数与 `device list` 一致 |
| 设备可用性 | `device list --source pack` | ✅ 4/4 显示“可烧录” |
| 免 `--pack` 连接 | 重启后端后 `probe connect -t g32f037rb` | ✅ |
| Commander | `read32 0x0 4`、`debug regs pc` | ✅ |
| Flash 回读 | `flash read --type chip`（128 KiB） | ✅ |
| Flash 擦除 / 空白检查 | 扇区擦除 `0x0`、`0x200` | ✅ `bytes_erased=512`，空白检查正确 |
| Flash 烧录 / 校验 | 恢复扇区内容，`flash verify` | ✅ `bytes_written=512`、`bytes_verified=131072` |
| RAM 填充 | `flash fill --addr 0x20000000 --size 64 --value 0x55` | ✅ 回读 64 字节均为 `0x55` |
| `pack remove` | 断开探针后卸载 | ✅ 清单、设备库、TARGET、Pack 文件均清理 |
| 原有 Pack 隔离 | 卸载 037 后检查 020/002 | ✅ 不受影响 |

---

## 2. 发现并修复的问题

### P1-1 无效 `.pack` 被当成 0 设备 Pack 安装

**现象（修复前）**

```text
omni pack preview .\.tmp-bad.pack
{ "file": "...\\.tmp-bad.pack", "count": 0, "devices": [] }   # exit 0

omni pack import .\.tmp-bad.pack
已导入 .tmp-bad unknown: 0 个芯片                              # exit 0
```

一个内容为纯文本、扩展名为 `.pack` 的文件被复制进 `packs/` 并写入安装清单。

**修复**

- `_extract_devices_from_pack(..., strict=True)`：非 ZIP、缺少 `.pdsc`、XML 解析失败抛 `ValueError`。
- `import_pack` 在复制/注册前先解析校验，并拒绝空设备 Pack。
- `--parts` 未匹配到任何型号时直接报错，不再安装 0 设备条目。

**修复后**

```text
omni pack preview .\.tmp-bad.pack
错误: 预览 Pack 失败: CMSIS-Pack 解析失败: File is not a zip file   # exit 1
omni pack import .\.tmp-bad.pack
错误: 导入 Pack 失败: CMSIS-Pack 解析失败: File is not a zip file   # exit 1
```

清单与设备库保持不变。

### P1-2 全量导入后 `--parts` 重导入不清理未选中的设备

**现象（修复前）**

先全量导入 4 个型号，再执行：

```text
omni pack import .\Geehy.G32F037_DFP.1.0.0.pack --parts g32f037cb
omni pack list      -> Geehy.G32F037_DFP 设备数 1
omni device list    -> 仍显示 4 个 g32f037xx 设备
```

`pack list` 与 `device list` 不一致。

**修复**

- 重新导入按“替换选择”处理：删除本 Pack 之前导入、但本次未选中的设备库条目。
- 该清理只作用于 `source=pack` 且 `pack=<当前 Pack>` 的记录，不影响内置型号或其它 Pack。

**修复后**

```text
pack list      -> 设备数 1
device list    -> 仅 g32f037cb
```

### P2-1 `pack remove` 成功但残留 `.pack` 文件

**现象（修复前）**

在 Pack 型号被连接使用后卸载：

```text
omni pack remove Geehy.G32F037_DFP -y
已卸载 Pack: Geehy.G32F037_DFP
# 但 python\data\packs\Geehy.G32F037_DFP.1.0.0.pack 仍在，且被后端占用
```

原因：pyOCD `CmsisPack` 持有 ZIP 句柄，目标类/设备之间存在引用环；仅从 `TARGET`
删除键后立即 `os.remove`，Windows 上会因句柄未释放而失败，旧代码静默吞掉异常。

**修复**

- `remove_pack` 在删除前触发 `gc.collect()`，让引用环中的 Pack/ZIP 句柄及时析构。
- 删除失败时写 warning，不再无提示。

**验证**

断开探针后卸载 037，`packs/` 下文件立即删除；清单、设备库、TARGET 同步清理。
仍保持连接时会话持有句柄，建议先 `omni probe disconnect` 再卸载。

### P1-3 `flash blank-check --addr 0x0` 忽略 `--size`

**现象（修复前）**

037 的 Flash 起始地址就是 `0x0`：

```text
omni flash blank-check --addr 0x0 --size 512
空白: 否  扫描 32768/32768 字节  首个非空地址: 0x0
```

实际扫描了整个 32 KiB chunk，而不是请求的 512 字节。原因是 `check_blank` 用
`if address` / `if (address and size)` 判断是否指定范围，`0x0` 被当成“未指定”。

**修复**

- 改用 `address is not None` / `size is not None`。
- 同时新增离线回归（fake session）：只读取 `(0, 128)` words、`total_bytes=512`。

**修复后**

```text
blank-check --addr 0x0 --size 512     -> total_bytes=512, first_nonblank_addr=0
erase sector 0x200 后同范围 blank-check -> is_blank=true, blank_bytes=512
```

---

## 3. 板卡 Flash 完整性

破坏性测试前先全片回读备份（128 KiB，SHA256 `5D904E80...B4B94C2`），
只擦写 `0x0` 和 `0x200` 两个 512 字节扇区，随后按备份恢复：

- `flash program sector0.bin --base-address 0x0`：`bytes_written=512`
- `flash program sector1.bin --base-address 0x200`：`bytes_written=512`
- `flash verify backup_before.bin --base-address 0x0`：`bytes_verified=131072`，成功

恢复后再次全片回读，与首次备份逐字节比较：**131071/131072 字节一致**；唯一差异在
`0x1FFF8`（`0xFF → 0xFE`），该地址不在本次擦写的两个扇区内，判断为目标固件运行期间
自身写入或首次回读缓存差异，不是 Pack/Flash 算法写入越界。为避免覆盖固件数据，未再改写该字节。

---

## 4. 回归测试

```text
cd python
..\.venv\Scripts\python.exe test_pack_support.py   -> RESULT: ALL PASS
..\.venv\Scripts\python.exe test_cli_fixes.py      -> ALL PASSED
..\.venv\Scripts\python.exe build.py --check-sources -> 通过（UTF-8，无 U+FFFD）
```

`test_pack_support.py` 新增覆盖：

- `4b` 无效 Pack 预览/导入拒绝，且不复制文件、不写清单
- `4c` 未知 `--parts` 拒绝，且不产生半成品安装
- `4d` 重导入按新选择替换设备库
- `4e` Flash 基地址 `0x0` 时 `blank-check` 只扫描请求范围

---

## 5. 代码改动

| 文件 | 改动 |
|---|---|
| `python/core/pack_manager.py` | 无效 Pack 校验、导入前解析、`--parts` 校验与设备库清理、卸载前 GC、严格预览 |
| `python/core/pyocd_backend.py` | `check_blank` 的 `0x0` 范围判断 |
| `python/test_pack_support.py` | 新增 4 组回归用例 |
| `python/omni_cli/README.md` | 补充重导入替换设备选择的说明 |

---

## 6. 最终状态与复现

测试结束后已清理 037 Pack（仅保留原有 G32F020/G32F002），并停止后端；DAPLink 处于断开状态。

重新执行完整流程：

```powershell
cd D:\workspace\embedded\omni-link
.\.venv\Scripts\omni.exe backend start

# 预览 / 临时挂包（不写设备库）
.\.venv\Scripts\omni.exe pack preview .\samples\Geehy\Geehy.G32F037_DFP.1.0.0.pack
.\.venv\Scripts\omni.exe probe connect 00350041520000035633344d000258 `
    -t g32f037rb -f 4m --pack .\samples\Geehy\Geehy.G32F037_DFP.1.0.0.pack

# 持久导入（重启后仍生效）
.\.venv\Scripts\omni.exe pack import .\samples\Geehy\Geehy.G32F037_DFP.1.0.0.pack
.\.venv\Scripts\omni.exe probe connect 00350041520000035633344d000258 -t g32f037rb -f 4m
.\.venv\Scripts\omni.exe flash read --type range --addr 0x0 --size 64 --json

# 清理
.\.venv\Scripts\omni.exe probe disconnect 00350041520000035633344d000258
.\.venv\Scripts\omni.exe pack remove Geehy.G32F037_DFP -y
.\.venv\Scripts\omni.exe backend stop
```
