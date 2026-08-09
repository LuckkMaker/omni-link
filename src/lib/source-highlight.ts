/**
 * 轻量源码语法高亮
 *
 * 为 Zone 源码视图提供零依赖的 C/C++/ARM 汇编 tokenizer。
 * 逐行分词，并在跨行阶段状态（块注释）中保持连续性，从而适配
 * 现有「按行渲染 + 行号 + 断点 + PC 高亮」的源码视图结构。
 *
 * 参考 Eclipse CDT Cloud 的源码视图思路（Monaco + 语言服务做高亮），
 * 但此处为离线嵌入式工具，采用更轻量的 tokenizer 方案，避免引入
 * Monaco 等重型编辑器依赖，同时保留对行内 PC/断点标记的完全控制。
 */

export type HighlightLang = 'c' | 'asm'

/** 跨行分词阶段状态 */
export interface HighlightState {
  /** 是否处于块注释 /* ... *​/ 中 */
  blockComment: boolean
}

export interface Token {
  text: string
  /** Tailwind 类名 */
  cls: string
}

export function createHighlightState(): HighlightState {
  return { blockComment: false }
}

// ── 颜色类（C/C++ 经典配色：注释绿色 / 关键字蓝色 / 字符串红色 / 其他黑色） ──
const CLS = {
  keyword: 'font-semibold text-blue-600',
  type: 'font-semibold text-blue-600',
  string: 'text-red-600',
  char: 'text-red-600',
  comment: 'italic text-green-700',
  number: 'text-black dark:text-gray-200',
  function: 'text-black dark:text-gray-200',
  preproc: 'text-black dark:text-gray-200',
  register: 'text-black dark:text-gray-200',
  include: 'text-red-600',
  plain: 'text-black dark:text-gray-200',
}

// ── C/C++ 关键字 ────────────────────────
const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'const', 'constexpr', 'continue', 'default', 'do', 'else',
  'enum', 'extern', 'for', 'goto', 'if', 'inline', 'register', 'restrict', 'return',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'volatile', 'while',
  '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex', '_Generic', '_Imaginary',
  '_Noreturn', '_Static_assert', '_Thread_local', 'alignas', 'alignof',
  'asm', 'bool', 'catch', 'class', 'concept', 'consteval', 'constinit', 'decltype',
  'delete', 'dynamic_cast', 'explicit', 'export', 'false', 'final', 'friend',
  'import', 'module', 'mutable', 'namespace', 'new', 'noexcept', 'nullptr',
  'operator', 'override', 'private', 'protected', 'public', 'requires',
  'reinterpret_cast', 'static_assert', 'static_cast', 'template', 'this',
  'thread_local', 'throw', 'true', 'try', 'typeid', 'typename', 'using',
  'virtual', 'wchar_t',
])

// ── C/C++ 类型 ──────────────────────────
const C_TYPES = new Set([
  'char', 'short', 'int', 'long', 'float', 'double', 'void', 'signed', 'unsigned',
  'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t',
  'uint64_t', 'int_least8_t', 'int_least16_t', 'int_least32_t', 'int_least64_t',
  'uint_least8_t', 'uint_least16_t', 'uint_least32_t', 'uint_least64_t',
  'int_fast8_t', 'int_fast16_t', 'int_fast32_t', 'int_fast64_t',
  'uint_fast8_t', 'uint_fast16_t', 'uint_fast32_t', 'uint_fast64_t',
  'intptr_t', 'uintptr_t', 'size_t', 'ssize_t', 'ptrdiff_t', 'intmax_t',
  'uintmax_t', 'byte', 'FILE', 'va_list', 'errno_t', 'wchar_t', 'char8_t',
  'char16_t', 'char32_t',
])

// ── ARM/Thumb 汇编助记符 ────────────────
const ASM_MNEMONICS = new Set([
  'add', 'adc', 'sub', 'sbc', 'rsb', 'mul', 'mla', 'umull', 'umlal', 'smull',
  'smlal', 'udiv', 'sdiv', 'and', 'orr', 'eor', 'bic', 'orn', 'tst', 'teq',
  'cmp', 'cmn', 'lsl', 'lsr', 'asr', 'ror', 'rrx', 'mov', 'mvn', 'neg',
  'ldr', 'str', 'ldrb', 'strb', 'ldrh', 'strh', 'ldrsb', 'ldrsh', 'ldrd',
  'strd', 'ldm', 'stm', 'push', 'pop', 'ldmdb', 'ldmia', 'stmdb', 'stmia',
  'b', 'bl', 'blx', 'bx', 'bxj', 'cbz', 'cbnz', 'it', 'ite', 'itt', 'ittt',
  'itte', 'itttt', 'ittte', 'ittet', 'wfi', 'wfe', 'sev', 'nop', 'yield',
  'bkpt', 'sxtb', 'sxth', 'uxtb', 'uxth', 'rev', 'rev16', 'revsh', 'rbit',
  'clz', 'cps', 'cpsid', 'cpsie', 'dmb', 'dsb', 'isb', 'mrs', 'msr',
  'vldr', 'vstr', 'vldm', 'vstm', 'vpush', 'vpop', 'vadd', 'vsub', 'vmul',
  'vdiv', 'vabs', 'vneg', 'vmov', 'vcvt', 'vcmpe', 'vcmp',
])

const ASM_REGISTERS = new Set([
  'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11',
  'r12', 'r13', 'r14', 'r15', 'sp', 'lr', 'pc', 'cpsr', 'spsr', 'apsr',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9',
  's10', 's11', 's12', 's13', 's14', 's15', 's16', 's17', 's18', 's19',
  's20', 's21', 's22', 's23', 's24', 's25', 's26', 's27', 's28', 's29',
  's30', 's31', 'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'q0', 'q1',
])

/**
 * 逐行分词。`state` 会在调用间共享，用于跨行块注释状态保持。
 * 返回该行生成的 token 列表。
 */
export function tokenizeLine(line: string, state: HighlightState, lang: HighlightLang = 'c'): Token[] {
  const tokens: Token[] = []
  const n = line.length
  let i = 0

  // 处理跨行块注释起始
  if (state.blockComment) {
    const end = line.indexOf('*/')
    if (end === -1) {
      if (line.length > 0) tokens.push({ text: line, cls: CLS.comment })
      return tokens
    }
    const head = line.slice(0, end + 2)
    if (head.length > 0) tokens.push({ text: head, cls: CLS.comment })
    state.blockComment = false
    i = end + 2
  }

  // 预处理指令（# 位于行首）：# + 指令名作为关键字高亮，其余内容继续走主循环（字符串/宏名等可高亮）
  if (i === 0 && /^\s*#/.test(line)) {
    const m = line.match(/^\s*(#[A-Za-z]+)/)
    if (m) {
      tokens.push({ text: m[1], cls: CLS.keyword })
      i = m[0].length
      // #include 的头文件路径（<xxx.h> / "xxx.h"）单独用 include 类高亮
      if (/^#include$/i.test(m[1])) {
        const hm = line.slice(i).match(/^(\s*)(<[^>\r\n]+>|"[^"\r\n]+")/)
        if (hm) {
          if (hm[1]) tokens.push({ text: hm[1], cls: CLS.plain })
          tokens.push({ text: hm[2], cls: CLS.include })
          i += hm[0].length
        }
      }
    }
  }

  while (i < n) {
    const ch = line[i]
    const next = line[i + 1] ?? ''

    // 块注释开始
    if (ch === '/' && next === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) {
        tokens.push({ text: line.slice(i), cls: CLS.comment })
        state.blockComment = true
        break
      }
      tokens.push({ text: line.slice(i, end + 2), cls: CLS.comment })
      i = end + 2
      continue
    }

    // 行注释
    if (ch === '/' && next === '/') {
      tokens.push({ text: line.slice(i), cls: CLS.comment })
      break
    }

    // 汇编行注释（GAS 部分汇编器/ARM 风格用 ; 表示注释）
    if (ch === ';' && lang === 'asm') {
      tokens.push({ text: line.slice(i), cls: CLS.comment })
      break
    }

    // 字符串字面量
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === '"') { j++; break }
        j++
      }
      tokens.push({ text: line.slice(i, j), cls: CLS.string })
      i = j
      continue
    }

    // 字符字面量
    if (ch === "'") {
      let j = i + 1
      while (j < n) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === "'") { j++; break }
        j++
      }
      tokens.push({ text: line.slice(i, j), cls: CLS.char })
      i = j
      continue
    }

    // 数字（十六进制 / 二进制 / 十进制 / 浮点）
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next)) || (ch === '.' && lang === 'asm')) {
      // 汇编伪指令 / 标签前缀（.section .word .global ...）
      if (ch === '.' && lang === 'asm') {
        let j = i
        while (j < n && /[A-Za-z0-9_.]/.test(line[j])) j++
        tokens.push({ text: line.slice(i, j), cls: CLS.preproc })
        i = j
        continue
      }
      let j = i
      if (line.startsWith('0x', i) || line.startsWith('0X', i)) {
        j = i + 2
        while (j < n && /[0-9a-fA-F_]/.test(line[j])) j++
      } else if (line.startsWith('0b', i) || line.startsWith('0B', i)) {
        j = i + 2
        while (j < n && /[01_]/.test(line[j])) j++
      } else {
        while (j < n && /[0-9a-fA-FxXbBoOeEuUlLdD_.]/.test(line[j])) j++
      }
      tokens.push({ text: line.slice(i, j), cls: CLS.number })
      i = j
      continue
    }

    // 标识符 / 关键词 / 类型 / 函数调用 / 汇编助记符与寄存器
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++
      const word = line.slice(i, j)
      tokens.push({ text: word, cls: classifyWord(word, line, j, lang) })
      i = j
      continue
    }

    // 其余字符（标点 / 空白）按连续段合并
    let j = i
    while (j < n && !isSpecialStart(line[j], line[j + 1] ?? '', lang)) j++
    // 防止死循环：若合并段长度为 0（当前字符即特殊字符），必须推进一位，否则 i 永不前进
    if (j === i) j = i + 1
    tokens.push({ text: line.slice(i, j), cls: CLS.plain })
    i = j
  }

  return tokens
}

// 特殊字符作为"下一段"的起始：普通字符合并段须在此处停下。
// 注意：';' 仅当 lang === 'asm' 时作为特殊字符（汇编行注释）。在 C 语言中 ';' 是普通标点，
// 若也作为特殊字符，普通合并段长度为 0 且无后续分支处理，会导致死循环。
const isSpecialStart = (c: string, next: string, lang: HighlightLang): boolean =>
  /[A-Za-z0-9_"']/.test(c) || (lang === 'asm' && c === ';') || (c === '/' && (next === '/' || next === '*'))

function classifyWord(word: string, line: string, end: number, lang: HighlightLang): string {
  if (lang === 'asm') {
    if (ASM_MNEMONICS.has(word.toLowerCase())) return CLS.keyword
    if (ASM_REGISTERS.has(word.toLowerCase())) return CLS.register
    return CLS.plain
  }
  if (C_KEYWORDS.has(word)) return CLS.keyword
  if (C_TYPES.has(word)) return CLS.type
  // 函数调用：标识符后紧跟 '('（允许中间有空白）
  let k = end
  while (k < line.length && line[k] === ' ') k++
  if (line[k] === '(') return CLS.function
  return CLS.plain
}

/** 根据文件路径推断语言 */
export function detectLang(filePath: string | null | undefined): HighlightLang {
  const p = (filePath ?? '').replace(/\\/g, '/').toLowerCase()
  const base = p.split('/').pop() ?? ''
  if (/\.(s|asm)$/.test(base) || /\.(s|asm)$/.test(p)) return 'asm'
  return 'c'
}