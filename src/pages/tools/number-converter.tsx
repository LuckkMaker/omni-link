import { useState, useCallback, useRef, useLayoutEffect, type ChangeEvent } from 'react'
import { RotateCcw, ArrowLeft, ArrowRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useToolsStore } from '@/stores/tools.store'
import { useNotificationStore } from '@/stores/notification.store'

/** 三个输入框的标识 */
type Field = 'dec' | 'hex' | 'bin'

/** 32 位无符号最大值 */
const MAX_UINT32 = 0xFFFFFFFF

/** 各输入框允许输入的字符：十进制 0-9，十六进制 0-9a-fA-F，二进制 0/1 */
const DIGIT_RE: Record<Field, RegExp> = {
  dec: /[0-9]/,
  hex: /[0-9a-fA-F]/,
  bin: /[01]/,
}

/** 各输入框的最大位数：十六进制 8 位、二进制 32 位、十进制 10 位（均为 32 位无符号） */
const MAX_LEN: Record<Field, number> = {
  dec: 10,
  hex: 8,
  bin: 32,
}

/** 超出最大位数时的提示 */
const LEN_HINT: Record<Field, string> = {
  dec: '十进制最多 10 位（32 位无符号范围）',
  hex: '十六进制最多 8 位（32 位）',
  bin: '二进制最多 32 位',
}

/**
 * 忽略进制前缀：输入框本身不显示 0x / 0b，粘贴带前缀的文本时也按无前缀处理。
 * （正常键入时 'x' / 'b' 会被过滤掉，所以这里只对粘贴等场景生效。）
 */
function stripPrefix(field: Field, v: string): string {
  if (field === 'hex') return v.replace(/^0[xX]/, '')
  if (field === 'bin') return v.replace(/^0[bB]/, '')
  return v
}

/**
 * 输入过滤：直接丢弃不属于该进制的字符（在字符进入输入框之前拦掉），
 * 并按被丢弃的字符数量修正光标位置，保证在中间插入/删除时不会跳到末尾。
 */
function filterInput(field: Field, raw: string, caret: number) {
  // 粘贴 "0x1F" / "0b1010" 时先去掉前缀
  const stripped = stripPrefix(field, raw)
  if (stripped !== raw) {
    raw = stripped
    caret = Math.max(0, caret - 2)
  }

  const allowDigit = DIGIT_RE[field]
  let text = ''
  let nextCaret = caret
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (allowDigit.test(ch)) text += ch
    else if (i < caret) nextCaret--
  }

  // 十六进制统一以大写显示（只改大小写，不影响光标位置）
  if (field === 'hex') text = text.toUpperCase()

  return { text, caret: Math.max(0, Math.min(nextCaret, text.length)) }
}

export default function NumberConverter() {
  // 从持久化 store 读取值
  const decimal = useToolsStore((s) => s.ncDecimal)
  // 兼容旧版本持久化下来的 0x 前缀写法，并统一大写
  const hex = stripPrefix('hex', useToolsStore((s) => s.ncHex)).toUpperCase()
  const binary = useToolsStore((s) => s.ncBinary)
  const setNcValues = useToolsStore((s) => s.setNcValues)

  // 输入被拒绝等提示统一走应用的全局通知（右下角通知 + 状态栏历史）
  const notify = useNotificationStore((s) => s.push)
  // 同一条提示 1.5s 内去重，避免连续键入被拦下的字符时通知刷屏
  const lastWarnRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const warn = useCallback((key: string, title: string, message: string) => {
    const now = Date.now()
    if (lastWarnRef.current.key === key && now - lastWarnRef.current.at < 1500) return
    lastWarnRef.current = { key, at: now }
    notify({ type: 'warning', title, message, autoClose: true, autoCloseDelay: 3000 })
  }, [notify])

  // 移位位数（0-31），用于左移 / 右移操作
  const [shiftAmount, setShiftAmount] = useState('1')

  // 核心数值（无符号 32 位），所有输入最终同步到这个值
  const value = (() => {
    const num = parseInt(decimal, 10)
    return Number.isNaN(num) ? 0 : num >>> 0
  })()

  /**
   * 正在编辑的输入框草稿。
   * 用户键入的文本（未规范化的写法，如前导 0、空串）
   * 只保留在草稿中，store 里始终保存规范值 —— 这样输入内容随时可以被删掉，
   * 不会像以前那样被写回输入框导致卡住。
   */
  const [draft, setDraft] = useState<{ field: Field; text: string } | null>(null)

  // 三个输入框的引用，用于输入被过滤后恢复光标
  const inputRefs = {
    dec: useRef<HTMLInputElement>(null),
    hex: useRef<HTMLInputElement>(null),
    bin: useRef<HTMLInputElement>(null),
  }
  const caretRef = useRef<{ field: Field; pos: number } | null>(null)

  // 过滤掉字符后浏览器会把光标移到末尾，这里按修正后的位置还原
  useLayoutEffect(() => {
    const pending = caretRef.current
    if (!pending) return
    caretRef.current = null
    const el = inputRefs[pending.field].current
    if (el && document.activeElement === el) {
      el.setSelectionRange(pending.pos, pending.pos)
    }
  })

  // 把数值以规范形式同步到三个输入框，并结束当前草稿
  const writeValue = useCallback((val: number) => {
    const v = val >>> 0
    setNcValues(String(v), v.toString(16).toUpperCase(), v.toString(2))
    setDraft(null)
  }, [setNcValues])

  const handleChange = useCallback((field: Field, e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target
    const raw = el.value
    const { text, caret } = filterInput(field, raw, el.selectionStart ?? raw.length)

    // 超出该进制的最大位数（如前导 0 堆到 16 位的 0000000000FFF223）：拒绝这次输入
    if (text.length > MAX_LEN[field]) {
      warn(`len-${field}`, LEN_HINT[field], '超出的字符已忽略')
      return
    }

    // 超出 32 位无符号范围：拒绝这次输入，字符不会进入输入框
    const num = text === ''
      ? 0
      : parseInt(text, field === 'hex' ? 16 : field === 'bin' ? 2 : 10)
    if (num > MAX_UINT32) {
      warn('range', '数值超出 32 位无符号范围', '最大 4294967295 (0xFFFFFFFF)，本次输入已忽略')
      return
    }

    setDraft({ field, text })
    if (text !== raw) caretRef.current = { field, pos: caret }

    if (text === '') {
      // 空输入：数值按 0 处理，当前字段保持为空便于继续输入
      setNcValues('0', '0', '0')
      return
    }

    // 输入合法：更新数值，当前输入框继续显示用户原始文本（草稿）
    setNcValues(String(num), num.toString(16).toUpperCase(), num.toString(2))
  }, [setNcValues, warn])

  // 失焦：丢弃草稿，输入框回到规范值
  const handleBlur = useCallback(() => {
    setDraft(null)
  }, [])

  const handleToggleBit = useCallback((bitIndex: number) => {
    writeValue(value ^ (1 << bitIndex))
  }, [value, writeValue])

  const handleReset = useCallback(() => {
    writeValue(0)
  }, [writeValue])

  // 解析移位位数，非法或越界时提示
  const parseShiftAmount = useCallback((): number | null => {
    const n = parseInt(shiftAmount, 10)
    if (Number.isNaN(n) || n < 0 || n > 31) {
      warn('shift', '移位位数无效', '移位位数需为 0-31 的整数')
      return null
    }
    return n
  }, [shiftAmount, warn])

  // 左移：低位补 0，超过 32 位部分丢弃
  const handleShiftLeft = useCallback(() => {
    const n = parseShiftAmount()
    if (n === null) return
    writeValue((value << n) >>> 0)
  }, [parseShiftAmount, value, writeValue])

  // 右移：逻辑右移，高位补 0
  const handleShiftRight = useCallback(() => {
    const n = parseShiftAmount()
    if (n === null) return
    writeValue(value >>> n)
  }, [parseShiftAmount, value, writeValue])

  // 输入框显示文本：正在编辑的字段显示草稿，其余显示 store 中的规范值
  const decText = draft?.field === 'dec' ? draft.text : decimal
  const hexText = draft?.field === 'hex' ? draft.text : hex
  const binText = draft?.field === 'bin' ? draft.text : binary

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
            ref={inputRefs.dec}
            value={decText}
            onChange={(e) => handleChange('dec', e)}
            onBlur={handleBlur}
            className="font-mono"
            placeholder="0"
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Hex value</label>
          <Input
            ref={inputRefs.hex}
            value={hexText}
            onChange={(e) => handleChange('hex', e)}
            onBlur={handleBlur}
            className="font-mono"
            placeholder="0"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Binary value</label>
          <Input
            ref={inputRefs.bin}
            value={binText}
            onChange={(e) => handleChange('bin', e)}
            onBlur={handleBlur}
            className="font-mono"
            placeholder="0"
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
        </div>
      </div>

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
