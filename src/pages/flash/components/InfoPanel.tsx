import { useState } from 'react'
import { Cpu, MemoryStick, ChevronRight, Settings } from 'lucide-react'
import { useProbeStore } from '@/stores/probe.store'
import { useNotificationStore } from '@/stores/notification.store'
import { cn } from '@/lib/utils'
import { formatKb as fmtKb, totalRamKb } from '@/lib/device-utils'
import { FlashConfigDialog } from './FlashConfigDialog'
import { DeviceConfigDialog } from './DeviceConfigDialog'

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-2 py-0.5 text-[11px] leading-tight">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono text-right truncate">{value ?? '-'}</span>
    </div>
  )
}

function CollapsibleSection({
  icon,
  title,
  defaultOpen = false,
  action,
  children,
}: {
  icon: React.ReactNode
  title: string
  defaultOpen?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-border/50 last:border-b-0">
      <div className="flex items-center">
        <button
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-1.5 px-2 py-1.5 hover:bg-muted/30 transition-colors min-w-0"
        >
          <ChevronRight className={cn('size-3 transition-transform shrink-0', open && 'rotate-90')} />
          <span className="text-muted-foreground shrink-0">{icon}</span>
          <span className="text-xs font-medium truncate">{title}</span>
        </button>
        {action}
      </div>
      {open && <div className="px-2 pb-1.5 pl-6">{children}</div>}
    </div>
  )
}

/** 齿轮图标按钮 */
function GearButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 mr-1 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
    >
      <Settings className="size-3" />
    </button>
  )
}

export function InfoPanel() {
  const {
    getSelectedProbe,
    getSelectedTarget,
    getDeviceInfo,
    selectedSectorIndices,
    setSelectedSectorIndices,
  } = useProbeStore()

  const probe = getSelectedProbe()
  const target = getSelectedTarget()
  const isConnected = probe?.state === 'connected'
  const deviceInfo = target ? getDeviceInfo(target.part_number) : undefined

  const [flashConfigOpen, setFlashConfigOpen] = useState(false)
  const [deviceConfigOpen, setDeviceConfigOpen] = useState(false)

  /** 打开设备配置：未连接时提示，不弹窗 */
  const handleDeviceConfig = () => {
    if (!isConnected) {
      useNotificationStore.getState().push({
        type: 'info',
        title: '设备配置',
        message: '请先连接芯片后再查看设备配置',
        autoClose: true,
        autoCloseDelay: 3000,
      })
      return
    }
    setDeviceConfigOpen(true)
  }

  return (
    <div className="overflow-y-auto">
      <CollapsibleSection
        icon={<Cpu className="size-3" />}
        title="设备信息"
        defaultOpen
        action={
          <GearButton
            onClick={handleDeviceConfig}
            title="设备配置"
          />
        }
      >
        <Row label="厂商" value={deviceInfo?.vendor} />
        <Row label="设备" value={deviceInfo?.display_name ?? target?.part_number} />
        <Row label="内核" value={deviceInfo?.core ?? target?.core} />
        <Row label="大小端" value={target?.endian ?? 'Little'} />
        <Row label="Core ID" value={target?.core_id} />
        <Row label="Device ID" value={target?.device_id} />
        <Row label="Revision ID" value={target?.revision_id} />
        {/* RAM：优先用运行时 ram_regions，否则回退 deviceInfo 静态数据 */}
        {(() => {
          // 运行时多 RAM 区域
          if (target?.ram_regions && target.ram_regions.length > 0) {
            const regions = target.ram_regions
            const total = regions.reduce((s, r) => s + r.length, 0)
            if (regions.length === 1) {
              return <Row label="RAM" value={`${formatSize(total)} (${formatHex(regions[0].start)})`} />
            }
            return (
              <>
                <Row label="RAM (总计)" value={`${formatSize(total)} · ${regions.length} 区域`} />
                {regions.map((r, i) => (
                  <Row
                    key={i}
                    label={`  RAM${i + 1}${r.is_default ? ' ·默认' : ''}`}
                    value={`${formatSize(r.length)} (${formatHex(r.start)})`}
                  />
                ))}
              </>
            )
          }
          // 静态 deviceInfo 多 RAM 区域
          if (deviceInfo?.ram_regions && deviceInfo.ram_regions.length > 0) {
            const regions = deviceInfo.ram_regions
            const totalKb = totalRamKb(regions, deviceInfo.ram_size)
            if (regions.length === 1) {
              return <Row label="RAM" value={`${fmtKb(totalKb)} (${regions[0].start})`} />
            }
            return (
              <>
                <Row label="RAM (总计)" value={`${fmtKb(totalKb)} · ${regions.length} 区域`} />
                {regions.map((r, i) => {
                  const bytes = parseInt(r.length, 16) || 0
                  return (
                    <Row
                      key={i}
                      label={`  RAM${i + 1}${r.is_default ? ' ·默认' : ''}`}
                      value={`${formatSize(bytes)} (${r.start})`}
                    />
                  )
                })}
              </>
            )
          }
          // 回退：单 RAM
          return <Row label="RAM" value={deviceInfo ? `${fmtKb(deviceInfo.ram_size)} (${deviceInfo.ram_base_address})` : null} />
        })()}
      </CollapsibleSection>

      <CollapsibleSection
        icon={<MemoryStick className="size-3" />}
        title="Flash 信息"
        action={
          <GearButton
            onClick={() => setFlashConfigOpen(true)}
            title="Flash 配置"
          />
        }
      >
        <Row label="Bank" value="Bank 1" />
        <Row label="基地址" value={target ? formatHex(target.flash_start) : (deviceInfo?.flash_base_address ?? null)} />
        <Row label="大小" value={target ? formatSize(target.flash_size) : (deviceInfo ? fmtKb(deviceInfo.flash_size) : null)} />
      </CollapsibleSection>

      <FlashConfigDialog
        open={flashConfigOpen}
        onOpenChange={setFlashConfigOpen}
        target={target}
        deviceInfo={deviceInfo}
        selectedSectors={selectedSectorIndices}
        onConfirm={(sectors) => setSelectedSectorIndices(sectors)}
      />

      <DeviceConfigDialog
        open={deviceConfigOpen}
        onOpenChange={setDeviceConfigOpen}
        target={target}
        deviceInfo={deviceInfo}
      />
    </div>
  )
}
