import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { useSessionReady, useAutoRefresh } from '../hooks'
import * as zoneService from '@/services/zone.service'
import type { NvicIrq } from '@/services/zone.service'
import { cn } from '@/lib/utils'

interface CorePeripheralsPanelProps {
  uid: string | null
  connected: boolean
}

interface PrevState {
  enabled: boolean
  pending: boolean
  active: boolean
  priority: number
}

/** 状态列标记：实心 = 置位（on），空心 = 未置位（off） */
function StateDot({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'inline-block size-2.5 rounded-full border',
        on ? 'border-transparent bg-primary' : 'border-current text-muted-foreground/40'
      )}
    />
  )
}

/**
 * Core Peripherals 面板（NVIC，Keil 范式）
 *
 * 表格按中断源一行展示 Enable / Pending / Active / Priority 状态；
 * 选中一行（仅高亮）后，在视图底部操作栏对 Enable / Pending 进行写入。
 * 默认折叠不读取；展开且就绪才读取；未就绪整块留白、不发请求。
 */
export function CorePeripheralsPanel({ uid, connected }: CorePeripheralsPanelProps) {
  const { ready } = useSessionReady(uid, connected)

  const [expanded, setExpanded] = useState(false)
  const [irqs, setIrqs] = useState<NvicIrq[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 值变化（与上次刷新对比）的单元格 key 集合（`${number}:${kind}`，黄底黑字）
  const [changed, setChanged] = useState<Set<string>>(() => new Set())
  // 上次快照（number -> 各状态）
  const prevRef = useRef<Map<number, PrevState>>(new Map())
  // 刷新序号：latest-wins，丢弃过期响应
  const refreshSeqRef = useRef(0)
  // 写入进行中：避免连点按钮重复发请求
  const writingRef = useRef(false)
  // 刷新 in-flight 守卫：避免事件刷新与写入后的回读请求堆积
  const inflightRef = useRef(false)

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const refresh = useCallback(async () => {
    if (!ready || !uid || !expandedRef.current || inflightRef.current) return
    inflightRef.current = true
    const seq = ++refreshSeqRef.current
    setLoading(true)
    try {
      const res = await zoneService.zoneCoreNvic(uid)
      if (seq !== refreshSeqRef.current) return
      if (res.success) {
        // 运行中其他调试操作占用总线时后端返回 skipped=True：静默保留上一份快照
        if ((res as { skipped?: boolean }).skipped) {
          setError(null)
          return
        }
        setIrqs(res.interrupts)
        setError(null)
        setChanged(() => {
          const next = new Set<string>()
          const prevMap = prevRef.current
          const curr = new Map<number, PrevState>()
          for (const it of res.interrupts) {
            const ps: PrevState = { enabled: it.enabled, pending: it.pending, active: it.active, priority: it.priority }
            const old = prevMap.get(it.number)
            if (old) {
              if (old.enabled !== ps.enabled) next.add(`${it.number}:enable`)
              if (old.pending !== ps.pending) next.add(`${it.number}:pending`)
              if (old.active !== ps.active) next.add(`${it.number}:active`)
              if (old.priority !== ps.priority) next.add(`${it.number}:priority`)
            }
            curr.set(it.number, ps)
          }
          prevRef.current = curr
          return next
        })
      } else {
        setIrqs([])
        setError(
          'error' in (res as { error?: string }) ? (res as { error?: string }).error || '读取失败' : '读取失败'
        )
      }
    } catch (e) {
      if (seq !== refreshSeqRef.current) return
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false)
      inflightRef.current = false
    }
  }, [ready, uid])

  useAutoRefresh(uid, connected, ready, refresh)

  // 展开且就绪时立即读取；折叠时自动停止（refresh 内守卫，不发请求）
  useEffect(() => {
    if (ready && expanded) void refresh()
  }, [ready, expanded, refresh])

  const toggle = useCallback(() => {
    setExpanded((v) => {
      if (v) setSelected(null)
      return !v
    })
  }, [])

  const doWrite = useCallback(
    async (kind: 'enable' | 'pending', value: boolean) => {
      if (!ready || !uid || selected === null || writingRef.current) return
      writingRef.current = true
      try {
        if (kind === 'enable') await zoneService.zoneSetNvicEnable(uid, selected, value)
        else await zoneService.zoneSetNvicPending(uid, selected, value)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '操作失败')
      } finally {
        writingRef.current = false
      }
    },
    [ready, uid, selected, refresh]
  )

  const selectedIrq = irqs.find((i) => i.number === selected) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!ready ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <>
          <button
            onClick={toggle}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border px-2 py-1 text-left text-xs hover:bg-muted/30"
          >
            <span className="flex min-w-0 items-center gap-1">
              {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="font-medium text-primary">NVIC</span>
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">0xE000_E100</span>
            <span className="truncate text-right text-[10px] text-muted-foreground">嵌套向量中断控制器</span>
          </button>

          {expanded && (
            <>
              <div className="flex min-h-0 flex-1 flex-col">
            {loading && irqs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                读取中...
              </div>
            ) : error ? (
              <div className="flex flex-1 items-center justify-center px-2 text-xs text-destructive">{error}</div>
            ) : irqs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">无中断源</div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="grid grid-cols-[44px_minmax(0,1fr)_56px_56px_56px_64px] border-b border-border text-[10px] font-medium text-muted-foreground">
                  <span className="px-2 py-1 text-left">IRQ</span>
                  <span className="border-l border-border px-2 py-1 text-left">Name</span>
                  <span className="border-l border-border px-2 py-1 text-center">Enable</span>
                  <span className="border-l border-border px-2 py-1 text-center">Pending</span>
                  <span className="border-l border-border px-2 py-1 text-center">Active</span>
                  <span className="border-l border-border px-2 py-1 text-center">Priority</span>
                </div>
                {irqs.map((it) => (
                  <button
                    key={it.number}
                    onClick={() => setSelected((cur) => (cur === it.number ? null : it.number))}
                    className={cn(
                      'grid w-full grid-cols-[44px_minmax(0,1fr)_56px_56px_56px_64px] items-center border-b border-border text-xs hover:bg-muted/30',
                      selected === it.number && 'bg-primary/10'
                    )}
                  >
                    <span className="px-2 py-1 font-mono text-muted-foreground">{it.number}</span>
                    <span className={cn('min-w-0 truncate border-l border-border px-2 py-1 text-left', selected === it.number ? 'font-medium text-primary' : 'text-foreground')}>{it.name}</span>
                    <StateCell changed={changed.has(`${it.number}:enable`)} on={it.enabled} />
                    <StateCell changed={changed.has(`${it.number}:pending`)} on={it.pending} />
                    <StateCell changed={changed.has(`${it.number}:active`)} on={it.active} />
                    <span className={cn('border-l border-border px-2 py-1 text-center font-mono', changed.has(`${it.number}:priority`) ? 'bg-yellow-400/30 text-foreground' : 'text-primary')}>{it.priority}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 底部操作栏：选中中断后用复选框操作 Enable / Pending（运行态同样可写） */}
          <div className="flex min-h-0 shrink-0 items-center gap-3 border-t border-border px-2 py-1.5">
            {selectedIrq ? (
              <>
                <span className="mr-1 truncate text-[11px] text-muted-foreground">
                  <span className="font-mono text-foreground">{selectedIrq.number}</span> <span className="text-primary">{selectedIrq.name}</span>
                </span>
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={selectedIrq.enabled}
                    onChange={(e) => doWrite('enable', e.target.checked)}
                  />
                  Enable
                </label>
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={selectedIrq.pending}
                    onChange={(e) => doWrite('pending', e.target.checked)}
                  />
                  Pending
                </label>
              </>
            ) : (
              <span className="px-1 text-[11px] text-muted-foreground"></span>
            )}
          </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function StateCell({ changed, on }: { changed: boolean; on: boolean }) {
  return (
    <span className={cn('flex items-center justify-center border-l border-border px-2 py-1', changed && 'bg-yellow-400/30')}>
      <StateDot on={on} />
    </span>
  )
}