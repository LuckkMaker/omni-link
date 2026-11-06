/**
 * 按地址对齐的固件比较工具。
 *
 * Flash 页的 compare 是「当前 Tab 数据 ↔ 参考文件」的逐字节对比。两份数据的
 * 基地址不一定相同：``.bin`` 的地址由用户指定，``.axf`` / ``.hex`` 自带地址。
 * 因此不能按「偏移 0 对偏移 0」比较，必须按绝对地址一一对应，否则不同基地址的
 * 两个文件会整体错位。
 *
 * 这里把两侧数据裁剪/补齐到同一个地址窗口，并给出：
 * - 两侧按窗口对齐后的字节与「是否有数据」掩码（窗口外的地址为无数据）；
 * - 差异掩码、差异/相同/仅单侧的字节数；
 * - 首个差异的绝对地址（用于视图自动跳转）。
 */

export interface CompareSide {
  /** 该侧原始数据 */
  bytes: Uint8Array
  /** 该侧数据的起始地址 */
  base: number
}

export interface CompareWindowOptions {
  /** 比较窗口起始地址；默认取左侧（当前 Tab）数据基地址 */
  start?: number
  /** 比较窗口长度；默认覆盖两侧数据范围的并集 */
  size?: number
}

export interface CompareWindow {
  /** 窗口起始地址 */
  start: number
  /** 窗口结束地址（不含） */
  end: number
  /** 窗口长度（字节） */
  size: number
  /** 左侧数据在窗口内的字节（无数据处为 0） */
  left: Uint8Array
  /** 左侧每个字节是否有数据（1=有，0=窗口内该地址左侧没有数据） */
  leftPresent: Uint8Array
  right: Uint8Array
  rightPresent: Uint8Array
  /** 每个字节是否为差异（两侧都有数据且值不同） */
  diffMask: Uint8Array
  /** 两侧都有数据且相同的字节数 */
  matchCount: number
  /** 两侧都有数据但不同的字节数 */
  diffCount: number
  /** 只有左侧有数据的字节数 */
  onlyLeft: number
  /** 只有右侧有数据的字节数 */
  onlyRight: number
  /** 首个差异（内容不同或仅单侧有数据）的绝对地址；窗口内完全一致时为 null */
  firstDiff: number | null
}

/** 把一侧数据按地址拷进窗口缓冲，并标记有数据的区间。 */
function copySideInto(
  target: Uint8Array,
  present: Uint8Array,
  side: CompareSide,
  windowStart: number,
): void {
  const from = Math.max(windowStart, side.base)
  const to = Math.min(windowStart + target.length, side.base + side.bytes.length)
  if (to <= from) return
  const dstOffset = from - windowStart
  const count = to - from
  target.set(side.bytes.subarray(from - side.base, from - side.base + count), dstOffset)
  present.fill(1, dstOffset, dstOffset + count)
}

/** 空窗口（没有可比较的地址范围时使用）。 */
function emptyWindow(start: number): CompareWindow {
  return {
    start,
    end: start,
    size: 0,
    left: new Uint8Array(0),
    leftPresent: new Uint8Array(0),
    right: new Uint8Array(0),
    rightPresent: new Uint8Array(0),
    diffMask: new Uint8Array(0),
    matchCount: 0,
    diffCount: 0,
    onlyLeft: 0,
    onlyRight: 0,
    firstDiff: null,
  }
}

/**
 * 构建比较窗口。
 *
 * 窗口默认从左侧数据基地址开始；``options.start`` 用于「指定地址比较」
 * （对话框里的起始地址），``options.size`` 用于限定比较长度。
 *
 * 起始地址/size 会被夹到两侧数据覆盖的地址范围内：指定地址远低于数据时不会
 * 生成几 MB 的空白前缀（也避免一次分配上百 MB 的缓冲），超出数据末尾的部分同理。
 */
export function buildCompareWindow(
  left: CompareSide,
  right: CompareSide,
  options: CompareWindowOptions = {},
): CompareWindow {
  const hasLeft = left.bytes.length > 0
  const hasRight = right.bytes.length > 0
  const leftEnd = left.base + left.bytes.length
  const rightEnd = right.base + right.bytes.length

  if (!hasLeft && !hasRight) return emptyWindow(options.start ?? left.base)

  const dataStart = hasLeft && hasRight ? Math.min(left.base, right.base) : hasLeft ? left.base : right.base
  const dataEnd = Math.max(hasLeft ? leftEnd : dataStart, hasRight ? rightEnd : dataStart)

  const requestedStart = options.start ?? (hasLeft ? left.base : dataStart)
  const windowStart = Math.min(Math.max(requestedStart, dataStart), dataEnd)
  const requestedEnd = options.size && options.size > 0 ? windowStart + options.size : dataEnd
  const windowEnd = Math.min(Math.max(requestedEnd, windowStart), dataEnd)

  if (windowEnd <= windowStart) {
    // 指定的地址落在数据范围之外：没有可比较的地址范围
    return emptyWindow(windowStart)
  }

  const size = windowEnd - windowStart
  const result: CompareWindow = {
    ...emptyWindow(windowStart),
    end: windowEnd,
    size,
    left: new Uint8Array(size),
    leftPresent: new Uint8Array(size),
    right: new Uint8Array(size),
    rightPresent: new Uint8Array(size),
    diffMask: new Uint8Array(size),
  }

  copySideInto(result.left, result.leftPresent, left, windowStart)
  copySideInto(result.right, result.rightPresent, right, windowStart)

  let firstDiff: number | null = null
  for (let i = 0; i < size; i++) {
    const hasLeft = result.leftPresent[i] === 1
    const hasRight = result.rightPresent[i] === 1
    if (hasLeft && hasRight) {
      if (result.left[i] === result.right[i]) {
        result.matchCount++
        continue
      }
      result.diffCount++
      result.diffMask[i] = 1
    } else if (hasLeft) {
      result.onlyLeft++
    } else if (hasRight) {
      result.onlyRight++
    } else {
      // 两侧都没有数据：窗口内的空洞，不参与统计
      continue
    }
    if (firstDiff === null) firstDiff = windowStart + i
  }

  result.firstDiff = firstDiff
  return result
}

/** base64 → 字节数组（空值返回空数组）。 */
export function base64ToBytes(base64: string | null | undefined): Uint8Array {
  if (!base64) return new Uint8Array(0)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 比较结果的一句话描述（通知/状态栏复用）。 */
export function describeCompare(window: CompareWindow): string {
  if (window.size === 0) return '没有可比较的数据'
  const parts: string[] = []
  if (window.diffCount > 0) parts.push(`${window.diffCount} 字节不同`)
  if (window.matchCount > 0) parts.push(`${window.matchCount} 字节相同`)
  if (window.onlyLeft > 0) parts.push(`仅左侧 ${window.onlyLeft} 字节`)
  if (window.onlyRight > 0) parts.push(`仅右侧 ${window.onlyRight} 字节`)
  if (parts.length === 0) parts.push('窗口内两侧都没有数据')
  return parts.join('，')
}
