import { Plus, X, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useFlasherStore } from '../flasher.store'

/**
 * 待烧录固件的 tab 栏。
 *
 * 布局与 Flash 页 TabBar 保持一致：icon + 文件名 + 加载点 + 关闭按钮。
 * 格式/地址等文件信息不放进 tab（放到内容区工具栏右侧），避免 tab 被撑宽。
 */
export function FlasherTabBar() {
  const tabs = useFlasherStore((s) => s.tabs)
  const activeTabId = useFlasherStore((s) => s.activeTabId)
  const selectTab = useFlasherStore((s) => s.selectTab)
  const closeTab = useFlasherStore((s) => s.closeTab)
  const openFileTab = useFlasherStore((s) => s.openFileTab)

  return (
    <div className="flex items-center gap-0.5 border-b border-border px-1 py-1 shrink-0 overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => selectTab(tab.id)}
          title={tab.path}
          className={cn(
            'group flex items-center gap-1.5 px-2.5 py-1 rounded-t-md cursor-pointer text-xs whitespace-nowrap transition-colors border-b-2',
            activeTabId === tab.id
              ? 'bg-primary/10 text-primary border-primary font-medium'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/30'
          )}
        >
          <FileText className="size-3 shrink-0" />
          <span>{tab.title}</span>
          {tab.loading && <span className="size-2 rounded-full bg-blue-500 animate-pulse" />}
          <button
            onClick={(e) => {
              e.stopPropagation()
              closeTab(tab.id)
            }}
            className="ml-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}

      {/* "+" 打开文件 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0">
            <Plus className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onClick={openFileTab}>
            <FileText className="size-3.5 mr-1.5" />
            Open Firmware...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
