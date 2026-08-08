import { useEffect, useState, useCallback } from 'react'
import { FileCode2, FunctionSquare, SquareTerminal, MemoryStick } from 'lucide-react'
import { Toolbar } from './components/Toolbar'
import { SourceFilesPanel } from './components/SourceFilesPanel'
import { FunctionsPanel } from './components/FunctionsPanel'
import { SourceView } from './components/SourceView'
import { DisasmView } from './components/DisasmView'
import { InspectorDock } from './components/InspectorDock'
import { TerminalDock } from './components/TerminalDock'
import { MemoryUsagePanel } from './components/MemoryUsagePanel'
import { ResizeHandle } from '@/components/LogConsole'
import { useProbeStore } from '@/stores/probe.store'
import { useZoneStore } from './store'
import { cn } from '@/lib/utils'

// ── 尺寸常量 ──────────────────────────────
const SOURCE_PANEL_DEFAULT = 280
const SOURCE_PANEL_MAX_RATIO = 0.3

const DOCK_DEFAULT_WIDTH = 360
const DOCK_MAX_RATIO = 0.45

const DISASM_DEFAULT_HEIGHT = 260
const DISASM_MIN_HEIGHT = 120
const DISASM_MAX_RATIO = 0.6

const TERMINAL_DEFAULT_HEIGHT = 200
const TERMINAL_MIN_HEIGHT = 80
const TERMINAL_MAX_RATIO = 0.4

function ratioOf(max: number): number {
  return Math.floor((window.innerWidth ?? 1280) * max)
}

type LeftTab = 'source' | 'functions'
type BottomTab = 'console' | 'memory'

/** 左侧 dock 顶部 tab 按钮 */
function DockedTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs transition-colors',
        active
          ? 'border-primary bg-primary/10 font-medium text-primary'
          : 'border-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * Zone 调试工作台主页（SEGGER Ozone 式布局）
 * 顶部工具栏 + 左侧(源码文件/函数表格) + 主源码视图 + 右侧(反汇编/检查器) + 底部(控制台/内存占用)
 */
export default function ZonePage() {
  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  // 左侧源码文件面板宽度（0 = 隐藏）
  const [sourceWidth, setSourceWidth] = useState(SOURCE_PANEL_DEFAULT)
  // 右侧 dock 宽度（0 = 隐藏）
  const [dockWidth, setDockWidth] = useState(DOCK_DEFAULT_WIDTH)
  // 右侧上半部分（反汇编）高度
  const [disasmHeight, setDisasmHeight] = useState(DISASM_DEFAULT_HEIGHT)
  // 底部 dock 高度（0 = 隐藏）
  const [dockHeight, setDockHeight] = useState(TERMINAL_DEFAULT_HEIGHT)

  // 左侧 tab / 底部 tab
  const [leftTab, setLeftTab] = useState<LeftTab>('source')
  const [bottomTab, setBottomTab] = useState<BottomTab>('console')

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

  // 左侧源码面板宽度拖拽（面板在分隔条左侧：向右拖动→变宽）
  const handleSourceResize = useCallback((delta: number) => {
    setSourceWidth((w) => Math.max(0, Math.min(ratioOf(SOURCE_PANEL_MAX_RATIO), w + delta)))
  }, [])
  const handleToggleSource = useCallback(() => {
    setSourceWidth((w) => (w > 0 ? 0 : SOURCE_PANEL_DEFAULT))
  }, [])

  // 右侧 dock 宽度拖拽（面板在分隔条右侧：向左拖动→变宽）
  const handleDockResize = useCallback((delta: number) => {
    setDockWidth((w) => Math.max(0, Math.min(ratioOf(DOCK_MAX_RATIO), w - delta)))
  }, [])
  const handleToggleDock = useCallback(() => {
    setDockWidth((w) => (w > 0 ? 0 : DOCK_DEFAULT_WIDTH))
  }, [])

  // 右侧上半（反汇编）高度拖拽
  const handleDisasmResize = useCallback((deltaY: number) => {
    setDisasmHeight((h) =>
      Math.max(DISASM_MIN_HEIGHT, Math.min(window.innerHeight * DISASM_MAX_RATIO, h - deltaY))
    )
  }, [])
  const handleToggleDisasm = useCallback(() => {
    setDisasmHeight((h) => (h > DISASM_MIN_HEIGHT ? DISASM_MIN_HEIGHT : DISASM_DEFAULT_HEIGHT))
  }, [])

  // 底部 dock 高度拖拽
  const handleDockHeightResize = useCallback((deltaY: number) => {
    setDockHeight((h) =>
      Math.max(0, Math.min(window.innerHeight * TERMINAL_MAX_RATIO, h - deltaY))
    )
  }, [])
  const handleToggleDockHeight = useCallback(() => {
    setDockHeight((h) => (h > 0 ? 0 : TERMINAL_DEFAULT_HEIGHT))
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部工具栏 */}
      <Toolbar uid={uid} connected={isConnected} />

      {/* 中部：左侧文件窗 | 主源码 | 右侧(反汇编/检查器) */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧 dock：Source Files / Functions */}
        <div
          className={sourceWidth > 0 ? 'flex shrink-0 flex-col overflow-hidden border-r border-border bg-card' : 'hidden'}
          style={sourceWidth > 0 ? { width: sourceWidth } : undefined}
        >
          <div className="flex shrink-0 items-center border-b border-border">
            <DockedTab
              active={leftTab === 'source'}
              onClick={() => setLeftTab('source')}
              icon={<FileCode2 className="size-3.5" />}
              label="Source Files"
            />
            <DockedTab
              active={leftTab === 'functions'}
              onClick={() => setLeftTab('functions')}
              icon={<FunctionSquare className="size-3.5" />}
              label="Functions"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {leftTab === 'source' ? <SourceFilesPanel uid={uid} /> : <FunctionsPanel uid={uid} />}
          </div>
        </div>
        <ResizeHandle
          direction="horizontal"
          onResize={handleSourceResize}
          onToggle={handleToggleSource}
          expanded={sourceWidth > 0}
        />

        {/* 主源码视图 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <SourceView uid={uid} />
          </div>
        </div>

        {/* 右侧 dock 分隔条 */}
        <ResizeHandle
          direction="horizontal"
          onResize={handleDockResize}
          onToggle={handleToggleDock}
          expanded={dockWidth > 0}
        />

        {/* 右侧 dock：上半反汇编，下半检查器 */}
        <div
          className={dockWidth > 0 ? 'flex shrink-0 flex-col overflow-hidden border-l border-border bg-card' : 'hidden'}
          style={dockWidth > 0 ? { width: dockWidth } : undefined}
        >
          {/* 上半：反汇编 */}
          <div className="shrink-0 overflow-hidden" style={{ height: disasmHeight }}>
            <DisasmView uid={uid} />
          </div>

          {/* 反汇编 / 检查器 分隔条 */}
          <ResizeHandle
            onResize={handleDisasmResize}
            onToggle={handleToggleDisasm}
            expanded={disasmHeight > DISASM_MIN_HEIGHT}
          />

          {/* 下半：检查器（寄存器/外设/内存） */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <InspectorDock uid={uid} connected={isConnected} />
          </div>
        </div>
      </div>

      {/* 底部特宽分隔条 */}
      <ResizeHandle
        onResize={handleDockHeightResize}
        onToggle={handleToggleDockHeight}
        expanded={dockHeight > 0}
      />

      {/* 底部 dock：Console / Memory Usage */}
      <div
        className={dockHeight > 0 ? 'flex shrink-0 flex-col border-t border-border bg-card' : 'hidden'}
        style={dockHeight > 0 ? { height: dockHeight } : undefined}
      >
        <div className="flex shrink-0 items-center border-b border-border">
          <DockedTab
            active={bottomTab === 'console'}
            onClick={() => setBottomTab('console')}
            icon={<SquareTerminal className="size-3.5" />}
            label="Console"
          />
          <DockedTab
            active={bottomTab === 'memory'}
            onClick={() => setBottomTab('memory')}
            icon={<MemoryStick className="size-3.5" />}
            label="Memory Usage"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {bottomTab === 'console' ? <TerminalDock /> : <MemoryUsagePanel uid={uid} />}
        </div>
      </div>
    </div>
  )
}