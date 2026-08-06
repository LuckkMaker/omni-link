import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useCommanderStore } from '@/stores/commander.store'
import { useUiStore } from '@/stores/ui.store'
import type { CommandInfo } from '@/services/commander.service'

/** 终端对外暴露的命令 API（供父组件通过 ref 调用） */
export interface TerminalApi {
  /** 立即执行一条命令（显示回显 + 执行 + 输出结果） */
  runCommand: (cmd: string) => void
  /** 在当前光标位置插入文本（不执行，等用户按 Enter） */
  insertText: (text: string) => void
  /** 清屏 */
  clear: () => void
  /** 清空命令历史 */
  clearHistory: () => void
  /** 聚焦终端（接收键盘输入） */
  focus: () => void
}

interface TerminalProps {
  uid: string | null
  connected: boolean
  /** 可用命令列表（用于 Tab 补全） */
  commands: CommandInfo[]
  /** 父组件创建的 ref，Terminal 会将 API 写入此 ref */
  apiRef: React.MutableRefObject<TerminalApi | null>
}

// ── ANSI 颜色码 ──────────────────────────
const COLOR = {
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  reverse: '\x1b[7m',
}

// 应用主题色（--primary: 221.2 83.2% 53.3% ≈ #2563eb）
const THEME_COLOR = { r: 37, g: 99, b: 235 }

const PROMPT = `\x1b[38;2;${THEME_COLOR.r};${THEME_COLOR.g};${THEME_COLOR.b}momni link\x1b[0m> `
const PROMPT_VISIBLE_LEN = 11 // "omni link> " 可见长度

// localStorage key
const HISTORY_KEY = 'commander:history'

/** 加载持久化的命令历史 */
function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.slice(0, 200) : []
  } catch {
    return []
  }
}

/** 保存命令历史到 localStorage */
function saveHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 200)))
  } catch {
    // 忽略写入失败
  }
}

export function Terminal({ uid, connected, commands, apiRef }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // 输入缓冲与历史导航状态（用 ref 避免 re-render）
  const inputBuf = useRef('')
  const cursorPos = useRef(0)
  const historyIndex = useRef(-1) // -1 = 当前输入，0+ = 历史浏览
  const savedInput = useRef('') // 浏览历史时保存的当前输入

  // 命令历史（本地持久化，与 store 同步）
  const historyRef = useRef<string[]>(loadHistory())

  // Ctrl+R 搜索状态
  const searchMode = useRef(false)
  const searchQuery = useRef('')
  const searchResultIndex = useRef(-1) // 当前匹配的历史索引

  // 字体大小
  const fontSize = useRef(13)

  // uid/running/commands 同步到 ref（供 onData 闭包访问最新值）
  const uidRef = useRef<string | null>(uid)
  uidRef.current = uid
  const commandsRef = useRef<CommandInfo[]>(commands)
  commandsRef.current = commands

  const execute = useCommanderStore((s) => s.execute)
  const runningCommand = useCommanderStore((s) => s.runningCommand)
  const runningRef = useRef(runningCommand)
  runningRef.current = runningCommand

  // ── 历史管理 ──────────────────────────
  /** 添加命令到历史并持久化 */
  const addToHistory = useCallback((cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) return
    // 去重连续相同命令
    if (historyRef.current[0] === trimmed) return
    historyRef.current = [trimmed, ...historyRef.current].slice(0, 200)
    saveHistory(historyRef.current)
    // 同步到 store（供其他组件查询）
    useCommanderStore.setState({ history: historyRef.current })
  }, [])

  /** 获取历史命令，index 0 = 最近一条 */
  const getHistory = useCallback((index: number): string | undefined => {
    if (index < 0 || index >= historyRef.current.length) return undefined
    return historyRef.current[index]
  }, [])

  /** 在历史中反向搜索包含 query 的命令 */
  const searchHistory = useCallback((query: string, fromIndex: number): string | undefined => {
    for (let i = fromIndex; i < historyRef.current.length; i++) {
      if (historyRef.current[i].toLowerCase().includes(query.toLowerCase())) {
        return historyRef.current[i]
      }
    }
    return undefined
  }, [])

  // ── 终端输出辅助 ──────────────────────
  /** 重绘当前输入行（清除当前行并重写，光标回到正确位置） */
  const redrawInputLine = useCallback(() => {
    const term = termRef.current
    if (!term) return
    term.write('\r\x1b[2K')
    term.write(PROMPT + inputBuf.current)
    const targetCol = PROMPT_VISIBLE_LEN + cursorPos.current
    const currentCol = PROMPT_VISIBLE_LEN + inputBuf.current.length
    if (targetCol < currentCol) {
      term.write(`\x1b[${currentCol - targetCol}D`)
    }
  }, [])

  // ── Ctrl+R 搜索渲染 ──────────────────
  /** 重绘搜索模式行 */
  const redrawSearchLine = useCallback(() => {
    const term = termRef.current
    if (!term) return
    term.write('\r\x1b[2K')
    const matched = searchResultIndex.current >= 0 ? historyRef.current[searchResultIndex.current] : ''
    term.write(
      `${COLOR.reverse}(reverse-i-search)\`${searchQuery.current}'${COLOR.reset}: ${matched}`
    )
  }, [])

  /** 退出搜索模式，将匹配结果填入输入缓冲 */
  const exitSearch = useCallback(
    (useResult: boolean) => {
      const term = termRef.current
      if (!term) return
      if (useResult && searchResultIndex.current >= 0) {
        inputBuf.current = historyRef.current[searchResultIndex.current] ?? ''
      }
      cursorPos.current = inputBuf.current.length
      historyIndex.current = -1
      searchMode.current = false
      searchQuery.current = ''
      searchResultIndex.current = -1
      redrawInputLine()
    },
    [redrawInputLine]
  )

  // ── 命令执行 ──────────────────────────
  /** 执行命令并显示结果 */
  const runCommand = useCallback(
    async (cmd: string, echo: boolean) => {
      const term = termRef.current
      if (!term) return

      // 退出搜索模式（如果有）
      if (searchMode.current) {
        exitSearch(true)
      }

      // 清除当前输入行，换行
      if (inputBuf.current || echo) {
        term.write('\r\n')
      }
      if (echo && cmd) {
        term.write(`${COLOR.dim}${cmd}${COLOR.reset}\r\n`)
      }
      inputBuf.current = ''
      cursorPos.current = 0
      historyIndex.current = -1

      if (!cmd.trim()) {
        // 空命令：清除当前行再写 prompt，避免 omni link> omni link> 重复叠加
        term.write('\r\x1b[2K' + PROMPT)
        return
      }

      // 记录到历史
      addToHistory(cmd)

      if (!uidRef.current) {
        term.write(`${COLOR.red}Error: No probe selected${COLOR.reset}\r\n`)
        term.write(PROMPT)
        return
      }

      // 显示运行指示（在命令行内新行）
      term.write(`${COLOR.yellow}\u23F3 ${cmd}${COLOR.reset}\r\n`)

      const result = await execute(uidRef.current, cmd)

      // 清除运行指示行（回到上一行行首并清除）
      term.write('\x1b[A\r\x1b[2K')

      if (result.output) {
        term.write(result.output)
        if (!result.output.endsWith('\n')) {
          term.write('\r\n')
        }
      }

      if (!result.success && result.error) {
        term.write(`${COLOR.red}Error: ${result.error}${COLOR.reset}\r\n`)
      }

      term.write(PROMPT)
    },
    [execute, addToHistory, exitSearch]
  )

  // ── Tab 补全 ──────────────────────────
  /** Tab 补全：补全命令名或从历史补全 */
  const tabComplete = useCallback(() => {
    const input = inputBuf.current
    const parts = input.split(/\s+/)

    // 如果只有一个词，补全命令名
    if (parts.length === 1 && parts[0]) {
      const prefix = parts[0].toLowerCase()
      const matches = commandsRef.current
        .filter((c) => c.name.toLowerCase().startsWith(prefix))
        .map((c) => c.name)

      if (matches.length === 1) {
        // 唯一匹配，直接补全
        inputBuf.current = matches[0] + ' '
        cursorPos.current = inputBuf.current.length
        redrawInputLine()
      } else if (matches.length > 1) {
        // 多个匹配，显示候选
        const term = termRef.current
        if (!term) return
        term.write('\r\n')
        term.write(matches.join('  ') + '\r\n')
        term.write(PROMPT + inputBuf.current)
      }
    } else {
      // 多词输入：从历史中找匹配当前行的命令
      const matches = historyRef.current.filter((h) => h.startsWith(input))
      if (matches.length === 1) {
        inputBuf.current = matches[0]
        cursorPos.current = inputBuf.current.length
        redrawInputLine()
      } else if (matches.length > 1) {
        const term = termRef.current
        if (!term) return
        term.write('\r\n')
        term.write(matches.join('  ') + '\r\n')
        term.write(PROMPT + inputBuf.current)
      }
    }
  }, [redrawInputLine])

  // ── 文本操作 ──────────────────────────
  /** 在当前光标位置插入文本 */
  const insertText = useCallback(
    (text: string) => {
      if (runningRef.current) return
      inputBuf.current =
        inputBuf.current.slice(0, cursorPos.current) +
        text +
        inputBuf.current.slice(cursorPos.current)
      cursorPos.current += text.length
      redrawInputLine()
    },
    [redrawInputLine]
  )

  /** 删除光标前一个单词 */
  const deleteWordBackward = useCallback(() => {
    if (cursorPos.current <= 0) return
    let pos = cursorPos.current
    // 跳过尾部空格
    while (pos > 0 && inputBuf.current[pos - 1] === ' ') pos--
    // 删除单词字符
    while (pos > 0 && inputBuf.current[pos - 1] !== ' ') pos--
    inputBuf.current = inputBuf.current.slice(0, pos) + inputBuf.current.slice(cursorPos.current)
    cursorPos.current = pos
    redrawInputLine()
  }, [redrawInputLine])

  /** 删除光标到行尾 */
  const killToEnd = useCallback(() => {
    inputBuf.current = inputBuf.current.slice(0, cursorPos.current)
    redrawInputLine()
  }, [redrawInputLine])

  /** 删除光标到行首 */
  const killToStart = useCallback(() => {
    inputBuf.current = inputBuf.current.slice(cursorPos.current)
    cursorPos.current = 0
    redrawInputLine()
  }, [redrawInputLine])

  /** 删除光标后一个字符（Delete 键） */
  const deleteCharForward = useCallback(() => {
    if (cursorPos.current < inputBuf.current.length) {
      inputBuf.current =
        inputBuf.current.slice(0, cursorPos.current) +
        inputBuf.current.slice(cursorPos.current + 1)
      redrawInputLine()
    }
  }, [redrawInputLine])

  // ── 清屏（修复 omni link> 重复叠加 bug）─────
  const clearScreen = useCallback(() => {
    const term = termRef.current
    if (!term) return
    // clear() 保留当前光标行，所以先清除当前行再写 prompt
    term.clear()
    term.write('\r\x1b[2K' + PROMPT + inputBuf.current)
  }, [])

  // ── 字体缩放 ──────────────────────────
  const zoomFont = useCallback((delta: number) => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    fontSize.current = Math.max(8, Math.min(24, fontSize.current + delta))
    term.options.fontSize = fontSize.current
    // 字体变化后重新计算尺寸
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        // 忽略
      }
    })
  }, [])

  // 暴露 API 给父组件
  useEffect(() => {
    apiRef.current = {
      runCommand: (cmd: string) => void runCommand(cmd, true),
      insertText,
      clear: clearScreen,
      clearHistory: () => {
        historyRef.current = []
        saveHistory([])
        useCommanderStore.setState({ history: [] })
      },
      focus: () => termRef.current?.focus(),
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, runCommand, insertText, clearScreen])

  // 初始化终端（仅挂载时）
  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: fontSize.current,
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      convertEol: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: useUiStore.getState().terminalTheme.theme,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current = fit

    // ── 复制粘贴支持 ──────────────────────────
    // Ctrl+Shift+C: 复制选中文本; Ctrl+Shift+V: 粘贴
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
        const selection = term.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {})
          event.preventDefault()
          return false
        }
      }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            term.paste(text)
          }
        }).catch(() => {})
        event.preventDefault()
        return false
      }
      return true
    })

    // 右键：有选中则复制，无选中则粘贴
    containerRef.current.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault()
      const selection = term.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {})
        term.clearSelection()
      } else {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            term.paste(text)
          }
        }).catch(() => {})
      }
    })

    // 欢迎信息
    term.write(
      `${COLOR.dim}Type 'help' for commands, Tab to complete, Ctrl+R to search history${COLOR.reset}\r\n`
    )
    term.write(
      `${COLOR.dim}Copy: Ctrl+Shift+C or right-click | Paste: Ctrl+Shift+V or right-click${COLOR.reset}\r\n`
    )
    term.write(
      `${COLOR.dim}Python expr: $ target.read32(0x20000000) | Shell: ! dir | Run script: run script.py${COLOR.reset}\r\n`
    )
    term.write(PROMPT)

    // 延迟 fit：等待 flex 布局计算完成
    const fitNow = () => {
      try {
        fit.fit()
      } catch {
        // 容器未就绪时忽略
      }
    }
    requestAnimationFrame(() => {
      fitNow()
      setTimeout(fitNow, 100)
    })

    // ── 输入处理 ──────────────────────────
    term.onData((data) => {
      // Ctrl+C 中断正在运行的命令
      if (data === '\x03' && runningRef.current) {
        const t = termRef.current
        if (!t) return
        const uid = uidRef.current
        if (!uid) return
        t.write(`${COLOR.yellow}^C${COLOR.reset}\r\n`)
        // 异步发送取消请求（不阻塞 onData）
        import('@/services/commander.service').then((s) =>
          s.cancelCommand(uid).catch(() => {})
        )
        return
      }

      if (runningRef.current) return
      const t = termRef.current
      if (!t) return

      // 处理多字符转义序列和单字符
      for (let i = 0; i < data.length; i++) {
        const ch = data[i]

        // ── Ctrl+R 搜索模式 ──
        if (searchMode.current) {
          if (ch === '\r') {
            // Enter：使用匹配结果
            exitSearch(true)
            // 执行命令
            void runCommand(inputBuf.current, false)
            continue
          }
          if (ch === '\x1b' || ch === '\x03') {
            // Esc / Ctrl+C：退出搜索，不使用结果
            exitSearch(false)
            if (ch === '\x03') {
              t.write('^C\r\n')
              inputBuf.current = ''
              cursorPos.current = 0
              t.write(PROMPT)
            }
            continue
          }
          if (ch === '\x08' || ch === '\x7f') {
            // Backspace：删除搜索字符
            if (searchQuery.current.length > 0) {
              searchQuery.current = searchQuery.current.slice(0, -1)
              searchResultIndex.current = searchQuery.current
                ? historyRef.current.findIndex((h) =>
                    h.toLowerCase().includes(searchQuery.current.toLowerCase())
                  )
                : -1
              redrawSearchLine()
            }
            continue
          }
          if (ch === '\x12') {
            // Ctrl+R again：继续搜索下一个匹配
            if (searchResultIndex.current >= 0) {
              const next = searchHistory(searchQuery.current, searchResultIndex.current + 1)
              if (next !== undefined) {
                searchResultIndex.current = historyRef.current.indexOf(next)
                redrawSearchLine()
              }
            }
            continue
          }
          // 可打印字符加入搜索
          if (ch >= ' ' || ch === '\t') {
            searchQuery.current += ch
            const idx = historyRef.current.findIndex((h) =>
              h.toLowerCase().includes(searchQuery.current.toLowerCase())
            )
            searchResultIndex.current = idx
            redrawSearchLine()
            continue
          }
          continue
        }

        // ── 正常模式 ──
        switch (ch) {
          case '\r': {
            // Enter：执行命令
            const cmd = inputBuf.current
            void runCommand(cmd, false)
            break
          }
          case '\x7f': {
            // Backspace
            if (cursorPos.current > 0) {
              inputBuf.current =
                inputBuf.current.slice(0, cursorPos.current - 1) +
                inputBuf.current.slice(cursorPos.current)
              cursorPos.current--
              redrawInputLine()
            }
            break
          }
          case '\t': {
            // Tab：补全
            tabComplete()
            break
          }
          case '\x12': {
            // Ctrl+R：进入反向搜索
            searchMode.current = true
            searchQuery.current = ''
            searchResultIndex.current = -1
            t.write('\r\n')
            redrawSearchLine()
            break
          }
          case '\x1b[A': {
            // Arrow Up：历史上一条（不会匹配，ch 是单字符 \x1b，在 case '\x1b' 中处理）
            break
          }
          case '\x1b[B': {
            // Arrow Down（不会匹配，在 case '\x1b' 中处理）
            break
          }
          case '\x1b[C': {
            // Arrow Right（不会匹配，在 case '\x1b' 中处理）
            break
          }
          case '\x1b[D': {
            // Arrow Left（不会匹配，在 case '\x1b' 中处理）
            break
          }
          case '\x1b': {
            // 转义序列处理（Arrow Up/Down/Left/Right/Home/End/Delete/PageUp/PageDown）
            const seq = data.slice(i)
            if (seq.startsWith('\x1b[A')) {
              // Arrow Up：历史上一条
              i += 2
              const cmd = getHistory(historyIndex.current + 1)
              if (cmd !== undefined) {
                if (historyIndex.current === -1) {
                  savedInput.current = inputBuf.current
                }
                historyIndex.current++
                inputBuf.current = cmd
                cursorPos.current = cmd.length
                redrawInputLine()
              }
            } else if (seq.startsWith('\x1b[B')) {
              // Arrow Down：历史下一条
              i += 2
              if (historyIndex.current > 0) {
                historyIndex.current--
                const cmd = getHistory(historyIndex.current)
                if (cmd !== undefined) {
                  inputBuf.current = cmd
                  cursorPos.current = cmd.length
                }
              } else if (historyIndex.current === 0) {
                historyIndex.current = -1
                inputBuf.current = savedInput.current
                cursorPos.current = savedInput.current.length
              }
              redrawInputLine()
            } else if (seq.startsWith('\x1b[C')) {
              // Arrow Right
              i += 2
              if (cursorPos.current < inputBuf.current.length) {
                cursorPos.current++
                t.write('\x1b[C')
              }
            } else if (seq.startsWith('\x1b[D')) {
              // Arrow Left
              i += 2
              if (cursorPos.current > 0) {
                cursorPos.current--
                t.write('\x1b[D')
              }
            } else if (seq.startsWith('\x1b[H') || seq.startsWith('\x1b[1~')) {
              // Home
              i += seq.startsWith('\x1b[H') ? 2 : 3
              cursorPos.current = 0
              redrawInputLine()
            } else if (seq.startsWith('\x1b[F') || seq.startsWith('\x1b[4~')) {
              // End
              i += seq.startsWith('\x1b[F') ? 2 : 3
              cursorPos.current = inputBuf.current.length
              redrawInputLine()
            } else if (seq.startsWith('\x1b[3~')) {
              // Delete
              i += 3
              deleteCharForward()
            } else if (seq.startsWith('\x1b[5~')) {
              // PageUp：滚动终端
              i += 3
              t.scrollLines(-Math.floor(t.rows / 2))
            } else if (seq.startsWith('\x1b[6~')) {
              // PageDown：滚动终端
              i += 3
              t.scrollLines(Math.floor(t.rows / 2))
            }
            break
          }
          case '\x03': {
            // Ctrl+C：取消当前输入行
            t.write('^C\r\n')
            inputBuf.current = ''
            cursorPos.current = 0
            historyIndex.current = -1
            t.write(PROMPT)
            break
          }
          case '\x0c': {
            // Ctrl+L：清屏（修复：清除当前行再写 prompt）
            t.clear()
            t.write('\r\x1b[2K' + PROMPT + inputBuf.current)
            break
          }
          case '\x15': {
            // Ctrl+U：删除整行（到行首）
            killToStart()
            break
          }
          case '\x17': {
            // Ctrl+W：删除前一个单词
            deleteWordBackward()
            break
          }
          case '\x0b': {
            // Ctrl+K：删除到行尾
            killToEnd()
            break
          }
          case '\x04': {
            // Ctrl+D：删除光标后字符，空行时无操作（不退出）
            if (inputBuf.current.length === 0) {
              // 空行，显示提示
              t.write('\r\n')
              t.write(PROMPT)
            } else {
              deleteCharForward()
            }
            break
          }
          case '\x01': {
            // Ctrl+A：行首
            cursorPos.current = 0
            redrawInputLine()
            break
          }
          case '\x05': {
            // Ctrl+E：行尾
            cursorPos.current = inputBuf.current.length
            redrawInputLine()
            break
          }
          case '\x1d': {
            // Ctrl+]：字体放大
            zoomFont(1)
            break
          }
          case '\x1f': {
            // Ctrl+_：字体缩小
            zoomFont(-1)
            break
          }
          case '\x18': {
            // Ctrl+X：重置字体大小
            fontSize.current = 13
            if (termRef.current) {
              termRef.current.options.fontSize = 13
              requestAnimationFrame(() => {
                try {
                  fitRef.current?.fit()
                } catch {
                  // 忽略
                }
              })
            }
            break
          }
          default: {
            // 可打印字符
            if (ch >= ' ' || ch === '\t') {
              inputBuf.current =
                inputBuf.current.slice(0, cursorPos.current) +
                ch +
                inputBuf.current.slice(cursorPos.current)
              cursorPos.current++
              redrawInputLine()
            }
          }
        }
      }
    })

    // 响应式调整
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // 容器未就绪时忽略
      }
    })
    ro.observe(containerRef.current)

    // 同时监听 window resize（侧边栏折叠等触发）
    const onWindowResize = () => {
      try {
        fit.fit()
      } catch {
        // 忽略
      }
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 响应终端主题切换
  const terminalTheme = useUiStore((s) => s.terminalTheme)
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme.theme
    }
  }, [terminalTheme])

  // 连接状态变化时显示提示（跳过首次挂载）
  const isFirstMount = useRef(true)
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    // 首次挂载时跳过，不显示 "[Probe disconnected]"
    if (isFirstMount.current) {
      isFirstMount.current = false
      return
    }

    if (!connected) {
      term.write(`\r\n${COLOR.yellow}[Probe disconnected]${COLOR.reset}\r\n`)
      term.write(PROMPT)
      inputBuf.current = ''
      cursorPos.current = 0
    }
  }, [connected])

  return <div ref={containerRef} className="h-full w-full overflow-hidden pl-2" />
}
