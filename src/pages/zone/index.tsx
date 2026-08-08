import { useEffect, useState, useCallback } from 'react'
import { FileCode2, Cpu } from 'lucide-react'
import { Toolbar } from './components/Toolbar'
import { SourceView } from './components/SourceView'
import { DisasmView } from './components/DisasmView'
import { InspectorDock } from './components/InspectorDock'
import { TerminalDock } from './components/TerminalDock'
import { ResizeHandle } from '@/components/LogConsole'
import { useProbeStore } from '@/stores/probe.store'
import { useZoneStore } from './store'
import { cn } from '@/lib/utils'

/** 右侧检查器 dock 默认宽度 */
const DOCK_DEFAULT_WIDTH = 360
const DOCK_MIN_WIDTH = 240
const DOCK_MAX_RATIO = 0.45
/** 底部终端默认高度 */
const TERMINAL_DEFAULT_HEIGHT = 180
const TERMINAL_MIN_HEIGHT = 80
const TERMINAL_MAX_RATIO = 0.4

function getDockMaxWidth(): number {
  return Math.floor((window.innerWidth ?? 1280) * DOCK_MAX_RATIO)
}

/**
 * Zone 调试工作台主页（类似 SEGGER Ozone 四区布局）
 * 顶部工具栏 + 源码/反汇编主视图 + 右侧检查器 dock + 底部终端控制台
 */
export default function ZonePage() {
  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  // 主视图：源码 / 反汇编 切换
  const [viewMode, setViewMode] = useState<'source' | 'disasm'>('source')

  // 右侧 dock 宽度（0 = 隐藏）
  const [dockWidth, setDockWidth] = useState(DOCK_DEFAULT_WIDTH)
  // 底部终端高度（0 = 隐藏）
  const [termHeight, setTermHeight] = useState(TERMINAL_DEFAULT_HEIGHT)

  // 连接断开时重置调试状态，避免残留
  const refreshStatus = useZoneStore((s) => s.refreshStatus)
  const setState = useZoneStore((s) => s.setState)
  useEffect(() => {
    if (isConnected && uid) {
      void refreshStatus(uid)
    } else {
      setState('disconnected')
    }
  }, [isConnected, uid, refreshStatus, setState])

  const handleDockResize = useCallback((delta: number) => {
    setDockWidth((w) => Math.max(0, Math.min(getDockMaxWidth(), w - delta)))
  }, [])
  const handleToggleDock = useCallback(() => {
    setDockWidth((w) => (w > 0 ? 0 : getDockMaxWidth()))
  }, [])

  const handleTermResize = useCallback((deltaY: number) => {
    setTermHeight((h) =>
      Math.max(0, Math.min(window.innerHeight * TERMINAL_MAX_RATIO, h - deltaY))
    )
  }, [])
  const handleToggleTerm = useCallback(() => {
    setTermHeight((h) => (h > 0 ? 0 : TERMINAL_DEFAULT_HEIGHT))
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部工具栏 */}
      <Toolbar uid={uid} connected={isConnected} />

      {/* 中部：主视图 + 右侧检查器 dock */}
      <div className="flex min-h-0 flex-1">
        {/* 主视图（源码 / 反汇编） */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 源码/反汇编切换条 */}
          <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1">
            <button
              onClick={() => setViewMode('source')}
              className={cn(
                'flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium',
                viewMode === 'source'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              <FileCode2 className="size-3.5" />
              源码
            </button>
            <button
              onClick={() => setViewMode('disasm')}
              className={cn(
                'flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium',
                viewMode === 'disasm'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              <Cpu className="size-3.5" />
              反汇编
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {viewMode === 'source' ? (
              <SourceView uid={uid} />
            ) : (
              <DisasmView uid={uid} />
            )}
          </div>
        </div>

        {/* 水平拖拽分隔条（双击隐藏/展开右侧 dock，始终可见以便恢复） */}
        <ResizeHandle
          direction="horizontal"
          onResize={handleDockResize}
          onToggle={handleToggleDock}
          expanded={dockWidth > 0}
        />

        {/* 右侧检查器 dock */}
        <div
          className={dockWidth > 0 ? 'shrink-0 overflow-hidden border-l border-border bg-card' : 'hidden'}
          style={dockWidth > 0 ? { width: dockWidth } : undefined}
        >
          <InspectorDock uid={uid} connected={isConnected} />
        </div>
      </div>

      {/* 垂直拖拽分隔条（双击隐藏/展开底部终端） */}
      <ResizeHandle
        onResize={handleTermResize}
        onToggle={handleToggleTerm}
        expanded={termHeight > 0}
      />

      {/* 底部终端控制台 */}
      <div
        className={termHeight > 0 ? 'shrink-0 border-t border-border' : 'hidden'}
        style={termHeight > 0 ? { height: termHeight } : undefined}
      >
        <TerminalDock />
      </div>
    </div>
  )
}