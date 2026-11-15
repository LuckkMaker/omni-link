import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock('@/services/file.service', () => ({
  readFile: mocks.readFile,
  parseFile: vi.fn(),
  statFile: vi.fn().mockResolvedValue({ mtime: 0, size: 0 }),
}))

import { useFlashStore, type FlashTab } from '@/stores/flash.store'
import { useNotificationStore } from '@/stores/notification.store'

function base64(values: number[]): string {
  return btoa(String.fromCharCode(...values))
}

function fileTab(baseAddress: number, values: number[]): FlashTab {
  return {
    id: 'tab-left',
    type: 'file',
    title: 'app.axf',
    filePath: 'app.axf',
    baseAddress,
    data: base64(values),
    size: values.length,
    loading: false,
    eraseBefore: true,
    verifyAfter: true,
    resetAfter: false,
  }
}

function activeTab(): FlashTab {
  const { tabs, activeTabId } = useFlashStore.getState()
  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) throw new Error('no active tab')
  return tab
}

function lastNotificationMessage(): string {
  const { notifications } = useNotificationStore.getState()
  return notifications[notifications.length - 1]?.message ?? ''
}

beforeEach(() => {
  mocks.readFile.mockReset()
  useNotificationStore.setState({ notifications: [] })
  useFlashStore.setState({ tabs: [fileTab(0x0800c000, [1, 2, 3, 4])], activeTabId: 'tab-left' })
})

describe('flash.store doCompare', () => {
  it('bin 按对话框指定的地址加载', async () => {
    mocks.readFile.mockResolvedValue({
      data: base64([1, 2, 3, 4]),
      base_address: 0x0800c000,
      size: 4,
      format: 'bin',
    })

    await useFlashStore.getState().doCompare('ref.bin', { startAddress: 0x0800c000 })

    expect(mocks.readFile).toHaveBeenCalledWith('ref.bin', 0x0800c000)
    const tab = activeTab()
    expect(tab.type).toBe('compare')
    expect(tab.windowStart).toBe(0x0800c000)
    expect(tab.windowSize).toBe(4)
    expect(tab.firstDiff).toBeNull()
    expect(lastNotificationMessage()).toContain('4 字节相同')
  })

  it('未指定地址时以当前 tab 的基地址为准', async () => {
    mocks.readFile.mockResolvedValue({
      data: base64([1, 2, 3, 4]),
      base_address: 0x0800c000,
      size: 4,
      format: 'bin',
    })

    await useFlashStore.getState().doCompare('ref.bin')

    expect(mocks.readFile).toHaveBeenCalledWith('ref.bin', 0x0800c000)
    expect(activeTab().windowStart).toBe(0x0800c000)
  })

  it('axf/.hex 自带地址：按地址对齐并跳到首个差异', async () => {
    // 左侧 0x08000000 起 4 字节；参考文件只覆盖 0x08000002 起的 2 字节
    useFlashStore.setState({ tabs: [fileTab(0x08000000, [1, 2, 3, 4])], activeTabId: 'tab-left' })
    mocks.readFile.mockResolvedValue({
      data: base64([3, 4]),
      base_address: 0x08000002,
      size: 2,
      format: 'elf',
    })

    await useFlashStore.getState().doCompare('ref.axf')

    // 非 bin 不传地址，用文件自带地址
    expect(mocks.readFile).toHaveBeenCalledWith('ref.axf')
    const tab = activeTab()
    expect(tab.baseAddress).toBe(0x08000000)
    expect(tab.rightBaseAddress).toBe(0x08000002)
    expect(tab.windowStart).toBe(0x08000000)
    expect(tab.windowSize).toBe(4)
    expect(tab.firstDiff).toBe(0x08000000)
  })

  it('地址范围不重叠时不产生逐字节差异', async () => {
    mocks.readFile.mockResolvedValue({
      data: base64([9, 9, 9, 9]),
      base_address: 0x08000000,
      size: 4,
      format: 'elf',
    })

    await useFlashStore.getState().doCompare('boot.axf')

    const tab = activeTab()
    expect(tab.windowStart).toBe(0x0800c000)
    expect(tab.firstDiff).toBe(0x0800c000)
    expect(lastNotificationMessage()).toContain('仅左侧 4 字节')
  })

  it('指定比较长度时窗口按长度截断', async () => {
    mocks.readFile.mockResolvedValue({
      data: base64([1, 2, 9, 4]),
      base_address: 0x0800c000,
      size: 4,
      format: 'bin',
    })

    await useFlashStore.getState().doCompare('ref.bin', { startAddress: 0x0800c000, size: 2 })

    const tab = activeTab()
    expect(tab.windowSize).toBe(2)
    expect(tab.firstDiff).toBeNull()
    expect(lastNotificationMessage()).toContain('2 字节相同')
  })
})
