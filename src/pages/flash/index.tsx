import { useState, useEffect } from 'react'
import {
  Eraser,
  Upload,
  CheckCircle,
  Download,
  Play,
  RotateCcw,
  ScanSearch,
  ChevronDown,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FilePanel } from './components/FilePanel'
import { BinAddressDialog } from './components/BinAddressDialog'
import { ReadBackRangeDialog } from './components/ReadBackRangeDialog'
import { CompareDialog } from './components/CompareDialog'
import { useFlashStore } from '@/stores/flash.store'
import { useProbeStore } from '@/stores/probe.store'

export default function FlashPage() {
  const {
    busy,
    doCheckBlank,
    doEraseChip,
    doEraseSelectedSectors,
    doProgram,
    doVerify,
    doReadBack,
    doReadBackSelectedSectors,
    doStartApp,
    doReset,
    doFillMemory,
    setShowReadBackRangeDialog,
    showFillDialog,
    setShowFillDialog,
    fillAddress,
    fillSize,
    fillValue,
    setFillAddress,
    setFillSize,
    setFillValue,
    checkFileChanges,
  } = useFlashStore()

  // 定时检查文件变更（每 3 秒检查所有 file tab）
  useEffect(() => {
    const timer = setInterval(() => {
      checkFileChanges()
    }, 3000)
    return () => clearInterval(timer)
  }, [checkFileChanges])

  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'

  const activeTab = useFlashStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  // 可编程条件：file tab 有文件路径，或 device tab 有数据
  const canProgram = activeTab?.type === 'file' && !!activeTab.filePath
    || activeTab?.type === 'device' && !!activeTab.data
  const canReadBack = !!activeTab

  return (
    <div className="flex h-full flex-col">
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-1 border-b border-border px-3 py-2 shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!isConnected || busy || !canProgram} className="h-8 gap-1">
              <Upload className="size-3.5" />
              Program
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => doProgram(false)}>Program</DropdownMenuItem>
            <DropdownMenuItem onClick={() => doProgram(true)}>
              <ShieldCheck className="size-3.5 mr-1.5" />
              Program &amp; Verify
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!isConnected || busy} className="h-8 gap-1">
              <Eraser className="size-3.5" />
              Erase
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={doEraseChip}>Erase Chip</DropdownMenuItem>
            <DropdownMenuItem onClick={() => doEraseSelectedSectors()}>Erase Sectors...</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button variant="ghost" size="sm" disabled={!isConnected || busy || !canProgram} onClick={doVerify} className="h-8 gap-1.5">
          <CheckCircle className="size-3.5" />
          Verify
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!isConnected || busy || !canReadBack} className="h-8 gap-1">
              <Download className="size-3.5" />
              Read Back
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => doReadBack('chip')}>Entire Chip</DropdownMenuItem>
            <DropdownMenuItem onClick={() => doReadBackSelectedSectors()}>Sectors...</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowReadBackRangeDialog(true)}>Range...</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button variant="ghost" size="sm" disabled={!isConnected || busy} onClick={doStartApp} className="h-8 gap-1.5">
          <Play className="size-3.5" />
          Start App
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button variant="ghost" size="sm" disabled={!isConnected || busy} onClick={doReset} className="h-8 gap-1.5">
          <RotateCcw className="size-3.5" />
          Reset
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button variant="ghost" size="sm" disabled={!isConnected || busy} onClick={doCheckBlank} className="h-8 gap-1.5">
          <ScanSearch className="size-3.5" />
          Check Blank
        </Button>
      </div>

      {/* 中间：文件区域（全宽） */}
      <div className="flex-1 min-h-0 p-2">
        <FilePanel />
      </div>

      {/* 弹窗 */}
      <BinAddressDialog />
      <ReadBackRangeDialog />
      <CompareDialog />

      {/* 填充内存对话框 */}
      <Dialog open={showFillDialog} onOpenChange={setShowFillDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>填充内存</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">起始地址</Label>
              <Input
                className="font-mono text-sm"
                value={fillAddress}
                onChange={(e) => setFillAddress(e.target.value)}
                placeholder="0x08000000"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">大小 (字节)</Label>
              <Input
                className="font-mono text-sm"
                value={fillSize}
                onChange={(e) => setFillSize(e.target.value)}
                placeholder="4096"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">填充值</Label>
              <Input
                className="font-mono text-sm"
                value={fillValue}
                onChange={(e) => setFillValue(e.target.value)}
                placeholder="0xFF"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowFillDialog(false)}>取消</Button>
            <Button disabled={busy} onClick={() => {
              const addr = parseInt(fillAddress, fillAddress.startsWith('0x') ? 16 : 10)
              const sz = parseInt(fillSize, fillSize.startsWith('0x') ? 16 : 10)
              const val = parseInt(fillValue, fillValue.startsWith('0x') ? 16 : 10)
              if (isNaN(addr) || isNaN(sz) || isNaN(val) || sz <= 0 || val < 0 || val > 255) return
              setShowFillDialog(false)
              doFillMemory(addr, sz, val)
            }}>
              填充
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
