import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { useZoneStore } from '../store'
import * as zoneService from '@/services/zone.service'
import type { DisasmRow } from '@/services/zone.service'

interface DisasmViewProps {
  uid: string | null
  connected: boolean
}

// 每次请求的反汇编窗口大小（字节 / 最大指令条数）
const WINDOW_LEN = 64
const WINDOW_MAX = 32

// 分支 / 跳转指令：点击操作数中的目标地址可导航到该地址的反汇编
const BRANCH_MNEMONICS = new Set(['b', 'bl', 'bx', 'blx', 'cbz', 'cbnz', 'tbb', 'tbh'])

function isBranch(mnemonic: string): boolean {
  return BRANCH_MNEMONICS.has(mnemonic.toLowerCase())
}

/** 从操作数文本中提取目标地址（如 `#0x8000440` / `0x8000440`） */
function extractTarget(op: string): number | null {
  const m = op.match(/0x[0-9a-fA-F]+/)
  if (!m) return null
  const v = parseInt(m[0], 16)
  return Number.isFinite(v) ? v : null
}

/** 反汇编操作数语法高亮：寄存器（绿）、立即数 #0x/#n（橙），其余保持默认 */
function highlightOperand(op: string) {
  const upper = op.toUpperCase()
  const parts = upper.split(/(#0X[0-9A-F]+|#\d+|\b(?:R\d{1,2}|SP|LR|PC)\b)/g).filter((p) => p !== '')
  return parts.map((p, i) => {
    if (/^#/.test(p)) return <span key={i} className="text-orange-500">{p}</span>
    if (/\b(?:R\d{1,2}|SP|LR|PC)\b/.test(p)) return <span key={i} className="text-emerald-600">{p}</span>
    return <span key={i}>{p}</span>
  })
}

/** 行类型键（用于分页合并时去重同函数/同源码行） */
function rowKey(r: DisasmRow): string {
  if (r.type === 'func') return `func:${r.name}`
  if (r.type === 'source') return `src:${r.file}:${r.line}:${r.text}`
  return `ins:${r.address}`
}

/** 取列表末尾最近的一条源码行键（其后的 ins 存在则返回 null） */
function lastSourceKey(rows: DisasmRow[]): string | null {
  for (let k = rows.length - 1; k >= 0; k--) {
    if (rows[k].type === 'ins') return null
    if (rows[k].type === 'source') return rowKey(rows[k])
  }
  return null
}

/** 追加下一页时去重：去掉 next 开头与 prev 末尾重复的函数/源码行 */
function dedupeAppend(prev: DisasmRow[], next: DisasmRow[]): DisasmRow[] {
  if (prev.length === 0) return next
  const lastRow = prev[prev.length - 1]
  const lastFunc = lastRow.type === 'ins' ? lastRow.function : null
  const lastSrc = lastSourceKey(prev)
  let i = 0
  while (i < next.length && next[i].type !== 'ins') {
    const r = next[i]
    if (r.type === 'func' && r.name === lastFunc) {
      i++
      continue
    }
    if (r.type === 'source' && lastSrc && rowKey(r) === lastSrc) {
      i++
      continue
    }
    break
  }
  return [...prev, ...next.slice(i)]
}

/**
 * 反汇编视图（SEGGER Ozone 风格）：函数标签 + 源码行交错 + 指令行，
 * 含列头、PC 高亮与自动滚动、滚动分页（加载更多/更前）、分支跳转导航。
 */
export function DisasmView({ uid, connected }: DisasmViewProps) {
  const pc = useZoneStore((s) => s.pc)
  const state = useZoneStore((s) => s.state)
  const disasmAvailable = useZoneStore((s) => s.disasmAvailable)
  const elfPath = useZoneStore((s) => s.elfPath)

  const [rows, setRows] = useState<DisasmRow[]>([])
  const [baseAddress, setBaseAddress] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingDir, setLoadingDir] = useState<'append' | 'prepend'>('append')
  const [error, setError] = useState<string | null>(null)
  const [canPrev, setCanPrev] = useState(true)
  const [canNext, setCanNext] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  // 并发加载守卫 + 前插滚动锚定
  const loadingRef = useRef(false)
  const anchorHeightRef = useRef(0)

  // 当前已加载指令的地址范围（用于分页从边界继续加载）
  const loadedRange = useMemo(() => {
    let start: number | null = null
    let end: number | null = null
    for (const r of rows) {
      if (r.type === 'ins') {
        if (start === null) start = r.address
        end = r.address + r.size
      }
    }
    return { start, end }
  }, [rows])

  const loadWindow = useCallback(
    async (addr: number, direction: 'replace' | 'append' | 'prepend' = 'replace') => {
      if (!uid || loadingRef.current) return
      loadingRef.current = true
      if (direction === 'replace') setLoading(true)
      else {
        setLoadingMore(true)
        setLoadingDir(direction)
      }
      setError(null)
      // 前插时记录原滚动高度，加载完成后保持当前可视内容不跳动
      if (direction === 'prepend') anchorHeightRef.current = containerRef.current?.scrollHeight ?? 0
      try {
        const res = await zoneService.zoneDisasm(uid, addr, WINDOW_LEN, WINDOW_MAX)
        if (!res.success) {
          // 窗口两端已到代码边界或无代码：停止该方向继续加载
          if (direction === 'append') setCanNext(false)
          if (direction === 'prepend') setCanPrev(false)
          setError('反汇编失败')
          return
        }
        const newRows = res.rows ?? []
        const nextCount = newRows.filter((r) => r.type === 'ins').length
        setBaseAddress(res.address)
        setRows((prev) => {
          if (direction === 'replace') return newRows
          if (direction === 'append') return dedupeAppend(prev, newRows)
          return [...newRows, ...prev]
        })
        // 边界判断：返回不足一窗口说明已到代码边界
        if (direction === 'replace') {
          setCanNext(true)
          setCanPrev(true)
        } else if (direction === 'append') {
          setCanNext(nextCount >= WINDOW_MAX)
        } else {
          setCanPrev(nextCount >= WINDOW_MAX)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '反汇编失败')
      } finally {
        loadingRef.current = false
        setLoading(false)
        setLoadingMore(false)
        // 前插后恢复滚动位置，保持可视内容稳定
        if (direction === 'prepend' && anchorHeightRef.current) {
          const before = anchorHeightRef.current
          anchorHeightRef.current = 0
          requestAnimationFrame(() => {
            const el = containerRef.current
            if (el) el.scrollTop += el.scrollHeight - before
          })
        }
      }
    },
    [uid]
  )

  // 初始：无 ELF 时显示提示；有 ELF 时从 PC 或默认地址反汇编
  useEffect(() => {
    if (!elfPath) {
      setRows([])
      setBaseAddress(null)
      setError(null)
      return
    }
    const startAddr = pc ?? 0x08000000
    if (pc !== null && pc !== undefined) {
      const inRange =
        baseAddress !== null && loadedRange.start !== null && loadedRange.end !== null
          ? pc >= loadedRange.start && pc < loadedRange.end
          : false
      if (!inRange) {
        void loadWindow(pc, 'replace')
        return
      }
    }
    if (baseAddress === null) {
      void loadWindow(startAddr, 'replace')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elfPath, pc, state])

  // 滚动到边缘时加载更多/更前
  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (!el || loadingRef.current) return
    const { start, end } = loadedRange
    if (el.scrollTop <= 40 && canPrev && start !== null && start - WINDOW_LEN > 0) {
      void loadWindow(start - WINDOW_LEN, 'prepend')
    } else if (
      el.scrollHeight - el.scrollTop - el.clientHeight <= 40 &&
      canNext &&
      end !== null
    ) {
      void loadWindow(end, 'append')
    }
  }, [loadWindow, canPrev, canNext, loadedRange])

  // PC 指令行滚动到容器中央（双重 rAF，布局稳定后滚动）
  useEffect(() => {
    if (pc === null || pc === undefined) return
    const container = containerRef.current
    const el = lineRefs.current.get(pc)
    if (!container || !el) return
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const lineH = eRect.height || 16
    const target = container.scrollTop + (eRect.top - cRect.top) - cRect.height / 2 + lineH / 2
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.scrollTo({ top: Math.max(0, target), behavior: 'auto' })
      })
    })
  }, [rows, pc])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 列头（sticky 顶部，滚动时保持可见） */}
      <div className="flex shrink-0 border-b border-border bg-background text-[10px] font-medium text-muted-foreground">
        <div className="flex w-10 shrink-0" />
        <span className="w-24 shrink-0 px-1 py-1">Address</span>
        <span className="w-20 shrink-0 px-1 py-1">Machine Code</span>
        <span className="w-16 shrink-0 px-1 py-1">Instruction</span>
        <span className="flex-1 px-1 py-1">Operand</span>
      </div>
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-relaxed"
      >
        {!connected ? (
          <div className="min-h-0 flex-1" />
        ) : !elfPath ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            请先加载 ELF 文件
          </div>
        ) : !disasmAvailable ? (
          <div className="flex h-full items-center justify-center gap-2 text-amber-600">
            <AlertCircle className="size-4" />
            <span>Capstone 未安装，无法反汇编</span>
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            反汇编中...
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center gap-2 text-red-500">
            <AlertCircle className="size-4" />
            <span className="max-w-md truncate">{error}</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            无指令
          </div>
        ) : (
          <>
            {/* 前插加载指示 */}
            {loadingMore && loadingDir === 'prepend' && (
              <div className="flex items-center justify-center gap-1 py-1 text-[10px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> 加载更前...
              </div>
            )}
            {rows.map((row, idx) => {
              if (row.type === 'func') {
                return (
                  <div
                    key={`f-${idx}`}
                    className="flex items-center gap-2 border-y border-border bg-muted/40 px-1 py-0.5 text-[11px]"
                  >
                    <span className="flex w-10 shrink-0" />
                    <span className="truncate font-semibold text-primary">{row.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] font-normal text-muted-foreground">
                      0x{row.address.toString(16).toUpperCase().padStart(8, '0')}
                    </span>
                  </div>
                )
              }
              if (row.type === 'source') {
                return (
                  <div
                    key={`s-${idx}`}
                    className="flex border-b border-transparent px-1 py-0.5 text-[11px] leading-relaxed"
                  >
                    <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/40">
                      {row.line}
                    </span>
                    <span
                      className="min-w-0 truncate italic text-muted-foreground/80"
                      title={`${row.file}:${row.line}`}
                    >
                      {row.text || ' '}
                    </span>
                  </div>
                )
              }
              const isPc = row.address === pc
              const isBr = isBranch(row.mnemonic)
              const target = isBr ? extractTarget(row.op_str) : null
              return (
                <div
                  key={row.address}
                  ref={(el) => {
                    if (el) lineRefs.current.set(row.address, el)
                    else lineRefs.current.delete(row.address)
                  }}
                  className={
                    isPc
                      ? 'flex border-b border-primary/20 bg-primary/10'
                      : 'flex border-b border-transparent hover:bg-muted/30'
                  }
                >
                  {/* 断点槽/PC 标记列（与源码窗口一致） */}
                  <div className="sticky left-0 flex w-10 shrink-0 select-none items-center justify-center bg-background">
                    <span className={isPc ? 'font-bold leading-none text-primary' : 'text-transparent'}>
                      ▶
                    </span>
                  </div>
                  <span className={isPc ? 'w-24 shrink-0 font-bold text-primary' : 'w-24 shrink-0 text-muted-foreground'}>
                    {row.address.toString(16).toUpperCase().padStart(8, '0')}
                  </span>
                  <span className="w-20 shrink-0 text-muted-foreground/70">{row.bytes.toUpperCase()}</span>
                  <span className="w-16 shrink-0 font-medium text-sky-600">{row.mnemonic.toUpperCase()}</span>
                  <span className="flex-1 pr-4">
                    {isBr && target !== null ? (
                      <button
                        onClick={() => void loadWindow(target, 'replace')}
                        title={`跳转到 0x${target.toString(16).toUpperCase()}`}
                        className="block w-full text-left hover:text-primary hover:underline"
                      >
                        {highlightOperand(row.op_str)}
                      </button>
                    ) : (
                      highlightOperand(row.op_str)
                    )}
                  </span>
                </div>
              )
            })}
            {/* 追加加载指示 */}
            {loadingMore && loadingDir === 'append' && (
              <div className="flex items-center justify-center gap-1 py-1 text-[10px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> 加载更多...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}