import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useOmniToolStore } from '../store'

const APP_START = 0x08010000
const APP_END = 0x080E0000
const DEFAULT_SIZE = 256 * 1024

/** 固定 0x 前缀的十六进制输入框（参照 Flash 页 ReadBackRangeDialog） */
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
      <span className="border-r border-border bg-muted/50 px-1.5 py-1 font-mono text-xs text-muted-foreground">
        0x
      </span>
      <input
        value={value.replace(/^0x/i, '')}
        onChange={(e) => onChange(e.target.value.replace(/^0x/i, ''))}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        className="flex-1 bg-transparent px-1.5 py-1 font-mono text-sm outline-none"
      />
    </div>
  )
}

/** 回读范围对话框：地址固定为 App 区起点，仅需填写长度 */
export function ReadBackRangeDialog() {
  const show = useOmniToolStore((s) => s.showRangeDialog)
  const setShow = useOmniToolStore((s) => s.setShowRangeDialog)
  const readBack = useOmniToolStore((s) => s.readBack)
  const tabs = useOmniToolStore((s) => s.tabs)
  const lastFileTabId = useOmniToolStore((s) => s.lastFileTabId)

  const [sizeText, setSizeText] = useState('')
  const [error, setError] = useState('')

  // 默认长度取最近使用的固件文件大小
  useEffect(() => {
    if (show) {
      const src = tabs.find((t) => t.id === lastFileTabId && t.kind === 'file')
      setSizeText((src?.size ? src.size : DEFAULT_SIZE).toString(16).toUpperCase())
      setError('')
    }
  }, [show, tabs, lastFileTabId])

  const handleConfirm = () => {
    const text = sizeText.trim()
    const size = parseInt(text, 16)
    if (isNaN(size) || size <= 0) {
      setError('请输入有效的长度（十六进制）')
      return
    }
    if (size % 4 !== 0) {
      setError('长度需 4 字节对齐（boot 单帧对齐要求）')
      return
    }
    if (APP_START + size > APP_END) {
      setError(`超出 App 区容量（最大 ${APP_END - APP_START} 字节）`)
      return
    }
    setShow(false)
    void readBack(size)
  }

  return (
    <Dialog open={show} onOpenChange={(open) => !open && setShow(false)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>回读设备内容</DialogTitle>
          <DialogDescription>从 App 区固定起始地址回读到 Device Memory</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="w-16 shrink-0 text-sm">起始地址</label>
            <span className="flex-1 rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-sm">
              {APP_START.toString(16).toUpperCase()}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-16 shrink-0 text-sm">长度</label>
            <HexInput value={sizeText} onChange={setSizeText} placeholder="40000" />
          </div>

          <div className="space-y-0.5 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <div>App 区范围：08010000 - 080DFFFF（832 KB）</div>
            <div>
              回读长度：
              <span className="font-mono">
                {(() => {
                  const n = parseInt(sizeText, 16)
                  return isNaN(n) || n <= 0
                    ? '—'
                    : n >= 1024 * 1024
                      ? `${(n / 1024 / 1024).toFixed(2)} MB`
                      : n >= 1024
                        ? `${(n / 1024).toFixed(1)} KB`
                        : `${n} B`
                })()}
              </span>
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShow(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm}>回读</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}