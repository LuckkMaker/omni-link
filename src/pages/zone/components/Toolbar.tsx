import { useCallback } from 'react'
import { Pause, StepForward, Play, RotateCcw, Loader2, FolderOpen, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useZoneStore } from '../store'

interface ToolbarProps {
  uid: string | null
  connected: boolean
}

/** Zone 顶部调试控制工具栏 */
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
      if (files.length > 0) setActiveSourceFile(files[0])
    }
  }, [uid, loadElf, setActiveSourceFile])

  const stateLabel =
    state === 'halted' ? '已暂停' : state === 'running' ? '运行中' : state === 'disconnected' ? '未连接' : '未知'

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-card px-3 py-1.5">
      <Button variant="outline" size="sm" onClick={handleLoadElf} disabled={!uid} title="加载 ELF 文件">
        <FolderOpen className="size-4" />
        <span className="ml-1.5">加载 ELF</span>
      </Button>

      <div className="mx-1 h-5 w-px bg-border" />

      <Button variant="outline" size="icon" onClick={() => uid && halt(uid)} disabled={disabled} title="暂停 (Halt)">
        <Pause className="size-4" />
      </Button>
      <Button variant="outline" size="icon" onClick={() => uid && step(uid)} disabled={disabled} title="单步 (Step)">
        <StepForward className="size-4" />
      </Button>
      <Button variant="outline" size="icon" onClick={() => uid && continueRun(uid)} disabled={disabled} title="继续 (Continue)">
        <Play className="size-4" />
      </Button>
      <Button variant="outline" size="icon" onClick={() => uid && reset(uid)} disabled={disabled} title="复位并暂停 (Reset)">
        <RotateCcw className="size-4" />
      </Button>

      <div className="mx-1 h-5 w-px bg-border" />

      {/* 连接与运行状态 */}
      <div className="flex items-center gap-2 text-xs">
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
        <div className="ml-auto flex items-center gap-1 text-xs text-red-500">
          <AlertCircle className="size-3.5" />
          <span className="max-w-64 truncate" title={error}>{error}</span>
        </div>
      )}
    </div>
  )
}