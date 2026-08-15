import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as zoneService from '@/services/zone.service'
import type {
  ZoneSession,
  SourceFileInfo,
  ZoneResetMode,
  ZoneStepMode,
  SourceBreakpoint,
} from '@/services/zone.service'
import * as probeService from '@/services/probe.service'
import type { ConnectMode } from '@/services/probe.service'
import { programFlash } from '@/services/flash.service'
import { useNotificationStore } from '@/stores/notification.store'
import { useLogStore } from '@/stores/log.store'

/** 推送 Zone 操作日志到全局日志区（来源 zone，便于全局按来源筛选查看） */
function zoneLog(level: 'info' | 'warning' | 'error', message: string) {
  useLogStore.getState().addLog({
    timestamp: new Date().toISOString(),
    level,
    message,
    source: 'zone',
  })
}

/** 从请求错误中提取后端返回的明确原因（FastAPI detail），优先于 axios 的 "Request failed with status code XXX" */
export function extractApiErrorDetail(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail.trim()
  return null
}

/** 将断点操作的后端错误详情翻译为友好的中文提示（后端为英文，直接展示用户看不懂） */
function friendlyBreakpointError(detail: string): string {
  if (/^No code at /.test(detail)) {
    const loc = detail.replace(/^No code at /, '')
    return `该行没有可执行代码，无法设置断点（${loc}）`
  }
  if (detail === 'No ELF loaded') return '未加载 ELF 固件，无法设置断点'
  if (detail === 'Probe not connected') return '探针未连接，无法设置断点'
  if (detail.startsWith('Target not available')) {
    const reason = detail.replace(/^Target not available:?\s*/, '')
    return `目标不可用，无法设置断点${reason ? `：${reason}` : ''}`
  }
  return detail
}

/** 右侧检查器 dock 的 section 类型 */
export type InspectorTabId = 'disasm' | 'callstack' | 'registers' | 'peripherals'

/** 刷新策略模式 */
export type RefreshMode = 'on_stop' | 'periodic_always' | 'off'

/** 兼容旧持久化数据：periodic_running 已移除，映射为 periodic_always */
function normalizeRefreshMode(v: unknown): RefreshMode {
  if (v === 'periodic_running') return 'periodic_always'
  return v === 'off' || v === 'periodic_always' || v === 'on_stop' ? v : 'on_stop'
}

/** Zone 会话启动方式（Load ELF 下拉选项） */
export type ZoneStartMode = 'download_reset' | 'attach_running' | 'attach_halt'

/** 内存窗口：独立锚点地址 + 分组宽度 + 端序 */
export interface MemoryWindow {
  id: string
  /** 窗口名（如 Memory 1） */
  name: string
  /** 地址（hex 字符串，支持 0x 前缀） */
  address: string
  /** 分组字节宽度 */
  byteWidth: 1 | 2 | 4
  bigEndian: boolean
}

/** Watch 观察项：持久化定义（expr/format），运行时值由面板求值刷新 */
export interface WatchItem {
  id: number
  /** 观察表达式：寄存器名 / 0x 地址 / 符号名 */
  expr: string
  /** 值显示格式 */
  format: 'hex' | 'dec' | 'bin' | 'char' | 'str' | 'float'
}

/** Watch 页签：一组观察项（多 tab 对比，上限 4 个） */
export interface WatchTab {
  id: string
  /** 页签名（如 Watch 1） */
  name: string
  items: WatchItem[]
}

interface ZoneStore {
  // ── 调试状态 ──────────────────────────────
  /** 目标状态 */
  state: 'disconnected' | 'running' | 'halted' | 'unknown'
  /** 当前 PC */
  pc: number | null
  /** PC 所在函数名（为空表示当前不在函数内，用于禁用 Step Out） */
  currentFunction: string | null
  /** 调试操作是否进行中 */
  busy: boolean
  /** 错误信息 */
  error: string | null

  // ── ELF ───────────────────────────────────
  /** 已加载 ELF 路径 */
  elfPath: string | null
  /** ELF 源文件列表 */
  sourceFiles: SourceFileInfo[]
  /** 已打开的源码 tab（完整路径列表） */
  openFiles: string[]
  /** 当前激活的源文件 tab */
  activeSourceFile: string | null
  /** 用户主动关闭、不应被 PC 自动跟随重新打开的源文件 */
  closedByUser: string[]
  /** 是否自动跟随 PC 执行文件（调试默认开启；用户手动切换 tab/文件后暂停，调试动作恢复） */
  followSource: boolean
  /** 是否支持反汇编 */
  disasmAvailable: boolean

  // ── 检查器 ────────────────────────────────
  /** 当前检查器 tab */
  activeInspectorTab: InspectorTabId
  /** 内存查看地址（字符串，支持 0x 前缀）——兼容持久化，始终与激活窗口地址同步 */
  memoryAddress: string
  /** 内存窗口列表（多窗口，至少保留一个） */
  memoryWindows: MemoryWindow[]
  /** 激活的内存窗口 id */
  activeMemoryWindow: string
  /** Watch 页签列表（多 tab，至少保留一个，上限 4） */
  watchTabs: WatchTab[]
  /** 激活的 Watch 页签 id */
  activeWatchTab: string

  // ── 刷新策略 ──────────────────────────────
  refreshMode: RefreshMode
  /** 刷新纪元：每次目标 halt 事件 / 调试动作完成时递增，驱动检查器面板在
   *  快速循环（每次停在同一断点同 PC）时仍能刷新——on_stop 仅靠 state/pc 差值
   *  判断会漏触发 */
  refreshTick: number

  // ── 会话 ───────────────────────────────────
  sessions: ZoneSession[]
  /** Zone 调试会话生命周期：idle 未启动 / connecting 启动中 / active 已启动（与目标连接状态正交） */
  sessionStatus: 'idle' | 'connecting' | 'active'
  /** 会话版本号：每次 start/stop/断开时递增，用于拦截跨会话的僵尸异步回调（如被 stop 中断的 startSession 仍置 active） */
  sessionNonce: number

  // ── 断点 ───────────────────────────────────
  breakpoints: SourceBreakpoint[]
  /** 源码视图当前光标所在行（供 Run to Cursor / Insert-Remove Breakpoint 使用） */
  cursorLine: { file: string; line: number } | null
  /** 「转到定义/引用」导航目标：打开该文件并滚动到指定行 */
  navGoto: { file: string; line: number } | null

  // ── 操作 ──────────────────────────────────
  setState: (s: ZoneStore['state']) => void
  setPc: (pc: number | null) => void
  setCurrentFunction: (fn: string | null) => void
  setBusy: (busy: boolean) => void
  setError: (error: string | null) => void
  setElfPath: (path: string | null) => void
  setSourceFiles: (files: SourceFileInfo[]) => void
  setActiveSourceFile: (file: string | null) => void
  setDisasmAvailable: (v: boolean) => void
  setFollowSource: (v: boolean) => void
  /** 用户打开文件/tab：加入 openFiles 并激活，同时暂停自动跟随（用户主动选择） */
  openSourceFile: (file: string) => void
  /** 自动跟随：仅保证文件已打开（不改变激活项与跟随状态） */
  ensureSourceFile: (file: string) => void
  /** 关闭源码 tab；若关闭的是激活项则激活相邻 tab */
  closeSourceFile: (file: string) => void
  /** 关闭指定文件之外的所有 tab（保留 file，其余关闭并标记为已关闭） */
  closeOtherFiles: (file: string) => void
  /** 关闭全部 tab */
  closeAllFiles: () => void
  setActiveInspectorTab: (tab: InspectorTabId) => void
  setMemoryAddress: (addr: string) => void
  /** 新建内存窗口（默认复制激活窗口设置；preset 可覆盖） */
  addMemoryWindow: (preset?: Partial<MemoryWindow>) => void
  /** 关闭内存窗口（至少保留一个，关闭的是激活项时切换到相邻窗口） */
  closeMemoryWindow: (id: string) => void
  /** 切换激活的内存窗口 */
  selectMemoryWindow: (id: string) => void
  /** 更新内存窗口的局部设置（地址/宽度/端序/格式），并同步 memoryAddress */
  updateMemoryWindow: (id: string, patch: Partial<MemoryWindow>) => void
  /** 添加 Watch 观察项到激活页签（按表达式去重，返回是否新增） */
  addWatchItem: (expr: string) => boolean
  /** 添加 Watch 观察项到指定页签（按表达式去重，返回是否新增） */
  addWatchItemToTab: (tabId: string, expr: string) => boolean
  /** 从指定页签移除 Watch 观察项 */
  removeWatchItem: (tabId: string, id: number) => void
  /** 设置指定页签内 Watch 观察项显示格式 */
  setWatchItemFormat: (tabId: string, id: number, format: WatchItem['format']) => void
  /** 清空指定页签（缺省为激活页签）全部 Watch 观察项 */
  clearWatchItems: (tabId?: string) => void
  /** 新建 Watch 页签（上限 4，自动命名 Watch N） */
  addWatchTab: () => void
  /** 关闭 Watch 页签（至少保留一个，关闭激活项时切换到相邻页签） */
  closeWatchTab: (id: string) => void
  /** 切换激活的 Watch 页签 */
  selectWatchTab: (id: string) => void
  /** 重命名 Watch 页签 */
  renameWatchTab: (id: string, name: string) => void
  /** 将观察项从激活页签移动到目标页签 */
  moveWatchItemToTab: (itemId: number, toTabId: string) => void
  setRefreshMode: (mode: RefreshMode) => void
  setBreakpoints: (bps: SourceBreakpoint[]) => void
  /** 设置源码视图当前光标所在行 */
  setCursorLine: (loc: { file: string; line: number } | null) => void
  /** 打开文件并导航到指定行（转到定义/引用） */
  gotoSource: (file: string, line: number) => void
  /** 清除导航目标 */
  clearGoto: () => void

  /** 调试控制动作（调用后端后刷新状态） */
  halt: (uid: string) => Promise<void>
  step: (uid: string, mode?: ZoneStepMode) => Promise<void>
  continue: (uid: string) => Promise<void>
  reset: (uid: string, mode?: ZoneResetMode) => Promise<void>
  /** 停止调试会话（断开探针连接） */
  stopSession: (uid: string) => Promise<void>
  refreshStatus: (uid: string) => Promise<void>

  /** 源码断点：切换某行断点并刷新列表 */
  toggleBreakpoint: (uid: string, file: string, line: number) => Promise<boolean>
  /** 运行到光标所在行（临时断点 + 继续运行，命中后暂停） */
  runToCursor: (uid: string, file: string, line: number) => Promise<void>
  /** 清除当前目标全部断点 */
  clearBreakpoints: (uid: string) => Promise<void>
  refreshBreakpoints: (uid: string) => Promise<void>

  /** ELF 加载（silent=true 时不弹全局通知，用于 startSession 内合并为一条通知） */
  loadElf: (uid: string, path: string, silent?: boolean) => Promise<boolean>

  /** 启动调试会话（自动重连并绑定连接模式） */
  startSession: (uid: string, mode: ZoneStartMode, path: string) => Promise<boolean>

  /** 会话管理 */
  fetchSessions: () => Promise<void>
  saveSession: (name: string) => Promise<void>
  loadSession: (name: string) => Promise<void>
  deleteSession: (name: string) => Promise<void>
}

/** 从 store 收集会话配置数据 */
function collectSessionData(get: () => ZoneStore): Record<string, unknown> {
  const s = get()
  return {
    elfPath: s.elfPath,
    activeSourceFile: s.activeSourceFile,
    activeInspectorTab: s.activeInspectorTab,
    memoryAddress: s.memoryAddress,
    refreshMode: s.refreshMode,
    watchTabs: s.watchTabs,
    activeWatchTab: s.activeWatchTab,
  }
}

export const useZoneStore = create<ZoneStore>()(
  persist(
    (set, get) => ({
      // ── 初始状态 ──────────────────────────
      state: 'disconnected',
      sessionStatus: 'idle',
      sessionNonce: 0,
      pc: null,
      currentFunction: null,
      busy: false,
      error: null,

      elfPath: null,
      sourceFiles: [],
      openFiles: [],
      activeSourceFile: null,
      closedByUser: [],
      followSource: true,
      disasmAvailable: false,

      activeInspectorTab: 'registers',
      memoryAddress: '0x20000000',
      memoryWindows: [{ id: 'mem-1', name: 'Memory 1', address: '0x20000000', byteWidth: 1, bigEndian: false }],
      activeMemoryWindow: 'mem-1',
      watchTabs: [{ id: 'watch-1', name: 'Watch 1', items: [] }],
      activeWatchTab: 'watch-1',

      refreshMode: 'on_stop',
      refreshTick: 0,

      sessions: [],

      breakpoints: [],
      cursorLine: null,
      navGoto: null,

      // ── 操作 ──────────────────────────────
      setState: (state) => set({ state }),
      setPc: (pc) => set({ pc }),
      setCurrentFunction: (currentFunction) => set({ currentFunction }),
      setBusy: (busy) => set({ busy }),
      setError: (error) => set({ error }),
      setElfPath: (elfPath) => set({ elfPath }),
      setSourceFiles: (sourceFiles) => set({ sourceFiles }),
      setActiveSourceFile: (activeSourceFile) => set({ activeSourceFile }),
      setDisasmAvailable: (disasmAvailable) => set({ disasmAvailable }),
      setFollowSource: (v) => set({ followSource: v }),
      openSourceFile: (file) =>
        set((s) => ({
          openFiles: s.openFiles.includes(file) ? s.openFiles : [...s.openFiles, file],
          activeSourceFile: file,
          followSource: false,
          // 用户主动重新打开，解除"已关闭"标记
          closedByUser: s.closedByUser.filter((f) => f !== file),
        })),
      ensureSourceFile: (file) =>
        set((s) => ({
          // 用户主动关闭过的文件不再被 PC 自动跟随重新打开（尊重用户关闭意图）
          openFiles:
            s.closedByUser.includes(file) || s.openFiles.includes(file)
              ? s.openFiles
              : [...s.openFiles, file],
        })),
      closeSourceFile: (file) =>
        set((s) => {
          const openFiles = s.openFiles.filter((f) => f !== file)
          let activeSourceFile = s.activeSourceFile
          if (file === s.activeSourceFile) {
            const idx = s.openFiles.indexOf(file)
            const next = openFiles[idx] ?? openFiles[idx - 1] ?? null
            activeSourceFile = next ?? null
          }
          return {
            openFiles,
            activeSourceFile,
            // 记录用户主动关闭的文件，避免 PC 定位时被重新打开
            closedByUser: s.closedByUser.includes(file) ? s.closedByUser : [...s.closedByUser, file],
          }
        }),
      closeOtherFiles: (file) =>
        set((s) => {
          const closed = s.openFiles.filter((f) => f !== file)
          return {
            openFiles: [file],
            activeSourceFile: file,
            // 仅保留 file 未标记关闭；其余关闭的文件加入 closedByUser，避免 PC 自动重新打开
            closedByUser: [...s.closedByUser.filter((f) => f !== file), ...closed],
          }
        }),
      closeAllFiles: () =>
        set((s) => ({
          openFiles: [],
          activeSourceFile: null,
          // 全部 tab 关闭：所有已打开文件标记为已关闭，避免 PC 自动跟随重新打开
          closedByUser: [...s.closedByUser, ...s.openFiles],
        })),
      setActiveInspectorTab: (activeInspectorTab) => set({ activeInspectorTab }),
      setMemoryAddress: (memoryAddress) => set({ memoryAddress }),
      addMemoryWindow: (preset) =>
        set((s) => {
          if (s.memoryWindows.length >= 4) return {} // 内存窗口上限 4
          const active = s.memoryWindows.find((w) => w.id === s.activeMemoryWindow)
          const base = active ?? s.memoryWindows[0] ?? { address: '0x20000000', byteWidth: 1, bigEndian: false }
          const id = 'mem-' + Math.random().toString(36).slice(2, 8)
          const win: MemoryWindow = {
            id,
            name: `Memory ${s.memoryWindows.length + 1}`,
            address: preset?.address ?? base.address,
            byteWidth: preset?.byteWidth ?? base.byteWidth,
            bigEndian: preset?.bigEndian ?? base.bigEndian,
          }
          return { memoryWindows: [...s.memoryWindows, win], activeMemoryWindow: id }
        }),
      closeMemoryWindow: (id) =>
        set((s) => {
          if (s.memoryWindows.length <= 1) return {} // 至少保留一个
          const windows = s.memoryWindows.filter((w) => w.id !== id)
          let active = s.activeMemoryWindow
          if (active === id) {
            const idx = s.memoryWindows.findIndex((w) => w.id === id)
            active = (windows[idx] ?? windows[idx - 1] ?? windows[0]).id
          }
          const activeWin = windows.find((w) => w.id === active) ?? windows[0]
          // 同步 memoryAddress（兼容持久化）
          return { memoryWindows: windows, activeMemoryWindow: active, memoryAddress: activeWin.address }
        }),
      selectMemoryWindow: (id) =>
        set((s) => {
          const win = s.memoryWindows.find((w) => w.id === id)
          return win ? { activeMemoryWindow: id, memoryAddress: win.address } : {}
        }),
      updateMemoryWindow: (id, patch) =>
        set((s) => {
          const windows = s.memoryWindows.map((w) => (w.id === id ? { ...w, ...patch } : w))
          // 更新激活窗口且改了地址时，同步 memoryAddress
          const addrChanged = (patch.address !== undefined) && id === s.activeMemoryWindow
          const activeWin = windows.find((w) => w.id === s.activeMemoryWindow) ?? windows[0]
          return addrChanged ? { memoryWindows: windows, memoryAddress: activeWin.address } : { memoryWindows: windows }
        }),
      setRefreshMode: (refreshMode) => set({ refreshMode }),
      addWatchItem: (expr) => get().addWatchItemToTab(get().activeWatchTab, expr),
      addWatchItemToTab: (tabId, expr) => {
        const trimmed = expr.trim()
        if (!trimmed) return false
        const s = get()
        const tab = s.watchTabs.find((t) => t.id === tabId)
        if (!tab) return false
        if (tab.items.some((i) => i.expr.toLowerCase() === trimmed.toLowerCase())) return false
        const nextId = s.watchTabs.reduce((m, t) => t.items.reduce((mm, i) => Math.max(mm, i.id), m), 0) + 1
        set({
          watchTabs: s.watchTabs.map((t) =>
            t.id === tabId ? { ...t, items: [...t.items, { id: nextId, expr: trimmed, format: 'hex' }] } : t
          ),
        })
        return true
      },
      removeWatchItem: (tabId, id) =>
        set((s) => ({
          watchTabs: s.watchTabs.map((t) => (t.id === tabId ? { ...t, items: t.items.filter((i) => i.id !== id) } : t)),
        })),
      setWatchItemFormat: (tabId, id, format) =>
        set((s) => ({
          watchTabs: s.watchTabs.map((t) =>
            t.id === tabId ? { ...t, items: t.items.map((i) => (i.id === id ? { ...i, format } : i)) } : t
          ),
        })),
      clearWatchItems: (tabId) =>
        set((s) => {
          const target = tabId ?? s.activeWatchTab
          return { watchTabs: s.watchTabs.map((t) => (t.id === target ? { ...t, items: [] } : t)) }
        }),
      addWatchTab: () =>
        set((s) => {
          if (s.watchTabs.length >= 4) return {}
          const n = s.watchTabs.length + 1
          const id = 'watch-' + Math.random().toString(36).slice(2, 8)
          const tab: WatchTab = { id, name: `Watch ${n}`, items: [] }
          return { watchTabs: [...s.watchTabs, tab], activeWatchTab: id }
        }),
      closeWatchTab: (id) =>
        set((s) => {
          if (s.watchTabs.length <= 1) return {}
          // Watch1（首个页签）不可删除
          if (s.watchTabs.findIndex((t) => t.id === id) === 0) return {}
          const tabs = s.watchTabs.filter((t) => t.id !== id)
          let active = s.activeWatchTab
          if (active === id) {
            const idx = s.watchTabs.findIndex((t) => t.id === id)
            active = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id
          }
          return { watchTabs: tabs, activeWatchTab: active }
        }),
      selectWatchTab: (id) =>
        set((s) => (s.watchTabs.some((t) => t.id === id) ? { activeWatchTab: id } : {})),
      renameWatchTab: (id, name) =>
        set((s) => ({
          watchTabs: s.watchTabs.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)),
        })),
      moveWatchItemToTab: (itemId, toTabId) =>
        set((s) => {
          let moved: WatchItem | null = null
          let fromTabId: string | null = null
          const tabs = s.watchTabs.map((t) => {
            const idx = t.items.findIndex((i) => i.id === itemId)
            if (idx >= 0) {
              moved = t.items[idx]
              fromTabId = t.id
              return { ...t, items: t.items.filter((i) => i.id !== itemId) }
            }
            return t
          })
          if (!moved || !fromTabId || fromTabId === toTabId) return {}
          return {
            watchTabs: tabs.map((t) => (t.id === toTabId ? { ...t, items: [...t.items, moved!] } : t)),
          }
        }),
      setBreakpoints: (breakpoints) => set({ breakpoints }),
      setCursorLine: (cursorLine) => set({ cursorLine }),
      gotoSource: (file, line) => {
        // 打开并激活文件（用户主动导航，暂停 PC 自动跟随），记录导航目标
        get().openSourceFile(file)
        set({ navGoto: { file, line } })
      },
      clearGoto: () => set({ navGoto: null }),

      halt: async (uid) => {
        set({ busy: true, error: null, followSource: true })
        try {
          await zoneService.zoneHalt(uid)
          zoneLog('info', 'Zone Halt')
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Halt failed'
          set({ busy: false, error: msg })
          zoneLog('error', `Zone Halt failed: ${msg}`)
          useNotificationStore.getState().push({ type: 'error', title: 'Halt failed', message: msg })
        }
      },

      step: async (uid, mode = 'into') => {
        set({ busy: true, error: null, followSource: true })
        try {
          // 刷新真实状态，避免依据过期的 state 判断（如 download&reset 后目标是 running）
          await get().refreshStatus(uid)
          // 目标运行中先暂停，再单步（后端 step 亦会兜底自动 halt，此处提前处理保证 UI 状态一致）
          if (get().state === 'running') {
            await zoneService.zoneHalt(uid)
          }
          await zoneService.zoneStep(uid, mode)
          zoneLog('info', `Zone Step [${mode}]`)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false, refreshTick: get().refreshTick + 1 })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Step failed'
          set({ busy: false, error: msg })
          zoneLog('error', `Zone Step failed: ${msg}`)
          useNotificationStore.getState().push({ type: 'error', title: 'Step failed', message: msg })
        }
      },

      continue: async (uid) => {
        // 目标已在运行：Run 按钮此时已禁用（state!=='halted'），此处兜底拦截
        // 状态刷新延迟造成的一瞬连点，避免重复 continue 堆积 SWD 流量。
        // 注意不是静默吞掉常规点击——按钮禁用已在 UI 层给出明确 affordance。
        if (get().state === 'running') return
        set({ busy: true, error: null, followSource: true })
        try {
          await zoneService.zoneContinue(uid)
          zoneLog('info', 'Zone Run (continue)')
          const st = await zoneService.zoneStatus(uid)
          // 每次 Run 都递增刷新纪元，驱动 Memory/外设面板刷新，
          // 覆盖「每次停在同一断点同 PC」导致 on_stop 差值判断漏刷新的场景
          set({ state: st.state, pc: st.pc, busy: false, refreshTick: get().refreshTick + 1 })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Continue failed'
          set({ busy: false, error: msg })
          zoneLog('error', `Zone Run failed: ${msg}`)
          useNotificationStore.getState().push({ type: 'error', title: 'Continue failed', message: msg })
        }
      },

      reset: async (uid, mode = 'halt') => {
        set({ busy: true, error: null, followSource: true })
        try {
          await zoneService.zoneReset(uid, mode)
          zoneLog('info', `Zone Reset [${mode}]`)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false, refreshTick: get().refreshTick + 1 })
        } catch (err) {
          const detail = extractApiErrorDetail(err)
          const fallback = err instanceof Error ? err.message : 'Reset failed'
          const msg = detail ?? fallback
          set({ busy: false, error: msg })
          zoneLog('error', `Zone Reset failed: ${msg}`)
          useNotificationStore.getState().push({ type: 'error', title: 'Reset failed', message: msg })
        }
      },

      refreshStatus: async (uid) => {
        try {
          const st = await zoneService.zoneStatus(uid)
          // 仅会话 active 时落地 status/pc：连接中/未启动/停止等过渡期可能会有发起于旧会话的
          // 过期轮询并发返回，若无条件写入会用旧数据覆盖「已停止/未启动」的正确空态，
          // 导致面板显示陈旧内容、运行指示跳转到错误位置。
          if (get().sessionStatus === 'active') {
            const prev = get().state
            const patch: Partial<ZoneStore> = { state: st.state, pc: st.pc }
            // 检测「非暂停 → 暂停」的 halt 跳变：递增刷新纪元，驱动检查器面板在断点命中时
            // 刷新（覆盖目标自行运行命中断点、非按钮触发的场景）
            if (st.state === 'halted' && prev !== 'halted') {
              patch.refreshTick = get().refreshTick + 1
            }
            set(patch)
          }
        } catch {
          // 忽略（连接断开时）
        }
      },

      stopSession: async (uid) => {
        // 递增会话版本号：使任何进行中的 startSession 回调失效，防止「点 stop 后，旧 start 仍在
        // 烧录/复位，随后又回头把 sessionStatus 置回 active」的僵尸启动覆盖 stop 状态。
        const nonce = get().sessionNonce + 1
        set({ busy: true, error: null, sessionNonce: nonce })
        try {
          await probeService.disconnectProbe(uid)
          // 停止会话：全量重置会话态。ELF 派生数据（elfPath/sourceFiles/openFiles/activeSourceFile）
          // 与 PC 跟随状态（closedByUser/followSource/pc/currentFunction）必须一并清空——
          // 否则下次 start 时 elfLoaded 不翻转、fetch 面板不重拉，且被用户关闭过的文件会一直
          // 阻塞运行指示自动跟随，导致「面板加载不到内容 / 运行指示跳转不到对应文件」。
          set({
            state: 'disconnected',
            sessionStatus: 'idle',
            pc: null,
            currentFunction: null,
            busy: false,
            breakpoints: [],
            elfPath: null,
            sourceFiles: [],
            openFiles: [],
            activeSourceFile: null,
            closedByUser: [],
            followSource: true,
          })
          zoneLog('info', 'Zone Stop debug session')
          useNotificationStore.getState().push({
            type: 'success',
            title: 'Stop debug session',
            message: '调试会话已停止',
            autoClose: true,
            autoCloseDelay: 3000,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Stop failed'
          set({ busy: false, error: msg })
          zoneLog('error', `Zone Stop debug session failed: ${msg}`)
          useNotificationStore.getState().push({ type: 'error', title: '停止调试会话失败', message: msg })
        }
      },

      refreshBreakpoints: async (uid) => {
        try {
          const res = await zoneService.zoneListBreakpoints(uid)
          if (res.success) set({ breakpoints: res.breakpoints })
        } catch {
          // 忽略（连接断开时）
        }
      },

      toggleBreakpoint: async (uid, file, line) => {
        const { breakpoints } = get()
        const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
        const cur = norm(file)
        const existing = breakpoints.find(
          (b) => b.line === line && (norm(b.file) === cur || norm(b.file).endsWith('/' + cur) || cur.endsWith('/' + norm(b.file)))
        )
        try {
          await zoneService.zoneSetBreakpoint(uid, file, line, !existing)
          zoneLog('info', `Zone ${existing ? 'Remove' : 'Set'} breakpoint at ${file}:${line}`)
          await get().refreshBreakpoints(uid)
          return true
        } catch (err) {
          // 优先展示后端返回的明确原因（如"该行无代码"），并翻译为中文，避免只显示
          // axios 的 "Request failed with status code 400" 让用户无法理解。
          const detail = extractApiErrorDetail(err)
          const fallback = err instanceof Error ? err.message : 'Breakpoint failed'
          const msg = friendlyBreakpointError(detail ?? fallback)
          set({ error: msg })
          zoneLog('error', `Zone breakpoint failed: ${msg}`)
          useNotificationStore.getState().push({ type: 'error', title: '断点操作失败', message: msg })
          return false
        }
      },

      runToCursor: async (uid, file, line) => {
        set({ busy: true, error: null, followSource: true })
        try {
          await zoneService.zoneRunToCursor(uid, file, line)
          zoneLog('info', `Zone Run to Cursor ${file}:${line}`)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false, refreshTick: get().refreshTick + 1 })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Run to cursor failed'
          set({ busy: false, error: msg })
          zoneLog('error', `Zone Run to Cursor failed: ${msg}`)
          useNotificationStore.getState().push({ type: 'error', title: 'Run to Cursor 失败', message: msg })
        }
      },

      clearBreakpoints: async (uid) => {
        set({ busy: true, error: null })
        try {
          const res = await zoneService.zoneClearBreakpoints(uid)
          zoneLog('info', `Zone Remove ${res.cleared ?? 0} breakpoint(s)`)
          set({ breakpoints: [], busy: false })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Clear breakpoints failed'
          set({ busy: false, error: msg })
          zoneLog('error', `Zone Clear breakpoints failed: ${msg}`)
          useNotificationStore.getState().push({ type: 'error', title: '清除断点失败', message: msg })
        }
      },

      loadElf: async (uid, path, silent = false) => {
        set({ busy: true, error: null })
        try {
          const result = await zoneService.zoneLoadElf(uid, path)
          // 拉取含大小的源文件列表
          let files: SourceFileInfo[] = []
          try {
            files = await zoneService.zoneSourceFiles(uid)
          } catch {
            files = result.source_files.map((p) => ({ path: p, name: p.split('/').pop() ?? p, size: null }))
          }
          // 不自动选中首个源文件：会话启动后由 PC 跟随定位到 PC 所在文件（如 Reset_Handler 的
          // startup 文件）。否则每次 start session 都会先打开 source_files[0]（如 stm32f4xx_hal.c）
          // 再跳转到 PC 文件，造成源码窗先开一个无关文件再切换的抖动。
          set({
            elfPath: result.path,
            sourceFiles: files,
            activeSourceFile: null,
            openFiles: [],
            followSource: true,
            disasmAvailable: result.disasm_available,
            busy: false,
          })
          if (!silent) {
            useNotificationStore.getState().push({
              type: 'success',
              title: 'ELF 已加载',
              message: result.path.split(/[\\/]/).pop() ?? result.path,
              autoClose: true,
              autoCloseDelay: 3000,
            })
          }
          return true
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'ELF load failed'
          set({ busy: false, error: msg })
          useNotificationStore.getState().push({
            type: 'error',
            title: 'ELF 加载失败',
            message: msg,
          })
          return false
        }
      },

      startSession: async (uid, mode, path) => {
        // 每次启动前递增会话版本号：标识本次会话。后续所有落地状态都校验该版本号，
        // 若期间被 stopSession/断开 bump 过（版本号已变），则本次启动的烧录/复位/刷新回调
        // 一律作废，避免旧会话在 stop 之后回头把 sessionStatus 置回 active。
        const nonce = get().sessionNonce + 1
        set({ busy: true, error: null, followSource: true, sessionStatus: 'connecting', sessionNonce: nonce })
        // 每个会话启动方式绑定所需连接模式
        const connectMode: ConnectMode = mode === 'download_reset' ? 'halt' : 'attach'
        const labels: Record<ZoneStartMode, string> = {
          download_reset: 'Download & Reset',
          attach_running: 'Attach to Running',
          attach_halt: 'Attach & Halt',
        }
        const summary: Record<ZoneStartMode, string> = {
          download_reset: '下载完成，目标已复位并暂停',
          attach_running: '已附加到运行中的程序，会话已启动',
          attach_halt: '目标已暂停，会话已启动',
        }
        // 「启动中」全局通知：加载期间保持显示（autoClose:false），完成后 update 为 success/error 再自动隐藏
        const notifId = useNotificationStore.getState().push({
          type: 'progress',
          title: '正在加载会话...',
          message: '正在连接设备...',
          autoClose: false,
        })
        try {
          // 1. 强制以绑定模式重连（自动切换连接模式，避免与全局设置冲突）
          await probeService.connectProbe(uid, { connect_mode: connectMode, force: true })
          useNotificationStore.getState().update(notifId, { message: '正在加载 ELF 符号...' })
          // 2. 加载 ELF 符号（静默模式，避免与下方会话通知重复弹窗）
          const ok = await get().loadElf(uid, path, true)
          if (!ok) {
            // loadElf 失败：恢复 idle（其内部已写 busy:false/error），避免停留在 connecting
            if (get().sessionNonce === nonce) set({ sessionStatus: 'idle' })
            useNotificationStore.getState().dismiss(notifId)
            return false
          }
          // 3. 会话动作
          if (mode === 'download_reset') {
            // 烧录（不自动运行）。复位并暂停在 Reset_Handler（参考 Keil：会话启动不自动运行到 main，
            // 由用户手动 [Run]/[Step] 进入程序，避免在调试起点上强加 breakpoint 副作用）
            useNotificationStore.getState().update(notifId, { message: '正在下载固件并复位目标...' })
            const flashRes = await programFlash(uid, path, true, false)
            zoneLog('info', 'Zone Download & Reset Program')
            // 烧录是「软失败」：接口返回 success=false 但 HTTP 层面不抛错（如 SWD 通信失败）。
            // 此时连接可能已中断，必须在此中止启动，避免继续执行已失效的 reset 再抛一次误导性错误。
            if (!flashRes.success) {
              throw new Error(
                flashRes.error
                  ? `固件下载失败：${flashRes.error}`
                  : '固件下载失败，请检查仿真器与目标板连接，或降低调试时钟频率'
              )
            }
            await get().reset(uid, 'halt')
          } else if (mode === 'attach_halt') {
            useNotificationStore.getState().update(notifId, { message: '正在暂停目标...' })
            await get().halt(uid)
          } else {
            useNotificationStore.getState().update(notifId, { message: '正在附加到运行中的程序...' })
          }
          // attach_running：保持目标运行，无需额外动作
          // 若在此过程中会话已被 stop（版本号已变），丢弃本次结果，避免僵尸启动覆盖 stop 状态
          if (get().sessionNonce !== nonce) {
            // 启动被中途停止：撤销这条「启动中」通知（stopSession 已有自己的停会话通知）
            useNotificationStore.getState().dismiss(notifId)
            return false
          }
          // 先置 active 再刷新状态：refreshStatus 仅在 active 时落地 state/pc，
          // 保证首页首次展示的即是本次会话的真实运行状态
          set({ sessionStatus: 'active' })
          await get().refreshStatus(uid)
          set({ busy: false })
          // 启动完成：同一条通知转为成功态并自动关闭（慢慢隐藏）
          useNotificationStore.getState().update(notifId, {
            type: 'success',
            title: labels[mode],
            message: summary[mode],
            autoClose: true,
            autoCloseDelay: 3000,
          })
          return true
        } catch (err) {
          // 优先展示后端返回的明确原因（如探针未连接、目标未选择、烧录失败等），
          // 避免只显示 axios 的 "Request failed with status code 500" 让用户无法理解。
          const detail = extractApiErrorDetail(err)
          const fallback = err instanceof Error ? err.message : 'Start session failed'
          const msg = detail ?? fallback
          // 仅当仍由本次启动负责状态（未被 stop 覆盖）时才写回 idle/error
          if (get().sessionNonce === nonce) set({ busy: false, error: msg, sessionStatus: 'idle' })
          useNotificationStore.getState().update(notifId, {
            type: 'error',
            title: '会话启动失败',
            message: msg,
            autoClose: true,
            autoCloseDelay: 5000,
          })
          return false
        }
      },

      fetchSessions: async () => {
        try {
          const sessions = await zoneService.zoneListSessions()
          set({ sessions })
        } catch {
          // 忽略
        }
      },

      saveSession: async (name) => {
        await zoneService.zoneSaveSession(name, collectSessionData(get))
        await get().fetchSessions()
        useNotificationStore.getState().push({
          type: 'success',
          title: '会话已保存',
          message: name,
          autoClose: true,
          autoCloseDelay: 3000,
        })
      },

      loadSession: async (name) => {
        const res = await zoneService.zoneGetSession(name)
        if (!res.success || !res.session) {
          useNotificationStore.getState().push({
            type: 'error',
            title: '会话加载失败',
            message: name,
          })
          return
        }
        const d = res.session.data
        const loadedAddr = (d.memoryAddress as string) ?? '0x20000000'
        set({
          elfPath: (d.elfPath as string) ?? null,
          activeSourceFile: (d.activeSourceFile as string) ?? null,
          activeInspectorTab: (d.activeInspectorTab as InspectorTabId) ?? 'registers',
          memoryAddress: loadedAddr,
          // 加载会话时重置为单个窗口（锚点取会话地址）
          memoryWindows: [{ id: 'mem-1', name: 'Memory 1', address: loadedAddr, byteWidth: 1, bigEndian: false }],
          activeMemoryWindow: 'mem-1',
          refreshMode: normalizeRefreshMode(d.refreshMode),
          watchTabs: (d.watchTabs as WatchTab[]) ?? [{ id: 'watch-1', name: 'Watch 1', items: [] }],
          activeWatchTab: (d.activeWatchTab as string) ?? 'watch-1',
        })
        useNotificationStore.getState().push({
          type: 'success',
          title: '会话已恢复',
          message: name,
          autoClose: true,
          autoCloseDelay: 3000,
        })
      },

      deleteSession: async (name) => {
        await zoneService.zoneDeleteSession(name)
        await get().fetchSessions()
        useNotificationStore.getState().push({
          type: 'success',
          title: '会话已删除',
          message: name,
          autoClose: true,
          autoCloseDelay: 3000,
        })
      },
    }),
    {
      name: 'zone-config',
      // 只持久化会话无关的 UI 偏好（ELF 路径等由会话管理，避免跨会话串扰）
      partialize: (state) => ({
        activeInspectorTab: state.activeInspectorTab,
        memoryAddress: state.memoryAddress,
        refreshMode: state.refreshMode,
        watchTabs: state.watchTabs,
        activeWatchTab: state.activeWatchTab,
      }),
      // 兼容旧持久化数据：periodic_running 已移除，合并时归一化
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { refreshMode?: unknown }
        return { ...current, ...p, refreshMode: normalizeRefreshMode(p.refreshMode) }
      },
    }
  )
)