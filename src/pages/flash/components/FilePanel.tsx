import { useState } from 'react'
import { Loader2, Save, GitCompare, PaintBucket, Cpu, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HexViewer, HexToolbar, type ByteWidth } from './HexViewer'
import { CompareView } from './CompareView'
import { TabBar } from './TabBar'
import { useFlashStore } from '@/stores/flash.store'
import { useProbeStore } from '@/stores/probe.store'

function formatSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

export function FilePanel() {
  const {
    tabs,
    activeTabId,
    setTabOption,
    updateTab,
    saveTabAs,
    setShowCompareDialog,
    setShowFillDialog,
    busy,
  } = useFlashStore()

  const isConnected = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? (s.probes.find((p) => p.uid === uid)?.state === 'connected') : false
  })

  const [byteWidth, setByteWidth] = useState<ByteWidth>(1)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // compare tab 渲染 CompareView
  if (activeTab?.type === 'compare' && activeTab.data && activeTab.rightData) {
    return (
      <div className="flex h-full flex-col">
        <TabBar />
        <div className="flex-1 min-h-0">
          <CompareView
            leftBase64={activeTab.data}
            leftBaseAddress={activeTab.baseAddress}
            leftTitle={activeTab.leftTitle ?? 'Left'}
            rightBase64={activeTab.rightData}
            rightBaseAddress={activeTab.rightBaseAddress ?? activeTab.baseAddress}
            rightTitle={activeTab.rightTitle ?? 'Right'}
            windowStart={activeTab.windowStart}
            windowSize={activeTab.windowSize}
            initialAddress={activeTab.firstDiff ?? activeTab.windowStart}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab 栏 */}
      <TabBar />

      {/* Tab 内容区 */}
      {activeTab && activeTab.data ? (
        <>
          {/* 工具栏：字节宽度 + 跳转 + 烧录选项 + Save As + Compare */}
          <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5 relative">
            <HexToolbar
              byteWidth={byteWidth}
              onByteWidthChange={setByteWidth}
              baseAddress={activeTab.baseAddress}
              dataLength={activeTab.size}
              jumpAddr={activeTab.jumpAddr ?? ''}
              onJumpAddrChange={(v) => updateTab(activeTab.id, { jumpAddr: v })}
            />

            {/* 分隔线 */}
            <div className="h-5 w-px bg-border mx-0.5" />

            {/* 烧录选项 */}
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={activeTab.eraseBefore} onChange={(e) => setTabOption(activeTab.id, 'eraseBefore', e.target.checked)} className="size-3 rounded border-border accent-primary" />
                <span>擦除</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={activeTab.verifyAfter} onChange={(e) => setTabOption(activeTab.id, 'verifyAfter', e.target.checked)} className="size-3 rounded border-border accent-primary" />
                <span>校验</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={activeTab.resetAfter} onChange={(e) => setTabOption(activeTab.id, 'resetAfter', e.target.checked)} className="size-3 rounded border-border accent-primary" />
                <span>复位和运行</span>
              </label>
            </div>

            <div className="h-5 w-px bg-border mx-0.5" />

            {/* Save As + Compare */}
            <Button variant="ghost" size="sm" onClick={() => saveTabAs(activeTab.id)} className="h-6 gap-1 px-1.5 text-xs">
              <Save className="size-3" />
              Save As
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowCompareDialog(true)} className="h-6 gap-1 px-1.5 text-xs">
              <GitCompare className="size-3" />
              Compare
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setShowFillDialog(true)} className="h-6 gap-1 px-1.5 text-xs" title={busy ? '操作进行中，请稍候' : '填充内存'}>
              <PaintBucket className="size-3" />
              Fill Memory
            </Button>

            {/* 右侧：文件信息 */}
            <div className="ml-auto text-[11px] text-muted-foreground">
              {activeTab.format && <span className="uppercase font-medium">{activeTab.format}</span>}
              <span className="mx-1">·</span>
              {formatSize(activeTab.size)}
              <span className="mx-1">·</span>
              {formatHex(activeTab.baseAddress)}
            </div>
          </div>

          {/* Hex 内容 */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <HexViewer
              base64Data={activeTab.data}
              baseAddress={activeTab.baseAddress}
              byteWidth={byteWidth}
              highlightOffset={activeTab.highlightOffset ?? null}
              onHighlightChange={(offset) => updateTab(activeTab.id, { highlightOffset: offset })}
              persistedScrollTop={activeTab.scrollTop}
              onScrollPersist={(st) => updateTab(activeTab.id, { scrollTop: st })}
            />
          </div>
        </>
      ) : activeTab && activeTab.loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载中...
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground gap-2">
          {activeTab?.type === 'device' ? (
            <>
              <Cpu className="size-8 opacity-40" />
              <p className="text-sm">Device Memory</p>
              <p className="text-xs">点击 Read Back 读取设备 Flash 内容</p>
            </>
          ) : (
            <>
              <FileText className="size-8 opacity-40" />
              <p className="text-sm">点击 + 打开文件</p>
              <p className="text-xs">支持 .bin / .hex / .elf / .axf</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
