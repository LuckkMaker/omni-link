import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertCircle, X, ChevronLeft, ChevronRight } from 'lucide-react'
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

/** 判断两个源码路径（可能一个为 basename）是否指向同一文件 */
function isSameSource(a: string, b: string): boolean {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
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
  const closedByUser = useZoneStore((s) => s.closedByUser)
  const openSourceFile = useZoneStore((s) => s.openSourceFile)
  const closeSourceFile = useZoneStore((s) => s.closeSourceFile)
  const closeOtherFiles = useZoneStore((s) => s.closeOtherFiles)
  const closeAllFiles = useZoneStore((s) => s.closeAllFiles)
  const ensureSourceFile = useZoneStore((s) => s.ensureSourceFile)
  const sourceFiles = useZoneStore((s) => s.sourceFiles)
  const pc = useZoneStore((s) => s.pc)
  const state = useZoneStore((s) => s.state)
  const elfPath = useZoneStore((s) => s.elfPath)
  const breakpoints = useZoneStore((s) => s.breakpoints)
  const toggleBreakpoint = useZoneStore((s) => s.toggleBreakpoint)
  const refreshBreakpoints = useZoneStore((s) => s.refreshBreakpoints)
  const cursorLine = useZoneStore((s) => s.cursorLine)
  const setCursorLine = useZoneStore((s) => s.setCursorLine)
  const navGoto = useZoneStore((s) => s.navGoto)
  const clearGoto = useZoneStore((s) => s.clearGoto)
  const gotoSource = useZoneStore((s) => s.gotoSource)
  // 始终持有最新 pc；文件加载 effect 内读取它但不在依赖中，避免每次 pc 变化都重拉文件
  const pcRef = useRef(pc)
  useEffect(() => {
    pcRef.current = pc
  }, [pc])

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
  // 最近一次解析到的 PC 源码位置；供文件加载完成后滚动居中（覆盖自动跟随之外的场景）
  const pcLocationRef = useRef<{ file: string; line: number } | null>(null)
  // 每个已打开文件记住的滚动位置（完整路径 -> scrollTop），切换 tab 回来时恢复
  const scrollPositionsRef = useRef<Map<string, number>>(new Map())
  // 当前正在显示的文件（用于切换时记录旧文件的滚动位置）
  const currentFileRef = useRef<string | null>(null)
  // 最新 followSource 值（用户手动切换 vs PC 自动跟随判断）
  const followSourceRef = useRef(followSource)
  useEffect(() => {
    followSourceRef.current = followSource
  }, [followSource])
  // 文件 tab 右键菜单（触发位置 + 目标文件）
  const [tabMenu, setTabMenu] = useState<{ file: string; x: number; y: number } | null>(null)
  // tab 栏横向滚动（滚轮 + 左右按钮切换）
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false })

  const updateTabOverflow = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    setTabOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    })
  }, [])

  // tab 栏挂载/文件变化时：绑定滚轮横向滚动（阻止页面随之滚动）+ 监听 scroll 更新按钮可用态
  useEffect(() => {
    const el = tabScrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', updateTabOverflow)
    updateTabOverflow()
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', updateTabOverflow)
    }
  }, [openFiles, updateTabOverflow])

  const scrollTabs = useCallback((dir: -1 | 1) => {
    tabScrollRef.current?.scrollBy({ left: dir * 220, behavior: 'smooth' })
  }, [])
  // 代码区右键菜单（触发位置 + 光标处标识符）
  const [codeMenu, setCodeMenu] = useState<{ x: number; y: number; word: string } | null>(null)
  // 转到引用结果面板（触发位置 + 查询词 + 命中列表）
  const [refsPanel, setRefsPanel] = useState<{
    x: number
    y: number
    query: string
    hits: { file: string; line: number; text: string }[]
    loading: boolean
  } | null>(null)

  // 取点击位置处的标识符（转到定义/引用使用）。Electron 基于 Chromium，支持 caretRangeFromPoint。
  const wordAtPoint = useCallback((clientX: number, clientY: number): string => {
    const range = document.caretRangeFromPoint?.(clientX, clientY)
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return ''
    const text = range.startContainer.textContent ?? ''
    let start = range.startOffset
    while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--
    let end = range.startOffset
    while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++
    const word = text.slice(start, end)
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) ? word : ''
  }, [])

  // 复制当前选区文本（无选区时复制光标处单词）
  const copySelection = useCallback(() => {
    const sel = window.getSelection()
    const text = sel && sel.toString().length > 0 ? sel.toString() : codeMenu?.word ?? ''
    if (text) void navigator.clipboard?.writeText(text).catch(() => {})
    setCodeMenu(null)
  }, [codeMenu])

  // 全选当前文件全部代码
  const selectAll = useCallback(() => {
    const node = containerRef.current
    if (!node) return
    const range = document.createRange()
    range.selectNodeContents(node)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    setCodeMenu(null)
  }, [])

  // 把符号文件路径映射到 sourceFiles 中的已知路径（不同目录同名文件按完整路径匹配，否则退化为 basename）
  const matchSourceFile = useCallback((file: string): string | null => {
    const n = norm(file)
    return (
      sourceFiles.find((f) => {
        const fp = norm(f.path)
        return fp === n || fp.endsWith('/' + n) || n.endsWith('/' + fp)
      })?.path ?? null
    )
  }, [sourceFiles])

  // 转到定义：后端符号表解析 → 打开文件并滚动到对应行
  const goToDefinition = useCallback(async () => {
    if (!uid || !codeMenu?.word) return
    setCodeMenu(null)
    const res = await zoneService.zoneResolveSymbol(uid, codeMenu.word)
    if (!res.success || !res.symbol || !res.symbol.file || res.symbol.line == null) {
      useZoneStore.getState().setError?.(`未找到符号定义: ${codeMenu.word}`)
      return
    }
    const target = matchSourceFile(res.symbol.file)
    if (target) gotoSource(target, res.symbol.line)
    else useZoneStore.getState().setError?.(`定义文件不在源码列表: ${res.symbol.file}`)
  }, [uid, codeMenu, matchSourceFile, gotoSource])

  // 转到引用：轻量全文检索，结果在面板中列出
  const goToReferences = useCallback(async () => {
    if (!uid || !codeMenu?.word) return
    const query = codeMenu.word
    const base = { x: codeMenu.x, y: codeMenu.y, query }
    setCodeMenu(null)
    setRefsPanel({ ...base, hits: [], loading: true })
    try {
      const res = await zoneService.zoneSearchSource(uid, query)
      setRefsPanel((p) => (p && p.query === query ? { ...p, hits: res.results ?? [], loading: false } : p))
    } catch {
      setRefsPanel((p) => (p && p.query === query ? { ...p, hits: [], loading: false } : p))
    }
  }, [uid, codeMenu])

  // 关闭右键菜单/引用面板：点击外部 / 按 ESC / 窗口失焦
  useEffect(() => {
    if (!tabMenu && !codeMenu && !refsPanel) return
    const close = () => {
      setTabMenu(null)
      setCodeMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTabMenu(null)
        setCodeMenu(null)
        setRefsPanel(null)
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [tabMenu, codeMenu, refsPanel])

  const lang = detectLang(activeSourceFile)

  // 整文件一次分词（块注释状态跨行保持），按文件内容 memo
  const rows = useMemo(() => {
    if (lines.length === 0) return []
    const st = createHighlightState()
    return lines.map((l) => tokenizeLine(l, st, lang))
  }, [lines, lang])

  // 连接后刷新断点列表
  useEffect(() => {
    if (uid && elfPath) void refreshBreakpoints(uid)
  }, [uid, elfPath, refreshBreakpoints])

  // 将指定行滚动到容器中央（相比 scrollIntoView 更稳定，不受 sticky 与祖先滚动影响）
  // 使用双重 requestAnimationFrame：首帧布局稳定后，第二帧再滚动，确保行元素已渲染定位。
  // 关键：元素（lineRefs）的获取也必须在 rAF 内完成——若在同步阶段读取，React 尚未渲染
  // 新内容，会拿到 undefined 导致不滚动（这是"停在 main 却不滚动"的根因）。
  // onlyIfOutOfView=true 时，仅当该行中心不在可视区内才滚动居中，避免打断用户阅读。
  const scrollToLine = useCallback((lineNo: number, onlyIfOutOfView = true) => {
    const container = containerRef.current
    if (!container) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = lineRefs.current.get(lineNo)
        if (!container || !el) return
        const cRect = container.getBoundingClientRect()
        const eRect = el.getBoundingClientRect()
        const lineH = eRect.height || 16
        const center = eRect.top + lineH / 2
        if (onlyIfOutOfView && center >= cRect.top && center <= cRect.bottom) return
        const target = container.scrollTop + (eRect.top - cRect.top) - cRect.height / 2 + lineH / 2
        container.scrollTo({ top: Math.max(0, target), behavior: 'auto' })
      })
    })
  }, [])

  // 回到容器顶部（切换到的文件不含当前 PC 时的默认定位，避免停留在上一文件的滚动偏移）
  const scrollToTop = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({ top: 0, behavior: 'auto' })
      })
    })
  }, [])

  // 恢复到指定滚动位置（用户手动切换回已打开文件时使用）
  const restoreScrollPosition = useCallback((top: number) => {
    const container = containerRef.current
    if (!container) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
      })
    })
  }, [])

  // 文件切换时记录旧文件的滚动位置（需在内容更新前记录，故在 activeSourceFile 变化的副作用里读取当前容器）
  useEffect(() => {
    const prev = currentFileRef.current
    if (prev && prev !== activeSourceFile && containerRef.current) {
      scrollPositionsRef.current.set(prev, containerRef.current.scrollTop)
    }
    currentFileRef.current = activeSourceFile ?? null
  }, [activeSourceFile])

  // 加载选中的源文件
  useEffect(() => {
    if (!uid || !activeSourceFile) {
      setLines([])
      setPcLine(null)
      return
    }
    // 切换文件后，若光标行不属于新文件则清空，避免跨文件误触发 Run to Cursor / 断点操作
    if (cursorLine && !isSameSource(norm(cursorLine.file), activeSourceFile)) {
      setCursorLine(null)
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
          // 「转到定义/引用」导航目标优先：打开文件后滚动到目标行并清除
          const nav = navGoto
          if (nav && norm(nav.file) === norm(activeSourceFile)) {
            clearGoto()
            setPcLine(null)
            setCursorLine({ file: activeSourceFile, line: nav.line })
            scrollToLine(nav.line, false)
            return
          }
          // 用户手动切换回已打开并滚动过的文件：恢复记住的滚动位置（优先于 PC 定位滚动）；
          // 自动跟随（单步/运行）切换时 followSource 为 true，不在此分支，仍滚动到 PC 行
          if (followSourceRef.current === false) {
            const saved = scrollPositionsRef.current.get(activeSourceFile)
            if (saved !== undefined) {
              // 仍标记 PC 行高亮（若 PC 在此文件），但不滚动到 PC
              const pcLoc = pcLocationRef.current
              if (pcLoc && norm(pcLoc.file) === norm(activeSourceFile)) {
                setPcLine(pcLoc.line)
              } else {
                setPcLine(null)
              }
              restoreScrollPosition(saved)
              return
            }
          }
          // 优先应用待跳转 PC 行（自动跟随切换文件时由 PC 定位 effect 设置）
          const pending = pendingPcRef.current
          if (pending && norm(pending.file) === norm(activeSourceFile)) {
            pendingPcRef.current = null
            setPcLine(pending.line)
            scrollToLine(pending.line)
            return
          }
          // 用户手动切换到含 PC 的文件：pending 未命中，改用最近一次解析到的 PC 位置居中
          const pcLoc = pcLocationRef.current
          if (pcLoc && norm(pcLoc.file) === norm(activeSourceFile)) {
            setPcLine(pcLoc.line)
            scrollToLine(pcLoc.line)
            return
          }
          // 兜底：实时查询当前 PC 在该文件对应的行（覆盖 pcLocationRef 尚未就绪的时序）
          const curPc = pcRef.current
          if (curPc != null && curPc !== undefined) {
            zoneService
              .zoneSourceLine(uid, curPc)
              .then((line) => {
                if (cancelled) return
                if (
                  line &&
                  line.file &&
                  (norm(line.file) === norm(activeSourceFile) ||
                    norm(line.file).endsWith('/' + norm(activeSourceFile)))
                ) {
                  setPcLine(line.line ?? null)
                  scrollToLine(line.line ?? -1)
                } else {
                  setPcLine(null)
                  scrollToTop()
                }
              })
              .catch(() => {
                setPcLine(null)
                scrollToTop()
              })
          } else {
            setPcLine(null)
            scrollToTop()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, activeSourceFile, scrollToLine, scrollToTop])

  // 根据 PC 定位源码行；若 PC 落在其他文件则自动切换源文件
  useEffect(() => {
    if (!uid || !elfPath || pc === null || pc === undefined) {
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
          // 记录最近一次 PC 源码位置，供文件加载完成后滚动居中
          pcLocationRef.current = { file: targetFull, line: line.line ?? 1 }
          if (targetFull !== activeSourceFile) {
            if (followSource && !closedByUser.includes(targetFull)) {
              // 跟随：记录待跳转行并切换文件，加载完成后由上面 effect 应用
              pendingPcRef.current = { file: targetFull, line: line.line ?? 1 }
              setActiveSourceFile(targetFull)
            } else {
              // 用户主动关闭了该文件或手动选择了其他文件：不强制切换，当前文件无执行位置
              setPcLine(null)
            }
            return
          }
          pendingPcRef.current = null
          setPcLine(line.line ?? null)
          // 仅自动跟随（单步/运行）时滚动到 PC 行；用户手动切换回文件时保持其记住的滚动位置
          if (followSourceRef.current) {
            scrollToLine(line.line ?? -1)
          }
        } else {
          setPcLine(null)
        }
      })
      .catch(() => setPcLine(null))
    return () => {
      cancelled = true
    }
  }, [uid, pc, activeSourceFile, sourceFiles, setActiveSourceFile, ensureSourceFile, followSource, state, closedByUser, scrollToLine, elfPath])

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
      {/* 源码 tab 栏（参考 RTT Viewer 风格）：点击切换，tab 过多时滚轮横向滚动 + 左右按钮切换 */}
      {openFiles.length > 0 && (
        <div className="flex shrink-0 items-stretch border-b border-border bg-muted/10">
          {/* 左切换按钮 */}
          <button
            onClick={() => scrollTabs(-1)}
            disabled={!tabOverflow.left}
            className="flex w-6 shrink-0 items-center justify-center border-r border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            title="向左切换"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <div
            ref={tabScrollRef}
            className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
            style={{ scrollbarWidth: 'none' }}
          >
            {openFiles.map((f) => {
              const active = norm(f) === norm(activeSourceFile ?? '')
              const name = f.replace(/\\/g, '/').split('/').pop() ?? f
              return (
                <div
                  key={f}
                  className={cn(
                    'group flex shrink-0 cursor-pointer select-none items-center gap-1 whitespace-nowrap border-b-2 px-2.5 py-1 text-xs transition-colors',
                    active
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                  )}
                  title={f}
                  onClick={() => openSourceFile(f)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setTabMenu({ file: f, x: e.clientX, y: e.clientY })
                  }}
                >
                  <span>{name}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      closeSourceFile(f)
                    }}
                    className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                    title="关闭"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>
          {/* 右切换按钮 */}
          <button
            onClick={() => scrollTabs(1)}
            disabled={!tabOverflow.right}
            className="flex w-6 shrink-0 items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            title="向右切换"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
      {/* 文件 tab 右键菜单：关闭 / 关闭其他 */}
      {tabMenu && (
        <div
          className="fixed z-50 min-w-[9rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              closeSourceFile(tabMenu.file)
              setTabMenu(null)
            }}
          >
            关闭
          </button>
          <button
            className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              closeOtherFiles(tabMenu.file)
              setTabMenu(null)
            }}
            disabled={openFiles.length <= 1}
          >
            关闭其他
          </button>
          <button
            className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              closeAllFiles()
              setTabMenu(null)
            }}
            disabled={openFiles.length === 0}
          >
            关闭所有
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-relaxed"
        onContextMenu={(e) => {
          e.preventDefault()
          const word = wordAtPoint(e.clientX, e.clientY)
          setCodeMenu({ x: e.clientX, y: e.clientY, word })
        }}
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
          <div className="flex h-full items-center justify-center" />
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
            // 当前光标所在行（Run to Cursor / Insert-Remove Breakpoint 的定位标注）
            const isCursorLine =
              cursorLine != null &&
              cursorLine.line === lineNo &&
              (norm(cursorLine.file) === norm(activeSourceFile ?? '') ||
                norm(cursorLine.file).endsWith('/' + norm(activeSourceFile ?? '')) ||
                norm(activeSourceFile ?? '').endsWith('/' + norm(cursorLine.file)))
            return (
              <div
                key={lineNo}
                ref={(el) => {
                  if (el) lineRefs.current.set(lineNo, el)
                  else lineRefs.current.delete(lineNo)
                }}
                onClick={() => {
                  // 正在拖选文本时不触发光标行切换
                  const sel = window.getSelection()
                  if (sel && sel.toString().length > 0) return
                  activeSourceFile &&
                    setCursorLine(
                      cursorLine && cursorLine.file === activeSourceFile && cursorLine.line === lineNo
                        ? null
                        : { file: activeSourceFile, line: lineNo }
                    )
                }}
                className={
                  isPcLine
                    ? 'flex cursor-pointer border-b border-primary/15 bg-primary/10 select-none'
                    : isCursorLine
                      ? 'flex cursor-pointer border-b border-amber-300/40 bg-amber-400/10 select-none'
                      : 'flex cursor-pointer border-b border-transparent hover:bg-muted/30 select-none'
                }
              >
                {/* 断点槽 + PC 标记 + 行号 */}
                <div
                  className={cn(
                    'sticky left-0 flex w-14 shrink-0 select-none items-center gap-1 pr-1 text-right',
                    isPcLine
                      ? 'bg-primary/10'
                      : isCursorLine
                        ? 'bg-amber-400/10'
                        : 'bg-background'
                  )}
                >
                  {isExecutable ? (
                    <button
                      onClick={() => uid && activeSourceFile && toggleBreakpoint(uid, activeSourceFile, lineNo)}
                      disabled={!uid || !activeSourceFile || state === 'disconnected'}
                      title={hasBp ? '移除断点' : '设置断点'}
                      className={cn(
                        'flex w-3 shrink-0 cursor-pointer items-center justify-center text-[11px] leading-none transition-transform hover:scale-125 disabled:cursor-default disabled:opacity-40'
                      )}
                    >
                      {hasBp && isPcLine ? (
                        // 断点与运行指示重叠：红点与运行指示在同一 12px 格内层叠，
                        // 位置大小与普通状态一致，仅运行指示附加半透明
                        <span className="relative block size-3">
                          <span className="absolute inset-0 flex items-center justify-center text-red-500">●</span>
                          <span className="absolute inset-0 flex items-center justify-center font-bold leading-none text-primary opacity-50">▶</span>
                        </span>
                      ) : hasBp ? (
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
                {/* 代码（带语法高亮，可选中文本） */}
                <pre className="flex-1 whitespace-pre select-text pr-4">
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

      {/* 代码区右键菜单：复制 / 全选 / 转到定义 / 转到引用 */}
      {codeMenu && (
        <div
          className="fixed z-50 min-w-[10rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ left: codeMenu.x, top: codeMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={copySelection}
          >
            复制
          </button>
          <button
            className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={selectAll}
          >
            全选
          </button>
          <div className="-mx-1 my-1 h-px bg-muted/60" />
          <button
            className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void goToDefinition()}
            disabled={!codeMenu.word}
          >
            转到定义
          </button>
          <button
            className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void goToReferences()}
            disabled={!codeMenu.word}
          >
            转到引用
          </button>
        </div>
      )}

      {/* 转到引用结果面板 */}
      {refsPanel && (
        <div
          className="fixed z-50 w-96 max-w-[70vw] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ left: refsPanel.x, top: refsPanel.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-2 py-1 text-xs font-medium">
            <span className="truncate">引用: {refsPanel.query}</span>
            <button
              className="ml-2 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setRefsPanel(null)}
            >
              ×
            </button>
          </div>
          {refsPanel.loading ? (
            <div className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> 搜索中...
            </div>
          ) : refsPanel.hits.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">无匹配结果</div>
          ) : (
            <div className="max-h-72 overflow-auto">
              {refsPanel.hits.map((h, i) => (
                <button
                  key={i}
                  className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
                  onClick={() => {
                    const target = matchSourceFile(h.file)
                    if (target) gotoSource(target, h.line)
                    setRefsPanel(null)
                  }}
                >
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {h.file}:{h.line}
                  </span>
                  <span className="truncate">{h.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}