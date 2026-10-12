import { useEffect, useState } from 'react'
import {
  Upload,
  CheckCircle,
  Download,
  Play,
  Box,
  FileText,
  Cpu,
  Loader2,
  GitCompare,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { wsClient } from '@/services/ws'
import { HexViewer, HexToolbar } from '@/pages/flash/components/HexViewer'
import { CompareView } from '@/pages/flash/components/CompareView'
import { useOmniToolStore } from './store'
import type { OmniProgress } from './service'
import { ConfirmDialog } from './components/ConfirmDialog'
import { FileTabBar } from './components/FileTabBar'
import { CompareDialog } from './components/CompareDialog'
import { ReadBackRangeDialog } from './components/ReadBackRangeDialog'

/** OMNI Tool App 区固定起始地址（固件分区规定，不可修改） */
const APP_ADDRESS = 0x08010000

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * OMNI Tool / Boot 子页面：给工具**自身**刷固件。
 *
 * 链路：app(0x1001) --MODE_BOOT--> boot(0x1000) --FC101/102/103--> app
 * 经 IAP（Modbus RTU）刷新 App 区，与"外部目标在线烧录"是两条独立链路。
 */
export default function BootPage() {
  const serialAvailable = useOmniToolStore((s) => s.serialAvailable)
  const session = useOmniToolStore((s) => s.session)
  const tabs = useOmniToolStore((s) => s.tabs)
  const activeTabId = useOmniToolStore((s) => s.activeTabId)
  const lastFileTabId = useOmniToolStore((s) => s.lastFileTabId)
  const updateTab = useOmniToolStore((s) => s.updateTab)
  const busy = useOmniToolStore((s) => s.busy)

  const [confirm, setConfirm] = useState<null | 'enterBoot' | 'upgrade' | 'startApp'>(null)
  const [showCompare, setShowCompare] = useState(false)

  useEffect(() => {
    useOmniToolStore.getState().refreshDevices()
  }, [])

  // 订阅后端升级进度
  useEffect(() => {
    const unsub = wsClient.on('omni_tool.progress', (data) => {
      useOmniToolStore.getState().onProgress(data as OmniProgress)
    })
    return () => unsub()
  }, [])

  const isBoot = session.personality === 'boot'
  const isApp = session.personality === 'app'
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  /**
   * 回读范围的参考文件：优先当前选中的文件 tab，否则用最近使用过的文件 tab。
   * 这样切到 Device Memory tab 后 Read Back 仍然可用（回读结果本就写进该 tab）。
   */
  const sourceTab =
    (activeTab?.kind === 'file' ? activeTab : null) ??
    (lastFileTabId ? (tabs.find((t) => t.id === lastFileTabId) ?? null) : null)

  const canUpgrade = isBoot && !!activeTab && activeTab.kind === 'file' && !busy

  return (
    <div className="flex h-full flex-col">
      {/* 未连接：仅提示，设备选择/连接由顶部 DeviceSwitcher 完成 */}
      {!session.connected ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <Box className="size-10 opacity-30" />
          <p className="text-sm">OMNI Tool 未连接</p>
          {!serialAvailable ? (
            <p className="text-xs text-destructive">缺少 pyserial，无法枚举串口</p>
          ) : (
            <p className="text-xs">请在顶部设备栏选择并连接 OMNI Tool 设备</p>
          )}
        </div>
      ) : (
        <>
          {/* 顶部工具栏
              app 模式：仅保留 Enter Bootloader（其余 IAP 操作在 app 下无意义）
              boot 模式：Upgrade / Verify / Read Back / Start App */}
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
            {!isBoot ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !isApp}
                onClick={() => setConfirm('enterBoot')}
                className="h-8 gap-1.5"
                title="写入 magic 并复位进入 bootloader"
              >
                <Upload className="size-3.5" />
                <span>Enter Bootloader</span>
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !canUpgrade}
                  onClick={() => setConfirm('upgrade')}
                  className="h-8 gap-1.5"
                  title="擦除 + 下载 + 回读校验 + 跳转"
                >
                  <Upload className="size-3.5" />
                  <span>Upgrade</span>
                </Button>

                <Separator orientation="vertical" className="mx-1 h-5" />

                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !activeTab || activeTab.kind !== 'file'}
                  onClick={() => useOmniToolStore.getState().verifyOnly()}
                  className="h-8 gap-1.5"
                  title="回读设备内容并与当前文件逐字节比对"
                >
                  <CheckCircle className="size-3.5" />
                  <span>Verify</span>
                </Button>

                <Separator orientation="vertical" className="mx-1 h-5" />

                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => useOmniToolStore.getState().setShowRangeDialog(true)}
                  className="h-8 gap-1.5"
                  title="按指定长度回读设备内容到 Device Memory"
                >
                  <Download className="size-3.5" />
                  <span>Read Back</span>
                </Button>

                <Separator orientation="vertical" className="mx-1 h-5" />

                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirm('startApp')}
                  className="h-8 gap-1.5"
                  title="跳转回 app"
                >
                  <Play className="size-3.5" />
                  <span>Start App</span>
                </Button>
              </>
            )}
          </div>

          {/* 中间：文件区（仅 boot 模式；app 模式待后续功能填充） */}
          {isBoot ? (
            <div className="flex min-h-0 flex-1 flex-col p-2">
              <FileTabBar />

              {activeTab ? (
                <>
                {/* compare tab：双栏差异对比 */}
                {activeTab.kind === 'compare' && activeTab.rightData ? (
                  /* 与 Flash 页 FilePanel 保持一致：仅 flex-1 min-h-0，
                     不要加 overflow-hidden，否则 HexViewer 虚拟滚动高度计算失效导致两侧滚动不同步 */
                  <div className="flex-1 min-h-0">
                    <CompareView
                      leftBase64={activeTab.data ?? ''}
                      leftBaseAddress={APP_ADDRESS}
                      leftTitle={activeTab.leftTitle ?? 'Left'}
                      rightBase64={activeTab.rightData}
                      rightBaseAddress={APP_ADDRESS}
                      rightTitle={activeTab.rightTitle ?? 'Right'}
                    />
                  </div>
                ) : (
                  <>
                    {/* 工具栏：字节宽度 + 地址跳转 + Compare + 文件信息 */}
                    <div className="relative flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
                      <HexToolbar
                        byteWidth={activeTab.byteWidth}
                        onByteWidthChange={(w) =>
                          updateTab(activeTab.id, { byteWidth: w, highlightOffset: null })
                        }
                        baseAddress={APP_ADDRESS}
                        dataLength={activeTab.size}
                        jumpAddr={activeTab.jumpAddr}
                        onJumpAddrChange={(v) => updateTab(activeTab.id, { jumpAddr: v })}
                      />

                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !activeTab.data}
                        onClick={() => setShowCompare(true)}
                        className="h-6 gap-1 px-1.5 text-xs"
                        title="选择参考文件与当前数据逐字节对比"
                      >
                        <GitCompare className="size-3" />
                        Compare
                      </Button>

                      {/* 右侧：文件信息 */}
                      <div className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                        {activeTab.kind === 'file' ? (
                          <span className="uppercase font-medium">{activeTab.format}</span>
                        ) : null}
                        <span>·</span>
                        <span>{formatSize(activeTab.size)}</span>
                      </div>
                    </div>

                    {/* Hex 内容 */}
                    <div className="mt-2 min-h-0 flex-1 overflow-hidden rounded-md border border-border">
                      {activeTab.loading ? (
                        <div className="flex h-full items-center justify-center text-muted-foreground">
                          <Loader2 className="mr-2 size-4 animate-spin" />
                          读取中...
                        </div>
                      ) : activeTab.data ? (
                        <HexViewer
                          base64Data={activeTab.data}
                          baseAddress={APP_ADDRESS}
                          byteWidth={activeTab.byteWidth}
                          highlightOffset={activeTab.highlightOffset}
                          onHighlightChange={(offset) =>
                            updateTab(activeTab.id, { highlightOffset: offset })
                          }
                          persistedScrollTop={activeTab.scrollTop}
                          onScrollPersist={(st) => updateTab(activeTab.id, { scrollTop: st })}
                        />
                      ) : (
                        /* 空态：Device Memory 引导回读 */
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                          {activeTab.kind === 'device' ? (
                            <>
                              <Cpu className="size-8 opacity-40" />
                              <p className="text-sm">Device Memory</p>
                              <p className="text-xs">点击 Read Back 读取设备 Flash 内容</p>
                            </>
                          ) : (
                            <>
                              <FileText className="size-8 opacity-40" />
                              <p className="text-sm">无数据</p>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            ) : null}
          </div>
          ) : null}

          {/* 人格未识别提示 */}
          {!isBoot && !isApp ? (
            <p className="shrink-0 px-4 pb-2 text-xs text-amber-600">
              当前设备人格未识别，可能无法执行升级操作。
            </p>
          ) : null}
        </>
      )}

      {/* 二次确认 */}
      <ConfirmDialog
        open={confirm === 'enterBoot'}
        title="进入 Bootloader"
        description="设备将写入 magic 并立即复位，当前 CMSIS-DAP 调试会话会中断。确认继续？"
        confirmLabel="进入 Bootloader"
        busy={busy}
        onOpenChange={(o) => !o && setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          useOmniToolStore.getState().enterBoot()
        }}
      />

      <ConfirmDialog
        open={confirm === 'upgrade'}
        title="开始升级（不可逆）"
        description={
          <>
            <div>固件：{activeTab?.title ?? '未选择'}</div>
            <div>地址：{formatHex(APP_ADDRESS)}</div>
            <div className="mt-2">
              将擦除目标地址覆盖的扇区并写入固件，过程中请勿拔线或断电。校验不通过时不会跳转。
            </div>
          </>
        }
        confirmLabel="开始升级"
        busy={busy}
        onOpenChange={(o) => !o && setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          useOmniToolStore.getState().startUpgrade()
        }}
      />

      <ReadBackRangeDialog />

      <CompareDialog open={showCompare} onOpenChange={setShowCompare} />

      <ConfirmDialog
        open={confirm === 'startApp'}
        title="跳转到 App"
        description="设备将跳出 bootloader 并跳转回 app，USB 会重新枚举为 app (PID 0x1001)。"
        confirmLabel="Start App"
        danger={false}
        busy={busy}
        onOpenChange={(o) => !o && setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          useOmniToolStore.getState().startApp()
        }}
      />
    </div>
  )
}