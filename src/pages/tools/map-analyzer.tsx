import { useState, useCallback, useRef, useEffect } from 'react'
import * as echarts from 'echarts'
import { Upload, FileText, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/services/api'
import { cn } from '@/lib/utils'
import { useToolsStore } from '@/stores/tools.store'

// ── 类型定义 ──────────────────────────────────

interface MapMeta {
  source_file: string
  component: string
  tool: string
  generated_at: string
}

interface MapSummary {
  code: number
  ro_data: number
  rw_data: number
  zi_data: number
  total_rom: number
  total_ram: number
  total_ro: number
  flash_used: number
  flash_capacity: number
  ram_used: number
  ram_capacity: number
}

interface MapRegion {
  name: string
  exec_base: number
  size: number
  max_size: number
}

interface MapEntry {
  name: string
  category: string
  kind: string
  library: string
  code: number
  ro_data: number
  rw_data: number
  zi_data: number
  rom: number
  ram: number
  stack?: number
}

interface MapCategory {
  name: string
  code: number
  ro_data: number
  rw_data: number
  zi_data: number
  rom: number
  ram: number
}

interface MapAnalysis {
  meta: MapMeta
  summary: MapSummary
  regions: MapRegion[]
  entries: MapEntry[]
  categories: MapCategory[]
  top_rom: MapEntry[]
  top_ram: MapEntry[]
  top_stack: MapEntry[]
}

type TabKey = 'rom' | 'ram' | 'stack' | 'all'

// ── 工具函数 ──────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatBytesCompact(bytes: number): string {
  if (bytes === 0) return '0'
  if (bytes < 1024) return `${bytes}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

const CATEGORY_COLORS: Record<string, string> = {
  'Code': '#3b82f6',
  'RO Data': '#06b6d4',
  'RW Data': '#22c55e',
  'ZI Data': '#a855f7',
  'Stack': '#f59e0b',
  'Heap': '#ef4444',
}

// ── 主组件 ──────────────────────────────────

export default function MapAnalyzer() {
  const [analysis, setAnalysis] = useState<MapAnalysis | null>(null)
  const [fileName, setFileName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 从持久化 store 读取配置
  const activeTab = useToolsStore((s) => s.maActiveTab) as TabKey
  const sortKey = useToolsStore((s) => s.maSortKey) as keyof MapEntry
  const sortDir = useToolsStore((s) => s.maSortDir)
  const setMaTab = useToolsStore((s) => s.setMaTab)
  const setMaSort = useToolsStore((s) => s.setMaSort)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ECharts refs
  const romDonutRef = useRef<HTMLDivElement>(null)
  const ramDonutRef = useRef<HTMLDivElement>(null)
  const categoryBarRef = useRef<HTMLDivElement>(null)
  const top20Ref = useRef<HTMLDivElement>(null)

  const handleFile = useCallback(async (file: File) => {
    setLoading(true)
    setError('')
    setFileName(file.name)
    setAnalysis(null)

    try {
      const content = await file.text()
      const client = await api()
      const { data } = await client.post('/api/tools/map-analyzer', {
        filename: file.name,
        content,
      })
      setAnalysis(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 尝试提取 FastAPI 错误详情
      const apiErr = e as { response?: { data?: { detail?: string } } }
      setError(apiErr.response?.data?.detail || msg || '解析失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleFile(file)
    e.target.value = ''
  }, [handleFile])

  // ── 图表渲染 ──────────────────────────────────

  // ROM 环形图
  useEffect(() => {
    if (!analysis || !romDonutRef.current) return
    const chart = echarts.init(romDonutRef.current)
    const data = [
      { name: 'Code', value: analysis.summary.code, itemStyle: { color: CATEGORY_COLORS['Code'] } },
      { name: 'RO Data', value: analysis.summary.ro_data, itemStyle: { color: CATEGORY_COLORS['RO Data'] } },
      { name: 'RW Data', value: analysis.summary.rw_data, itemStyle: { color: CATEGORY_COLORS['RW Data'] } },
    ].filter((d) => d.value > 0)
    chart.setOption({
      tooltip: { trigger: 'item', formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/>${formatBytes(p.value)} (${p.percent}%)` },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      series: [{
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        label: { show: true, formatter: '{b}\n{d}%', fontSize: 10 },
        data,
      }],
    })
    return () => chart.dispose()
  }, [analysis])

  // RAM 环形图
  useEffect(() => {
    if (!analysis || !ramDonutRef.current) return
    const chart = echarts.init(ramDonutRef.current)
    const data = [
      { name: 'RW Data', value: analysis.summary.rw_data, itemStyle: { color: CATEGORY_COLORS['RW Data'] } },
      { name: 'ZI Data', value: analysis.summary.zi_data, itemStyle: { color: CATEGORY_COLORS['ZI Data'] } },
    ].filter((d) => d.value > 0)
    chart.setOption({
      tooltip: { trigger: 'item', formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/>${formatBytes(p.value)} (${p.percent}%)` },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      series: [{
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        label: { show: true, formatter: '{b}\n{d}%', fontSize: 10 },
        data,
      }],
    })
    return () => chart.dispose()
  }, [analysis])

  // 分类柱状图（堆叠）
  useEffect(() => {
    if (!analysis || !categoryBarRef.current || analysis.categories.length === 0) return
    const chart = echarts.init(categoryBarRef.current)
    const cats = analysis.categories.slice(0, 15)
    chart.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      grid: { left: '3%', right: '4%', top: '3%', bottom: '15%', containLabel: true },
      xAxis: { type: 'category', data: cats.map((c) => c.name), axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: (v: number) => formatBytesCompact(v) } },
      series: [
        { name: 'Code', type: 'bar', stack: 'total', data: cats.map((c) => c.code), itemStyle: { color: CATEGORY_COLORS['Code'] } },
        { name: 'RO Data', type: 'bar', stack: 'total', data: cats.map((c) => c.ro_data), itemStyle: { color: CATEGORY_COLORS['RO Data'] } },
        { name: 'RW Data', type: 'bar', stack: 'total', data: cats.map((c) => c.rw_data), itemStyle: { color: CATEGORY_COLORS['RW Data'] } },
        { name: 'ZI Data', type: 'bar', stack: 'total', data: cats.map((c) => c.zi_data), itemStyle: { color: CATEGORY_COLORS['ZI Data'] } },
      ],
    })
    return () => chart.dispose()
  }, [analysis])

  // Top 20 柱状图
  useEffect(() => {
    if (!analysis || !top20Ref.current) return
    const chart = echarts.init(top20Ref.current)
    const top = activeTab === 'rom' ? analysis.top_rom : activeTab === 'ram' ? analysis.top_ram : analysis.top_stack
    const data = (top || []).slice(0, 20).reverse()
    chart.setOption({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: Array<{ name: string; value: number }>) => {
          const p = params[0]
          return `${p.name}<br/>${formatBytes(p.value)}`
        },
      },
      grid: { left: '3%', right: '6%', top: '3%', bottom: '3%', containLabel: true },
      xAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: (v: number) => formatBytesCompact(v) } },
      yAxis: { type: 'category', data: data.map((d) => d.name), axisLabel: { fontSize: 9, width: 200, overflow: 'truncate' } },
      series: [{
        type: 'bar',
        data: data.map((d) => (activeTab === 'rom' ? d.rom : activeTab === 'ram' ? d.ram : d.stack || 0)),
        itemStyle: {
          color: activeTab === 'rom' ? '#3b82f6' : activeTab === 'ram' ? '#22c55e' : '#f59e0b',
          borderRadius: [0, 3, 3, 0],
        },
      }],
    })
    return () => chart.dispose()
  }, [analysis, activeTab])

  // ── 表格数据（带排序）──────────────────────────

  const handleSort = useCallback((key: keyof MapEntry) => {
    if (sortKey === key) {
      setMaSort(key, sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setMaSort(key, 'desc')
    }
  }, [sortKey, sortDir, setMaSort])

  const tableData = (() => {
    if (!analysis) return []
    let data: MapEntry[]
    switch (activeTab) {
      case 'rom': data = analysis.top_rom; break
      case 'ram': data = analysis.top_ram; break
      case 'stack': data = analysis.top_stack; break
      case 'all': data = [...analysis.entries]; break
    }
    // 排序
    const sorted = [...data].sort((a, b) => {
      const av = (a[sortKey] as number | string) ?? 0
      const bv = (b[sortKey] as number | string) ?? 0
      let cmp: number
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv
      } else {
        cmp = String(av).localeCompare(String(bv))
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  })()

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      {/* 文件选择 */}
      <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border py-8 transition-colors hover:border-primary/50 hover:bg-muted/20">
        <FileText className="mb-3 h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">点击下方按钮选择 .map 文件</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
        >
          <Upload className="mr-1.5 h-4 w-4" />
          {loading ? '解析中...' : '选择文件'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".map,.txt"
          className="hidden"
          onChange={handleFileInput}
        />
        {fileName && (
          <p className="mt-2 text-xs text-muted-foreground">已加载: {fileName}</p>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>

      {/* 分析结果 */}
      {analysis && (
        <>
          {/* 元信息 */}
          <div className="flex flex-wrap gap-4 rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            <span>编译器: <span className="font-mono text-foreground">{analysis.meta.component || '—'}</span></span>
            <span>工具: <span className="font-mono text-foreground">{analysis.meta.tool || '—'}</span></span>
            <span>生成时间: <span className="font-mono text-foreground">{analysis.meta.generated_at || '—'}</span></span>
            <span>条目数: <span className="font-mono text-foreground">{analysis.entries.length}</span></span>
          </div>

          {/* 摘要卡片 */}
          <div className="grid grid-cols-6 gap-3">
            <SummaryCard label="ROM Total" value={analysis.summary.total_rom} color="text-primary" />
            <SummaryCard label="RAM Total" value={analysis.summary.total_ram} color="text-primary" />
            <SummaryCard label="Code" value={analysis.summary.code} color="text-primary" />
            <SummaryCard label="RO Data" value={analysis.summary.ro_data} color="text-primary" />
            <SummaryCard label="RW Data" value={analysis.summary.rw_data} color="text-primary" />
            <SummaryCard label="ZI Data" value={analysis.summary.zi_data} color="text-primary" />
          </div>

          {/* 内存区域使用率 */}
          {analysis.regions.length > 0 && (
            <div className="rounded-lg border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold">内存区域使用率</h3>
              <div className="space-y-3">
                {analysis.regions.map((region) => {
                  const pct = region.max_size > 0 ? (region.size / region.max_size) * 100 : 0
                  return (
                    <div key={region.name}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="font-mono font-medium">
                          {region.name} <span className="text-muted-foreground">@0x{region.exec_base.toString(16).toUpperCase()}</span>
                        </span>
                        <span className="text-muted-foreground">
                          {formatBytes(region.size)} / {formatBytes(region.max_size)} ({pct.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-yellow-500' : 'bg-primary'
                          )}
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 环形图 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-border p-4">
              <h3 className="mb-2 text-sm font-semibold">ROM 构成</h3>
              <div ref={romDonutRef} className="h-64 w-full" />
            </div>
            <div className="rounded-lg border border-border p-4">
              <h3 className="mb-2 text-sm font-semibold">RAM 构成</h3>
              <div ref={ramDonutRef} className="h-64 w-full" />
            </div>
          </div>

          {/* 分类堆叠柱状图 */}
          <div className="rounded-lg border border-border p-4">
            <h3 className="mb-2 text-sm font-semibold">分类占用（Top 15）</h3>
            <div ref={categoryBarRef} className="h-72 w-full" />
          </div>

          {/* Top 20 柱状图 */}
          <div className="rounded-lg border border-border p-4">
            <h3 className="mb-2 text-sm font-semibold">
              Top 20 — {activeTab === 'rom' ? 'ROM' : activeTab === 'ram' ? 'RAM' : 'Stack'}
            </h3>
            <div ref={top20Ref} className="h-96 w-full" />
          </div>

          {/* 表格 */}
          <div className="rounded-lg border border-border">
            <div className="flex border-b border-border">
              {([
                { key: 'rom', label: 'Top ROM' },
                { key: 'ram', label: 'Top RAM' },
                { key: 'stack', label: 'Top Stack' },
                { key: 'all', label: '全部条目' },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setMaTab(tab.key)}
                  className={cn(
                    'px-4 py-2 text-sm font-medium transition-colors',
                    activeTab === tab.key
                      ? 'border-b-2 border-primary text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <SortHeader label="名称" sortKey="name" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 pl-3 pr-2" />
                    <SortHeader label="类别" sortKey="category" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 px-2" />
                    <SortHeader label="Code" sortKey="code" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 px-2 text-right" align="right" />
                    <SortHeader label="RO" sortKey="ro_data" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 px-2 text-right" align="right" />
                    <SortHeader label="RW" sortKey="rw_data" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 px-2 text-right" align="right" />
                    <SortHeader label="ZI" sortKey="zi_data" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 px-2 text-right" align="right" />
                    <SortHeader label="ROM" sortKey="rom" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 px-2 text-right" align="right" />
                    <SortHeader label="RAM" sortKey="ram" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 px-2 text-right" align="right" />
                    {activeTab === 'stack' && <SortHeader label="Stack" sortKey="stack" currentSort={sortKey} sortDir={sortDir} onSort={handleSort} className="py-2 pr-3 text-right" align="right" />}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {tableData.slice(0, 200).map((entry, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="py-1.5 pl-3 pr-2 text-primary" title={entry.name}>
                        <span className="block max-w-xs truncate">{entry.name}</span>
                      </td>
                      <td className="py-1.5 px-2 text-muted-foreground">{entry.category}</td>
                      <td className="py-1.5 px-2 text-right">{entry.code > 0 ? formatBytesCompact(entry.code) : '-'}</td>
                      <td className="py-1.5 px-2 text-right">{entry.ro_data > 0 ? formatBytesCompact(entry.ro_data) : '-'}</td>
                      <td className="py-1.5 px-2 text-right">{entry.rw_data > 0 ? formatBytesCompact(entry.rw_data) : '-'}</td>
                      <td className="py-1.5 px-2 text-right">{entry.zi_data > 0 ? formatBytesCompact(entry.zi_data) : '-'}</td>
                      <td className="py-1.5 px-2 text-right text-primary">{entry.rom > 0 ? formatBytesCompact(entry.rom) : '-'}</td>
                      <td className="py-1.5 px-2 text-right text-primary">{entry.ram > 0 ? formatBytesCompact(entry.ram) : '-'}</td>
                      {activeTab === 'stack' && (
                        <td className="py-1.5 pr-3 text-right text-primary">
                          {entry.stack ? formatBytesCompact(entry.stack) : '-'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {tableData.length > 200 && (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  仅显示前 200 项（共 {tableData.length} 项）
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-lg font-bold font-mono', color)}>{formatBytes(value)}</div>
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  currentSort,
  sortDir,
  onSort,
  className,
  align,
}: {
  label: string
  sortKey: keyof MapEntry
  currentSort: keyof MapEntry
  sortDir: 'asc' | 'desc'
  onSort: (key: keyof MapEntry) => void
  className?: string
  align?: 'right'
}) {
  const isActive = currentSort === sortKey
  return (
    <th className={className}>
      <button
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 font-medium transition-colors hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
          isActive && 'text-primary'
        )}
      >
        {label}
        {isActive ? (
          sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </th>
  )
}
