import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal, type TerminalApi } from './components/Terminal'
import { CommandSidebar } from './components/CommandSidebar'
import { ResizeHandle } from '@/components/LogConsole'
import { useProbeStore } from '@/stores/probe.store'
import { useCommanderStore } from '@/stores/commander.store'
import { useUiStore } from '@/stores/ui.store'
import { resetContext } from '@/services/commander.service'

const SIDEBAR_MAX_RATIO = 0.25 // 最大尺寸 = 窗口宽度 1/4
const SIDEBAR_DEFAULT_WIDTH = 288 // w-72

function getSidebarMaxWidth(): number {
  return Math.floor((window.innerWidth ?? 1280) * SIDEBAR_MAX_RATIO)
}

export default function CommanderPage() {
  const terminalApiRef = useRef<TerminalApi | null>(null)

  // 侧边栏宽度状态：0 = 完全隐藏；>0 = 展开宽度（上限 = 窗口 1/4）
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)

  // 终端主题：用于让终端容器背景跟随主题即时切换
  const terminalTheme = useUiStore((s) => s.terminalTheme)

  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  const commands = useCommanderStore((s) => s.commands)
  const commandsLoaded = useCommanderStore((s) => s.commandsLoaded)
  const fetchCommands = useCommanderStore((s) => s.fetchCommands)

  // 挂载时拉取全量命令列表
  useEffect(() => {
    if (isConnected && uid) {
      void fetchCommands(uid)
    } else if (!commandsLoaded) {
      void fetchCommands(null)
    }
  }, [isConnected, uid, commandsLoaded, fetchCommands])

  // 断开时重置 commandsLoaded
  useEffect(() => {
    if (!isConnected) {
      useCommanderStore.setState({ commandsLoaded: false })
    }
  }, [isConnected])

  /** 侧边栏命令点击处理 */
  const handleSidebarCommand = useCallback((cmd: string) => {
    if (!terminalApiRef.current) return
    if (cmd.endsWith(' ')) {
      terminalApiRef.current.insertText(cmd)
    } else {
      terminalApiRef.current.runCommand(cmd)
    }
    // 焦点回到终端，方便用户按回车或继续输入
    terminalApiRef.current.focus()
  }, [])

  /** 清屏 */
  const handleClear = useCallback(() => {
    terminalApiRef.current?.clear()
  }, [])

  /** 重置命令上下文 */
  const handleResetContext = useCallback(async () => {
    if (!uid) return
    try {
      await resetContext(uid)
      await fetchCommands(uid)
      terminalApiRef.current?.runCommand('status')
    } catch {
      // 忽略
    }
  }, [uid, fetchCommands])

  /** 命令执行前拦截：list 由界面提供 probe 连接与目标配置，命令冗余，Commander 亦不可用 */
  const handleBeforeCommand = useCallback(async (cmdUid: string, cmd: string): Promise<boolean> => {
    const first = cmd.trim().split(/\s+/)[0]?.toLowerCase()
    if (first === 'list') {
      terminalApiRef.current?.writeLog?.('命令「list」不可用：应用已提供 probe 连接与目标配置')
      return true
    }
    return false
  }, [])

  /** 拖拽调整侧边栏宽度
   *  右侧边栏：鼠标向左拖（delta<0）应扩大宽度，向右拖（delta>0）应缩小宽度 */
  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => {
      const next = Math.max(0, Math.min(getSidebarMaxWidth(), w - delta))
      return next
    })
  }, [])

  /** 双击在[完全隐藏(0)]和[最大尺寸(窗口1/4)]之间切换 */
  const handleToggleSidebar = useCallback(() => {
    setSidebarWidth((w) => (w > 0 ? 0 : getSidebarMaxWidth()))
  }, [])

  /** 侧边栏宽度变化后触发 resize，让 xterm.js FitAddon 重新计算尺寸 */
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'))
    }, 50)
    return () => clearTimeout(timer)
  }, [sidebarWidth])

  return (
    <div className="flex h-full min-h-0">
      {/* 终端区：容器背景跟随当前终端主题 */}
      <div
        className="relative min-w-0 flex-1"
        style={{ backgroundColor: terminalTheme.theme.background }}
      >
        <Terminal
          uid={uid}
          connected={isConnected}
          commands={commands}
          apiRef={terminalApiRef}
          onBeforeCommand={handleBeforeCommand}
        />
      </div>

      {/* 水平拖拽分隔条（双击在[完全隐藏]与[最大尺寸]之间切换） */}
      <ResizeHandle
        direction="horizontal"
        onResize={handleSidebarResize}
        onToggle={handleToggleSidebar}
        expanded={sidebarWidth > 0}
      />

      {/* 侧边命令面板（宽度为 0 时完全隐藏，避免残留 border） */}
      <div
        className={sidebarWidth > 0 ? 'shrink-0 overflow-hidden border-l border-border bg-card' : 'hidden'}
        style={sidebarWidth > 0 ? { width: sidebarWidth } : undefined}
      >
        <CommandSidebar
          onRunCommand={handleSidebarCommand}
          commands={commands}
          connected={isConnected}
          onClear={handleClear}
          onResetContext={handleResetContext}
        />
      </div>
    </div>
  )
}
