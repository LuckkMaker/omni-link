import { useCallback, useEffect, useState } from 'react'
import { Box, ChevronDown, Cpu, FileCode2, HardDriveDownload, Rocket, Usb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ResizeHandle } from '@/components/LogConsole'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from './components/ConfirmDialog'
import { TargetDialog } from './components/TargetDialog'
import { FlasherPanel } from './components/FlasherPanel'
import { FlasherConfigSidebar } from './components/FlasherConfigSidebar'
import { useOmniToolStore } from './store'
import { useFlasherStore } from './flasher.store'
import { wsClient } from '@/services/ws'
import type { OmniProgress } from './service'

const SIDEBAR_MAX_RATIO = 0.25
const SIDEBAR_DEFAULT_WIDTH = 288

function getSidebarMaxWidth(): number {
  return Math.floor((window.innerWidth ?? 1280) * SIDEBAR_MAX_RATIO)
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * OMNI Tool / Flasher 子页面：把 OMNI Tool 当作 SWD 探针，在线烧录**外部目标芯片**。
 *
 * 与 Boot 页的区别：Boot 刷的是工具自身（IAP），本页刷的是挂在 SWD 上的目标，
 * 所以目标芯片与地址都需要用户指定。
 *
 * 上位机统一走固件镜像型会话（`OPEN_IMAGE`/`IMAGE_DATA`/`IMAGE_VERIFY`），
 * bin 与 hex 一视同仁；整片擦除与回读校验复用地址型会话。
 *
 * 布局对齐：左侧为主内容（顶部工具栏 + 文件区），右侧配置栏作为**顶层兄弟节点**
 * 从页面顶部贯通到底（与 Commander 页一致），而不是压在工具栏下方。
 */
export default function FlasherPage() {
  const session = useOmniToolStore((s) => s.session)
  const serialAvailable = useOmniToolStore((s) => s.serialAvailable)

  const status = useFlasherStore((s) => s.status)
  const targets = useFlasherStore((s) => s.targets)
  const targetId = useFlasherStore((s) => s.targetId)
  const tabs = useFlasherStore((s) => s.tabs)
  const activeTabId = useFlasherStore((s) => s.activeTabId)
  const chipErase = useFlasherStore((s) => s.chipErase)
  const readbackVerify = useFlasherStore((s) => s.readbackVerify)
  const busy = useFlasherStore((s) => s.busy)

  const [confirmFlash, setConfirmFlash] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)

  const target = targets.find((t) => t.id === targetId) ?? null
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const flmSource = useFlasherStore((s) => s.flmSource)
  const flmName = useFlasherStore((s) => s.flmName)

  // 设备/会话变化会影响可用性
  useEffect(() => {
    useFlasherStore.getState().refreshStatus()
  }, [session.connected, session.port, session.personality])

  useEffect(() => {
    useOmniToolStore.getState().refreshDevices()
  }, [])

  // 烧录进度经同一 WebSocket 通道推送
  useEffect(() => {
    const unsub = wsClient.on('omni_tool.progress', (data) => {
      useFlasherStore.getState().onProgress(data as OmniProgress)
    })
    return () => unsub()
  }, [])

  const connected = session.connected
  // 在线烧录只能走 app 人格：boot 固件只有 IAP，没有 SWD
  const isApp = session.personality === 'app'
  const available = !!status?.available && isApp
  const hasFile = !!activeTab && !activeTab.loading && activeTab.size > 0
  const canFlash = available && hasFile && !!target && !busy

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.max(0, Math.min(getSidebarMaxWidth(), w - delta)))
  }, [])
  const handleToggleSidebar = useCallback(() => {
    setSidebarWidth((w) => (w > 0 ? 0 : getSidebarMaxWidth()))
  }, [])

  if (!connected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Usb className="size-10 opacity-30" />
        <p className="text-sm">OMNI Tool 未连接</p>
        {!serialAvailable ? (
          <p className="text-xs text-destructive">缺少 pyserial，无法枚举串口</p>
        ) : (
          <p className="text-xs">请在顶部设备栏选择并连接 OMNI Tool 设备</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧主内容：工具栏 + 文件区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部工具栏：目标芯片 + 烧录 / 恢复 */}
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
          {/* 目标芯片：点击弹窗选择（内置 / 外部 FLM） */}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => useFlasherStore.getState().openTargetDialog()}
            className="h-8 gap-1.5"
            title="选择目标芯片（内置 FLM 或外部 FLM 文件）"
          >
            <Cpu className="size-3.5" />
            <span>目标芯片</span>
            {target ? (
              <Badge variant="outline" className="ml-0.5 h-5 px-1.5 text-[10px]">
                {target.name}
              </Badge>
            ) : null}
            <ChevronDown className="size-3" />
          </Button>

          {/* FLM 来源指示：外部 FLM 已选但固件尚不支持时明确提示，避免误以为生效 */}
          {flmSource === 'file' ? (
            <Badge
              variant="outline"
              className="h-5 shrink-0 gap-1 border-amber-500/50 px-1.5 text-[10px] text-amber-600 dark:text-amber-500"
              title={`已选外部 FLM：${flmName ?? ''}。当前固件暂不支持在线下发 FLM，实际仍使用内置算法`}
            >
              <FileCode2 className="size-3" />
              外部 FLM 未生效
            </Badge>
          ) : null}

          <span className="mx-1 h-5 w-px bg-border" />

          <Button
            variant="ghost"
            size="sm"
            disabled={!canFlash}
            onClick={() => setConfirmFlash(true)}
            className="h-8 gap-1.5"
            title="下发镜像 → 固件校验 CRC32 → 回读比对 → 切回 DAP"
          >
            <Rocket className="size-3.5" />
            <span>Flash Target</span>
          </Button>

          <span className="mx-1 h-5 w-px bg-border" />

          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !isApp}
            onClick={() => useFlasherStore.getState().recover()}
            className="h-8 gap-1.5"
            title="目标复位并重建 SWD 链路。烧录失败会自动清场，正常无需手动点"
          >
            <HardDriveDownload className="size-3.5" />
            <span>Recover</span>
          </Button>

          <div className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
            <Box className="size-3" />
            <span>{session.port}</span>
            {status ? <span>· {status.max_image_payload} B/包</span> : null}
          </div>
        </div>

        {/* 人格不符时给出明确原因 */}
        {!isApp ? (
          <div className="shrink-0 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-500">
            当前设备处于 bootloader 模式，仅提供自身 IAP，无法烧录外部目标。
            请切到 <b>Boot</b> 子页面执行「Enter Bootloader」回到 app 模式，或给工具断电重插。
          </div>
        ) : null}

        {/* 文件区（对齐 Flash 页 FilePanel：仅外层 p-2 留白，内部自行铺满） */}
        <div className="min-h-0 flex-1 p-2">
          <FlasherPanel />
        </div>
      </div>

      {/* 水平拖拽分隔条（双击在[完全隐藏]与[最大尺寸]之间切换） */}
      <ResizeHandle
        direction="horizontal"
        onResize={handleSidebarResize}
        onToggle={handleToggleSidebar}
        expanded={sidebarWidth > 0}
      />

      {/* 右侧配置栏：顶层兄弟节点，从页面顶部贯通到底（宽度为 0 时完全隐藏） */}
      <div
        className={cn(
          'shrink-0 overflow-hidden border-l border-border bg-card',
          sidebarWidth > 0 ? '' : 'hidden'
        )}
        style={sidebarWidth > 0 ? { width: sidebarWidth } : undefined}
      >
        <FlasherConfigSidebar />
      </div>

      <TargetDialog />

      {/* 烧录二次确认（不可逆：可能擦除目标芯片） */}
      <ConfirmDialog
        open={confirmFlash}
        title="开始烧录目标芯片"
        description={
          <>
            <div>目标：{target?.name ?? '未选择'}</div>
            <div>固件：{activeTab?.title ?? '未选择'}</div>
            <div>
              {activeTab?.format === 'hex' ? '地址：由 HEX 文件解析' : `地址：${formatHex(activeTab?.address ?? 0)}`}
              {' · '}
              {formatBytes(activeTab?.size ?? 0)}
              {activeTab && activeTab.segments.length > 1
                ? ` · ${activeTab.segments.length} 段`
                : ''}
            </div>
            <div className="mt-2">
              {chipErase
                ? '将先整片擦除目标 Flash 再写入，耗时可能达数十秒以上。'
                : '不做整片擦除，由固件按扇区懒擦除（跨扇区才擦）。'}
              固件侧会校验整镜像 CRC32
              {readbackVerify ? '，写完再回读逐字节比对' : '（本次未开启回读校验）'}。
              过程中请勿断开 SWD 或给目标断电。
            </div>
          </>
        }
        confirmLabel="开始烧录"
        busy={busy}
        onOpenChange={(o) => !o && setConfirmFlash(false)}
        onConfirm={() => {
          setConfirmFlash(false)
          useFlasherStore.getState().startFlash()
        }}
      />
    </div>
  )
}
