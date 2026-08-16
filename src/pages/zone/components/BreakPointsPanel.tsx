import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { X } from 'lucide-react'
import { useZoneStore } from '../store'
import type { SourceBreakpoint } from '@/services/zone.service'
import { cn } from '@/lib/utils'

/** 取文件 basename（兼容 Windows/Unix 路径分隔符） */
function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return norm.slice(norm.lastIndexOf('/') + 1) || p
}

/** 规范化路径（与 SourceView 一致） */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
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

interface CtxMenuState {
  x: number
  y: number
  bp: SourceBreakpoint
}

/** 断点符号（与源码窗口 glyph 一致）：启用=红色实心圆，禁用=灰色空心圆 */
function BreakpointSymbol({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        'inline-block size-3 shrink-0 rounded-full',
        enabled ? 'bg-[#f85149]' : 'border-[1.5px] border-slate-400/80'
      )}
      title={enabled ? '启用断点' : '关闭断点'}
    />
  )
}

/** BreakPoints 面板：列举所有断点的 [Checkbox][file:line]，支持点击跳转源码/启停/删除/右键启停删除 */
export function BreakPointsPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const breakpoints = useZoneStore((s) => s.breakpoints)
  const refreshBreakpoints = useZoneStore((s) => s.refreshBreakpoints)
  const removeBreakpoint = useZoneStore((s) => s.removeBreakpoint)
  const setBreakpointEnabled = useZoneStore((s) => s.setBreakpointEnabled)
  const sourceFiles = useZoneStore((s) => s.sourceFiles)
  const gotoSource = useZoneStore((s) => s.gotoSource)

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  // 点击断点跳转源码：先经源文件列表把 basename 解析为完整路径（与 PC 定位一致），再 gotoSource
  const jumpTo = (bp: SourceBreakpoint) => {
    const target = norm(bp.file)
    const full =
      sourceFiles.find((f) => {
        const fp = norm(f.path)
        return fp === target || fp.endsWith('/' + target) || fp.endsWith(target)
      })?.path ?? bp.file
    gotoSource(full, bp.line)
  }

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {breakpoints.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
            无断点
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
              <BreakpointSymbol enabled={bp.enabled} />
              <Checkbox
                checked={bp.enabled}
                onCheckedChange={(v) => uid && void setBreakpointEnabled(uid, bp.address, !!v)}
                title={bp.enabled ? '关闭断点' : '启用断点'}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 cursor-pointer truncate font-mono hover:text-primary',
                  !bp.enabled && 'text-muted-foreground'
                )}
                title={`${bp.file}:${bp.line} (0x${bp.address.toString(16)})`}
                onClick={() => jumpTo(bp)}
              >
                {baseName(bp.file)}:{bp.line}
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
    </div>
  )
}
