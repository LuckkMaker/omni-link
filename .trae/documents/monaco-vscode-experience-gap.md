# OMNI Link 源码视图：Monaco vs VS Code 编辑/显示体验差距分析

## 摘要

本报告分析 OMNI Link 的 Zone 源码视图（基于 `@monaco-editor/react` 0.56）与 VS Code 在编辑体验、显示体验、语言服务三个维度上的差距，并给出针对本工具定位（嵌入式调试源码视图、默认只读、强调 PC/断点/光标跟焦）的分级改造建议。

**核心结论**：Monaco 是 VS Code 的编辑器内核，但 VS Code = Monaco + Workbench + 扩展宿主。差距的本质是——VS Code 里习以为常的补全/悬停/状态栏/面包屑/诊断，绝大多数来自 Workbench UI 和语言扩展（LSP），在 Monaco 中要么是**被显式关掉的配置项**（改一行即可解锁），要么是**根本不存在、需自行实现或接入 LSP 的能力**。

产出物为纯分析报告，不落地代码。

---

## 一、当前状态（已核对源码）

参与评估的实现（`src/pages/zone/components/SourceView.tsx` + `src/lib/monaco-setup.ts`）：

- 编辑器 `options`：`readOnly` 默认、`folding:true`、`minimap` 关闭、`renderLineHighlight:'none'`、`contextmenu:false`（自定义右键）、`quickSuggestions/wordBasedSuggestions/suggestOnTriggerCharacters/parameterHints/snippetSuggestions` 全关、`selectionHighlight:false`、`occurrencesHighlight:'off'`、`links:false`、`renderWhitespace:'none'`
- 已实现：编辑模式切换、保存/`Ctrl+S`、脏标记、tab 管理、右键菜单（复制/全选/转到定义/转到引用）、断点/PC/光标装饰（`buildSourceDecorations`）、Monarch 汇编高亮、主题联动（`applyOmniTheme` 从 CSS 变量构建 `omni-dark`）
- 语言映射（`monacoLangFor`）：`.c/.h/.cpp/.hpp`→`cpp`，`.s/.asm`→`arm-asm`，其余→`plaintext`

---

## 二、能力差距清单

### 1. 编辑体验类

| 能力 | 当前状态 | VS Code 体验 | Monaco 实现方式 | 成本 | 本场景价值 |
|---|---|---|---|---|---|
| 自动补全 | 全关，无补全源 | 默认开启，输入弹补全 + Ctrl+Space | `cpp`/`asm` 无语义源；需 LSP 或自建 provider | 高（语义）/ 中（词库） | 中（仅编辑模式有意义） |
| 悬停 | 无 hover provider | 悬停显示类型/文档/签名 | `registerHoverProvider`，可用后端符号表自建 | 中 | 高（调试看符号信息有用） |
| 括号自动闭合/配对 | 未显式关闭，编辑模式生效 | 默认 `autoClosingBrackets` 配对高亮 | Monaco 原生配置 | 低 | 中 |
| 括号配对配色 | 未深定制主题色 | 默认开启 | `bracketPairColorization` + 主题色 | 低 | 中 |
| 多光标 | 未禁用，默认可用 | Alt+Click / Ctrl+D | Monaco 原生内置 | 低 | 中（编辑模式） |
| 代码折叠 | 已开 | 默认开 | 已实现 | 无需改 | 高（已满足） |
| 选中词/光标词高亮 | `selectionHighlight:false`、`occurrencesHighlight:'off'` 显式关 | 默认高亮 | 改回 true | 低 | 高（强烈建议） |
| 当前行高亮 | `renderLineHighlight:'none'` 关 | 默认当前行底色 | 改为 `{active:'line',line:'all'}` | 低 | 高（配合 PC 跟焦） |
| 智能缩进 | 默认 advanced | 默认 advanced | 无需改 | 低 | 中 |
| sticky scroll 表头吸顶 | 未开 | 新版默认，函数头吸顶 | `stickyScroll.enabled:true` | 低 | 中（大文件有用） |
| inlay hints 内联提示 | 未开 | C/C++ 扩展提供参数名提示 | 需语言服务 | 高 | 中 |

### 2. 显示体验类

| 能力 | 当前状态 | VS Code 体验 | Monaco 实现方式 | 成本 | 本场景价值 |
|---|---|---|---|---|---|
| 缩略图 minimap | `minimap:{enabled:false}` 关 | 默认开，右侧概览+点击跳转 | 改 `{enabled:true}`（可配 maxColumn/renderCharacters） | 低 | 中（大源码定位有用） |
| 面包屑 breadcrumbs | 无 | Workbench 组件，路径/符号层级可点跳 | Monaco 无内置，需自建 DOM + 符号 provider | 高 | 低（已有 tab 栏替代） |
| 状态栏 | 无 | 行列/语言/缩进/编码 | Monaco 无内置，需自建 DOM | 中 | 低（工具下方有状态区） |
| 语义高亮 | 仅 Monarch tokenizer 级 | cpptools/clangd 语义 token | `semanticHighlighting` + LSP | 高 | 中 |
| 链接 | `links:false` 关 | 默认识别 URL | 改回 true | 低 | 低（源码视图不需要） |
| 行高亮/装饰 | 已实现 PC/断点/光标 | 调试扩展 PC 行、断点红点 | 已通过 `deltaDecorations` 实现 | 已满足 | 高（已满足） |
| 断点槽 glyph margin | `glyphMargin:true` 已开 | 断点槽 | 已实现 | 已满足 | 高（已满足） |

### 3. C/C++ 语境：Monaco 内置 vs VS Code（重点断层）

| 维度 | Monaco 内置 `cpp` | VS Code (cpptools / clangd) |
|---|---|---|
| 语法高亮 | 有（Monarch，仅关键词/数字/字符串级） | 有 + 语义级（类型/函数/变量区分） |
| 自动补全 | 无任何语义源 | 完整 |
| 跳转定义/引用 | 无（当前用后端符号表 `zoneResolveSymbol`/`zoneSearchSource` 实现） | 完整（含跨文件、peek 内联预览） |
| 悬停/签名 | 无 | 完整 |
| 诊断/错误 | 无 | 完整（红/黄波浪线） |
| 重构成因 | 纯前端 tokenizer | 语言服务器进程（LSP） |

关键点：Monaco 内置 `cpp` 只有 Monarch tokenizer 和基础括号，**没有任何代码智能**（Monaco 仅 TS/JS 有内置语言服务）。VS Code 的 C/C++ 能力全来自扩展，且 **cpptools 是原生二进制无法在浏览器跑**，只能走 LSP（clangd）路线。

---

## 三、LSP / monaco-languageclient 集成成本

若引入 C/C++ 语义能力，标准路径是 TypeFox 的 `monaco-languageclient`（把 Monaco 语言 provider 桥接到 LSP 服务器）：

| 环节 | 内容 | 成本 |
|---|---|---|
| 依赖改造 | 引入 `monaco-languageclient`，Monaco 需用带 IDE 扩展的入口（`@codingame/monaco-vscode-editor-api`） | 高 |
| clangd 运行方式 | Electron 主进程 spawn 原生 / 远端 WebSocket / WASM in-worker | 高 |
| compile_commands.json | 需用户提供或构建系统生成；嵌入式工具通常没有现成 compile database | 高（外部依赖） |
| 与现有装饰共存 | LSP diagnostic 与已有 `deltaDecorations` 需协调 | 中 |
| 离线/体积 | clangd 二进制或 WASM 显著增加 Electron 打包体积 | 中 |

**收敛建议**：不要全量上 LSP。本工具核心是调试源码视图，已有后端符号表支撑转定义/转引用，且默认只读。LSP 边际收益主要在编辑模式的补全/悬停/诊断，投入产出比低。若只想要"像 VS Code"的悬停，可低成本用现有后端符号表做轻量自建 hover provider，无需 LSP。

---

## 四、改造优先级建议

### 第一优先级（低成本、高收益，纯配置改一行）
- 开启 `selectionHighlight:true` + `occurrencesHighlight:'on'`（选中词高亮）
- 开启 `renderLineHighlight`（当前行高亮，配合 PC 跟焦更清晰）
- 若开括号高亮，补 `bracketPairColorization` 主题色（`editorBracketHighlight.foreground*`）

### 第二优先级（中成本，编辑体验）
- 自建轻量 hover provider（复用后端符号表 `zoneResolveSymbol`/`zoneSearchSource`）
- 编辑模式开启 `quickSuggestions`/`wordBasedSuggestions`（词库级补全）
- 编辑模式开启 `autoClosingBrackets`/`multiCursorModifier`

### 第三优先级（视定位决定，高成本）
- minimap 开启（一行配置、成本低、改观明显，可提前）
- 状态栏/面包屑（对本工具价值低，建议不做或后置）
- LSP/clangd 语义补全、诊断、inlay hints（高成本，仅在"可编辑原生源码"成为核心卖点后再投入）

---

## 五、假设与决策

- 用户选择"仅分析不实现"，故本报告不产出代码改动，仅作为后续实施的决策依据。
- 本工具定位为嵌入式调试源码视图，默认只读，故未将全部 VS Code 能力设为必追平项，每项标注了本场景价值判断。

## 六、验证方式

本报告为纯分析产物，无需运行验证。后续若按第一/第二优先级实施，验证方式为：typecheck + 启动前端，在 Zone 页打开源码文件，检查选中词高亮、当前行高亮、悬停提示、编辑模式补全等是否生效。

---

## 参考文件

- `computer://d:\workspaces\project\omni-link\src\lib\monaco-setup.ts` — `applyOmniTheme()` 主题构建、`monacoLangFor()` 语言映射、Monarch asm tokenizer
- `computer://d:\workspaces\project\omni-link\src\pages\zone\components\SourceView.tsx` — 编辑器 options（798-822 行）、`contextmenu:false` 自定义右键、`buildSourceDecorations` 装饰、tab 管理、编辑模式/保存

资料来源：Monaco 官方 TypeDoc（`IEditorOptions`/`IBracketPairColorizationOptions`）、Monaco changelog、TypeFox `monaco-languageclient`、`Guyutongxue/clangd-in-browser`、clangd 官方文档、VS Code C/C++ 扩展文档。