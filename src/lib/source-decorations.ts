/**
 * 将 Zone 调试状态（PC / 光标行 / 断点）映射为 Monaco 装饰（IModelDeltaDecoration）。
 * 纯函数：输入 store 状态 + 当前模型行数，输出装饰数组，供 editor.deltaDecorations 使用。
 */
import * as monaco from 'monaco-editor'

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 判断两个源码路径（可能一个为 basename）是否指向同一文件 */
function sameFile(a: string, b: string): boolean {
  const na = norm(a)
  const nb = norm(b)
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na)
}

export interface SourceDecorationInput {
  /** 当前激活的源文件（完整路径） */
  activeFile: string | null
  /** PC 行号 */
  pcLine: number | null
  /** Run to Cursor 光标所在行 */
  cursorLine: { file: string; line: number } | null
  /** 已设置的源码断点 */
  breakpoints: { file: string; line: number }[]
  /** 可执行（可打断点）行号集合 */
  executableLines: Set<number>
  /** 当前模型的总行数 */
  lineCount: number
  /** 编辑模式下相对原始内容被修改的行号（minimap 黄色标记） */
  modifiedLines?: Set<number>
  /** 编辑模式下相对原始内容新增的行号（minimap 绿色标记） */
  addedLines?: Set<number>
}

export function buildSourceDecorations(
  input: SourceDecorationInput
): monaco.editor.IModelDeltaDecoration[] {
  const dels: monaco.editor.IModelDeltaDecoration[] = []
  const valid = (l: number) => l >= 1 && l <= input.lineCount

  // PC 行：整行高亮（含行号背景）+ glyph 运行指示
  if (input.pcLine != null && valid(input.pcLine)) {
    // 同行有断点时，运行指示半透明显示，避免盖住断点红点
    const bpOnPcLine = input.breakpoints.some(
      (b) => input.activeFile && sameFile(b.file, input.activeFile) && b.line === input.pcLine
    )
    dels.push({
      range: new monaco.Range(input.pcLine, 1, input.pcLine, 1),
      options: {
        isWholeLine: true,
        className: 'cm-pc',
        marginClassName: 'cm-pc-margin',
      },
    })
    dels.push({
      range: new monaco.Range(input.pcLine, 1, input.pcLine, 1),
      options: {
        glyphMarginClassName: bpOnPcLine ? 'cm-pc-glyph cm-pc-over-bp' : 'cm-pc-glyph',
      },
    })
  }

  // 光标行：整行琥珀高亮
  if (
    input.activeFile &&
    input.cursorLine &&
    sameFile(input.cursorLine.file, input.activeFile) &&
    valid(input.cursorLine.line)
  ) {
    dels.push({
      range: new monaco.Range(input.cursorLine.line, 1, input.cursorLine.line, 1),
      options: { isWholeLine: true, className: 'cm-cursor' },
    })
  }

  // 断点：glyph 红点 + overview ruler 标尺标记（右侧滚动条一眼看到全文件断点分布）
  for (const bp of input.breakpoints) {
    if (input.activeFile && sameFile(bp.file, input.activeFile) && valid(bp.line)) {
      dels.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          glyphMarginClassName: 'cm-bp',
          overviewRuler: {
            color: '#f85149',
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      })
    }
  }

  // 可执行行：glyph 灰色断点圆点（表示该行可打断点，对齐旧版自绘渲染器）
  // 已设断点的行不再显示灰点（红点优先）
  const bpLines = new Set(
    input.breakpoints
      .filter((b) => input.activeFile && sameFile(b.file, input.activeFile))
      .map((b) => b.line)
  )
  input.executableLines.forEach((line) => {
    if (valid(line) && !bpLines.has(line)) {
      dels.push({
        range: new monaco.Range(line, 1, line, 1),
        options: { glyphMarginClassName: 'cm-bp-available' },
      })
    }
  })

  // 编辑模式下：滚动条（overview ruler）修改行（黄）/ 新增行（绿）标记，对齐 VS Code 的修改行指示
  if (input.modifiedLines) {
    input.modifiedLines.forEach((line) => {
      if (valid(line)) {
        dels.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            overviewRuler: { color: '#ffcc00', position: monaco.editor.OverviewRulerLane.Full },
          },
        })
      }
    })
  }
  if (input.addedLines) {
    input.addedLines.forEach((line) => {
      if (valid(line)) {
        dels.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            overviewRuler: { color: '#3fb950', position: monaco.editor.OverviewRulerLane.Full },
          },
        })
      }
    })
  }

  return dels
}