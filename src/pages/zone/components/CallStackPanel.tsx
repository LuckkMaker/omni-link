import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, AlertCircle, ListTree } from 'lucide-react'
import { zoneStack, type CallStackFrame } from '@/services/zone.service'
import { useZoneStore } from '../store'

interface CallStackPanelProps {
  uid: string | null
  connected: boolean
}

function fmtAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * 底部 Call Stack tab：调用栈回溯。
 * 需目标暂停；在 halt/step（PC 变化）时自动刷新。
 */
export function CallStackPanel({ uid, connected }: CallStackPanelProps) {
  const state = useZoneStore((s) => s.state)
  const pc = useZoneStore((s) => s.pc)

  const [frames, setFrames] = useState<CallStackFrame[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!uid) return
    setLoading(true)
    try {
      const res = await zoneStack(uid)
      setFrames(res.frames ?? [])
      setError(null)
    } catch (e) {
      setFrames([])
      setError(e instanceof Error ? e.message : '读取调用栈失败')
    } finally {
      setLoading(false)
    }
  }, [uid])

  // halt/step 时自动刷新（PC 变化或状态进入 halted）
  const lastState = useRef(state)
  const lastPc = useRef(pc)
  const didInit = useRef(false)
  useEffect(() => {
    if (!uid) {
      setFrames([])
      return
    }
    if (state === 'halted') {
      // 首次挂载时若目标已 halt（如会话启动后才展开此面板），强制刷新一次，避免空帧
      const stateChanged = lastState.current !== 'halted'
      const pcChanged = lastPc.current !== pc
      const firstMount = !didInit.current
      didInit.current = true
      if (stateChanged || pcChanged || firstMount) void refresh()
    } else {
      setFrames([])
    }
    lastState.current = state
    lastPc.current = pc
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, state, pc])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1">
        <ListTree className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">调用栈</span>
        {state === 'halted' ? (
          <span className="text-[10px] text-muted-foreground">({frames.length} 帧)</span>
        ) : null}
        <button
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent"
          onClick={() => void refresh()}
          disabled={!uid || state !== 'halted'}
          title="刷新"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        {!connected ? (
          <div className="min-h-0 flex-1" />
        ) : !uid ? (
          <Empty text="未连接" />
        ) : state !== 'halted' ? (
          <Empty text="目标运行中，暂停后查看调用栈" />
        ) : error ? (
          <Empty text={error} isError />
        ) : loading && frames.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            回溯中...
          </div>
        ) : frames.length === 0 ? (
          <Empty text="无有效调用栈（ELF 无符号表或异常栈）" />
        ) : (
          frames.map((f, i) => (
            <div
              key={`${f.address}-${i}`}
              className={i === 0
                ? 'flex items-center gap-2 border-b border-primary/20 bg-primary/10 px-2 py-1'
                : 'flex items-center gap-2 border-b border-border/50 px-2 py-1 hover:bg-muted/30'}
            >
              <span className="w-6 shrink-0 select-none text-right text-muted-foreground/60">{i}</span>
              <span className="w-24 shrink-0 text-muted-foreground">{fmtAddr(f.address)}</span>
              <span className={i === 0 ? 'shrink-0 font-medium text-primary' : 'shrink-0'}>
                {f.function || f.symbol || '<unknown>'}
              </span>
              {f.file && (
                <span className="truncate text-muted-foreground/70">
                  — {f.file.split('/').pop()}
                  {f.line ? `:${f.line}` : ''}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function Empty({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <div
      className={
        isError
          ? 'flex h-full items-center justify-center gap-2 p-4 text-red-500'
          : 'flex h-full items-center justify-center p-4 text-center text-muted-foreground'
      }
    >
      {isError ? <AlertCircle className="size-4 shrink-0" /> : null}
      <span className="max-w-md truncate">{text}</span>
    </div>
  )
}