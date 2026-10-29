import type { ReactNode } from 'react'
import { Flame, ShieldCheck, Info } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { useFlasherStore } from '../flasher.store'

/** 配置项行：标题 + 说明 + 开关 */
function ToggleRow({
  icon,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  icon: ReactNode
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {icon}
          <span>{title}</span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}

/**
 * 右侧配置栏（对齐 Commander 页的侧栏用法）。
 *
 * 烧录选项放这里而不是文件 tab 上：它们是**每次烧录的行为**，
 * 不属于某个固件文件，跟着文件 tab 走会让"这个文件用哪套设置"变得含糊。
 */
export function FlasherConfigSidebar() {
  const chipErase = useFlasherStore((s) => s.chipErase)
  const readbackVerify = useFlasherStore((s) => s.readbackVerify)
  const busy = useFlasherStore((s) => s.busy)
  const setChipErase = useFlasherStore((s) => s.setChipErase)
  const setReadbackVerify = useFlasherStore((s) => s.setReadbackVerify)

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-muted/30">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold">烧录配置</h3>
      </div>

      <ToggleRow
        icon={<Flame className="size-3.5 text-muted-foreground" />}
        title="烧录前整片擦除"
        description="先用地址模式走一趟 OPEN → ERASE → CLOSE 清空整片，再写入镜像。耗时可达数十秒。"
        checked={chipErase}
        disabled={busy}
        onChange={setChipErase}
      />

      <Separator />

      <ToggleRow
        icon={<ShieldCheck className="size-3.5 text-muted-foreground" />}
        title="写后回读校验"
        description="写完并 CLOSE 后重新 OPEN 再次 halt 目标，逐段回读比对。耗时约为写入的 0.6 倍。"
        checked={readbackVerify}
        disabled={busy}
        onChange={setReadbackVerify}
      />

      <Separator />

      <div className="px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Info className="size-3.5 text-muted-foreground" />
          <span>说明</span>
        </div>
        <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
          <li>
            关掉整片擦除时，扇区擦除由固件 flash manager 按需完成（跨扇区才擦），速度更快。
          </li>
          <li>
            镜像写入后固件会先校验整镜像 CRC32，不符则报 <code className="font-mono">EBADMSG</code>。
          </li>
          <li>
            回读校验失败不会影响已写入的内容，但会明确报出首个不一致位置。
          </li>
        </ul>
      </div>
    </div>
  )
}