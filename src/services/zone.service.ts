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

/** 核心寄存器（Name/Value/Description） */
export interface CoreRegister {
  name: string
  value: number
  description: string
}

/** 寄存器读取结果 */
export interface RegisterReadResult {
  success: boolean
  values: { address: number; value: number }[]
  errors: { address: number; error: string }[]
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
  sections: { name: string; address: number; size: number; writable: boolean; flash: boolean }[]
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

/** 源码行断点 */
export interface SourceBreakpoint {
  address: number
  file: string
  line: number
}

/** 按源码行设置/移除断点 */
export async function zoneSetBreakpoint(
  uid: string,
  file: string,
  line: number,
  set: boolean
): Promise<{ success: boolean; address: number; file: string; line: number; active: boolean }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/debug/breakpoint`, { file, line, set })
  return data
}

/** 列出已设置的源码断点 */
export async function zoneListBreakpoints(uid: string): Promise<{ success: boolean; breakpoints: SourceBreakpoint[] }> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/zone/breakpoints`)
  return data
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

/** 读取内存 */
export async function zoneReadMemory(
  uid: string,
  address: number,
  length: number
): Promise<{ success: boolean; address: number; length: number; data_hex: string }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/zone/memory/read`, { address, length })
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