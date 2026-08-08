import { useEffect, useRef, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { useZoneStore } from '../store'
import * as zoneService from '@/services/zone.service'

interface SourceViewProps {
  uid: string | null
}

/** 源码视图：行号 + PC 高亮 + 断点红点（文件选择由左侧 Source Files 面板完成） */
export function SourceView({ uid }: SourceViewProps) {
  const activeSourceFile = useZoneStore((s) => s.activeSourceFile)
  const pc = useZoneStore((s) => s.pc)
  const state = useZoneStore((s) => s.state)

  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pcLine, setPcLine] = useState<number | null>(null)
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // 加载选中的源文件
  useEffect(() => {
    if (!uid || !activeSourceFile) {
      setLines([])
      setPcLine(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    zoneService
      .zoneSourceContent(uid, activeSourceFile)
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setLines(res.lines ?? [])
        } else {
          setLines([])
          setError(res.error ?? '源码读取失败')
        }
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '源码读取失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [uid, activeSourceFile])

  // 根据 PC 定位源码行
  useEffect(() => {
    if (!uid || pc === null || pc === undefined) {
      setPcLine(null)
      return
    }
    let cancelled = false
    zoneService
      .zoneSourceLine(uid, pc)
      .then((line) => {
        if (cancelled) return
        if (line && line.file) {
          const targetFile = line.file.replace(/\\/g, '/')
          const cur = (activeSourceFile ?? '').replace(/\\/g, '/')
          if (targetFile === cur || targetFile.endsWith(cur) || cur.endsWith(targetFile)) {
            setPcLine(line.line ?? null)
            requestAnimationFrame(() => {
              const el = lineRefs.current.get(line.line ?? -1)
              el?.scrollIntoView({ block: 'center', behavior: 'auto' })
            })
          } else {
            setPcLine(null)
          }
        } else {
          setPcLine(null)
        }
      })
      .catch(() => setPcLine(null))
    return () => {
      cancelled = true
    }
  }, [uid, pc, activeSourceFile, state])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-relaxed">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载中...
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center gap-2 text-red-500">
            <AlertCircle className="size-4" />
            <span className="max-w-md truncate">{error}</span>
          </div>
        ) : lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            请在左侧 Source Files 面板选择源码文件
          </div>
        ) : (
          lines.map((content, idx) => {
            const lineNo = idx + 1
            const isPcLine = lineNo === pcLine
            return (
              <div
                key={lineNo}
                ref={(el) => {
                  if (el) lineRefs.current.set(lineNo, el)
                  else lineRefs.current.delete(lineNo)
                }}
                className={
                  isPcLine
                    ? 'flex border-b border-primary/20 bg-primary/10'
                    : 'flex border-b border-transparent hover:bg-muted/30'
                }
              >
                {/* 断点列 + 行号 */}
                <div className="sticky left-0 flex w-14 shrink-0 select-none items-center gap-1 bg-background pr-1 text-right">
                  <span className="w-2 shrink-0 text-red-500">•</span>
                  <span className={isPcLine ? 'font-bold text-primary' : 'text-muted-foreground'}>
                    {lineNo}
                  </span>
                </div>
                {/* 代码 */}
                <pre className="flex-1 whitespace-pre pr-4">{content || ' '}</pre>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}