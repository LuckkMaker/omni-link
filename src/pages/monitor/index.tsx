import { useEffect, useState, useCallback, useRef } from 'react'
import { Activity, Download, X } from 'lucide-react'
import { useProbeStore } from '@/stores/probe.store'
import { useMonitorStore } from '@/stores/monitor.store'
import { useNotificationStore } from '@/stores/notification.store'
import { monitorService, type SamplePoint } from '@/services/monitor.service'
import { wsClient } from '@/services/ws'
import { ChannelPanel } from './components/ChannelPanel'
import { WatchPanel } from './components/WatchPanel'
import { WaveformChart, type CursorMeasurement } from './components/WaveformChart'
import { ResizeHandle } from '@/components/LogConsole'

const SIDEBAR_DEFAULT_WIDTH = 360
const SIDEBAR_MAX_RATIO = 0.4
const WATCH_DEFAULT_HEIGHT = 180

function getSidebarMaxWidth(): number {
  return Math.floor((window.innerWidth ?? 1280) * SIDEBAR_MAX_RATIO)
}

export default function MonitorPage() {
  const selectedProbe = useProbeStore((s) => {
    const uid = s.selectedUid
    return uid ? s.probes.find((p) => p.uid === uid) ?? null : null
  })
  const isConnected = selectedProbe?.state === 'connected'
  const uid = selectedProbe?.uid ?? null

  const running = useMonitorStore((s) => s.running)
  const paused = useMonitorStore((s) => s.paused)
  const error = useMonitorStore((s) => s.error)
  const rateHz = useMonitorStore((s) => s.rateHz)
  const variables = useMonitorStore((s) => s.variables)
  const samples = useMonitorStore((s) => s.samples)
  const channels = useMonitorStore((s) => s.channels)
  const follow = useMonitorStore((s) => s.follow)
  const setFollow = useMonitorStore((s) => s.setFollow)
  const timebase = useMonitorStore((s) => s.timebase)
  const setTimebase = useMonitorStore((s) => s.setTimebase)
  const fps = useMonitorStore((s) => s.fps)
  const coreState = useMonitorStore((s) => s.coreState)
  const setCoreState = useMonitorStore((s) => s.setCoreState)

  const setRunning = useMonitorStore((s) => s.setRunning)
  const setPaused = useMonitorStore((s) => s.setPaused)
  const setStarting = useMonitorStore((s) => s.setStarting)
  const setError = useMonitorStore((s) => s.setError)
  const setRateHz = useMonitorStore((s) => s.setRateHz)
  const setActualRateHz = useMonitorStore((s) => s.setActualRateHz)
  const appendSamples = useMonitorStore((s) => s.appendSamples)
  const clearSamples = useMonitorStore((s) => s.clearSamples)

  const pushNotification = useNotificationStore((s) => s.push)
  const updateNotification = useNotificationStore((s) => s.update)

  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [watchHeight, setWatchHeight] = useState(WATCH_DEFAULT_HEIGHT)
  const [cursorMeasure, setCursorMeasure] = useState<CursorMeasurement | null>(null)
  /** 鼠标游标位置的采样值及索引（JScope 风格：鼠标悬停波形图时显示对应位置的值） */
  const [cursorData, setCursorData] = useState<{ values: Map<string, number | null>; sampleIndex: number } | null>(null)
  const notifIdRef = useRef<string | null>(null)

  // ── 初始化：拉取状态与变量列表 ──
  useEffect(() => {
    if (!uid) return
    monitorService.status(uid).then((st) => {
      setRunning(st.running)
      setPaused(st.paused)
      if (st.rate_hz > 0) setRateHz(st.rate_hz)
      if (st.actual_rate_hz !== undefined) setActualRateHz(st.actual_rate_hz)
    }).catch(() => { /* ignore */ })
    monitorService.getVariables(uid).then((res) => {
      useMonitorStore.getState().setVariables(res.variables)
    }).catch(() => { /* ignore */ })
  }, [uid, setRunning, setPaused, setRateHz, setActualRateHz])

  // ── 运行中定期刷新实际采样率 ──
  useEffect(() => {
    if (!uid || !running) return
    const timer = setInterval(() => {
      monitorService.status(uid).then((st) => {
        if (st.actual_rate_hz !== undefined) setActualRateHz(st.actual_rate_hz)
      }).catch(() => { /* ignore */ })
    }, 2000)
    return () => clearInterval(timer)
  }, [uid, running, setActualRateHz])

  // ── 目标内核状态轮询（连接时定期查询 Run/Halt 状态）──
  useEffect(() => {
    if (!uid || !isConnected) return
    const poll = async () => {
      try {
        const r = await monitorService.deviceState(uid)
        if (r.success) {
          setCoreState(r.state === 'running' ? 'running' : r.state === 'halted' ? 'halted' : 'unknown')
        }
      } catch { /* ignore */ }
    }
    poll()
    const timer = setInterval(poll, 3000)
    return () => clearInterval(timer)
  }, [uid, isConnected, setCoreState])

  // ── WebSocket 事件订阅 ──
  useEffect(() => {
    if (!uid) return

    const offSample = wsClient.on('monitor.sample', (data: unknown) => {
      const payload = data as { uid: string; samples: SamplePoint[] }
      if (payload.uid !== uid) return
      appendSamples(payload.samples)
    })

    const offStarted = wsClient.on('monitor.started', (data: unknown) => {
      const payload = data as { uid: string; rate_hz: number; transport: string }
      if (payload.uid !== uid) return
      setRunning(true)
      setPaused(false)
      setStarting(false)
      if (notifIdRef.current) {
        updateNotification(notifIdRef.current, {
          type: 'success',
          title: 'Monitor 采样已启动',
          message: `${payload.rate_hz} Hz / ${payload.transport}`,
          autoClose: true,
          autoCloseDelay: 3000,
        })
        notifIdRef.current = null
      }
    })

    const offStopped = wsClient.on('monitor.stopped', (data: unknown) => {
      const payload = data as { uid: string; reason: string }
      if (payload.uid !== uid) return
      setRunning(false)
      setPaused(false)
      setStarting(false)
    })

    const offError = wsClient.on('monitor.error', (data: unknown) => {
      const payload = data as { uid: string; error: string }
      if (payload.uid !== uid) return
      setError(payload.error)
      pushNotification({
        type: 'error',
        title: 'Monitor 错误',
        message: payload.error,
        autoClose: false,
      })
    })

    const offInfo = wsClient.on('monitor.info', (data: unknown) => {
      const payload = data as { uid: string; paused: boolean }
      if (payload.uid !== uid) return
      setPaused(payload.paused)
    })

    return () => { offSample(); offStarted(); offStopped(); offError(); offInfo() }
  }, [uid, appendSamples, setRunning, setPaused, setStarting, setError, updateNotification, pushNotification])

  // ── 采样控制：启动/暂停/停止 ──
  const handleStartPause = useCallback(async () => {
    if (!uid) return
    if (running && !paused) {
      // 运行中 → 暂停
      try {
        await monitorService.pause(uid)
        setPaused(true)
        pushNotification({
          type: 'info', title: '采样已暂停',
          message: '', autoClose: true, autoCloseDelay: 2000,
        })
      } catch (e) {
        pushNotification({
          type: 'error', title: '暂停失败',
          message: e instanceof Error ? e.message : String(e),
          autoClose: true, autoCloseDelay: 3000,
        })
      }
    } else if (running && paused) {
      // 已暂停 → 继续
      try {
        await monitorService.resume(uid)
        setPaused(false)
        pushNotification({
          type: 'info', title: '采样已恢复',
          message: '', autoClose: true, autoCloseDelay: 2000,
        })
      } catch (e) {
        pushNotification({
          type: 'error', title: '恢复失败',
          message: e instanceof Error ? e.message : String(e),
          autoClose: true, autoCloseDelay: 3000,
        })
      }
    } else {
      // 未运行 → 启动
      if (variables.length === 0) {
        pushNotification({
          type: 'warning', title: '请先添加监视变量',
          message: '在右侧边栏加载 ELF 文件并选择变量',
          autoClose: true, autoCloseDelay: 4000,
        })
        return
      }
      setStarting(true)
      setError(null)
      setFollow(true)
      clearSamples()
      notifIdRef.current = pushNotification({
        type: 'progress', title: 'Monitor 采样启动中',
        message: `正在以 ${rateHz} Hz 启动采样...`,
      })
      try {
        const result = await monitorService.start(uid, { rate_hz: rateHz })
        if (!result.success) {
          setStarting(false)
          if (notifIdRef.current) {
            updateNotification(notifIdRef.current, {
              type: 'error', title: 'Monitor 启动失败',
              message: '未知错误', autoClose: true, autoCloseDelay: 5000,
            })
            notifIdRef.current = null
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStarting(false)
        setError(msg)
        if (notifIdRef.current) {
          updateNotification(notifIdRef.current, {
            type: 'error', title: 'Monitor 启动失败',
            message: msg, autoClose: true, autoCloseDelay: 5000,
          })
          notifIdRef.current = null
        }
      }
    }
  }, [uid, running, paused, variables.length, rateHz, setPaused, setStarting, setError, setFollow, clearSamples, pushNotification, updateNotification])

  const handleStop = useCallback(async () => {
    if (!uid) return
    try {
      await monitorService.stop(uid)
      setRunning(false)
      setPaused(false)
      setFollow(false)
      pushNotification({
        type: 'info', title: 'Monitor 采样已停止',
        message: '', autoClose: true, autoCloseDelay: 2000,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      pushNotification({
        type: 'error', title: '停止采样失败',
        message: msg, autoClose: false,
      })
    }
  }, [uid, setRunning, setPaused, setFollow, setError, pushNotification])

  // ── 目标设备控制：Run/Halt/Reset ──
  // 直接操作 CPU 内核，不影响采样线程（采样继续绘图）
  const handleToggleDevice = useCallback(async () => {
    if (!uid) return
    try {
      if (coreState === 'running') {
        await monitorService.deviceHalt(uid)
        setCoreState('halted')
      } else {
        await monitorService.deviceRun(uid)
        setCoreState('running')
      }
    } catch (e) {
      pushNotification({
        type: 'error', title: '设备控制失败',
        message: e instanceof Error ? e.message : String(e),
        autoClose: true, autoCloseDelay: 3000,
      })
    }
  }, [uid, coreState, setCoreState, pushNotification])

  const handleReset = useCallback(async () => {
    if (!uid) return
    try {
      const result = await monitorService.deviceReset(uid, true)
      setCoreState(result.state === 'halted' ? 'halted' : 'running')
      pushNotification({
        type: 'info', title: '目标已复位',
        message: '', autoClose: true, autoCloseDelay: 2000,
      })
    } catch (e) {
      pushNotification({
        type: 'error', title: '复位失败',
        message: e instanceof Error ? e.message : String(e),
        autoClose: true, autoCloseDelay: 3000,
      })
    }
  }, [uid, setCoreState, pushNotification])

  // ── 侧边栏拖拽 ──
  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.max(0, Math.min(getSidebarMaxWidth(), w - delta)))
  }, [])
  const handleToggleSidebar = useCallback(() => {
    setSidebarWidth((w) => (w > 0 ? 0 : getSidebarMaxWidth()))
  }, [])

  // ── Watch 面板高度拖拽 ──
  const handleWatchResize = useCallback((deltaY: number) => {
    setWatchHeight((h) => Math.max(0, Math.min(window.innerHeight / 2, h - deltaY)))
  }, [])

  // ── CSV 导出 ──
  const handleExportCsv = useCallback(async () => {
    if (!uid) return
    try {
      const result = await monitorService.exportCsv(uid)
      if (result.success && result.csv) {
        const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `monitor_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
        a.click()
        URL.revokeObjectURL(url)
        pushNotification({
          type: 'success', title: 'CSV 导出成功',
          message: `${result.count} 个采样点`,
          autoClose: true, autoCloseDelay: 3000,
        })
      }
    } catch (e) {
      pushNotification({
        type: 'error', title: '导出失败',
        message: e instanceof Error ? e.message : String(e),
        autoClose: true, autoCloseDelay: 3000,
      })
    }
  }, [uid, pushNotification])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── 主区域（顶部栏已移除，采样率/Follow/启停移至右侧 ChannelPanel 工具栏）── */}
      <div className="flex min-h-0 flex-1">
        {/* 左：波形/数据流区 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 波形显示区 */}
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/20 p-2">
            {!isConnected ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  {uid ? '仿真器未连接' : '请选择并连接仿真器'}
                </p>
              </div>
            ) : variables.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2">
                <Activity className="size-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">尚未添加监视变量</p>
                <p className="text-xs text-muted-foreground/70">在右侧边栏加载 ELF 文件并选择变量</p>
              </div>
            ) : !running && samples.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2">
                <Activity className="size-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {variables.length} 个变量就绪，点击"启动"开始采样
                </p>
                <p className="text-xs text-muted-foreground/70">
                  {rateHz >= 1000 ? `${(rateHz / 1000).toFixed(0)} kHz` : `${rateHz} Hz`} · SWD 轮询模式
                  {coreState === 'halted' && ' · 内核已暂停'}
                </p>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                {/* 波形工具条 */}
                <div className="mb-1 flex items-center justify-end gap-3 px-1">
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={handleExportCsv}
                    title="导出 CSV"
                  >
                    <Download className="size-3" />
                    CSV
                  </button>
                  <button
                    className="text-xs text-primary hover:underline"
                    onClick={clearSamples}
                  >
                    清空
                  </button>
                </div>
                {/* uPlot 波形图 */}
                <div className="min-h-0 flex-1 overflow-hidden rounded border border-border bg-background">
                  <WaveformChart
                    variables={variables}
                    channels={channels}
                    samples={samples}
                    follow={follow}
                    paused={paused}
                    windowSec={timebase}
                    fps={fps}
                    className="h-full w-full"
                    onCursorSelect={setCursorMeasure}
                    onTimebaseChange={setTimebase}
                    onFollowChange={setFollow}
                    onCursorValueChange={setCursorData}
                  />
                </div>
                {/* 游标测量结果 */}
                {cursorMeasure && (
                  <div className="mt-1 rounded border border-primary/30 bg-primary/5 p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[10px] font-medium text-primary">
                        游标测量 · Δt = {(cursorMeasure.t2 - cursorMeasure.t1).toFixed(3)}s
                        ({cursorMeasure.t1.toFixed(3)}s → {cursorMeasure.t2.toFixed(3)}s)
                      </span>
                      <button
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setCursorMeasure(null)}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      {cursorMeasure.values.map((v) => (
                        <div key={v.varId} className="flex items-center gap-1 text-[10px] font-mono">
                          <span className="text-muted-foreground">{v.name}:</span>
                          <span>{v.v1?.toFixed(3) ?? '—'}</span>
                          <span className="text-muted-foreground">→</span>
                          <span>{v.v2?.toFixed(3) ?? '—'}</span>
                          <span className="text-primary">Δ={v.delta?.toFixed(3) ?? '—'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部 Watch 面板（折叠时高度为 0，向下收起露出全部波形图） */}
          <div style={{ height: watchHeight }} className="flex flex-col border-t border-border overflow-hidden">
            {watchHeight > 0 && <WatchPanel uid={uid} onCollapse={() => setWatchHeight(0)} cursorData={cursorData} />}
          </div>
          {/* Watch 面板收起后的展开按钮 */}
          {watchHeight === 0 && (
            <button
              className="flex h-5 items-center justify-center border-t border-border text-[10px] text-muted-foreground hover:bg-muted/30"
              onClick={() => setWatchHeight(WATCH_DEFAULT_HEIGHT)}
            >
              ▲ 显示 Watch 面板
            </button>
          )}
        </div>

        {/* 水平拖拽分隔条（双击折叠/展开） */}
        <ResizeHandle
          direction="horizontal"
          onResize={handleSidebarResize}
          onToggle={handleToggleSidebar}
          expanded={sidebarWidth > 0}
        />

        {/* 右：通道面板（含 RTT/HSS 切换、ELF 加载、内联变量浏览） */}
        <div
          className={sidebarWidth > 0 ? 'flex shrink-0 flex-col overflow-hidden border-l border-border bg-background' : 'hidden'}
          style={sidebarWidth > 0 ? { width: sidebarWidth } : undefined}
        >
          <ChannelPanel
            uid={uid}
            isConnected={isConnected}
            onStartPause={handleStartPause}
            onStop={handleStop}
            onToggleDevice={handleToggleDevice}
            onReset={handleReset}
            coreState={coreState}
          />
        </div>
      </div>
    </div>
  )
}
