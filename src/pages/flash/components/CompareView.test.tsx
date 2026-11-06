import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { CompareView } from './CompareView'

function base64(values: number[]): string {
  return btoa(String.fromCharCode(...values))
}

/** React SSR 会在相邻文本节点间插入 <!-- -->，断言前去掉它们。 */
function text(html: string): string {
  return html.replace(/<!-- -->/g, '')
}

describe('CompareView', () => {
  it('按地址对齐渲染：两侧共用窗口起始地址与单侧统计', () => {
    const html = text(
      renderToString(
        <CompareView
          leftBase64={base64([1, 2, 3, 4])}
          leftBaseAddress={0x0800c000}
          leftTitle="app.axf"
          rightBase64={base64([5, 6, 7, 8])}
          rightBaseAddress={0x08000000}
          rightTitle="boot.axf"
          windowStart={0x0800c000}
        />,
      ),
    )

    // 窗口从左侧基地址开始，行地址 = 0x0800C000（而不是 0）
    expect(html).toContain('0x0800_C000')
    expect(html).toContain('仅左侧 4 B')
    expect(html).toContain('差异 0 bytes')
  })

  it('两侧基地址不同但地址相同的数据可以匹配', () => {
    const html = text(
      renderToString(
        <CompareView
          leftBase64={base64([0xaa, 0xbb, 0xcc, 0xdd])}
          leftBaseAddress={0x0800c000}
          leftTitle="left"
          rightBase64={base64([0xaa, 0xbb, 0xcc, 0xdd])}
          rightBaseAddress={0x0800c000}
          rightTitle="right"
        />,
      ),
    )

    expect(html).toContain('匹配 4 B')
    expect(html).toContain('差异 0 bytes')
  })
})
