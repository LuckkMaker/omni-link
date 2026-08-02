import { useEffect, useRef } from 'react'
import { wsClient } from '@/services/ws'
import { useProbeStore } from '@/stores/probe.store'
import { useFlashStore } from '@/stores/flash.store'
import { useNotificationStore } from '@/stores/notification.store'
import { useLogStore } from '@/stores/log.store'
import type {
  ProbeListData,
  ProbeConnectedData,
  ProbeDisconnectedData,
  FlashProgressEvent,
  LogEvent,
} from '@shared/types'

/**
 * 绑定 WebSocket 事件到 probe store。
 * 在后端就绪后自动连接 WebSocket，订阅仿真器相关事件。
 * 支持 port 变化时自动重连（后端重启场景）。
 */
export function useProbeWs(port: number | null): void {
  const connectedPort = useRef<number | null>(null)

  useEffect(() => {
    if (!port || connectedPort.current === port) return

    // 如果之前连接了不同端口，先断开
    if (connectedPort.current !== null) {
      wsClient.disconnect()
    }
    connectedPort.current = port

    const store = useProbeStore.getState()

    // 连接 WebSocket
    wsClient.connect(port)

    // 订阅仿真器列表更新
    const unsubList = wsClient.on('probe.list', (data) => {
      const d = data as ProbeListData
      store.onProbeList(d.probes)
    })

    // 订阅仿真器已连接
    const unsubConnected = wsClient.on('probe.connected', (data) => {
      const d = data as ProbeConnectedData
      store.onProbeConnected(d.uid, d.target ?? null)
    })

    // 订阅仿真器已断开
    const unsubDisconnected = wsClient.on('probe.disconnected', (data) => {
      const d = data as ProbeDisconnectedData
      store.onProbeDisconnected(d.uid)
    })

    // 订阅仿真器热插拔 — 刷新仿真器列表
    const unsubAdded = wsClient.on('probe.added', () => {
      store.fetchProbes()
    })
    const unsubRemoved = wsClient.on('probe.removed', () => {
      store.fetchProbes()
    })

    // 订阅 Flash 操作进度事件（erase / program / verify / blank）
    const unsubFlashProgress = wsClient.on('flash.progress', (data) => {
      useFlashStore.getState().onProgress(data as FlashProgressEvent)
    })

    // 订阅日志事件：统一收口到全局 log store（带来源筛选，可全局查看）
    const unsubLog = wsClient.on('log', (data) => {
      useLogStore.getState().addLog(data as LogEvent)
    })

    // 订阅后端 notification 事件（如 erase 进度通知）
    const unsubNotification = wsClient.on('notification', (data) => {
      const n = data as {
        type?: 'info' | 'success' | 'error' | 'warning'
        title?: string
        message?: string
        autoClose?: boolean
        autoCloseDelay?: number
      }
      useNotificationStore.getState().push({
        type: (n.type as 'info' | 'success' | 'error' | 'warning') || 'info',
        title: n.title || '',
        message: n.message || '',
        autoClose: n.autoClose ?? true,
        autoCloseDelay: n.autoCloseDelay ?? 4000,
      })
    })

    // 注意：不在 cleanup 中 disconnect，由 port 变化或组件卸载时处理
    return () => {
      unsubList()
      unsubConnected()
      unsubDisconnected()
      unsubAdded()
      unsubRemoved()
      unsubFlashProgress()
      unsubLog()
      unsubNotification()
    }
  }, [port])
}
