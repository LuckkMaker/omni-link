# OMNI Work UI 设计规则

> 本文档总结项目的 UI 设计规范，作为后续开发和维护的参考标准。
> 技术栈：Electron + React 18 + TypeScript + Tailwind CSS + shadcn/ui

---

## 1. 颜色方案

### 1.1 语义色 Token（CSS 变量）

所有语义色通过 CSS 变量定义在 `src/styles/globals.css` 的 `:root` 中，使用 HSL 格式。Tailwind 配置将这些变量映射为语义类名。

| Token | HEX | 用途 |
|-------|-----|------|
| `--background` | `#ffffff` | 页面背景 |
| `--foreground` | `#0f172a` | 主文字色（slate-950） |
| `--card` / `--popover` | `#ffffff` | 卡片/弹窗表面 |
| `--primary` | `#2563eb` | 主色（blue-600），按钮、激活态 |
| `--primary-foreground` | `#f8fafc` | 主色上的文字 |
| `--secondary` / `--muted` / `--accent` | `#f1f5f9` | 次要背景（slate-100） |
| `--muted-foreground` | `#64748b` | 辅助文字（slate-500） |
| `--destructive` | `#ef4444` | 危险/错误色（red-500） |
| `--border` / `--input` | `#e2e8f0` | 边框色（slate-200） |

**规则**：语义色必须使用 token 类名（`bg-primary`、`text-muted-foreground`、`border-border` 等），禁止硬编码。

### 1.2 透明度修饰

使用斜杠语法控制透明度，而非新建 token：
- 边框淡化：`border-border/50`（列表项分隔）
- 背景层叠：`bg-primary/5`、`bg-primary/10`、`bg-primary/20`（选中态）
- 静默背景：`bg-muted/20`、`bg-muted/30`、`bg-muted/40`
- 危险色淡化：`border-destructive/50`

### 1.3 状态色（允许硬编码）

状态语义色（info/success/warning/error）允许使用 Tailwind 默认调色板：
- 成功：`text-green-500`、`text-green-600`、`bg-green-500/5`、`border-green-500/30`
- 警告：`text-yellow-500`、`text-yellow-400`
- 错误：`text-red-500`、`bg-red-500/30`、`border-red-500/30`
- 信息：`text-blue-500`、`text-blue-400`
- 阶段色：`text-orange-500`、`text-purple-500`、`text-cyan-500`

**例外**：`StatusBar` 使用 `bg-primary text-white` 深色背景，内部用 `bg-white/10`、`text-white/60` 等白色透明度修饰。

---

## 2. 边框与圆角

### 2.1 圆角策略（`--radius: 0.5rem` 基准）

| 类 | 用途 |
|----|------|
| `rounded-md` | **默认圆角**：按钮、输入框、下拉项、小容器 |
| `rounded-lg` | Card 组件、拖拽区 |
| `rounded` | 小按钮组、logo 框 |
| `rounded-sm` | dropdown item、select item（subtle） |
| `rounded-full` | 状态点、进度条、radio 圈 |
| **无圆角** | 表格单元格、表头、HexViewer 网格、面板分区 |

**关键规则**：
- **面板/Section 之间使用直角**（无 `rounded`），仅用 `border` 分隔
- **交互元素**（按钮、输入框、下拉）使用 `rounded-md`
- **Card 容器**使用 `rounded-lg`
- **不要混用**：同一层级的面板必须统一圆角风格

### 2.2 边框规则

- 全局默认：`* { @apply border-border }`，所有元素 border 颜色统一
- 分区线：`border-b border-border`（顶栏底）、`border-t border-border`（底栏顶）、`border-r border-border`（侧边栏右）
- 淡分隔：`border-b border-border/50 last:border-b-0`（列表项之间）
- 虚线边框：`border-2 border-dashed`（文件拖拽区）

---

## 3. 排版

### 3.1 字号梯度

| 类 | px | 用途 |
|----|-----|------|
| `text-2xl` | 24 | 页面主标题（`font-bold`） |
| `text-lg` | 18 | Dialog 标题（`font-semibold`） |
| `text-sm` | 14 | **正文默认**：按钮、输入框、label |
| `text-xs` | 12 | 辅助文字：工具栏、tab、日志、状态栏 |
| `text-[11px]` | 11 | 紧凑信息：InfoPanel key-value 行 |
| `text-[10px]` | 10 | 时间戳、badge 计数 |

### 3.2 字重

| 类 | 用途 |
|----|------|
| `font-bold` | 页面 h1 |
| `font-semibold` | Dialog/Card 标题、表头、tab 激活态 |
| `font-medium` | 按钮默认、nav 激活态、表单 label |

### 3.3 `font-mono` 使用场景

- 十六进制地址：`0x08000000`
- UID / ID 类值：Core ID、Device ID、Revision ID
- 日志内容：`font-mono text-xs leading-relaxed`
- 表格地址列、Hex 输入框
- 等宽数字：`tabular-nums`（进度百分比、字节数）

---

## 4. 间距

### 4.1 常用 padding

| 类 | 用途 |
|----|------|
| `p-6` | 页面外层、Card、Dialog |
| `p-3` | 侧边栏 nav、通知项 |
| `p-2` | 侧边栏顶区、错误提示框 |
| `px-3 py-2` | 顶部工具栏 |
| `px-3 py-1.5` | LogConsole 头部 |
| `px-2 py-0.5` | 状态栏子项 |
| `px-3 py-1` | 下拉菜单项 |

### 4.2 常用 gap

| 类 | 用途 |
|----|------|
| `gap-0.5` | 紧凑工具栏按钮组、状态栏子项 |
| `gap-1` | 工具栏图标按钮 |
| `gap-1.5` | 工具栏按钮内图标+文字 |
| `gap-2` | 卡片头部、表单组、InfoPanel 行 |
| `gap-3` | 通知项图标+内容 |
| `gap-4` | Dialog 垂直间距、两列布局 |

---

## 5. 图标规范

### 5.1 图标库

`lucide-react`（`^0.468.0`）

### 5.2 尺寸（统一用 `size-*` 简写）

| 类 | 用途 |
|----|------|
| `size-3` | 最小图标：折叠箭头、tab close、dropdown 小图标 |
| `size-3.5` | 工具栏图标：FlashPage 工具栏、LogConsole 头部 |
| `size-4` | 默认图标：NavLink 导航、Button 内图标、Dialog 关闭 |
| `size-5` | 卡片标题图标 |
| `size-8` | 空状态大图标（`opacity-40`） |

**规则**：业务代码统一用 `size-*`，不使用 `h-* w-*`。

### 5.3 图标颜色

- 默认继承 `currentColor`
- 辅助说明：`text-muted-foreground`
- 主色强调：`text-primary`
- 状态色：`text-green-600`（已连接）、`text-red-500`（错误）

### 5.4 旋转动画

`<Loader2 className="size-4 animate-spin" />` 用于加载状态。

---

## 6. 布局模式

### 6.1 顶层布局（三段式）

```
┌─────────────────────────────────────┐
│  侧边栏 (w-56)  │     主区域         │  ← flex flex-1 min-h-0
│  - DeviceSwitcher│                  │
│  - NavLink nav   │                  │
│  - InfoPanel     │                  │
├─────────────────────────────────────┤
│           StatusBar (h-6)           │  ← bg-primary text-white
└─────────────────────────────────────┘
```

```tsx
<div className="flex h-screen w-full flex-col">
  <div className="flex flex-1 min-h-0">
    <aside className="flex w-56 flex-col border-r border-border bg-muted/30">...</aside>
    <main className="flex-1 overflow-hidden"><Outlet /></main>
  </div>
  <StatusBar />
  <NotificationContainer />
</div>
```

### 6.2 关键 flexbox 模式

- 顶部固定 + 中间滚动：`flex flex-col` + `flex-1 min-h-0 overflow-y-auto`（**`min-h-0` 是关键**）
- 侧边栏固定底栏：`shrink-0 max-h-[45%] overflow-y-auto`
- 左右推挤：`ml-auto`（工具栏右侧、状态栏右侧）
- 主区铺满：`flex-1 overflow-hidden`

### 6.3 工具栏分组

```tsx
<Button variant="ghost" size="sm" className="h-8 gap-1.5">...</Button>
<Separator orientation="vertical" className="mx-1 h-5" />
<DropdownMenu>...</DropdownMenu>
```

### 6.4 右侧边栏 Section 规范

**强制规则**：所有页面的右侧边栏（Commander、RTT Viewer、Monitor）必须使用统一的 Section 标题与分割线风格，以 Commander 页 `CommandSidebar` 为基准。

#### Section 结构

每个 Section 是一个带底边的块级容器，最后一个 Section 不带底边：

```tsx
<div className="border-b border-border last:border-b-0">
  {/* Section 标题栏 */}
  <div className="px-2 py-1.5">
    <span className="text-xs font-medium text-muted-foreground">Section 标题</span>
  </div>
  {/* Section 内容 */}
  <div className="space-y-1 p-2 pt-0">
    {/* 控件、配置项... */}
  </div>
</div>
```

#### 标题样式

| 层级 | 类 | 用途 |
|------|----|------|
| Section 标题 | `text-xs font-medium text-muted-foreground` | 主分区标题（如"采样控制"、"接收配置"） |
| 子分组标题 | `text-[11px] font-medium tracking-wide text-muted-foreground/70` | Section 内的子分组（如"调试"） |

#### 分割线规则

- **Section 之间**：使用 `border-b border-border last:border-b-0`，**禁止使用 `<Separator />` 组件**
- **Section 内弱分隔**：`border-b border-border/50 last:border-b-0`（列表项之间）
- **可折叠 Section 标题**：`border-b border-border` + `hover:bg-muted/40 transition-colors`

#### 禁止事项

- 禁止在右侧边栏中使用 `<Separator />` 组件做 Section 分隔（仅工具栏内可用垂直 Separator）
- 禁止使用 `<Label>` 组件做 Section 标题（Label 用于表单字段标签，不用于分区标题）
- 禁止不同页面使用不同的 Section 标题字号/字重/颜色

---

## 7. 组件规范

### 7.1 实际使用的 shadcn/ui 组件

| 组件 | 路径 |
|------|------|
| Button | `src/components/ui/button.tsx` |
| Input | `src/components/ui/input.tsx` |
| Label | `src/components/ui/label.tsx` |
| Select | `src/components/ui/select.tsx` |
| Dialog | `src/components/ui/dialog.tsx` |
| DropdownMenu | `src/components/ui/dropdown-menu.tsx` |
| Card | `src/components/ui/card.tsx` |
| Badge | `src/components/ui/badge.tsx` |
| Progress | `src/components/ui/progress.tsx` |
| Separator | `src/components/ui/separator.tsx` |
| ScrollArea | `src/components/ui/scroll-area.tsx` |

> 注：Textarea、Checkbox、RadioGroup、Tabs、Table、Tooltip 等未封装为 ui 组件，需要时用原生 HTML + Tailwind 实现。

### 7.2 Button 变体

```tsx
// variant
default:     'bg-primary text-primary-foreground hover:bg-primary/90'
destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
outline:     'border border-input bg-background hover:bg-accent'
secondary:   'bg-secondary text-secondary-foreground hover:bg-secondary/80'
ghost:       'hover:bg-accent hover:text-accent-foreground'
link:        'text-primary underline-offset-4 hover:underline'

// size
default: 'h-10 px-4 py-2'
sm:      'h-9 rounded-md px-3'
lg:      'h-11 rounded-md px-8'
icon:    'h-10 w-10'
```

**项目常用自定义尺寸**：
- 工具栏按钮：`variant="ghost" size="sm" className="h-8 gap-1.5"`
- 紧凑图标按钮：`variant="ghost" size="sm" className="h-6 w-6 p-0"`
- 小文字按钮：`className="h-6 gap-1 px-1.5 text-xs"`

> **注意**：Button 基础类未内置 `gap`，图标+文字组合需显式写 `gap-1`/`gap-1.5`/`gap-2`。

### 7.3 Dialog 模式

```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="max-w-md">
    <DialogHeader>
      <DialogTitle>标题</DialogTitle>
      <DialogDescription>描述（可选）</DialogDescription>
    </DialogHeader>
    {/* 表单内容：space-y-2 / space-y-3 */}
    <DialogFooter>
      <Button variant="outline">取消</Button>
      <Button>确认</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**宽度梯度**：
| max-w | 用途 |
|-------|------|
| `max-w-xs` | 极简确认 |
| `max-w-sm` | 单输入弹窗 |
| `max-w-md` | 表单弹窗（默认） |
| `max-w-2xl` | 复杂表格 |
| `max-w-4xl` | 大表格选择 |

### 7.4 可折叠 Section（InfoPanel 模式）

```tsx
<div className="border-b border-border/50 last:border-b-0">
  <button className="flex flex-1 items-center gap-1.5 px-2 py-1.5 hover:bg-muted/30">
    <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
    <span className="text-muted-foreground shrink-0">{icon}</span>
    <span className="text-xs font-medium truncate">{title}</span>
  </button>
  {open && <div className="px-2 pb-1.5 pl-6">{children}</div>}
</div>
```

### 7.5 key-value 行模式

```tsx
<div className="flex justify-between gap-2 py-0.5 text-[11px] leading-tight">
  <span className="text-muted-foreground">{label}</span>
  <span className="font-mono text-right truncate">{value}</span>
</div>
```

### 7.6 空状态

```tsx
<div className="flex flex-1 flex-col items-center justify-center text-muted-foreground gap-2">
  <Icon className="size-8 opacity-40" />
  <span className="text-xs">暂无数据</span>
</div>
```

### 7.7 选中态视觉

- 行选中：`bg-primary/10` 或 `bg-primary/20`
- 卡片选中：`border-primary bg-primary/5`
- tab 选中：`bg-primary/10 text-primary border-primary font-medium`

---

## 8. 通知系统

**强制规则**：所有全局性通知（成功、失败、警告、信息提示）必须使用项目自研的 `useNotificationStore` + `NotificationContainer`，**禁止使用 `sonner` toast 或其他第三方通知库**。

### 8.1 为什么不用 sonner

项目自研通知系统统一管理通知的显示、历史记录、进度更新。使用 sonner toast 会导致：
- 通知不进入历史记录（铃铛无法查看）
- 样式与全局通知卡片不一致
- 无法更新进度（如烧录进度通知）

### 8.2 使用方式

```tsx
import { useNotificationStore } from '@/stores/notification.store'

// 在组件内获取 push 方法
const notify = useNotificationStore((s) => s.push)

// 成功通知
notify({ type: 'success', title: '操作成功', message: '详细描述（可选）' })

// 错误通知
notify({ type: 'error', title: '操作失败', message: e instanceof Error ? e.message : String(e) })

// 警告通知
notify({ type: 'warning', title: '请注意' })

// 信息通知
notify({ type: 'info', title: '提示信息' })

// 进度通知（不会自动关闭）
const id = notify({ type: 'progress', title: '正在烧录...', progress: 0 })
// 更新进度
useNotificationStore.getState().update(id, { progress: 50, message: '擦除中...' })
// 完成
useNotificationStore.getState().update(id, { type: 'success', title: '烧录完成', progress: 100 })
```

### 8.3 通知 API

| 方法 | 用途 |
|------|------|
| `push(n)` | 新增通知，返回 id |
| `update(id, patch)` | 更新通知（类型/进度/消息） |
| `dismiss(id)` | 关闭通知（移入历史） |
| `clear()` | 清空所有活跃通知 |

### 8.4 通知类型与颜色

| 类型 | 左侧条 | 图标 | 自动关闭 |
|------|--------|------|----------|
| info | `border-l-primary` | `Info`（blue-400） | 是 |
| success | `border-l-green-500` | `CheckCircle2`（green-400） | 是 |
| warning | `border-l-yellow-500` | `AlertTriangle`（yellow-400） | 是 |
| error | `border-l-red-500` | `XCircle`（red-400） | 是 |
| progress | `border-l-primary` | `Loader2`（blue-400，animate-spin） | 否 |

### 8.5 通知卡片样式

```tsx
<div className="w-80 rounded-md border border-border border-l-4 bg-popover p-3 shadow-lg
  animate-in slide-in-from-right-5 fade-in duration-300">
  {/* border-l-primary / border-l-green-500 / border-l-yellow-500 / border-l-red-500 */}
</div>
```

---

## 9. 动画与过渡

| 类 | 用途 |
|----|------|
| `transition-colors` | 所有 hover 态颜色过渡（最常用） |
| `transition-transform` | 折叠箭头旋转 |
| `transition-opacity` | 显隐过渡 |
| `animate-spin` | 加载图标 |
| `animate-pulse` | loading 点 |
| `animate-in slide-in-from-*` | 通知入场动画 |

---

## 10. 工具函数

### 10.1 `cn()` 

路径：`src/lib/utils.ts`，标准 `twMerge(clsx(inputs))`。

**规则**：所有条件 className 必须用 `cn()` 合并，不允许模板字符串拼接。

```tsx
// ✅ 正确
<div className={cn('base classes', isActive && 'active classes', className)} />

// ❌ 错误
<div className={`base classes ${isActive ? 'active' : ''}`} />
```

### 10.2 十六进制格式化

```tsx
formatHex(0x08000000)  // "0x08000000"
formatSize(1024 * 1024)  // "1.00 MB"
formatSize(1024)  // "1.0 KB"
```

---

## 11. 检查清单

新增 UI 组件时，对照以下清单：

- [ ] 语义色使用 token（`bg-primary`、`text-muted-foreground`），状态色允许硬编码
- [ ] 圆角与同层级面板统一（面板用直角，交互元素用 `rounded-md`）
- [ ] 边框用 `border-border`，分区用单方向 border
- [ ] 图标用 `size-*` 简写
- [ ] 条件 className 用 `cn()` 合并
- [ ] flex 布局需要滚动区域时加 `min-h-0`
- [ ] 字号：正文 `text-sm`，辅助 `text-xs`，标题 `text-lg font-semibold`
- [ ] Button 图标+文字组合显式写 `gap-1.5`
- [ ] hover 态加 `transition-colors`
- [ ] 空状态用 `text-muted-foreground` + `opacity-40` 图标
- [ ] 右侧边栏 Section 使用 `border-b border-border` 分隔，禁止 `<Separator />` 和 `<Label>` 做标题（见 6.4）
