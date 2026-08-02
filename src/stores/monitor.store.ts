import { create } from 'zustand'
import type { MonitorVariable, SamplePoint, MonitorVarType } from '@/services/monitor.service'

/** 前端 ring buffer 容量上限（与后端对齐，5.2 阶段 uPlot 渲染用） */
const MAX_SAMPLES = 100000

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

  // ── 显示配置 ──
  follow: boolean
  /** 时基窗口（秒），Follow/触发模式下显示的窗口宽度，如 0.001=1ms, 1=1s */
  timebase: number
  /** 波形图渲染帧率（FPS），控制重绘频率，默认 30 */
  fps: number
  channels: ChannelConfig[]

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

function makeChannel(varId: string, index: number): ChannelConfig {
  return {
    varId,
    color: PALETTE[index % PALETTE.length],
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

  follow: true,
  timebase: 1,
  fps: 30,
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

  syncChannels: () => set((s) => {
    const existing = new Map(s.channels.map((c) => [c.varId, c]))
    const channels = s.variables.map((v, i) =>
      existing.get(v.id) ?? makeChannel(v.id, i)
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
    })
  },
}))
