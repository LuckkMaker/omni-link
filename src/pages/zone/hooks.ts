import { useCallback, useEffect, useRef } from 'react'
import { useZoneStore } from './store'

/**
 * 两级"就绪"判定，区分 ELF 派生面板与目标读取面板：
 *
 * 1. elfLoaded = !!elfPath：ELF 符号是否已加载。
 *    仅依赖 ELF 符号、不读目标硬件的面板（源码文件 / 函数 / 内存占用）据此提前加载，
 *    无需等待目标连接与会话启动，避免 startSession 全程（含烧录）完成后才显示。
 *
 * 2. ready = connected && elfPath && sessionStatus==='active'：调试会话真正就绪。
 *    需读取目标内存/寄存器/栈的面板（Memory / Registers / Peripherals / Call Stack / Watch）
 *    据此展示，避免"仅连接设备"或"未加载 ELF"时过早读取目标数据。
 *
 * ready 由 sessionStatus 主导（startSession 内部保证 先 connect → 再 loadElf → 才置 active），
 * 并叠加 connected 与 elfPath 做防御性兜底。
 *
 * @param uid 设备 uid（由父级从 probe.store 传入）
 * @param connected 设备是否已连接（由父级从 probe.store 传入）
 */
export function useSessionReady(uid: string | null, connected: boolean) {
  const sessionStatus = useZoneStore((s) => s.sessionStatus)
  const elfPath = useZoneStore((s) => s.elfPath)
  const elfLoaded = !!elfPath
  const ready = connected && elfLoaded && sessionStatus === 'active'
  return { ready, elfLoaded, uid, connected, elfPath, sessionStatus }
}

interface AutoRefreshOptions {
  /** 触发刷新前的额外门控（如 Call Stack 仅暂停时可读栈）。默认无门控。 */
  canRefresh?: () => boolean
}

/**
 * 通用自动刷新触发器：根据全局 refreshMode 与目标状态决定是否刷新。
 *
 * - on_stop：halt/刷新纪元变化时刷新。refreshTick 每次 halt 事件/调试动作都递增，
 *   覆盖「循环停在同一断点同 PC」时 state/pc 差值不变导致漏刷新的场景。
 * - periodic_always：每 1 秒周期刷新。通过 AHB-AP 非侵入式读取（read_memory_direct），
 *   目标运行中也可刷新、不打断程序执行（与 Keil 的 Periodic Window Update 一致）。
 *   同时监听 halt 事件：断点命中/用户 Stop 瞬间立即刷新一次，不等下一个周期。
 *   用户调试操作进行中（busy）时跳过本轮，避免与 halt/step/continue/reset 争抢资源。
 * - off：不自动刷新。
 *
 * 仅动态数据面板（寄存器 / 外设 / 内存 / Watch / 调用栈）接入；静态面板不调用本 hook。
 */
export function useAutoRefresh(
  uid: string | null,
  connected: boolean,
  ready: boolean,
  refresh: () => void,
  opts?: AutoRefreshOptions
) {
  const state = useZoneStore((s) => s.state)
  const pc = useZoneStore((s) => s.pc)
  const refreshMode = useZoneStore((s) => s.refreshMode)
  const refreshTick = useZoneStore((s) => s.refreshTick)
  const busy = useZoneStore((s) => s.busy)
  const lastState = useRef(state)
  const lastPc = useRef(pc)
  const lastTick = useRef(refreshTick)
  const lastBusy = useRef(busy)
  // pc 最新值用 ref 持有：pc 变化不应触发 effect 重跑——否则 250ms 状态轮询更新 pc 时
  // 会反复清除重建周期 interval，导致周期刷新（setInterval）永远不触发（运行中变量不刷新）
  const pcRef = useRef(pc)
  pcRef.current = pc
  // 门控函数用 ref 持有：避免调用方传内联箭头函数时因函数引用变化导致 effect 每帧重跑
  const canRefreshRef = useRef(opts?.canRefresh)
  canRefreshRef.current = opts?.canRefresh
  // in-flight 守卫：上一次刷新未完成时跳过本轮。周期刷新 100ms 触发一次，若后端处理慢
  // （断点命中后汇编/寄存器读取争用），无守卫会导致请求堆积压垮后端、busy 卡死、工具栏灰置。
  // 有守卫后刷新频率自动随后端处理速度调节：后端快则快刷，后端慢则自动降频不堆积。
  const inFlightRef = useRef(false)
  const guardedRefresh = useCallback(() => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    Promise.resolve(refresh()).finally(() => {
      inFlightRef.current = false
    })
  }, [refresh])

  useEffect(() => {
    // 会话未就绪（未连接 / 未加载 ELF / 未启动调试会话）时不自动轮询
    if (!uid || !connected || !ready) return
    // 面板级门控（如 Call Stack 仅暂停时可读栈）
    if (canRefreshRef.current && !canRefreshRef.current()) return

    if (refreshMode === 'on_stop') {
      if (state === 'halted') {
        const stateChanged = lastState.current !== 'halted'
        const pcChanged = lastPc.current !== pcRef.current
        const tickChanged = lastTick.current !== refreshTick
        if (stateChanged || pcChanged || tickChanged) {
          guardedRefresh()
        }
      }
      lastState.current = state
      lastPc.current = pcRef.current
      lastTick.current = refreshTick
      return
    }

    if (refreshMode === 'periodic_always') {
      // 周期刷新仅目标运行中执行（后端 AHB-AP 非侵入式读取，观察运行中变量）。
      // 目标暂停时不周期轮询——暂停时面板由 halt 事件/on_stop 驱动刷新，
      // 但 halt 跳变（断点命中/用户 Stop 瞬间）仍需立即刷新一次，让面板立刻反映暂停后的值。
      const haltHit = state === 'halted' && (lastState.current !== 'halted' || lastTick.current !== refreshTick)
      if (state === 'running') {
        // 用户调试操作进行中：跳过本轮，100ms 后重试一次（操作间隙立即补上刷新），
        // 避免与 halt/step/continue/reset 争抢后端资源
        if (busy) {
          const retry = setTimeout(() => guardedRefresh(), 100)
          return () => clearTimeout(retry)
        }
        // 周期刷新：每 100ms（后端 AHB-AP 非侵入式读取，运行中不打断程序）。
        // 100ms 可感知 ms_cnt（10ms 变化）的实时更新；s_cnt（1s 变化）每 10 次刷新跳 1
        const timer = setInterval(guardedRefresh, 100)
        // 立即刷新：busy 刚结束（操作间隙补上）或 halt 跳变（断点命中/用户 Stop 瞬间），
        // 不等下一个周期，立即拿到最新值
        const busyEnded = lastBusy.current && !busy
        if (busyEnded || haltHit) {
          guardedRefresh()
        }
        lastBusy.current = busy
        lastState.current = state
        lastTick.current = refreshTick
        return () => clearInterval(timer)
      }
      // 目标暂停：仅 halt 跳变时立即刷新一次，不周期轮询（调试操作进行中跳过）
      if (haltHit && !busy) {
        guardedRefresh()
      }
      lastState.current = state
      lastPc.current = pcRef.current
      lastTick.current = refreshTick
      lastBusy.current = busy
      return
    }
    // off：不自动刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, connected, ready, state, refreshMode, refreshTick, guardedRefresh, busy])
}
