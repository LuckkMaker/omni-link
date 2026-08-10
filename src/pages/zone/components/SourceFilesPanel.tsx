import { useMemo } from 'react'
import { FolderOpen } from 'lucide-react'
import { useZoneStore } from '../store'
import { cn } from '@/lib/utils'
import { gridColumns, TableHeaderCell, useColumnResize, useColumnSort, type ColumnDef } from './sortableTable'
import type { SourceFileInfo } from '@/services/zone.service'

/** 字节数 → 可读大小 */
function formatSize(size: number | null | undefined): string {
  if (size === null || size === undefined) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * 左侧源码文件窗：File / Size / Path 三栏表格布局（紧凑多列横向展示）。
 * 点击表头可排序，拖拽表头右边框可调整列宽；点击行后主窗口显示对应源码。
 * 标题栏由外层 tab 提供，本组件仅渲染表格内容。
 */
export function SourceFilesPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const sourceFiles = useZoneStore((s) => s.sourceFiles)
  const activeSourceFile = useZoneStore((s) => s.activeSourceFile)
  const openSourceFile = useZoneStore((s) => s.openSourceFile)

  const columns = useMemo<ColumnDef<SourceFileInfo>[]>(
    () => [
      {
        key: 'name',
        label: 'File',
        width: 200,
        minWidth: 80,
        sortValue: (f) => f.name,
        cell: (f) => f.name,
        cellClassName: (f) => cn('min-w-0 truncate font-medium', f.path === activeSourceFile && 'text-primary'),
      },
      {
        key: 'size',
        label: 'Size',
        width: 90,
        minWidth: 60,
        // 无行号文件 size 为 null，按 0 参与排序
        sortValue: (f) => f.size ?? 0,
        cell: (f) => <span className="font-mono text-xs">{formatSize(f.size)}</span>,
      },
      {
        key: 'path',
        label: 'Path',
        width: 320,
        minWidth: 120,
        sortValue: (f) => f.path,
        cell: (f) => f.path,
        cellClassName: () => 'min-w-0 truncate text-[10px]',
      },
    ],
    [activeSourceFile]
  )

  const { sorted, sort, toggle } = useColumnSort(sourceFiles, columns, 'name')
  const { widths, startResize } = useColumnResize(columns)
  const template = gridColumns(columns, widths)

  if (!connected) {
    return <div className="h-full min-h-0" />
  }

  if (sourceFiles.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <FolderOpen className="size-6 opacity-50" />
        <span>未加载 ELF 或 ELF 无 DWARF 源码信息</span>
        <span className="text-[10px] opacity-70">点击工具栏「Start Session」导入</span>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-auto">
      {/* 表头（sticky，点击排序 / 拖拽调宽） */}
      <div className="sticky top-0 z-10 grid min-w-max border-b border-border" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <TableHeaderCell key={c.key} col={c as ColumnDef<unknown>} sort={sort} onSort={toggle} onResize={startResize} />
        ))}
      </div>
      {sorted.map((f) => {
        const isActive = f.path === activeSourceFile
        return (
          <div
            key={f.path}
            onClick={() => openSourceFile(f.path)}
            title={f.path}
            className={cn(
              'grid min-w-max cursor-pointer border-b border-border text-xs transition-colors',
              isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
            )}
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((c) => (
              <div
                key={c.key}
                className={cn('min-w-0 whitespace-nowrap border-r border-border px-2 py-1 last:border-r-0', c.cellClassName?.(f))}
              >
                {c.cell(f)}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}