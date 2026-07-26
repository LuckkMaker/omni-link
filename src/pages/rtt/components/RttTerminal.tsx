import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { wsClient } from '@/services/ws'
import { useRttStore } from '@/stores/rtt.store'
import { useUiStore } from '@/stores/ui.store'
import { useNotificationStore } from '@/stores/notification.store'
import { rttService } from '@/services/rtt.service'

/** 终端对外暴露的 API */
export interface RttTerminalApi {
  /** 清屏 */
  clear: () => void
  /** 获取当前 Tab 所有接收到的原始数据（用于保存到文件） */
  getData: () => Uint8Array
  /** 清空当前 Tab 的数据缓冲 */
  clearData: () => void
  /** 聚焦终端 */
  focus: () => void
  /** 字体缩放 */
  zoom: (delta: number) => void
}

interface RttTerminalProps {
  /** 当前探针 UID */
  uid: string | null
  /** 是否正在运行 */
  running: boolean
  /** Tab ID（用于从 store 读取对应 Tab 的数据） */
  tabId: string
  /** 输入模式：bar=InputBar 发送，terminal=终端直接输入（支持 Tab/方向键/Ctrl 组合键等） */
  inputMode: 'bar' | 'terminal'
  /** 本地回显开关（仅 terminal 输入模式生效；下位机不回显时开启） */
  localEcho: boolean
}

const COLOR = {
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
}

/** 将字节数组格式化为 hex dump 文本 */
function formatHexDump(data: Uint8Array, offset = 0): string {
  let result = ''
  let pos = offset
  while (pos < data.length) {
    const chunk = data.slice(pos, pos + 16)
    const hexPart = Array.from(chunk)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
    const asciiPart = Array.from(chunk)
      .map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.')
      .join('')
    const addr = (pos).toString(16).padStart(8, '0')
    result += `${COLOR.dim}${addr}${COLOR.reset}  ${hexPart.padEnd(47)}  ${asciiPart}\r\n`
    pos += 16
  }
  return result
}

export const RttTerminal = forwardRef<RttTerminalApi, RttTerminalProps>(
  function RttTerminal({ uid, running, tabId, inputMode, localEcho }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<XTerm | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const fontSize = useRef(13)

    // 已写入终端的数据缓冲长度（用于增量写入）
    const writtenBufferCountRef = useRef(0)
    const writtenBytesRef = useRef(0)

    // 同步 store 状态
    const displayMode = useRttStore((s) => s.displayMode)
    const displayModeRef = useRef(displayMode)
    displayModeRef.current = displayMode

    // 当前 Tab 的数据缓冲（订阅更新）
    const tabDataBuffer = useRttStore((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      return tab ? tab.dataBuffer : []
    })
    const uidRef = useRef<string | null>(uid)
    uidRef.current = uid

    // 输入模式与本地回显同步到 ref（供 onData 闭包访问最新值）
    const inputModeRef = useRef(inputMode)
    inputModeRef.current = inputMode
    const localEchoRef = useRef(localEcho)
    localEchoRef.current = localEcho
    const runningRef = useRef(running)
    runningRef.current = running

    // 发送通道：单通道 Tab 用 tab.channel，All Channel Tab 用 selectedDownChannel
    const selectedDownChannel = useRttStore((s) => s.selectedDownChannel)
    const activeTab = useRttStore((s) => s.tabs.find((t) => t.id === tabId))
    const sendChannelRef = useRef<number>(
      activeTab?.mode === 'single' && activeTab.channel !== undefined
        ? activeTab.channel
        : selectedDownChannel
    )
    sendChannelRef.current = activeTab?.mode === 'single' && activeTab.channel !== undefined
      ? activeTab.channel
      : selectedDownChannel

    // 暴露 API
    useImperativeHandle(ref, () => ({
      clear: () => {
        termRef.current?.clear()
      },
      getData: () => useRttStore.getState().getTabData(tabId),
      clearData: () => {
        useRttStore.getState().clearTabData(tabId)
        writtenBufferCountRef.current = 0
        writtenBytesRef.current = 0
        termRef.current?.clear()
      },
      focus: () => termRef.current?.focus(),
      zoom: (delta: number) => {
        const term = termRef.current
        const fit = fitRef.current
        if (!term || !fit) return
        fontSize.current = Math.max(8, Math.min(24, fontSize.current + delta))
        term.options.fontSize = fontSize.current
        requestAnimationFrame(() => {
          try { fit.fit() } catch { /* ignore */ }
        })
      },
    }), [tabId])

    // 初始化终端
    useEffect(() => {
      if (!containerRef.current) return

      const term = new XTerm({
        cursorBlink: inputModeRef.current === 'terminal',
        fontSize: fontSize.current,
        fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
        convertEol: true,
        scrollback: 10000,
        // terminal 模式启用输入，bar 模式禁用（由 InputBar 处理）
        disableStdin: inputModeRef.current !== 'terminal',
        allowProposedApi: true,
        theme: useUiStore.getState().terminalTheme.theme,
      })

      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.open(containerRef.current)

      termRef.current = term
      fitRef.current = fit

      // 欢迎信息（仅在未运行时显示；已运行时跳过，避免残留）
      if (!runningRef.current) {
        term.write(`${COLOR.dim}等待 RTT 会话启动...${COLOR.reset}\r\n`)
      }

      // 复制支持 + Ctrl+A 全选
      // 影响评估：
      // - 终端模式：Ctrl+A 原是 readline "行首" 快捷键，但 RTT shell 场景极少用，
      //   全选更实用；若下位机 shell 需要 Ctrl+A，可在 InputBar 模式输入 \x01 发送。
      // - 输入栏模式：无影响（焦点在 InputBar 时 Ctrl+A 选中文本框内容）。
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        // Ctrl+Shift+C 复制选中
        if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
          const selection = term.getSelection()
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {})
            event.preventDefault()
            return false
          }
        }
        // Ctrl+A 全选（仅在终端有焦点时生效）
        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyA') {
          term.selectAll()
          event.preventDefault()
          return false
        }
        return true
      })

      // 终端输入处理（仅 terminal 输入模式生效）
      // onData 收到的 data 是原始输入序列：可见字符、Tab(\t)、Enter(\r)、
      // 方向键转义序列(\x1b[A 等)、Ctrl 组合键(\x03 等) 等。
      // UTF-8 编码后发送到下位机 down channel，下位机 shell 可识别。
      const onDataDisposable = term.onData((data: string) => {
        // bar 模式不处理（由 InputBar 发送）
        if (inputModeRef.current !== 'terminal') return
        // 未启动会话不处理
        if (!runningRef.current) return
        const uid = uidRef.current
        if (!uid) return

        // 本地回显：把输入写回终端（下位机不回显时使用；hex 显示模式强制关闭避免破坏 dump）
        if (localEchoRef.current && displayModeRef.current !== 'hex') {
          term.write(data)
        }

        // 发送原始字节到 down channel
        const bytes = new TextEncoder().encode(data)
        // 不 await：onData 同步触发，发送异步进行
        rttService.send(uid, bytes, sendChannelRef.current)
          .then((result) => {
            if (result.success) {
              useRttStore.getState().addBytesSent(result.bytes_written)
            }
          })
          .catch(() => { /* 忽略发送错误，避免阻塞后续输入 */ })
      })

      // 响应式调整
      const fitNow = () => { try { fit.fit() } catch { /* ignore */ } }
      requestAnimationFrame(() => { fitNow(); setTimeout(fitNow, 100) })

      const ro = new ResizeObserver(fitNow)
      ro.observe(containerRef.current)
      window.addEventListener('resize', fitNow)

      return () => {
        ro.disconnect()
        window.removeEventListener('resize', fitNow)
        onDataDisposable.dispose()
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    }, [])

    // 响应终端主题切换
    const terminalTheme = useUiStore((s) => s.terminalTheme)
    useEffect(() => {
      if (termRef.current) {
        termRef.current.options.theme = terminalTheme.theme
      }
    }, [terminalTheme])

    // 响应输入模式切换：动态更新 disableStdin/cursorBlink 并 focus
    // bar → terminal：启用输入、光标闪烁、聚焦终端
    // terminal → bar：禁用输入、光标不闪烁
    useEffect(() => {
      const term = termRef.current
      if (!term) return
      const isTerminal = inputMode === 'terminal'
      term.options.disableStdin = !isTerminal
      term.options.cursorBlink = isTerminal
      if (isTerminal) {
        // 切到终端模式后聚焦，便于直接输入
        try { term.focus() } catch { /* ignore */ }
      }
    }, [inputMode])

    // 运行状态变化：启动时清除欢迎文字（通知已由 ConfigPanel 发出）
    const isFirstMount = useRef(true)
    useEffect(() => {
      if (isFirstMount.current) {
        isFirstMount.current = false
        return
      }
      if (running) {
        // 清除"等待启动 RTT 会话"等欢迎文字，让接收数据干净显示
        termRef.current?.clear()
      }
    }, [running])

    // 增量写入：当 tabDataBuffer 增加新数据时，写入终端
    useEffect(() => {
      const term = termRef.current
      if (!term) return

      // 从上次写入位置开始，写入新增的缓冲块
      while (writtenBufferCountRef.current < tabDataBuffer.length) {
        const buf = tabDataBuffer[writtenBufferCountRef.current]
        if (displayModeRef.current === 'hex') {
          term.write(formatHexDump(buf, writtenBytesRef.current))
        } else {
          const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
          term.write(text)
        }
        writtenBytesRef.current += buf.length
        writtenBufferCountRef.current++
      }
    }, [tabDataBuffer])

    // rtt.error 错误提示（全局错误仍显示）
    useEffect(() => {
      const unsubError = wsClient.on('rtt.error', (data: unknown) => {
        const payload = data as { uid: string; error: string }
        if (payload.uid !== uidRef.current) return
        const term = termRef.current
        if (!term) return
        term.write(`\r\n${COLOR.red}[RTT 错误] ${payload.error}${COLOR.reset}\r\n`)
      })
      return unsubError
    }, [])

    // 显示模式切换：通过全局通知提示
    const prevMode = useRef(displayMode)
    useEffect(() => {
      if (prevMode.current !== displayMode) {
        prevMode.current = displayMode
        useNotificationStore.getState().push({
          type: 'info',
          title: '显示模式已切换',
          message: displayMode === 'text' ? '文本' : '十六进制',
        })
      }
    }, [displayMode])

    // Tab 切换或清空时重置写入位置
    useEffect(() => {
      writtenBufferCountRef.current = 0
      writtenBytesRef.current = 0
      termRef.current?.clear()
    }, [tabId])

    return <div ref={containerRef} className="h-full w-full overflow-hidden pl-2" />
  }
)
