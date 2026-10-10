import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { OmniLogLine } from '../store'

const LEVEL_CLASS: Record<string, string> = {
  info: 'text-muted-foreground',
  success: 'text-green-600',
  error: 'text-destructive',
}

export function OperationLog({
  logs,
  onClear,
}: {
  logs: OmniLogLine[]
  onClear: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium">操作日志</span>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={logs.length === 0}>
          <Trash2 className="mr-1 size-3.5" />
          清空
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs leading-relaxed">
        {logs.length === 0 ? (
          <div className="p-1 text-muted-foreground">—</div>
        ) : (
          logs.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap break-all', LEVEL_CLASS[l.level])}>
              <span className="text-muted-foreground/60">[{l.time}] </span>
              {l.message}
            </div>
          ))
        )}
      </div>
    </div>
  )
}