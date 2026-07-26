import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { previewPack, importPack, getPackDevices, updatePackDevices } from '@/services/pack.service'
import { useNotificationStore } from '@/stores/notification.store'
import { totalRamKb, ramRegionsTooltip } from '@/lib/device-utils'
import type { PackDevice } from '@shared/types'

interface PackDeviceSelectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  /** 导入模式：传入 .pack 文件路径；编辑模式：传入已安装 pack 名称 */
  mode: 'import' | 'edit'
  /** 导入模式=pack 文件路径，编辑模式=pack 名称 */
  target: string
}

function formatSize(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`
  return `${kb} KB`
}

export function PackDeviceSelectDialog({
  open,
  onOpenChange,
  onSuccess,
  mode,
  target,
}: PackDeviceSelectDialogProps) {
  const notify = useNotificationStore((s) => s.push)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [devices, setDevices] = useState<PackDevice[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')

  const loadDevices = useCallback(async () => {
    setLoading(true)
    setSelected(new Set())
    setDevices([])
    try {
      if (mode === 'import') {
        const result = await previewPack(target)
        setDevices(result.devices)
        // 导入模式：默认全选
        setSelected(new Set(result.devices.map((d) => d.part_number)))
      } else {
        const result = await getPackDevices(target)
        setDevices(result.devices)
        // 编辑模式：选中已导入的
        setSelected(new Set(result.devices.filter((d) => d.imported).map((d) => d.part_number)))
      }
    } catch (e) {
      notify({ type: 'error', title: '加载设备列表失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }, [mode, target, notify])

  useEffect(() => {
    if (open && target) {
      loadDevices()
    }
  }, [open, target, loadDevices])

  const toggleDevice = (partNumber: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(partNumber)) {
        next.delete(partNumber)
      } else {
        next.add(partNumber)
      }
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((d) => d.part_number)))
    }
  }

  const filtered = devices.filter(
    (d) =>
      d.display_name.toLowerCase().includes(filter.toLowerCase()) ||
      d.part_number.toLowerCase().includes(filter.toLowerCase()) ||
      d.core.toLowerCase().includes(filter.toLowerCase())
  )

  const handleSubmit = async () => {
    if (selected.size === 0) {
      notify({ type: 'warning', title: '请至少选择一个设备' })
      return
    }
    setSubmitting(true)
    try {
      const selectedParts = Array.from(selected)
      if (mode === 'import') {
        const result = await importPack(target, selectedParts)
        notify({
          type: 'success',
          title: 'Pack 导入成功',
          message: `${result.pack.name} — ${result.device_count} 个设备`,
        })
      } else {
        const result = await updatePackDevices(target, selectedParts)
        const parts = []
        if (result.added.length > 0) parts.push(`新增 ${result.added.length} 个`)
        if (result.removed.length > 0) parts.push(`移除 ${result.removed.length} 个`)
        notify({
          type: 'success',
          title: '设备选择已更新',
          message: parts.length > 0 ? parts.join('，') : '无变更',
        })
      }
      onOpenChange(false)
      onSuccess()
    } catch (e) {
      notify({
        type: 'error',
        title: mode === 'import' ? 'Pack 导入失败' : '更新失败',
        message: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'import' ? '选择要导入的设备' : '编辑 Pack 设备选择'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3 py-2">
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            已选 {selected.size} / {devices.length}
          </span>
          <Button variant="outline" size="sm" onClick={toggleAll} disabled={loading || devices.length === 0}>
            {selected.size === filtered.length && filtered.length > 0 ? '取消全选' : '全选'}
          </Button>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选设备..."
            className="h-8 max-w-xs text-sm"
          />
        </div>

        <div className="max-h-[400px] overflow-auto rounded-md border border-border">
          <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted">
                <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[8%]">选择</th>
                <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[35%]">设备</th>
                <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[20%]">内核</th>
                <th className="border-b border-r border-border px-2 py-2 text-center font-medium w-[18%]">Flash</th>
                <th className="border-b border-border px-2 py-2 text-center font-medium w-[19%]">RAM</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto size-4 animate-spin" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    无匹配设备
                  </td>
                </tr>
              ) : (
                filtered.map((d) => (
                  <tr
                    key={d.part_number}
                    onClick={() => toggleDevice(d.part_number)}
                    className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/30"
                  >
                    <td className="border-r border-border/50 px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(d.part_number)}
                        onCheckedChange={() => toggleDevice(d.part_number)}
                      />
                    </td>
                    <td className="border-r border-border/50 px-3 py-2 text-center font-medium">{d.display_name}</td>
                    <td className="border-r border-border/50 px-3 py-2 text-center text-muted-foreground">{d.core}</td>
                    <td className="border-r border-border/50 px-3 py-2 text-center tabular-nums">{formatSize(d.flash_size)}</td>
                    <td
                      className="px-3 py-2 text-center tabular-nums"
                      title={ramRegionsTooltip(d.ram_regions)}
                    >
                      {formatSize(totalRamKb(d.ram_regions, d.ram_size))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || selected.size === 0}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                处理中...
              </>
            ) : mode === 'import' ? (
              `导入选中的 ${selected.size} 个设备`
            ) : (
              '保存选择'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
