import { useCallback, useEffect, useRef } from 'react'
import { Terminal, type TerminalApi } from '@/pages/commander/components/Terminal'
import { useProbeStore } from '@/stores/probe.store'
import { useCommanderStore } from '@/stores/commander.store'
import { useZoneStore } from '../store'
import { useLogStore } from '@/stores/log.store'
import type { LogEvent } from '@shared/types'

// ── 事件行 ANSI 着色（与现有 COLOR 风格一致）──
const ANSI = {
  timestamp: '\x1b[2m', // dim
  info: '\x1b[90m', // 灰
  warning: '\x1b[33m', // 黄
  error: '\x1b[31m', // 红
  reset: '\x1b[0m',
} as const

const LEVEL_TAG: Record<LogEvent['level'], string> = {
  info: 'INFO',
  warning: 'WARN',
  error: 'ERR ',
}

/** 时间戳 HH:MM:SS.mmm（与全局日志区一致） */
function formatTime(ts: string | number): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  } catch {
    return String(ts)
  }
}

/** Zone 控制台 help 回复：保持 pyOCD help 排版风格，但只列出 Zone 支持的命令 */
const HELP_LINES = [
  'Commands:',
  '--------',
  'break                     ADDR                 Set a breakpoint address.',
  'c, continue, g, go                             Resume execution of the target.',
  'd, disasm                 [-c/--center] ADDR [LEN] Disassemble instructions at an address.',
  'fill                      [SIZE] ADDR LEN PATTERN Fill a range of memory with a pattern.',
  'h, halt                                        Halt the target.',
  '?, help                   [CMD]                Show help for commands.',
  'rb, read8                 ADDR [LEN]           Read 8-bit bytes.',
  'rh, read16                ADDR [LEN]           Read 16-bit halfwords.',
  'rw, read32                ADDR [LEN]           Read 32-bit words.',
  'rd, read64                ADDR [LEN]           Read 64-bit words.',
  'reg, rr                   [-p] [-f] [REG...]   Print core or peripheral register(s).',
  'reset                     [halt|-halt|-h] [TYPE] Reset the target, optionally with halt and/or specifying the reset type.',
  'rmbreak                   ADDR                 Remove a breakpoint.',
  'rmwatch                   ADDR [r|w|rw] [1|2|4] Remove watchpoint(s).',
  'st, status                                     Show the target\'s current state.',
  's, step                   [COUNT]              Step one or more instructions.',
  'symbol                    NAME                 Show a symbol\'s value.',
  'watch                     ADDR [r|w|rw] [1|2|4] Set a watchpoint address, and optional access type (default rw) and size (4).',
  'where                     [ADDR]               Show symbol, file, and line for address.',
  'wb, write8                ADDR DATA+           Write 8-bit bytes to memory.',
  'wh, write16               ADDR DATA+           Write 16-bit halfwords to memory.',
  'ww, write32               ADDR DATA+           Write 32-bit words to memory.',
  'wd, write64               ADDR DATA...         Write 64-bit double-words to memory.',
  '',
  'Any integer argument will accept a register name.',
]

/** 把一条 zone 事件格式化为带颜色/时间戳/级别的终端行 */
function formatEventLine(e: LogEvent): string {
  const color = ANSI[e.level]
  return (
    `${ANSI.timestamp}${formatTime(e.timestamp)}${ANSI.reset} ` +
    `${color}[${LEVEL_TAG[e.level]}]${ANSI.reset} ${color}${e.message}${ANSI.reset}`
  )
}

/** 回放时最多注入的 zone 事件条数 */
const REPLAY_LIMIT = 100

/**
 * Zone 底部 Console（统一混合流 + Zone 内命令联动）
 *
 * - 复用 Commander 的 Terminal（xterm REPL：历史/Tab 补全/Ctrl+R/复制粘贴/字体缩放）。
 * - 订阅全局 log store 的 zone 事件，注入到 xterm scrollback（带时间戳/级别着色），
 *   与命令回显/输出混排成统一混合流（最接近 Keil Command 窗口）。
 * - 运行控制类命令（halt/step/continue/go/reset）经 onBeforeCommand 拦截，改走
 *   Zone store 既有 action，使工具栏状态与 Watch/寄存器/内存/调用栈面板随之联动。
 * - 头部提供清屏 / 保存日志。
 */
export function ConsoleDock() {
  const terminalApiRef = useRef<TerminalApi | null>(null)

  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  const commands = useCommanderStore((s) => s.commands)
  const commandsLoaded = useCommanderStore((s) => s.commandsLoaded)
  const fetchCommands = useCommanderStore((s) => s.fetchCommands)

  // 拉取命令列表（供 Tab 补全）
  useEffect(() => {
    if (isConnected && uid) {
      void fetchCommands(uid)
    } else if (!commandsLoaded) {
      void fetchCommands(null)
    }
  }, [isConnected, uid, commandsLoaded, fetchCommands])

  // Tab 切换后触发 resize，让 xterm FitAddon 重算尺寸
  useEffect(() => {
    const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    return () => clearTimeout(timer)
  }, [])

  // ── zone 事件注入（混合流）──
  // 已注入的 zone 事件条数：subscribe 增量时据此只注入新增条目，避免重复
  const injectedRef = useRef(0)

  const injectZoneLogs = useCallback((api: TerminalApi) => {
    // 仅注入面向用户的调试事件；internal 内部诊断日志（如 Disasm 加载细节）不进入 Console
    const zoneLogs = useLogStore
      .getState()
      .logs.filter((l) => l.source === 'zone' && !l.internal)
    // 日志被 clearLogs 清空过：重置计数，避免后续新增事件被跳过
    if (zoneLogs.length < injectedRef.current) injectedRef.current = 0
    const newItems = zoneLogs.slice(injectedRef.current)
    injectedRef.current = zoneLogs.length
    for (const e of newItems) api.writeLog?.(formatEventLine(e))
  }, [])

  // 等待 Terminal 就绪（apiRef 写入后）回放最近 N 条 zone 事件，避免切页返回空白
  useEffect(() => {
    let raf = 0
    const check = () => {
      const api = terminalApiRef.current
      if (api?.writeLog) {
        const zoneLogs = useLogStore
          .getState()
          .logs.filter((l) => l.source === 'zone')
        injectedRef.current = Math.max(0, zoneLogs.length - REPLAY_LIMIT)
        injectZoneLogs(api)
        return
      }
      raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [injectZoneLogs])

  // 订阅全局 log store：新增 zone 事件增量注入
  useEffect(() => {
    const unsub = useLogStore.subscribe(() => {
      const api = terminalApiRef.current
      if (api?.writeLog) injectZoneLogs(api)
    })
    return unsub
  }, [injectZoneLogs])

  // ── 命令→Zone store 联动 ──
  // 黑名单：Zone 控制台禁用高风险 pyOCD 命令（任意代码执行 / 烧录擦除 / 文件读写），
  // 避免绕过界面约束或破坏调试会话；此类命令拦截并提示前往 Commander 页面
  const blockedCommands = ['script', 'exec', 'eval', 'py', 'python', 'load', 'save', 'flash', 'erase', 'write']
  // 拦截运行控制类命令，改走 Zone store action（自动刷新工具栏与各面板 + 写 zone 日志）
  const onBeforeCommand = useCallback(async (cmdUid: string, cmd: string): Promise<boolean> => {
    const tokens = cmd.trim().split(/\s+/)
    const first = (tokens[0] ?? '').toLowerCase()
    if (blockedCommands.includes(first)) {
      useLogStore.getState().addLog({
        timestamp: new Date().toISOString(),
        level: 'warning',
        message: `命令「${first}」在 Zone 控制台不可用（受保护），请前往 Commander 页面操作`,
        source: 'zone',
      })
      return true
    }
    // 前缀式高风险命令：Python 表达式 / shell / run script
    const trimmed = cmd.trim()
    if (trimmed.startsWith('$') || trimmed.startsWith('!') || first === 'run') {
      const kind = trimmed.startsWith('$')
        ? 'Python 表达式'
        : trimmed.startsWith('!')
          ? 'Shell 命令'
          : 'run script'
      useLogStore.getState().addLog({
        timestamp: new Date().toISOString(),
        level: 'warning',
        message: `${kind}在 Zone 控制台不可用（受保护），请前往 Commander 页面操作`,
        source: 'zone',
      })
      return true
    }
    const zone = useZoneStore.getState()
    switch (first) {
      case 'help':
        // 回复 Zone 实际支持的命令（覆盖 pyOCD 全量 help，避免列出被禁用/被拦截命令）
        for (const line of HELP_LINES) {
          terminalApiRef.current?.writeLog?.(line)
        }
        return true
      case 'halt':
        await zone.halt(cmdUid)
        return true
      case 'continue':
      case 'go':
        await zone.continue(cmdUid)
        return true
      case 'step': {
        const mode = (tokens[1] ?? '').toLowerCase()
        if (mode === 'over') await zone.step(cmdUid, 'over')
        else if (mode === 'out') await zone.step(cmdUid, 'out')
        else await zone.step(cmdUid, 'into')
        return true
      }
      case 'reset':
        await zone.reset(cmdUid, 'halt')
        return true
      default:
        // 内存/寄存器/断点类命令（read32/write32/break 等）仍直通 commander
        return false
    }
  }, [])

  return (
    <div className="h-full min-h-0">
      <Terminal
        uid={uid}
        connected={isConnected}
        commands={commands}
        apiRef={terminalApiRef}
        onBeforeCommand={onBeforeCommand}
        banner={[
          `Type 'help' for commands, Tab to complete, Ctrl+R to search history`,
          `Copy: Ctrl+Shift+C | Paste: Ctrl+Shift+V`,
          `Clear: Ctrl+L | Zoom: Ctrl+MouseWheel`,
          `以下命令在 Zone 页面禁用: script/exec/eval/load/save/flash/erase/write`,
        ]}
      />
    </div>
  )
}