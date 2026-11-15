import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNotificationStore } from '@/stores/notification.store'

export type ByteWidth = 1 | 2 | 4

interface HexViewerProps {
  base64Data?: string
  /** 可选：直接给字节数组（优先于 base64Data，避免重复解码） */
  bytes?: Uint8Array | null
  baseAddress: number
  byteWidth: ByteWidth
  /** 可选：比较参考数据（base64），存在时高亮差异字节 */
  diffBase64?: string | null
  diffBaseAddress?: number
  /** 可选：预先算好的差异掩码（1=差异），优先于 diffBase64 的按地址比较 */
  diffMask?: Uint8Array | null
  /** 可选：每个字节是否有数据（1=有）；为 0 的地址显示空白（两侧地址范围不一致时） */
  presentMask?: Uint8Array | null
  /** 可选：加载后自动滚动并高亮到该绝对地址（比较结果跳到首个差异） */
  initialAddress?: number | null
  /** 可选：滚动同步回调，当本组件滚动时通知另一个组件 */
  onScrollSync?: (scrollTop: number) => void
  /** 可选：外部控制的 scrollTop，用于同步滚动 */
  syncScrollTop?: number | null
  /** 可选：外部持久化的高亮偏移（按 tab 保存） */
  highlightOffset?: number | null
  /** 可选：高亮变化回调（持久化到 tab） */
  onHighlightChange?: (offset: number | null) => void
  /** 可选：外部持久化的 scrollTop（切换 tab 后恢复） */
  persistedScrollTop?: number
  /** 可选：滚动位置持久化回调 */
  onScrollPersist?: (scrollTop: number) => void
}

// 虚拟滚动常量
const ROW_HEIGHT = 20 // 固定行高 px
const BUFFER_ROWS = 5 // 上下缓冲行数

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function formatHexAddr(addr: number): string {
  const hex = addr.toString(16).toUpperCase().padStart(8, '0')
  return `0x${hex.slice(0, 4)}_${hex.slice(4)}`
}

const HEX_CHARS = '0123456789ABCDEF'

function byteToHex(b: number): string {
  return HEX_CHARS[(b >> 4) & 0xF] + HEX_CHARS[b & 0xF]
}

function byteToAscii(b: number): string {
  return b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'
}

function readLeU16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8)
}
function readLeU32(data: Uint8Array, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0
}

function wordToHex(val: number, width: ByteWidth): string {
  return val.toString(16).toUpperCase().padStart(width * 2, '0')
}

/** HexViewer 工具栏（字节宽度切换 + 地址跳转），紧凑布局 */
export function HexToolbar({
  byteWidth,
  onByteWidthChange,
  baseAddress,
  dataLength,
  jumpAddr: extJumpAddr,
  onJumpAddrChange,
}: {
  byteWidth: ByteWidth
  onByteWidthChange: (w: ByteWidth) => void
  baseAddress: number
  dataLength: number
  /** 外部持久化的跳转地址（按 tab 保存），不传则用局部 state */
  jumpAddr?: string
  onJumpAddrChange?: (v: string) => void
}) {
  const [localJumpAddr, setLocalJumpAddr] = useState('')
  const jumpAddr = extJumpAddr ?? localJumpAddr
  const setJumpAddr = onJumpAddrChange ?? setLocalJumpAddr

  const endAddress = baseAddress + dataLength - 1

  const handleJump = useCallback(() => {
    const trimmed = jumpAddr.trim().toLowerCase()
    if (!trimmed) return
    const addr = parseInt(trimmed, 16)
    if (isNaN(addr) || addr < 0) {
      useNotificationStore.getState().push({
        type: 'warning',
        title: '地址无效',
        message: '请输入有效的十六进制地址',
      })
      return
    }
    if (addr < baseAddress || addr > endAddress) {
      useNotificationStore.getState().push({
        type: 'warning',
        title: '地址超出范围',
        message: `有效范围 ${formatHexAddr(baseAddress)} ~ ${formatHexAddr(endAddress)}`,
      })
      return
    }

    const offset = addr - baseAddress
    window.dispatchEvent(new CustomEvent('hexviewer:jump', { detail: { offset } }))
  }, [jumpAddr, baseAddress, endAddress])

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {/* 字节宽度切换 */}
      <div className="flex items-center rounded border border-border">
        {([1, 2, 4] as ByteWidth[]).map((w) => (
          <button
            key={w}
            onClick={() => onByteWidthChange(w)}
            className={cn(
              'px-1.5 py-0.5 text-[11px] font-medium transition-colors',
              byteWidth === w
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {w}B
          </button>
        ))}
      </div>

      {/* 地址跳转 — 固定 0x 前缀 */}
      <div className="flex items-center gap-0.5 ml-auto">
        <div className="flex items-center h-6 rounded-md border border-border overflow-hidden">
          <span className="flex items-center px-1.5 h-full text-xs font-mono text-muted-foreground bg-muted/50 border-r border-border">0x</span>
          <input
            value={jumpAddr}
            onChange={(e) => {
              // 只允许十六进制字符
              const filtered = e.target.value.replace(/[^0-9a-fA-F]/g, '')
              setJumpAddr(filtered)
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleJump()}
            placeholder="08000000"
            spellCheck={false}
            autoComplete="off"
            className="h-6 w-20 bg-transparent px-1.5 font-mono text-xs outline-none"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={handleJump} className="h-6 w-6 p-0">
          <Search className="size-3" />
        </Button>
      </div>
    </div>
  )
}

interface HexCell {
  hex: string
  diff: boolean
}

interface HexGroup {
  /** 该组的字节宽度（1/2/4），用于确定显示哪些组 */
  width: ByteWidth
  cells: HexCell[]
}

interface VirtualRow {
  offset: number
  addr: string
  groups: HexGroup[]
  ascii: { ch: string; diff: boolean }[]
}

export function HexViewer({ base64Data, bytes, baseAddress, byteWidth, diffBase64, diffBaseAddress, diffMask, presentMask, initialAddress, onScrollSync, syncScrollTop, highlightOffset: extHighlightOffset, onHighlightChange, persistedScrollTop, onScrollPersist }: HexViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [localHighlightOffset, setLocalHighlightOffset] = useState<number | null>(null)
  const highlightOffset = extHighlightOffset !== undefined ? extHighlightOffset : localHighlightOffset
  const onScrollSyncRef = useRef(onScrollSync)
  onScrollSyncRef.current = onScrollSync
  const onHighlightChangeRef = useRef(onHighlightChange)
  onHighlightChangeRef.current = onHighlightChange
  const onScrollPersistRef = useRef(onScrollPersist)
  onScrollPersistRef.current = onScrollPersist

  // 每行固定 16 字节（标准十六进制编辑器宽度），byteWidth 控制字分组方式
  const bytesPerRow = 16

  const data = useMemo(() => {
    if (bytes) return bytes
    return base64Data ? decodeBase64(base64Data) : new Uint8Array(0)
  }, [bytes, base64Data])
  const diffData = useMemo(() => diffBase64 ? decodeBase64(diffBase64) : null, [diffBase64])

  // 总行数（廉价计算，不需要遍历数据）
  const totalRows = Math.ceil(data.length / bytesPerRow)
  const totalHeight = totalRows * ROW_HEIGHT

  // 监听容器尺寸
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    const ro = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 计算可见行范围
  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS)
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + 2 * BUFFER_ROWS
  const visibleEnd = Math.min(totalRows, visibleStart + visibleCount)

  // 只为可见行生成渲染数据（按需计算，不再预计算全部）
  const visibleRows = useMemo<VirtualRow[]>(() => {
    if (data.length === 0) return []
    const result: VirtualRow[] = []

    // 辅助函数：该地址是否有数据（presentMask 为比较窗口对齐后的「无数据」标记）
    const hasByte = (pos: number): boolean => !presentMask || presentMask[pos] === 1

    // 辅助函数：检查指定字节范围内是否有 diff
    const checkDiff = (pos: number, width: number): boolean => {
      if (diffMask) {
        for (let j = 0; j < width; j++) if (diffMask[pos + j]) return true
        return false
      }
      if (!diffData) return false
      for (let j = 0; j < width; j++) {
        const refOffset = (baseAddress + pos + j) - (diffBaseAddress ?? baseAddress)
        if (refOffset < 0 || refOffset >= diffData.length) return true
        if (data[pos + j] !== diffData[refOffset]) return true
      }
      return false
    }

    // 辅助函数：生成一个组的 cells（offset 作为参数传入，避免闭包作用域问题）
    const buildGroup = (width: ByteWidth, offset: number): HexGroup => {
      const cellCount = bytesPerRow / width // 1B:8, 2B:4, 4B:2
      const cells: HexCell[] = []
      for (let i = 0; i < cellCount; i++) {
        const pos = offset + i * width
        let present = pos + width <= data.length
        for (let j = 0; present && j < width; j++) present = hasByte(pos + j)
        if (present) {
          let hex: string
          if (width === 1) {
            hex = byteToHex(data[pos])
          } else if (width === 2) {
            hex = wordToHex(readLeU16(data, pos), 2)
          } else {
            hex = wordToHex(readLeU32(data, pos), 4)
          }
          cells.push({ hex, diff: checkDiff(pos, width) })
        } else {
          cells.push({ hex: ' '.repeat(width * 2), diff: false })
        }
      }
      return { width, cells }
    }

    for (let rowIdx = visibleStart; rowIdx < visibleEnd; rowIdx++) {
      const offset = rowIdx * bytesPerRow

      // 构建 ASCII 列（8 个字符，每个字节一个）
      const ascii: { ch: string; diff: boolean }[] = []
      for (let i = 0; i < bytesPerRow; i++) {
        const pos = offset + i
        if (pos < data.length && hasByte(pos)) {
          ascii.push({ ch: byteToAscii(data[pos]), diff: checkDiff(pos, 1) })
        } else {
          ascii.push({ ch: ' ', diff: false })
        }
      }

      // byteWidth 选择唯一的字分组方式（标准十六进制编辑器行为）：
      // 1B: 16 个单字节单元，空格分隔
      // 2B: 8 个双字节词，空格分隔，词内无空格（ABCD）
      // 4B: 4 个四字节词，空格分隔，词内无空格（ABCDEF01）
      const groups: HexGroup[] = [buildGroup(byteWidth, offset)]

      result.push({
        offset,
        addr: formatHexAddr(baseAddress + offset),
        groups,
        ascii,
      })
    }
    return result
  }, [data, diffData, diffMask, presentMask, baseAddress, diffBaseAddress, byteWidth, bytesPerRow, visibleStart, visibleEnd])

  // 数据或字节宽度变化时恢复滚动位置（切换 tab 时从持久化值恢复）
  useEffect(() => {
    const targetScroll = persistedScrollTop ?? 0
    if (containerRef.current) {
      containerRef.current.scrollTop = targetScroll
    }
    setScrollTop(targetScroll)
    // 仅清局部高亮（CompareView 模式）；持久化模式由 tab 数据控制
    if (extHighlightOffset === undefined) {
      setLocalHighlightOffset(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base64Data, bytes, byteWidth])

  // 初始跳转：数据就绪后滚动/高亮到指定地址（比较结果直接跳到首个差异）
  useEffect(() => {
    const el = containerRef.current
    if (initialAddress == null || !el || data.length === 0) return
    const offset = Math.max(0, Math.min(initialAddress - baseAddress, data.length - 1))
    const rowIndex = Math.floor(offset / bytesPerRow)
    const targetTop = rowIndex * ROW_HEIGHT
    // 居中显示
    const centerOffset = Math.max(0, targetTop - el.clientHeight / 2 + ROW_HEIGHT / 2)
    el.scrollTop = centerOffset
    setScrollTop(centerOffset)
    if (onHighlightChangeRef.current) {
      onHighlightChangeRef.current(rowIndex * bytesPerRow)
    } else {
      setLocalHighlightOffset(rowIndex * bytesPerRow)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAddress, base64Data, bytes, baseAddress, bytesPerRow])

  // 地址跳转：直接设置 scrollTop
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const offset = detail.offset as number
      const rowIndex = Math.floor(offset / bytesPerRow)
      const targetTop = rowIndex * ROW_HEIGHT
      const el = containerRef.current
      if (el) {
        // 居中显示
        const centerOffset = Math.max(0, targetTop - el.clientHeight / 2 + ROW_HEIGHT / 2)
        el.scrollTop = centerOffset
        setScrollTop(centerOffset)
        // 更新高亮（持久化模式通过回调，CompareView 模式用局部 state）
        if (onHighlightChangeRef.current) {
          onHighlightChangeRef.current(rowIndex * bytesPerRow)
        } else {
          setLocalHighlightOffset(rowIndex * bytesPerRow)
        }
      }
    }
    window.addEventListener('hexviewer:jump', handler)
    return () => window.removeEventListener('hexviewer:jump', handler)
  }, [bytesPerRow])

  // 滚动同步
  const isSyncingRef = useRef(false)
  const scrollPersistTimerRef = useRef<number | null>(null)

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const st = e.currentTarget.scrollTop
    setScrollTop(st)
    // 节流持久化滚动位置（捕获当前回调，避免 tab 切换后写错 tab）
    const persistCb = onScrollPersistRef.current
    if (persistCb) {
      if (scrollPersistTimerRef.current) clearTimeout(scrollPersistTimerRef.current)
      scrollPersistTimerRef.current = window.setTimeout(() => {
        scrollPersistTimerRef.current = null
        persistCb(st)
      }, 500)
    }
    if (isSyncingRef.current) return
    onScrollSyncRef.current?.(st)
  }, [])

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (scrollPersistTimerRef.current) clearTimeout(scrollPersistTimerRef.current)
    }
  }, [])

  // 外部同步滚动
  useEffect(() => {
    if (syncScrollTop !== null && syncScrollTop !== undefined && containerRef.current) {
      isSyncingRef.current = true
      containerRef.current.scrollTop = syncScrollTop
      setScrollTop(syncScrollTop)
      requestAnimationFrame(() => { isSyncingRef.current = false })
    }
  }, [syncScrollTop])

  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        无数据
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-full overflow-auto font-mono text-xs"
    >
      {/* 撑开总高度，维持滚动条 */}
      <div style={{ height: totalHeight, position: 'relative' }}>
        {/* 只渲染可见行，用 absolute 定位偏移 */}
        <div style={{ position: 'absolute', top: visibleStart * ROW_HEIGHT, left: 0, right: 0 }}>
          {visibleRows.map((row) => (
            <div
              key={row.offset}
              style={{ height: ROW_HEIGHT }}
              className={cn(
                'flex gap-3 px-2 hover:bg-muted/30',
                highlightOffset === row.offset && 'bg-yellow-500/20 ring-1 ring-yellow-500/50'
              )}
            >
              <span className="shrink-0 text-muted-foreground leading-5">{row.addr}</span>
              {/* Hex 数据：按 byteWidth 分组显示，8 字节中线处加额外空格 */}
              <span className="shrink-0 flex items-center leading-5">
                {row.groups.map((group, gi) => (
                  <span key={gi} className="flex items-center">
                    {group.cells.map((cell, ci) => {
                      // 8 字节中线：前 8 字节后加更宽间距（标准十六进制编辑器习惯）
                      const isMidpoint = ci === (8 / group.width)
                      return (
                        <span key={ci} className="flex items-center">
                          {ci > 0 && <span className={isMidpoint ? 'w-[1.5ch]' : 'w-[0.5ch]'} />}
                          <span className={cn('font-mono', cell.diff && 'bg-red-500/30 text-red-600 dark:text-red-400 rounded px-0.5')}>
                            {cell.hex}
                          </span>
                        </span>
                      )
                    })}
                  </span>
                ))}
              </span>
              {/* ASCII（16 个等宽字符，与 hex 列字宽设置无关，参照 JLink 标准） */}
              <span className="text-muted-foreground flex items-center leading-5 font-mono">
                {row.ascii.map((a, idx) => (
                  <span key={idx} className={cn('w-[1ch] text-center', a?.diff && 'bg-red-500/30 text-red-600 dark:text-red-400 rounded')}>
                    {a?.ch ?? ' '}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
