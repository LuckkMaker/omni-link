import { useCallback, useState } from 'react'
import { Eraser, Trash2, Download, Keyboard, MessageSquare, FileDown, ListChecks, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { useRttStore } from '@/stores/rtt.store'
import { CHECKSUM_OPTIONS, type ChecksumType } from '@/utils/checksum'
import { cn } from '@/lib/utils'
import { SaveFormatDialog } from './SaveFormatDialog'
import { SendFileButton } from './SendFileButton'

/** 校验起始字节选项（UI 为 1-based 显示，值为 0-based 内部索引） */
const CHECKSUM_START_OPTIONS = Array.from({ length: 8 }, (_, i) => ({
  label: `第${i + 1}字节`,
  value: i,
}))

/** 校验结束字节选项（负值表示从末尾排除 N 字节） */
const CHECKSUM_END_OPTIONS = [
  { label: '末尾', value: -1 },
  { label: '倒数第1字节', value: -2 },
  { label: '倒数第2字节', value: -3 },
  { label: '倒数第3字节', value: -4 },
  { label: '倒数第4字节', value: -5 },
]

interface ConfigPanelProps {
  uid: string | null
  connected: boolean
  terminalRef: React.RefObject<{ clear: () => void; getData: () => Uint8Array; clearData: () => void } | null>
  /** 打开多字符串对话框 */
  onOpenMultiString: () => void
}

/** 统一配置行：复选框 + 文字（+ 可选右侧配置项）。
 *  间距统一 gap-2，行高 h-7，保证整个侧边栏复选框行视觉一致。 */
function CheckRow({
  label,
  checked,
  onCheckedChange,
  disabled,
  title,
  children,
}: {
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
  disabled?: boolean
  title?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex h-7 items-center gap-2">
      <Checkbox
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        title={title}
      />
      <span className="text-[11px] whitespace-nowrap" title={title}>{label}</span>
      {children && (
        <div className="ml-auto flex items-center gap-1">
          {children}
        </div>
      )}
    </div>
  )
}

/** 配置项的次行容器：常驻显示，未勾选时禁用并降低视觉权重。
 *  用于"定时发送"、"加校验"等需要展开额外配置的复选项。 */
function ConfigSubRow({
  disabled,
  children,
  className,
}: {
  disabled?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn(
      'flex h-7 items-center gap-1.5 pl-6',
      disabled && 'opacity-50 pointer-events-none',
      className,
    )}>
      {children}
    </div>
  )
}

export function ConfigPanel({ uid, terminalRef, onOpenMultiString }: ConfigPanelProps) {
  const [showSaveDialog, setShowSaveDialog] = useState(false)

  const {
    running,
    displayMode,
    inputMode,
    localEcho,
    recordToFile,
    sendHex,
    sendNewline,
    sendTiming,
    sendTimingInterval,
    sendChecksum,
    sendChecksumType,
    sendChecksumStart,
    sendChecksumEnd,
    setDisplayMode,
    setInputMode,
    setLocalEcho,
    setRecordToFile,
    setSendHex,
    setSendNewline,
    setSendTiming,
    setSendTimingInterval,
    setSendChecksum,
    setSendChecksumType,
    setSendChecksumStart,
    setSendChecksumEnd,
  } = useRttStore()

  const activeTabId = useRttStore((s) => s.activeTabId)
  const activeTab = useRttStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const handleClear = useCallback(() => { terminalRef.current?.clear() }, [terminalRef])
  const handleClearData = useCallback(() => {
    terminalRef.current?.clear()
    terminalRef.current?.clearData()
    // 仅清空当前 Tab 的 xterm 视图与数据缓冲；
    // 不再重置全局收发字节统计，保留 status bar 所有 tab 累计统计
  }, [terminalRef])

  const handleSave = useCallback((format: 'txt' | 'log' | 'csv' | 'bin') => {
    const data = terminalRef.current?.getData()
    if (!data || data.length === 0) return
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    let blob: Blob
    let ext: string
    switch (format) {
      case 'bin':
        blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' })
        ext = 'bin'
        break
      case 'csv': {
        const lines: string[] = ['Offset,Hex,ASCII']
        const chunkSize = 16
        for (let i = 0; i < data.length; i += chunkSize) {
          const chunk = data.slice(i, i + chunkSize)
          const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ')
          const ascii = Array.from(chunk).map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('')
          lines.push(`${i.toString(16).padStart(8, '0')},"${hex}","${ascii}"`)
        }
        blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
        ext = 'csv'
        break
      }
      case 'log': {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(data)
        const lines = text.split(/\r?\n/)
        const stamped = lines.map((line) => {
          const now = new Date().toISOString().replace('T', ' ').slice(0, 23)
          return `[${now}] ${line}`
        })
        blob = new Blob([stamped.join('\n')], { type: 'text/plain;charset=utf-8' })
        ext = 'log'
        break
      }
      case 'txt':
      default: {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(data)
        blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
        ext = 'txt'
        break
      }
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `rtt_${timestamp}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }, [terminalRef])

  const handleToggleRecord = useCallback(() => {
    setRecordToFile(!recordToFile, null)
  }, [recordToFile, setRecordToFile])

  const getSendChannel = useCallback(() => {
    const tab = useRttStore.getState().tabs.find((t) => t.id === activeTabId)
    if (tab?.mode === 'single' && tab.channel !== undefined) return tab.channel
    return useRttStore.getState().selectedDownChannel
  }, [activeTabId])

  const dataSize = activeTab?.bufferSize ?? 0

  return (
    <div className="flex flex-col overflow-y-auto text-xs">
      {/* ① 接收配置 */}
      <div className="border-b border-border last:border-b-0">
        <div className="px-2 py-1.5">
          <span className="text-xs font-medium text-muted-foreground">接收配置</span>
        </div>
        <div className="space-y-1 p-2 pt-0">

        {/* 输入模式切换（segmented） */}
        <div className="flex items-center rounded-md border border-border p-0.5">
          <button
            onClick={() => setInputMode('bar')}
            className={cn(
              'flex h-6 flex-1 items-center justify-center gap-1 rounded text-[11px] font-medium transition-colors',
              inputMode === 'bar' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
            title="输入栏模式"
          >
            <MessageSquare className="size-3" />
            输入栏
          </button>
          <button
            onClick={() => setInputMode('terminal')}
            className={cn(
              'flex h-6 flex-1 items-center justify-center gap-1 rounded text-[11px] font-medium transition-colors',
              inputMode === 'terminal' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
            title="终端模式"
          >
            <Keyboard className="size-3" />
            终端
          </button>
        </div>

        {/* 本地回显：复选框 + 文字（仅终端模式） */}
        {inputMode === 'terminal' && (
          <CheckRow
            label="本地回显"
            checked={localEcho}
            onCheckedChange={setLocalEcho}
            title="开启后输入立即显示在终端。下位机 shell 通常会回显，无需开启；仅当下位机不回显时开启"
          />
        )}

        {/* HEX 显示：复选框 + 文字 */}
        <CheckRow
          label="HEX 显示"
          checked={displayMode === 'hex'}
          onCheckedChange={(v) => setDisplayMode(v ? 'hex' : 'text')}
          title="以十六进制格式显示接收数据"
        />

        <div className="grid grid-cols-2 gap-1.5 pt-0.5">
          <Button variant="outline" size="sm" onClick={handleClear} className="h-7 text-[11px]" title="清屏：保留数据缓冲">
            <Eraser className="mr-1 h-3 w-3" />
            清屏
          </Button>
          <Button variant="outline" size="sm" onClick={handleClearData} className="h-7 text-[11px]" title="清空：清除数据缓冲">
            <Trash2 className="mr-1 h-3 w-3" />
            清空
          </Button>
        </div>

        <Button variant="outline" size="sm" onClick={() => setShowSaveDialog(true)} disabled={dataSize === 0} className="h-7 w-full text-[11px]" title="保存接收数据到文件">
          <Download className="mr-1 h-3 w-3" />
          保存数据{dataSize > 0 ? ` (${dataSize < 1024 ? `${dataSize}B` : `${(dataSize / 1024).toFixed(1)}K`})` : ''}
        </Button>

        <Button variant={recordToFile ? 'default' : 'outline'} size="sm" onClick={handleToggleRecord} disabled={!running} className="h-7 w-full text-[11px]" title="开启后持续把接收到的数据存入 .dat 文件">
          <FileDown className="mr-1 h-3 w-3" />
          {recordToFile ? '停止接收' : '接收数据到文件'}
        </Button>
        </div>
      </div>

      {/* ② 发送配置 */}
      <div className="border-b border-border last:border-b-0">
        <div className="px-2 py-1.5">
          <span className="text-xs font-medium text-muted-foreground">发送配置</span>
        </div>
        <div className="space-y-1 p-2 pt-0">

        {/* HEX 发送 + 回车换行：两个独立 CheckRow 并列保持视觉一致 */}
        <div className="grid grid-cols-2 gap-x-2">
          <CheckRow
            label="HEX 发送"
            checked={sendHex}
            onCheckedChange={setSendHex}
            disabled={!running}
            title="以十六进制格式发送"
          />
          <CheckRow
            label="回车换行"
            checked={sendNewline}
            onCheckedChange={setSendNewline}
            disabled={!running || sendHex}
            title="发送时追加换行符"
          />
        </div>

        {/* 定时发送：第 1 行复选框 + 文字；第 2 行常驻间隔配置 */}
        <CheckRow
          label="定时发送"
          checked={sendTiming}
          onCheckedChange={setSendTiming}
          disabled={!running}
          title="按间隔自动发送输入栏内容"
        />
        <ConfigSubRow disabled={!sendTiming || !running}>
          <span className="text-[10px] text-muted-foreground">间隔</span>
          <Input
            type="number"
            min={10}
            max={60000}
            value={sendTimingInterval}
            onChange={(e) => setSendTimingInterval(Number(e.target.value))}
            disabled={!sendTiming || !running}
            className="h-5 w-16 text-[11px] font-mono"
            title="定时发送间隔（ms）"
          />
          <span className="text-[10px] text-muted-foreground">ms</span>
        </ConfigSubRow>

        {/* 校验：第 1 行复选框 + 文字；第 2 行类型选择；第 3 行字节范围 */}
        <CheckRow
          label="加校验"
          checked={sendChecksum}
          onCheckedChange={setSendChecksum}
          disabled={!running}
          title="附加校验值到数据末尾"
        />
        <ConfigSubRow disabled={!sendChecksum || !running}>
          <span className="text-[10px] text-muted-foreground">类型</span>
          <Select value={sendChecksumType} onValueChange={(v) => setSendChecksumType(v as ChecksumType)}>
            <SelectTrigger className="h-5 flex-1 text-[11px] px-1.5" title="校验类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHECKSUM_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ConfigSubRow>
        {/* 校验范围：第 3 行起始字节下拉；第 4 行结束字节下拉 */}
        <ConfigSubRow disabled={!sendChecksum || !running}>
          <span className="text-[10px] text-muted-foreground">起始</span>
          <Select
            value={String(sendChecksumStart)}
            onValueChange={(v) => setSendChecksumStart(Number(v))}
          >
            <SelectTrigger className="h-5 flex-1 text-[11px] px-1.5" title="校验起始字节">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHECKSUM_START_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ConfigSubRow>
        <ConfigSubRow disabled={!sendChecksum || !running}>
          <span className="text-[10px] text-muted-foreground">结束</span>
          <Select
            value={String(sendChecksumEnd)}
            onValueChange={(v) => setSendChecksumEnd(Number(v))}
          >
            <SelectTrigger className="h-5 flex-1 text-[11px] px-1.5" title="校验结束字节">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHECKSUM_END_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ConfigSubRow>

        {/* 发送文件：高度统一 h-7 */}
        <SendFileButton uid={uid} running={running} getSendChannel={getSendChannel} />

        {/* 多字符串：高度统一 h-7 */}
        <Button variant="outline" size="sm" onClick={onOpenMultiString} disabled={!running} className="w-full justify-start text-[11px] h-7" title="多字符串管理">
          <ListChecks className="mr-1.5 h-3 w-3" />
          多字符串
        </Button>
        </div>
      </div>

      <SaveFormatDialog open={showSaveDialog} onOpenChange={setShowSaveDialog} onConfirm={handleSave} dataSize={dataSize} />
    </div>
  )
}
