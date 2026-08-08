import { useCallback } from 'react'
import { Pause, Play, RotateCcw, Power, ChevronDown, Download, Crosshair, ArrowDown, CornerDownRight, CornerUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useZoneStore, type ZoneStartMode } from '../store'

interface ToolbarProps {
  uid: string | null
  connected: boolean
}

/** Zone 顶部调试控制工具栏（参考 Flash 顶部菜单栏风格） */
export function Toolbar({ uid, connected }: ToolbarProps) {
  const busy = useZoneStore((s) => s.busy)
  const halt = useZoneStore((s) => s.halt)
  const step = useZoneStore((s) => s.step)
  const continueRun = useZoneStore((s) => s.continue)
  const reset = useZoneStore((s) => s.reset)
  const startSession = useZoneStore((s) => s.startSession)

  const disabled = !connected || !uid || busy

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

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={!uid || busy} className="h-8 gap-1.5">
            <Power className="size-3.5" />
            Start Session
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
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
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Button variant="ghost" size="sm" onClick={() => uid && halt(uid)} disabled={disabled} className="h-8 gap-1.5" title="Halt">
        <Pause className="size-4" />
        Halt
      </Button>
      <Button variant="ghost" size="sm" onClick={() => uid && continueRun(uid)} disabled={disabled} className="h-8 gap-1.5" title="Run">
        <Play className="size-4" />
        Run
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={disabled} className="h-8 gap-1.5">
            <RotateCcw className="size-4" />
            Reset
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
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
        </DropdownMenuContent>
      </DropdownMenu>

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