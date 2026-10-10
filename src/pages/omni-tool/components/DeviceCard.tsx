import { Usb, Plug, Unplug } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { HoverScrollText } from '@/components/HoverScrollText'
import { omniPersonalityBadge, type OmniDevice } from '../service'

interface Props {
  device: OmniDevice
  active: boolean
  disabled: boolean
  onConnect: () => void
  onDisconnect: () => void
}

export function DeviceCard({ device, active, disabled, onConnect, onDisconnect }: Props) {
  const vidPid =
    device.vid != null && device.pid != null
      ? `VID ${device.vid.toString(16).toUpperCase().padStart(4, '0')} · PID ${device.pid
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}`
      : 'VID/PID 未知'

  // 显示方式：OMNI Tool + 序列号 + 人格徽章（序列号过长时 hover 滚动）
  const title = `OMNI Tool ${device.serial_number ?? device.port}`
  const badgeVariant = device.personality === 'app' ? 'secondary' : 'outline'

  return (
    <div
      className={cn(
        'rounded-md border p-3 transition-colors',
        active ? 'border-primary bg-accent' : 'border-border hover:bg-accent/50'
      )}
    >
      <div className="flex items-start gap-2">
        <Usb className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <HoverScrollText text={title} className="min-w-0 flex-1 font-medium" />
            <Badge variant={badgeVariant} className="shrink-0">
              {omniPersonalityBadge[device.personality]}
            </Badge>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {device.port} · {vidPid}
          </div>
        </div>
        <Button
          size="sm"
          variant={active ? 'secondary' : 'outline'}
          disabled={disabled}
          onClick={active ? onDisconnect : onConnect}
        >
          {active ? (
            <>
              <Unplug className="mr-1 size-3.5" />
              断开
            </>
          ) : (
            <>
              <Plug className="mr-1 size-3.5" />
              连接
            </>
          )}
        </Button>
      </div>
    </div>
  )
}