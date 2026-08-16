import { useEffect, useState, useCallback, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Download, SquareTerminal, Logs, Settings, SquareActivity, Wrench, ChevronDown, AlertOctagon, FileBarChart, Binary, FileCheck2, Bug } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
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

  // ── 侧边栏自动折叠：目标设备连接后折叠为窄图标栏，断开后自动展开 ──
  const isConnected = useProbeStore(
    (s) => s.probes.find((p) => p.uid === s.selectedUid)?.state === 'connected'
  )
  const [sidebarOpen, setSidebarOpen] = useState(!isConnected)
  useEffect(() => {
    setSidebarOpen(!isConnected)
  }, [isConnected])

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
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <Sidebar>
            <SidebarHeader>
              <DeviceSwitcher collapsed={!sidebarOpen} />
            </SidebarHeader>

            <SidebarContent>
              <SidebarGroup>
                <SidebarMenu>
                  {navItems.slice(0, 5).map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={location.pathname === item.to}
                        tooltip={item.label}
                      >
                        <NavLink to={item.to}>
                          <item.icon className="size-4" />
                          <span>{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}

                  {/* 工具 — 可展开的二级菜单 */}
                  <SidebarMenuItem>
                    {!sidebarOpen ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <SidebarMenuButton isActive={isToolsActive} collapseIconOnly={false}>
                            <span className="relative flex items-center justify-center">
                              <Wrench className="size-5 shrink-0" />
                              <ChevronDown className="absolute -right-1.5 -bottom-1.5 size-3 rounded-sm bg-background text-muted-foreground shadow-sm" />
                            </span>
                          </SidebarMenuButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="right" align="start" className="w-48">
                          {toolsSubItems.map((item) => (
                            <DropdownMenuItem key={item.to} asChild>
                              <NavLink to={item.to}>
                                <item.icon className="size-3.5" />
                                <span>{item.label}</span>
                              </NavLink>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <>
                        <SidebarMenuButton
                          onClick={() => setToolsExpanded(!toolsExpanded)}
                          isActive={isToolsActive}
                        >
                          <Wrench className="size-4" />
                          <span className="flex-1 text-left">工具</span>
                          <ChevronDown
                            className={cn('size-4 transition-transform', toolsExpanded && 'rotate-180')}
                          />
                        </SidebarMenuButton>
                        {toolsExpanded && (
                          <SidebarMenuSub>
                            {toolsSubItems.map((item) => (
                              <SidebarMenuSubItem key={item.to}>
                                <SidebarMenuSubButton asChild isActive={location.pathname === item.to}>
                                  <NavLink to={item.to}>
                                    <item.icon className="size-3.5" />
                                    <span>{item.label}</span>
                                  </NavLink>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        )}
                      </>
                    )}
                  </SidebarMenuItem>

                  {navItems.slice(5).map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={location.pathname === item.to}
                        tooltip={item.label}
                      >
                        <NavLink to={item.to}>
                          <item.icon className="size-4" />
                          <span>{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>

            {!sidebarOpen ? null : (
              <SidebarFooter className="max-h-[45%] overflow-y-auto border-t border-border">
                <InfoPanel />
              </SidebarFooter>
            )}
          </Sidebar>
        </SidebarProvider>
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
