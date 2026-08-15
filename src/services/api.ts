import axios, { AxiosInstance } from 'axios'

/**
 * HTTP 客户端，用于与 Python FastAPI 后端通信。
 * 端口由 Electron 主进程动态分配，通过 IPC 获取。
 * 默认超时 30s，Flash 长操作在 service 层按请求覆盖为 0（无超时）。
 */
let baseURL: string | null = null
let client: AxiosInstance | null = null

async function getBaseURL(): Promise<string> {
  if (baseURL) return baseURL

  let port: number | null = null
  if (window.electron) {
    port = await window.electron.getPythonPort()
  } else {
    // 纯浏览器开发模式（无 Electron 主进程）：回退到默认后端端口 8765
    // 可通过 VITE_PY_PORT 环境变量覆盖
    port = Number(import.meta.env.VITE_PY_PORT ?? 8765)
  }
  if (!port) {
    // 后端尚未就绪，不缓存，抛异常让调用方在 status 就绪后重试
    throw new Error('Python backend not ready (port unknown)')
  }

  baseURL = `http://127.0.0.1:${port}`
  return baseURL
}

export async function api(): Promise<AxiosInstance> {
  if (client) return client
  const url = await getBaseURL()
  client = axios.create({
    baseURL: url,
    // 默认 10s 超时：防止后端被刷新请求淹没时，store 的调试操作（continue/status 等）
    // HTTP 请求无限挂起导致 busy 永久卡死、工具栏灰置。Flash 等长操作在 service 层覆盖为 0。
    timeout: 10000,
    headers: { 'Content-Type': 'application/json' }
  })
  return client
}

/**
 * 重置客户端（Python 后端重启后需要重新获取端口）
 */
export function resetApiClient(): void {
  baseURL = null
  client = null
}
