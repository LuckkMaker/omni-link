import { describe, expect, it } from 'vitest'
import { base64ToBytes, buildCompareWindow, describeCompare } from './compare'

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('buildCompareWindow', () => {
  it('同一地址且内容相同时完全匹配', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2, 3, 4), base: 0x08000000 },
      { bytes: bytes(1, 2, 3, 4), base: 0x08000000 },
    )

    expect(window.start).toBe(0x08000000)
    expect(window.end).toBe(0x08000004)
    expect(window.matchCount).toBe(4)
    expect(window.diffCount).toBe(0)
    expect(window.onlyLeft).toBe(0)
    expect(window.onlyRight).toBe(0)
    expect(window.firstDiff).toBeNull()
  })

  it('内容不同时记录差异地址与掩码', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2, 3, 4), base: 0x08000000 },
      { bytes: bytes(1, 2, 9, 4), base: 0x08000000 },
    )

    expect(window.diffCount).toBe(1)
    expect(window.matchCount).toBe(3)
    expect(window.diffMask[2]).toBe(1)
    expect(window.diffMask[0]).toBe(0)
    expect(window.firstDiff).toBe(0x08000002)
  })

  it('两侧基地址不同时按地址对齐，而不是按偏移 0 对齐', () => {
    // 左侧从 0x08000000 开始，右侧只覆盖 0x08000002 起的两个字节
    const window = buildCompareWindow(
      { bytes: bytes(1, 2, 3, 4), base: 0x08000000 },
      { bytes: bytes(3, 4), base: 0x08000002 },
    )

    expect(window.start).toBe(0x08000000)
    expect(window.end).toBe(0x08000004)
    expect(window.matchCount).toBe(2)
    expect(window.onlyLeft).toBe(2)
    expect(window.onlyRight).toBe(0)
    expect(window.firstDiff).toBe(0x08000000)
    expect(window.leftPresent[0]).toBe(1)
    expect(window.rightPresent[0]).toBe(0)
    expect(window.rightPresent[2]).toBe(1)
    // 地址 0x08000002 处两侧都是 0x03，不应算差异
    expect(window.diffCount).toBe(0)
  })

  it('指定起始地址时窗口从该地址开始', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2, 3, 4), base: 0x08000000 },
      { bytes: bytes(3, 4), base: 0x08000002 },
      { start: 0x08000002 },
    )

    expect(window.start).toBe(0x08000002)
    expect(window.size).toBe(2)
    expect(window.matchCount).toBe(2)
    expect(window.onlyLeft).toBe(0)
    expect(window.firstDiff).toBeNull()
  })

  it('指定比较大小会限制窗口长度', () => {
    const window = buildCompareWindow(
      { bytes: new Uint8Array(16).fill(0x11), base: 0 },
      { bytes: new Uint8Array(16).fill(0x11), base: 0 },
      { start: 0x4, size: 4 },
    )

    expect(window.start).toBe(0x4)
    expect(window.size).toBe(4)
    expect(window.matchCount).toBe(4)
  })

  it('地址范围完全不重叠时只统计单侧数据，且不跨窗口对齐', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2, 3, 4), base: 0x0800c000 },
      { bytes: bytes(5, 6, 7, 8), base: 0x08000000 },
    )

    expect(window.start).toBe(0x0800c000)
    expect(window.matchCount).toBe(0)
    expect(window.diffCount).toBe(0)
    expect(window.onlyLeft).toBe(4)
    expect(window.onlyRight).toBe(0)
    expect(window.firstDiff).toBe(0x0800c000)
  })

  it('窗口内两侧都没有数据的空洞不计入统计', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2), base: 0x10 },
      { bytes: bytes(3, 4), base: 0x20 },
      { start: 0x10 },
    )

    expect(window.size).toBe(0x12)
    expect(window.onlyLeft).toBe(2)
    expect(window.onlyRight).toBe(2)
    expect(window.matchCount).toBe(0)
    expect(window.diffCount).toBe(0)
    expect(window.firstDiff).toBe(0x10)
  })

  it('空数据不会抛异常', () => {
    const window = buildCompareWindow(
      { bytes: new Uint8Array(0), base: 0x08000000 },
      { bytes: new Uint8Array(0), base: 0x08000000 },
    )

    expect(window.size).toBe(0)
    expect(window.firstDiff).toBeNull()
    expect(describeCompare(window)).toBe('没有可比较的数据')
  })

  it('起始地址远低于数据范围时不会生成巨量空白窗口', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2), base: 0x08000000 },
      { bytes: bytes(1, 2), base: 0x08000000 },
      { start: 0x0 },
    )

    expect(window.start).toBe(0x08000000)
    expect(window.size).toBe(2)
    expect(window.matchCount).toBe(2)
  })

  it('比较长度超出数据范围时按数据范围截断', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2), base: 0 },
      { bytes: bytes(1, 2), base: 0 },
      { start: 0, size: 0x10000000 },
    )

    expect(window.size).toBe(2)
  })

  it('起始地址在数据范围之外时得到空窗口', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2), base: 0x1000 },
      { bytes: bytes(1, 2), base: 0x1000 },
      { start: 0x80000000 },
    )

    expect(window.size).toBe(0)
  })
})

describe('base64ToBytes', () => {
  it('解码 base64 数据', () => {
    expect(Array.from(base64ToBytes(btoa('\x01\x02\xff')))).toEqual([1, 2, 255])
  })

  it('空值返回空数组', () => {
    expect(base64ToBytes(null).length).toBe(0)
    expect(base64ToBytes('').length).toBe(0)
  })
})

describe('describeCompare', () => {
  it('汇总差异/相同/单侧字节数', () => {
    const window = buildCompareWindow(
      { bytes: bytes(1, 2, 3), base: 0x100 },
      { bytes: bytes(1, 9, 3, 4), base: 0x100 },
    )

    expect(window.diffCount).toBe(1)
    expect(window.matchCount).toBe(2)
    expect(window.onlyRight).toBe(1)
    expect(describeCompare(window)).toBe('1 字节不同，2 字节相同，仅右侧 1 字节')
  })
})
