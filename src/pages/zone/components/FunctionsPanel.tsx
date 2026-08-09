import { useEffect, useState, useCallback } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { zoneFunctions } from '@/services/zone.service'
import { useZoneStore } from '../store'

interface FuncRow {
  name: string
  address: number
  size: number
}

function fmtAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * 左侧 Functions 窗口：函数符号表（Name / Address / Size）。
 * 支持关键字过滤（防抖），点击行跳转主源码视图到对应函数地址。
 */
export function FunctionsPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const [filter, setFilter] = useState('')
  const [functions, setFunctions] = useState<FuncRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setActiveSourceFile = useZoneStore((s) => s.setActiveSourceFile)

  const load = useCallback(async () => {
    if (!uid) {
      setFunctions([])
      setTotal(0)
      return
    }
    setLoading(true)
    try {
      const res = await zoneFunctions(uid, filter, 0, 500)
      setFunctions(res.functions)
      setTotal(res.total)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed')
    } finally {
      setLoading(false)
    }
  }, [uid, filter])

  // 过滤防抖
  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 过滤输入框 */}
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter functions..."
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      {/* 函数表 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-3 text-xs text-red-500">{error}</div>
        ) : !connected ? (
          <div className="min-h-0 flex-1" />
        ) : !uid ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
            未加载 ELF
          </div>
        ) : loading && functions.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
            Loading...
          </div>
        ) : functions.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
            {total === 0 ? 'ELF 无符号表' : `无匹配「${filter}」的函数`}
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="sticky top-0 z-10 bg-card px-2 py-1 font-medium">Name</th>
                <th className="sticky top-0 z-10 bg-card px-2 py-1 text-right font-medium">Address</th>
                <th className="sticky top-0 z-10 bg-card px-2 py-1 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {functions.map((fn) => (
                <tr
                  key={`${fn.address}-${fn.name}`}
                  onClick={() => setActiveSourceFile(null)}
                  className="cursor-pointer text-xs hover:bg-accent"
                  title={`${fn.name}\n${fmtAddr(fn.address)}  size=${fn.size}`}
                >
                  <td className="max-w-0 truncate px-2 py-1 font-mono">{fn.name}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
                    {fmtAddr(fn.address)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
                    {fn.size}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}