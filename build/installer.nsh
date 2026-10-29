; NSIS 自定义安装钩子（electron-builder nsis.include）
;
; 目标：安装后可直接在终端使用 `omni` 命令（随安装包分发的单文件 CLI）。
; CLI 位于 <安装目录>\resources\python\omni.exe，故把该目录加入当前用户 PATH；
; 卸载时移除。
;
; 注意：electron-builder 自带的 NSIS（nsis-3.0.4.1 / nsis-resources）未包含
; EnVar 插件，不能用 EnVar::SetHKCU 等命令（会导致 makensis 报
; "Plugin not found" 而整个打包失败）。这里改用注册表 + StrFunc.nsh 自行去重。

!include "WinMessages.nsh"
!include "StrFunc.nsh"

; 注意：makensis 以 /WX（warning as error）编译，未被引用的 StrFunc 函数会触发
; "warning 6010: ... not referenced" 而使打包失败。卸载器是单独的一遍编译
; （BUILD_UNINSTALLER），此时 customInstall 不存在；两遍各自用到的函数不同，
; 故按编译阶段分别声明（安装用 StrStr，卸载用 UnStrStr/UnStrRep），避免残留未引用函数。
!ifdef BUILD_UNINSTALLER
  ${UnStrStr}
  ${UnStrRep}
!else
  ${StrStr}
!endif

!define OMNI_CLI_DIR "$INSTDIR\resources\python"
!define OMNI_TOOLCHAIN_EXE "$INSTDIR\resources\toolchain\omni-toolchain.exe"

!macro customInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 "$0" "${OMNI_CLI_DIR}"
  ${If} $1 == ""
    ${If} $0 == ""
      WriteRegStr HKCU "Environment" "Path" "${OMNI_CLI_DIR}"
    ${Else}
      WriteRegStr HKCU "Environment" "Path" "$0;${OMNI_CLI_DIR}"
    ${EndIf}
    ; 广播环境变量变更，新开的终端/资源管理器即时生效
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}

  ; 可选：安装器旁边有离线工具链包时联动安装到共享目录。
  ; 支持 <setup 目录>\toolchains-offline\、\omni-toolchain-offline\ 或 .zip。
  StrCpy $2 ""
  IfFileExists "$EXEDIR\toolchains-offline\tools.json" 0 +2
    StrCpy $2 "$EXEDIR\toolchains-offline"
  StrCmp $2 "" 0 omni_toolchain_found
  IfFileExists "$EXEDIR\toolchain-offline\tools.json" 0 +2
    StrCpy $2 "$EXEDIR\toolchain-offline"
  StrCmp $2 "" 0 omni_toolchain_found
  IfFileExists "$EXEDIR\omni-toolchain-offline\tools.json" 0 +2
    StrCpy $2 "$EXEDIR\omni-toolchain-offline"
  StrCmp $2 "" 0 omni_toolchain_found
  IfFileExists "$EXEDIR\toolchain-offline.zip" 0 +2
    StrCpy $2 "$EXEDIR\toolchain-offline.zip"
  StrCmp $2 "" 0 omni_toolchain_found
  IfFileExists "$EXEDIR\omni-toolchain-offline.zip" 0 +2
    StrCpy $2 "$EXEDIR\omni-toolchain-offline.zip"

  omni_toolchain_found:
  IfFileExists "${OMNI_TOOLCHAIN_EXE}" 0 omni_toolchain_skip
  StrCmp $2 "" omni_toolchain_skip
    DetailPrint "Installing toolchains from $2 ..."
    ExecWait '"${OMNI_TOOLCHAIN_EXE}" --offline "$2" --silent --install-dir "$LOCALAPPDATA\OMNI\toolchains"' $3
    ${If} $3 != 0
      DetailPrint "Toolchain installer exited with $3"
      IfSilent omni_toolchain_skip
      MessageBox MB_ICONEXCLAMATION "工具链安装失败（exit $3）。$\r$\n可稍后手动运行：$\r$\n${OMNI_TOOLCHAIN_EXE} --offline $\"$2$\""
    ${EndIf}
  omni_toolchain_skip:
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrStr} $1 "$0" "${OMNI_CLI_DIR}"
  ${If} $1 != ""
    ; 依次处理 ";DIR" / "DIR;" / "DIR" 三种存在形式
    ${UnStrRep} $0 "$0" ";${OMNI_CLI_DIR}" ""
    ${UnStrRep} $0 "$0" "${OMNI_CLI_DIR};" ""
    ${UnStrRep} $0 "$0" "${OMNI_CLI_DIR}" ""
    WriteRegStr HKCU "Environment" "Path" "$0"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend