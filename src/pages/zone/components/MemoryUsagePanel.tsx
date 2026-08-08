import { useEffect, useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { zoneMemoryUsage, type MemoryUsage } from '@/services/zone.service'
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

/** 单条用量横条（Flash/RAM） */
function UsageBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-xs font-medium">{label}</span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-40 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
        {fmtBytes(value)} / {fmtBytes(max)}
      </span>
    </div>
  )
}

/**
 * 底部 Memory Usage tab：ELF section 近似估算的 Flash/RAM 占用 + section 明细表。
 * 默认 flash 上限 2MB、ram 上限 512KB（可随实际调整），用于进度条可视化。
 */
export function MemoryUsagePanel({ uid }: { uid: string | null }) {
  const [usage, setUsage] = useState<MemoryUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!uid) {
      setUsage(null)
      setError(null)
      return
    }
    setLoading(true)
    try {
      setUsage(await zoneMemoryUsage(uid))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed')
      setUsage(null)
    } finally {
      setLoading(false)
    }
  }, [uid])

  useEffect(() => {
    void load()
  }, [load])

  const FLASH_MAX = 2 * 1024 * 1024
  const RAM_MAX = 512 * 1024

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2">
      <div className="flex shrink-0 items-center gap-2">
        <UsageBar label="Flash" value={usage?.flash_used ?? 0} max={FLASH_MAX} color="bg-sky-500" />
        <UsageBar label="RAM" value={usage?.ram_used ?? 0} max={RAM_MAX} color="bg-amber-500" />
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

      <div className="min-h-0 flex-1 overflow-auto pt-2">
        {error ? (
          <div className="flex h-full items-center justify-center text-xs text-red-500">{error}</div>
        ) : !uid || !usage ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {uid ? '未加载 ELF' : '未连接探针'}
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="sticky top-0 z-10 bg-card px-2 py-1 font-medium">Section</th>
                <th className="sticky top-0 z-10 bg-card px-2 py-1 text-right font-medium">Address</th>
                <th className="sticky top-0 z-10 bg-card px-2 py-1 text-right font-medium">Size</th>
                <th className="sticky top-0 z-10 bg-card px-2 py-1 text-center font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {usage.sections.map((sec) => (
                <tr key={sec.name} className="text-xs hover:bg-accent">
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{sec.name}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
                    {fmtAddr(sec.address)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
                    {fmtBytes(sec.size)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-center text-[10px]">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 font-medium',
                        sec.flash ? 'bg-sky-500/15 text-sky-600' : 'bg-amber-500/15 text-amber-600'
                      )}
                    >
                      {sec.flash ? 'FLASH' : 'RAM'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}