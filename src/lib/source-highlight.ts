/**
 * ARM/Thumb 汇编词表
 *
 * 供 Monaco Monarch 汇编 tokenizer（src/lib/monaco-setup.ts）与
 * 汇编补全（SourceView.tsx）复用，避免两处词表漂移。
 *
 * 历史说明：本文件原为自绘行渲染器的 C/C++/ARM 汇编 tokenizer，
 * Monaco 迁移后 C/C++ 交由 Monaco 内置 `cpp` 语言，汇编交由 Monarch，
 * 故旧 tokenizer 已移除，仅保留汇编词表导出。
 */

/** ARM/Thumb 汇编助记符 */
export const ASM_MNEMONICS = new Set([
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

/** ARM/Thumb 通用寄存器与浮点寄存器 */
export const ASM_REGISTERS = new Set([
  'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11',
  'r12', 'r13', 'r14', 'r15', 'sp', 'lr', 'pc', 'cpsr', 'spsr', 'apsr',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9',
  's10', 's11', 's12', 's13', 's14', 's15', 's16', 's17', 's18', 's19',
  's20', 's21', 's22', 's23', 's24', 's25', 's26', 's27', 's28', 's29',
  's30', 's31', 'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'q0', 'q1',
])
