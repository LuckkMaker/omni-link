import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Play,
  Square,
  SkipForward,
  RotateCcw,
  Cpu,
  MemoryStick,
  Search,
  Terminal as TerminalIcon,
  ChevronRight,
  BookOpen,
  Eraser,
  Power,
  Download,
  Upload,
  Trash2,
  GripHorizontal,
  Copy,
  Workflow,
  FolderSearch,
  Check,
  Pause,
  Zap,
  FileSpreadsheet,
  CircleDot,
} from 'lucide-react'
import { useNotificationStore } from '@/stores/notification.store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CommandInfo } from '@/services/commander.service'

interface CommandSidebarProps {
  onRunCommand: (cmd: string) => void
  commands: CommandInfo[]
  connected: boolean
  onClear: () => void
  onResetContext: () => void
}

/** 快捷命令定义 */
interface QuickCommand {
  label: string
  cmd: string
  icon: typeof Play
  group: string
}

const QUICK_COMMANDS: QuickCommand[] = [
  // Run Control
  { label: 'halt', cmd: 'halt', icon: Square, group: 'Run Control' },
  { label: 'continue', cmd: 'continue', icon: Play, group: 'Run Control' },
  { label: 'step', cmd: 'step', icon: SkipForward, group: 'Run Control' },
  { label: 'break', cmd: 'break ', icon: CircleDot, group: 'Run Control' },
  { label: 'where', cmd: 'where', icon: TerminalIcon, group: 'Run Control' },
  { label: 'reset', cmd: 'reset', icon: RotateCcw, group: 'Run Control' },
  { label: 'reset -h', cmd: 'reset -h', icon: Pause, group: 'Run Control' },
  { label: 'status', cmd: 'status', icon: Search, group: 'Run Control' },
  // Registers
  { label: 'reg', cmd: 'reg', icon: Cpu, group: 'Registers' },
  // Memory
  { label: 'read32', cmd: 'read32 ', icon: MemoryStick, group: 'Memory' },
  { label: 'write32', cmd: 'write32 ', icon: MemoryStick, group: 'Memory' },
  { label: 'unlock', cmd: 'unlock', icon: MemoryStick, group: 'Memory' },
  { label: 'erase', cmd: 'erase', icon: Trash2, group: 'Memory' },
  { label: 'load', cmd: 'load ', icon: Download, group: 'Memory' },
  { label: 'savemem', cmd: 'savemem ', icon: Upload, group: 'Memory' },
  { label: 'elf', cmd: 'elf ', icon: BookOpen, group: 'Memory' },
]

// 命令参考区的默认/最小/最大高度（px）
const REF_DEFAULT_HEIGHT = 500
const REF_MIN_HEIGHT = 120
const REF_MAX_HEIGHT = 600

/** 示例分组（标题 + 代码行） */
interface ExampleGroup {
  title: string  // 分组标题，如 "Examples"、"Example script.py content"
  lines: string[]  // 代码行
}

/** 从 extra_help 中提取示例分组
 * 识别 "Examples:" 和 "Example ... content:" 等段落标题
 * 保留原始缩进（对 Python 脚本至关重要）
 */
function extractExampleGroups(extraHelp: string): ExampleGroup[] {
  if (!extraHelp) return []
  const lines = extraHelp.split('\n')
  const groups: ExampleGroup[] = []
  let currentGroup: ExampleGroup | null = null

  for (const line of lines) {
    const trimmed = line.trim()

    // 检测分组标题：Examples: 或 Example ... content:
    if (/^examples?:$/i.test(trimmed) || /^example\s+.*content\s*:$/i.test(trimmed)) {
      if (currentGroup && currentGroup.lines.length > 0) {
        groups.push(currentGroup)
      }
      const title = trimmed.replace(/:$/, '')
      currentGroup = { title, lines: [] }
      continue
    }

    if (currentGroup) {
      // 空行表示当前分组可能结束
      if (trimmed === '') {
        if (currentGroup.lines.length > 0) {
          groups.push(currentGroup)
          currentGroup = null
        }
        continue
      }
      // 遇到非代码行（大写字母开头的描述文本）则结束当前分组
      if (/^[A-Z][a-z]/.test(trimmed) && !trimmed.startsWith('$') && !trimmed.startsWith('!') && !trimmed.startsWith('>') && !trimmed.startsWith('#')) {
        if (currentGroup.lines.length > 0) {
          groups.push(currentGroup)
          currentGroup = null
        }
        continue
      }
      // 保留原始缩进（replaceEnd only，不去掉行首空格）
      currentGroup.lines.push(line.replace(/\s+$/, ''))
    }
  }

  if (currentGroup && currentGroup.lines.length > 0) {
    groups.push(currentGroup)
  }

  // 去除每个分组开头和结尾的空行，并计算公共缩进进行统一去除
  for (const g of groups) {
    // 去除开头空行
    while (g.lines.length > 0 && g.lines[0].trim() === '') {
      g.lines.shift()
    }
    // 去除结尾空行
    while (g.lines.length > 0 && g.lines[g.lines.length - 1].trim() === '') {
      g.lines.pop()
    }
    // 计算最小公共缩进（用于去掉 extra_help 中统一的前缀空格）
    const nonEmpty = g.lines.filter((l) => l.trim() !== '')
    if (nonEmpty.length > 0) {
      const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^ */)![0].length))
      if (minIndent > 0) {
        g.lines = g.lines.map((l) => l.slice(minIndent))
      }
    }
  }

  return groups
}

/** 获取命令的所有示例（带中文说明）
 * 优先使用后端返回的 examples 字段（准确的数据库示例）
 * 如果没有，再从 extra_help 中提取（无说明）
 */
function getCommandExamples(cmd: CommandInfo): { cmd: string; desc?: string }[] {
  // 优先使用后端数据库中的示例（新结构：{cmd, desc}）
  if (cmd.examples && cmd.examples.length > 0) {
    return cmd.examples
  }
  // 回退：从 extra_help 提取（无说明）
  const groups = extractExampleGroups(cmd.extra_help)
  return groups.flatMap((g) => g.lines.map((line) => ({ cmd: line })))
}

/** 流程步骤（单个命令） */
function WorkflowStep({
  cmd,
  connected,
  onRun,
}: {
  cmd: string
  connected: boolean
  onRun: (cmd: string) => void
}) {
  return (
    <span
      className={cn(
        'cursor-pointer hover:underline',
        connected ? 'text-primary' : 'text-muted-foreground/40'
      )}
      onClick={() => connected && onRun(cmd)}
    >
      {cmd}
    </span>
  )
}

/** 流程箭头分隔符 */
function WorkflowArrow() {
  return <span className="text-muted-foreground/40">→</span>
}

export function CommandSidebar({
  onRunCommand,
  commands,
  connected,
  onClear,
  onResetContext,
}: CommandSidebarProps) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)
  const [showReference, setShowReference] = useState(false)
  const [showWorkflows, setShowWorkflows] = useState(false)
  const [exampleCmd, setExampleCmd] = useState<CommandInfo | null>(null)

  // 路径转换工具
  const [pathInput, setPathInput] = useState('')
  const [pathCopied, setPathCopied] = useState(false)

  // 命令参考区高度（可拖拽拉伸）
  const [refHeight, setRefHeight] = useState(REF_DEFAULT_HEIGHT)
  const draggingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)

  // 按分组组织快捷命令（保持定义顺序）
  const quickGroups = QUICK_COMMANDS.reduce<Record<string, QuickCommand[]>>((acc, cmd) => {
    ;(acc[cmd.group] ??= []).push(cmd)
    return acc
  }, {})

  // 按分类组织命令参考，自定义命令放在最后
  const refGroups = commands.reduce<Record<string, CommandInfo[]>>((acc, cmd) => {
    const cat = cmd.category || 'other'
    ;(acc[cat] ??= []).push(cmd)
    return acc
  }, {})
  const sortedCategories = Object.keys(refGroups).sort((a, b) => a.localeCompare(b))

  // ── 拖拽拉伸命令参考区 ──────────────────
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      draggingRef.current = true
      startYRef.current = e.clientY
      startHeightRef.current = refHeight
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [refHeight]
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const delta = startYRef.current - e.clientY
      const newHeight = Math.max(
        REF_MIN_HEIGHT,
        Math.min(REF_MAX_HEIGHT, startHeightRef.current + delta)
      )
      setRefHeight(newHeight)
    }

    const handleMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  /** 复制文本到剪贴板 */
  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
  }, [])

  /** 转换路径：Windows 反斜杠转正斜杠
   *  只取第一行非空内容，避免粘贴多行路径后复制到终端时
   *  被 xterm.js 误当作多条命令执行 */
  const convertedPath = (pathInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
  ).replace(/\\/g, '/')

  /** 复制转换后的路径并插入到终端 */
  const handleCopyPath = useCallback(() => {
    if (!convertedPath) return
    navigator.clipboard.writeText(convertedPath).then(() => {
      setPathCopied(true)
      setTimeout(() => setPathCopied(false), 2000)
    }).catch(() => {})
  }, [convertedPath])

  /** 插入转换后的路径到终端（带 load 前缀） */
  const handleInsertPath = useCallback(() => {
    if (!convertedPath) return
    onRunCommand(`load ${convertedPath} `)
  }, [convertedPath, onRunCommand])

  /** 处理命令点击：可用则插入（不执行），不可用则全局通知 */
  const handleCommandClick = useCallback(
    (cmd: CommandInfo) => {
      const canRun = connected || !cmd.requires_connection
      if (!canRun) {
        useNotificationStore.getState().push({
          type: 'warning',
          title: '命令不可用',
          message: '该命令需要连接目标设备',
          autoClose: true,
          autoCloseDelay: 3000,
        })
        return
      }
      // 始终追加空格，确保走 insertText 只插入不执行
      onRunCommand(cmd.name + ' ')
    },
    [connected, onRunCommand]
  )

  /** 处理示例点击：可用则插入（不执行），不可用则全局通知 */
  const handleExampleClick = useCallback(
    (example: string) => {
      // 提取命令名用于检查是否需要连接（保留 ! 和 $ 前缀）
      const cmdText = example.trim()
      // 对于 ! 和 $ 前缀命令，命令名就是前缀符号
      const cmdName = cmdText.startsWith('!') ? '!' :
                      cmdText.startsWith('$') ? '$' :
                      cmdText.split(/\s/)[0]
      const cmdInfo = commands.find((c) => c.name === cmdName)
      const requiresConn = cmdInfo?.requires_connection ?? true
      if (requiresConn && !connected) {
        useNotificationStore.getState().push({
          type: 'warning',
          title: '命令不可用',
          message: '该命令需要连接目标设备',
          autoClose: true,
          autoCloseDelay: 3000,
        })
        return
      }
      // 只插入不执行（末尾加空格方便编辑参数）
      onRunCommand(cmdText + ' ')
    },
    [connected, commands, onRunCommand]
  )
  // 保留 handleExampleClick 供未来扩展使用（命令行直接插入示例）
  void handleExampleClick

  return (
    <div className="flex h-full w-full flex-col bg-muted/30">
      {/* Header：清屏 + 重置上下文 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onClear}
          className="h-7 flex-1 gap-1.5 text-xs"
          title="清屏 (Ctrl+L)"
        >
          <Eraser className="size-3.5 text-muted-foreground" />
          Clear
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!connected}
          onClick={onResetContext}
          className="h-7 flex-1 gap-1.5 text-xs"
          title="重置命令上下文（目标切换后使用）"
        >
          <RotateCcw className="size-3.5 text-muted-foreground" />
          Reset
        </Button>
      </div>

      {/* 路径转换工具 */}
      <div className="shrink-0 border-b border-border p-2">
        <div className="mb-1 flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground">
          路径转换
        </div>
        <input
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder="粘贴 Windows 路径..."
          className="h-7 w-full rounded border border-border bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
        />
        {convertedPath && (
          <div className="mt-1 space-y-1">
            <div className="rounded bg-muted/60 px-2 py-1">
              <code className="text-[10px] font-mono text-foreground/90 break-all">
                {convertedPath}
              </code>
            </div>
            <div className="flex gap-1">
              <button
                onClick={handleCopyPath}
                className="flex flex-1 items-center justify-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                {pathCopied ? (
                  <>
                    <Check className="size-2.5" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="size-2.5" />
                    复制
                  </>
                )}
              </button>
              <button
                onClick={handleInsertPath}
                disabled={!connected}
                className="flex flex-1 items-center justify-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-40"
                title={connected ? '插入 load 命令' : '需要连接设备'}
              >
                <Download className="size-2.5" />
                插入 load
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Quick Commands 区 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border px-2 py-1.5">
          <span className="px-1 text-xs font-medium text-muted-foreground">
            快捷命令
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {Object.entries(quickGroups).map(([group, cmds]) => (
            <div key={group} className="mb-3">
              <div className="mb-1 px-1 text-[11px] font-medium tracking-wide text-muted-foreground/70">
                {group}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {cmds.map((cmd) => (
                  <Button
                    key={cmd.label}
                    variant="outline"
                    size="sm"
                    disabled={!connected}
                    onClick={() => onRunCommand(cmd.cmd)}
                    className="h-7 justify-start gap-1.5 px-2 text-xs"
                  >
                    <cmd.icon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{cmd.label}</span>
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 常用流程 区 */}
      <div className="shrink-0 border-t border-border">
        <button
          onClick={() => setShowWorkflows((v) => !v)}
          className="flex w-full items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-medium hover:bg-muted/40 transition-colors"
        >
          <ChevronRight
            className={cn('size-3 transition-transform', showWorkflows && 'rotate-90')}
          />
          <Workflow className="size-3.5 text-muted-foreground" />
          常用流程
        </button>
        {showWorkflows && (
          <div className="p-2 space-y-2">
            {/* 调试含符号信息 */}
            <div className="rounded-md border border-border/50 bg-muted/30 p-2">
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground/70">
                <Zap className="size-3 text-muted-foreground" />
                调试（含符号信息）
              </div>
              <div className="flex flex-wrap items-center gap-0.5 text-[11px] font-mono">
                <WorkflowStep cmd="halt" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="erase" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="load " connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="reset -h" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="elf " connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="step" connected={connected} onRun={onRunCommand} />
              </div>
            </div>
            {/* 断点调试 */}
            <div className="rounded-md border border-border/50 bg-muted/30 p-2">
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground/70">
                <Zap className="size-3 text-muted-foreground" />
                断点调试
              </div>
              <div className="flex flex-wrap items-center gap-0.5 text-[11px] font-mono">
                <WorkflowStep cmd="elf " connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="break " connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="reset -h" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="continue" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="step" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="where" connected={connected} onRun={onRunCommand} />
              </div>
            </div>
            {/* 解锁并烧录 */}
            <div className="rounded-md border border-border/50 bg-muted/30 p-2">
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground/70">
                <Zap className="size-3 text-muted-foreground" />
                解锁并烧录
              </div>
              <div className="flex flex-wrap items-center gap-0.5 text-[11px] font-mono">
                <WorkflowStep cmd="halt" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="unlock" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="erase" connected={connected} onRun={onRunCommand} />
                <WorkflowArrow />
                <WorkflowStep cmd="load " connected={connected} onRun={onRunCommand} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Command Reference 区 */}
      <div
        className="shrink-0 border-t border-border bg-muted/50"
        style={{ height: showReference ? refHeight : 'auto' }}
      >
        {/* 拖拽条 */}
        {showReference && (
          <div
            onMouseDown={handleDragStart}
            className="flex h-1.5 cursor-row-resize items-center justify-center bg-border hover:bg-primary/40 transition-colors"
            title="拖拽调整高度"
          >
            <GripHorizontal className="size-3 text-muted-foreground/50" />
          </div>
        )}

        {/* 标题栏 */}
        <button
          onClick={() => setShowReference((v) => !v)}
          className="flex w-full items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-medium hover:bg-muted/40 transition-colors"
        >
          <ChevronRight
            className={cn('size-3 transition-transform', showReference && 'rotate-90')}
          />
          <BookOpen className="size-3.5 text-muted-foreground" />
          命令参考
          <span className="ml-auto text-[10px] text-muted-foreground">{commands.length}</span>
        </button>

        {/* 命令列表 */}
        {showReference && (
          <div className="overflow-y-auto" style={{ height: refHeight - 44 }}>
            {sortedCategories.map((cat) => {
              const cmds = refGroups[cat]
              return (
                <div key={cat} className="border-b border-border/50 last:border-b-0">
                  {/* 分类标题 */}
                  <button
                    onClick={() =>
                      setExpandedCategory(expandedCategory === cat ? null : cat)
                    }
                    className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide hover:bg-muted/30 transition-colors"
                  >
                    <ChevronRight
                      className={cn(
                        'size-3 transition-transform',
                        expandedCategory === cat && 'rotate-90'
                      )}
                    />
                    {cat}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {cmds.length}
                    </span>
                  </button>

                  {/* 命令列表 */}
                  {expandedCategory === cat && (
                    <div className="pb-1">
                      {cmds.map((cmd) => {
                        const examples = getCommandExamples(cmd)
                        const canRun = connected || !cmd.requires_connection
                        return (
                          <div
                            key={cmd.name}
                            className="group flex items-center gap-1 px-2 py-1 pl-4 transition-colors hover:bg-primary/5"
                          >
                            {/* 点击命令名插入命令（不执行） */}
                            <button
                              onClick={() => handleCommandClick(cmd)}
                              className={cn(
                                'flex min-w-0 flex-1 items-baseline gap-1 text-left',
                                !canRun && 'opacity-40'
                              )}
                            >
                              <code className="font-mono text-[11px] text-primary">
                                {cmd.name}
                              </code>
                              {cmd.usage && (
                                <span className="font-mono text-[10px] text-muted-foreground truncate">
                                  {cmd.usage}
                                </span>
                              )}
                            </button>
                            {/* 示例按钮（有示例时始终显示） */}
                            {examples.length > 0 && (
                              <button
                                onClick={() => setExampleCmd(cmd)}
                                className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 hover:bg-amber-500/20 transition-colors"
                                title="查看示例"
                              >
                                <FileSpreadsheet className="size-2.5" />
                                <span>示例</span>
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 示例弹窗 */}
      <Dialog open={!!exampleCmd} onOpenChange={(open) => !open && setExampleCmd(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-col gap-1 leading-normal">
              <div className="flex items-center gap-2">
                <code className="font-mono text-primary text-base break-all">
                  {exampleCmd?.name}
                </code>
                {exampleCmd?.usage && (
                  <span className="font-mono text-sm text-muted-foreground break-all">
                    {exampleCmd.usage}
                  </span>
                )}
              </div>
              {/* 副标题：命令功能简述 */}
              {exampleCmd?.help && (
                <p className="text-xs font-normal text-muted-foreground">
                  {exampleCmd.help}
                </p>
              )}
            </DialogTitle>
          </DialogHeader>
          {exampleCmd && (
            <div className="space-y-3">
              {/* 详细说明（extra_help 非示例部分） */}
              {exampleCmd.extra_help && (
                <div className="space-y-2">
                  {/* 渲染非示例的描述文本 */}
                  {exampleCmd.extra_help
                    .split(/\n\n+/)
                    .filter((para) => {
                      const t = para.trim()
                      // 跳过示例段落（由代码块单独渲染）
                      return !/^examples?:/i.test(t) &&
                             !/^example\s+.*content\s*:/i.test(t)
                    })
                    .map((para, idx) => (
                      <p key={idx} className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                        {para.trim()}
                      </p>
                    ))}
                </div>
              )}
              {/* 别名 */}
              {exampleCmd.aliases.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Aliases:</span>
                  <div className="flex gap-1">
                    {exampleCmd.aliases.map((alias) => (
                      <code key={alias} className="font-mono text-primary/80 bg-muted px-1.5 py-0.5 rounded">
                        {alias}
                      </code>
                    ))}
                  </div>
                </div>
              )}
              {/* 示例列表（单条示例 + 中文说明 + 复制按钮） */}
              {(() => {
                const examples = getCommandExamples(exampleCmd)
                const groups = extractExampleGroups(exampleCmd.extra_help)
                if (examples.length === 0 && groups.length === 0) return null

                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        示例（{examples.length}）
                      </span>
                      {examples.length > 0 && (
                        <button
                          onClick={() => copyToClipboard(examples.map((e) => e.cmd).join('\n'))}
                          className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-primary transition-colors"
                          title="复制全部示例"
                        >
                          <Copy className="size-2.5" />
                          <span>复制全部</span>
                        </button>
                      )}
                    </div>
                    {examples.map((ex, idx) => (
                      <div
                        key={idx}
                        className="group rounded border border-border/60 bg-muted/40 p-2 hover:border-primary/40 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <code className="flex-1 font-mono text-xs text-foreground/90 break-all">
                            {ex.cmd}
                          </code>
                          <button
                            onClick={() => copyToClipboard(ex.cmd)}
                            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
                            title="复制此示例"
                          >
                            <Copy className="size-3" />
                          </button>
                        </div>
                        {ex.desc && (
                          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                            {ex.desc}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
