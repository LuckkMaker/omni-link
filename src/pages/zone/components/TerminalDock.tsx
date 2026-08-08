import { useEffect, useRef } from 'react'
import { Terminal, type TerminalApi } from '@/pages/commander/components/Terminal'
import { useProbeStore } from '@/stores/probe.store'
import { useCommanderStore } from '@/stores/commander.store'

/**
 * Zone 底部 Console tab（Phase 6）
 * 复用 Commander 的 Terminal 组件，作为 Zone 工作台的 REPL 控制台。
 * 底部 dock 已由外层 tab 栏管理折叠，这里不再内嵌「终端控制台」标题栏（避免重复）。
 */
export function TerminalDock() {
  const terminalApiRef = useRef<TerminalApi | null>(null)

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

  // Tab 切换后触发 resize，让 xterm FitAddon 重算尺寸
  useEffect(() => {
    const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Terminal uid={uid} connected={isConnected} commands={commands} apiRef={terminalApiRef} />
    </div>
  )
}