import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DeviceTable } from '@/components/DeviceTable'
import type { DeviceInfo } from '@shared/types'

interface TargetDeviceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceList: DeviceInfo[]
  currentPartNumber: string | null
  onConfirm: (partNumber: string) => void
}

export function TargetDeviceDialog({
  open,
  onOpenChange,
  deviceList,
  currentPartNumber,
  onConfirm,
}: TargetDeviceDialogProps) {
  const [selected, setSelected] = useState<string | null>(currentPartNumber)

  const handleConfirm = (partNumber: string) => {
    onConfirm(partNumber)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>选择目标设备</DialogTitle>
        </DialogHeader>

        <DeviceTable
          devices={deviceList}
          selectable
          selectedPartNumber={selected}
          onSelect={setSelected}
          onConfirm={handleConfirm}
          maxHeight="max-h-96"
          showCount={false}
        />

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">双击设备行选中，点击窗口外取消</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
