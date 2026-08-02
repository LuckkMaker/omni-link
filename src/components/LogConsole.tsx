import { useEffect, useRef, useCallback } from 'react'
import { Terminal, Trash2, Download, ChevronUp, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNotificationStore } from '@/stores/notification.store'
import { cn } from '@/lib/utils'
import type { LogEvent } from '@shared/types'

const levelColor: Record<LogEvent['level'], string> = {
  info: 'text-foreground',
  warning: 'text-yellow-500',
  error: 'text-red-500',
}

const levelTag: Record<LogEvent['level'], string> = {
  info: 'INFO',
  warning: 'WARN',
  error: 'ERR ',
}

function formatTime(ts: string | number): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  } catch {
    return String(ts)
  }
}

interface LogConsoleProps {
  logs: LogEvent[]
  onClear: () => void
  title?: string
}

/** 共享日志控制台组件，可被 Flash / RTT / Commander 等页面复用 */
export function LogConsole({ logs, onClear, title = '日志' }: LogConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  // Ctrl+A 全选日志区内所有文本
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault()
      const el = scrollRef.current
      if (!el) return
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  }, [])

  // Ctrl+C 复制选中文本
  const handleCopy = useCallback((e: React.ClipboardEvent) => {
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) return
    e.preventDefault()
    const lastLog = logs[logs.length - 1]
    if (lastLog) {
      e.clipboardData.setData('text/plain', `[${formatTime(lastLog.timestamp)}] [${levelTag[lastLog.level].trim()}] ${lastLog.message}`)
    }
  }, [logs])

  const handleSave = async () => {
    if (logs.length === 0) return
    // 文件名用本地时间（toISOString 是 UTC，会比系统时间少 8 小时）
    const now = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    const savePath = await window.electron?.saveFileDialog?.(`log_${ts}.log`)
    if (!savePath) return

    const content = logs.map((log) =>
      `[${formatTime(log.timestamp)}] [${levelTag[log.level].trim()}] ${log.message}`
    ).join('\n')

    const base64 = btoa(unescape(encodeURIComponent(content)))
    const { api } = await import('@/services/api')
    const client = await api()
    await client.post('/api/files/save', { file_path: savePath, data: base64 })

    useNotificationStore.getState().push({
      type: 'success',
      title: '日志已保存',
      message: savePath.split(/[\\/]/).pop() ?? savePath,
      autoClose: true,
      autoCloseDelay: 3000,
    })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-border">
        <Terminal className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{title}</span>
        {logs.length > 0 && (
          <span className="text-[10px] text-muted-foreground">({logs.length})</span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSave}
            disabled={logs.length === 0}
            className="h-6 w-6 p-0"
            title="保存日志"
          >
            <Download className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={logs.length === 0}
            className="h-6 w-6 p-0"
            title="清除日志"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onCopy={handleCopy}
          className="h-full overflow-y-auto px-3 pb-2 font-mono text-xs leading-relaxed outline-none"
        >
          {logs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              暂无日志
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="flex gap-2 py-0.5">
                <span className="shrink-0 text-muted-foreground/60">{formatTime(log.timestamp)}</span>
                <span className={cn('shrink-0 font-bold', levelColor[log.level])}>
                  [{levelTag[log.level]}]
                </span>
                <span className={levelColor[log.level]}>{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** 拖拽分隔条组件，支持垂直/水平方向 + 双击折叠/展开
 *
 *  折叠态（onToggle 存在且 expanded===false）升级为可见把手：
 *  - 尺寸加粗（8px）+ 浅色背景，在页面中可见
 *  - 中间把手条加宽，颜色更明显
 *  - 叠加方向箭头图标，提示展开方向
 *  - tooltip 提示"双击展开"
 *  展开态保持原 1.5px 细条样式，低视觉干扰。
 */
export function ResizeHandle({
  onResize,
  onToggle,
  expanded,
  direction = 'vertical',
}: {
  onResize: (delta: number) => void
  onToggle?: () => void
  expanded?: boolean
  direction?: 'vertical' | 'horizontal'
}) {
  const dragging = useRef(false)
  const lastPos = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    lastPos.current = direction === 'vertical' ? e.clientY : e.clientX
    document.body.style.cursor = direction === 'vertical' ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
  }, [direction])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const currentPos = direction === 'vertical' ? e.clientY : e.clientX
      const delta = currentPos - lastPos.current
      lastPos.current = currentPos
      onResize(delta)
    }
    const handleMouseUp = () => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [onResize, direction])

  const isVertical = direction === 'vertical'
  // 折叠态判定：有 onToggle 且明确 expanded===false 才算折叠（无 onToggle 时按展开态样式）
  const isCollapsed = onToggle !== undefined && expanded === false
  const toggleTitle = onToggle
    ? (isCollapsed
        ? (isVertical ? '双击展开日志区' : '双击展开侧栏')
        : (isVertical ? '双击隐藏日志区' : '双击隐藏侧栏'))
    : undefined

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={onToggle}
      title={toggleTitle}
      className={cn(
        'group relative flex shrink-0 items-center justify-center transition-colors',
        isVertical
          ? (isCollapsed
              ? 'h-2 w-full cursor-row-resize bg-muted/60 hover:bg-primary/15'
              : 'h-1.5 w-full cursor-row-resize hover:bg-primary/20')
          : (isCollapsed
              ? 'h-full w-2 cursor-col-resize bg-muted/60 hover:bg-primary/15'
              : 'h-full w-1.5 cursor-col-resize hover:bg-primary/20')
      )}
    >
      {/* 把手条 */}
      <div className={cn(
        'rounded-full transition-colors',
        isVertical
          ? (isCollapsed
              ? 'h-1 w-12 bg-primary/50 group-hover:bg-primary/70'
              : 'h-0.5 w-8 bg-border group-hover:bg-primary/40')
          : (isCollapsed
              ? 'w-1 h-12 bg-primary/50 group-hover:bg-primary/70'
              : 'w-0.5 h-8 bg-border group-hover:bg-primary/40')
      )} />
      {/* 折叠态叠加方向箭头图标 */}
      {isCollapsed && (
        isVertical
          ? <ChevronUp className="absolute size-3 text-muted-foreground group-hover:text-primary" />
          : <ChevronLeft className="absolute size-3 text-muted-foreground group-hover:text-primary" />
      )}
    </div>
  )
}
