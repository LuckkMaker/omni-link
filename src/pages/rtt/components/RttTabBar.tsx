import { Plus, X, Play, Square, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCallback, useRef, useState } from 'react'
import { useRttStore } from '@/stores/rtt.store'
import { useProbeStore } from '@/stores/probe.store'
import { useNotificationStore } from '@/stores/notification.store'
import { rttService } from '@/services/rtt.service'
import { cn } from '@/lib/utils'

interface RttTabBarProps {
  /** 是否正在运行（运行时才能新增 Tab） */
  running: boolean
}

/**
 * RTT 终端 Tab 栏
 *
 * - 第一个 Tab 固定为 "All Channel"（接收所有通道数据）
 * - 可新增单通道 Tab（选择 up channel）
 * - 可关闭非 All Channel 的 Tab
 */
export function RttTabBar({ running }: RttTabBarProps) {
  const tabs = useRttStore((s) => s.tabs)
  const activeTabId = useRttStore((s) => s.activeTabId)
  const setActiveTab = useRttStore((s) => s.setActiveTab)
  const removeTab = useRttStore((s) => s.removeTab)
  const addTab = useRttStore((s) => s.addTab)
  const upChannels = useRttStore((s) => s.upChannels)
  const starting = useRttStore((s) => s.starting)

  // 启停按钮所需：选中仿真器（uid + 连接状态）
  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const uid = selectedProbe?.uid ?? null
  const connected = selectedProbe?.state === 'connected'

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newChannel, setNewChannel] = useState('0')

  // 启停操作序号：启动请求可能在 Stop 之后才返回（后端扫描较慢时尤其明显）。
  // 用序号把"迟到的结果"丢掉，避免已停止后又弹"启动成功"、或把 running 置回 true。
  const opSeqRef = useRef(0)

  const handleAddTab = () => {
    const ch = Number(newChannel)
    const chInfo = upChannels.find((c) => c.index === ch)
    addTab(ch, chInfo?.name)
    setShowAddDialog(false)
  }

  // ── 启停会话（逻辑迁自 ConfigPanel，封装 rttService 调用 + 状态更新 + 通知） ──
  const handleStart = useCallback(async () => {
    if (!uid) return
    const seq = ++opSeqRef.current
    const {
      setStarting,
      setError,
      setChannels,
      setRunning,
      setSelectedUpChannel,
      setSelectedDownChannel,
      selectedUpChannel,
      selectedDownChannel,
    } = useRttStore.getState()
    setStarting(true)
    setError(null)
    // 整合"启动中"与"已完成"为同一条通知：先以 progress 显示，完成后 update 为 success/error
    const notifId = useNotificationStore.getState().push({
      type: 'progress',
      title: 'RTT 会话启动中',
      message: '正在与下位机建立 RTT 连接...',
    })
    try {
      const result = await rttService.start(uid, {
        up_channel: selectedUpChannel,
        down_channel: selectedDownChannel,
      })
      // 期间用户点了停止/又发起新的启动：这次结果已过期，不能改 UI 状态，
      // 也要把这条 progress 通知收掉（否则会永远转圈）。
      if (seq !== opSeqRef.current) {
        useNotificationStore.getState().update(notifId, {
          type: 'info',
          title: 'RTT 启动结果已忽略',
          message: '启动期间会话状态已变化',
          autoClose: true,
          autoCloseDelay: 3000,
        })
        return
      }
      if (result.success) {
        setChannels(result.up_channels, result.down_channels)
        setRunning(true)
        setSelectedUpChannel(result.up_channel)
        setSelectedDownChannel(result.down_channel)
        useRttStore.getState().resetTabs()
        useNotificationStore.getState().update(notifId, {
          type: 'success',
          title: 'RTT 会话已启动',
          message: `Up: Channel ${result.up_channel}, Down: Channel ${result.down_channel}`,
          autoClose: true,
          autoCloseDelay: 3000,
        })
      } else {
        setError(result.error || '启动失败')
        useNotificationStore.getState().update(notifId, {
          type: 'error',
          title: 'RTT 启动失败',
          message: result.error || '未知错误',
          autoClose: true,
          autoCloseDelay: 5000,
        })
      }
    } catch (e) {
      if (seq !== opSeqRef.current) {
        useNotificationStore.getState().update(notifId, {
          type: 'info',
          title: 'RTT 启动结果已忽略',
          message: '启动期间会话状态已变化',
          autoClose: true,
          autoCloseDelay: 3000,
        })
        return
      }
      // 从 axios 错误响应中提取后端 HTTPException 的 detail 字段
      const axiosErr = e as { response?: { data?: { detail?: string } }; message?: string }
      const msg = axiosErr.response?.data?.detail ?? (e instanceof Error ? e.message : String(e))
      setError(msg)
      useNotificationStore.getState().update(notifId, {
        type: 'error',
        title: 'RTT 启动失败',
        message: msg,
        autoClose: true,
        autoCloseDelay: 8000,
      })
    } finally {
      if (seq === opSeqRef.current) setStarting(false)
    }
  }, [uid])

  const handleStop = useCallback(async () => {
    if (!uid) return
    // 让仍在返回途中的启动结果失效（后端也会取消后台启动流程）
    opSeqRef.current += 1
    const { setRunning, setStarting, reset } = useRttStore.getState()
    setStarting(false)
    try { await rttService.stop(uid) } catch { /* 忽略 */ }
    setRunning(false)
    reset()
    useNotificationStore.getState().push({
      type: 'info',
      title: 'RTT 会话已停止',
    })
  }, [uid])

  const canStart = !!uid && connected && !running && !starting

  return (
    <>
      <div className="flex items-center gap-0.5 border-b border-border px-1 py-1 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'group flex items-center gap-1.5 px-2.5 py-1 rounded-t-md cursor-pointer text-xs whitespace-nowrap transition-colors border-b-2',
              activeTabId === tab.id
                ? 'bg-primary/10 text-primary border-primary font-medium'
                : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/30'
            )}
            onClick={() => setActiveTab(tab.id)}
            title={tab.mode === 'single' && tab.channelName
              ? `${tab.title} - ${tab.channelName}`
              : tab.title}
          >
            <span>{tab.title}</span>
            {tab.bytesReceived > 0 && (
              <span className="text-[10px] opacity-70">
                ({(tab.bytesReceived / 1024).toFixed(1)}K)
              </span>
            )}
            {tab.id !== 'all' && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removeTab(tab.id)
                }}
                className="ml-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                title="关闭 Tab"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        ))}

        {/* "+" 按钮新增单通道 Tab（样式对齐 Flash 页面） */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 shrink-0"
          disabled={!running || upChannels.length === 0}
          onClick={() => setShowAddDialog(true)}
          title={running ? '新增单通道 Tab' : '启动 RTT 后才能新增 Tab'}
        >
          <Plus className="size-3.5" />
        </Button>

        {/* 启动/停止合并按钮（最右侧，ml-auto 撑开右侧空间） */}
        <div className="ml-auto flex items-center gap-1.5 pl-2">
          {running ? (
            <Button
              onClick={handleStop}
              variant="destructive"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              title="停止 RTT 会话"
            >
              <Square className="mr-1 h-3 w-3" />
              停止
            </Button>
          ) : (
            <Button
              onClick={handleStart}
              disabled={!canStart}
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              title={connected ? '启动 RTT 会话' : '请先连接仿真器'}
            >
              {starting ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Play className="mr-1 h-3 w-3" />
              )}
              {starting ? '启动中...' : '启动'}
            </Button>
          )}
        </div>
      </div>

      {/* 新增 Tab 对话框 */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>新增单通道 Tab</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                选择 Up Channel（接收通道）
              </label>
              <Select value={newChannel} onValueChange={setNewChannel}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {upChannels.map((ch) => (
                    <SelectItem key={ch.index} value={String(ch.index)} className="text-sm">
                      Channel {ch.index}{ch.name ? ` - ${ch.name}` : ''} ({ch.size}B)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-[11px] text-muted-foreground">
              该 Tab 仅接收选中通道的数据。发送数据时请在输入栏选择对应的 Down Channel。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAddDialog(false)}>
                取消
              </Button>
              <Button size="sm" onClick={handleAddTab}>
                创建
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
