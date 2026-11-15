import { useMemo, useState, useRef, useCallback } from 'react'
import { HexViewer, HexToolbar, type ByteWidth } from './HexViewer'
import { base64ToBytes, buildCompareWindow } from '../utils/compare'

interface CompareViewProps {
  leftBase64: string
  leftBaseAddress: number
  leftTitle: string
  rightBase64: string
  rightBaseAddress: number
  rightTitle: string
  /** 比较窗口起始地址（默认左侧基地址；即「指定地址比较」的地址） */
  windowStart?: number
  /** 比较窗口长度（默认覆盖两侧数据的并集） */
  windowSize?: number
  /** 初始跳转地址（首个差异）；不传则用窗口内首个差异 */
  initialAddress?: number | null
}

function formatSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

export function CompareView({
  leftBase64,
  leftBaseAddress,
  leftTitle,
  rightBase64,
  rightBaseAddress,
  rightTitle,
  windowStart,
  windowSize,
  initialAddress,
}: CompareViewProps) {
  const [byteWidth, setByteWidth] = useState<ByteWidth>(1)

  // 滚动同步状态
  const [leftSyncScroll, setLeftSyncScroll] = useState<number | null>(null)
  const [rightSyncScroll, setRightSyncScroll] = useState<number | null>(null)
  const isSyncing = useRef(false)

  const leftBytes = useMemo(() => base64ToBytes(leftBase64), [leftBase64])
  const rightBytes = useMemo(() => base64ToBytes(rightBase64), [rightBase64])

  // 按地址对齐：两侧都裁剪/补齐到同一个地址窗口，行号与地址一一对应
  const compareWindow = useMemo(
    () =>
      buildCompareWindow(
        { bytes: leftBytes, base: leftBaseAddress },
        { bytes: rightBytes, base: rightBaseAddress },
        { start: windowStart, size: windowSize },
      ),
    [leftBytes, leftBaseAddress, rightBytes, rightBaseAddress, windowStart, windowSize],
  )

  const jumpAddress = initialAddress ?? compareWindow.firstDiff ?? compareWindow.start

  // 左侧滚动 → 同步右侧
  const handleLeftScroll = useCallback((scrollTop: number) => {
    if (isSyncing.current) return
    isSyncing.current = true
    setRightSyncScroll(scrollTop)
    requestAnimationFrame(() => { isSyncing.current = false })
  }, [])

  // 右侧滚动 → 同步左侧
  const handleRightScroll = useCallback((scrollTop: number) => {
    if (isSyncing.current) return
    isSyncing.current = true
    setLeftSyncScroll(scrollTop)
    requestAnimationFrame(() => { isSyncing.current = false })
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="shrink-0 flex items-center gap-2 border-b border-border px-2 py-1.5">
        <HexToolbar
          byteWidth={byteWidth}
          onByteWidthChange={setByteWidth}
          baseAddress={compareWindow.start}
          dataLength={compareWindow.size}
        />
        <span className="text-[11px] text-muted-foreground font-mono">
          {formatHex(compareWindow.start)} ~ {formatHex(compareWindow.end > compareWindow.start ? compareWindow.end - 1 : compareWindow.start)}
        </span>
        <div className="ml-auto text-[11px] text-muted-foreground flex items-center gap-2">
          <span className="text-red-600 dark:text-red-400">差异 {compareWindow.diffCount} bytes</span>
          <span>·</span>
          <span className="text-green-600 dark:text-green-400">匹配 {formatSize(compareWindow.matchCount)}</span>
          {compareWindow.onlyLeft > 0 && (
            <>
              <span>·</span>
              <span className="text-amber-600 dark:text-amber-400">仅左侧 {formatSize(compareWindow.onlyLeft)}</span>
            </>
          )}
          {compareWindow.onlyRight > 0 && (
            <>
              <span>·</span>
              <span className="text-amber-600 dark:text-amber-400">仅右侧 {formatSize(compareWindow.onlyRight)}</span>
            </>
          )}
        </div>
      </div>

      {/* 左右双栏 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧 */}
        <div className="flex-1 min-w-0 border-r border-border flex flex-col">
          <div className="shrink-0 px-2 py-1 bg-muted/30 text-xs font-medium border-b border-border truncate">
            <span className="text-muted-foreground">Left: </span>
            {leftTitle}
            <span className="ml-2 text-muted-foreground/70">{formatHex(leftBaseAddress)} · {formatSize(leftBytes.length)}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <HexViewer
              bytes={compareWindow.left}
              baseAddress={compareWindow.start}
              byteWidth={byteWidth}
              presentMask={compareWindow.leftPresent}
              diffMask={compareWindow.diffMask}
              initialAddress={jumpAddress}
              onScrollSync={handleLeftScroll}
              syncScrollTop={leftSyncScroll}
            />
          </div>
        </div>

        {/* 右侧 */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="shrink-0 px-2 py-1 bg-muted/30 text-xs font-medium border-b border-border truncate">
            <span className="text-muted-foreground">Right: </span>
            {rightTitle}
            <span className="ml-2 text-muted-foreground/70">{formatHex(rightBaseAddress)} · {formatSize(rightBytes.length)}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <HexViewer
              bytes={compareWindow.right}
              baseAddress={compareWindow.start}
              byteWidth={byteWidth}
              presentMask={compareWindow.rightPresent}
              diffMask={compareWindow.diffMask}
              initialAddress={jumpAddress}
              onScrollSync={handleRightScroll}
              syncScrollTop={rightSyncScroll}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
