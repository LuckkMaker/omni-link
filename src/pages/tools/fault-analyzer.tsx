import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  Play,
  Eraser,
  RotateCcw,
  Square,
  ListOrdered,
  RefreshCw,
  Crosshair,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useProbeStore } from '@/stores/probe.store'
import { execCommand, type CommandResult } from '@/services/commander.service'
import { cn } from '@/lib/utils'

// ── Cortex-M 故障寄存器地址（SCB 区域）──────────────────

const FAULT_ADDRS = {
  SHCSR: 0xe000ed24, // 系统处理器控制与状态（含各 FAULTENA / ACT 位）
  CFSR: 0xe000ed28, // 可配置故障状态（MMFSR + BFSR + UFSR）
  HFSR: 0xe000ed2c, // 硬故障状态
  DFSR: 0xe000ed30, // 调试故障状态
  MMFAR: 0xe000ed34, // MemManage 故障地址
  BFAR: 0xe000ed38, // Bus 故障地址
  AFSR: 0xe000ed3c, // 辅助故障状态（厂商定义）
} as const

// ── 故障位定义 ──────────────────────────────────

interface FaultBit {
  bit: number
  name: string
  desc: string
}

const SHCSR_BITS: FaultBit[] = [
  { bit: 0, name: 'MEMFAULTACT', desc: 'MemManage 故障处理程序正在执行' },
  { bit: 1, name: 'BUSFAULTACT', desc: 'Bus 故障处理程序正在执行' },
  { bit: 2, name: 'HARDFAULTACT', desc: 'HardFault 处理程序正在执行' },
  { bit: 3, name: 'USGFAULTACT', desc: 'Usage 故障处理程序正在执行' },
  { bit: 16, name: 'MEMFAULTENA', desc: 'MemManage 故障处理程序使能' },
  { bit: 17, name: 'BUSFAULTENA', desc: 'Bus 故障处理程序使能' },
  { bit: 18, name: 'USGFAULTENA', desc: 'Usage 故障处理程序使能' },
]

const MMFSR_BITS: FaultBit[] = [
  { bit: 0, name: 'IACCVIOL', desc: '指令访问违例 — 取指时访问了 MPU 禁止的区域' },
  { bit: 1, name: 'DACCVIOL', desc: '数据访问违例 — 读写时访问了 MPU 禁止的区域' },
  { bit: 3, name: 'MUNSTKERR', desc: '异常返回出栈错误 — MemManage' },
  { bit: 4, name: 'MSTKERR', desc: '异常入栈错误 — MemManage' },
  { bit: 5, name: 'MLSPERR', desc: '浮点延迟栈错误 — MemManage' },
  { bit: 7, name: 'MMARVALID', desc: 'MMFAR 包含有效地址' },
]

const BFSR_BITS: FaultBit[] = [
  { bit: 0, name: 'IBUSERR', desc: '指令总线错误 — 取指时总线错误' },
  { bit: 1, name: 'PRECISERR', desc: '精确数据总线错误 — BFAR 包含有效地址' },
  { bit: 2, name: 'IMPRECISERR', desc: '不精确数据总线错误' },
  { bit: 3, name: 'UNSTKERR', desc: '异常返回出栈错误 — BusFault' },
  { bit: 4, name: 'STKERR', desc: '异常入栈错误 — BusFault' },
  { bit: 5, name: 'LSPERR', desc: '浮点延迟栈错误 — BusFault' },
  { bit: 7, name: 'BFARVALID', desc: 'BFAR 包含有效地址' },
]

const UFSR_BITS: FaultBit[] = [
  { bit: 0, name: 'UNDEFINSTR', desc: '未定义指令 — 执行了无效的指令编码' },
  { bit: 1, name: 'INVSTATE', desc: '无效 T 状态 — Thumb 位不正确' },
  { bit: 2, name: 'INVPC', desc: '异常返回 PC 无效 — LR 值非法' },
  { bit: 3, name: 'NOCP', desc: '协处理器不可用 — 尝试执行 FPU 指令但 FPU 未使能' },
  { bit: 4, name: 'STKOF', desc: '栈溢出 — 8 位递减栈计数器下溢 (ARMv8-M)' },
  { bit: 8, name: 'UNALIGNED', desc: '未对齐访问 — 产生了未对齐的内存访问' },
  { bit: 9, name: 'DIVBYZERO', desc: '除零错误 — 执行了 SDIV/UDIV 且除数为 0' },
]

const HFSR_BITS: FaultBit[] = [
  { bit: 1, name: 'VECTTBL', desc: '向量表读取失败 — 取异常向量时总线错误' },
  { bit: 30, name: 'FORCED', desc: '强制 HardFault — 可配置故障（MemManage/Bus/Usage）升级为 HardFault' },
  { bit: 31, name: 'DEBUGEVT', desc: '调试事件触发 — 调试器产生的 HardFault' },
]

const DFSR_BITS: FaultBit[] = [
  { bit: 0, name: 'HALTED', desc: 'NVIC 中请求的 Halt' },
  { bit: 1, name: 'BKPT', desc: '执行了 BKPT 指令' },
  { bit: 2, name: 'DWTTRAP', desc: 'DWT 匹配触发' },
  { bit: 3, name: 'VCATCH', desc: '向量捕获触发' },
  { bit: 4, name: 'EXTERNAL', desc: 'EDBGRQ 信号触发' },
]

// ── 类型 ──────────────────────────────────

interface RegState {
  shcsr: string
  cfsr: string
  hfsr: string
  dfsr: string
  mmfar: string
  bfar: string
  afsr: string
}

type StackSource = 'vc' | 'current' | 'recovered'

interface StackFrame {
  r0: string
  r1: string
  r2: string
  r3: string
  r12: string
  lr: string
  pc: string
  xpsr: string
  sp: string
  excReturn?: string
  stackUsed: 'msp' | 'psp'
  source: StackSource
}

const EMPTY_REGS: RegState = {
  shcsr: '00000000',
  cfsr: '00000000',
  hfsr: '00000000',
  dfsr: '00000000',
  mmfar: '00000000',
  bfar: '00000000',
  afsr: '00000000',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 带超时的命令执行：避免后端命令挂起时页面无限等待（execCommand 默认 timeout=0） */
const execWithTimeout = async (
  uid: string,
  command: string,
  ms = 15000
): Promise<CommandResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`命令执行超时（${ms / 1000}s）: ${command}`)),
      ms
    )
  })
  try {
    return await Promise.race([execCommand(uid, command), timeout])
  } finally {
    clearTimeout(timer)
  }
}

// ── 命令输出解析 ──────────────────────────────────

/** 从 read32 hex dump 输出中提取第一个 32 位值（兼容无 0x 与带 0x 两种格式） */
const parseRead32 = (output: string): string => {
  const m =
    output.match(/:  ([0-9a-fA-F]{8})/) ??
    output.match(/0x([0-9a-fA-F]{1,8})\b/)
  return m ? m[1].padStart(8, '0').toUpperCase() : '00000000'
}

const readMem32 = async (uid: string, addr: number): Promise<string> => {
  const result = await execWithTimeout(uid, `read32 0x${addr.toString(16)}`)
  return parseRead32(result.output)
}

/** 从 "reg xxx" 输出（如 "lr = 0xfffffffd"）提取数值；失败返回 null */
const parseReg32 = (output: string): number | null => {
  const m = output.match(/0x([0-9a-fA-F]{1,8})\b/)
  if (!m) return null
  const v = parseInt(m[1], 16)
  return Number.isNaN(v) ? null : v
}

const parseCoreState = (output: string): 'halted' | 'running' | 'unknown' => {
  if (/Halted/i.test(output)) return 'halted'
  if (/Running/i.test(output)) return 'running'
  return 'unknown'
}

// ── 异常现场恢复（栈回溯：故障已发生但未在异常入口捕获时，从栈中找回现场） ──────────────────────────────────

const toHexStr = (v: number): string => (v >>> 0).toString(16).padStart(8, '0').toUpperCase()

/** 解析 read32 addr len 批量输出的多行 hex dump（每行 4 个 32 位值，值间单空格） */
const parseRead32Block = (output: string): number[] => {
  const vals: number[] = []
  const re = /:  ([0-9a-fA-F]{8}) ([0-9a-fA-F]{8}) ([0-9a-fA-F]{8}) ([0-9a-fA-F]{8})/
  for (const line of output.split('\n')) {
    const m = line.match(re)
    if (m) {
      for (let i = 1; i <= 4; i++) vals.push(parseInt(m[i], 16))
    }
  }
  return vals
}

/** 读取地址处的 8 个异常现场字（r0-r3/r12/lr/pc/xpsr） */
const readFrameWords = async (uid: string, addr: number): Promise<number[]> => {
  const hex = await Promise.all(
    [0, 4, 8, 12, 16, 20, 24, 28].map((off) => readMem32(uid, addr + off))
  )
  return hex.map((h) => parseInt(h, 16) || 0)
}

/**
 * 判断 8 字是否为有效异常现场：
 * - xPSR.IPSR 非 0（正处在异常/中断上下文中）
 * - PC 落在代码区（0x00000000-0x1FFFFFFF）且非无效值
 * - LR 为 EXC_RETURN（0xFFFFFFFx）
 */
const isValidExceptionFrame = (w: number[]): boolean => {
  if (w.length < 8) return false
  const ipsr = w[7] & 0x1ff
  const pc = w[6]
  const lr = w[5]
  return (
    ipsr !== 0 &&
    ipsr <= 32 &&
    pc >= 0x00000000 &&
    pc <= 0x1fffffff &&
    pc !== 0xffffffff &&
    (lr >>> 28) === 0xf
  )
}

/** 从当前 SP 向上扫描栈，寻找最近的异常现场帧（故障处理程序已接管时的现场恢复） */
const scanExceptionFrame = async (
  uid: string,
  sp: number,
  maxBytes = 2048
): Promise<number | null> => {
  const BLOCK = 256 // 每次批量读 256 字节（64 字）
  const STEP = BLOCK - 32 // 块间重叠 32 字节（8 字），保证跨块帧不漏
  for (let off = 0; off < maxBytes; off += STEP) {
    let block: number[]
    try {
      const res = await execWithTimeout(
        uid,
        `read32 0x${(sp + off).toString(16)} ${BLOCK}`
      )
      block = parseRead32Block(res.output)
    } catch {
      break // 读到无效内存区域，停止扫描
    }
    if (block.length < 8) break
    for (let i = 0; i + 8 <= block.length; i += 1) {
      const win = block.slice(i, i + 8)
      if (isValidExceptionFrame(win)) {
        return sp + off + i * 4
      }
    }
  }
  return null
}

// ── reg all 输出解析（多 tab 列表化） ──────────────────────────────────

interface ParsedRegEntry {
  name: string
  value: string
  group: string
}

const REG_GROUP_HEADER = /^([a-zA-Z0-9_-]+) registers:$/
const GENERAL_REG = /^(r\d+|r1[0-5]|sp|lr|pc|xpsr)$/

/** 解析 pyocd `reg all` 列式输出（如 "  r0: 0x2000abcd  r1: 0x..."）为条目列表 */
const parseRegAll = (output: string): ParsedRegEntry[] => {
  const entries: ParsedRegEntry[] = []
  let group = 'general'
  for (const line of output.split('\n')) {
    const g = line.match(REG_GROUP_HEADER)
    if (g) {
      group = g[1].toLowerCase()
      continue
    }
    const re = /([a-zA-Z_][a-zA-Z0-9_]*):\s*(0x[0-9a-fA-F]{1,16})/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      entries.push({ name: m[1].toLowerCase(), value: m[2], group })
    }
  }
  return entries
}

const formatRegValue = (value: string): string => {
  const v = value.replace(/^0x/i, '')
  return v.length <= 8 ? v.padStart(8, '0').toUpperCase() : value.toUpperCase()
}

/** 寄存器语义说明（完整覆盖：通用 + 特殊 + FPU） */
const REG_DESC: Record<string, (v: number) => string> = {
  // 通用寄存器
  r0: () => '参数/返回值 · 通用寄存器',
  r1: () => '参数 · 通用寄存器',
  r2: () => '参数 · 通用寄存器',
  r3: () => '参数 · 通用寄存器',
  r4: () => '被调用者保存 · 通用寄存器',
  r5: () => '被调用者保存 · 通用寄存器',
  r6: () => '被调用者保存 · 通用寄存器',
  r7: () => '被调用者保存 · 通用寄存器',
  r8: () => '被调用者保存 · 通用寄存器',
  r9: () => '被调用者保存 · 通用寄存器',
  r10: () => '被调用者保存 · 通用寄存器',
  r11: () => '被调用者保存 · 通用寄存器（可选帧指针）',
  r12: () => '内部调用临时寄存器 (IP)',
  sp: () => '栈指针（MSP 或 PSP，取决于模式）',
  lr: () => '链接寄存器 · 异常入口时为 EXC_RETURN',
  pc: () => '程序计数器 · 当前指令地址',
  xpsr: (v) =>
    `N=${(v >> 31) & 1} Z=${(v >> 30) & 1} C=${(v >> 29) & 1} V=${(v >> 28) & 1} T=${(v >> 24) & 1} · IPSR=${v & 0x1ff}`,
  // 特殊寄存器
  msp: () => '主栈指针 · 复位后默认，异常处理与特权模式使用',
  psp: () => '进程栈指针 · 线程模式且 CONTROL.SPSEL=1 时使用',
  control: (v) =>
    (v & 1) === 1 ? '线程模式使用 PSP (SPSEL=1)' : '线程模式使用 MSP (SPSEL=0)',
  primask: (v) =>
    (v & 1) === 1 ? 'PRIMASK=1 · 屏蔽所有可配置优先级中断' : 'PRIMASK=0 · 未屏蔽',
  basepri: (v) => `屏蔽优先级 ≤ ${v} 的中断（0 = 不屏蔽）`,
  basepri_max: (v) => `最高可屏蔽优先级 ${v}`,
  faultmask: (v) =>
    (v & 1) === 1 ? 'FAULTMASK=1 · 屏蔽所有中断（含 NMI）' : 'FAULTMASK=0 · 未屏蔽',
}

/** 解析寄存器说明（REG_DESC 之外按名字模式匹配 FPU 等） */
const getRegDesc = (name: string, num: number): string => {
  const direct = REG_DESC[name]
  if (direct) return direct(num)
  if (/^s\d+$/.test(name)) return '单精度浮点寄存器 (FPU S0-S31)'
  if (/^d\d+$/.test(name)) return '双精度浮点寄存器 (FPU D0-D15)'
  if (/^q\d+$/.test(name)) return '128 位 SIMD/浮点寄存器 (NEON)'
  if (name.startsWith('fpc')) return '浮点协处理器控制寄存器 (FPU)'
  return '—'
}

// ── 分析结果持久化（页面切换后恢复） ──────────────────────────────────

const STORAGE_KEY = 'omni.fault-analyzer.v1'

interface PersistedState {
  regs: RegState
  stackFrame: StackFrame | null
  analyzeInfo: string | null
  ts: number
}

/** 读取上次保存的分析结果（失败返回 null，不影响正常流程） */
const readPersisted = (): PersistedState | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedState
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.regs || typeof parsed.regs !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

// ── 主组件 ──────────────────────────────────

export default function FaultAnalyzer() {
  const [initial] = useState(readPersisted)
  const [regs, setRegs] = useState<RegState>(() => initial?.regs ?? EMPTY_REGS)
  const [stackFrame, setStackFrame] = useState<StackFrame | null>(
    () => initial?.stackFrame ?? null
  )
  const [loading, setLoading] = useState(false)
  const [regOutput, setRegOutput] = useState<string | null>(null)
  const [analyzeInfo, setAnalyzeInfo] = useState<string | null>(() => {
    if (!initial) return null
    if (initial.analyzeInfo) return initial.analyzeInfo
    // 仅当确有实际数据恢复（栈帧非空或任一故障寄存器非 0）时才提示"已恢复"；
    // 清空后持久化的空状态（regs 全 0 / stackFrame null）不显示该提示
    const hasRealData =
      initial.stackFrame !== null ||
      initial.regs.cfsr !== '00000000' ||
      initial.regs.hfsr !== '00000000' ||
      initial.regs.dfsr !== '00000000'
    return hasRealData ? '已恢复上次分析结果' : null
  })

  // 分析结果变化时持久化，页面切换后自动恢复
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ regs, stackFrame, analyzeInfo, ts: Date.now() })
      )
    } catch {
      // localStorage 不可用时忽略
    }
  }, [regs, stackFrame, analyzeInfo])

  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  const parseHex = (s: string): number => {
    const cleaned = s.trim().replace(/^0x/i, '')
    return parseInt(cleaned, 16) || 0
  }

  // ── 读取当前目标状态（供 VC 捕获后与手动分析复用）──

  const readTargetState = useCallback(
    async (source: StackSource, opts?: { recover?: boolean }) => {
      // 1. 故障寄存器（硬件寄存器，随时可读）
      const [shcsr, cfsr, hfsr, dfsr, mmfar, bfar, afsr] = await Promise.all([
        readMem32(uid!, FAULT_ADDRS.SHCSR),
        readMem32(uid!, FAULT_ADDRS.CFSR),
        readMem32(uid!, FAULT_ADDRS.HFSR),
        readMem32(uid!, FAULT_ADDRS.DFSR),
        readMem32(uid!, FAULT_ADDRS.MMFAR),
        readMem32(uid!, FAULT_ADDRS.BFAR),
        readMem32(uid!, FAULT_ADDRS.AFSR),
      ])
      setRegs({ shcsr, cfsr, hfsr, dfsr, mmfar, bfar, afsr })

      // 2. EXC_RETURN → 判断异常使用的栈
      const lrVal = parseReg32(
        (await execWithTimeout(uid!, 'reg lr')).output
      )
      const excReturn =
        lrVal !== null && (lrVal >>> 28) === 0xf ? lrVal : null
      const stackUsed: 'msp' | 'psp' =
        excReturn !== null && ((excReturn >> 2) & 1) === 1 ? 'psp' : 'msp'

      // 3. 读取 SP 处的 8 字，校验是否为有效异常现场
      const spVal = parseReg32(
        (await execWithTimeout(uid!, `reg ${stackUsed}`)).output
      )
      if (spVal === null) return

      const direct = await readFrameWords(uid!, spVal)
      let frameAddr = spVal
      let frameWords = direct
      let finalSource = source

      if (!isValidExceptionFrame(direct) && opts?.recover) {
        // SP 处不是异常现场（如 CPU 停在故障处理程序内）→ 栈回溯恢复
        const found = await scanExceptionFrame(uid!, spVal)
        if (found !== null) {
          frameAddr = found
          frameWords = await readFrameWords(uid!, found)
          finalSource = 'recovered'
        }
      }

      setStackFrame({
        r0: toHexStr(frameWords[0]),
        r1: toHexStr(frameWords[1]),
        r2: toHexStr(frameWords[2]),
        r3: toHexStr(frameWords[3]),
        r12: toHexStr(frameWords[4]),
        lr: toHexStr(frameWords[5]),
        pc: toHexStr(frameWords[6]),
        xpsr: toHexStr(frameWords[7]),
        sp: frameAddr.toString(16).padStart(8, '0').toUpperCase(),
        excReturn:
          excReturn !== null
            ? excReturn.toString(16).padStart(8, '0').toUpperCase()
            : undefined,
        stackUsed,
        source: finalSource,
      })
    },
    [uid]
  )

  // ── 工具栏操作 ──────────────────────────────────

  /**
   * 开始分析：自适应捕获，不复位、不破坏现场
   * - 目标已暂停（故障可能已发生）→ 直接读取现场（必要时栈回溯恢复）
   * - 目标运行中 → 开启 Vector Catch 持续监控，故障自然发生时自动暂停并捕获
   */
  const handleAnalyze = useCallback(async () => {
    if (!uid || !isConnected || loading) return
    setLoading(true)
    try {
      const st = await execWithTimeout(uid, 'status')
      if (parseCoreState(st.output) === 'halted') {
        // ── 目标已暂停：不复位，直接读取（现场可能已在故障处理程序中被覆盖 → 栈回溯恢复）──
        const cfsrV = parseHex(await readMem32(uid, FAULT_ADDRS.CFSR))
        const hfsrV = parseHex(await readMem32(uid, FAULT_ADDRS.HFSR))
        await readTargetState('current', { recover: true })
        setAnalyzeInfo(
          cfsrV !== 0 || hfsrV !== 0
            ? '已读取故障现场（目标原为暂停状态，未复位）'
            : '目标已暂停，未检测到故障标志 — 已读取当前状态'
        )
      } else {
        // ── 目标运行中 ──
        // 1. 先查故障标志：上电即触发故障的固件此时很可能已卡在故障处理程序中
        //    （状态仍为 running），直接捕获，避免空等 15s 监控超时。
        const preCfsr = parseHex(await readMem32(uid, FAULT_ADDRS.CFSR))
        const preHfsr = parseHex(await readMem32(uid, FAULT_ADDRS.HFSR))
        if (preCfsr !== 0 || preHfsr !== 0) {
          await execWithTimeout(uid, 'halt')
          setAnalyzeInfo(
            '检测到故障已发生（目标仍在运行，可能正停在故障处理程序中），已暂停并恢复现场（未复位）'
          )
          await readTargetState('current', { recover: true })
          return
        }

        // 2. 无故障标志 → 开启 VC 监控，等待故障自然发生（不复位、不打断运行）
        setAnalyzeInfo('未检测到故障，开启 Vector Catch 监控…（不复位，故障发生时自动暂停保留现场）')
        await execWithTimeout(uid, 'vector-catch hbm')

        let captured = false
        await sleep(300)
        for (let i = 0; i < 30; i++) {
          // 最长约 15s
          const s = await execWithTimeout(uid, 'status', 10000)
          if (parseCoreState(s.output) === 'halted') {
            captured = true
            break
          }
          await sleep(500)
        }

        if (captured) {
          setAnalyzeInfo('已捕获异常（Vector Catch，未复位），读取现场…')
          await readTargetState('vc')
        } else {
          setAnalyzeInfo(
            '监控 15s 未触发故障；Vector Catch 已保持开启，故障发生时目标会自动暂停保留现场，届时再次点击「开始分析」即可读取'
          )
        }
      }
    } catch (e) {
      setAnalyzeInfo(
        `分析失败：${e instanceof Error ? e.message : '命令执行出错'}`
      )
    } finally {
      setLoading(false)
    }
  }, [uid, isConnected, loading, readTargetState])

  /** 手动分析：不复位目标，读取当前暂停状态（保留原「开始分析」行为） */
  const handleReadCurrent = useCallback(async () => {
    if (!uid || !isConnected || loading) return
    setLoading(true)
    setAnalyzeInfo('读取当前暂停状态…')
    try {
      const st = await execWithTimeout(uid, 'status')
      if (parseCoreState(st.output) !== 'halted') {
        await execWithTimeout(uid, 'halt')
      }
      await readTargetState('current')
      setAnalyzeInfo('已读取当前状态（非 Vector Catch 现场）')
    } catch (e) {
      setAnalyzeInfo(
        `读取失败：${e instanceof Error ? e.message : '命令执行出错'}`
      )
    } finally {
      setLoading(false)
    }
  }, [uid, isConnected, loading, readTargetState])

  const handleClear = useCallback(() => {
    setRegs(EMPTY_REGS)
    setStackFrame(null)
    setAnalyzeInfo(null)
    setRegOutput(null) // 同时清空 Reg 弹窗输出，避免任何残留状态
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // 忽略
    }
  }, [])

  const handleReset = useCallback(async () => {
    if (!uid || loading) return
    setLoading(true)
    setAnalyzeInfo('复位目标…')
    try {
      await execWithTimeout(uid, 'reset')
      setAnalyzeInfo('目标已复位')
    } catch (e) {
      setAnalyzeInfo(
        `复位失败：${e instanceof Error ? e.message : '命令执行出错'}`
      )
    } finally {
      setLoading(false)
    }
  }, [uid, loading])

  const handleHalt = useCallback(async () => {
    if (!uid || loading) return
    setLoading(true)
    setAnalyzeInfo('暂停目标…')
    try {
      await execWithTimeout(uid, 'halt')
      setAnalyzeInfo('目标已暂停')
    } catch (e) {
      setAnalyzeInfo(
        `暂停失败：${e instanceof Error ? e.message : '命令执行出错'}`
      )
    } finally {
      setLoading(false)
    }
  }, [uid, loading])

  const handleReg = useCallback(async () => {
    if (!uid || loading) return
    setLoading(true)
    setAnalyzeInfo('读取寄存器…')
    try {
      const result = await execWithTimeout(uid, 'reg all')
      setRegOutput(result.output)
      setAnalyzeInfo('寄存器读取完成')
    } catch (e) {
      setAnalyzeInfo(
        `寄存器读取失败：${e instanceof Error ? e.message : '命令执行出错'}`
      )
    } finally {
      setLoading(false)
    }
  }, [uid, loading])

  // ── 派生值 ──────────────────────────────────

  const cfsrVal = parseHex(regs.cfsr)
  const hfsrVal = parseHex(regs.hfsr)
  const shcsrVal = parseHex(regs.shcsr)
  const dfsrVal = parseHex(regs.dfsr)

  const mmfsrVal = cfsrVal & 0xff
  const bfsrVal = (cfsrVal >> 8) & 0xff
  const ufsrVal = (cfsrVal >> 16) & 0xffff

  const hasData =
    cfsrVal !== 0 || hfsrVal !== 0 || dfsrVal !== 0 || stackFrame !== null

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      {/* 工具栏（flex-wrap：避免窄窗口下按钮被挤出可视区） */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-1 py-2 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          disabled={!isConnected || loading}
          onClick={handleAnalyze}
          className="h-8 gap-1.5"
        >
          {loading ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          开始分析
        </Button>

        <Button
          variant="ghost"
          size="sm"
          disabled={!isConnected || loading}
          onClick={handleReadCurrent}
          className="h-8 gap-1.5"
          title="不复位目标，读取当前暂停状态"
        >
          <Crosshair className="size-3.5" />
          读当前状态
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button
          variant="ghost"
          size="sm"
          disabled={!hasData || loading}
          onClick={handleClear}
          className="h-8 gap-1.5"
        >
          <Eraser className="size-3.5" />
          清空数据
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button
          variant="ghost"
          size="sm"
          disabled={!isConnected || loading}
          onClick={handleReset}
          className="h-8 gap-1.5"
        >
          <RotateCcw className="size-3.5" />
          Reset
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button
          variant="ghost"
          size="sm"
          disabled={!isConnected || loading}
          onClick={handleHalt}
          className="h-8 gap-1.5"
        >
          <Square className="size-3.5" />
          Halt
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button
          variant="ghost"
          size="sm"
          disabled={!isConnected || loading}
          onClick={handleReg}
          className="h-8 gap-1.5"
        >
          <ListOrdered className="size-3.5" />
          Core Reg
        </Button>
      </div>

      {/* 诊断结论（新增 · 置顶，不替代四个 fault section） */}
      <FaultSummary
        regs={regs}
        stackFrame={stackFrame}
        analyzeInfo={analyzeInfo}
        hasData={hasData}
      />

      {/* 1. CPU capture during exception（保留结构 + 内部增强） */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            CPU capture during exception
            {stackFrame && (
              <SourceBadge source={stackFrame.source} />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stackFrame ? (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                异常栈帧（从 {stackFrame.stackUsed.toUpperCase()} = 0x{stackFrame.sp} 读取
                {stackFrame.excReturn
                  ? ` · EXC_RETURN=0x${stackFrame.excReturn}`
                  : ''}
                {stackFrame.excReturn
                  ? ` → 使用 ${stackFrame.stackUsed.toUpperCase()}`
                  : ''}
                ）
              </div>
              <div className="grid grid-cols-4 gap-3">
                <StackReg label="R0" value={stackFrame.r0} />
                <StackReg label="R1" value={stackFrame.r1} />
                <StackReg label="R2" value={stackFrame.r2} />
                <StackReg label="R3" value={stackFrame.r3} />
                <StackReg label="R12" value={stackFrame.r12} />
                <StackReg label="LR" value={stackFrame.lr} highlight />
                <StackReg label="PC" value={stackFrame.pc} highlight />
                <StackReg label="xPSR" value={stackFrame.xpsr} />
              </div>
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm">
                <span className="text-muted-foreground">故障地址（PC）: </span>
                <span className="font-mono text-primary">0x{stackFrame.pc}</span>
                <span className="ml-4 text-muted-foreground">返回地址（LR）: </span>
                <span className="font-mono text-primary">0x{stackFrame.lr}</span>
              </div>
              <XpsrBits xpsr={stackFrame.xpsr} />
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {isConnected
                ? '点击「开始分析」自动捕获异常现场（Vector Catch，无需固件支持）'
                : '连接探针后可从目标读取异常现场'}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. System Handler Control（单列显示） */}
      <FaultSection
        title="System Handler Control"
        register="SHCSR"
        value={shcsrVal}
        bits={SHCSR_BITS}
      />

      {/* 3. Debug Faults（单列显示） */}
      <FaultSection
        title="Debug Faults"
        register="DFSR"
        value={dfsrVal}
        bits={DFSR_BITS}
      />

      {/* 4. Hard Faults（保留） */}
      <FaultSection
        title="Hard Faults"
        register="HFSR"
        value={hfsrVal}
        bits={HFSR_BITS}
      />

      {/* 5. Usage Faults（保留） */}
      <FaultSection
        title="Usage Faults"
        register="UFSR"
        value={ufsrVal}
        bits={UFSR_BITS}
      />

      {/* 6. Bus Faults（保留） */}
      <FaultSection
        title="Bus Faults"
        register="BFSR"
        value={bfsrVal}
        bits={BFSR_BITS}
      />

      {/* 7. Memory Management Faults（保留） */}
      <FaultSection
        title="Memory Management Faults"
        register="MMFSR"
        value={mmfsrVal}
        bits={MMFSR_BITS}
      />

      {/* Reg 弹窗（多 tab：通用 / 特殊 / 原始输出） */}
      {regOutput !== null && (
        <RegDialog output={regOutput} onClose={() => setRegOutput(null)} />
      )}
    </div>
  )
}

// ── Reg 弹窗组件（列表方式展示） ──────────────────────────────────

function RegDialog({ output, onClose }: { output: string; onClose: () => void }) {
  const [tab, setTab] = useState<'general' | 'special'>('general')
  const entries = useMemo(() => parseRegAll(output), [output])
  const general = entries.filter((e) => GENERAL_REG.test(e.name))
  const special = entries.filter((e) => !GENERAL_REG.test(e.name))
  const list = tab === 'general' ? general : special

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>寄存器列表</DialogTitle>
        </DialogHeader>
        <div className="flex gap-1 border-b border-border pb-2">
          {(
            [
              ['general', '通用寄存器'],
              ['special', '特殊寄存器'],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              variant={tab === key ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setTab(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="max-h-[55vh] overflow-y-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">寄存器</TableHead>
                <TableHead className="w-36">值</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-xs text-muted-foreground">
                    未解析到寄存器
                  </TableCell>
                </TableRow>
              ) : (
                list.map((e) => {
                  const num = parseInt(e.value, 16)
                  const desc = getRegDesc(e.name, Number.isNaN(num) ? 0 : num)
                  return (
                    <TableRow key={`${e.group}-${e.name}`}>
                      <TableCell className="font-mono text-xs font-medium">
                        {e.name}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-primary">
                        {formatRegValue(e.value)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {desc}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── 诊断结论组件（新增 · 置顶） ──────────────────────────────────

function FaultSummary({
  regs,
  stackFrame,
  analyzeInfo,
  hasData,
}: {
  regs: RegState
  stackFrame: StackFrame | null
  analyzeInfo: string | null
  hasData: boolean
}) {
  const cfsr = parseInt(regs.cfsr, 16) || 0
  const hfsr = parseInt(regs.hfsr, 16) || 0
  const shcsr = parseInt(regs.shcsr, 16) || 0
  const mmfar = parseInt(regs.mmfar, 16) || 0
  const bfar = parseInt(regs.bfar, 16) || 0
  const mmfsr = cfsr & 0xff
  const bfsr = (cfsr >> 8) & 0xff
  const ufsr = (cfsr >> 16) & 0xffff
  const bfarValid = (bfsr >> 7) & 1
  const mmarValid = (mmfsr >> 7) & 1

  let faultType = '未检测到故障'
  let faultAddr = '—'
  let faultPos = stackFrame ? `PC=0x${stackFrame.pc}` : '—'

  if (hfsr & (1 << 30)) {
    // FORCED → 查看可配置故障
    if (bfsr !== 0) {
      faultType = bfsr & (1 << 1)
        ? '精确总线错误'
        : bfsr & (1 << 8)
          ? '指令预取总线错误'
          : bfsr & (1 << 12)
            ? '异常入栈总线错误'
            : bfsr & (1 << 11)
              ? '异常出栈总线错误'
              : '总线错误'
      faultAddr = bfarValid ? `0x${regs.bfar}` : '—（不精确错误，BFAR 无效）'
    } else if (ufsr !== 0) {
      faultType = ufsr & (1 << 0)
        ? '未定义指令'
        : ufsr & (1 << 1)
          ? '非法状态（Thumb 位错误）'
          : ufsr & (1 << 2)
            ? '异常返回 PC 无效'
            : ufsr & (1 << 9)
              ? '除零错误'
              : ufsr & (1 << 8)
                ? '未对齐访问'
                : '用法错误'
    } else if (mmfsr !== 0) {
      faultType = mmfsr & (1 << 0)
        ? '指令访问违例'
        : mmfsr & (1 << 1)
          ? '数据访问违例'
          : '内存管理错误'
      faultAddr = mmarValid ? `0x${regs.mmfar}` : '—'
    } else {
      faultType = '强制 HardFault（可配置故障来源未知）'
    }
  } else if (hfsr & (1 << 1)) {
    faultType = '向量表读取失败'
  } else if (bfsr !== 0) {
    faultType = '总线错误（未升级为 HardFault）'
  } else if (ufsr !== 0) {
    faultType = '用法错误（未升级为 HardFault）'
  } else if (mmfsr !== 0) {
    faultType = '内存管理错误（未升级为 HardFault）'
  }

  const busFaultEnabled = (shcsr >> 17) & 1
  const usgFaultEnabled = (shcsr >> 18) & 1
  const memFaultEnabled = (shcsr >> 16) & 1

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          分析结论
          {hasData ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-normal text-primary">
              已捕获
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
              未分析
            </span>
          )}
          {analyzeInfo && (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              · {analyzeInfo}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {hasData ? (
          <div className="grid gap-2 md:grid-cols-3">
            <SummaryItem label="故障类型" value={faultType} />
            <SummaryItem label="故障地址" value={faultAddr} mono />
            <SummaryItem label="触发位置" value={faultPos} mono />
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">
            点击「开始分析」自动捕获并生成诊断结论
          </div>
        )}
        {hasData && (hfsr & (1 << 30)) !== 0 && (
          <div className="text-xs text-muted-foreground">
            可配置故障使能：Bus{' '}
            {busFaultEnabled ? 'ON' : 'OFF'} · Usage {usgFaultEnabled ? 'ON' : 'OFF'} · MemManage{' '}
            {memFaultEnabled ? 'ON' : 'OFF'}
            {!busFaultEnabled && !usgFaultEnabled && !memFaultEnabled
              ? '（均未使能 → 故障升级为 HardFault）'
              : '（已使能时故障走各自 handler，不会升级）'}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SummaryItem({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-md border border-border bg-background/60 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-sm', mono && 'font-mono text-primary')}>
        {value}
      </div>
    </div>
  )
}

// ── 子组件 ──────────────────────────────────

function CpuIcon() {
  return (
    <svg className="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  )
}

function ActivityIcon() {
  return (
    <svg className="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  )
}

function SourceBadge({ source }: { source: StackSource }) {
  if (source === 'vc') {
    return (
      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-normal text-primary">
        Vector Catch · 异常入口捕获
      </span>
    )
  }
  if (source === 'recovered') {
    return (
      <span className="rounded-full bg-teal-500/10 px-2 py-0.5 text-[10px] font-normal text-teal-600 dark:text-teal-400">
        栈回溯恢复 · 未复位
      </span>
    )
  }
  return (
    <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-[10px] font-normal text-yellow-600 dark:text-yellow-500">
      当前栈 · 非异常入口
    </span>
  )
}

function FaultSection({
  title,
  register,
  value,
  bits,
}: {
  title: string
  register: string
  value: number
  bits: FaultBit[]
}) {
  const activeBits = bits.filter((b) => (value >> b.bit) & 1)
  const hasFault = value !== 0
  const summary = activeBits.map((b) => b.name).join(' ')

  return (
    <Card className={cn(hasFault && 'border-primary/30')}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle
            className={cn(
              'flex items-center gap-2 text-sm',
              hasFault ? 'text-primary' : 'text-foreground'
            )}
          >
            {title}
            {hasFault && (
              <span className="flex items-center gap-1 text-xs">
                <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                {activeBits.length} flag(s) active
              </span>
            )}
          </CardTitle>
          <span
            className={cn(
              'font-mono text-xs',
              hasFault ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            {register} = 0x{value.toString(16).padStart(8, '0').toUpperCase()}
            {summary ? ` · ${summary}` : ''}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {hasFault ? (
          <div className="space-y-1.5">
            {activeBits.map((b) => (
              <div
                key={b.bit}
                className="flex items-start gap-3 rounded-md bg-muted/30 px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs font-bold text-primary">
                  bit {b.bit}
                </span>
                <span className="font-mono text-xs font-medium">{b.name}</span>
                <span className="flex-1 text-xs text-muted-foreground">{b.desc}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-2 text-center text-xs text-muted-foreground">
            无 {title} 标志位
          </div>
        )}

        {/* 全 32 位位图（含保留位，0-31 全覆盖） */}
        <div className="mt-3 flex flex-wrap gap-1">
          {Array.from({ length: 32 }, (_, bit) => {
            const isActive = (value >> bit) & 1
            const defined = bits.find((b) => b.bit === bit)
            return (
              <div
                key={bit}
                title={
                  defined
                    ? `bit ${bit} · ${defined.name}: ${defined.desc}`
                    : `bit ${bit} · 保留/未定义`
                }
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded text-[10px] font-mono font-bold transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted/30 text-muted-foreground'
                )}
              >
                {isActive ? '1' : '0'}
              </div>
            )
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/70">
          <span>bit 0 →</span>
          <span>← bit 31</span>
        </div>
      </CardContent>
    </Card>
  )
}

function StackReg({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className={cn(
      'rounded-md border p-2',
      highlight ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/20'
    )}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('font-mono text-sm font-medium', highlight && 'text-primary')}>
        0x{value}
      </div>
    </div>
  )
}

function XpsrBits({ xpsr }: { xpsr: string }) {
  const v = parseInt(xpsr, 16) || 0
  const bits: [string, number][] = [
    ['N', 31], ['Z', 30], ['C', 29], ['V', 28], ['Q', 27], ['T', 24],
  ]
  return (
    <div className="flex flex-wrap gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
      <span className="text-xs text-muted-foreground">xPSR 标志:</span>
      {bits.map(([name, bit]) => (
        <span
          key={name}
          className={cn(
            'rounded px-1.5 py-0.5 font-mono text-[10px]',
            (v >> bit) & 1
              ? 'bg-primary/10 text-primary'
              : 'bg-muted/40 text-muted-foreground'
          )}
        >
          {name}={(v >> bit) & 1}
        </span>
      ))}
      <span className="font-mono text-[10px] text-muted-foreground">
        IPSR={(v & 0x1ff).toString(10)}
      </span>
    </div>
  )
}

function MemRegionBadge({ addr }: { addr: number }) {
  // 地址 0 特判：通常是空指针/零地址访问（0x0 即向量表/Flash 起始区）
  if (addr === 0) {
    return (
      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
        地址 0x0 · 空指针/零地址访问
      </span>
    )
  }
  const region =
    addr >= 0x00000000 && addr <= 0x1fffffff
      ? { name: 'Flash/代码区', cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' }
      : addr >= 0x20000000 && addr <= 0x3fffffff
        ? { name: 'SRAM', cls: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' }
        : addr >= 0x40000000 && addr <= 0x5fffffff
          ? { name: '外设区', cls: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' }
          : addr >= 0x60000000 && addr <= 0x9fffffff
            ? { name: '外部存储区', cls: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-500' }
            : addr >= 0xe0000000 && addr <= 0xffffffff
              ? { name: '系统区', cls: 'bg-gray-500/10 text-gray-600 dark:text-gray-400' }
              : { name: '非法/保留区', cls: 'bg-destructive/10 text-destructive' }
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', region.cls)}>
      {region.name}
    </span>
  )
}
