import { create } from 'zustand'
import type { LogEvent } from '@shared/types'

/** 日志来源筛选 */
export type LogFilter = 'all' | 'monitor' | 'flash' | 'rtt' | 'commander' | 'system'

/** 全局日志条目（带来源标记） */
export interface GlobalLogEntry extends LogEvent {
  /** 推断出的来源（后端 source 字段缺失时按消息前缀兜底） */
  source: string
}

/** 全局日志保留条数上限 */
const MAX_LOGS = 1000

interface LogState {
  logs: GlobalLogEntry[]
  /** 当前筛选来源 */
  filter: LogFilter

  addLog: (entry: LogEvent) => void
  clearLogs: () => void
  setFilter: (filter: LogFilter) => void
}

/** 按消息内容兜底推断来源（后端未带 source 时使用，与后端 _infer_log_source 规则一致） */
function inferSource(message: string): string {
  const msg = message || ''
  if (msg.includes('Monitor')) return 'monitor'
  if (msg.includes('RTT')) return 'rtt'
  if (msg.includes('Commander')) return 'commander'
  if (['Flash', '烧录', '擦除', 'Program', 'Erase', 'Verify', 'Read Back', 'Check Blank', '固件'].some((k) => msg.includes(k))) {
    return 'flash'
  }
  return 'system'
}

export const useLogStore = create<LogState>((set) => ({
  logs: [],
  filter: 'all',

  addLog: (entry) =>
    set((s) => ({
      logs: [
        ...s.logs,
        { ...entry, source: entry.source ?? inferSource(entry.message) },
      ].slice(-MAX_LOGS),
    })),

  clearLogs: () => set({ logs: [] }),
  setFilter: (filter) => set({ filter }),
}))
