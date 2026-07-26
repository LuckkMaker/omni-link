import { useEffect, useRef, useCallback } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { MonitorVariable, SamplePoint } from '@/services/monitor.service'
import type { ChannelConfig } from '@/stores/monitor.store'
import { TIMEBASE_OPTIONS, findNearestTimebaseIndex, GRID_DIVS } from '../constants'

export interface CursorMeasurement {
  /** 左游标时间（秒） */
  t1: number
  /** 右游标时间（秒） */
  t2: number
  /** 各通道在左右游标处的值 */
  values: { varId: string; name: string; v1: number | null; v2: number | null; delta: number | null }[]
}

interface Props {
  variables: MonitorVariable[]
  channels: ChannelConfig[]
  samples: SamplePoint[]
  follow: boolean
  /** 采样是否暂停（暂停时波形以最后采样值继续向右绘制） */
  paused?: boolean
  /** 时间窗口（秒），Follow 模式下显示最近 N 秒 */
  windowSec?: number
  /** 渲染帧率（FPS），控制波形图重绘频率，默认 30 */
  fps?: number
  className?: string
  /** 游标选择回调（拖选区域后触发） */
  onCursorSelect?: (m: CursorMeasurement | null) => void
  /** 时基变化回调（滚轮缩放时步进时基档位，与 ChannelPanel 下拉联动） */
  onTimebaseChange?: (secPerDiv: number) => void
}

/** 最大渲染点数（超过时做 min/max 降采样保留波形形状） */
const MAX_RENDER_POINTS = 20000
/** Y 轴自适应的边距比例（上下各留 10%） */
const Y_PADDING = 0.1
/** Y 轴 hysteresis：新范围与旧范围重叠超过此比例时不更新，避免频繁跳动 */
const Y_HYSTERESIS = 0.15

/**
 * 相对时间格式化：根据数值大小自动选择 μs/ms/s 单位。
 * 用于 X 轴刻度标签，对标示波器/STM32CubeMonitor 的相对时间显示。
 */
function formatTimeValue(v: number): string {
  const abs = Math.abs(v)
  if (abs === 0) return '0'
  if (abs < 0.001) return `${(v * 1e6).toFixed(0)}μs`
  if (abs < 1) return `${(v * 1e3).toFixed(1)}ms`
  return `${v.toFixed(2)}s`
}

/**
 * 根据时间跨度选择合适的刻度间隔（秒），使刻度线数量约为 5-8 个。
 * 对标示波器 1-2-5 序列时基。
 */
function niceTimeStep(span: number): number {
  if (span <= 0) return 1
  const targetSteps = 6
  const raw = span / targetSteps
  // 1-2-5 序列
  const exp = Math.floor(Math.log10(raw))
  const base = Math.pow(10, exp)
  const mantissa = raw / base
  let step: number
  if (mantissa < 1.5) step = 1 * base
  else if (mantissa < 3.5) step = 2 * base
  else if (mantissa < 7.5) step = 5 * base
  else step = 10 * base
  return step
}

export function WaveformChart({
  variables, channels, samples, follow, paused = false,
  windowSec = 10, fps = 30, className, onCursorSelect, onTimebaseChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const followRef = useRef(follow)
  const pausedRef = useRef(paused)
  const samplesRef = useRef(samples)
  const varsRef = useRef(variables)
  const chansRef = useRef(channels)
  const windowRef = useRef(windowSec)
  const fpsRef = useRef(fps)
  // 暂停起始时间戳（wall-clock），用于计算暂停期间虚拟点的时间推进
  const pauseStartRef = useRef<number | null>(null)
  // Y 轴 hysteresis：记录上次设置的 Y 范围
  const yRangeRef = useRef<{ min: number; max: number } | null>(null)
  // 游标回调 ref（避免重建 uPlot）
  const onCursorRef = useRef(onCursorSelect)
  useEffect(() => { onCursorRef.current = onCursorSelect }, [onCursorSelect])
  // 时基变化回调 ref（避免重建 uPlot）
  const onTimebaseRef = useRef(onTimebaseChange)
  useEffect(() => { onTimebaseRef.current = onTimebaseChange }, [onTimebaseChange])

  // ── 构建可见通道列表（visible=true 的通道）──
  const getVisibleSeries = useCallback(() => {
    const chans = chansRef.current
    const vars = varsRef.current
    return vars
      .filter((v) => {
        const ch = chans.find((c) => c.varId === v.id)
        return ch?.visible ?? true
      })
      .map((v) => ({
        variable: v,
        channel: chans.find((c) => c.varId === v.id)!,
      }))
  }, [])

  // ── 数据转换：samples -> uPlot data 格式 ──
  // 流程：原始对齐 → min/max 降采样(超上限时) → 滑动平均(按通道)
  // 不做去重：重复采样点是真实数据，反映"采样率 > 信号变化率"的采样保持行为。
  // 阶梯锯齿通过 stepped 路径渲染（zero-order hold）正确呈现，而非丢弃数据点。
  const buildPlotData = useCallback(() => {
    const series = getVisibleSeries()
    const pts = samplesRef.current
    if (pts.length === 0 || series.length === 0) {
      return { data: [[] as number[], ...series.map(() => [] as number[])] as uPlot.AlignedData, series }
    }

    const nSer = series.length

    // 1) 提取原始对齐数据：times[i] + rows[i][si]（保留全部采样点，不去重）
    const times: number[] = new Array(pts.length)
    const rows: (number | null)[][] = new Array(pts.length)
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i]
      times[i] = pt.t_ms / 1000
      const row: (number | null)[] = new Array(nSer)
      for (let si = 0; si < nSer; si++) {
        const v = pt.values.find((x) => x.id === series[si].variable.id)
        row[si] = v?.value ?? null
      }
      rows[i] = row
    }

    // 1.5) 暂停时追加虚拟保持点：以最后一个真实采样值，时间按 wall-clock 推进
    //      仅在 Follow 模式下追加 —— Follow 模式需让波形持续向右绘制水平线，
    //      直观反映"采样暂停、值保持"；非 Follow 模式下完全冻结视图，不追加虚拟点。
    if (pausedRef.current && followRef.current && pauseStartRef.current !== null && pts.length > 0) {
      const lastPt = pts[pts.length - 1]
      const lastRealTime = lastPt.t_ms / 1000
      const elapsedPause = (Date.now() - pauseStartRef.current) / 1000
      const virtualTime = lastRealTime + elapsedPause
      times.push(virtualTime)
      const row: (number | null)[] = new Array(nSer)
      for (let si = 0; si < nSer; si++) {
        const v = lastPt.values.find((x) => x.id === series[si].variable.id)
        row[si] = v?.value ?? null
      }
      rows.push(row)
    }

    // 2) min/max 降采样：点数超过上限时按桶取 min+max（同一时间戳输出两点，
    //    uPlot 绘制垂直线，保真波形包络，不产生人为折线锯齿）
    let fTimes: number[] = times
    let valArrays: (number | null)[][]
    let downsampled = false
    if (times.length > MAX_RENDER_POINTS) {
      const bucketSize = Math.ceil(times.length / MAX_RENDER_POINTS)
      const ot: number[] = []
      const ov: (number | null)[][] = series.map(() => [])
      for (let b = 0; b < times.length; b += bucketSize) {
        const end = Math.min(b + bucketSize, times.length)
        const tMid = times[Math.min(end - 1, b + ((end - b) >> 1))]
        ot.push(tMid, tMid)
        for (let si = 0; si < nSer; si++) {
          let min: number | null = null
          let max: number | null = null
          for (let j = b; j < end; j++) {
            const v = rows[j][si]
            if (v === null || typeof v !== 'number') continue
            if (min === null || v < min) min = v
            if (max === null || v > max) max = v
          }
          ov[si].push(min, max)
        }
      }
      fTimes = ot
      valArrays = ov
      downsampled = true
    } else {
      // 未降采样：rows 是 [pointIdx][seriesIdx]，转置为 [seriesIdx][pointIdx]
      valArrays = series.map((_, si) => rows.map((r) => r[si]))
    }

    // 3) 滑动平均（按通道窗口大小）：对 movingAverage > 0 的通道做居中窗口平均，
    //    平滑噪声。null 值跳过（不参与平均，保持 null）。
    //    降采样后的数据已为包络极值，不再做平均。
    if (!downsampled) {
      const anyMA = series.some((s) => (s.channel.movingAverage ?? 0) > 0)
      if (anyMA) {
        for (let si = 0; si < nSer; si++) {
          const w = series[si].channel.movingAverage ?? 0
          if (!w || w < 1) continue
          const half = Math.floor(w / 2)
          const src = valArrays[si]
          const out: (number | null)[] = new Array(src.length)
          for (let i = 0; i < src.length; i++) {
            let sum = 0, cnt = 0
            for (let k = -half; k <= half; k++) {
              const idx = i + k
              if (idx < 0 || idx >= src.length) continue
              const v = src[idx]
              if (v !== null && typeof v === 'number') { sum += v; cnt++ }
            }
            out[i] = cnt > 0 ? sum / cnt : src[i]
          }
          valArrays[si] = out
        }
      }
    }

    return {
      data: [fTimes, ...valArrays] as uPlot.AlignedData,
      series,
    }
  }, [getVisibleSeries])

  // ── 实际渲染 ──
  const doRender = useCallback(() => {
    const plot = plotRef.current
    if (!plot) return

    const { data, series } = buildPlotData()
    if (data[0].length === 0) return

    plot.setData(data)

    // Y 轴自适应辅助：根据可见 X 范围计算并设置 Y 量程
    // 优先使用用户设定的固定量程（min/max），否则自适应数据范围
    const autoFitY = (xMin: number, xMax: number) => {
      const hasFixedRange = series.some((s) => s.channel.min !== null || s.channel.max !== null)
      if (hasFixedRange) {
        // 固定量程模式：取各通道 min/max 的并集
        let fixedMin = Infinity
        let fixedMax = -Infinity
        for (const s of series) {
          if (s.channel.min !== null) fixedMin = Math.min(fixedMin, s.channel.min)
          if (s.channel.max !== null) fixedMax = Math.max(fixedMax, s.channel.max)
        }
        // 若只设了一端，另一端用数据补
        if (fixedMin === Infinity || fixedMax === -Infinity) {
          let yMin = Infinity, yMax = -Infinity
          for (let i = 0; i < data[0].length; i++) {
            const t = data[0][i] as number
            if (t < xMin || t > xMax) continue
            for (let si = 0; si < series.length; si++) {
              const v = data[si + 1][i]
              if (v !== null && typeof v === 'number') {
                if (v < yMin) yMin = v
                if (v > yMax) yMax = v
              }
            }
          }
          if (fixedMin === Infinity) fixedMin = yMin
          if (fixedMax === -Infinity) fixedMax = yMax
        }
        if (fixedMin !== Infinity && fixedMax !== -Infinity) {
          const range = fixedMax - fixedMin || 1
          const paddedMin = fixedMin - range * Y_PADDING
          const paddedMax = fixedMax + range * Y_PADDING
          yRangeRef.current = { min: paddedMin, max: paddedMax }
          plot.setScale('y', { min: paddedMin, max: paddedMax })
        }
      } else {
        // 自适应模式：计算窗口内可见通道数据的 min/max
        let yMin = Infinity
        let yMax = -Infinity
        for (let i = 0; i < data[0].length; i++) {
          const t = data[0][i] as number
          if (t < xMin || t > xMax) continue
          for (let si = 0; si < series.length; si++) {
            const v = data[si + 1][i]
            if (v !== null && typeof v === 'number') {
              if (v < yMin) yMin = v
              if (v > yMax) yMax = v
            }
          }
        }

        if (yMin !== Infinity && yMax !== -Infinity) {
          const range = yMax - yMin || 1
          const paddedMin = yMin - range * Y_PADDING
          const paddedMax = yMax + range * Y_PADDING

          // Hysteresis：新范围在旧范围内且变化不大时不更新，避免频繁跳动
          const prev = yRangeRef.current
          if (prev) {
            const prevRange = prev.max - prev.min
            if (paddedMin >= prev.min + prevRange * Y_HYSTERESIS &&
                paddedMax <= prev.max - prevRange * Y_HYSTERESIS) {
              // 数据在旧范围内，不更新
            } else {
              yRangeRef.current = { min: paddedMin, max: paddedMax }
              plot.setScale('y', { min: paddedMin, max: paddedMax })
            }
          } else {
            yRangeRef.current = { min: paddedMin, max: paddedMax }
            plot.setScale('y', { min: paddedMin, max: paddedMax })
          }
        }
      }
    }

    // Follow 模式：X 轴自动滚动到最新数据 + Y 轴自适应
    if (followRef.current && data[0].length > 0) {
      const lastT = data[0][data[0].length - 1] as number
      // 示波器式时基：窗口宽度 = 时基 × 格数（10 格）
      const win = windowRef.current * GRID_DIVS

      // 触发检测：找第一个启用触发的通道，以其最近触发点作为窗口右边界
      let trigXMax: number | null = null
      for (let si = 0; si < series.length; si++) {
        const ch = series[si].channel
        if (ch.triggerMode === 'none') continue
        const arr = data[si + 1]
        const level = ch.triggerLevel
        for (let i = arr.length - 1; i >= 1; i--) {
          const prev = arr[i - 1]
          const curr = arr[i]
          if (prev === null || curr === null || typeof prev !== 'number' || typeof curr !== 'number') continue
          let hit = false
          if (ch.triggerMode === 'rising' && prev < level && curr >= level) hit = true
          else if (ch.triggerMode === 'falling' && prev > level && curr <= level) hit = true
          else if (ch.triggerMode === 'level' && curr >= level) hit = true
          if (hit) { trigXMax = data[0][i] as number; break }
        }
        if (trigXMax !== null) break
      }

      const xMax = trigXMax !== null ? trigXMax : lastT
      // 相对时间从 0 起算，xMin 钳位到 0，避免显示负时间
      const xMin = Math.max(0, xMax - win)
      plot.setScale('x', { min: xMin, max: xMax })
      autoFitY(xMin, xMax)
    } else {
      // 非 Follow 模式：冻结 X 轴在当前位置，不随新数据自动滚动
      // 仅在首次渲染（无 X scale）时自动 fit 全部数据
      const xScale = plot.scales.x
      const needInit = !xScale || xScale.min === undefined || xScale.max === undefined
      if (needInit && data[0].length > 1) {
        yRangeRef.current = null
        const tMin = data[0][0] as number
        const tMax = data[0][data[0].length - 1] as number
        const tRange = tMax - tMin || 1
        const tPad = tRange * 0.02
        const fitMin = Math.max(0, tMin - tPad)
        const fitMax = tMax + tPad
        plot.setScale('x', { min: fitMin, max: fitMax })
        autoFitY(fitMin, fitMax)
      } else if (xScale && xScale.min !== undefined && xScale.max !== undefined) {
        // Y 轴自适应当前可见窗口内的数据
        autoFitY(xScale.min, xScale.max)
      }
    }
  }, [buildPlotData])

  // ── 渲染调度（按 FPS 节流）──
  const scheduleRender = useCallback(() => {
    if (timerRef.current !== null) return
    const interval = 1000 / Math.max(1, fpsRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      doRender()
    }, interval)
  }, [doRender])

  // 同步 ref（避免重建 uPlot）
  useEffect(() => { followRef.current = follow; dirtyRef.current = true; scheduleRender() }, [follow, scheduleRender])
  useEffect(() => { samplesRef.current = samples; dirtyRef.current = true; scheduleRender() }, [samples, scheduleRender])
  useEffect(() => { varsRef.current = variables; dirtyRef.current = true; scheduleRender() }, [variables, scheduleRender])
  useEffect(() => { chansRef.current = channels; dirtyRef.current = true; scheduleRender() }, [channels, scheduleRender])
  useEffect(() => { windowRef.current = windowSec; dirtyRef.current = true; scheduleRender() }, [windowSec, scheduleRender])
  useEffect(() => { fpsRef.current = fps }, [fps])

  // ── 暂停状态：记录起始时间 ──
  // Follow 模式下持续重绘使虚拟保持点随时间推进（波形向右画水平线）；
  // 非 Follow 模式下完全冻结视图，不持续重绘。
  useEffect(() => {
    pausedRef.current = paused
    if (paused) {
      pauseStartRef.current = Date.now()
      // 仅 Follow 模式下持续重绘（虚拟点推进需要重绘）
      if (followRef.current) {
        const interval = 1000 / Math.max(1, fpsRef.current)
        const id = setInterval(() => {
          dirtyRef.current = true
          scheduleRender()
        }, interval)
        return () => clearInterval(id)
      }
    } else {
      pauseStartRef.current = null
      dirtyRef.current = true
      scheduleRender()
    }
  }, [paused, scheduleRender])

  // ── 创建/重建 uPlot 实例（变量或通道数变化时）──
  useEffect(() => {
    if (!containerRef.current) return

    const series = getVisibleSeries()
    const width = containerRef.current.clientWidth || 600
    const height = containerRef.current.clientHeight || 300

    const opts: uPlot.Options = {
      width,
      height,
      series: [
        {}, // X 轴（时间）
        ...series.map((s) => ({
          label: s.variable.name,
          stroke: s.channel.color,
          width: 1.5,
          // 阶梯路径（zero-order hold）：采样保持式渲染。
          // 采样率高于信号变化率时，重复值显示为水平阶梯而非斜线，
          // 忠实反映 SWD 轮询的真实采样行为，不丢弃任何采样点。
          // align: 1（右对齐）= 值在采样时刻立即变化，符合"读到新值后保持到下次读取"的语义。
          paths: uPlot.paths.stepped!({ align: 1 }),
          points: { show: false },
        })),
      ],
      axes: [
        {
          label: 'Time',
          space: 70,
          // 自定义刻度值格式化：相对时间用 μs/ms/s 显示，不使用 Unix 日期
          values: (_self: uPlot, ticks: number[]) => ticks.map(formatTimeValue),
        },
        {
          label: 'Value',
          space: 50,
        },
      ],
      legend: {
        show: true,
        live: true,
      },
      cursor: {
        drag: { x: true, y: false, setScale: false },
      },
      hooks: {
        setSelect: [(self: uPlot) => {
          const sel = self.select
          if (!sel || sel.width < 2) {
            // 选择区域太小，清除游标
            onCursorRef.current?.(null)
            return
          }
          // 将像素坐标转换为数据坐标
          const t1 = self.posToVal(sel.left, 'x')
          const t2 = self.posToVal(sel.left + sel.width, 'x')
          const visibleSeries = varsRef.current
            .filter((v) => {
              const ch = chansRef.current.find((c) => c.varId === v.id)
              return ch?.visible ?? true
            })
          // 在数据中找到最接近 t1/t2 的采样点
          const pts = samplesRef.current
          const findNearest = (t: number) => {
            if (pts.length === 0) return null
            let best = pts[0]
            let bestDist = Math.abs(best.t_ms / 1000 - t)
            for (let i = 1; i < pts.length; i++) {
              const d = Math.abs(pts[i].t_ms / 1000 - t)
              if (d < bestDist) { best = pts[i]; bestDist = d }
            }
            return best
          }
          const p1 = findNearest(t1)
          const p2 = findNearest(t2)
          const values = visibleSeries.map((v) => {
            const v1 = p1?.values.find((x) => x.id === v.id)?.value ?? null
            const v2 = p2?.values.find((x) => x.id === v.id)?.value ?? null
            const delta = (v1 !== null && v2 !== null) ? v2 - v1 : null
            return { varId: v.id, name: v.name, v1, v2, delta }
          })
          onCursorRef.current?.({ t1, t2, values })
        }],
      },
      scales: {
        x: {
          // time: false — X 轴值为相对秒数（从采样起点计时），
          // 不是 Unix 时间戳。设为 true 会导致 uPlot 按 1970 纪元日期格式化。
          time: false,
        },
      },
    }

    const plot = new uPlot(opts, [[]], containerRef.current)
    plotRef.current = plot

    // ── 鼠标滚轮缩放 ──
    // 默认：步进时基档位（1-2-5 序列），与 ChannelPanel 时基下拉联动
    // 按 Shift：缩放 Y 轴（值），连续缩放
    const onWheel = (e: WheelEvent) => {
      const p = plotRef.current
      if (!p) return
      e.preventDefault()

      if (e.shiftKey) {
        // 缩放 Y 轴，以鼠标 Y 位置为中心（连续缩放）
        const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25
        const yScale = p.scales.y
        if (yScale && yScale.min !== undefined && yScale.max !== undefined) {
          const mouseVal = p.posToVal(e.offsetY, 'y')
          const range = yScale.max - yScale.min
          const newRange = range * zoomFactor
          const ratio = (mouseVal - yScale.min) / range
          const newMin = mouseVal - newRange * ratio
          const newMax = mouseVal + newRange * (1 - ratio)
          p.setScale('y', { min: newMin, max: newMax })
        }
      } else {
        // 步进时基档位（1-2-5 序列），与 ChannelPanel 下拉联动
        // 向上滚（deltaY < 0）→ 减小时基（放大）；向下滚 → 增大时基（缩小）
        const currentSecPerDiv = windowRef.current
        const idx = findNearestTimebaseIndex(currentSecPerDiv)
        const nextIdx = e.deltaY < 0
          ? Math.max(0, idx - 1)   // 放大：走向更小的时基
          : Math.min(TIMEBASE_OPTIONS.length - 1, idx + 1)  // 缩小：走向更大的时基
        if (nextIdx === idx) return // 已到边界
        const newSecPerDiv = TIMEBASE_OPTIONS[nextIdx].value
        // 通知 store 更新时基（ChannelPanel 下拉会同步更新）
        onTimebaseRef.current?.(newSecPerDiv)
        // 立即更新 windowRef，使下一次渲染使用新时基
        windowRef.current = newSecPerDiv

        // 非 Follow 模式：以鼠标位置为中心设置新窗口
        if (!followRef.current) {
          const xScale = p.scales.x
          if (xScale && xScale.min !== undefined && xScale.max !== undefined) {
            const mouseVal = p.posToVal(e.offsetX, 'x')
            const oldRange = xScale.max - xScale.min
            const newRange = newSecPerDiv * GRID_DIVS
            const ratio = (mouseVal - xScale.min) / oldRange
            const newMin = Math.max(0, mouseVal - newRange * ratio)
            const newMax = newMin + newRange
            p.setScale('x', { min: newMin, max: newMax })
          }
        }
        // Follow 模式：doRender 会自动以新时基更新窗口
        dirtyRef.current = true
        scheduleRender()
      }
    }
    const wheelTarget = containerRef.current
    if (wheelTarget) wheelTarget.addEventListener('wheel', onWheel, { passive: false })

    // ResizeObserver 监听容器大小变化
    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        })
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      if (wheelTarget) wheelTarget.removeEventListener('wheel', onWheel)
      resizeObserver.disconnect()
      plot.destroy()
      plotRef.current = null
    }
    // 依赖变量ID列表和通道可见性，变化时重建
    // 注意：windowSec 不在依赖中 —— 时基切换只更新 windowRef 并触发重渲染，
    // 不重建 uPlot 实例，避免波形图闪烁/数据丢失。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    variables.map((v) => v.id).join(','),
    channels.filter((c) => c.visible).map((c) => c.varId).join(','),
    channels.map((c) => c.color).join(','),
  ])

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />
}
