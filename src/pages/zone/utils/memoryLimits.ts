/** 内存占用面板：内存区域解析工具 */
import type { DeviceInfo, TargetInfo } from '@shared/types'
import { parseHexBytes } from '@/lib/device-utils'

export interface MemoryRegion {
  /** 显示名称：Flash / RAM，多个同类型区域时带序号（Flash 1 / RAM 2） */
  name: string
  /** 区域起始地址 */
  start: number
  /** 区域大小（字节） */
  length: number
  /** 区域类型 */
  kind: 'flash' | 'ram'
  /** 数据来源 */
  source: 'target' | 'device' | 'default'
}

const DEFAULT_FLASH_START = 0x08000000
const DEFAULT_FLASH_SIZE = 2 * 1024 * 1024
const DEFAULT_RAM_START = 0x20000000
const DEFAULT_RAM_SIZE = 512 * 1024

/** 生成区域显示名称（多个同类型区域带序号） */
function buildNames(kind: 'flash' | 'ram', count: number): string[] {
  const base = kind === 'flash' ? 'Flash' : 'RAM'
  if (count <= 1) return [base]
  return Array.from({ length: count }, (_, i) => `${base} ${i + 1}`)
}

/**
 * 解析内存区域列表（Flash + RAM）。
 * 优先级：运行时 TargetInfo → 静态 DeviceInfo（DFP pack 导入）→ 兜底常量。
 * Flash / RAM 各自独立解析，互不阻塞。
 */
export function resolveMemoryRegions(
  target: TargetInfo | null,
  deviceInfo: DeviceInfo | undefined
): MemoryRegion[] {
  const regions: MemoryRegion[] = []

  if (target?.flash_regions?.length) {
    const names = buildNames('flash', target.flash_regions.length)
    target.flash_regions.forEach((r, i) =>
      regions.push({ name: names[i], start: r.start, length: r.length, kind: 'flash', source: 'target' })
    )
  } else if (deviceInfo?.flash_regions?.length) {
    const names = buildNames('flash', deviceInfo.flash_regions.length)
    deviceInfo.flash_regions.forEach((r, i) =>
      regions.push({
        name: names[i],
        start: parseHexBytes(r.start),
        length: parseHexBytes(r.length),
        kind: 'flash',
        source: 'device',
      })
    )
  }

  if (target?.ram_regions?.length) {
    const names = buildNames('ram', target.ram_regions.length)
    target.ram_regions.forEach((r, i) =>
      regions.push({ name: names[i], start: r.start, length: r.length, kind: 'ram', source: 'target' })
    )
  } else if (deviceInfo?.ram_regions?.length) {
    const names = buildNames('ram', deviceInfo.ram_regions.length)
    deviceInfo.ram_regions.forEach((r, i) =>
      regions.push({
        name: names[i],
        start: parseHexBytes(r.start),
        length: parseHexBytes(r.length),
        kind: 'ram',
        source: 'device',
      })
    )
  }

  if (regions.length === 0) {
    regions.push({ name: 'Flash', start: DEFAULT_FLASH_START, length: DEFAULT_FLASH_SIZE, kind: 'flash', source: 'default' })
    regions.push({ name: 'RAM', start: DEFAULT_RAM_START, length: DEFAULT_RAM_SIZE, kind: 'ram', source: 'default' })
  }

  return regions
}
