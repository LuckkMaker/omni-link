import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type SidebarContextValue = {
  /** 侧边栏是否展开（false = 折叠成窄图标栏） */
  open: boolean
  /** 设置展开状态 */
  setOpen: (open: boolean) => void
  /** 切换展开/折叠 */
  toggleSidebar: () => void
  /** 是否处于折叠态（窄图标栏） */
  isCollapsed: boolean
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar 必须在 <SidebarProvider> 内使用')
  }
  return context
}

/**
 * 桌面专用侧边栏 Provider。
 * 通过受控 open/onOpenChange 驱动；不引入移动端 Sheet 抽屉逻辑（Electron 固定布局）。
 */
function SidebarProvider({
  open: openProp,
  onOpenChange,
  defaultOpen = true,
  children,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  const open = openProp !== undefined ? openProp : internalOpen

  const setOpen = React.useCallback(
    (value: boolean) => {
      setInternalOpen(value)
      onOpenChange?.(value)
    },
    [onOpenChange]
  )

  const toggleSidebar = React.useCallback(() => setOpen(!open), [open, setOpen])

  const value = React.useMemo<SidebarContextValue>(
    () => ({ open, setOpen, toggleSidebar, isCollapsed: !open }),
    [open, setOpen, toggleSidebar]
  )

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
}

const Sidebar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { collapsible?: 'icon' | 'offcanvas' }
>(({ className, collapsible = 'icon', children, ...props }, ref) => {
  const { open } = useSidebar()
  const isCollapsed = collapsible === 'icon' && !open
  return (
    <div
      ref={ref}
      data-sidebar="root"
      data-collapsible={collapsible}
      data-collapsed={isCollapsed || undefined}
      className={cn(
        'group/sidebar flex h-full shrink-0 flex-col border-r border-border bg-muted/30 overflow-hidden transition-[width] duration-300 ease-in-out',
        collapsible === 'icon' ? (open ? 'w-56' : 'w-16') : open ? 'w-56' : 'w-0',
        className
      )}
      {...props}
    >
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </div>
  )
})
Sidebar.displayName = 'Sidebar'

const SidebarHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="header"
      className={cn('shrink-0 border-b border-border p-2', className)}
      {...props}
    />
  )
)
SidebarHeader.displayName = 'SidebarHeader'

const SidebarContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="content"
      className={cn('flex-1 min-h-0 overflow-y-auto p-3 select-none', className)}
      {...props}
    />
  )
)
SidebarContent.displayName = 'SidebarContent'

const SidebarFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-sidebar="footer" className={cn('shrink-0', className)} {...props} />
  )
)
SidebarFooter.displayName = 'SidebarFooter'

const SidebarGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-sidebar="group" className={cn('w-full', className)} {...props} />
  )
)
SidebarGroup.displayName = 'SidebarGroup'

const SidebarGroupLabel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="group-label"
      className={cn(
        'mb-1 px-3 text-xs font-medium text-muted-foreground/70 uppercase',
        className
      )}
      {...props}
    />
  )
)
SidebarGroupLabel.displayName = 'SidebarGroupLabel'

const SidebarGroupContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-sidebar="group-content" className={cn('w-full', className)} {...props} />
  )
)
SidebarGroupContent.displayName = 'SidebarGroupContent'

const SidebarMenu = React.forwardRef<HTMLUListElement, React.HTMLAttributes<HTMLUListElement>>(
  ({ className, ...props }, ref) => (
    <ul
      ref={ref}
      data-sidebar="menu"
      className={cn('space-y-1', className)}
      {...props}
    />
  )
)
SidebarMenu.displayName = 'SidebarMenu'

const SidebarMenuItem = React.forwardRef<HTMLLIElement, React.HTMLAttributes<HTMLLIElement>>(
  ({ className, ...props }, ref) => (
    <li ref={ref} data-sidebar="menu-item" className={cn('group/menu-item', className)} {...props} />
  )
)
SidebarMenuItem.displayName = 'SidebarMenuItem'

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean
    isActive?: boolean
    /** 折叠态悬停提示；折叠态下将包裹 Tooltip */
    tooltip?: string
    /** 折叠态是否仅保留图标（隐藏非 svg 子元素并放大图标）。带角标等装饰的项可设为 false 自行安排折叠态内容 */
    collapseIconOnly?: boolean
  }
>(({ asChild = false, isActive = false, tooltip, collapseIconOnly = true, className, children, ...props }, ref) => {
  const { isCollapsed } = useSidebar()
  const Comp = asChild ? Slot : 'button'
  const button = (
    <Comp
      ref={ref}
      data-sidebar="menu-button"
      data-active={isActive || undefined}
      className={cn(
        'flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        isCollapsed &&
          cn(
            'justify-center px-2',
            collapseIconOnly && '[&>*:not(svg)]:hidden [&>svg]:size-6'
          ),
        isActive
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        className
      )}
      {...props}
    >
      {children}
    </Comp>
  )

  if (isCollapsed && tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
    )
  }
  return button
})
SidebarMenuButton.displayName = 'SidebarMenuButton'

const SidebarMenuSub = React.forwardRef<HTMLUListElement, React.HTMLAttributes<HTMLUListElement>>(
  ({ className, ...props }, ref) => {
    const { isCollapsed } = useSidebar()
    return (
      <ul
        ref={ref}
        data-sidebar="menu-sub"
        className={cn('ml-4 space-y-0.5 border-l border-border pl-2', isCollapsed && 'hidden', className)}
        {...props}
      />
    )
  }
)
SidebarMenuSub.displayName = 'SidebarMenuSub'

const SidebarMenuSubItem = React.forwardRef<HTMLLIElement, React.HTMLAttributes<HTMLLIElement>>(
  ({ className, ...props }, ref) => (
    <li ref={ref} data-sidebar="menu-sub-item" className={cn('', className)} {...props} />
  )
)
SidebarMenuSubItem.displayName = 'SidebarMenuSubItem'

const SidebarMenuSubButton = React.forwardRef<
  HTMLAnchorElement,
  React.AnchorHTMLAttributes<HTMLAnchorElement> & { asChild?: boolean; isActive?: boolean }
>(({ asChild = false, isActive = false, className, children, ...props }, ref) => {
  const Comp = asChild ? Slot : 'a'
  return (
    <Comp
      ref={ref}
      data-sidebar="menu-sub-button"
      data-active={isActive || undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
        isActive
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        className
      )}
      {...props}
    >
      {children}
    </Comp>
  )
})
SidebarMenuSubButton.displayName = 'SidebarMenuSubButton'

export {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
}