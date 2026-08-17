import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { useSessionReady, useAutoRefresh } from '../hooks'
import * as zoneService from '@/services/zone.service'
import type { NvicIrq, ScbRegister, ScbField } from '@/services/zone.service'
import { cn } from '@/lib/utils'

interface CorePeripheralsPanelProps {
  uid: string | null
  connected: boolean
}

/** 十六进制格式化（32 位） */
function fmtHex(v: number): string {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/** 从寄存器值提取位域当前值 */
function decodeFieldValue(value: number, field: ScbField): number {
  const mask = field.bit_width >= 32 ? 0xffffffff : (1 << field.bit_width) - 1
  return (value >> field.bit_offset) & mask
}

/**
 * Core Peripherals 面板（Keil 范式）
 *
 * 顶部为多个分组：NVIC（按中断源）+ System Control and Configuration（SCB 寄存器）。
 * 分组可独立展开/折叠；折叠只隐藏内容（order + flex），不卸载以保留状态。
 * 未就绪整块留白、不发请求。
 */
export function CorePeripheralsPanel({ uid, connected }: CorePeripheralsPanelProps) {
  const { ready } = useSessionReady(uid, connected)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!ready ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <>
          <NvicSection uid={uid} connected={connected} />
          <SystemCtrlSection uid={uid} connected={connected} />
        </>
      )}
    </div>
  )
}

// ── 分组容器辅助：展开的组 flex-1 占用剩余空间，折叠的组 shrink-0 固定在底端 ──
function GroupShell({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('flex min-h-0 flex-col', open ? 'order-0 flex-1' : 'order-1 shrink-0')}>
      {children}
    </div>
  )
}

// ── NVIC（嵌套向量中断控制器）：按中断源展示 Enable/Pending/Active/Priority ──
function NvicSection({ uid, connected }: { uid: string | null; connected: boolean }) {
  const { ready } = useSessionReady(uid, connected)

  const [expanded, setExpanded] = useState(false)
  const [irqs, setIrqs] = useState<NvicIrq[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 值变化（与上次刷新对比）的单元格 key 集合（`${number}:${kind}`，黄底黑字）
  const [changed, setChanged] = useState<Set<string>>(() => new Set())
  // 上次快照（number -> 各状态）
  const prevRef = useRef<Map<number, PrevState>>(new Map())
  // 刷新序号：latest-wins，丢弃过期响应
  const refreshSeqRef = useRef(0)
  // 写入进行中：避免连点按钮重复发请求
  const writingRef = useRef(false)
  // 刷新 in-flight 守卫：避免事件刷新与写入后的回读请求堆积
  const inflightRef = useRef(false)

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const refresh = useCallback(async () => {
    if (!ready || !uid || !expandedRef.current || inflightRef.current) return
    inflightRef.current = true
    const seq = ++refreshSeqRef.current
    setLoading(true)
    try {
      const res = await zoneService.zoneCoreNvic(uid)
      if (seq !== refreshSeqRef.current) return
      if (res.success) {
        // 运行中其他调试操作占用总线时后端返回 skipped=True：静默保留上一份快照
        if ((res as { skipped?: boolean }).skipped) {
          setError(null)
          return
        }
        setIrqs(res.interrupts)
        setError(null)
        setChanged(() => {
          const next = new Set<string>()
          const prevMap = prevRef.current
          const curr = new Map<number, PrevState>()
          for (const it of res.interrupts) {
            const ps: PrevState = { enabled: it.enabled, pending: it.pending, active: it.active, priority: it.priority }
            const old = prevMap.get(it.number)
            if (old) {
              if (old.enabled !== ps.enabled) next.add(`${it.number}:enable`)
              if (old.pending !== ps.pending) next.add(`${it.number}:pending`)
              if (old.active !== ps.active) next.add(`${it.number}:active`)
              if (old.priority !== ps.priority) next.add(`${it.number}:priority`)
            }
            curr.set(it.number, ps)
          }
          prevRef.current = curr
          return next
        })
      } else {
        setIrqs([])
        setError(
          'error' in (res as { error?: string }) ? (res as { error?: string }).error || '读取失败' : '读取失败'
        )
      }
    } catch (e) {
      if (seq !== refreshSeqRef.current) return
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false)
      inflightRef.current = false
    }
  }, [ready, uid])

  useAutoRefresh(uid, connected, ready, refresh)

  // 展开且就绪时立即读取；折叠时自动停止（refresh 内守卫，不发请求）
  useEffect(() => {
    if (ready && expanded) void refresh()
  }, [ready, expanded, refresh])

  const toggle = useCallback(() => {
    setExpanded((v) => {
      if (v) setSelected(null)
      return !v
    })
  }, [])

  const doWrite = useCallback(
    async (kind: 'enable' | 'pending', value: boolean) => {
      if (!ready || !uid || selected === null || writingRef.current) return
      writingRef.current = true
      try {
        if (kind === 'enable') await zoneService.zoneSetNvicEnable(uid, selected, value)
        else await zoneService.zoneSetNvicPending(uid, selected, value)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '操作失败')
      } finally {
        writingRef.current = false
      }
    },
    [ready, uid, selected, refresh]
  )

  const selectedIrq = irqs.find((i) => i.number === selected) ?? null

  return (
    <GroupShell open={expanded}>
      <button
        onClick={toggle}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center border-b border-border px-2 py-1 text-left text-xs hover:bg-muted/30"
      >
        <span className="flex min-w-0 items-center gap-1">
          {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="font-medium text-primary">NVIC</span>
        </span>
        <span className="truncate text-right text-[10px] text-muted-foreground">嵌套向量中断控制器</span>
      </button>

      {expanded && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            {loading && irqs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                读取中...
              </div>
            ) : error ? (
              <div className="flex flex-1 items-center justify-center px-2 text-xs text-destructive">{error}</div>
            ) : irqs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">无中断源</div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="grid grid-cols-[44px_minmax(0,1fr)_56px_56px_56px_64px] border-b border-border text-[10px] font-medium text-muted-foreground">
                  <span className="px-2 py-1 text-left">IRQ</span>
                  <span className="border-l border-border px-2 py-1 text-left">Name</span>
                  <span className="border-l border-border px-2 py-1 text-center">Enable</span>
                  <span className="border-l border-border px-2 py-1 text-center">Pending</span>
                  <span className="border-l border-border px-2 py-1 text-center">Active</span>
                  <span className="border-l border-border px-2 py-1 text-center">Priority</span>
                </div>
                {irqs.map((it) => (
                  <button
                    key={it.number}
                    onClick={() => setSelected((cur) => (cur === it.number ? null : it.number))}
                    className={cn(
                      'grid w-full grid-cols-[44px_minmax(0,1fr)_56px_56px_56px_64px] items-center border-b border-border text-xs hover:bg-muted/30',
                      selected === it.number && 'bg-primary/10'
                    )}
                  >
                    <span className="px-2 py-1 font-mono text-muted-foreground">{it.number}</span>
                    <span className={cn('min-w-0 truncate border-l border-border px-2 py-1 text-left', selected === it.number ? 'font-medium text-primary' : 'text-foreground')}>{it.name}</span>
                    <StateCell changed={changed.has(`${it.number}:enable`)} on={it.enabled} />
                    <StateCell changed={changed.has(`${it.number}:pending`)} on={it.pending} />
                    <StateCell changed={changed.has(`${it.number}:active`)} on={it.active} />
                    <span className={cn('border-l border-border px-2 py-1 text-center font-mono', changed.has(`${it.number}:priority`) ? 'bg-yellow-400/30 text-foreground' : 'text-primary')}>{it.priority}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 底部操作栏：选中中断后用复选框操作 Enable / Pending（运行态同样可写） */}
          <div className="flex min-h-0 shrink-0 items-center gap-3 border-t border-border px-2 py-1.5">
            {selectedIrq ? (
              <>
                <span className="mr-1 truncate text-[11px] text-muted-foreground">
                  <span className="font-mono text-foreground">{selectedIrq.number}</span> <span className="text-primary">{selectedIrq.name}</span>
                </span>
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={selectedIrq.enabled}
                    onChange={(e) => doWrite('enable', e.target.checked)}
                  />
                  Enable
                </label>
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={selectedIrq.pending}
                    onChange={(e) => doWrite('pending', e.target.checked)}
                  />
                  Pending
                </label>
              </>
            ) : (
              <span className="px-1 text-[11px] text-muted-foreground"></span>
            )}
          </div>
        </div>
      )}
    </GroupShell>
  )
}

interface PrevState {
  enabled: boolean
  pending: boolean
  active: boolean
  priority: number
}

/** 状态列标记：实心 = 置位（on），空心 = 未置位（off） */
function StateDot({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'inline-block size-2.5 rounded-full border',
        on ? 'border-transparent bg-primary' : 'border-current text-muted-foreground/40'
      )}
    />
  )
}

function StateCell({ changed, on }: { changed: boolean; on: boolean }) {
  return (
    <span className={cn('flex items-center justify-center border-l border-border px-2 py-1', changed && 'bg-yellow-400/30')}>
      <StateDot on={on} />
    </span>
  )
}

// ── System Control and Configuration（SCB：ICSR/VTOR/AIRCR/STIR） ──
function SystemCtrlSection({ uid, connected }: { uid: string | null; connected: boolean }) {
  const { ready } = useSessionReady(uid, connected)

  const [expanded, setExpanded] = useState(false)
  const [registers, setRegisters] = useState<ScbRegister[]>([])
  // 展开的寄存器 key 集合（寄存器地址）
  const [expandedRegs, setExpandedRegs] = useState<Set<number>>(() => new Set())
  // 展开的分组 key 集合（默认全部展开）
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 值变化的寄存器地址集合（黄底黑字）
  const [changedAddrs, setChangedAddrs] = useState<Set<number>>(() => new Set())
  // 值变化的位域 key 集合（`${address}:${field}`，仅变化位域高亮）
  const [changedFields, setChangedFields] = useState<Set<string>>(() => new Set())
  // 上次各寄存器值快照（address -> value）
  const prevValuesRef = useRef<Map<number, number>>(new Map())
  // 上次各字段值快照（address:field -> value）
  const prevFieldsRef = useRef<Map<string, number>>(new Map())
  // 刷新序号：latest-wins
  const refreshSeqRef = useRef(0)
  // 刷新 in-flight 守卫
  const inflightRef = useRef(false)
  // 写入进行中守卫
  const writingRef = useRef(false)

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const expandedRegsRef = useRef(expandedRegs)
  expandedRegsRef.current = expandedRegs

  const refresh = useCallback(async () => {
    if (!ready || !uid || !expandedRef.current || inflightRef.current) return
    inflightRef.current = true
    const seq = ++refreshSeqRef.current
    setLoading(true)
    try {
      const res = await zoneService.zoneReadScb(uid)
      if (seq !== refreshSeqRef.current) return
      if (res.success) {
        // 运行中其他调试操作占用总线时后端返回 skipped=True：静默保留上一份快照
        if (res.skipped) {
          setError(null)
          return
        }
        setRegisters(res.registers)
        setError(null)
        // 对比本次与上次的寄存器值与位域值，标记变化项
        const prevVals = prevValuesRef.current
        const prevFields = prevFieldsRef.current
        const changedA = new Set<number>()
        const changedF = new Set<string>()
        for (const reg of res.registers) {
          if (reg.value === null) continue
          if (prevVals.has(reg.address) && prevVals.get(reg.address) !== reg.value) changedA.add(reg.address)
          prevVals.set(reg.address, reg.value)
          // 仅对比已展开寄存器的位域（未展开的位域无需高亮标记切换时对比）
          if (expandedRegsRef.current.has(reg.address)) {
            for (const f of reg.fields) {
              const fv = decodeFieldValue(reg.value, f)
              const fkey = `${reg.address}:${f.name}`
              if (prevFields.has(fkey) && prevFields.get(fkey) !== fv) changedF.add(fkey)
              prevFields.set(fkey, fv)
            }
          }
        }
        setChangedAddrs(changedA)
        setChangedFields(changedF)
      } else {
        setRegisters([])
        setError('error' in (res as { error?: string }) ? (res as { error?: string }).error || '读取失败' : '读取失败')
      }
    } catch (e) {
      if (seq !== refreshSeqRef.current) return
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false)
      inflightRef.current = false
    }
  }, [ready, uid])

  useAutoRefresh(uid, connected, ready, refresh)

  // 展开且就绪时立即读取；折叠时自动停止
  useEffect(() => {
    if (ready && expanded) void refresh()
  }, [ready, expanded, refresh])

  const toggle = useCallback(() => setExpanded((v) => !v), [])
  const toggleReg = useCallback((address: number) => {
    setExpandedRegs((prev) => {
      const next = new Set(prev)
      if (next.has(address)) next.delete(address)
      else next.add(address)
      return next
    })
  }, [])
  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

  // 写可写位域（RMW，运行态可操作）：写成功后强制刷新以回读更新值与高亮
  const doFieldWrite = useCallback(
    async (address: number, field: ScbField, value: number) => {
      if (!ready || !uid || !field.access || field.access === 'ro' || writingRef.current) return
      writingRef.current = true
      try {
        await zoneService.zoneWriteScbField(uid, address, field.name, value)
        await refresh()
      } catch (e) {
        const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
        setError(typeof detail === 'string' ? detail : e instanceof Error ? e.message : '写入失败')
      } finally {
        writingRef.current = false
      }
    },
    [ready, uid, refresh]
  )

  // 按 group 字段聚合寄存器为分组（保持寄存器返回顺序），供分组折叠渲染
  const groupedRegisters = useMemo(() => {
    const groups: { key: string; label: string; desc: string; registers: ScbRegister[] }[] = []
    const byKey = new Map<string, { key: string; label: string; desc: string; registers: ScbRegister[] }>()
    for (const reg of registers) {
      const key = reg.group || reg.name
      let g = byKey.get(key)
      if (!g) {
        g = { key, label: key, desc: reg.group_desc ?? reg.description ?? '', registers: [] }
        byKey.set(key, g)
        groups.push(g)
      }
      g.registers.push(reg)
    }
    return groups
  }, [registers])

  return (
    <GroupShell open={expanded}>
      <button
        onClick={toggle}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center border-b border-border px-2 py-1 text-left text-xs hover:bg-muted/30"
      >
        <span className="flex min-w-0 items-center gap-1">
          {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="font-medium text-primary">System Control and Configuration</span>
        </span>
        <span className="truncate text-right text-[10px] text-muted-foreground">SCB 系统控制与配置</span>
      </button>

      {expanded && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            {loading && registers.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                读取中...
              </div>
            ) : error ? (
              <div className="flex flex-1 items-center justify-center px-2 text-xs text-destructive">{error}</div>
            ) : registers.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">无寄存器</div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                {groupedRegisters.map((grp) => {
                  const grpOpen = expandedGroups.has(grp.key)
                  return (
                    <div key={grp.key}>
                      <button
                        onClick={() => toggleGroup(grp.key)}
                        className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-left text-xs hover:bg-muted/30"
                      >
                        <span className="flex min-w-0 items-center gap-1 px-2 py-1">
                          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground', !grpOpen && '-rotate-90')} />
                          <span className="truncate font-medium text-primary">{grp.label}</span>
                        </span>
                        <span className="min-w-0 truncate border-l border-border px-2 py-1 font-mono text-muted-foreground">{grp.registers[0]?.name}</span>
                        <span className="min-w-0 truncate border-l border-border px-2 py-1 text-[10px] text-muted-foreground" title={grp.desc}>{grp.desc}</span>
                      </button>
                      {grpOpen &&
                        grp.registers.map((reg) => {
                          const regOpen = expandedRegs.has(reg.address)
                          return (
                            <div key={reg.address}>
                              <button
                                onClick={() => toggleReg(reg.address)}
                                className={cn(
                                  'grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-left text-xs hover:bg-muted/30',
                                  changedAddrs.has(reg.address) && 'bg-yellow-400/20'
                                )}
                              >
                                <span className="flex min-w-0 items-center gap-1 py-1 pl-3 pr-2">
                                  <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground', !regOpen && '-rotate-90')} />
                                  <span className="min-w-0 truncate font-mono text-foreground">{reg.name}{reg.write_only ? ' (W)' : ''}</span>
                                </span>
                                <span className={cn('min-w-0 truncate border-l border-border px-2 py-1 font-mono', changedAddrs.has(reg.address) ? 'bg-yellow-400/30 text-foreground' : 'text-primary')}>
                                  {reg.value !== null ? fmtHex(reg.value) : '—'}
                                </span>
                                <span className="min-w-0 truncate border-l border-border px-2 py-1 text-[10px] text-muted-foreground" title={reg.description}>{reg.description}</span>
                              </button>
                              {regOpen && (
                                <div>
                                  {reg.fields.map((f) => {
                                    const fv = reg.value !== null ? decodeFieldValue(reg.value, f) : undefined
                                    return (
                                      <FieldRow
                                        key={`${reg.address}:${f.name}`}
                                        field={f}
                                        value={fv}
                                        changed={changedFields.has(`${reg.address}:${f.name}`)}
                                        onWrite={(v) => doFieldWrite(reg.address, f, v)}
                                      />
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </GroupShell>
  )
}

function FieldRow({
  field,
  value,
  changed,
  onWrite,
}: {
  field: ScbField
  value: number | undefined
  changed?: boolean
  onWrite?: (value: number) => void
}) {
  const bitDesc = field.bit_width === 1
    ? `bit ${field.bit_offset}`
    : `bits [${field.bit_offset + field.bit_width - 1}:${field.bit_offset}]`
  // 匹配枚举值（位域值显示枚举名义）
  const enumMatch = value !== undefined && field.values
    ? field.values.find((v) => (v.value >>> 0) === (value >>> 0))
    : undefined
  const writable = field.access === 'rw' || field.access === 'w'
  const valueText = value !== undefined
    ? (enumMatch ? `${enumMatch.name} (${fmtHex(value)})` : fmtHex(value))
    : '—'

  // 只读位：按位宽显示值即可
  if (!writable || value === undefined) {
    return (
      <RowCell field={field} changed={changed}>
        <span className={cn('min-w-0 truncate font-mono', changed ? 'bg-yellow-400/30 text-foreground' : 'text-primary')} title={bitDesc}>
          {writable ? '—' : valueText}
        </span>
      </RowCell>
    )
  }

  // 可写位：单 bit 用复选框（勾选=写1，取消=写0）；有枚举用下拉；其余用数值输入
  if (field.bit_width === 1) {
    return (
      <RowCell field={field} changed={changed}>
        <label className="flex cursor-pointer items-center gap-1 px-2 py-0.5">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={!!value}
            onChange={(e) => onWrite?.(e.target.checked ? 1 : 0)}
          />
        </label>
      </RowCell>
    )
  }

  if (field.values && field.values.length > 0) {
    return (
      <RowCell field={field} changed={changed}>
        <select
          value={value >>> 0}
          onChange={(e) => onWrite?.(parseInt(e.target.value, 10))}
          className="mr-1 w-full min-w-0 rounded border border-border bg-background px-1 py-0.5 font-mono text-xs text-foreground outline-none focus:border-primary"
        >
          {field.values.map((vd) => (
            <option key={vd.value} value={vd.value >>> 0}>
              {vd.name}
            </option>
          ))}
        </select>
      </RowCell>
    )
  }

  return (
    <RowCell field={field} changed={changed}>
      <HexNumberInput field={field} value={value >>> 0} onWrite={onWrite} />
    </RowCell>
  )
}

/** 可写多 bit 位域的十六进制输入框：显示/输入均为 0x 前缀 hex，失焦提交 */
function HexNumberInput({
  field,
  value,
  onWrite,
}: {
  field: ScbField
  value: number
  onWrite?: (value: number) => void
}) {
  const [text, setText] = useState(fmtShortHex(value, field.bit_width))
  // 外部值变化（刷新回读）时同步显示
  useEffect(() => {
    setText(fmtShortHex(value, field.bit_width))
  }, [value, field.bit_width])

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
        }}
        onBlur={(e) => {
          const commit = parseHexInput(e.target.value)
          const limit = (1 << field.bit_width) - 1
          if (commit !== null && commit >= 0 && commit <= limit) {
            onWrite?.(commit)
          } else {
            setText(fmtShortHex(value, field.bit_width))
          }
        }}
        className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground outline-none focus:border-primary"
      />
    </div>
  )
}

function fmtShortHex(v: number, width: number): string {
  const digits = Math.max(1, Math.ceil(width / 4))
  return '0x' + v.toString(16).toUpperCase().padStart(digits, '0')
}

function parseHexInput(raw: string): number | null {
  const t = raw.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(t)) return null
  return parseInt(t, 16)
}

/** 位域行骨架：三列 Name / 值控件 / Description */
function RowCell({
  field,
  changed,
  children,
}: {
  field: ScbField
  changed?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={cn('grid w-full grid-cols-[minmax(0,1fr)_minmax(110px,0.7fr)_minmax(0,1fr)] border-b border-border text-left text-xs', changed && 'bg-yellow-400/15 hover:bg-yellow-400/15')}>
      <span className="min-w-0 truncate py-0.5 pl-8 pr-2 font-mono text-muted-foreground" title={`${field.name} - ${field.description || bitDesc(field)}`}>
        {field.name}
      </span>
      <span className="min-w-0 border-l border-border px-2 py-0.5 text-foreground" title={field.description || bitDesc(field)}>
        {children}
      </span>
      <span className="min-w-0 truncate border-l border-border px-2 py-0.5 text-[10px] text-muted-foreground/70" title={field.description || bitDesc(field)}>
        {field.description || bitDesc(field)}
      </span>
    </div>
  )
}

function bitDesc(field: ScbField): string {
  return field.bit_width === 1
    ? `bit ${field.bit_offset}`
    : `bits [${field.bit_offset + field.bit_width - 1}:${field.bit_offset}]`
}