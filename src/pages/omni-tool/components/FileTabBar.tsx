import { Plus, X, FileText, Cpu, GitCompare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useOmniToolStore } from '../store'

/** 固件/设备内存 tab 栏（镜像 flash 页 TabBar：固定首个 Device Memory + 多个文件 tab） */
export function FileTabBar() {
  const tabs = useOmniToolStore((s) => s.tabs)
  const activeTabId = useOmniToolStore((s) => s.activeTabId)
  const selectTab = useOmniToolStore((s) => s.selectTab)
  const closeTab = useOmniToolStore((s) => s.closeTab)
  const openFileTab = useOmniToolStore((s) => s.openFileTab)

  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1 py-1">
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          onClick={() => selectTab(tab.id)}
          title={tab.kind === 'file' ? tab.filePath : tab.title}
          className={cn(
            'group flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-2.5 py-1 text-xs transition-colors',
            activeTabId === tab.id
              ? 'border-primary bg-primary/10 font-medium text-primary'
              : 'border-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground'
          )}
        >
          {tab.kind === 'device' ? (
            <Cpu className="size-3 shrink-0" />
          ) : tab.kind === 'compare' ? (
            <GitCompare className="size-3 shrink-0" />
          ) : (
            <FileText className="size-3 shrink-0" />
          )}
          <span>{tab.title}</span>
          {tab.loading ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-blue-500" /> : null}
          {/* 首个 Device Memory tab 不可关闭 */}
          {index > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className="ml-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}

      {/* "+" 打开文件 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0">
            <Plus className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onClick={openFileTab}>
            <FileText className="mr-1.5 size-3.5" />
            Open Firmware...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}