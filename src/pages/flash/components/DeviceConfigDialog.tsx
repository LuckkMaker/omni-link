/**
 * 设备配置弹窗
 *
 * 参考 J-Link MCU 配置界面，展示目标设备的核心信息。
 * 布局：
 * 1. 目标设备（型号、厂商、内核、大小端、Core ID）
 * 2. 目标 RAM（基地址、大小）
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { TargetInfo, DeviceInfo, RamRegionInfo } from '@shared/types'
import { formatBytes } from '@/lib/device-utils'

interface DeviceConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: TargetInfo | null
  deviceInfo?: DeviceInfo
}

/** 规范化为运行时 RAM 区域列表（优先 target.ram_regions，否则 deviceInfo.ram_regions，最后合成单个） */
function resolveRamRegions(
  target: TargetInfo | null,
  deviceInfo?: DeviceInfo
): { start: number; length: number; is_default: boolean }[] {
  // 运行时 ram_regions
  if (target?.ram_regions && target.ram_regions.length > 0) {
    return target.ram_regions.map((r: RamRegionInfo) => ({
      start: r.start,
      length: r.length,
      is_default: r.is_default,
    }))
  }
  // 静态 deviceInfo.ram_regions
  if (deviceInfo?.ram_regions && deviceInfo.ram_regions.length > 0) {
    return deviceInfo.ram_regions.map((r) => ({
      start: parseInt(r.start, 16) || 0,
      length: parseInt(r.length, 16) || 0,
      is_default: r.is_default,
    }))
  }
  // 回退：合成单个默认区域
  const ramStart = target?.ram_start
    ?? (deviceInfo?.ram_base_address ? parseInt(deviceInfo.ram_base_address, 16) : 0)
  const ramBytes = target?.ram_size
    ?? (deviceInfo ? deviceInfo.ram_size * 1024 : 0)
  return [{ start: ramStart, length: ramBytes, is_default: true }]
}

export function DeviceConfigDialog({ open, onOpenChange, target, deviceInfo }: DeviceConfigDialogProps) {
  const partNumber = target?.part_number ?? deviceInfo?.part_number ?? 'Unknown'
  const displayName = deviceInfo?.display_name ?? partNumber
  const vendor = deviceInfo?.vendor ?? '-'
  // 内核信息：优先从 device_info.json 获取（更具体，如 "Cortex-M4"）
  const core = deviceInfo?.core ?? target?.core ?? '-'
  const endian = target?.endian ?? 'Little'

  // Core ID（仅连接后可用，从 DPIDR 读取）
  const coreId = target?.core_id ?? ''

  // Device ID 和 Revision ID（仅连接后可用，从 DBGMCU_IDCODE 读取）
  const deviceId = target?.device_id ?? ''
  const revisionId = target?.revision_id ?? ''

  const ramRegions = resolveRamRegions(target, deviceInfo)
  const ramTotalBytes = ramRegions.reduce((s, r) => s + r.length, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>设备配置</DialogTitle>
          <DialogDescription>
            目标设备信息和配置
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 目标设备 */}
          <Section title="目标设备">
            <Row label="厂商" value={vendor} />
            <Row label="设备" value={partNumber} mono />
            <Row label="内核" value={core} />
            <Row label="大小端" value={endian === 'Little' ? 'Little Endian' : 'Big Endian'} />
            <Row label="Core ID" value={coreId || '-'} mono />
            <Row label="Device ID" value={deviceId || '-'} mono />
            <Row label="Revision ID" value={revisionId || '-'} mono />
          </Section>

          {/* 目标 RAM */}
          <Section title="目标 RAM">
            {ramRegions.length > 1 && (
              <Row label="总计" value={ramTotalBytes ? formatBytes(ramTotalBytes) : '-'} />
            )}
            {ramRegions.map((r, i) => {
              const addr = `0x${r.start.toString(16).toUpperCase().padStart(8, '0')}`
              const label = ramRegions.length > 1
                ? `RAM${i + 1}${r.is_default ? ' (默认)' : ''}`
                : '基地址'
              return (
                <div key={i}>
                  {ramRegions.length > 1 && (
                    <Row label={label} value={`${addr} · ${formatBytes(r.length)}`} mono />
                  )}
                  {ramRegions.length === 1 && (
                    <>
                      <Row label="基地址" value={addr} mono />
                      <Row label="大小" value={r.length ? formatBytes(r.length) : '-'} />
                    </>
                  )}
                </div>
              )
            })}
          </Section>

          {!target && !deviceInfo && (
            <div className="text-center text-sm text-muted-foreground py-8">
              暂无设备信息，连接仿真器后可加载实时数据
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-muted-foreground mb-1.5">{title}</h4>
      <div className="rounded-md border bg-muted/20 divide-y divide-border/50">
        {children}
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2 px-3 py-1.5 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={mono ? 'font-mono' : ''}>{value}</span>
    </div>
  )
}
