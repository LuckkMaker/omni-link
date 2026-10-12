import { create } from 'zustand'
import { parseFile, readFile } from '@/services/file.service'
import { useLogStore } from '@/stores/log.store'
import { useNotificationStore } from '@/stores/notification.store'
import {
  omniToolErrorMessage,
  omniToolService,
  type OmniFlasherStatus,
  type OmniProgress,
} from './service'

/** 目标芯片 Flash 起点（与后端 FLASHER_TARGETS 对齐，当前仅 stm32f407ig） */
const TARGET_FLASH_BASE = 0x08000000

/** 已选镜像文件 */
export interface FlasherImage {
  path: string
  title: string
  format: 'bin' | 'hex'
  size: number
  /** 起始地址：.bin 用目标 Flash 起点，.hex 用文件自带地址 */
  address: number
  /** base64 数据，供 Hex 预览 */
  data: string | null
  loading: boolean
}

export interface FlasherResult {
  address: number
  size: number
  verified: boolean
}

interface FlasherStore {
  /** 后端可用性（是否连着 app 设备、支持哪些型号） */
  status: OmniFlasherStatus | null
  /** 当前选中的目标型号 */
  target: string
  /** 已加载的镜像（单文件：一次烧一个目标） */
  image: FlasherImage | null
  /** 烧录选项 */
  chipErase: boolean
  readbackVerify: boolean
  busy: boolean
  /** 最近一次烧录结果（页面内持续展示） */
  lastResult: FlasherResult | null

  refreshStatus: () => Promise<void>
  setTarget: (target: string) => void
  setChipErase: (v: boolean) => void
  setReadbackVerify: (v: boolean) => void
  openImage: () => Promise<void>
  clearImage: () => void
  startFlash: () => Promise<void>
  recover: () => Promise<void>
  onProgress: (p: OmniProgress) => void
}

function log(level: 'info' | 'warning' | 'error', message: string): void {
  useLogStore.getState().addLog({
    timestamp: new Date().toISOString(),
    level,
    message,
    source: 'omni-flasher',
  })
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase()}`
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** 烧录各阶段中文标签（与后端 _FLASHER_STAGE_SPAN 的 stage 对应） */
const STAGE_LABEL: Record<string, string> = {
  mode: '切换模式',
  open: '开启会话',
  erase: '整片擦除',
  write: '写入',
  verify: '回读校验',
  close: '关闭会话',
}

/** 当前烧录操作的进度通知 id */
let activeNotifId: string | null = null

export const useFlasherStore = create<FlasherStore>((set, get) => ({
  status: null,
  target: 'stm32f407ig',
  image: null,
  chipErase: true,
  readbackVerify: true,
  busy: false,
  lastResult: null,

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
      set((s) => ({
        status,
        // 后端支持的型号为准；当前仅 stm32f407ig
        target: status.targets.includes(s.target) ? s.target : (status.targets[0] ?? s.target),
      }))
    } catch (e) {
      log('error', `读取烧录器状态失败：${omniToolErrorMessage(e)}`)
    }
  },

  setTarget: (target) => set({ target }),
  setChipErase: (chipErase) => set({ chipErase }),
  setReadbackVerify: (readbackVerify) => set({ readbackVerify }),

  clearImage: () => set({ image: null, lastResult: null }),

  openImage: async () => {
    const path = await window.electron?.openFileDialog?.({
      extensions: ['bin', 'hex'],
      title: '选择要烧录到目标芯片的固件 (.bin / .hex)',
    })
    if (!path) return

    const title = path.split(/[\\/]/).pop() ?? path
    set({
      image: {
        path,
        title,
        format: path.toLowerCase().endsWith('.hex') ? 'hex' : 'bin',
        size: 0,
        address: TARGET_FLASH_BASE,
        data: null,
        loading: true,
      },
      lastResult: null,
    })

    try {
      const [info, data] = await Promise.all([parseFile(path), readFile(path)])
      // .hex 自带起始地址；.bin 不含地址，烧到目标 Flash 起点
      const format: 'bin' | 'hex' = info.format === 'hex' ? 'hex' : 'bin'
      const address = format === 'hex' ? (data.base_address || TARGET_FLASH_BASE) : TARGET_FLASH_BASE
      set((s) =>
        s.image?.path === path
          ? { image: { ...s.image, data: data.data, size: data.size, loading: false, format, address } }
          : {}
      )
      log('info', `已加载 ${title}（${formatBytes(data.size)}）@ ${formatHex(address)}`)
    } catch (e) {
      log('error', `加载固件失败：${omniToolErrorMessage(e)}`)
      set((s) => (s.image?.path === path ? { image: null } : {}))
    }
  },

  startFlash: async () => {
    const { image, target, chipErase, readbackVerify, status } = get()

    if (!status?.available) {
      log('error', '请先在顶部设备栏连接 app 模式的 OMNI Tool')
      return
    }
    if (!image || !image.path || image.loading) {
      log('error', '请先选择要烧录的固件文件')
      return
    }

    set({ busy: true })
    activeNotifId = useNotificationStore.getState().push({
      type: 'progress',
      title: '在线烧录',
      message: '正在切换到 FLASHER 模式...',
      progress: 0,
      autoClose: false,
    })
    try {
      const res = await omniToolService.flasherFlash(image.path, {
        address: image.address,
        target,
        erase: chipErase,
        verify: readbackVerify,
      })
      set({ lastResult: { address: res.address, size: res.size, verified: res.verified } })
      log('info', `在线烧录完成：${formatBytes(res.size)} @ ${formatHex(res.address)}${res.verified ? '（校验通过）' : '（未校验）'}`)
      useNotificationStore.getState().update(activeNotifId, {
        type: 'success',
        title: '烧录完成',
        message: `${formatBytes(res.size)} @ ${formatHex(res.address)}${res.verified ? ' · 校验通过' : ''}`,
        progress: 100,
        autoClose: true,
        autoCloseDelay: 4000,
      })
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `在线烧录失败：${msg}`)
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