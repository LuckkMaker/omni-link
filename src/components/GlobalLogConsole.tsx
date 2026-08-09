import { useMemo } from 'react'
import { Filter } from 'lucide-react'
import { LogConsole } from '@/components/LogConsole'
import { useLogStore, type LogFilter } from '@/stores/log.store'

/** 来源筛选选项：全部/系统 固定在前，其余按字母序排列 */
const FILTER_OPTIONS: { value: LogFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'system', label: '系统' },
  { value: 'commander', label: 'Commander' },
  { value: 'flash', label: 'Flash' },
  { value: 'monitor', label: 'Monitor' },
  { value: 'rtt', label: 'RTT' },
  { value: 'zone', label: 'Zone' },
]

/**
 * 全局日志控制台（挂在 MainLayout 底部，应用内所有页面共用）。
 *
 * - 数据来源：全局 log store（useProbeWs 统一收口 WS `log` 事件）
 * - 筛选：按来源（monitor/flash/rtt/commander/zone/system）过滤查看，
 *   筛选下拉通过 LogConsole 的 headerExtra 插槽渲染在日志窗口标题栏内
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

  // 来源筛选下拉，渲染到日志窗口标题栏（LogConsole 的 headerExtra 插槽）
  const headerExtra = (
    <span className="ml-2 flex items-center gap-1 text-muted-foreground">
      <Filter className="size-3" />
      <select
        value={filter}
        onChange={(e) => setFilter(e.target.value as LogFilter)}
        title="按来源筛选"
        className="h-6 rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary"
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
    </span>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0">
        <LogConsole
          logs={visibleLogs}
          onClear={clearLogs}
          title="日志"
          headerExtra={headerExtra}
        />
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