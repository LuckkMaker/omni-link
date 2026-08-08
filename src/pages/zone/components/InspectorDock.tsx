import { useEffect, useState, useCallback, useRef } from 'react'
import { Loader2, RefreshCw, AlertCircle, MemoryStick, Cpu, Blocks } from 'lucide-react'
import { useZoneStore } from '../store'
import * as zoneService from '@/services/zone.service'
import type { Peripheral, PeripheralRegister } from '@/services/zone.service'

interface InspectorDockProps {
  uid: string | null
  connected: boolean
}

/** 右侧检查器 dock：寄存器 / 外设 / 内存 多 tab */
export function InspectorDock({ uid, connected }: InspectorDockProps) {
  const activeTab = useZoneStore((s) => s.activeInspectorTab)
  const setActiveTab = useZoneStore((s) => s.setActiveInspectorTab)
  const state = useZoneStore((s) => s.state)
  const refreshMode = useZoneStore((s) => s.refreshMode)

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Tab 栏 */}
      <div className="flex shrink-0 items-center border-b border-border">
        {(
          [
            { id: 'registers', label: '寄存器', icon: Cpu },
            { id: 'peripherals', label: '外设', icon: Blocks },
            { id: 'memory', label: '内存', icon: MemoryStick },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={
              activeTab === tab.id
                ? 'flex flex-1 items-center justify-center gap-1.5 border-b-2 border-primary px-2 py-2 text-xs font-medium text-primary'
                : 'flex flex-1 items-center justify-center gap-1.5 border-b-2 border-transparent px-2 py-2 text-xs text-muted-foreground hover:bg-accent'
            }
          >
            <tab.icon className="size-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'registers' && <RegistersPanel uid={uid} connected={connected} />}
        {activeTab === 'peripherals' && <PeripheralsPanel uid={uid} connected={connected} />}
        {activeTab === 'memory' && <MemoryPanel uid={uid} connected={connected} />}
      </div>
    </div>
  )
}

// ── 通用刷新触发器：根据状态与刷新策略决定是否自动刷新 ──
function useAutoRefresh(uid: string | null, connected: boolean, refresh: () => void) {
  const state = useZoneStore((s) => s.state)
  const pc = useZoneStore((s) => s.pc)
  const refreshMode = useZoneStore((s) => s.refreshMode)
  const lastState = useRef(state)
  const lastPc = useRef(pc)

  useEffect(() => {
    if (!uid || !connected) return

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
  }, [uid, connected, state, pc, refreshMode, refresh])
}

// ── 寄存器面板 ────────────────────────────
function RegistersPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const [registers, setRegisters] = useState<{ name: string; value: number }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!uid || !connected) return
    setLoading(true)
    try {
      // 读取核心寄存器：复用 commander 的 reg 命令输出
      // 这里通过 status + 简化：读取通用寄存器集
      const result = await loadCoreRegisters(uid)
      setRegisters(result)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }, [uid, connected])

  useAutoRefresh(uid, connected, refresh)

  useEffect(() => {
    if (connected) void refresh()
  }, [connected, refresh])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-border px-2 py-1">
        <span className="text-xs font-medium">核心寄存器</span>
        <button
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent"
          onClick={() => void refresh()}
          disabled={!connected}
          title="刷新"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!connected ? (
          <Empty text="未连接" />
        ) : error ? (
          <Empty text={error} isError />
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {registers.map((r) => (
                <tr key={r.name} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="px-2 py-1 font-mono text-muted-foreground">{r.name}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    0x{r.value.toString(16).toUpperCase().padStart(8, '0')}
                  </td>
                </tr>
              ))}
              {registers.length === 0 && !loading && (
                <tr><td className="px-2 py-4 text-center text-muted-foreground">暂无数据</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/** 读取核心寄存器（通过 commander 的 reg 命令） */
async function loadCoreRegisters(uid: string): Promise<{ name: string; value: number }[]> {
  const { execCommand } = await import('@/services/commander.service')
  const result = await execCommand(uid, 'reg')
  const out = result.output || ''
  const regs: { name: string; value: number }[] = []
  // 解析 "r0                 = 0x00000000" 或 "r0 = 0x0" 格式
  const lines = out.split('\n')
  const validNames = new Set([
    'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12',
    'sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'primask', 'basepri',
    'faultmask', 'basepri_max', 'ipsr', 'splim', 'fpscr', 'apsr', 'lr',
  ])
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/)
    if (!m) continue
    const name = m[1].toLowerCase()
    if (!validNames.has(name)) continue
    let value: number
    try {
      value = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10)
    } catch {
      continue
    }
    regs.push({ name: name.toUpperCase(), value })
  }
  return regs
}

// ── 外设面板 ──────────────────────────────
function PeripheralsPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const [peripherals, setPeripherals] = useState<Peripheral[]>([])
  const [selected, setSelected] = useState<Peripheral | null>(null)
  const [regValues, setRegValues] = useState<Map<number, number>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshPeripherals = useCallback(async () => {
    if (!uid || !connected) return
    setLoading(true)
    try {
      const res = await zoneService.zonePeripherals(uid)
      if (res.success) {
        setPeripherals(res.peripherals)
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取外设失败')
    } finally {
      setLoading(false)
    }
  }, [uid, connected])

  const refreshValues = useCallback(async () => {
    if (!uid || !connected || !selected) return
    // 读取选中外设所有寄存器值
    const addrs = selected.registers.map((r) => r.address)
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
  }, [uid, connected, selected])

  useAutoRefresh(uid, connected, refreshValues)

  useEffect(() => {
    if (connected) {
      void refreshPeripherals()
    } else {
      setPeripherals([])
      setSelected(null)
      setRegValues(new Map())
    }
  }, [connected, refreshPeripherals])

  useEffect(() => {
    if (selected) void refreshValues()
  }, [selected, refreshValues])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-border px-2 py-1">
        <span className="text-xs font-medium">外设</span>
        <button
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent"
          onClick={() => void refreshPeripherals()}
          disabled={!connected}
          title="刷新外设列表"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 外设树（左） */}
        <div className="w-2/5 shrink-0 overflow-auto border-r border-border">
          {!connected ? (
            <Empty text="未连接" />
          ) : error ? (
            <Empty text={error} isError />
          ) : (
            <div className="py-1">
              {peripherals.map((p) => (
                <button
                  key={p.name}
                  onClick={() => setSelected(p)}
                  className={
                    selected?.name === p.name
                      ? 'flex w-full items-center justify-between px-2 py-1 text-left text-xs font-medium text-primary'
                      : 'flex w-full items-center justify-between px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent'
                  }
                >
                  <span className="truncate">{p.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground/60">
                    0x{p.base_address.toString(16).toUpperCase()}
                  </span>
                </button>
              ))}
              {peripherals.length === 0 && !loading && (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">无外设</div>
              )}
            </div>
          )}
        </div>

        {/* 寄存器值（右） */}
        <div className="min-w-0 flex-1 overflow-auto">
          {!selected ? (
            <Empty text="选择外设查看寄存器" />
          ) : (
            <div className="py-1">
              {selected.registers.map((reg) => (
                <RegisterRow key={reg.name} reg={reg} value={regValues.get(reg.address)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RegisterRow({ reg, value }: { reg: PeripheralRegister; value: number | undefined }) {
  return (
    <div className="border-b border-border/50 px-2 py-1">
      <div className="flex items-center justify-between">
        <span className="truncate text-xs font-medium">{reg.name}</span>
        <span className="ml-2 font-mono text-xs text-primary">
          {value !== undefined
            ? '0x' + value.toString(16).toUpperCase().padStart((reg.size / 4 || 8), '0')
            : '—'}
        </span>
      </div>
      {reg.fields.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {reg.fields.map((f) => (
            <span key={f.name} className="text-[10px] text-muted-foreground">
              {f.name}[{f.bit_offset + (f.bit_width || 1) - 1}:{f.bit_offset}]
              {value !== undefined && (
                <span className="ml-1 font-mono text-foreground/80">
                  = {((value >> f.bit_offset) & ((1 << (f.bit_width || 1)) - 1)).toString(16).toUpperCase()}
                </span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 内存面板 ──────────────────────────────
function MemoryPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const memoryAddress = useZoneStore((s) => s.memoryAddress)
  const setMemoryAddress = useZoneStore((s) => s.setMemoryAddress)
  const [rows, setRows] = useState<{ address: number; bytes: number[]; ascii: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!uid || !connected) return
    setLoading(true)
    try {
      const addr = parseInt(memoryAddress, 16)
      if (isNaN(addr)) throw new Error('无效地址')
      const res = await zoneService.zoneReadMemory(uid, addr & ~0xf, 256)
      if (res.success) {
        const bytes = Buffer.from(res.data_hex, 'hex')
        const newRows: { address: number; bytes: number[]; ascii: string }[] = []
        for (let i = 0; i < bytes.length; i += 16) {
          const chunk = Array.from(bytes.slice(i, i + 16))
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
  }, [uid, connected, memoryAddress])

  useAutoRefresh(uid, connected, refresh)

  // 手动刷新（含地址变化）
  useEffect(() => {
    if (connected) void refresh()
  }, [connected, refresh])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <span className="text-xs font-medium">内存</span>
        <input
          value={memoryAddress}
          onChange={(e) => setMemoryAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void refresh() }}
          className="ml-1 w-28 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs"
          placeholder="0x20000000"
        />
        <button
          className="rounded p-1 text-muted-foreground hover:bg-accent"
          onClick={() => void refresh()}
          disabled={!connected}
          title="刷新"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-background font-mono text-xs leading-relaxed">
        {!connected ? (
          <Empty text="未连接" />
        ) : error ? (
          <Empty text={error} isError />
        ) : (
          rows.map((row) => (
            <div key={row.address} className="flex px-2 py-0.5 hover:bg-muted/30">
              <span className="w-24 shrink-0 text-muted-foreground">
                {row.address.toString(16).toUpperCase().padStart(8, '0')}
              </span>
              <span className="flex-1">
                {row.bytes.map((b, i) => (
                  <span key={i} className="mr-1.5">
                    {b.toString(16).toUpperCase().padStart(2, '0')}
                  </span>
                ))}
              </span>
              <span className="w-24 shrink-0 text-muted-foreground/60">{row.ascii}</span>
            </div>
          ))
        )}
      </div>
    </div>
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