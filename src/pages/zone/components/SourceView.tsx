import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { Loader2, AlertCircle, X, ChevronLeft, ChevronRight, Save, Undo2, Pencil } from 'lucide-react'
import { useZoneStore } from '../store'
import * as zoneService from '@/services/zone.service'
import { monaco, monacoLangFor, applyOmniTheme, isDarkTheme, type MonacoThemeName } from '@/lib/monaco-setup'
import { ASM_MNEMONICS, ASM_REGISTERS } from '@/lib/source-highlight'
import { buildSourceDecorations } from '@/lib/source-decorations'
import { cn } from '@/lib/utils'
import '@/lib/monaco-theme.css'

interface SourceViewProps {
  uid: string | null
}

/** Monaco model 缓存上限（LRU）：超过后逐出最久未用的 model 并 dispose，防止内存持续增长 */
const MODEL_CACHE_LIMIT = 30

/** 语义 provider（定义/引用/文档符号）注册覆盖的语言 */
const SOURCE_LANGS = ['cpp', 'arm-asm', 'plaintext']

/** zoneFunctions 返回的单条函数 */
type ZoneFunc = { name: string; address: number; size: number; file?: string | null; line?: number | null }

/** 函数列表缓存（按 uid）：同一会话内复用，避免补全 / 文档符号每次全量拉取 2000 条 */
const functionsCache = new Map<string, { funcs: ZoneFunc[]; ts: number }>()
const FUNCTIONS_CACHE_TTL = 60_000

/** 获取（并缓存）函数列表；缓存失效时重新拉取 */
async function getCachedFunctions(uid: string): Promise<ZoneFunc[]> {
  const hit = functionsCache.get(uid)
  if (hit && Date.now() - hit.ts < FUNCTIONS_CACHE_TTL) return hit.funcs
  const res = await zoneService.zoneFunctions(uid, '', 0, 2000)
  const funcs = res.success ? res.functions : []
  functionsCache.set(uid, { funcs, ts: Date.now() })
  return funcs
}

/** 将两个源码路径归一化为可比较形态（统一 / 分隔、去尾部 /） */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 判断两个源码路径（可能一个为 basename）是否指向同一文件 */
function isSameSource(a: string, b: string): boolean {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
}

/** 计算当前内容相对原始内容的修改/新增行号（用于 minimap 修改行高亮，对齐 VS Code） */
function computeChangedLines(original: string, current: string): { modified: Set<number>; added: Set<number> } {
  const modified = new Set<number>()
  const added = new Set<number>()
  if (original === current) return { modified, added }
  const a = original.split('\n')
  const b = current.split('\n')
  const n = a.length
  const m = b.length

  // LCS 长度表（dp[i][j]：a[i..] 与 b[j..] 的最长公共子序列长度）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // 回溯：按变更块区分「新增」（纯插入）与「修改」（替换了原行）
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    // 收集删除段（跳过原行）
    let hasDel = false
    while (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      hasDel = true
      i++
    }
    // 收集新增段（当前行）
    while (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) {
      if (hasDel) modified.add(j + 1)
      else added.add(j + 1)
      j++
    }
  }
  // 尾部纯新增
  while (j < m) {
    added.add(j + 1)
    j++
  }
  return { modified, added }
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
  // 每个文件首次加载时的磁盘原文（用于编辑模式 Diff 对比）
  const originalsRef = useRef<Map<string, string>>(new Map())
  // Diff 对比弹层开关
  const [diffTarget, setDiffTarget] = useState<string | null>(null)
  // hover provider 一次性注册，会话停止 / 卸载时释放
  const hoverDisposableRef = useRef<monaco.IDisposable | null>(null)
  // 切换源文件后待跳转的 PC 行（文件模型加载完成后应用）
  const pendingPcRef = useRef<{ file: string; line: number } | null>(null)
  // 最近一次解析到的 PC 源码位置；供模型加载完成后滚动居中
  const pcLocationRef = useRef<{ file: string; line: number } | null>(null)
  // 当前正在显示的文件（用于切换时保存旧文件的视口状态）
  const currentFileRef = useRef<string | null>(null)
  // minimap 强制刷新定时器（Monaco 已知：编辑内容变更后 minimap 不随内容重绘，需手动刷新）
  const minimapRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 编辑模式下相对原始内容的修改/新增行号（minimap 修改行高亮）
  const changedLinesRef = useRef<{ modified: Set<number>; added: Set<number> }>({ modified: new Set(), added: new Set() })

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
  const [codeMenu, setCodeMenu] = useState<{
    x: number
    y: number
    word: string
    pos: { lineNumber: number; column: number } | null
  } | null>(null)
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

  // Peek 定义：将光标移到触发词后触发 Monaco 原生 peek（依赖上面注册的 DefinitionProvider）
  const peekDefinition = useCallback(() => {
    const editor = editorRef.current
    if (editor && codeMenu?.pos) {
      editor.setPosition(new monaco.Position(codeMenu.pos.lineNumber, codeMenu.pos.column))
      editor.trigger('source-editor', 'editor.action.peekDefinition', null)
    }
    setCodeMenu(null)
  }, [codeMenu])

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
      modifiedLines: changedLinesRef.current.modified,
      addedLines: changedLinesRef.current.added,
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

  // 关闭文件前确认：文件有未保存修改时弹窗确认，避免误丢编辑内容
  const confirmClose = useCallback((file: string): boolean => {
    if (dirtyMapRef.current.get(norm(file))) {
      return window.confirm(`文件「${file}」有未保存的修改，确定关闭？`)
    }
    return true
  }, [])

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
      setMonacoTheme(applyOmniTheme(true))
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
      })
      // 光标位置变化（鼠标点击 / 键盘方向键 / 跳转）→ 同步 Run-to-Cursor 光标行，
      // 保证 Run to Cursor / 断点操作始终使用最新光标行（编辑模式下不触发）。
      // 仅响应用户显式移动（Explicit），忽略 setModel 等程序性重置（NotSet），避免误设光标行/跳转
      editor.onDidChangeCursorPosition((e) => {
        if (editingRef.current) return
        if (e.reason !== monaco.editor.CursorChangeReason.Explicit) return
        const file = activeFileRef.current
        if (!file) return
        const line = e.position.lineNumber
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
        const key = norm(file)
        const original = originalsRef.current.get(key) ?? ''
        const current = editor.getModel()?.getValue() ?? ''
        // 完全撤销回原始内容时清除脏标记（tab 红点），否则标记为脏
        if (current === original) {
          dirtyMapRef.current.delete(key)
          setDirty(false)
        } else {
          dirtyMapRef.current.set(key, true)
          setDirty(true)
        }
        // 防抖：计算相对原始内容的修改/新增行并刷新 minimap 标记（对齐 VS Code 修改行高亮），
        // 同时强制刷新 minimap 内容（Monaco 已知编辑后 minimap 不随内容重绘）
        if (minimapRefreshTimerRef.current) clearTimeout(minimapRefreshTimerRef.current)
        minimapRefreshTimerRef.current = setTimeout(() => {
          const ed = editorRef.current
          const model = ed?.getModel()
          if (!ed || !model) return
          const original = originalsRef.current.get(norm(file)) ?? ''
          changedLinesRef.current = computeChangedLines(original, model.getValue())
          applyDecorations()
          ed.updateOptions({ minimap: { enabled: false } })
          ed.updateOptions({
            minimap: { enabled: true, size: 'fit', maxColumn: 120, renderCharacters: true, showSlider: 'mouseover' },
          })
        }, 150)
      })
      editor.onContextMenu((e) => {
        const pos = e.target.position
        const model = editor.getModel()
        let word = ''
        if (pos && model) {
          const w = model.getWordAtPosition(pos)
          word = w ? w.word : ''
        }
        setCodeMenu({
          x: e.event.browserEvent.clientX,
          y: e.event.browserEvent.clientY,
          word,
          pos: pos ? { lineNumber: pos.lineNumber, column: pos.column } : null,
        })
      })
      applyDecorations()
    },
    [uid, toggleBreakpoint, setCursorLine, applyDecorations]
  )

  // 自建轻量 hover provider —— 悬停符号时复用后端符号表展示类型/地址/所属函数/定义位置。
  // 独立 useEffect 依赖 uid：onMount 只在首挂载执行一次，会捕获到首挂载时的 null uid，
  // 导致 hover 永远请求失败；改由 uid 驱动注册/清理可保证闭包捕获到最新 uid。
  useEffect(() => {
    if (!uid) return
    const disposable = monaco.languages.registerHoverProvider('*', {
      provideHover: async (model, position) => {
        const word = model.getWordAtPosition(position)
        if (!word) return null
        const res = await zoneService.zoneResolveSymbol(uid, word.word)
        if (!res.success || !res.symbol) return null
        const s = res.symbol
        const lines: monaco.IMarkdownString[] = []
        // 函数符号：优先展示 DWARF 签名（返回类型 f(参数类型...)）
        if (s.signature) {
          lines.push({ value: `\`${s.signature}\`` })
        } else {
          const typeFrag = s.type && s.type !== 'unknown' ? `\`${s.type}\`` : ''
          const addrFrag = s.address != null ? `@ \`0x${s.address.toString(16).toUpperCase()}\`` : ''
          lines.push({ value: `**${s.name}** ${typeFrag} ${addrFrag}`.trim() })
        }
        // 返回类型 + 参数列表（仅函数符号且已解析出签名时展示）
        if (s.ret) lines.push({ value: `返回类型: \`${s.ret}\`` })
        if (s.params && s.params.length > 0) {
          lines.push({ value: `参数: ${s.params.map((p) => `\`${p}\``).join(', ')}` })
        }
        if (s.size != null) lines.push({ value: `size: ${s.size} bytes` })
        if (s.function) lines.push({ value: `所属函数: \`${s.function}\`` })
        if (s.file && s.line != null) lines.push({ value: `定义于: \`${s.file}:${s.line}\`` })
        return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), contents: lines }
      },
    })
    hoverDisposableRef.current = disposable
    return () => {
      disposable.dispose()
      hoverDisposableRef.current = null
    }
  }, [uid])

  // ── 语义 Language Provider（原生导航：定义 / 引用 / 文档符号）──
  // 复用后端符号表与轻量检索，注册为 Monaco 原生 provider，顺带点亮
  // Peek 定义、面包屑、大纲。随 uid 驱动注册/清理，避免闭包捕获过期 uid。
  useEffect(() => {
    if (!uid) return
    const disposables: monaco.IDisposable[] = []

    // 文件路径 → model uri（与 createModel 一致）
    const fileUri = (p: string) => monaco.Uri.parse('file:///' + norm(p))

    // ── DWARF 符号补全中间件：基于后端符号表提供自动补全 ──
    disposables.push(
      monaco.languages.registerCompletionItemProvider(SOURCE_LANGS, {
        triggerCharacters: ['.', '>', ':'],
        provideCompletionItems: async (model, position) => {
          const wordUntilPosition = model.getWordUntilPosition(position)
          const word = wordUntilPosition.word
          const range = {
            startLineNumber: position.lineNumber,
            startColumn: wordUntilPosition.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: wordUntilPosition.endColumn,
          }
          const suggestions: monaco.languages.CompletionItem[] = []
          // 汇编语言：先补助记符 + 寄存器
          if (model.getLanguageId() === 'arm-asm') {
            for (const m of Array.from(ASM_MNEMONICS)) {
              if (!word || m.toLowerCase().startsWith(word.toLowerCase())) {
                suggestions.push({ label: m, kind: monaco.languages.CompletionItemKind.Keyword, insertText: m, range })
              }
            }
            for (const r of Array.from(ASM_REGISTERS)) {
              if (!word || r.toLowerCase().startsWith(word.toLowerCase())) {
                suggestions.push({ label: r, kind: monaco.languages.CompletionItemKind.Variable, insertText: r, range })
              }
            }
          }
          // 复用缓存的函数列表，补函数名（大小写不敏感前缀匹配）
          const funcs = await getCachedFunctions(uid)
          const lower = word.toLowerCase()
          for (const fn of funcs) {
            if (!word || fn.name.toLowerCase().startsWith(lower)) {
              suggestions.push({
                label: fn.name,
                kind: monaco.languages.CompletionItemKind.Function,
                detail: `0x${fn.address.toString(16).toUpperCase()}`,
                insertText: fn.name,
                range,
              })
            }
          }
          return { suggestions }
        },
      })
    )

    // 转到定义：符号表解析 → 打开目标文件并返回 Location
    disposables.push(
      monaco.languages.registerDefinitionProvider(SOURCE_LANGS, {
        provideDefinition: async (model, position) => {
          const word = model.getWordAtPosition(position)
          if (!word) return null
          const res = await zoneService.zoneResolveSymbol(uid, word.word)
          if (!res.success || !res.symbol || !res.symbol.file || res.symbol.line == null) return null
          const target = matchSourceFile(res.symbol.file)
          if (!target) return null
          gotoSource(target, res.symbol.line)
          return {
            uri: fileUri(target),
            range: new monaco.Range(res.symbol.line, 1, res.symbol.line, 1),
          }
        },
      })
    )

    // 转到引用：轻量全文检索 → Location 列表（供原生 Find All References / Peek）
    disposables.push(
      monaco.languages.registerReferenceProvider(SOURCE_LANGS, {
        provideReferences: async (model, position) => {
          const word = model.getWordAtPosition(position)
          if (!word) return []
          const res = await zoneService.zoneSearchSource(uid, word.word)
          if (!res.success || !res.results) return []
          const locations: monaco.languages.Location[] = []
          for (const h of res.results) {
            const target = matchSourceFile(h.file)
            if (!target) continue
            locations.push({
              uri: fileUri(target),
              range: new monaco.Range(h.line, 1, h.line, 1),
            })
          }
          return locations
        },
      })
    )

    // 文档符号：当前文件内函数列表（驱动面包屑 / 大纲 / 转符号）
    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(SOURCE_LANGS, {
        provideDocumentSymbols: async (model) => {
          const file = currentFileRef.current
          if (!file) return []
          const key = norm(file)
          const funcs = await getCachedFunctions(uid)
          const symbols: monaco.languages.DocumentSymbol[] = []
          for (const fn of funcs) {
            if (!fn.file || fn.line == null) continue
            const fnNorm = norm(fn.file)
            if (fnNorm !== key && !fnNorm.endsWith('/' + key) && !key.endsWith('/' + fnNorm)) continue
            symbols.push({
              name: fn.name,
              detail: `0x${fn.address.toString(16).toUpperCase()}`,
              kind: monaco.languages.SymbolKind.Function,
              tags: [],
              range: new monaco.Range(fn.line, 1, fn.line + 1, 1),
              selectionRange: new monaco.Range(fn.line, 1, fn.line, 1),
            })
          }
          return symbols
        },
      })
    )

    // CodeLens：在每个函数声明行展示其链接地址 + 大小（嵌入式调试参考信息）
    disposables.push(
      monaco.languages.registerCodeLensProvider(SOURCE_LANGS, {
        provideCodeLenses: async (model) => {
          const file = currentFileRef.current
          if (!file) return { lenses: [], dispose: () => {} }
          const key = norm(file)
          const funcs = await getCachedFunctions(uid)
          const lenses: monaco.languages.CodeLens[] = []
          for (const fn of funcs) {
            if (!fn.file || fn.line == null) continue
            const fnNorm = norm(fn.file)
            if (fnNorm !== key && !fnNorm.endsWith('/' + key) && !key.endsWith('/' + fnNorm)) continue
            lenses.push({
              range: new monaco.Range(fn.line, 1, fn.line, 1),
              id: `func-${fn.line}`,
              command: {
                id: 'omnilink-codelens-info',
                title: `0x${fn.address.toString(16).toUpperCase()} · ${fn.size}B`,
              },
            })
          }
          return { lenses, dispose: () => {} }
        },
        resolveCodeLens: async (model, lens) => lens,
      })
    )

    return () => {
      disposables.forEach((d) => d.dispose())
    }
  }, [uid, matchSourceFile, gotoSource])

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
    const cl = cursorLineRef.current
    if (cl && !isSameSource(norm(cl.file), activeSourceFile)) {
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
          // 保存磁盘原文（首次加载时），供 Diff 对比
          if (!originalsRef.current.has(key)) {
            originalsRef.current.set(key, res.lines?.join('\n') ?? '')
          }
          let model = modelsRef.current.get(key)
          if (!model) {
            model = monaco.editor.createModel(
              res.lines?.join('\n') ?? '',
              monacoLangFor(activeSourceFile),
              monaco.Uri.parse('file:///' + key)
            )
            modelsRef.current.set(key, model)
          } else {
            // LRU touch：删除后重插，将本次访问提升到 Map 末尾（最近使用）
            modelsRef.current.delete(key)
            modelsRef.current.set(key, model)
          }
          // 超限逐出最久未用（Map 迭代顺序即访问顺序，首个为最久未用）
          while (modelsRef.current.size > MODEL_CACHE_LIMIT) {
            const oldestKey = modelsRef.current.keys().next().value as string | undefined
            if (oldestKey == null) break
            const oldest = modelsRef.current.get(oldestKey)
            if (oldest) oldest.dispose()
            modelsRef.current.delete(oldestKey)
            viewStatesRef.current.delete(oldestKey)
            dirtyMapRef.current.delete(oldestKey)
          }
          const editor = editorRef.current
          if (editor) {
            editor.setModel(model)
            // 切换文件：重置修改行标记（新文件相对其自身原始内容重新计算）
            changedLinesRef.current = { modified: new Set(), added: new Set() }
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
  }, [uid, activeSourceFile, navGoto, setCursorLine, clearGoto, applyDecorations])

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
      // 释放 hover provider，避免重复注册
      hoverDisposableRef.current?.dispose()
      hoverDisposableRef.current = null
      dirtyMapRef.current.clear()
      setDirty(false)
      setEditing(false)
      // 会话停止：清空函数列表缓存，避免切换 ELF 后仍命中旧符号表
      functionsCache.clear()
      // 清理 minimap 刷新定时器与修改行标记
      if (minimapRefreshTimerRef.current) {
        clearTimeout(minimapRefreshTimerRef.current)
        minimapRefreshTimerRef.current = null
      }
      changedLinesRef.current = { modified: new Set(), added: new Set() }
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
                  {/* 脏文件圆点指示（未保存修改） */}
                  {dirtyMapRef.current.get(norm(f)) && (
                    <span className="size-1.5 shrink-0 rounded-full bg-red-500" title="未保存的修改" />
                  )}
                  <span>{name}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirmClose(f)) closeSourceFile(f)
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
                  onClick={() => setDiffTarget(activeSourceFile)}
                  disabled={!activeSourceFile}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  title="与磁盘原始版本对比"
                >
                  Diff 对比
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
              if (confirmClose(tabMenu.file)) closeSourceFile(tabMenu.file)
              setTabMenu(null)
            }}
          >
            关闭
          </button>
          <button
            className="flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              const others = openFiles.filter((f) => f !== tabMenu.file)
              const hasDirty = others.some((f) => dirtyMapRef.current.get(norm(f)))
              if (hasDirty && !window.confirm('存在未保存的修改，确定关闭其他文件？')) return
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
              const hasDirty = openFiles.some((f) => dirtyMapRef.current.get(norm(f)))
              if (hasDirty && !window.confirm('存在未保存的修改，确定关闭所有文件？')) return
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
      {/* overflow-visible：允许 Monaco 的 Find 控件按钮 tooltip 溢出容器显示，避免被裁剪到窗口外 */}
      <div className="relative min-h-0 flex-1 overflow-visible">
        <Editor
          theme={monacoTheme}
          language="plaintext"
          onMount={handleMount}
          options={{
            readOnly: !editing,
            automaticLayout: true,
            glyphMargin: true,
            folding: true,
            // 第三优先级改造：开启 minimap（右侧缩略图，可点击/拖拽跳转）
            minimap: { enabled: true, size: 'fit', maxColumn: 120, renderCharacters: true, showSlider: 'mouseover' },
            // 大文件长函数阅读：粘性滚动（滚动时固定显示当前嵌套父级首行）
            stickyScroll: { enabled: true },
            // 彩虹缩进：启用缩进辅助线；括号仅高亮配对（bracketPairColorization），不画括号引导线
            guides: { indentation: true, bracketPairs: false, highlightActiveIndentation: true },
            // 补全幽灵预览（suggest 预览文本）
            suggest: { preview: true },
            // Find 主动选中：自动从当前选区播种搜索词，并在选区/多行内查找
            find: { autoFindInSelection: 'multiline', seedSearchStringFromSelection: 'always' },
            // 折叠控件始终显示（汇编折叠更易发现）
            showFoldingControls: 'always',
            fontSize: 14,
            lineHeight: 0,
            fontFamily: "'JetBrainsMono', Consolas, 'Courier New', monospace",
            fontLigatures: true,
            ariaLabel: '源码编辑器',
            scrollBeyondLastLine: false,
            // 第一优先级改造：开启当前行高亮（只高亮光标所在行，不与 PC 行装饰叠加冲突）
            renderLineHighlight: 'line',
            contextmenu: false,
            // 第二优先级改造：编辑体验 —— 仅在编辑模式下启用补全、自动闭合括号、多光标
            quickSuggestions: editing ? { other: true, comments: false, strings: false } : false,
            wordBasedSuggestions: editing ? 'currentDocument' : 'off',
            suggestOnTriggerCharacters: editing,
            parameterHints: { enabled: editing },
            snippetSuggestions: 'none',
            autoClosingBrackets: editing ? 'languageDefined' : 'never',
            multiCursorModifier: 'ctrlCmd',
            // 第一优先级改造：开启选中词 / 光标词高亮（VS Code 默认体验；singleFile 只高亮当前文件内出现位）
            selectionHighlight: true,
            occurrencesHighlight: 'singleFile',
            // 第一优先级改造：开启括号配对高亮（配色在 monaco-setup.ts 主题中补齐）
            bracketPairColorization: { enabled: true },
            links: false,
            renderWhitespace: 'all',
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

      {/* Diff 对比弹层：original=磁盘原文，modified=当前编辑值（均只读查看） */}
      {diffTarget && (
        <div className="absolute inset-0 z-20 flex flex-col border-t border-border bg-background">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1 text-xs">
            <span className="truncate font-medium">
              Diff: {diffTarget.replace(/\\/g, '/').split('/').pop()}
              <span className="ml-2 text-muted-foreground">左侧磁盘 · 右侧当前</span>
            </span>
            <button
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setDiffTarget(null)}
              title="关闭对比"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <DiffEditor
              theme={monacoTheme}
              language={monacoLangFor(diffTarget)}
              original={originalsRef.current.get(norm(diffTarget)) ?? ''}
              modified={editorRef.current?.getModel()?.getValue() ?? ''}
              className="h-full"
              options={{
                readOnly: true,
                renderSideBySide: true,
                originalEditable: false,
                fontSize: 14,
                lineHeight: 0,
                fontFamily: "'JetBrainsMono', Consolas, 'Courier New', monospace",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderWhitespace: 'none',
                automaticLayout: true,
              }}
            />
          </div>
        </div>
      )}

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
            onClick={peekDefinition}
            disabled={!codeMenu.word}
          >
            Peek 定义
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