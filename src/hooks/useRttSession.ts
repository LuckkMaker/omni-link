import { useEffect, useRef } from 'react'
import { wsClient } from '@/services/ws'
import { useRttStore } from '@/stores/rtt.store'
import { useLogStore } from '@/stores/log.store'
import { useProbeStore } from '@/stores/probe.store'
import { rttService } from '@/services/rtt.service'

/**
 * 全局 RTT 会话管理 Hook
 *
 * 在 MainLayout 层挂载，确保切换页面时 RTT 会话不会被停止。
 * - 订阅 rtt.started / rtt.stopped / rtt.error 事件（全局）
 * - 订阅 rtt.data 事件，按通道分发到对应 Tab 的数据缓冲
 * - 探针断开时停止 RTT 会话
 * - 应用退出时由后端 cleanup_all 处理
 */
export function useRttSession() {
  const setRunning = useRttStore((s) => s.setRunning)
  const reset = useRttStore((s) => s.reset)
  const appendTabData = useRttStore((s) => s.appendTabData)
  const addBytesReceived = useRttStore((s) => s.addBytesReceived)
  // RTT 会话状态日志进全局日志区（带 RTT 来源筛选）
  const logEvent = useLogStore((s) => s.addLog)

  // 当前选中的探针 UID
  const selectedUid = useProbeStore((s) => s.selectedUid)

  // 用 ref 保持最新的 tabs 和 uid，避免频繁重新订阅
  const tabsRef = useRef(useRttStore.getState().tabs)
  const uidRef = useRef(selectedUid)
  useEffect(() => {
    const unsub = useRttStore.subscribe((s) => {
      tabsRef.current = s.tabs
    })
    return unsub
  }, [])
  uidRef.current = selectedUid

  // 全局订阅 RTT 事件（不随页面卸载而取消）
  useEffect(() => {
    const unsubStarted = wsClient.on('rtt.started', (data: unknown) => {
      const payload = data as { uid: string }
      if (payload.uid !== uidRef.current) return
      setRunning(true)
      logEvent({ level: 'info', message: 'RTT 会话已启动', timestamp: new Date().toISOString() })
    })

    const unsubStopped = wsClient.on('rtt.stopped', (data: unknown) => {
      const payload = data as { uid: string; reason: string }
      if (payload.uid !== uidRef.current) return
      setRunning(false)
      logEvent({ level: 'info', message: `RTT 会话已停止 (${payload.reason})`, timestamp: new Date().toISOString() })
      if (payload.reason === 'disconnected') {
        reset()
      }
    })

    const unsubError = wsClient.on('rtt.error', (data: unknown) => {
      const payload = data as { uid: string; error: string }
      if (payload.uid !== uidRef.current) return
      logEvent({ level: 'error', message: payload.error, timestamp: new Date().toISOString() })
    })

    // 全局订阅 rtt.data，按通道分发到对应 Tab
    const unsubData = wsClient.on('rtt.data', (data: unknown) => {
      const payload = data as { uid: string; channel: number; data: string; size: number }
      if (payload.uid !== uidRef.current) return

      // base64 解码
      const binary = atob(payload.data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }

      // 分发到匹配的 Tab
      const tabs = tabsRef.current
      for (const tab of tabs) {
        if (tab.mode === 'all') {
          // All Channel tab：追加所有通道数据（可加前缀，但为保持原始数据完整性，前缀在渲染时加）
          appendTabData(tab.id, bytes)
        } else if (tab.channel === payload.channel) {
          // 单通道 tab：只追加匹配通道的数据
          appendTabData(tab.id, bytes)
        }
      }

      // 累计字节统计
      addBytesReceived(bytes.length)
    })

    return () => {
      unsubStarted()
      unsubStopped()
      unsubError()
      unsubData()
    }
  }, [selectedUid, setRunning, reset, logEvent, appendTabData, addBytesReceived])

  // 探针断开时停止 RTT（全局监听，不依赖页面挂载）
  const isConnected = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid)?.state === 'connected' : false
  })

  useEffect(() => {
    if (!isConnected && useRttStore.getState().running && selectedUid) {
      void rttService.stop(selectedUid).catch(() => {})
      setRunning(false)
      reset()
    }
  }, [isConnected, selectedUid, setRunning, reset])
}
