# Command reference

Commander 页面复用 pyOCD Commander REPL，以下为完整命令参考。OMNI Link 在此基础上增加了 `source` 命令用于源码路径映射。

## 会话与状态

| 命令 | 说明 |
|------|------|
| `list` | 列出所有探针 |
| `status` | 显示目标状态（运行/暂停） |
| `exit`, `quit` | 退出 commander |
| `help [command]` | 显示帮助 |
| `sleep MS` | 睡眠指定毫秒 |
| `set OPTION VALUE` | 设置会话选项 |

## 复位与运行控制

| 命令 | 说明 |
|------|------|
| `reset` | 复位目标 |
| `halt` | 暂停目标 |
| `continue`, `go` | 继续运行 |
| `step` | 单步执行一条指令 |

## 寄存器

| 命令 | 说明 |
|------|------|
| `reg [name]` | 读取寄存器（不指定名称则读取所有核心寄存器） |
| `wreg NAME VALUE` | 写入寄存器 |
| `reg --all` | 读取所有寄存器包括调试寄存器 |

## 内存读写

| 命令 | 说明 |
|------|------|
| `read8 ADDR [COUNT]` | 读取 8 位内存 |
| `read16 ADDR [COUNT]` | 读取 16 位内存 |
| `read32 ADDR [COUNT]` | 读取 32 位内存 |
| `read64 ADDR [COUNT]` | 读取 64 位内存 |
| `write8 ADDR DATA...` | 写入 8 位内存 |
| `write16 ADDR DATA...` | 写入 16 位内存 |
| `write32 ADDR DATA...` | 写入 32 位内存 |
| `write64 ADDR DATA...` | 写入 64 位内存 |
| `savemem ADDR SIZE FILE` | 保存内存到文件 |
| `loadmem ADDR FILE` | 从文件加载到内存 |
| `load FILE [FORMAT]` | 烧录固件文件 |
| `compare ADDR FILE` | 比较内存与文件 |
| `fill ADDR SIZE PATTERN` | 填充内存 |
| `find ADDR SIZE PATTERN` | 在内存中搜索 |

## Flash 操作

| 命令 | 说明 |
|------|------|
| `erase [ADDR LENGTH]` | 擦除 Flash（不指定参数则擦除整个芯片） |
| `unlock` | 解锁安全区域 |

OMNI Link 的 `erase` 命令直接操作 `boot_memory` 的 Flash 实例，与 Flash 页面的擦除行为一致。

## 断点与观察点

| 命令 | 说明 |
|------|------|
| `break ADDR` | 设置断点 |
| `remove BREAKPOINT` | 移除断点 |
| `lsbreak` | 列出断点 |
| `rmbreak BREAKPOINT` | 移除断点 |
| `watch ADDR [SIZE] [R/W/RW]` | 设置观察点 |
| `rmwatch WATCHPOINT` | 移除观察点 |
| `lswatch` | 列出观察点 |

## 调试端口 (DP/AP)

| 命令 | 说明 |
|------|------|
| `readdp ADDR` | 读取 DP 寄存器 |
| `writedp ADDR DATA` | 写入 DP 寄存器 |
| `readap ADDR` | 读取 AP 寄存器 |
| `writeap ADDR DATA` | 写入 AP 寄存器 |
| `initdp` | 初始化 DP |
| `makeap AP_NUM` | 创建 AP |
| `flushprobe` | 刷新探针缓冲 |
| `reinit` | 重新初始化 |

## 反汇编与符号

| 命令 | 说明 |
|------|------|
| `disasm ADDR [COUNT]` | 反汇编指定地址 |
| `where` | 显示当前 PC 位置和源码 |
| `symbol NAME` | 查找符号地址 |
| `core NUM` | 选择核心 |

## source 命令（OMNI Link 扩展）

`source` 命令参考 GDB 的 `directory`/`substitute-path` 设计，解决跨机器源码路径映射问题。当 ELF 文件中记录的源码路径与当前机器上的实际路径不一致时，配置替换规则后 `where` 和 `disasm` 命令可正确显示源码。

```
source add <原始路径前缀> <本地路径前缀>
source list
source remove <索引>
source clear
```

示例：

```
source add /home/user/project/src D:/myproject/src
source list
  0: /home/user/project/src -> D:/myproject/src
source remove 0
```

## 服务器

| 命令 | 说明 |
|------|------|
| `gdbserver start` / `stop` | 启动/停止 GDB 服务器 |
| `probeserver start` / `stop` | 启动/停止探针服务器 |

pyOCD Python API 与会话选项的完整参考见 [pyOCD 命令参考](../tech/pyocd-reference.md)。
