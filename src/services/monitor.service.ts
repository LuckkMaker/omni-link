import { api } from './api'

/** Monitor 支持的数据类型 */
export type MonitorVarType =
  | 'int8' | 'uint8'
  | 'int16' | 'uint16'
  | 'int32' | 'uint32'
  | 'float'

/** 被监视的变量 */
export interface MonitorVariable {
  id: string
  name: string
  address: number
  type: MonitorVarType
  size: number
  remark: string
  refresh_sec: number
}

/** ELF 符号（变量/函数）
 *
 *  数组符号：is_array=true，elem_type/elem_count/elem_size 描述元素信息。
 *  非数组：is_array=false，elem_count=1，elem_size=size，elem_type=type。
 *  type 字段：数组时为元素类型，非数组为变量类型（向后兼容）。
 */
export interface MonitorSymbol {
  name: string
  address: number
  size: number
  type: MonitorVarType
  /** 是否数组 */
  is_array: boolean
  /** 元素数据类型（数组时为元素类型，非数组等于 type） */
  elem_type: MonitorVarType
  /** 数组元素个数（非数组为 1） */
  elem_count: number
  /** 元素字节数（非数组等于 size） */
  elem_size: number
  /** 所属源文件（DWARF compile unit name，无 DWARF 时 "unknown"） */
  source_file: string
  /** 数组类型是否为猜测（无 DWARF 信息时按 size 推断，元素类型可能不准确） */
  is_guess?: boolean
}

/** 符号查询结果（分页） */
export interface SymbolQueryResult {
  success: boolean
  symbols: MonitorSymbol[]
  total: number
  page: number
  page_size: number
}

/** Monitor 运行状态 */
export interface MonitorStatus {
  running: boolean
  paused: boolean
  connected: boolean
  rate_hz: number
  actual_rate_hz?: number
  variable_count: number
  elf_loaded: boolean
  buffer_size: number
}

/** 单个采样点 */
export interface SamplePoint {
  t_ms: number
  values: { id: string; value: number | null }[]
}

/** 启动采样参数 */
export interface StartSamplingOptions {
  rate_hz?: number
  max_points?: number
  transport?: 'swd' | 'rtt'
}

/** Monitor API 服务 */
export const monitorService = {
  /** 查询 Monitor 状态 */
  async status(uid: string): Promise<MonitorStatus> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/monitor/status`)
    return data
  },

  /** 加载 ELF/AXF 文件，解析符号表 */
  async loadElf(uid: string, path: string): Promise<{ success: boolean; symbol_count: number; path: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/elf/load`, { path })
    return data
  },

  /** 检测已加载 ELF 文件是否在磁盘上变化（供轮询提醒重载） */
  async checkElfChanged(uid: string): Promise<{ loaded: boolean; changed: boolean; path?: string; mtime?: number; error?: string }> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/monitor/elf/changed`)
    return data
  },

  /** 查询符号列表（分页） */
  async getSymbols(
    uid: string,
    opts: { filter?: string; type?: 'object' | 'func' | 'all'; page?: number; page_size?: number } = {}
  ): Promise<SymbolQueryResult> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/monitor/symbols`, {
      params: {
        filter: opts.filter ?? '',
        type: opts.type ?? 'object',
        page: opts.page ?? 1,
        page_size: opts.page_size ?? 200,
      },
    })
    return data
  },

  /** 获取监视变量列表 */
  async getVariables(uid: string): Promise<{ variables: MonitorVariable[] }> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/monitor/variables`)
    return data
  },

  /** 添加监视变量
   *
   *  elem_index：数组元素索引（可选）。传入时后端按 address + elem_index*elem_size
   *  计算实际地址，变量名变为 name[elem_index]，类型/大小用元素信息。
   *  非数组符号不传此参数。
   */
  async addVariable(
    uid: string,
    params: {
      name: string
      address: number
      type: MonitorVarType
      remark?: string
      refresh_sec?: number
      elem_index?: number
    }
  ): Promise<{ success: boolean; variable: MonitorVariable }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/variables`, params)
    return data
  },

  /** 移除监视变量 */
  async removeVariable(uid: string, varId: string): Promise<{ success: boolean }> {
    const client = await api()
    const { data } = await client.delete(`/api/probes/${uid}/monitor/variables/${varId}`)
    return data
  },

  /** 写入变量值到下位机 */
  async writeVariable(uid: string, varId: string, value: number): Promise<{ success: boolean }> {
    const client = await api()
    const { data } = await client.put(`/api/probes/${uid}/monitor/variables/${varId}/value`, { value })
    return data
  },

  /** 启动采样 */
  async start(uid: string, opts: StartSamplingOptions = {}): Promise<{ success: boolean; rate_hz: number; transport: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/start`, {
      rate_hz: opts.rate_hz ?? 1000,
      max_points: opts.max_points ?? 300000,
      transport: opts.transport ?? 'swd',
    })
    return data
  },

  /** 停止采样 */
  async stop(uid: string): Promise<{ success: boolean }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/stop`)
    return data
  },

  /** 暂停采样（采样线程保持运行但跳过读取） */
  async pause(uid: string): Promise<{ success: boolean; paused: boolean }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/pause`)
    return data
  },

  /** 恢复采样 */
  async resume(uid: string): Promise<{ success: boolean; paused: boolean }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/resume`)
    return data
  },

  /** 运行目标内核（resume） */
  async deviceRun(uid: string): Promise<{ success: boolean; state: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/device/run`)
    return data
  },

  /** 暂停目标内核（halt） */
  async deviceHalt(uid: string): Promise<{ success: boolean; state: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/device/halt`)
    return data
  },

  /** 复位目标芯片 */
  async deviceReset(uid: string, run: boolean = true): Promise<{ success: boolean; state: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/monitor/device/reset`, { run })
    return data
  },

  /** 查询目标内核状态 */
  async deviceState(uid: string): Promise<{ success: boolean; state: string; error?: string }> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/monitor/device/state`)
    return data
  },

  /** 导出录制数据为 CSV（可指定时间范围；缺省导出全部） */
  async exportCsv(
    uid: string,
    opts?: { mode?: 'all' | 'recent' | 'custom'; recentSeconds?: number; startMs?: number; endMs?: number },
  ): Promise<{ success: boolean; csv: string; count: number }> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/monitor/record/export`, {
      params: { format: 'csv', ...(opts ?? {}) },
    })
    return data
  },

  /** 按时间范围读取磁盘落盘采样数据（历史无上限，供全览/历史查看） */
  async readRecord(
    uid: string,
    opts?: { startMs?: number; endMs?: number; limit?: number },
  ): Promise<{
    success: boolean
    segments: { vars: { id: string; name: string; type: string; address: number }[]; samples: { t_ms: number; values: Record<string, number> }[] }[]
    error?: string
  }> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/monitor/record`, { params: opts ?? {} })
    return data
  },
}
