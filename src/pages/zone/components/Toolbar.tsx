import { useCallback } from 'react'
import { Pause, Play, RotateCcw, Power, ChevronDown, Download, Crosshair, ArrowDown, CornerDownRight, CornerUpRight, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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

/** Zone 顶部调试控制工具栏（参考 Flash 顶部菜单栏风格） */
export function Toolbar({ uid, connected }: ToolbarProps) {
  const busy = useZoneStore((s) => s.busy)
  const halt = useZoneStore((s) => s.halt)
  const step = useZoneStore((s) => s.step)
  const continueRun = useZoneStore((s) => s.continue)
  const reset = useZoneStore((s) => s.reset)
  const startSession = useZoneStore((s) => s.startSession)
  const stopSession = useZoneStore((s) => s.stopSession)
  const state = useZoneStore((s) => s.state)

  const disabled = !connected || !uid || busy

  // 会话进行中 = 目标非断连态（running/halted/unknown）→ 图标红色；未启动（disconnected）→ 绿色
  const sessionActive = state !== 'disconnected'

  // 启动调试会话：未加载 ELF 时先弹窗选择文件，再按所选方式自动重连并执行动作
  const handleStart = useCallback(async (mode: ZoneStartMode) => {
    if (!uid) return
    let path = useZoneStore.getState().elfPath
    if (!path) {
      path = await window.electron?.openFileDialog?.({ extensions: ['elf', 'axf'], title: '选择 ELF 文件' })
      if (!path) return
    }
    await startSession(uid, mode, path)
  }, [uid, startSession])

  // Start Session 主按钮：会话未启动 → 默认 Download & Reset Program；已启动 → Stop debug session
  const handleStartMain = useCallback(() => {
    if (!uid) return
    if (sessionActive) void stopSession(uid)
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
        disabled={!uid || busy}
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

      <Button variant="ghost" size="sm" onClick={() => uid && halt(uid)} disabled={disabled} className="h-8 gap-1.5" title="Halt">
        <Pause className="size-4" />
        Halt
      </Button>
      <Button variant="ghost" size="sm" onClick={() => uid && continueRun(uid)} disabled={disabled} className="h-8 gap-1.5" title="Run">
        <Play className="size-4" />
        Run
      </Button>

      <SplitButton
        main={
          <>
            <RotateCcw className="size-4" />
            Reset
          </>
        }
        disabled={disabled}
        onClick={() => uid && reset(uid, 'break_symbol')}
      >
        <DropdownMenuItem onClick={() => uid && reset(uid, 'break_symbol')}>
          <Crosshair className="size-3.5 mr-1.5" />
          Reset &amp; Break at Symbol
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => uid && reset(uid, 'halt')}>
          <Pause className="size-3.5 mr-1.5" />
          Reset &amp; Halt
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => uid && reset(uid, 'run')}>
          <Play className="size-3.5 mr-1.5" />
          Reset &amp; Run
        </DropdownMenuItem>
      </SplitButton>

      <Button variant="ghost" size="sm" onClick={() => uid && step(uid, 'over')} disabled={disabled} className="h-8 gap-1.5" title="Step Over">
        <CornerDownRight className="size-4" />
        Step Over
      </Button>
      <Button variant="ghost" size="sm" onClick={() => uid && step(uid, 'into')} disabled={disabled} className="h-8 gap-1.5" title="Step Into">
        <ArrowDown className="size-4" />
        Step Into
      </Button>
      <Button variant="ghost" size="sm" onClick={() => uid && step(uid, 'out')} disabled={disabled} className="h-8 gap-1.5" title="Step Out">
        <CornerUpRight className="size-4" />
        Step Out
      </Button>
    </div>
  )
}