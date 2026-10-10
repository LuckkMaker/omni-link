import { useState } from 'react'
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

/** 比较对话框：选择参考文件，与当前 tab 数据做逐字节对比 */
export function CompareDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const compareWith = useOmniToolStore((s) => s.compareWith)
  const [error, setError] = useState('')

  const handleSelectFile = async () => {
    const path = await window.electron?.openFileDialog?.({
      extensions: ['bin', 'hex'],
      title: '选择参考固件文件',
    })
    if (!path) return
    onOpenChange(false)
    void compareWith(path)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>比较</DialogTitle>
          <DialogDescription>
            选择一个参考文件，与当前 tab 数据进行逐字节对比（差异字节会高亮）
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-0.5 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <div>左侧：当前 tab 的数据</div>
            <div>右侧：选中的参考文件</div>
            <div>两侧滚动会同步，差异字节自动标红</div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSelectFile}>选择文件...</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}