import { useEffect, useState, useCallback, useMemo } from 'react'
import { RefreshCw, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { zoneMemoryUsage, type MemoryUsage } from '@/services/zone.service'
import { useZoneStore } from '../store'
import { useSessionReady } from '../hooks'
import { useProbeStore } from '@/stores/probe.store'
import { resolveMemoryRegions, type MemoryRegion } from '../utils/memoryLimits'
import { cn } from '@/lib/utils'

function fmtBytes(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function fmtAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

interface SectionGroup {
  region: MemoryRegion
  sections: MemoryUsage['sections']
}

/** 将 ELF sections 按地址归属到各内存区域；未落入任何区域的归入 unmatched */
function groupSectionsByRegion(
  sections: MemoryUsage['sections'],
  regions: MemoryRegion[]
): { groups: SectionGroup[]; unmatched: MemoryUsage['sections'] } {
  const groups: SectionGroup[] = regions.map((region) => ({ region, sections: [] }))
  const unmatched: MemoryUsage['sections'] = []
  for (const sec of sections) {
    const group = groups.find(
      (g) => sec.address >= g.region.start && sec.address < g.region.start + g.region.length
    )
    if (group) group.sections.push(sec)
    else unmatched.push(sec)
  }
  return { groups, unmatched }
}

/** 单条内存段横条（可展开/折叠，展开显示段内 sections） */
function RegionBar({
  region,
  sections,
  expanded,
  onToggle,
  color,
}: {
  region: MemoryRegion
  sections: MemoryUsage['sections']
  expanded: boolean
  onToggle: () => void
  color: string
}) {
  const used = sections.reduce((s, x) => s + x.size, 0)
  const overflow = region.length > 0 && used > region.length
  const pct = region.length > 0 ? Math.min(100, (used / region.length) * 100) : 0

  return (
    <div className="overflow-hidden rounded border border-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent"
        title={`上限来源：${region.source}`}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
        />
        <span className="w-10 shrink-0 text-xs font-medium">{region.name}</span>
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', overflow ? 'bg-red-500' : color)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span
          className={cn(
            'w-44 shrink-0 text-right font-mono text-[10px]',
            overflow ? 'font-semibold text-red-500' : 'text-muted-foreground'
          )}
        >
          {fmtBytes(used)} / {fmtBytes(region.length)} ({Math.round(pct)}%)
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border">
          {sections.length === 0 ? (
            <div className="px-2 py-1 text-[10px] text-muted-foreground">该区域无 section</div>
          ) : (
            sections.map((sec) => {
              const secOverflow = sec.address + sec.size > region.start + region.length
              return (
                <div
                  key={sec.name}
                  className={cn('flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent', secOverflow && 'text-red-500')}
                >
                  <span className="flex-1 truncate font-mono">{sec.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{fmtAddr(sec.address)}</span>
                  <span className="w-16 text-right font-mono text-[10px] text-muted-foreground">
                    {fmtBytes(sec.size)}
                  </span>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 底部 Memory Usage tab：ELF section 近似估算的内存占用。
 * 内存段（Flash/RAM 区域）来自 DFP pack 导入的设备数据（运行时 TargetInfo → 静态 DeviceInfo → 兜底），
 * 每段一条可展开/折叠的横条，展开显示段内 sections；溢出时变红警示。
 */
export function MemoryUsagePanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  // 内存占用按 ELF section 近似估算，仅依赖 ELF 符号，用 elfLoaded 提前加载，无需等待目标连接/会话启动
  const { elfLoaded } = useSessionReady(uid, connected)
  const [usage, setUsage] = useState<MemoryUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // 响应式订阅探针目标与设备目录，连接/断开时内存区域实时更新
  const target = useProbeStore((s) => (uid ? s.probes.find((p) => p.uid === uid)?.target ?? null : null))
  const deviceList = useProbeStore((s) => s.deviceList)
  const deviceInfo = useMemo(
    () => (target ? deviceList.find((d) => d.part_number === target.part_number) : undefined),
    [target, deviceList]
  )
  const regions = useMemo(() => resolveMemoryRegions(target, deviceInfo), [target, deviceInfo])

  const load = useCallback(async () => {
    // ELF 未加载时不请求后端，避免 No ELF loaded 的 400 报错
    if (!elfLoaded || !uid) {
      setUsage(null)
      setError(null)
      return
    }
    setLoading(true)
    try {
      setUsage(await zoneMemoryUsage(uid))
      setError(null)
    } catch (e) {
      // 优先展示后端 FastAPI 返回的 detail，便于定位真实原因
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : e instanceof Error ? e.message : 'load failed')
      setUsage(null)
    } finally {
      setLoading(false)
    }
  }, [elfLoaded, uid])

  useEffect(() => {
    void load()
  }, [load])

  const { groups, unmatched } = useMemo(
    () => groupSectionsByRegion(usage?.sections ?? [], regions),
    [usage, regions]
  )

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2">
      <div className="flex shrink-0 items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading || !uid}
          className="h-6 w-6 shrink-0 p-0"
          title="刷新"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pt-1">
        {error ? (
          <div className="flex h-full items-center justify-center text-xs text-red-500">{error}</div>
        ) : !elfLoaded ? (
          <div className="min-h-0 flex-1" />
        ) : !usage ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            加载中...
          </div>
        ) : (
          <div className="space-y-2">
            {groups.map((g, i) => {
              const key = `${g.region.name}:${g.region.start.toString(16)}`
              return (
                <RegionBar
                  key={key}
                  region={g.region}
                  sections={g.sections}
                  expanded={expanded[key] ?? i === 0}
                  onToggle={() => toggle(key)}
                  color={g.region.kind === 'flash' ? 'bg-sky-500' : 'bg-amber-500'}
                />
              )
            })}
            {unmatched.length > 0 && (
              <div className="overflow-hidden rounded border border-border">
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  其他
                </div>
                {unmatched.map((sec) => (
                  <div key={sec.name} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent">
                    <span className="flex-1 truncate font-mono">{sec.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{fmtAddr(sec.address)}</span>
                    <span className="w-16 text-right font-mono text-[10px] text-muted-foreground">
                      {fmtBytes(sec.size)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
