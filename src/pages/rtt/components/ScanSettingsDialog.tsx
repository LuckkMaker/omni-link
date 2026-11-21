import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useRttStore, type RttScanMode } from '@/stores/rtt.store'
import { cn } from '@/lib/utils'

const MODE_OPTIONS: Array<{ value: RttScanMode; label: string; desc: string }> = [
  { value: 'auto', label: '自动检测', desc: '遍历目标 RAM 区域查找 SEGGER RTT 控制块' },
  { value: 'address', label: '指定地址', desc: '已知 _SEGGER_RTT 地址时直接解析，启动最快' },
  { value: 'range', label: '地址范围', desc: '在指定起始地址与范围内扫描控制块' },
]

/** 带 0x 前缀的十六进制输入框（值为纯 hex 文本，不含前缀） */
function HexInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex flex-1 items-center overflow-hidden rounded-md border border-border focus-within:ring-1 focus-within:ring-ring">
      <span className="border-r border-border bg-muted/50 px-1.5 py-1 font-mono text-xs text-muted-foreground">0x</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        className="flex-1 bg-transparent px-1.5 py-1 font-mono text-sm outline-none"
      />
    </div>
  )
}

/** 解析十六进制文本；非法输入返回 null */
function parseHexText(text: string): number | null {
  const t = text.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(t)) return null
  return parseInt(t, 16)
}

function toHexText(n: number): string {
  return n.toString(16).toUpperCase()
}

function formatBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

interface ScanSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** RTT 控制块扫描设置（自动检测 / 指定地址 / 地址范围），修改后下次启动生效 */
export function ScanSettingsDialog({ open, onOpenChange }: ScanSettingsDialogProps) {
  const scanMode = useRttStore((s) => s.scanMode)
  const scanAddress = useRttStore((s) => s.scanAddress)
  const scanSize = useRttStore((s) => s.scanSize)
  const setScanMode = useRttStore((s) => s.setScanMode)
  const setScanAddress = useRttStore((s) => s.setScanAddress)
  const setScanSize = useRttStore((s) => s.setScanSize)

  const [addrText, setAddrText] = useState('')
  const [sizeText, setSizeText] = useState('')

  // 仅在弹窗打开时同步一次，避免用户输入过程中被 store 的值回写打断
  useEffect(() => {
    if (open) {
      setAddrText(toHexText(scanAddress))
      setSizeText(toHexText(scanSize))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const addrValue = parseHexText(addrText)
  const sizeValue = parseHexText(sizeText)

  const handleAddrChange = (v: string) => {
    setAddrText(v)
    const parsed = parseHexText(v)
    if (parsed !== null) setScanAddress(parsed)
  }

  const handleSizeChange = (v: string) => {
    setSizeText(v)
    const parsed = parseHexText(v)
    if (parsed !== null && parsed > 0) setScanSize(parsed)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>RTT 控制块扫描</DialogTitle>
          <DialogDescription>设置后端在目标 RAM 中查找 RTT 控制块的方式，修改后下次启动生效</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 扫描模式 */}
          <div className="grid grid-cols-3 gap-1 rounded-md border border-border p-0.5">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setScanMode(opt.value)}
                className={cn(
                  'h-7 rounded text-[11px] font-medium transition-colors',
                  scanMode === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            {MODE_OPTIONS.find((o) => o.value === scanMode)?.desc}
          </p>

          {/* 地址 / 范围输入 */}
          {scanMode !== 'auto' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="w-16 shrink-0 text-sm">
                  {scanMode === 'address' ? '控制块地址' : '起始地址'}
                </label>
                <HexInput value={addrText} onChange={handleAddrChange} placeholder="20000000" />
              </div>
              {scanMode === 'address' && addrValue === null && (
                <p className="text-xs text-destructive">请输入有效的十六进制地址</p>
              )}
              {scanMode === 'range' && (
                <>
                  <div className="flex items-center gap-2">
                    <label className="w-16 shrink-0 text-sm">扫描大小</label>
                    <HexInput value={sizeText} onChange={handleSizeChange} placeholder="4000" />
                  </div>
                  {sizeValue === null || sizeValue <= 0 ? (
                    <p className="text-xs text-destructive">请输入大于 0 的十六进制大小</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      范围 <span className="font-mono">
                        {addrValue !== null ? `0x${toHexText(addrValue)}` : '—'}
                        {addrValue !== null ? ` ~ 0x${toHexText(addrValue + sizeValue - 1)}` : ''}
                      </span>
                      （{formatBytes(sizeValue)}）
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
