<!-- 发布模板：{{VERSION}} 由 python/scripts/cli-release.ps1 在打包时替换。 -->
# OMNI CLI {{VERSION}}（Windows x64 · portable）

这是 OMNI CLI 的独立便携版，不包含 Electron 应用和调试后端。

## 内容

```text
omni.exe           OMNI CLI 可执行文件（单文件，无需安装 Python）
README.md          本文档
LICENSE            MIT 许可证
install.ps1        安装到用户目录并加入 PATH
uninstall.ps1      卸载
SHA256SUMS.txt     文件校验和
```

## 安装

在解压目录中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

默认安装到：

```text
%LOCALAPPDATA%\Programs\OMNI CLI\bin
```

并把该目录加入**当前用户**的 PATH，不需要管理员权限。安装后新开一个终端：

```powershell
omni --version
omni project config --target stm32f407ig
```

### 自定义目录 / 不修改 PATH

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -InstallDir "D:\tools\omni-cli" -NoPath
```

### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## 能做什么

**完全独立（不需要 OMNI Link 应用/后端）**：

```powershell
omni project config   --target stm32f407ig
omni project config   --target stm32f407ig --sync-keil
omni project bsp      --target stm32f407ig
omni project sync-keil
```

`omni project` 只读取 omni-emb 仓库的 `Kconfig` / `soc` / `boards` 数据，直接生成
`.config`、`omni_config.h`、`bsp_config.h`，并同步 Keil 工程。

**需要 OMNI Link 后端**：

```powershell
omni probe list
omni flash program .\app.hex
omni rtt read --follow
omni debug ...
```

portable 包不带后端。可以连接正在运行的 OMNI Link 应用后端；或者设置
`OMNI_BACKEND_DIR` / `OMNI_BACKEND_SERVER` 指向已有的后端目录。

## `menuconfig` 说明

`omni project menuconfig` 的交互界面由 `kconfiglib` 的 `menuconfig` 命令提供。
portable 包不包含 `menuconfig.exe`；因此：

- 只做 `config` / `bsp` / `sync-keil`：不需要额外依赖；
- 需要交互式 `menuconfig`：请安装同版本 wheel（发布页提供），
  或使用已安装的 OMNI Link 应用/带 `kconfiglib` 的 Python 环境。

wheel 安装会自动提供 `menuconfig` 命令：

```powershell
# 在 wheel 所在目录执行
python -m pip install .\omni_cli-{{VERSION}}-py3-none-any.whl
# 或
uv tool install --from .\omni_cli-{{VERSION}}-py3-none-any.whl omni-cli
```

## 用于 Keil / CMSIS 构建钩子

启动器 `omni_project.py` 会按以下顺序查找 CLI：

1. `--cli PATH`
2. `OMNI_CLI`
3. PATH 中的 `omni` / `omni.exe`

安装后 `omni` 已在用户 PATH 中，构建钩子可以直接使用：

```text
python ../../../omni/scripts/omni_project/omni_project.py config --target stm32f407ig --sync-keil
```

如果机器上同时装了旧版 OMNI Link，请确认 `OMNI_CLI` 没有指向旧版 `omni.exe`。

## 校验

```powershell
Get-FileHash .\omni.exe -Algorithm SHA256
```

与 `SHA256SUMS.txt` 对比。

## 版本

- CLI: {{VERSION}}
- 最低要求: Windows 10 x64
- 平台: win64
