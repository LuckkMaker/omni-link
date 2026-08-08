import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as zoneService from '@/services/zone.service'
import type { ZoneSession } from '@/services/zone.service'

/** 右侧检查器 dock 的 tab 类型 */
export type InspectorTabId = 'registers' | 'peripherals' | 'memory'

/** 刷新策略模式（参考 vscode-memory-inspector） */
export type RefreshMode = 'on_stop' | 'periodic_always' | 'periodic_running' | 'off'

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
  sourceFiles: string[]
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
  setSourceFiles: (files: string[]) => void
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
          set({ busy: false, error: err instanceof Error ? err.message : 'Halt failed' })
        }
      },

      step: async (uid) => {
        set({ busy: true, error: null })
        try {
          await zoneService.zoneStep(uid)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false })
        } catch (err) {
          set({ busy: false, error: err instanceof Error ? err.message : 'Step failed' })
        }
      },

      continue: async (uid) => {
        set({ busy: true, error: null })
        try {
          await zoneService.zoneContinue(uid)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false })
        } catch (err) {
          set({ busy: false, error: err instanceof Error ? err.message : 'Continue failed' })
        }
      },

      reset: async (uid) => {
        set({ busy: true, error: null })
        try {
          await zoneService.zoneReset(uid)
          const st = await zoneService.zoneStatus(uid)
          set({ state: st.state, pc: st.pc, busy: false })
        } catch (err) {
          set({ busy: false, error: err instanceof Error ? err.message : 'Reset failed' })
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
          set({
            elfPath: result.path,
            sourceFiles: result.source_files,
            disasmAvailable: result.disasm_available,
            busy: false,
          })
          return true
        } catch (err) {
          set({ busy: false, error: err instanceof Error ? err.message : 'ELF load failed' })
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
      },

      loadSession: async (name) => {
        const res = await zoneService.zoneGetSession(name)
        if (!res.success || !res.session) return
        const d = res.session.data
        set({
          elfPath: (d.elfPath as string) ?? null,
          activeSourceFile: (d.activeSourceFile as string) ?? null,
          activeInspectorTab: (d.activeInspectorTab as InspectorTabId) ?? 'registers',
          memoryAddress: (d.memoryAddress as string) ?? '0x20000000',
          refreshMode: (d.refreshMode as RefreshMode) ?? 'on_stop',
        })
      },

      deleteSession: async (name) => {
        await zoneService.zoneDeleteSession(name)
        await get().fetchSessions()
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