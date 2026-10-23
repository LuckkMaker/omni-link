# 离线工具链源目录

把 CMake / Ninja / LLVM Embedded / Arm GNU Toolchain / CMSIS-Toolbox 的 **zip 或解压目录** 放在这里；`tools.json` 描述版本、压缩包、目标目录和 SHA256。

生成独立离线包：

```powershell
npm run toolchain:package
# 或
.\build.ps1 -ToolchainPackage
```

输出到 `toolchain-release/`：

```text
toolchain-release\
├── toolchain-offline\          # 目录：omni-toolchain.exe + tools.json + zip + SHA256SUMS.txt
└── toolchain-offline-<version>.zip
```

安装器会把工具装到 `%LOCALAPPDATA%\OMNI\toolchains`，不会进主安装包。

本目录的压缩包不会进 git（`.gitignore` 只保留本 README 和 `tools.json`）。

如果只是开发机本地准备 `tools/`，仍可用：

```powershell
.\scripts\prepare-tools.ps1 -Source toolchains -Clean -Force
```
