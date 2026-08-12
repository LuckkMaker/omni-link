import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, Plus, Trash2, RefreshCw, Loader2, AlertCircle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { zoneReadMemory } from '@/services/zone.service'
import { useZoneStore } from '../store'
import { useSessionReady } from '../hooks'

interface WatchPanelProps {
  uid: string | null
  connected: boolean
}

interface WatchItem {
  id: number
  expr: string
  kind: 'register' | 'address' | 'invalid'
  value: string | null
  error?: string
}

const REG_NAMES = new Set([
  'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12',
  'sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'primask', 'basepri',
  'faultmask', 'basepri_max', 'ipsr', 'splim', 'fpscr', 'apsr',
])

function classify(expr: string): 'register' | 'address' | 'invalid' {
  const t = expr.trim().toLowerCase()
  if (REG_NAMES.has(t)) return 'register'
  if (/^0x[0-9a-f]+$/i.test(t)) return 'address'
  return 'invalid'
}

let nextId = 1

/**
 * 底部 Watch tab：观察寄存器或内存地址。
 * 目标暂停时自动刷新；支持手动刷新与增删。
 */
export function WatchPanel({ uid, connected }: WatchPanelProps) {
  const state = useZoneStore((s) => s.state)
  const pc = useZoneStore((s) => s.pc)
  const { ready } = useSessionReady(uid, connected)

  const [items, setItems] = useState<WatchItem[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addItem = useCallback(() => {
    const expr = input.trim()
    if (!expr) return
    const kind = classify(expr)
    setItems((prev) => [...prev, { id: nextId++, expr, kind, value: null }])
    setInput('')
  }, [input])

  const removeItem = useCallback((id: number) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }, [])

  const refresh = useCallback(async () => {
    if (!ready || !uid) return
    setLoading(true)
    try {
      // 一次性读取全部寄存器
      let regMap: Map<string, number> = new Map()
      try {
        const { execCommand } = await import('@/services/commander.service')
        const result = await execCommand(uid, 'reg')
        const out = result.output || ''
        const map = new Map<string, number>()
        for (const line of out.split('\n')) {
          const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/)
          if (!m) continue
          const name = m[1].toLowerCase()
          if (!REG_NAMES.has(name)) continue
          let value: number
          try {
            value = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10)
          } catch {
            continue
          }
          map.set(name, value)
        }
        regMap = map
      } catch {
        // 忽略寄存器整批读取失败
      }

      const updated = await Promise.all(
        items.map(async (item) => {
          if (item.kind === 'register') {
            const v = regMap.get(item.expr.trim().toLowerCase())
            return { ...item, value: v !== undefined ? `0x${v.toString(16).toUpperCase()}` : '—', error: undefined }
          }
          if (item.kind === 'address') {
            try {
              const addr = parseInt(item.expr.trim(), 16)
              const res = await zoneReadMemory(uid, addr & ~0x3, 4)
              if (res.success) {
                const buf = Buffer.from(res.data_hex, 'hex')
                const v = buf.readUInt32LE(0)
                return { ...item, value: `0x${v.toString(16).toUpperCase().padStart(8, '0')}`, error: undefined }
              }
              return { ...item, value: '—', error: '读取失败' }
            } catch (e) {
              return { ...item, value: '—', error: e instanceof Error ? e.message : '读取失败' }
            }
          }
          return item
        })
      )
      setItems(updated)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }, [ready, items])

  // 暂停/单步时自动刷新
  const lastState = useRef(state)
  const lastPc = useRef(pc)
  useEffect(() => {
    if (!ready) return
    if (state === 'halted') {
      const stateChanged = lastState.current !== 'halted'
      const pcChanged = lastPc.current !== pc
      if (stateChanged || pcChanged) void refresh()
    }
    lastState.current = state
    lastPc.current = pc
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state, pc])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1">
        <Eye className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">观察</span>
        <button
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent"
          onClick={() => void refresh()}
          disabled={!ready}
          title="刷新"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 输入行 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addItem()
          }}
          placeholder="寄存器名或 0x 地址，Enter 添加"
          className="h-7 text-xs"
        />
        <Button variant="outline" size="sm" className="h-7 shrink-0 px-2" onClick={addItem} title="添加">
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!ready ? (
          <div className="min-h-0 flex-1" />
        ) : error ? (
          <Empty text={error} isError />
        ) : items.length === 0 ? (
          <Empty text="添加寄存器或内存地址进行观察" />
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1 font-medium">表达式</th>
                <th className="px-2 py-1 text-right font-medium">值</th>
                <th className="w-8 px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="px-2 py-1 font-mono text-xs">
                    {item.expr}
                    {item.kind === 'invalid' && (
                      <span className="ml-1.5 text-[10px] text-amber-600">无效</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-xs text-primary">
                    {item.error ? <span className="text-[10px] text-red-500">{item.error}</span> : item.value ?? '—'}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-red-500"
                      onClick={() => removeItem(item.id)}
                      title="删除"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Empty({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <div
      className={
        isError
          ? 'flex h-full items-center justify-center gap-2 p-4 text-red-500'
          : 'flex h-full items-center justify-center p-4 text-center text-muted-foreground'
      }
    >
      {isError ? <AlertCircle className="size-4 shrink-0" /> : null}
      <span className="max-w-md truncate">{text}</span>
    </div>
  )
}