import { api } from './api'

export interface RttChannel {
  index: number
  name: string
  size: number
}

export interface RttStartResult {
  success: boolean
  up_channels: RttChannel[]
  down_channels: RttChannel[]
  up_channel: number
  down_channel: number
  error?: string
}

export interface RttSendResult {
  success: boolean
  bytes_written: number
  error?: string
}

export interface RttStatus {
  running: boolean
  connected: boolean
}

export interface RttStartOptions {
  address?: number
  size?: number
  up_channel?: number
  down_channel?: number
}

/** RTT Viewer API 服务 */
export const rttService = {
  /** 查询 RTT 状态 */
  async status(uid: string): Promise<RttStatus> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/rtt/status`)
    return data
  },

  /** 启动 RTT 会话 */
  async start(uid: string, opts: RttStartOptions): Promise<RttStartResult> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/rtt/start`, opts, {
      // 10 秒超时（后端 5 秒超时 + 5 秒余量），防止 SWD 通信挂起时
      // 前端通知永久卡在"RTT会话启动中"
      timeout: 10000,
    })
    return data
  },

  /** 停止 RTT 会话 */
  async stop(uid: string): Promise<{ success: boolean }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/rtt/stop`)
    return data
  },

  /** 获取通道信息 */
  async getChannels(uid: string): Promise<RttStartResult> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/rtt/channels`)
    return data
  },

  /** 发送文本数据 */
  async sendText(
    uid: string,
    text: string,
    channel?: number,
    appendNewline = true
  ): Promise<RttSendResult> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/rtt/send-text`, {
      text,
      channel,
      append_newline: appendNewline,
    })
    return data
  },

  /** 发送二进制数据（base64 编码） */
  async send(uid: string, dataBytes: Uint8Array, channel?: number): Promise<RttSendResult> {
    // 手动 base64 编码，避免展开大数组
    let binary = ''
    for (let i = 0; i < dataBytes.length; i++) {
      binary += String.fromCharCode(dataBytes[i])
    }
    const base64 = btoa(binary)
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/rtt/send`, {
      data: base64,
      channel,
    })
    return data
  },

  /** 运行目标内核（resume） */
  async deviceRun(uid: string): Promise<{ success: boolean; state: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/rtt/device/run`)
    return data
  },

  /** 暂停目标内核（halt） */
  async deviceHalt(uid: string): Promise<{ success: boolean; state: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/rtt/device/halt`)
    return data
  },

  /** 复位目标芯片并重新初始化 RTT 控制块 */
  async deviceReset(uid: string, run: boolean = true): Promise<{ success: boolean; state: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/rtt/device/reset`, { run }, {
      // 复位含 0.5s 等待 + 控制块重搜索，需较长超时
      timeout: 15000,
    })
    return data
  },

  /** 查询目标内核状态 */
  async deviceState(uid: string): Promise<{ success: boolean; state: string; error?: string }> {
    const client = await api()
    const { data } = await client.get(`/api/probes/${uid}/rtt/device/state`)
    return data
  },
}
