import { useEffect, useState } from 'react'
import { FileText, Loader2, MapPin, Check, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HexViewer, HexToolbar } from '@/pages/flash/components/HexViewer'
import { FlasherTabBar } from './FlasherTabBar'
import { parseAddress, useFlasherStore } from '../flasher.store'

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/** BIN 目标地址输入框（hex 自带地址，不适用） */
function AddressInput({ tabId }: { tabId: string }) {
  const tab = useFlasherStore((s) => s.tabs.find((t) => t.id === tabId))
  const applyAddress = useFlasherStore((s) => s.applyAddress)
  const updateTab = useFlasherStore((s) => s.updateTab)
  const [draft, setDraft] = useState('')

  // 外部改动（如切换 tab 后重新解析）同步到输入框
  useEffect(() => {
    setDraft(tab?.addrOverride ?? '')
  }, [tab?.addrOverride, tabId])

  if (!tab || tab.format !== 'bin') return null

  const invalid = draft.trim() !== '' && parseAddress(draft) === null

  return (
    <div className="flex items-center gap-1.5">
      <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs text-muted-foreground">目标地址</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            updateTab(tabId, { addrOverride: draft })
            void applyAddress(tabId)
          }
        }}
        placeholder={formatHex(tab.address)}
        spellCheck={false}
        autoComplete="off"
        className={`w-28 rounded border bg-transparent px-1.5 py-0.5 font-mono text-xs outline-none focus:border-primary ${
          invalid ? 'border-destructive' : 'border-border'
        }`}
        title="BIN 文件不含地址，在此指定烧录起始地址"
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        disabled={invalid}
        onClick={() => {
          updateTab(tabId, { addrOverride: draft })
          void applyAddress(tabId)
        }}
        title="应用地址并重新解析"
      >
        <Check className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        onClick={() => {
          updateTab(tabId, { addrOverride: '' })
          setDraft('')
          void applyAddress(tabId)
        }}
        title="恢复默认地址（目标 Flash 起点）"
      >
        <RotateCcw className="size-3" />
      </Button>
    </div>
  )
}

/**
 * 待烧录固件的文件区：tab 栏 + 工具栏（字节宽度 / 目标地址）+ Hex 预览。
 *
 * 布局与 Flash 页 FilePanel 保持一致（TabBar → 工具栏 → Hex 内容），
 * 镜像的段与 CRC32 等信息收敛到工具栏右侧，避免多出一行挤占 Hex 高度。
 *
 * 与 Boot 页的区别：这里烧的是**外部目标芯片**，所以 BIN 需要可改目标地址；
 * HEX 的地址由文件记录决定，固件侧解析，不提供手动输入。
 */
export function FlasherPanel() {
  const tabs = useFlasherStore((s) => s.tabs)
  const activeTabId = useFlasherStore((s) => s.activeTabId)
  const updateTab = useFlasherStore((s) => s.updateTab)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // 工具栏右侧信息的悬停提示：文件原始大小（HEX 另附解出大小）+ 各地址段
  const infoTitle = activeTab
    ? [
        `文件 ${formatBytes(activeTab.fileSize)}${
          activeTab.format === 'hex' && activeTab.fileSize !== activeTab.size
            ? `（解出 ${formatBytes(activeTab.size)}）`
            : ''
        }`,
        ...activeTab.segments.map(
          (s) => `段 ${formatHex(s.address)}–${formatHex(s.address + s.size)}（${formatBytes(s.size)}）`
        ),
      ].join('\n')
    : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FlasherTabBar />

      {activeTab ? (
        activeTab.loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            解析中...
          </div>
        ) : (
          <>
            {/* 工具栏：字节宽度 + 目标地址 + 文件信息 */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
              <HexToolbar
                byteWidth={activeTab.byteWidth}
                onByteWidthChange={(w) =>
                  updateTab(activeTab.id, { byteWidth: w, highlightOffset: null })
                }
                baseAddress={activeTab.address}
                dataLength={activeTab.size}
                jumpAddr={activeTab.jumpAddr}
                onJumpAddrChange={(v) => updateTab(activeTab.id, { jumpAddr: v })}
              />

              <div className="h-5 w-px bg-border" />

              <AddressInput tabId={activeTab.id} />

              {/* 右侧：文件信息（地址段与 CRC32 收在悬停提示里） */}
              <div
                className="ml-auto shrink-0 text-[11px] text-muted-foreground"
                title={infoTitle}
              >
                <span className="font-medium uppercase">{activeTab.format}</span>
                <span className="mx-1">·</span>
                {formatBytes(activeTab.size)}
                <span className="mx-1">·</span>
                {activeTab.format === 'hex' ? (
                  <span className="opacity-70">地址由文件解析</span>
                ) : (
                  formatHex(activeTab.address)
                )}
                {activeTab.segments.length > 1 ? (
                  <>
                    <span className="mx-1">·</span>
                    <span className="opacity-70">{activeTab.segments.length} 段</span>
                  </>
                ) : null}
                {activeTab.crc32 ? (
                  <>
                    <span className="mx-1">·</span>
                    <span className="font-mono">
                      CRC32 0x{activeTab.crc32.toString(16).toUpperCase().padStart(8, '0')}
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            {/* Hex 内容 */}
            <div className="min-h-0 flex-1 overflow-hidden">
              {activeTab.data ? (
                <HexViewer
                  base64Data={activeTab.data}
                  baseAddress={activeTab.address}
                  byteWidth={activeTab.byteWidth}
                  highlightOffset={activeTab.highlightOffset}
                  onHighlightChange={(offset) =>
                    updateTab(activeTab.id, { highlightOffset: offset })
                  }
                  persistedScrollTop={activeTab.scrollTop}
                  onScrollPersist={(st) => updateTab(activeTab.id, { scrollTop: st })}
                />
              ) : null}
            </div>
          </>
        )
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <FileText className="size-8 opacity-40" />
          <p className="text-sm">未选择固件</p>
          <p className="text-xs">点击 + 打开 .bin / .hex 文件</p>
        </div>
      )}
    </div>
  )
}
