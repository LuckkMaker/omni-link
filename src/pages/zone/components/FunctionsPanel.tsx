import { useEffect, useState, useCallback, useMemo } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { zoneFunctions, zoneSourceLine } from '@/services/zone.service'
import { useZoneStore } from '../store'
import { cn } from '@/lib/utils'
import { gridColumns, TableHeaderCell, useColumnResize, useColumnSort, type ColumnDef } from './sortableTable'

interface FuncRow {
  name: string
  address: number
  size: number
  file?: string | null
  line?: number | null
}

function fmtAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/** 取源码文件 basename（用于 Source 列紧凑显示） */
function baseName(p: string | null | undefined): string {
  if (!p) return ''
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/** 将源码路径归一化为可比较形态（统一 / 分隔、去尾部 /） */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 左侧 Functions 窗口：函数符号表（Name / Address / Size / Source）。
 * 支持关键字过滤（防抖），点击表头可排序，拖拽表头右边框可调整列宽。
 */
export function FunctionsPanel({ uid, connected }: { uid: string | null; connected: boolean }) {
  const [filter, setFilter] = useState('')
  const [functions, setFunctions] = useState<FuncRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sourceFiles = useZoneStore((s) => s.sourceFiles)
  const gotoSource = useZoneStore((s) => s.gotoSource)
  const elfPath = useZoneStore((s) => s.elfPath)

  /** 点击函数行：解析函数地址对应的源码位置，跳转主源码视图到该行 */
  const gotoFunction = useCallback(
    async (fn: FuncRow) => {
      if (!uid) return
      try {
        // 优先用行内已带有的源码位置，缺失时再向后端解析一次
        let file = fn.file
        let ln = fn.line
        if (file == null || ln == null) {
          const line = await zoneSourceLine(uid, fn.address)
          if (!line?.file || line.line == null) return
          file = line.file
          ln = line.line
        }
        // file 可能是 basename，先在源文件列表中定位完整路径
        const base = norm(file)
        const full =
          sourceFiles.find((f) => {
            const fp = norm(f.path)
            return fp === base || fp.endsWith('/' + base) || base.endsWith('/' + fp)
          })?.path ?? file
        gotoSource(full, ln)
      } catch {
        // 无源码信息时忽略跳转
      }
    },
    [uid, sourceFiles, gotoSource]
  )

  const load = useCallback(async () => {
    // ELF 未加载时不请求后端，避免 No ELF loaded 的 400 报错
    if (!uid || !elfPath) {
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
      // 优先展示后端 FastAPI 返回的 detail，便于定位真实原因
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : e instanceof Error ? e.message : 'load failed')
    } finally {
      setLoading(false)
    }
  }, [uid, filter, elfPath])

  // 过滤防抖
  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const columns = useMemo<ColumnDef<FuncRow>[]>(
    () => [
      {
        key: 'name',
        label: 'Name',
        width: 220,
        minWidth: 100,
        sortValue: (f) => f.name,
        cell: (f) => <span className="font-mono">{f.name}</span>,
        cellClassName: () => 'min-w-0 truncate',
      },
      {
        key: 'address',
        label: 'Address',
        width: 110,
        minWidth: 70,
        sortValue: (f) => f.address,
        cell: (f) => <span className="font-mono text-xs">{fmtAddr(f.address)}</span>,
      },
      {
        key: 'size',
        label: 'Size',
        width: 80,
        minWidth: 60,
        sortValue: (f) => f.size,
        cell: (f) => <span className="font-mono text-xs">{f.size}</span>,
      },
      {
        key: 'source',
        label: 'Source',
        width: 200,
        minWidth: 120,
        sortValue: (f) => (f.file ? `${baseName(f.file)}:${f.line ?? 0}` : ''),
        cell: (f) =>
          f.file && f.line != null ? (
            <span className="font-mono text-xs text-muted-foreground">
              {baseName(f.file)}:{f.line}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/40">—</span>
          ),
        cellClassName: () => 'min-w-0 truncate',
      },
    ],
    []
  )

  const { sorted, sort, toggle } = useColumnSort(functions, columns)
  const { widths, startResize } = useColumnResize(columns)
  const template = gridColumns(columns, widths)

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
        ) : !uid || !elfPath ? (
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
          <>
            {/* 表头（sticky，点击排序 / 拖拽调宽） */}
            <div className="sticky top-0 z-10 grid min-w-max border-b border-border" style={{ gridTemplateColumns: template }}>
              {columns.map((c) => (
                <TableHeaderCell key={c.key} col={c as ColumnDef<unknown>} sort={sort} onSort={toggle} onResize={startResize} />
              ))}
            </div>
            {sorted.map((fn) => (
              <div
                key={`${fn.address}-${fn.name}`}
                onClick={() => void gotoFunction(fn)}
                className="grid min-w-max cursor-pointer border-b border-border text-xs hover:bg-accent"
                style={{ gridTemplateColumns: template }}
                title={`${fn.name}\n${fmtAddr(fn.address)}  size=${fn.size}`}
              >
                {columns.map((c) => (
                  <div
                    key={c.key}
                    className={cn('min-w-0 whitespace-nowrap border-r border-border px-2 py-1 last:border-r-0', c.cellClassName?.(fn))}
                  >
                    {c.cell(fn)}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}