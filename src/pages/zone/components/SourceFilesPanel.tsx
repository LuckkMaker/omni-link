import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useZoneStore } from '../store'
import { useSessionReady } from '../hooks'
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
 * 顶部搜索框按文件名 / 路径即时过滤（客户端，无后端请求）；
 * 点击表头可排序，拖拽表头右边框可调整列宽；点击行后主窗口显示对应源码。
 * 标题栏由外层 tab 提供，本组件仅渲染搜索框 + 表格内容。
 */
export function SourceFilesPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const sourceFiles = useZoneStore((s) => s.sourceFiles)
  const activeSourceFile = useZoneStore((s) => s.activeSourceFile)
  const openSourceFile = useZoneStore((s) => s.openSourceFile)
  const [filter, setFilter] = useState('')
  // 源码文件列表仅依赖 ELF 符号，用 elfLoaded 提前展示，无需等待目标连接/会话启动
  const { elfLoaded } = useSessionReady(uid, connected)

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

  // 客户端过滤：按文件名 / 路径（大小写不敏感）
  const kw = filter.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!kw) return sorted
    return sorted.filter((f) => f.name.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw))
  }, [sorted, kw])

  if (!elfLoaded) {
    return <div className="h-full min-h-0" />
  }

  if (sourceFiles.length === 0) {
    return <div className="h-full min-h-0" />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 过滤输入框 */}
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files..."
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      {/* 文件表 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">{kw ? `无匹配「${filter.trim()}」的文件` : ''}</div>
        ) : (
          <>
            {/* 表头（sticky，点击排序 / 拖拽调宽） */}
            <div className="sticky top-0 z-10 grid min-w-max border-b border-border" style={{ gridTemplateColumns: template }}>
              {columns.map((c) => (
                <TableHeaderCell key={c.key} col={c as ColumnDef<unknown>} sort={sort} onSort={toggle} onResize={startResize} />
              ))}
            </div>
            {filtered.map((f) => {
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
          </>
        )}
      </div>
    </div>
  )
}