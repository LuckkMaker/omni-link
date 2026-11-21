import { Plus, X } from 'lucide-react'
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
import { useState } from 'react'
import { useRttStore } from '@/stores/rtt.store'
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

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newChannel, setNewChannel] = useState('0')

  const handleAddTab = () => {
    const ch = Number(newChannel)
    const chInfo = upChannels.find((c) => c.index === ch)
    addTab(ch, chInfo?.name)
    setShowAddDialog(false)
  }

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
