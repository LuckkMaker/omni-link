import { create } from 'zustand'
import type { ProbeWithState, TargetInfo, DeviceInfo, JLinkDeviceInfo } from '@shared/types'
import * as probeService from '@/services/probe.service'
import type { ConnectMode } from '@/services/probe.service'
import { listTargets } from '@/services/target.service'
import { listDevices, listAllJLinkDevices } from '@/services/device.service'
import { useNotificationStore } from './notification.store'
import { useLogStore } from './log.store'

/** 从 FastAPI 错误响应中提取后端返回的 detail（字符串）错误详情 */
function extractApiDetail(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  return typeof detail === 'string' ? detail : null
}

/** 写全局日志（探针连接/断开归属 system 来源） */
function probeLog(level: 'info' | 'warning' | 'error', message: string) {
  useLogStore.getState().addLog({
    timestamp: new Date().toISOString(),
    level,
    message,
    source: 'system',
  })
}

/** 调试接口类型 */
export type DebugInterface = 'swd' | 'jtag'

/** 连接模式选项 */
export const CONNECT_MODE_OPTIONS: { label: string; value: ConnectMode; desc: string }[] = [
  {
    label: '复位并暂停 (Halt)',
    value: 'halt',
    desc: '连接时复位目标并暂停在复位向量（默认）',
  },
  {
    label: '附加模式 (Attach)',
    value: 'attach',
    desc: '不复位、不暂停，保持目标当前状态（适合故障分析等需要保留现场的场景）',
  },
  {
    label: '连接前复位 (Pre-reset)',
    value: 'pre-reset',
    desc: '建立调试连接前先执行一次复位',
  },
  {
    label: '复位下连接 (Under-reset)',
    value: 'under-reset',
    desc: '拉低复位线时连接，用于深度睡眠或被锁定的目标',
  },
]

/** 速度选项 (Hz) */
export const SPEED_OPTIONS = [
  { label: '10 MHz', value: 10_000_000 },
  { label: '5 MHz', value: 5_000_000 },
  { label: '2 MHz', value: 2_000_000 },
  { label: '1 MHz', value: 1_000_000 },
  { label: '500 kHz', value: 500_000 },
  { label: '200 kHz', value: 200_000 },
  { label: '100 kHz', value: 100_000 },
  { label: '50 kHz', value: 50_000 },
  { label: '20 kHz', value: 20_000 },
  { label: '10 kHz', value: 10_000 },
  { label: '5 kHz', value: 5_000 },
]

interface ProbeStore {
  // ── 状态 ──────────────────────────────
  /** 仿真器列表（含连接状态） */
  probes: ProbeWithState[]
  /** 当前选中的仿真器 UID */
  selectedUid: string | null
  /** pyOCD 支持的目标型号列表 */
  targetList: string[]
  /** 设备目录（来自 device_info.json） */
  deviceList: DeviceInfo[]
  /** J-Link 设备库全量列表（应用加载时预取，选择 J-Link 设备名时本地检索） */
  jlinkDevices: JLinkDeviceInfo[]
  /** 加载仿真器中 */
  loadingProbes: boolean
  /** 加载 J-Link 设备库中 */
  loadingJlinkDevices: boolean
  /** 连接/断开操作中 */
  connecting: boolean
  /** 错误信息 */
  error: string | null

  // ── 连接前配置 ────────────────────────
  /** 连接前选择的目标设备 part_number */
  pendingTarget: string | null
  /** 连接前选择的调试接口 */
  pendingInterface: DebugInterface
  /** 连接前选择的时钟速度 (Hz) */
  pendingSpeed: number
  /** 连接前选择的连接模式 */
  pendingConnectMode: ConnectMode
  /** J-Link 目标设备名（前端 J-Link 输入框填写，如 G32F463XC） */
  pendingJlinkDevice: string | null
  /** Flash 配置：选中的扇区索引集合（确定后保存） */
  selectedSectorIndices: Set<number>

  // ── 派生获取器 ────────────────────────
  /** 获取当前选中的仿真器 */
  getSelectedProbe: () => ProbeWithState | null
  /** 获取当前选中仿真器的目标信息 */
  getSelectedTarget: () => TargetInfo | null
  /** 根据 part_number 查找设备目录信息 */
  getDeviceInfo: (partNumber: string) => DeviceInfo | undefined

  // ── 操作 ──────────────────────────────
  /** 拉取仿真器列表 */
  fetchProbes: () => Promise<void>
  /** 拉取支持的 MCU 型号列表 */
  fetchTargets: () => Promise<void>
  /** 拉取设备目录 */
  fetchDevices: () => Promise<void>
  /** 拉取 J-Link 设备库全量列表（应用加载时调用一次） */
  fetchJlinkDevices: () => Promise<void>
  /** 选中仿真器 */
  selectProbe: (uid: string | null) => void
  /** 设置连接前配置 */
  setPendingTarget: (partNumber: string | null) => void
  setPendingInterface: (iface: DebugInterface) => void
  setPendingSpeed: (speed: number) => void
  setPendingConnectMode: (mode: ConnectMode) => void
  setPendingJlinkDevice: (device: string | null) => void
  /** 保存 Flash 配置中选中的扇区索引 */
  setSelectedSectorIndices: (indices: Set<number>) => void
  /** 连接仿真器 */
  connectProbe: (uid: string) => Promise<void>
  /** 断开仿真器 */
  disconnectProbe: (uid: string) => Promise<void>
  /** 手动设置目标芯片 */
  setTarget: (partNumber: string) => Promise<void>
  /** 清除错误 */
  clearError: () => void

  // ── WebSocket 事件处理 ────────────────
  /** 仿真器列表更新（热插拔 / 手动刷新） */
  onProbeList: (probes: ProbeWithState[]) => void
  /** 仿真器已连接 */
  onProbeConnected: (uid: string, target: TargetInfo | null) => void
  /** 仿真器已断开 */
  onProbeDisconnected: (uid: string) => void
}

export const useProbeStore = create<ProbeStore>((set, get) => ({
  // ── 初始状态 ──────────────────────────
  probes: [],
  selectedUid: null,
  targetList: [],
  deviceList: [],
  jlinkDevices: [],
  loadingProbes: false,
  loadingJlinkDevices: false,
  connecting: false,
  error: null,

  // 连接前默认配置
  pendingTarget: null,
  pendingInterface: 'swd',
  pendingSpeed: 1_000_000,
  pendingConnectMode: 'halt',
  pendingJlinkDevice: null,
  selectedSectorIndices: new Set(),

  // ── 派生获取器 ────────────────────────
  getSelectedProbe: () => {
    const { probes, selectedUid } = get()
    return probes.find((p) => p.uid === selectedUid) ?? null
  },

  getSelectedTarget: () => {
    const probe = get().getSelectedProbe()
    return probe?.target ?? null
  },

  getDeviceInfo: (partNumber: string) => {
    return get().deviceList.find((d) => d.part_number === partNumber)
  },

  // ── 操作 ──────────────────────────────
  fetchProbes: async () => {
    set({ loadingProbes: true, error: null })
    try {
      const probes = await probeService.listProbes()
      // 未选中仿真器时，默认选中第一个
      const currentUid = get().selectedUid
      const autoUid = currentUid && probes.some((p) => p.uid === currentUid)
        ? currentUid
        : probes.length > 0 ? probes[0].uid : null
      set({ probes, selectedUid: autoUid, loadingProbes: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '获取仿真器列表失败'
      set({ loadingProbes: false, error: msg })
      useNotificationStore.getState().push({
        type: 'error',
        title: '获取仿真器列表失败',
        message: msg,
        autoClose: true,
        autoCloseDelay: 5000,
      })
    }
  },

  fetchTargets: async () => {
    try {
      const targets = await listTargets()
      set({ targetList: targets })
    } catch (err) {
      console.error('[probe.store] fetchTargets failed:', err)
    }
  },

  fetchDevices: async () => {
    try {
      const devices = await listDevices()
      set({ deviceList: devices })
    } catch (err) {
      console.error('[probe.store] fetchDevices failed:', err)
    }
  },

  fetchJlinkDevices: async () => {
    // 已加载则跳过，避免重复拉取全量设备库
    if (get().jlinkDevices.length > 0) return
    set({ loadingJlinkDevices: true })
    try {
      const devices = await listAllJLinkDevices()
      set({ jlinkDevices: devices, loadingJlinkDevices: false })
    } catch (err) {
      console.error('[probe.store] fetchJlinkDevices failed:', err)
      set({ loadingJlinkDevices: false })
    }
  },

  selectProbe: (uid) => set({ selectedUid: uid }),

  setPendingTarget: (partNumber) => set({ pendingTarget: partNumber }),
  setPendingInterface: (iface) => set({ pendingInterface: iface }),
  setPendingSpeed: (speed) => set({ pendingSpeed: speed }),
  setPendingConnectMode: (mode) => set({ pendingConnectMode: mode }),
  setPendingJlinkDevice: (device) =>
    set({ pendingJlinkDevice: device ? device.trim() || null : null }),
  setSelectedSectorIndices: (indices) => set({ selectedSectorIndices: new Set(indices) }),

  connectProbe: async (uid) => {
    const { pendingTarget, pendingInterface, pendingSpeed, pendingConnectMode, pendingJlinkDevice } = get()
    set({ connecting: true, error: null })
    // 先将状态标记为 connecting
    set((state) => ({
      probes: state.probes.map((p) =>
        p.uid === uid ? { ...p, state: 'connecting' as const } : p
      ),
    }))
    try {
      const result = await probeService.connectProbe(uid, {
        target: pendingTarget ?? undefined,
        interface: pendingInterface,
        speed: pendingSpeed,
        connect_mode: pendingConnectMode,
        jlink_device: pendingJlinkDevice ?? undefined,
      })
      // 连接成功，更新仿真器状态和目标信息
      set((state) => ({
        probes: state.probes.map((p) =>
          p.uid === uid
            ? { ...p, state: 'connected' as const, target: result.target }
            : p
        ),
        connecting: false,
      }))
      // 连接成功后，自动选中所有扇区（作为默认 Flash 配置）
      if (result.target?.sectors?.length) {
        set({ selectedSectorIndices: new Set(result.target.sectors.map((s) => s.index)) })
      }
      // 连接成功后，如果列表为空则重新加载
      if (get().targetList.length === 0) {
        get().fetchTargets()
      }
      if (get().deviceList.length === 0) {
        get().fetchDevices()
      }
      probeLog('info', `仿真器连接成功（${uid}）`)
    } catch (err) {
      const fallback = err instanceof Error ? err.message : '连接仿真器失败'
      // 优先使用后端返回的 detail（如底层错误详情），否则退回通用 500 信息
      const detail = extractApiDetail(err)
      const msg = detail ?? fallback
      set((state) => ({
        probes: state.probes.map((p) =>
          p.uid === uid ? { ...p, state: 'error' as const } : p
        ),
        connecting: false,
        error: msg,
      }))
      probeLog('error', `仿真器连接失败（${uid}）：${msg}`)
      useNotificationStore.getState().push({
        type: 'error',
        title: '连接失败',
        message: msg,
        autoClose: true,
        autoCloseDelay: 8000,
      })
    }
  },

  disconnectProbe: async (uid) => {
    set({ connecting: true, error: null })
    try {
      await probeService.disconnectProbe(uid)
      set((state) => ({
        probes: state.probes.map((p) =>
          p.uid === uid
            ? { ...p, state: 'disconnected' as const, target: null }
            : p
        ),
        connecting: false,
      }))
      probeLog('info', `仿真器已断开（${uid}）`)
    } catch (err) {
      const fallback = err instanceof Error ? err.message : '断开仿真器失败'
      const detail = extractApiDetail(err)
      const msg = detail ?? fallback
      set({ connecting: false, error: msg })
      probeLog('error', `仿真器断开失败（${uid}）：${msg}`)
      useNotificationStore.getState().push({
        type: 'error',
        title: '断开仿真器失败',
        message: msg,
        autoClose: true,
        autoCloseDelay: 5000,
      })
    }
  },

  setTarget: async (partNumber) => {
    const { selectedUid } = get()
    if (!selectedUid) return
    set({ connecting: true, error: null })
    try {
      const result = await probeService.setTarget(selectedUid, partNumber)
      set((state) => ({
        probes: state.probes.map((p) =>
          p.uid === selectedUid
            ? { ...p, state: 'connected' as const, target: result.target }
            : p
        ),
        connecting: false,
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : '设置目标芯片失败'
      set({ connecting: false, error: msg })
      useNotificationStore.getState().push({
        type: 'error',
        title: '设置目标芯片失败',
        message: msg,
        autoClose: true,
        autoCloseDelay: 5000,
      })
    }
  },

  clearError: () => set({ error: null }),

  // ── WebSocket 事件处理 ────────────────
  onProbeList: (probes) => {
    set((state) => ({
      probes,
      // 保持已选中的仿真器（如果仍然存在）
      selectedUid:
        state.selectedUid && probes.some((p) => p.uid === state.selectedUid)
          ? state.selectedUid
          : probes.length > 0
            ? probes[0].uid
            : null,
    }))
  },

  onProbeConnected: (uid, target) => {
    set((state) => ({
      probes: state.probes.map((p) =>
        p.uid === uid
          ? { ...p, state: 'connected' as const, target }
          : p
      ),
    }))
  },

  onProbeDisconnected: (uid) => {
    set((state) => ({
      probes: state.probes.map((p) =>
        p.uid === uid
          ? { ...p, state: 'disconnected' as const, target: null }
          : p
      ),
    }))
  },
}))
