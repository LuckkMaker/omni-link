# Commander

Commander 页面提供交互式命令行，复用 pyOCD Commander REPL，对标 SEGGER J-Link Commander。

![Commander 命令行](../assets/images/commander_page.png)

## 界面布局

中央终端区域为 xterm.js 渲染的交互式 REPL，执行 `halt`、`load`、`reset`、`step` 等命令后自动输出反汇编结果，指令行附带源文件名与行号标注（如 `system_stm32f4xx.c:168`），并在右侧注释中显示对应的 C 代码片段。右侧命令面板将 halt/step/where/reset 等命令归类为快捷按钮，路径切换区可快速加载 ELF 文件，「常用流程」区将调试、断点调试、解锁刷写三套多步操作链封装为可单击的工作流。

## 连接

Commander 复用顶部设备切换器选择的探针与目标。进入 Commander 页面后，终端自动连接并显示目标状态。若探针未连接，终端提示等待连接。

Commander 采用 keep-alive 机制，切走页面时使用 `display:none` 保留 xterm 实例与会话状态，切回时无需重新连接。

## 常用命令

完整命令列表见 [Command reference](../reference/command.md)。

### 复位与运行控制

| 命令 | 说明 |
|------|------|
| `reset` | 复位目标 |
| `halt` | 暂停目标 |
| `continue` | 继续运行 |
| `step` | 单步执行一条指令 |

### 内存读写

| 命令 | 说明 |
|------|------|
| `read32 ADDR [COUNT]` | 读取 32 位内存 |
| `write32 ADDR DATA...` | 写入 32 位内存 |
| `load FILE` | 烧录固件文件 |

### 寄存器与反汇编

| 命令 | 说明 |
|------|------|
| `reg` | 读取所有核心寄存器 |
| `reg NAME` | 读取指定寄存器 |
| `disasm ADDR [COUNT]` | 反汇编指定地址 |
| `where` | 显示当前 PC 位置与源码 |

## 快捷命令面板

右侧命令面板提供常用命令的快捷按钮，无需手动输入：

- **halt / step / continue / reset** — 运行控制
- **where** — 查看当前执行位置
- **disasm** — 反汇编当前 PC 附近代码

## 命令参考表

右侧命令面板底部提供命令参考表，将常用命令与参数分类列出（复位与控制、内存读写、寄存器、反汇编等），并附带命令示例。点击命令或示例即可将其插入终端，无需手动输入，方便记不住命令的新手快速上手。参考表区域支持拖拽调整高度。

## 一键工作流

「常用流程」区将多步操作链封装为单击工作流：

- **调试** — halt → 加载 ELF → reset → halt，准备好调试环境
- **断点调试** — halt → 加载 ELF → 设置断点 → reset → halt → continue，运行到断点处暂停
- **解锁刷写** — 解锁安全区域 → 擦除 → 烧录，适用于带读保护的芯片

## source 命令

`source` 命令参考 GDB 的 `directory`/`substitute-path` 设计，解决跨机器源码路径映射问题。当 ELF 文件中记录的源码路径（如编译机的 `/home/user/project/src/main.c`）与当前机器上的实际路径不一致时，可通过 `source` 配置替换规则：

```
source add /home/user/project/src D:/myproject/src
source list
source remove 0
```

配置后，`where` 和 `disasm` 命令显示的反汇编结果会附带正确的源码路径与代码片段。
