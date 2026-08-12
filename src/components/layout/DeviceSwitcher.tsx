import { useEffect, useState } from 'react'
import { Usb, ChevronsUpDown, RefreshCw, PlugZap, Unplug } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConnectionConfigDialog } from '@/components/ConnectionConfigDialog'
import { useProbeStore } from '@/stores/probe.store'
import { useBackendStatus } from '@/hooks/useBackendStatus'
import type { ProbeState } from '@shared/types'

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

export function DeviceSwitcher() {
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

  // 后端就绪后加载设备目录
  useEffect(() => {
    if (status) {
      fetchDevices()
    }
  }, [status, fetchDevices])

  // 侧边栏连接/断开图标按钮
  const toggleConnection = () => {
    if (!selectedProbe) return
    // 已连接 → 断开
    if (selectedProbe.state === 'connected') {
      disconnectProbe(selectedProbe.uid)
      return
    }
    // 连接前必须选择目标设备
    if (!pendingTarget) {
      setInitialError('请先选择目标设备')
      setConfigDialogOpen(true)
      return
    }
    if (selectedProbe.state === 'disconnected' || selectedProbe.state === 'error') {
      connectProbe(selectedProbe.uid)
    }
  }

  return (
    <>
      {/* 侧边栏顶部：设备配置按钮 + 连接/断开图标按钮 */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => { setInitialError(null); setConfigDialogOpen(true) }}
          className="flex flex-1 min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary/10">
            <Usb className="size-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {selectedProbe
                ? formatProbeName(selectedProbe.product, selectedProbe.vendor)
                : '未选择设备'}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {currentDeviceName
                ? currentDeviceName
                : selectedProbe
                  ? stateLabel[selectedProbe.state]
                  : '点击选择仿真器'}
            </div>
          </div>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>

        {/* 连接/断开图标按钮 */}
        {selectedProbe && (
          <button
            onClick={toggleConnection}
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
              <Unplug className="size-4" />
            ) : (
              <PlugZap className="size-4" />
            )}
          </button>
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