import { useEffect, useRef } from 'react'
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
  const lastState = useRef(state)
  const lastPc = useRef(pc)
  const lastTick = useRef(refreshTick)
  // 门控函数用 ref 持有：避免调用方传内联箭头函数时因函数引用变化导致 effect 每帧重跑
  const canRefreshRef = useRef(opts?.canRefresh)
  canRefreshRef.current = opts?.canRefresh

  useEffect(() => {
    // 会话未就绪（未连接 / 未加载 ELF / 未启动调试会话）时不自动轮询
    if (!uid || !connected || !ready) return
    // 面板级门控（如 Call Stack 仅暂停时可读栈）
    if (canRefreshRef.current && !canRefreshRef.current()) return

    if (refreshMode === 'on_stop') {
      if (state === 'halted') {
        const stateChanged = lastState.current !== 'halted'
        const pcChanged = lastPc.current !== pc
        const tickChanged = lastTick.current !== refreshTick
        if (stateChanged || pcChanged || tickChanged) {
          refresh()
        }
      }
      lastState.current = state
      lastPc.current = pc
      lastTick.current = refreshTick
      return
    }

    if (refreshMode === 'periodic_always') {
      // 每 1 秒周期刷新：后端使用 AHB-AP 非侵入式读取（read_memory_direct），
      // 目标运行中也可读取、不打断程序执行，与 Keil 的 Periodic Window Update 一致。
      const timer = setInterval(refresh, 1000)
      return () => clearInterval(timer)
    }
    // off：不自动刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, connected, ready, state, pc, refreshMode, refreshTick, refresh])
}
