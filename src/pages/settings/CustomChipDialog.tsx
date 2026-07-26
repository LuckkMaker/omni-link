import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2, FileCode, FolderOpen, Plus, Trash2 } from 'lucide-react'
import { createCustomDevice, extractFlmInfo } from '@/services/device.service'
import { useNotificationStore } from '@/stores/notification.store'
import type { CustomDeviceCreate, DeviceRamRegion } from '@shared/types'

interface CustomChipDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

const CORE_OPTIONS = [
  'Cortex-M0', 'Cortex-M0+', 'Cortex-M1', 'Cortex-M3',
  'Cortex-M4', 'Cortex-M7', 'Cortex-M23', 'Cortex-M33', 'Cortex-M55',
]

interface RamRow {
  start: string
  length_kb: string
  is_default: boolean
}

interface FormState {
  flm_path: string
  part_number: string
  display_name: string
  vendor: string
  core: string
  flash_base_address: string
  flash_size: string
  sector_size: string
  page_size: string
  ram_rows: RamRow[]
}

const EMPTY_FORM: FormState = {
  flm_path: '',
  part_number: '',
  display_name: '',
  vendor: 'Custom',
  core: 'Cortex-M4',
  flash_base_address: '0x08000000',
  flash_size: '256',
  sector_size: '0x400',
  page_size: '0x400',
  ram_rows: [{ start: '0x20000000', length_kb: '64', is_default: true }],
}

/** 把表单中的 RAM 行转换为提交用的 ram_regions */
function ramRowsToRegions(rows: RamRow[]): { ram_regions: DeviceRamRegion[]; ram_base: string; ram_size_kb: number } {
  const ram_regions: DeviceRamRegion[] = []
  let ram_base = '0x20000000'
  let ram_size_kb = 0
  let defaultSet = false
  for (const row of rows) {
    if (!row.start || !row.length_kb) continue
    const kb = parseInt(row.length_kb) || 0
    const bytes = kb * 1024
    const isDefault = row.is_default && !defaultSet ? true : false
    ram_regions.push({
      start: row.start,
      length: `0x${bytes.toString(16).toUpperCase()}`,
      is_default: isDefault,
    })
    if (isDefault) {
      ram_base = row.start
      ram_size_kb = kb
      defaultSet = true
    }
  }
  // 若无 default，取第一个
  if (!defaultSet && ram_regions.length > 0) {
    ram_regions[0].is_default = true
    ram_base = ram_regions[0].start
    ram_size_kb = parseInt(rows[0]?.length_kb || '0') || 0
  }
  return { ram_regions, ram_base, ram_size_kb }
}

export function CustomChipDialog({ open, onOpenChange, onSuccess }: CustomChipDialogProps) {
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM })
  const [creating, setCreating] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const notify = useNotificationStore((s) => s.push)

  const update = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleSelectFlm = async () => {
    const path = await window.electron.openFileDialog({ extensions: ['FLM'], title: '选择 FLM Flash 算法文件' })
    if (!path) return
    update('flm_path', path)

    // 自动提取参数
    setExtracting(true)
    try {
      const info = await extractFlmInfo(path)
      if (info.flash_base) update('flash_base_address', info.flash_base as string)
      if (info.flash_size) update('flash_size', String(info.flash_size))
      if (info.page_size) update('page_size', info.page_size as string)
    } catch {
      // 提取失败不致命
    } finally {
      setExtracting(false)
    }
  }

  // ── RAM 行操作 ──
  const addRamRow = () => {
    setForm((prev) => ({
      ...prev,
      ram_rows: [...prev.ram_rows, { start: '0x20000000', length_kb: '32', is_default: false }],
    }))
  }
  const removeRamRow = (idx: number) => {
    setForm((prev) => {
      const next = prev.ram_rows.filter((_, i) => i !== idx)
      // 若删掉的是默认行，把第一行设为默认
      if (next.length > 0 && !next.some((r) => r.is_default)) {
        next[0].is_default = true
      }
      return { ...prev, ram_rows: next.length > 0 ? next : [{ start: '0x20000000', length_kb: '32', is_default: true }] }
    })
  }
  const updateRamRow = (idx: number, patch: Partial<RamRow>) => {
    setForm((prev) => {
      const next = prev.ram_rows.map((r, i) => {
        if (i !== idx) return r
        const updated = { ...r, ...patch }
        // 设为默认时，取消其他行的默认
        if (patch.is_default === true) {
          return updated
        }
        return updated
      })
      // 若 patch.is_default === true，取消其他行
      if (patch.is_default === true) {
        next.forEach((r, i) => {
          if (i !== idx) r.is_default = false
        })
      }
      return { ...prev, ram_rows: next }
    })
  }

  const handleSubmit = async () => {
    if (!form.flm_path) { notify({ type: 'warning', title: '请先选择 FLM 文件' }); return }
    if (!form.part_number) { notify({ type: 'warning', title: '请输入芯片型号' }); return }

    setCreating(true)
    try {
      const { ram_regions, ram_base, ram_size_kb } = ramRowsToRegions(form.ram_rows)
      const req: CustomDeviceCreate = {
        flm_path: form.flm_path,
        part_number: form.part_number,
        core: form.core,
        flash_base_address: form.flash_base_address,
        flash_size: parseInt(form.flash_size) || 0,
        ram_base_address: ram_base,
        ram_size: ram_size_kb,
        vendor: form.vendor,
        display_name: form.display_name || form.part_number,
        ram_regions,
      }
      await createCustomDevice(req)
      notify({ type: 'success', title: `自定义芯片 ${form.part_number} 创建成功` })
      setForm({ ...EMPTY_FORM, ram_rows: [...EMPTY_FORM.ram_rows] })
      onOpenChange(false)
      onSuccess()
    } catch (e) {
      notify({ type: 'error', title: '创建自定义芯片失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setCreating(false)
    }
  }

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      // 关闭时重置表单
      setForm({ ...EMPTY_FORM, ram_rows: [...EMPTY_FORM.ram_rows] })
    }
    onOpenChange(v)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCode className="size-4" />
            添加自定义芯片
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2 max-h-[70vh] overflow-y-auto pr-1">
          {/* FLM 文件选择 */}
          <div className="space-y-1.5">
            <Label>FLM Flash 算法文件</Label>
            <div className="flex items-center gap-2">
              <Input
                value={form.flm_path}
                placeholder="选择 .FLM 文件..."
                className="font-mono text-xs"
                readOnly
              />
              <Button variant="outline" size="sm" onClick={handleSelectFlm} disabled={extracting}>
                {extracting ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
                选择文件
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              FLM 文件包含 Flash 擦除/编程算法，可从芯片厂商获取或从 CMSIS-Pack 中提取
            </p>
          </div>

          {/* 基本信息分组 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>芯片型号 <span className="text-red-500">*</span></Label>
              <Input
                value={form.part_number}
                onChange={(e) => update('part_number', e.target.value)}
                placeholder="my-custom-mcu"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label>显示名称</Label>
              <Input
                value={form.display_name}
                onChange={(e) => update('display_name', e.target.value)}
                placeholder="留空则使用型号"
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label>厂商</Label>
              <Input
                value={form.vendor}
                onChange={(e) => update('vendor', e.target.value)}
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label>内核</Label>
              <Select value={form.core} onValueChange={(v) => update('core', v)}>
                <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CORE_OPTIONS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Flash 区域分组 */}
          <div className="rounded-md border border-border p-3 space-y-3">
            <p className="text-xs font-medium text-muted-foreground">Flash 区域</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">基地址</Label>
                <Input
                  value={form.flash_base_address}
                  onChange={(e) => update('flash_base_address', e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">大小 (KB)</Label>
                <Input
                  type="number"
                  value={form.flash_size}
                  onChange={(e) => update('flash_size', e.target.value)}
                  className="text-xs tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">扇区大小 (hex)</Label>
                <Input
                  value={form.sector_size}
                  onChange={(e) => update('sector_size', e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">页大小 (hex)</Label>
                <Input
                  value={form.page_size}
                  onChange={(e) => update('page_size', e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </div>

          {/* RAM 区域分组（支持多个） */}
          <div className="rounded-md border border-border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">RAM 区域</p>
              <Button variant="ghost" size="sm" onClick={addRamRow} className="h-6 px-2 text-xs">
                <Plus className="size-3 mr-1" />
                添加
              </Button>
            </div>
            {form.ram_rows.map((row, idx) => (
              <div key={idx} className="flex items-end gap-2">
                <div className="space-y-1.5 flex-1">
                  <Label className="text-xs">基地址 {idx + 1}</Label>
                  <Input
                    value={row.start}
                    onChange={(e) => updateRamRow(idx, { start: e.target.value })}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5 w-24">
                  <Label className="text-xs">大小 (KB)</Label>
                  <Input
                    type="number"
                    value={row.length_kb}
                    onChange={(e) => updateRamRow(idx, { length_kb: e.target.value })}
                    className="text-xs tabular-nums"
                  />
                </div>
                <label className="flex items-center gap-1 text-xs text-muted-foreground pb-2 whitespace-nowrap cursor-pointer">
                  <input
                    type="radio"
                    checked={row.is_default}
                    onChange={() => updateRamRow(idx, { is_default: true })}
                    className="size-3"
                  />
                  默认
                </label>
                {form.ram_rows.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRamRow(idx)}
                    className="h-8 px-2 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              一个芯片可能有多个 RAM 区域（如 SRAM + CCM），标记为「默认」的区域将作为主 RAM
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>取消</Button>
          <Button onClick={handleSubmit} disabled={creating}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : null}
            添加芯片
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
