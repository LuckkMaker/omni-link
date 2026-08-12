import { useEffect, useState, useCallback, useRef } from 'react'
import { Loader2, AlertCircle, Cpu, Blocks, Binary, Share2, ChevronRight, ChevronDown, X, Plus } from 'lucide-react'
import { useZoneStore, type InspectorTabId } from '../store'
import { useSessionReady } from '../hooks'
import * as zoneService from '@/services/zone.service'
import type { Peripheral, PeripheralRegister, PeripheralField, CoreRegister } from '@/services/zone.service'
import { cn } from '@/lib/utils'
import { DisasmView } from './DisasmView'
import { CallGraphPanel } from './CallGraphPanel'

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
    { id: 'callgraph' as InspectorTabId, label: 'Call Graph', icon: Share2, content: <CallGraphPanel uid={uid} connected={connected} /> },
    { id: 'registers' as InspectorTabId, label: 'Registers', icon: Cpu, content: <RegistersPanel uid={uid} connected={connected} /> },
    { id: 'peripherals' as InspectorTabId, label: 'Peripherals', icon: Blocks, content: <PeripheralsPanel uid={uid} connected={connected} /> },
  ]
  const expandedSections = sections.filter((s) => expanded.includes(s.id))
  const collapsedSections = sections.filter((s) => !expanded.includes(s.id))

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* 展开的 section：header + 内容（共享剩余高度） */}
      {expandedSections.map((s) => (
        <div key={s.id} className="flex min-h-0 flex-1 flex-col">
          <RailTab active onClick={() => toggle(s.id)} icon={s.icon} label={s.label} title={s.label} />
          <div className="min-h-0 flex-1 overflow-hidden border-t border-border">{s.content}</div>
        </div>
      ))}
      {/* 折叠的 section 固定在底部；content 保持挂载（会话启动后预取数据），仅 CSS 隐藏不占空间 */}
      <div className="mt-auto flex shrink-0 flex-col">
        {collapsedSections.map((s) => (
          <div key={s.id} className="flex flex-col">
            <RailTab active={false} onClick={() => toggle(s.id)} icon={s.icon} label={s.label} title={s.label} />
            <div className="hidden">{s.content}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 通用刷新触发器：根据状态与刷新策略决定是否自动刷新 ──
function useAutoRefresh(uid: string | null, connected: boolean, ready: boolean, refresh: () => void) {
  const state = useZoneStore((s) => s.state)
  const pc = useZoneStore((s) => s.pc)
  const refreshMode = useZoneStore((s) => s.refreshMode)
  const lastState = useRef(state)
  const lastPc = useRef(pc)

  useEffect(() => {
    // 会话未就绪（未连接 / 未加载 ELF / 未启动调试会话）时不自动轮询
    if (!uid || !connected || !ready) return

    // On Stop：halt 时刷新；step 时状态保持 halted 但 PC 变化，据此再次刷新
    if (refreshMode === 'on_stop') {
      if (state === 'halted') {
        const stateChanged = lastState.current !== 'halted'
        const pcChanged = lastPc.current !== pc
        if (stateChanged || pcChanged) {
          refresh()
        }
      }
      lastState.current = state
      lastPc.current = pc
      return
    }

    // Periodic：定时刷新
    if (refreshMode === 'periodic_always' || refreshMode === 'periodic_running') {
      const shouldRun =
        refreshMode === 'periodic_always' || state === 'running'
      if (!shouldRun) return
      const timer = setInterval(refresh, 2000)
      return () => clearInterval(timer)
    }
    // off：不自动刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, connected, ready, state, pc, refreshMode, refresh])
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

/** 按字组装十六进制（参考 Flash HexViewer 的 readLeU16/readLeU32 + wordToHex） */
function wordHex(bytes: number[], width: 1 | 2 | 4, bigEndian: boolean): string {
  let val = 0
  if (bigEndian) {
    for (let i = 0; i < width; i++) val = (val << 8) | (bytes[i] & 0xff)
  } else {
    for (let i = width - 1; i >= 0; i--) val = (val << 8) | (bytes[i] & 0xff)
  }
  return (val >>> 0).toString(16).toUpperCase().padStart(width * 2, '0')
}



// ── 寄存器面板（CPU Core：Name / Value / Description） ──────────
function RegistersPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const { ready } = useSessionReady(uid, connected)
  const [registers, setRegisters] = useState<CoreRegister[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!ready || !uid) {
      setRegisters([])
      setError(null)
      return
    }
    setLoading(true)
    try {
      const res = await zoneService.zoneCoreRegisters(uid)
      if (res.success) {
        setRegisters(res.registers)
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }, [ready, uid])

  useAutoRefresh(uid, connected, ready, refresh)

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
          {registers.map((r) => (
            <div key={r.name} className="grid grid-cols-[minmax(0,1fr)_minmax(80px,0.7fr)_minmax(0,1fr)] border-b border-border text-xs hover:bg-muted/30">
              <span className="min-w-0 truncate px-2 py-1 font-mono">{r.name}</span>
              <span className="min-w-0 truncate border-l border-border px-2 py-1 font-mono text-primary">{fmtHex(r.value)}</span>
              <span className="min-w-0 truncate border-l border-border px-2 py-1 text-muted-foreground" title={r.description}>{r.description}</span>
            </div>
          ))}
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
    try {
      const res = await zoneService.zoneReadRegisters(uid, addrs)
      if (res.success) {
        const map = new Map<number, number>()
        for (const v of res.values) map.set(v.address, v.value)
        setRegValues(map)
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
        // 默认展开第一个外设
        if (res.peripherals.length > 0) {
          setExpandedPeriph((prev) => (prev.size > 0 ? prev : new Set([res.peripherals[0].name])))
        }
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
                        />
                        {regOpen &&
                          (reg.fields ?? []).map((f) => {
                            const regVal = regValues.get(reg.address)
                            const fv = regVal !== undefined ? decodeFieldValue(regVal, f) : undefined
                            return (
                              <FieldRow key={`${regKey}:${f.name}`} field={f} value={fv} />
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

function RegisterRow({ open, onToggle, reg, value }: {
  open: boolean; onToggle: () => void; reg: PeripheralRegister; value: number | undefined
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
      <span className="min-w-0 truncate border-l border-border px-2 py-1 font-mono text-primary">
        {value !== undefined ? fmtHex(value) : '—'}
      </span>
      <span className="min-w-0 truncate border-l border-border px-2 py-1 text-[10px] text-muted-foreground" title={reg.description}>
        {reg.description || `0x${reg.offset.toString(16).toUpperCase()}`}
      </span>
    </button>
  )
}

function FieldRow({ field, value }: { field: PeripheralField; value: number | undefined }) {
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
      <span className="min-w-0 truncate border-l border-border px-2 py-0.5 font-mono text-primary" title={bitDesc}>
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

// ── 内存面板（底部 tab 使用；导出以便被 Zone 底部 tab 复用） ──
export function MemoryPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const { ready } = useSessionReady(uid, connected)
  const memoryWindows = useZoneStore((s) => s.memoryWindows)
  const activeMemoryWindow = useZoneStore((s) => s.activeMemoryWindow)
  const addMemoryWindow = useZoneStore((s) => s.addMemoryWindow)
  const closeMemoryWindow = useZoneStore((s) => s.closeMemoryWindow)
  const selectMemoryWindow = useZoneStore((s) => s.selectMemoryWindow)
  const updateMemoryWindow = useZoneStore((s) => s.updateMemoryWindow)

  // 激活窗口（数据源：宽度/端序/格式/地址均来自窗口）
  const active = memoryWindows.find((w) => w.id === activeMemoryWindow) ?? memoryWindows[0]
  const byteWidth = active?.byteWidth ?? 1
  const bigEndian = active?.bigEndian ?? false

  // 地址输入框（本地编辑，回车提交；允许 hex / 符号 / &var / var[下标]）
  const [addrInput, setAddrInput] = useState(active?.address ?? '0x20000000')
  const [rows, setRows] = useState<{ address: number; bytes: number[]; ascii: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 切换窗口时同步输入框
  useEffect(() => {
    setAddrInput(active?.address ?? '0x20000000')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMemoryWindow])

  const refresh = useCallback(async () => {
    if (!ready || !uid) {
      setRows([])
      setError(null)
      return
    }
    setLoading(true)
    try {
      const addr = parseInt(active.address, 16)
      if (isNaN(addr)) throw new Error('无效地址')
      const res = await zoneService.zoneReadMemory(uid, addr & ~0xf, 256)
      if (res.success) {
        // 浏览器环境无 Buffer，手动解析十六进制字符串为字节数组
        const hex = res.data_hex
        const bytes = new Uint8Array(hex.length / 2)
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
        }
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
      setError(e instanceof Error ? e.message : '读取内存失败')
    } finally {
      setLoading(false)
    }
  }, [ready, uid, active.address])

  useAutoRefresh(uid, connected, ready, refresh)

  // 手动刷新（含地址变化）
  useEffect(() => {
    if (ready) void refresh()
  }, [ready, refresh])

  // 回车解析地址表达式（纯 hex 直接提交；符号/&var/var[下标] 走后端解析）
  const handleAddrEnter = useCallback(async () => {
    if (!uid) return
    const expr = addrInput.trim()
    if (!expr) return
    if (/^(?:0x)?[0-9a-fA-F]{1,8}$/.test(expr)) {
      const hex = expr.startsWith('0x') ? expr : '0x' + expr
      updateMemoryWindow(active.id, { address: hex })
      setAddrInput(hex)
      return
    }
    try {
      const res = await zoneService.zoneResolveMemoryAddress(uid, expr)
      if (res.address != null) {
        const hex = '0x' + res.address.toString(16).toUpperCase()
        updateMemoryWindow(active.id, { address: hex })
        setAddrInput(hex)
      } else {
        setError(res.error || '无法解析地址')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析地址失败')
    }
  }, [uid, addrInput, active.id, updateMemoryWindow])

  const readLength = rows.length * 16
  const startAddr = rows.length > 0 ? rows[0].address : NaN

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 窗口 tab 栏：多窗口切换 + 新建 + 关闭（至少保留一个） */}
      <div className="flex shrink-0 items-center border-b border-border">
        {memoryWindows.map((w) => {
          const isActive = w.id === active.id
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
                title={w.address}
              >
                {w.address}
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
        <button
          onClick={() => addMemoryWindow()}
          className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/20 hover:text-foreground"
          title="新建窗口（复制当前设置）"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {/* 工具栏（参考 Flash FilePanel：字节宽度分段 + 端序 + 格式 + 地址跳转 + 右侧信息） */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        {/* 字节宽度切换 */}
        <div className="flex items-center rounded border border-border">
          {([1, 2, 4] as const).map((w) => (
            <button
              key={w}
              onClick={() => updateMemoryWindow(active.id, { byteWidth: w })}
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
              onClick={() => updateMemoryWindow(active.id, { bigEndian: o.v })}
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

        {/* 地址跳转 — 支持 hex / 符号 / &var / var[下标] */}
        <div className="flex items-center h-6 rounded-md border border-border overflow-hidden">
          <span className="flex items-center px-1.5 h-full text-xs font-mono text-muted-foreground bg-muted/50 border-r border-border">0x</span>
          <input
            value={addrInput.startsWith('0x') ? addrInput.slice(2) : addrInput}
            onChange={(e) => setAddrInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAddrEnter() }}
            placeholder="20000000 / buf[0]"
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

      {/* Hex 内容区（参考 Flash HexViewer：地址 0xXXXX_XXXX | 按字分组 Hex | ASCII） */}
      <div className="min-h-0 flex-1 overflow-auto bg-background font-mono text-xs leading-5">
        {!ready ? (
          <div className="min-h-0 flex-1" />
        ) : error ? (
          <Empty text={error} isError />
        ) : (
          rows.map((row) => {
            // 按 byteWidth 切成等宽字（16 字节一行 → 1B:16 字 / 2B:8 字 / 4B:4 字），固定十六进制
            const words: string[] = []
            for (let i = 0; i < row.bytes.length; i += byteWidth) {
              words.push(wordHex(row.bytes.slice(i, i + byteWidth), byteWidth, bigEndian))
            }
            return (
              <div key={row.address} className="flex gap-3 px-2 py-0.5 hover:bg-muted/30">
                <span className="shrink-0 text-muted-foreground">{formatHexAddr(row.address)}</span>
                <span className="shrink-0 flex items-center">
                  {words.map((w, wi) => {
                    // 8 字节中线处加更宽间距（与 Flash HexViewer 一致）
                    const isMidpoint = wi === 8 / byteWidth
                    return (
                      <span key={wi} className="flex items-center">
                        {wi > 0 && <span className={isMidpoint ? 'w-[1.5ch]' : 'w-[0.5ch]'} />}
                        <span>{w}</span>
                      </span>
                    )
                  })}
                </span>
                <span className="text-muted-foreground flex items-center">
                  {row.ascii.split('').map((ch, i) => (
                    <span key={i} className="w-[1ch] text-center">{ch}</span>
                  ))}
                </span>
              </div>
            )
          })
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