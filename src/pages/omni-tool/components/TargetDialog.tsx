import { useMemo, useState } from 'react'
import { CircleAlert, FileCode2, Package, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useFlasherStore } from '../flasher.store'

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

const STATUS_OPTIONS: { value: '' | 'available' | 'reserved'; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'available', label: '可用' },
  { value: 'reserved', label: '预留' },
]

/** 列筛选输入框（与设备表一致） */
function ColumnFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="筛选..."
      className="h-7 w-full text-xs text-center"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    />
  )
}

/**
 * 目标芯片选择对话框：芯片 + FLM 来源（内置 / 外部文件）。
 *
 * 选择窗口参考「连接时选择目标芯片」的样式——可筛选的表格，点击高亮、双击确认。
 *
 * 当前固件只内置了 stm32f407ig 的 FLM（`FLASHER_PLAN` 阶段 B 在线下发 FLM 未实现），
 * 所以外部 FLM 入口先占位并明确标注暂不可用 —— 不做假实现，避免用户选了却不生效。
 */
export function TargetDialog() {
  const show = useFlasherStore((s) => s.showTargetDialog)
  const targets = useFlasherStore((s) => s.targets)
  const targetId = useFlasherStore((s) => s.targetId)
  const flmSource = useFlasherStore((s) => s.flmSource)
  const flmName = useFlasherStore((s) => s.flmName)
  const setTarget = useFlasherStore((s) => s.setTarget)
  const closeTargetDialog = useFlasherStore((s) => s.closeTargetDialog)
  const pickFlmFile = useFlasherStore((s) => s.pickFlmFile)
  const clearFlmFile = useFlasherStore((s) => s.clearFlmFile)

  const [selected, setSelected] = useState<string>(targetId)
  const [filters, setFilters] = useState({
    name: '',
    start: '',
    end: '',
    size: '',
    status: '' as '' | 'available' | 'reserved',
  })

  const updateFilter = (key: keyof typeof filters, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }))

  const rows = useMemo(
    () =>
      targets.map((t) => ({
        target: t,
        start: t.available ? formatHex(t.flashBase) : '—',
        end: t.available ? formatHex(t.flashEnd) : '—',
        size: t.available ? formatSize(t.flashEnd - t.flashBase) : '—',
      })),
    [targets]
  )

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (filters.name && !r.target.name.toLowerCase().includes(filters.name.toLowerCase())) return false
        if (filters.start && !r.start.toLowerCase().includes(filters.start.toLowerCase())) return false
        if (filters.end && !r.end.toLowerCase().includes(filters.end.toLowerCase())) return false
        if (filters.size && !r.size.toLowerCase().includes(filters.size.toLowerCase())) return false
        if (filters.status === 'available' && !r.target.available) return false
        if (filters.status === 'reserved' && r.target.available) return false
        return true
      }),
    [rows, filters]
  )

  const handleConfirm = (id: string) => setTarget(id)

  return (
    <Dialog open={show} onOpenChange={(o) => !o && closeTargetDialog()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>选择目标芯片</DialogTitle>
        </DialogHeader>

        {/* 芯片列表（双击设备行选中，与连接时的目标设备选择窗口一致） */}
        <div className="overflow-auto rounded-md border border-border max-h-80">
          <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted">
                <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[26%]">型号</th>
                <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[18%]">Flash 起始</th>
                <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[18%]">Flash 结束</th>
                <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[16%]">容量</th>
                <th className="border-b border-border px-2 py-2 text-center font-medium w-[22%]">状态</th>
              </tr>
              <tr className="bg-muted">
                <th className="border-b border-r border-border px-1.5 py-1">
                  <ColumnFilter value={filters.name} onChange={(v) => updateFilter('name', v)} />
                </th>
                <th className="border-b border-r border-border px-1.5 py-1">
                  <ColumnFilter value={filters.start} onChange={(v) => updateFilter('start', v)} />
                </th>
                <th className="border-b border-r border-border px-1.5 py-1">
                  <ColumnFilter value={filters.end} onChange={(v) => updateFilter('end', v)} />
                </th>
                <th className="border-b border-r border-border px-1.5 py-1">
                  <ColumnFilter value={filters.size} onChange={(v) => updateFilter('size', v)} />
                </th>
                <th className="border-b border-border px-1.5 py-1">
                  <select
                    value={filters.status}
                    onChange={(e) => updateFilter('status', e.target.value as '' | 'available' | 'reserved')}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 w-full rounded-md border border-input bg-background px-1 text-xs text-center"
                  >
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    无匹配芯片
                  </td>
                </tr>
              ) : (
                filtered.map(({ target: t, start, end, size }) => (
                  <tr
                    key={t.id}
                    onClick={t.available ? () => setSelected(t.id) : undefined}
                    onDoubleClick={t.available ? () => handleConfirm(t.id) : undefined}
                    title={t.unavailableReason}
                    className={cn(
                      'border-b border-border/50 transition-colors',
                      t.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-55',
                      t.available && selected === t.id ? 'bg-primary/20' : t.available && 'hover:bg-muted/30'
                    )}
                  >
                    <td className="border-r border-border/50 px-3 py-2 text-center font-medium">{t.name}</td>
                    <td className="border-r border-border/50 px-3 py-2 text-center font-mono text-muted-foreground">{start}</td>
                    <td className="border-r border-border/50 px-3 py-2 text-center font-mono text-muted-foreground">{end}</td>
                    <td className="border-r border-border/50 px-3 py-2 text-center tabular-nums">{size}</td>
                    <td className="px-3 py-2 text-center">
                      {t.available ? (
                        <Badge variant="outline" className="gap-1">
                          <Package className="size-3" />
                          内置 FLM
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          预留
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">双击芯片行选中，点击窗口外取消</p>
          <span className="text-xs text-muted-foreground">共 {filtered.length} / {targets.length} 个</span>
        </div>

        <Separator />

        {/* FLM 来源 */}
        <div className="space-y-2">
          <div className="text-xs font-medium">FLM 来源</div>

          {/* 内置 */}
          <div
            className={cn(
              'flex items-center gap-2 rounded-md border px-3 py-2',
              flmSource === 'builtin' ? 'border-primary bg-primary/5' : 'border-border'
            )}
          >
            <Package className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">内置 FLM</div>
              <div className="text-[11px] text-muted-foreground">固件内部硬编码，开箱即用</div>
            </div>
            {flmSource === 'builtin' ? (
              <Badge variant="outline" className="shrink-0 text-[10px]">当前使用</Badge>
            ) : null}
          </div>

          {/* 外部文件（预留） */}
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 opacity-70">
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <span>外部 .FLM 文件</span>
                <Badge variant="outline" className="text-[10px]">暂不可用</Badge>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {flmName ? flmName : '需固件支持在线下发 FLM（FLASHER_PLAN 阶段 B）'}
              </div>
            </div>
            {flmSource === 'file' ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0"
                title="清除已选 FLM"
                onClick={clearFlmFile}
              >
                <X className="size-3.5" />
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-xs"
                title="固件暂不支持在线下发 FLM，可先选择以记录路径"
                onClick={() => void pickFlmFile()}
              >
                <FileCode2 className="size-3" />
                选择
              </Button>
            )}
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          烧错目标会擦除该芯片的 Flash，无法恢复。操作前请核对丝印型号与 SWD 接线。
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={closeTargetDialog}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
