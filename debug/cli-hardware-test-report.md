# OMNI CLI 实机测试报告

> 测试目的：确认 OMNI CLI 能否用于真实硬件上的驱动/文件系统验证。
> 被测固件：`omni-emb/examples/fatfs/fatfs_ram_disk`（STM32F407IG，RAM 盘 + FatFs）。
> 结论：**可用，但缺少 RTT 上行读取能力，日志断言无法做。**

---

## 0. 环境

| 项 | 值 |
|----|----|
| 日期 | 2026-10-20 |
| CLI 版本 | `omni 0.1.0` |
| CLI 路径 | `D:\Program Files\OMNI Link\resources\python\omni.exe` |
| 后端 | `omni-backend.exe`，按需启动 |
| 探针 | SEGGER J-Link Compact PLUS（V12），S/N `852001270`，VTref 3.296 V |
| 目标 | STM32F407IG，device id `0x413`，1 MiB Flash / 128 KiB RAM |
| 固件 | Code 27836 B，RO 1136 B，RW 24 B，ZI 69776 B（含 64 KiB RAM 盘） |
| 宿主 | Windows，PowerShell 7 |

被测固件的预期行为：上电后挂载 `0:`；无文件系统则 `f_mkfs`；建目录、写文件、读回、列目录、查剩余空间；然后 500 ms 翻转 LED。

---

## 1. 总体结论

| 能力 | 状态 |
|------|------|
| 探针枚举 / 连接 / 目标识别 | ✅ 可用 |
| Flash 烧录 / 校验 / 读取 / 空白检查 | ✅ 可用 |
| 寄存器读取 | ✅ 可用 |
| 内存读取 | ✅ 可用 |
| 内核 halt / run / reset | ✅ 可用 |
| Commander 命令 | ✅ 可用（注意参数顺序） |
| RTT 会话启动 / 通道枚举 | ✅ 可用 |
| **RTT 上行数据读取** | ❌ **缺失（P0）** |
| 长时间稳定性 / 错误恢复 | ⚠️ 存在问题（P1） |
| 中文输出 | ❌ 乱码（P1） |

已用 CLI 完成的有效验证：

| 检查 | 命令 | 结果 |
|------|------|------|
| 设备已登记 | `debug mem read --addr 0x20000520 --size 4` | `b0700008` → `0x080070B0` = `_dev_disk1` |
| FAT 引导扇区 | `--addr 0x20000524 --size 16` | `ebfe90 4d53444f53352e30 0002 01 01 00` |
| 扇区大小 | 同上 | `0x0200` = 512 B，与 `FF_MAX_SS` 一致 |
| 引导签名 | `--addr 0x20000722 --size 2` | `55aa` |

---

## 2. 问题清单

优先级定义：

- **P0**：阻断目标场景（实机日志验证）。
- **P1**：功能错误或严重可用性问题。
- **P2**：误导性行为，影响脚本判断。
- **P3**：一致性与文案问题。

---

### P0-1 无法读取 RTT 上行数据

**现象**

`rtt start` 成功，`rtt channels` 显示 `Terminal` 通道 1024 B。但没有任何命令能取出数据。

**复现**

```powershell
omni rtt start --json
omni rtt channels --json
omni rtt read          # 不存在
```

**实际输出**

```text
$ omni rtt read
usage: omni rtt [-h] <sub> ...
omni rtt: error: argument <sub>: invalid choice: 'read'
  (choose from 'status', 'start', 'stop', 'channels', 'send', 'device')
```

后端 OpenAPI 中同样没有读取端点。当前 RTT 相关路由只有：

```text
/api/probes/{uid}/rtt/channels
/api/probes/{uid}/rtt/device/halt
/api/probes/{uid}/rtt/device/reset
/api/probes/{uid}/rtt/device/run
/api/probes/{uid}/rtt/device/state
/api/probes/{uid}/rtt/send
/api/probes/{uid}/rtt/send-text
/api/probes/{uid}/rtt/start
/api/probes/{uid}/rtt/status
/api/probes/{uid}/rtt/stop
```

**数据确实存在**

通过 `debug mem read` 解码控制块，确认缓冲区内有 290 字节未读日志：

```text
aUp[0]: pBuffer=0x200000D8 size=1024 WrOff=290
buffer head: <inf> [app]: mkfs: 0
             <inf> [app]: mkdir: 0
```

**原因定位**

- `python/api/rtt.py`：路由列表见行 65 / 74 / 107 / 113 / 122 / 136 / 148 / 157 / 166 / 191，无读取路由。
- `python/core/rtt_backend.py:527` `_poll_loop()`：轮询线程读到数据后，行 575 只做 `event_manager.emit("rtt.data", ...)`，数据走 WebSocket 给 GUI，没有落地缓存，也没有 REST 出口。

**建议修复**

1. 在 `rtt_backend` 内为每个 `uid` 增加一个有界环形缓冲（例如 64 KiB），`_poll_loop` 读取后同时追加进去，并维护单调递增的 `seq` 与 `dropped` 计数。
2. 新增 `GET /api/probes/{uid}/rtt/data?since=<seq>&max_bytes=<n>`，返回 `{seq, data_base64, truncated}`。
3. CLI 新增：

   ```text
   omni rtt read [--uid UID] [--channel N] [--max-bytes N] [--follow] [--out FILE] [--json]
   ```

   `--follow` 按 `seq` 轮询增量；`--out` 落盘；`--json` 返回原始 base64 便于 CI。
4. 保留现有 WebSocket 通道给 GUI，REST 与 WS 读同一环形缓冲，避免双份数据。

**验收**

`omni rtt read --follow` 能持续打印 `<inf> [app]: mkfs: 0` 等日志；`--json` 能给出可断言的文本。

---

### P1-1 `probe connect` 漏 `--target` 会拖死后端

**复现**

```powershell
omni backend start
omni probe connect 852001270        # 故意不带 --target
```

**实际输出**

```text
错误: timed out
```

随后后端进入半死状态：

```text
$ omni backend status
运行中  端口=55381  pid=26080，HTTP 无响应

$ omni probe status 852001270
错误: 未找到正在运行的后端。
```

进程仍在（`omni-backend` pid 26080 存活），必须 `omni backend stop` 才能恢复。

**原因定位**

- `python/api/probes.py:15-22`：`SetTargetRequest` 中 `target` 与 `speed` 都是可选。
- 同文件 `:53-72`：连接处理未在 `target` 为空时提前返回 400，直接把 `None` 交给 pyOCD。pyOCD 无目标型号时会长时间探测，阻塞后端。

**建议修复**

1. `target` 缺省时立即返回 400，消息写明「`--target` 必填，可用 `omni target list` 查询」。
2. 连接流程整体加超时，并把 pyOCD 调用放到可取消的工作线程；超时后释放 session。
3. CLI 帮助把 `--target` 标为必需（或给出交互式选择）。

---

### P1-2 后端 HTTP 会整体无响应

**现象**

除 P1-1 外，`flash program` 异常路径也触发过同样状态。

**实际输出**

```text
$ omni debug status
错误: 未找到正在运行的后端。
```

但同一时刻：

```text
GET /api/health      → {"status":"ok","pid":28004,"ws_connections":0}
GET /api/probes/states → 请求超时（5 s 无响应）
```

即：健康检查可用，探针相关路由全部阻塞。

**原因定位**

后端在探针操作上持有全局/每 uid 锁（`rtt_backend` 中有 `_ops_locks`、`_global_lock` 等）。一次挂起的 pyOCD 调用会长期占锁，后续请求排队直至 HTTP 超时。

**建议修复**

1. 所有硬件调用设硬超时（建议 5–30 s，按操作类型）。
2. 超时后强制标记该探针 session 失效，并释放锁，不要等待 `to_thread` 线程结束。
3. `/api/probes/states` 与 `/api/probes` 不应等待硬件锁，返回缓存状态即可。

---

### P1-3 报错误导：把「后端无响应」说成「后端未运行」

**现象**

后端进程存活但 HTTP 无响应时，除 `backend status` 外的命令统一输出：

```text
错误: 未找到正在运行的后端。请先执行 `omni backend start` ...
```

用户会误以为后端没启动，重复 `backend start`。

**建议修复**

CLI 在收到连接错误时区分三种情况：

| 情况 | 提示 |
|------|------|
| 端口无监听 | 未找到后端，请 `omni backend start` |
| 端口有监听但请求超时 | 后端无响应，建议 `omni backend stop` 后重启 |
| 后端返回 5xx | 透传后端错误 |

`backend status` 已能识别第二种，其他命令应复用它。

---

### P1-4 中文全部乱码（U+FFFD）

**现象**

所有中文帮助、表头、提示都是 `�`。

**证据**

`omni backend -h` 的原始字节，首个非 ASCII 在偏移 84：

```text
EF BF BD EF BF BD EF BF BD EF BF BD EF BF BD EF BF BD D7 A4 EF BF BD EF BF BD EF BF BD 20 64 61 65 6D 6F 6E
```

- `EF BF BD` 是 UTF-8 的 U+FFFD，说明字符串在打印前就已损坏。
- 中间夹着 `D7 A4`（GBK 的「驻」），说明文本经历过一次「按 GBK 解码 → 非法序列替换 → 再按 UTF-8 输出」。

**排除控制台因素**

设置 `PYTHONIOENCODING=utf-8` 前后，U+FFFD 序列数都是 23，与代码页无关。

**排查结果**

- `python/omni_cli_main.py`、`python/api/rtt.py`、`python/api/probes.py` 均为 UTF-8 无 BOM，源码中不含 U+FFFD。
- `python/omni_cli/cli.py` 没有 `sys.stdout.reconfigure(...)` 之类的编码设置。
- 安装目录 `resources/python/` 只有 `omni.exe` / `omni-backend.exe` / `_internal`，无法核对运行期字符串。

**推断**

安装包里的冻结产物与当前源码不一致（旧构建或构建期编码问题），不是源码问题。

**建议修复**

1. 用当前源码重新构建 CLI，构建前后校验：`omni backend -h | Select-String ([char]0xFFFD)` 应为空。
2. 在 CLI 入口显式设置输出编码，让问题暴露而不是静默替换：

   ```python
   sys.stdout.reconfigure(encoding="utf-8", errors="strict")
   sys.stderr.reconfigure(encoding="utf-8", errors="strict")
   ```

   若担心 CI 环境，可退回 `errors="backslashreplace"`，至少不会产生 U+FFFD。
3. 构建脚本加一步「源码编码检查」：禁止提交含 U+FFFD 的 `.py`。

---

### P2-1 会话已死时返回假成功

**复现**

在一次失败的 `flash program` 之后执行：

```powershell
omni debug regs --json
```

**实际输出**

```json
{
  "success": true,
  "registers": [],
  "errors": [
    { "name": "r0", "error": "Target is not connected." },
    { "name": "r1", "error": "Target is not connected." }
  ]
}
```

退出码 0。

同时 `debug status`：

```json
{ "success": true, "connected": true, "state": "unknown", "pc": null }
```

**问题**

- `success: true` 但 `registers` 为空。
- `connected: true` 与底层 `Target is not connected.` 矛盾。
- 退出码 0，CI 会误判通过。

**原因定位**

`python/api/zone.py` 多处使用同一模式：

```python
if not result["success"] and result.get("error"):
    raise HTTPException(...)
return {"success": True}
```

当底层返回 `success: False` 但 `error` 为 `None`（错误放在 `errors[]` 列表里），就被当成成功。同类模式见 `:157`、`:221`、`:249`、`:308`。

**建议修复**

1. 判据改为 `if not result["success"]: raise ...`，不再要求 `error` 非空。
2. 寄存器接口在 `registers` 为空且有 `errors` 时返回 503，并给出首个错误摘要。
3. `debug status` 的 `connected` 必须以 pyOCD session 实际状态为准；取不到状态时 `state` 用 `"unknown"` 且 `success: false`。

---

### P2-2 `--speed` 单位与错误信息不清

**复现**

```powershell
omni probe connect 852001270 --target stm32f407xg --interface swd --speed 4000
```

**实际输出**

```text
错误: Given speed is too slow.  Minimum is 5.
```

帮助里写的是「时钟频率 Hz」。4000 Hz = 4 kHz，低于 5 kHz 下限，判断本身正确，但错误信息没有单位，用户不知道 5 指什么。

另外失败后探针状态变成 `error`，必须 `disconnect` 才能重连。

**建议修复**

1. 错误信息补单位：`Minimum is 5 kHz (--speed 5000 in Hz)`。
2. 或在帮助中统一用 kHz，并在解析处直接换算。
3. `connect` 失败后自动回滚到 `disconnected`，不要让状态卡在 `error`。

---

### P2-3 `--target` 未标记为必需

见 P1-1。帮助中 `--target` 显示为可选，但实际是必需项。

---

### P3-1 `flash verify` 返回 `bytes_written`

**实际输出**

```json
{ "success": true, "bytes_written": 0, "duration_ms": 3, "error": null }
```

校验操作不写 Flash，字段名误导。

**位置**：`python/api/flash.py:75-79`。

**建议**：改为 `bytes_verified` 或 `bytes_compared`；或在 verify 响应里移除该字段。

---

### P3-2 `commander exec` 选项顺序与其它命令不一致

**复现**

```powershell
omni commander exec "read32 0x08000000 4" --timeout 15
# → 错误: incorrect number of arguments

omni commander exec --timeout 15 read32 0x08000000 4
# → 08000000:  200110a8
```

`--timeout` 被当成命令参数。帮助里确有说明，但错误信息没有指出原因。

另外 `commander exec` 不接受 `--json`，与其它子命令不一致。

**建议修复**

1. 用 `argparse.REMAINDER` 前先抽取全局选项，或提示「全局选项须放在命令之前」。
2. `commander exec` 支持 `--json`，输出结构化结果。

---

### P3-3 非确定性异常（未复现，供参考）

测试早期出现过两次，之后无法复现：

| 现象 | 记录 |
|------|------|
| `flash program` 返回 `{"success": false, "bytes_written": 0, "duration_ms": 5005, "error": "Unspecified error."}` | duration 恰好 5005 ms，像 5 s 内部超时 |
| `flash verify` 耗时 80 263 ms 后返回 `success: true, bytes_written: 0` | 同批次，后续为 3 ms |

两次都伴随后端进入 P1-2 的无响应状态。

**建议**：在 pyOCD 调用处补充详细日志（操作名、地址、耗时、异常栈），把 `Unspecified error.` 替换为具体原因。

---

## 3. 当前可用的完整命令序列

```powershell
# 1. 启动后端
omni backend start

# 2. 连接探针（--target 必需，速度单位 Hz）
omni probe connect 852001270 --target stm32f407xg --interface swd --speed 4000000

# 3. 烧录与校验
omni flash program <file.hex> --json --timeout 60
omni flash verify  <file.hex> --json --timeout 60

# 4. 运行
omni debug run --json

# 5. 读内存 / 寄存器
omni debug mem read --addr 0x20000524 --size 16 --json
omni debug regs --json

# 6. Commander（全局选项在前）
omni commander exec --timeout 15 read32 0x08000000 4

# 7. 收尾
omni backend stop
```

---

## 4. RTT 读取的临时绕法

在 `rtt read` 补齐前，可先读控制块，再读缓冲区。

```powershell
# 控制块：签名(16) + up数(4) + down数(4) + aUp[0]{pName,pBuffer,Size,WrOff,RdOff,Flags}
omni debug mem read --addr 0x20000020 --size 40 --json

# 取 aUp[0].pBuffer / WrOff 后读取缓冲区
omni debug mem read --addr 0x200000D8 --size 290 --json
```

控制块地址可通过搜索 RAM 中的 `SEGGER RTT` 签名获得（本次为 `0x20000020`）。

> 该绕法依赖应用链接布局，不能替代正式的 `rtt read`。

---

## 5. 修复优先级建议

| 优先级 | 项 | 工作量估计 |
|--------|----|-----------|
| P0 | RTT 上行读取（后端环形缓冲 + REST + CLI） | 中 |
| P1 | 中文编码（重新构建 + 显式 UTF-8 + 构建检查） | 小 |
| P1 | 后端不阻塞、失败可恢复、统一报错 | 中 |
| P1 | `--target` 必填校验与快速失败 | 小 |
| P2 | 会话死亡时返回 `success: false` 与非零退出码 | 小 |
| P2 | `--speed` 单位与状态回滚 | 小 |
| P3 | `verify` 字段改名、`commander` 参数与 `--json` | 小 |

---

## 6. 验收清单

修复后请逐项确认：

- [ ] `omni rtt read --follow` 能持续打印目标日志
- [ ] `omni rtt read --json` 返回可断言的文本与 `seq`
- [ ] `omni backend -h` 输出无 U+FFFD
- [ ] `omni probe connect <uid>`（不带 `--target`）立即返回 400，后端仍可用
- [ ] 任意一次失败的 `flash program` 之后，`debug regs` 仍可用（不需重启后端）
- [ ] 会话失效时 `debug regs` 返回 `success: false` 且退出码非 0
- [ ] `flash verify --json` 不再返回 `bytes_written`
- [ ] `omni commander exec "read32 0x08000000 4" --timeout 15` 可用，或报错信息明确

---

## 附录 A：RTT 控制块原始数据

```text
address: 0x20000020
hex: 53454747455220525454000000000000 03000000 03000000
     41700008 d8000020 00040000 22010000
```

| 字段 | 值 |
|------|-----|
| signature | `SEGGER RTT` |
| MaxNumUpBuffers | 3 |
| MaxNumDownBuffers | 3 |
| aUp[0].pName | `0x08007041` |
| aUp[0].pBuffer | `0x200000D8` |
| aUp[0].Size | 1024 |
| aUp[0].WrOff | 290 |

缓冲区首部内容：`<inf> [app]: mkfs: 0` / `<inf> [app]: mkdir: 0`

---

## 附录 B：乱码字节样本

```text
$ omni backend -h   (hex, 从偏移 84)
EF BF BD EF BF BD EF BF BD EF BF BD EF BF BD EF BF BD
D7 A4 EF BF BD EF BF BD EF BF BD 20 64 61 65 6D 6F 6E
```

`EF BF BD` × N = 多个 U+FFFD；`D7 A4` = GBK「驻」的残留字节。

设置 `PYTHONIOENCODING=utf-8` 前后统计：

```text
PYTHONIOENCODING=utf-8 -> U+FFFD sequences: 23
default                -> U+FFFD sequences: 23
```

---

## 附录 C：测试脚本片段

```python
# 读取 RTT 控制块并解析 aUp[0]
import json, subprocess, struct

def mem_read(addr, size):
    out = subprocess.run(
        ["omni", "debug", "mem", "read", "--addr", hex(addr), "--size", str(size), "--json"],
        capture_output=True, text=True, encoding="utf-8")
    return bytes.fromhex(json.loads(out.stdout)["data_hex"])

cb = mem_read(0x20000020, 40)
assert cb[0:10] == b"SEGGER RTT"
p_buf = struct.unpack_from("<I", cb, 28)[0]
wr    = struct.unpack_from("<I", cb, 36)[0]
print(hex(p_buf), wr, mem_read(p_buf, wr).decode("utf-8", "replace"))
```
