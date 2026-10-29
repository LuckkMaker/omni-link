import { Eraser, Download, ShieldCheck, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { useFlashStore } from '@/stores/flash.store'
import { cn } from '@/lib/utils'

function formatSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const phaseConfig = {
  idle: { label: '待机', icon: null, color: 'text-muted-foreground' },
  erasing: { label: '擦除中', icon: Eraser, color: 'text-orange-500' },
  programming: { label: '编程中', icon: Download, color: 'text-blue-500' },
  verifying: { label: '校验中', icon: ShieldCheck, color: 'text-purple-500' },
  reading: { label: '读取中', icon: Download, color: 'text-cyan-500' },
  done: { label: '完成', icon: CheckCircle2, color: 'text-green-500' },
  error: { label: '错误', icon: XCircle, color: 'text-red-500' },
} as const

export function FlashProgress() {
  const { phase, progress, progressCurrent, progressTotal, progressUnit, busy, result } = useFlashStore()
  const config = phaseConfig[phase]
  const Icon = config.icon

  // 不在操作中且无结果时不显示
  if (phase === 'idle' && !result) return null

  // 根据 unit 格式化进度文本
  let progressDetail = ''
  if (progressTotal > 0) {
    if (progressUnit === 'bytes') {
      progressDetail = `${formatSize(progressCurrent)} / ${formatSize(progressTotal)}`
    } else if (progressUnit === 'sectors') {
      progressDetail = `${progressCurrent} / ${progressTotal} 扇区`
    }
    // operations: 只显示百分比，不显示数量
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {Icon && busy ? (
              <Loader2 className={cn('size-5 animate-spin', config.color)} />
            ) : Icon ? (
              <Icon className={cn('size-5', config.color)} />
            ) : null}
            <CardTitle>进度</CardTitle>
          </div>
          {phase !== 'idle' && (
            <Badge variant={phase === 'done' ? 'default' : phase === 'error' ? 'destructive' : 'secondary'}>
              {config.label}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 进度条 */}
        {busy && (
          <>
            <Progress value={progress} className="h-2.5" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {config.label}... {progress.toFixed(1)}%
              </span>
              {progressTotal > 0 && progressDetail && (
                <span className="tabular-nums text-muted-foreground">
                  {progressDetail}
                </span>
              )}
            </div>
          </>
        )}

        {/* 结果 */}
        {result && (
          <div className={cn(
            'rounded-md border p-3 text-sm',
            result.success ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'
          )}>
            {result.success ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium text-green-600">
                  <CheckCircle2 className="size-4" />
                  烧录成功
                </div>
                <div className="text-xs text-muted-foreground">
                  写入 {formatSize(result.bytes_written ?? 0)} · 耗时 {(result.duration_ms / 1000).toFixed(2)}s
                  {(result.bytes_written ?? 0) > 0 && result.duration_ms > 0 && (
                    ` · 速率 ${((result.bytes_written ?? 0) / 1024 / (result.duration_ms / 1000)).toFixed(1)} KB/s`
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 font-medium text-red-600">
                <XCircle className="size-4" />
                {result.error || '操作失败'}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
