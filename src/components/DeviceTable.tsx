import { useState, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { totalRamKb, ramRegionsTooltip } from '@/lib/device-utils'
import type { DeviceInfo } from '@shared/types'

/** 格式化 Flash/RAM 大小：KB → 可读字符串 */
export function formatSize(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`
  return `${kb} KB`
}

/** 设备来源的展示标签与配色 */
const SOURCE_META: Record<DeviceInfo['source'], { label: string; cls: string }> = {
  builtin: { label: '内置', cls: 'text-sky-700 bg-sky-100' },
  pack: { label: 'Pack', cls: 'text-muted-foreground bg-muted' },
  flm: { label: 'FLM', cls: 'text-violet-700 bg-violet-100' },
}

const SOURCE_FILTER_OPTIONS: { value: '' | DeviceInfo['source']; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'builtin', label: '内置' },
  { value: 'pack', label: 'Pack' },
  { value: 'flm', label: 'FLM' },
]

/** 列筛选输入框 */
function ColumnFilter({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
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

/** 来源筛选下拉 */
function SourceFilter({
  value,
  onChange,
}: {
  value: '' | DeviceInfo['source']
  onChange: (v: '' | DeviceInfo['source']) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange((e.target.value || '') as '' | DeviceInfo['source'])}
      onClick={(e) => e.stopPropagation()}
      className="h-7 w-full rounded-md border border-input bg-background px-1 text-xs text-center"
    >
      {SOURCE_FILTER_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

interface DeviceTableProps {
  /** 设备列表 */
  devices: DeviceInfo[]
  /** 加载中 */
  loading?: boolean
  /** 是否可选（启用点击选中 + 高亮） */
  selectable?: boolean
  /** 当前选中的 part_number */
  selectedPartNumber?: string | null
  /** 选中回调 */
  onSelect?: (partNumber: string) => void
  /** 确认回调（双击触发） */
  onConfirm?: (partNumber: string) => void
  /** 最大高度（CSS 值） */
  maxHeight?: string
  /** 是否显示列筛选 */
  showFilters?: boolean
  /** 是否显示底部计数 */
  showCount?: boolean
}

export function DeviceTable({
  devices,
  loading = false,
  selectable = false,
  selectedPartNumber,
  onSelect,
  onConfirm,
  maxHeight = 'max-h-96',
  showFilters = true,
  showCount = true,
}: DeviceTableProps) {
  const [filters, setFilters] = useState<{
    vendor: string
    device: string
    core: string
    source: '' | DeviceInfo['source']
    flash: string
    ram: string
  }>({
    vendor: '',
    device: '',
    core: '',
    source: '',
    flash: '',
    ram: '',
  })

  const updateFilter = (key: keyof typeof filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const filtered = useMemo(() => {
    return devices.filter((d) => {
      if (filters.vendor && !d.vendor.toLowerCase().includes(filters.vendor.toLowerCase())) return false
      if (filters.device && !d.display_name.toLowerCase().includes(filters.device.toLowerCase())) return false
      if (filters.core && !d.core.toLowerCase().includes(filters.core.toLowerCase())) return false
      if (filters.source && d.source !== filters.source) return false
      if (filters.flash && !formatSize(d.flash_size).toLowerCase().includes(filters.flash.toLowerCase())) return false
      const ramKb = totalRamKb(d.ram_regions, d.ram_size)
      if (filters.ram && !formatSize(ramKb).toLowerCase().includes(filters.ram.toLowerCase())) return false
      return true
    })
  }, [devices, filters])

  return (
    <div className="flex flex-col gap-2">
      <div className={cn('overflow-auto rounded-md border border-border', maxHeight)}>
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10">
            {/* 表头行 — 用 div 包裹确保不透明背景覆盖 */}
            <tr className="bg-muted">
              <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[22%]">制造商</th>
              <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[24%]">设备</th>
              <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[12%]">来源</th>
              <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[12%]">内核</th>
              <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[15%]">Flash</th>
              <th className="border-b border-border px-2 py-2 text-center font-medium w-[15%]">RAM</th>
            </tr>
            {/* 筛选输入行 */}
            {showFilters && (
              <tr className="bg-muted">
                <th className="border-b border-r border-border px-1.5 py-1">
                  <ColumnFilter value={filters.vendor} onChange={(v) => updateFilter('vendor', v)} />
                </th>
                <th className="border-b border-r border-border px-1.5 py-1">
                  <ColumnFilter value={filters.device} onChange={(v) => updateFilter('device', v)} />
                </th>
                <th className="border-b border-r border-border px-1.5 py-1">
                  <SourceFilter value={filters.source} onChange={(v) => updateFilter('source', v)} />
                </th>
                <th className="border-b border-r border-border px-1.5 py-1">
                  <ColumnFilter value={filters.core} onChange={(v) => updateFilter('core', v)} />
                </th>
                <th className="border-b border-r border-border px-1.5 py-1">
                  <ColumnFilter value={filters.flash} onChange={(v) => updateFilter('flash', v)} />
                </th>
                <th className="border-b border-border px-1.5 py-1">
                  <ColumnFilter value={filters.ram} onChange={(v) => updateFilter('ram', v)} />
                </th>
              </tr>
            )}
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto size-4 animate-spin" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  无匹配设备
                </td>
              </tr>
            ) : (
              filtered.map((d) => {
                const src = SOURCE_META[d.source] ?? SOURCE_META.pack
                return (
                  <tr
                    key={d.part_number}
                    onClick={selectable && onSelect ? () => onSelect(d.part_number) : undefined}
                    onDoubleClick={selectable && onConfirm ? () => onConfirm(d.part_number) : undefined}
                    className={cn(
                      'border-b border-border/50 transition-colors',
                      selectable && 'cursor-pointer',
                      selectable && selectedPartNumber === d.part_number
                        ? 'bg-primary/20'
                        : 'hover:bg-muted/30'
                    )}
                  >
                    <td className="border-r border-border/50 px-3 py-2 text-center">
                      <span className="inline-block w-full truncate align-middle" title={d.vendor}>{d.vendor}</span>
                    </td>
                    <td className="border-r border-border/50 px-3 py-2 text-center font-medium">{d.display_name}</td>
                    <td className="border-r border-border/50 px-3 py-2 text-center">
                      <span
                        className={cn(
                          'inline-block rounded-full px-2 py-0.5 text-[10px] leading-none',
                          src.cls
                        )}
                      >
                        {src.label}
                      </span>
                    </td>
                    <td className="border-r border-border/50 px-3 py-2 text-center text-muted-foreground">{d.core}</td>
                    <td className="border-r border-border/50 px-3 py-2 text-center tabular-nums">{formatSize(d.flash_size)}</td>
                    <td
                      className="px-3 py-2 text-center tabular-nums"
                      title={ramRegionsTooltip(d.ram_regions)}
                    >
                      {formatSize(totalRamKb(d.ram_regions, d.ram_size))}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {showCount && (
        <div className="flex items-center justify-end">
          <span className="text-xs text-muted-foreground">
            共 {loading ? '—' : filtered.length} / {devices.length} 个设备
          </span>
        </div>
      )}
    </div>
  )
}