import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, X } from 'lucide-react'
import type { SourceBreakpoint, BreakpointUpdate } from '@/services/zone.service'

/** execute 模式只读命令白名单（与后端 soft_bp.py EXECUTE_READONLY_COMMANDS 对齐） */
const EXECUTE_COMMANDS: { value: string; hint: string }[] = [
  { value: 'reg', hint: 'reg [r0 r1 ...]' },
  { value: 'rr', hint: 'rr [r0 ...]' },
  { value: 'read8', hint: 'read8 <地址>' },
  { value: 'read16', hint: 'read16 <地址>' },
  { value: 'read32', hint: 'read32 <地址>' },
  { value: 'read64', hint: 'read64 <地址>' },
  { value: 'rb', hint: 'rb <地址>' },
  { value: 'rh', hint: 'rh <地址>' },
  { value: 'rw', hint: 'rw <地址>' },
  { value: 'rd', hint: 'rd <地址>' },
  { value: 'disasm', hint: 'disasm [地址] [条数]' },
  { value: 'd', hint: 'd [地址] [条数]' },
  { value: 'where', hint: 'where（当前 PC 所在符号）' },
  { value: 'symbol', hint: 'symbol <名字>' },
  { value: 'status', hint: 'status（目标状态）' },
  { value: 'st', hint: 'st（目标状态）' },
]

interface CommandRow {
  cmd: string
  args: string
}

/** 将多行命令字符串解析为行数组（每行 = 命令 + 参数） */
function parseCommandRows(text: string | null | undefined): CommandRow[] {
  const rows = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (rows.length === 0) return [{ cmd: 'reg', args: '' }]
  return rows.map((line) => {
    const [cmd, ...rest] = line.split(/\s+/)
    return { cmd: cmd || 'reg', args: rest.join(' ') }
  })
}

/** 将行数组序列化为多行命令字符串 */
function serializeCommandRows(rows: CommandRow[]): string {
  return rows
    .map((r) => [r.cmd, r.args].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n')
}

interface Props {
  open: boolean
  bp: SourceBreakpoint
  onOpenChange: (open: boolean) => void
  onSave: (patch: BreakpointUpdate) => void
}

/** 编辑断点条件/日志内容/执行命令对话框（标题与输入控件按 mode 动态切换） */
export function BreakpointConditionDialog({ open, bp, onOpenChange, onSave }: Props) {
  const mode = bp.mode
  // break/log 用单行文本；execute 用命令选择器（白名单下拉 + 参数）
  const [text, setText] = useState('')
  const [rows, setRows] = useState<CommandRow[]>([{ cmd: 'reg', args: '' }])

  // 打开时同步当前断点内容
  useEffect(() => {
    if (!open) return
    if (mode === 'execute') {
      setRows(parseCommandRows(bp.condition))
    } else {
      setText(bp.condition ?? '')
    }
  }, [open, bp, mode])

  const title =
    mode === 'break' ? '编辑条件' : mode === 'log' ? '编辑日志内容' : '编辑执行命令'
  const description =
    mode === 'break'
      ? '表达式求值为 true 时才中断（空 = 无条件）。支持寄存器、内存与基本运算。'
      : mode === 'log'
        ? '命中时打印该文本并自动继续，不中断。可用 {表达式} 插入运行时值。'
        : '命中时逐行执行只读命令并自动继续，不中断。仅允许列出的只读命令。'

  const handleSave = () => {
    if (mode === 'execute') {
      onSave({ condition: serializeCommandRows(rows), applyCondition: true })
    } else {
      onSave({ condition: text, applyCondition: true })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {mode === 'execute' ? (
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={row.cmd}
                  onValueChange={(v) =>
                    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, cmd: v } : r)))
                  }
                >
                  <SelectTrigger className="w-32 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXECUTE_COMMANDS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={row.args}
                  onChange={(e) =>
                    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, args: e.target.value } : r)))
                  }
                  placeholder={EXECUTE_COMMANDS.find((c) => c.value === row.cmd)?.hint}
                  className="h-9 min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                  title="删除该行"
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setRows((prev) => [...prev, { cmd: 'reg', args: '' }])}
            >
              <Plus className="mr-1 size-3.5" /> 添加命令
            </Button>
            <p className="text-xs text-muted-foreground">
              非只读命令（write/step/script 等）命中时会被后端拒绝，不影响目标状态。
            </p>
          </div>
        ) : (
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={mode === 'break' ? '例如：r0 > 100 && r1 == 0x20000000' : '例如：count = {r0}, flag = {flag}'}
            className="font-mono text-sm"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}