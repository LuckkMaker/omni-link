列计划，解决以下问题
优先考虑对应用已完成功能的影响。

## 优化应用功能
1. 使用 DAPLink 仿真器时，用 JTAG 连接不上目标设备。之前修改pyocd源码后可以用JLink仿真器连接，但 DAPLink 仍然无法连接。需要进一步排查原因。
2. 增加一种通过target_xxx.py的导入的方式。
3. 分析probe-rs与pyocd的差异

## 优化 Flash 页面功能

## 优化 Commander 页面功能
1. Commander 终端（xterm.js）文本换行没有自适应对齐，行尾字符可能被滚动条覆盖。
   问题根因：`FitAddon` 计算列宽时用容器宽度，但只减去 `.xterm` 元素的 padding，不减去容器的 padding。`Terminal.tsx` 容器用了 `pl-2`（padding-left 8px），导致 fit 算出的列宽比实际可用宽度大 8px，`screen` 右侧压到 overlay 滚动条，行尾被盖住、对齐错乱。
   参考修复方案（已在 omni-bus 串口终端验证）：把 padding 从容器移到 `.xterm` 元素上，让 fit 正确扣除。即在容器加 `serial-terminal` 标识 class，去掉 `pl-2`，在样式里给 `.serial-terminal .xterm { padding-left: 8px; }`。之后可再验证并统一处理。

## 优化 RTT Viewer 页面功能

## 优化 Monitor 页面功能

## 优化 Zone 页面功能
1. 源码 Tab优化，激活的 tab 背景色改为应用主题色
2. 源码窗口，<math.h> 包含的头文件没有高亮
3. 源码窗口，文件 tab 增加鼠标右键菜单，提供「关闭」和「关闭其他」选项
4. 源码窗口，增加文件编辑的部分功能，鼠标选择文本，右键菜单提供「复制」，「全选」选项，[转到定义]和[转到引用]功能，看是否要引入 clangd ?
5. stop session 或重新连接后，清除所有断点
6. 运行指示与断点指示重叠时，断点指示被覆盖，无法看到断点位置。看这种情况下把运行指示改为半透明，还是增大断点指示？
7. source files 窗口的文件按文件名第一个字母排序
8. 顶部菜单栏，或者各个tab，当我点击过快时，菜单和tab的text会被选中
9. 当代码运行到不是function的行时，要不要禁用 [step out] 按钮？或者在点击时弹出提示？参考keil mdk