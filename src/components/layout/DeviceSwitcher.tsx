import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Usb, ChevronsUpDown, RefreshCw, Link, Box, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConnectionConfigDialog } from '@/components/ConnectionConfigDialog'
import { Badge } from '@/components/ui/badge'
import { HoverScrollText } from '@/components/HoverScrollText'
import { omniPersonalityBadge } from '@/pages/omni-tool/service'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { useProbeStore } from '@/stores/probe.store'
import { useBackendStatus } from '@/hooks/useBackendStatus'
import { useOmniToolStore } from '@/pages/omni-tool/store'
import type { ProbeState } from '@shared/types'

/**
 * 连接来源（两个互相独立的设备池）：
 * - probe：调试探针（任意 CMSIS-DAP：ST-Link / J-Link / DAPLink …），供 Zone/Flash/Commander/RTT 使用
 * - omni ：OMNI Tool 设备自身的 CDC 命令口，供 /omni-tool 使用
 */
type Source = 'probe' | 'omni'

const stateLabel: Record<ProbeState, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  error: '错误',
}

function formatProbeName(product: string, vendor: string): string {
  if (product && product !== 'Unknown') return product
  if (vendor && vendor !== 'Unknown') return vendor
  return 'DAPLink'
}

export function DeviceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const {
    pendingTarget,
    connecting,
    fetchDevices,
    getSelectedProbe,
    getSelectedTarget,
    getDeviceInfo,
    connectProbe,
    disconnectProbe,
  } = useProbeStore()

  const { status } = useBackendStatus()
  const selectedProbe = getSelectedProbe()
  const target = getSelectedTarget()
  const isConnected = selectedProbe?.state === 'connected'

  // 当前设备显示名
  const currentDeviceName = target
    ? getDeviceInfo(target.part_number)?.display_name ?? target.part_number
    : pendingTarget
      ? getDeviceInfo(pendingTarget)?.display_name ?? pendingTarget
      : null

  const [configDialogOpen, setConfigDialogOpen] = useState(false)
  const [initialError, setInitialError] = useState<string | null>(null)

  // ── 连接来源切换 ──
  // 默认跟随当前页面（/omni-tool 用 OMNI Tool，其余页面用调试探针）；
  // 点击设备控件前的图标可手动切换，路由变化时恢复"跟随页面"。
  const location = useLocation()
  const routeSource: Source = location.pathname === '/omni-tool' ? 'omni' : 'probe'
  const [pinnedSource, setPinnedSource] = useState<Source | null>(null)
  const source = pinnedSource ?? routeSource
  useEffect(() => {
    setPinnedSource(null)
  }, [routeSource])

  const toggleSource = () => setPinnedSource(source === 'probe' ? 'omni' : 'probe')

  // ── OMNI Tool 设备状态（与 /omni-tool 页共用同一 store，单一真相）──
  const omniDevices = useOmniToolStore((s) => s.devices)
  const omniSession = useOmniToolStore((s) => s.session)
  const omniBusy = useOmniToolStore((s) => s.busy)
  const omniConnected = omniSession.connected
  const selectedPort = useOmniToolStore((s) => s.selectedPort)
  // 已连接时以实际会话端口为准，否则用列表中的选中项
  const omniSelected =
    omniDevices.find((d) => d.port === (omniSession.port ?? selectedPort)) ?? null
  const omniSerial = omniSelected ? omniSelected.serial_number || omniSelected.port : ''

  // 后端就绪后加载设备目录
  useEffect(() => {
    if (status) {
      fetchDevices()
    }
  }, [status, fetchDevices])

  // 切到 OMNI 来源且尚无设备列表时自动扫描一次
  useEffect(() => {
    if (status && source === 'omni' && omniDevices.length === 0) {
      useOmniToolStore.getState().refreshDevices()
    }
  }, [status, source, omniDevices.length])

  // 连接/断开（调试探针）
  const toggleProbeConnection = () => {
    if (!selectedProbe) return
    if (selectedProbe.state === 'connected') {
      disconnectProbe(selectedProbe.uid)
      return
    }
    if (!pendingTarget) {
      setInitialError('请先选择目标设备')
      setConfigDialogOpen(true)
      return
    }
    if (selectedProbe.state === 'disconnected' || selectedProbe.state === 'error') {
      connectProbe(selectedProbe.uid)
    }
  }

  // 折叠态：仅一个图标按钮。
  // 已连接 → 断开；未连接 → 切换来源（沿用"折叠态优先断开"以避免连接后无法断开的死锁）。
  if (collapsed) {
    const isOmni = source === 'omni'
    const connected = isOmni ? omniConnected : isConnected
    const spinning = isOmni ? omniBusy : connecting || selectedProbe?.state === 'connecting'
    const onClick = connected
      ? isOmni
        ? () => useOmniToolStore.getState().disconnect()
        : toggleProbeConnection
      : toggleSource
    const title = connected
      ? '断开连接'
      : isOmni
        ? 'OMNI Tool 设备（点击切换为调试探针）'
        : '调试探针（点击切换为 OMNI Tool）'

    return (
      <button
        onClick={onClick}
        disabled={spinning}
        title={title}
        className={cn(
          'mx-auto flex h-9 w-9 items-center justify-center rounded-md transition-colors disabled:opacity-50',
          connected
            ? 'text-green-600 hover:bg-green-500/10'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        {spinning ? (
          <RefreshCw className="size-5 animate-spin" />
        ) : connected ? (
          <Link className="size-5" />
        ) : isOmni ? (
          <Box className="size-5" />
        ) : (
          <Usb className="size-5" />
        )}
      </button>
    )
  }

  return (
    <>
      <div className="flex items-center gap-1">
        {/* 图标：点击在"调试探针 / OMNI Tool"两个设备池之间切换 */}
        <button
          onClick={toggleSource}
          title={source === 'probe' ? '切换到 OMNI Tool 设备' : '切换到调试探针'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {source === 'probe' ? <Usb className="size-5" /> : <Box className="size-5" />}
        </button>

        {source === 'omni' ? (
          <>
            {/* OMNI Tool：下拉仅"选择"，连接/断开由右侧按钮执行（与调试探针三段式一致） */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={omniBusy}
                  className="flex flex-1 min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">OMNI Tool</div>
                    <HoverScrollText
                      text={omniSerial || '未发现设备'}
                      className="text-xs text-muted-foreground"
                    />
                  </div>
                  <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-64">
                {omniDevices.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    未发现 OMNI Tool 设备
                  </div>
                ) : (
                  omniDevices.map((d) => (
                    <DropdownMenuItem
                      key={d.port}
                      onSelect={() => useOmniToolStore.getState().selectPort(d.port)}
                    >
                      <Box className="size-3.5 shrink-0" />
                      <HoverScrollText
                        text={`OMNI Tool ${d.serial_number || d.port}`}
                        className="min-w-0 flex-1 text-muted-foreground"
                      />
                      <Badge
                        variant={d.personality === 'app' ? 'secondary' : 'outline'}
                        className="shrink-0"
                      >
                        {omniPersonalityBadge[d.personality]}
                      </Badge>
                      {d.port === selectedPort && <Check className="size-3.5 shrink-0" />}
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuItem onSelect={() => useOmniToolStore.getState().refreshDevices()}>
                  <RefreshCw className="size-3.5" />
                  <span>刷新设备</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 连接/断开 */}
            <button
              onClick={() => {
                if (omniConnected) {
                  useOmniToolStore.getState().disconnect()
                } else if (selectedPort) {
                  useOmniToolStore.getState().connect(selectedPort)
                }
              }}
              disabled={omniBusy || (!omniConnected && !selectedPort)}
              title={omniConnected ? '断开连接' : '连接目标设备'}
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50',
                omniConnected
                  ? 'text-green-600 hover:bg-green-500/10'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {omniBusy ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : omniConnected ? (
                <Link className="size-4" />
              ) : (
                <Link className="size-4" />
              )}
            </button>
          </>
        ) : (
          <>
            {/* 调试探针：打开连接配置弹窗 */}
            <button
              onClick={() => {
                setInitialError(null)
                setConfigDialogOpen(true)
              }}
              className="flex flex-1 min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <HoverScrollText
                  text={
                    selectedProbe
                      ? formatProbeName(selectedProbe.product, selectedProbe.vendor)
                      : '未选择设备'
                  }
                  className="text-sm font-medium"
                />
                <HoverScrollText
                  text={
                    currentDeviceName
                      ? currentDeviceName
                      : selectedProbe
                        ? stateLabel[selectedProbe.state]
                        : '点击选择仿真器'
                  }
                  className="text-xs text-muted-foreground"
                />
              </div>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </button>

            {/* 连接/断开图标按钮 */}
            {selectedProbe && (
              <button
                onClick={toggleProbeConnection}
                disabled={connecting || selectedProbe.state === 'connecting'}
                title={
                  connecting
                    ? '处理中...'
                    : isConnected
                      ? '断开连接'
                      : pendingTarget
                        ? '连接目标设备'
                        : '请先选择目标设备'
                }
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50',
                  isConnected
                    ? 'text-green-600 hover:bg-green-500/10'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                {connecting || selectedProbe.state === 'connecting' ? (
                  <RefreshCw className="size-4 animate-spin" />
                ) : isConnected ? (
                  <Link className="size-4" />
                ) : (
                  <Link className="size-4" />
                )}
              </button>
            )}
          </>
        )}
      </div>

      {/* 连接配置弹窗（复用组件，config 模式，不显示 ELF 区） */}
      <ConnectionConfigDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        mode="config"
        initialError={initialError}
      />
    </>
  )
}