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
}

/** 反汇编结果 */
export interface DisasmResult {
  success: boolean
  address: number
  instructions: DisasmInstruction[]
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
  fields: PeripheralField[]
}

/** 外设 */
export interface Peripheral {
  name: string
  base_address: number
  registers: PeripheralRegister[]
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

/** 单步执行 */
export async function zoneStep(uid: string): Promise<void> {
  const client = await api()
  await client.post(`/api/probes/${uid}/zone/debug/step`)
}

/** 继续运行 */
export async function zoneContinue(uid: string): Promise<void> {
  const client = await api()
  await client.post(`/api/probes/${uid}/zone/debug/continue`)
}

/** 复位并暂停 */
export async function zoneReset(uid: string): Promise<void> {
  const client = await api()
  await client.post(`/api/probes/${uid}/zone/debug/reset`)
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
): Promise<{ success: boolean; functions: { name: string; address: number; size: number }[]; total: number }> {
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