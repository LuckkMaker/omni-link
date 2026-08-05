import { useEffect, useRef, useCallback, useState } from 'react'
import { RttTerminal, type RttTerminalApi } from './components/RttTerminal'
import { ConfigPanel } from './components/ConfigPanel'
import { InputBar } from './components/InputBar'
import { RttTabBar } from './components/RttTabBar'
import { MultiStringDialog } from './components/MultiStringDialog'
import { ResizeHandle } from '@/components/LogConsole'
import { useRecordToFile } from './hooks/useRecordToFile'
import { useProbeStore } from '@/stores/probe.store'
import { useRttStore } from '@/stores/rtt.store'
import { useUiStore } from '@/stores/ui.store'
import { useNotificationStore } from '@/stores/notification.store'
import { rttService } from '@/services/rtt.service'

const SIDEBAR_MAX_RATIO = 0.25 // 最大尺寸 = 窗口宽度 1/4
const SIDEBAR_DEFAULT_WIDTH = 288 // w-72

function getSidebarMaxWidth(): number {
  return Math.floor((window.innerWidth ?? 1280) * SIDEBAR_MAX_RATIO)
}

export default function RttPage() {
  const terminalRef = useRef<RttTerminalApi | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [showMultiString, setShowMultiString] = useState(false)

  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  const running = useRttStore((s) => s.running)
  const activeTabId = useRttStore((s) => s.activeTabId)
  const terminalTheme = useUiStore((s) => s.terminalTheme)
  const inputMode = useRttStore((s) => s.inputMode)
  const localEcho = useRttStore((s) => s.localEcho)
  const pushNotification = useNotificationStore((s) => s.push)

  const [coreState, setCoreState] = useState<'running' | 'halted' | 'unknown'>('unknown')

  // 接收数据到文件（持续录制 .dat）
  useRecordToFile(activeTabId)

  // 目标内核状态轮询（连接时定期查询 Run/Halt 状态）
  useEffect(() => {
    if (!uid || !isConnected) {
      setCoreState('unknown')
      return
    }
    const poll = async () => {
      try {
        const r = await rttService.deviceState(uid)
        if (r.success) {
          setCoreState(r.state === 'running' ? 'running' : r.state === 'halted' ? 'halted' : 'unknown')
        }
      } catch { /* ignore */ }
    }
    poll()
    const timer = setInterval(poll, 3000)
    return () => clearInterval(timer)
  }, [uid, isConnected])

  // 目标设备控制：Run/Halt 切换
  const handleToggleDevice = useCallback(async () => {
    if (!uid) return
    try {
      if (coreState === 'running') {
        await rttService.deviceHalt(uid)
        setCoreState('halted')
      } else {
        await rttService.deviceRun(uid)
        setCoreState('running')
      }
    } catch (e) {
      pushNotification({
        type: 'error', title: '设备控制失败',
        message: e instanceof Error ? e.message : String(e),
        autoClose: true, autoCloseDelay: 3000,
      })
    }
  }, [uid, coreState, pushNotification])

  // 目标设备控制：复位（后端会重新搜索 RTT 控制块）
  const handleReset = useCallback(async () => {
    if (!uid) return
    const notifId = pushNotification({
      type: 'progress', title: '正在复位目标...',
      message: '复位并重新初始化 RTT 控制块',
    })
    try {
      const result = await rttService.deviceReset(uid, true)
      setCoreState(result.state === 'halted' ? 'halted' : 'running')
      useNotificationStore.getState().update(notifId, {
        type: 'success', title: '目标已复位',
        message: 'RTT 控制块已重新初始化',
        autoClose: true, autoCloseDelay: 3000,
      })
    } catch (e) {
      useNotificationStore.getState().update(notifId, {
        type: 'error', title: '复位失败',
        message: e instanceof Error ? e.message : String(e),
        autoClose: true, autoCloseDelay: 5000,
      })
    }
  }, [uid, pushNotification])

  // 侧边栏宽度变化后触发 resize 让 xterm 重新 fit
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'))
    }, 50)
    return () => clearTimeout(timer)
  }, [sidebarWidth, inputMode])

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => {
      const next = Math.max(0, Math.min(getSidebarMaxWidth(), w - delta))
      return next
    })
  }, [])

  const handleToggleSidebar = useCallback(() => {
    setSidebarWidth((w) => (w > 0 ? 0 : getSidebarMaxWidth()))
  }, [])

  /** 获取发送目标 down channel（供 InputBar/MultiStringDialog 使用） */
  const getSendChannel = useCallback(() => {
    const tab = useRttStore.getState().tabs.find((t) => t.id === activeTabId)
    if (tab?.mode === 'single' && tab.channel !== undefined) return tab.channel
    return useRttStore.getState().selectedDownChannel
  }, [activeTabId])

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：终端 + 输入栏 + 日志 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Tab 栏 */}
        <RttTabBar running={running} />

        {/* 终端：容器背景跟随主题；pb-1 留底部余量避免最后行被 InputBar 遮挡 */}
        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          style={{ backgroundColor: terminalTheme.theme.background }}
        >
          {isConnected ? (
            <RttTerminal
              key={activeTabId}
              ref={terminalRef}
              uid={uid}
              running={running}
              tabId={activeTabId}
              inputMode={inputMode}
              localEcho={localEcho}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p style={{ color: terminalTheme.theme.foreground, opacity: 0.7 }}>
                  {uid ? 'Link 未连接' : '请选择并连接 Link'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 输入栏：仅 bar 模式显示（terminal 模式由终端直接输入） */}
        {inputMode === 'bar' && (
          <InputBar
            uid={uid}
            running={running}
          />
        )}
      </div>

      {/* 水平拖拽分隔条 */}
      <ResizeHandle
        direction="horizontal"
        onResize={handleSidebarResize}
        onToggle={handleToggleSidebar}
        expanded={sidebarWidth > 0}
      />

      {/* 右侧配置面板（无标题，直接渲染 ConfigPanel） */}
      <div
        className={sidebarWidth > 0 ? 'flex shrink-0 flex-col overflow-hidden border-l border-border bg-card' : 'hidden'}
        style={sidebarWidth > 0 ? { width: sidebarWidth } : undefined}
      >
        <div className="flex-1 overflow-y-auto">
          <ConfigPanel
            uid={uid}
            connected={isConnected}
            terminalRef={terminalRef}
            onOpenMultiString={() => setShowMultiString(true)}
            onToggleDevice={handleToggleDevice}
            onReset={handleReset}
            coreState={coreState}
          />
        </div>
      </div>

      {/* 多字符串对话框 */}
      <MultiStringDialog
        open={showMultiString}
        onOpenChange={setShowMultiString}
        uid={uid}
        running={running}
        getSendChannel={getSendChannel}
      />
    </div>
  )
}
