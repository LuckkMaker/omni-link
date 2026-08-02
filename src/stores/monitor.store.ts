import { create } from 'zustand'
import type { MonitorVariable, SamplePoint, MonitorVarType } from '@/services/monitor.service'

/** 前端 ring buffer 容量上限（与后端对齐；60 万点 @2.8kHz ≈ 3.5 分钟，
 *  全览历史加载以该上限截取最近数据） */
const MAX_SAMPLES = 600000

/** 通道配置（5.2 阶段波形渲染用）
 *
 *  min/max：用户设定的 Y 轴量程（用于固定量程模式，区别于 Follow 自适应）。
 *  movingAverage：是否启用滑动平均滤波。
 *  yResolution：Y 轴分辨率（每个刻度代表的数值大小，用于网格标注）。
 *  这些字段属于通道显示配置，可随变量配置一起持久化（JSON）。
 */
export interface ChannelConfig {
  varId: string
  color: string
  visible: boolean
  format: 'dec' | 'hex' | 'bin'
  /** Y 轴最小值（固定量程模式，null 表示跟随自适应） */
  min: number | null
  /** Y 轴最大值（固定量程模式，null 表示跟随自适应） */
  max: number | null
  /** 滑动平均窗口大小（0=关闭，>0=窗口大小） */
  movingAverage: number
  /** Y 轴分辨率（每格代表的数值，0 表示自动） */
  yResolution: number
  /** 触发方式：none=无，rising=上升沿，falling=下降沿，level=电平触发 */
  triggerMode: 'none' | 'rising' | 'falling' | 'level'
  /** 触发阈值（信号穿越/达到此值时触发） */
  triggerLevel: number
}

/** 数组变量分组（M6：数组在 Watch 面板以首元素展示，可展开/收起全部元素） */
export interface ArrayGroup {
  /** 数组基础名（不含 [n] 后缀） */
  baseName: string
  /** 元素个数 */
  elemCount: number
  /** 元素类型 */
  elemType: MonitorVarType
  /** 数组基地址 */
  baseAddress: number
  /** 元素字节数 */
  elemSize: number
  /** 首元素变量 ID */
  firstElemId: string
  /** 是否已展开（显示全部元素） */
  expanded: boolean
  /** 所有元素变量 ID（含首元素） */
  elemIds: string[]
}

interface MonitorState {
  // ── 运行状态 ──
  running: boolean
  paused: boolean
  starting: boolean
  error: string | null
  rateHz: number
  actualRateHz: number  // 实际采样率（由后端统计，用于诊断 HSS 性能）
  transport: 'swd' | 'rtt'
  // ── ELF ──
  elfPath: string | null
  elfLoaded: boolean
  /** 已加载的 ELF 文件在磁盘上发生变化（轮询检测到 mtime 改变） */
  elfChanged: boolean
  symbolCount: number

  // ── 变量 ──
  variables: MonitorVariable[]

  // ── 采样数据（前端 ring buffer）──
  /**
   * 采样点数组。引用保持稳定（内部可变），高频追加时不做全量拷贝；
   * 订阅方须同时依赖 samplesVersion 触发重渲染（见 appendSamples 分帧提交）。
   */
  samples: SamplePoint[]
  /** 数据版本号：每批量提交一次 +1，用于驱动订阅方重渲染 */
  samplesVersion: number
  totalSamples: number
  /** 全览历史加载中（磁盘数据正在拉取） */
  historyLoading: boolean
  /** 全览历史加载失败信息（null=无错误） */
  historyError: string | null

  // ── 显示配置 ──
  follow: boolean
  /** 时基窗口（秒），Follow/触发模式下显示的窗口宽度，如 0.001=1ms, 1=1s */
  timebase: number
  /** 波形图渲染帧率（FPS），控制重绘频率，默认 30 */
  fps: number
  channels: ChannelConfig[]
  /** Y 轴自动归一化：开启后每个通道按各自数据范围独立缩放（多量级通道共存时互不压缩） */
  yNormalized: boolean

  // ── 目标设备状态 ──
  /** CPU 内核状态：running=运行中, halted=已暂停, unknown=未知/未连接 */
  coreState: 'running' | 'halted' | 'unknown'

  // ── 数组分组（M6：数组首元素+展开/收起）──
  arrayGroups: ArrayGroup[]

  // ── actions ──
  setRunning: (running: boolean) => void
  setPaused: (paused: boolean) => void
  setStarting: (starting: boolean) => void
  setError: (error: string | null) => void
  setRateHz: (hz: number) => void
  setActualRateHz: (hz: number) => void
  setTransport: (t: 'swd' | 'rtt') => void
  setFollow: (on: boolean) => void
  setTimebase: (t: number) => void
  setFps: (fps: number) => void
  setYNormalized: (on: boolean) => void
  setCoreState: (state: 'running' | 'halted' | 'unknown') => void

  setElf: (path: string, count: number) => void
  setElfChanged: (v: boolean) => void
  setVariables: (vars: MonitorVariable[]) => void
  addVariable: (v: MonitorVariable) => void
  removeVariable: (id: string) => void
  updateVariable: (id: string, patch: Partial<MonitorVariable>) => void

  /** WS 推送采样点时调用，写入 ring buffer */
  appendSamples: (pts: SamplePoint[]) => void
  clearSamples: () => void
  /** 设置历史加载状态（全览时拉取磁盘数据） */
  setHistoryLoading: (loading: boolean) => void
  /** 加载磁盘历史到样本缓冲（全览时替换/合并 buffer；segments 来自后端 read_record） */
  loadHistory: (segments: { vars: { id: string; name: string; type: string; address: number }[]; samples: { t_ms: number; values: Record<string, number> }[] }[]) => void

  /** 同步通道配置（变量增删时） */
  syncChannels: () => void
  setChannel: (varId: string, patch: Partial<ChannelConfig>) => void

  /** 注册数组分组（添加数组首元素时调用） */
  registerArrayGroup: (g: { baseName: string; elemCount: number; elemType: MonitorVarType; baseAddress: number; elemSize: number; firstElemId: string }) => void
  /** 展开数组分组（添加 1..N-1 元素后调用） */
  expandArrayGroup: (baseName: string, newElemIds: string[]) => void
  /** 收起数组分组（移除非首元素后调用） */
  collapseArrayGroup: (baseName: string) => void
  /** 移除数组分组（删除整个数组时调用） */
  removeArrayGroup: (baseName: string) => void

  reset: () => void
}

/** 默认通道调色板（blue/green/orange/purple/cyan 循环） */
const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#dc2626', '#db2777', '#65a30d']

/**
 * 通道颜色全局递增序号。
 * 用"下一个未用颜色"而非 variables 数组位置分配：删除中间变量后重新添加，
 * 新通道不会拿到与现有通道冲突的调色板颜色（位置索引方案下 var 重加会
 * 与 s_cnt 同为 index 2 的颜色）。
 */
let channelColorSeq = 0

// ── 采样点高频缓冲（消除每次 appendSamples 的全量数组拷贝）──
// samplesBuffer：引用稳定的可变数组，直接暴露给订阅方（长度实时变化）
// pendingSamples：WS 消息到达时先入队，每 ~16ms 批量提交一次（分帧合并 set，
//   把高频采样下的 set/重渲染频率从"每消息一次"降到 ~60 次/秒）
const samplesBuffer: SamplePoint[] = []
let pendingSamples: SamplePoint[] = []
let pendingTotal = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flushPending(set: (partial: Partial<MonitorState>) => void, get: () => MonitorState) {
  flushTimer = null
  if (pendingSamples.length === 0) return
  samplesBuffer.push(...pendingSamples)
  if (samplesBuffer.length > MAX_SAMPLES) {
    samplesBuffer.splice(0, samplesBuffer.length - MAX_SAMPLES)
  }
  const added = pendingTotal
  pendingSamples = []
  pendingTotal = 0
  set({ samplesVersion: get().samplesVersion + 1, totalSamples: get().totalSamples + added })
}

function scheduleFlush(set: (partial: Partial<MonitorState>) => void, get: () => MonitorState) {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => flushPending(set, get), 16)
}

function clearSamplesBuffer(set: (partial: Partial<MonitorState>) => void, get: () => MonitorState) {
  samplesBuffer.length = 0
  pendingSamples = []
  pendingTotal = 0
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  set({ samplesVersion: get().samplesVersion + 1, totalSamples: 0 })
}

function makeChannel(varId: string): ChannelConfig {
  return {
    varId,
    color: PALETTE[channelColorSeq++ % PALETTE.length],
    visible: true,
    format: 'dec',
    min: null,
    max: null,
    movingAverage: 8,
    yResolution: 0,
    triggerMode: 'none',
    triggerLevel: 0,
  }
}

export const useMonitorStore = create<MonitorState>((set, get) => ({
  running: false,
  paused: false,
  starting: false,
  error: null,
  rateHz: 1000,
  actualRateHz: 0,
  transport: 'swd',

  elfPath: null,
  elfLoaded: false,
  elfChanged: false,
  symbolCount: 0,

  variables: [],

  samples: samplesBuffer,
  samplesVersion: 0,
  totalSamples: 0,
  historyLoading: false,
  historyError: null,

  follow: true,
  timebase: 1,
  fps: 30,
  yNormalized: false,
  channels: [],
  arrayGroups: [],
  coreState: 'unknown',

  setRunning: (running) => set({ running }),
  setPaused: (paused) => set({ paused }),
  setStarting: (starting) => set({ starting }),
  setError: (error) => set({ error }),
  setRateHz: (hz) => set({ rateHz: hz }),
  setActualRateHz: (hz) => set({ actualRateHz: hz }),
  setTransport: (t) => set({ transport: t }),
  setFollow: (on) => set({ follow: on }),
  setTimebase: (t) => set({ timebase: t }),
  setFps: (fps) => set({ fps }),
  setYNormalized: (on) => set({ yNormalized: on }),
  setCoreState: (state) => set({ coreState: state }),

  setElf: (path, count) => set({ elfPath: path, elfLoaded: true, symbolCount: count, elfChanged: false }),
  setElfChanged: (v) => set({ elfChanged: v }),

  setVariables: (vars) => {
    set({ variables: vars })
    get().syncChannels()
  },

  addVariable: (v) => {
    set((s) => ({ variables: [...s.variables, v] }))
    get().syncChannels()
  },

  removeVariable: (id) => {
    set((s) => ({
      variables: s.variables.filter((v) => v.id !== id),
      channels: s.channels.filter((c) => c.varId !== id),
    }))
  },

  updateVariable: (id, patch) => set((s) => ({
    variables: s.variables.map((v) => (v.id === id ? { ...v, ...patch } : v)),
  })),

  appendSamples: (pts) => {
    // 高频路径：先入待提交队列，分帧批量合并（避免每消息一次全量拷贝+set）
    pendingSamples.push(...pts)
    pendingTotal += pts.length
    scheduleFlush(set, get)
  },

  clearSamples: () => clearSamplesBuffer(set, get),

  setHistoryLoading: (loading) => set({ historyLoading: loading, historyError: loading ? null : get().historyError }),

  loadHistory: (segments) => {
    // 磁盘历史段展开为 SamplePoint[]（后端 values 是 {id:value} dict，转 [{id,value}]）
    const hist: SamplePoint[] = []
    let lastHistT = -Infinity
    for (const seg of segments) {
      for (const s of seg.samples) {
        hist.push({
          t_ms: s.t_ms,
          values: Object.entries(s.values).map(([id, value]) => ({ id, value })),
        })
        if (s.t_ms > lastHistT) lastHistT = s.t_ms
      }
    }
    // 保留当前缓冲中比历史更新（t_ms > lastHistT）的样本：
    // 加载期间 WS 仍会推来新样本，避免替换时丢失
    const tail = lastHistT >= 0 ? samplesBuffer.filter((p) => p.t_ms > lastHistT) : []
    samplesBuffer.length = 0
    samplesBuffer.push(...hist, ...tail)
    if (samplesBuffer.length > MAX_SAMPLES) {
      samplesBuffer.splice(0, samplesBuffer.length - MAX_SAMPLES)
    }
    pendingSamples = []
    pendingTotal = 0
    set({
      samplesVersion: get().samplesVersion + 1,
      totalSamples: samplesBuffer.length,
      historyLoading: false,
      historyError: null,
    })
  },

  syncChannels: () => set((s) => {
    const existing = new Map(s.channels.map((c) => [c.varId, c]))
    const channels = s.variables.map((v) =>
      existing.get(v.id) ?? makeChannel(v.id)
    )
    return { channels }
  }),

  setChannel: (varId, patch) => set((s) => ({
    channels: s.channels.map((c) => (c.varId === varId ? { ...c, ...patch } : c)),
  })),

  registerArrayGroup: (g) => set((s) => ({
    arrayGroups: [...s.arrayGroups, { ...g, expanded: false, elemIds: [g.firstElemId] }],
  })),

  expandArrayGroup: (baseName, newElemIds) => set((s) => ({
    arrayGroups: s.arrayGroups.map((g) =>
      g.baseName === baseName
        ? { ...g, expanded: true, elemIds: [...g.elemIds, ...newElemIds] }
        : g
    ),
  })),

  collapseArrayGroup: (baseName) => set((s) => ({
    arrayGroups: s.arrayGroups.map((g) =>
      g.baseName === baseName
        ? { ...g, expanded: false, elemIds: g.elemIds.filter((id) => id === g.firstElemId) }
        : g
    ),
  })),

  removeArrayGroup: (baseName) => set((s) => ({
    arrayGroups: s.arrayGroups.filter((g) => g.baseName !== baseName),
  })),

  reset: () => {
    clearSamplesBuffer(set, get)
    set({
      running: false,
      paused: false,
      starting: false,
      error: null,
      channels: [],
      arrayGroups: [],
      coreState: 'unknown',
      yNormalized: false,
      historyLoading: false,
      historyError: null,
    })
  },
}))
