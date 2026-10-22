# OMNI CLI（`omni`）

把 OMNI Link 的调试能力（探针、烧录、RTT、设备库、Commander）和 OMNI 工程配置能力统一到一个命令行入口，便于脚本化、CI 与自动化测试。

## 定位

OMNI CLI 有两类命令：

- **调试/烧录类**：`backend` / `probe` / `target` / `flash` / `commander` / `debug` / `monitor` / `device` / `pack` / `rtt` / `system` / `file` / `tool`。
  它们是 OMNI Link 后端的瘦客户端，通过 HTTP 复用 REST 接口，不复制后端业务逻辑。
  （例外：`file checksum` 纯本地计算，不需要后端。）
- **工程配置类**：`omni config`。本地执行，不经过后端，实现在 `omni_cli.config` 内；
  只依赖 omni-emb 仓库的 `Kconfig` / `soc` / `boards` 数据，不调用 `omni/scripts` 下的旧脚本。

```
omni (本包)
  ├── HTTP ──▶ OMNI Link Python 后端 (server.py) ──▶ 调试探针 ──▶ 目标芯片
  ├── 本地 ──▶ omni_cli.config ──▶ 工程配置/头文件/Keil 工程
  └── 本地 ──▶ file checksum ──▶ 原始文件字节校验和
```

因此：**调试/烧录命令需要后端；`omni config` 与 `omni file checksum` 不需要后端，也不需要探针。**

## 版本记录

### 0.14.0（2026-10-22）

- `omni config bsp` 生成的 `bsp_config.h` 内容稳定化：注释不再写入「来自 linker map /
  源码扫描」这类随构建状态变化的信息，避免 configure 期（map 还不存在）与构建后
  生成不同字节、造成无意义 diff。来源信息仍打印在日志里。
### 0.13.0（2026-10-22）

- `omni build -t` 目标体系（对齐 `west build -t`）：
  - `-t size` → 构建 `omni-size-<project>` 目标；
  - `-t clean` → 等价 `--clean`；
  - `-t flash` / `-t run` → 构建完成后调用 `omni flash program <omni.axf>`（`--runner-arg` 透传参数）；
  - 其它值 → 原样透传给 `cmake --build --target`。
- runner 与 CMake 配置统一使用「当前 CLI」（PATH 上版本更低时自动退回 `python -m omni_cli`）。
### 0.12.0（2026-10-22）

- `omni build` 对齐 west 的行为：
  - **默认跳过 CMake 配置**（构建目录已有 `CMakeCache.txt` 时），`--cmake` 强制重新配置；
  - 构建目录与上下文绑定：cache 里的 board/compiler/build-type 不一致时报错并提示 `--clean`；
  - 新增 `-t/--target`（只构建指定目标，如 `omni-size-template`）；
  - 新增 `-o/--cmake-arg`（透传 cmake 参数，注意写成 `--cmake-arg=-DFOO=1`）；
  - `-t` 让给 `--target`，构建类型改用 `--build-type`。
### 0.11.0（2026-10-22）

- 新增 `omni build`：本地 CMake 配置 + 构建（Ninja），产物路径与尺寸直接返回：
  - 构建目录固定 `<project>/build/<board>/<COMPILER>/<buildtype>`；
  - `--clean` / `--configure-only` / `-j` / `--json` / `-v`；
  - 自动把「当前 CLI」传给 CMake（`-DOMNI_CLI` 或 `-DOMNI_CLI_PYTHON`+`-DOMNI_CLI_MODULE`），
    不再依赖 `PATH` 上的 omni 版本。
- `omni config bsp` 的 map 自动发现增加 `build/**/*.map`（CMake 产物目录）。
### 0.10.0（2026-10-22）

- 新增 `omni modules`：`list` / `check` / `generate`（本地命令，不依赖后端）：
  - 扫描 `modules/<dir>/omni/module.yml` 与 `omni/modules/<name>/module.yml`
    （后者对应 Zephyr 的 `cmake-ext`，用于上游镜像仓库）；
  - `generate` 写出 `omni/cmake/omni_modules.cmake` 与 `omni/Kconfig.modules`，
    `--check` 校验生成物是否漂移（不一致返回 2）。
### 0.9.0（2026-10-22）

- 新增 `omni boards`：`list` / `show` / `check` / `sync`（本地命令，不依赖后端）：
  - 板事实来自 `omni/boards/<board>/board.yml`；
  - `check` 比对工程 `boards/<board>/startup/*` 与 HAL 模块里的原始文件；
  - `sync` 只补缺失文件，默认不覆盖已有文件，可生成 HAL 配置头模板。
- 新增依赖 `PyYAML>=6.0`。
- README：修正 `project` 段标题为 `config`。
### 0.8.0（2026-10-22）

- 新增 `omni file`：
  - `info`：解析 bin/hex/elf 的格式、大小、段信息；
  - `checksum`：本地计算 modbus-crc16 / crc16-ccitt / crc32 / add8 / xor8 / add16，
    支持 `--start` / `--end` 字节范围。
- 新增 `omni flash compare <file>`：对比目标 Flash/RAM 与固件文件，返回首个不一致地址、
  差异总数与差异列表（`--max-diffs` / `--fail-fast`），不写目标。
- 新增 `omni tool map <file.map>`：解析 ARM 链接器 map，输出 ROM/RAM 使用、区域、
  分类与 ROM Top 条目。
- 后端新增 `POST /api/probes/{uid}/flash/compare`；Flash 地址对比前自动
  `reset_and_halt`，避免读到陈旧 Flash。

### 0.7.0（2026-10-21）

- **破坏性变更**：`omni project` 重命名为 `omni config`，子命令 `generate`（默认）/ `menuconfig` / `bsp` / `sync-keil`；不保留旧命令。
- **破坏性变更**：板级选项 `--target` 改为 `-b/--board`；`probe connect --target` 仍表示芯片型号，未变。
- **破坏性变更**：环境变量 `OMNI_TARGET` 改为 `OMNI_BOARD`。
- 包结构：`omni_cli.project` → `omni_cli.config`；`context` 上提为 `omni_cli.context`。
- 命令注册改为单一来源（`commands.add_all_parsers`），新增命令不必再改 `cli.py`。
- 启动器路径（omni-emb 侧）：`omni/scripts/omni_project/omni_project.py` → `omni/scripts/omni_config/omni_config.py`。

### 0.6.0（2026-10-21）

- 新增运维与设备信息命令：
  - `omni system info`（后端/数据库/Python/pyOCD 版本与设备库统计）；
  - `omni commander reset|cancel`；
  - `omni probe jlink-devices`（J-Link 设备库检索，配合 `--jlink-device`）；
  - `omni device flm-info <file.FLM>`（自动提取 Flash 参数供 `device custom`）；
  - `omni rtt send --file <path>`（发送文件原始字节）。

### 0.5.0（2026-10-21）

- 新增 `omni monitor`：ELF/符号、监视变量增删改、采样 start/stop/pause/resume、
  目标内核 run/halt/reset/state、历史读取（`read`，支持 `--follow`）与 CSV 导出。
- `monitor var add --symbol` 自动解析符号地址/类型；数组必须 `--index`，越界/歧义会拒绝。
- `SessionRecorder.read_range` 读取前 flush 当前文件，采样进行中即可读到最新样本，
  支撑 `monitor read --follow`。

### 0.4.0（2026-10-21）

- 新增 **临时挂包**：`omni probe connect <uid> -t <part> --pack <file.pack>`（可重复）。
  行为对齐 pyOCD `--pack`：只注册到当前后端进程的 `TARGET`，不复制文件、不写设备库，
  `backend stop/restart` 后失效；同一后端内的后续命令无需重复 `--pack`。
- 新增 `omni pack` 命令组：`list(show)` / `preview` / `import` / `remove`，复用 GUI
  「设置 → 芯片管理」的 `/api/packs` 能力。
- `probe connect` 增加 pyOCD 风格别名：`-t/--target`、`-f/--frequency`（支持 `4m`、
  `2.5khz`）、`-M/--connect`；`probe target --pack` 可在切换目标时挂包。
- Pack 生命周期修正：卸载只删除本 Pack 拥有的 `TARGET` 键，内置型号与其它 Pack 的
  同名型号不被误删；安装清单路径失效时按 filename 从 `packs/` 自愈；`device list`
  不再把 Pack 芯片误标为“不可烧录”。
- 新增能力缺口评审：`docs/tech/cli-coverage.md`（pyOCD CLI 与应用端 REST/UI 对照）。

### 0.3.2（2026-10-21）

- `omni project` 的人类可读成功摘要改为 ASCII/英文（`Project configuration generated.`
  等），避免在 Keil 的 GBK 控制台里显示为乱码；错误前缀也改为 `Error:`。
- 配套修复 CMSIS `execute`：项目目录改为通过 `$input(1)$` 传递，避免
  `$ProjectDir$` 在 `run` 中展开为空导致 `--project-dir: expected one argument`。
- 启动器最低版本提升到 `0.3.2`。

### 0.3.1（2026-10-21）

- 修复 `omni project sync-keil` 的 FatFs 规则：`CONFIG_FATFS` → `CONFIG_FS_FATFS`
  （当前 omni 框架使用 `FS_FATFS`，旧符号导致 `fatfs_arch.c` 不会同步进 Keil 工程）。
- 修复 `omni project menuconfig` 在找不到 `menuconfig` 命令时遗留临时
  `omni-app-*.Kconfig` 的问题。
- 补充 `FS_FATFS`、`--stop-on-change`、`menuconfig` 清理的离线回归测试。

### 0.3.0（2026-10-21）

- 产品名统一为 **OMNI CLI**；Python 包 `omnilink_cli` → `omni_cli`。
  发行名 `omni-cli` 和命令 `omni` 不变；开发态调用改为 `python -m omni_cli`。
- 新增本地命令 `omni project`：
  - `config`：Kconfig 合并、`omni_config.h`、`bsp_config.h`，可选 MSP / Keil 同步；
  - `menuconfig`：交互式配置；
  - `bsp`：独立生成 `bsp_config.h`；
  - `sync-keil`：按已有 `.config` 同步 Keil 工程，默认全部 `*.uvprojx`。
- 工程配置逻辑从 `omni-emb/omni/scripts` 重新实现到 CLI；旧脚本保留作参考/备份，
  不再被 CLI 调用。
- 新增 `kconfiglib` 依赖（`config` / `menuconfig`）；`bsp` / `sync-keil` 不需要它。
- 新增 `omni-emb/omni/scripts/omni_project/omni_project.py` 薄启动器，供 Keil/CMSIS 构建钩子调用。

### 0.2.3（2026-10-20）

- 修复 `rtt read --since <过期游标> --json` 的 stdout 被中文警告污染、无法被
  `ConvertFrom-Json` 解析的问题：`--json` 模式不再向 stderr 输出 `session_reset`/`lost`
  警告，改为在 JSON 响应中增加 `warning` 字段；stdout 始终是纯 JSON/JSONL，人类可读模式
  的警告仍在 stderr。
- `rtt read --json --out FILE` 不再输出“已追加写入”stderr 提示，避免合并捕获时污染 JSON。

### 0.2.2（2026-10-20）

- 修复 `flash erase --type chip` 后 `program` 内部校验误报 `Verify failed at 0x08000000`：
  Flash 算法写完后调试口在复位前可能读到陈旧内容。`program` 的内部校验与独立
  `flash verify` 现在先 `reset_and_halt` 再读取；`erase` / `fill`（Flash）结束也会复位一次。
- 修复 `flash fill`：导入路径改为 `pyocd.flash.loader`（原 `flash_loader` 不存在）；
  Flash 填充使用 `chip_erase="sector"`，并校验范围落在单个 region 内。
- `flash fill --value` 支持 `0x55` 等十六进制写法（仍限制 0-255）。
- RTT `--since`：`seq` 改为在同一后端进程内跨 `rtt start` 单调递增（只清缓存、不重置编号），
  旧会话的 `next_seq` 可继续作为游标；后端重启后才从 1 开始，并返回 `session_reset` 提示，
  不再静默返回 0 字节。
- `probe list` 新增 `--refresh`；文档说明其状态来自 1~2s 监控快照，连接权威状态用
  `probe status`。
- 文档明确 `flash reset`（默认复位后运行）与 `debug reset`（默认复位并暂停）的默认值相反。

### 0.2.1（2026-10-20）

- Flash 操作前自动停止 RTT 轮询（Flash 算法需要独占 SWD）：修复 RTT 会话运行时全片擦除
  被 30s 超时掐断、重试排队超时的问题；响应中的 `rtt_stopped` 告知是否自动停止。
- `flash program` / `erase` 默认 HTTP 超时提高到 **180s**；`verify` / `blank-check` /
  `read` / `fill` 为 120s（仍可用 `--timeout` 覆盖）。
- `flash erase --json` 返回 `bytes_erased`，不再返回误导性的 `bytes_written: 0`；
  各操作只输出本操作有意义的计数字段。
- 同一探针的 Flash 操作串行化：重复请求立即 409，避免客户端超时后并发擦除/烧录。
- 修复 `debug halt` 后立即 `debug regs` 的偶发竞态：RTT 轮询与寄存器读取共享 target
  （现通过调试协调锁串行），且 Zone 的 halt 不再被 RTT 自动 resume 覆盖。
- 文档修正：`commander exec list` 是 pyOCD 的探针/目标列表，列出 pyOCD 命令应使用
  `commander exec help`。

### 0.2.0（2026-10-20）

- **新增命令 `omni rtt read`**：读取 SEGGER RTT 上行数据。支持 `--follow`（持续跟踪）、
  `--duration`、`--out`（原始字节落盘）、`--channel`、`--since`、`--json`（follow 为 JSONL）。
- `probe connect`：`--target` 改为必填（帮助与 argparse 双重标注）；`--speed` 校验
  5 kHz ~ 50 MHz 并给出 `Hz/kHz` 单位提示；连接失败回落到 `disconnected`，修正参数后可直接重试。
- `commander exec`：命令之后出现的已知全局选项（`--uid/--backend-port/--timeout/--managed/--json/--quiet`）
  自动前移，`--json` 在任意位置均可用。
- `flash verify --json`：不再返回误导性的 `bytes_written`，改为 `bytes_verified`。
- `debug regs` / `debug status`：会话失效时返回 `success:false` 与非零退出码；
  寄存器接口区分“目标运行中（409，提示先 halt）”与“会话失效（503）”。
- 修复管道/重定向下中文输出 `�`（U+FFFD）：CLI stdout/stderr 显式固定 UTF-8，后端日志同步修复；
  构建脚本新增源码编码检查与打包后帮助输出校验。
- 后端配套：RTT 上行环形缓存（REST 与 WebSocket 共用）、探针列表状态快照、
  connect/set-target/寄存器读取的 HTTP 超时、commander 调试锁有限等待。

### 0.1.0

- 首个版本：`backend` / `probe` / `target` / `flash` / `commander` / `debug` / `device` / `rtt` 基础命令。

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

> `omni config generate` / `menuconfig` 依赖 `kconfiglib`，wheel 安装会自动拉取；
> `menuconfig` 还需要同一环境中的 `menuconfig` 命令（`kconfiglib` 会安装它）。
> `bsp` / `sync-keil` 不依赖 `kconfiglib`。

可用参数：

| 参数 | 说明 |
| --- | --- |
| `-NoBuild` | 跳过构建，仅重装已有 wheel |
| `-StartBackend` | 安装后顺带启动常驻后端 |

### 方式二：源码直接运行（开发调试）

```powershell
cd D:\workspace\embedded\omni-link\python
& "..\.venv\Scripts\python.exe" -m omni_cli probe list
```

源码态无需安装，改完代码立即生效；缺点是每次要带解释器和 `-m`。

> 两种方式并存：wheel 安装后源码改动需要重跑一次 `cli-package.ps1` 才会生效。

### 方式三：CLI-only 独立发布（不打包整个应用）

只更新 CLI 时，不需要重新构建 Electron 前端和 238 MB 的应用安装包：

```powershell
cd D:\workspace\embedded\omni-link
.\build.ps1 -CliOnly
# 等价于
powershell -File python\scripts\cli-release.ps1
```

产物：

```text
python\dist\cli-release\omni-cli-<version>-win64.zip
python\dist\cli-release\omni_cli-<version>-py3-none-any.whl
python\dist\cli-release\SHA256SUMS.txt
```

zip 内包含 `omni.exe`、`README.md`、`LICENSE`、`install.ps1`、`uninstall.ps1`
和 `SHA256SUMS.txt`。安装脚本默认装到
`%LOCALAPPDATA%\Programs\OMNI CLI\bin` 并加入用户 PATH。

可选参数：

```powershell
# 只重打 zip，不重新构建 exe/wheel
powershell -File python\scripts\cli-release.ps1 -SkipBuild -SkipWheel

# 不生成 zip，只保留组装目录
powershell -File python\scripts\cli-release.ps1 -NoZip -KeepStaging

# 代码签名（可选）
powershell -File python\scripts\cli-release.ps1 `
  -PfxPath .\certs\omni.pfx -PfxPassword "******" -RequireSigned
```

> portable zip 不包含调试后端；`omni config` 可独立使用，`probe/flash/debug/rtt`
> 需要已安装的 OMNI Link 后端或 `OMNI_BACKEND_DIR`/`OMNI_BACKEND_SERVER`。

## 快速开始

```powershell
# 1) 启动常驻后端（只需一次）
omni backend start

# 2) 查看探针
omni probe list

# 3) 连接目标芯片（内置型号）
omni probe connect 852001270 --target stm32f407xg

# 3b) 或临时挂载厂商 DFP，连接 Pack 中的型号（不写入设备库）
omni probe connect 852001270 -t g32f020k8 --pack .\Geehy.G32F020_DFP.0.0.11.pack

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
| `--timeout SEC` | 后端 HTTP 超时秒数（默认 30；`flash program/erase` 默认 180，`verify/blank-check/read/fill` 默认 120） |

> `omni config` 是本地命令，只使用 `--json` / `--quiet`，**不接受** `--backend-port` /
> `--managed` / `--timeout`；它另有 `--project-dir` / `--omni-root` / `-b/--board` 等上下文选项。
>
> ℹ️ `omni commander exec` 的命令参数用 `REMAINDER` 收集。为兼容常见写法，CLI 解析前会把
> 命令之后出现的**已知全局选项**（`--uid` / `--backend-port` / `--timeout` / `--managed` /
> `--json` / `--quiet`）自动前移，因此下面两种写法都可用：
>
> ```powershell
> omni commander exec --uid 852001270 read32 0x080000C0 4   # 推荐
> omni commander exec "read32 0x080000C0 4" --timeout 15    # 也可
> ```
>
> 其它以 `--` 开头的选项（不属于全局选项）仍须写在命令之前，否则会作为命令参数传给 pyOCD。
> `--` 之后的内容不会被提取。

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

### `system` — 系统信息

| 子命令 | 说明 |
| --- | --- |
| `info` | 后端/数据库/Python/pyOCD 版本、数据库路径、设备库来源统计 |

```powershell
omni system info
omni system info --json
```

### `config` — 工程配置（本地命令）

不经过后端，也不需要探针；直接在本地读取 omni 框架的 `Kconfig` / `soc` / `boards`
并生成工程配置。实现在 `omni_cli.config`，不调用 omni-emb 的旧脚本。

| 子命令 | 说明 |
| --- | --- |
| `generate`（默认） | Kconfig 合并 + `omni_config.h` + `bsp_config.h`；可选 `--msp` / `--sync-keil` |
| `menuconfig` | 打开交互式 menuconfig，保存后更新头文件 |
| `bsp` | 独立生成 `bsp_config.h`（默认自动发现链接 map） |
| `sync-keil` | 按已有 `.config` 同步 Keil 工程；**默认全部 `*.uvprojx`** |

上下文选项（各子命令通用）：`--project-dir PATH`、`--omni-root PATH`、`-b/--board BOARD`。
不传时自动从当前目录向上查找工程根和 `omni/` 根；多目标工程必须显式 `-b/--board`。

```powershell
cd D:\workspace\embedded\omni-emb\examples\basic\template

omni config generate --board stm32f407ig
omni config generate --board stm32f407ig --msp
omni config generate --board stm32f407ig --sync-keil
omni config generate --board stm32f407ig --sync-keil --stop-on-change
omni config bsp --board stm32f407ig
omni config bsp --board stm32f407ig --map Listings\stm32f407\omni.map
omni config sync-keil
omni config menuconfig --board stm32f407ig
```

> `--sync-keil` / `sync-keil` 默认同步工程目录下**全部** `*.uvprojx`，与旧
> `omni_config.py --sync-uvprojx` 一致。只有需要收窄时才加 `--uvprojx FILE`（可重复）。
>
> `--stop-on-change`：任意 `.uvprojx` 有变化时返回退出码 **2**，提示重新加载/构建；
> 没有变化返回 0。
>
> `menuconfig` 需要交互式终端；Windows 下会打开独立控制台窗口。不要在 CI 管道中使用。

Keil/CMSIS 构建钩子建议通过 omni-emb 的薄启动器调用，而不是直接写 `omni`：

```text
python ../../../omni/scripts/omni_config/omni_config.py config --board stm32f407ig --sync-keil
```

启动器只负责定位 CLI、校验最低版本（0.7.0）和转发参数；可用 `OMNI_CLI` 指定
`omni.exe` 路径。

### `build` — 配置并构建（本地命令）

不经过后端；内部就是 `cmake -S … -B … -G Ninja` + `cmake --build`，但会自动补上
工作区、板、编译器、工具链、CLI 等参数。

| 选项 | 说明 |
| --- | --- |
| `-b/--board` | 板级目标（多板工程必填） |
| `-c/--compiler` | `ac6`（默认）/ `gcc` / `clang` / `ac5`；当前仅 ac6 提供工具链文件 |
| `--build-type` | `Debug`（默认）/ `Release` |
| `--cmake` | 强制重新执行 CMake 配置（默认已有构建目录时跳过） |
| `--clean` | 先删除该上下文的构建目录 |
| `--configure-only` | 只配置，不编译 |
| `-t/--target T` | `size` / `clean` / `flash` / `run` / 或任意 cmake 目标 |
| `-o/--cmake-arg ARG` | 额外 cmake 参数（写成 `--cmake-arg=-DFOO=1`，可重复） |
| `--runner-arg ARG` | 传给 runner（`omni flash program`）的参数，可重复 |
| `-j/--jobs N` | 并行任务数 |
| `-v/--verbose` | 打印 cmake 完整输出 |
| `--json` / `--quiet` | 供脚本与 CI 消费 |

```powershell
cd D:\workspace\embedded\omni-emb

omni build -b stm32f407ig --project-dir examples\basic\template
omni build -b stm32f407ig --project-dir examples\basic\template --clean
omni build -b stm32f407ig --project-dir examples\basic\template --configure-only
omni build -b stm32f407ig --project-dir examples\basic\template --json
```

输出包含构建目录、`Program Size: Code/RO-data/RW-data/ZI-data` 与
`omni.axf` / `omni.hex` / `omni.bin` / `omni.axf.map` / `omni.size.txt` 的绝对路径。
### `boards` — 板定义（本地命令）

不经过后端；读取 `omni/boards/<board>/board.yml`。板目录只保存板事实，
工程 `boards/<board>/` 仍是独立的受管副本（tracked、可修改）。

| 子命令 | 说明 |
| --- | --- |
| `list`（默认） | 列出框架里的板（board / device / cpu / fpu / hal / series） |
| `show BOARD` | 显示单个板的完整事实与上游文件位置 |
| `check` | 比对工程 `boards/<board>/startup/*` 与 HAL 模块里的原始文件；`--all` 汇总全仓 |
| `sync` | 为工程补齐缺失的板级文件；默认不覆盖已有文件 |

```powershell
cd D:\workspace\embedded\omni-emb

omni boards list
omni boards show stm32f407ig
omni boards check --project-dir examples\basic\template -b stm32f407ig
omni boards sync  --project-dir examples\basic\template -b stm32f407ig --dry-run
omni boards sync  --project-dir examples\basic\template -b stm32f407ig
```

> `check` 报告 `identical / modified / missing / project-only`，**始终返回 0**（先观察漂移）；
> `check --all` 扫描 `examples/` 与 `applications/`，按板汇总每个文件的漂移次数，
> 并列出缺文件的工程（例如 `ram_boot` 只提供 RAM 链接脚本，属预期）。
> `sync` 只补缺失文件；加 `--force` 才会覆盖，`--dry-run` 只打印动作。
> 新工程脚手架会生成 `board.clayer.yml`、`board.conf`、`bsp.c`，并从 HAL 模块复制
> 启动文件、链接脚本、system 源文件与 HAL 配置头模板。

`boards` 与 `target` 的分工：`boards` 是**构建目标**（`OMNI_BOARD` / `$TargetType$`），
`target` 是**调试/烧录的芯片型号**；`boards show` 会给出对应的 `omni target info <device>`。
### `modules` — 模块注册表（本地命令）

不经过后端；模块声明来自 `module.yml`，`generate` 产出 CMake 注册表与 Kconfig 入口。

| 子命令 | 说明 |
| --- | --- |
| `list`（默认） | 列出模块及其 glue 位置、CMake 目录、Kconfig、enable 符号 |
| `check` | 检查声明是否自洽（目录/文件是否存在、是否声明 enable） |
| `generate` | 生成 `omni/cmake/omni_modules.cmake` 与 `omni/Kconfig.modules`；`--check` 只校验 |

```powershell
cd D:\workspace\embedded\omni-emb

omni modules list
omni modules check
omni modules generate
omni modules generate --check   # CI：注册表与 module.yml 不一致时返回 2
```

> 模块的构建胶水有两个合法位置：`modules/<dir>/omni/`（仓库是自己的，如 hal_stm32）
> 与 `omni/modules/<name>/`（上游镜像，用 `module: ../../../modules/<dir>` 指回源码）。
> `enable` 是 Kconfig 符号，为 y 时模块参与 CMake 构建，目标名 `omni_module_<name>`。
### `probe` — 探针管理

| 子命令 | 说明 |
| --- | --- |
| `list` | 枚举探针（UID / 厂商 / 产品 / 串号 / 连接状态；状态来自 1~2s 监控快照） |
| `connect <uid>` | 连接探针并指定目标芯片（支持 `--pack` 临时挂包） |
| `disconnect <uid>` | 断开探针（等待底层关闭，释放 J-Link 等探针句柄） |
| `status <uid>` | 查询连接状态与目标信息（**连接的权威状态以此为准**） |
| `target <uid> [--part PART] [--pack PATH]` | 查询或设置目标型号（切换目标时可挂包） |
| `jlink-devices` | 从 J-Link 设备库检索设备名（`--search` / `--flash-kb` / `--limit`） |

> `probe list` 为了性能读取后台监控快照（每 2s 刷新），刚 `connect` 后可能仍显示
> `disconnected`；需要立即刷新用 `omni probe list --refresh`，或用 `omni probe status <uid>`。

`connect` 选项：

| 选项 | 说明 |
| --- | --- |
| `-t, --target` | **必填**，目标芯片型号（如 `stm32f407xg`；用 `omni target list` 查询） |
| `--interface` | `swd`（默认）/ `jtag` |
| `-f, --frequency, --speed` | 时钟频率，范围 5000（5 kHz）~ 50000000（50 MHz）；支持 `4000000`、`4m`、`2.5khz` |
| `-M, --connect, --connect-mode` | `attach` 附加不复位 / `halt` 复位并暂停 / `pre-reset` 连接前复位 / `under-reset` 复位下连接 |
| `--jlink-device` | **J-Link 必填**，SEGGER 数据库中的设备名（如 `G32F463XC`） |
| `--pack PATH` | **临时挂载 CMSIS-Pack**（可重复）；仅当前后端进程有效，不写入设备库 |
| `--force` | 已连接时强制按新参数重连 |

> `--target` 由 CLI 与服务端双重校验：CLI 缺少时直接报用法错误（退出码 2 的同类错误），
> 直接调 REST 则立即返回 400，不会把空目标交给 pyOCD 长时间探测。失败后探针回落到
> `disconnected`，修正参数后可直接重试，无需先 `disconnect`。
>
> `--speed` 低于 J-Link 下限时不再只显示 DLL 原文 `Minimum is 5.`，而是明确给出
> “`4000 Hz = 4 kHz`，下限 `5 kHz`（`--speed 5000`）”。

```powershell
omni probe list
omni probe list --refresh          # 强制重新枚举（刚 connect 后看即时状态）
omni probe connect 852001270 --target stm32f407xg
omni probe connect 852001270 --target G32F463XC --jlink-device G32F463XC
omni probe connect 852001270 -t g32f020k8 --pack .\Geehy.G32F020_DFP.0.0.11.pack
omni probe status 852001270
omni probe target 852001270 --part stm32f407xg
omni probe jlink-devices --search G32 --flash-kb 256   # 查 J-Link 设备名
omni probe disconnect 852001270
```

> **临时挂包（`--pack`）与 pyOCD 的 `--pack` 对齐**：
> - 只把 Pack 中的型号注册到当前后端进程的 pyOCD `TARGET`，不复制文件、不写设备库/安装清单；
> - `omni backend stop`（或重启）后失效；同一后端内后续 `flash/debug/commander/rtt` 直接可用，
>   无需重复传 `--pack`；
> - 与内置型号同名时**内置优先**，与多个 Pack 同名时按 `--pack` 顺序先到先得；
> - Pack 条目没有 `jlink_device`，J-Link 用户仍需 `--jlink-device`；
> - `--pack` 与 `--managed` 同时使用时，命令结束后端即关停，临时包也随之消失；多步操作请先
>   `omni backend start`。

### `target` — 目标型号

| 子命令 | 说明 |
| --- | --- |
| `list` | 列出后端支持的全部 MCU 型号（`--search` 过滤 / `--limit` 限量） |
| `info <part>` | 查询某型号是否受支持 |

```powershell
omni target list --search stm32f4 --limit 8
omni target info stm32f407xg
```

### `pack` — CMSIS-Pack 管理

与 GUI「设置 → 芯片管理 → DFP 导入」共用同一份设备库与安装清单；与 `--pack`
临时挂包的区别是：`pack import` 会**复制文件并持久安装**，重启后端后仍生效。

| 子命令 | 说明 |
| --- | --- |
| `list`（别名 `show`） | 列出已安装 Pack（名称/版本/设备数/文件是否存在） |
| `preview <file>` | 预览 `.pack` 中的芯片（`--search` / `--limit`；不导入） |
| `import <file>` | 导入 `.pack`（`--parts a,b` 只导入指定型号；缺省=全部） |
| `remove <name> [-y]` | 卸载 Pack（只删除本 Pack 独有的目标；内置型号不受影响） |

```powershell
omni pack list
omni pack preview .\Geehy.G32F020_DFP.0.0.11.pack --search g32f020
omni pack preview .\Keil.STM32F1xx_DFP.2.4.1.pack --limit 20

# 持久导入（写入设备库与安装清单）
omni pack import .\Geehy.G32F020_DFP.0.0.11.pack
omni pack import .\Keil.STM32F1xx_DFP.2.4.1.pack --parts stm32f103c8,stm32f103rb
omni device list --source pack
omni target list --search g32f020

# 卸载
omni pack remove Geehy.G32F020_DFP -y
```

> ℹ️ `--parts` 只影响设备库展示；导入时整包型号都会注册到 pyOCD `TARGET`，
> 因此未勾选的型号仍可通过 `--target` 连接（与 pyOCD 加载整包一致）。对已安装的
> Pack 重新执行 `pack import --parts` 会以本次选择**替换**设备库条目（上次导入但本次
> 未选中的型号从设备库移除），TARGET 注册仍保留整包。
>
> ℹ️ 若安装清单里的路径来自另一份源码树 / 拷贝目录，CLI 启动加载会按 filename
> 从 `packs/` 目录自愈；`omni pack list` 中“文件=缺失”的条目可重新导入修复。
>
> ℹ️ 临时挂包请用 `probe connect --pack`；它不会出现在 `pack list` / `device list`，
> 重启后端后自动消失。

### `flash` — 烧录 / 擦除 / 校验 / 回读

除 `--uid` 外，各子命令：

| 子命令 | 说明 | 默认 HTTP 超时 |
| --- | --- | --- |
| `program <file>` | 烧录固件（hex/bin/elf），默认烧后校验并复位运行 | 180s |
| `erase` | 擦除，`--type chip`（默认）/ `sector` / `sector_range` | 180s |
| `verify <file>` | 校验 Flash 与固件文件是否一致 | 120s |
| `compare <file>` | 对比目标与文件，返回首个差异/差异列表（`--max-diffs` / `--fail-fast`） | 180s |
| `blank-check` | 检查是否空白（默认整个 Flash），返回首个非空地址 | 120s |
| `read` | 回读，`--type chip`（默认）/ `range`；`--out PATH` 让后端另存文件 | 120s |
| `fill` | 填充内存区域（Flash/RAM），`--addr` `--size` 必填，`--value` 0-255（默认 `0xFF`，支持 `0x55`） | 120s |
| `cancel` | 取消正在进行的 Flash 操作 | 30s |
| `reset` | 复位目标，`--type hw`（默认）/ `sw`；**默认复位后运行**，`--no-run` 暂停 | 30s |

> ⏱️ 全片擦除 1 MiB Flash 实测约 16s，叠加 RTT 轮询后可能超过 30s。`program` / `erase`
> 的默认超时已放宽到 **180s**（`verify/read/blank-check/fill` 为 120s）；仍可用
> `--timeout SEC` 显式覆盖。超时只影响 CLI 的 HTTP 等待，后端线程仍会继续执行。

```powershell
# 全片擦除：默认 180s；建议先停 RTT（现在后端也会在 Flash 操作前自动停止 RTT）
omni rtt stop
omni flash erase --type chip --timeout 180

omni flash program .\app.hex
omni flash program .\app.bin --base-address 0x08000000 --no-reset
omni flash verify .\app.hex
omni flash compare .\app.hex                     # 一致返回 0；不一致返回 1 并列出差异
omni flash compare .\app.hex --max-diffs 50
omni flash blank-check --addr 0x08000000 --size 64
omni flash read --type range --addr 0x08000000 --size 64 --json
omni flash fill --addr 0x08000000 --size 256 --value 0x55   # 支持 0x 前缀
omni flash reset --no-run
```

> ⚠️ `program` / `erase` / `fill` 会真实改写芯片内容，执行前请确认目标板可擦写。

> ℹ️ 所有 Flash 操作开始前，后端会自动暂停 Monitor 并停止 RTT 轮询（Flash 算法需要独占
> SWD，RTT 每 10ms 的读会显著拖慢擦除，还可能并发访问 target）。响应中的
> `rtt_stopped: true` 表示本次操作前主动停了 RTT；需要日志请重新 `omni rtt start`。
> 同一探针同时只允许一个 Flash 操作，重复请求会立即返回 409 而不是排队到超时。

> ℹ️ 计数字段按操作区分：`program`/`fill` → `bytes_written`；`verify` → `bytes_verified`；
> `erase` → `bytes_erased`（chip 擦除为 Flash 区域大小，扇区擦除为实际擦除的扇区总大小）。
> 响应中不会再出现与本次操作无关的 `0` 值计数字段。

> ℹ️ **校验前会复位**：Flash 算法写完后，芯片复位前调试口可能读到陈旧内容（实机稳定复现：
> chip erase → program 内部校验误报 `0x08000000` 不一致，复位后即正确）。因此
> `program` 的内部校验与独立 `flash verify` 都会先 `reset_and_halt` 再读；独立
> `verify` 结束后目标停在 paused。`erase` / `fill`（Flash）结束后也会复位一次，
> 保证后续 `blank-check` / `read` 读到真实内容。
>
> ℹ️ **reset 默认值差异**：`flash reset` 默认复位后**运行**（`--no-run` 才暂停）；
> `debug reset` 默认复位并**暂停**（`--mode run` 才运行）。

### `file` — 固件文件工具

| 子命令 | 说明 |
| --- | --- |
| `info <file>` | 解析 bin/hex/elf 的格式、大小、entry 与段信息（`--base-address` 用于 bin） |
| `checksum <file>` | **本地执行**（不需要后端）：计算原始文件字节校验和：`modbus-crc16` / `crc16-ccitt` / `crc32` / `add8` / `xor8` / `add16`；`--start` / `--end` 指定字节范围 |

```powershell
omni file info .\app.hex
omni file info .\app.bin --base-address 0x08000000
omni file checksum .\app.bin --algorithm crc32
omni file checksum .\app.bin --algorithm modbus-crc16 --start 0 --end 1024
```

> ℹ️ `checksum` 计算的是**原始文件字节**，与 GUI 文件校验页一致；不会解析 hex/elf 的地址段。
> `--end` 为不含端点的字节偏移。
> `checksum` 不建后端客户端，也没有 `--managed` / `--backend-port` / `--timeout` 这些后端连接选项；
> `info` 仍需后端（hex/elf 解析在后端完成）。

### `tool` — 离线工具

| 子命令 | 说明 |
| --- | --- |
| `map <file.map>` | 分析 ARM 链接器 map：ROM/RAM 使用、执行区域、分类、ROM Top 条目（`--top N`） |

```powershell
omni tool map .\Listings\stm32f407\omni.map
omni tool map .\omni.map --top 20 --json
```

### `commander` — pyOCD Commander

直接复用后端的 pyOCD 命令系统（`reg` / `read32` / `write32` / `break` / `step` / `disasm` 等）。

| 子命令 | 说明 |
| --- | --- |
| `exec <command...>` | 执行单条命令 |
| `shell` | 交互式 REPL；`--command CMD` 可非交互批量执行（`;` 分隔） |
| `reset` | 重置探针的 Commander 上下文（目标切换/重连后） |
| `cancel` | 取消该探针上正在执行的命令（长命令/僵死命令的出口） |

> 列出 pyOCD 可用命令用 **`omni commander exec help`**（不带参数）。
> `omni commander exec list` 是 pyOCD 的“探针/目标”列表命令，输出的是探针与目标表，
> **不是**命令列表。

```powershell
omni commander exec help                     # 列出 pyOCD 全部命令
omni commander exec help read32              # 查看某命令用法
omni commander exec read32 0x080000C0 4
omni commander exec reg
omni commander exec list                     # pyOCD 的探针/目标列表（不是命令列表）
omni commander shell                         # 进 REPL，连续调试最省事
omni commander shell --command "status; reg"
omni commander cancel                         # 取消正在执行的命令
omni commander reset                          # 目标切换/重连后重置上下文
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
| `reset` | 复位，`--mode halt`（默认，复位并暂停）/ `run` / `break-symbol`（复位运行并停在入口符号；与 `flash reset` 默认运行相反） |
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

### `monitor` — 变量采样与导出

复用后端 `/api/probes/{uid}/monitor/*`：加载 ELF → 选符号 → 加监视变量 → 采样 → 读取/导出。

| 子命令 | 说明 |
| --- | --- |
| `status` | 采样状态（运行/暂停/实际速率/变量数/缓冲点数） |
| `elf load <file>` / `elf changed` | 加载 ELF/AXF（Monitor 符号） / 检测文件是否变化 |
| `symbols` | 查询符号（`--filter` / `--type object\|func\|all` / `--page` / `--page-size`） |
| `var list` | 列出监视变量（ID/名称/地址/类型/刷新/备注） |
| `var add --symbol <name> [--index N]` | 按符号添加；数组必须给 `--index` |
| `var add --name N --address A --type T` | 手工地址添加（`--index` 可用于数组元素） |
| `var rm <id>` / `var set <id> --value V` | 删除变量 / 写回目标内存 |
| `start` / `stop` / `pause` / `resume` | 采样控制（`--rate` / `--max-points` / `--transport swd\|rtt`） |
| `device run\|halt\|reset\|state` | 目标内核控制（`reset --no-run` 复位后暂停） |
| `read` | 读取落盘样本（`--start-ms` / `--end-ms` / `--limit` / `--max-points`） |
| `read --follow` | 持续跟踪新样本（`--interval` / `--duration`，Ctrl+C 结束） |
| `export <out.csv>` | 导出落盘 CSV（`--mode all\|recent\|custom`，`--force` 覆盖） |

```powershell
omni monitor elf load .\app.axf
omni monitor symbols --filter counter
omni monitor var add --symbol g_counter
omni monitor var add --symbol g_buf --index 3
omni monitor var list
omni monitor start --rate 1000
omni monitor read --limit 20
omni monitor read --follow --duration 5
omni monitor export .\monitor.csv --mode recent --recent 10 --force
omni monitor stop
```

> ℹ️ `var add --symbol` 会先按名字精确匹配；数组符号必须 `--index`，越界/歧义会直接拒绝。
> `read` 默认只显示 200 个样本（`--limit 0` 表示全部）；`--follow` 不受该限制，
> 默认从当前最新样本之后开始跟踪，不重复输出；需要回放历史时显式传 `--start-ms 0`。
>
> ℹ️ 采样数据落盘后 `read/export` 可跨会话读取；后端在读取前会 flush 当前文件，
> 因此采样进行中也能看到最新样本。

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
| `flm-info <flm>` | 从 `.FLM` 自动提取 Flash 参数（供 `custom` 填参） |
| `reimport` | 从 `device_info.json` 重新导入初始数据 |

`custom` 必填参数：`--part-number` `--flash-base` `--flash-size`(KB) `--ram-base` `--ram-size`(KB)；可选 `--core`（默认 `Cortex-M4`）`--vendor` `--display-name`。

```powershell
omni device summary
omni device list --search G32
omni device info g32f463xc
omni device flm-info .\G32F463.FLM          # 查看 FLM 的 base/size/page/sector
omni device custom .\G32F463.FLM --part-number MYCHIP --flash-base 0x08000000 `
    --flash-size 1024 --ram-base 0x20000000 --ram-size 128
omni device delete MYCHIP -y
```

### `rtt` — SEGGER RTT

| 子命令 | 说明 |
| --- | --- |
| `status` | 查询 RTT 会话状态（含上行缓存统计：`buffered_bytes` / `next_seq` / `dropped_bytes`） |
| `start` | 启动 RTT 会话（`--address` / `--size` 指定控制块搜索范围，`--up-channel` / `--down-channel` 选通道） |
| `stop` | 停止 RTT 会话（已缓存的上行数据仍可读取） |
| `channels` | 列出 up/down 通道 |
| `read` | **读取上行数据**：一次性读取当前缓存，或 `--follow` 持续跟踪 |
| `send` | 发送数据：`--file PATH` / `--base64 DATA` / `--text TEXT`（三选一），`--channel` 指定通道 |
| `device run\|halt\|status\|reset` | 目标内核控制；`reset` 会重新初始化 RTT 控制块，`--no-run` 复位后停在暂停态 |

`read` 选项：

| 选项 | 说明 |
| --- | --- |
| `--channel N` | 只看指定 up channel（缺省全部通道） |
| `--since SEQ` | 从指定 seq 续读（默认 0 = 从当前最旧可用数据）。seq 在同一后端进程内**跨 `rtt start` 单调递增**；后端重启后从 1 开始 |
| `--max-bytes N` | 单次最多读取的字节数（默认 65536；按整块返回，不拆块） |
| `--follow` | 持续跟踪新数据（Ctrl+C 结束，退出码 0） |
| `--interval SEC` | follow 轮询间隔（默认 0.2） |
| `--duration SEC` | follow 持续秒数（默认 0 = 一直跟踪；适合 CI 定时采样） |
| `--out FILE` | 把原始字节追加写入文件（与 `--json` 可同时使用） |
| `--encoding ENC` | 文本解码编码（默认 utf-8；非法字节替换，`--json` 的 base64 无损） |

后端在轮询线程里把每个通道读到的数据同时写入一份 **64 KiB 环形缓存**（WebSocket 推送不受影响），
REST 与 CLI 都从这份缓存增量读取，因此：

- GUI 没开（或没连 WebSocket）时，CLI 依然能拿到日志；
- 多个 `rtt read` 客户端互不影响（各自维护 `cursor`，服务端不消费游标）；
- 缓存被覆盖时响应带 `lost: true`，CLI 会向 stderr 打警告；
- **seq 在后端进程内单调递增**：`rtt start/stop/start` 只清空缓存，不重置编号，旧会话的
  `next_seq` 可以继续作为 `--since` 游标；只有**后端重启**后 seq 才从 1 开始，此时旧游标
  会触发 `session_reset: true`，CLI 打警告并从当前最旧数据重读；
- `--json` 返回 `{seq, channel, data(base64), text, cursor, truncated, lost, session_reset, oldest_seq, next_seq, dropped_bytes}`，
  可直接用于 CI 断言；`--follow --json` 输出逐行 JSON（JSONL）。
- **`--json` 模式下 stdout 始终是纯 JSON/JSONL**：`session_reset` / `lost` 等警告放在响应的
  `warning` 字段里（不会写 stderr，避免 `2>&1` 把中文警告混进 JSON）；人类可读模式才把警告
  写到 stderr。`--follow --json` 在“只有警告、暂无数据”时也会输出一行带 `warning` 的对象。

```powershell
omni rtt start --uid 852001270
omni rtt read --uid 852001270                 # 打印当前已缓存日志
omni rtt read --uid 852001270 --follow        # 持续跟踪（Ctrl+C 退出）
omni rtt read --uid 852001270 --json          # 可断言的 JSON（含 seq/text）
omni rtt read --uid 852001270 --channel 0 --out rtt.log --follow --duration 10
omni rtt channels --uid 852001270
omni rtt send --uid 852001270 --text "hello"
omni rtt send --uid 852001270 --file .\payload.bin
omni rtt device halt --uid 852001270
omni rtt device reset --uid 852001270
omni rtt stop --uid 852001270
```

## 退出码约定

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 业务失败或运行错误（错误信息输出到 stderr，前缀 `错误:`） |
| `2` | 用法错误：未指定子命令、`argparse` 参数错误、多目标未指定 `-b/--board`；`omni config` 的 `--stop-on-change` 检测到 Keil 工程变化时也返回 2 |
| `3` | `omni_config.py` 启动器环境错误：找不到 `omni` 或版本过低 |

脚本中判断后端是否存活：

```powershell
omni backend status --quiet
if ($LASTEXITCODE -ne 0) { omni backend start }
```

后端异常时 CLI 会区分三种情况，不再一律说“未找到后端”：

| 情况 | 提示 |
| --- | --- |
| 端口无监听 | 无法连接后端，引导 `omni backend start`（或 `--managed`） |
| 端口在监听但请求超时 | 后端无响应（可能僵死/被硬件操作阻塞），引导 `omni backend stop` 后重启 |
| 后端返回 4xx/5xx | 透传后端 `detail` |

## 输出编码

CLI 在管道/重定向下会把 stdout/stderr 显式设为 UTF-8（`errors=backslashreplace`），
避免中文 Windows 的 cp936 编码与消费端（PowerShell 7 / CI / Node）的 UTF-8 解码不一致，
从而产生 `�`（U+FFFD）。设置了 `PYTHONIOENCODING` 时尊重用户配置。

后端日志（stderr）同样固定为 UTF-8，`.backend.log` 不再出现中文乱码。

构建脚本会在打包前检查所有第一方 `.py` 是否为合法 UTF-8 且不含 U+FFFD，并在打包后
运行 `omni backend -h` 校验帮助输出：

```powershell
python build.py --check-sources     # 只检查源码编码
python build.py --cli-only          # 只重建 CLI（打包后自动校验帮助输出）
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OMNI_BACKEND_DIR` | 后端根目录（含 `server.py`）。wheel 安装后用于定位后端 |
| `OMNI_BACKEND_SERVER` | 直接指定 `server.py` 路径，优先级最高 |
| `OMNI_BACKEND_PORT` | 后端端口覆盖（与 Electron 主进程一致） |
| `OMNI_PROJECT_DIR` | `omni config` 的工程根目录覆盖 |
| `OMNI_EMB_ROOT` / `OMNI_ROOT` | `omni config` 的 omni 框架根目录覆盖（接受仓库根或 `omni/`） |
| `OMNI_BOARD` | `omni config` 的默认板级目标 |
| `OMNI_CLI` | `omni_config.py` 启动器查找的 `omni` 可执行文件/目录 |
| `OMNI_PROJECT_SKIP_VERSION_CHECK` | 设为 `1` 时启动器跳过版本检查 |

`server.py` 定位优先级：`OMNI_BACKEND_SERVER` → `OMNI_BACKEND_DIR` → 包内 `cli.config.json`（由 `cli-package.ps1` 安装时写入）→ 源码树布局。

## 运行时文件

均位于包目录（`.venv\Lib\site-packages\omni_cli\` 或源码目录）：

| 文件 | 说明 |
| --- | --- |
| `cli.config.json` | 持久化的后端目录（wheel 安装时写入） |
| `.backend_runtime.json` | 常驻后端的 pid / port 记录 |
| `.backend.log` | 后端 stderr 日志，启动失败时排查用 |
| `.backend.handshake.jsonl` | 常驻模式握手文件（stdout 重定向） |

## 测试

```powershell
cd D:\workspace\embedded\omni-link\python

# 离线回归（无需硬件）：RTT 环形缓存、commander 选项前移、错误分类、编码检查、verify 字段
..\.venv\Scripts\python.exe test_cli_fixes.py

# 工程配置回归（无需硬件/后端）：上下文解析、Kconfig 合并、BSP、Keil 同步
..\.venv\Scripts\python.exe test_project_cli.py

# 源码编码检查（UTF-8 / 无 U+FFFD）
..\.venv\Scripts\python.exe build.py --check-sources

# 安全子集：自检 + 探针/目标 + 设备库 + Commander（不写 Flash）
powershell -File scripts\cli-smoke.ps1 -UseInstalled

# 追加破坏性回环：program → verify（含 bytes_verified 断言）→ blank-check → erase → blank-check
powershell -File scripts\cli-smoke.ps1 -UseInstalled -Firmware .\app.hex

# 追加调试控制段：elf load → src files → bp add/list/del → regs → mem → stack/locals/disasm → periph → session
powershell -File scripts\cli-smoke.ps1 -UseInstalled -Elf .\app.axf

# 追加 RTT 上行读取：rtt start → status → read --json → read --follow --duration 2 → stop
powershell -File scripts\cli-smoke.ps1 -UseInstalled -Rtt
```

`-UseInstalled` 表示使用 venv 中已安装的 `omni.exe`；省略则用源码 `python -m omni_cli`。脚本会自行拉起后端、自动取第一个探针，结束时清理进程，每条命令后打印 `exit=`。
`cli-smoke.ps1` 还会检查帮助输出无 U+FFFD、缺少 `--target` 的 `probe connect` 立即失败，任一检查不通过时脚本以非 0 退出。

## 常见问题

**`错误: 未找到正在运行的后端`**
先 `omni backend start`，或给命令加 `--managed`。

**`后端在端口 xxxxx 上有监听但 HTTP 无响应` / `请求超时`**
后端进程还活着，但被挂起的 pyOCD 操作（连接/烧录/调试）拖住了。执行 `omni backend stop`
（会按端口定位进程树强杀）后重新 `omni backend start`。连接超时也会把该探针会话标记为失效，
不需要重启后端即可重试。

**`错误: 未找到后端 server.py: ...\site-packages\server.py`**
wheel 安装后未记录后端位置。重跑 `python\scripts\cli-package.ps1`，或临时设置 `OMNI_BACKEND_DIR` 指向 `python\` 目录。

**`omni config` 报“工程包含多个目标板”**
该工程有多个 `boards/<target>`；用 `-b/--board` 指定，例如
`omni config generate --board stm32f407ig`。

**`omni config generate` 报 `No module named kconfiglib`**
当前 Python 环境缺少 `kconfiglib`。wheel 安装会自动安装；源码态执行
`..\.venv\Scripts\python.exe -m pip install kconfiglib`，或 `uv pip install kconfiglib`。

**`omni config menuconfig` 打不开 / 找不到 menuconfig**
`menuconfig` 是 `kconfiglib` 提供的控制台命令。确认安装它的 `Scripts` 目录在 PATH，
或在 Python 环境中使用 `python -m menuconfig`。

**`omni_config.py` 报“未找到 omni CLI”或版本过低**
构建钩子通过启动器调用 CLI。安装 OMNI CLI（0.3.2+），或设置
`OMNI_CLI=D:\path\to\omni.exe`。启动器返回码 3 表示环境问题，不是配置生成失败。

**J-Link 连不上目标**
必须用 `--jlink-device` 指定 SEGGER 数据库中的设备名（大小写敏感），例如 `--jlink-device G32F463XC`。该名称与 CMSIS-PACK 型号不一定相同。

**`错误: incorrect number of arguments`**
命令参数个数或格式有误，常见是地址被拆成多个 token。用 `omni commander exec help <命令>` 查用法，例如 `read32 0x080000C0 4`（地址是一个 token）。

**`device info` 查不到型号**
设备库中型号为小写（如 `g32f463xc`），查询时需保持一致。

**改了源码但 `omni` 行为没变**
wheel 安装态用的是 site-packages 中的副本，重跑 `cli-package.ps1` 重新安装即可。
