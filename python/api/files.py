"""文件解析 API 路由"""

import os
import base64
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class ParseRequest(BaseModel):
    file_path: str
    base_address: int | None = None


class SaveRequest(BaseModel):
    file_path: str
    data: str  # base64 encoded


class StatRequest(BaseModel):
    file_path: str


@router.post("/stat")
async def stat_file(req: StatRequest):
    """获取文件修改时间，用于检测文件是否变更"""
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail="File not found")
    return {"mtime": os.path.getmtime(req.file_path), "size": os.path.getsize(req.file_path)}


@router.post("/parse")
async def parse_file(req: ParseRequest):
    """解析固件文件，返回格式/大小/段信息"""
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail="File not found")

    ext = os.path.splitext(req.file_path)[1].lower()
    file_size = os.path.getsize(req.file_path)

    if ext == ".bin":
        return {
            "format": "bin",
            "size": file_size,
            "entry": None,
            "segments": [{"address": 0, "size": file_size}],
        }
    elif ext == ".hex":
        # 解析 Intel HEX 文件
        return parse_hex(req.file_path)
    elif ext in (".elf", ".axf"):
        # 解析 ELF/AXF 文件
        return parse_elf(req.file_path)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported file format: {ext}")


@router.post("/read")
async def read_file(req: ParseRequest):
    """读取固件文件数据，返回 base64 编码的二进制数据和地址段（供 HexViewer 显示）"""
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail="File not found")

    ext = os.path.splitext(req.file_path)[1].lower()

    if ext == ".bin":
        with open(req.file_path, "rb") as f:
            data = f.read()
        return {
            "format": "bin",
            "base_address": req.base_address or 0,
            "data": base64.b64encode(data).decode("ascii"),
            "size": len(data),
            "mtime": os.path.getmtime(req.file_path),
        }
    elif ext == ".hex":
        return read_hex(req.file_path)
    elif ext in (".elf", ".axf"):
        return read_elf(req.file_path)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported file format: {ext}")


@router.post("/save")
async def save_file(req: SaveRequest):
    """将 base64 编码的数据保存到文件"""
    try:
        data = base64.b64decode(req.data)
        with open(req.file_path, "wb") as f:
            f.write(data)
        return {"success": True, "size": len(data)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def read_hex(file_path: str):
    """读取 Intel HEX 文件，合并为连续二进制数据"""
    base_addr = 0
    min_addr = None
    max_addr = None
    data_map = {}

    with open(file_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or not line.startswith(":"):
                continue

            data_str = line[1:]
            byte_count = int(data_str[0:2], 16)
            address = int(data_str[2:6], 16)
            record_type = int(data_str[6:8], 16)

            if record_type == 0:  # Data record
                full_addr = base_addr + address
                data_bytes = bytes.fromhex(data_str[8:8 + byte_count * 2])
                for i, b in enumerate(data_bytes):
                    data_map[full_addr + i] = b
                if min_addr is None or full_addr < min_addr:
                    min_addr = full_addr
                if max_addr is None or full_addr + byte_count > max_addr:
                    max_addr = full_addr + byte_count
            elif record_type == 4:  # Extended linear address
                base_addr = int(data_str[8:12], 16) << 16
            elif record_type == 1:  # End of file
                break

    if min_addr is None:
        return {"format": "hex", "base_address": 0, "data": "", "size": 0, "mtime": os.path.getmtime(file_path)}

    # 填充连续数据（空隙用 0xFF 填充）
    total = max_addr - min_addr
    raw = bytearray([0xFF] * total)
    for addr, b in data_map.items():
        raw[addr - min_addr] = b

    return {
        "format": "hex",
        "base_address": min_addr,
        "data": base64.b64encode(bytes(raw)).decode("ascii"),
        "size": total,
        "mtime": os.path.getmtime(file_path),
    }


def read_elf(file_path: str):
    """读取 ELF/AXF 文件，提取可加载段数据

    只提取有文件数据的 PT_LOAD 段（跳过 BSS），按连续性分组，
    返回最大的连续组（通常是 Flash 区域），避免 Flash 和 RAM 之间的大间隙
    导致分配数百 MB 的填充缓冲区。
    """
    try:
        from elftools.elf.elffile import ELFFile

        with open(file_path, "rb") as f:
            elf = ELFFile(f)
            # 收集所有有文件数据的 PT_LOAD 段（跳过 BSS: filesz==0）
            loadable = []
            for segment in elf.iter_segments():
                if segment.header.p_type != "PT_LOAD":
                    continue
                filesz = segment.header.p_filesz
                if filesz == 0:
                    continue
                vaddr = segment.header.p_vaddr
                data = segment.data()
                loadable.append((vaddr, vaddr + filesz, data))

            if not loadable:
                return {"format": "elf", "base_address": 0, "data": "", "size": 0, "mtime": os.path.getmtime(file_path)}

            # 按地址排序，分组连续段（间隙 > 4KB 视为不同内存区域）
            loadable.sort(key=lambda x: x[0])
            groups = []
            current_group = [loadable[0]]
            for i in range(1, len(loadable)):
                prev_end = current_group[-1][1]
                curr_start = loadable[i][0]
                if curr_start - prev_end > 0x1000:
                    groups.append(current_group)
                    current_group = [loadable[i]]
                else:
                    current_group.append(loadable[i])
            groups.append(current_group)

            # 选择数据量最大的组（通常是 Flash）
            best_group = max(groups, key=lambda g: sum(len(s[2]) for s in g))

            min_addr = best_group[0][0]
            max_addr = max(s[1] for s in best_group)
            total = max_addr - min_addr
            raw = bytearray([0xFF] * total)
            for vaddr, _, data in best_group:
                offset = vaddr - min_addr
                raw[offset:offset + len(data)] = data

            return {
                "format": "elf",
                "base_address": min_addr,
                "data": base64.b64encode(bytes(raw)).decode("ascii"),
                "size": total,
                "mtime": os.path.getmtime(file_path),
            }
    except ImportError:
        raise HTTPException(status_code=500, detail="pyelftools not installed")


def parse_hex(file_path: str):
    """解析 Intel HEX 文件"""
    import re

    segments = []
    current_addr = 0
    base_addr = 0
    total_size = 0
    seg_start = None
    seg_end = None

    with open(file_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or not line.startswith(":"):
                continue

            # 解析 HEX 记录
            data_str = line[1:]
            byte_count = int(data_str[0:2], 16)
            address = int(data_str[2:6], 16)
            record_type = int(data_str[6:8], 16)

            if record_type == 0:  # Data record
                full_addr = base_addr + address
                if seg_start is None:
                    seg_start = full_addr
                seg_end = full_addr + byte_count
                total_size += byte_count
            elif record_type == 4:  # Extended linear address
                base_addr = int(data_str[8:12], 16) << 16
            elif record_type == 1:  # End of file
                break

    if seg_start is not None:
        segments.append({"address": seg_start, "size": seg_end - seg_start})

    return {
        "format": "hex",
        "size": total_size,
        "entry": seg_start,
        "segments": segments,
    }


def parse_elf(file_path: str):
    """解析 ELF 文件"""
    try:
        from elftools.elf.elffile import ELFFile

        with open(file_path, "rb") as f:
            elf = ELFFile(f)
            segments = []
            for section in elf.iter_sections():
                if section.header.sh_type == "SHT_PROGBITS" and section.header.sh_size > 0:
                    if section.header.sh_flags & 0x2:  # SHF_ALLOC
                        segments.append({
                            "address": section.header.sh_addr,
                            "size": section.header.sh_size,
                        })

            return {
                "format": "elf",
                "size": os.path.getsize(file_path),
                "entry": elf.header.e_entry,
                "segments": segments,
            }
    except ImportError:
        return {
            "format": "elf",
            "size": os.path.getsize(file_path),
            "entry": None,
            "segments": [],
        }
