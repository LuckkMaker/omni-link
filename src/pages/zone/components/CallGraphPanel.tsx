import { useCallback, useEffect, useState } from 'react'
import { Share2, ChevronRight, ChevronDown, RefreshCw, Loader2, AlertCircle, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { zoneCallGraph, zoneFunctions, zoneStack, type CallGraphCallee } from '@/services/zone.service'
import { useZoneStore } from '../store'

interface CallGraphPanelProps {
  uid: string | null
}

interface GNode {
  name: string
  address: number
  size: number
  depth: number
  children: GNode[]
  loaded: boolean
  loading: boolean
}

function fmtAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * 底部 Call Graph tab：调用图（树形下钻）。
 * 根节点默认取当前 PC 所在函数，可点击节点展开其直接 callees。
 */
export function CallGraphPanel({ uid }: CallGraphPanelProps) {
  const pc = useZoneStore((s) => s.pc)
  const elfPath = useZoneStore((s) => s.elfPath)

  const [root, setRoot] = useState<GNode | null>(null)
  const [rootLabel, setRootLabel] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [pickResults, setPickResults] = useState<{ name: string; address: number; size: number }[]>([])

  const buildNode = useCallback(
    (callee: CallGraphCallee, depth: number): GNode => ({
      name: callee.name,
      address: callee.address,
      size: callee.size,
      depth,
      children: [],
      loaded: false,
      loading: false,
    }),
    []
  )

  const loadChildren = useCallback(
    async (node: GNode) => {
      if (!uid || node.loaded || node.loading) return
      node.loading = true
      try {
        const res = await zoneCallGraph(uid, node.address)
        node.children = res.callees.map((c) => buildNode(c, node.depth + 1))
        node.loaded = true
      } catch {
        node.loaded = true
      } finally {
        node.loading = false
      }
      // 触发重渲染
      setRoot((r) => (r ? { ...r } : r))
    },
    [uid, buildNode]
  )

  // 默认根：当前 PC 所在函数
  useEffect(() => {
    if (!uid || !elfPath) {
      setRoot(null)
      setRootLabel('')
      return
    }
    if (root) return
    let cancelled = false
    const init = async () => {
      setLoading(true)
      setError(null)
      try {
        let addr: number | null = null
        try {
          const st = await zoneStack(uid)
          const top = st.frames?.[0]
          if (top?.function_address) addr = top.function_address
          else if (top?.address) addr = top.address
        } catch {
          // 未暂停则用 PC
        }
        if (cancelled) return
        if (addr === null && pc) addr = pc
        if (addr === null) throw new Error('无法定位起始函数')
        const res = await zoneCallGraph(uid, addr)
        const n = buildNode({ name: res.function.name, address: res.function.address, size: res.function.size }, 0)
        n.children = res.callees.map((c) => buildNode(c, 1))
        n.loaded = true
        setRoot(n)
        setRootLabel(`${res.function.name} @ ${fmtAddr(res.function.address)}`)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载调用图失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void init()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, elfPath, pc])

  // 函数搜索（选择根）
  const onSearch = useCallback(
    async (q: string) => {
      setFilter(q)
      if (!uid || !q.trim()) {
        setPickResults([])
        return
      }
      try {
        const res = await zoneFunctions(uid, q.trim(), 0, 30)
        setPickResults(res.functions)
      } catch {
        setPickResults([])
      }
    },
    [uid]
  )

  const pickRoot = useCallback(
    async (name: string, address: number) => {
      if (!uid) return
      setFilter('')
      setPickResults([])
      setLoading(true)
      setError(null)
      try {
        const res = await zoneCallGraph(uid, address)
        const n = buildNode({ name: res.function.name, address: res.function.address, size: res.function.size }, 0)
        n.children = res.callees.map((c) => buildNode(c, 1))
        n.loaded = true
        setRoot(n)
        setRootLabel(`${name} @ ${fmtAddr(address)}`)
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载调用图失败')
      } finally {
        setLoading(false)
      }
    },
    [uid, buildNode]
  )

  const resetRoot = useCallback(() => {
    setRoot(null)
    setRootLabel('')
    setError(null)
  }, [])

  const renderNode = (node: GNode) => {
    const expanded = node.loaded && node.children.length > 0
    return (
      <div key={`${node.address}-${node.depth}`}>
        <div
          className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-muted/30"
          style={{ paddingLeft: 8 + node.depth * 16 }}
        >
          <button
            className={
              node.children.length > 0
                ? 'flex h-4 w-4 items-center text-muted-foreground'
                : 'flex h-4 w-4 items-center text-transparent'
            }
            onClick={() => void loadChildren(node)}
            title={node.children.length > 0 ? '展开/收起' : '无子节点'}
          >
            {node.loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : node.children.length > 0 ? (
              expanded ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )
            ) : (
              <ChevronRight className="size-3" />
            )}
          </button>
          <span className="font-mono text-xs">{node.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground/70">{fmtAddr(node.address)}</span>
          {node.children.length > 0 ? (
            <span className="text-[10px] text-muted-foreground/50">({node.children.length})</span>
          ) : null}
        </div>
        {expanded && <div className="border-l border-border/40">{node.children.map(renderNode)}</div>}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1">
        <Share2 className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">调用图</span>
        {rootLabel && <span className="truncate text-[10px] text-muted-foreground">{rootLabel}</span>}
        <div className="ml-auto flex items-center gap-1">
          {root && (
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
              onClick={resetRoot}
              title="回到当前 PC 函数"
            >
              重置
            </button>
          )}
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            onClick={resetRoot}
            disabled={!uid}
            title="刷新"
          >
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 根函数搜索 */}
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => void onSearch(e.target.value)}
            placeholder="搜索函数作为根节点..."
            className="h-7 pl-7 text-xs"
          />
        </div>
        {pickResults.length > 0 && (
          <div className="mt-1 max-h-40 overflow-auto rounded border border-border bg-popover">
            {pickResults.map((f) => (
              <button
                key={`${f.address}-${f.name}`}
                onClick={() => void pickRoot(f.name, f.address)}
                className="flex w-full items-center justify-between px-2 py-1 text-left text-xs hover:bg-accent"
              >
                <span className="truncate font-mono">{f.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{fmtAddr(f.address)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!uid || !elfPath ? (
          <Empty text="未加载 ELF" />
        ) : error ? (
          <Empty text={error} isError />
        ) : !root ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            分析调用图...
          </div>
        ) : (
          <div className="py-1">{renderNode(root)}</div>
        )}
      </div>
    </div>
  )
}

function Empty({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <div
      className={
        isError
          ? 'flex h-full items-center justify-center gap-2 p-4 text-red-500'
          : 'flex h-full items-center justify-center p-4 text-center text-muted-foreground'
      }
    >
      {isError ? <AlertCircle className="size-4 shrink-0" /> : null}
      <span className="max-w-md truncate">{text}</span>
    </div>
  )
}