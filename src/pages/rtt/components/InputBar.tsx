import { useState, useCallback, useRef, useEffect } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useRttStore } from '@/stores/rtt.store'
import { rttService } from '@/services/rtt.service'
import { computeChecksumWithRange, type ChecksumType } from '@/utils/checksum'

interface InputBarProps {
  uid: string | null
  running: boolean
}

/**
 * 发送数据预处理：把文本/hex 字符串解析为字节数组，并按发送配置追加换行+校验
 */
function preprocessSend(
  text: string,
  opts: {
    hex: boolean
    newline: boolean
    checksum: boolean
    checksumType: ChecksumType
    checksumStart: number
    checksumEnd: number
  },
): Uint8Array | { error: string } {
  let data: Uint8Array
  if (opts.hex) {
    const hexStr = text.replace(/\s+/g, '').replace(/0x/gi, '')
    if (hexStr.length % 2 !== 0) return { error: '十六进制数据长度必须为偶数' }
    if (!/^[0-9a-fA-F]*$/.test(hexStr)) return { error: '十六进制数据包含非法字符' }
    data = new Uint8Array(hexStr.length / 2)
    for (let i = 0; i < hexStr.length; i += 2) {
      data[i / 2] = parseInt(hexStr.substring(i, i + 2), 16)
    }
  } else {
    data = new TextEncoder().encode(text)
    if (opts.newline) {
      const nl = new TextEncoder().encode('\n')
      const withNl = new Uint8Array(data.length + nl.length)
      withNl.set(data, 0)
      withNl.set(nl, data.length)
      data = withNl
    }
  }
  if (opts.checksum) {
    const cks = computeChecksumWithRange(
      data, opts.checksumType, opts.checksumStart, opts.checksumEnd,
    )
    const withCks = new Uint8Array(data.length + cks.length)
    withCks.set(data, 0)
    withCks.set(cks, data.length)
    data = withCks
  }
  return data
}

export function InputBar({ uid, running }: InputBarProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 发送配置（订阅 store，store 负责持久化）
  const sendHex = useRttStore((s) => s.sendHex)
  const sendNewline = useRttStore((s) => s.sendNewline)
  const sendTiming = useRttStore((s) => s.sendTiming)
  const sendTimingInterval = useRttStore((s) => s.sendTimingInterval)
  const sendChecksum = useRttStore((s) => s.sendChecksum)
  const sendChecksumType = useRttStore((s) => s.sendChecksumType)
  const sendChecksumStart = useRttStore((s) => s.sendChecksumStart)
  const sendChecksumEnd = useRttStore((s) => s.sendChecksumEnd)

  const selectedDownChannel = useRttStore((s) => s.selectedDownChannel)
  const setSelectedDownChannel = useRttStore((s) => s.setSelectedDownChannel)
  const downChannels = useRttStore((s) => s.downChannels)
  const addBytesSent = useRttStore((s) => s.addBytesSent)
  const setError = useRttStore((s) => s.setError)

  // 当前激活的 Tab（决定发送目标通道）
  const activeTab = useRttStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const sendChannel = activeTab?.mode === 'single' && activeTab.channel !== undefined
    ? activeTab.channel
    : selectedDownChannel

  const hasDownChannel = downChannels.length > 0
  const canSend = uid && running && hasDownChannel && !sending && text.length > 0

  const handleSend = useCallback(async () => {
    if (!uid || !canSend) return
    setSending(true)
    setError(null)
    try {
      const result = preprocessSend(text, {
        hex: sendHex,
        newline: sendNewline,
        checksum: sendChecksum,
        checksumType: sendChecksumType,
        checksumStart: sendChecksumStart,
        checksumEnd: sendChecksumEnd,
      })
      if (result instanceof Uint8Array) {
        const r = await rttService.send(uid, result, sendChannel)
        if (r.success) {
          addBytesSent(r.bytes_written)
          // hex/定时模式不清空文本，方便重复发送；普通文本模式清空
          if (!sendHex && !sendTiming) setText('')
        } else {
          setError(r.error || '发送失败')
        }
      } else {
        setError(result.error)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [uid, canSend, text, sendHex, sendNewline, sendChecksum, sendChecksumType, sendChecksumStart, sendChecksumEnd, sendChannel, sendTiming, addBytesSent, setError])

  // 定时发送：开启时按间隔自动触发
  useEffect(() => {
    const timerId = window.setInterval(() => {
      if (sendTiming && running && text.length > 0) {
        void handleSend()
      }
    }, sendTimingInterval)
    return () => clearInterval(timerId)
  }, [sendTiming, sendTimingInterval, running, text, handleSend])

  // Enter 发送（定时模式禁用，避免冲突）
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (sendTiming) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }, [handleSend, sendTiming])

  // 运行时自动聚焦输入框
  useEffect(() => {
    if (running) {
      inputRef.current?.focus()
    }
  }, [running])

  const showChannelSelector = activeTab?.mode === 'all'

  return (
    <div className="flex items-center gap-2 border-t border-border bg-background px-3 py-2">
      {/* Down Channel 选择器（仅 All Channel Tab 显示）：缩小尺寸 */}
      {showChannelSelector && hasDownChannel && (
        <Select
          value={String(selectedDownChannel)}
          onValueChange={(v) => setSelectedDownChannel(Number(v))}
          disabled={!running}
        >
          <SelectTrigger className="h-8 w-[90px] text-[11px]" title="选择发送目标 Down Channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {downChannels.map((ch) => (
              <SelectItem key={ch.index} value={String(ch.index)} className="text-xs">
                Ch{ch.index}{ch.name ? ` - ${ch.name}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* 单通道 Tab 显示发送目标（只读） */}
      {!showChannelSelector && activeTab?.mode === 'single' && (
        <div className="flex h-8 items-center rounded-md border border-border px-2 text-[11px] text-muted-foreground" title="发送目标通道（由当前 Tab 决定）">
          → Ch{sendChannel}
        </div>
      )}

      {/* 输入框 */}
      <Input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={!running || !hasDownChannel}
        placeholder={
          !running
            ? 'RTT 会话未启动'
            : !hasDownChannel
            ? '无下行通道'
            : sendHex
            ? '输入十六进制数据，如 41 42 43 或 0x41 0x42'
            : '输入要发送的文本...'
        }
        className={cn(
          'h-9 flex-1 font-mono text-sm',
          sendHex && 'tracking-wider'
        )}
      />

      {/* 发送按钮 */}
      <Button
        onClick={handleSend}
        disabled={!canSend || sendTiming}
        size="sm"
        className="h-9 px-4"
        title={sendTiming ? '定时发送中（手动发送已禁用）' : '发送（Enter）'}
      >
        <Send className="mr-1.5 h-3.5 w-3.5" />
        发送
      </Button>
    </div>
  )
}
