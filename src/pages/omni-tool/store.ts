import { create } from 'zustand'
import { parseFile, readFile } from '@/services/file.service'
import { useLogStore } from '@/stores/log.store'
import { useNotificationStore } from '@/stores/notification.store'
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

let tabSeq = 0
function genTabId(): string {
  return `omni-file-${++tabSeq}`
}

/** 固定的 Device Memory tab id（首个 tab，不可删除） */
export const DEVICE_TAB_ID = 'omni-device-0'

function formatHexAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase()}`
}

/** 文件 tab（镜像 flash.store 的 FlashTab）
 *
 *  三种类型：
 *  - ``kind: 'device'``：设备内存（固定首个 tab，不可删除），Read Back 的落点
 *  - ``kind: 'file'``：本地固件文件（bin / hex），升级/校验的对象
 *  - ``kind: 'compare'``：左右双栏对比（当前 tab vs 选中的参考文件）
 *
 *  地址不存于 tab：App 区地址由固件分区固定（见 APP_DEFAULT_ADDRESS）。
 */
export interface OmniFileTab {
  id: string
  /** device = 设备内存（固定首个）；file = 本地固件文件；compare = 对比视图 */
  kind: 'device' | 'file' | 'compare'
  title: string
  /** 仅 file tab 有值 */
  filePath: string
  size: number
  format: 'bin' | 'hex'
  /** base64 编码的二进制内容（用于 Hex 预览） */
  data: string | null
  /** 读取中 */
  loading: boolean
  /** 按 tab 记忆的视图状态 */
  byteWidth: 1 | 2 | 4
  jumpAddr: string
  scrollTop: number
  highlightOffset: number | null
  /** 仅 compare tab：右侧参考数据（base64） */
  rightData?: string | null
  /** 仅 compare tab：左右两侧标题 */
  leftTitle?: string
  rightTitle?: string
}

interface OmniToolStore {
  devices: OmniDevice[]
  /** 列表中已选中的设备端口（与"是否已连接"分离） */
  selectedPort: string | null
  serialAvailable: boolean
  /** 是否有扫描在进行中（UI 显示转圈，并阻止重入扫描） */
  refreshing: boolean
  /** 最近一次扫描完成的时间戳（0 = 从未扫描），用于判断列表是否过期 */
  lastScanAt: number
  session: OmniSessionState
  info: OmniInfo | null
  /** 文件 tab 列表（首项恒为固定的 Device Memory，不可删除） */
  tabs: OmniFileTab[]
  activeTabId: string | null
  /** 最近一次选中的固件文件 tab（Read Back 以其长度作为默认回读范围） */
  lastFileTabId: string | null
  /** 回读范围对话框是否打开 */
  showRangeDialog: boolean
  busy: boolean

  refreshDevices: () => Promise<void>
  /**
   * 强制重新扫描（忽略节流窗口）。用于打开设备下拉、切换设备池等
   * "用户明确要看最新列表"的时机——设备人格切换后 USB 会重新枚举，
   * 列表不刷新就只会看到旧的 app 端口和旧序列号。
   */
  refreshDevicesNow: () => Promise<void>
  refreshDevicesUntil: (personality: OmniPersonality, timeoutMs?: number) => Promise<boolean>
  selectPort: (port: string | null) => void
  connect: (port: string) => Promise<void>
  disconnect: () => Promise<void>
  loadInfo: () => Promise<void>
  openFileTab: () => Promise<void>
  selectTab: (id: string) => void
  closeTab: (id: string) => void
  updateTab: (id: string, patch: Partial<OmniFileTab>) => void
  setShowRangeDialog: (open: boolean) => void
  enterBoot: () => Promise<void>
  startUpgrade: () => Promise<void>
  verifyOnly: () => Promise<void>
  readBack: (size?: number) => Promise<void>
  compareWith: (filePath: string) => Promise<void>
  startApp: () => Promise<void>
  onProgress: (p: OmniProgress) => void
  /** 写日志到全局日志控制台（source 固定为 omni-tool） */
  pushLog: (level: 'info' | 'warning' | 'error', message: string) => void
}

/** 推送日志到全局日志 store（与其它页面共用底部日志区） */
function log(level: 'info' | 'warning' | 'error', message: string): void {
  useLogStore.getState().addLog({
    timestamp: new Date().toISOString(),
    level,
    message,
    source: 'omni-tool',
  })
}

/** 忙碌计数器：支持嵌套操作（如 startUpgrade 内部再 connect）正确叠加 */
let busyDepth = 0
function beginBusy(): void {
  busyDepth += 1
  useOmniToolStore.setState({ busy: true })
}
function endBusy(): void {
  busyDepth = Math.max(0, busyDepth - 1)
  useOmniToolStore.setState({ busy: busyDepth > 0 })
}

// ── 全局通知：所有操作统一在此展示进度与结果 ──────────────────────

/** 当前进行中操作的进度通知 id */
let activeNotifId: string | null = null

/** 阶段标签（与后端 omni_tools.session._STAGE_SPAN 的 stage 对应） */
const STAGE_LABEL: Record<string, string> = {
  info: '准备',
  set_addr: '设置地址',
  erase: '擦除',
  download: '下载',
  verify: '校验',
  read_back: '回读',
  leave: '跳转',
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** 开始一个带进度通知的操作 */
function beginOperation(title: string): void {
  beginBusy()
  activeNotifId = useNotificationStore.getState().push({
    type: 'progress',
    title,
    message: '准备中...',
    progress: 0,
    autoClose: false,
  })
}

/** 收到后端进度事件：更新全局通知的进度与文案 */
function updateProgress(p: OmniProgress): void {
  if (!activeNotifId) return
  const label = STAGE_LABEL[p.stage] ?? p.stage
  const detail = p.total > 0 ? ` ${formatBytes(p.current)} / ${formatBytes(p.total)}` : ''
  useNotificationStore.getState().update(activeNotifId, {
    progress: Math.max(0, Math.min(100, p.percent)),
    message: `${label}中...${detail}`,
  })
}

/** 结束操作：按结果切换通知类型 */
function endOperation(
  ok: boolean,
  title: string,
  message: string,
  errorTitle = '操作失败'
): void {
  const id = activeNotifId
  activeNotifId = null
  if (id) {
    useNotificationStore.getState().update(id, {
      type: ok ? 'success' : 'error',
      title: ok ? title : errorTitle,
      message,
      progress: ok ? 100 : undefined,
      autoClose: true,
      autoCloseDelay: ok ? 3000 : 6000,
    })
  }
  endBusy()
}

/** 自动扫描的最小间隔：打开下拉等高频时机共享同一次扫描，避免打爆串口枚举 */
const SCAN_THROTTLE_MS = 1500

/** 正在进行的扫描（避免并发请求；进行中的调用复用同一 Promise） */
let scanInFlight: Promise<void> | null = null

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
  refreshing: false,
  lastScanAt: 0,
  session: { connected: false, port: null, personality: 'unknown', busy: false } as OmniSessionState,
  info: null as OmniInfo | null,
  tabs: [
    {
      id: DEVICE_TAB_ID,
      kind: 'device',
      title: 'Device Memory',
      filePath: '',
      size: 0,
      format: 'bin',
      data: null,
      loading: false,
      byteWidth: 1,
      jumpAddr: '',
      scrollTop: 0,
      highlightOffset: null,
    },
  ] as OmniFileTab[],
  activeTabId: DEVICE_TAB_ID,
  lastFileTabId: null as string | null,
  showRangeDialog: false,
  busy: false,
}

export const useOmniToolStore = create<OmniToolStore>((set, get) => ({
  ...INITIAL_STATE,

  pushLog: (level, message) => log(level, message),

  onProgress: (p) => updateProgress(p),

  refreshDevices: async () => {
    // 节流：距上次扫描不足 SCAN_THROTTLE_MS 时直接跳过，交给打开下拉时的
    // refreshDevicesNow 强制刷新，避免高频时机反复枚举串口。
    if (useOmniToolStore.getState().lastScanAt &&
        Date.now() - useOmniToolStore.getState().lastScanAt < SCAN_THROTTLE_MS) {
      return
    }
    await useOmniToolStore.getState().refreshDevicesNow()
  },

  refreshDevicesNow: async () => {
    // 复用在途扫描：并发调用（打开下拉 + 路由进入 + 轮询）共享一次结果
    if (scanInFlight) return scanInFlight
    set({ refreshing: true })
    scanInFlight = (async () => {
      try {
        const res = await omniToolService.scan()
        set((s) => {
          // 保留已选设备；若已消失则回退到第一台，避免选择与列表不一致
          const stillThere = res.omni_devices.some((d) => d.port === s.selectedPort)
          return {
            devices: res.omni_devices,
            serialAvailable: res.serial_available,
            selectedPort: stillThere ? s.selectedPort : (res.omni_devices[0]?.port ?? null),
            lastScanAt: Date.now(),
          }
        })
      } catch (e) {
        log('error', omniToolErrorMessage(e))
      } finally {
        set({ refreshing: false })
      }
    })()
    try {
      await scanInFlight
    } finally {
      scanInFlight = null
    }
  },

  /**
   * 刷新设备列表，并重试直到出现目标人格的设备（设备刚复位/跳转时，
   * USB 重新枚举有延迟，立刻扫描常扫不到，会导致列表为空但会话仍显示已连接）。
   */
  refreshDevicesUntil: async (personality: OmniPersonality, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      // 轮询必须绕过节流，否则 500ms 间隔的等待会被 1.5s 节流窗口吞掉
      await get().refreshDevicesNow()
      const hit = get().devices.some((d) => d.personality === personality)
      if (hit || Date.now() >= deadline) return hit
      await new Promise((r) => setTimeout(r, 500))
    }
  },

  selectPort: (port) => set({ selectedPort: port }),

  connect: async (port) => {
    beginBusy()
    try {
      set({ info: null, selectedPort: port })
      const session = await omniToolService.connect(port)
      set({ session })
      log('info', `已连接 ${port}（${session.personality}）`)
      if (session.personality === 'app') {
        log('warning', '提示：进入 bootloader 会中断当前 DAP 调试会话')
      }
      await get().loadInfo()
    } catch (e) {
      log('error', `连接失败：${omniToolErrorMessage(e)}`)
    } finally {
      endBusy()
    }
  },

  disconnect: async () => {
    try {
      const session = await omniToolService.disconnect()
      set({ session, info: null })
      log('info', '已断开连接')
    } catch (e) {
      log('error', omniToolErrorMessage(e))
    }
  },

  loadInfo: async () => {
    const { session } = get()
    if (!session.connected) return
    try {
      const info = await omniToolService.info()
      set({ info })
      if (info.personality === 'boot') {
        log('info', `boot ${info.boot_version_str}，MCU UID ${info.mcu_uid}`)
      } else {
        log('info', `${info.vendor} ${info.product} v${info.fw_ver}`)
      }
    } catch (e) {
      log('error', `读取设备信息失败：${omniToolErrorMessage(e)}`)
    }
  },

  // ---- 文件 tab ----
  openFileTab: async () => {
    const path = await window.electron?.openFileDialog?.({
      extensions: ['bin', 'hex'],
      title: '选择 OMNI Tool 固件 (.bin / .hex)',
    })
    if (!path) return

    const id = genTabId()
    const title = path.split(/[\\/]/).pop() ?? path
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: 'file',
          title,
          filePath: path,
          format: path.toLowerCase().endsWith('.hex') ? 'hex' : 'bin',
          size: 0,
          data: null,
          loading: true,
          byteWidth: 1,
          jumpAddr: '',
          scrollTop: 0,
          highlightOffset: null,
        },
      ],
      activeTabId: id,
      lastFileTabId: id,
    }))

    // 读取文件内容供预览（地址固定为 App 区起点，由固件分区规定）
    try {
      const [info, data] = await Promise.all([parseFile(path), readFile(path)])
      get().updateTab(id, {
        data: data.data,
        size: data.size,
        loading: false,
        format: info.format === 'hex' ? 'hex' : 'bin',
      })
      log('info', `已加载 ${title}（${data.size} bytes）→ ${formatHexAddr(APP_DEFAULT_ADDRESS)}`)
    } catch (e) {
      log('error', `加载文件失败：${omniToolErrorMessage(e)}`)
      get().closeTab(id)
    }
  },

  selectTab: (id) =>
    // 记录最近选中的文件 tab：切换到 Device Memory 后仍可据此确定回读范围
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id)
      return {
        activeTabId: id,
        lastFileTabId: tab?.kind === 'file' ? id : s.lastFileTabId,
      }
    }),

  closeTab: (id) =>
    set((s) => {
      // 首个 Device Memory tab 不可关闭
      if (id === DEVICE_TAB_ID) return {}
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx < 0) return {}
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTabId
      // 若关掉的正是最近使用的文件 tab，回退到剩余的最后一个文件 tab
      const lastFileTabId =
        s.lastFileTabId === id
          ? (tabs.filter((t) => t.kind === 'file').slice(-1)[0]?.id ?? null)
          : s.lastFileTabId
      return { tabs, activeTabId, lastFileTabId }
    }),

  updateTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  // ---- 操作 ----
  enterBoot: async () => {
    beginOperation('进入 Bootloader')
    try {
      await omniToolService.enterBoot()
      log('info', '已下发 MODE_BOOT，等待设备重新枚举为 boot...')
      const boot = await waitForPersonality('boot')
      if (!boot) {
        // 超时：app 端口已失效，必须显式断开，否则页面停留在死连接上
        await get().disconnect()
        throw new Error('等待 boot 设备超时（请确认设备已复位并重新枚举）')
      }
      log('info', `boot 设备已就绪：${boot.port}`)
      await get().connect(boot.port)
      endOperation(true, '已进入 Bootloader', `boot 设备就绪：${boot.port}`)
      // 设备刚重新枚举，列表可能还没刷新到位：重试直到扫到 boot 设备
      await get().refreshDevicesUntil('boot')
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `进入 bootloader 失败：${msg}`)
      endOperation(false, '', msg, '进入 Bootloader 失败')
    }
  },

  startUpgrade: async () => {
    const { session, tabs, activeTabId } = get()
    const tab = tabs.find((t) => t.id === activeTabId)

    if (session.personality !== 'boot') {
      log('error', '请先进入 bootloader 模式并连接 boot 串口')
      return
    }
    if (!tab || tab.kind !== 'file') {
      log('error', '请先通过 + 打开要升级的固件文件')
      return
    }

    beginOperation('固件升级')
    try {
      const res = await omniToolService.upgrade(tab.filePath, APP_DEFAULT_ADDRESS)
      log('info', `升级完成：${res.size} bytes @ ${formatHexAddr(APP_DEFAULT_ADDRESS)}`)
      log('info', '设备将跳转回 app，等待重新枚举...')

      // 设备已 LEAVE，重新枚举为 app：等待新设备就绪并切回 app 会话，
      // 否则页面会停留在已失效的 boot 连接上（boot 端口已消失）
      const app = await waitForPersonality('app')
      if (!app) {
        // 超时：boot 端口已失效，必须显式断开，否则页面停留在死连接上
        await get().disconnect()
        log('warning', '等待 app 设备超时，已断开当前会话；请确认设备已启动')
        endOperation(true, '升级完成', `${formatBytes(res.size)} 已写入，设备未重新枚举`)
      } else {
        await get().connect(app.port)
        log('info', `升级闭环完成，设备已运行新固件：${app.port}`)
        endOperation(true, '升级完成', `${formatBytes(res.size)} 已写入，设备运行新固件`)
      }

      // 设备刚重新枚举，列表可能还没刷新到位：重试直到扫到 app 设备
      await get().refreshDevicesUntil('app')
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `升级失败：${msg}`)
      endOperation(false, '', msg, '升级失败')
    }
  },

  // ---- 单步操作 ----
  /** 单独校验当前文件与设备内容是否一致（不擦除、不写入） */
  verifyOnly: async () => {
    const { session, tabs, activeTabId } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (session.personality !== 'boot') {
      log('error', '请先进入 bootloader 模式')
      return
    }
    if (!tab || tab.kind !== 'file') {
      log('error', '请先通过 + 打开要校验的固件文件')
      return
    }
    beginOperation('校验固件')
    try {
      const res = await omniToolService.verify(tab.filePath, APP_DEFAULT_ADDRESS)
      if (res.verified) {
        const msg = `${formatBytes(res.size)} @ ${formatHexAddr(APP_DEFAULT_ADDRESS)}`
        log('info', `校验通过：${msg}`)
        endOperation(true, '校验通过', msg)
      } else {
        const where =
          res.offset != null ? formatHexAddr(res.address + res.offset) : '未知位置'
        const msg = `首个不一致位置 ${where}`
        log('error', `校验失败：${msg}`)
        endOperation(false, '', msg, '校验失败')
      }
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `校验失败：${msg}`)
      endOperation(false, '', msg, '校验失败')
    }
  },

  /** 回读设备内容到固定的 Device Memory tab
 *
 *  ``size`` 为空时回退到最近使用的固件文件长度；两者都没有则报错，
 *  正常流程下对话框会先让用户输入长度。
 */
  readBack: async (size?: number) => {
    const { session, tabs, lastFileTabId } = get()
    const source = tabs.find((t) => t.id === lastFileTabId && t.kind === 'file')
    if (session.personality !== 'boot') {
      log('error', '请先进入 bootloader 模式')
      return
    }
    const length = size ?? source?.size ?? 0
    if (length <= 0) {
      log('error', '请指定回读长度')
      return
    }

    get().updateTab(DEVICE_TAB_ID, { size: length, loading: true, data: null })
    beginOperation('回读设备')
    try {
      const res = await omniToolService.readBack(APP_DEFAULT_ADDRESS, length)
      get().updateTab(DEVICE_TAB_ID, { data: res.data, loading: false })
      log('info', `已回读 ${res.size} bytes @ ${formatHexAddr(APP_DEFAULT_ADDRESS)}`)
      endOperation(true, '回读完成', `${formatBytes(res.size)} @ ${formatHexAddr(APP_DEFAULT_ADDRESS)}`)
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `回读失败：${msg}`)
      get().updateTab(DEVICE_TAB_ID, { loading: false })
      endOperation(false, '', msg, '回读失败')
    }
  },

  /** 打开回读范围对话框（默认填入最近使用文件的地址/长度） */
  setShowRangeDialog: (open) => set({ showRangeDialog: open }),

  /** 与选中的参考文件做逐字节对比，生成 compare tab */
  compareWith: async (filePath: string) => {
    const { tabs, activeTabId } = get()
    const left = tabs.find((t) => t.id === activeTabId)
    if (!left?.data) {
      log('error', '当前 tab 没有可对比的数据')
      return
    }

    const notif = useNotificationStore.getState()
    const notifId = notif.push({ type: 'progress', title: '比较', message: '正在加载参考文件...' })

    try {
      const data = await readFile(filePath, APP_DEFAULT_ADDRESS)
      const refTitle = filePath.split(/[\\/]/).pop() ?? filePath
      const id = genTabId()

      set((s) => ({
        tabs: [
          ...s.tabs,
          {
            id,
            kind: 'compare',
            title: `Compare: ${left.title} vs ${refTitle}`,
            filePath: '',
            size: left.size,
            format: left.format,
            data: left.data,
            loading: false,
            byteWidth: left.byteWidth,
            jumpAddr: '',
            scrollTop: 0,
            highlightOffset: null,
            rightData: data.data,
            leftTitle: left.title,
            rightTitle: refTitle,
          },
        ],
        activeTabId: id,
      }))

      // 统计差异字节数
      const a = atob(left.data)
      const b = atob(data.data)
      const minLen = Math.min(a.length, b.length)
      let diff = 0
      for (let i = 0; i < minLen; i++) {
        if (a.charCodeAt(i) !== b.charCodeAt(i)) diff++
      }
      diff += Math.abs(a.length - b.length)

      notif.update(notifId, {
        type: diff === 0 ? 'success' : 'warning',
        title: '比较完成',
        message:
          diff === 0
            ? `完全匹配 (${formatBytes(minLen)})`
            : `${diff} 字节不同 (共 ${formatBytes(minLen)})`,
        autoClose: true,
        autoCloseDelay: 5000,
      })
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `比较失败：${msg}`)
      notif.update(notifId, {
        type: 'error',
        title: '比较失败',
        message: msg,
        autoClose: true,
        autoCloseDelay: 5000,
      })
    }
  },

  /** 从 bootloader 跳转到 app */
  startApp: async () => {
    const { session } = get()
    if (session.personality !== 'boot') {
      log('error', '当前设备不在 bootloader 模式')
      return
    }
    beginOperation('跳转到 App')
    try {
      const res = await omniToolService.leave()
      log('info', `已下发跳转（目标 ${formatHexAddr(res.address)}），等待设备重新枚举为 app...`)

      // boot 端口即将消失：先释放会话，再等待 app 重新枚举并接管
      await get().disconnect()
      const app = await waitForPersonality('app')
      if (!app) {
        log('warning', '等待 app 设备超时，请确认设备已启动')
        endOperation(true, '已跳转', '设备未重新枚举为 app，请确认已启动')
      } else {
        await get().connect(app.port)
        log('info', `app 已就绪：${app.port}`)
        endOperation(true, '已跳转到 App', `app 已就绪：${app.port}`)
      }
      // 设备刚重新枚举，列表可能还没刷新到位：重试直到扫到 app 设备
      await get().refreshDevicesUntil('app')
    } catch (e) {
      const msg = omniToolErrorMessage(e)
      log('error', `跳转失败：${msg}`)
      endOperation(false, '', msg, '跳转失败')
    }
  },
}))