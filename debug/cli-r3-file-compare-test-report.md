# OMNI CLI 0.8.0 R3 实机测试报告（file / flash compare / tool map）

> 测试日期：2026-10-22  
> CLI：`omni 0.8.0`  
> 探针/目标：SEGGER J-Link Compact PLUS + APM32F407IGT6（`apm32f407xg`）  
> 工程：`D:\workspace\embedded\omni-emb\examples\dsp\dsp_sin_cos`  
> 固件：`Objects\stm32f407\omni.hex` / `omni.axf`  
> Map：`Listings\stm32f407\omni.map`

## 结果

| 命令 | 结果 |
|---|---|
| `omni file info omni.hex` | ✅ hex，文件 25235 B，数据 8952 B，entry 0x08000000 |
| `omni file info omni.axf` | ✅ elf，文件 119904 B，2 个段（Flash 8936 B / RAM 16 B） |
| `omni file checksum omni.hex --algorithm crc32` | ✅ `5A B2 8F 68`（25235 B） |
| `omni file checksum omni.hex --algorithm modbus-crc16` | ✅ `59 61` |
| `omni tool map omni.map --top 5` | ✅ ROM 8.7 KB / 1 MB，RAM 1.0 KB / 128 KB，区域/分类/Top 正常 |
| `omni flash compare omni.hex` | ✅ 一致，8952 B，179 ms，退出码 0 |
| `omni flash compare wrong.bin --base-address 0x08000000 --max-diffs 3` | ✅ 6 个差异，首个 0x08000000，列出 3 条，退出码 1 |

## 测试中顺手修正

- `file info` 区分“文件大小”和“数据大小”（hex 文件 25235 B 对应 8952 B 数据）。
- `tool map` 输出使用用户传入的 map 路径，而不是后端临时文件名。
- `flash compare` 新增后端 `POST /api/probes/{uid}/flash/compare`，Flash 地址先
  `reset_and_halt` 再读；`--max-diffs` 限制返回条数，`--fail-fast` 可提前停止。

## 结论

R3 计划中的 `file info/checksum`、`flash compare`、`tool map` 在 J-Link + APM32F407
实机上通过；离线回归 `test_file_tool_cli.py` 全 PASS。
