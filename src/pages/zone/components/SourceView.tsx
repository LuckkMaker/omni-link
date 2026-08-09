import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertCircle, X } from 'lucide-react'
import { useZoneStore } from '../store'
import * as zoneService from '@/services/zone.service'
import { tokenizeLine, createHighlightState, detectLang } from '@/lib/source-highlight'
import { cn } from '@/lib/utils'

interface SourceViewProps {
  uid: string | null
}

/** 将两个源码路径归一化为可比较形态（统一 / 分隔、去尾部 /） */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 源码视图：行号 + 语法高亮 + PC 行高亮 + 断点。
 * start session 后 PC 变化会自动切换到对应源文件并把执行行滚动到窗口中央并高亮。
 * 行号左侧为断点槽：灰色圆点表示可设置断点，点击后变红为已激活断点。
 */
export function SourceView({ uid }: SourceViewProps) {
  const activeSourceFile = useZoneStore((s) => s.activeSourceFile)
  const setActiveSourceFile = useZoneStore((s) => s.setActiveSourceFile)
  const openFiles = useZoneStore((s) => s.openFiles)
  const followSource = useZoneStore((s) => s.followSource)
  const openSourceFile = useZoneStore((s) => s.openSourceFile)
  const closeSourceFile = useZoneStore((s) => s.closeSourceFile)
  const ensureSourceFile = useZoneStore((s) => s.ensureSourceFile)
  const sourceFiles = useZoneStore((s) => s.sourceFiles)
  const pc = useZoneStore((s) => s.pc)
  const state = useZoneStore((s) => s.state)
  const breakpoints = useZoneStore((s) => s.breakpoints)
  const toggleBreakpoint = useZoneStore((s) => s.toggleBreakpoint)
  const refreshBreakpoints = useZoneStore((s) => s.refreshBreakpoints)

  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pcLine, setPcLine] = useState<number | null>(null)
  // 可执行（可打断点）的行号集合；仅在这些行显示断点标记
  const [executableLines, setExecutableLines] = useState<Set<number>>(new Set())
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)
  // 切换源文件后待跳转的 PC 行（文件加载完成后应用）
  const pendingPcRef = useRef<{ file: string; line: number } | null>(null)

  const lang = detectLang(activeSourceFile)

  // 整文件一次分词（块注释状态跨行保持），按文件内容 memo
  const rows = useMemo(() => {
    if (lines.length === 0) return []
    const st = createHighlightState()
    return lines.map((l) => tokenizeLine(l, st, lang))
  }, [lines, lang])

  // 连接后刷新断点列表
  useEffect(() => {
    if (uid) void refreshBreakpoints(uid)
  }, [uid, refreshBreakpoints])

  // 将指定行滚动到容器中央（相比 scrollIntoView 更稳定，不受 sticky 与祖先滚动影响）
  // 使用双重 requestAnimationFrame：首帧布局稳定后，第二帧再滚动，确保行元素已渲染定位
  const scrollToLine = useCallback((lineNo: number) => {
    const container = containerRef.current
    const el = lineRefs.current.get(lineNo)
    if (!container || !el) return
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const lineH = eRect.height || 16
    const target = container.scrollTop + (eRect.top - cRect.top) - cRect.height / 2 + lineH / 2
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.scrollTo({ top: Math.max(0, target), behavior: 'auto' })
      })
    })
  }, [])

  // 加载选中的源文件
  useEffect(() => {
    if (!uid || !activeSourceFile) {
      setLines([])
      setPcLine(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    zoneService
      .zoneSourceContent(uid, activeSourceFile)
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setLines(res.lines ?? [])
          // 若存在待跳转的 PC 行且属于当前文件，加载后应用；否则当前文件无执行位置
          const pending = pendingPcRef.current
          if (pending && norm(pending.file) === norm(activeSourceFile)) {
            pendingPcRef.current = null
            setPcLine(pending.line)
            requestAnimationFrame(() => scrollToLine(pending.line))
          } else {
            setPcLine(null)
          }
        } else {
          setLines([])
          setError(res.error ?? '源码读取失败')
        }
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '源码读取失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [uid, activeSourceFile, scrollToLine])

  // 根据 PC 定位源码行；若 PC 落在其他文件则自动切换源文件
  useEffect(() => {
    if (!uid || pc === null || pc === undefined) {
      setPcLine(null)
      return
    }
    let cancelled = false
    zoneService
      .zoneSourceLine(uid, pc)
      .then((line) => {
        if (cancelled) return
        if (line && line.file) {
          const targetBase = norm(line.file)
          const cur = norm(activeSourceFile ?? '')
          // 在源文件列表中定位完整路径（get_line 返回的可能是 basename）
          const targetFull =
            sourceFiles.find((f) => {
              const fp = norm(f.path)
              return fp === targetBase || fp.endsWith('/' + targetBase) || fp.endsWith(targetBase)
            })?.path ?? null
          if (!targetFull) {
            setPcLine(null)
            return
          }
          // 始终保证执行文件已作为 tab 打开（不覆盖用户当前选择）
          ensureSourceFile(targetFull)
          if (targetFull !== activeSourceFile) {
            if (followSource) {
              // 跟随：记录待跳转行并切换文件，加载完成后由上面 effect 应用
              pendingPcRef.current = { file: targetFull, line: line.line ?? 1 }
              setActiveSourceFile(targetFull)
            } else {
              // 用户手动选择了其他文件：跟随暂停，不强制切换，当前文件无执行位置
              setPcLine(null)
            }
            return
          }
          pendingPcRef.current = null
          setPcLine(line.line ?? null)
          scrollToLine(line.line ?? -1)
        } else {
          setPcLine(null)
        }
      })
      .catch(() => setPcLine(null))
    return () => {
      cancelled = true
    }
  }, [uid, pc, activeSourceFile, sourceFiles, setActiveSourceFile, ensureSourceFile, followSource, state, scrollToLine])

  // 加载当前文件的可执行行号（仅这些行可打断点）
  useEffect(() => {
    if (!uid || !activeSourceFile) {
      setExecutableLines(new Set())
      return
    }
    let cancelled = false
    zoneService
      .zoneExecutableLines(uid, activeSourceFile)
      .then((res) => {
        if (cancelled) return
        if (res.success && res.lines) setExecutableLines(new Set(res.lines))
        else setExecutableLines(new Set())
      })
      .catch(() => setExecutableLines(new Set()))
    return () => {
      cancelled = true
    }
  }, [uid, activeSourceFile])

  // PC 行吸附：当 PC 解析到的行是空行/非代码行（如函数 epilogue 被 DWARF 行表映射到函数体外的空行）时，
  // 向上吸附到最近的真实代码行（优先可执行行），避免高亮停在函数大括号之外。
  useEffect(() => {
    if (pcLine == null || lines.length === 0) return
    const content = lines[pcLine - 1]
    const isEmpty = !content || content.trim() === ''
    if (!isEmpty) return
    // 空行 → 从上一行向上找最近的非空行；executableLines 已就绪时要求目标行可执行
    for (let l = pcLine - 1; l >= 1; l--) {
      const c = lines[l - 1]
      if (!c || c.trim() === '') continue
      if (executableLines.size > 0 && !executableLines.has(l)) continue
      if (l !== pcLine) {
        setPcLine(l)
        scrollToLine(l)
      }
      return
    }
    // 未找到可吸附的代码行 → 取消高亮（当前位置无有效源码行）
    setPcLine(null)
  }, [pcLine, lines, executableLines, scrollToLine])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 源码 tab 栏：已打开文件列表，点击切换（用户手动切换后暂停 PC 自动跟随） */}
      {openFiles.length > 0 && (
        <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted/20">
          {openFiles.map((f) => {
            const active = norm(f) === norm(activeSourceFile ?? '')
            const name = f.replace(/\\/g, '/').split('/').pop() ?? f
            return (
              <div
                key={f}
                className={cn(
                  'flex shrink-0 items-stretch border-r border-border',
                  active ? 'bg-background' : 'hover:bg-muted/40'
                )}
                title={f}
              >
                <button
                  onClick={() => openSourceFile(f)}
                  className={cn(
                    'flex h-7 items-center gap-1 whitespace-nowrap px-3 text-xs',
                    active ? 'font-medium text-primary' : 'text-muted-foreground'
                  )}
                >
                  {name}
                </button>
                <button
                  onClick={() => closeSourceFile(f)}
                  className={cn(
                    'flex h-7 w-6 shrink-0 items-center justify-center text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-500',
                    active && 'text-primary/60'
                  )}
                  title="关闭"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-relaxed"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载中...
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center gap-2 text-red-500">
            <AlertCircle className="size-4" />
            <span className="max-w-md truncate">{error}</span>
          </div>
        ) : lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
           Session 未启动
          </div>
        ) : (
          lines.map((content, idx) => {
            const lineNo = idx + 1
            const isPcLine = lineNo === pcLine
            const tokens = rows[idx] ?? []
            const hasBp = breakpoints.some(
              (b) =>
                b.line === lineNo &&
                (norm(b.file) === norm(activeSourceFile ?? '') ||
                  norm(b.file).endsWith('/' + norm(activeSourceFile ?? '')) ||
                  norm(activeSourceFile ?? '').endsWith('/' + norm(b.file)))
            )
            // 仅可执行行可打断点；PC 行与已设断点行也始终允许操作
            const isExecutable = executableLines.has(lineNo) || isPcLine || hasBp
            return (
              <div
                key={lineNo}
                ref={(el) => {
                  if (el) lineRefs.current.set(lineNo, el)
                  else lineRefs.current.delete(lineNo)
                }}
                className={
                  isPcLine
                    ? 'flex border-b border-primary/15 bg-primary/10'
                    : 'flex border-b border-transparent hover:bg-muted/30'
                }
              >
                {/* 断点槽 + PC 标记 + 行号 */}
                <div className="sticky left-0 flex w-14 shrink-0 select-none items-center gap-1 bg-background pr-1 text-right">
                  {isExecutable ? (
                    <button
                      onClick={() => uid && activeSourceFile && toggleBreakpoint(uid, activeSourceFile, lineNo)}
                      disabled={!uid || !activeSourceFile || state === 'disconnected'}
                      title={hasBp ? '移除断点' : '设置断点'}
                      className="flex w-3 shrink-0 cursor-pointer items-center justify-center text-[11px] leading-none transition-transform hover:scale-125 disabled:cursor-default disabled:opacity-40"
                    >
                      {hasBp ? (
                        <span className="text-red-500">●</span>
                      ) : isPcLine ? (
                        <span className="font-bold leading-none text-primary">▶</span>
                      ) : (
                        <span className="text-gray-300">●</span>
                      )}
                    </button>
                  ) : (
                    <span className="flex w-3 shrink-0" />
                  )}
                  <span className={isPcLine ? 'font-bold text-primary' : 'text-muted-foreground'}>
                    {lineNo}
                  </span>
                </div>
                {/* 代码（带语法高亮） */}
                <pre className="flex-1 whitespace-pre pr-4">
                  {tokens.length
                    ? tokens.map((t, ti) =>
                        t.cls ? (
                          <span key={ti} className={t.cls}>
                            {t.text}
                          </span>
                        ) : (
                          t.text
                        )
                      )
                    : content || ' '}
                </pre>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}