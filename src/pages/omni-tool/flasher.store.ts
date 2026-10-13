import { create } from 'zustand'
import { readFile } from '@/services/file.service'
import { useLogStore } from '@/stores/log.store'
import { useNotificationStore } from '@/stores/notification.store'
import {
  omniToolErrorMessage,
  omniToolService,
  type OmniFlasherSegment,
  type OmniFlasherStatus,
  type OmniProgress,
} from './service'

/** 目标芯片默认 Flash 起点（与后端 FLASHER_TARGETS 对齐） */
const TARGET_FLASH_BASE = 0x08000000

/** FLM（Flash 编程算法）来源 */
export type FlmSource = 'builtin' | 'file'

/** 一个可选的目标芯片 */
export interface FlasherTarget {
  /** 芯片标识（后端 target 参数） */
  id: string
  /** 显示名 */
  name: string
  /** Flash 区间 */
  flashBase: number
  flashEnd: number
  /** 是否可用（当前仅内置 FLM 的型号可用） */
  available: boolean
  /** 不可用时的原因 */
  unavailableReason?: string
}

/**
 * 可选目标芯片列表。
 *
 * 当前固件 `FLASHER_PLAN` 阶段 B（在线下发 FLM）尚未实现，FLM 由固件内置，
 * 所以只有 stm32f407ig 可用；其余为预留位，固件支持在线 FLM 后即可启用。
 */
export const FLASHER_TARGETS_UI: FlasherTarget[] = [
  {
    id: 'stm32f407ig',
    name: 'STM32F407IG',
    flashBase: TARGET_FLASH_BASE,
    flashEnd: 0x08100000,
    available: true,
  },
  {
    id: 'reserved-1',
    name: '其它型号',
    flashBase: 0,
    flashEnd: 0,
    available: false,
    unavailableReason: '需固件支持在线下发 FLM（FLASHER_PLAN 阶段 B）',
  },
]

/** 已选镜像的解析结果 */
export interface FlasherTab {
  id: string
  /** 文件路径 */
  path: string
  /** 文件名 */
  title: string
  /** 后端按内容嗅探出的真实格式 */
  format: 'bin' | 'hex'
  /** 文件原始字节数 */
  fileSize: number
  /** 解出的有效数据字节数 */
  size: number
  /** 起始地址：hex 取文件自带首段地址；bin 用用户输入/目标 Flash 起点 */
  address: number
  /** base64 数据，供 Hex 预览 */
  data: string | null
  /** 地址段（hex 可能多段） */
  segments: OmniFlasherSegment[]
  /** 整镜像 CRC32（固件侧校验用） */
  crc32: number
  loading: boolean
  /** 用户手动改写的目标地址（hex 不适用） */
  addrOverride: string
  /** 按 tab 记忆的视图状态 */
  byteWidth: 1 | 2 | 4
  jumpAddr: string
  scrollTop: number
  highlightOffset: number | null
}

interface FlasherStore {
  /** 后端可用性（是否连着 app 设备、支持哪些型号） */
  status: OmniFlasherStatus | null
  /** 可选目标芯片列表（内置 + 预留） */
  targets: FlasherTarget[]
  /** 当前选中的目标芯片 id */
  targetId: string
  /** 目标芯片选择对话框是否打开 */
  showTargetDialog: boolean
  /** FLM 来源：内置（固件硬编码）/ 外部文件（预留，固件暂不支持） */
  flmSource: FlmSource
  /** 外部 FLM 文件路径（仅 flmSource='file'） */
  flmPath: string | null
  /** 外部 FLM 文件名 */
  flmName: string | null

  /** 文件 tab 列表（可多开，各自带地址设置） */
  tabs: FlasherTab[]
  activeTabId: string | null

  /** 烧录前整片擦除（默认关：固件 flash manager 会做扇区懒擦除） */
  chipErase: boolean
  readbackVerify: boolean
  busy: boolean

  refreshStatus: () => Promise<void>
  openTargetDialog: () => void
  closeTargetDialog: () => void
  setTarget: (id: string) => void
  /** 选择外部 FLM 文件（预留：固件暂不支持在线下发 FLM） */
  pickFlmFile: () => Promise<void>
  clearFlmFile: () => void
  setChipErase: (v: boolean) => void
  setReadbackVerify: (v: boolean) => void
  openFileTab: () => Promise<void>
  selectTab: (id: string) => void
  closeTab: (id: string) => void
  updateTab: (id: string, patch: Partial<FlasherTab>) => void
  /** 提交地址改写，重新解析并刷新预览 */
  applyAddress: (id: string) => Promise<void>
  startFlash: (tabId?: string) => Promise<void>
  recover: () => Promise<void>
  onProgress: (p: OmniProgress) => void
}

let tabSeq = 0
function genTabId(): string {
  return `flasher-${++tabSeq}`
}

function log(level: 'info' | 'warning' | 'error', message: string): void {
  useLogStore.getState().addLog({
    timestamp: new Date().toISOString(),
    level,
    message,
    source: 'omni-flasher',
  })
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/** 解析用户输入的地址（支持 0x 前缀与十进制） */
export function parseAddress(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const addr = parseInt(trimmed, trimmed.toLowerCase().startsWith('0x') ? 16 : 10)
  return Number.isNaN(addr) || addr < 0 ? null : addr
}

/** 烧录各阶段中文标签（与后端 _FLASHER_STAGE_SPAN 的 stage 对应） */
const STAGE_LABEL: Record<string, string> = {
  mode: '切换模式',
  open: '开启会话',
  erase: '整片擦除',
  write: '下发镜像',
  verify: '校验',
  close: '关闭会话',
}

/** 当前烧录操作的进度通知 id */
let activeNotifId: string | null = null

export const useFlasherStore = create<FlasherStore>((set, get) => ({
  status: null,
  targets: FLASHER_TARGETS_UI,
  targetId: FLASHER_TARGETS_UI[0].id,
  showTargetDialog: false,
  flmSource: 'builtin',
  flmPath: null,
  flmName: null,

  tabs: [],
  activeTabId: null,

  chipErase: false,
  readbackVerify: true,
  busy: false,

  onProgress: (p) => {
    if (!activeNotifId) return
    const label = STAGE_LABEL[p.stage] ?? p.stage
    const detail = p.total > 0 ? ` ${formatBytes(p.current)} / ${formatBytes(p.total)}` : ''
    useNotificationStore.getState().update(activeNotifId, {
      progress: Math.max(0, Math.min(100, p.percent)),
      message: `${label}...${detail || p.message}`,
    })
  },

  refreshStatus: async () => {
    try {
      const status = await omniToolService.flasherStatus()
      set((s) => {
        // 后端支持的型号为准；当前仅 stm32f407ig
        const valid = s.targets.some((t) => t.id === s.targetId)
        const fallback = s.targets.find((t) => status.targets.includes(t.id))
        return {
          status,
          targetId: valid ? s.targetId : (fallback?.id ?? s.targetId),
        }
      })
    } catch (e) {
      log('error', `读取烧录器状态失败：${omniToolErrorMessage(e)}`)
    }
  },

  openTargetDialog: () => set({ showTargetDialog: true }),
  closeTargetDialog: () => set({ showTargetDialog: false }),
  setTarget: (targetId) => set({ targetId, showTargetDialog: false }),

  pickFlmFile: async () => {
    const path = await window.electron?.openFileDialog?.({
      extensions: ['flm'],
      title: '选择目标的 FLM 编程算法文件',
    })
    if (!path) return
    const name = path.split(/[\\/]/).pop() ?? path
    set({ flmSource: 'file', flmPath: path, flmName: name })
    // 固件尚不支持在线下发 FLM，这一步只是把选择记录下来，实际烧录仍用内置 FLM
    log(
      'warning',
      `已选择外部 FLM：${name}。当前固件暂不支持在线下发 FLM，烧录仍将使用内置算法`
    )
  },

  clearFlmFile: () => set({ flmSource: 'builtin', flmPath: null, flmName: null }),

  setChipErase: (chipErase) => set({ chipErase }),
  setReadbackVerify: (readbackVerify) => set({ readbackVerify }),

  selectTab: (id) => set({ activeTabId: id }),

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx < 0) return {}
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    }),

  updateTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  openFileTab: async () => {
    const path = await window.electron?.openFileDialog?.({
      extensions: ['bin', 'hex'],
      title: '选择要烧录到目标芯片的固件 (.bin / .hex)',
    })
    if (!path) return

    const title = path.split(/[\\/]/).pop() ?? path
    const target = get().targets.find((t) => t.id === get().targetId)
    const id = genTabId()
    const tab: FlasherTab = {
      id,
      path,
      title,
      format: 'bin',
      fileSize: 0,
      size: 0,
      address: target?.flashBase ?? TARGET_FLASH_BASE,
      data: null,
      segments: [],
      crc32: 0,
      loading: true,
      addrOverride: '',
      byteWidth: 1,
      jumpAddr: '',
      scrollTop: 0,
      highlightOffset: null,
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))

    // 解析 + 读取预览
    try {
      const [info, data] = await Promise.all([
        omniToolService.flasherAnalyze(path),
        readFile(path),
      ])
      const format: 'bin' | 'hex' = info.is_hex ? 'hex' : 'bin'
      const address = info.segments[0]?.address ?? target?.flashBase ?? TARGET_FLASH_BASE
      get().updateTab(id, {
        data: data.data,
        format,
        address,
        fileSize: info.file_size,
        size: info.total,
        segments: info.segments,
        crc32: info.crc32,
        loading: false,
      })
      log(
        'info',
        `已加载 ${title}：${format === 'hex' ? 'HEX' : 'BIN'}，` +
          `${formatBytes(info.total)} @ ${formatHex(address)}，` +
          `CRC32=0x${info.crc32.toString(16).toUpperCase()}`
      )
    } catch (e) {
      log('error', `加载固件失败：${omniToolErrorMessage(e)}`)
      get().closeTab(id)
    }
  },

  applyAddress: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    const trimmed = tab.addrOverride.trim()
    if (!trimmed) {
      // 清空则回到文件自带地址（hex）或目标 Flash 起点（bin）
      const target = get().targets.find((t) => t.id === get().targetId)
      const fallback = tab.format === 'hex'
        ? tab.segments[0]?.address ?? TARGET_FLASH_BASE
        : target?.flashBase ?? TARGET_FLASH_BASE
      get().updateTab(id, { address: fallback, addrOverride: '' })
      return
    }

    const addr = parseAddress(trimmed)
    if (addr === null) {
      log('error', `地址格式无效：${trimmed}（示例 0x08000000）`)
      return
    }
    if (tab.format === 'hex') {
      log('warning', 'HEX 文件自带地址，固件会从记录里解析，忽略手动地址')
      get().updateTab(id, { addrOverride: '' })
      return
    }

    try {
      const info = await omniToolService.flasherAnalyze(tab.path, addr)
      get().updateTab(id, {
        address: info.segments[0]?.address ?? addr,
        segments: info.segments,
        size: info.total,
        crc32: info.crc32,
      })
      log('info', `${tab.title} 起始地址设为 ${formatHex(addr)}`)
    } catch (e) {
      log('error', `设置地址失败：${omniToolErrorMessage(e)}`)
    }
  },

  startFlash: async (tabId) => {
    const { tabs, activeTabId, targetId, targets, chipErase, readbackVerify, status } = get()
    const tab = tabs.find((t) => t.id === (tabId ?? activeTabId))
    const target = targets.find((t) => t.id === targetId)

    if (!status?.available) {
      log('error', '请先在顶部设备栏连接 app 模式的 OMNI Tool')
      return
    }
    if (!tab || tab.loading) {
      log('error', '请先通过 + 选择要烧录的固件文件')
      return
    }
    if (!target || !target.available) {
      log('error', target?.unavailableReason ?? '请先选择可用的目标芯片')
      return
    }

    set({ busy: true })
    activeNotifId = useNotificationStore.getState().push({
      type: 'progress',
      title: `烧录 ${target.name}`,
      message: '正在切换到 FLASHER 模式...',
      progress: 0,
      autoClose: false,
    })
    try {
      const res = await omniToolService.flasherFlash(tab.path, {
        address: tab.format === 'hex' ? undefined : tab.address,
        target: target.id,
        erase: chipErase,
        verify: readbackVerify,
      })
      log(
        'info',
        `烧录完成 ${target.name}：${tab.format.toUpperCase()} ` +
          `${formatBytes(res.size)} @ ${formatHex(res.address)}` +
          `${res.verified ? '（校验通过）' : '（未校验）'}`
      )
      useNotificationStore.getState().update(activeNotifId, {
        type: 'success',
        title: '烧录完成',
        message:
          `${target.name} · ${formatBytes(res.size)} @ ${formatHex(res.address)}` +
          `${res.verified ? ' · 校验通过' : ''}`,
        progress: 100,
        autoClose: true,
        autoCloseDelay: 4000,
      })
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `烧录失败：${msg}`)
      useNotificationStore.getState().update(activeNotifId, {
        type: 'error',
        title: '烧录失败',
        message: msg,
        autoClose: true,
        autoCloseDelay: 8000,
      })
    } finally {
      activeNotifId = null
      set({ busy: false })
    }
  },

  recover: async () => {
    set({ busy: true })
    try {
      await omniToolService.flasherRecover()
      log('info', '已执行 RECOVER：目标已复位，SWD 链路已重建，可直接重试烧录')
      useNotificationStore.getState().push({
        type: 'success',
        title: '已恢复',
        message: '目标已复位，SWD 链路已重建，可直接重新烧录',
      })
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `恢复失败：${msg}`)
      useNotificationStore.getState().push({ type: 'error', title: '恢复失败', message: msg })
    } finally {
      set({ busy: false })
    }
  },
}))