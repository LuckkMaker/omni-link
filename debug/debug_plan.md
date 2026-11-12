列计划，解决以下问题
优先考虑对应用已完成功能的影响。

## UI 优化
1. 左侧边栏，OMNI Tool菜单展开后，无法重新折叠

## 优化应用功能
1. 使用 DAPLink 仿真器时，用 JTAG 连接不上目标设备。之前修改pyocd源码后可以用JLink仿真器连接，但 DAPLink 仍然无法连接。需要进一步排查原因。
2. 增加一种通过target_xxx.py的导入的方式。
3. 分析probe-rs与pyocd的差异
4. 不同页面的竞态状态问题，可能导致页面功能异常。需要分析各页面的状态管理逻辑，确保状态同步和一致性。
5. JLink在板子reset几次后就连接不上

## 优化 Flash 页面功能

## 优化 Commander 页面功能

1. commander页，当连接芯片用reg读出数据后，按键盘上翻看历史命令时，会发reg的数据清掉。read32 0x400140000 这种单行的没被清

## 优化 RTT Viewer 页面功能
1. [启动]按钮改到右侧配置栏

## 优化 Monitor 页面功能

## 优化 Zone 页面功能
1. 开启[周期刷新]后，当断点被触发时，要按照断点触发时的逻辑刷新。目前发现当开启周期刷新与不开启周期刷新时，断点处变量的变化会不一致。开启周期刷新时，断点触发后，变量的值没被刷新

## CLI 工具

## 自定义 FLM 导入支持型号分析（待修复）

结论：**该途径目前整体不可用，属于硬阻断**。以 `samples/STM32H7x_2048.FLM` 为例，创建自定义芯片在第一步就失败（100% 复现）；即使绕过该步，动态 Target 类也无法实例化，FLM 算法注入方式同样不符合 pyOCD 的约定。且 `python/data/user-devices.xml` 中至今没有任何 `source="flm"` 记录，说明历史上从未成功创建过。

### 一、用样例 FLM 的实测结果

FLM 本身可被 `PackFlashAlgo` 正确解析（说明问题不在文件）：

- `flash_start = 0x08000000`
- `flash_size = 0x200000`（2048KB）
- `page_size = 0x400`
- `sector_sizes = [(0, 0x20000)]`（扇区 128KB）
- 算法符号：`Init / UnInit / EraseSector / ProgramPage / EraseChip`（无 Verify）

### 二、逐项问题（按严重度）

P0-1 创建阶段直接抛异常：内核映射与内置 pyOCD 版本不匹配
- 位置：`python/core/custom_target.py:33-43`（`_get_core_class`）
- 原因：内置 pyOCD 的 `pyocd/coresight/cortex_m.py` 只有 `CortexM` / `CortexM_v8M`，没有 `CortexM0/CortexM4/CortexM7` 这些类；`getattr(cortex_m, class_name, cortex_m.CortexM4)` 的默认参数会被预先求值，先抛 `AttributeError`，随后 `from ... import CortexM4` 抛 `ImportError`。
- 影响：无论前端/CLI 选择哪个内核，`POST /api/devices/custom` 都返回 500「创建自定义芯片失败」；`load_custom_targets()` 启动加载也会走同一函数，全部被静默跳过（只记 warning）。

P0-2 动态 Target 类没有继承 `CoreSightTarget`
- 位置：`python/core/custom_target.py:215-236`（`class CustomFlmTarget:` 实为普通 object 子类，内部再手动调 `CoreSightTarget.__init__`）
- 实测：`CustomFlmTarget.__mro__ == [CustomFlmTarget_xxx, object]`；实例化报 `TypeError: super(type, obj): obj must be an instance or subtype of type`（`CoreSightTarget.__init__` 内 `super().__init__` 无法解析）。
- 影响：即使修掉 P0-1，`TARGET[part](session)`（`pyocd/board/board.py:121`）在连接时依然必然失败。

P0-3 FLM 算法注入方式错误（`algo=` 传了对象，应传 dict 或 `flm=`）
- 位置：`python/core/custom_target.py:248-256`（`mm.FlashRegion(..., algo=flash_algo)`，而 `flash_algo` 是 `PackFlashAlgo` 实例）
- pyOCD 约定见 `pyocd/target/pack/flm_region_builder.py:59-101`：`FlashRegion` 只有在 `algo is None` 且 `flm` 有值（路径或 `PackFlashAlgo` 实例）时才会把 FLM 编译成 pyOCD 的 algo dict、按扇区拆分子区域并设置 `are_erased_sectors_readable`；`algo` 必须是 dict。
- 实测：`Flash(target, PackFlashAlgo实例)` 报 `TypeError: 'PackFlashAlgo' object is not subscriptable`（`pyocd/flash/flash.py:137-145` 直接按 dict 下标取值）。
- 影响：即使目标类能实例化，`create_flash` 阶段也会抛异常，表现为「连接失败」，且错误发生在 `session.open()` 而不是创建阶段，排查成本高。

P1-1 扇区/页大小硬编码 0x400，忽略 FLM 实际扇区，且前端填了也不生效
- 后端位置：`python/core/custom_target.py:123-135`、`custom_target.py:248-256` 固定 `sector_size=0x400 / page_size=0x400`。
- 前端位置：`src/pages/settings/CustomChipDialog.tsx` 有「扇区大小 / 页大小」输入，但 `CustomDeviceCreate`（`src/shared/types.ts:274-285`、`python/api/devices.py:51-62`）没有这两个字段，提交时被丢弃。
- 影响：STM32H7x_2048 实际扇区为 128KB，擦除会按 1KB 粒度调用 `EraseSector`，地址不落在扇区边界，轻则擦除失败，重则误擦；未连接时 Flash 页面还会按 1KB 画出 2048 个假扇区（`src/pages/flash/utils/sectors.ts:67-69` 使用设备元数据计算）。

P1-2 内存映射以「用户输入」为准，不使用 FLM 自带信息，失败也不报错
- 位置：`python/core/custom_target.py:114-136` 直接采用表单 `flash_base/size`；`extract_flm_info` 只返回 flash_base/flash_size/page_size，不返回 sector_size（`custom_target.py:340-364`）。
- 前端 `handleSelectFlm` 的 `catch {}`（`CustomChipDialog.tsx:113-124`）会静默吞掉提取失败，此时表单仍是默认 `256KB Flash / 0x400 扇区`，创建出来的就是错误的内存映射。
- 影响：用户看到的容量、扇区、烧录行为可能都与真实芯片不一致，且没有任何提示。

P1-3 「可烧录」判断错误：FLM 设备只看文件存在
- 位置：`python/core/database.py:513-516`（`source == "flm"` 时只判断 `flm_path` 文件是否存在）
- 影响：即使 TARGET 里没有注册该型号（当前必然如此），设备列表/CLI 仍显示 `available=true`；用户选中后连接会得到 `Target type xxx not recognized`，状态自相矛盾。

P1-4 `ram_regions.is_default` 被丢弃
- 位置：`python/core/custom_target.py:259-267` 创建 `mm.RamRegion` 时没有传 `is_default`。
- 影响：pyOCD 的 `MemoryRegion` 默认属性里 `is_default=True`（`pyocd/core/memory_map.py:250`），多 RAM 时「默认 RAM」标记失效，Flash 算法可能被分配到 CCM 等不合适的 RAM（`flm_region_builder.py:131-139` 依赖默认 RAM）。

P2-1 内核选项实际无效
- 位置：`python/core/custom_target.py:220` 只设置了类属性 `CORE`，但 pyOCD 不读取该属性；实际内核由 CoreSight discovery + CPUID 自动识别（`pyocd/coresight/discovery.py:66`）。前端「内核」下拉对最终行为没有影响。

P2-2 创建时不做 FLM 有效性校验
- `_build_custom_target_class` 不解析 FLM，解析被推迟到 `create_flash`；坏 FLM 会「创建成功、连接才炸」。应在创建接口内解析并 fail fast（4xx + 明确错误）。

P2-3 删除设备不回收 TARGET 注册与已复制的 FLM 文件
- `python/api/devices.py:125-133` 仅删库；`python/data/flm/{part_number}.FLM` 与进程内 `TARGET` 条目残留，直到后端重启。

P2-4 part_number 未做 pyOCD 规范化
- `custom_target.py:84` 仅 `lower()`；pyOCD 用 `normalise_target_type_name` 处理空格/横线（`pyocd/target/__init__.py:33`）。含特殊字符的型号会注册成一个用户永远选不中的 key。

### 三、途径/设计层面的问题

1. FLM 本身不足以「支持一个型号」：它只提供 Flash 算法（Flash 起始/大小/页/扇区 + 算法符号），不包含完整 RAM 图、内核、调试序列、SVD、J-Link device 名；同一份 FLM 往往对应多个具体料号（`STM32H7x_2048` 就对应多个 H7 2MB 器件），无法从 FLM 反推 part number。
2. 现有实现自建了一套 Target 注册体系，但没有复用仓库里已有的正确机制：DFP 导入路径 `pyocd/target/pack/pack_target.py` + `FlmFlashRegionBuilder`，以及内置目标模板 `python/pyocd/target/builtin/st/target_STM32F407xx.py` / `python/tools/generate_flash_algo.py`。这导致上面的 P0-2、P0-3 都属于「重复造轮子但造错」。
3. 因此正确语义应是：**FLM + 用户补充的内存参数 → 生成一个可连接的 CoreSightTarget（带正确的 Flash 扇区子区域）**，作为「无 DFP 可用时的兜底」；能拿到 DFP 时应优先走 DFP 导入。

### 四、修复方向（供后续执行，本次不改代码）

建议方案（对齐 pyOCD 原生 FLM 机制）：
1. `CustomFlmTarget` 改为继承 `CoreSightTarget`；删除 `_get_core_class` 与 `CORE` 属性，内核交给 discovery 自动识别（或仅区分 `CortexM` / `CortexM_v8M`）。
2. 内存映射改为：
   - `FlashRegion(start=flash_start, length=flash_length, flm=PackFlashAlgo(flm_path))`
   - `RamRegion(..., is_default=...)`（保留库里的默认标记）
   让 `FlmFlashRegionBuilder` 自动完成 algo dict、page/sector、扇区子区域、`are_erased_sectors_readable`。
   若坚持预生成静态 MemoryMap，则用 `PackFlashAlgo.get_pyocd_flash_algo(page_size, ram_region)` 生成 dict 传给 `algo=`，并按 `iter_sector_size_ranges()` 拆分多个 `FlashRegion`（F4 这类 16/64/128KB 混合扇区必须拆）。
3. `create_custom_target` 创建时解析 FLM：校验必需符号（Init/EraseSector/ProgramPage），用 FLM 的实际 `flash_start/flash_size/page_size/sector_sizes` 作为默认值/校验值，前端不再需要填扇区/页大小（或补齐为可选覆盖项并真正提交）。
4. `extract_flm_info` 增加 `sector_size`（及扇区列表），前端自动填充；提取失败必须提示，不能用静默默认值继续创建。
5. `is_target_registered(source="flm")` 改为「文件存在 **且** `part_number in TARGET`」；删除设备时同步 `TARGET.pop` 并删除已复制的 FLM。
6. 注册/加载时对 part_number 统一走 `normalise_target_type_name`；与内置、pack 型号做大小写不敏感冲突检查。
7. 前端设备表/Flash 页的扇区信息以后端返回（连接后 `target.flash_regions`）或 FLM 解析结果为准，不再使用「单区域 + 0x400」推算。

### 五、验收标准

1. `omni device custom samples/STM32H7x_2048.FLM --part-number stm32h7_custom --flash-base 0x08000000 --flash-size 2048 --ram-base 0x20000000 --ram-size 128` 返回 200，`user-devices.xml` 出现 `source="flm"` 记录。
2. `omni device list` 中该型号 `available=true`；重启后端后仍为 true（验证 `load_custom_targets`）。
3. 连接后 `target.flash_regions` 为 `0x08000000 / 2MB / sector 0x20000 / page 0x400`。
4. 擦除 + 烧录一个小 bin 成功，且擦除范围与扇区边界一致。
5. 故意传入损坏 FLM / 缺失必需符号时，创建接口返回 4xx 明确错误，不写入设备库。