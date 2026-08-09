import { useEffect, useRef, useState, useCallback } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { useZoneStore } from '../store'
import * as zoneService from '@/services/zone.service'
import type { DisasmInstruction } from '@/services/zone.service'

interface DisasmViewProps {
  uid: string | null
  connected: boolean
}

/** 反汇编操作数语法高亮：寄存器（绿）、立即数 #0x/#n（橙），其余保持默认 */
function highlightOperand(op: string) {
  const upper = op.toUpperCase()
  const parts = upper.split(/(#0X[0-9A-F]+|#\d+|\b(?:R\d{1,2}|SP|LR|PC)\b)/g).filter((p) => p !== '')
  return parts.map((p, i) => {
    if (/^#/.test(p)) return <span key={i} className="text-orange-500">{p}</span>
    if (/\b(?:R\d{1,2}|SP|LR|PC)\b/.test(p)) return <span key={i} className="text-emerald-600">{p}</span>
    return <span key={i}>{p}</span>
  })
}

/** 反汇编视图：地址 + 指令 + 符号标注，PC 高亮（与源码窗口一致的箭头 + 行高亮 + 自动滚动） */
export function DisasmView({ uid, connected }: DisasmViewProps) {
  const pc = useZoneStore((s) => s.pc)
  const state = useZoneStore((s) => s.state)
  const disasmAvailable = useZoneStore((s) => s.disasmAvailable)
  const elfPath = useZoneStore((s) => s.elfPath)

  const [instructions, setInstructions] = useState<DisasmInstruction[]>([])
  const [baseAddress, setBaseAddress] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const loadDisasm = useCallback(
    async (addr: number) => {
      if (!uid) return
      setLoading(true)
      setError(null)
      try {
        const res = await zoneService.zoneDisasm(uid, addr, 64, 32)
        if (res.success) {
          setInstructions(res.instructions)
          setBaseAddress(res.address)
        } else {
          setError('反汇编失败')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '反汇编失败')
      } finally {
        setLoading(false)
      }
    },
    [uid]
  )

  // 初始：无 ELF 时显示提示；有 ELF 时从 PC 或默认地址反汇编
  useEffect(() => {
    if (!elfPath) {
      setInstructions([])
      setBaseAddress(null)
      return
    }
    const startAddr = pc ?? 0x08000000
    if (pc !== null && pc !== undefined) {
      const inRange =
        baseAddress !== null &&
        pc >= baseAddress &&
        pc < baseAddress + instructions.reduce((acc, i) => acc + i.size, 0)
      if (!inRange) {
        void loadDisasm(pc)
        return
      }
    }
    if (baseAddress === null) {
      void loadDisasm(startAddr)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elfPath, pc, state])

  // PC 指令行滚动到容器中央（双重 rAF，布局稳定后滚动）
  useEffect(() => {
    if (pc === null || pc === undefined) return
    const container = containerRef.current
    const el = lineRefs.current.get(pc)
    if (!container || !el) return
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const lineH = eRect.height || 16
    const target = container.scrollTop + (eRect.top - cRect.top) - cRect.height / 2 + lineH / 2
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.scrollTo({ top: Math.max(0, target), behavior: 'auto' })
      })
    })
  }, [instructions, pc])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-relaxed"
      >
        {!connected ? (
          <div className="min-h-0 flex-1" />
        ) : !elfPath ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            请先加载 ELF 文件
          </div>
        ) : !disasmAvailable ? (
          <div className="flex h-full items-center justify-center gap-2 text-amber-600">
            <AlertCircle className="size-4" />
            <span>Capstone 未安装，无法反汇编</span>
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            反汇编中...
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center gap-2 text-red-500">
            <AlertCircle className="size-4" />
            <span className="max-w-md truncate">{error}</span>
          </div>
        ) : instructions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            无指令
          </div>
        ) : (
          instructions.map((ins) => {
            const isPc = ins.address === pc
            return (
              <div
                key={ins.address}
                ref={(el) => {
                  if (el) lineRefs.current.set(ins.address, el)
                  else lineRefs.current.delete(ins.address)
                }}
                className={
                  isPc
                    ? 'flex border-b border-primary/20 bg-primary/10'
                    : 'flex border-b border-transparent hover:bg-muted/30'
                }
              >
                {/* 断点槽/PC 标记列（与源码窗口一致） */}
                <div className="sticky left-0 flex w-10 shrink-0 select-none items-center justify-center bg-background">
                  <span className={isPc ? 'font-bold leading-none text-primary' : 'text-transparent'}>
                    ▶
                  </span>
                </div>
                <span className={isPc ? 'w-24 shrink-0 font-bold text-primary' : 'w-24 shrink-0 text-muted-foreground'}>
                  {ins.address.toString(16).toUpperCase().padStart(8, '0')}
                </span>
                <span className="w-20 shrink-0 text-muted-foreground/70">{ins.bytes.toUpperCase()}</span>
                <span className="w-16 shrink-0 font-medium text-sky-600">{ins.mnemonic.toUpperCase()}</span>
                <span className="flex-1 pr-4">{highlightOperand(ins.op_str)}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}