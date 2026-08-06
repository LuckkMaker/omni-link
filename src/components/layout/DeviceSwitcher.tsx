import { useEffect, useState } from 'react'
import { Usb, ChevronsUpDown, RefreshCw, Cpu, PlugZap, Unplug } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TargetDeviceDialog } from '@/components/TargetDeviceDialog'
import { useProbeStore, SPEED_OPTIONS, CONNECT_MODE_OPTIONS } from '@/stores/probe.store'
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
    probes,
    selectedUid,
    deviceList,
    connecting,
    loadingProbes,
    pendingTarget,
    pendingInterface,
    pendingSpeed,
    pendingConnectMode,
    fetchProbes,
    fetchDevices,
    selectProbe,
    connectProbe,
    disconnectProbe,
    setPendingTarget,
    setPendingInterface,
    setPendingSpeed,
    setPendingConnectMode,
    getSelectedProbe,
    getSelectedTarget,
    getDeviceInfo,
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
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // 后端就绪后加载设备目录
  useEffect(() => {
    if (status && deviceList.length === 0) {
      fetchDevices()
    }
  }, [status, deviceList.length, fetchDevices])

  // 打开配置弹窗时刷新仿真器列表
  const handleConfigOpen = (open: boolean) => {
    setConfigDialogOpen(open)
    if (open && status) {
      fetchProbes()
    }
  }

  // 确认按钮：仅保存配置并关闭弹窗（不发起连接）
  const handleConfirm = () => {
    setConfigDialogOpen(false)
    setErrorMsg(null)
  }

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
      setErrorMsg('请先选择目标设备')
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
          onClick={() => handleConfigOpen(true)}
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

      {/* 配置弹窗 */}
      <Dialog open={configDialogOpen} onOpenChange={handleConfigOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>连接配置</DialogTitle>
          </DialogHeader>

          {/* 仿真器选择 + 刷新 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">仿真器</span>
              <Button variant="ghost" size="sm" onClick={() => fetchProbes()} disabled={loadingProbes}>
                <RefreshCw className={cn('size-4', loadingProbes && 'animate-spin')} />
              </Button>
            </div>
            <Select
              value={selectedUid ?? ''}
              onValueChange={(v) => selectProbe(v)}
              disabled={probes.length === 0}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={loadingProbes ? '扫描中...' : '未检测到仿真器'} />
              </SelectTrigger>
              <SelectContent>
                {probes.map((probe) => (
                  <SelectItem key={probe.uid} value={probe.uid}>
                    {formatProbeName(probe.product, probe.vendor)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 目标设备 */}
          <div className="space-y-2">
            <span className="text-sm font-medium">目标设备</span>
            <button
              onClick={() => { setDeviceDialogOpen(true); setErrorMsg(null) }}
              className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <span className={currentDeviceName ? 'font-medium' : 'text-muted-foreground'}>
                {currentDeviceName ?? '点击选择目标设备'}
              </span>
              <Cpu className="size-4 text-muted-foreground" />
            </button>
            {errorMsg && (
              <p className="text-xs text-red-500">{errorMsg}</p>
            )}
          </div>

          {/* 接口 + 速度 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium">接口</span>
                <span className="text-[10px] text-muted-foreground cursor-help" title="SWD：2 线调试（SWCLK+SWDIO），推荐；JTAG：传统 4 线调试，需探针和目标均支持。连接失败时可降低速度重试。">
                  ⓘ
                </span>
              </div>
              <Select value={pendingInterface} onValueChange={(v) => setPendingInterface(v as 'swd' | 'jtag')}>
                <SelectTrigger className="h-9" disabled={isConnected}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="swd">SWD</SelectItem>
                  <SelectItem value="jtag">JTAG</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium">速度</span>
                <span className="text-[10px] text-muted-foreground cursor-help" title="时钟频率，越高传输越快但越易出错。探针不支持时会自动选最接近值。连接不稳定时请降低速度。">
                  ⓘ
                </span>
              </div>
              <Select value={String(pendingSpeed)} onValueChange={(v) => setPendingSpeed(Number(v))}>
                <SelectTrigger className="h-9" disabled={isConnected}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPEED_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={String(s.value)}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 连接模式 */}
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <span className="text-sm font-medium">连接模式</span>
              <span
                className="text-[10px] text-muted-foreground cursor-help"
                title={CONNECT_MODE_OPTIONS.map((m) => `${m.label}：${m.desc}`).join('\n')}
              >
                ⓘ
              </span>
            </div>
            <Select
              value={pendingConnectMode}
              onValueChange={(v) => setPendingConnectMode(v as typeof pendingConnectMode)}
            >
              <SelectTrigger className="h-9" disabled={isConnected}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONNECT_MODE_OPTIONS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {CONNECT_MODE_OPTIONS.find((m) => m.value === pendingConnectMode)?.desc}
            </p>
          </div>

          {/* 完成按钮：仅保存配置 */}
          {selectedProbe && (
            <div className="flex justify-end pt-2">
              <Button
                className="gap-2"
                onClick={handleConfirm}
                disabled={connecting || selectedProbe.state === 'connecting'}
              >
                完成
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 目标设备选择弹窗（二级） */}
      <TargetDeviceDialog
        open={deviceDialogOpen}
        onOpenChange={setDeviceDialogOpen}
        deviceList={deviceList}
        currentPartNumber={pendingTarget}
        onConfirm={(partNumber) => setPendingTarget(partNumber)}
      />
    </>
  )
}
