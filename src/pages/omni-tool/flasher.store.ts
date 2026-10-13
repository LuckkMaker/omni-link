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

/** 目标芯片 Flash 起点（与后端 FLASHER_TARGETS 对齐，当前仅 stm32f407ig） */
const TARGET_FLASH_BASE = 0x08000000

/** 已选镜像文件 */
export interface FlasherImage {
  path: string
  title: string
  /** 后端按内容嗅探出的真实格式（比扩展名可靠） */
  format: 'bin' | 'hex'
  /** 文件原始字节数 */
  fileSize: number
  /** 解出的有效数据字节数（hex 通常远小于文件大小） */
  size: number
  /** 起始地址：hex 取文件自带首段地址，bin 用目标 Flash 起点 */
  address: number
  /** base64 数据，供 Hex 预览 */
  data: string | null
  /** 地址段（hex 可能多段） */
  segments: OmniFlasherSegment[]
  /** 整镜像 CRC32（固件侧校验用） */
  crc32: number
  loading: boolean
}

export interface FlasherResult {
  address: number
  size: number
  verified: boolean
  isHex: boolean
  segments: number
}

interface FlasherStore {
  /** 后端可用性（是否连着 app 设备、支持哪些型号） */
  status: OmniFlasherStatus | null
  /** 当前选中的目标型号 */
  target: string
  /** 已加载的镜像（单文件：一次烧一个目标） */
  image: FlasherImage | null
  /** 烧录前先整片擦除（默认关：固件 flash manager 会做扇区懒擦除） */
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
  // 默认不整片擦除：固件 flash manager 会做扇区懒擦除（跨扇区才擦），
  // 与 verify_flash.py 的默认行为一致，也更快。
  chipErase: false,
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
        format: 'bin',
        fileSize: 0,
        size: 0,
        address: TARGET_FLASH_BASE,
        data: null,
        segments: [],
        crc32: 0,
        loading: true,
      },
      lastResult: null,
    })

    try {
      // 后端按**内容**判定格式（扩展名不可靠），顺带做 hex 合法性校验与 CRC32 计算。
      // 先 analyze 再读预览：analyze 失败说明文件本身有问题，别浪费一次读文件。
      const info = await omniToolService.flasherAnalyze(path)
      const data = await readFile(path)
      const format: 'bin' | 'hex' = info.is_hex ? 'hex' : 'bin'
      const address = info.segments[0]?.address ?? TARGET_FLASH_BASE
      set((s) =>
        s.image?.path === path
          ? {
              image: {
                ...s.image,
                data: data.data,
                format,
                address,
                fileSize: info.file_size,
                size: info.total,
                segments: info.segments,
                crc32: info.crc32,
                loading: false,
              },
            }
          : {}
      )
      const segDesc =
        info.segments.length > 1
          ? `${info.segments.length} 段（${formatHex(address)} 起）`
          : formatHex(address)
      log(
        'info',
        `已加载 ${title}：${info.is_hex ? 'HEX 直烧（模式 B）' : 'BIN（模式 A）'}，` +
          `${formatBytes(info.total)} @ ${segDesc}，CRC32=0x${info.crc32.toString(16).toUpperCase()}`
      )
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `加载固件失败：${msg}`)
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
      set({
        lastResult: {
          address: res.address,
          size: res.size,
          verified: res.verified,
          isHex: res.is_hex ?? image.format === 'hex',
          segments: res.segments ?? image.segments.length,
        },
      })
      log(
        'info',
        `在线烧录完成（${res.is_hex ? 'HEX' : 'BIN'} 镜像模式）：` +
          `${formatBytes(res.size)} @ ${formatHex(res.address)}` +
          `${res.verified ? '（校验通过）' : '（未校验）'}`
      )
      useNotificationStore.getState().update(activeNotifId, {
        type: 'success',
        title: '烧录完成',
        message:
          `${formatBytes(res.size)} @ ${formatHex(res.address)}` +
          `${res.verified ? ' · 校验通过' : ''}`,
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