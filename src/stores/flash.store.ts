import { create } from 'zustand'
import type { FirmwareFileInfo, FlashProgressEvent, LogEvent, FlashResult } from '@shared/types'
import * as flashService from '@/services/flash.service'
import { parseFile, readFile, statFile } from '@/services/file.service'
import { useProbeStore } from './probe.store'
import { useNotificationStore } from './notification.store'
import { selectedSectorsToRanges } from '@/pages/flash/utils/sectors'

// ── Tab 数据模型 ──────────────────────────
export interface FlashTab {
  id: string
  type: 'device' | 'file' | 'compare'
  title: string
  filePath?: string
  baseAddress: number
  data: string | null         // base64 encoded
  size: number
  format?: string
  loading: boolean
  // 烧录选项（每个 tab 独立保存，删除 tab 时自动移除）
  eraseBefore: boolean
  verifyAfter: boolean
  resetAfter: boolean
  // HexViewer 状态（按 tab 持久化，切换 tab 后保留）
  jumpAddr?: string
  highlightOffset?: number | null
  scrollTop?: number
  /** 文件最后修改时间（用于检测文件变更） */
  fileMtime?: number
  /** 是否已通知文件变更（避免重复通知） */
  fileChangeNotified?: boolean
  // compare tab 专用
  rightData?: string | null   // base64 encoded right side data
  rightBaseAddress?: number
  rightTitle?: string
  leftTitle?: string
}

type FlashPhase = 'idle' | 'erasing' | 'programming' | 'verifying' | 'reading' | 'done' | 'error'

let tabIdCounter = 0
function genId(): string {
  return `tab-${++tabIdCounter}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

function getFileName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

/** 将二进制数据转换为 Intel HEX 格式字符串 */
function binaryToIntelHex(bytes: Uint8Array, baseAddress: number): string {
  const lines: string[] = []
  let addr = baseAddress
  let i = 0
  const recordDataLen = 16 // 每行 16 字节数据

  while (i < bytes.length) {
    // 检查是否需要扩展线性地址记录（每 64KB 边界）
    const upperAddr = (addr >> 16) & 0xFFFF
    const prevUpperAddr = (i === 0) ? -1 : ((baseAddress + i - 1) >> 16) & 0xFFFF
    if (upperAddr !== prevUpperAddr) {
      // 扩展线性地址记录 (Type 04)
      const data = [0x02, 0x00, 0x04, (upperAddr >> 8) & 0xFF, upperAddr & 0xFF]
      let checksum = 0
      for (const b of data) checksum += b
      checksum = (~checksum + 1) & 0xFF
      lines.push(`:02000004${upperAddr.toString(16).padStart(4, '0').toUpperCase()}${checksum.toString(16).padStart(2, '0').toUpperCase()}`)
    }

    const len = Math.min(recordDataLen, bytes.length - i)
    const lowAddr = addr & 0xFFFF
    const recordType = 0x00 // 数据记录

    // 构建记录
    let record = `:${len.toString(16).padStart(2, '0').toUpperCase()}${lowAddr.toString(16).padStart(4, '0').toUpperCase()}${recordType.toString(16).padStart(2, '0').toUpperCase()}`

    let checksum = len + (lowAddr >> 8) + (lowAddr & 0xFF) + recordType
    for (let j = 0; j < len; j++) {
      const b = bytes[i + j]
      record += b.toString(16).padStart(2, '0').toUpperCase()
      checksum += b
    }
    checksum = (~checksum + 1) & 0xFF
    record += checksum.toString(16).padStart(2, '0').toUpperCase()
    lines.push(record)

    i += len
    addr += len
  }

  // 结束记录
  lines.push(':00000001FF')
  return lines.join('\n')
}

interface FlashStore {
  // ── Tab 状态 ──────────────────────────
  tabs: FlashTab[]
  activeTabId: string | null

  // ── 弹窗 ──────────────────────────────
  showBinAddrDialog: boolean
  pendingBinPath: string | null
  showReadBackRangeDialog: boolean
  showCompareDialog: boolean
  /** 填充内存对话框（数据 tab 的 Compare 旁与顶部工具栏共用） */
  showFillDialog: boolean
  fillAddress: string
  fillSize: string
  fillValue: string

  // ── 烧录状态 ──────────────────────────
  phase: FlashPhase
  progress: number
  progressCurrent: number
  progressTotal: number
  progressUnit: 'bytes' | 'sectors' | 'operations'
  busy: boolean
  result: FlashResult | null
  activeNotifId: string | null

  // ── 日志 ──────────────────────────────
  logs: LogEvent[]

  // ── Tab 操作 ──────────────────────────
  openFileTab: () => Promise<void>
  addDeviceTab: () => void
  closeTab: (id: string) => void
  selectTab: (id: string) => void
  getActiveTab: () => FlashTab | null
  updateTab: (id: string, patch: Partial<FlashTab>) => void
  saveTabAs: (id: string) => Promise<void>
  reloadFileTab: (tabId: string) => Promise<void>
  checkFileChanges: (tabId?: string) => void

  // ── 弹窗控制 ──────────────────────────
  setShowBinAddrDialog: (show: boolean) => void
  setPendingBinPath: (path: string | null) => void
  confirmBinAddress: (address: number) => Promise<void>
  setShowReadBackRangeDialog: (show: boolean) => void
  setShowCompareDialog: (show: boolean) => void
  setShowFillDialog: (show: boolean) => void
  setFillAddress: (v: string) => void
  setFillSize: (v: string) => void
  setFillValue: (v: string) => void

  // ── Flash 操作 ────────────────────────
  doCheckBlank: () => Promise<void>
  doEraseChip: () => Promise<void>
  doEraseSectors: (address: number, size: number) => Promise<void>
  /** 擦除全局配置中选中的扇区（支持多个不连续范围） */
  doEraseSelectedSectors: () => Promise<void>
  doProgram: (verify?: boolean) => Promise<void>
  doVerify: () => Promise<void>
  doReadBack: (mode: 'chip' | 'range', address?: number, size?: number) => Promise<void>
  /** 读回全局配置中选中的扇区（支持多个不连续范围，合并为一个连续缓冲） */
  doReadBackSelectedSectors: () => Promise<void>
  doStartApp: () => Promise<void>
  doReset: () => Promise<void>
  doFillMemory: (address: number, size: number, value: number) => Promise<void>
  cancelOperation: () => Promise<void>
  doCompare: (filePath: string) => Promise<void>

  setTabOption: (tabId: string, key: 'eraseBefore' | 'verifyAfter' | 'resetAfter', value: boolean) => void

  // ── WebSocket 事件 ────────────────────
  onProgress: (data: FlashProgressEvent) => void
  onLog: (data: LogEvent) => void
  onComplete: (data: FlashResult) => void
  reset: () => void
  clearLogs: () => void
}

export const useFlashStore = create<FlashStore>((set, get) => ({
  // ── 初始状态 ──────────────────────────
  tabs: [
    { id: genId(), type: 'device', title: 'Device Memory', baseAddress: 0x08000000, data: null, size: 0, loading: false, eraseBefore: true, verifyAfter: true, resetAfter: false },
  ],
  activeTabId: null,

  showBinAddrDialog: false,
  pendingBinPath: null,
  showReadBackRangeDialog: false,
  showCompareDialog: false,
  showFillDialog: false,
  fillAddress: '0x08000000',
  fillSize: '4096',
  fillValue: '0xFF',

  phase: 'idle',
  progress: 0,
  progressCurrent: 0,
  progressTotal: 0,
  progressUnit: 'bytes',
  busy: false,
  result: null,
  activeNotifId: null,

  logs: [],

  // ── Tab 操作 ──────────────────────────
  openFileTab: async () => {
    const path = await window.electron.openFileDialog()
    if (!path) return

    const isBin = path.toLowerCase().endsWith('.bin')
    if (isBin) {
      set({ pendingBinPath: path, showBinAddrDialog: true })
      return
    }

    // 非 bin 文件直接加载
    const id = genId()
    const fileName = getFileName(path)
    set((state) => ({
      tabs: [...state.tabs, { id, type: 'file', title: fileName, filePath: path, baseAddress: 0, data: null, size: 0, loading: true, eraseBefore: true, verifyAfter: true, resetAfter: false }],
      activeTabId: id,
    }))

    try {
      const [info, data] = await Promise.all([parseFile(path), readFile(path)])
      get().updateTab(id, { data: data.data, baseAddress: data.base_address, size: data.size, format: info.format, loading: false, fileMtime: data.mtime })
    } catch (err) {
      console.error('[flash.store] openFileTab failed:', err)
      get().updateTab(id, { loading: false })
    }
  },

  addDeviceTab: () => {
    const id = genId()
    const deviceTabs = get().tabs.filter((t) => t.type === 'device').length
    set((state) => ({
      tabs: [...state.tabs, { id, type: 'device', title: `Device Memory ${deviceTabs > 0 ? deviceTabs + 1 : ''}`.trim(), baseAddress: 0x08000000, data: null, size: 0, loading: false, eraseBefore: true, verifyAfter: true, resetAfter: false }],
      activeTabId: id,
    }))
  },

  closeTab: (id) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id)
      // 第一个 Device Memory tab 不可关闭
      if (tab?.type === 'device' && state.tabs.indexOf(tab) === 0) return state

      const newTabs = state.tabs.filter((t) => t.id !== id)
      let newActive = state.activeTabId
      if (state.activeTabId === id) {
        newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
      }
      return { tabs: newTabs, activeTabId: newActive }
    })
  },

  selectTab: (id) => {
    set({ activeTabId: id })
    // 文件 tab：检查文件是否已变更
    get().checkFileChanges(id)
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId) ?? null
  },

  updateTab: (id, patch) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }))
  },

  saveTabAs: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab?.data) return
    // 去除源文件扩展名，只保留纯文件名
    const rawTitle = tab.title.replace(/\.[^.]+$/, '').replace(/\s+/g, '_')
    const defaultName = `${rawTitle}.bin`
    const savePath = await window.electron?.saveFileDialog?.(defaultName)
    if (!savePath) return

    // base64 → bytes
    const binary = atob(tab.data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const { api } = await import('@/services/api')
    const client = await api()

    const isHex = savePath.toLowerCase().endsWith('.hex')
    if (isHex) {
      // 转换为 Intel HEX 格式
      const hexContent = binaryToIntelHex(bytes, tab.baseAddress)
      // hex 是文本，用 base64 编码后发送
      const hexBase64 = btoa(hexContent)
      await client.post('/api/files/save', { file_path: savePath, data: hexBase64 })
    } else {
      // bin 格式直接保存 base64 数据
      await client.post('/api/files/save', { file_path: savePath, data: tab.data })
    }
    useNotificationStore.getState().push({ type: 'success', title: '另存为', message: `已保存到 ${getFileName(savePath)}`, autoClose: true, autoCloseDelay: 3000 })
  },

  reloadFileTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.filePath) return
    set({ showReloadDialog: false, pendingReloadTabId: null })
    get().updateTab(tabId, { loading: true })
    try {
      const [info, data] = await Promise.all([parseFile(tab.filePath), readFile(tab.filePath, tab.baseAddress)])
      get().updateTab(tabId, {
        data: data.data,
        baseAddress: data.base_address || tab.baseAddress,
        size: data.size,
        format: info.format,
        loading: false,
        fileMtime: data.mtime,
        fileChangeNotified: false,
        jumpAddr: '',
        highlightOffset: null,
        scrollTop: 0,
      })
      useNotificationStore.getState().push({ type: 'success', title: '文件已重新加载', message: tab.title, autoClose: true, autoCloseDelay: 3000 })
    } catch (err) {
      get().updateTab(tabId, { loading: false })
      useNotificationStore.getState().push({ type: 'error', title: '重新加载失败', message: err instanceof Error ? err.message : '未知错误', autoClose: true })
    }
  },

  checkFileChanges: (tabId) => {
    const tabs = get().tabs
    const targets = tabId ? [tabs.find((t) => t.id === tabId)].filter(Boolean) as FlashTab[] : tabs.filter((t) => t.type === 'file')
    for (const tab of targets) {
      if (tab.type !== 'file' || !tab.filePath || !tab.fileMtime || tab.fileChangeNotified) continue
      statFile(tab.filePath).then((stat) => {
        if (Math.abs(stat.mtime - tab.fileMtime!) > 0.001) {
          // 标记已通知，避免重复
          get().updateTab(tab.id, { fileChangeNotified: true })
          // 全局通知 + 操作按钮
          useNotificationStore.getState().push({
            type: 'warning',
            title: '文件已变更',
            message: `"${tab.title}" 在磁盘上已被修改`,
            autoClose: false,
            action: {
              label: '重新加载',
              onClick: () => { get().reloadFileTab(tab.id) },
            },
          })
        }
      }).catch(() => { /* 文件可能已删除，忽略 */ })
    }
  },

  // ── 弹窗控制 ──────────────────────────
  setShowBinAddrDialog: (show) => set({ showBinAddrDialog: show }),
  setPendingBinPath: (path) => set({ pendingBinPath: path }),

  confirmBinAddress: async (address) => {
    const path = get().pendingBinPath
    set({ showBinAddrDialog: false, pendingBinPath: null })
    if (!path) return

    const id = genId()
    const fileName = getFileName(path)
    set((state) => ({
      tabs: [...state.tabs, { id, type: 'file', title: fileName, filePath: path, baseAddress: address, data: null, size: 0, loading: true, eraseBefore: true, verifyAfter: true, resetAfter: false }],
      activeTabId: id,
    }))

    try {
      const [info, data] = await Promise.all([parseFile(path), readFile(path, address)])
      get().updateTab(id, { data: data.data, baseAddress: address, size: data.size, format: info.format, loading: false, fileMtime: data.mtime })
    } catch (err) {
      console.error('[flash.store] confirmBinAddress failed:', err)
      get().updateTab(id, { loading: false })
    }
  },

  setShowReadBackRangeDialog: (show) => set({ showReadBackRangeDialog: show }),
  setShowCompareDialog: (show) => set({ showCompareDialog: show }),
  setShowFillDialog: (show) => set({ showFillDialog: show }),
  setFillAddress: (v) => set({ fillAddress: v }),
  setFillSize: (v) => set({ fillSize: v }),
  setFillValue: (v) => set({ fillValue: v }),

  // ── Flash 操作 ────────────────────────
  doCheckBlank: async () => {
    const uid = useProbeStore.getState().selectedUid
    if (!uid) return
    await wrapOperation(set, get, '检查空白', '正在检查...', async () => {
      const result = await flashService.checkBlank(uid)
      if (result.success && result.is_blank !== undefined) {
        if (result.is_blank) {
          return { success: true, duration_ms: result.duration_ms }
        }
        // 非空白：提示首个非空地址，并显示实际扫描量（提前终止时 scanned_bytes < total_bytes）
        const scanned = result.scanned_bytes ?? result.total_bytes ?? 0
        const total = result.total_bytes ?? 0
        const early = result.early_terminated
        const scannedDesc = early && total > 0
          ? `（已扫描 ${(scanned / 1024).toFixed(1)}KB / ${(total / 1024).toFixed(1)}KB，提前终止）`
          : ''
        return {
          success: true,
          duration_ms: result.duration_ms,
          error: `非空白，首个非0xFF地址: ${result.first_nonblank_addr ? formatHex(result.first_nonblank_addr) : 'N/A'}${scannedDesc}`,
        }
      }
      return { success: false, error: result.error ?? '检查失败' }
    })
    const state = get()
    if (state.result?.error?.includes('非空白')) {
      useNotificationStore.getState().push({ type: 'warning', title: '检查空白', message: state.result.error, autoClose: true, autoCloseDelay: 5000 })
    }
  },

  doEraseChip: async () => {
    const uid = useProbeStore.getState().selectedUid
    if (!uid) return
    await wrapOperation(set, get, '整片擦除', '正在擦除...', async () => {
      return await flashService.eraseFlash(uid, 'chip')
    }, () => 'Flash 已整片擦除')
  },

  doEraseSectors: async (address, size) => {
    const uid = useProbeStore.getState().selectedUid
    if (!uid) return
    await wrapOperation(set, get, '扇区擦除', `擦除 ${formatHex(address)} ~ ${formatHex(address + size)}...`, async () => {
      return await flashService.eraseFlash(uid, 'sector_range', address, size)
    }, () => '扇区擦除完成')
  },

  doEraseSelectedSectors: async () => {
    const uid = useProbeStore.getState().selectedUid
    if (!uid) return
    const probeStore = useProbeStore.getState()
    const target = probeStore.getSelectedTarget()
    const deviceInfo = target ? probeStore.getDeviceInfo(target.part_number) : undefined
    const ranges = selectedSectorsToRanges(probeStore.selectedSectorIndices, target, deviceInfo)
    if (ranges.length === 0) {
      useNotificationStore.getState().push({ type: 'warning', title: '扇区擦除', message: '未选中任何扇区，请在 Flash 配置中选择', autoClose: true })
      return
    }
    const rangeDesc = ranges.map((r) => `${formatHex(r.start)}~${formatHex(r.end)}`).join(', ')
    await wrapOperation(set, get, '扇区擦除', `擦除 ${rangeDesc}...`, async () => {
      // 逐个范围擦除
      for (const r of ranges) {
        await flashService.eraseFlash(uid, 'sector_range', r.start, r.end - r.start + 1)
      }
      return { success: true, duration_ms: 0 } as FlashResult
    }, () => `已擦除 ${ranges.length} 个范围`)
  },

  doProgram: async (verify) => {
    const uid = useProbeStore.getState().selectedUid
    const tab = get().getActiveTab()
    if (!uid || !tab) return
    // 支持两种 tab 类型：file（文件路径）和 device（内存数据）
    if (tab.type === 'file' && !tab.filePath) return
    if (tab.type === 'device' && !tab.data) return
    const shouldVerify = verify ?? tab.verifyAfter
    const { eraseBefore, resetAfter } = tab
    const title = shouldVerify ? '编程并校验' : '编程'
    await wrapOperation(set, get, title, eraseBefore ? '擦除中...' : '编程中...', async () => {
      if (tab.type === 'device' && tab.data) {
        // Device Memory tab：使用 base64 数据编程
        return await flashService.programFlash(uid, '', shouldVerify, resetAfter, tab.baseAddress, tab.data)
      }
      // File tab：使用文件路径
      return await flashService.programFlash(uid, tab.filePath!, shouldVerify, resetAfter, tab.baseAddress)
    }, (r) => {
      const speed = r.bytes_written > 0 && r.duration_ms > 0 ? ` · ${(r.bytes_written / 1024 / (r.duration_ms / 1000)).toFixed(1)} KB/s` : ''
      return `写入 ${formatSize(r.bytes_written)} · 耗时 ${(r.duration_ms / 1000).toFixed(2)}s${speed}`
    })
  },

  doVerify: async () => {
    const uid = useProbeStore.getState().selectedUid
    const tab = get().getActiveTab()
    if (!uid || !tab) return
    if (tab.type === 'file' && !tab.filePath) return
    if (tab.type === 'device' && !tab.data) return
    await wrapOperation(set, get, '校验', '正在校验...', async () => {
      if (tab.type === 'device' && tab.data) {
        return await flashService.verifyFlash(uid, '', tab.data, tab.baseAddress)
      }
      return await flashService.verifyFlash(uid, tab.filePath!, undefined, tab.baseAddress)
    }, () => 'Flash 内容与数据一致')
  },

  doReadBack: async (mode, address, size) => {
    const uid = useProbeStore.getState().selectedUid
    const tab = get().getActiveTab()
    if (!uid || !tab) return
    set({ showReadBackRangeDialog: false })
    get().updateTab(tab.id, { loading: true })
    await wrapOperation(set, get, '读回', '正在读取 Flash...', async () => {
      try {
        const result = await flashService.readBack(uid, mode, address ?? 0, size ?? 0)
        if (result.success && result.base64_data) {
          // 数据直接存入当前 tab，重置 HexViewer 持久化状态
          get().updateTab(tab.id, {
            data: result.base64_data,
            baseAddress: result.base_address ?? 0,
            size: result.bytes_read ?? 0,
            loading: false,
            format: 'bin',
            jumpAddr: '',
            highlightOffset: null,
            scrollTop: 0,
          })
          return { success: true, duration_ms: result.duration_ms, bytes_written: result.bytes_read ?? 0 }
        }
        get().updateTab(tab.id, { loading: false })
        return { success: false, error: result.error ?? '读回失败' }
      } catch (err) {
        get().updateTab(tab.id, { loading: false })
        throw err
      }
    }, (r) => `读取 ${formatSize(r.bytes_written)} 到 ${tab.title}`)
  },

  doReadBackSelectedSectors: async () => {
    const uid = useProbeStore.getState().selectedUid
    const tab = get().getActiveTab()
    if (!uid || !tab) return
    const probeStore = useProbeStore.getState()
    const target = probeStore.getSelectedTarget()
    const deviceInfo = target ? probeStore.getDeviceInfo(target.part_number) : undefined
    const ranges = selectedSectorsToRanges(probeStore.selectedSectorIndices, target, deviceInfo)
    if (ranges.length === 0) {
      useNotificationStore.getState().push({ type: 'warning', title: '读回', message: '未选中任何扇区，请在 Flash 配置中选择', autoClose: true })
      return
    }
    // 逐个 range 读取，间隙用 0xFF 填充（模拟擦除后的 Flash 状态）
    const startAddr = ranges[0].start
    const endAddr = ranges[ranges.length - 1].end
    const totalSize = endAddr - startAddr + 1
    // 预分配整个缓冲区，填充 0xFF
    const buffer = new Uint8Array(totalSize).fill(0xff)
    get().updateTab(tab.id, { loading: true })
    await wrapOperation(set, get, '读回', `正在读取 ${ranges.length} 个范围 (${formatHex(startAddr)} ~ ${formatHex(endAddr)})...`, async () => {
      try {
        // 逐个 range 读取并填入缓冲区对应位置
        for (const r of ranges) {
          const rangeSize = r.end - r.start + 1
          const result = await flashService.readBack(uid, 'range', r.start, rangeSize)
          if (!result.success || !result.base64_data) {
            get().updateTab(tab.id, { loading: false })
            return { success: false, error: result.error ?? `读回失败 (${formatHex(r.start)})` }
          }
          // base64 解码后填入缓冲区
          const bytes = atob(result.base64_data)
          const offset = r.start - startAddr
          for (let i = 0; i < bytes.length; i++) {
            buffer[offset + i] = bytes.charCodeAt(i)
          }
        }
        // 整个缓冲区转 base64 存入 tab
        let binary = ''
        const chunkSize = 0x8000
        for (let i = 0; i < buffer.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, Array.from(buffer.subarray(i, i + chunkSize)) as unknown as number[])
        }
        const base64 = btoa(binary)
        get().updateTab(tab.id, {
          data: base64,
          baseAddress: startAddr,
          size: totalSize,
          loading: false,
          format: 'bin',
          jumpAddr: '',
          highlightOffset: null,
          scrollTop: 0,
        })
        return { success: true, duration_ms: 0, bytes_written: totalSize }
      } catch (err) {
        get().updateTab(tab.id, { loading: false })
        throw err
      }
    }, (r) => `读取 ${formatSize(r.bytes_written)} 到 ${tab.title}`)
  },

  doStartApp: async () => {
    const uid = useProbeStore.getState().selectedUid
    if (!uid) return
    await wrapOperation(set, get, '启动应用', '正在启动...', async () => {
      const result = await flashService.resetTarget(uid, 'hw', true)
      return { success: result.success }
    }, () => '目标已复位并运行')
  },

  doReset: async () => {
    const uid = useProbeStore.getState().selectedUid
    if (!uid) return
    await wrapOperation(set, get, '复位', '正在复位...', async () => {
      const result = await flashService.resetTarget(uid, 'hw', false)
      return { success: result.success }
    }, () => '目标已复位')
  },

  doFillMemory: async (address, size, value) => {
    // 纯前端操作：在当前激活 Tab 的数据数组中填充指定值，不调用后端。
    // 用户可随后通过 Program 将填充结果烧录到目标设备。
    const tab = get().getActiveTab()
    const notif = useNotificationStore.getState()
    const addrStr = formatHex(address)
    const endStr = formatHex(address + size - 1)
    const valStr = `0x${value.toString(16).toUpperCase().padStart(2, '0')}`

    // 校验：必须有激活的可编辑 Tab 且有数据
    if (!tab) {
      notif.push({ type: 'warning', title: '填充内存', message: '没有激活的数据 Tab', autoClose: true, autoCloseDelay: 5000 })
      return
    }
    if (tab.type === 'compare') {
      notif.push({ type: 'warning', title: '填充内存', message: '比较 Tab 不支持填充操作，请切换到文件或设备 Tab', autoClose: true, autoCloseDelay: 5000 })
      return
    }
    if (!tab.data) {
      notif.push({ type: 'warning', title: '填充内存', message: '当前 Tab 没有数据，请先打开文件或读回 Flash', autoClose: true, autoCloseDelay: 5000 })
      return
    }

    // 校验：填充地址范围必须在 tab.data 覆盖的地址范围内，超出范围时提示用户
    const dataStart = tab.baseAddress
    const dataEnd = tab.baseAddress + tab.size - 1
    const fillStart = address
    const fillEnd = address + size - 1
    if (fillStart < dataStart || fillEnd > dataEnd) {
      notif.push({
        type: 'warning',
        title: '填充内存',
        message: `地址范围超出数据范围。数据范围: ${formatHex(dataStart)}..${formatHex(dataEnd)}，请求范围: ${addrStr}..${endStr}`,
        autoClose: true,
        autoCloseDelay: 5000,
      })
      return
    }

    // UI 反馈：progress 通知 → success/error（沿用 wrapOperation 的反馈模式）
    const notifId = notif.push({ type: 'progress', title: '填充内存', message: `正在填充 ${addrStr}..${endStr} (${valStr})...`, progress: 0 })
    try {
      // base64 解码为字节数组
      const binary = atob(tab.data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

      // 在指定地址范围内填充值（同步前端操作）
      const offset = address - tab.baseAddress
      bytes.fill(value, offset, offset + size)

      // 重新编码为 base64（分块处理避免调用栈溢出）
      let newBinary = ''
      const chunkSize = 0x8000
      for (let i = 0; i < bytes.length; i += chunkSize) {
        newBinary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as unknown as number[])
      }
      const newBase64 = btoa(newBinary)

      // 更新 tab 数据（触发 HexViewer 刷新）
      get().updateTab(tab.id, { data: newBase64, size: bytes.length })

      notif.update(notifId, {
        type: 'success',
        title: '填充内存完成',
        message: `已填充 ${addrStr}..${endStr} (${valStr})`,
        autoClose: true,
        autoCloseDelay: 3000,
      })
    } catch (err) {
      notif.update(notifId, {
        type: 'error',
        title: '填充内存失败',
        message: err instanceof Error ? err.message : '未知错误',
        autoClose: true,
        autoCloseDelay: 5000,
      })
    }
  },

  cancelOperation: async () => {
    const uid = useProbeStore.getState().selectedUid
    if (!uid) return
    try {
      await flashService.cancelOperation(uid)
    } catch (err) {
      console.error('[flash.store] cancel failed:', err)
    }
    // 更新 UI 状态
    set({ busy: false, phase: 'idle', progress: 0 })
    const { activeNotifId } = get()
    if (activeNotifId) {
      const notif = useNotificationStore.getState()
      notif.update(activeNotifId, {
        type: 'warning',
        title: '操作已取消',
        message: '用户取消了当前操作',
        autoClose: true,
        autoCloseDelay: 3000,
      })
      set({ activeNotifId: null })
    }
  },

  doCompare: async (filePath) => {
    const tab = get().getActiveTab()
    if (!tab?.data) return
    set({ showCompareDialog: false })

    const notif = useNotificationStore.getState()
    const notifId = notif.push({ type: 'progress', title: '比较', message: '正在加载参考文件...' })

    try {
      const isBin = filePath.toLowerCase().endsWith('.bin')
      let refBaseAddr = tab.baseAddress
      let refData: string

      if (isBin) {
        const data = await readFile(filePath, tab.baseAddress)
        refData = data.data
        refBaseAddr = data.base_address
      } else {
        const data = await readFile(filePath)
        refData = data.data
        refBaseAddr = data.base_address
      }

      // 创建新 compare tab
      const id = genId()
      const refFileName = getFileName(filePath)
      const leftTitle = tab.title
      const rightTitle = refFileName
      const compareTitle = `Compare: ${leftTitle} vs ${rightTitle}`

      set((state) => ({
        tabs: [...state.tabs, {
          id,
          type: 'compare' as const,
          title: compareTitle,
          baseAddress: tab.baseAddress,
          data: tab.data,
          size: tab.size,
          loading: false,
          eraseBefore: true,
          verifyAfter: true,
          resetAfter: false,
          rightData: refData,
          rightBaseAddress: refBaseAddr,
          leftTitle,
          rightTitle,
        }],
        activeTabId: id,
      }))

      // 统计差异
      const tabBytes = atob(tab.data)
      const refBytes = atob(refData)
      const minLen = Math.min(tabBytes.length, refBytes.length)
      let diffCount = 0
      for (let i = 0; i < minLen; i++) {
        if (tabBytes.charCodeAt(i) !== refBytes.charCodeAt(i)) diffCount++
      }
      diffCount += Math.abs(tabBytes.length - refBytes.length)

      notif.update(notifId, {
        type: diffCount === 0 ? 'success' : 'warning',
        title: '比较完成',
        message: diffCount === 0
          ? `完全匹配 (${formatSize(minLen)})`
          : `${diffCount} 字节不同 (共 ${formatSize(minLen)})`,
        autoClose: true,
        autoCloseDelay: 5000,
      })
    } catch (err) {
      notif.update(notifId, { type: 'error', title: '比较失败', message: err instanceof Error ? err.message : '未知错误', autoClose: true, autoCloseDelay: 5000 })
    }
  },

  setTabOption: (tabId, key, value) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, [key]: value } : t)),
    }))
  },

  // ── WebSocket 事件 ────────────────────
  onProgress: (data) => {
    const phaseMap: Record<string, FlashPhase> = { erase: 'erasing', program: 'programming', verify: 'verifying', blank: 'verifying', read: 'reading' }
    // 推断 unit：erase phase 默认 operations，其他默认 bytes
    const unit = data.unit ?? (data.phase === 'erase' ? 'operations' : 'bytes')
    set({
      phase: phaseMap[data.phase] ?? get().phase,
      progress: data.percent,
      progressCurrent: data.current,
      progressTotal: data.total,
      progressUnit: unit,
    })
    const { activeNotifId } = get()
    if (activeNotifId) {
      const msgMap: Record<string, string> = { erase: '擦除中...', program: '编程中...', verify: '校验中...', blank: '检查空白中...', read: '读取中...' }
      let progressText = ''
      if (data.total > 0) {
        if (unit === 'bytes') {
          progressText = ` ${formatSize(data.current)} / ${formatSize(data.total)}`
        } else if (unit === 'sectors') {
          progressText = ` ${data.current} / ${data.total} 扇区`
        }
        // operations: 只显示百分比，不显示数量
      }
      useNotificationStore.getState().update(activeNotifId, {
        progress: data.percent,
        message: `${msgMap[data.phase] ?? ''}${progressText}`,
      })
    }
  },

  onLog: (data) => set((state) => ({ logs: [...state.logs, data] })),

  onComplete: (data) => {
    set({ phase: data.success ? 'done' : 'error', busy: false, result: data, progress: data.success ? 100 : get().progress })
    const { activeNotifId } = get()
    if (activeNotifId) {
      const notif = useNotificationStore.getState()
      if (data.success) {
        notif.update(activeNotifId, { type: 'success', title: '操作完成', message: `写入 ${formatSize(data.bytes_written)} · 耗时 ${(data.duration_ms / 1000).toFixed(2)}s`, autoClose: true, autoCloseDelay: 3000 })
      } else {
        notif.update(activeNotifId, { type: 'error', title: '操作失败', message: data.error ?? '未知错误', autoClose: true, autoCloseDelay: 5000 })
      }
      set({ activeNotifId: null })
    }
  },

  reset: () => set({ phase: 'idle', progress: 0, progressCurrent: 0, progressTotal: 0, progressUnit: 'bytes', busy: false, result: null, logs: [], activeNotifId: null }),

  clearLogs: () => set({ logs: [] }),
}))

// ── 通用操作包装 ──────────────────────────
async function wrapOperation(
  set: (partial: Partial<FlashStore>) => void,
  get: () => FlashStore,
  title: string,
  startMsg: string,
  fn: () => Promise<{ success: boolean; error?: string | null; duration_ms?: number; bytes_written?: number }>,
  successMsg?: (result: any) => string,
) {
  const uid = useProbeStore.getState().selectedUid
  if (!uid) return

  // 防止重复操作
  if (get().busy) {
    useNotificationStore.getState().push({
      type: 'warning',
      title: '操作繁忙',
      message: `正在执行${get().phase === 'erasing' ? '擦除' : get().phase === 'programming' ? '编程' : get().phase === 'verifying' ? '校验' : '操作'}中，请稍候...`,
      autoClose: true,
      autoCloseDelay: 3000,
    })
    return
  }

  const notif = useNotificationStore.getState()
  const notifId = notif.push({ type: 'progress', title, message: startMsg, progress: 0 })
  set({ busy: true, progress: 0, progressCurrent: 0, progressTotal: 0, progressUnit: 'bytes', result: null, logs: [{ level: 'info', message: `── ${title} ──`, timestamp: new Date().toISOString() }], activeNotifId: notifId })
  try {
    const result = await fn()
    set({ phase: result.success ? 'done' : 'error', busy: false, result: result as FlashResult, activeNotifId: null })
    if (result.success) {
      notif.update(notifId, { type: 'success', title: `${title}完成`, message: successMsg ? successMsg(result) : '操作成功', autoClose: true, autoCloseDelay: 5000 })
    } else {
      notif.update(notifId, { type: 'error', title: `${title}失败`, message: result.error ?? '未知错误', autoClose: true, autoCloseDelay: 5000 })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : `${title}失败`
    set({ phase: 'error', busy: false, result: { success: false, bytes_written: 0, duration_ms: 0, error: msg }, activeNotifId: null })
    notif.update(notifId, { type: 'error', title: `${title}失败`, message: msg, autoClose: true, autoCloseDelay: 5000 })
  }
}

// 初始化：选中第一个 tab
useFlashStore.setState((state) => ({ activeTabId: state.tabs[0]?.id ?? null }))
