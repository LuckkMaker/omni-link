# OMNI Tool 上位机功能开发计划

> 状态：**M1 / M2 已完成并在实机验证**（M3 预留，未实现）
> 目标版本：omni-link 0.5.x
> 关联固件：`omni-emb/applications/industrial/omni_tool_app`、`omni-emb/applications/industrial/omni_tool_boot`
> 协议基线：`HOST_COMMANDS.md` **v0.3**（模式 B 镜像型）

本文是给 **OMNI Tool（多功能调试工具）** 配套上位机功能的开发计划。上位机承载在 omni-link 内，以独立模块形式接入，不改动既有功能。

---

## 1. 背景与目标

OMNI Tool 是运行在 STM32F407IG/H743II 上的多功能调试工具，支持 CMSIS-DAP 在线调试、离线烧录、协议透传、示波器、逻辑分析等。上位机侧需要一个统一入口来：

1. **boot 自升级**：通过 boot 的 IAP 通道给工具自身刷新固件。
2. **在线烧录**：把工具当作 CMSIS-DAP 探针，烧写外部目标 MCU（复用 omni-link 现有能力）。
3. **脱机烧录 / 协议透传 / 高速采样**（示波器、逻辑分析）：**本轮只预留，不实现**。

### 已验证的初始验证范围

| 链路 | 说明 | 本轮 |
|---|---|---|
| boot 自升级 | app → boot → 擦除/下载/校验/跳转 → app | **实现** |
| app 在线烧录 | 工具作为 CMSIS-DAP 烧外部目标 | **验证（复用现有页）** |
| app 脱机烧录 | 固件侧机制未完成 | 预留 |
| 协议透传 / 采样 | 依赖高速数据通道，未定 | 预留 |

---

## 2. 现状盘点（两套固件 / 两套协议）

工具以 **USB 复合设备** 形式工作，同一 VID `0xC251`，靠 PID 区分人格：

|  | omni_tool_boot | omni_tool_app |
|---|---|---|
| PID | `0x1000` | `0x1001` |
| 传输 | USB CDC 虚拟串口 | CDC（命令口）+ WinUSB（CMSIS-DAP v2） |
| 协议 | **Modbus RTU**，多字节字段 **大端 BE** | **自定义二进制包**，多字节字段 **小端 LE** |
| 报文 | PDU 自定义功能码 | 定长 64B 包，环形缓冲深 4 |
| 职责 | 给工具**自身**刷固件（App 区） | 进 FLASHER 模式后用 SWD 烧**外部目标** |

### 2.1 boot 协议（Modbus RTU，大端，带 CRC16）

| 功能码 | 语义 | 请求 | 响应 |
|---|---|---|---|
| FC101 `0x65` | 下载 | `[4B addr BE][2B len BE][data]` | `[4B addr BE][2B written_len BE]` |
| FC102 `0x66` | 上传/读回 | `[4B addr BE][2B len BE]` | `[4B addr BE][len 字节 data]` |
| FC103 `0x67` | 控制 | `[2B sub BE][4B data BE]` | `[2B sub BE][4B data BE]` |
| FC104 `0x68` | 读信息 | 空 | `[4B version BE][12B MCU UID BE]` |

- FC103 子功能：`0x01` SET_ADDR、`0x02` ERASE、`0x03` LEAVE。
- 地址/长度必须 **4 字节对齐**；单帧下载数据 ≤ 244B，单帧读取 ≤ 248B。
- 擦除**一次只擦一个扇区**，F407 App 区共 7 个扇区，**单扇区耗时 1~2s**。
- 地址范围：Boot `0x08000000`，App `0x08010000 ~ 0x080E0000`，DAP 区 `0x080E0000`。
- 参考实现已存在且已验证：`omni_tool_boot/boot_iap_test.py`（**M1 直接移植，不重新发明**）。

### 2.2 app 命令协议（自定义二进制，小端，64B 包）

| 命令 | ID | 本轮用途 |
|---|---|---|
| INFO | `0x00` | 读厂商/产品/固件版本/能力/包参数 |
| MODE | `0x01` | 切模式；`0x03`=FLASHER、`0x02`=DAP、`0xFF`=BOOT（写 magic `0xABCD1234`@`0x20000000` + 复位） |
| FLASH | `0x20` | **在线烧录**（M2 已用）：模式 A `OPEN/WRITE/ERASE/CLOSE/READ/RECOVER` + 模式 B `OPEN_IMAGE/IMAGE_DATA/IMAGE_VERIFY` |
| EXECUTE_COMMANDS | `0x7F` | 批量执行 |
| QUEUE_COMMANDS | `0x7E` | 协议层排队标记 |

- INFO 子项：`0x01` VENDOR、`0x02` PRODUCT、`0x03` SER_NUM（**固件为 TODO**）、`0x04` FW_VER、`0xF0` CAPABILITIES（**当前 `0x00 0x00`**）、`0xFE` PACKET_COUNT、`0xFF` PACKET_SIZE。
- 错误码：`[1]` 为 `0x00` 成功，否则 `(uint8_t)(-errno)`。注意固件 `omni/errno.h` **不是 Linux 取值**：
  `0x05` EIO / `0x13` ENODEV / `0x16` EINVAL / `0x4D` EBADMSG / `0x74` ETIMEDOUT /
  `0x78` EALREADY / `0x86` ENOTSUP / `0x8A` EILSEQ。
  （Linux 的 `ENOTSUP=95`、`EALREADY=114`、`ETIMEDOUT=110` 都是错的，别抄。）
- `MODE(BOOT)` **不回包**即复位，上位机须按"无响应 = 成功进入 boot"处理。
- 文档：`omni_tool_app/docs/HOST_COMMANDS.md`（**v0.3**）。

### 2.3 omni-link 侧可复用能力

- 探针/目标/烧录：`src/pages/flash`、`src/pages/zone`，后端 `python/core/pyocd_backend.py`。
- 事件推送：WebSocket `/ws` + `core/events.py` 的 `event_manager`。
- 打包：`python/omni-backend.spec`（PyInstaller，`hiddenimports` 为**显式白名单**）。
- **缺串口能力**：`python/requirements.txt` 无串口库，需新增 `pyserial`。

---

## 3. 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 功能范围 | boot 自升级 + 在线烧录（验证）；脱机/透传/采样**预留** |
| D2 | 模块隔离 | **只在后端**新增独立 `omni_tools` 目录；前端沿用现有目录结构 |
| D3 | 页面归属 | 新开**顶层路由 `/omni-tool`**，不并入现有 `/tools`（离线小工具）子菜单 |
| D4 | 模式并发 | 工具侧**单功能互斥**；上位机需提示 DAP 会话将被中断 |
| D5 | boot 固件来源 | M1 **手工选择 .bin**，不做内置固件库/版本管理 |
| D6 | CLI | **暂不同步** |
| D7 | 透传通道 | 预估仍走 CDC，本轮仅预留接口位 |

---

## 4. 架构与目录

omni-link 为 electron-vite 双根结构（前端 `src/`、后端 `python/`），无法合并为单一顶层目录。隔离策略：**后端自包含模块 + 前端沿用现有约定**，外部触点压到 4 处。

```
python/omni_tools/                 # 后端自包含（唯一新增目录）
  __init__.py
  router.py                        # FastAPI 路由，前缀 /api/omni-tool
  device_finder.py                 # 按 VID/PID 枚举 COM 口、识别设备人格
  protocol/
    __init__.py
    serial_link.py                 # pyserial 收发、超时、重试、日志
    modbus_rtu.py                  # Modbus RTU 组帧 + CRC16
    boot_iap.py                    # FC101/102/103/104 语义封装
    app_cmd.py                     # app 64B 小端命令通道（INFO / MODE_BOOT）
```

```
src/pages/omni-tool/               # 前端（沿用现有 pages 约定）
  index.tsx                        # 页面：设备发现 / 固件升级 / 预留页签
  components/                      # 设备卡片、进度、日志、危险操作确认
  service.ts                       # API 客户端（axios）
  store.ts                         # zustand 状态
```

### 外部触点（仅 4 处，改动极小、易回退）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `python/server.py` | `include_router(omni_tools.router, prefix="/api", tags=["omni-tool"])` + lifespan 清理 |
| 2 | `src/App.tsx` | 新增 `<Route path="/omni-tool" element={<OmniToolPage />} />` |
| 3 | `src/layouts/MainLayout.tsx` | `navItems` 增加 `{ to: '/omni-tool', label: 'Omni Tool', icon: ... }` |
| 4 | `python/omni-backend.spec` | `hiddenimports` 补 `omni_tools.*` 与 `serial`、`serial.tools.list_ports` |

### 依赖变更

- `python/requirements.txt` 新增 `pyserial>=3.5`。
- 打包验证：dev（源码态）与安装版（PyInstaller）**都要跑通**，白名单漏项会导致"dev 正常、安装版崩溃"。

---

## 5. 分阶段计划

### M1 — 串口底座 + boot 自升级（本次实现）

| 步骤 | 内容 | 产出 |
|---|---|---|
| M1.0 | 串口底座：枚举 COM（VID/PID）、打开/关闭、读写超时、重试、统一日志 | `device_finder.py`、`protocol/serial_link.py` |
| M1.1 | boot 协议：Modbus RTU 组帧 + CRC16 + FC101/102/103/104（**移植 `boot_iap_test.py`**） | `protocol/modbus_rtu.py`、`protocol/boot_iap.py` |
| M1.2 | app 协议：`INFO` 读型号/版本 + `MODE_BOOT` 一键进入 bootloader | `protocol/app_cmd.py` |
| M1.3 | 后端 API：扫描/连接/读信息/擦除/下载/校验/跳转；进度经 WebSocket 推送 | `router.py` |
| M1.4 | 前端页面 `/omni-tool`：设备卡片（自动识别 boot/app）、选固件、进度条、日志、二次确认 | `src/pages/omni-tool/` |
| M1.5 | 端到端闭环 + 打包（spec/依赖）实机验证 | 验收通过 |

**端到端闭环（一次验证两套协议）：**

```
app(0x1001) --INFO--> 读型号/版本
            --MODE_BOOT--> 复位（无回包）
                ↓ 重新枚举
boot(0x1000) --FC104--> 读 boot 版本 + MCU UID
             --FC103 SET_ADDR--> --FC103 ERASE×7--
             --FC101 分块下载--> --FC102 回读逐字节校验--
             --FC103 LEAVE--> 跳转
                ↓ 重新枚举
app(0x1001) 回归，读取版本确认升级成功
```

**M1 验收标准：**

1. 点击"一键进入 bootloader"后设备 PID 由 `0x1001` 变为 `0x1000`。
2. 下载 960KB 以内 .bin，回读逐字节一致（校验失败**不得**执行跳转）。
3. 跳转后 app 能正常枚举并读到预期固件版本。
4. 异常路径（拔线、无响应、地址越界、校验失败）均给出可读错误且不卡死。
5. 源码态 + 安装版均可正常运行。

### M2 — 在线烧录（已实现，协议 v0.3）

把 omni_tool_app 当作 SWD 探针，经其 **CDC 命令通道**的 `FLASH(0x20)` 命令在线烧写**外部目标 MCU**。

**上位机统一走固件的镜像型会话**，`.hex` 与 `.bin` 一视同仁：

```
MODE(FLASHER) -> OPEN_IMAGE(base,crc32) -> IMAGE_DATA×N(<=60B/包) -> IMAGE_VERIFY -> CLOSE
-> 重 OPEN -> READ×N(<=56B/包) 逐段比对 -> CLOSE -> MODE(DAP)
```

固件保留的**地址型会话**（`OPEN`/`WRITE`）只用于两件事：**整片擦除清场**、**回读校验**。

| 命令 | 帧（LE） | 用途 |
|---|---|---|
| `OPEN_IMAGE(0x06)` | `0x20 0x06 \| base(4) \| crc32(4)` | 开镜像会话（`.hex` 忽略 base） |
| `IMAGE_DATA(0x07)` | `0x20 0x07 \| len(2) \| bytes[<=60]` | 喂文件原始字节，可任意切分 |
| `IMAGE_VERIFY(0x08)` | `0x20 0x08` | 校验整镜像 CRC32 |
| `OPEN/WRITE/ERASE/CLOSE/READ/RECOVER` | 同 v0.2 | 清场（`ERASE` 仅此用）与回读校验 |

关键实现约束（对齐固件 `HOST_COMMANDS.md` v0.3）：

- **回读校验必须重新 `OPEN`**：`CLOSE` 后目标进入 RUN 态，此时 `READ` 回 `EIO(0x05)`。
- 任一子命令失败即**作废会话**，上位机须先 `RECOVER(0x05)` 或重新 `OPEN_IMAGE` 再继续。
- 超时按目标侧分级预算（对应固件 `CONFIG_FLASHER_*_TIMEOUT_MS`，上位机略留余量）：
  `MODE` 10s / halt 5s / 单包编程 15s / **整片擦除 240s**。
- **目标型号仅 `stm32f407ig`**：固件 `FLASHER_PLAN` 阶段 B（在线下发 FLM）尚未实现，
  FLM 由固件内置；多型号需等固件支持在线下发 FLM 后再扩展上位机目标表。

**为什么不用让用户选模式**（已核对固件 `stream_app.c` / `flash_decoder.c`）：
`OPEN_IMAGE` 后固件自己判定格式（`.hex` 看记录前缀、`.bin` 看 NVIC 向量表）并解出地址，
两者**最终都进同一个 `flash_manager_data()`**，即 `setup_next_sector()` 的**扇区懒擦除**。
所以镜像模式**不需要主机下发任何擦除命令** —— 关掉整片擦除也能正确写入，
这正是 `verify_flash.py --hex` 的行为。暴露模式选择只会让用户选错。

**主机侧仍要先解一遍 hex**（与固件 `verify_flash.py` 同一定义），做三件事：
拦坏文件（校验和 / 非 HEX 行 / 记录截断）、**强制记录地址递增**（固件按扇区懒擦除，
回跳写已写扇区会擦掉已落盘数据）、算整镜像 CRC32（`zlib.crc32`，与固件 `image_crc.c`
逐位实现一致）交给 `OPEN_IMAGE`。格式按**内容**嗅探而非扩展名。

错误码 v0.3 把「文件有问题」与「链路有问题」分开，便于排查方向不用猜：
`0x4D EBADMSG`（CRC 不符 / 非 BIN 非 HEX）、`0x8A EILSEQ`（hex 本身不合法）→ 查**文件**；
`0x05 EIO` / `0x74 ETIMEDOUT` → 查**接线与供电**。

### M2 页面归属

`/omni-tool` 改为布局页，下挂两个子功能（侧边栏二级菜单与路由同源于 `sections.ts`）：

| 路由 | 页面 | 内容 |
|------|------|------|
| `/omni-tool/boot` | Boot | 原 M1 功能：给工具自身刷固件（app → boot IAP） |
| `/omni-tool/flasher` | Flasher | M2：在线烧录外部目标（选固件 / 段与 CRC32 预览 / 整片擦除开关 / 回读校验开关 / 烧录 / RECOVER） |

后端端点：`/api/omni-tool/flasher/{status, analyze, flash, recover}`。
`analyze` **只解析不烧录**，供前端在选完文件后立刻显示"写到哪些地址、CRC32 是多少"。

### M2 实机验收（OMNI-Tool v0.1.0 @ COM23，stm32f407ig 目标）

| 场景 | 结果 |
|---|---|
| `GPIO_Toggle.hex`（对齐 `verify_flash.py --hex 0x08000000`） | ✅ 4104B，CRC32 `0xB9252999` 一致，逐字节一致，1.9s |
| `omni.bin`（同样走镜像模式） | ✅ 14160B，CRC32 `0x0C12AEF2` 一致，逐字节一致，4.0s |
| hex + 整片擦除（地址模式清场） | ✅ 通过 |
| `omni.bin` + 整片擦除 | ✅ 通过 |
| 坏 hex（校验和错误） | ✅ `analyze` 与 `flash` 均在开烧前拒绝 |
| 二进制内容但扩展名 `.hex` | ✅ 正确当作 bin 镜像烧，不损坏镜像 |

> 详细适配说明见 `docs/omni-tool-flasher.md`。

### M3 — 预留（本轮不实现）

| 能力 | 依赖的固件能力 | 预留方式 |
|---|---|---|
| 在线烧录多型号 | 阶段 B：在线下发 FLM + 目标 flash 几何 | 已留 `FLASHER_TARGETS` 目标表；固件支持后追加即可 |
| app 脱机烧录 | 镜像落盘 + 任务触发 + 状态查询（boot/app 分区、FLM 管理） | 页面占位 + 协议版本位 |
| 高速采样（示波器/逻辑分析） | 独立高速数据通道（CDC 64B 包不够） | 页面占位 + 通道抽象接口 |
| UART/I2C 透传 | 透传服务接入命令路由、引脚仲裁 | 页面占位 + 通道抽象接口 |

> 预留原则：只留**接口与版本号**，不做假实现，避免后续返工。

---

## 6. 固件侧改动清单

| 侧 | M1 是否需要改 | 说明 |
|---|---|---|
| **boot** | **不需要** | FC101/102/103/104 均已实现 |
| **app** | **不需要（必需项为零）** | `CMD_INFO`、`CMD_MODE_BOOT` 均已实现 |

可选增强（非必需，可后置，不影响 M1 验收）：

- app：`CMD_INFO_SER_NUM` 用 MCU UID 填充（当前为 TODO）→ 上位机可显示唯一序列号。
- app：置位 `capabilities` 位图（当前 `0x00 0x00`）→ 支持能力发现。

> 结论：M1/M2 **不触碰应用原有功能**，符合"实现时不影响应用原来功能"的要求。真正需要固件新增功能的，是 M3。

---

## 7. 风险与前置验证

| # | 风险 | 应对 |
|---|---|---|
| R1 | **打包漏项**：spec 为显式 `hiddenimports` 白名单，`pyserial` 与 `omni_tools.*` 不同步添加会导致安装版崩溃 | M1.0 即改 spec，dev 与安装版双验证 |
| R2 | **COM 枚举**：app 为 CDC+WinUSB 复合设备，需实测 Windows 下 CDC 接口确实枚举为 COM 口 | M1.0 先做最小枚举验证脚本 |
| R3 | **超时策略**：单扇区擦除 1~2s、7 个扇区，固定超时会误判失败 | 按操作分级超时（擦除/下载/读回各自独立） |
| R4 | **不可逆操作**：擦除/跳转有变砖风险，且可能刷错设备 | 操作前核对设备身份 + 二次确认 + `LEAVE` 前强制校验通过 |
| R5 | **模式互斥**：进入 FLASHER/UART 会抢占 SWD，DAP 页失效 | 首次操作时提示"当前 DAP 会话将中断" |
| R6 | **协议演进**：`HOST_COMMANDS.md` 为 v0.1，无版本协商 | 后端协议层带版本常量；新增命令一律向后兼容增量 |

---

## 8. 待确认 / 后续

1. boot 固件来源后续是否要内置固件库与版本管理（D5 暂定手工选 .bin）。
2. CLI（`omni.exe`）是否在后续阶段开放同等能力（D6 暂不同步）。
3. 透传与采样所需的高速数据通道方案（复用 WinUSB bulk 或新增 bulk EP）——**须在 M3 之前定案**。
4. 固件侧协议版本号与能力发现机制是否随 M3 一并冻结。

---

## 9. 参考

| 资料 | 位置 |
|---|---|
| app 上位机指令文档（**协议 v0.3，模式 A/B**） | `omni_tool_app/docs/HOST_COMMANDS.md` |
| 烧写参考脚本（`--hex` 走模式 B） | `omni_tool_app/verify_flash.py` |
| hex/CRC32 主机侧自检 | `omni_tool_app/_selftest_hex.py` |
| 离线烧录规划 | `omni_tool_app/docs/FLASHER_PLAN.md` |
| app 开发路线图 | `omni_tool_app/docs/DEV_ROADMAP.md` |
| boot IAP 测试工具与说明 | `omni_tool_boot/boot_iap_test.py`、`boot_iap_test_README.md` |
| boot IAP 实现 | `omni_tool_boot/src/iap_app.c` |
| app 命令路由实现 | `omni_tool_app/src/cmd_app.c`、`src/cmd_app.h` |
| 模式 B 固件侧实现 | `omni_tool_app/src/svc_flasher.c`、`src/flasher/image_crc.c`、`src/flasher/intelhex.c` |
| **在线烧录上位机适配说明** | `docs/omni-tool-flasher.md` |
| omni-link 后端架构 | `docs/tech/architecture.md` |
| omni-link 后端入口 | `python/server.py` |