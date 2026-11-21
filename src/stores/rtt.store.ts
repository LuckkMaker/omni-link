import { create } from 'zustand'
import type { RttChannel } from '@/services/rtt.service'
import type { LogEvent } from '@shared/types'
import type { ChecksumType } from '@/utils/checksum'

export type DisplayMode = 'text' | 'hex'

/** RTT 输入模式：bar=InputBar 发送，terminal=终端直接输入（支持 Tab/方向键/Ctrl 组合键等） */
export type InputMode = 'bar' | 'terminal'

/** RTT 控制块扫描模式：auto=自动检测，address=指定控制块地址，range=指定地址范围 */
export type RttScanMode = 'auto' | 'address' | 'range'

/** Tab 模式 */
export type TabMode = 'all' | 'single'

/** 多字符串条目 */
export interface MultiStringItem {
  id: string
  /** 内容（文本或 hex 字符串，由 isHex 决定解析方式） */
  content: string
  /** 是否以 hex 格式发送 */
  isHex: boolean
  /** 用户注释 */
  comment: string
  /** 是否启用发送 */
  enabled: boolean
  /** 发送顺序（从 0 开始） */
  order: number
  /** 发送延时（ms，每条独立，发送后等待此时长再发下一条） */
  delayMs: number
}

/** RTT 终端 Tab */
export interface RttTab {
  /** Tab 唯一 ID */
  id: string
  /** Tab 标题 */
  title: string
  /** 模式：all=所有通道，single=单通道 */
  mode: TabMode
  /** 通道索引（single 模式有效） */
  channel?: number
  /** 通道名称（single 模式有效，来自固件 SEGGER_RTT_ConfigUpBuffer 的 name） */
  channelName?: string
  /** 接收数据缓冲（Uint8Array 数组，用于保存到文件） */
  dataBuffer: Uint8Array[]
  /** 缓冲总大小（字节） */
  bufferSize: number
  /** 累计接收字节数 */
  bytesReceived: number
}

/** 生成唯一 Tab ID */
function genTabId(): string {
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 缓冲大小上限（10MB） */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024

// ── 输入模式偏好持久化 ──────────────────────────
const INPUT_MODE_KEY = 'rtt:inputMode'
const LOCAL_ECHO_KEY = 'rtt:localEcho'

// ── 发送配置持久化 ──────────────────────────
const SEND_HEX_KEY = 'rtt:sendHex'
const SEND_NEWLINE_KEY = 'rtt:sendNewline'
const SEND_TIMING_KEY = 'rtt:sendTiming'
const SEND_TIMING_INTERVAL_KEY = 'rtt:sendTimingInterval'
const SEND_CHECKSUM_KEY = 'rtt:sendChecksum'
const SEND_CHECKSUM_TYPE_KEY = 'rtt:sendChecksumType'
const SEND_CHECKSUM_START_KEY = 'rtt:sendChecksumStart'
const SEND_CHECKSUM_END_KEY = 'rtt:sendChecksumEnd'
const MULTI_STRINGS_KEY = 'rtt:multiStrings'

// ── 控制块扫描模式持久化 ──────────────────────────
const SCAN_MODE_KEY = 'rtt:scanMode'
const SCAN_ADDRESS_KEY = 'rtt:scanAddress'
const SCAN_SIZE_KEY = 'rtt:scanSize'

function loadScanMode(): RttScanMode {
  try {
    const v = localStorage.getItem(SCAN_MODE_KEY)
    if (v === 'auto' || v === 'address' || v === 'range') return v
  } catch { /* ignore */ }
  return 'auto'
}

function loadInputMode(): InputMode {
  try {
    const v = localStorage.getItem(INPUT_MODE_KEY)
    if (v === 'terminal' || v === 'bar') return v
  } catch { /* ignore */ }
  return 'bar'
}

function loadLocalEcho(): boolean {
  try {
    const v = localStorage.getItem(LOCAL_ECHO_KEY)
    if (v !== null) return v === '1'
  } catch { /* ignore */ }
  // 默认关闭：真实终端场景下位机 shell 会回显，无需本地回显
  return false
}

function loadBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return v === '1'
  } catch { /* ignore */ }
  return def
}

function loadNum(key: string, def: number): number {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) {
      const n = Number(v)
      if (!Number.isNaN(n)) return n
    }
  } catch { /* ignore */ }
  return def
}

function loadStr(key: string, def: string): string {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return v
  } catch { /* ignore */ }
  return def
}

function loadMultiStrings(): MultiStringItem[] {
  try {
    const v = localStorage.getItem(MULTI_STRINGS_KEY)
    if (v) {
      const arr = JSON.parse(v) as MultiStringItem[]
      if (Array.isArray(arr)) {
        // 兼容旧数据：无 delayMs 字段时默认 1000ms
        return arr.slice(0, 100).map((it) => ({
          ...it,
          delayMs: typeof it.delayMs === 'number' ? it.delayMs : 1000,
        }))
      }
    }
  } catch { /* ignore */ }
  return []
}

interface RttState {
  /** RTT 是否正在运行 */
  running: boolean
  /** 是否正在启动中 */
  starting: boolean
  /** up channels（target -> host） */
  upChannels: RttChannel[]
  /** down channels（host -> target） */
  downChannels: RttChannel[]
  /** 选中的 up channel（兼容旧逻辑，用于启动时指定） */
  selectedUpChannel: number
  /** 选中的 down channel（用于发送） */
  selectedDownChannel: number
  /** 接收到的字节数（总计） */
  bytesReceived: number
  /** 发送的字节数 */
  bytesSent: number
  /** 错误信息 */
  error: string | null
  /** 显示模式 */
  displayMode: DisplayMode
  /** 输入模式：bar=InputBar 发送，terminal=终端直接输入 */
  inputMode: InputMode
  /** 本地回显（仅 terminal 输入模式生效；下位机不回显时使用） */
  localEcho: boolean
  /** 是否自动换行 */
  autoWrap: boolean

  // ── 控制块扫描 ──────────────────────────
  /** 控制块扫描模式 */
  scanMode: RttScanMode
  /** 指定地址（address/range 模式生效） */
  scanAddress: number
  /** 扫描范围大小（range 模式生效） */
  scanSize: number

  // ── 发送配置 ──────────────────────────
  /** hex 发送模式 */
  sendHex: boolean
  /** 发送时追加换行 */
  sendNewline: boolean
  /** 定时发送开关 */
  sendTiming: boolean
  /** 定时发送间隔（ms） */
  sendTimingInterval: number
  /** 加校验开关 */
  sendChecksum: boolean
  /** 校验类型 */
  sendChecksumType: ChecksumType
  /** 校验起始字节索引（0-based，含） */
  sendChecksumStart: number
  /** 校验结束字节索引（-1=末尾，否则 0-based 含） */
  sendChecksumEnd: number

  // ── 接收到文件 ──────────────────────────
  /** 是否正在把接收数据写入文件 */
  recordToFile: boolean
  /** 当前录制文件名（仅显示用） */
  recordFileName: string | null

  // ── 多字符串 ──────────────────────────
  /** 多字符串列表（上限 100） */
  multiStrings: MultiStringItem[]
  /** 多字符串发送间隔（ms） */
  multiStringInterval: number

  /** RTT 日志 */
  logs: LogEvent[]

  /** 多终端 Tab 列表 */
  tabs: RttTab[]
  /** 当前激活的 Tab ID */
  activeTabId: string

  setRunning: (running: boolean) => void
  setStarting: (starting: boolean) => void
  setChannels: (up: RttChannel[], down: RttChannel[]) => void
  setSelectedUpChannel: (ch: number) => void
  setSelectedDownChannel: (ch: number) => void
  addBytesReceived: (n: number) => void
  addBytesSent: (n: number) => void
  /** 重置全局收发字节统计（清空操作时调用） */
  resetStats: () => void
  setError: (error: string | null) => void
  setDisplayMode: (mode: DisplayMode) => void
  setInputMode: (mode: InputMode) => void
  setLocalEcho: (on: boolean) => void
  setAutoWrap: (autoWrap: boolean) => void

  // 控制块扫描 setter
  setScanMode: (mode: RttScanMode) => void
  setScanAddress: (address: number) => void
  setScanSize: (size: number) => void

  addLog: (log: LogEvent) => void
  clearLogs: () => void
  reset: () => void

  // 发送配置 setter
  setSendHex: (on: boolean) => void
  setSendNewline: (on: boolean) => void
  setSendTiming: (on: boolean) => void
  setSendTimingInterval: (n: number) => void
  setSendChecksum: (on: boolean) => void
  setSendChecksumType: (t: ChecksumType) => void
  setSendChecksumStart: (n: number) => void
  setSendChecksumEnd: (n: number) => void

  // 接收到文件 setter
  setRecordToFile: (on: boolean, fileName?: string | null) => void

  // 多字符串 setter
  addMultiString: (item: Omit<MultiStringItem, 'id' | 'order'>) => void
  updateMultiString: (id: string, patch: Partial<Omit<MultiStringItem, 'id'>>) => void
  removeMultiString: (id: string) => void
  reorderMultiStrings: (id: string, direction: 'up' | 'down') => void
  setMultiStringInterval: (n: number) => void

  /** 向指定 Tab 追加数据 */
  appendTabData: (tabId: string, data: Uint8Array) => void
  /** 清空指定 Tab 的数据缓冲 */
  clearTabData: (tabId: string) => void
  /** 获取指定 Tab 的数据缓冲（拼接为单个 Uint8Array） */
  getTabData: (tabId: string) => Uint8Array
  /** 添加新 Tab（单通道模式） */
  addTab: (channel: number, channelName?: string) => string
  /** 关闭 Tab */
  removeTab: (tabId: string) => void
  /** 设置激活 Tab */
  setActiveTab: (tabId: string) => void
  /** 重置 Tab（启动新会话时） */
  resetTabs: () => void
}

/** 创建初始 All Channel Tab */
function createAllChannelTab(): RttTab {
  return {
    id: 'all',
    title: 'All Channel',
    mode: 'all',
    dataBuffer: [],
    bufferSize: 0,
    bytesReceived: 0,
  }
}

export const useRttStore = create<RttState>((set, get) => ({
  running: false,
  starting: false,
  upChannels: [],
  downChannels: [],
  selectedUpChannel: 0,
  selectedDownChannel: 0,
  bytesReceived: 0,
  bytesSent: 0,
  error: null,
  displayMode: 'text',
  inputMode: loadInputMode(),
  localEcho: loadLocalEcho(),
  autoWrap: true,

  // 控制块扫描（持久化）
  scanMode: loadScanMode(),
  scanAddress: loadNum(SCAN_ADDRESS_KEY, 0x20000000),
  scanSize: loadNum(SCAN_SIZE_KEY, 0x4000),

  // 发送配置初始值（持久化）
  sendHex: loadBool(SEND_HEX_KEY, false),
  sendNewline: loadBool(SEND_NEWLINE_KEY, true),
  sendTiming: loadBool(SEND_TIMING_KEY, false),
  sendTimingInterval: loadNum(SEND_TIMING_INTERVAL_KEY, 1000),
  sendChecksum: loadBool(SEND_CHECKSUM_KEY, false),
  sendChecksumType: (loadStr(SEND_CHECKSUM_TYPE_KEY, 'modbus-crc16') as ChecksumType),
  sendChecksumStart: loadNum(SEND_CHECKSUM_START_KEY, 0),
  sendChecksumEnd: loadNum(SEND_CHECKSUM_END_KEY, -1),

  // 接收到文件
  recordToFile: false,
  recordFileName: null,

  // 多字符串
  multiStrings: loadMultiStrings(),
  multiStringInterval: loadNum('rtt:multiStringInterval', 1000),
  logs: [],

  tabs: [createAllChannelTab()],
  activeTabId: 'all',

  setRunning: (running) => set({ running }),
  setStarting: (starting) => set({ starting }),
  setChannels: (up, down) => set({ upChannels: up, downChannels: down }),
  setSelectedUpChannel: (ch) => set({ selectedUpChannel: ch }),
  setSelectedDownChannel: (ch) => set({ selectedDownChannel: ch }),
  addBytesReceived: (n) => set((s) => ({ bytesReceived: s.bytesReceived + n })),
  addBytesSent: (n) => set((s) => ({ bytesSent: s.bytesSent + n })),
  resetStats: () => set({ bytesReceived: 0, bytesSent: 0 }),
  setError: (error) => set({ error }),
  setDisplayMode: (mode) => set({ displayMode: mode }),
  setInputMode: (mode) => {
    try { localStorage.setItem(INPUT_MODE_KEY, mode) } catch { /* ignore */ }
    set({ inputMode: mode })
  },
  setLocalEcho: (on) => {
    try { localStorage.setItem(LOCAL_ECHO_KEY, on ? '1' : '0') } catch { /* ignore */ }
    set({ localEcho: on })
  },
  setAutoWrap: (autoWrap) => set({ autoWrap }),

  // 控制块扫描 setter（带持久化）
  setScanMode: (mode) => {
    try { localStorage.setItem(SCAN_MODE_KEY, mode) } catch { /* ignore */ }
    set({ scanMode: mode })
  },
  setScanAddress: (address) => {
    const v = Math.max(0, Math.floor(address))
    try { localStorage.setItem(SCAN_ADDRESS_KEY, String(v)) } catch { /* ignore */ }
    set({ scanAddress: v })
  },
  setScanSize: (size) => {
    const v = Math.max(1, Math.floor(size))
    try { localStorage.setItem(SCAN_SIZE_KEY, String(v)) } catch { /* ignore */ }
    set({ scanSize: v })
  },

  // 发送配置 setter（带持久化）
  setSendHex: (on) => {
    try { localStorage.setItem(SEND_HEX_KEY, on ? '1' : '0') } catch { /* ignore */ }
    set({ sendHex: on })
  },
  setSendNewline: (on) => {
    try { localStorage.setItem(SEND_NEWLINE_KEY, on ? '1' : '0') } catch { /* ignore */ }
    set({ sendNewline: on })
  },
  setSendTiming: (on) => {
    try { localStorage.setItem(SEND_TIMING_KEY, on ? '1' : '0') } catch { /* ignore */ }
    set({ sendTiming: on })
  },
  setSendTimingInterval: (n) => {
    const v = Math.max(10, Math.min(60000, Math.floor(n)))
    try { localStorage.setItem(SEND_TIMING_INTERVAL_KEY, String(v)) } catch { /* ignore */ }
    set({ sendTimingInterval: v })
  },
  setSendChecksum: (on) => {
    try { localStorage.setItem(SEND_CHECKSUM_KEY, on ? '1' : '0') } catch { /* ignore */ }
    set({ sendChecksum: on })
  },
  setSendChecksumType: (t) => {
    try { localStorage.setItem(SEND_CHECKSUM_TYPE_KEY, t) } catch { /* ignore */ }
    set({ sendChecksumType: t })
  },
  setSendChecksumStart: (n) => {
    try { localStorage.setItem(SEND_CHECKSUM_START_KEY, String(n)) } catch { /* ignore */ }
    set({ sendChecksumStart: n })
  },
  setSendChecksumEnd: (n) => {
    try { localStorage.setItem(SEND_CHECKSUM_END_KEY, String(n)) } catch { /* ignore */ }
    set({ sendChecksumEnd: n })
  },

  // 接收到文件 setter
  setRecordToFile: (on, fileName) => set({
    recordToFile: on,
    recordFileName: fileName ?? (on ? null : null),
  }),

  // 多字符串 setter
  addMultiString: (item) => set((s) => {
    if (s.multiStrings.length >= 100) return s
    const id = `ms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const order = s.multiStrings.length
    const next = [...s.multiStrings, { ...item, id, order, delayMs: item.delayMs ?? 1000 }]
    try { localStorage.setItem(MULTI_STRINGS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    return { multiStrings: next }
  }),
  updateMultiString: (id, patch) => set((s) => {
    const next = s.multiStrings.map((it) => it.id === id ? { ...it, ...patch } : it)
    try { localStorage.setItem(MULTI_STRINGS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    return { multiStrings: next }
  }),
  removeMultiString: (id) => set((s) => {
    const filtered = s.multiStrings.filter((it) => it.id !== id)
    // 重新编号 order
    const next = filtered.map((it, idx) => ({ ...it, order: idx }))
    try { localStorage.setItem(MULTI_STRINGS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    return { multiStrings: next }
  }),
  reorderMultiStrings: (id, direction) => set((s) => {
    const arr = [...s.multiStrings].sort((a, b) => a.order - b.order)
    const idx = arr.findIndex((it) => it.id === id)
    if (idx < 0) return s
    const target = direction === 'up' ? idx - 1 : idx + 1
    if (target < 0 || target >= arr.length) return s
    ;[arr[idx], arr[target]] = [arr[target], arr[idx]]
    const next = arr.map((it, i) => ({ ...it, order: i }))
    try { localStorage.setItem(MULTI_STRINGS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    return { multiStrings: next }
  }),
  setMultiStringInterval: (n) => {
    const v = Math.max(0, Math.min(60000, Math.floor(n)))
    try { localStorage.setItem('rtt:multiStringInterval', String(v)) } catch { /* ignore */ }
    set({ multiStringInterval: v })
  },
  addLog: (log) => set((s) => ({ logs: [...s.logs, log].slice(-500) })),
  clearLogs: () => set({ logs: [] }),
  reset: () =>
    set({
      running: false,
      starting: false,
      upChannels: [],
      downChannels: [],
      selectedUpChannel: 0,
      selectedDownChannel: 0,
      bytesReceived: 0,
      bytesSent: 0,
      error: null,
      tabs: [createAllChannelTab()],
      activeTabId: 'all',
    }),

  appendTabData: (tabId, data) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        const newBuffer = [...tab.dataBuffer, data]
        let newSize = tab.bufferSize + data.length
        // 超限时移除旧数据
        while (newSize > MAX_BUFFER_SIZE && newBuffer.length > 1) {
          const removed = newBuffer.shift()!
          newSize -= removed.length
        }
        return {
          ...tab,
          dataBuffer: newBuffer,
          bufferSize: newSize,
          bytesReceived: tab.bytesReceived + data.length,
        }
      }),
    })),

  clearTabData: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, dataBuffer: [], bufferSize: 0, bytesReceived: 0 }
          : tab
      ),
    })),

  getTabData: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return new Uint8Array(0)
    const total = tab.dataBuffer.reduce((sum, b) => sum + b.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const buf of tab.dataBuffer) {
      result.set(buf, offset)
      offset += buf.length
    }
    return result
  },

  addTab: (channel, channelName) => {
    const id = genTabId()
    // 标题统一为 Channel N，不附加通道名，避免不同通道显示风格不一致
    const title = `Channel ${channel}`
    set((s) => ({
      tabs: [...s.tabs, {
        id,
        title,
        mode: 'single' as const,
        channel,
        // 通道名存入 channelName 字段，供 Tab tooltip 显示
        channelName: channelName,
        dataBuffer: [],
        bufferSize: 0,
        bytesReceived: 0,
      }],
      activeTabId: id,
    }))
    return id
  },

  removeTab: (tabId) =>
    set((s) => {
      // 不允许关闭 All Channel tab
      if (tabId === 'all') return s
      const newTabs = s.tabs.filter((t) => t.id !== tabId)
      const newActive = s.activeTabId === tabId ? 'all' : s.activeTabId
      return { tabs: newTabs, activeTabId: newActive }
    }),

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  resetTabs: () => set({ tabs: [createAllChannelTab()], activeTabId: 'all' }),
}))
