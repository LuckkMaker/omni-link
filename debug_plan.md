列计划，解决以下问题
优先考虑对应用已完成功能的影响。

## 优化应用功能
1. 使用 DAPLink 仿真器时，用 JTAG 连接不上目标设备。之前修改pyocd源码后可以用JLink仿真器连接，但 DAPLink 仍然无法连接。需要进一步排查原因。
2. 增加一种通过target_xxx.py的导入的方式。
3. 分析probe-rs与pyocd的差异
4. 不同页面的竞态状态问题，可能导致页面功能异常。需要分析各页面的状态管理逻辑，确保状态同步和一致性。
5. JLink在板子reset几次后就连接不上

## 优化 Flash 页面功能

## 优化 Commander 页面功能

## 优化 RTT Viewer 页面功能

## 优化 Monitor 页面功能

## 优化 Zone 页面功能
1. 开启[周期刷新]后，当断点被触发时，要按照断点触发时的逻辑刷新。目前发现当开启周期刷新与不开启周期刷新时，断点处变量的变化会不一致。开启周期刷新时，断点触发后，变量的值没被刷新

## CLI 工具

结构现状 ：`omni` 有 8 个命令组 ——`backend / commander / debug / device / flash / probe / rtt / target` （ cli.py ）。

覆盖盲区 （后端有端点、CLI 无对应命令）——这是最大的不完善：

- 整个`monitor` 组缺失 ：`api/monitor.py` 有 17 个端点（实时变量监视、录制导出、device run/halt/reset、record/export…），CLI 完全没有。
- `packs` （器件包管理）缺失 ：`api/packs.py` 的列表/预览/导入/删除等全无 CLI（前端有 pack.service.ts ，venv 里也有`pack-manager.exe` ）。
- `files` （文件 stat/parse/read/save）缺失 ： api/files.py 4 个端点无 CLI。
- 零散端点未覆盖 ：`commander/commands|reset|cancel` 、`probes/states` 、`probes/jlink/devices*` 、`probes/refresh` 、`devices/custom/extract-flm-info` 、`tools/map-analyzer` 、`zone/elf/changed` 、`zone/source/executable-lines` 、`source/content` (POST)、`nvic/{n}/enable|pending` 、`scb/stir|field` 。
代码里的显式 TODO （自有代码，排除 vendored pyocd）只有两处：

- dwarf_locals.py:674 —— DWARF 表达式部分操作符暂不支持。
- monitor_backend.py:1524 —— Monitor 不支持`double` （归并为 float）。
已知缺陷 ：`probe connect --connect-mode attach` 会触发原生层崩溃`0xc000001d` （ probes.py 中`attach` 是默认模式），仅默认 halt 模式正常， 尚未修 。（本次已修的：callgraph Thumb 位、periph 合并块读、stack 请求方法、多探针选错 uid。）