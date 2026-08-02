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
  /** 采样数据版本号：samples 引用稳定（高频可变缓冲），版本号变化驱动重绘 */
  samplesVersion?: number
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
  /** 时基变化回调（滚轮缩放时与 ChannelPanel 下拉联动） */
  onTimebaseChange?: (secPerDiv: number) => void
  /** Follow 模式变化回调（滚轮缩放时自动关闭 Follow） */
  onFollowChange?: (follow: boolean) => void
  /** 鼠标游标值变化回调（JScope 风格：鼠标悬停时推送游标位置的采样值及采样点索引） */
  onCursorValueChange?: (data: { values: Map<string, number | null>; sampleIndex: number } | null) => void
  /** 全览信号：数值递增时缩放显示全部已采数据（关闭 Follow + X 轴覆盖数据首尾 + Y 轴重新自适应） */
  fitSignal?: number
  /** Y 轴自动归一化：开启后每个通道按各自数据范围独立缩放（等价于所有通道都设了 yResolution） */
  yNormalized?: boolean
}

// 降采样由 uPlot decimation 基于可视像素宽度完成（稳定分桶，无索引漂移伪影）
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
  variables, channels, samples, samplesVersion, follow, paused = false,
  windowSec = 10, fps = 30, className, onCursorSelect, onTimebaseChange, onFollowChange, onCursorValueChange,
  fitSignal, yNormalized = false,
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
  // Y 轴 hysteresis：记录上次设置的 Y 范围
  const yRangeRef = useRef<{ min: number; max: number } | null>(null)
  // Y 轴配置变化检测：yResolution/min/max/visible 变化时重置 yRangeRef，强制重新计算 Y 轴
  const prevYConfigRef = useRef<Map<string, { yRes: number; min: number | null; max: number | null; visible: boolean }>>(new Map())
  // 逐通道 Y 归一化参数（示波器模式：每通道独立 Y 量程，共享 0..GRID_DIVS 网格）
  // key = varId, value = { yRes: 每格数值, center: 数据中心 }
  const normParamsRef = useRef<Map<string, { yRes: number; center: number }>>(new Map())
  // 是否处于归一化模式（任意通道设了 yResolution > 0）
  const normalizedRef = useRef(false)
  // 归一化模式下是否需要重置 Y 轴到 0..GRID_DIVS
  const normYResetRef = useRef(true)
  // 游标回调 ref（避免重建 uPlot）
  const onCursorRef = useRef(onCursorSelect)
  useEffect(() => { onCursorRef.current = onCursorSelect }, [onCursorSelect])
  // 时基变化回调 ref（避免重建 uPlot）
  const onTimebaseRef = useRef(onTimebaseChange)
  useEffect(() => { onTimebaseRef.current = onTimebaseChange }, [onTimebaseChange])
  // Follow 变化回调 ref（避免重建 uPlot）
  const onFollowChangeRef = useRef(onFollowChange)
  useEffect(() => { onFollowChangeRef.current = onFollowChange }, [onFollowChange])
  // 游标值变化回调 ref（JScope 风格）
  const onCursorValueRef = useRef(onCursorValueChange)
  useEffect(() => { onCursorValueRef.current = onCursorValueChange }, [onCursorValueChange])
  // Y 轴自动归一化开关 ref（buildPlotData 是 useCallback，需经 ref 读取最新值）
  const yNormRef = useRef(yNormalized)
  useEffect(() => { yNormRef.current = yNormalized }, [yNormalized])
  // 自动归一化判定缓存：多通道量级差异大时自动启用逐通道独立量程。
  // 范围计算全量遍历数据，用 500ms 节流避免每帧重算（60 万点 × 通道数）。
  const autoNormRef = useRef(false)
  const autoNormAtRef = useRef(0)

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
  // 暂停/恢复由后端处理时间间隙（resume 时调整 start_time），前端无需补偿。
  // 不做去重：重复采样点是真实数据，反映"采样率 > 信号变化率"的采样保持行为。
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

    // 1.5) 确保时间戳单调递增（uPlot 要求 X 轴严格递增）
    // 安全网：后端已保证单调性，但暂停/恢复时序不精确可能导致微小回退。
    // uPlot 遇到非递增时间戳会画回头线（如停止后波形横向回到起点）。
    let needsSort = false
    for (let i = 1; i < times.length; i++) {
      if (times[i] < times[i - 1]) { needsSort = true; break }
    }
    if (needsSort) {
      const indices = times.map((_, i) => i)
      indices.sort((a, b) => times[a] - times[b])
      const sortedTimes = indices.map((i) => times[i])
      const sortedRows = indices.map((i) => rows[i])
      for (let i = 0; i < times.length; i++) {
        times[i] = sortedTimes[i]
        rows[i] = sortedRows[i]
      }
    }

    // 2) 数据透传：不再做自研索引分桶降采样 —— 桶边界随总点数变化（bucketSize 取整
    //    漂移），重绘时已绘制波形的 min/max 尖峰位置会整体移动，表现为"毛刺/已绘波形
    //    被后续采样影响"。改由 uPlot 内置 decimation（基于可视像素宽度分桶，稳定无漂移）
    //    负责降采样。rows 是 [pointIdx][seriesIdx]，转置为 [seriesIdx][pointIdx]。
    const fTimes: number[] = times
    const valArrays: (number | null)[][] = series.map((_, si) => rows.map((r) => r[si]))

    // 3) 滑动平均（按通道窗口大小）：对 movingAverage > 0 的通道做居中窗口平均，
    //    平滑噪声。null 值跳过（不参与平均，保持 null）。
    //    用前缀和 O(n) 实现：数据量增大到全量透传后，O(n*w) 双重循环会拖慢渲染。
    const anyMA = series.some((s) => (s.channel.movingAverage ?? 0) > 0)
    if (anyMA) {
      for (let si = 0; si < nSer; si++) {
        const w = series[si].channel.movingAverage ?? 0
        if (!w || w < 1) continue
        const half = Math.floor(w / 2)
        const src = valArrays[si]
        const n = src.length
        // 前缀和：preSum[i] = src[0..i-1] 的数值和，preCnt[i] = 其中有效值个数
        const preSum = new Float64Array(n + 1)
        const preCnt = new Int32Array(n + 1)
        for (let i = 0; i < n; i++) {
          const v = src[i]
          preSum[i + 1] = preSum[i]
          preCnt[i + 1] = preCnt[i]
          if (v !== null && typeof v === 'number') {
            preSum[i + 1] += v
            preCnt[i + 1] += 1
          }
        }
        const out: (number | null)[] = new Array(n)
        for (let i = 0; i < n; i++) {
          const lo = Math.max(0, i - half)
          const hi = Math.min(n - 1, i + half)
          const cnt = preCnt[hi + 1] - preCnt[lo]
          out[i] = cnt > 0 ? (preSum[hi + 1] - preSum[lo]) / cnt : src[i]
        }
        valArrays[si] = out
      }
    }

    // 4) 逐通道 Y 归一化（示波器模式）
    // 触发条件：任意通道设置了 yResolution > 0、全局开启"Y 轴自动归一化"，
    // 或自动判定（多通道量级差异 >8 倍时自动启用，避免大数值变量加入后
    // 压扁小数值变量波形，如 s_cnt 0~4000 与 var -100~100 同时可见）。
    // 开启后所有通道数据归一化到 0..GRID_DIVS 网格，每通道独立缩放：
    // yResolution 决定每格代表的数值（未设置的通道按自身数据范围自动计算）。
    const anyYRes = series.some((s) => (s.channel.yResolution ?? 0) > 0)
    let autoNorm = autoNormRef.current
    if (!anyYRes && !yNormRef.current && nSer >= 2) {
      const now = performance.now()
      if (now - autoNormAtRef.current > 500) {
        autoNormAtRef.current = now
        // 计算各通道数据范围（全量，500ms 节流）
        const ranges: { min: number; max: number }[] = []
        for (let si = 0; si < nSer; si++) {
          const arr = valArrays[si]
          let mn = Infinity, mx = -Infinity
          for (let i = 0; i < arr.length; i++) {
            const v = arr[i]
            if (v !== null && typeof v === 'number') {
              if (v < mn) mn = v
              if (v > mx) mx = v
            }
          }
          if (mn !== Infinity && mx !== -Infinity) ranges.push({ min: mn, max: mx })
        }
        if (ranges.length >= 2) {
          const maxRange = Math.max(...ranges.map((r) => r.max - r.min))
          const minRange = Math.min(...ranges.map((r) => r.max - r.min))
          autoNormRef.current = minRange > 0 && maxRange / minRange > 8
        } else {
          autoNormRef.current = false
        }
      }
      autoNorm = autoNormRef.current
    }
    const prevNorm = normalizedRef.current
    normalizedRef.current = anyYRes || yNormRef.current || autoNorm
    // 模式切换（共享量程 <-> 归一化）：重置 Y 轴与量程缓存，避免坐标系停留旧模式
    if (normalizedRef.current !== prevNorm) {
      normYResetRef.current = true
      yRangeRef.current = null
    }
    if (normalizedRef.current) {
      const normParams = normParamsRef.current
      const halfGrid = GRID_DIVS / 2
      for (let si = 0; si < nSer; si++) {
        const yRes = series[si].channel.yResolution ?? 0
        const arr = valArrays[si]
        // 计算通道数据范围（全量数据，保证稳定性）
        let yMin = Infinity, yMax = -Infinity
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i]
          if (v !== null && typeof v === 'number') {
            if (v < yMin) yMin = v
            if (v > yMax) yMax = v
          }
        }
        if (yMin === Infinity) continue // 全 null，跳过
        // 通道未设 yResolution 时自动计算（按数据范围填满网格）
        const effectiveRes = yRes > 0 ? yRes : ((yMax - yMin) || 1) / GRID_DIVS
        const dataCenter = (yMin + yMax) / 2
        // Hysteresis：数据中心漂移不超过 1 格时保持不变，避免波形上下跳动
        const varId = series[si].variable.id
        const prev = normParams.get(varId)
        let center = dataCenter
        if (prev && prev.yRes === effectiveRes && Math.abs(dataCenter - prev.center) < effectiveRes) {
          center = prev.center
        }
        normParams.set(varId, { yRes: effectiveRes, center })
        // 归一化：(value - center) / yRes + GRID_DIVS/2
        valArrays[si] = arr.map(v => {
          if (v === null || typeof v !== 'number') return null
          return (v - center) / effectiveRes + halfGrid
        })
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

    // 保存当前 X/Y 轴范围 —— plot.setData() 会触发 uPlot 自动缩放两轴，
    // 需在之后恢复，否则每次渲染都会重置用户的视图（已渲染波形会因 Y 轴跳变而"变化"）
    const savedXMin = plot.scales.x?.min
    const savedXMax = plot.scales.x?.max
    const savedYMin = plot.scales.y?.min
    const savedYMax = plot.scales.y?.max
    const hasSavedX = savedXMin !== undefined && savedXMax !== undefined
    const hasSavedY = savedYMin !== undefined && savedYMax !== undefined

    plot.setData(data)

    // 立即恢复 Y 轴范围（setData 会自动缩放 Y 轴到新数据范围）
    // 防止已渲染波形因 Y 轴跳变而视觉上"变化"
    if (hasSavedY) {
      plot.setScale('y', { min: savedYMin!, max: savedYMax! })
    }

    // Y 轴自适应辅助：根据可见 X 范围计算并设置 Y 量程
    // 仅在非归一化模式调用（归一化模式由 buildPlotData 逐通道缩放，Y 轴固定 0..GRID_DIVS）
    // 优先级：min/max（固定量程）> 自适应数据范围
    // ratchet=true 时只扩不缩（Follow 模式），防止已渲染波形因 Y 轴变化而跳动
    const autoFitY = (xMin: number, xMax: number, ratchet: boolean = false) => {
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

          const prev = yRangeRef.current
          if (prev) {
            if (ratchet) {
              // 只扩不缩：新范围超出旧范围时才扩展，绝不收缩
              // 防止 Follow 模式下已渲染波形因 Y 轴缩放而跳动
              const newMin = Math.min(prev.min, paddedMin)
              const newMax = Math.max(prev.max, paddedMax)
              if (newMin < prev.min || newMax > prev.max) {
                yRangeRef.current = { min: newMin, max: newMax }
                plot.setScale('y', { min: newMin, max: newMax })
              }
            } else {
              // 普通模式：数据在旧范围内时不更新（hysteresis）
              const prevRange = prev.max - prev.min
              if (paddedMin >= prev.min + prevRange * Y_HYSTERESIS &&
                  paddedMax <= prev.max - prevRange * Y_HYSTERESIS) {
                // 数据在旧范围内，不更新
              } else {
                yRangeRef.current = { min: paddedMin, max: paddedMax }
                plot.setScale('y', { min: paddedMin, max: paddedMax })
              }
            }
          } else {
            yRangeRef.current = { min: paddedMin, max: paddedMax }
            plot.setScale('y', { min: paddedMin, max: paddedMax })
          }
        }
      }
    }

    // Follow 模式：X 轴自动滚动到最新数据 + Y 轴自适应
    // 暂停时无新数据到达，Follow 不推进 X 轴，显示自然冻结（JScope 风格）。
    // Follow 关闭时：X 轴固定不动，用户可自由滚动浏览历史数据。
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
      // Y 轴：归一化模式固定 0..GRID_DIVS，非归一化模式 autoFitY（ratchet 只扩不缩）
      if (normalizedRef.current) {
        plot.setScale('y', { min: 0, max: GRID_DIVS })
        normYResetRef.current = false
      } else {
        autoFitY(xMin, xMax, true)
      }
    } else {
      // 非 Follow 模式：冻结 X 和 Y 轴，不随新数据自动调整
      // setData 会自动缩放两轴，此处必须恢复保存的范围
      // Y 轴已在 setData 后恢复，此处只需恢复 X 轴
      if (hasSavedX) {
        plot.setScale('x', { min: savedXMin!, max: savedXMax! })
        if (normalizedRef.current) {
          // 归一化模式：配置变更时重置 Y 到 0..GRID_DIVS，否则保留用户缩放
          if (normYResetRef.current) {
            plot.setScale('y', { min: 0, max: GRID_DIVS })
            normYResetRef.current = false
          }
        } else if (!yRangeRef.current) {
          autoFitY(savedXMin!, savedXMax!)
        }
      } else if (data[0].length > 1) {
        // 首次渲染（无已设 X scale）：自动 fit 全部数据
        const tMin = data[0][0] as number
        const tMax = data[0][data[0].length - 1] as number
        const tRange = tMax - tMin || 1
        const tPad = tRange * 0.02
        const fitMin = Math.max(0, tMin - tPad)
        const fitMax = tMax + tPad
        plot.setScale('x', { min: fitMin, max: fitMax })
        if (normalizedRef.current) {
          plot.setScale('y', { min: 0, max: GRID_DIVS })
          normYResetRef.current = false
        } else {
          yRangeRef.current = null
          autoFitY(fitMin, fitMax)
        }
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
  // Follow 关闭时重置 yRangeRef，使非 Follow 模式下 Y 轴按可见数据重新计算，
  // 而非沿用 Follow 模式的 ratchet 扩展范围（可能过大）。
  useEffect(() => {
    const wasFollowing = followRef.current
    followRef.current = follow
    if (wasFollowing && !follow) {
      yRangeRef.current = null
    }
    dirtyRef.current = true
    scheduleRender()
  }, [follow, scheduleRender])

  // Y 轴自动归一化开关切换：清空归一化参数与 Y 轴缓存，强制按新模式重算
  // （归一化模式 <-> 共享量程模式）
  useEffect(() => {
    normYResetRef.current = true
    normParamsRef.current.clear()
    yRangeRef.current = null
    dirtyRef.current = true
    scheduleRender()
  }, [yNormalized, scheduleRender])

  // ── 全览：fitSignal 递增时，关闭 Follow + X 轴缩放覆盖全部已采数据 + Y 轴重新自适应 ──
  const lastFitSignalRef = useRef(0)
  useEffect(() => {
    if (fitSignal === undefined || fitSignal === lastFitSignalRef.current) return
    lastFitSignalRef.current = fitSignal
    const plot = plotRef.current
    if (!plot) return
    const data = samplesRef.current
    if (!data || data.length === 0) return
    const first = data[0].t_ms / 1000
    const last = data[data.length - 1].t_ms / 1000
    if (!(last > first)) return
    if (followRef.current) {
      followRef.current = false
      onFollowChangeRef.current?.(false)
    }
    yRangeRef.current = null
    normYResetRef.current = true
    plot.setScale('x', { min: first, max: last })
    // Y 轴自适应在 doRender 内按新可见窗口重新计算
    dirtyRef.current = true
    scheduleRender()
  }, [fitSignal, scheduleRender])
  useEffect(() => { samplesRef.current = samples; dirtyRef.current = true; scheduleRender() }, [samples, samplesVersion, scheduleRender])
  useEffect(() => { varsRef.current = variables; dirtyRef.current = true; scheduleRender() }, [variables, scheduleRender])
  useEffect(() => {
    // 检测 Y 轴配置变化（yResolution/min/max/visible）或通道数量变化（增删变量），
    // 变化时重置 yRangeRef 强制重新计算。
    // - visible：隐藏/显示通道后可见数据范围变化，需重新适配 Y 轴
    // - 通道数量：删除变量后 channels 变少，若仅比较现有通道配置则检测不到变化，
    //   Y 轴停留在包含已删通道的范围，剩余通道波形可能不可见
    const prevMap = prevYConfigRef.current
    const prevCount = prevMap.size   // 遍历前记录旧通道数（遍历中会新增 key）
    let yConfigChanged = false
    for (const ch of channels) {
      const prev = prevMap.get(ch.varId)
      const curr = { yRes: ch.yResolution ?? 0, min: ch.min, max: ch.max, visible: ch.visible ?? true }
      if (prev && (prev.yRes !== curr.yRes || prev.min !== curr.min || prev.max !== curr.max || prev.visible !== curr.visible)) {
        yConfigChanged = true
      }
      prevMap.set(ch.varId, curr)
    }
    if (prevCount !== channels.length) {
      yConfigChanged = true
    }
    if (yConfigChanged) {
      yRangeRef.current = null
      // 归一化模式下 Y Res 变化需重置 Y 轴到 0..GRID_DIVS
      normYResetRef.current = true
      // 清除旧的归一化参数，强制重新计算数据中心
      normParamsRef.current.clear()
    }
    chansRef.current = channels
    dirtyRef.current = true
    scheduleRender()
  }, [channels, scheduleRender])
  // 时基变化：更新 windowRef，并在非 Follow 模式下同步更新 X 轴窗口宽度
  // Follow 模式下 doRender 会自动使用 windowRef × GRID_DIVS 作为窗口，无需此处干预
  // 非 Follow 模式下需主动 setScale，否则下拉切换时基不会改变可见窗口
  // 注意：滚轮操作已直接 setScale 并回调 onTimebaseChange → store → windowSec 变化 → 此 effect 触发。
  //       此时当前窗口宽度已与新时基匹配，通过比较跳过重复 setScale，避免以视图中心重新对齐导致跳动。
  const prevWindowRef = useRef(windowSec)
  useEffect(() => {
    const prevWindow = prevWindowRef.current
    windowRef.current = windowSec
    if (prevWindow !== windowSec) {
      prevWindowRef.current = windowSec
      const plot = plotRef.current
      if (plot && !followRef.current) {
        const xScale = plot.scales.x
        if (xScale && xScale.min !== undefined && xScale.max !== undefined) {
          const currentRange = xScale.max - xScale.min
          const expectedRange = windowSec * GRID_DIVS
          // 当前窗口宽度已匹配新时基（来自滚轮操作的反馈），跳过重设
          if (Math.abs(currentRange - expectedRange) / expectedRange > 0.01) {
            // 来自下拉切换：以当前视图中心为锚点更新窗口宽度
            const center = (xScale.min + xScale.max) / 2
            let newMin = center - expectedRange / 2
            let newMax = center + expectedRange / 2
            if (newMin < 0) { newMin = 0; newMax = expectedRange }
            plot.setScale('x', { min: newMin, max: newMax })
          }
        }
      }
    }
    dirtyRef.current = true
    scheduleRender()
  }, [windowSec, scheduleRender])
  useEffect(() => { fpsRef.current = fps }, [fps])

  // ── 暂停状态：冻结显示（JScope 风格）──
  // 后端在 resume() 时调整 start_time 消除时间间隙，前端无需任何补偿。
  // 暂停时无新数据到达，显示自然冻结。恢复后时间戳连续，波形自然衔接。
  useEffect(() => {
    pausedRef.current = paused
    dirtyRef.current = true
    scheduleRender()
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
          // 线性插值渲染（默认）：相邻采样点用直线连接。
          // 对标 JScope 的点对点渲染方式，波形平整有规律。
          // stepped 路径会在采样间隔微小波动时产生不等宽阶梯，视觉上不规律。
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
          // 归一化模式显示格数（0..GRID_DIVS），非归一化模式显示实际数值
          values: (_self: uPlot, ticks: number[]) => {
            if (normalizedRef.current) {
              return ticks.map((v) => v.toFixed(0))
            }
            return ticks.map((v) => {
              const abs = Math.abs(v)
              if (abs >= 10000) return v.toFixed(0)
              if (abs >= 100) return v.toFixed(1)
              if (abs >= 1) return v.toFixed(2)
              return v.toFixed(3)
            })
          },
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
        // Y 轴：归一化模式下固定 0..GRID_DIVS（每通道独立缩放到该网格），
        // 必须设 auto:false，否则 uPlot setData 后会自动缩放 Y 轴覆盖我们的 setScale，
        // 导致归一化模式下波形被压扁或看似"空白"。
        y: { auto: !normalizedRef.current },
      },
      // 注：uPlot 1.6 内置像素桶降采样（可视窗口点数 ≥ 4×像素宽时自动 min/max 分桶），
      // 桶基于像素列、稳定无漂移；因此前端不再做自研索引分桶降采样（见 buildPlotData）。
    }

    const plot = new uPlot(opts, [[]], containerRef.current)
    plotRef.current = plot

    // ── 鼠标滚轮缩放 ──
    // X 轴：离散时基步进（示波器风格），每次滚动切换一档时基，钳位到最小/最大
    // Y 轴（Shift）：以鼠标 Y 位置为中心连续缩放
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
        // X 轴：离散时基步进 —— 每次滚动恰好切换一档时基
        const xScale = p.scales.x
        if (!xScale || xScale.min === undefined || xScale.max === undefined) return

        // Follow 模式下滚轮 → 关闭 Follow，切换为手动浏览
        if (followRef.current) {
          followRef.current = false
          onFollowChangeRef.current?.(false)
        }

        // 从当前可见窗口宽度反推当前时基档位
        const currentRange = xScale.max - xScale.min
        const currentSecPerDiv = currentRange / GRID_DIVS
        const currentIdx = findNearestTimebaseIndex(currentSecPerDiv)

        // 滚轮向上 (deltaY < 0) = 放大 = 时基减小 (index -1)
        // 滚轮向下 (deltaY > 0) = 缩小 = 时基增大 (index +1)
        const direction = e.deltaY < 0 ? -1 : 1
        const newIdx = Math.max(0, Math.min(TIMEBASE_OPTIONS.length - 1, currentIdx + direction))

        // 已在边界，保持不变（不发生档位切换）
        if (newIdx === currentIdx) return

        const newSecPerDiv = TIMEBASE_OPTIONS[newIdx].value
        const newRange = newSecPerDiv * GRID_DIVS

        // 以鼠标位置为中心设置新窗口，钳位 newMin 到 0（避免负时间）
        const mouseVal = p.posToVal(e.offsetX, 'x')
        const ratio = (mouseVal - xScale.min) / currentRange
        let newMin = mouseVal - newRange * ratio
        let newMax = newMin + newRange
        if (newMin < 0) {
          newMin = 0
          newMax = newRange
        }
        p.setScale('x', { min: newMin, max: newMax })

        // 同步时基下拉（不触发重绘，setScale 已触发 uPlot 重绘）
        windowRef.current = newSecPerDiv
        onTimebaseRef.current?.(newSecPerDiv)
      }
    }

    // ── 鼠标游标值追踪（JScope 风格）──
    // 鼠标悬停于波形图时，将游标 X 位置对应的采样值推送给 Watch 面板
    let cursorRafId: number | null = null
    let lastCursorX = -1
    const onMouseMove = (e: MouseEvent) => {
      const p = plotRef.current
      if (!p) return
      // 用 RAF 节流，避免高频 mousemove 触发过多回调
      lastCursorX = e.offsetX
      if (cursorRafId !== null) return
      cursorRafId = requestAnimationFrame(() => {
        cursorRafId = null
        const plot = plotRef.current
        if (!plot) return
        const xVal = plot.posToVal(lastCursorX, 'x')
        const pts = samplesRef.current
        if (pts.length === 0) return
        // 二分查找最近的采样点
        let lo = 0, hi = pts.length - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (pts[mid].t_ms / 1000 < xVal) lo = mid + 1
          else hi = mid
        }
        // 比较 lo 和 lo-1 哪个更近
        let best = lo
        if (lo > 0) {
          const d1 = Math.abs(pts[lo].t_ms / 1000 - xVal)
          const d0 = Math.abs(pts[lo - 1].t_ms / 1000 - xVal)
          if (d0 < d1) best = lo - 1
        }
        const vals = new Map<string, number | null>()
        for (const v of pts[best].values) vals.set(v.id, v.value)
        onCursorValueRef.current?.({ values: vals, sampleIndex: best })
      })
    }
    // 鼠标离开时不重置游标值 —— 保留最后游标位置的值继续显示（JScope 风格）
    const onMouseLeave = () => {
      if (cursorRafId !== null) {
        cancelAnimationFrame(cursorRafId)
        cursorRafId = null
      }
    }

    const wheelTarget = containerRef.current
    if (wheelTarget) {
      wheelTarget.addEventListener('wheel', onWheel, { passive: false })
      wheelTarget.addEventListener('mousemove', onMouseMove)
      wheelTarget.addEventListener('mouseleave', onMouseLeave)
    }

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
      if (wheelTarget) {
        wheelTarget.removeEventListener('wheel', onWheel)
        wheelTarget.removeEventListener('mousemove', onMouseMove)
        wheelTarget.removeEventListener('mouseleave', onMouseLeave)
      }
      if (cursorRafId !== null) cancelAnimationFrame(cursorRafId)
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
    // 归一化状态变化时重建 uPlot（scales.y.auto 需在创建时设置）
    yNormalized ? 'on' : (autoNormRef.current ? 'auto' : 'off'),
  ])

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />
}
