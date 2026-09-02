import { api } from './api'
import type { ProbeWithState, TargetInfo } from '@shared/types'

/** 列出所有仿真器（含连接状态和目标信息） */
export async function listProbes(): Promise<ProbeWithState[]> {
  const client = await api()
  const { data } = await client.get('/api/probes')
  return data.probes as ProbeWithState[]
}

/** 手动触发仿真器列表刷新 */
export async function refreshProbes(): Promise<ProbeWithState[]> {
  const client = await api()
  const { data } = await client.post('/api/probes/refresh')
  return data.probes as ProbeWithState[]
}

/** 连接模式 */
export type ConnectMode = 'attach' | 'halt' | 'pre-reset' | 'under-reset'

/** 连接指定仿真器 */
export async function connectProbe(
  uid: string,
  options?: {
    target?: string
    interface?: string
    speed?: number
    connect_mode?: ConnectMode
    /** 为 True 时即使已连接也按新 connect_mode 强制重连 */
    force?: boolean
    /** J-Link 目标设备名（如 G32F463XC）：J-Link 探针必须设置才能建立目标连接 */
    jlink_device?: string
  }
): Promise<{ connected: boolean; uid: string; target: TargetInfo | null }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/connect`, options ?? {})
  return data
}

/** 断开指定仿真器 */
export async function disconnectProbe(uid: string): Promise<void> {
  const client = await api()
  await client.post(`/api/probes/${uid}/disconnect`)
}

/** 获取当前连接的目标信息 */
export async function getTarget(uid: string): Promise<TargetInfo> {
  const client = await api()
  const { data } = await client.get(`/api/probes/${uid}/target`)
  return data as TargetInfo
}

/** 手动设置目标芯片型号 */
export async function setTarget(
  uid: string,
  partNumber: string
): Promise<{ success: boolean; uid: string; target: TargetInfo | null }> {
  const client = await api()
  const { data } = await client.post(`/api/probes/${uid}/target`, {
    part_number: partNumber,
  })
  return data
}
