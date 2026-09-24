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
      // 20 秒超时（后端 RTT_START_TIMEOUT=15s + 5s 余量）：
      // 后端启动流程含低地址探测 + 复位运行 + 控制块重搜，主场景耗时可到 10s+，
      // 且后端只有真挂起时才会在 15s 返回 408。前端超时必须大于后端，
      // 否则会把后端仍在正常进行的启动误判为失败（日志显示已找到/已启动，
      // 前端却弹"启动失败"）。
      timeout: 20000,
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

  /** 复位目标芯片（仅芯片复位，可指定复位后运行） */
  async deviceReset(uid: string, run: boolean = true): Promise<{ success: boolean; state: string }> {
    const client = await api()
    const { data } = await client.post(`/api/probes/${uid}/rtt/device/reset`, { run }, {
      // 20 秒超时：后端 rtt_device_reset 已有 RTT_DEVICE_RESET_TIMEOUT=12s 的
      // wait_for 保护，前端超时须大于后端，否则会先于后端拿到无响应的
      // "Network Error" 而非收到明确错误。
      timeout: 20000,
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
