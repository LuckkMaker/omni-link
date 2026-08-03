import { useEffect, useRef } from 'react'
import { useRttStore } from '@/stores/rtt.store'
import { useNotificationStore } from '@/stores/notification.store'

/**
 * 接收数据到文件 hook
 *
 * 监听 recordToFile 开关：开启时让用户选 .dat 文件，之后每帧接收到的数据持续 append。
 * 关闭时 flush 关闭 FileHandle。
 *
 * 使用 File System Access API（showSaveFilePicker / createWritable）。
 * Electron 环境支持；不支持时 fallback 用 Blob 一次性下载。
 */
export function useRecordToFile(activeTabId: string) {
  const recordToFile = useRttStore((s) => s.recordToFile)
  const setRecordToFile = useRttStore((s) => s.setRecordToFile)
  const tab = useRttStore((s) => s.tabs.find((t) => t.id === activeTabId))
  // 已写入的缓冲块数（仅录制开启后新增的块才写入）
  const writtenCountRef = useRef(0)
  const writableRef = useRef<FileSystemWritableFileStream | null>(null)
  const startBufferLenRef = useRef(0)

  // 开启录制
  useEffect(() => {
    if (!recordToFile) return
    let cancelled = false
    const start = async () => {
      try {
        // 生成文件名：[omni_link_rtt]_YYYYMMDD_HHMMSS.dat
        const now = new Date()
        const p = (n: number) => n.toString().padStart(2, '0')
        const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
        const fileName = `[omni_link_rtt]_${ts}.dat`

        // File System Access API
        if (typeof (window as any).showSaveFilePicker === 'function') {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: fileName,
            types: [{
              description: 'DAT 原始数据',
              accept: { 'application/octet-stream': ['.dat'] },
            }],
          })
          if (cancelled) return
          const writable = await handle.createWritable()
          writableRef.current = writable
          // 从当前缓冲末尾开始录制（开启后的新数据才写入）
          startBufferLenRef.current = tab?.dataBuffer.length ?? 0
          writtenCountRef.current = startBufferLenRef.current
          setRecordToFile(true, handle.name)
        } else {
          // 不支持 File System Access API，不启用持续录制
          useNotificationStore.getState().push({
            type: 'warning',
            title: '不支持持续录制',
            message: '当前浏览器不支持 File System Access API，无法持续录制到文件',
          })
          setRecordToFile(false, null)
        }
      } catch (e) {
        // 用户取消选文件
        setRecordToFile(false, null)
      }
    }
    void start()

    return () => {
      cancelled = true
    }
  }, [recordToFile]) // eslint-disable-line react-hooks/exhaustive-deps

  // 关闭录制：flush writable
  useEffect(() => {
    if (recordToFile) return
    const w = writableRef.current
    if (w) {
      writableRef.current = null
      void w.close().catch(() => { /* ignore */ })
      startBufferLenRef.current = 0
      writtenCountRef.current = 0
    }
  }, [recordToFile])

  // 监听数据缓冲增长，写入文件
  const bufLen = tab?.dataBuffer.length ?? 0
  useEffect(() => {
    if (!recordToFile) return
    const w = writableRef.current
    const buffers = tab?.dataBuffer
    if (!w || !buffers) return
    // 从上次写入位置开始追加
    while (writtenCountRef.current < buffers.length) {
      const buf = buffers[writtenCountRef.current]
      try {
        // 转为 ArrayBuffer 以兼容 FileSystemWritableFileStream.write 类型
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        void w.write(ab)
      } catch { /* ignore */ }
      writtenCountRef.current++
    }
  }, [bufLen, recordToFile]) // eslint-disable-line react-hooks/exhaustive-deps

  // 卸载时关闭
  useEffect(() => {
    return () => {
      const w = writableRef.current
      if (w) {
        void w.close().catch(() => { /* ignore */ })
        writableRef.current = null
      }
    }
  }, [])
}
