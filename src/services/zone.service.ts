import { api } from './api'

/** 调试状态 */
export interface ZoneDebugStatus {
  success: boolean
  connected: boolean
  state: 'disconnected' | 'running' | 'halted' | 'unknown'
  pc: number | null
}

/** ELF 加载结果 */
export interface ZoneElfInfo {
  success: boolean
  loaded: boolean
  path: string | null
}

/** ELF 加载结果（含元数据） */
export interface ZoneElfLoadResult {
  success: boolean
  path: string
  source_files: string[]
  function_count: number
  disasm_available: boolean
}

/** 源码位置 */
export interface ZoneSourceLine {
  address: number
  file?: string
  dirname?: string
  line?: number
  comp_dir?: string
  function?: string
}

/** 反汇编指令 */
export interface DisasmInstruction {
  address: number
  size: number
  bytes: string
  mnemonic: string
  op_str: string
  /** 所属函数名（无调试信息时为 null） */
  function?: string | null
}

/** 反汇编交错行：函数标签 / 源码行 / 指令行（与 SEGGER Ozone 反汇编视图一致） */
export type DisasmRow =
  | { type: 'func'; name: string; address: number }
  | { type: 'source'; file: string; line: number; text: string }
  | { type: 'ins'; address: number; size: number; bytes: string; mnemonic: string; op_str: string; function: string | null }

/** 反汇编结果 */
export interface DisasmResult {
  success: boolean
  address: number
  instructions: DisasmInstruction[]
  rows?: DisasmRow[]
  count: number
}

/** 外设字段 */
export interface PeripheralField {
  name: string
  bit_offset: number
  bit_width: number
  description: string
  values: { name: string; value: number; description: string }[]
}

/** 外设寄存器 */
export interface PeripheralRegister {
  name: string
  offset: number
  address: number
  size: number
  access: string
  description?: string
  fields: PeripheralField[]
}

/** 外设 */
export interface Peripheral {
  name: string
  description?: string
  base_address?: number
  /** 寄存器列表（三级结构：外设 → 寄存器 → 位域） */
  registers: PeripheralRegister[]
}

/** 核心寄存器（Name/Value/Description，group 用于分组折叠展示） */
export interface CoreRegister {
  name: string
  value: number
  description: string
  group: string
}

/** 寄存器读取结果 */
export interface RegisterReadResult {
  success: boolean
  values: { address: number; value: number }[]
  errors: { address: number; error: string }[]
}

/** Core Peripheral：单个中断源状态（NVIC 视图一行） */
export interface NvicIrq {
  number: number
  name: string
  enabled: boolean
  pending: boolean
  active: boolean
  priority: number
}

/** 会话配置 */
export interface ZoneSession {
  name: string
  path: string
  updated_at: string
}

/** 源文件信息（左侧 Source Files 表格行） */
export interface SourceFileInfo {
  path: string
  name: string
  size: number | null
}

/** 内存使用统计 */
export interface MemoryUsage {
  success: boolean
  flash_used: number
  ram_used: number
  total: number
  sections: {
    name: string
    address: number
    size: number
    writable: boolean
    flash: boolean
    /** 该 section 的语义分类占用（kind → 字节数） */
    categories: Record<string, number>
  }[]
  /** 语义分类聚合：Code/RO Data/RW Data/ZI Data/Heap/Stack */
  categories: { name: string; kind: string; rom: number; ram: number }[]
}

// ── 调试控制 ──────────────────────────────

/** 暂停目标 */
export async function zoneHalt(uid: string): Promise<void> {
  const client = await api()
  await client.post(`/api/probes/${uid}/zone/debug/halt`)
}

/** 继续运行 */
export async function zoneContinue(uid: string): Promise<void> {
  const client = await api()
  await client.post(`/api/probes/${uid}/zone/debug/continue`)
}

/** 复位模式 */
export type ZoneResetMode = 'halt' | 'run' | 'break_symbol'

/** 单步模式 */
export type ZoneStepMode = 'into' | 'over' | 'out'

/** 单步执行 */
export async function zoneStep(
  uid: string,
  mode: ZoneStepMode = 'into'
): Promise<{ success: boolean; mode: ZoneStepMode; halted?: boolean }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/debug/step`, { mode })
  return data
}

/** 复位目标 */
export async function zoneReset(uid: string, mode: ZoneResetMode = 'halt'): Promise<{
  success: boolean
  mode: ZoneResetMode
  symbol?: string | null
  address?: number | null
  halted?: boolean
}> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/debug/reset`, { mode })
  return data
}

/** 断点模式：break 中断 / log 日志点（命中打印并继续）/ execute 执行只读命令（命中执行并继续） */
export type BreakpointMode = 'break' | 'log' | 'execute'

/** 源码行断点 */
export interface SourceBreakpoint {
  address: number
  file: string
  line: number
  /** 是否启用（checkbox 启停） */
  enabled: boolean
  /** 按 mode 复用：break→触发条件表达式 / log→日志文本（可含 {expr}）/ execute→多行只读命令 */
  condition: string | null
  /** 断点模式 */
  mode: BreakpointMode
}

/** 单个断点的局部更新（PATCH）：仅提供要修改的字段 */
export interface BreakpointUpdate {
  enabled?: boolean
  mode?: BreakpointMode
  /** 更新 condition 时需同时置 applyCondition=true（用于区分「设为空」与「不修改」） */
  condition?: string | null
  applyCondition?: boolean
}

/** 按源码行设置/移除断点 */
export async function zoneSetBreakpoint(
  uid: string,
  file: string,
  line: number,
  set: boolean,
  opts?: { enabled?: boolean; condition?: string | null; mode?: BreakpointMode }
): Promise<{ success: boolean; address: number; file: string; line: number; active: boolean }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/debug/breakpoint`, {
    file,
    line,
    set,
    enabled: opts?.enabled,
    condition: opts?.condition,
    mode: opts?.mode,
  })
  return data
}

/** 按地址更新单个断点（启停 / 模式 / 条件） */
export async function zoneUpdateBreakpoint(
  uid: string,
  address: number,
  patch: BreakpointUpdate
): Promise<{ success: boolean } & SourceBreakpoint> {
  const client = await api()
  const { data } = await client.patch(`/api/probes/${uid}/zone/debug/breakpoint`, {
    address,
    enabled: patch.enabled,
    mode: patch.mode,
    condition: patch.applyCondition ? patch.condition : undefined,
    apply_condition: patch.applyCondition ?? false,
  })
  return data
}

/** 按地址删除单个断点 */
export async function zoneRemoveBreakpoint(
  uid: string,
  address: number
): Promise<{ success: boolean; cleared: number }> {
  const client = await api()
  const { data } = await client.delete(`/api/probes/${uid}/zone/debug/breakpoint`, { params: { address } })
  return data
}

/** 列出已设置的源码断点（前端兜底默认新字段，兼容旧后端返回） */
export async function zoneListBreakpoints(uid: string): Promise<{ success: boolean; breakpoints: SourceBreakpoint[] }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/breakpoints`)
  const bps = (data.breakpoints as Partial<SourceBreakpoint>[] ?? []).map((b) => ({
    address: b.address ?? 0,
    file: b.file ?? '',
    line: b.line ?? 0,
    enabled: b.enabled ?? true,
    condition: b.condition ?? null,
    mode: (b.mode as BreakpointMode) ?? 'break',
  }))
  return { success: data.success, breakpoints: bps }
}

/** 清除全部断点 */
export async function zoneClearBreakpoints(uid: string): Promise<{ success: boolean; cleared: number }> {
  const client = await api()
  const { data } = await client.delete(`/api/probes/${uid}/zone/debug/breakpoints`)
  return data
}

/** 运行到光标所在行（临时断点 + 继续运行，命中后暂停） */
export async function zoneRunToCursor(
  uid: string,
  file: string,
  line: number
): Promise<{ success: boolean; address: number; halted: boolean }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/debug/run-to-cursor`, { file, line })
  return data
}

/** 查询调试状态 */
export async function zoneStatus(uid: string): Promise<ZoneDebugStatus> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/debug/status`)
  return data as ZoneDebugStatus
}

// ── ELF 源码 / 反汇编 ──────────────────────

/** 加载 ELF */
export async function zoneLoadElf(uid: string, path: string): Promise<ZoneElfLoadResult> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/elf/load`, { path })
  return data as ZoneElfLoadResult
}

/** 查询 ELF 加载状态 */
export async function zoneElfInfo(uid: string): Promise<ZoneElfInfo> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/elf/info`)
  return data as ZoneElfInfo
}

/** 查询 ELF 是否变化 */
export async function zoneElfChanged(uid: string): Promise<{ success: boolean; changed: boolean; loaded: boolean }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/elf/changed`)
  return data
}

/** 源文件列表 */
export async function zoneSourceFiles(uid: string): Promise<SourceFileInfo[]> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/source/files`)
  return data.files as SourceFileInfo[]
}

/** 地址 → 源码行 */
export async function zoneSourceLine(uid: string, address: number): Promise<ZoneSourceLine | null> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/source/line`, { params: { address } })
  return data.success ? (data.line as ZoneSourceLine) : null
}

/** 读取源文件内容 */
export async function zoneSourceContent(
  uid: string,
  file: string
): Promise<{ success: boolean; file?: string; lines?: string[]; error?: string }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/source/content`, { params: { file } })
  return data
}

/** 写回源文件内容（编辑保存） */
export async function zoneSourceSave(
  uid: string,
  file: string,
  content: string
): Promise<{ success: boolean; file?: string; error?: string }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/source/content`, { file, content })
  return data
}

/** 获取文件中可执行（可打断点）的行号 */
export async function zoneExecutableLines(
  uid: string,
  file: string
): Promise<{ success: boolean; lines?: number[]; error?: string }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/source/executable-lines`, {
    params: { file },
  })
  return data
}

/** 符号定义位置（转到定义） */
export interface SourceSymbol {
  name: string
  address: number
  size: number
  type: string
  file?: string | null
  line?: number | null
  function?: string | null
  /** 函数符号的 DWARF 签名（返回类型 f(参数类型...)，离线解析） */
  signature?: string | null
  /** 函数返回类型名 */
  ret?: string | null
  /** 形参类型名列表 */
  params?: string[] | null
}

/** 按名字解析符号定义位置 */
export async function zoneResolveSymbol(
  uid: string,
  name: string
): Promise<{ success: boolean; symbol?: SourceSymbol | null }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/source/symbol`, {
    params: { name },
  })
  return data
}

/** 源码 hover 调试信息（函数地址 / 变量值 / 寄存器值） */
export interface HoverInfo {
  /** 类别：function 函数 / variable 变量 / register 寄存器 */
  kind: 'function' | 'variable' | 'register'
  name: string
  /** 函数地址 / 变量所在地址 */
  address?: number
  /** 变量当前值（available 为 true 时有效） */
  value?: number | null
  /** 变量类型名 */
  type?: string
  /** 变量值是否成功读取 */
  available?: boolean
  /** 变量位宽（字节数 × 8），用于按位宽补齐显示 */
  bit_size?: number
  /** 符号大小（字节数） */
  size?: number
  /** 变量类别：scalar 标量 / struct 结构体 / array 数组 / pointer 指针 */
  var_kind?: 'scalar' | 'struct' | 'array' | 'pointer'
}

/** 源码 hover：解析函数地址 / 变量值（需目标暂停读取变量） */
export async function zoneHoverInfo(
  uid: string,
  name: string
): Promise<{ success: boolean; state?: 'disconnected' | 'running' | 'halted'; info?: HoverInfo | null }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/hover`, { name })
  return data
}

// ── Watch 观察项求值 ──────────────────────────

/** Watch 观察项求值结果（与 HoverInfo 一致，额外携带 children 供展开显示） */
export interface WatchEvalInfo {
  /** 类别：register 寄存器 / function 函数 / variable 变量 */
  kind: 'register' | 'function' | 'variable'
  name: string
  /** 函数地址 / 变量所在地址 */
  address?: number
  /** 变量当前值（available 为 true 时有效） */
  value?: number | null
  /** 变量类型名 */
  type?: string
  /** 变量值是否成功读取 */
  available?: boolean
  /** 变量位宽（字节数 × 8），用于按位宽补齐显示 */
  bit_size?: number
  /** 符号大小（字节数） */
  size?: number
  /** 变量类别：scalar 标量 / struct 结构体 / array 数组 / pointer 指针 */
  var_kind?: 'scalar' | 'struct' | 'array' | 'pointer'
  /** 函数符号的 DWARF 签名（返回类型 f(参数类型...)，kind=function 时有效） */
  signature?: string | null
  /** 结构体成员 / 数组元素（var_kind 为 struct/array 时非空） */
  children?: CallStackLocal[]
  /** char 数组/指针的字符串值（如 "hello"） */
  str_value?: string
  /** float/double 浮点值 */
  float_value?: number
}

/** Watch 观察项求值：按表达式解析 函数/局部变量/全局变量/寄存器 当前值 */
export async function zoneWatchEval(
  uid: string,
  name: string
): Promise<{ success: boolean; state?: 'disconnected' | 'running' | 'halted'; info?: WatchEvalInfo | null }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/watch/eval`, { name })
  return data
}

/** Locals 页签：当前函数局部变量/形参结果 */
export interface LocalsResult {
  success: boolean
  state?: 'disconnected' | 'running' | 'halted'
  locals?: {
    signature?: string
    ret?: string
    variables?: CallStackLocal[]
  } | null
}

/** 当前函数局部变量/形参（随 PC 变化自动切换） */
export async function zoneLocals(uid: string): Promise<LocalsResult> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/locals`)
  return data
}

/** Watch 值编辑请求：按地址写内存或按名写寄存器 */
export interface WatchSetRequest {
  /** 目标：address 内存地址 / register 寄存器名 */
  target: 'address' | 'register'
  /** 内存地址（target=address 时必填） */
  address?: number
  /** 位宽字节数（target=address 时，默认 4） */
  size?: number
  /** 寄存器名（target=register 时必填） */
  name?: string
  /** 要写入的值 */
  value: number
}

/** Watch 值编辑：写内存/寄存器，写后立即重读回显 */
export async function zoneWatchSet(
  uid: string,
  req: WatchSetRequest
): Promise<{ success: boolean; error?: string; value?: number }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/watch/set`, req)
  return data
}

/** 源文件搜索结果（转到引用） */
export interface SourceSearchHit {
  file: string
  line: number
  text: string
}

/** 在全部源文件中做文本搜索 */
export async function zoneSearchSource(
  uid: string,
  query: string,
  limit = 200
): Promise<{ success: boolean; results?: SourceSearchHit[]; truncated?: boolean; error?: string }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/source/search`, {
    params: { query, limit },
  })
  return data
}

/** 反汇编 */
export async function zoneDisasm(
  uid: string,
  address: number,
  length = 64,
  maxInstructions = 32
): Promise<DisasmResult> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/disasm`, {
    address,
    length,
    max_instructions: maxInstructions,
  })
  return data as DisasmResult
}

/** 函数列表 */
export async function zoneFunctions(
  uid: string,
  filter = '',
  offset = 0,
  limit = 200
): Promise<{ success: boolean; functions: { name: string; address: number; size: number; file?: string | null; line?: number | null }[]; total: number }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/functions`, {
    params: { filter, offset, limit },
  })
  return data
}

/** 内存使用统计 */
export async function zoneMemoryUsage(uid: string): Promise<MemoryUsage> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/memory/usage`)
  return data as MemoryUsage
}

// ── 调用栈 / 调用图 ──────────────────────────

/** 调用栈帧局部变量（标量或可展开的结构体/数组节点） */
export interface CallStackLocal {
  name: string
  type: string
  value: number | null
  is_param: boolean
  available: boolean
  address?: number
  /** 变量位宽（字节数 × 8），用于按位宽补齐显示 */
  bit_size?: number
  /** 节点类别：scalar 标量 / struct 结构体 / array 数组 / pointer 指针。结构体/数组可展开查看成员 */
  kind?: 'scalar' | 'struct' | 'array' | 'pointer'
  /** 结构体成员 / 数组元素（kind 为 struct/array 时非空） */
  children?: CallStackLocal[]
  /** char 数组/指针的字符串值（如 "hello"） */
  str_value?: string
  /** float/double 浮点值 */
  float_value?: number
}

/** 调用栈帧 */
export interface CallStackFrame {
  address: number
  sp?: number | null
  symbol?: string
  function?: string
  function_address?: number
  function_size?: number
  file?: string
  line?: number
  /** 帧来源：top 当前 / except 异常 / return 返回 / call 调用 */
  type?: 'top' | 'except' | 'return' | 'call'
  /** 函数签名（DWARF，如 "void HAL_NVIC_SetPriorityGrouping(uint32_t)"） */
  signature?: string
  /** 函数返回值类型 */
  ret?: string
  /** 函数局部变量 / 形参（无变量时为空） */
  locals?: CallStackLocal[]
}

/** 调用栈回溯结果 */
export interface CallStackResult {
  success: boolean
  frames: CallStackFrame[]
  sp: number
  pc: number
  lr: number
}

/** 调用图 callee */
export interface CallGraphCallee {
  name: string
  address: number
  size: number
}

/** 调用图结果 */
export interface CallGraphResult {
  success: boolean
  function: { name: string; address: number; size: number }
  callees: CallGraphCallee[]
}

/** 调用栈回溯（需目标暂停） */
export async function zoneStack(uid: string): Promise<CallStackResult> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/stack`)
  return data as CallStackResult
}

/** 调用图：某函数的直接 callees */
export async function zoneCallGraph(uid: string, address: number): Promise<CallGraphResult> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/callgraph`, { params: { address } })
  return data as CallGraphResult
}

// ── 外设 / 寄存器 / 内存 ──────────────────────

/** 外设树元数据 */
export async function zonePeripherals(uid: string): Promise<{ success: boolean; peripherals: Peripheral[] }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/peripherals`)
  return data
}

/** 批量读取寄存器 */
export async function zoneReadRegisters(uid: string, addresses: number[]): Promise<RegisterReadResult> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/registers/read`, { addresses })
  return data as RegisterReadResult
}

/** 读取 CPU 核心寄存器（Name/Value/Description） */
export async function zoneCoreRegisters(
  uid: string
): Promise<{ success: boolean; registers: CoreRegister[] }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/registers/core`)
  return data as { success: boolean; registers: CoreRegister[] }
}

// ── Core Peripherals（NVIC） ─────────────────

/** NVIC 中断源状态表（Keil 范式：按中断源展示 Enable/Pending/Active/Priority） */
export async function zoneCoreNvic(uid: string): Promise<{ success: boolean; interrupts: NvicIrq[] }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/peripherals/core/nvic`)
  return data as { success: boolean; interrupts: NvicIrq[] }
}

/** 使能/禁止指定中断 */
export async function zoneSetNvicEnable(uid: string, number: number, enable: boolean): Promise<{ success: boolean }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/peripherals/core/nvic/${number}/enable`, { enable })
  return data as { success: boolean }
}

/** 置位/清除指定中断的挂起 */
export async function zoneSetNvicPending(uid: string, number: number, pending: boolean): Promise<{ success: boolean }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/peripherals/core/nvic/${number}/pending`, { pending })
  return data as { success: boolean }
}

/** 读取内存 */
export async function zoneReadMemory(
  uid: string,
  address: number,
  length: number
): Promise<{ success: boolean; address: number; length: number; data_hex: string; skipped?: boolean }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/memory/read`, { address, length })
  return data
}

/** 解析内存地址表达式（纯 hex / &name / name / name[offset]） → 地址 */
export async function zoneResolveMemoryAddress(
  uid: string,
  expr: string
): Promise<{ address: number | null; name?: string; size?: number; error?: string }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/memory/resolve`, { params: { expr } })
  return data
}

// ── 会话配置 ──────────────────────────────

/** 列出会话 */
export async function zoneListSessions(): Promise<ZoneSession[]> {
  const client = await api()
  const { data } = await client.get('/api/zone/sessions')
  return data.sessions as ZoneSession[]
}

/** 保存会话 */
export async function zoneSaveSession(name: string, sessionData: Record<string, unknown>): Promise<void> {
  const client = await api()
  await client.post('/api/zone/sessions', { name, data: sessionData })
}

/** 读取会话 */
export async function zoneGetSession(name: string): Promise<{ success: boolean; session?: { name: string; data: Record<string, unknown>; updated_at: string } }> {
  const client = await api()
  const { data } = await client.get(`/api/zone/sessions/${encodeURIComponent(name)}`)
  return data
}

/** 删除会话 */
export async function zoneDeleteSession(name: string): Promise<void> {
  const client = await api()
  await client.delete(`/api/zone/sessions/${encodeURIComponent(name)}`)
}