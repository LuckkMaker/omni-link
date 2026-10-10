import { api } from '@/services/api'
import type { AxiosError } from 'axios'

/** 设备人格：boot（Modbus RTU，PID 0x1000）/ app（自定义命令，PID 0x1001）/ 其他串口 */
export type OmniPersonality = 'boot' | 'app' | 'unknown'

/** 人格短标签（用于设备列表的徽章） */
export const omniPersonalityBadge: Record<OmniPersonality, string> = {
  app: 'App',
  boot: 'Boot',
  unknown: '未知'
}

export interface OmniDevice {
  port: string
  vid: number | null
  pid: number | null
  personality: OmniPersonality
  serial_number: string | null
  description: string | null
  product: string | null
  manufacturer: string | null
}

export interface OmniScanResult {
  serial_available: boolean
  devices: OmniDevice[]
  omni_devices: OmniDevice[]
}

export interface OmniSessionState {
  connected: boolean
  port: string | null
  personality: OmniPersonality
  busy: boolean
}

export interface OmniAppInfo {
  personality: 'app'
  port: string
  vendor: string
  product: string
  serial_number: string
  fw_ver: string
  capabilities: number | null
  packet_size: number | null
  packet_count: number | null
}

export interface OmniBootInfo {
  personality: 'boot'
  port: string
  boot_version: number
  boot_version_str: string
  mcu_uid: string
}

export type OmniInfo = OmniAppInfo | OmniBootInfo

/** 升级进度（后端经 WebSocket omni_tool.progress 推送） */
export interface OmniProgress {
  stage: string
  message: string
  current: number
  total: number
  percent: number
}

export interface OmniUpgradeResult {
  success: boolean
  verified: boolean
  address: number
  size: number
  message: string
}

/** 提取后端 detail，避免只显示 "Request failed with status code 400" */
export function omniToolErrorMessage(e: unknown): string {
  const ax = e as AxiosError<{ detail?: string }>
  return ax.response?.data?.detail ?? (e instanceof Error ? e.message : String(e))
}

/** OMNI Tool API 客户端（后端前缀 /api/omni-tool） */
export const omniToolService = {
  async scan(): Promise<OmniScanResult> {
    const client = await api()
    const { data } = await client.get('/api/omni-tool/devices')
    return data
  },

  async state(): Promise<OmniSessionState> {
    const client = await api()
    const { data } = await client.get('/api/omni-tool/state')
    return data
  },

  async connect(port: string): Promise<OmniSessionState> {
    const client = await api()
    const { data } = await client.post('/api/omni-tool/connect', { port }, { timeout: 8000 })
    return data
  },

  async disconnect(): Promise<OmniSessionState> {
    const client = await api()
    const { data } = await client.post('/api/omni-tool/disconnect')
    return data
  },

  async info(): Promise<OmniInfo> {
    const client = await api()
    const { data } = await client.get('/api/omni-tool/info', { timeout: 10000 })
    return data
  },

  async enterBoot(): Promise<{ success: boolean; message: string }> {
    const client = await api()
    const { data } = await client.post('/api/omni-tool/enter-boot', {}, { timeout: 8000 })
    return data
  },

  async erase(address?: number, full = false): Promise<{ success: boolean; sectors: number[] }> {
    const client = await api()
    const { data } = await client.post(
      '/api/omni-tool/erase',
      { address, full },
      { timeout: 0 } // 擦除按扇区耗时，不做前端超时
    )
    return data
  },

  async upgrade(filePath: string, address?: number): Promise<OmniUpgradeResult> {
    const client = await api()
    const { data } = await client.post(
      '/api/omni-tool/upgrade',
      { file_path: filePath, address },
      { timeout: 0 } // 擦除 + 下载 + 回读校验耗时可达数分钟
    )
    return data
  },
}