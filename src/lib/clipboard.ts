/**
 * 将文本写入系统剪贴板。
 *
 * 生产环境 Electron 渲染进程以 file:// 加载（非安全上下文），
 * navigator.clipboard 不可用，故按以下优先级逐级尝试：
 *   1. Electron 主进程 clipboard 模块（通过 preload 暴露）——最可靠
 *   2. navigator.clipboard.writeText（HTTPS / dev 等安全上下文）
 *   3. document.execCommand('copy') 兜底
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false

  // 1) Electron 主进程剪贴板
  try {
    if (window.electron?.writeClipboardText) {
      return await window.electron.writeClipboardText(text)
    }
  } catch { /* 继续降级 */ }

  // 2) 标准 Clipboard API
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 继续降级 */ }

  // 3) execCommand 兜底（元素需在文档内且被选中）
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    const selection = document.getSelection()
    const prevRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (selection && prevRange) {
      selection.removeAllRanges()
      selection.addRange(prevRange)
    }
    return ok
  } catch {
    return false
  }
}