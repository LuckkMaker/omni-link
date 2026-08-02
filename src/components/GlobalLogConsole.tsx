import { useMemo } from 'react'
import { Filter } from 'lucide-react'
import { LogConsole } from '@/components/LogConsole'
import { useLogStore, type LogFilter } from '@/stores/log.store'

/** 来源筛选选项 */
const FILTER_OPTIONS: { value: LogFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'monitor', label: 'Monitor' },
  { value: 'flash', label: 'Flash' },
  { value: 'rtt', label: 'RTT' },
  { value: 'commander', label: 'Commander' },
  { value: 'system', label: '系统' },
]

/**
 * 全局日志控制台（挂在 MainLayout 底部，应用内所有页面共用）。
 *
 * - 数据来源：全局 log store（useProbeWs 统一收口 WS `log` 事件）
 * - 筛选：按来源（monitor/flash/rtt/commander/system）过滤查看
 * - 避让：当前页面有右侧边栏时（rightInset > 0），日志区右侧让出该宽度，
 *   不干扰右侧边栏（如 Monitor 页面的通道面板）
 */
export function GlobalLogConsole() {
  const logs = useLogStore((s) => s.logs)
  const filter = useLogStore((s) => s.filter)
  const setFilter = useLogStore((s) => s.setFilter)
  const clearLogs = useLogStore((s) => s.clearLogs)

  // 按筛选来源过滤（并显示当前筛选下各来源计数）
  const visibleLogs = useMemo(() => {
    if (filter === 'all') return logs
    return logs.filter((l) => l.source === filter)
  }, [logs, filter])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center gap-1 border-b border-border px-3 py-1">
        <Filter className="size-3 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground">来源</span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as LogFilter)}
          className="h-6 rounded border border-border bg-background px-1.5 text-[11px] outline-none focus:border-primary"
        >
          {FILTER_OPTIONS.map((opt) => {
            const count = opt.value === 'all'
              ? logs.length
              : logs.filter((l) => l.source === opt.value).length
            return (
              <option key={opt.value} value={opt.value}>
                {opt.label} ({count})
              </option>
            )
          })}
        </select>
      </div>
      <div className="flex-1 min-h-0">
        <LogConsole logs={visibleLogs} onClear={clearLogs} title="日志" />
      </div>
    </div>
  )
}

/**
 * 全局日志区容器（含高度拖拽/折叠）。放在 MainLayout 的 main 底部，全宽显示。
 */
export function GlobalLogArea() {
  return (
    <div className="h-full">
      <GlobalLogConsole />
    </div>
  )
}
