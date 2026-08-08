import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as zoneService from '@/services/zone.service'
import type { ZoneSession, SourceFileInfo } from '@/services/zone.service'
import * as probeService from '@/services/probe.service'
import type { ConnectMode } from '@/services/probe.service'
import { programFlash } from '@/services/flash.service'
import { useNotificationStore } from '@/stores/notification.store'

/** 右侧检查器 dock 的 section 类型 */
export type InspectorTabId = 'disasm' | 'registers' | 'peripherals' | 'memory'

/** 刷新策略模式（参考 vscode-memory-inspector） */
export type RefreshMode = 'on_stop' | 'periodic_always' | 'periodic_running' | 'off'

/** Zone 会话启动方式（Load ELF 下拉选项） */
export type ZoneStartMode = 'download_reset' | 'attach_running' | 'attach_halt'

interface ZoneStore {
  // ── 调试状态 ──────────────────────────────
  /** 目标状态 */
  state: 'disconnected' | 'running' | 'halted' | 'unknown'
  /** 当前 PC */
  pc: number | null
  /** 调试操作是否进行中 */
  busy: boolean
  /** 错误信息 */
  error: string | null

  // ── ELF ───────────────────────────────────
  /** 已加载 ELF 路径 */
  elfPath: string | null
  /** ELF 源文件列表 */
  sourceFiles: SourceFileInfo[]
  /** 当前选中的源文件 */
  activeSourceFile: string | null
  /** 是否支持反汇编 */
  disasmAvailable: boolean

  // ── 检查器 ────────────────────────────────
  /** 当前检查器 tab */
  activeInspectorTab: InspectorTabId
  /** 内存查看地址（字符串，支持 0x 前缀） */
  memoryAddress: string

  // ── 刷新策略 ──────────────────────────────
  refreshMode: RefreshMode

  // ── 会话 ───────────────────────────────────
  sessions: ZoneSession[]

  // ── 操作 ──────────────────────────────────
  setState: (s: ZoneStore['state']) => void
  setPc: (pc: number | null) => void
  setBusy: (busy: boolean) => void
  setError: (error: string | null) => void
  setElfPath: (path: string | null) => void
  setSourceFiles: (files: SourceFileInfo[]) => void
  setActiveSourceFile: (file: string | null) => void
  setDisasmAvailable: (v: boolean) => void
  setActiveInspectorTab: (tab: InspectorTabId) => void
  setMemoryAddress: (addr: string) => void
  setRefreshMode: (mode: RefreshMode) => void

  /** 调试控制动作（调用后端后刷新状态） */
  halt: (uid: string) => Promise<void>
  step: (uid: string) => Promise<void>
  continue: (uid: string) => Promise<void>
  reset: (uid: string) => Promise<void>
  refreshStatus: (uid: string) => Promise<void>

  /** ELF 加载 */
  loadElf: (uid: string, path: string) => Promise<boolean>

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
  }
}

export const useZoneStore = create<ZoneStore>()(
  persist(
    (set, get) => ({
      // ── 初始状态 ──────────────────────────
      state: 'disconnected',
      pc: null,
      busy: false,
      error: null,

      elfPath: null,
      sourceFiles: [],
      activeSourceFile: null,
      disasmAvailable: false,

      activeInspectorTab: 'registers',
      memoryAddress: '0x20000000',

      refreshMode: 'on_stop',

      sessions: [],

      // ── 操作 ──────────────────────────────
      setState: (state) => set({ state }),
      setPc: (pc) => set({ pc }),
      setBusy: (busy) => set({ busy }),
      setError: (error) => set({ error }),
      setElfPath: (elfPath) => set({ elfPath }),
      setSourceFiles: (sourceFiles) => set({ sourceFiles }),
      setActiveSourceFile: (activeSourceFile) => set({ activeSourceFile }),
      setDisasmAvailable: (disasmAvailable) => set({ disasmAvailable }),
      setActiveInspectorTab: (activeInspectorTab) => set({ activeInspectorTab }),
      setMemoryAddress: (memoryAddress) => set({ memoryAddress }),
      setRefreshMode: (refreshMode) => set({ refreshMode }),

      halt: async (uid) => {
        set({ busy: true, error: null })
        try {
          await zoneService.zoneHalt(uid)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Halt failed'
          set({ busy: false, error: msg })
          useNotificationStore.getState().push({ type: 'error', title: 'Halt failed', message: msg })
        }
      },

      step: async (uid) => {
        set({ busy: true, error: null })
        try {
          await zoneService.zoneStep(uid)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Step failed'
          set({ busy: false, error: msg })
          useNotificationStore.getState().push({ type: 'error', title: 'Step failed', message: msg })
        }
      },

      continue: async (uid) => {
        set({ busy: true, error: null })
        try {
          await zoneService.zoneContinue(uid)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Continue failed'
          set({ busy: false, error: msg })
          useNotificationStore.getState().push({ type: 'error', title: 'Continue failed', message: msg })
        }
      },

      reset: async (uid) => {
        set({ busy: true, error: null })
        try {
          await zoneService.zoneReset(uid)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Reset failed'
          set({ busy: false, error: msg })
          useNotificationStore.getState().push({ type: 'error', title: 'Reset failed', message: msg })
        }
      },

      refreshStatus: async (uid) => {
        try {
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc })
        } catch {
          // 忽略（连接断开时）
        }
      },

      loadElf: async (uid, path) => {
        set({ busy: true, error: null })
        try {
          const result = await zoneService.zoneLoadElf(uid, path)
          // 拉取含大小的源文件列表
          let files: SourceFileInfo[] = []
          const activeFile = result.source_files[0] ?? null
          try {
            files = await zoneService.zoneSourceFiles(uid)
          } catch {
            files = result.source_files.map((p) => ({ path: p, name: p.split('/').pop() ?? p, size: null }))
          }
          set({
            elfPath: result.path,
            sourceFiles: files,
            activeSourceFile: activeFile,
            disasmAvailable: result.disasm_available,
            busy: false,
          })
          useNotificationStore.getState().push({
            type: 'success',
            title: 'ELF 已加载',
            message: result.path.split(/[\\/]/).pop() ?? result.path,
            autoClose: true,
            autoCloseDelay: 3000,
          })
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
        set({ busy: true, error: null })
        // 每个会话启动方式绑定所需连接模式
        const connectMode: ConnectMode = mode === 'download_reset' ? 'halt' : 'attach'
        const labels: Record<ZoneStartMode, string> = {
          download_reset: 'Download & Reset',
          attach_running: 'Attach to Running',
          attach_halt: 'Attach & Halt',
        }
        try {
          // 1. 强制以绑定模式重连（自动切换连接模式，避免与全局设置冲突）
          await probeService.connectProbe(uid, { connect_mode: connectMode, force: true })
          // 2. 加载 ELF 符号（失败时内部已推送错误通知）
          const ok = await get().loadElf(uid, path)
          if (!ok) return false
          // 3. 会话动作
          if (mode === 'download_reset') {
            await programFlash(uid, path, true, true)
            useNotificationStore.getState().push({
              type: 'success',
              title: 'Download & Reset',
              message: '烧录并复位完成',
              autoClose: true,
              autoCloseDelay: 3000,
            })
          } else if (mode === 'attach_halt') {
            await get().halt(uid)
          }
          // attach_running：保持目标运行，无需额外动作
          set({ busy: false })
          useNotificationStore.getState().push({
            type: 'success',
            title: labels[mode],
            message: '会话已启动',
            autoClose: true,
            autoCloseDelay: 3000,
          })
          return true
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Start session failed'
          set({ busy: false, error: msg })
          useNotificationStore.getState().push({
            type: 'error',
            title: '会话启动失败',
            message: msg,
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
        set({
          elfPath: (d.elfPath as string) ?? null,
          activeSourceFile: (d.activeSourceFile as string) ?? null,
          activeInspectorTab: (d.activeInspectorTab as InspectorTabId) ?? 'registers',
          memoryAddress: (d.memoryAddress as string) ?? '0x20000000',
          refreshMode: (d.refreshMode as RefreshMode) ?? 'on_stop',
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
      }),
    }
  )
)