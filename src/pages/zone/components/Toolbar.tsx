import { useCallback } from 'react'
import { Pause, StepForward, Play, RotateCcw, Loader2, FolderOpen, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useZoneStore } from '../store'

interface ToolbarProps {
  uid: string | null
  connected: boolean
}

/** Zone 顶部调试控制工具栏（参考 Flash 顶部菜单栏风格） */
export function Toolbar({ uid, connected }: ToolbarProps) {
  const state = useZoneStore((s) => s.state)
  const pc = useZoneStore((s) => s.pc)
  const busy = useZoneStore((s) => s.busy)
  const error = useZoneStore((s) => s.error)
  const halt = useZoneStore((s) => s.halt)
  const step = useZoneStore((s) => s.step)
  const continueRun = useZoneStore((s) => s.continue)
  const reset = useZoneStore((s) => s.reset)
  const loadElf = useZoneStore((s) => s.loadElf)
  const setActiveSourceFile = useZoneStore((s) => s.setActiveSourceFile)

  const disabled = !connected || !uid || busy

  const handleLoadElf = useCallback(async () => {
    if (!uid) return
    const path = await window.electron?.openFileDialog?.({ extensions: ['elf', 'axf'], title: '选择 ELF 文件' })
    if (!path) return
    const ok = await loadElf(uid, path)
    if (ok) {
      // 加载成功后自动选中第一个源文件
      const files = useZoneStore.getState().sourceFiles
      if (files.length > 0) setActiveSourceFile(files[0].path)
    }
  }, [uid, loadElf, setActiveSourceFile])

  const stateLabel =
    state === 'halted' ? 'Halted' : state === 'running' ? 'Running' : state === 'disconnected' ? 'Disconnected' : 'Unknown'

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleLoadElf}
        disabled={!uid}
        className="h-8 gap-1.5"
      >
        <FolderOpen className="size-3.5" />
        Load ELF
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Button variant="ghost" size="sm" onClick={() => uid && halt(uid)} disabled={disabled} className="h-8 gap-1.5" title="Halt">
        <Pause className="size-4" />
        Halt
      </Button>
      <Button variant="ghost" size="sm" onClick={() => uid && step(uid)} disabled={disabled} className="h-8 gap-1.5" title="Step">
        <StepForward className="size-4" />
        Step
      </Button>
      <Button variant="ghost" size="sm" onClick={() => uid && continueRun(uid)} disabled={disabled} className="h-8 gap-1.5" title="Continue">
        <Play className="size-4" />
        Continue
      </Button>
      <Button variant="ghost" size="sm" onClick={() => uid && reset(uid)} disabled={disabled} className="h-8 gap-1.5" title="Reset">
        <RotateCcw className="size-4" />
        Reset
      </Button>

      <div className="ml-auto flex items-center gap-2 text-xs">
        {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <span
          className={
            state === 'halted'
              ? 'text-amber-600'
              : state === 'running'
                ? 'text-emerald-600'
                : 'text-muted-foreground'
          }
        >
          {stateLabel}
        </span>
        {pc !== null && pc !== undefined && (
          <span className="font-mono text-muted-foreground">
            PC = 0x{(pc ?? 0).toString(16).toUpperCase().padStart(8, '0')}
          </span>
        )}
      </div>

      {error && (
        <div className="ml-3 flex items-center gap-1 text-xs text-red-500">
          <AlertCircle className="size-3.5" />
          <span className="max-w-64 truncate" title={error}>{error}</span>
        </div>
      )}
    </div>
  )
}