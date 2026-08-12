import { useCallback, useState } from 'react'
import { Play, RotateCcw, Power, ChevronDown, Download, ArrowDown, CornerDownRight, CornerUpRight, Square, Trash2, Pause } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
}: {
  main: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-stretch', className)}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={disabled}
        className="h-8 gap-1.5 rounded-r-none border-r border-border/60"
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

  const disabled = !connected || !uid || busy
  // 会话进行中 = 真正启动过调试会话（sessionStatus === 'active'）→ 图标红色；未启动 → 绿色。
  // 注意：不能用 state !== 'disconnected' 判断，侧边栏连接设备后目标可能为 running，
  // 但 zone 会话尚未启动（未加载 ELF），此时仍应显示 Start Session。
  const sessionActive = sessionStatus === 'active'
  const sessionConnecting = sessionStatus === 'connecting'
  // Step Out 仅在目标暂停且当前行落在函数内时可用（非函数行无法出栈）
  const stepOutDisabled = disabled || state !== 'halted' || !currentFunction

  // 仿真器未选择或设备未连接时，弹出「连接配置」弹窗（start 模式，含 ELF 选择区）
  const [configOpen, setConfigOpen] = useState(false)
  const [pendingMode, setPendingMode] = useState<ZoneStartMode | null>(null)

  // 每次启动调试会话都强制弹窗选择 ELF 文件（不做自动记忆/回退），再按所选方式自动重连并执行动作
  const handleStart = useCallback(
    (mode: ZoneStartMode) => {
      // 仿真器未选择 / 设备未连接：先弹出连接配置弹窗（用户在此选择仿真器/目标 + ELF，再统一启动）
      if (!uid || !connected) {
        setPendingMode(mode)
        setConfigOpen(true)
        return
      }
      void (async () => {
        const path = await window.electron?.openFileDialog?.({ extensions: ['elf', 'axf'], title: '选择 ELF 文件' })
        if (!path) return
        await startSession(uid, mode, path)
      })()
    },
    [uid, connected, startSession]
  )

  // 连接配置弹窗确认后：携带用户选择的 ELF 路径启动会话（连接由 startSession 内部统一处理，避免双重连接）
  const handleStartSessionFromDialog = useCallback(
    (elfPath: string) => {
      if (!uid || !pendingMode) return
      const mode = pendingMode
      setPendingMode(null)
      void startSession(uid, mode, elfPath)
    },
    [uid, pendingMode, startSession]
  )

  // Start Session 主按钮：会话未启动 → 默认 Download & Reset Program；已启动 → Stop debug session
  const handleStartMain = useCallback(() => {
    if (sessionActive && uid) void stopSession(uid)
    else void handleStart('download_reset')
  }, [uid, sessionActive, stopSession, handleStart])

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-2">
      <SplitButton
        main={
          <>
            <Power className={sessionActive ? 'size-3.5 text-red-500' : 'size-3.5 text-green-500'} />
            {sessionActive ? 'Stop Session' : 'Start Session'}
          </>
        }
        disabled={busy || sessionConnecting}
        onClick={handleStartMain}
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
        {sessionActive && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => uid && stopSession(uid)}>
              <Square className="size-3.5 mr-1.5 text-red-500" />
              Stop debug session
            </DropdownMenuItem>
          </>
        )}
      </SplitButton>

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
        Reset
      </Button>
      {/* Run：Start code execution */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && continueRun(uid)}
        disabled={disabled}
        className="h-8 gap-1.5"
        title="Start code execution"
      >
        <Play className="size-4" />
        Run
      </Button>
      {/* Stop：Stop code execution */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => uid && halt(uid)}
        disabled={disabled}
        className="h-8 gap-1.5"
        title="Stop code execution"
      >
        <Square className="size-4" />
        Stop
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
        Step Into
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
        Step Over
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
        Step Out
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
        <Trash2 className="size-4" />
        Kill All Breakpoints
      </Button>

      {/* 连接配置弹窗（start 模式，含 ELF 选择区）——仅仿真器未选择/设备未连接时由 Start Session 触发 */}
      <ConnectionConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        mode="start"
        onStartSession={handleStartSessionFromDialog}
      />
    </div>
  )
}