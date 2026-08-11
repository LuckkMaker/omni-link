import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, AlertCircle, ChevronRight, ChevronDown } from 'lucide-react'
import { zoneStack, type CallStackFrame, type CallStackLocal } from '@/services/zone.service'
import { useZoneStore } from '../store'

interface CallStackPanelProps {
  uid: string | null
  connected: boolean
}

function fmtAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/** 变量数值格式化：按位宽补齐十六进制位数（未知位宽默认 32bit） */
function fmtValue(v: number | null | undefined, bitSize?: number): string {
  if (v == null) return '—'
  const bits = bitSize && bitSize > 0 ? bitSize : 32
  const digits = Math.max(1, Math.ceil(bits / 4))
  return `0x${v.toString(16).toUpperCase().padStart(digits, '0')}`
}

/** 变量节点值显示：结构体/数组/指针显示地址，标量显示数值 */
function valueText(v: CallStackLocal): string {
  if (v.kind === 'struct' || v.kind === 'array') {
    return v.address != null ? fmtAddr(v.address) : '不可用'
  }
  if (v.kind === 'pointer') {
    return v.available ? fmtAddr(v.value ?? 0) : '不可用'
  }
  return v.available ? fmtValue(v.value, v.bit_size) : '不可用'
}

/** 变量行 Type：结构化类型用通用词（struct/array），指针保留具体类型，标量显示类型 */
function varTypeLabel(v: CallStackLocal): string {
  const prefix = v.is_param ? 'param' : 'variable'
  if (v.kind === 'struct') return `${prefix} - struct`
  if (v.kind === 'array') return `${prefix} - array`
  return `${prefix} - ${v.type || '?'}`
}

const GRID = 'grid grid-cols-[minmax(0,1.2fr)_minmax(96px,0.6fr)_minmax(56px,0.42fr)_minmax(0,1fr)]'

interface VarNodeProps {
  node: CallStackLocal
  path: string
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
}

/** 递归渲染局部变量节点（结构体/数组可折叠展开成员/元素） */
function VarNode({ node, path, depth, expanded, onToggle }: VarNodeProps) {
  const hasChildren = node.children && node.children.length > 0
  const open = expanded.has(path)
  const indent = Math.min(depth, 8) * 12 + 12
  return (
    <>
      <div className={`${GRID} border-t border-border/30 bg-muted/20 text-xs`}>
        <span
          className="min-w-0 truncate py-1 pr-2 text-left font-mono text-foreground/90"
          style={{ paddingLeft: indent }}
        >
          {hasChildren ? (
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
          className="min-w-0 truncate border-l border-border/30 px-2 py-1 text-left font-mono text-muted-foreground"
          title={node.address != null ? `地址: ${fmtAddr(node.address)}` : undefined}
        >
          {valueText(node)}
        </span>
        <span className="min-w-0 truncate border-l border-border/30 px-2 py-1 text-left text-muted-foreground">
          {varTypeLabel(node)}
        </span>
        <span className="min-w-0 truncate border-l border-border/30 px-2 py-1 text-left text-muted-foreground/70">
          {node.is_param ? '参数' : node.is_param === false && depth === 0 ? '局部' : ''}
        </span>
      </div>
      {hasChildren && open
        ? node.children!.map((c, ci) => (
            <VarNode
              key={`${path}-${ci}`}
              node={c}
              path={`${path}-${ci}`}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))
        : null}
    </>
  )
}

/**
 * Call Stack tab：调用栈回溯（4 列：Function / Location·Value / Type / Source）。
 * 需目标暂停；在 halt/step（PC 变化）时自动刷新。结构体/数组变量可折叠展开。
 */
export function CallStackPanel({ uid, connected }: CallStackPanelProps) {
  const state = useZoneStore((s) => s.state)
  const pc = useZoneStore((s) => s.pc)

  const [frames, setFrames] = useState<CallStackFrame[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 已展开的变量节点路径集合
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const toggleNode = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    if (!uid) return
    setLoading(true)
    try {
      const res = await zoneStack(uid)
      setFrames(res.frames ?? [])
      setError(null)
    } catch (e) {
      setFrames([])
      setError(e instanceof Error ? e.message : '读取调用栈失败')
    } finally {
      setLoading(false)
    }
  }, [uid])

  // halt/step 时自动刷新（PC 变化或状态进入 halted）
  const lastState = useRef(state)
  const lastPc = useRef(pc)
  const didInit = useRef(false)
  useEffect(() => {
    if (!uid) {
      setFrames([])
      return
    }
    if (state === 'halted') {
      // 首次挂载时若目标已 halt（如会话启动后才展开此面板），强制刷新一次，避免空帧
      const stateChanged = lastState.current !== 'halted'
      const pcChanged = lastPc.current !== pc
      const firstMount = !didInit.current
      didInit.current = true
      if (stateChanged || pcChanged || firstMount) void refresh()
    } else {
      setFrames([])
    }
    lastState.current = state
    lastPc.current = pc
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, state, pc])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!connected ? (
        <div className="min-h-0 flex-1" />
      ) : !uid ? (
        <Empty text="未连接" />
      ) : state !== 'halted' ? (
        <Empty text="目标运行中，暂停后查看调用栈" />
      ) : error ? (
        <Empty text={error} isError />
      ) : loading && frames.length === 0 ? (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          回溯中...
        </div>
      ) : frames.length === 0 ? (
        <Empty text="无有效调用栈（ELF 无符号表或异常栈）" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* 4 列表头 */}
          <div className={`${GRID} border-b border-border text-[10px] font-medium text-muted-foreground`}>
            <span className="px-2 py-1 text-left">Function</span>
            <span className="border-l border-border px-2 py-1 text-left">Location/Value</span>
            <span className="border-l border-border px-2 py-1 text-left">Type</span>
            <span className="border-l border-border px-2 py-1 text-left">Source</span>
          </div>
          {frames.map((f, i) => {
            const isTop = i === 0
            const hasLocals = f.locals && f.locals.length > 0
            const rowCls = isTop
              ? `${GRID} bg-primary/10 text-xs`
              : `${GRID} text-xs hover:bg-muted/30`
            return (
              <div key={`${f.address}-${i}`} className={isTop ? 'border-b border-primary/20' : 'border-b border-border/50'}>
                {/* 函数行 */}
                <div className={rowCls}>
                  <span className="min-w-0 truncate px-2 py-1 text-left">
                    <span className={isTop ? 'font-medium text-primary' : 'font-medium text-foreground'}>
                      {f.function || f.symbol || '<unknown>'}
                    </span>
                  </span>
                  <span
                    className="min-w-0 truncate border-l border-border/50 px-2 py-1 text-left font-mono text-muted-foreground"
                    title={`SP: ${f.sp != null ? fmtAddr(f.sp) : '—'}`}
                  >
                    {fmtAddr(f.address)}
                  </span>
                  <span
                    className="min-w-0 truncate border-l border-border/50 px-2 py-1 text-left text-muted-foreground"
                    title={f.signature || undefined}
                  >
                    {f.signature || '—'}
                  </span>
                  <span className="min-w-0 truncate border-l border-border/50 px-2 py-1 text-left">
                    {f.file ? (
                      <span className="text-muted-foreground/80">
                        {f.file.split('/').pop()}
                        {f.line ? `:${f.line}` : ''}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </span>
                </div>
                {/* 局部变量（含结构体/数组可展开成员） */}
                {hasLocals
                  ? f.locals!.map((v, vi) => (
                      <VarNode
                        key={`${f.address}-v-${vi}`}
                        node={v}
                        path={`${f.address}-${vi}`}
                        depth={0}
                        expanded={expanded}
                        onToggle={toggleNode}
                      />
                    ))
                  : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Empty({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <div
      className={
        isError
          ? 'flex h-full items-center justify-center gap-2 p-4 text-red-500'
          : 'flex h-full items-center justify-center p-4 text-center text-muted-foreground'
      }
    >
      {isError ? <AlertCircle className="size-4 shrink-0" /> : null}
      <span className="max-w-md truncate">{text}</span>
    </div>
  )
}