"""外设/寄存器检查器后端（Zone 页面右侧检查器 dock 数据源）

封装 pyOCD 的 SVDDevice（target.svd_device），提供：
    - 外设树元数据（外设 → 寄存器 → 位域/枚举）
    - 寄存器合并块读（参考 svdAddrGapThreshold 策略，合并连续地址为整块读取）
    - 位域/枚举解码

数据源：pyocd_backend 的 session.target.svd_device（未连接时返回空）。
"""

import logging
import threading

logger = logging.getLogger(__name__)


class PeripheralBackend:
    """外设/寄存器检查器后端"""

    def __init__(self):
        self._lock = threading.Lock()

    def _get_svd_device(self, uid: str):
        """获取探针的 SVDDevice（未连接返回 None）"""
        try:
            from core.pyocd_backend import backend
            if not backend.is_connected(uid):
                return None
            session = backend._get_session(uid)
            if session is None:
                return None
            target = session.target
            svd = getattr(target, 'svd_device', None)
            return svd
        except Exception as e:
            logger.warning(f"Failed to get SVD device for {uid[:16]}: {e}")
            return None

    def is_available(self, uid: str) -> bool:
        return self._get_svd_device(uid) is not None

    def get_peripherals(self, uid: str) -> dict:
        """外设树元数据（不含寄存器值，仅结构）

        Returns:
            {success, peripherals: [{name, base_address,
                registers: [{name, offset, address, size, access,
                    fields: [{name, bit_offset, bit_width, description, values}]}]}]}
        """
        svd = self._get_svd_device(uid)
        if svd is None:
            return {"success": False, "error": "No SVD device (target not connected or no SVD)"}

        peripherals = []
        for p in svd.peripherals:
            regs = []
            base = p.base_address or 0
            for r in p.registers:
                fields = []
                if hasattr(r, 'fields'):
                    for f in r.fields:
                        values = []
                        if hasattr(f, 'values'):
                            for v in f.values:
                                values.append({
                                    "name": getattr(v, 'name', ''),
                                    "value": getattr(v, 'value', 0),
                                    "description": getattr(v, 'description', ''),
                                })
                        fields.append({
                            "name": f.name,
                            "bit_offset": getattr(f, 'bit_offset', 0),
                            "bit_width": getattr(f, 'bit_width', 0),
                            "description": getattr(f, 'description', ''),
                            "values": values,
                        })
                regs.append({
                    "name": r.name,
                    "offset": getattr(r, 'address_offset', 0),
                    "address": base + getattr(r, 'address_offset', 0),
                    "size": getattr(r, 'size', 32),
                    "access": getattr(r, 'access', ''),
                    "fields": fields,
                })
            peripherals.append({
                "name": p.name,
                "base_address": base,
                "registers": regs,
            })

        return {"success": True, "peripherals": peripherals}

    def read_registers(self, uid: str, addresses: list[int]) -> dict:
        """批量读取寄存器值（合并连续地址为整块读取）

        Args:
            uid: 探针 ID
            addresses: 寄存器绝对地址列表（从元数据接口拿到）

        Returns:
            {success, values: [{address, value}], errors: [{address, error}]}
        """
        try:
            from core.pyocd_backend import backend
            if not backend.is_connected(uid):
                return {"success": False, "error": "Probe not connected"}
            session = backend._get_session(uid)
            if session is None:
                return {"success": False, "error": "No session"}
            target = session.target

            # 合并连续地址（间隙 <= 4 字节视为连续，整块读取）
            addresses = sorted(set(addresses))
            groups = []
            for addr in addresses:
                if groups and addr - groups[-1][-1] <= 4:
                    groups[-1].append(addr)
                else:
                    groups.append([addr])

            values = []
            errors = []
            for group in groups:
                start = group[0]
                end = group[-1]
                count = end - start + 1
                try:
                    data = target.read_memory_block32(start, count)
                    for i, addr in enumerate(group):
                        values.append({"address": addr, "value": data[i]})
                except Exception as e:
                    for addr in group:
                        errors.append({"address": addr, "error": str(e)})

            return {"success": True, "values": values, "errors": errors}
        except Exception as e:
            logger.warning(f"Read registers failed: {e}")
            return {"success": False, "error": str(e)}

    def read_register(self, uid: str, address: int) -> dict:
        """读取单个寄存器"""
        try:
            from core.pyocd_backend import backend
            if not backend.is_connected(uid):
                return {"success": False, "error": "Probe not connected"}
            session = backend._get_session(uid)
            if session is None:
                return {"success": False, "error": "No session"}
            target = session.target
            value = target.read32(address)
            return {"success": True, "address": address, "value": value}
        except Exception as e:
            return {"success": False, "address": address, "error": str(e)}


# 全局单例
peripheral_backend = PeripheralBackend()