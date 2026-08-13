"""DWARF 局部变量 / 形参解析与位置表达式求值（供 Zone Call Stack + Locals 面板）

职责：
    - 遍历 ELF 的 DWARF 调试信息，按函数起始地址建立索引：
      函数签名（返回类型 + 形参类型列表）与本函数内形参/局部变量的
      （名称、类型名、类型字节大小、位置表达式）。
    - 求值 DWARF 位置表达式（寄存器 / 栈相对 / 帧基址 / 常量 / deref 等），
      支持 .debug_loc 位置列表按 PC 匹配。
    - 给定当前寄存器与内存读取回调，读取变量当前值。

对无法解析或不支持的场景保持健壮（返回 None / 空列表），不抛异常阻断调用栈。
"""
import logging

logger = logging.getLogger(__name__)

# DIE.tag 在 pyelftools 中返回字符串（如 'DW_TAG_subprogram'），直接按字符串比较
_TAG_BASE_TYPE = "DW_TAG_base_type"
_TAG_TYPEDEF = "DW_TAG_typedef"
_TAG_STRUCT = "DW_TAG_structure_type"
_TAG_UNION = "DW_TAG_union_type"
_TAG_ENUM = "DW_TAG_enumeration_type"
_TAG_POINTER = "DW_TAG_pointer_type"
_TAG_CONST = "DW_TAG_const_type"
_TAG_VOLATILE = "DW_TAG_volatile_type"
_TAG_RESTRICT = "DW_TAG_restrict_type"
_TAG_ARRAY = "DW_TAG_array_type"
_TAG_SUBROUTINE = "DW_TAG_subroutine_type"
_TAG_SUBPROGRAM = "DW_TAG_subprogram"
_TAG_FORMAL_PARAM = "DW_TAG_formal_parameter"
_TAG_VARIABLE = "DW_TAG_variable"
_TAG_SUBRANGE = "DW_TAG_subrange_type"
_TAG_MEMBER = "DW_TAG_member"

# 寄存器下标 → 寄存器名（供位置表达式引用；与后端核心寄存器 key 对齐）
_REG_NAMES = {
    0: "r0", 1: "r1", 2: "r2", 3: "r3", 4: "r4", 5: "r5", 6: "r6",
    7: "r7", 8: "r8", 9: "r9", 10: "r10", 11: "r11", 12: "r12",
    13: "sp", 14: "lr", 15: "pc",
}

# 记录无法解析的 ELF 路径，避免重复打海量日志
_warned = set()


class VarInfo:
    __slots__ = ("name", "type_name", "type_size", "is_param", "location", "type_die")

    def __init__(self, name, type_name, type_size, is_param, location, type_die=None):
        self.name = name
        self.type_name = type_name
        self.type_size = type_size
        self.is_param = is_param
        # location: ('expr', bytes) 或 ('loclist', offset)
        self.location = location
        # type_die: 变量声明类型的 DIE（用于展开结构体/数组成员），可空
        self.type_die = type_die


class FuncInfo:
    __slots__ = ("name", "address", "ret_type", "signature", "frame_base", "args", "locals", "decl_line")

    def __init__(self, name, address, ret_type, signature, frame_base, args, locals_, decl_line=None):
        self.name = name
        self.address = address
        self.ret_type = ret_type
        self.signature = signature
        # frame_base: ('expr', bytes) 或 ('loclist', offset) 或 None
        self.frame_base = frame_base
        self.args = args
        self.locals = locals_
        # decl_line: DWARF 函数声明行（定义所在行），用于跳转/CodeLens 定位
        self.decl_line = decl_line


# ── ULEB128 / SLEB128（pyelftools 内部有，但这里自实现，操作字节流更直接） ──
def _read_uleb(data, i):
    result = 0
    shift = 0
    while True:
        b = data[i]
        i += 1
        result |= (b & 0x7f) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, i


def _read_sleb(data, i):
    result = 0
    shift = 0
    while True:
        b = data[i]
        i += 1
        result |= (b & 0x7f) << shift
        shift += 7
        if not (b & 0x80):
            if (b & 0x40) and shift < 64:
                result |= (~0 << shift)
            break
    return result, i


class DwarfLocals:
    """按 ELF 构建 函数地址 → 变量/签名 索引，并提供位置表达式求值。"""

    def __init__(self, dwarfinfo):
        self.dwarfinfo = dwarfinfo
        # address -> FuncInfo
        self._funcs = {}
        # name -> VarInfo（全局变量，DW_OP_addr 定位）
        self._globals = {}
        self._loclists = None
        try:
            self._loclists = dwarfinfo.location_lists()
        except Exception:
            self._loclists = None
        self._build()

    # ── 索引构建 ──────────────────────────────
    def _build(self):
        for cu in self.dwarfinfo.iter_CUs():
            # 顶层 DW_TAG_variable = 全局变量（非函数内局部变量），DW_OP_addr 定位
            try:
                top = cu.get_top_DIE()
                for die in top.iter_children():
                    if die.tag == _TAG_VARIABLE:
                        try:
                            self._index_global(die)
                        except Exception:
                            continue
            except Exception:
                pass
            for die in cu.iter_DIEs():
                if die.tag != _TAG_SUBPROGRAM:
                    continue
                try:
                    self._index_subprogram(die)
                except Exception:
                    continue

    def _index_subprogram(self, die):
        if "DW_AT_low_pc" not in die.attributes or "DW_AT_name" not in die.attributes:
            return
        low_pc = die.attributes["DW_AT_low_pc"].value
        if low_pc == 0:
            return
        name = _to_str(die.attributes["DW_AT_name"].value)
        if not name:
            return

        ret_type_name = ""
        if "DW_AT_type" in die.attributes:
            t = self._resolve_type(die.get_DIE_from_attribute("DW_AT_type"))
            ret_type_name = t[0]

        args = []
        locals_ = []
        for child in die.iter_children():
            if child.tag == _TAG_FORMAL_PARAM:
                v = self._make_var(child, is_param=True)
                if v:
                    args.append(v)
            elif child.tag == _TAG_VARIABLE:
                v = self._make_var(child, is_param=False)
                if v:
                    locals_.append(v)

        param_types = [a.type_name for a in args]
        signature = self._format_signature(ret_type_name, name, param_types)
        frame_base = self._frame_base_of(die)

        decl_line = None
        if "DW_AT_decl_line" in die.attributes:
            decl_line = die.attributes["DW_AT_decl_line"].value

        self._funcs[low_pc] = FuncInfo(
            name=name,
            address=low_pc,
            ret_type=ret_type_name,
            signature=signature,
            frame_base=frame_base,
            args=args,
            locals_=locals_,
            decl_line=decl_line,
        )

    def _index_global(self, die):
        """索引全局变量（CU 顶层 DW_TAG_variable），按名字精确匹配"""
        if "DW_AT_name" not in die.attributes:
            return
        name = _to_str(die.attributes["DW_AT_name"].value)
        if not name:
            return
        v = self._make_var(die, is_param=False)
        if v:
            self._globals[name] = v

    def _make_var(self, die, is_param):
        if "DW_AT_name" not in die.attributes:
            return None
        name = _to_str(die.attributes["DW_AT_name"].value)
        type_name = ""
        type_size = 4
        type_die = None
        if "DW_AT_type" in die.attributes:
            type_die = die.get_DIE_from_attribute("DW_AT_type")
            t = self._resolve_type(type_die)
            type_name, type_size = t
        location = self._location_of(die)
        if location is None:
            return None
        return VarInfo(name, type_name, type_size, is_param, location, type_die)

    def _frame_base_of(self, die):
        return self._location_of(die, attr="DW_AT_frame_base")

    def _location_of(self, die, attr="DW_AT_location"):
        if attr not in die.attributes:
            return None
        a = die.attributes[attr]
        form = a.form
        val = a.value
        if form in ("DW_FORM_exprloc",) or form.startswith("DW_FORM_block"):
            # pyelftools 0.33 的 exprloc 值为 ListContainer（元素为 int 或单字节 bytes）
            if isinstance(val, (bytes, bytearray)):
                return ("expr", bytes(val))
            if isinstance(val, (list, tuple)):
                out = bytearray()
                for x in val:
                    if isinstance(x, int):
                        out.append(x)
                    elif isinstance(x, (bytes, bytearray)) and len(x) == 1:
                        out.append(x[0])
                    else:
                        out.extend(bytes(x))
                return ("expr", bytes(out))
            return None
        # DW_FORM_sec_offset / data4 → .debug_loc 位置列表偏移
        if isinstance(val, int):
            return ("loclist", val)
        return None

    # ── 类型解析（递归，带深度限制） ──────────
    def _resolve_type(self, die, _depth=0, _seen=None):
        if _depth > 12:
            return ("...", 0)
        if _seen is None:
            _seen = set()
        tid = id(die)
        if tid in _seen:
            return ("...", 0)
        _seen = _seen | {tid}
        tag = die.tag
        if tag == _TAG_TYPEDEF:
            # typedef 穿透到实际类型：struct 显示 struct，数组显示 [N]，指针显示 T*
            if "DW_AT_type" in die.attributes:
                return self._resolve_type(
                    die.get_DIE_from_attribute("DW_AT_type"), _depth + 1, _seen
                )
            return ("typedef", 0)
        if tag in (_TAG_BASE_TYPE, _TAG_STRUCT,
                   _TAG_UNION, _TAG_ENUM):
            nm = _to_str(die.attributes.get("DW_AT_name").value) if "DW_AT_name" in die.attributes else ""
            size = die.attributes.get("DW_AT_byte_size").value if "DW_AT_byte_size" in die.attributes else 0
            if tag == _TAG_STRUCT:
                return ("struct", size or 4)
            if tag == _TAG_UNION:
                return ("union", size or 4)
            if tag == _TAG_ENUM:
                # Keil 风格 enum (基类型)：有底层类型则显示基类型，否则仅 enum
                base = ""
                if "DW_AT_type" in die.attributes:
                    base = self._resolve_type(
                        die.get_DIE_from_attribute("DW_AT_type"), _depth + 1, _seen
                    )[0]
                return (f"enum ({base})" if base else "enum", size or 4)
            # base_type：按 Keil 风格简化内置类型名
            return (_short_type(nm or tag.replace("DW_TAG_", "")), size or 4)
        if tag == _TAG_POINTER:
            if "DW_AT_type" in die.attributes:
                inner, _ = self._resolve_type(die.get_DIE_from_attribute("DW_AT_type"), _depth + 1, _seen)
                return (inner + "*", 4)
            return ("void*", 4)
        if tag in (_TAG_CONST, _TAG_VOLATILE, _TAG_RESTRICT):
            if "DW_AT_type" in die.attributes:
                return self._resolve_type(die.get_DIE_from_attribute("DW_AT_type"), _depth + 1, _seen)
            return ("void", 0)
        if tag == _TAG_ARRAY:
            inner = ("void", 0)
            if "DW_AT_type" in die.attributes:
                inner = self._resolve_type(die.get_DIE_from_attribute("DW_AT_type"), _depth + 1, _seen)
            count = 1
            for cd in die.iter_children():
                if cd.tag == _TAG_SUBRANGE and "DW_AT_count" in cd.attributes:
                    count = cd.attributes["DW_AT_count"].value or 1
            return (inner[0] + f"[{count}]", (inner[1] or 1) * count)
        if tag == _TAG_SUBROUTINE:
            return ("func", 4)
        return (tag.replace("DW_TAG_", ""), 0)

    # ── 签名格式化（Keil 风格：`返回类型 f(参数类型...)`，函数名统一用 f 表示函数类型） ──
    @staticmethod
    def _format_signature(ret_type, name, param_types):
        _ = name  # 不保留原函数名，用 'f' 表示函数类型
        parts = []
        for t in param_types:
            t = _short_type(t) if t else "void"
            if len(t) > 24:
                t = t[:23] + "…"
            parts.append(t)
        if not parts:
            parts.append("void")
        ret = _short_type(ret_type) if ret_type else "void"
        # Type 列统一用类型表达：返回类型为枚举时，去掉原枚举名/底层类型，仅用 enum
        if ret.startswith("enum"):
            ret = "enum"
        return f"{ret} f({', '.join(parts)})"

    # ── 轻量签名查询（离线，不依赖寄存器/内存） ──
    def _find_func_by_addr(self, address):
        """返回包含 address 的函数（取 low_pc <= address 且最接近者）；无则 None。"""
        best = None
        for low, func in self._funcs.items():
            if low <= address and (best is None or low > best[0]):
                best = (low, func)
        return best[1] if best else None

    def get_func_signature(self, address):
        """按地址返回函数签名信息（供 hover / 符号解析，无需寄存器与内存）。

        Args:
            address: 函数入口地址（或函数内任意 PC）

        Returns:
            {signature, ret, params} 或 None；
            signature 为 `返回类型 f(参数类型...)` 可读形式，
            ret 为返回类型名（缺省按 void），params 为形参类型名列表。
        """
        if not self._funcs:
            return None
        func = self._funcs.get(address)
        if func is None:
            func = self._find_func_by_addr(address)
        if func is None:
            return None
        params = [a.type_name for a in func.args]
        return {
            "signature": func.signature,
            "ret": func.ret_type or ("void" if func.signature else ""),
            "params": params,
        }

    def get_func_decl_line(self, address):
        """按函数入口地址返回 DWARF 声明行（函数定义所在行）；无则 None。"""
        if not self._funcs:
            return None
        func = self._funcs.get(address)
        if func is None:
            func = self._find_func_by_addr(address)
        return func.decl_line if func is not None else None

    # ── 位置表达式求值 ────────────────────────
    def _frame_base_num(self, func, regs, cfa):
        fb = func.frame_base
        if fb is None:
            return cfa
        try:
            if fb[0] == "loclist":
                expr = self._loc_expr_for_pc(fb[1], func.address, regs)
            else:
                expr = fb[1]
            kind, val = self._eval_expr(expr, regs, cfa, cfa)
            return self._to_num(kind, val, regs)
        except Exception:
            return cfa

    def _loc_expr_for_pc(self, offset, pc, regs):
        if self._loclists is None:
            return None
        try:
            entries = self._loclists.get_location_list_at_offset(offset)
        except Exception:
            return None
        for e in entries:
            bo, eo = getattr(e, "begin_offset", None), getattr(e, "end_offset", None)
            if bo is None or eo is None:
                continue
            if bo <= pc < eo:
                return bytes(getattr(e, "loc_expr", b""))
        # 未命中范围，取第一个非空的表达式
        for e in entries:
            if getattr(e, "loc_expr", None):
                return bytes(e.loc_expr)
        return None

    def _eval_expr(self, expr, regs, frame_base, cfa):
        """求值位置表达式，返回 (kind, value)，kind ∈ {reg, addr, val}。"""
        if not expr:
            return ("val", 0)
        stack = []
        i = 0
        n = len(expr)

        def push(k, v):
            stack.append((k, v))

        def pop():
            return stack.pop()

        def reg_val(ridx):
            key = _REG_NAMES.get(ridx)
            if key is None:
                return 0
            v = regs.get(key)
            return v if isinstance(v, int) else 0

        while i < n:
            op = expr[i]
            i += 1
            try:
                if 0x30 <= op <= 0x4f:  # DW_OP_lit0..31
                    push("val", op - 0x30)
                elif 0x50 <= op <= 0x6f:  # DW_OP_reg0..31
                    push("reg", op - 0x50)
                elif 0x70 <= op <= 0x8f:  # DW_OP_breg0..31
                    off, i = _read_sleb(expr, i)
                    push("addr", reg_val(op - 0x70) + off)
                elif op == 0x03:  # DW_OP_addr
                    # 语义是「变量所在内存地址」，用 addr 类别以便 _eval_var 解引用读取值
                    push("addr", int.from_bytes(expr[i:i + 4], "little"))
                    i += 4
                elif op in (0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f):
                    sz = {0x08: 1, 0x09: 1, 0x0a: 2, 0x0b: 2, 0x0c: 4, 0x0d: 4, 0x0e: 8, 0x0f: 8}[op]
                    signed = op in (0x09, 0x0b, 0x0d, 0x0f)
                    raw = expr[i:i + sz]
                    i += sz
                    push("val", int.from_bytes(raw, "little", signed=signed))
                elif op == 0x10:  # DW_OP_constu
                    v, i = _read_uleb(expr, i)
                    push("val", v)
                elif op == 0x11:  # DW_OP_consts
                    v, i = _read_sleb(expr, i)
                    push("val", v)
                elif op == 0x06:  # DW_OP_deref
                    k, v = pop()
                    addr = self._to_num(k, v, regs)
                    push("val", self._read_word(addr, 4, regs))
                elif op == 0x94:  # DW_OP_deref_size
                    sz, i = _read_uleb(expr, i)
                    k, v = pop()
                    push("val", self._read_word(self._to_num(k, v, regs), sz, regs))
                elif op == 0x22:  # DW_OP_plus
                    k2, v2 = pop()
                    k1, v1 = pop()
                    r = self._to_num(k1, v1, regs) + self._to_num(k2, v2, regs)
                    push("addr" if (k1 == "addr" or k2 == "addr") else "val", r)
                elif op == 0x1c:  # DW_OP_minus
                    k2, v2 = pop()
                    k1, v1 = pop()
                    push("val", self._to_num(k1, v1, regs) - self._to_num(k2, v2, regs))
                elif op == 0x23:  # DW_OP_plus_uconst
                    u, i = _read_uleb(expr, i)
                    k, v = pop()
                    push("addr" if k == "addr" else "val", v + u)
                elif op == 0x91:  # DW_OP_fbreg
                    off, i = _read_sleb(expr, i)
                    push("addr", frame_base + off)
                elif op == 0x90:  # DW_OP_regx
                    ridx, i = _read_uleb(expr, i)
                    push("reg", ridx)
                elif op == 0x92:  # DW_OP_bregx
                    ridx, i = _read_uleb(expr, i)
                    off, i = _read_sleb(expr, i)
                    push("addr", reg_val(ridx) + off)
                elif op == 0x9c:  # DW_OP_call_frame_cfa
                    push("addr", cfa)
                elif op == 0x9f:  # DW_OP_stack_value
                    k, v = pop()
                    push("val", v)
                elif op == 0x12:  # dup
                    stack.append(stack[-1])
                elif op == 0x13:  # drop
                    stack.pop()
                elif op == 0x14:  # swap
                    stack[-1], stack[-2] = stack[-2], stack[-1]
                elif op == 0x96:  # nop
                    pass
                # 其余操作符暂不支持：跳过保持栈顶
            except Exception:
                break
        if not stack:
            return ("val", 0)
        return stack[-1]

    def _read_word(self, addr, size, regs):
        if self._read_mem is None:
            return 0
        try:
            data = self._read_mem(addr, size)
            if data and len(data) >= size:
                return int.from_bytes(data[:size], "little")
        except Exception:
            pass
        return 0

    @staticmethod
    def _to_num(kind, value, regs):
        if kind == "reg":
            key = _REG_NAMES.get(value)
            v = regs.get(key)
            return v if isinstance(v, int) else 0
        return value

    # ── 对外：读取某函数（地址）的变量值 ──────
    def get_func_locals(self, address, regs, read_mem, pc=None):
        """返回 (signature, ret_type, variables)。variables: [{name, type, value, is_param, available}]。

        regs: 当前寄存器（r0..r12, sp, lr, pc, ...）
        read_mem: callable(addr, length) -> bytes
        pc: 用于位置列表 PC 匹配的当前 PC（默认 address）
        """
        func = self._funcs.get(address)
        if func is None:
            # 未命中起始地址：尝试最接近的低地址函数
            func = self._nearest_func(address)
        if func is None:
            return None, "", []
        self._read_mem = read_mem
        pc = pc if pc is not None else address
        cfa = regs.get("sp") or 0
        frame_base = self._frame_base_num(func, regs, cfa)

        variables = []
        for var in list(func.args) + list(func.locals):
            info = self._eval_var(var, pc, regs, frame_base, cfa)
            variables.append(info)
        return func.signature, func.ret_type, variables

    def get_local_var(self, address, name, regs, read_mem, pc=None):
        """在当前函数（address 所在）中按名字查找局部变量/形参并读取当前值。

        Args:
            address: 帧内地址（函数入口或函数内任意 PC）
            name: 变量名（精确匹配）
            regs: 当前寄存器（r0..r12, sp, lr, pc, ...）
            read_mem: callable(addr, length) -> bytes
            pc: 位置列表 PC 匹配用（默认 address）

        Returns:
            {name, type, value, address, available, is_param, bit_size, kind, children} 或 None
        """
        func = self._funcs.get(address)
        if func is None:
            func = self._nearest_func(address)
        if func is None:
            return None
        self._read_mem = read_mem
        pc = pc if pc is not None else address
        cfa = regs.get("sp") or 0
        frame_base = self._frame_base_num(func, regs, cfa)
        for var in list(func.args) + list(func.locals):
            if var.name == name:
                return self._eval_var(var, pc, regs, frame_base, cfa)
        return None

    def get_global_var(self, name, regs, read_mem):
        """按名字读取全局变量值（DW_OP_addr 定位，frame_base 无关）。

        Args:
            name: 全局变量名（精确匹配）
            regs: 当前寄存器
            read_mem: callable(addr, length) -> bytes

        Returns:
            {name, type, value, address, available, is_param, bit_size, kind, children} 或 None
        """
        var = self._globals.get(name)
        if var is None:
            return None
        self._read_mem = read_mem
        cfa = regs.get("sp") or 0
        return self._eval_var(var, 0, regs, 0, cfa)

    def _eval_var(self, var, pc, regs, frame_base, cfa):
        size = var.type_size or 4
        kind = "scalar"
        if var.type_die is not None:
            kind = self._type_kind(var.type_die)
        base = {
            "name": var.name,
            "type": var.type_name,
            "is_param": var.is_param,
            "available": False,
            "value": None,
            "bit_size": size * 8,
            "kind": kind,
            "children": None,
            "address": None,
        }
        compound = kind in ("struct", "array")
        try:
            if var.location[0] == "loclist":
                expr = self._loc_expr_for_pc(var.location[1], pc, regs)
            else:
                expr = var.location[1]
            if not expr:
                return base
            kind_val, val = self._eval_expr(expr, regs, frame_base, cfa)
            if kind_val == "addr":
                base["address"] = val
                if compound:
                    sub = self._build_value_node(var.type_die, val, regs, var.name)
                    if sub:
                        base["children"] = sub["children"]
                        base["kind"] = sub["kind"] or kind
                        base["available"] = True
                    return base
                raw = self._read_word(val, size, regs)
            elif kind_val == "reg":
                raw = self._to_num(kind_val, val, regs)
            else:
                raw = val
            base["value"] = raw
            base["available"] = True
            # 指针：若指向 struct/array 且指针值有效，解引用展开目标成员/元素
            if kind == "pointer":
                self._attach_pointer_children(base, var.type_die, raw, regs)
        except Exception:
            pass
        return base

    def _attach_pointer_children(self, node, die, ptr, regs, depth=0):
        """指针解引用：穿透 typedef/const/volatile 确认是指针，取指向的类型；
        若 pointee 为 struct/array 且指针值有效，在目标地址展开成员/元素挂到 node.children。
        空指针/无效指针/函数指针/指向标量时不展开。递归受 depth 保护。"""
        if not ptr or depth > 12:
            return
        d = die
        ddepth = 0
        while d.tag in (_TAG_CONST, _TAG_VOLATILE, _TAG_RESTRICT, _TAG_TYPEDEF):
            if "DW_AT_type" not in d.attributes or ddepth > 12:
                return
            d = d.get_DIE_from_attribute("DW_AT_type")
            ddepth += 1
        if d.tag != _TAG_POINTER:
            return
        if "DW_AT_type" not in d.attributes:
            return
        pointee = d.get_DIE_from_attribute("DW_AT_type")
        ptag = pointee.tag
        pdepth = 0
        while ptag in (_TAG_CONST, _TAG_VOLATILE, _TAG_RESTRICT, _TAG_TYPEDEF):
            if "DW_AT_type" not in pointee.attributes or pdepth > 12:
                break
            pointee = pointee.get_DIE_from_attribute("DW_AT_type")
            ptag = pointee.tag
            pdepth += 1
        if ptag not in (_TAG_STRUCT, _TAG_ARRAY):
            return
        sub = self._build_value_node(pointee, ptr, regs, node.get("name", ""), depth + 1)
        if sub and sub["children"]:
            node["children"] = sub["children"]

    def _type_kind(self, die, depth=0):
        """穿透 typedef/const/volatile/restrict，返回类型类别：
        struct / array / pointer / scalar。"""
        while die.tag in (_TAG_CONST, _TAG_VOLATILE, _TAG_RESTRICT, _TAG_TYPEDEF):
            if "DW_AT_type" not in die.attributes or depth > 12:
                break
            die = die.get_DIE_from_attribute("DW_AT_type")
            depth += 1
        tag = die.tag
        if tag == _TAG_STRUCT:
            return "struct"
        if tag == _TAG_ARRAY:
            return "array"
        if tag == _TAG_POINTER:
            return "pointer"
        return "scalar"

    def _is_compound(self, die):
        """判断类型 DIE（穿透 typedef/const/volatile）是否为结构体或数组。"""
        tag = die.tag
        while tag in (_TAG_CONST, _TAG_VOLATILE, _TAG_RESTRICT, _TAG_TYPEDEF):
            if "DW_AT_type" not in die.attributes:
                return False
            die = die.get_DIE_from_attribute("DW_AT_type")
            tag = die.tag
        return tag in (_TAG_STRUCT, _TAG_ARRAY)

    def _build_value_node(self, die, addr, regs, name, depth=0):
        """从类型 DIE + 内存地址构造可显示的值节点 dict。

        struct / array 递归展开成员/元素（children），标量读取数值（value）。
        """
        if depth > 12:
            return None
        # 穿透 const/volatile/typedef
        while die.tag in (_TAG_CONST, _TAG_VOLATILE, _TAG_RESTRICT, _TAG_TYPEDEF):
            if "DW_AT_type" not in die.attributes:
                break
            die = die.get_DIE_from_attribute("DW_AT_type")
        tag = die.tag
        type_name, size = self._resolve_type(die)
        node = {
            "name": name,
            "type": type_name,
            "bit_size": (size or 4) * 8,
            "address": addr,
            "value": None,
            "available": True,
            "children": None,
            "kind": "scalar",
        }
        if tag == _TAG_STRUCT:
            node["kind"] = "struct"
            children = []
            for child in die.iter_children():
                if child.tag != _TAG_MEMBER:
                    continue
                mname = (_to_str(child.attributes["DW_AT_name"].value)
                         if "DW_AT_name" in child.attributes else "")
                if "DW_AT_type" not in child.attributes:
                    continue
                off = self._member_offset(child)
                if off is None:
                    continue
                mdie = child.get_DIE_from_attribute("DW_AT_type")
                sub = self._build_value_node(mdie, addr + off, regs, mname, depth + 1)
                if sub:
                    children.append(sub)
            node["children"] = children
        elif tag == _TAG_ARRAY:
            node["kind"] = "array"
            elem_die = None
            if "DW_AT_type" in die.attributes:
                elem_die = die.get_DIE_from_attribute("DW_AT_type")
            count = self._array_count(die)
            elem_size = (self._resolve_type(elem_die)[1] if elem_die else 1) or 1
            children = []
            for i in range(count):
                sub = self._build_value_node(elem_die, addr + i * elem_size, regs, f"[{i}]", depth + 1)
                if sub:
                    children.append(sub)
            node["children"] = children
        elif tag == _TAG_POINTER:
            # 指针：value 显示指针值（指向的地址）；若指向 struct/array 则解引用展开
            node["kind"] = "pointer"
            ptr = self._read_word(addr, 4, regs)
            node["value"] = ptr
            self._attach_pointer_children(node, die, ptr, regs, depth + 1)
        else:
            node["value"] = self._read_word(addr, size or 4, regs)
        return node

    @staticmethod
    def _member_offset(child):
        """解析成员偏移（DW_AT_data_member_location）。常量偏移返回 int；表达式等复杂形式返回 None。"""
        attr = child.attributes.get("DW_AT_data_member_location")
        if attr is None:
            return 0
        v = attr.value
        if isinstance(v, int):
            return v
        if isinstance(v, (bytes, bytearray)):
            try:
                return int.from_bytes(bytes(v), "little")
            except Exception:
                return None
        return None

    @staticmethod
    def _array_count(die):
        count = 1
        for cd in die.iter_children():
            if cd.tag != _TAG_SUBRANGE:
                continue
            if "DW_AT_count" in cd.attributes:
                count = cd.attributes["DW_AT_count"].value or 1
            elif "DW_AT_upper_bound" in cd.attributes:
                ub = cd.attributes["DW_AT_upper_bound"].value
                count = ub + 1 if isinstance(ub, int) else 1
        try:
            return max(1, int(count))
        except Exception:
            return 1

    def _nearest_func(self, address):
        # 调用帧地址可能是函数内非入口地址；找覆盖它的最近函数
        best = None
        for low, f in self._funcs.items():
            if low <= address:
                if best is None or low > best[0]:
                    best = (low, f)
        return best[1] if best else None

    def array_info(self, name):
        """按变量名在 DWARF 中查找数组，返回 (element_size, element_count)；非数组/未找到返回 None。

        供内存地址表达式 name[offset] 解析元素字节大小使用。
        """
        for cu in self.dwarfinfo.iter_CUs():
            for die in cu.iter_DIEs():
                if die.tag != _TAG_VARIABLE:
                    continue
                if "DW_AT_name" not in die.attributes:
                    continue
                if _to_str(die.attributes["DW_AT_name"].value) != name:
                    continue
                if "DW_AT_type" not in die.attributes:
                    continue
                t = die.get_DIE_from_attribute("DW_AT_type")
                depth = 0
                while (t.tag in (_TAG_TYPEDEF, _TAG_CONST, _TAG_VOLATILE, _TAG_RESTRICT)
                       and "DW_AT_type" in t.attributes and depth < 12):
                    t = t.get_DIE_from_attribute("DW_AT_type")
                    depth += 1
                if t.tag != _TAG_ARRAY:
                    return None
                count = self._array_count(t)
                elem_size = 1
                if "DW_AT_type" in t.attributes:
                    res = self._resolve_type(t.get_DIE_from_attribute("DW_AT_type"))
                    elem_size = res[1] or 1
                return (elem_size, count)
        return None


def _to_str(v):
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8", "replace")
        except Exception:
            return v.decode("latin-1", "replace")
    return str(v) if v is not None else ""


# Keil 风格内置类型名简化映射（供签名与变量类型显示）
_SHORT_TYPES = {
    "void": "void", "bool": "bool",
    "char": "char", "signed char": "schar", "unsigned char": "uchar",
    "short": "short", "short int": "short", "signed short": "short",
    "signed short int": "short", "unsigned short": "ushort", "unsigned short int": "ushort",
    "int": "int", "signed": "int", "signed int": "int",
    "unsigned": "uint", "unsigned int": "uint",
    "long": "long", "long int": "long", "signed long": "long", "signed long int": "long",
    "unsigned long": "ulong", "unsigned long int": "ulong",
    "long long": "long long", "long long int": "long long",
    "signed long long": "long long", "signed long long int": "long long",
    "unsigned long long": "ulong long", "unsigned long long int": "ulong long",
    "float": "float", "double": "double",
    "uint8_t": "uchar", "uint16_t": "ushort", "uint32_t": "uint", "uint64_t": "ulong long",
    "int8_t": "char", "int16_t": "short", "int32_t": "int", "int64_t": "long long",
    "size_t": "uint", "ssize_t": "int",
}


def _short_type(t):
    """将 DWARF 类型名简化为 Keil 风格短名（uint32_t→uint，const/volatile 剥离，指针递归）。"""
    t = (t or "").strip()
    if not t:
        return t
    if t.endswith("*"):
        return _short_type(t[:-1].strip()) + "*"
    if t.startswith("const "):
        t = t[6:].strip()
    if t.startswith("volatile "):
        t = t[9:].strip()
    if t.startswith("struct "):
        return "struct"
    if t.startswith("union "):
        return "union"
    if t.startswith("enum "):
        return t
    return _SHORT_TYPES.get(t, t)