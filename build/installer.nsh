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