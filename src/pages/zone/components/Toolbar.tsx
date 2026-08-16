import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, RotateCcw, ChevronDown, Download, ArrowDown, CornerDownRight, CornerUpRight, Square, CircleSlash, Pause, RefreshCw, Settings, BugPlay, BugOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConnectionConfigDialog } from '@/components/ConnectionConfigDialog'
import { useZoneStore, type ZoneStartMode } from '../store'
import { cn } from '@/lib/utils'

interface ToolbarProps {
  uid: string | null
  connected: boolean
}

/** 拆分按钮：主按钮（默认动作）+ 右侧下拉箭头（展开更多选项） */
function SplitButton({
  main,
  onClick,
  disabled,
  children,
  className,
  title,
}: {
  main: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <div className={cn('flex items-stretch', className)}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className="h-8 gap-1.5 rounded-r-none"
      >
        {main}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={disabled} className="h-8 w-6 shrink-0 rounded-l-none px-0">
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Zone 顶部调试控制工具栏（参考 Keil MDK Debug 布局） */
export function Toolbar({ uid, connected }: ToolbarProps) {
  const busy = useZoneStore((s) => s.busy)
  const halt = useZoneStore((s) => s.halt)
  const step = useZoneStore((s) => s.step)
  const continueRun = useZoneStore((s) => s.continue)
  const reset = useZoneStore((s) => s.reset)
  const startSession = useZoneStore((s) => s.startSession)
  const stopSession = useZoneStore((s) => s.stopSession)
  const state = useZoneStore((s) => s.state)
  const sessionStatus = useZoneStore((s) => s.sessionStatus)
  const currentFunction = useZoneStore((s) => s.currentFunction)
  const clearBreakpoints = useZoneStore((s) => s.clearBreakpoints)
  const refreshMode = useZoneStore((s) => s.refreshMode)
  const setRefreshMode = useZoneStore((s) => s.setRefreshMode)

  const disabled = !connected || !uid || busy
  // 会话进行中 = 真正启动过调试会话（sessionStatus === 'active'）→ 图标红色；未启动 → 绿色。
  // 注意：不能用 state !== 'disconnected' 判断，侧边栏连接设备后目标可能为 running，
  // 但 zone 会话尚未启动（未加载 ELF），此时仍应显示 Start Session。
  const sessionActive = sessionStatus === 'active'
  const sessionConnecting = sessionStatus === 'connecting'
  // Step Out 仅在目标暂停且当前行落在函数内时可用（非函数行无法出栈）
  const stepOutDisabled = disabled || state !== 'halted' || !currentFunction

  // 周期刷新激活（用于开关按钮高亮 + 图标旋转提示）。
  // 仅会话 active 时有效：未启动会话按钮禁用，且不显示激活态（避免旧持久化残留高亮）
  const periodicActive = sessionActive && refreshMode === 'periodic_always'
  // 转动仅表示周期刷新正在实际运行（目标运行中）；目标暂停时模式仍开启（保持颜色）但不轮询
  const periodicRunning = periodicActive && state === 'running'

  // 自适应紧凑模式：工具栏内容溢出时隐藏文字标签（仅图标 + 悬停提示），
  // 窗口足够宽时自动恢复完整标签。用 ResizeObserver 实测容器宽度，
  // 不依赖固定断点，避免不同语言/字体宽度下误判。
  const containerRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const fullWidthRef = useRef(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (compact) {
        // 紧凑模式：容器宽度 ≥ 完整内容宽度 + 余量才恢复完整标签（滞回避免抖动）
        if (el.clientWidth >= fullWidthRef.current + 48) setCompact(false)
      } else {
        // 完整模式：记录完整内容宽度，溢出则切换紧凑
        fullWidthRef.current = el.scrollWidth
        if (el.scrollWidth > el.clientWidth + 1) setCompact(true)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [compact])

  // 仿真器未选择或设备未连接时，弹出「连接配置」弹窗（start 模式，含 ELF 选择区）
  const [configOpen, setConfigOpen] = useState(false)
  const [pendingMode, setPendingMode] = useState<ZoneStartMode | null>(null)

  // 每次启动调试会话都强制弹窗选择 ELF 文件（不做自动记忆/回退），再按所选方式自动重连并执行动作。
  // 设备已连接时同样弹窗（聚焦「会话」tab，于可执行文件处引导），保证启动前必选 ELF。
  const handleStart = useCallback((mode: ZoneStartMode) => {
    setPendingMode(mode)
    setConfigOpen(true)
  }, [])

  // 调试会话配置弹窗确认后：携带用户选择的 ELF 路径与会话选项启动会话（连接由 startSession 内部统一处理，避免双重连接）
  const handleStartSessionFromDialog = useCallback(
    (elfPath: string, runToMain: boolean) => {
      if (!uid || !pendingMode) return
      const mode = pendingMode
      setPendingMode(null)
      void startSession(uid, mode, elfPath, { runToMain })
    },
    [uid, pendingMode, startSession]
  )

  // Start Session 主按钮：会话未启动 → 默认 Download & Reset Program；已启动 → Stop debug session
  const handleStartMain = useCallback(() => {
    if (sessionActive && uid) void stopSession(uid)
    else void handleStart('download_reset')
  }, [uid, sessionActive, stopSession, handleStart])

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-2',
        compact && 'toolbar-compact'
      )}
    >
      <SplitButton
        main={
          <>
            {sessionConnecting ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : sessionActive ? (
              <BugPlay className="size-3.5 text-green-600" />
            ) : (
              <BugOff className="size-3.5 text-muted-foreground" />
            )}
            <span data-toolbar-label>{sessionActive ? 'Stop Session' : 'Start Session'}</span>
          </>
        }
        disabled={busy || sessionConnecting}
        onClick={handleStartMain}
        title={sessionActive ? 'Stop debug session' : 'Start debug session'}
      >
        <DropdownMenuItem onClick={() => handleStart('download_reset')}>
          <Download className="size-3.5 mr-1.5" />
          Download &amp; Reset Program
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleStart('attach_running')}>
          <Play className="size-3.5 mr-1.5" />
          Attach to Running Program
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleStart('attach_halt')}>
          <Pause className="size-3.5 mr-1.5" />
          Attach &amp; Halt Program
        </DropdownMenuItem>
      </SplitButton>

      {/* Session Setting：齿轮入口（仅图标），紧跟 Start Session 之后；随时打开调试会话配置（连接 + ELF + 会话选项） */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfigOpen(true)}
        disabled={busy || sessionConnecting}
        className="h-8 w-8 px-0"
        title="Debug session configuration"
      >
        <Settings className="size-4" />
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      {/* Reset：复位 CPU（复位并暂停） */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && reset(uid, 'halt')}
        disabled={disabled}
        className="h-8 gap-1.5"
        title="Reset the CPU"
      >
        <RotateCcw className="size-4" />
        <span data-toolbar-label>Reset</span>
      </Button>
      {/* Run：Start code execution。目标非暂停态（running/unknown）时禁用——
          运行中再按 Run 是冗余 no-op，禁用可避免"点得动但不执行"的误导，
          同时阻断连点产生的重复 continue 请求堆积到 SWD 链路。 */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && continueRun(uid)}
        disabled={disabled || state !== 'halted'}
        className="h-8 gap-1.5"
        title={state !== 'halted' ? '目标未暂停，无法启动执行' : 'Start code execution'}
      >
        <Play className="size-4" />
        <span data-toolbar-label>Run</span>
      </Button>
      {/* Stop：Stop code execution。目标非运行态（halted/unknown）时禁用——
          已暂停再按 Stop 是冗余 no-op，禁用避免"点得动但不执行"的误导，
          同时阻断连点产生的重复 halt 请求堆积到 SWD 链路。 */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && halt(uid)}
        disabled={disabled || state !== 'running'}
        className="h-8 gap-1.5"
        title={state !== 'running' ? '目标未在运行，无需停止' : 'Stop code execution'}
      >
        <Square className="size-4" />
        <span data-toolbar-label>Stop</span>
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      {/* Step Into：Step one line */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && step(uid, 'into')}
        disabled={disabled}
        className="h-8 gap-1.5"
        title="Step one line"
      >
        <ArrowDown className="size-4" />
        <span data-toolbar-label>Step Into</span>
      </Button>
      {/* Step Over：Step over the current line */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && step(uid, 'over')}
        disabled={disabled}
        className="h-8 gap-1.5"
        title="Step over the current line"
      >
        <CornerDownRight className="size-4" />
        <span data-toolbar-label>Step Over</span>
      </Button>
      {/* Step Out：Step out of the current function（非函数行禁用） */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && step(uid, 'out')}
        disabled={stepOutDisabled}
        className="h-8 gap-1.5"
        title={
          state === 'halted' && !currentFunction
            ? '当前行不在函数内，无法 Step Out'
            : 'Step out of the current function'
        }
      >
        <CornerUpRight className="size-4" />
        <span data-toolbar-label>Step Out</span>
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      {/* Kill All Breakpoints：清除当前目标全部断点 */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && clearBreakpoints(uid)}
        disabled={disabled}
        className="h-8 gap-1.5"
        title="Kill all breakpoints in current target"
      >
        <CircleSlash className="size-4" />
        <span data-toolbar-label>Kill All Breakpoints</span>
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      {/* 周期刷新：一级开关，点击激活/关闭周期刷新（每 1 秒，运行中不打断程序）。
          仅调试会话启动后可用；停止会话时由 stopSession 自动复位为 on_stop */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setRefreshMode(periodicActive ? 'on_stop' : 'periodic_always')}
        disabled={!sessionActive}
        className={cn('h-8 gap-1.5', periodicActive && 'text-primary')}
        title={
          !sessionActive
            ? '启动调试会话后可用'
            : periodicActive
              ? periodicRunning
                ? 'Refreshing...'
                : 'Periodic refresh (target paused)'
              : 'Periodic refresh'
        }
      >
        <RefreshCw className={cn('size-4', periodicRunning && 'animate-spin')} />
        <span data-toolbar-label>Periodic Refresh</span>
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      {/* 调试会话配置弹窗（start 模式，含 ELF 选择区与会话选项）——
          由 Start Session（点 Start 即弹，带 pendingMode）或齿轮入口触发。
          startOnConfirm 依据是否有待启动的 mode：有 → 确认即启动；齿轮打开（无 mode）→ 仅为配置编辑态。
          startConnected：设备已连接时聚焦「会话」tab，并在可执行文件处引导选择 ELF。 */}
      <ConnectionConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        mode="start"
        startOnConfirm={pendingMode !== null}
        startConnected={connected}
        onStartSession={handleStartSessionFromDialog}
      />
    </div>
  )
}