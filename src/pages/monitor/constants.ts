/**
 * Monitor 页面共享常量
 *
 * 被 ChannelPanel（时基下拉选择）和 WaveformChart（滚轮联动）共同使用，
 * 确保两者引用同一份时基档位定义。
 */

/** 示波器标准水平格数 */
export const GRID_DIVS = 10

/**
 * 时基档位（秒/div），覆盖 us~s 全范围，1-2-5 序列。
 *
 * - ChannelPanel 的时基下拉使用此列表渲染选项
 * - WaveformChart 的鼠标滚轮缩放在此列表中步进，与下拉联动
 * - Follow 模式下时间窗口宽度 = 时基 × GRID_DIVS（10 格）
 */
export const TIMEBASE_OPTIONS: { label: string; value: number }[] = [
  { label: '1 us/div', value: 0.000001 },
  { label: '2 us/div', value: 0.000002 },
  { label: '5 us/div', value: 0.000005 },
  { label: '10 us/div', value: 0.00001 },
  { label: '20 us/div', value: 0.00002 },
  { label: '50 us/div', value: 0.00005 },
  { label: '100 us/div', value: 0.0001 },
  { label: '200 us/div', value: 0.0002 },
  { label: '500 us/div', value: 0.0005 },
  { label: '1 ms/div', value: 0.001 },
  { label: '2 ms/div', value: 0.002 },
  { label: '5 ms/div', value: 0.005 },
  { label: '10 ms/div', value: 0.01 },
  { label: '20 ms/div', value: 0.02 },
  { label: '50 ms/div', value: 0.05 },
  { label: '100 ms/div', value: 0.1 },
  { label: '200 ms/div', value: 0.2 },
  { label: '500 ms/div', value: 0.5 },
  { label: '1 s/div', value: 1 },
  { label: '2 s/div', value: 2 },
  { label: '5 s/div', value: 5 },
  { label: '10 s/div', value: 10 },
  { label: '20 s/div', value: 20 },
  { label: '50 s/div', value: 50 },
  { label: '100 s/div', value: 100 },
  { label: '200 s/div', value: 200 },
  { label: '500 s/div', value: 500 },
]

/**
 * 在 TIMEBASE_OPTIONS 中查找最接近给定值的档位索引。
 * 用于滚轮缩放时从当前窗口宽度反推最近的时基档位。
 */
export function findNearestTimebaseIndex(secPerDiv: number): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < TIMEBASE_OPTIONS.length; i++) {
    const dist = Math.abs(TIMEBASE_OPTIONS[i].value - secPerDiv)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  return bestIdx
}
