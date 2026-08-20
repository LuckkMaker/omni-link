import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { JLinkDeviceInfo } from '@shared/types'

/** 列网格：制造商 / 设备 / Flash / RAM（表头、筛选行、数据行共用，保证对齐） */
const GRID_CLS = 'grid grid-cols-[20%_42%_19%_19%]'
/** 数据行估算高度（px），用于虚拟滚动布局 */
const ROW_HEIGHT = 34
/** 过滤结果上限，避免极端情况下渲染过多 */
const MAX_RESULTS = 1000

/** 字节 → 可读容量（J-Link 设备的 Flash/RAM 以字节计） */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

interface JLinkDeviceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** J-Link 设备库全量列表 */
  devices: JLinkDeviceInfo[]
  /** 加载中（设备库尚未就绪） */
  loading?: boolean
  /** 当前已选设备名（打开时用于高亮初始项） */
  value: string
  /** 确认选择设备名 */
  onConfirm: (name: string) => void
}

/**
 * 模态窗口选择 J-Link 设备名（约 1 万条）。
 * 设计风格与「选择目标设备」弹窗一致：sticky 表头 + 逐列筛选输入行 + 双击确认 + 底部提示；
 * 数据体量过大，用虚拟滚动只渲染可视行；未输入筛选时直接显示全部设备。
 */
export function JLinkDeviceDialog({
  open,
  onOpenChange,
  devices,
  loading = false,
  value,
  onConfirm,
}: JLinkDeviceDialogProps) {
  const [filters, setFilters] = useState({ manu: '', name: '', flash: '', ram: '' })
  const [selected, setSelected] = useState(value)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setSelected(value)
      setFilters({ manu: '', name: '', flash: '', ram: '' })
    }
  }, [open, value])

  const updateFilter = (key: keyof typeof filters, v: string) =>
    setFilters((prev) => ({ ...prev, [key]: v }))

  const { matchedCount, items } = useMemo(() => {
    const mf = filters.manu.trim().toLowerCase()
    const nf = filters.name.trim().toLocaleLowerCase()
    const ff = filters.flash.trim().toLowerCase().replace(/\s+/g, ' ')
    const rf = filters.ram.trim().toLowerCase().replace(/\s+/g, ' ')

    let list = devices
    if (mf) list = list.filter((d) => d.manufacturer.toLowerCase().includes(mf))
    if (ff) list = list.filter((d) => fmtBytes(d.flash_size).toLowerCase().includes(ff))
    if (rf) list = list.filter((d) => fmtBytes(d.ram_size).toLowerCase().includes(rf))

    if (!nf) {
      // 未筛设备名：按制造商排序，便于同品牌设备聚拢
      const sorted = [...list].sort((a, b) =>
        a.manufacturer.localeCompare(b.manufacturer) || a.name.localeCompare(b.name)
      )
      return { matchedCount: sorted.length, items: sorted.slice(0, MAX_RESULTS) }
    }

    // 设备名筛选：精确命中 > 前缀命中 > 包含命中，忽略大小写
    const uq = nf.toUpperCase()
    const scored: { d: JLinkDeviceInfo; rank: number }[] = []
    for (const d of list) {
      const n = d.name.toUpperCase()
      let rank = -1
      if (n === uq) rank = 0
      else if (n.startsWith(uq)) rank = 1
      else if (n.includes(uq)) rank = 2
      if (rank !== -1) scored.push({ d, rank })
    }
    scored.sort((a, b) => a.rank - b.rank || a.d.name.localeCompare(b.d.name))
    return {
      matchedCount: scored.length,
      items: scored.slice(0, MAX_RESULTS).map((x) => x.d),
    }
  }, [devices, filters])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  const commit = (name: string) => {
    onConfirm(name)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>选择 JLink 设备名</DialogTitle>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="max-h-96 overflow-auto rounded-md border border-border"
        >
          {/* sticky 表头：标题行 + 筛选输入行 */}
          <div className="sticky top-0 z-10">
            <div className={cn(GRID_CLS, 'bg-muted text-sm font-medium')}>
              <span className="border-b border-r border-border px-2 py-2">制造商</span>
              <span className="border-b border-r border-border px-2 py-2">设备</span>
              <span className="border-b border-r border-border px-2 py-2 text-center">Flash</span>
              <span className="border-b border-border px-2 py-2 text-center">RAM</span>
            </div>
            <div className={cn(GRID_CLS, 'bg-muted')}>
              <FilterInput
                value={filters.manu}
                onChange={(v) => updateFilter('manu', v)}
                placeholder="制造商…"
                align="left"
              />
              <FilterInput
                value={filters.name}
                onChange={(v) => updateFilter('name', v)}
                placeholder="设备名…"
                align="left"
              />
              <FilterInput
                value={filters.flash}
                onChange={(v) => updateFilter('flash', v)}
                placeholder="Flash…"
                align="center"
              />
              <FilterInput
                value={filters.ram}
                onChange={(v) => updateFilter('ram', v)}
                placeholder="RAM…"
                align="center"
              />
            </div>
          </div>

          {/* 虚拟滚动数据区 */}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">无匹配设备</div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const d = items[vi.index]
                return (
                  <div
                    key={vi.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: vi.size,
                      transform: `translateY(${vi.start}px)`,
                    }}
                    onClick={() => setSelected(d.name)}
                    onDoubleClick={() => commit(d.name)}
                    className={cn(
                      GRID_CLS,
                      'cursor-pointer items-center border-b border-border/50 text-sm transition-colors',
                      selected === d.name ? 'bg-primary/20' : 'hover:bg-muted/30'
                    )}
                  >
                    <span className="truncate border-r border-border/50 px-3 py-1.5">
                      {d.manufacturer}
                    </span>
                    <span className="truncate border-r border-border/50 px-3 py-1.5 font-mono">
                      {d.name}
                    </span>
                    <span className="border-r border-border/50 px-2 py-1.5 text-center tabular-nums">
                      {fmtBytes(d.flash_size)}
                    </span>
                    <span className="truncate px-2 py-1.5 text-center tabular-nums">
                      {fmtBytes(d.ram_size)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">双击设备行选中，点击窗口外取消</p>
          <span className="text-xs text-muted-foreground">
            {loading ? '—' : `共 ${matchedCount} / ${devices.length} 个设备`}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 列筛选输入框（与目标设备表的列筛选一致；点击/键入不冒泡，避免误触选中） */
function FilterInput({
  value,
  onChange,
  placeholder,
  align,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  align: 'left' | 'center'
}) {
  return (
    <div className="border-r border-border px-1.5 py-1 last:border-r-0">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn('h-7 text-xs', align === 'center' && 'text-center')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  )
}