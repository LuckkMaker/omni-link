"""事件系统：WebSocket 推送管理

管理 WebSocket 连接，向前端推送实时事件（进度、日志、探针变更等）。
"""

import asyncio
import json
from datetime import datetime
from typing import Any
from fastapi import WebSocket, WebSocketDisconnect


def _infer_log_source(message: str) -> str:
    """根据日志消息内容推断来源页面（monitor/flash/rtt/commander/system）"""
    msg = message or ""
    if "Monitor" in msg:
        return "monitor"
    if "RTT" in msg:
        return "rtt"
    if "Commander" in msg:
        return "commander"
    if any(k in msg for k in ("Flash", "烧录", "擦除", "Program", "Erase", "Verify", "Read Back", "Check Blank", "固件")):
        return "flash"
    return "system"


class EventManager:
    """WebSocket 事件推送管理器"""

    def __init__(self):
        self._connections: list[WebSocket] = []
        self._loop: asyncio.AbstractEventLoop | None = None

    async def handle_websocket(self, websocket: WebSocket):
        """处理 WebSocket 连接"""
        await websocket.accept()
        self._connections.append(websocket)
        if self._loop is None:
            self._loop = asyncio.get_event_loop()

        # 推送欢迎消息
        await websocket.send_text(json.dumps({
            "event": "ws.connected",
            "data": {"message": "WebSocket connected"}
        }))

        try:
            while True:
                # 接收客户端消息（心跳 / 命令）
                raw = await websocket.receive_text()
                msg = json.loads(raw) if raw.startswith("{") else {"action": raw}
                action = msg.get("action")

                if action == "ping":
                    await websocket.send_text(json.dumps({
                        "event": "pong",
                        "data": {"timestamp": datetime.now().isoformat()}
                    }))
                elif action == "refresh_probes":
                    # 客户端请求立即刷新探针列表
                    from core.pyocd_backend import backend
                    probes = backend.get_probe_states()
                    await websocket.send_text(json.dumps({
                        "event": "probe.list",
                        "data": {"probes": probes}
                    }))

        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            if websocket in self._connections:
                self._connections.remove(websocket)

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        """设置事件循环引用（供后台线程使用）"""
        self._loop = loop

    def emit(self, event: str, data: dict[str, Any]):
        """同步接口：向所有连接推送事件（从非 async 上下文调用）"""
        if not self._connections:
            return
        message = json.dumps({"event": event, "data": data})
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._broadcast(message), self._loop)

    async def emit_async(self, event: str, data: dict[str, Any]):
        """异步接口：向所有连接推送事件（从 async 上下文调用）"""
        if not self._connections:
            return
        message = json.dumps({"event": event, "data": data})
        await self._broadcast(message)

    async def _broadcast(self, message: str):
        """异步广播消息"""
        dead = []
        for ws in self._connections:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in self._connections:
                self._connections.remove(ws)

    def log(self, level: str, message: str):
        """推送日志事件

        source 由消息内容推断（集中处理，调用方无需改动）：
        - 含 "Monitor"      -> monitor
        - 含 "RTT"          -> rtt
        - 含 "Commander"    -> commander
        - 含 Flash/烧录/擦除等 -> flash
        - 其他（连接/目标等）  -> system
        """
        self.emit("log", {
            "timestamp": datetime.now().isoformat(timespec="milliseconds"),
            "level": level,
            "message": message,
            "source": _infer_log_source(message),
        })

    @property
    def connection_count(self) -> int:
        return len(self._connections)


# 全局单例
event_manager = EventManager()
