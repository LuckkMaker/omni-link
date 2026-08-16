import { useEffect, useState } from 'react'
import { RefreshCw, Cpu, FileCode2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
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

function formatProbeName(product: string, vendor: string): string {
  if (product && product !== 'Unknown') return product
  if (vendor && vendor !== 'Unknown') return vendor
  return 'DAPLink'
}

/** localStorage key：记录上一次选择的 ELF 路径，方便下次启动会话时快速确认 */
const ELF_LAST_PATH_KEY = 'omni_link_last_elf_path'
/** localStorage key：记录「运行到 main()」开关，跨会话保持一致（含已连接快速启动路径） */
export const RUN_TO_MAIN_KEY = 'omni_link_run_to_main'

interface ConnectionConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * 显示模式：
   * - 'config'：仅保存连接配置（侧边栏入口），不显示 ELF/会话选项区；
   * - 'start'：zone 页调试会话配置入口，显示 ELF 选择区与会话选项，确认后携带 ELF 路径和会话选项启动会话。
   */
  mode: 'config' | 'start'
  /** mode='start' 时，确认后回调携带用户选择的 ELF 路径与「运行到 main()」开关 */
  onStartSession?: (elfPath: string, runToMain: boolean) => void
  /** 打开时由外部注入的初始提示（如"请先选择目标设备"），关闭/确认后清除 */
  initialError?: string | null
  /**
   * mode='start' 时是否在确认后发起会话启动：
   * - true（Start 自动弹出）：确认 =「连接并启动」，校验仿真器/ELF 并回调 onStartSession；
   * - false（齿轮入口）：仅作为配置编辑态，确认 =「完成」，只保存选项（勾选即持久化），不启动会话。
   */
  startOnConfirm?: boolean
}

/**
 * 会话启动配置弹窗：仿真器 / 目标设备 / 接口 / 速度 / 连接模式。
 * mode='start' 时升级为「调试会话配置」，追加 ELF 选择与「运行到 main()」会话选项。
 * 仅保存配置与收集选项，不在此发起连接（连接由 startSession 统一处理，避免双重连接）。
 */
export function ConnectionConfigDialog({
  open,
  onOpenChange,
  mode,
  onStartSession,
  initialError,
  startOnConfirm = true,
}: ConnectionConfigDialogProps) {
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

  const showElf = mode === 'start'

  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [elfError, setElfError] = useState<string | null>(null)
  const [elfPath, setElfPath] = useState<string | null>(null)
  // 「运行到 main()」会话选项：默认开启，跨会话持久化（含已连接快速启动路径读取同一 key）
  const [runToMain, setRunToMain] = useState<boolean>(() =>
    localStorage.getItem(RUN_TO_MAIN_KEY) !== '0'
  )

  // 当前设备显示名
  const currentDeviceName = target
    ? getDeviceInfo(target.part_number)?.display_name ?? target.part_number
    : pendingTarget
      ? getDeviceInfo(pendingTarget)?.display_name ?? pendingTarget
      : null

  // 打开时刷新仿真器列表，并注入外部初始提示
  useEffect(() => {
    if (open && status) {
      fetchProbes()
      if (deviceList.length === 0) fetchDevices()
    }
    if (open) {
      setErrorMsg(initialError ?? null)
      setProbeError(null)
      setElfError(null)
    }
  }, [open, status, initialError, fetchProbes, fetchDevices, deviceList.length])

  // 打开 start 模式时，预填上一次选择的 ELF 路径（作为默认值，用户仍可重新选择或确认使用）
  useEffect(() => {
    if (open && mode === 'start') {
      const last = localStorage.getItem(ELF_LAST_PATH_KEY)
      if (last) setElfPath(last)
    }
  }, [open, mode])

  // 选择 ELF 文件（仅 start 模式）
  const handlePickElf = async () => {
    const path = await window.electron?.openFileDialog?.({
      extensions: ['elf', 'axf'],
      title: '选择 ELF 文件',
    })
    if (path) {
      setElfPath(path)
      setElfError(null)
      localStorage.setItem(ELF_LAST_PATH_KEY, path)
    }
  }

  const handleConfirm = () => {
    if (showElf && startOnConfirm) {
      if (!selectedProbe) {
        setProbeError('请先选择仿真器')
        return
      }
      if (!elfPath) {
        setElfError('请选择 ELF/AXF 文件')
        return
      }
      const path = elfPath
      const runToMainValue = runToMain
      localStorage.setItem(RUN_TO_MAIN_KEY, runToMain ? '1' : '0')
      onOpenChange(false)
      setErrorMsg(null)
      setProbeError(null)
      setElfError(null)
      setElfPath(null)
      onStartSession?.(path, runToMainValue)
    } else {
      // 非启动确认（config 模式 / 齿轮配置态）：仅关闭，选项已在勾选/选择时即时持久化
      onOpenChange(false)
      setErrorMsg(null)
      setProbeError(null)
      setElfError(null)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[440px] max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{showElf ? '调试会话配置' : '连接配置'}</DialogTitle>
          </DialogHeader>

          {/* 仿真器选择 + 刷新 */}
          <div className="min-w-0 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                仿真器
                {probeError && <span className="ml-2 text-xs font-normal text-red-500">{probeError}</span>}
              </span>
              <Button variant="ghost" size="sm" onClick={() => fetchProbes()} disabled={loadingProbes}>
                <RefreshCw className={cn('size-4', loadingProbes && 'animate-spin')} />
              </Button>
            </div>
            <Select
              value={selectedUid ?? ''}
              onValueChange={(v) => { selectProbe(v); setProbeError(null) }}
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
          <div className="min-w-0 space-y-2">
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
          <div className="grid min-w-0 grid-cols-2 gap-4">
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
          <div className="min-w-0 space-y-2">
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

          {/* ELF 文件选择（仅 zone 页 Start Session 入口显示） */}
          {showElf && (
            <div className="min-w-0 space-y-2">
              <span className="text-sm font-medium">
                可执行文件
                {elfError && <span className="ml-2 text-xs font-normal text-red-500">{elfError}</span>}
              </span>
              <button
                onClick={handlePickElf}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <span className={cn('min-w-0 truncate', elfPath ? 'font-medium' : 'text-muted-foreground')}>
                  {elfPath ? elfPath.split(/[\\/]/).pop() : '点击选择可执行文件'}
                </span>
                <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
              </button>
              {elfPath && (
                <p className="truncate text-[10px] text-muted-foreground" title={elfPath}>{elfPath}</p>
              )}
            </div>
          )}

          {/* 会话选项（仅 zone 页调试会话配置入口显示） */}
          {showElf && (
            <div className="min-w-0 space-y-2">
              <span className="text-sm font-medium">会话选项</span>
              <label
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2 text-sm transition-colors hover:bg-accent"
                title="Download & Reset 后复位目标，并自动运行到 main() 后暂停，便于从程序入口开始调试"
              >
                <Checkbox
                  checked={runToMain}
                  onCheckedChange={(v) => {
                    const next = !!v
                    setRunToMain(next)
                    localStorage.setItem(RUN_TO_MAIN_KEY, next ? '1' : '0')
                  }}
                  className="size-4"
                  id="zone-run-to-main"
                />
                <span className="select-none">运行到 main()</span>
              </label>
            </div>
          )}

          {/* 完成按钮 */}
          {selectedProbe && (
            <div className="flex justify-end pt-2">
              <Button
                className="gap-2"
                onClick={handleConfirm}
                disabled={connecting || selectedProbe.state === 'connecting'}
              >
                {showElf ? (startOnConfirm ? '连接并启动' : '完成') : '完成'}
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