# J-Link + G32F463xC：RTT 启动慢/超时、停止后重启卡死、反复连接残留 测试报告

日期：2026-10-28  
环境：Windows / Python 3.11 / pyOCD 0.44.1（集成于 `python/pyocd`）/ pylink 2.0.1  
硬件：J-Link 150710717 + G32F463xC 目标板（内存映射借用 `apm32f407xg` 以复现 2 个 RAM region）

## 1. 复现

### 1.1 RTT 控制块扫描慢、超时后仍"启动成功"

目标使用 `apm32f407xg` 内存映射时有两个 RAM region：

```
[0] 0x10000000 size=0x10000   ← CCM，本板/本探针组合下完全不可读
[1] 0x20000000 size=0x20000   ← 主 SRAM，RTT 控制块在 0x200000A0
```

旧实现从低地址开始扫，先读 0x10000000：

- 16KB `read_memory_block32` 首次失败耗时 **0.9~9.2s**（J-Link 内部重试）；
- 失败后一路二分到 64 字节，一个 64KB 区段放大成 **约 2048 次读 + 1024 条 WARN**；
- 实测一次 `rtt start` **10.5s / 20.1s**，直接超过 30s 预算（用户现场更慢）；
- 已经超时返回 408 后，后台线程仍会继续扫完并把会话装上去、补发 `rtt.started`，
  造成"前端提示失败/超时，稍后日志又显示启动成功"。

日志特征与用户贴的一致：

```
RTT: 0x1000F2C0~0x1000F300 读取失败（Unspecified error.）
RTT: 0x1000F300~0x1000F340 读取失败（Unspecified error.）
...
```

### 1.2 Stop 后重新 Start 卡死

- 启动超时/停止后，旧轮询线程可能仍卡在一次 DLL 读里；`stop()` 只 `join(2s)`。
- 旧轮询线程每轮从共享字典按 uid 重新取 `_running`/`_control_blocks`，新会话复用
  同一 uid 后，**旧线程会"复活"并继续读新会话**；每次停启都可能多一个轮询线程，
  多个线程同时读同一 target / 抢同一把 J-Link DLL 锁，应用越来越慢直至无响应。
- 同时 `stop()` 不会取消仍在扫描的启动流程，停完还会被后台线程重新装回会话。

### 1.3 多次连接/断开后"残留、再也连不上"

用 `py-spy dump --native` 抓到了两类真实阻塞：

1. `probe-monitor` 线程卡在 **CMSIS-DAP（libusb/HID）枚举**：

   ```
   HidD_SetFeature (hid.dll)
   libusb_interrupt_transfer (libusb-1.0.dll)
   get_all_connected_interfaces (pyocd/probe/pydapaccess/interface/pyusb_v2_backend.py)
   ... list_probes -> detect_probe_changes -> probe_monitor._poll_loop
   ```

   旧 `list_probes()` 用一把 `JLINK_DLL_LOCK` **包住整段聚合枚举**（包含上面的
   DAPLink 枚举），于是一个与 J-Link 无关的慢枚举会把所有 J-Link 操作挡在锁外。

2. 连接线程卡在 `ConnectHelper.session_with_chosen_probe()` → `choose_probe()` →
   **CMSIS-DAP 枚举**（即使 `unique_id` 指向 J-Link，聚合器仍会扫所有探针类型）：

   ```
   get_active_configuration (usb/core.py)
   get_all_connected_interfaces (pyusb_v2_backend.py)
   get_probe_with_id (cmsis_dap_probe.py)
   choose_probe -> session_with_chosen_probe -> _do_connect
   ```

   前端 axios 默认 10s，先于后端 15s/HTTP 20s 超时；用户看到
   `timeout of 10000ms exceeded` 就再点一次，于是每次重试再起一个线程。被丢弃的
   线程持有 pylink 的跨进程锁文件 `.pylink-usb-150710717.lck`，**其它进程/后续连接
   全部报 "J-Link is already open"**，只能重启后端——即用户说的"DLL 进程残留"。

   复测中还发现：上一版加在超时路径里的"关闭迟到会话"逻辑若直接 `future.result()`，
   会把 HTTP 线程重新阻塞回原生调用（实测请求卡到 30s+），本次已修正为只在
   `future.done()` 时处理。

### 1.4 连续连接/断开后 `0xc000001d`、DLL 永久损坏（补充复现）

按"连接→断开"循环压测，第 **6** 次连接即出现：

```
Connecting to probe 150710717...
仿真器连接失败（150710717）：exception: privileged instruction      ← 0xc000001d
仿真器连接失败（150710717）：J-Link DLL 无响应（上一次调用超过 5s 未返回）...
仿真器连接失败（150710717）：J-Link DLL 无响应（上一次调用超过 5s 未返回）...
```

之后无论怎么重试都失败，**拔插 USB 也没用**。这与用户 16:06~16:07 的日志一致
（用户是 `[WinError -1073741795] Windows Error 0xc000001d`）。

根因在 **pylink 的全局 DLL 回调悬垂指针**：

- `pylink.JLink.__init__` 每个实例都会创建 4 个 `ctypes.CFUNCTYPE` 回调，并通过
  `JLINKARM_EnableLog` / `EnableLogCom` / `SetErrorOutHandler` / `SetWarnOutHandler`
  注册到 **JLinkARM.dll 的全局函数指针**；
- 这些 trampoline 的生命周期却绑在 Python 实例上。实例被回收后，DLL 里仍留着
  指向已释放内存的指针；
- 下一次 DLL 输出日志/错误（例如 `JLINKARM_OpenEx` 内部）就会跳进野指针，
  ctypes 把原生异常翻译成 `0xc000001d`；DLL 内部状态被破坏后，后续所有调用
  要么直接崩、要么卡住——进程内无法恢复，只能重启后端。

而本应用每次枚举/连接都会创建并丢弃多个 `pylink.JLink`（pyOCD 聚合器每 2s 枚举
一次就会建 2 个），所以"连续连接/断开几次后必崩"。这也解释了为什么拔插 USB 无效：
坏的是进程内 DLL 的全局指针，不是 USB 连接。

## 2. 修复

### 2.1 RTT 扫描（`python/core/rtt_backend.py`）

| 改动 | 效果 |
| --- | --- |
| 扫描顺序改为「主 SRAM（0x2000_0000~0x3FFF_FFFF）优先，其次容量大者」 | 常见固件 0.2s 内命中，**完全跳过不可读的 CCM** |
| 每个 region 先做 16 字节可读性探测，失败即整段跳过 | 不再用 16KB 大读去"发现"坏区段 |
| 坏块二分限制 2 级（16KB→4KB→1KB），1KB 失败即整段跳过 | 单块失败从 2048 次读降到 ~21 次 |
| 失败明细上限 8 条 + 每 region 一条汇总日志 | 不再刷屏 1024 条 WARN |
| 连续 2 个 16KB 块失败判定整段不可读，提前结束 | 探测能过但后续读不动的区段也不会扫到底 |
| 本次启动内记住"已确认不可读"范围，复位重试时跳过 | 避免每次重试再吃一次 J-Link 数秒失败延迟 |
| 用户指定地址也上报读失败，不再误报"未找到控制块/固件没初始化" | 错误信息可执行 |
| 扫描每块检查取消令牌 | Stop/超时可在一次读内退出 |

### 2.2 RTT 会话生命周期（同文件）

- 引入 `_RttSession`（会话对象）与 `_StartToken`（启动取消令牌）：
  - 轮询线程持有创建时的 session，每轮校验"我仍是当前会话"；stop 后旧线程必然退出，
    **不会因新会话复用 uid 而复活/重复读取**；
  - `start()` 同一探针只允许一个启动流程，重复请求立即返回 `busy`；
  - HTTP 超时 / `stop()` 会置位取消令牌，后台线程在下一个检查点退出，**不会在失败
    通知之后偷偷把会话装上去**；
  - `stop()` 不再长等轮询线程（join 1s），并先取消在途启动。

### 2.3 J-Link 连接与探针枚举（`python/core/pyocd_backend.py`、`python/core/jlink_lock.py`）

- 连接时用 pyOCD 支持的 `"jlink:<serial>"` 前缀，**只查 J-Link 后端**，避开
  CMSIS-DAP/libusb 枚举（本次卡顿的真正来源）。
- `list_probes()` 不再用 `JLINK_DLL_LOCK` 包住整段（含 DAPLink）枚举；pylink 调用
  已由 `install_pylink_lock` 逐个加锁。
- `JLINK_DLL_LOCK` 等待上限 5s：卡死时抛 `JLinkDllBusy`（明确提示重启后端/重插探针），
  并进入 15s 冷却期让后续调用立即失败，**不再无限排队、耗尽线程池**。
- `connect()` 增加"同一探针只允许一个连接尝试"闸门（TTL 45s）：上一次没返回时后续
  请求 0.4s 内失败并提示，不再叠加卡死线程；显式断开可清除标记。
- 迟到的连接（超时后才 open 成功）通过 `future` 完成回调自动关闭，释放探针；
  该回调只在 `future.done()` 时读取结果，不会阻塞请求线程。

### 2.4 超时对齐 / 前端状态

- 前端 `connectProbe` 超时 10s → **30s**（后端 15s + HTTP 20s 先返回，前端不会再提前判死）。
- CLI `omni rtt start` 默认超时 30s → **45s**（大于后端 30s）。
- `RttTabBar` 用操作序号丢弃迟到的启动结果：Stop 之后返回的"启动成功"不再改状态、
  也不再弹成功通知；停止时同步清掉 `starting`。

### 2.5 J-Link 全局回调 hub（`python/core/jlink_lock.py`）

- `install_pylink_lock()` 在加锁的同时调用 `install_pylink_callback_hub()`：
  把 `JLinkFunctions.LOG_PROTOTYPE` / `UNSECURE_HOOK_PROTOTYPE` 替换成
  `_CallbackHub`；
- 每个进程只创建一个 CFUNCTYPE trampoline（永久持有），所有 `pylink.JLink` 实例
  复用它；真正要调的 Python handler 存在 hub 里按实例替换；
- DLL 里的函数指针因此永远有效，实例回收不再产生悬垂指针，也不会随枚举次数增长
  内存；
- 必须在创建任何 `pylink.JLink` 之前安装（后端 lifespan 启动时、probe monitor 之前）。

## 3. 验证

### 3.1 实机（J-Link 150710717 + G32F463xC）

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| `probe connect`（2 region 映射） | 15s 超时 / 重试仍超时 | 0.6~1.8s，5 次断开重连 0.83~0.93s |
| 连续"连接→断开"压测 | **第 6 次 `0xc000001d`，之后永久失效** | **30 + 60 次 0 错误**，线程稳定 |
| 连接/RTT 启停混合压测 | — | **20 轮 0 错误**（connect→rtt start→stop→disconnect） |
| `rtt start` 自动扫描（控制块在 SRAM） | 10.5~20.1s，1024 条 WARN，可能超时 | **0.69~1.28s**，0 条 WARN |
| 显式扫描不可读 CCM（0x10000000, 64KB） | 20s+，1024 条 WARN | 3.2~3.4s，1 条明确结论 |
| 扫描中 Stop → 再 Start | 状态错乱/卡死 | stop 0.6s；旧启动返回"已取消"；重启 0.7~0.8s |
| 5 次 RTT 停启后线程 | 轮询线程累积 | 稳定 1 个 `rtt-poll-*` |
| 5 次断开/重连后线程 | 10+ 且卡死 | 稳定 3 个（主/监控/一个工作线程） |
| 并发第二次 `rtt start` | 排队 6s 后失败 | 0.62s 返回"启动仍在进行中" |

### 3.2 离线回归测试（无需硬件）

```powershell
cd python
..\.venv\Scripts\python.exe test_rtt_scan.py          # ALL PASS（9 组）
..\.venv\Scripts\python.exe test_jlink_timeouts.py    # ALL PASS（4 组，含回调 hub）
..\.venv\Scripts\python.exe test_cli_fixes.py         # ALL PASSED
..\.venv\Scripts\python.exe test_monitor_cli.py       # ALL PASS
..\.venv\Scripts\python.exe test_session_integration.py  # ALL PASS
```

前端类型检查：

```powershell
npm run typecheck:node
npm run typecheck:web
```

## 4. 备注 / 后续建议

- 不可读 RAM 区段的**首次** J-Link 访问本身仍有 2~3s 失败延迟（DLL 内部重试，Python
  侧无法取消）。现在的策略是"最多付一次"，并优先扫主 SRAM 把它完全避开。
- 若某次 J-Link `open()` 在 DLL 内永久卡住，Python 无法强杀该线程；应用其余部分
  仍可用，按错误提示重启后端即可（`omni backend stop`）。
- 建议后续给 `rtt start` 增加"扫描区域"配置项，让用户可直接排除 CCM/DTCM。
