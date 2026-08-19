import { api } from './api'
import type { DeviceInfo, CustomDeviceCreate, SourceSummary, JLinkDeviceInfo } from '@shared/types'

/** 获取完整设备目录（含可用状态） */
export async function listDevices(): Promise<DeviceInfo[]> {
  const client = await api()
  const { data } = await client.get('/api/devices')
  return data.devices as DeviceInfo[]
}

/** 获取指定设备信息（含可用状态） */
export async function getDevice(partNumber: string): Promise<DeviceInfo> {
  const client = await api()
  const { data } = await client.get(`/api/devices/${partNumber}`)
  return data as DeviceInfo
}

/** 获取设备来源统计 */
export async function getSourceSummary(): Promise<SourceSummary> {
  const client = await api()
  const { data } = await client.get('/api/devices/sources/summary')
  return data as SourceSummary
}

/** 通过 FLM 文件创建自定义芯片 */
export async function createCustomDevice(req: CustomDeviceCreate): Promise<DeviceInfo> {
  const client = await api()
  const { data } = await client.post('/api/devices/custom', req)
  return data as DeviceInfo
}

/** 从 FLM 文件自动提取 Flash 参数 */
export async function extractFlmInfo(path: string): Promise<Record<string, string | number>> {
  const client = await api()
  const { data } = await client.post('/api/devices/custom/extract-flm-info', { path })
  return data.info as Record<string, string | number>
}

/** 重新从 device_info.json 导入数据 */
export async function reimportDevices(): Promise<number> {
  const client = await api()
  const { data } = await client.post('/api/devices/reimport')
  return data.imported as number
}

/** 从 J-Link 设备库动态查询候选设备（按前缀/Flash 容量过滤） */
export async function listJLinkDevices(opts?: {
  search?: string
  flashKb?: number
}): Promise<JLinkDeviceInfo[]> {
  const client = await api()
  const params = new URLSearchParams()
  if (opts?.search) params.set('search', opts.search)
  if (opts?.flashKb != null) params.set('flash_kb', String(opts.flashKb))
  const { data } = await client.get(`/api/probes/jlink/devices?${params.toString()}`)
  return data.devices as JLinkDeviceInfo[]
}
