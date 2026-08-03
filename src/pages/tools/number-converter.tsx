import { useState, useCallback } from 'react'
import { RotateCcw, ArrowLeft, ArrowRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useToolsStore } from '@/stores/tools.store'

export default function NumberConverter() {
  // 从持久化 store 读取值
  const decimal = useToolsStore((s) => s.ncDecimal)
  const hex = useToolsStore((s) => s.ncHex)
  const binary = useToolsStore((s) => s.ncBinary)
  const setNcValues = useToolsStore((s) => s.setNcValues)

  const [error, setError] = useState('')

  // 移位位数（0-31），用于左移 / 右移操作
  const [shiftAmount, setShiftAmount] = useState('1')

  // 核心数值（无符号 32 位），所有输入最终同步到这个值
  const value = (() => {
    try {
      return parseInt(decimal, 10) >>> 0
    } catch {
      return 0
    }
  })()

  const updateAll = useCallback((val: number, except?: 'dec' | 'hex' | 'bin') => {
    const v = val >>> 0
    const newDec = except !== 'dec' ? String(v) : decimal
    const newHex = except !== 'hex' ? '0x' + v.toString(16).toUpperCase() : hex
    const newBin = except !== 'bin' ? v.toString(2) : binary
    setNcValues(newDec, newHex, newBin)
    setError('')
  }, [decimal, hex, binary, setNcValues])

  const handleDecimalChange = useCallback((v: string) => {
    setNcValues(v, hex, binary)
    const cleaned = v.trim()
    if (cleaned === '') {
      updateAll(0, 'dec')
      return
    }
    if (!/^\d+$/.test(cleaned)) {
      setError('十进制输入包含非法字符')
      return
    }
    const num = parseInt(cleaned, 10)
    if (num > 0xFFFFFFFF) {
      setError('数值超出 32 位无符号范围')
      return
    }
    updateAll(num, 'dec')
  }, [hex, binary, setNcValues, updateAll])

  const handleHexChange = useCallback((v: string) => {
    const cleaned = v.replace(/^0x/i, '').trim()
    setNcValues(decimal, v, binary)
    if (cleaned === '') {
      updateAll(0, 'hex')
      return
    }
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
      setError('十六进制输入包含非法字符')
      return
    }
    const num = parseInt(cleaned, 16)
    updateAll(num, 'hex')
  }, [decimal, binary, setNcValues, updateAll])

  const handleBinaryChange = useCallback((v: string) => {
    const cleaned = v.replace(/^0b/i, '').trim()
    setNcValues(decimal, hex, v)
    if (cleaned === '') {
      updateAll(0, 'bin')
      return
    }
    if (!/^[01]+$/.test(cleaned)) {
      setError('二进制输入包含非法字符')
      return
    }
    const num = parseInt(cleaned, 2)
    updateAll(num, 'bin')
  }, [decimal, hex, setNcValues, updateAll])

  const handleToggleBit = useCallback((bitIndex: number) => {
    const newVal = (value ^ (1 << bitIndex)) >>> 0
    updateAll(newVal)
  }, [value, updateAll])

  const handleReset = useCallback(() => {
    updateAll(0)
  }, [updateAll])

  // 解析移位位数，非法或越界时返回 null 并提示
  const parseShiftAmount = useCallback((): number | null => {
    const n = parseInt(shiftAmount, 10)
    if (Number.isNaN(n) || n < 0 || n > 31) {
      setError('移位位数需为 0-31 的整数')
      return null
    }
    return n
  }, [shiftAmount])

  // 左移：低位补 0，超过 32 位部分丢弃
  const handleShiftLeft = useCallback(() => {
    const n = parseShiftAmount()
    if (n === null) return
    updateAll((value << n) >>> 0)
  }, [parseShiftAmount, value, updateAll])

  // 右移：逻辑右移，高位补 0
  const handleShiftRight = useCallback(() => {
    const n = parseShiftAmount()
    if (n === null) return
    updateAll(value >>> n)
  }, [parseShiftAmount, value, updateAll])

  // 生成 32 位的位信息（bit 31 在左，bit 0 在右）
  const bitValue = (bitIndex: number) => (value >> bitIndex) & 1

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* 操作栏 */}
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={handleReset}>
          <RotateCcw className="mr-1.5 h-4 w-4" />
          重置
        </Button>
      </div>

      {/* 输入字段 */}
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Decimal value</label>
          <Input
            value={decimal}
            onChange={(e) => handleDecimalChange(e.target.value)}
            className="font-mono"
            placeholder="0"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Hex value</label>
          <Input
            value={hex}
            onChange={(e) => handleHexChange(e.target.value)}
            className="font-mono"
            placeholder="0x0"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Binary value</label>
          <Input
            value={binary}
            onChange={(e) => handleBinaryChange(e.target.value)}
            className="font-mono"
            placeholder="0"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* 32 位 bit 可视化与勾选 — 两行显示，每行 16 位 */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">32-bit Binary</h3>
          <span className="font-mono text-sm text-muted-foreground">
            {value.toString(2).padStart(32, '0').match(/.{1,4}/g)?.join(' ')}
          </span>
        </div>

        {/* 两行，每行 4 组 4-bit */}
        <div className="flex flex-col items-center gap-3">
          {[0, 1].map((rowIdx) => (
            <div key={rowIdx} className="flex items-stretch justify-center gap-2">
              {Array.from({ length: 4 }, (_, groupInRow) => {
                const groupIdx = rowIdx * 4 + groupInRow
                const startBit = 31 - groupIdx * 4
                return (
                  <div key={groupIdx} className="flex flex-col items-center">
                    <div className="mb-1 text-[10px] font-mono text-muted-foreground">
                      {startBit}-{startBit - 3}
                    </div>
                    <div className="flex gap-1">
                      {Array.from({ length: 4 }, (_, bitInGroup) => {
                        const bitIndex = startBit - bitInGroup
                        const isSet = bitValue(bitIndex) === 1
                        return (
                          <button
                            key={bitIndex}
                            onClick={() => handleToggleBit(bitIndex)}
                            className={cn(
                              'flex h-7 w-7 items-center justify-center rounded border-2 text-xs font-bold font-mono transition-all',
                              isSet
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-background text-muted-foreground hover:border-primary/60'
                            )}
                            title={`Bit ${bitIndex} — ${isSet ? '1' : '0'} (点击切换)`}
                          >
                            {isSet ? '1' : '0'}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* 分组标签 */}
        <div className="mt-3 grid grid-cols-8 gap-2 border-t border-border pt-2">
          {['Byte 3', 'Byte 2', 'Byte 1', 'Byte 0'].map((label, i) => (
            <div
              key={label}
              className="col-span-2 rounded bg-muted/40 px-2 py-1 text-center"
            >
              <div className="text-[10px] text-muted-foreground">{label}</div>
              <div className="font-mono text-xs text-primary">
                0x{((value >> ((3 - i) * 8)) & 0xFF).toString(16).padStart(2, '0').toUpperCase()}
              </div>
            </div>
          ))}
        </div>

        {/* 位运算：左移 / 右移 — 32-bit Binary 区块底部 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <label className="text-xs font-medium text-muted-foreground">移位位数</label>
          <Input
            value={shiftAmount}
            onChange={(e) => setShiftAmount(e.target.value.replace(/[^\d]/g, ''))}
            className="w-24 font-mono"
            placeholder="1"
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
          />
          <Button variant="outline" size="sm" onClick={handleShiftLeft} title="左移 (<<)" className="gap-1.5">
            <ArrowLeft className="size-4" />
            左移 &lt;&lt;
          </Button>
          <Button variant="outline" size="sm" onClick={handleShiftRight} title="逻辑右移 (>>)" className="gap-1.5">
            <ArrowRight className="size-4" />
            右移 &gt;&gt;
          </Button>
        </div>
      </div>

      {/* 额外信息 */}
      <div className="grid grid-cols-3 gap-4">
        <InfoCard label="八进制" value={'0o' + value.toString(8)} />
        <InfoCard
          label="字符"
          value={value >= 32 && value < 127 ? `'${String.fromCharCode(value)}'` : '—'}
        />
        <InfoCard
          label="位计数"
          value={`${popcount(value)} bit(s) set`}
        />
      </div>
    </div>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm font-medium">{value}</div>
    </div>
  )
}

/** 计算二进制中 1 的个数 */
function popcount(n: number): number {
  let count = 0
  let v = n >>> 0
  while (v) {
    count += v & 1
    v >>>= 1
  }
  return count
}
