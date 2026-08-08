import { useEffect, useRef, useState, useCallback } from 'react'
import { ChevronDown, ChevronUp, SquareTerminal } from 'lucide-react'
import { Terminal, type TerminalApi } from '@/pages/commander/components/Terminal'
import { useProbeStore } from '@/stores/probe.store'
import { useCommanderStore } from '@/stores/commander.store'
import { cn } from '@/lib/utils'

/** 底部终端控制台默认高度 */
const TERMINAL_DEFAULT_HEIGHT = 180
const TERMINAL_MIN_HEIGHT = 80
const TERMINAL_MAX_RATIO = 0.4

/**
 * Zone 底部终端控制台（Phase 6）
 * 复用 Commander 的 Terminal 组件，作为 Zone 工作台的 REPL 控制台。
 * 与其它页面共享探针连接状态与命令列表；命令执行结果由后端 log 事件写入全局日志。
 */
export function TerminalDock() {
  const terminalApiRef = useRef<TerminalApi | null>(null)

  const [height, setHeight] = useState(TERMINAL_DEFAULT_HEIGHT)
  const [collapsed, setCollapsed] = useState(false)

  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  const commands = useCommanderStore((s) => s.commands)
  const commandsLoaded = useCommanderStore((s) => s.commandsLoaded)
  const fetchCommands = useCommanderStore((s) => s.fetchCommands)

  // 拉取命令列表（供 Tab 补全）
  useEffect(() => {
    if (isConnected && uid) {
      void fetchCommands(uid)
    } else if (!commandsLoaded) {
      void fetchCommands(null)
    }
  }, [isConnected, uid, commandsLoaded, fetchCommands])

  // 折叠/展开后触发 resize，让 xterm FitAddon 重算尺寸
  useEffect(() => {
    const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    return () => clearTimeout(timer)
  }, [collapsed, height])

  const handleResize = useCallback((deltaY: number) => {
    setHeight((h) =>
      Math.max(TERMINAL_MIN_HEIGHT, Math.min(window.innerHeight * TERMINAL_MAX_RATIO, h - deltaY))
    )
  }, [])

  const handleToggle = useCallback(() => setCollapsed((c) => !c), [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* 标题栏：可折叠 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5">
        <SquareTerminal className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">终端控制台</span>
        <button
          onClick={handleToggle}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
          title={collapsed ? '展开终端' : '折叠终端'}
        >
          {collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>

      {/* 终端区（折叠时隐藏） */}
      <div className={cn('min-h-0 flex-1', collapsed ? 'hidden' : 'block')}>
        <Terminal uid={uid} connected={isConnected} commands={commands} apiRef={terminalApiRef} />
      </div>
    </div>
  )
}