import { useEffect, useState, useCallback, useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { zoneMemoryUsage, type MemoryUsage } from '@/services/zone.service'
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

/** 语义分类 → 色块颜色 */
const CATEGORY_COLORS: Record<string, string> = {
  code: 'bg-sky-500',
  ro_data: 'bg-cyan-500',
  rw_data: 'bg-emerald-500',
  zi_data: 'bg-purple-500',
  heap: 'bg-orange-500',
  stack: 'bg-amber-500',
}

/** 语义分类 → 显示名（嵌入式行业术语） */
const CATEGORY_LABELS: Record<string, string> = {
  code: 'Code',
  ro_data: 'RO Data',
  rw_data: 'RW Data',
  zi_data: 'ZI Data',
  heap: 'Heap',
  stack: 'Stack',
}

/** 区域聚合结果：区域 + 该区域内 section 的总占用与分类 */
interface RegionUsage {
  region: MemoryRegion
  used: number
  cats: Record<string, number>
}

/** 把 ELF section 按地址归属到内存区域，聚合每个区域的占用与分类 */
function groupSectionsByRegion(sections: MemoryUsage['sections'], regions: MemoryRegion[]): RegionUsage[] {
  return regions.map((region) => {
    const end = region.start + region.length
    const inRegion = sections.filter((s) => s.address >= region.start && s.address < end)
    const used = inRegion.reduce((sum, s) => sum + s.size, 0)
    const cats: Record<string, number> = {}
    for (const s of inRegion) {
      for (const [kind, bytes] of Object.entries(s.categories)) {
        cats[kind] = (cats[kind] ?? 0) + bytes
      }
    }
    return { region, used, cats }
  })
}

/** 单区域内存卡片：标题（区域名+起始地址）+ 进度条 + 使用量/容量 + 分类占比 */
function MemoryCard({ usage }: { usage: RegionUsage }) {
  const { region, used, cats } = usage
  const overflow = region.length > 0 && used > region.length
  const pct = region.length > 0 ? Math.min(100, (used / region.length) * 100) : 0
  const barColor = region.kind === 'flash' ? 'bg-sky-500' : 'bg-amber-500'
  // 按区域类型过滤分类：Flash 显示 Code/RO Data，RAM 显示 RW/ZI/Heap/Stack
  const kinds = region.kind === 'flash' ? ['code', 'ro_data'] : ['rw_data', 'zi_data', 'heap', 'stack']
  const items = kinds.filter((k) => (cats[k] ?? 0) > 0)

  return (
    <div className="overflow-hidden rounded border border-border">
      <div
        className="flex items-center justify-between gap-1 border-b border-border bg-muted/30 px-2 py-1"
        title={`${region.name} · ${fmtAddr(region.start)} - ${fmtAddr(region.start + region.length)}`}
      >
        <span className="text-xs font-medium">{region.name}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{fmtAddr(region.start)}</span>
        {overflow && <AlertTriangle className="size-3 shrink-0 text-red-500" />}
      </div>
      <div className="space-y-1.5 p-2">
        <div className="h-2.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', overflow ? 'bg-red-500' : barColor)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div
          className={cn(
            'text-right font-mono text-[10px]',
            overflow ? 'font-semibold text-red-500' : 'text-muted-foreground'
          )}
        >
          {fmtBytes(used)} / {fmtBytes(region.length)} ({Math.round(pct)}%)
        </div>
        <div className="space-y-1">
          {items.length === 0 ? (
            <div className="text-[10px] text-muted-foreground">未使用</div>
          ) : (
            items.map((k) => (
              <div key={k} className="flex items-center gap-1.5 text-[10px]">
                <span className={cn('size-2 shrink-0 rounded-sm', CATEGORY_COLORS[k] ?? 'bg-muted')} />
                <span className="w-14 shrink-0 text-muted-foreground">{CATEGORY_LABELS[k] ?? k}</span>
                <span className="font-mono">{fmtBytes(cats[k])}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Memory Usage 面板：ELF section 语义分类估算 Flash/RAM 占用。
 * 每个内存区域（Flash/RAM 分区）一张卡片，容量来自 DFP pack 设备数据，
 * 分类占比（Code/RO Data/RW Data/ZI Data/Heap/Stack）让占用构成一目了然，溢出变红警示。
 */
export function MemoryUsagePanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  // 内存占用按 ELF section 近似估算，仅依赖 ELF 符号，用 elfLoaded 提前加载，无需等待目标连接/会话启动
  const { elfLoaded, elfPath } = useSessionReady(uid, connected)
  const [usage, setUsage] = useState<MemoryUsage | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    try {
      setUsage(await zoneMemoryUsage(uid))
      setError(null)
    } catch (e) {
      // 优先展示后端 FastAPI 返回的 detail，便于定位真实原因
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : e instanceof Error ? e.message : 'load failed')
      setUsage(null)
    }
    // 依赖 elfPath 而非 elfLoaded：同一会话内重载不同路径 ELF 时也能重拉数据
  }, [elfPath, uid])

  useEffect(() => {
    void load()
  }, [load])

  const regionUsages = useMemo(
    () => (usage ? groupSectionsByRegion(usage.sections, regions) : []),
    [usage, regions]
  )

  return (
    <div className="relative min-h-0 flex-1">
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center p-3 text-xs text-red-500">{error}</div>
      ) : !elfLoaded ? null : !usage ? (
        <div className="absolute inset-0 flex items-center justify-center p-3 text-xs text-muted-foreground">加载中...</div>
      ) : (
        <div className="absolute inset-0 overflow-y-auto">
          <div className="grid grid-cols-2 content-start gap-2 p-3 pt-2">
            {regionUsages.map((u) => (
              <MemoryCard key={`${u.region.kind}-${u.region.start}`} usage={u} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
