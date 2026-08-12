import { useEffect, useRef, useState, useCallback, useMemo, useLayoutEffect } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { useZoneStore } from '../store'
import { useSessionReady } from '../hooks'
import * as zoneService from '@/services/zone.service'
import type { DisasmRow } from '@/services/zone.service'

interface DisasmViewProps {
  uid: string | null
  connected: boolean
}

// 每次请求的反汇编窗口大小（字节 / 最大指令条数）
const WINDOW_LEN = 64
const WINDOW_MAX = 32
// 初始加载时向目标地址之前预加载的窗口数，避免一向上滚动就触发 prepend 加载
const PRELOAD_WINDOWS = 4

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

/** 取列表最后一条指令所属函数名（无指令则 null） */
function tailFunction(rows: DisasmRow[]): string | null {
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k]
    if (r.type === 'ins') return r.function
  }
  return null
}

/** 取列表第一条指令所属函数名（无指令则 null，忽略开头 func 标签） */
function headFunction(rows: DisasmRow[]): string | null {
  for (const r of rows) {
    if (r.type === 'ins') return r.function
  }
  return null
}

/** 跳过列表开头的 func 标签行（用于窗口边界合并时移除重复标签） */
function skipLeadingFunc(rows: DisasmRow[], start = 0): number {
  let i = start
  while (i < rows.length && rows[i].type === 'func') i++
  return i
}

/** 追加下一页时去重：去掉 next 开头与 prev 末尾重复的函数标签/源码行 */
function dedupeAppend(prev: DisasmRow[], next: DisasmRow[]): DisasmRow[] {
  if (prev.length === 0) return next
  const prevFunc = tailFunction(prev)
  const nextFunc = headFunction(next)
  // 窗口边界切在函数中间：prev 尾部 + next 头部同属一个函数 →
  // 跳过 next 开头的重复函数标签，保持函数体连续。
  if (prevFunc && prevFunc === nextFunc) {
    return [...prev, ...next.slice(skipLeadingFunc(next))]
  }
  const lastSrc = lastSourceKey(prev)
  let i = 0
  while (i < next.length && next[i].type !== 'ins') {
    const r = next[i]
    // 跳过与 prev 末尾同函数的重复标签行
    if (r.type === 'func' && prevFunc && r.name === prevFunc) {
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

/** 前插上一页时去重：去掉 next 开头与 prev 末尾重复的函数标签/源码行 */
function dedupePrepend(next: DisasmRow[], prev: DisasmRow[]): DisasmRow[] {
  if (next.length === 0) return prev
  const nextFunc = tailFunction(next)
  const prevFunc = headFunction(prev)
  // 窗口边界切在函数中间：next 尾部 + prev 头部同属一个函数 → 保持函数体连续。
  if (nextFunc && nextFunc === prevFunc) {
    return [...next, ...prev.slice(skipLeadingFunc(prev))]
  }
  return [...next, ...prev]
}

/** 取列表最后一条指令的结束地址（无指令返回 null） */
function loadedEnd(rows: DisasmRow[]): number | null {
  let end: number | null = null
  for (const r of rows) if (r.type === 'ins') end = r.address + r.size
  return end
}

/** 判断是否已到代码末尾（最后一条指令后没有更多反汇编） */
function maybeEnd(rows: DisasmRow[]): boolean {
  const end = loadedEnd(rows)
  return end === null
}

/**
 * 反汇编视图（SEGGER Ozone 风格）：函数标签 + 源码行交错 + 指令行，
 * 含列头、PC 高亮与自动滚动、滚动分页（加载更多/更前）、分支跳转导航。
 */
export function DisasmView({ uid, connected }: DisasmViewProps) {
  const pc = useZoneStore((s) => s.pc)
  const state = useZoneStore((s) => s.state)
  const disasmAvailable = useZoneStore((s) => s.disasmAvailable)
  // 反汇编从 ELF 读取代码段，仅依赖 ELF 符号，用 elfLoaded 提前加载，无需等待目标连接/会话启动。
  // PC 高亮/自动滚动在会话 active、PC 就绪后由 effect 自动锚定到实际指令。
  const { elfLoaded } = useSessionReady(uid, connected)

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
  // 加载纪元：每次 loadInitial 递增，过期（已被更新的加载取代）的结果直接丢弃。
  // 避免"旧加载尚未完成时再次 Reset/Run 触发新加载"被 loadingRef 守卫跳过，
  // 或因旧加载晚到覆盖新加载，导致反汇编停在旧 PC 区域、PC 行缺失而不滚动。
  const loadEpochRef = useRef(0)

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
      const epoch = loadEpochRef.current
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
        // 期间发生了新的 loadInitial（epoch 变化），本次增量结果已过期，丢弃
        if (epoch !== loadEpochRef.current) return
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
          return dedupePrepend(newRows, prev)
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
        if (epoch === loadEpochRef.current) setError(e instanceof Error ? e.message : '反汇编失败')
      } finally {
        if (epoch === loadEpochRef.current) {
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
        } else {
          anchorHeightRef.current = 0
        }
      }
    },
    [uid]
  )

  // 初始加载：从目标地址往前预加载 PRELOAD_WINDOWS 个窗口，再逐步往后补齐，
  // 使刚加载 ELF 后向上滚动有内容缓冲，避免一滚就触发 prepend 加载。
  const loadInitial = useCallback(
    async (targetAddr: number) => {
      if (!uid) return
      // 每次初始加载都递增纪元：末尾应用结果前校验，若期间又触发了更新的加载则丢弃本次，
      // 避免被 loadingRef 守卫跳过新加载，也避免旧加载晚到覆盖新加载（旧 PC 区域）。
      const epoch = ++loadEpochRef.current
      loadingRef.current = true
      setLoading(true)
      setError(null)
      try {
        // 1. 向前预加载若干窗口（从 targetAddr - PRELOAD_WINDOWS*WINDOW_LEN 起）
        const frontStart = Math.max(0, targetAddr - PRELOAD_WINDOWS * WINDOW_LEN)
        let acc: DisasmRow[] = []
        let cur = frontStart
        let frontCount = 0
        while (cur >= 0 && cur < targetAddr) {
          const res = await zoneService.zoneDisasm(uid, cur, WINDOW_LEN, WINDOW_MAX)
          if (!res.success) break
          const batch = res.rows ?? []
          const count = batch.filter((r) => r.type === 'ins').length
          acc = dedupeAppend(acc, batch)
          frontCount += count
          // 向前推进到窗口末尾，进入下一窗口
          let next = cur
          for (const r of batch) if (r.type === 'ins') next = Math.max(next, r.address + r.size)
          if (next <= cur) break
          cur = next
          // 已预加载足够窗口或到达代码边界则停止
          if (frontCount >= WINDOW_MAX * PRELOAD_WINDOWS) break
        }
        // 2. 从已加载末尾继续向后补齐，直到覆盖 targetAddr。
        //    注意用 `loadedEnd <= targetAddr`（而不是 `<`）：第 1 阶段预加载可能
        //    因 frontCount 上限提前断在 targetAddr-1 条指令处，此时 loadedEnd 恰等于
        //    targetAddr，若用 `<` 会误判已覆盖，导致 PC 指令行缺失、滚动定位失效。
        let guard = 0
        while (acc.length === 0 || (loadedEnd(acc) !== null && loadedEnd(acc)! <= targetAddr)) {
          if (guard++ > 8) break
          const start = acc.length === 0 ? frontStart : loadedEnd(acc)!
          const res = await zoneService.zoneDisasm(uid, start, WINDOW_LEN, WINDOW_MAX)
          if (!res.success) break
          acc = dedupeAppend(acc, res.rows ?? [])
        }
        // 加载期间发生了更新的加载，丢弃本次结果
        if (epoch !== loadEpochRef.current) return
        setBaseAddress(frontStart)
        setRows(acc)
        setCanPrev(frontCount >= WINDOW_MAX * PRELOAD_WINDOWS)
        setCanNext(!maybeEnd(acc))
      } catch (e) {
        if (epoch === loadEpochRef.current) {
          setError(e instanceof Error ? e.message : '反汇编失败')
        }
      } finally {
        if (epoch === loadEpochRef.current) {
          loadingRef.current = false
          setLoading(false)
        }
      }
    },
    [uid]
  )

  // 初始：ELF 未加载时清空；加载后从 PC 或默认地址反汇编（PC 就绪后自动重定位）
  useEffect(() => {
    if (!elfLoaded) {
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
        void loadInitial(pc)
        return
      }
    }
    if (baseAddress === null) {
      void loadInitial(startAddr)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elfLoaded, pc, state])

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

  // PC 指令行滚动到容器中央
  // 用 useLayoutEffect（DOM 提交后、绘制前同步执行）而非 useEffect+双重 rAF：
  // 此时 lineRefs 已由 ref 回调填充，容器已布局，可直接按几何计算滚动目标，
  // 避免"Reset 后停在 Reset_Handler 却不滚动"（旧实现因渲染时序拿到 undefined）。
  // 若首次布局尚未就绪（如面板刚切换/隐藏态），下一帧重试一次。
  useLayoutEffect(() => {
    if (pc === null || pc === undefined) return
    const doScroll = () => {
      const container = containerRef.current
      const el = lineRefs.current.get(pc)
      if (!container || !el) return false
      const cRect = container.getBoundingClientRect()
      const eRect = el.getBoundingClientRect()
      const lineH = eRect.height || 16
      const target = container.scrollTop + (eRect.top - cRect.top) - cRect.height / 2 + lineH / 2
      container.scrollTo({ top: Math.max(0, target), behavior: 'auto' })
      return true
    }
    if (!doScroll()) {
      requestAnimationFrame(doScroll)
    }
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
        {!elfLoaded ? (
          <div className="min-h-0 flex-1" />
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
                    className="flex items-center border-y border-border bg-muted/40 pl-1 pr-2 py-0.5 text-[11px]"
                  >
                    <span className="truncate font-semibold text-primary">{row.name}</span>
                    <span className="ml-1 shrink-0 font-mono text-[10px] font-normal text-muted-foreground">
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
                    <span
                      className="min-w-0 flex-1 truncate italic text-muted-foreground/80"
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