# 工具链目录

OMNI Link 的工具链默认由独立安装器管理，**不再塞进主安装包**：

```text
%LOCALAPPDATA%\OMNI\toolchains\     # omni-toolchain.exe 安装到这里
├── cmake/bin/cmake.exe
├── ninja/ninja.exe
├── llvm-embedded/19.1.5/bin/clang.exe
├── gcc-arm-none-eabi/14.3.1/bin/arm-none-eabi-gcc.exe
└── cmsis-toolbox/2.13.0/bin/cbuild.exe
```

本目录 `tools/` 只用于**开发机本地**或“离线全量包”变体，不参与默认打包。

## 推荐流程：离线工具链包

1. 把 zip/解压目录放到 `../toolchains/`（`toolchains/tools.json` 已按当前压缩包配好）。
2. 生成独立离线包：

   ```powershell
   npm run toolchain:package
   # 或
   .\scripts\build-toolchain-offline.ps1
   ```

   输出：

   ```text
   toolchain-release\
   ├── toolchain-offline\             # 目录，可直接放在安装器旁边
   │   ├── omni-toolchain.exe
   │   ├── tools.json
   │   ├── *.zip
   │   └── SHA256SUMS.txt
   └── toolchain-offline-<version>.zip
   ```

3. 用户安装：

   ```powershell
   .\toolchain-offline\omni-toolchain.exe --offline . 
   ```

   默认安装到 `%LOCALAPPDATA%\OMNI\toolchains`，不需要管理员权限。

4. 主安装包联动：把 `toolchain-offline` 目录放在 OMNI Link 安装器旁边，安装器会检测并调用；也可以把 `toolchain-offline-<version>.zip` 改名为 `toolchain-offline.zip` 放在旁边。

## 本地开发：快速准备 tools/

```powershell
# 只预览
.\scripts\prepare-tools.ps1 -DryRun

# 从 D:\ToolChain / toolchains/ / tools/ 的 zip 整理到 tools/
.\scripts\prepare-tools.ps1 -Clean -Force
```

`tools/` 的布局和共享目录相同，解析器也认。

## 解析顺序

1. 显式覆盖：`OMNI_CMAKE`、`OMNI_NINJA`、`OMNI_CLANG`、`OMNI_GCC`、`OMNI_CBUILD`
2. `OMNI_TOOLS_DIR`
3. 共享目录 `OMNI_TOOLCHAIN_HOME`（默认 `%LOCALAPPDATA%\OMNI\toolchains`）
4. 安装目录/仓库的 `tools/`
5. 系统 `PATH`

查看：

```powershell
omni toolchain
omni toolchain --json
```

## 体积与许可

- 离线包只放开源工具：CMake、Ninja、LLVM Embedded、Arm GNU Toolchain、CMSIS-Toolbox。
- Arm Compiler 6（armclang）需要商业许可，默认不打包；检测到系统安装时使用系统 `PATH`。
- J-Link 等调试器通常有独立许可，建议只检测系统安装。
