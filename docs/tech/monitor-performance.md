# Monitor 波形采样率优化

> 本文记录 OMNI Work Monitor（波形监控）页面采样率优化的完整方案：从瓶颈分析、实现手段到踩坑修复，供后续开发与维护参考。

## 背景

Monitor 页面通过 pyOCD 直连 DAPLink/STLink/JLink 探针，非侵入式（不暂停 CPU）读取目标 MCU 的 RAM 变量，绘制示波器风格波形。默认采样率档位 1Hz ~ 100kHz，实际可达采样率受**变量布局、探针链路（USB 往返次数）与数据通道（WS/JSON）**三重因素制约。

优化前采样线程每帧对每个"读取分组"独立调用 `target.read_memory_block32()`，多个分组串行执行，**每个分组都是一次完整的 USB 往返**；分组合并阈值仅 16 字节，变量布局分散时会生成大量小分组，进一步放大往返次数。

## 调研：plink 的 4500Hz 是否真实

开源项目 [pushk3n/plink](https://github.com/pushk3n/plink)（Apache-2.0）同样基于 pyOCD 读内存画波形，其提交 [e2d43cd](https://github.com/pushk3n/plink/commit/e2d43cd7d12b3ab61d66736d0e2952382d090575) 声称"针对 dap-link V2 bulk 升级，10MHz 仅采样模式下达到 4500+Hz"。

**核实结论：属实，但有严格前提。**

1. **"仅采样模式"不是 UI 开关**，指关闭绘图、只跑采样循环的测试方式——绘图负载本身是采样率的大头消耗。
2. **4500Hz 是作者实测经验值**，依赖 DAPLink V2（WinUSB bulk）+ 10MHz SWD 时钟 + 少量变量，代码中没有硬性保证。
3. plink 的核心手段（详见下文对比表）均可在本项目复用，但其 Block 合并存在 MEM-AP 页边界缺陷（见 [踩坑记录](#踩坑记录)），本项目实现时已修正。

## 采样链路瓶颈分析

| 环节 | plink（4500Hz 前提） | 本项目优化前 | 说明 |
|------|----------------------|--------------|------|
| SWD 时钟 | 8–10 MHz | 1 MHz 默认 | 物理带宽，最大差距来源（本次未改，连接页已可选速度） |
| 跨 Block 读取 | AP/DP 层流水线，一次 `flush()` 发出全部命令 | `read_memory_block32` 逐组串行，N 组 = N 次 USB 往返 | **本次优化核心** |
| Block 合并 | gap 64KB / max_bytes 按传输类型（HID 1024 / Bulk 2048） | gap 16 字节固定 | 本次优化 |
| 采样节流 | busy-wait 微调（μs 级） | `time.sleep`（ms 级） | 暂未改 |
| 数据通道 | 进程内 numpy 直写，无序列化 | WS + JSON 逐条（rate/8 条/秒） | 结构性差异，暂未改 |

## 优化方案

改动集中在 `python/core/monitor_backend.py` 的**私有实现**（`_read_variables` / `_build_read_groups` / `_pipelined_read`），公开接口签名不变，不影响 Flash / Commander / RTT 等其他页面（详见 [影响面](#影响面)）。

### 1. 跨 Block 流水线读取（`_pipelined_read`）

借鉴 plink 的 `_pipelined_batch_read`，绕过 target 层直接操作 AP/DP 寄存器：

```
dp.write_ap(CSW, 32 位传输)                      # 设置传输宽度（保留原 CSW 控制位）
for 每个 Block:
    dp.write_ap(TAR, 起始地址)                    # 写目标地址（deferred 缓冲）
    cb = dp.read_ap_multiple(DRW, word_count, now=False)  # 批量读（deferred 缓冲）
dp.flush()                                        # 一次发送所有命令
for 每个 Block: words = cb()                      # 逐个取回结果
```

依赖 pyOCD 的 deferred transfers 机制（连接时已开启 `cmsis_dap.deferred_transfers=True`）：`write_ap` / `read_ap_multiple` 的命令先缓冲进 DAP 层命令包，**只有 `dp.flush()` 才真正发送到 USB**。

**效果**：N 个 Block 从 N 次 USB 往返降为 1 次（Bulk V2 探针 pipeline_depth ≥ 6，收益最大）。

### 2. Block 合并策略激进化（`_build_read_groups`）

| 参数 | 优化前 | 优化后 |
|------|--------|--------|
| `MERGE_GAP` | 16 字节 | **64 KB**（合并条件退化为纯大小约束，"带宽换时间"） |
| 单块上限 `max_bytes` | 无 | **Bulk 2048B / HID 1024B / 未知 512B** |
| 最小载荷比 `MIN_PAYLOAD_RATIO` | 无 | **20%**（有效变量字节 / 覆盖总字节，低于则拆块，防止读大段无关 RAM） |
| 地址对齐 | 条件判断 | **强制 4 字节对齐**（统一走更快的 block32） |

### 3. 探针传输类型自适应（`_get_transport_type`）

从 `session.probe._link._interface.is_bulk` 检测探针为 Bulk（CMSIS-DAP v2/WinUSB）或 HID（v1），带缓存（`_transport_type`），探针断开时清理。传输类型决定单块上限，也决定是否启用流水线。

### 4. 自动降级机制（`_pipeline_disabled`）

两层保护，保证**最差性能等于改动前**：

1. **HID 探针不启用流水线**：HID 下 pipeline_depth=1，命令本就逐条往返，流水线无收益只有风险（plink 注释同款判断）。
2. **失败一次即降级**：流水线抛异常 → `_pipeline_disabled[uid] = True` → 后续每帧直接走串行，不再重试；`start()` 新采样会话重置标志（给一次机会），探针断开时清理。失败时会打印一条 `logger.warning`（"Monitor pipelined read failed, disable pipelining..."）便于诊断。

> 串行路径（`_read_variables_serial`）同样使用新的合并策略（64KB gap + 对齐 + max_bytes），因此即使降级，性能也不低于改动前。

## 踩坑记录

### 1. 波形刷新卡顿（失败 → 整批双倍重读）

**现象**：优化上线后波形刷新明显卡顿。

**排查**：逐一排除 `unlock()` 隐含 flush（`debug_probe.py` 的 `unlock` 仅释放 RLock，不 flush，流水线机制成立）、CSW 残留污染（见第 4 条）后，定位到最可能元凶——**流水线在真实探针上失败时，原 fallback 设计是"整批串行重读"，而下次循环还会再尝试流水线**。若探针不兼容流水线，则每帧都执行"失败尝试 + 整批重读"的双倍开销，采样率直接腰斩，波形自然卡顿。

**修复**：引入 `_pipeline_disabled` 降级开关（见 [自动降级机制](#4-自动降级机制pipeline_disabled)），失败一次即永久降级，杜绝双倍读取。

### 2. `target.ap` 不存在（CoreSightTarget / DFP 动态 target）

**现象**：后端日志持续输出 `'Apm32f407ig' object has no attribute 'ap'`（每条对应一次采样启动）。

**根因**：`target.ap` 是标准 `CortexM` 才有的属性（来自构造参数 `CoreSightCoreComponent.__init__`）。本项目目标 APM32F407IG 的 target 由 **CMSIS-Pack（DFP）动态生成**，机制见 `pyocd/target/pack/pack_target.py`：

```python
targetClass = type(subclassName, (superklass,), {
    "__init__": _PackTargetMethods._pack_target__init__, ...
})
# 无内置 family 匹配时 superklass = CoreSightTarget
# _pack_target__init__ 首行 super().__init__ → CoreSightTarget.__init__
```

即 DFP target 继承 **`CoreSightTarget`**（而非 CortexM），有 `self.dp` / `self.aps` / **`self.first_ap`**，唯独没有 `self.ap`。`first_ap` 是 `CoreSightTarget` 的 property（排序后第一个 AP，单核目标即 AHB-AP#0），pyocd 内部也用它取 AP（`pack_target.py` 中 `self._target.first_ap`）。

**修复**：`_pipelined_read` 获取 AP 改为兼容逻辑：

```python
ap = getattr(target, 'ap', None)
if ap is None:
    ap = getattr(target, 'first_ap', None)
if ap is None:
    raise AttributeError(f"target {type(target).__name__} has no accessible AP")
```

### 3. MEM-AP auto-increment 页边界

**问题**：MEM-AP 的 TAR 自增读在越过 `auto_increment_page_size`（默认 1KB）边界时会回绕，跨页的整块 `read_ap_multiple` 会读到错误数据。pyOCD 自己的 `_read_memory_block32` 内部按页拆分（`_read_block32_page`），但 plink 的流水线实现未处理此边界（其 2048B 单块已存在隐患）。

**修复**：`_pipelined_read` 中按页拆分排队，每子页独立 `write_ap(TAR)` + `read_ap_multiple(DRW)`，全部子页仍共用一次 `flush()`：

```python
page_size = getattr(ap, 'auto_increment_page_size', 0x400)
while addr < end:
    page_avail = page_size - (addr & (page_size - 1))
    chunk = min(page_avail, end - addr)
    ...  # write_ap(TAR, addr) + read_ap_multiple(DRW, chunk//4, now=False)
    addr += chunk
```

### 4. CSW 寄存器残留（确认无影响）

流水线直接 `dp.write_ap(CSW, csw | CSW_SIZE32)` 绕过 AP 层，会不会污染 pyocd 的 CSW 缓存（`_cached_csw`）导致后续 8/16 位操作出错？经查 `ap.py` 的 `write_reg`：写入 CSW 前会与 `_cached_csw` 比较，**目标值不同则实际写并更新缓存**——因此后续任何 AP 操作都会把硬件 CSW 写回它认为正确的值，残留 SIZE32 不会造成永久污染，无需恢复。

## 影响面

| 改动 | 影响范围 | 说明 |
|------|----------|------|
| `_pipelined_read` / `_build_read_groups` / `_read_variables` 等 | **仅 Monitor 页面** | 全部为私有实现，Flash / Commander / RTT / SWV 不调用 |
| `_get_transport_type` / `_block_max_bytes` | 仅 Monitor 页面 | 新增私有方法 |
| `_pipeline_disabled` 降级标志 | 仅 Monitor 页面 | `start()` 重置、`on_probe_disconnected` 清理 |
| 公开接口（`pause_during` / `is_running` / `on_probe_disconnected` / `cleanup_all`） | **未改动** | Flash / Commander 依赖 `pause_during`，RTT 依赖 `is_running`，签名保持不变 |

## 验证

离线测试（无需硬件，mock AP/DP 层）：

- `python/test_read_groups.py` — 合并/对齐/载荷比/max_bytes 分组算法，全 PASS
- `python/test_pipelined_read.py` — 流水线成功、异常回退、HID 走串行、失败降级、跨页拆子页、CoreSightTarget（`first_ap`）兼容、缓存复用，全 PASS

线上验证要点：

1. 后端日志**不应再出现** "Monitor pipelined read failed"。
2. 观察 `status` 接口的 `actual_rate_hz`（实际采样率）对比优化前后。
3. 若采样率提升后波形卡顿，说明瓶颈转移到前端数据通道（WS 消息数 = 采样率 / `PUSH_BATCH=8`），后续可做 P2 优化（`PUSH_BATCH` 动态放大 + payload 减重）。

## 后续方向（未实施）

- **P0**：SWD 时钟 1MHz → 4–8MHz（连接页已有速度选项，可主动选择；提频是全局的，需注意探针/线缆稳定性）
- **P2**：WS 通道减负 — `PUSH_BATCH` 随采样率动态放大（如 `max(8, rate//50)`），payload 由 `[{id, value}]` 改为按通道顺序的数值数组
- **P2**：采样节流改为 busy-wait 混合（先 sleep 大部分时间，最后忙等微调，μs 级抖动）
- **P3**：前端 zustand `[...samples, ...pts]` 全量拷贝改为分帧批量提交，降低高频下 GC 压力
