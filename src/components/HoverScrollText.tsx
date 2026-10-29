import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  text: string
  className?: string
}

/**
 * 单行文本；仅当内容超出容器宽度时，hover 才横向来回滚动显示。
 * 未溢出时保持静态（同时提供原生 title 兜底）。
 */
export function HoverScrollText({ text, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const [distance, setDistance] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const overflow = el.scrollWidth - el.clientWidth
      setDistance(overflow > 1 ? overflow : 0)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])

  return (
    <span
      ref={ref}
      title={text}
      className={cn('group/scroll block overflow-hidden whitespace-nowrap', className)}
      style={{ '--marquee-distance': `${distance}px` } as CSSProperties}
    >
      <span className={cn('inline-block', distance > 0 && 'group-hover/scroll:animate-marquee')}>
        {text}
      </span>
    </span>
  )
}