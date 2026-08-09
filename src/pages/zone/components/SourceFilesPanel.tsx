import { useMemo } from 'react'
import { FolderOpen } from 'lucide-react'
import { useZoneStore } from '../store'
import { cn } from '@/lib/utils'

/** 字节数 → 可读大小 */
function formatSize(size: number | null | undefined): string {
  if (size === null || size === undefined) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * 左侧源码文件窗：File / Size / Path 三栏表格布局（紧凑多列横向展示）。
 * 点击行后主窗口显示对应源码。标题栏由外层 tab 提供，本组件仅渲染表格内容。
 */
export function SourceFilesPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const sourceFiles = useZoneStore((s) => s.sourceFiles)
  const activeSourceFile = useZoneStore((s) => s.activeSourceFile)
  const openSourceFile = useZoneStore((s) => s.openSourceFile)

  // 按文件名首字母排序（忽略大小写），保证列表顺序稳定可寻
  const sortedFiles = useMemo(
    () => [...sourceFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [sourceFiles]
  )

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
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="sticky top-0 z-10 bg-card px-2 py-1 font-medium">File</th>
            <th className="sticky top-0 z-10 bg-card px-2 py-1 text-right font-medium">Size</th>
            <th className="sticky top-0 z-10 bg-card px-2 py-1 font-medium">Path</th>
          </tr>
        </thead>
        <tbody>
          {sortedFiles.map((f) => {
            const isActive = f.path === activeSourceFile
            return (
              <tr
                key={f.path}
                onClick={() => openSourceFile(f.path)}
                title={f.path}
                className={cn(
                  'cursor-pointer text-xs transition-colors',
                  isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                )}
              >
                <td className={cn('whitespace-nowrap px-2 py-1 font-medium', isActive && 'text-primary')}>
                  {f.name}
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
                  {formatSize(f.size)}
                </td>
                <td className="max-w-0 truncate px-2 py-1 text-[10px] text-muted-foreground/70">
                  {f.path}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}