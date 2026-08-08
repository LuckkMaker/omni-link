import { useEffect, useRef, useState, useCallback } from 'react'
import { Loader2, AlertCircle, Cpu } from 'lucide-react'
import { useZoneStore } from '../store'
import * as zoneService from '@/services/zone.service'
import type { DisasmInstruction } from '@/services/zone.service'

interface DisasmViewProps {
  uid: string | null
}

/** 反汇编视图：地址 + 指令 + 符号标注，PC 高亮 */
export function DisasmView({ uid }: DisasmViewProps) {
  const pc = useZoneStore((s) => s.pc)
  const state = useZoneStore((s) => s.state)
  const disasmAvailable = useZoneStore((s) => s.disasmAvailable)
  const elfPath = useZoneStore((s) => s.elfPath)

  const [instructions, setInstructions] = useState<DisasmInstruction[]>([])
  const [baseAddress, setBaseAddress] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pcRef = useRef<HTMLDivElement>(null)

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
    // 若 PC 变化且不在当前已加载范围内，重新加载
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

  // PC 行滚动到可见
  useEffect(() => {
    if (pc === null || pc === undefined) return
    const inList = instructions.some((i) => i.address === pc)
    if (inList) {
      requestAnimationFrame(() => {
        pcRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' })
      })
    }
  }, [instructions, pc])

  const handleUp = useCallback(async () => {
    if (baseAddress === null) return
    await loadDisasm(Math.max(0, baseAddress - 32))
  }, [baseAddress, loadDisasm])

  const handleDown = useCallback(async () => {
    if (instructions.length === 0) return
    const last = instructions[instructions.length - 1]
    await loadDisasm(last.address + last.size)
  }, [instructions, loadDisasm])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <Cpu className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">反汇编</span>
        {baseAddress !== null && (
          <span className="ml-1 font-mono text-xs text-muted-foreground">
            @ 0x{baseAddress.toString(16).toUpperCase().padStart(8, '0')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={handleUp}
            disabled={loading || !elfPath}
          >
            ↑
          </button>
          <button
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={handleDown}
            disabled={loading || !elfPath}
          >
            ↓
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-background font-mono text-xs leading-relaxed">
        {!elfPath ? (
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
                ref={isPc ? pcRef : undefined}
                className={
                  isPc
                    ? 'flex border-b border-primary/20 bg-primary/10'
                    : 'flex border-b border-transparent hover:bg-muted/30'
                }
              >
                <span className="w-10 shrink-0 select-none pl-1 text-red-500">
                  {isPc ? '▶' : ''}
                </span>
                <span className={isPc ? 'w-24 shrink-0 font-bold text-primary' : 'w-24 shrink-0 text-muted-foreground'}>
                  {ins.address.toString(16).toUpperCase().padStart(8, '0')}
                </span>
                <span className="w-20 shrink-0 text-muted-foreground/70">{ins.bytes}</span>
                <span className="w-16 shrink-0">{ins.mnemonic}</span>
                <span className="flex-1">{ins.op_str}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}