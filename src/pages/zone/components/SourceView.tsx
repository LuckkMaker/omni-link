import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { Loader2, AlertCircle, X, ChevronLeft, ChevronRight, Save, Undo2, Pencil } from 'lucide-react'
import { useZoneStore } from '../store'
import * as zoneService from '@/services/zone.service'
import { monaco, monacoLangFor, applyOmniTheme, isDarkTheme, type MonacoThemeName } from '@/lib/monaco-setup'
import { buildSourceDecorations } from '@/lib/source-decorations'
import { cn } from '@/lib/utils'
import '@/lib/monaco-theme.css'

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
 * 源码视图：Monaco 只读编辑器 + 语法高亮 + PC 行高亮 + 断点槽。
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

  // ── 渲染 / 交互状态 ──────────────────────────────
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pcLine, setPcLine] = useState<number | null>(null)
  const [executableLines, setExecutableLines] = useState<Set<number>>(new Set())
  // Monaco 主题：跟随文档明暗（浅色 UI 用 omni-light，深色用 omni-dark）
  const [monacoTheme, setMonacoTheme] = useState<MonacoThemeName>(() =>
    isDarkTheme() ? 'omni-dark' : 'omni-light'
  )
  // 编辑模式：editing 开关 + 各文件脏标记（未保存的修改）
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  // 异步回调内读取最新值，避免闭包过期
  const editingRef = useRef(false)
  const dirtyRef = useRef(false)
  const dirtyMapRef = useRef<Map<string, boolean>>(new Map())

  // Monaco 实例与模型缓存
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map())
  const viewStatesRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(new Map())
  const decorationIdsRef = useRef<string[]>([])
  // 切换源文件后待跳转的 PC 行（文件模型加载完成后应用）
  const pendingPcRef = useRef<{ file: string; line: number } | null>(null)
  // 最近一次解析到的 PC 源码位置；供模型加载完成后滚动居中
  const pcLocationRef = useRef<{ file: string; line: number } | null>(null)
  // 当前正在显示的文件（用于切换时保存旧文件的视口状态）
  const currentFileRef = useRef<string | null>(null)

  // 始终持有最新值（在异步回调内读取，避免闭包过期）
  const pcRef = useRef(pc)
  const followSourceRef = useRef(followSource)
  const activeFileRef = useRef<string | null>(activeSourceFile)
  const stateRef = useRef(state)
  const pcLineRef = useRef<number | null>(pcLine)
  const cursorLineRef = useRef(cursorLine)
  const breakpointsRef = useRef(breakpoints)
  const executableLinesRef = useRef(executableLines)
  useEffect(() => {
    pcRef.current = pc
  }, [pc])
  useEffect(() => {
    followSourceRef.current = followSource
  }, [followSource])
  useEffect(() => {
    activeFileRef.current = activeSourceFile
  }, [activeSourceFile])
  useEffect(() => {
    stateRef.current = state
  }, [state])
  useEffect(() => {
    pcLineRef.current = pcLine
  }, [pcLine])
  useEffect(() => {
    cursorLineRef.current = cursorLine
  }, [cursorLine])
  useEffect(() => {
    breakpointsRef.current = breakpoints
  }, [breakpoints])
  useEffect(() => {
    executableLinesRef.current = executableLines
  }, [executableLines])
  useEffect(() => {
    editingRef.current = editing
  }, [editing])
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // ── 文件 tab 与右键菜单状态 ─────────────────────────
  const [tabMenu, setTabMenu] = useState<{ file: string; x: number; y: number } | null>(null)
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false })
  // 代码区右键菜单（触发位置 + 光标处标识符）
  const [codeMenu, setCodeMenu] = useState<{ x: number; y: number; word: string } | null>(null)
  // 转到引用结果面板
  const [refsPanel, setRefsPanel] = useState<{
    x: number
    y: number
    query: string
    hits: { file: string; line: number; text: string }[]
    loading: boolean
  } | null>(null)

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

  // 把符号文件路径映射到 sourceFiles 中的已知路径（不同目录同名文件按完整路径匹配，否则退化为 basename）
  const matchSourceFile = useCallback(
    (file: string): string | null => {
      const n = norm(file)
      return (
        sourceFiles.find((f) => {
          const fp = norm(f.path)
          return fp === n || fp.endsWith('/' + n) || n.endsWith('/' + fp)
        })?.path ?? null
      )
    },
    [sourceFiles]
  )

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

  // 复制当前选区文本（无选区时复制光标处单词）
  const copySelection = useCallback(() => {
    const editor = editorRef.current
    let text = ''
    if (editor) {
      const sel = editor.getSelection()
      if (sel && !sel.isEmpty()) {
        text = editor.getModel()?.getValueInRange(sel) ?? ''
      }
    }
    if (!text) text = codeMenu?.word ?? ''
    if (text) void navigator.clipboard?.writeText(text).catch(() => {})
    setCodeMenu(null)
  }, [codeMenu])

  // 全选当前文件全部代码
  const selectAll = useCallback(() => {
    const editor = editorRef.current
    if (editor) {
      const model = editor.getModel()
      if (model) {
        editor.setSelection(new monaco.Range(1, 1, model.getLineCount(), Number.MAX_SAFE_INTEGER))
      }
      editor.focus()
    }
    setCodeMenu(null)
  }, [])

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

  // 连接后刷新断点列表
  useEffect(() => {
    if (uid && elfPath) void refreshBreakpoints(uid)
  }, [uid, elfPath, refreshBreakpoints])

  // 统一应用装饰：从最新 ref 状态计算 PC/光标/断点装饰并交付 editor
  const applyDecorations = useCallback(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const dels = buildSourceDecorations({
      activeFile: activeFileRef.current,
      pcLine: pcLineRef.current,
      cursorLine: cursorLineRef.current,
      breakpoints: breakpointsRef.current,
      executableLines: executableLinesRef.current,
      lineCount: model.getLineCount(),
    })
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, dels)
  }, [])

  // 响应式触发装饰更新
  useEffect(() => {
    applyDecorations()
  }, [pcLine, cursorLine, breakpoints, executableLines, activeSourceFile, applyDecorations])

  // 保存当前文件（编辑模式）：写回磁盘并清除脏标记
  const saveCurrentFile = useCallback(async () => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const file = activeFileRef.current
    if (!editor || !model || !file || !uid) return
    setSaving(true)
    try {
      const content = model.getValue()
      const res = await zoneService.zoneSourceSave(uid, file, content)
      if (res.success) {
        const key = norm(file)
        dirtyMapRef.current.set(key, false)
        setDirty(false)
        useZoneStore.getState().setError?.(null)
      } else {
        useZoneStore.getState().setError?.(`保存失败: ${res.error ?? '未知错误'}`)
      }
    } catch (e) {
      useZoneStore.getState().setError?.(
        `保存失败: ${e instanceof Error ? e.message : '网络错误'}`
      )
    } finally {
      setSaving(false)
    }
  }, [uid])

  // 切换编辑模式：进入时清空 Run-to-Cursor 光标，退出时若未保存则提示
  const toggleEditing = useCallback(() => {
    setEditing((cur) => {
      const next = !cur
      if (next) {
        setCursorLine(null)
      }
      return next
    })
  }, [setCursorLine])

  // 撤销当前文件最近一次编辑
  const undoCurrentFile = useCallback(() => {
    editorRef.current?.trigger('source-editor', 'undo', null)
  }, [])

  // Ctrl/Cmd + S 保存
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveCurrentFile()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, saveCurrentFile])

  // 切换文件时：把旧文件脏标记写入 map，恢复新文件脏标记
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const prev = currentFileRef.current
    if (prev) dirtyMapRef.current.set(prev, dirtyRef.current)
    currentFileRef.current = activeSourceFile ?? null
    if (activeSourceFile) {
      const dirtyNow = dirtyMapRef.current.get(norm(activeSourceFile)) ?? false
      setDirty(dirtyNow)
    }
  }, [activeSourceFile])

  // Monaco 挂载：绑定断点槽点击 / 光标定位 / 右键菜单
  const handleMount = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor
      // 挂载时按应用主题色刷新 Monaco 主题（CSS 变量此时已就绪），并同步当前主题名
      setMonacoTheme(applyOmniTheme())
      editor.onMouseDown((e) => {
        const pos = e.target.position
        if (!pos) return
        const file = activeFileRef.current
        if (!file) return
        const line = pos.lineNumber
        // 断点槽（glyph margin）点击 → 切换断点（仅可执行行 / PC 行 / 已设断点行）
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
          const hasBp = breakpointsRef.current.some(
            (b) => b.line === line && isSameSource(norm(b.file), file)
          )
          const isExecutable =
            executableLinesRef.current.has(line) || line === pcLineRef.current || hasBp
          if (isExecutable && stateRef.current !== 'disconnected') {
            void toggleBreakpoint(uid ?? '', file, line)
          }
          return
        }
        // 代码区点击 → 定位光标行（拖动选文本时不切换）
        if (editingRef.current) return // 编辑模式下点击不触发 Run-to-Cursor 光标
        const sel = editor.getSelection()
        if (sel && !sel.isEmpty()) return
        const cur = cursorLineRef.current
        setCursorLine(cur && cur.file === file && cur.line === line ? null : { file, line })
      })
      // 编辑内容变更 → 标记脏（仅编辑模式；readOnly 状态不会触发）
      editor.onDidChangeModelContent(() => {
        if (!editingRef.current) return
        const file = activeFileRef.current
        if (!file) return
        dirtyMapRef.current.set(norm(file), true)
        setDirty(true)
      })
      editor.onContextMenu((e) => {
        const pos = e.target.position
        const model = editor.getModel()
        let word = ''
        if (pos && model) {
          const w = model.getWordAtPosition(pos)
          word = w ? w.word : ''
        }
        setCodeMenu({ x: e.event.browserEvent.clientX, y: e.event.browserEvent.clientY, word })
      })
      applyDecorations()
    },
    [uid, toggleBreakpoint, setCursorLine, applyDecorations]
  )

  // 文件切换时：保存旧文件的视口状态（在内容加载前执行）
  useEffect(() => {
    const prev = currentFileRef.current
    const editor = editorRef.current
    if (prev && prev !== activeSourceFile && editor) {
      const m = editor.getModel()
      if (m) viewStatesRef.current.set(prev, editor.saveViewState())
    }
    currentFileRef.current = activeSourceFile ?? null
  }, [activeSourceFile])

  // 加载选中的源文件（创建/复用 model 并 setModel）
  useEffect(() => {
    if (!uid || !activeSourceFile) {
      setError(null)
      setLoading(false)
      if (editorRef.current) editorRef.current.setModel(null)
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
          const key = norm(activeSourceFile)
          let model = modelsRef.current.get(key)
          if (!model) {
            model = monaco.editor.createModel(
              res.lines?.join('\n') ?? '',
              monacoLangFor(activeSourceFile),
              monaco.Uri.parse('file:///' + key)
            )
            modelsRef.current.set(key, model)
          }
          const editor = editorRef.current
          if (editor) {
            editor.setModel(model)
            const vs = viewStatesRef.current.get(key)
            // 「转到定义/引用」导航目标优先：打开文件后滚动到目标行并清除
            const nav = navGoto
            if (nav && norm(nav.file) === key) {
              clearGoto()
              setPcLine(null)
              setCursorLine({ file: activeSourceFile, line: nav.line })
              editor.revealLineInCenter(nav.line)
            } else if (followSourceRef.current === false && vs) {
              // 用户手动切换回已打开并滚动过的文件：恢复视口（优先于 PC 定位滚动）
              editor.restoreViewState(vs)
              const pLoc = pcLocationRef.current
              setPcLine(pLoc && norm(pLoc.file) === key ? pLoc.line : null)
            } else {
              // 优先应用待跳转 PC 行（自动跟随切换文件时由 PC 定位 effect 设置）
              const pending = pendingPcRef.current
              if (pending && norm(pending.file) === key) {
                pendingPcRef.current = null
                setPcLine(pending.line)
                editor.revealLineInCenter(pending.line)
              } else {
                // 用户手动切换到含 PC 的文件：pending 未命中，改用最近一次解析到的 PC 位置居中
                const pLoc = pcLocationRef.current
                if (pLoc && norm(pLoc.file) === key) {
                  setPcLine(pLoc.line)
                  editor.revealLineInCenter(pLoc.line)
                } else {
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
                          (norm(line.file) === key || norm(line.file).endsWith('/' + key))
                        ) {
                          setPcLine(line.line ?? null)
                          editor.revealLineInCenter(line.line ?? 1)
                        } else {
                          setPcLine(null)
                          editor.setScrollTop(0)
                        }
                      })
                      .catch(() => {
                        setPcLine(null)
                        editor.setScrollTop(0)
                      })
                  } else {
                    setPcLine(null)
                    editor.setScrollTop(0)
                  }
                }
              }
            }
          }
          applyDecorations()
        } else {
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
  }, [uid, activeSourceFile, cursorLine, navGoto, setCursorLine, clearGoto, applyDecorations])

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
          // 记录最近一次 PC 源码位置，供模型加载完成后滚动居中
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
            editorRef.current?.revealLineInCenter(line.line ?? -1)
          }
        } else {
          setPcLine(null)
        }
      })
      .catch(() => setPcLine(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, pc, activeSourceFile, sourceFiles, setActiveSourceFile, ensureSourceFile, followSource, state, closedByUser, elfPath])

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

  // PC 行吸附：当 PC 解析到的行是空行/非代码行时，向上吸附到最近的真实代码行，避免高亮停在函数大括号之外
  useEffect(() => {
    if (pcLine == null) return
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const content = model.getLineContent(pcLine)
    const isEmpty = !content || content.trim() === ''
    if (!isEmpty) return
    for (let l = pcLine - 1; l >= 1; l--) {
      const c = model.getLineContent(l)
      if (!c || c.trim() === '') continue
      if (executableLines.size > 0 && !executableLines.has(l)) continue
      if (l !== pcLine) {
        setPcLine(l)
        editor.revealLineInCenter(l)
      }
      return
    }
    setPcLine(null)
  }, [pcLine, executableLines])

  // 会话停止（openFiles 清空）时释放所有 model 缓存
  useEffect(() => {
    if (openFiles.length === 0) {
      modelsRef.current.forEach((m) => m.dispose())
      modelsRef.current.clear()
      viewStatesRef.current.clear()
      decorationIdsRef.current = []
      dirtyMapRef.current.clear()
      setDirty(false)
      setEditing(false)
    }
  }, [openFiles])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 源码 tab 栏（参考 RTT Viewer 风格）：点击切换，tab 过多时滚轮横向滚动 + 左右按钮切换 */}
      {openFiles.length > 0 && (
        <div className="flex shrink-0 items-stretch border-b border-border bg-muted/10">
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
          <button
            onClick={() => scrollTabs(1)}
            disabled={!tabOverflow.right}
            className="flex w-6 shrink-0 items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            title="向右切换"
          >
            <ChevronRight className="size-3.5" />
          </button>
          {/* 编辑工具栏：编辑模式开关 + 保存 / 撤销 */}
          <div className="ml-1 flex shrink-0 items-center gap-1 border-l border-border pl-1.5">
            {editing ? (
              <>
                <button
                  onClick={() => void saveCurrentFile()}
                  disabled={!dirty || saving || !activeSourceFile}
                  className={cn(
                    'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40',
                    dirty
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'text-muted-foreground'
                  )}
                  title="保存当前文件 (Ctrl+S)"
                >
                  {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                  {dirty && <span className="size-1.5 rounded-full bg-red-500" />}
                  保存
                </button>
                <button
                  onClick={undoCurrentFile}
                  disabled={!activeSourceFile}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  title="撤销"
                >
                  <Undo2 className="size-3" />
                  撤销
                </button>
                <button
                  onClick={toggleEditing}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary transition-colors hover:bg-accent"
                  title="退出编辑模式"
                >
                  <Pencil className="size-3" />
                  完成
                </button>
              </>
            ) : (
              <button
                onClick={toggleEditing}
                disabled={!activeSourceFile}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                title="进入编辑模式，可修改源码"
              >
                <Pencil className="size-3" />
                编辑
              </button>
            )}
          </div>
        </div>
      )}
      {/* 文件 tab 右键菜单：关闭 / 关闭其他 / 关闭所有 */}
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
      {/* Monaco 代码区：Editor 常驻，loading/error 用覆盖层叠加，避免卸载导致实例 dispose 后异步回调崩溃 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Editor
          theme={monacoTheme}
          language="plaintext"
          onMount={handleMount}
          options={{
            readOnly: !editing,
            automaticLayout: true,
            glyphMargin: true,
            folding: true,
            minimap: { enabled: false },
            fontSize: 12,
            lineHeight: 20,
            fontFamily: "'JetBrainsMono', Consolas, 'Courier New', monospace",
            scrollBeyondLastLine: false,
            // 第一优先级改造：开启当前行高亮（只高亮光标所在行，不与 PC 行装饰叠加冲突）
            renderLineHighlight: 'line',
            contextmenu: false,
            quickSuggestions: false,
            wordBasedSuggestions: 'off',
            suggestOnTriggerCharacters: false,
            parameterHints: { enabled: false },
            snippetSuggestions: 'none',
            // 第一优先级改造：开启选中词 / 光标词高亮（VS Code 默认体验；singleFile 只高亮当前文件内出现位）
            selectionHighlight: true,
            occurrencesHighlight: 'singleFile',
            // 第一优先级改造：开启括号配对高亮（配色在 monaco-setup.ts 主题中补齐）
            bracketPairColorization: { enabled: true },
            links: false,
            renderWhitespace: 'none',
            smoothScrolling: true,
            padding: { top: 4, bottom: 4 },
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          }}
        />
        {loading && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载中...
          </div>
        )}
        {error && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 text-red-500">
            <AlertCircle className="size-4" />
            <span className="max-w-md truncate">{error}</span>
          </div>
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