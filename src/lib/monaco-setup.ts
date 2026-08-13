/**
 * Monaco 全局初始化（Zone 源码视图）
 *
 * - 离线 Electron：让 @monaco-editor/react 使用打包的 monaco 实例，而非默认的 CDN 加载
 * - 配置 web worker（Vite `?worker` 语法），保证编辑器离线可用
 * - 注册 ARM/Thumb 汇编语言（Monarch 轻量 tokenizer，复用 source-highlight 词表）
 * - 定义 omni-dark / omni-light 双主题：dark 对齐 Tailwind 深色配色，light 对齐 VS Code Light+ 配色
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import { ASM_MNEMONICS, ASM_REGISTERS } from './source-highlight'

// 离线 Electron：告诉 monaco 在主线程（而非 CDN worker）创建 worker
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
}

// 让 @monaco-editor/react 使用上面 import 的 monaco 实例
loader.config({ monaco })

// ── ARM/Thumb 汇编语言（Monarch）────────────────────────────
monaco.languages.register({ id: 'arm-asm' })
monaco.languages.setMonarchTokensProvider('arm-asm', {
  defaultToken: 'identifier',
  tokenizer: {
    root: [
      [/;.*$/, 'comment'],
      [/\.[A-Za-z_][A-Za-z0-9_]*/, 'preproc'],
      [new RegExp(`\\b(?:${Array.from(ASM_MNEMONICS).join('|')})\\b`, 'i'), 'keyword'],
      [new RegExp(`\\b(?:${Array.from(ASM_REGISTERS).join('|')})\\b`, 'i'), 'type'],
      [/[0-9][0-9a-fA-FxXbBoO_]*/, 'number'],
      [/[A-Za-z_][A-Za-z0-9_]*/, 'identifier'],
    ],
  },
} as monaco.languages.IMonarchLanguage)

// ── omni-dark / omni-light 主题 ─────────────────────────────
// omni-dark 运行时读取 globals.css 的 CSS 变量（--background/--foreground/--primary 等）
// 构建，保证与深色应用配色一致；omni-light 对齐 VS Code Light+ 的经典配色。
// 应用主题色定义在 src/styles/globals.css 的 CSS 变量中（--background/--foreground/--primary 等）。
// 这里在运行时读取这些变量构建 Monaco 主题，保证编辑器与整个应用配色一致、可随主题联动。

function readCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v ? `hsl(${v})` : fallback
}

/** 将 hsl 字符串（hsl(H S L) 或 hsl(H,S%,L%)）转为 6 位 hex；无法解析时回退。 */
function hslToHex(input: string, fallback: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(input)) return input
  const m = input.match(/hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)/i)
  if (!m) return fallback
  let h = parseFloat(m[1]) % 360
  const s = parseFloat(m[2]) / 100
  const l = parseFloat(m[3]) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  let r: number, g: number, b: number
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const toHex = (v: number) =>
    Math.round((v + mm) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toLowerCase()
}

/** 定义 omni-dark 主题（对齐 Tailwind 深色变量） */
function defineOmniDarkTheme(): void {
  const bg = readCssVar('--background', '#0d1117')
  const fg = readCssVar('--foreground', '#e6edf3')
  const primary = readCssVar('--primary', '#58a6ff')
  const mutedFg = readCssVar('--muted-foreground', '#8b949e')
  const accent = readCssVar('--accent', '#21262d')

  // Monaco 的 token rules 与 colors 均需 hex 颜色；统一用 hslToHex 转换，避免非法值崩溃
  monaco.editor.defineTheme('omni-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: hslToHex(mutedFg, '7ee787'), fontStyle: 'italic' },
      { token: 'keyword', foreground: hslToHex(primary, '58a6ff') },
      { token: 'type', foreground: hslToHex(primary, '58a6ff') },
      { token: 'number', foreground: '#d2a8ff' },
      { token: 'string', foreground: '#f97583' },
      { token: 'preproc', foreground: '#ffab70' },
      { token: 'identifier', foreground: hslToHex(fg, 'e6edf3') },
    ],
    colors: {
      'editor.background': hslToHex(bg, '#0d1117'),
      'editor.foreground': hslToHex(fg, '#e6edf3'),
      // 第一优先级改造：当前行 / 选中词 / occurrences 高亮（半透明，不与 PC 行装饰叠加过冲突）
      'editor.lineHighlightBackground': hslToHex(accent, '#2a2f3a'),
      'editor.selectionHighlightBackground': hslToHex(accent, '#1f6feb'),
      'editor.occurrencesHighlight.background': hslToHex(accent, '#1f6feb'),
      'editor.occurrencesHighlight.border': hslToHex(primary, '#58a6ff'),
      'editorLineNumber.foreground': hslToHex(mutedFg, '#8b949e'),
      'editorLineNumber.activeForeground': hslToHex(fg, '#e6edf3'),
      'editorGutter.background': hslToHex(bg, '#0d1117'),
      'editor.selectionBackground': hslToHex(primary, '#264f78'),
      // 第一优先级改造：括号配对配色（6 级 + 异常括号）
      'editorBracketHighlight.foreground1': '#ff7b72',
      'editorBracketHighlight.foreground2': '#79c0ff',
      'editorBracketHighlight.foreground3': '#d2a8ff',
      'editorBracketHighlight.foreground4': '#ffa657',
      'editorBracketHighlight.foreground5': '#7ee787',
      'editorBracketHighlight.foreground6': '#ffa657',
      'editorBracketHighlight.unexpectedBracket.foreground': '#f85149',
      'editorBracketPairGuide.background1': '#ff7b72',
      'editorBracketPairGuide.background2': '#79c0ff',
      'editorBracketPairGuide.background3': '#d2a8ff',
      'editorBracketPairGuide.background4': '#ffa657',
      'editorBracketPairGuide.background5': '#7ee787',
      'editorBracketPairGuide.background6': '#ffa657',
      'editorBracketPairGuide.activeBackground1': '#ff7b72',
      'editorBracketPairGuide.activeBackground2': '#79c0ff',
      'editorBracketPairGuide.activeBackground3': '#d2a8ff',
      'editorBracketPairGuide.activeBackground4': '#ffa657',
      'editorBracketPairGuide.activeBackground5': '#7ee787',
      'editorBracketPairGuide.activeBackground6': '#ffa657',
    },
  })
}

/** 定义 omni-light 主题（对齐 VS Code Light+ 经典配色） */
function defineOmniLightTheme(): void {
  monaco.editor.defineTheme('omni-light', {
    base: 'vs',
    inherit: true,
    rules: [
      // VS Code Light+ 经典 token 配色
      { token: 'comment', foreground: '#008000', fontStyle: 'italic' },
      { token: 'keyword', foreground: '#0000ff' },
      { token: 'type', foreground: '#267f99' },
      { token: 'number', foreground: '#098658' },
      { token: 'string', foreground: '#a31515' },
      { token: 'preproc', foreground: '#795e26' },
      { token: 'identifier', foreground: '#000000' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#000000',
      // 当前行 / 选中词 / occurrences 高亮（浅色下用轻柔底色）
      'editor.lineHighlightBackground': '#e8f0fe',
      'editor.selectionHighlightBackground': '#add6ff',
      'editor.occurrencesHighlight.background': '#add6ff',
      'editor.occurrencesHighlight.border': '#007fd4',
      'editorLineNumber.foreground': '#237893',
      'editorLineNumber.activeForeground': '#000000',
      'editorGutter.background': '#ffffff',
      'editor.selectionBackground': '#add6ff',
      // 括号配对配色（VS Code Light+ 默认 6 色循环）
      'editorBracketHighlight.foreground1': '#ff0000',
      'editorBracketHighlight.foreground2': '#0000ff',
      'editorBracketHighlight.foreground3': '#008000',
      'editorBracketHighlight.foreground4': '#ff0000',
      'editorBracketHighlight.foreground5': '#0000ff',
      'editorBracketHighlight.foreground6': '#008000',
      'editorBracketHighlight.unexpectedBracket.foreground': '#ff0000',
      'editorBracketPairGuide.background1': '#ff0000',
      'editorBracketPairGuide.background2': '#0000ff',
      'editorBracketPairGuide.background3': '#008000',
      'editorBracketPairGuide.background4': '#ff0000',
      'editorBracketPairGuide.background5': '#0000ff',
      'editorBracketPairGuide.background6': '#008000',
      'editorBracketPairGuide.activeBackground1': '#ff0000',
      'editorBracketPairGuide.activeBackground2': '#0000ff',
      'editorBracketPairGuide.activeBackground3': '#008000',
      'editorBracketPairGuide.activeBackground4': '#ff0000',
      'editorBracketPairGuide.activeBackground5': '#0000ff',
      'editorBracketPairGuide.activeBackground6': '#008000',
    },
  })
}

export type MonacoThemeName = 'omni-dark' | 'omni-light'

/** 判断当前文档处于深色还是浅色主题（依据 <html>.classList 是否含 .dark，缺省按 --background 亮度推断） */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  const html = document.documentElement
  if (html.classList.contains('dark')) return true
  // 无 .dark 类时，按 --background 的 HSL 亮度粗略推断（浅色主题背景亮度高）
  const bg = readCssVar('--background', '#ffffff')
  const m = bg.match(/hsl\(\s*[\d.]+\s+[\d.]+%\s+([\d.]+)%\s*\)/i)
  if (m) return parseFloat(m[1]) < 50
  return false
}

/** 应用当前主题对应的 Monaco 主题；返回主题名 */
export function applyOmniTheme(): MonacoThemeName {
  defineOmniDarkTheme()
  defineOmniLightTheme()
  return isDarkTheme() ? 'omni-dark' : 'omni-light'
}

/** 按文件路径推断 Monaco 语言 id */
export function monacoLangFor(file: string | null | undefined): string {
  const p = (file ?? '').replace(/\\/g, '/').toLowerCase()
  const base = p.split('/').pop() ?? ''
  if (/\.(c|h|cpp|hpp|cc|cxx)$/.test(base)) return 'cpp'
  if (/\.(s|asm)$/.test(base)) return 'arm-asm'
  return 'plaintext'
}

export { monaco }

// 模块加载时立即应用主题（兜底，保证 theme="omni-dark"/"omni-light" 一定可用）
try {
  applyOmniTheme()
} catch {
  /* 非浏览器环境跳过 */
}