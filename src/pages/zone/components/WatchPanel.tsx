import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Eye,
  Plus,
  Trash2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Search,
  X,
  Columns2,
  ArrowRight,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  zoneWatchEval,
  zoneWatchSet,
  type WatchEvalInfo,
  type CallStackLocal,
} from '@/services/zone.service'
import { useZoneStore, type WatchItem, type WatchTab } from '../store'
import { useSessionReady, useAutoRefresh } from '../hooks'
import { cn } from '@/lib/utils'

interface WatchPanelProps {
  uid: string | null
  connected: boolean
  /** 在内存中查看：创建内存窗口并切换到 Memory 页签 */
  onShowMemory?: (address: number) => void
}

/** 观察项运行时值（持久化定义 + 运行时求值结果） */
interface WatchValue {
  id: number
  expr: string
  info: WatchEvalInfo | null
  state: 'disconnected' | 'running' | 'halted' | 'unknown'
  loading: boolean
}

/** 值显示格式 */
type WatchFormat = 'hex' | 'dec' | 'bin' | 'char' | 'str' | 'float'

/** 四列列宽（px），表头拖拽调节 */
type ColKey = 'address' | 'name' | 'value' | 'type'
const COL_MIN = 80
const MAX_TABS = 4

// ── 工具函数 ──────────────────────────────

function fmtAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

function fmtValue(v: number | null | undefined, bitSize?: number): string {
  if (v == null) return '—'
  const bits = bitSize && bitSize > 0 ? bitSize : 32
  const digits = Math.max(1, Math.ceil(bits / 4))
  return `0x${v.toString(16).toUpperCase().padStart(digits, '0')}`
}

/** 解析用户输入的值：支持 0x 十六进制 / 0b 二进制 / 0 前缀八进制 / 十进制 */
function parseValue(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  try {
    if (/^0x/i.test(t)) return parseInt(t.slice(2), 16)
    if (/^0b/i.test(t)) return parseInt(t.slice(2), 2)
    if (/^0[0-7]+$/.test(t)) return parseInt(t, 8)
    return parseInt(t, 10)
  } catch {
    return null
  }
}

function fmtValueByFormat(v: number | null | undefined, bitSize: number | undefined, format: WatchFormat): string {
  if (v == null) return '—'
  switch (format) {
    case 'hex':
      return fmtValue(v, bitSize)
    case 'dec':
      return String(v)
    case 'bin':
      return `0b${v.toString(2)}`
    case 'char': {
      if (v >= 0x20 && v <= 0x7e) return `'${String.fromCharCode(v)}'`
      return fmtValue(v, bitSize)
    }
    case 'str':
    case 'float':
      // 字符串/浮点由上层 nodeValue 优先处理，此处回退十六进制
      return fmtValue(v, bitSize)
  }
}

/** 字符串值显示：可打印则加引号，含不可见字符时转义 */
function fmtString(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x22) out += '\\"'
    else if (code === 0x5c) out += '\\\\'
    else if (code === 0x09) out += '\\t'
    else if (code === 0x0a) out += '\\n'
    else if (code === 0x0d) out += '\\r'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return `"${out}"`
}

/** 节点值显示：优先按格式（str/float），否则回退十六进制 */
function nodeValue(n: CallStackLocal, format: WatchFormat): string {
  if (format === 'str' && n.str_value != null) return fmtString(n.str_value)
  if (format === 'float' && n.float_value != null) return String(n.float_value)
  if (n.kind === 'struct' || n.kind === 'array') {
    return n.address != null ? fmtAddr(n.address) : '不可用'
  }
  if (n.kind === 'pointer') {
    return n.available ? fmtAddr(n.value ?? 0) : '不可用'
  }
  return n.available ? fmtValueByFormat(n.value, n.bit_size, format) : '不可用'
}

function valueText(info: WatchEvalInfo | null): string {
  if (!info) return '—'
  if (!info.available) return '不可用'
  if (info.kind === 'register') return fmtValue(info.value, 32)
  if (info.kind === 'function') return info.address != null ? fmtAddr(info.address) : '—'
  // variable
  if (info.var_kind === 'struct' || info.var_kind === 'array') {
    return info.address != null ? fmtAddr(info.address) : '不可用'
  }
  if (info.var_kind === 'pointer') {
    return info.available ? fmtAddr(info.value ?? 0) : '不可用'
  }
  return info.available ? fmtValue(info.value, info.bit_size) : '不可用'
}

/** 顶层观察项按格式显示：str/float 优先，标量按所选格式，结构体/数组/指针显示地址 */
function watchValueText(v: WatchValue, fmt: WatchFormat): string {
  const info = v.info
  if (!info) return '—'
  if (fmt === 'str' && info.str_value != null) return fmtString(info.str_value)
  if (fmt === 'float' && info.float_value != null) return String(info.float_value)
  if (!info.available) return '不可用'
  if (info.kind === 'register') return fmtValueByFormat(info.value, 32, fmt)
  if (info.kind === 'function') return info.address != null ? fmtAddr(info.address) : '—'
  if (info.var_kind === 'struct' || info.var_kind === 'array') {
    return info.address != null ? fmtAddr(info.address) : '不可用'
  }
  if (info.var_kind === 'pointer') {
    return info.available ? fmtAddr(info.value ?? 0) : '不可用'
  }
  return info.available ? fmtValueByFormat(info.value, info.bit_size, fmt) : '不可用'
}

function kindLabel(info: WatchEvalInfo | null): string {
  if (!info) return '?'
  if (info.kind === 'register') return '寄存器'
  if (info.kind === 'function') {
    // 与源码 hover 一致：显示函数签名（如 void f(void)）
    return info.signature ? `函数 [${info.signature}]` : '函数'
  }
  if (info.kind === 'variable') {
    const prefix = info.var_kind ? `${info.var_kind} ` : ''
    return `${prefix}${info.type || '变量'}`
  }
  return '?'
}

function hasChildren(info: WatchEvalInfo | null): boolean {
  return !!(info?.children && info.children.length > 0)
}

// ── 递归子节点渲染（四列：Name / Value / Type / Address） ──

/** 变化高亮：本次刷新中值发生变化的变量高亮显示，未变化的不高亮 */
function changeClass(level: number | undefined): string {
  if (!level) return ''
  return 'bg-yellow-400/40 text-foreground'
}

interface VarNodeProps {
  node: CallStackLocal
  path: string
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  changed: Map<string, number>
  format: WatchFormat
  colWidths: Record<ColKey, number>
  /** 右键菜单：在内存中查看 */
  onContextMenu?: (e: React.MouseEvent, node: CallStackLocal) => void
}

function VarNode({ node, path, depth, expanded, onToggle, changed, format, colWidths, onContextMenu }: VarNodeProps) {
  const hasCh = node.children && node.children.length > 0
  const open = expanded.has(path)
  const indent = Math.min(depth, 8) * 12 + 12
  const level = changed.get(path)
  const isChanged = !!level
  return (
    <>
      <div
        className="flex border-t border-border/30 bg-muted/20 text-xs"
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, node) : undefined}
      >
        <span
          className="min-w-0 truncate py-1 pr-2 text-left font-mono text-foreground/90"
          style={{ width: colWidths.name, paddingLeft: indent }}
        >
          {hasCh ? (
            <button
              onClick={() => onToggle(path)}
              className="mr-0.5 inline-flex shrink-0 items-center align-middle text-muted-foreground hover:text-foreground"
              title={open ? '折叠' : '展开'}
            >
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          ) : (
            <span className="mr-1.5 inline-block w-3 shrink-0" />
          )}
          {node.name}
        </span>
        <span
          className={cn(
            'min-w-0 truncate border-l border-border/30 px-2 py-1 text-left font-mono',
            isChanged ? changeClass(level) : 'text-muted-foreground'
          )}
          style={{ width: colWidths.value }}
          title={node.address != null ? `地址: ${fmtAddr(node.address)}` : undefined}
        >
          {nodeValue(node, format)}
        </span>
        <span
          className="min-w-0 truncate border-l border-border/30 px-2 py-1 text-left text-muted-foreground"
          style={{ width: colWidths.type }}
        >
          {nodeType(node)}
        </span>
        <span
          className="min-w-0 truncate border-l border-border/30 px-2 py-1 text-left font-mono text-muted-foreground/80"
          style={{ width: colWidths.address }}
        >
          {node.address != null ? fmtAddr(node.address) : '—'}
        </span>
      </div>
      {hasCh && open
        ? node.children!.map((c, ci) => (
            <VarNode
              key={`${path}-${ci}`}
              node={c}
              path={`${path}-${ci}`}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              changed={changed}
              format={format}
              colWidths={colWidths}
              onContextMenu={onContextMenu}
            />
          ))
        : null}
    </>
  )
}

function nodeType(n: CallStackLocal): string {
  const prefix = n.is_param ? 'param' : ''
  if (n.kind === 'struct') return `${prefix} struct`
  if (n.kind === 'array') return `${prefix} array`
  if (n.kind === 'pointer') return `${prefix} ${n.type || '?'}*`
  return `${prefix} ${n.type || '?'}`
}

// ── 值文本收集（用于对比变化） ──

/** 顶层观察项变化签名：字符串/浮点优先，否则十六进制值 */
function infoChangeText(info: WatchEvalInfo | null): string {
  if (!info) return '—'
  if (info.str_value != null) return `str:${info.str_value}`
  if (info.float_value != null) return `float:${info.float_value}`
  return valueText(info)
}

/** 子节点变化签名：字符串/浮点优先，否则十六进制值 */
function nodeChangeText(n: CallStackLocal): string {
  if (n.str_value != null) return `str:${n.str_value}`
  if (n.float_value != null) return `float:${n.float_value}`
  return nodeValue(n, 'hex')
}

function collectValueTexts(values: WatchValue[], out: Map<string, string>) {
  for (const v of values) {
    out.set(`expr-${v.id}`, infoChangeText(v.info))
    collectChildrenTexts(v.info?.children, `expr-${v.id}`, out)
  }
}

function collectChildrenTexts(children: CallStackLocal[] | undefined, prefix: string, out: Map<string, string>) {
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const key = `${prefix}-${i}`
    out.set(key, nodeChangeText(children[i]))
    collectChildrenTexts(children[i].children, key, out)
  }
}

/** 与上一帧快照对比，返回本次刷新中值发生变化的 key → 1（未变化的不在结果中） */
function computeChangedKeys(current: Map<string, string>, prev: Map<string, string>): Map<string, number> {
  const changed = new Map<string, number>()
  current.forEach((val, key) => {
    const before = prev.get(key)
    if (before !== undefined && before !== val) {
      changed.set(key, 1)
    }
  })
  return changed
}

const FORMAT_OPTIONS: [WatchFormat, string][] = [
  ['hex', '十六进制'],
  ['dec', '十进制'],
  ['bin', '二进制'],
  ['char', '字符'],
  ['str', '字符串'],
  ['float', '浮点'],
]

/** 右键菜单状态：顶层观察项（itemId+format）或子节点（address） */
interface CtxMenuState {
  x: number
  y: number
  itemId?: number
  format?: WatchFormat
  address?: number
  name: string
}

// ── 单栏列表（表头 + 行 + 右键菜单），供单栏/分栏复用 ──

interface WatchListProps {
  /** 该列渲染的页签 id */
  currentTabId: string
  items: WatchItem[]
  values: WatchValue[]
  colWidths: Record<ColKey, number>
  onResizeCol: (col: ColKey, width: number) => void
  expanded: Set<string>
  onToggle: (path: string) => void
  changed: Map<string, number>
  searchQuery: string
  tabs: WatchTab[]
  onRemove: (tabId: string, id: number) => void
  onSetFormat: (tabId: string, id: number, format: WatchFormat) => void
  onShowMemory: (address: number) => void
  onMoveToTab: (itemId: number, toTabId: string) => void
  onCommitEdit: (v: WatchValue, value: number) => Promise<void>
  ready: boolean
  emptyText: string
}

function WatchList({
  currentTabId,
  items,
  values,
  colWidths,
  onResizeCol,
  expanded,
  onToggle,
  changed,
  searchQuery,
  tabs,
  onRemove,
  onSetFormat,
  onShowMemory,
  onMoveToTab,
  onCommitEdit,
  ready,
  emptyText,
}: WatchListProps) {
  // ── 值编辑 ──
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  // ── 右键菜单 ──
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  // 菜单贴底/贴右时自动回移，避免超出视口显示不全
  useLayoutEffect(() => {
    if (!ctxMenu || !ctxMenuRef.current) return
    const menu = ctxMenuRef.current
    const rect = menu.getBoundingClientRect()
    const MARGIN = 8
    let left = rect.left
    let top = rect.top
    if (rect.right > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN)
    }
    if (rect.bottom > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN)
    }
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [ctxMenu])

  // 点击其他区域 / 滚动时关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])

  // ── 表头拖拽调节列宽 ──
  const startResize = useCallback(
    (col: ColKey) => (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startW = colWidths[col]
      const onMove = (ev: MouseEvent) => {
        onResizeCol(col, Math.max(COL_MIN, startW + (ev.clientX - startX)))
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [colWidths, onResizeCol]
  )

  // ── 搜索过滤 ──
  const filteredValues = useMemo(() => {
    if (!searchQuery) return values
    const q = searchQuery.toLowerCase()
    return values.filter((v) => {
      if (v.expr.toLowerCase().includes(q)) return true
      const info = v.info
      if (info?.str_value && info.str_value.toLowerCase().includes(q)) return true
      if (info?.float_value != null && String(info.float_value).includes(q)) return true
      const t = valueText(info)
      if (t !== '—' && t.toLowerCase().includes(q)) return true
      if (kindLabel(info).toLowerCase().includes(q)) return true
      return false
    })
  }, [values, searchQuery])

  // ── 值编辑 ──
  const isEditable = useCallback((info: WatchEvalInfo | null, st: WatchValue['state']): boolean => {
    if (!info || !info.available) return false
    if (st !== 'halted') return false
    if (info.kind === 'function') return false
    if (info.var_kind === 'struct' || info.var_kind === 'array') return false
    return true
  }, [])

  const handleCommit = useCallback(
    async (v: WatchValue, value: number) => {
      setEditError(null)
      try {
        await onCommitEdit(v, value)
        setEditing(null)
      } catch (e) {
        setEditError(e instanceof Error ? e.message : '写入失败')
        setEditing(null)
      }
    },
    [onCommitEdit]
  )

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent, v: WatchValue) => {
      if (e.key === 'Enter') {
        const parsed = parseValue(editing?.value ?? '')
        if (parsed != null) void handleCommit(v, parsed)
        else setEditError('无效数值（支持 0x / 0b / 十进制）')
      } else if (e.key === 'Escape') {
        setEditing(null)
        setEditError(null)
      }
    },
    [editing, handleCommit]
  )

  // ── 渲染表头（四列，可拖拽调宽，左对齐） ──
  const renderHeader = () => (
    <div className="flex shrink-0 border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
      <div className="relative flex items-center justify-start px-2 py-1 font-medium" style={{ width: colWidths.name }}>
        <span>Name</span>
        <div
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent"
          onMouseDown={startResize('name')}
          title="拖拽调节列宽"
        />
      </div>
      <div className="relative flex items-center justify-start border-l border-border px-2 py-1 font-medium" style={{ width: colWidths.value }}>
        <span>Value</span>
        <div
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent"
          onMouseDown={startResize('value')}
          title="拖拽调节列宽"
        />
      </div>
      <div className="relative flex items-center justify-start border-l border-border px-2 py-1 font-medium" style={{ width: colWidths.type }}>
        <span>Type</span>
        <div
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent"
          onMouseDown={startResize('type')}
          title="拖拽调节列宽"
        />
      </div>
      <div className="relative flex items-center justify-start border-l border-border px-2 py-1 font-medium" style={{ width: colWidths.address }}>
        <span>Address</span>
        <div
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent"
          onMouseDown={startResize('address')}
          title="拖拽调节列宽"
        />
      </div>
    </div>
  )

  // ── 渲染行 ──
  const renderRows = () =>
    filteredValues.map((v) => {
      const item = items.find((w) => w.id === v.id)
      const fmt = item?.format ?? 'hex'
      const isChanged = changed.has(`expr-${v.id}`)
      const hasCh = hasChildren(v.info)
      const open = expanded.has(`expr-${v.id}`)
      return (
        <div key={v.id}>
          <div
            className="flex border-b border-border/50 hover:bg-muted/30"
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu({ x: e.clientX, y: e.clientY, itemId: v.id, format: fmt, address: v.info?.address, name: v.expr })
            }}
          >
            {/* Name 列 */}
            <span className="flex min-w-0 items-center justify-start gap-1 px-2 py-1 font-mono text-xs" style={{ width: colWidths.name }}>
              {hasCh ? (
                <button
                  onClick={() => onToggle(`expr-${v.id}`)}
                  className="mr-0.5 inline-flex shrink-0 items-center align-middle text-muted-foreground hover:text-foreground"
                  title={open ? '折叠' : '展开'}
                >
                  {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                </button>
              ) : (
                <span className="mr-1.5 inline-block w-3 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{v.expr}</span>
            </span>
            {/* Value 列 */}
            <span
              className={cn(
                'min-w-0 truncate border-l border-border/30 px-2 py-1 text-left font-mono text-xs',
                isChanged ? changeClass(changed.get(`expr-${v.id}`)) : 'text-primary'
              )}
              style={{ width: colWidths.value }}
              title={v.info?.address != null ? `地址: ${fmtAddr(v.info.address)}` : undefined}
            >
              {editing?.id === v.id ? (
                <Input
                  autoFocus
                  value={editing.value}
                  onChange={(e) => setEditing({ id: v.id, value: e.target.value })}
                  onKeyDown={(e) => handleEditKeyDown(e, v)}
                  onBlur={() => {
                    setEditing(null)
                    setEditError(null)
                  }}
                  className="h-6 w-full min-w-24 px-1 text-xs font-mono"
                  title="Enter 提交，Esc 取消"
                />
              ) : (
                <button
                  className={cn(
                    'w-full truncate text-left font-mono',
                    isEditable(v.info, v.state) && 'cursor-text hover:bg-accent/40'
                  )}
                  onClick={() => {
                    if (!isEditable(v.info, v.state)) return
                    setEditing({ id: v.id, value: valueText(v.info) })
                    setEditError(null)
                  }}
                  title={isEditable(v.info, v.state) ? '点击编辑值' : undefined}
                >
                  {v.loading ? '...' : watchValueText(v, fmt)}
                </button>
              )}
            </span>
            {/* Type 列 */}
            <span
              className="min-w-0 truncate border-l border-border/30 px-2 py-1 text-left text-xs text-muted-foreground"
              style={{ width: colWidths.type }}
            >
              {kindLabel(v.info)}
            </span>
            {/* Address 列 */}
            <span
              className="min-w-0 truncate border-l border-border/30 px-2 py-1 text-left font-mono text-xs text-muted-foreground"
              style={{ width: colWidths.address }}
            >
              {v.info?.address != null ? fmtAddr(v.info.address) : '—'}
            </span>
          </div>
          {/* 子节点展开 */}
          {open && v.info?.children
            ? v.info.children.map((c, ci) => (
                <VarNode
                  key={`expr-${v.id}-${ci}`}
                  node={c}
                  path={`expr-${v.id}-${ci}`}
                  depth={1}
                  expanded={expanded}
                  onToggle={onToggle}
                  changed={changed}
                  format={fmt}
                  colWidths={colWidths}
                  onContextMenu={(e, node) => {
                    e.preventDefault()
                    if (node.address == null) return
                    setCtxMenu({ x: e.clientX, y: e.clientY, address: node.address, name: node.name })
                  }}
                />
              ))
            : null}
        </div>
      )
    })

  return (
    <div className="flex h-full min-h-0 flex-col">
      {items.length > 0 && renderHeader()}
      <div className="min-h-0 flex-1 overflow-auto">
        {!ready ? null : items.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
            {emptyText}
          </div>
        ) : filteredValues.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
            无匹配项
          </div>
        ) : (
          renderRows()
        )}
      </div>

      {/* 值编辑错误提示 */}
      {editError && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-red-500/10 px-2 py-1 text-xs text-red-500">
          <AlertCircle className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{editError}</span>
          <button className="rounded p-0.5 hover:bg-accent" onClick={() => setEditError(null)}>
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* 右键菜单：格式 / 在内存中查看 / 移动到 / 删除 */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="fixed z-50 min-w-36 rounded-md border border-border bg-popover p-1 shadow-md"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.itemId != null && (
            <>
              {FORMAT_OPTIONS.map(([key, label]) => (
                <button
                  key={key}
                  className="flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() => {
                    onSetFormat(currentTabId, ctxMenu.itemId!, key)
                    setCtxMenu(null)
                  }}
                >
                  <span>{label}</span>
                  {ctxMenu.format === key && <span className="text-primary">✓</span>}
                </button>
              ))}
              <div className="my-1 h-px bg-border" />
            </>
          )}
          {ctxMenu.address != null && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => {
                onShowMemory(ctxMenu.address!)
                setCtxMenu(null)
              }}
            >
              <Eye className="size-3.5" />
              在内存中查看 {ctxMenu.name ? `(${ctxMenu.name})` : ''}
            </button>
          )}
          {ctxMenu.itemId != null && tabs.length > 1 && (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">移动到</div>
              {tabs
                .filter((t) => t.id !== currentTabId)
                .map((t) => (
                  <button
                    key={t.id}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={() => {
                      onMoveToTab(ctxMenu.itemId!, t.id)
                      setCtxMenu(null)
                    }}
                  >
                    <ArrowRight className="size-3.5" />
                    {t.name}
                  </button>
                ))}
            </>
          )}
          {ctxMenu.itemId != null && (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-red-500 hover:bg-accent"
                onClick={() => {
                  onRemove(currentTabId, ctxMenu.itemId!)
                  setCtxMenu(null)
                }}
              >
                <Trash2 className="size-3.5" />
                删除
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── 组件 ──

export function WatchPanel({ uid, connected, onShowMemory }: WatchPanelProps) {
  const watchTabs = useZoneStore((s) => s.watchTabs)
  const activeWatchTab = useZoneStore((s) => s.activeWatchTab)
  const addWatchItemToTab = useZoneStore((s) => s.addWatchItemToTab)
  const addWatchTab = useZoneStore((s) => s.addWatchTab)
  const closeWatchTab = useZoneStore((s) => s.closeWatchTab)
  const selectWatchTab = useZoneStore((s) => s.selectWatchTab)
  const moveWatchItemToTab = useZoneStore((s) => s.moveWatchItemToTab)
  const removeWatchItem = useZoneStore((s) => s.removeWatchItem)
  const setWatchItemFormat = useZoneStore((s) => s.setWatchItemFormat)
  const clearWatchItems = useZoneStore((s) => s.clearWatchItems)
  const addMemoryWindow = useZoneStore((s) => s.addMemoryWindow)
  const { ready } = useSessionReady(uid, connected)

  // ── Watch 输入 ──
  const [input, setInput] = useState('')
  const [values, setValues] = useState<WatchValue[]>([])
  // 上次求值结果快照：目标运行中局部变量/寄存器不可读时，保留上次值而非显示"运行中"
  const valuesRef = useRef<WatchValue[]>([])
  useEffect(() => {
    valuesRef.current = values
  }, [values])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [changed, setChanged] = useState<Map<string, number>>(new Map())
  /** 上一帧值快照：与当前值对比检测变化 */
  const prevSnapshotRef = useRef<Map<string, string>>(new Map())

  // ── 搜索过滤 ──
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // ── 四列列宽（表头拖拽调节） ──
  const [colWidths, setColWidths] = useState<Record<ColKey, number>>({ address: 96, name: 200, value: 160, type: 140 })

  // ── 分栏对比 ──
  const [split, setSplit] = useState(false)
  const [leftTabId, setLeftTabId] = useState(activeWatchTab)
  const [rightTabId, setRightTabId] = useState<string | null>(null)

  const allItems = useMemo(() => watchTabs.flatMap((t) => t.items), [watchTabs])

  // 分栏有效 id（页签被关闭时自动回退）
  const validLeftId = watchTabs.some((t) => t.id === leftTabId) ? leftTabId : activeWatchTab
  const validRightId =
    rightTabId && watchTabs.some((t) => t.id === rightTabId) && rightTabId !== validLeftId
      ? rightTabId
      : (watchTabs.find((t) => t.id !== validLeftId)?.id ?? null)

  // ── 同步全部页签 items → values ──
  useEffect(() => {
    setValues((prev) => {
      const existing = new Map(prev.map((v) => [v.id, v]))
      const next: WatchValue[] = []
      for (const item of allItems) {
        const e = existing.get(item.id)
        if (e) {
          next.push(e)
        } else {
          next.push({ id: item.id, expr: item.expr, info: null, state: 'unknown', loading: false })
        }
      }
      return next
    })
  }, [allItems])

  // ── Watch 批量求值 ──
  const refresh = useCallback(async () => {
    if (!ready || !uid) return
    if (allItems.length === 0) return
    setLoading(true)
    try {
      const updated: WatchValue[] = await Promise.all(
        allItems.map(async (item): Promise<WatchValue> => {
          try {
            const res = await zoneWatchEval(uid, item.expr)
            const info = res.info ?? null
            const st = (res.state ?? 'unknown') as WatchValue['state']
            // 目标运行中且该项不可读（局部变量/寄存器运行中无法读取）：
            // 保留上次的值，避免显示"运行中"占位；全局变量运行中可读，正常实时刷新
            if (st === 'running' && info && !info.available) {
              const prev = valuesRef.current.find((v) => v.id === item.id)
              if (prev && prev.info?.available) {
                return { ...prev, state: st, loading: false }
              }
            }
            return { id: item.id, expr: item.expr, info, state: st, loading: false }
          } catch {
            return { id: item.id, expr: item.expr, info: null, state: 'unknown' as const, loading: false }
          }
        })
      )
      const current = new Map<string, string>()
      collectValueTexts(updated, current)
      // 与上一帧对比：值变化的变量高亮，未变化的立即取消高亮
      const changedKeys = computeChangedKeys(current, prevSnapshotRef.current)
      prevSnapshotRef.current = current
      setChanged(changedKeys)
      setValues(updated)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }, [ready, uid, allItems])

  // ── 自动刷新（由 store refreshMode 驱动：on_stop 暂停时刷新 / periodic 周期刷新） ──
  useAutoRefresh(uid, connected, ready, refresh)

  // ── 展开/折叠 ──
  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    const all = new Set<string>()
    const collect = (items: WatchValue[], prefix: string) => {
      for (const v of items) {
        const key = `${prefix}-${v.id}`
        all.add(key)
        collectChildren(v.info?.children, key, all)
      }
    }
    const collectChildren = (children: CallStackLocal[] | undefined, prefix: string, all: Set<string>) => {
      if (!children) return
      for (let i = 0; i < children.length; i++) {
        const key = `${prefix}-${i}`
        all.add(key)
        collectChildren(children[i].children, key, all)
      }
    }
    collect(values, 'expr')
    setExpanded(all)
  }, [values])

  const collapseAll = useCallback(() => {
    setExpanded(new Set())
  }, [])

  // ── 添加 Watch 项：Enter 添加到当前页签，+ 按钮展开页签选择 ──
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)

  // 点击其他区域关闭添加菜单
  useEffect(() => {
    if (!addMenuOpen) return
    const close = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [addMenuOpen])

  const addToTab = useCallback(
    (tabId: string) => {
      const trimmed = input.trim()
      if (!trimmed) return
      addWatchItemToTab(tabId, trimmed)
      setInput('')
      setAddMenuOpen(false)
    },
    [input, addWatchItemToTab]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') addToTab(activeWatchTab)
    },
    [addToTab, activeWatchTab]
  )

  // ── 值编辑提交（父级：写入 + 刷新；失败抛错由 WatchList 展示） ──
  const commitEdit = useCallback(
    async (v: WatchValue, value: number) => {
      const info = v.info
      if (!info || !uid) return
      if (info.kind === 'register') {
        await zoneWatchSet(uid, { target: 'register', name: info.name, value })
      } else if (info.address != null) {
        const size = Math.max(1, Math.min(8, Math.ceil((info.bit_size ?? 32) / 8)))
        await zoneWatchSet(uid, { target: 'address', address: info.address, size, value })
      } else {
        throw new Error('该观察项不可编辑')
      }
      void refresh()
    },
    [uid, refresh]
  )

  // ── 在内存中查看：创建内存窗口定位到地址，并切换到 Memory 页签 ──
  const showInMemory = useCallback(
    (address: number) => {
      if (address == null) return
      addMemoryWindow({ address: fmtAddr(address) })
      onShowMemory?.(address)
    },
    [addMemoryWindow, onShowMemory]
  )

  // ── 分栏切换 ──
  const toggleSplit = useCallback(() => {
    if (split) {
      setSplit(false)
    } else {
      setLeftTabId(activeWatchTab)
      const others = watchTabs.filter((t) => t.id !== activeWatchTab)
      setRightTabId(others[0]?.id ?? null)
      setSplit(true)
    }
  }, [split, activeWatchTab, watchTabs])

  // ── 按页签取 items / values ──
  const itemsForTab = useCallback(
    (tabId: string): WatchItem[] => {
      const tab = watchTabs.find((t) => t.id === tabId)
      return tab?.items ?? []
    },
    [watchTabs]
  )

  const valuesForTab = useCallback(
    (tabId: string): WatchValue[] => {
      const ids = new Set(itemsForTab(tabId).map((i) => i.id))
      return values.filter((v) => ids.has(v.id))
    },
    [values, itemsForTab]
  )

  // ── 分栏列页签选择器 ──
  const renderColumnSelector = (tabId: string, onChange: (id: string) => void) => (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <Columns2 className="size-3 shrink-0 text-muted-foreground" />
      <select
        value={tabId}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs"
      >
        {watchTabs.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  )

  const listProps = {
    colWidths,
    onResizeCol: (col: ColKey, width: number) => setColWidths((s) => ({ ...s, [col]: width })),
    expanded,
    onToggle: toggleExpand,
    changed,
    searchQuery,
    tabs: watchTabs,
    onRemove: removeWatchItem,
    onSetFormat: setWatchItemFormat,
    onShowMemory: showInMemory,
    onMoveToTab: moveWatchItemToTab,
    onCommitEdit: commitEdit,
    ready,
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 输入行 + 操作按钮（Enter 添加到当前页签，+ 按钮展开页签选择） */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="变量、寄存器或表达式，Enter 添加到当前页签"
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <div ref={addMenuRef} className="relative shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            onClick={() => setAddMenuOpen((v) => !v)}
            title="选择目标页签添加"
          >
            <Plus className="size-3.5" />
          </Button>
          {addMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-36 rounded-md border border-border bg-popover p-1 shadow-md">
              {watchTabs.map((t) => (
                <button
                  key={t.id}
                  className="flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() => addToTab(t.id)}
                >
                  <span>{t.name}</span>
                  {t.id === activeWatchTab && <span className="text-[10px] text-muted-foreground">当前</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {values.length > 0 && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              onClick={expandAll}
              title="全部展开"
            >
              <ChevronsDownUp className="size-3.5" />
            </button>
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              onClick={collapseAll}
              title="全部折叠"
            >
              <ChevronsUpDown className="size-3.5" />
            </button>
            <button
              className={cn('rounded p-1 text-muted-foreground hover:bg-accent', showSearch && 'bg-accent')}
              onClick={() => {
                setShowSearch((v) => !v)
                if (showSearch) setSearchQuery('')
              }}
              title="搜索过滤"
            >
              <Search className="size-3.5" />
            </button>
            <button
              className={cn(
                'rounded p-1 text-muted-foreground hover:bg-accent',
                split && 'bg-accent',
                watchTabs.length < 2 && 'cursor-not-allowed opacity-40'
              )}
              onClick={toggleSplit}
              disabled={watchTabs.length < 2}
              title={watchTabs.length < 2 ? '需要至少 2 个页签才能分栏对比' : '分栏对比查看'}
            >
              <Columns2 className="size-3.5" />
            </button>
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              onClick={() => clearWatchItems(split ? validLeftId : undefined)}
              title="清空当前页签"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* 页签栏（单栏模式显示，位于输入框下方） */}
      {!split && (
        <div className="flex shrink-0 items-center border-b border-border">
          {watchTabs.map((t) => {
            const isActive = t.id === activeWatchTab
            return (
              <div
                key={t.id}
                className={cn(
                  'group/tab flex items-center gap-1 border-r border-border px-2 py-1 text-xs',
                  isActive ? 'bg-muted/40 text-foreground' : 'text-muted-foreground hover:bg-muted/20'
                )}
              >
                <button onClick={() => selectWatchTab(t.id)} className="font-medium" title="切换页签">
                  {t.name}
                </button>
                {watchTabs.length > 1 && watchTabs[0].id !== t.id ? (
                  <button
                    onClick={() => closeWatchTab(t.id)}
                    className="flex size-3 shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/tab:opacity-100 hover:text-red-500"
                    title="关闭页签"
                  >
                    <X className="size-3" />
                  </button>
                ) : (
                  // 首个页签不可关闭，用等宽占位保持与其余页签宽度一致
                  <span className="flex size-3 shrink-0" aria-hidden />
                )}
              </div>
            )
          })}
          {watchTabs.length < MAX_TABS && (
            <button
              onClick={addWatchTab}
              className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/20 hover:text-foreground"
              title={`新建页签（上限 ${MAX_TABS}）`}
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {/* 搜索过滤输入 */}
      {showSearch && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="过滤表达式、值或类型..."
            className="h-7 text-xs"
          />
          {searchQuery && (
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-accent"
              onClick={() => setSearchQuery('')}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      )}

      {/* 读取错误提示 */}
      {error && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-red-500/10 px-2 py-1 text-xs text-red-500">
          <AlertCircle className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button className="rounded p-0.5 hover:bg-accent" onClick={() => setError(null)}>
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* 列表体：单栏或分栏 */}
      <div className="min-h-0 flex-1">
        {!ready ? (
          <div className="min-h-0 flex-1" />
        ) : split ? (
          <div className="flex h-full min-h-0">
            <div className="flex min-w-0 flex-1 flex-col border-r border-border">
              {renderColumnSelector(validLeftId, setLeftTabId)}
              <WatchList
                {...listProps}
                currentTabId={validLeftId}
                items={itemsForTab(validLeftId)}
                values={valuesForTab(validLeftId)}
                emptyText="添加变量、寄存器、表达式或 0x 地址进行观察"
              />
            </div>
            {validRightId && (
              <div className="flex min-w-0 flex-1 flex-col">
                {renderColumnSelector(validRightId, setRightTabId)}
                <WatchList
                  {...listProps}
                  currentTabId={validRightId}
                  items={itemsForTab(validRightId)}
                  values={valuesForTab(validRightId)}
                  emptyText="添加变量、寄存器、表达式或 0x 地址进行观察"
                />
              </div>
            )}
          </div>
        ) : (
          <WatchList
            {...listProps}
            currentTabId={activeWatchTab}
            items={itemsForTab(activeWatchTab)}
            values={valuesForTab(activeWatchTab)}
            emptyText="添加变量、寄存器、表达式或 0x 地址进行观察"
          />
        )}
      </div>
    </div>
  )
}
