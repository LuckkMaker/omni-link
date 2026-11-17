# 后端 API 参考

后端 FastAPI 服务监听 `127.0.0.1`，动态端口（开发模式固定 `8765`）。基础路径 `http://127.0.0.1:{port}/api`。

## 路由模块

| 模块 | 前缀 | 文件 | 说明 |
|------|------|------|------|
| probes | `/api/probes` | `vendor/omni-backend/link/api/probes.py` | 探针管理（列表/连接/断开/刷新） |
| targets | `/api/targets` | `vendor/omni-backend/link/api/targets.py` | 支持的 MCU 型号查询 |
| devices | `/api/devices` | `vendor/omni-backend/link/api/devices.py` | 设备目录（设备数据库） |
| flash | `/api` | `vendor/omni-backend/link/api/flash.py` | Flash 擦除/烧录/校验/回读/复位 |
| files | `/api/files` | `vendor/omni-backend/link/api/files.py` | 固件文件解析/读取/保存 |
| commander | `/api` | `vendor/omni-backend/link/api/commander.py` | Commander REPL 会话与命令执行 |
| rtt | `/api` | `vendor/omni-backend/link/api/rtt.py` | RTT 会话启动/停止/收发 |
| monitor | `/api` | `vendor/omni-backend/link/api/monitor.py` | Monitor 采样启动/停止/变量解析 |
| system | `/api/system` | `vendor/omni-backend/link/api/system.py` | 系统信息（版本、平台） |
| tools | `/api/tools` | `vendor/omni-backend/link/api/tools.py` | 工具集（fault/map 分析） |

## REST API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/probes` | GET | 列出所有已连接探针（含状态） |
| `/api/probes/states` | GET | 获取探针状态（轻量级） |
| `/api/probes/{uid}/connect` | POST | 连接指定探针 |
| `/api/probes/{uid}/disconnect` | POST | 断开探针 |
| `/api/probes/{uid}/target` | GET | 获取当前目标信息 |
| `/api/probes/{uid}/target` | POST | 手动设置目标芯片型号 |
| `/api/probes/{uid}/status` | GET | 获取探针状态 |
| `/api/probes/refresh` | POST | 手动刷新探针列表 |
| `/api/targets` | GET | 列出所有支持的 MCU 型号 |
| `/api/targets/{part_number}` | GET | 获取指定 MCU 信息 |
| `/api/devices` | GET | 列出设备目录 |
| `/api/devices/{part_number}` | GET | 获取设备详情 |
| `/api/probes/{uid}/flash/erase` | POST | 擦除 Flash（chip/sector/sector_range） |
| `/api/probes/{uid}/flash/program` | POST | 烧录固件 |
| `/api/probes/{uid}/flash/verify` | POST | 校验 Flash 内容 |
| `/api/probes/{uid}/flash/blank-check` | POST | 检查空白 |
| `/api/probes/{uid}/flash/read` | POST | 读取 Flash（返回 base64） |
| `/api/probes/{uid}/flash/cancel` | POST | 取消 Flash 操作 |
| `/api/probes/{uid}/reset` | POST | 复位目标（hw/sw） |
| `/api/files/parse` | POST | 解析固件文件（bin/hex/elf） |
| `/api/files/read` | POST | 读取文件数据 |
| `/api/files/save` | POST | 保存数据到文件 |
| `/api/commander/...` | — | Commander 会话与命令执行 |
| `/api/rtt/...` | — | RTT 会话管理 |
| `/api/monitor/...` | — | Monitor 采样控制 |
| `/api/system/...` | — | 系统信息 |
| `/api/tools/...` | — | Fault/Map 分析工具 |
| `/api/health` | GET | 健康检查 |

## 请求与响应格式

### 探针连接

```json
{
  "target": "apm32f407xg",
  "interface": "swd",
  "speed": 10000000
}
```

### Flash 擦除

```json
{
  "type": "chip",
  "address": 0,
  "size": 0
}
```

`type` 可选值：`chip`（整片）、`sector`（扇区）、`sector_range`（范围）

### Flash 烧录

```json
{
  "file_path": "D:/firmware.bin",
  "verify": true,
  "reset": true,
  "base_address": null
}
```

### Flash 读取

```json
{
  "type": "chip",
  "address": 0,
  "size": 0,
  "output_path": ""
}
```

返回：

```json
{
  "success": true,
  "base64_data": "...",
  "base_address": 0,
  "bytes_read": 0,
  "duration_ms": 0
}
```

## WebSocket 事件

连接 `ws://127.0.0.1:{port}/ws` 后接收以下事件推送：

| 事件 | 说明 |
|------|------|
| `probe.list` | 探针列表更新 |
| `probe.connected` | 探针已连接 |
| `probe.disconnected` | 探针已断开 |
| `probe.added` | 探针热插入 |
| `probe.removed` | 探针热拔出 |
| `flash.progress` | 烧录进度（erase/program/verify） |
| `flash.complete` | 烧录完成 |
| `rtt.data` | RTT 数据到达 |
| `monitor.data` | Monitor 采样数据 |
| `log` | 日志消息 |
