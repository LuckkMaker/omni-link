import { useEffect, useState, useCallback, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Download, SquareTerminal, Logs, Settings, SquareActivity, Wrench, ChevronDown, AlertOctagon, FileBarChart, Binary, FileCheck2, Bug } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBackendStatus } from '@/hooks/useBackendStatus'
import { useProbeWs } from '@/hooks/useProbeWs'
import { useRttSession } from '@/hooks/useRttSession'
import { useProbeStore } from '@/stores/probe.store'
import { resetApiClient } from '@/services/api'
import { DeviceSwitcher } from '@/components/layout/DeviceSwitcher'
import { InfoPanel } from '@/pages/flash/components/InfoPanel'
import { StatusBar } from '@/components/layout/StatusBar'
import { NotificationContainer } from '@/components/NotificationContainer'
import { ResizeHandle } from '@/components/LogConsole'
import { GlobalLogArea } from '@/components/GlobalLogConsole'
import CommanderPage from '@/pages/commander'
import ZonePage from '@/pages/zone'

/** 全局日志区最小高度（0 = 完全隐藏）与默认展开高度 */
const LOG_MIN_HEIGHT = 0
const LOG_DEFAULT_EXPANDED = 200

const navItems = [
  { to: '/zone', label: 'Zone', icon: Bug },
  { to: '/flash', label: 'Flash', icon: Download },
  { to: '/commander', label: 'Commander', icon: SquareTerminal },
  { to: '/rtt', label: 'RTT Viewer', icon: Logs },
  { to: '/monitor', label: 'Monitor', icon: SquareActivity },
  { to: '/settings', label: '设置', icon: Settings },
]

const toolsSubItems = [
  { to: '/tools/fault', label: 'Fault Analyzer', icon: AlertOctagon },
  { to: '/tools/map', label: 'Map Analyzer', icon: FileBarChart },
  { to: '/tools/number', label: 'Number Converter', icon: Binary },
  { to: '/tools/checksum', label: 'File Checksum', icon: FileCheck2 },
]

export default function MainLayout() {
  const { status, port } = useBackendStatus()
  useProbeWs(port)
  useRttSession()  // 全局 RTT 会话管理（切换页面不停止）

  const { fetchProbes, fetchTargets } = useProbeStore()
  const location = useLocation()
  const isToolsActive = location.pathname.startsWith('/tools')
  const [toolsExpanded, setToolsExpanded] = useState(isToolsActive)

  // Commander keep-alive：首次进入 /commander 才挂载，之后切走仅隐藏（display:none），
  // 保留 xterm 实例与命令历史，切回时触发 resize 让 FitAddon 重算尺寸。
  const isOnCommander = location.pathname === '/commander'
  const [commanderMounted, setCommanderMounted] = useState(false)
  useEffect(() => {
    if (isOnCommander) setCommanderMounted(true)
  }, [isOnCommander])
  useEffect(() => {
    if (isOnCommander) {
      const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
      return () => clearTimeout(timer)
    }
  }, [isOnCommander])

  // Zone keep-alive：首次进入 /zone 才挂载，之后切走仅隐藏（display:none），
  // 保留源码视图、面板展开/宽度、终端等全部内容与 UI 状态；切回时触发 resize 让布局重算。
  const isOnZone = location.pathname === '/zone'
  const [zoneMounted, setZoneMounted] = useState(false)
  useEffect(() => {
    if (isOnZone) setZoneMounted(true)
  }, [isOnZone])
  useEffect(() => {
    if (isOnZone) {
      const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
      return () => clearTimeout(timer)
    }
  }, [isOnZone])

  // ── 全局日志区：高度拖拽/折叠（双击恢复/隐藏，记录上次展开高度）──
  const [logHeight, setLogHeight] = useState(LOG_MIN_HEIGHT)
  const lastLogExpandedHeight = useRef(LOG_DEFAULT_EXPANDED)
  const handleLogResize = useCallback((deltaY: number) => {
    setLogHeight((h) => {
      const next = Math.max(0, Math.min(window.innerHeight / 2, h - deltaY))
      if (next > 0) lastLogExpandedHeight.current = next
      return next
    })
  }, [])
  const handleToggleLog = useCallback(() => {
    setLogHeight((h) => (h > 0 ? 0 : lastLogExpandedHeight.current))
  }, [])

  // 路由变化到 tools 时自动展开
  useEffect(() => {
    if (isToolsActive) {
      setToolsExpanded(true)
    }
  }, [isToolsActive])

  useEffect(() => {
    if (status) {
      resetApiClient()
      fetchProbes()
      fetchTargets()
    }
  }, [status, fetchProbes, fetchTargets])

  return (
    <div className="flex h-screen w-full flex-col">
      <div className="flex flex-1 min-h-0">
        <aside className="flex w-56 flex-col border-r border-border bg-muted/30">
          <div className="border-b border-border p-2">
            <DeviceSwitcher />
          </div>

          <nav className="flex-1 min-h-0 overflow-y-auto space-y-1 p-3 select-none">
            {navItems.slice(0, 5).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ))}

            {/* 工具 — 可展开的二级菜单 */}
            <div>
              <button
                onClick={() => setToolsExpanded(!toolsExpanded)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isToolsActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <Wrench className="size-4" />
                <span className="flex-1 text-left">工具</span>
                <ChevronDown
                  className={cn('size-4 transition-transform', toolsExpanded && 'rotate-180')}
                />
              </button>
              {toolsExpanded && (
                <div className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2">
                  {toolsSubItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                          isActive
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                        )
                      }
                    >
                      <item.icon className="size-3.5" />
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>

            {navItems.slice(5).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="shrink-0 max-h-[45%] overflow-y-auto border-t border-border">
            <InfoPanel />
          </div>
        </aside>
        <main className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* 页面内容区（滚动） */}
          <div className="relative flex-1 min-h-0 overflow-auto">
            {/* 非 Commander / Zone 页面：正常路由渲染 */}
            {!isOnCommander && !isOnZone && <Outlet />}
            {/* Commander 页面：keep-alive 常驻，切走仅隐藏 */}
            {commanderMounted && (
              <div className={cn('absolute inset-0', isOnCommander ? 'block' : 'hidden')}>
                <CommanderPage />
              </div>
            )}
            {/* Zone 页面：keep-alive 常驻，切走仅隐藏（保留内容与 UI 状态） */}
            {zoneMounted && (
              <div className={cn('absolute inset-0', isOnZone ? 'block' : 'hidden')}>
                <ZonePage />
              </div>
            )}
          </div>

          {/* 可拖拽分隔（双击完全隐藏/恢复） */}
          <ResizeHandle
            onResize={handleLogResize}
            onToggle={handleToggleLog}
            expanded={logHeight > LOG_MIN_HEIGHT}
          />

          {/* 底部：全局日志区（高度为 0 时完全隐藏，避免残留 border） */}
          <div
            className={logHeight > LOG_MIN_HEIGHT ? 'shrink-0 border-t border-border' : 'hidden'}
            style={logHeight > LOG_MIN_HEIGHT ? { height: logHeight } : undefined}
          >
            <GlobalLogArea />
          </div>
        </main>
      </div>

      <StatusBar />
      <NotificationContainer />
    </div>
  )
}
