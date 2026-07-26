/** 设备信息显示工具函数 */
import type { DeviceRamRegion, RamRegionInfo } from '@shared/types'

/** 将十六进制字符串解析为字节数 */
export function parseHexBytes(hex: string): number {
  if (!hex) return 0
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex : `0x${hex}`
  return parseInt(s, 16) || 0
}

/** 字节数 → 可读字符串 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** KB → 可读字符串 */
export function formatKb(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`
  return `${kb} KB`
}

/**
 * 计算设备目录中 RAM 区域的总大小（KB）。
 * 优先累加 ram_regions，否则回退到 ram_size。
 */
export function totalRamKb(regions: DeviceRamRegion[] | undefined, fallbackKb: number): number {
  if (regions && regions.length > 0) {
    const totalBytes = regions.reduce((sum, r) => sum + parseHexBytes(r.length), 0)
    return Math.round(totalBytes / 1024)
  }
  return fallbackKb
}

/**
 * 计算 RAM 区域的总大小（字节）。
 * 优先累加 ram_regions，否则回退到 ram_size * 1024。
 */
export function totalRamBytes(regions: RamRegionInfo[] | undefined, fallbackBytes: number): number {
  if (regions && regions.length > 0) {
    return regions.reduce((sum, r) => sum + r.length, 0)
  }
  return fallbackBytes
}

/**
 * 生成 RAM 区域的悬浮提示文本（用于表格单元格 title）。
 * 单个区域时返回空字符串（无需提示）；多个区域时返回分行明细。
 */
export function ramRegionsTooltip(regions: DeviceRamRegion[] | undefined): string {
  if (!regions || regions.length <= 1) return ''
  return regions
    .map((r, i) => {
      const tag = r.is_default ? ' (默认)' : ''
      return `RAM${i + 1}: ${formatBytes(parseHexBytes(r.length))} @ ${r.start}${tag}`
    })
    .join('\n')
}

/**
 * 生成运行时 RAM 区域的悬浮提示文本。
 */
export function runtimeRamRegionsTooltip(regions: RamRegionInfo[] | undefined): string {
  if (!regions || regions.length <= 1) return ''
  return regions
    .map((r, i) => {
      const tag = r.is_default ? ' (默认)' : ''
      const addr = `0x${r.start.toString(16).toUpperCase().padStart(8, '0')}`
      return `RAM${i + 1}: ${formatBytes(r.length)} @ ${addr}${tag}`
    })
    .join('\n')
}
