import { useEffect, useState, useCallback } from 'react'
import { FileCode2, FunctionSquare, MemoryStick, SquareTerminal, Eye, ListTree } from 'lucide-react'
import { Toolbar } from './components/Toolbar'
import { SourceFilesPanel } from './components/SourceFilesPanel'
import { FunctionsPanel } from './components/FunctionsPanel'
import { MemoryUsagePanel } from './components/MemoryUsagePanel'
import { SourceView } from './components/SourceView'
import { InspectorDock, MemoryPanel } from './components/InspectorDock'
import { TerminalDock } from './components/TerminalDock'
import { WatchPanel } from './components/WatchPanel'
import { CallStackPanel } from './components/CallStackPanel'
import { ResizeHandle } from '@/components/LogConsole'
import { useProbeStore } from '@/stores/probe.store'
import { useZoneStore } from './store'
import * as zoneService from '@/services/zone.service'
import { cn } from '@/lib/utils'

// ── 尺寸常量 ──────────────────────────────
const SOURCE_PANEL_DEFAULT = 300
const SOURCE_PANEL_MAX_RATIO = 0.3

const DOCK_DEFAULT_WIDTH = 440
const DOCK_MAX_RATIO = 0.5

const TERMINAL_DEFAULT_HEIGHT = 220
const TERMINAL_MIN_HEIGHT = 80
const TERMINAL_MAX_RATIO = 0.4

function ratioOf(max: number): number {
  return Math.floor((window.innerWidth ?? 1280) * max)
}

type LeftTab = 'source' | 'functions' | 'memory'
// 底部右栏 tab（左栏固定 Console）
type BottomTab = 'callstack' | 'memory' | 'watch'

/** 左侧纵向 tab 按钮（垂直列表：图标 + 完整标签横向排列） */
function RailTab({
  active,
  onClick,
  icon: Icon,
  label,
  title,
}: {
  active: boolean
  onClick: () => void
  icon: React.ElementType
  label: string
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      className={cn(
        'flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left text-xs transition-colors',
        active
          ? 'border-primary bg-primary/10 font-medium text-primary'
          : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

/** 底部横向 tab 按钮 */
function BottomTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ElementType
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
      <Icon className="size-3.5" />
      {label}
    </button>
  )
}

/**
 * Zone 调试工作台主页（SEGGER Ozone 式布局）
 * 顶部工具栏 + 左侧纵向tab(源码文件/函数/内存占用) + 主源码视图 + 右侧(反汇编/纵向tab检查器) + 底部(控制台/调用栈/调用图/观察)
 */
export default function ZonePage() {
  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  // 左侧 dock 宽度（0 = 隐藏）
  const [sourceWidth, setSourceWidth] = useState(SOURCE_PANEL_DEFAULT)
  // 右侧 dock 宽度（0 = 隐藏）
  const [dockWidth, setDockWidth] = useState(DOCK_DEFAULT_WIDTH)
  // 底部 dock 高度（0 = 隐藏）
  const [dockHeight, setDockHeight] = useState(TERMINAL_DEFAULT_HEIGHT)
  // 底部左栏（Console）宽度比例（0~1，右栏占 1 - ratio），默认各 50%
  const [bottomLeftRatio, setBottomLeftRatio] = useState(0.5)

  // 左侧手风琴：可同时展开多个 section，折叠的固定在底部（Source Files 默认展开）
  const [expandedLeft, setExpandedLeft] = useState<LeftTab[]>(['source'])
  // 底部右栏 tab（默认 Call Stack）
  const [bottomTab, setBottomTab] = useState<BottomTab>('callstack')

  const toggleLeft = useCallback((id: LeftTab) => {
    setExpandedLeft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  // 连接断开时重置调试状态，避免残留
  const refreshStatus = useZoneStore((s) => s.refreshStatus)
  const setState = useZoneStore((s) => s.setState)
  const setBreakpoints = useZoneStore((s) => s.setBreakpoints)
  useEffect(() => {
    if (isConnected && uid) {
      void refreshStatus(uid)
    } else {
      setState('disconnected')
      // 断开/重连后清除所有断点，避免 UI 残留
      useZoneStore.getState().breakpoints.length > 0 && setBreakpoints([])
    }
  }, [isConnected, uid, refreshStatus, setState, setBreakpoints])

  // 跟踪 PC 所在函数：暂停时把 PC 解析为函数名，供 Step Out 按钮禁用判断（非函数行禁用）
  const setCurrentFunction = useZoneStore((s) => s.setCurrentFunction)
  const zoneState = useZoneStore((s) => s.state)
  const pc = useZoneStore((s) => s.pc)
  useEffect(() => {
    if (!uid || zoneState !== 'halted' || pc == null) {
      setCurrentFunction(null)
      return
    }
    let cancelled = false
    zoneService
      .zoneSourceLine(uid, pc)
      .then((line) => {
        if (!cancelled) setCurrentFunction(line?.function ?? null)
      })
      .catch(() => {
        if (!cancelled) setCurrentFunction(null)
      })
    return () => {
      cancelled = true
    }
  }, [uid, zoneState, pc, setCurrentFunction])

  // 周期轮询目标运行状态：在 on_stop 刷新模式下，Run 后目标若命中断点而暂停，
  // 状态不会自动同步到 store —— 必须主动轮询才能把 run→halt 的转变反映到 state/pc，
  // 否则断点命中后界面仍停留在"运行中"，表现为"没停在断点处"。
  useEffect(() => {
    if (!isConnected || !uid) return
    const timer = setInterval(() => {
      void refreshStatus(uid)
    }, 1000)
    return () => clearInterval(timer)
  }, [isConnected, uid, refreshStatus])

  // 左侧面板宽度拖拽（面板在分隔条左侧：向右拖动→变宽）
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

  // 底部 dock 高度拖拽（保留手动拖拽，设最小高度，不再支持双击隐藏）
  const handleDockHeightResize = useCallback((deltaY: number) => {
    setDockHeight((h) =>
      Math.max(TERMINAL_MIN_HEIGHT, Math.min(window.innerHeight * TERMINAL_MAX_RATIO, h - deltaY))
    )
  }, [])

  // 底部左右分隔拖拽：分隔条在左栏右侧，向右拖动→左栏变宽（delta 为横向增量）
  const handleBottomSplitResize = useCallback((delta: number) => {
    setBottomLeftRatio((r) => Math.max(0.2, Math.min(0.8, r + delta / (window.innerWidth ?? 1280))))
  }, [])

  // 左侧手风琴 section 配置：可多选展开，共享显示空间，折叠项固定在底部
  const leftSections = [
    { id: 'source' as LeftTab, label: 'Source Files', icon: FileCode2, content: <SourceFilesPanel uid={uid} connected={isConnected} /> },
    { id: 'functions' as LeftTab, label: 'Functions', icon: FunctionSquare, content: <FunctionsPanel uid={uid} connected={isConnected} /> },
    { id: 'memory' as LeftTab, label: 'Memory Usage', icon: MemoryStick, content: <MemoryUsagePanel uid={uid} connected={isConnected} /> },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部工具栏 */}
      <Toolbar uid={uid} connected={isConnected} />

      {/* 中部：左侧dock | 主源码 | 右侧dock */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧 dock：手风琴（多选展开，共享高度） */}
        <div
          className={sourceWidth > 0 ? 'flex shrink-0 flex-col overflow-hidden border-r border-border bg-card' : 'hidden'}
          style={sourceWidth > 0 ? { width: sourceWidth } : undefined}
        >
          {/* 左侧手风琴：所有 section 保持挂载，折叠时仅隐藏内容区（避免重挂载导致重新拉取数据） */}
          {leftSections.map((s) => {
            const isExpanded = expandedLeft.includes(s.id)
            return (
              <div
                key={s.id}
                className={isExpanded ? 'flex min-h-0 flex-1 flex-col' : 'flex shrink-0 flex-col'}
              >
                <RailTab active={isExpanded} onClick={() => toggleLeft(s.id)} icon={s.icon} label={s.label} title={s.label} />
                <div className={isExpanded ? 'min-h-0 flex-1 overflow-hidden border-t border-border' : 'hidden'}>
                  {s.content}
                </div>
              </div>
            )
          })}
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

        {/* 右侧 dock：检查器手风琴（反汇编/寄存器/外设/内存，多选展开） */}
        <div
          className={dockWidth > 0 ? 'flex shrink-0 flex-col overflow-hidden border-l border-border bg-card' : 'hidden'}
          style={dockWidth > 0 ? { width: dockWidth } : undefined}
        >
          <InspectorDock uid={uid} connected={isConnected} />
        </div>
      </div>

      {/* 底部拖拽把手（保留拖拽，无双击隐藏） */}
      <ResizeHandle
        onResize={handleDockHeightResize}
        expanded={dockHeight > 0}
      />

      {/* 底部 dock：左右分栏，左栏 Console 固定，右栏 Call Stack/Memory/Watch tab 区 */}
      <div
        className={dockHeight > 0 ? 'flex shrink-0 flex-col border-t border-border bg-card' : 'hidden'}
        style={dockHeight > 0 ? { height: dockHeight } : undefined}
      >
        <div className="flex min-h-0 flex-1">
          {/* 左栏：Console 固定（无 tab 栏） */}
          <div className="flex min-w-0 flex-col overflow-hidden" style={{ width: `${bottomLeftRatio * 100}%` }}>
            <div className="flex shrink-0 items-center border-b border-border">
              <BottomTab active icon={SquareTerminal} label="Console" />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <TerminalDock />
            </div>
          </div>
          {/* 左右分隔条 */}
          <ResizeHandle
            direction="horizontal"
            onResize={handleBottomSplitResize}
            expanded={bottomLeftRatio > 0}
          />
          {/* 右栏：Call Stack / Memory / Watch tab 区（flex-1 占剩余，分隔条宽度自动吸收） */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center border-b border-border">
              <BottomTab active={bottomTab === 'callstack'} onClick={() => setBottomTab('callstack')} icon={ListTree} label="Call Stack" />
              <BottomTab active={bottomTab === 'watch'} onClick={() => setBottomTab('watch')} icon={Eye} label="Watch" />
              <BottomTab active={bottomTab === 'memory'} onClick={() => setBottomTab('memory')} icon={MemoryStick} label="Memory" />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {bottomTab === 'callstack' && <CallStackPanel uid={uid} connected={isConnected} />}
              {bottomTab === 'watch' && <WatchPanel uid={uid} connected={isConnected} />}
              {bottomTab === 'memory' && <MemoryPanel uid={uid} connected={isConnected} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}