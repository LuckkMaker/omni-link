import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { X, ChevronRight } from 'lucide-react'
import { useZoneStore } from '../store'
import { BreakpointConditionDialog } from './BreakpointConditionDialog'
import type { SourceBreakpoint, BreakpointMode, BreakpointUpdate } from '@/services/zone.service'
import { cn } from '@/lib/utils'

const MODE_LABEL: Record<BreakpointMode, string> = {
  break: 'Break',
  log: 'Log',
  execute: 'Execute',
}

/** 右键菜单项（与 SourceView 一致） */
function MenuItem({
  label,
  onClick,
  disabled,
  checked,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  checked?: boolean
}) {
  return (
    <button
      className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
      onClick={onClick}
      disabled={disabled}
    >
      <span className="flex-1 text-left">{label}</span>
      {checked && <span className="text-primary">✓</span>}
    </button>
  )
}

function MenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-muted/60" />
}

/** 二级展开菜单：编辑模式三档（hover 展开） */
function ModeMenuSub({
  bp,
  onPick,
}: {
  bp: SourceBreakpoint
  onPick: (mode: BreakpointMode) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className={cn(
          'flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
          open ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
        )}
      >
        <span className="flex-1 text-left">编辑模式</span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </div>
      {open && (
        <div className="absolute left-full top-0 z-50 min-w-[9rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
          {(Object.keys(MODE_LABEL) as BreakpointMode[]).map((m) => (
            <MenuItem key={m} label={MODE_LABEL[m]} checked={m === bp.mode} onClick={() => onPick(m)} />
          ))}
        </div>
      )}
    </div>
  )
}

interface CtxMenuState {
  x: number
  y: number
  bp: SourceBreakpoint
}

/** BreakPoints 面板：列举所有断点的 [Checkbox][file:line]，支持启停/删除/右键编辑 */
export function BreakPointsPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const breakpoints = useZoneStore((s) => s.breakpoints)
  const refreshBreakpoints = useZoneStore((s) => s.refreshBreakpoints)
  const updateBreakpoint = useZoneStore((s) => s.updateBreakpoint)
  const removeBreakpoint = useZoneStore((s) => s.removeBreakpoint)
  const setBreakpointEnabled = useZoneStore((s) => s.setBreakpointEnabled)

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  const [editTarget, setEditTarget] = useState<SourceBreakpoint | null>(null)

  // uid/连接变化时拉取断点列表
  useEffect(() => {
    if (uid && connected) void refreshBreakpoints(uid)
  }, [uid, connected, refreshBreakpoints])

  // 菜单贴底/贴右时自动回移，避免超出视口
  useLayoutEffect(() => {
    if (!ctxMenu || !ctxMenuRef.current) return
    const menu = ctxMenuRef.current
    const rect = menu.getBoundingClientRect()
    const MARGIN = 8
    let left = rect.left
    let top = rect.top
    if (rect.right > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN)
    }
    if (rect.bottom > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN)
    }
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [ctxMenu])

  // 点击其他区域 / 滚动时关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])

  const handleSave = (bp: SourceBreakpoint) => (patch: BreakpointUpdate) => {
    setEditTarget(null)
    if (uid) void updateBreakpoint(uid, bp.address, patch)
  }

  const editLabel = (m: BreakpointMode) =>
    m === 'log' ? '编辑日志内容' : m === 'execute' ? '编辑执行命令' : '编辑条件'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {breakpoints.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
            暂无断点（在源码行点击行号或按 F9 添加）
          </div>
        ) : (
          breakpoints.map((bp) => (
            <div
              key={bp.address}
              className="flex items-center gap-2 border-b border-border/50 px-2 py-1 text-xs hover:bg-muted/30"
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu({ x: e.clientX, y: e.clientY, bp })
              }}
            >
              <Checkbox
                checked={bp.enabled}
                onCheckedChange={(v) => uid && void setBreakpointEnabled(uid, bp.address, !!v)}
                title={bp.enabled ? '禁用断点' : '启用断点'}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono',
                  !bp.enabled && 'text-muted-foreground line-through'
                )}
                title={`${bp.file}:${bp.line} (0x${bp.address.toString(16)})`}
              >
                {bp.file}:{bp.line}
              </span>
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                {MODE_LABEL[bp.mode]}
              </span>
              {!bp.enabled && (
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  禁用
                </span>
              )}
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => uid && void removeBreakpoint(uid, bp.address)}
                title="移除断点"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="fixed z-50 min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItem label={editLabel(ctxMenu.bp.mode)} onClick={() => { setEditTarget(ctxMenu.bp); setCtxMenu(null) }} />
          <ModeMenuSub
            bp={ctxMenu.bp}
            onPick={(m) => {
              setCtxMenu(null)
              if (uid) void updateBreakpoint(uid, ctxMenu.bp.address, { mode: m })
            }}
          />
          <MenuSeparator />
          {ctxMenu.bp.enabled ? (
            <MenuItem
              label="关闭断点"
              onClick={() => { setCtxMenu(null); if (uid) void setBreakpointEnabled(uid, ctxMenu.bp.address, false) }}
            />
          ) : (
            <MenuItem
              label="开启断点"
              onClick={() => { setCtxMenu(null); if (uid) void setBreakpointEnabled(uid, ctxMenu.bp.address, true) }}
            />
          )}
          <MenuItem
            label="移除断点"
            onClick={() => { setCtxMenu(null); if (uid) void removeBreakpoint(uid, ctxMenu.bp.address) }}
          />
        </div>
      )}

      {editTarget && uid && (
        <BreakpointConditionDialog
          open={!!editTarget}
          bp={editTarget}
          onOpenChange={(open) => { if (!open) setEditTarget(null) }}
          onSave={handleSave(editTarget)}
        />
      )}
    </div>
  )
}