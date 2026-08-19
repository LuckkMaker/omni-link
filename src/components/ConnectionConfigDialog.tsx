import { useEffect, useState } from 'react'
import { RefreshCw, Cpu, FileCode2, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TargetDeviceDialog } from '@/components/TargetDeviceDialog'
import { listJLinkDevices } from '@/services/device.service'
import type { JLinkDeviceInfo } from '@shared/types'
import { useProbeStore, SPEED_OPTIONS, CONNECT_MODE_OPTIONS } from '@/stores/probe.store'
import { useBackendStatus } from '@/hooks/useBackendStatus'

function formatProbeName(product: string, vendor: string): string {
  if (product && product !== 'Unknown') return product
  if (vendor && vendor !== 'Unknown') return vendor
  return 'DAPLink'
}

/** 字节 → 可读容量（J-Link 设备的 Flash/RAM 以字节计） */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
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
  /** mode='start' 且设备已连接时（Start 自动弹出）：默认聚焦「会话」tab，并在可执行文件处抖动引导选择 ELF */
  startConnected?: boolean
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
  startConnected = false,
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
    pendingJlinkDevice,
    fetchProbes,
    fetchDevices,
    selectProbe,
    connectProbe,
    setPendingTarget,
    setPendingInterface,
    setPendingSpeed,
    setPendingConnectMode,
    setPendingJlinkDevice,
    getSelectedProbe,
    getSelectedTarget,
    getDeviceInfo,
  } = useProbeStore()

  const { status } = useBackendStatus()
  const selectedProbe = getSelectedProbe()
  const target = getSelectedTarget()
  const isConnected = selectedProbe?.state === 'connected'

  // J-Link 探针（product 或 vendor 命中 SEGGER）：需要填写 J-Link 设备名才能建立目标连接
  const isJlink =
    /j[- ]?link|segger/i.test(
      `${selectedProbe?.product ?? ''} ${selectedProbe?.vendor ?? ''}`
    )

  // J-Link 候选设备下拉状态：从 J-Link 设备库动态查询（按 jlink_search 前缀 / Flash 容量）
  const [jlinkCandidates, setJlinkCandidates] = useState<JLinkDeviceInfo[]>([])
  const [jlinkLoading, setJlinkLoading] = useState(false)
  const [jlinkPopupOpen, setJlinkPopupOpen] = useState(false)

  const loadJlinkCandidates = async () => {
    const dev = getDeviceInfo(pendingTarget ?? '')
    // 前缀优先取内置设备的 jlink_search（如 STM32F407），否则用当前输入值兜底
    const search = dev?.jlink_search || pendingJlinkDevice?.trim()
    if (!search) {
      setJlinkCandidates([])
      return
    }
    setJlinkLoading(true)
    try {
      const list = await listJLinkDevices({
        search,
        // 用目标设备的容量精确过滤（如 1024KB → IG/VG/ZG）；仅当锚点来自设备时适用
        flashKb: dev?.jlink_search ? dev.flash_size : undefined,
      })
      setJlinkCandidates(list)
    } catch {
      setJlinkCandidates([])
    } finally {
      setJlinkLoading(false)
    }
  }

  const showElf = mode === 'start'

  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [elfError, setElfError] = useState<string | null>(null)
  const [elfPath, setElfPath] = useState<string | null>(null)
  // 连接/会话 tab（start 模式）：默认按入口——Start 自动弹出先确认连接，齿轮打开聚焦会话
  const [activeTab, setActiveTab] = useState<'connect' | 'session'>('connect')
  // 「运行到 main()」会话选项：默认不选中，跨会话持久化（含已连接快速启动路径读取同一 key）
  const [runToMain, setRunToMain] = useState<boolean>(() =>
    localStorage.getItem(RUN_TO_MAIN_KEY) === '1'
  )

  // ── 派生值（须在所有 useState 之后声明，避免引用未初始化） ──
  // 设备已连接点击 Start：需先选 ELF → 会话 tab 可执行文件处做引导（抖动/高亮）
  const needElf = showElf && startOnConfirm && startConnected && !elfPath

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
      // 默认 tab：Start 且设备已连接 → 聚焦「会话」引导选 ELF；Start 未连接 → 先确认连接；齿轮 → 会话
      setActiveTab(startOnConfirm ? (startConnected ? 'session' : 'connect') : 'session')
      setErrorMsg(initialError ?? null)
      setProbeError(null)
      setElfError(null)
    }
  }, [open, status, initialError, startOnConfirm, startConnected, fetchProbes, fetchDevices, deviceList.length])

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
        setActiveTab('connect')
        return
      }
      if (!elfPath) {
        setElfError('请选择 ELF/AXF 文件')
        setActiveTab('session')
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

  /** [取消]：仅关闭弹窗并清除错误提示，不发起连接，不改动已持久化的选项 */
  const handleCancel = () => {
    onOpenChange(false)
    setErrorMsg(null)
    setProbeError(null)
    setElfError(null)
  }

  /** [完成并连接]：config 模式保存配置并立即发起连接（校验仿真器与目标设备） */
  const handleConnect = () => {
    if (!selectedProbe) {
      setProbeError('请先选择仿真器')
      return
    }
    if (!pendingTarget) {
      setErrorMsg('请先选择目标设备')
      return
    }
    if (isJlink && !pendingJlinkDevice) {
      setProbeError('请填写 J-Link 设备名')
      return
    }
    onOpenChange(false)
    setErrorMsg(null)
    setProbeError(null)
    setElfError(null)
    void connectProbe(selectedProbe.uid)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[440px] max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{showElf ? '调试会话配置' : '连接配置'}</DialogTitle>
          </DialogHeader>

          {/* 连接/会话 两个 tab（仅 start 模式），风格与设置页 tab 一致 */}
          {showElf && (
            <div className="flex gap-1 border-b border-border">
              <button
                type="button"
                onClick={() => setActiveTab('connect')}
                className={cn(
                  'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                  activeTab === 'connect'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                连接
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('session')}
                className={cn(
                  'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                  activeTab === 'session'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                会话
              </button>
            </div>
          )}

          {/* 连接配置（mode='config' 或 start 模式的「连接」tab） */}
          {(!showElf || activeTab === 'connect') && (
          <>
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
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{formatProbeName(probe.product, probe.vendor)}</span>
                      {probe.serial && (
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {probe.serial}
                        </span>
                      )}
                    </span>
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
              <span className="text-sm font-medium">接口</span>
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
              <span className="text-sm font-medium">速度</span>
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

          {/* J-Link 设备名（仅 J-Link 探针）：必须在 J-Link 上建立目标连接才能调试 */}
          {isJlink && (
            <div className="min-w-0 space-y-2">
              <span className="text-sm font-medium">J-Link 设备名</span>
              <div className="flex items-center gap-2">
                <Input
                  value={pendingJlinkDevice ?? ''}
                  onChange={(e) => setPendingJlinkDevice(e.target.value)}
                  placeholder="如 STM32F407IG"
                  className="h-9 min-w-0 flex-1 font-mono text-sm"
                />
                <DropdownMenu
                  open={jlinkPopupOpen}
                  onOpenChange={(o) => {
                    setJlinkPopupOpen(o)
                    if (o) void loadJlinkCandidates()
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      title="从 J-Link 查询候选设备"
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="z-50 min-w-64">
                    {jlinkLoading ? (
                      <DropdownMenuItem disabled>查询中…</DropdownMenuItem>
                    ) : jlinkCandidates.length === 0 ? (
                      <DropdownMenuItem disabled>无候选（需先选择目标设备或填写前缀）</DropdownMenuItem>
                    ) : (
                      jlinkCandidates.map((item) => (
                        <DropdownMenuItem
                          key={item.name}
                          className="flex items-center justify-between gap-4"
                          onSelect={() => {
                            setPendingJlinkDevice(item.name)
                            setJlinkPopupOpen(false)
                          }}
                        >
                          <span className="font-mono text-sm">{item.name}</span>
                          <span className="text-xs text-muted-foreground">{fmtBytes(item.flash_size)}</span>
                        </DropdownMenuItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                J-Link 必须指定设备名（SEGGER 数据库名称）才能建立目标连接，可用右侧按钮从 J-Link 查询候选（内置 STM32F407xG 会自动匹配 IG/VG/ZG）
              </p>
            </div>
          )}

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
          </>
          )}

          {/* 会话配置（仅 zone 页「会话」tab 显示） */}
          {showElf && activeTab === 'session' && (
          <>
          {/* ELF 文件选择 */}
          <div className="min-w-0 space-y-2">
              <span className="text-sm font-medium">
                可执行文件
                {elfError && <span className="ml-2 text-xs font-normal text-red-500">{elfError}</span>}
              </span>
              <button
                onClick={handlePickElf}
                title={elfPath ?? undefined}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm transition-colors',
                  needElf
                    ? 'border-primary/70 zone-elf-need hover:bg-primary/5'
                    : 'border-input hover:bg-accent'
                )}
              >
                <span className={cn('min-w-0 truncate', needElf ? 'font-medium text-primary' : elfPath ? 'font-medium' : 'text-muted-foreground')}>
                  {elfPath ? elfPath.split(/[\\/]/).pop() : needElf ? '请选择可执行文件' : '点击选择可执行文件'}
                </span>
                <FileCode2 className={cn('size-4 shrink-0', needElf ? 'text-primary' : 'text-muted-foreground')} />
              </button>
              {needElf && (
                <p className="text-xs text-amber-600">请选择要加载到目标的 ELF/AXF 可执行文件，再点击“连接并启动”</p>
              )}
            </div>

            {/* 会话选项 */}
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
          </>
          )}

          {/* 操作按钮 */}
            <div className="flex items-center justify-between pt-2">
              <Button variant="outline" onClick={handleCancel}>
                取消
              </Button>
              <div className="flex gap-2">
                {!showElf && (
                  <>
                    <Button variant="outline" onClick={handleConfirm} disabled={connecting}>
                      确认
                    </Button>
                    <Button
                      className="gap-2"
                      onClick={handleConnect}
                      disabled={!selectedProbe || connecting || selectedProbe.state === 'connecting'}
                    >
                      确认并连接
                    </Button>
                  </>
                )}
                {showElf && (
                  <Button
                    className="gap-2"
                    onClick={handleConfirm}
                    disabled={connecting || selectedProbe?.state === 'connecting'}
                  >
                    {startOnConfirm ? '连接并启动' : '完成'}
                  </Button>
                )}
              </div>
            </div>
        </DialogContent>
      </Dialog>

      {/* 目标设备选择弹窗（二级） */}
      <TargetDeviceDialog
        open={deviceDialogOpen}
        onOpenChange={setDeviceDialogOpen}
        deviceList={deviceList}
        currentPartNumber={pendingTarget}
        onConfirm={(partNumber) => {
          setPendingTarget(partNumber)
          // 选中内置型号时，自动带出其自带的 J-Link 设备名（若探针为 J-Link 则输入框自动就位）
          const dev = deviceList.find((dd) => dd.part_number === partNumber)
          if (dev?.jlink_device) setPendingJlinkDevice(dev.jlink_device)
        }}
      />
    </>
  )
}