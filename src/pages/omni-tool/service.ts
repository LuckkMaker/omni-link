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

export interface OmniReadBackResult {
  success: boolean
  address: number
  size: number
  /** base64 编码的设备内容 */
  data: string
}

/** 在线烧录可用性（后端 /api/omni-tool/flasher/status） */
export interface OmniFlasherStatus {
  /** 已连接 app 人格设备 */
  available: boolean
  personality: OmniPersonality
  port: string | null
  /** 模式 A 单包负载上限（64B 协议包减去 8B 头） */
  max_payload: number
  /** 模式 B 单包负载上限（64B 减去 4B 头，无地址字段） */
  max_image_payload: number
  /** 支持的目标型号（由固件内置 FLM 决定） */
  targets: string[]
}

/**
 * 烧写模式说明（固件协议 v0.3）：
 *
 * 上位机**统一使用镜像型会话**（`OPEN_IMAGE` / `IMAGE_DATA` / `IMAGE_VERIFY`），
 * `.hex` 与 `.bin` 都一样 —— 固件自己判定格式并解出地址，两者最终进同一个
 * flash manager，**扇区懒擦除由固件完成**，主机无需下发擦除命令。
 *
 * 固件仍保留地址型会话（`OPEN` / `WRITE`），仅用于"先整片擦除再清场"这一步，
 * 因为镜像型会话本身不支持 `ERASE`。
 */

/** 单个地址段（hex 可能有多个不连续段） */
export interface OmniFlasherSegment {
  address: number
  size: number
}

/** 镜像分析结果：选完文件即可知道写到哪些地址、CRC32 是多少 */
export interface OmniFlasherAnalyze {
  /** 文件内容是否为 Intel HEX 文本 */
  is_hex: boolean
  /** 文件原始字节数 */
  file_size: number
  segments: OmniFlasherSegment[]
  /** 解出的有效数据字节数 */
  total: number
  /** 整镜像 CRC32（传给固件做校验） */
  crc32: number
}

/** 在线烧录结果 */
export interface OmniFlasherResult {
  success: boolean
  /** 是否执行并通过了回读校验 */
  verified: boolean
  address: number
  size: number
  /** 文件是否为 HEX 文本 */
  is_hex?: boolean
  /** 写入的地址段数 */
  segments?: number
  /** 整镜像 CRC32 */
  crc32?: number | null
  message: string
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

  async upgrade(filePath: string, address?: number): Promise<OmniUpgradeResult> {
    const client = await api()
    const { data } = await client.post(
      '/api/omni-tool/upgrade',
      { file_path: filePath, address },
      { timeout: 0 } // 擦除 + 下载 + 回读校验耗时可达数分钟
    )
    return data
  },

  async verify(filePath: string, address?: number): Promise<{
    verified: boolean
    offset: number | null
    address: number
    size: number
  }> {
    const client = await api()
    const { data } = await client.post(
      '/api/omni-tool/verify',
      { file_path: filePath, address },
      { timeout: 0 } // 回读全量比对耗时较长
    )
    return data
  },

  async readBack(address: number, size: number): Promise<OmniReadBackResult> {
    const client = await api()
    const { data } = await client.post(
      '/api/omni-tool/read-back',
      { address, size },
      { timeout: 0 } // 按 248B/帧回读，耗时随长度增长
    )
    return data
  },

  async leave(): Promise<{ success: boolean; address: number }> {
    const client = await api()
    const { data } = await client.post('/api/omni-tool/leave', {}, { timeout: 8000 })
    return data
  },

  // ---- 在线烧录（外部目标 MCU） ----
  async flasherStatus(): Promise<OmniFlasherStatus> {
    const client = await api()
    const { data } = await client.get('/api/omni-tool/flasher/status', { timeout: 8000 })
    return data
  },

  async flasherFlash(
    filePath: string,
    opts: {
      address?: number
      target?: string
      /** 烧录前先整片擦除（用地址型会话清场） */
      erase?: boolean
      verify?: boolean
    } = {}
  ): Promise<OmniFlasherResult> {
    const client = await api()
    const { data } = await client.post(
      '/api/omni-tool/flasher/flash',
      {
        file_path: filePath,
        address: opts.address,
        target: opts.target ?? 'stm32f407ig',
        erase: opts.erase ?? false,
        verify: opts.verify ?? true,
      },
      { timeout: 0 } // 整片擦除 + 分块写入 + 回读校验耗时可达数分钟
    )
    return data
  },

  /** 只解析不烧录：预览会用哪个模式、写到哪些地址、CRC32 是多少 */
  async flasherAnalyze(filePath: string, address?: number): Promise<OmniFlasherAnalyze> {
    const client = await api()
    const { data } = await client.post(
      '/api/omni-tool/flasher/analyze',
      { file_path: filePath, address },
      { timeout: 20000 } // 大 hex 解析需时
    )
    return data
  },

  async flasherRecover(): Promise<{ success: boolean; message: string }> {
    const client = await api()
    const { data } = await client.post('/api/omni-tool/flasher/recover', {}, { timeout: 20000 })
    return data
  },
}