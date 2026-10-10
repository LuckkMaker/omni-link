import { Progress } from '@/components/ui/progress'
import type { OmniProgress } from '../service'

const STAGE_LABEL: Record<string, string> = {
  info: '准备',
  set_addr: '设置地址',
  erase: '擦除',
  download: '下载',
  verify: '回读校验',
  leave: '跳转',
  done: '完成',
}

export function UpgradeProgress({ progress }: { progress: OmniProgress }) {
  const label = STAGE_LABEL[progress.stage] ?? progress.stage
  const pct = Math.max(0, Math.min(100, progress.percent))
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{pct.toFixed(1)}%</span>
      </div>
      <Progress value={pct} />
      <div className="truncate text-xs text-muted-foreground">{progress.message}</div>
    </div>
  )
}