import { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: string
  dir: SortDir
}

export interface ColumnDef<T> {
  key: string
  label: React.ReactNode
  align?: 'left' | 'right' | 'center'
  /** 排序取值函数；返回 null 表示该列不可排序 */
  sortValue?: (row: T) => string | number | null
  /** 默认初始宽度（px），配合表头拖拽调整 */
  width?: number
  minWidth?: number
  cell: (row: T) => React.ReactNode
  cellClassName?: (row: T) => string
}

/**
 * 表头排序：点击循环 asc → desc → 取消。
 * 数值列按数值比较，文本列按 locale 比较（数字感知 + 忽略大小写）。
 */
export function useColumnSort<T>(rows: T[], columns: ColumnDef<T>[], initialKey?: string) {
  const [sort, setSort] = useState<SortState | null>(initialKey ? { key: initialKey, dir: 'asc' } : null)
  const toggle = useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }, [])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const sv = col.sortValue
    return [...rows].sort((a, b) => {
      const va = sv(a)
      const vb = sv(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      const r =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' })
      return sort.dir === 'asc' ? r : -r
    })
  }, [rows, columns, sort])

  return { sorted, sort, toggle }
}

/**
 * 表头拖拽调整列宽：拖拽列右侧边框手柄，实时更新该列宽度。
 * 列宽以 px 存储，超出容器宽度时由外层 overflow-auto 横向滚动。
 */
export function useColumnResize<T>(columns: ColumnDef<T>[]) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const c of columns) if (c.width) init[c.key] = c.width
    return init
  })
  const dragRef = useRef<{ key: string; startX: number; startW: number; minW: number } | null>(null)

  const startResize = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (dragRef.current) return
      const col = columns.find((c) => c.key === key)
      dragRef.current = {
        key,
        startX: e.clientX,
        startW: widths[key] ?? col?.width ?? 120,
        minW: col?.minWidth ?? 60,
      }
      const onMove = (ev: MouseEvent) => {
        const d = dragRef.current
        if (!d) return
        // 取整到整数像素，避免子像素坐标导致滚动时边框抗锯齿抖动
        setWidths((w) => ({
          ...w,
          [d.key]: Math.max(d.minW, Math.round(d.startW + ev.clientX - d.startX)),
        }))
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [columns, widths]
  )

  return { widths, startResize }
}

/** 合成 grid-template-columns（所有列可调整，超出时横向滚动） */
export function gridColumns<T>(columns: ColumnDef<T>[], widths: Record<string, number>): string {
  return columns.map((c) => `${widths[c.key] ?? c.width ?? 120}px`).join(' ')
}

interface HeaderCellProps {
  col: ColumnDef<unknown>
  sort: SortState | null
  onSort: (key: string) => void
  onResize: (key: string, e: React.MouseEvent) => void
}

/** 表头单元格：排序指示 + 右侧拖拽调宽手柄 */
export function TableHeaderCell({ col, sort, onSort, onResize }: HeaderCellProps) {
  const sortable = col.sortValue != null
  const align = col.align ?? 'left'
  return (
    <div
      className={cn(
        'relative select-none whitespace-nowrap border-r border-border bg-card px-2 py-1 text-[10px] font-medium uppercase tracking-wide last:border-r-0',
        sortable ? 'cursor-pointer hover:bg-accent' : '',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        col.headerClassName
      )}
      onClick={sortable ? () => onSort(col.key) : undefined}
    >
      <span className="inline-flex items-center gap-1">
        {col.label}
        {sortable &&
          (sort?.key === col.key ? (
            sort.dir === 'asc' ? (
              <ArrowUp className="size-3 shrink-0" />
            ) : (
              <ArrowDown className="size-3 shrink-0" />
            )
          ) : (
            <ArrowUpDown className="size-3 shrink-0 opacity-40" />
          ))}
      </span>
      <span
        className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize hover:bg-primary/20"
        onMouseDown={(e) => onResize(col.key, e)}
        onClick={(e) => e.stopPropagation()}
        title="拖拽调整列宽"
      />
    </div>
  )
}