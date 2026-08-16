"""表达式求值器（白名单式，不用裸 Python eval）

供 Zone 软断点使用：
    - eval_condition(core, expr) -> bool  条件断点：求值为 true 才中断
    - eval_log(core, text) -> str         日志点：替换 {expr} 占位后求值输出

支持：
    - 数字：十进制 / 0x 十六进制
    - 寄存器名：r0-r12, sp, lr, pc, xpsr, apsr, primask, basepri, faultmask, control
    - 读内存：*(u8*)addr / *(u16*)addr / *(u32*)addr
    - 运算符：&& || ! == != < <= > >= + - * / % ( )
"""

from __future__ import annotations

from typing import Any, Optional

# pyOCD Core 上可读的常用寄存器（小写）
_REGISTERS = {
    "sp", "lr", "pc", "xpsr", "apsr", "primask", "basepri", "faultmask", "control",
    *(f"r{i}" for i in range(13)),
}

# 运算符优先级（越大越先结合）
_PREC = {
    "||": 1,
    "&&": 2,
    "==": 3, "!=": 3,
    "<": 4, "<=": 4, ">": 4, ">=": 4,
    "+": 5, "-": 5,
    "*": 6, "/": 6, "%": 6,
}


class _ExprError(ValueError):
    """表达式解析/求值错误"""


# ── Tokenizer ──────────────────────────────

class _Tok:
    __slots__ = ("kind", "value")

    def __init__(self, kind: str, value: Any = None):
        self.kind = kind  # 'num' | 'reg' | 'mem' | 'op' | 'lparen' | 'rparen' | 'end'
        self.value = value

    def __repr__(self):
        return f"Tok({self.kind},{self.value!r})"


def _tokenize(src: str) -> list[_Tok]:
    toks: list[_Tok] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
            continue
        if c.isdigit() or (c == "0" and i + 1 < n and src[i + 1].lower() == "x"):
            j = i
            if src[i:i + 2].lower() == "0x":
                j += 2
                while j < n and (src[j].isdigit() or src[j].lower() in "abcdef"):
                    j += 1
                toks.append(_Tok("num", int(src[i:j], 16)))
            else:
                while j < n and src[j].isdigit():
                    j += 1
                toks.append(_Tok("num", int(src[i:j], 10)))
            i = j
            continue
        if c == "*" and i + 1 < n and src[i + 1] == "(":
            # *(u8*)addr 内存读
            j = src.find(")", i + 2)
            if j == -1:
                raise _ExprError("内存读缺少右括号")
            inner = src[i + 2:j].strip().rstrip("*")
            if not inner.startswith("u") or not inner[1:].isdigit():
                raise _ExprError(f"不支持的读内存宽度: {inner}")
            toks.append(_Tok("mem", int(inner[1:])))
            i = j + 1
            continue
        if c.isalpha() or c == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            name = src[i:j].lower()
            if name not in _REGISTERS:
                raise _ExprError(f"未知标识符: {name}")
            toks.append(_Tok("reg", name))
            i = j
            continue
        two = src[i:i + 2]
        if two in _PREC:
            toks.append(_Tok("op", two))
            i += 2
            continue
        if c in "+-*/%<>=!":
            toks.append(_Tok("op", c))
            i += 1
            continue
        if c == "(":
            toks.append(_Tok("lparen"))
            i += 1
            continue
        if c == ")":
            toks.append(_Tok("rparen"))
            i += 1
            continue
        raise _ExprError(f"无法识别的字符: {c!r}")
    toks.append(_Tok("end"))
    return toks


# ── 递归下降解析 ───────────────────────────

class _Parser:
    def __init__(self, toks: list[_Tok]):
        self.toks = toks
        self.pos = 0

    def peek(self) -> _Tok:
        return self.toks[self.pos]

    def advance(self) -> _Tok:
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def expect_op(self, op: str):
        t = self.peek()
        if t.kind != "op" or t.value != op:
            raise _ExprError(f"期望 {op!r}")
        return self.advance()

    def parse(self):
        node = self._or()
        if self.peek().kind != "end":
            raise _ExprError("表达式多余内容")
        return node

    def _or(self):
        node = self._and()
        while self.peek().kind == "op" and self.peek().value == "||":
            self.advance()
            node = ("||", node, self._and())
        return node

    def _and(self):
        node = self._cmp()
        while self.peek().kind == "op" and self.peek().value == "&&":
            self.advance()
            node = ("&&", node, self._cmp())
        return node

    def _cmp(self):
        node = self._add()
        while self.peek().kind == "op" and self.peek().value in ("==", "!=", "<", "<=", ">", ">="):
            op = self.advance().value
            node = (op, node, self._add())
        return node

    def _add(self):
        node = self._mul()
        while self.peek().kind == "op" and self.peek().value in ("+", "-"):
            op = self.advance().value
            node = (op, node, self._mul())
        return node

    def _mul(self):
        node = self._unary()
        while self.peek().kind == "op" and self.peek().value in ("*", "/", "%"):
            op = self.advance().value
            node = (op, node, self._unary())
        return node

    def _unary(self):
        if self.peek().kind == "op" and self.peek().value == "!":
            self.advance()
            return ("!", self._unary())
        return self._primary()

    def _primary(self):
        t = self.peek()
        if t.kind == "num":
            self.advance()
            return ("num", t.value)
        if t.kind == "reg":
            self.advance()
            return ("reg", t.value)
        if t.kind == "mem":
            # *(uN*) 已由 tokenizer 消费为 mem(width)，其后是地址表达式
            self.advance()
            return ("mem", self._unary(), t.value)
        if t.kind == "lparen":
            self.advance()
            node = self._or()
            if self.peek().kind != "rparen":
                raise _ExprError("缺右括号")
            self.advance()
            return node
        raise _ExprError("意外的 token")


def _parse(expr: str):
    return _Parser(_tokenize(expr)).parse()


# ── 求值 ──────────────────────────────────

def _resolve_reg(core, name: str) -> int:
    try:
        if name == "pc":
            return int(core.read_core_register("pc")) & ~1
        return int(core.read_core_register(name))
    except Exception as e:
        raise _ExprError(f"读取寄存器 {name} 失败: {e}")


def _read_mem(core, addr: int, width_bits: int) -> int:
    try:
        nbytes = width_bits // 8
        raw = core.read_memory(addr, nbytes)
        return int.from_bytes(raw, "little") if isinstance(raw, (bytes, bytearray)) else int(raw)
    except Exception as e:
        raise _ExprError(f"读内存 0x{addr:x} 失败: {e}")


def _eval(node, core) -> int:
    kind = node[0]
    if kind == "num":
        return node[1]
    if kind == "reg":
        return _resolve_reg(core, node[1])
    if kind == "mem":
        return _read_mem(core, _eval(node[1], core), node[2])
    if kind == "!":
        return 0 if _eval(node[1], core) else 1
    op, left, right = node
    a = _eval(left, core)
    b = _eval(right, core)
    if op == "||":
        return 1 if (a or b) else 0
    if op == "&&":
        return 1 if (a and b) else 0
    if op == "==":
        return 1 if a == b else 0
    if op == "!=":
        return 1 if a != b else 0
    if op == "<":
        return 1 if a < b else 0
    if op == "<=":
        return 1 if a <= b else 0
    if op == ">":
        return 1 if a > b else 0
    if op == ">=":
        return 1 if a >= b else 0
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        if b == 0:
            raise _ExprError("除零")
        return a // b
    if op == "%":
        if b == 0:
            raise _ExprError("取模除零")
        return a % b
    raise _ExprError(f"未知运算符: {op}")


def eval_condition(core, expr: str) -> bool:
    """条件断点求值：表达式为真才中断。expr 为空/空白视为无条件（返回 True）。"""
    if not expr or not expr.strip():
        return True
    return bool(_eval(_parse(expr), core))


def eval_log(core, text: str) -> str:
    """日志点求值：将 {expr} 占位替换为表达式求值结果。

    形如 r0={r0}  mem={*(u32*)0x20000000}  的文本，逐段求值输出。
    """
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        start = text.find("{", i)
        if start == -1:
            out.append(text[i:])
            break
        end = text.find("}", start + 1)
        if end == -1:
            out.append(text[i:])
            break
        out.append(text[i:start])
        expr = text[start + 1:end].strip()
        if expr:
            try:
                out.append(str(_eval(_parse(expr), core)))
            except _ExprError as e:
                out.append(f"<err:{e}>")
            except Exception as e:
                out.append(f"<err:{e}>")
        i = end + 1
    return "".join(out)