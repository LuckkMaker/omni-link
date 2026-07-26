import { useState } from 'react'
import { Trash2, ChevronRight, ChevronDown, Eye, EyeOff } from 'lucide-react'
import { useMonitorStore, type ArrayGroup } from '@/stores/monitor.store'
import { useNotificationStore } from '@/stores/notification.store'
import { monitorService } from '@/services/monitor.service'
import { cn } from '@/lib/utils'

/** 触发方式选项（与 ChannelConfig.triggerMode 对齐） */
const TRIGGER_MODES: { value: 'none' | 'rising' | 'falling' | 'level'; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'rising', label: '上升沿' },
  { value: 'falling', label: '下降沿' },
  { value: 'level', label: '电平' },
]

/** Y 轴分辨率选项（1-2-5 序列，上限为 uint32_t 最大值 4294967295） */
const Y_RESOLUTION_OPTIONS: { value: number; label: string }[] = (() => {
  const opts: { value: number; label: string }[] = []
  const UINT32_MAX = 4294967295
  const mantissas = [1, 2, 5]
  for (let exp = 0; ; exp++) {
    const base = Math.pow(10, exp)
    let done = false
    for (const m of mantissas) {
      const v = m * base
      if (v > UINT32_MAX) { done = true; break }
      // 格式化标签：k/M/G 后缀
      let label: string
      if (v >= 1e9) label = `${v / 1e9}G`
      else if (v >= 1e6) label = `${v / 1e6}M`
      else if (v >= 1e3) label = `${v / 1e3}k`
      else label = `${v}`
      opts.push({ value: v, label: `${label}/div` })
    }
    if (done) break
  }
  return opts
})()

interface Props {
  uid: string | null
  /** 收起 Watch 面板（高度置 0，露出全部波形图） */
  onCollapse?: () => void
}

/**
 * Watch 监视面板
 *
 * 表头：Color | Name | Address | Size | Type | Value | Min | Max | Moving Avg | Y Resolution | 展开 | 操作
 * 其中 Min/Max/Moving Average/Y Resolution 属通道显示配置（ChannelConfig）。
 * Y 偏移/Y 缩放/触发 放在每行的"展开二级区"中，避免列过多导致横向滚动。
 */
export function WatchPanel({ uid, onCollapse }: Props) {
  const variables = useMonitorStore((s) => s.variables)
  const channels = useMonitorStore((s) => s.channels)
  const samples = useMonitorStore((s) => s.samples)
  const running = useMonitorStore((s) => s.running)
  const removeVariable = useMonitorStore((s) => s.removeVariable)
  const addVariable = useMonitorStore((s) => s.addVariable)
  const setChannel = useMonitorStore((s) => s.setChannel)
  const arrayGroups = useMonitorStore((s) => s.arrayGroups)
  const expandArrayGroup = useMonitorStore((s) => s.expandArrayGroup)
  const collapseArrayGroup = useMonitorStore((s) => s.collapseArrayGroup)
  const removeArrayGroup = useMonitorStore((s) => s.removeArrayGroup)
  const pushNotification = useNotificationStore((s) => s.push)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  /** 展开二级配置区的通道 id 集合 */
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const toggleExpand = (id: string) => setExpandedRows((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  // 取最新值
  const lastSample = samples[samples.length - 1]
  const lastValues = new Map<string, number | null>()
  if (lastSample) {
    for (const v of lastSample.values) lastValues.set(v.id, v.value)
  }
  const prevValues = new Map<string, number | null>()
  const prev = samples[samples.length - 2]
  if (prev) {
    for (const v of prev.values) prevValues.set(v.id, v.value)
  }

  const handleRemove = async (id: string) => {
    if (!uid) return
    // 检查是否是数组组的首元素：移除首元素 = 移除整个数组组
    const group = arrayGroups.find((g) => g.firstElemId === id)
    if (group) {
      const toRemove = variables.filter((v) => v.name.startsWith(`${group.baseName}[`))
      for (const v of toRemove) {
        removeVariable(v.id)
        try {
          await monitorService.removeVariable(uid, v.id)
        } catch (e) {
          const status = (e as { response?: { status?: number } })?.response?.status
          if (status === 404) continue
        }
      }
      removeArrayGroup(group.baseName)
      return
    }
    // 普通变量移除（乐观更新，404 静默）
    removeVariable(id)
    try {
      await monitorService.removeVariable(uid, id)
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status
      const msg = e instanceof Error ? e.message : String(e)
      if (status !== 404 && !/404|not found/i.test(msg)) {
        pushNotification({
          type: 'error', title: '移除失败',
          message: msg,
          autoClose: true, autoCloseDelay: 3000,
        })
      }
    }
  }

  /** 展开数组分组：添加 1..N-1 元素到监视 */
  const handleExpandArray = async (group: ArrayGroup) => {
    if (!uid) return
    const newIds: string[] = []
    for (let i = 1; i < group.elemCount; i++) {
      try {
        const res = await monitorService.addVariable(uid, {
          name: group.baseName, address: group.baseAddress, type: group.elemType, elem_index: i,
        })
        if (res.success) {
          addVariable(res.variable)
          newIds.push(res.variable.id)
        }
      } catch { /* ignore */ }
    }
    expandArrayGroup(group.baseName, newIds)
  }

  /** 收起数组分组：移除非首元素（保留 elem_index=0） */
  const handleCollapseArray = async (group: ArrayGroup) => {
    if (!uid) return
    const prefix = `${group.baseName}[`
    const toRemove = variables.filter((v) => {
      if (!v.name.startsWith(prefix)) return false
      const idx = parseInt(v.name.slice(prefix.length, v.name.length - 1))
      return idx > 0
    })
    for (const v of toRemove) {
      removeVariable(v.id)
      try {
        await monitorService.removeVariable(uid, v.id)
      } catch (e) {
        const status = (e as { response?: { status?: number } })?.response?.status
        if (status === 404) continue
      }
    }
    collapseArrayGroup(group.baseName)
  }

  const handleWriteValue = async (id: string) => {
    if (!uid) return
    const val = parseInt(editValue, editValue.startsWith('0x') ? 16 : 10)
    if (isNaN(val)) {
      pushNotification({
        type: 'warning', title: '无效的值', message: '请输入十进制或 0x 前缀的十六进制',
        autoClose: true, autoCloseDelay: 3000,
      })
      return
    }
    try {
      await monitorService.writeVariable(uid, id, val)
      setEditingId(null)
    } catch (e) {
      pushNotification({
        type: 'error', title: '写入失败',
        message: e instanceof Error ? e.message : String(e),
        autoClose: true, autoCloseDelay: 3000,
      })
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 标题栏 + 收起按钮 */}
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-2 py-1">
        <span className="text-xs font-medium">Watch 监视面板</span>
        {onCollapse && (
          <button
            className="text-muted-foreground hover:text-foreground text-[10px]"
            onClick={onCollapse}
            title="收起 Watch 面板（向下隐藏，露出波形图）"
          >
            ▼ 收起
          </button>
        )}
      </div>

      {/* 表格（列多，横向滚动） */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-xs whitespace-nowrap">
          <thead className="sticky top-0 z-10 bg-muted/60">
            <tr>
              <th className="border border-border px-1.5 py-1 text-left font-medium w-10">Color</th>
              <th className="border border-border px-2 py-1 text-left font-medium w-32">Name</th>
              <th className="border border-border px-2 py-1 text-left font-medium w-24">Address</th>
              <th className="border border-border px-1.5 py-1 text-center font-medium w-10">Size</th>
              <th className="border border-border px-1.5 py-1 text-left font-medium w-14">Type</th>
              <th className="border border-border px-2 py-1 text-right font-medium w-32">Value</th>
              <th className="border border-border px-1.5 py-1 text-center font-medium w-16">Min</th>
              <th className="border border-border px-1.5 py-1 text-center font-medium w-16">Max</th>
              <th className="border border-border px-1.5 py-1 text-center font-medium w-12">Moving Avg</th>
              <th className="border border-border px-1.5 py-1 text-center font-medium w-16">Y Resolution</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-8">⚙</th>
              <th className="border border-border w-8" />
            </tr>
          </thead>
          <tbody>
            {variables.length === 0 ? (
              <tr>
                <td colSpan={12} className="border border-border px-2 py-4 text-center text-muted-foreground">
                  暂无监视变量
                </td>
              </tr>
            ) : variables.map((v, i) => {
              const val = lastValues.get(v.id)
              const prevVal = prevValues.get(v.id)
              const changed = running && val !== undefined && prevVal !== undefined && val !== prevVal
              const ch = channels.find((c) => c.varId === v.id)
              // 数组分组查找：首元素显示展开按钮，非首元素缩进显示
              const arrGroup = arrayGroups.find((g) => g.firstElemId === v.id)
              const subElemGroup = !arrGroup ? arrayGroups.find((g) => g.elemIds.includes(v.id) && g.firstElemId !== v.id) : null
              return (
                <>
                <tr
                  key={v.id}
                  className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}
                >
                  {/* Color */}
                  <td className="border border-border px-1 py-1 text-center">
                    <input
                      type="color"
                      className="size-4 cursor-pointer rounded border-0 bg-transparent p-0"
                      value={ch?.color ?? '#888888'}
                      onChange={(e) => setChannel(v.id, { color: e.target.value })}
                      title="通道颜色"
                    />
                  </td>
                  {/* Name（数组首元素显示展开/收起按钮，非首元素缩进） */}
                  <td className="border border-border px-2 py-1 truncate max-w-[160px]" title={v.name}>
                    <div className="flex items-center gap-0.5">
                      {arrGroup && (
                        <button
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          onClick={() => arrGroup.expanded ? handleCollapseArray(arrGroup) : handleExpandArray(arrGroup)}
                          title={arrGroup.expanded ? `收起（当前显示全部 ${arrGroup.elemCount} 个元素）` : `展开全部 ${arrGroup.elemCount} 个元素`}
                        >
                          {arrGroup.expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        </button>
                      )}
                      {subElemGroup && <span className="shrink-0 w-3.5" />}
                      <span className={cn('truncate', subElemGroup && 'text-muted-foreground')}>
                        {v.name}
                      </span>
                      {arrGroup && !arrGroup.expanded && (
                        <span className="shrink-0 ml-1 text-[10px] text-muted-foreground">+{arrGroup.elemCount - 1}</span>
                      )}
                    </div>
                  </td>
                  {/* Address */}
                  <td className="border border-border px-2 py-1 font-mono">
                    0x{v.address.toString(16).toUpperCase().padStart(8, '0')}
                  </td>
                  {/* Size */}
                  <td className="border border-border px-1.5 py-1 text-center font-mono">
                    {v.size}
                  </td>
                  {/* Type */}
                  <td className="border border-border px-1.5 py-1 font-mono">
                    {v.type}
                  </td>
                  {/* Value（双击编辑） */}
                  <td
                    className={cn(
                      'border border-border px-2 py-1 text-right font-mono tabular-nums transition-colors overflow-hidden',
                      changed && 'bg-primary/10',
                      editingId === v.id && 'p-0',
                    )}
                    onDoubleClick={() => { setEditingId(v.id); setEditValue('') }}
                    title="双击修改变量值"
                  >
                    {editingId === v.id ? (
                      <input
                        className="w-full bg-background px-2 py-1 text-right font-mono outline-none ring-1 ring-primary"
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleWriteValue(v.id)
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        onBlur={() => setEditingId(null)}
                        placeholder={val?.toString() ?? ''}
                      />
                    ) : val === undefined ? '—' : val === null ? 'N/A' : val}
                  </td>
                  {/* Min（null=自适应） */}
                  <td className="border border-border px-1 py-1">
                    <input
                      type="number"
                      className="h-5 w-full bg-transparent text-center font-mono text-[11px] outline-none focus:bg-background focus:ring-1 focus:ring-primary rounded"
                      value={ch?.min ?? ''}
                      onChange={(e) => setChannel(v.id, { min: e.target.value === '' ? null : Number(e.target.value) })}
                      placeholder="自动"
                      title="Y 轴最小值（空=跟随自适应）"
                    />
                  </td>
                  {/* Max（null=自适应） */}
                  <td className="border border-border px-1 py-1">
                    <input
                      type="number"
                      className="h-5 w-full bg-transparent text-center font-mono text-[11px] outline-none focus:bg-background focus:ring-1 focus:ring-primary rounded"
                      value={ch?.max ?? ''}
                      onChange={(e) => setChannel(v.id, { max: e.target.value === '' ? null : Number(e.target.value) })}
                      placeholder="自动"
                      title="Y 轴最大值（空=跟随自适应）"
                    />
                  </td>
                  {/* Moving Average */}
                  <td className="border border-border px-1 py-1 text-center">
                    <input
                      type="checkbox"
                      className="size-3 cursor-pointer"
                      checked={ch?.movingAverage ?? false}
                      onChange={(e) => setChannel(v.id, { movingAverage: e.target.checked })}
                      title="启用滑动平均滤波"
                    />
                  </td>
                  {/* Y Resolution（1-2-5 序列选择，0=自动）*/}
                  <td className="border border-border px-1 py-1">
                    <select
                      className="h-5 w-full bg-transparent text-center font-mono text-[11px] outline-none focus:bg-background focus:ring-1 focus:ring-primary rounded cursor-pointer"
                      value={ch?.yResolution ?? 0}
                      onChange={(e) => setChannel(v.id, { yResolution: Number(e.target.value) })}
                      title="Y 轴分辨率（每格代表的数值，0=自动）"
                    >
                      <option value={0}>自动</option>
                      {Y_RESOLUTION_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </td>
                  {/* 展开二级配置区 */}
                  <td className="border border-border px-1 py-1 text-center">
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => toggleExpand(v.id)}
                      title="展开/收起 通道显示配置（偏移/缩放/触发）"
                    >
                      {expandedRows.has(v.id) ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                  </td>
                  {/* 操作：隐藏/显示 + 移除 */}
                  <td className="border border-border px-1 text-center">
                    <div className="flex items-center justify-center gap-0.5">
                      <button
                        className={cn('hover:text-foreground', ch?.visible === false ? 'text-muted-foreground/50' : 'text-muted-foreground')}
                        onClick={() => setChannel(v.id, { visible: !(ch?.visible ?? true) })}
                        title={ch?.visible === false ? '显示通道' : '隐藏通道'}
                      >
                        {ch?.visible === false ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                      </button>
                      <button
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemove(v.id)}
                        title="移除变量"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </td>
                </tr>
                {/* 展开二级区：Y 偏移 / Y 缩放 / 触发方式 / 触发阈值 */}
                {expandedRows.has(v.id) && (
                  <tr key={`${v.id}-cfg`} className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                    <td colSpan={12} className="border border-border px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <label className="text-muted-foreground" title="Y 轴偏移：波形垂直平移（数值加减）">偏移</label>
                          <input
                            type="number"
                            className="h-5 w-16 rounded border border-border bg-background px-1 text-center font-mono outline-none focus:ring-1 focus:ring-primary"
                            value={ch?.yOffset ?? 0}
                            onChange={(e) => setChannel(v.id, { yOffset: Number(e.target.value) })}
                            step="any"
                            title="Y 轴偏移：波形垂直平移（数值加减）"
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <label className="text-muted-foreground" title="Y 轴缩放：垂直放大倍数（1=原始）">缩放</label>
                          <input
                            type="number"
                            className="h-5 w-16 rounded border border-border bg-background px-1 text-center font-mono outline-none focus:ring-1 focus:ring-primary"
                            value={ch?.yScale ?? 1}
                            onChange={(e) => setChannel(v.id, { yScale: Number(e.target.value) })}
                            step="any"
                            title="Y 轴缩放：垂直放大倍数（1=原始大小）"
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <label className="text-muted-foreground" title="触发方式：信号达到阈值时定格波形">触发</label>
                          <select
                            className="h-5 rounded border border-border bg-background px-1 outline-none focus:ring-1 focus:ring-primary"
                            value={ch?.triggerMode ?? 'none'}
                            onChange={(e) => setChannel(v.id, { triggerMode: e.target.value as 'none' | 'rising' | 'falling' | 'level' })}
                            title="触发方式"
                          >
                            {TRIGGER_MODES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </select>
                          {ch?.triggerMode && ch.triggerMode !== 'none' && (
                            <>
                              <label className="text-muted-foreground">阈值</label>
                              <input
                                type="number"
                                className="h-5 w-18 rounded border border-border bg-background px-1 text-center font-mono outline-none focus:ring-1 focus:ring-primary"
                                value={ch?.triggerLevel ?? 0}
                                onChange={(e) => setChannel(v.id, { triggerLevel: Number(e.target.value) })}
                                step="any"
                                title="触发阈值"
                              />
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>

      {running && (
        <div className="border-t border-border bg-muted/20 px-2 py-0.5 text-[10px] text-muted-foreground">
          双击 Value 单元格修改变量值 · {samples.length} 个采样点
        </div>
      )}
    </div>
  )
}
