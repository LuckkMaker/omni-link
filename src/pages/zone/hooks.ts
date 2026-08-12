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