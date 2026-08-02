import { useState, useEffect, useRef } from 'react'
import { Trash2, ChevronRight, ChevronDown, Eye, EyeOff, MoreVertical } from 'lucide-react'
import { useMonitorStore, type ArrayGroup } from '@/stores/monitor.store'
import { useNotificationStore } from '@/stores/notification.store'
import { monitorService, type SamplePoint } from '@/services/monitor.service'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

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

/** 滑动平均窗口选项 */
const MA_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
  { value: 8, label: '8' },
  { value: 16, label: '16' },
  { value: 32, label: '32' },
  { value: 64, label: '64' },
]

/**
 * 计算指定采样点索引处的简单移动平均（SMA）。
 * 居中窗口：以 idx 为中心，取 [idx-half, idx+half] 范围内的非 null 值求平均。
 * 与 WaveformChart.buildPlotData 中的 MA 逻辑保持一致。
 */
function computeSMA(samples: SamplePoint[], varId: string, idx: number, window: number): number | null {
  if (window < 1 || idx < 0 || idx >= samples.length) return null
  const half = Math.floor(window / 2)
  let sum = 0, cnt = 0
  for (let k = -half; k <= half; k++) {
    const i = idx + k
    if (i < 0 || i >= samples.length) continue
    const v = samples[i].values.find((x) => x.id === varId)?.value
    if (v !== null && v !== undefined && typeof v === 'number') { sum += v; cnt++ }
  }
  return cnt > 0 ? sum / cnt : null
}

interface Props {
  uid: string | null
  /** 收起 Watch 面板（高度置 0，露出全部波形图） */
  onCollapse?: () => void
  /** 鼠标游标位置的采样值及索引（JScope 风格：Value/MA 列显示游标位置的值） */
  cursorData?: { values: Map<string, number | null>; sampleIndex: number } | null
}

/**
 * Watch 监视面板
 *
 * 表头：Color | Name | Address | Size | Type | Value | Min | Max | Moving Avg | Y Resolution | 展开 | 操作
 * 其中 Min/Max/Moving Average/Y Resolution 属通道显示配置（ChannelConfig）。
 * Y 偏移/Y 缩放/触发 放在每行的"展开二级区"中，避免列过多导致横向滚动。
 */
export function WatchPanel({ uid, onCollapse, cursorData }: Props) {
  const variables = useMonitorStore((s) => s.variables)
  const channels = useMonitorStore((s) => s.channels)
  // samples 引用稳定（高频可变缓冲），依赖版本号触发重渲染以读取最新数据
  const samplesVersion = useMonitorStore((s) => s.samplesVersion)
  const samples = useMonitorStore((s) => s.samples)
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

  // ── 通道实时统计（当前值/均值/峰峰值，基于全部已采数据，400ms 节流重算）──
  const [chanStats, setChanStats] = useState<Map<string, { cur: number | null; mean: number | null; pp: number | null }>>(new Map())
  const lastStatsAtRef = useRef(0)
  useEffect(() => {
    if (samplesVersion === 0) return
    const now = performance.now()
    if (now - lastStatsAtRef.current < 400) return
    lastStatsAtRef.current = now
    const buf = samples
    if (buf.length === 0) {
      setChanStats(new Map())
      return
    }
    const stats = new Map<string, { cur: number | null; mean: number | null; pp: number | null }>()
    for (const ch of channels) {
      if (!ch.visible) continue
      let sum = 0, cnt = 0
      let min = Infinity, max = -Infinity
      let cur: number | null = null
      for (let i = 0; i < buf.length; i++) {
        const vals = buf[i].values
        let v: number | null = null
        for (let k = 0; k < vals.length; k++) {
          if (vals[k].id === ch.varId) { v = vals[k].value; break }
        }
        if (v === null || typeof v !== 'number') continue
        sum += v; cnt++
        if (v < min) min = v
        if (v > max) max = v
        cur = v
      }
      stats.set(ch.varId, {
        cur,
        mean: cnt > 0 ? sum / cnt : null,
        pp: min !== Infinity && max !== -Infinity ? max - min : null,
      })
    }
    setChanStats(stats)
  }, [samplesVersion, samples, channels])

  // JScope 风格：Value 列只显示游标位置的采样值，不显示实时值
  // 鼠标离开波形图后保留最后游标位置的值（cursorData 不会被重置为 null）
  // 鼠标从未进入波形图时 cursorData 为 null，显示 "—"
  const cursorValues = cursorData?.values ?? null
  const cursorIdx = cursorData?.sampleIndex ?? -1

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

      {/* 通道实时统计（当前值 / 均值 / 峰峰值，基于全部已采数据） */}
      {chanStats.size > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-border px-2 py-1">
          {channels.filter((c) => c.visible).map((ch) => {
            const st = chanStats.get(ch.varId)
            if (!st) return null
            const v = variables.find((x) => x.id === ch.varId)
            return (
              <div
                key={ch.varId}
                className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground"
                title={`${v?.name ?? ch.varId}：当前值 / 均值 / 峰峰值（全部已采数据）`}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: ch.color }} />
                <span className="text-foreground">{v?.name ?? ch.varId}</span>
                <span>{st.cur !== null ? st.cur.toFixed(2) : '--'}</span>
                <span>avg {st.mean !== null ? st.mean.toFixed(2) : '--'}</span>
                <span>pp {st.pp !== null ? st.pp.toFixed(2) : '--'}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* 表格（列多，横向滚动） */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-xs whitespace-nowrap">
          <thead className="sticky top-0 z-10 bg-muted/60">
            <tr>
              <th className="border border-border px-1 py-1 text-center font-medium w-8">Color</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-32">Name</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-24">Address</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-8">Size</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-12">Type</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-24" title="游标位置采样值（鼠标悬停波形图）">
                Value
              </th>
              <th className="border border-border px-1 py-1 text-center font-medium w-14">Min</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-14">Max</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-14">MA</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-16">Y Res</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-36">Trigger</th>
              <th className="border border-border px-1 py-1 text-center font-medium w-10">More</th>
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
              const ch = channels.find((c) => c.varId === v.id)
              // Value 列只显示游标位置的采样值（JScope 风格），不显示实时值
              const val = cursorValues?.get(v.id) ?? null
              const hasCursor = cursorValues !== null
              // MA 值：显示最新采样点处的 SMA（基于全部采样数据，非游标位置）
              const maWindow = ch?.movingAverage ?? 0
              const maVal = maWindow > 0 && samples.length > 0
                ? computeSMA(samples, v.id, samples.length - 1, maWindow)
                : null
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
                  <td className="border border-border px-1 py-1 truncate max-w-[160px]" title={v.name}>
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
                  <td className="border border-border px-1 py-1 font-mono text-center">
                    0x{v.address.toString(16).toUpperCase().padStart(8, '0')}
                  </td>
                  {/* Size */}
                  <td className="border border-border px-1 py-1 text-center font-mono">
                    {v.size}
                  </td>
                  {/* Type */}
                  <td className="border border-border px-1 py-1 font-mono text-center">
                    {v.type}
                  </td>
                  {/* Value（双击编辑；只显示游标位置值，不显示实时值） */}
                  <td
                    className={cn(
                      'border border-border px-1 py-1 text-right font-mono tabular-nums transition-colors overflow-hidden',
                      hasCursor && 'bg-primary/5',
                      editingId === v.id && 'p-0',
                    )}
                    onDoubleClick={() => { setEditingId(v.id); setEditValue('') }}
                    title={hasCursor ? '游标位置值（双击写入新值）' : '鼠标悬停波形图查看值（双击写入新值）'}
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
                    ) : !hasCursor ? '—' : val === null ? 'N/A' : val}
                  </td>
                  {/* Min（null=自适应） */}
                  <td className="border border-border px-0.5 py-1">
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
                  <td className="border border-border px-0.5 py-1">
                    <input
                      type="number"
                      className="h-5 w-full bg-transparent text-center font-mono text-[11px] outline-none focus:bg-background focus:ring-1 focus:ring-primary rounded"
                      value={ch?.max ?? ''}
                      onChange={(e) => setChannel(v.id, { max: e.target.value === '' ? null : Number(e.target.value) })}
                      placeholder="自动"
                      title="Y 轴最大值（空=跟随自适应）"
                    />
                  </td>
                  {/* Moving Average（显示游标位置处的 SMA 计算值；窗口配置在"更多"菜单） */}
                  <td
                    className="border border-border px-1 py-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground"
                    title={maWindow > 0
                      ? `SMA(${maWindow}) 最新滑动平均值（窗口配置在"更多"菜单）`
                      : '滑动平均未开启（在"更多"菜单中配置窗口大小）'}
                  >
                    {maWindow > 0
                      ? (maVal !== null ? maVal.toFixed(2) : '—')
                      : 'Off'}
                  </td>
                  {/* Y Resolution（1-2-5 序列选择，0=自动）*/}
                  <td className="border border-border px-0.5 py-1">
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
                  {/* Trigger Control：选择触发方式，[电平]时显示阈值输入 */}
                  <td className="border border-border px-0.5 py-1">
                    <div className="flex items-center gap-0.5">
                      <select
                        className="h-5 flex-1 min-w-0 bg-transparent text-center font-mono text-[11px] outline-none focus:bg-background focus:ring-1 focus:ring-primary rounded cursor-pointer"
                        value={ch?.triggerMode ?? 'none'}
                        onChange={(e) => setChannel(v.id, { triggerMode: e.target.value as 'none' | 'rising' | 'falling' | 'level' })}
                        title="触发方式"
                      >
                        {TRIGGER_MODES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      {ch?.triggerMode === 'level' && (
                        <input
                          type="number"
                          className="h-5 w-12 rounded border border-border bg-background px-0.5 text-center font-mono text-[11px] outline-none focus:ring-1 focus:ring-primary"
                          value={ch?.triggerLevel ?? 0}
                          onChange={(e) => setChannel(v.id, { triggerLevel: Number(e.target.value) })}
                          step="any"
                          title="触发阈值"
                        />
                      )}
                    </div>
                  </td>
                  {/* 更多操作：MA配置、显示/隐藏、移除 */}
                  <td className="border border-border px-0.5 py-1 text-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="text-muted-foreground hover:text-foreground"
                          title="更多操作"
                        >
                          <MoreVertical className="size-3" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        {/* MA 窗口配置子菜单 */}
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <span className="text-xs">滑动平均 (MA)</span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuRadioGroup
                              value={String(ch?.movingAverage ?? 0)}
                              onValueChange={(val) => setChannel(v.id, { movingAverage: Number(val) })}
                            >
                              {MA_OPTIONS.map((opt) => (
                                <DropdownMenuRadioItem key={opt.value} value={String(opt.value)}>
                                  {opt.label}
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setChannel(v.id, { visible: !(ch?.visible ?? true) })}
                        >
                          {ch?.visible === false ? (
                            <>
                              <Eye className="size-3.5" />
                              <span>显示通道</span>
                            </>
                          ) : (
                            <>
                              <EyeOff className="size-3.5" />
                              <span>隐藏通道</span>
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => handleRemove(v.id)}
                        >
                          <Trash2 className="size-3.5" />
                          <span>移除变量</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
