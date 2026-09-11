import { useEffect, useState, useCallback, useRef } from 'react'
import { Loader2, AlertCircle, Cpu, Blocks, Binary, ChevronRight, ChevronDown, X, Plus, Columns2, Settings2 } from 'lucide-react'
import { useZoneStore, type InspectorTabId } from '../store'
import { useSessionReady, useAutoRefresh } from '../hooks'
import * as zoneService from '@/services/zone.service'
import type { Peripheral, PeripheralRegister, PeripheralField, CoreRegister } from '@/services/zone.service'
import { cn } from '@/lib/utils'
import { DisasmView } from './DisasmView'
import { CorePeripheralsPanel } from './CorePeripheralsPanel'

interface InspectorDockProps {
  uid: string | null
  connected: boolean
}

// ── 右侧纵向 tab 按钮（垂直列表：图标 + 完整标签横向排列） ──
function RailTab({
  active,
  onClick,
  icon: Icon,
  label,
  title,
}: {
  active: boolean
  onClick: () => void
  icon: React.ElementType
  label: string
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      className={cn(
        'flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left text-xs transition-colors',
        active
          ? 'border-primary bg-primary/10 font-medium text-primary'
          : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

/** 右侧检查器 dock：寄存器 / 外设 手风琴（多选展开） */
export function InspectorDock({ uid, connected }: InspectorDockProps) {
  // 手风琴：可多选展开，共享显示空间，折叠项固定在底部（默认只展开反汇编，Registers 默认折叠）
  const [expanded, setExpanded] = useState<InspectorTabId[]>(['disasm'])
  const toggle = useCallback((id: InspectorTabId) => {
    setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const sections = [
    { id: 'disasm' as InspectorTabId, label: 'Disassembly', icon: Binary, content: <DisasmView uid={uid} connected={connected} /> },
    { id: 'registers' as InspectorTabId, label: 'Registers', icon: Cpu, content: <RegistersPanel uid={uid} connected={connected} /> },
    { id: 'coreperipheral' as InspectorTabId, label: 'Core Peripherals', icon: Settings2, content: <CorePeripheralsPanel uid={uid} connected={connected} /> },
    { id: 'peripherals' as InspectorTabId, label: 'Peripherals', icon: Blocks, content: <PeripheralsPanel uid={uid} connected={connected} /> },
  ]
  const expandedSections = new Set(expanded)

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* 每个 section 只挂载一次：折叠/展开仅通过 CSS(order + hidden) 切换显示，
          避免在两个容器间搬移导致 React 重建组件实例、丢失面板状态（如外设展开态/寄存器值） */}
      {sections.map((s) => {
        const isExpanded = expandedSections.has(s.id)
        return (
          <div
            key={s.id}
            className={cn(
              'flex flex-col',
              isExpanded ? 'min-h-0 flex-1 order-0' : 'shrink-0 order-1'
            )}
          >
            <RailTab
              active={isExpanded}
              onClick={() => toggle(s.id)}
              icon={s.icon}
              label={s.label}
              title={s.label}
            />
            <div
              className={cn(
                'min-h-0 overflow-hidden border-t border-border',
                isExpanded ? 'flex-1' : 'hidden'
              )}
            >
              {s.content}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 十六进制格式化（32 位） */
function fmtHex(v: number): string {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/** 从寄存器值提取位域当前值（参考 vscode-peripheral-inspector 的字段值解码） */
function decodeFieldValue(value: number, field: PeripheralField): number {
  const mask = field.bit_width >= 32 ? 0xffffffff : (1 << field.bit_width) - 1
  return (value >> field.bit_offset) & mask
}

/** 十六进制地址（0xXXXX_XXXX 下划线分隔，与 Flash HexViewer 的 formatHexAddr 一致） */
function formatHexAddr(addr: number): string {
  const hex = (addr >>> 0).toString(16).toUpperCase().padStart(8, '0')
  return `0x${hex.slice(0, 4)}_${hex.slice(4)}`
}

// 寄存器分组定义（顺序即展示顺序，参考 Keil 分组）
const REGISTER_GROUPS = [
  { id: 'core', label: 'Core', description: '通用寄存器与程序状态' },
  { id: 'banked', label: 'Banked', description: '双堆栈指针' },
  { id: 'system', label: 'System', description: '系统控制与屏蔽' },
  { id: 'fpu', label: 'FPU', description: '浮点状态' },
]

// ── 寄存器面板（CPU Core：Name / Value / Description） ──────────
function RegistersPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const { ready } = useSessionReady(uid, connected)
  // 核心寄存器运行中不可读：运行中不刷新（保留上次值），暂停时（halt 事件/周期）才刷新
  const state = useZoneStore((s) => s.state)
  const [registers, setRegisters] = useState<CoreRegister[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 值变化（与上次刷新对比）的寄存器名集合（黑字 + 背景高亮，与 Call Stack / Peripherals 一致）
  const [changed, setChanged] = useState<Set<string>>(() => new Set())
  // 上次各寄存器值文本快照（name -> hex 文本）
  const prevTextsRef = useRef<Map<string, string>>(new Map())
  // 刷新序号：latest-wins，丢弃过期响应（快速连点 Run 时乱序返回）
  const refreshSeqRef = useRef(0)
  // 分组折叠状态（参考 Peripherals 面板手风琴；默认展开 Core，其余折叠）
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(['core']))
  const toggleGroup = useCallback((g: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    if (!ready || !uid) {
      setRegisters([])
      setError(null)
      return
    }
    const seq = ++refreshSeqRef.current
    setLoading(true)
    try {
      const res = await zoneService.zoneCoreRegisters(uid)
      if (seq !== refreshSeqRef.current) return
      if (res.success) {
        setRegisters(res.registers)
        setError(null)
        // 对比本次与上次的值文本，标记值发生变化的寄存器
        const curr = new Map<string, string>()
        res.registers.forEach((r) => curr.set(r.name, r.value !== undefined ? fmtHex(r.value) : ''))
        const prev = prevTextsRef.current
        const changedPaths = new Set<string>()
        curr.forEach((text, name) => {
          if (prev.has(name) && prev.get(name) !== text) changedPaths.add(name)
        })
        setChanged(changedPaths)
        prevTextsRef.current = curr
      }
    } catch (e) {
      if (seq !== refreshSeqRef.current) return
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false)
    }
  }, [ready, uid])

  // 寄存器仅暂停时可读；periodicEnabled: false —— 不参与周期刷新，仅随调试操作在 halt 状态更新
  useAutoRefresh(uid, connected, ready, refresh, {
    canRefresh: () => state === 'halted',
    periodicEnabled: false,
  })

  useEffect(() => {
    if (ready) void refresh()
  }, [ready, refresh])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!ready ? (
        <div className="min-h-0 flex-1" />
      ) : loading && registers.length === 0 ? (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          读取中...
        </div>
      ) : error ? (
        <Empty text={error} isError />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* 列表头（三列网格，居左显示，底部边框 + 列间纵向边框） */}
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-[10px] font-medium text-muted-foreground">
            <span className="px-2 py-1 text-left">Name</span>
            <span className="border-l border-border px-2 py-1 text-left">Value</span>
            <span className="border-l border-border px-2 py-1 text-left">Description</span>
          </div>
          {REGISTER_GROUPS.map((g) => {
            const groupRegs = registers.filter((r) => r.group === g.id)
            const open = expandedGroups.has(g.id)
            return (
              <div key={g.id}>
                <GroupRow
                  open={open}
                  onToggle={() => toggleGroup(g.id)}
                  name={g.label}
                  count={groupRegs.length}
                  description={g.description}
                />
                {open &&
                  groupRegs.map((r) => (
                    <div key={r.name} className="grid grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-xs hover:bg-muted/30">
                      <span className="min-w-0 truncate py-1 pl-6 pr-2 font-mono">{r.name}</span>
                      <span
                        className={cn(
                          'min-w-0 truncate border-l border-border px-2 py-1 font-mono',
                          changed.has(r.name) ? 'bg-yellow-400/30 text-foreground' : 'text-primary'
                        )}
                      >
                        {fmtHex(r.value)}
                      </span>
                      <span className="min-w-0 truncate border-l border-border px-2 py-1 text-muted-foreground" title={r.description}>{r.description}</span>
                    </div>
                  ))}
              </div>
            )
          })}
          {registers.length === 0 && (
            <div className="px-2 py-4 text-center text-muted-foreground">暂无数据</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 外设面板（外设 → 寄存器 → 位域 三级折叠：Name / Value / Description） ──
function PeripheralsPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const { ready } = useSessionReady(uid, connected)
  const [peripherals, setPeripherals] = useState<Peripheral[]>([])
  const [expandedPeriph, setExpandedPeriph] = useState<Set<string>>(new Set())
  const [expandedReg, setExpandedReg] = useState<Set<string>>(new Set())
  const [regValues, setRegValues] = useState<Map<number, number>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 值变化（与上次刷新对比）的寄存器地址集合（黑字 + 背景高亮）
  const [changedAddrs, setChangedAddrs] = useState<Set<number>>(() => new Set())
  // 上次各地址值快照（address -> value）
  const prevRegValuesRef = useRef<Map<number, number>>(new Map())
  // 位域值变化（与上次对比）的字段 key 集合（address:fieldName，仅变化的位域高亮）
  const [changedFields, setChangedFields] = useState<Set<string>>(() => new Set())
  // 上次各字段值快照（address:fieldName -> field value）
  const prevFieldsRef = useRef<Map<string, number>>(new Map())
  // 刷新序号：latest-wins，丢弃过期响应（快速连点 Run 时乱序返回）
  const refreshSeqRef = useRef(0)

  // 始终引用最新展开状态，供 refreshValues 按需读取（避免 useCallback 闭包过期）
  const expandedPeriphRef = useRef(expandedPeriph)
  expandedPeriphRef.current = expandedPeriph

  const refreshValues = useCallback(async () => {
    if (!ready || !uid) return
    // 只收集当前展开外设的寄存器地址（对齐 Keil 按需读取，避免全量刷新）
    const names = expandedPeriphRef.current
    if (names.size === 0) return
    const allRegs: PeripheralRegister[] = []
    for (const p of peripherals) {
      if (names.has(p.name)) allRegs.push(...(p.registers ?? []))
    }
    const addrs = allRegs.map((r) => r.address)
    if (addrs.length === 0) return
    const seq = ++refreshSeqRef.current
    try {
      const res = await zoneService.zoneReadRegisters(uid, addrs)
      // 已发起更新的刷新（res 过期）：丢弃本次结果，避免旧数据覆盖新数据
      if (seq !== refreshSeqRef.current) return
      if (res.success) {
        const map = new Map<number, number>()
        for (const v of res.values) map.set(v.address, v.value)
        // 对比本次与上次的值，标记值发生变化的寄存器地址
        const prev = prevRegValuesRef.current
        const changedSet = new Set<number>()
        map.forEach((val, addr) => {
          if (prev.has(addr) && prev.get(addr) !== val) changedSet.add(addr)
        })
        setChangedAddrs(changedSet)
        prevRegValuesRef.current = map
        setRegValues(map)
        // 按位域对比，仅标记值发生变化的位域（而非整个寄存器）
        const prevFields = prevFieldsRef.current
        const changedF = new Set<string>()
        for (const reg of allRegs) {
          const regVal = map.get(reg.address)
          if (regVal === undefined) continue
          for (const f of reg.fields ?? []) {
            const fv = decodeFieldValue(regVal, f)
            const fkey = `${reg.address}:${f.name}`
            if (prevFields.has(fkey) && prevFields.get(fkey) !== fv) changedF.add(fkey)
            prevFields.set(fkey, fv)
          }
        }
        setChangedFields(changedF)
      }
    } catch {
      // 忽略
    }
  }, [ready, uid, peripherals])

  const refreshPeripherals = useCallback(async () => {
    // 会话未就绪时不请求后端，避免 No ELF loaded 的 400 报错
    if (!ready || !uid) {
      setPeripherals([])
      setRegValues(new Map())
      setExpandedPeriph(new Set())
      setExpandedReg(new Set())
      setError(null)
      return
    }
    setLoading(true)
    try {
      const res = await zoneService.zonePeripherals(uid)
      if (res.success) {
        setPeripherals(res.peripherals)
        setError(null)
      }
    } catch (e) {
      // 优先展示后端 FastAPI 返回的 detail，便于定位真实原因
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : e instanceof Error ? e.message : '读取外设失败')
    } finally {
      setLoading(false)
    }
  }, [ready, uid])

  useAutoRefresh(uid, connected, ready, refreshValues)

  useEffect(() => {
    void refreshPeripherals()
  }, [refreshPeripherals])

  // 外设加载完成 / 展开状态变化时，读取当前展开外设的寄存器值（按需、分组）；halt/单步由 useAutoRefresh 刷新
  useEffect(() => {
    if (ready && peripherals.length > 0) void refreshValues()
  }, [ready, peripherals, expandedPeriph, refreshValues])

  const togglePeriph = useCallback((name: string) => {
    setExpandedPeriph((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])
  const toggleReg = useCallback((key: string) => {
    setExpandedReg((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!ready ? (
        <div className="min-h-0 flex-1" />
      ) : loading && peripherals.length === 0 ? (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          读取中...
        </div>
      ) : error ? (
        <Empty text={error} isError />
      ) : peripherals.length === 0 ? (
        <Empty text="无外设" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* 列表头（与 Registers 一致：三列网格，居左显示，底部边框 + 列间纵向边框） */}
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-[10px] font-medium text-muted-foreground">
            <span className="px-2 py-1 text-left">Name</span>
            <span className="border-l border-border px-2 py-1 text-left">Value</span>
            <span className="border-l border-border px-2 py-1 text-left">Description</span>
          </div>
          {peripherals.map((p) => {
            const periphOpen = expandedPeriph.has(p.name)
            return (
              <div key={p.name}>
                <PeriphRow
                  open={periphOpen}
                  onToggle={() => togglePeriph(p.name)}
                  name={p.name}
                  value={p.base_address !== undefined ? fmtHex(p.base_address) : ''}
                  description={p.description}
                />
                {periphOpen &&
                  (p.registers ?? []).map((reg) => {
                    const regKey = `${p.name}:${reg.address}`
                    const regOpen = expandedReg.has(regKey)
                    return (
                      <div key={regKey}>
                        <RegisterRow
                          open={regOpen}
                          onToggle={() => toggleReg(regKey)}
                          reg={reg}
                          value={regValues.get(reg.address)}
                          changed={changedAddrs.has(reg.address)}
                        />
                        {regOpen &&
                          (reg.fields ?? []).map((f) => {
                            const regVal = regValues.get(reg.address)
                            const fv = regVal !== undefined ? decodeFieldValue(regVal, f) : undefined
                            return (
                              <FieldRow
                                  key={`${regKey}:${f.name}`}
                                  field={f}
                                  value={fv}
                                  changed={changedFields.has(`${reg.address}:${f.name}`)}
                                />
                            )
                          })}
                      </div>
                    )
                  })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function GroupRow({ open, onToggle, name, count, description }: {
  open: boolean; onToggle: () => void; name: string; count: number; description?: string
}) {
  return (
    <button onClick={onToggle} className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-left text-xs hover:bg-muted/30">
      <span className="flex min-w-0 items-center gap-1 px-2 py-1">
        <ChevronDownGlyph open={open} />
        <span className="truncate font-medium text-primary">{name}</span>
      </span>
      <span className="min-w-0 truncate border-l border-border px-2 py-1 font-mono text-muted-foreground">{count}</span>
      <span className="min-w-0 truncate border-l border-border px-2 py-1 text-[10px] text-muted-foreground" title={description}>{description}</span>
    </button>
  )
}

function PeriphRow({ open, onToggle, name, value, description }: {
  open: boolean; onToggle: () => void; name: string; value: string; description?: string
}) {
  return (
    <button onClick={onToggle} className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-left text-xs hover:bg-muted/30">
      <span className="flex min-w-0 items-center gap-1 px-2 py-1">
        <ChevronDownGlyph open={open} />
        <span className="truncate font-medium text-primary">{name}</span>
      </span>
      <span className="min-w-0 truncate border-l border-border px-2 py-1 font-mono text-muted-foreground">{value}</span>
      <span className="min-w-0 truncate border-l border-border px-2 py-1 text-[10px] text-muted-foreground" title={description}>{description}</span>
    </button>
  )
}

function RegisterRow({ open, onToggle, reg, value, changed }: {
  open: boolean; onToggle: () => void; reg: PeripheralRegister; value: number | undefined; changed?: boolean
}) {
  const hasFields = (reg.fields ?? []).length > 0
  return (
    <button
      onClick={onToggle}
      disabled={!hasFields}
      className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-left text-xs hover:bg-muted/30"
    >
      <span className="flex min-w-0 items-center gap-1 py-1 pl-6 pr-2">
        {hasFields ? <ChevronDownGlyph open={open} /> : <span className="size-3.5 shrink-0" />}
        <span className="truncate font-mono text-foreground">{reg.name}</span>
      </span>
      <span className={cn('min-w-0 truncate border-l border-border px-2 py-1 font-mono', changed ? 'bg-yellow-400/30 text-foreground' : 'text-primary')}>
        {value !== undefined ? fmtHex(value) : '—'}
      </span>
      <span className="min-w-0 truncate border-l border-border px-2 py-1 text-[10px] text-muted-foreground" title={reg.description}>
        {reg.description || `0x${reg.offset.toString(16).toUpperCase()}`}
      </span>
    </button>
  )
}

function FieldRow({ field, value, changed }: { field: PeripheralField; value: number | undefined; changed?: boolean }) {
  const bitDesc = field.bit_width === 1
    ? `bit ${field.bit_offset}`
    : `bits [${field.bit_offset + field.bit_width - 1}:${field.bit_offset}]`
  // 匹配枚举值（参考 vscode-peripheral-inspector：位域值显示枚举名义）
  const enumMatch = value !== undefined
    ? field.values.find((v) => (v.value >>> 0) === (value >>> 0))
    : undefined
  const valueText = value !== undefined
    ? (enumMatch ? `${enumMatch.name} (${fmtHex(value)})` : fmtHex(value))
    : '—'
  return (
    <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-left text-xs hover:bg-muted/30">
      <span className="min-w-0 truncate py-0.5 pl-12 pr-2 font-mono text-muted-foreground" title={bitDesc}>
        {field.name}
      </span>
      <span className={cn('min-w-0 truncate border-l border-border px-2 py-0.5 font-mono', changed ? 'bg-yellow-400/30 text-foreground' : 'text-primary')} title={bitDesc}>
        {valueText}
      </span>
      <span className="min-w-0 truncate border-l border-border px-2 py-0.5 text-[10px] text-muted-foreground/70" title={field.description}>
        {field.description || bitDesc}
      </span>
    </div>
  )
}

function ChevronDownGlyph({ open }: { open: boolean }) {
  return open
    ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
    : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
}

// ── 内存窗口视图（单窗口：工具栏 + Hex 内容，供单栏/分栏复用） ──
interface MemoryWindowViewProps {
  uid: string | null
  connected: boolean
  windowId: string
  /** 分栏模式：顶部显示窗口选择器 */
  showSelector?: boolean
  onSelectWindow?: (id: string) => void
}

function MemoryWindowView({ uid, connected, windowId, showSelector, onSelectWindow }: MemoryWindowViewProps) {
  const { ready } = useSessionReady(uid, connected)
  const memoryWindows = useZoneStore((s) => s.memoryWindows)
  const updateMemoryWindow = useZoneStore((s) => s.updateMemoryWindow)
  const win = memoryWindows.find((w) => w.id === windowId)

  const byteWidth = win?.byteWidth ?? 1
  const bigEndian = win?.bigEndian ?? false

  // 地址输入框（纯 hex，本地编辑，回车提交）
  const [addrInput, setAddrInput] = useState(win?.address ?? '0x20000000')
  // 变量输入框（符号 / &var / var[下标]，回车解析并跳转）
  const [varInput, setVarInput] = useState('')
  const [rows, setRows] = useState<{ address: number; bytes: number[]; ascii: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 值变化（与上次刷新对比）的字节偏移集合（窗口内 0-255，黑字 + 背景高亮）
  const [changedBytes, setChangedBytes] = useState<Set<number>>(() => new Set())
  // 上次读取的字节快照与基地址（地址变化时重置，避免整窗误标红）
  const prevBytesRef = useRef<Uint8Array | null>(null)
  const prevBaseRef = useRef<number | null>(null)
  // 刷新序号：latest-wins——快速连点 Run 时多次异步读内存乱序返回，
  // 只有最后一次的响应才允许落地，丢弃过期响应避免旧数据覆盖新数据
  const refreshSeqRef = useRef(0)
  // skipped 重试计数：halt 后多面板并发刷新竞争后端协调锁，内存读取可能被跳过，
  // 延迟重试确保最终拿到最新数据（上限 3 次，避免持续争用时无限重试）
  const retryCountRef = useRef(0)

  // 切换窗口时同步输入框
  useEffect(() => {
    setAddrInput(win?.address ?? '0x20000000')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId])

  const refresh = useCallback(async () => {
    if (!ready || !uid || !win) {
      setRows([])
      setError(null)
      return
    }
    const seq = ++refreshSeqRef.current
    setLoading(true)
    try {
      const addr = parseInt(win.address, 16)
      if (isNaN(addr)) throw new Error('无效地址')
      const res = await zoneService.zoneReadMemory(uid, addr & ~0xf, 256)
      // 已发起更新的刷新（res 过期）：丢弃本次结果，避免旧数据覆盖新数据
      if (seq !== refreshSeqRef.current) return
      if (res.success) {
        // 调试操作进行中（后端协调锁被占用）：延迟重试，避免 halt 后刷新被跳过
        // 导致面板保持旧数据"不跟手"；重试上限 3 次，成功或超限即停止
        if (res.skipped) {
          if (retryCountRef.current < 3) {
            retryCountRef.current += 1
            const retrySeq = seq
            setTimeout(() => {
              // 期间已有新刷新发起（地址/窗口变化或手动刷新）：放弃重试，避免旧数据覆盖新数据
              if (refreshSeqRef.current !== retrySeq) return
              void refresh()
            }, 120)
          }
          return
        }
        retryCountRef.current = 0
        // 浏览器环境无 Buffer，手动解析十六进制字符串为字节数组
        const hex = res.data_hex
        const bytes = new Uint8Array(hex.length / 2)
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
        }
        // 对比本次与上次（同基地址）的字节，标记变化位置（高亮）
        const base = res.address
        const changedSet = new Set<number>()
        const prevBytes = prevBytesRef.current
        if (prevBaseRef.current === base && prevBytes) {
          for (let i = 0; i < bytes.length; i++) {
            if (prevBytes[i] !== bytes[i]) changedSet.add(i)
          }
        }
        setChangedBytes(changedSet)
        prevBaseRef.current = base
        prevBytesRef.current = bytes
        const bpr = 16 // 每行固定 16 字节，组粒度由 groupSize 控制
        const newRows: { address: number; bytes: number[]; ascii: string }[] = []
        for (let i = 0; i < bytes.length; i += bpr) {
          const chunk = Array.from(bytes.slice(i, i + bpr))
          newRows.push({
            address: (res.address + i) & ~0xf,
            bytes: chunk,
            ascii: chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''),
          })
        }
        setRows(newRows)
        setError(null)
      }
    } catch (e) {
      if (seq !== refreshSeqRef.current) return
      setError(e instanceof Error ? e.message : '读取内存失败')
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false)
    }
  }, [ready, uid, win])

  // periodicEnabled: false —— 内存不参与周期刷新，仅随调试操作在 halt 状态更新（地址/窗口变化仍手动刷新）
  useAutoRefresh(uid, connected, ready, refresh, { periodicEnabled: false })

  // 手动刷新（含地址变化）
  useEffect(() => {
    if (ready) void refresh()
  }, [ready, refresh])

  // 地址输入：仅接受纯 hex
  const handleAddrEnter = useCallback(() => {
    if (!uid || !win) return
    const expr = addrInput.trim()
    if (!expr) return
    if (/^(?:0x)?[0-9a-fA-F]{1,8}$/.test(expr)) {
      const hex = expr.startsWith('0x') ? expr : '0x' + expr
      updateMemoryWindow(win.id, { address: hex })
      setAddrInput(hex)
    } else {
      setError('地址仅支持十六进制（如 20000000 / 0x20000000）')
    }
  }, [uid, addrInput, win, updateMemoryWindow])

  // 变量输入：解析符号/表达式并跳转到其地址
  const handleVarEnter = useCallback(async () => {
    if (!uid || !win) return
    const expr = varInput.trim()
    if (!expr) return
    try {
      const res = await zoneService.zoneResolveMemoryAddress(uid, expr)
      if (res.address != null) {
        const hex = '0x' + res.address.toString(16).toUpperCase()
        updateMemoryWindow(win.id, { address: hex })
        setAddrInput(hex)
        setVarInput('')
        setError(null)
      } else {
        setError(res.error || '无法解析变量地址')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析变量地址失败')
    }
  }, [uid, varInput, win, updateMemoryWindow])

  const readLength = rows.length * 16
  const startAddr = rows.length > 0 ? rows[0].address : NaN

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 分栏模式：窗口选择器 */}
      {showSelector && onSelectWindow && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          <Columns2 className="size-3 shrink-0 text-muted-foreground" />
          <select
            value={windowId}
            onChange={(e) => onSelectWindow(e.target.value)}
            className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 font-mono text-xs"
          >
            {memoryWindows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 工具栏（字节宽度 + 端序 + 地址跳转 + 变量跳转 + 刷新 + 右侧信息） */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        {/* 字节宽度切换 */}
        <div className="flex items-center rounded border border-border">
          {([1, 2, 4] as const).map((w) => (
            <button
              key={w}
              onClick={() => updateMemoryWindow(win?.id ?? '', { byteWidth: w })}
              className={cn(
                'px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                byteWidth === w
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {w}B
            </button>
          ))}
        </div>

        {/* 端序切换 */}
        <div className="flex items-center rounded border border-border">
          {[{ v: false, l: 'LE' }, { v: true, l: 'BE' }].map((o) => (
            <button
              key={o.l}
              onClick={() => updateMemoryWindow(win?.id ?? '', { bigEndian: o.v })}
              className={cn(
                'px-2 py-0.5 text-[11px] font-medium transition-colors',
                bigEndian === o.v
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {o.l}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-border mx-0.5" />

        {/* 地址跳转（纯 hex） */}
        <div className="flex items-center h-6 rounded-md border border-border overflow-hidden">
          <span className="flex items-center px-1.5 h-full text-xs font-mono text-muted-foreground bg-muted/50 border-r border-border">0x</span>
          <input
            value={addrInput.startsWith('0x') ? addrInput.slice(2) : addrInput}
            onChange={(e) => setAddrInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddrEnter() }}
            placeholder="20000000"
            spellCheck={false}
            autoComplete="off"
            className="h-6 w-24 bg-transparent px-1.5 font-mono text-xs outline-none"
          />
        </div>

        {/* 变量跳转（解析符号/表达式） */}
        <div className="flex items-center h-6 rounded-md border border-border overflow-hidden">
          <span className="flex items-center px-1.5 h-full text-xs text-muted-foreground bg-muted/50 border-r border-border">变量</span>
          <input
            value={varInput}
            onChange={(e) => setVarInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleVarEnter() }}
            placeholder="buf[0] / &var"
            spellCheck={false}
            autoComplete="off"
            className="h-6 w-28 bg-transparent px-1.5 font-mono text-xs outline-none"
          />
        </div>

        <button
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void refresh()}
          disabled={!ready}
          title="刷新"
        >
          <RefreshGlyph spinning={loading} />
        </button>

        <div className="h-5 w-px bg-border mx-0.5" />

        {/* 右侧信息：地址范围 */}
        <div className="ml-auto text-[11px] text-muted-foreground">
          {!isNaN(startAddr) ? `${formatHexAddr(startAddr)} · ${readLength} B` : '—'}
        </div>
      </div>

      {/* Hex 内容区（地址 0xXXXX_XXXX | 按字分组 Hex | ASCII） */}
      <div className="min-h-0 flex-1 overflow-auto bg-background font-mono text-xs leading-5">
        {!ready ? (
          <div className="min-h-0 flex-1" />
        ) : error ? (
          <Empty text={error} isError />
        ) : (
          rows.map((row, ri) => {
            return (
              <div key={row.address} className="flex gap-3 px-2 py-0.5 hover:bg-muted/30">
                <span className="shrink-0 text-muted-foreground">{formatHexAddr(row.address)}</span>
                {/* 按 byteWidth 分组，组内每个字节独立 span，值与上次对比变化的字节高亮 */}
                <span className="shrink-0 flex items-center">
                  {row.bytes.map((b, bi) => {
                    const offset = ri * 16 + bi
                    const isWordStart = bi % byteWidth === 0
                    const is8Midpoint = bi === 8
                    return (
                      <span key={bi} className="flex items-center">
                        {isWordStart && bi > 0 && <span className={is8Midpoint ? 'w-[1.5ch]' : 'w-[0.5ch]'} />}
                        <span className={changedBytes.has(offset) ? 'rounded bg-yellow-400/30 font-bold text-foreground' : ''}>
                          {b.toString(16).padStart(2, '0').toUpperCase()}
                        </span>
                      </span>
                    )
                  })}
                </span>
                <span className="text-muted-foreground flex items-center">
                  {row.ascii.split('').map((ch, i) => {
                    const offset = ri * 16 + i
                    return (
                      <span key={i} className={cn('w-[1ch] text-center', changedBytes.has(offset) && 'bg-yellow-400/30 font-bold text-foreground')}>{ch}</span>
                    )
                  })}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── 内存面板（底部 tab 使用；导出以便被 Zone 底部 tab 复用） ──
const MAX_MEMORY_WINDOWS = 4

export function MemoryPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const memoryWindows = useZoneStore((s) => s.memoryWindows)
  const activeMemoryWindow = useZoneStore((s) => s.activeMemoryWindow)
  const addMemoryWindow = useZoneStore((s) => s.addMemoryWindow)
  const closeMemoryWindow = useZoneStore((s) => s.closeMemoryWindow)
  const selectMemoryWindow = useZoneStore((s) => s.selectMemoryWindow)

  // ── 分栏对比 ──
  const [split, setSplit] = useState(false)
  const [leftWinId, setLeftWinId] = useState(activeMemoryWindow)
  const [rightWinId, setRightWinId] = useState<string | null>(null)

  // 分栏有效 id（窗口被关闭时自动回退）
  const validLeftId = memoryWindows.some((w) => w.id === leftWinId) ? leftWinId : activeMemoryWindow
  const validRightId =
    rightWinId && memoryWindows.some((w) => w.id === rightWinId) && rightWinId !== validLeftId
      ? rightWinId
      : (memoryWindows.find((w) => w.id !== validLeftId)?.id ?? null)

  const toggleSplit = useCallback(() => {
    if (split) {
      setSplit(false)
    } else {
      setLeftWinId(activeMemoryWindow)
      const others = memoryWindows.filter((w) => w.id !== activeMemoryWindow)
      setRightWinId(others[0]?.id ?? null)
      setSplit(true)
    }
  }, [split, activeMemoryWindow, memoryWindows])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 窗口 tab 栏：多窗口切换 + 新建 + 关闭 + 分栏开关（单栏模式显示） */}
      {!split && (
        <div className="flex shrink-0 items-center border-b border-border">
          {memoryWindows.map((w) => {
            const isActive = w.id === activeMemoryWindow
            return (
              <div
                key={w.id}
                className={cn(
                  'group/tab flex items-center gap-1 border-r border-border px-2 py-1 text-xs',
                  isActive ? 'bg-muted/40 text-foreground' : 'text-muted-foreground hover:bg-muted/20'
                )}
              >
                <button
                  onClick={() => selectMemoryWindow(w.id)}
                  className="font-mono"
                  title={`${w.name} · ${w.address}`}
                >
                  {w.name}
                </button>
                {memoryWindows.length > 1 && (
                  <button
                    onClick={() => closeMemoryWindow(w.id)}
                    className="flex opacity-0 transition-opacity group-hover/tab:opacity-100 hover:text-red-500"
                    title="关闭窗口"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            )
          })}
          {memoryWindows.length < MAX_MEMORY_WINDOWS && (
            <button
              onClick={() => addMemoryWindow()}
              className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/20 hover:text-foreground"
              title={`新建窗口（上限 ${MAX_MEMORY_WINDOWS}）`}
            >
              <Plus className="size-3.5" />
            </button>
          )}
          <button
            className={cn(
              'ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/20 hover:text-foreground',
              memoryWindows.length < 2 && 'cursor-not-allowed opacity-40'
            )}
            onClick={toggleSplit}
            disabled={memoryWindows.length < 2}
            title={memoryWindows.length < 2 ? '需要至少 2 个窗口才能分栏对比' : '分栏对比查看'}
          >
            <Columns2 className="size-3.5" />
            分栏
          </button>
        </div>
      )}

      {/* 分栏模式：顶部栏 + 退出分栏 */}
      {split && (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1">
          <span className="text-[11px] text-muted-foreground">分栏对比</span>
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            onClick={toggleSplit}
            title="退出分栏"
          >
            <Columns2 className="size-3.5" />
          </button>
        </div>
      )}

      {/* 内容区：单栏或分栏 */}
      <div className="min-h-0 flex-1">
        {split ? (
          <div className="flex h-full min-h-0">
            <div className="flex min-w-0 flex-1 flex-col border-r border-border">
              <MemoryWindowView
                uid={uid}
                connected={connected}
                windowId={validLeftId}
                showSelector
                onSelectWindow={setLeftWinId}
              />
            </div>
            {validRightId && (
              <div className="flex min-w-0 flex-1 flex-col">
                <MemoryWindowView
                  uid={uid}
                  connected={connected}
                  windowId={validRightId}
                  showSelector
                  onSelectWindow={setRightWinId}
                />
              </div>
            )}
          </div>
        ) : (
          <MemoryWindowView uid={uid} connected={connected} windowId={activeMemoryWindow} />
        )}
      </div>
    </div>
  )
}

function RefreshGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg className={`size-3.5 ${spinning ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

function Empty({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <div className={`flex h-full items-center justify-center p-4 text-center text-xs ${isError ? 'text-red-500' : 'text-muted-foreground'}`}>
      {isError ? <AlertCircle className="mr-1.5 size-3.5" /> : null}
      {text}
    </div>
  )
}