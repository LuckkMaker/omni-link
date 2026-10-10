import { create } from 'zustand'
import { statFile } from '@/services/file.service'
import {
  omniToolErrorMessage,
  omniToolService,
  type OmniDevice,
  type OmniInfo,
  type OmniPersonality,
  type OmniProgress,
  type OmniSessionState,
} from './service'

const APP_DEFAULT_ADDRESS = 0x08010000

export type LogLevel = 'info' | 'success' | 'error'

export interface OmniLogLine {
  time: string
  level: LogLevel
  message: string
}

interface OmniToolStore {
  devices: OmniDevice[]
  /** 列表中已选中的设备端口（与"是否已连接"分离） */
  selectedPort: string | null
  serialAvailable: boolean
  session: OmniSessionState
  info: OmniInfo | null
  filePath: string | null
  fileSize: number | null
  /** 目标地址（文本，支持 0x 前缀） */
  address: string
  busy: boolean
  progress: OmniProgress | null
  logs: OmniLogLine[]
  error: string | null

  refreshDevices: () => Promise<void>
  selectPort: (port: string | null) => void
  connect: (port: string) => Promise<void>
  disconnect: () => Promise<void>
  loadInfo: () => Promise<void>
  chooseFile: () => Promise<void>
  setAddress: (value: string) => void
  enterBoot: () => Promise<void>
  startUpgrade: () => Promise<void>
  onProgress: (p: OmniProgress) => void
  pushLog: (level: LogLevel, message: string) => void
  clearLogs: () => void
}

function now(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/** 等待设备以指定人格重新枚举（app <-> boot 切换后端口会变化） */
async function waitForPersonality(
  target: OmniPersonality,
  timeoutMs = 30000
): Promise<OmniDevice | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await omniToolService.scan().catch(() => null)
    const hit = res?.omni_devices.find((d) => d.personality === target)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 700))
  }
  return null
}

const INITIAL_STATE = {
  devices: [] as OmniDevice[],
  selectedPort: null as string | null,
  serialAvailable: true,
  session: { connected: false, port: null, personality: 'unknown', busy: false } as OmniSessionState,
  info: null as OmniInfo | null,
  filePath: null as string | null,
  fileSize: null as number | null,
  address: `0x${APP_DEFAULT_ADDRESS.toString(16).toUpperCase()}`,
  busy: false,
  progress: null as OmniProgress | null,
  logs: [] as OmniLogLine[],
  error: null as string | null,
}

export const useOmniToolStore = create<OmniToolStore>((set, get) => ({
  ...INITIAL_STATE,

  pushLog: (level, message) =>
    set((s) => ({ logs: [...s.logs, { time: now(), level, message }].slice(-500) })),

  clearLogs: () => set({ logs: [] }),

  onProgress: (p) => set({ progress: p }),

  setAddress: (value) => set({ address: value }),

  refreshDevices: async () => {
    try {
      const res = await omniToolService.scan()
      set((s) => {
        // 保留已选设备；若已消失则回退到第一台，避免选择与列表不一致
        const stillThere = res.omni_devices.some((d) => d.port === s.selectedPort)
        return {
          devices: res.omni_devices,
          serialAvailable: res.serial_available,
          selectedPort: stillThere ? s.selectedPort : (res.omni_devices[0]?.port ?? null),
        }
      })
    } catch (e) {
      set({ error: omniToolErrorMessage(e) })
    }
  },

  selectPort: (port) => set({ selectedPort: port }),

  connect: async (port) => {
    set({ busy: true, error: null, info: null, progress: null, selectedPort: port })
    try {
      const session = await omniToolService.connect(port)
      set({ session })
      get().pushLog('info', `已连接 ${port}（${session.personality}）`)
      if (session.personality === 'app') {
        get().pushLog('info', '提示：进入 bootloader 会中断当前 DAP 调试会话')
      }
      await get().loadInfo()
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      set({ error: msg })
      get().pushLog('error', `连接失败：${msg}`)
    } finally {
      set({ busy: false })
    }
  },

  disconnect: async () => {
    try {
      const session = await omniToolService.disconnect()
      set({ session, info: null, progress: null })
      get().pushLog('info', '已断开连接')
    } catch (e) {
      set({ error: omniToolErrorMessage(e) })
    }
  },

  loadInfo: async () => {
    const { session } = get()
    if (!session.connected) return
    try {
      const info = await omniToolService.info()
      set({ info })
      if (info.personality === 'boot') {
        get().pushLog('info', `boot ${info.boot_version_str}，MCU UID ${info.mcu_uid}`)
      } else {
        get().pushLog('info', `${info.vendor} ${info.product} v${info.fw_ver}`)
      }
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      set({ error: msg })
      get().pushLog('error', `读取设备信息失败：${msg}`)
    }
  },

  chooseFile: async () => {
    const path = await window.electron?.openFileDialog?.({
      extensions: ['bin'],
      title: '选择 OMNI Tool 固件 (.bin)',
    })
    if (!path) return
    let size: number | null = null
    try {
      size = (await statFile(path)).size
    } catch {
      size = null
    }
    set({ filePath: path, fileSize: size, error: null })
    get().pushLog('info', `已选择固件：${path}${size != null ? `（${size} bytes）` : ''}`)
  },

  enterBoot: async () => {
    set({ busy: true, error: null })
    try {
      await omniToolService.enterBoot()
      get().pushLog('info', '已下发 MODE_BOOT，等待设备重新枚举为 boot...')
      const boot = await waitForPersonality('boot')
      if (!boot) {
        throw new Error('等待 boot 设备超时（请确认设备已复位并重新枚举）')
      }
      get().pushLog('success', `boot 设备已就绪：${boot.port}`)
      await get().connect(boot.port)
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      set({ error: msg })
      get().pushLog('error', `进入 bootloader 失败：${msg}`)
    } finally {
      set({ busy: false })
    }
  },

  startUpgrade: async () => {
    const { filePath, address, session } = get()
    if (session.personality !== 'boot') {
      set({ error: '请先连接处于 bootloader 模式的设备' })
      return
    }
    if (!filePath) {
      set({ error: '请先选择固件 .bin 文件' })
      return
    }
    const parsed = Number(address.trim())
    if (!Number.isInteger(parsed) || parsed < 0) {
      set({ error: `目标地址无效：${address}` })
      return
    }

    set({ busy: true, error: null, progress: { stage: 'info', message: '准备中', current: 0, total: 0, percent: 0 } })
    try {
      const res = await omniToolService.upgrade(filePath, parsed)
      get().pushLog('success', `升级完成：${res.size} bytes @ 0x${res.address.toString(16).toUpperCase()}`)
      get().pushLog('info', '设备将跳转回 app，等待重新枚举...')
      await waitForPersonality('app')
      await get().refreshDevices()
      set({ progress: { stage: 'done', message: '升级完成', current: 1, total: 1, percent: 100 } })
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      set({ error: msg })
      get().pushLog('error', `升级失败：${msg}`)
      set({ progress: null })
    } finally {
      set({ busy: false })
    }
  },
}))