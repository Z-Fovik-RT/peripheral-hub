Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!ifndef PAYLOAD
  !error "PAYLOAD must point to staged distribution"
!endif
!ifndef OUTPUT
  !error "OUTPUT must point to setup output"
!endif
!ifndef APPVERSION
  !error "APPVERSION must be supplied"
!endif
Name "外设中心 · 本地定制版"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\PeripheralHubPublic"
InstallDirRegKey HKCU "Software\PeripheralHubPublic" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${APPVERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "外设中心 · 本地定制版（非官方）"
VIAddVersionKey /LANG=2052 "FileDescription" "本地定制版安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APPVERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APPVERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Local customization; third-party components retain their original notices."
Var TestInstall
Var Options
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "外设中心 · ${APPVERSION}"
!define MUI_WELCOMEPAGE_TEXT "安装非官方 Windows 外设中心。不会安装或替换设备驱动。运行需要 Windows x64 和 PowerShell 7。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "启动外设中心"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  StrCpy $TestInstall "0"
  ${GetParameters} $Options
  ClearErrors
  ${GetOptions} $Options "/TEST" $0
  ${IfNot} ${Errors}
    StrCpy $TestInstall "1"
  ${EndIf}
FunctionEnd

Section "Install"
  ; Reuse only a directory marked as our own install; avoid merging into unrelated software.
  IfFileExists "$INSTDIR\peripheral-hub-public.marker" directoryReady
  ; A fresh install may use an empty folder or preserved local-state only.
  FindFirst $0 $1 "$INSTDIR\*"
inspectFreshDirectory:
  StrCmp $1 "" freshDirectoryReady
  StrCmp $1 "." nextFreshEntry
  StrCmp $1 ".." nextFreshEntry
  StrCmp $1 "local-state" nextFreshEntry
  FindClose $0
  Goto directoryConflict
nextFreshEntry:
  FindNext $0 $1
  Goto inspectFreshDirectory
freshDirectoryReady:
  FindClose $0
  Goto directoryReady
directoryConflict:
  SetErrorLevel 3
  IfSilent abortDirectoryConflict
  MessageBox MB_ICONSTOP "该目录包含其他文件，请选择独立的空目录。"
abortDirectoryConflict:
  Abort
directoryReady:
  ; Refuse to overwrite a running executable before changing any installed file.
  IfFileExists "$INSTDIR\runtime\PeripheralHub.exe" 0 runtimeReady
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\runtime\PeripheralHub.exe", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p .r0'
  ${If} $0 == -1
    SetErrorLevel 2
    IfSilent upgradeAbort
    MessageBox MB_ICONSTOP "应用正在运行或安装目录不可写。请关闭外设中心后重试；本次未覆盖文件。"
    upgradeAbort:
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
runtimeReady:
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*.*"
  FileOpen $0 "$INSTDIR\peripheral-hub-public.marker" w
  FileWrite $0 "PeripheralHubPublic ${APPVERSION}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} $TestInstall == "0"
    CreateDirectory "$SMPROGRAMS\Peripheral Hub"
    CreateShortCut "$SMPROGRAMS\Peripheral Hub\外设中心.lnk" "$INSTDIR\Start-Hub.cmd" "" "$INSTDIR\runtime\PeripheralHub.exe"
    CreateShortCut "$SMPROGRAMS\Peripheral Hub\卸载.lnk" "$INSTDIR\Uninstall.exe"
    WriteRegStr HKCU "Software\PeripheralHubPublic" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeripheralHubPublic" "DisplayName" "Peripheral Hub 外设中心（非官方）"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeripheralHubPublic" "DisplayVersion" "${APPVERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeripheralHubPublic" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeripheralHubPublic" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeripheralHubPublic" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeripheralHubPublic" "NoRepair" 1
    FileOpen $0 "$INSTDIR\shortcuts-created.marker" w
    FileWrite $0 "1"
    FileClose $0
  ${EndIf}
SectionEnd

Function LaunchApp
  ExecShell "open" "$INSTDIR\Start-Hub.cmd"
FunctionEnd

Function un.onInit
  SetShellVarContext current
  IfFileExists "$INSTDIR\peripheral-hub-public.marker" valid
  MessageBox MB_ICONSTOP "此目录缺少定制版安装标记，卸载已停止。"
  Abort
valid:
FunctionEnd

Section "Uninstall"
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PeripheralHubPublic"
  StrLen $2 '$\"$INSTDIR\runtime\PeripheralHub.exe$\"'
  StrCpy $3 $1 $2
  ${If} $3 == '$\"$INSTDIR\runtime\PeripheralHub.exe$\"'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PeripheralHubPublic"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "PeripheralHubPublic"
  ${EndIf}
  ; Only application-owned directories are removed. Local audio recovery/profile data stays.
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\native"
  RMDir /r "$INSTDIR\docs"
  Delete "$INSTDIR\Start-Hub.cmd"
  Delete "$INSTDIR\Scan-Devices.ps1"
  Delete "$INSTDIR\device-profiles.json"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.md"
  IfFileExists "$INSTDIR\shortcuts-created.marker" removeLinks keepLinks
removeLinks:
  Delete "$SMPROGRAMS\Peripheral Hub\外设中心.lnk"
  Delete "$SMPROGRAMS\Peripheral Hub\卸载.lnk"
  RMDir "$SMPROGRAMS\Peripheral Hub"
  ReadRegStr $0 HKCU "Software\PeripheralHubPublic" "InstallDir"
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "Software\PeripheralHubPublic"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeripheralHubPublic"
  ${EndIf}
keepLinks:
  Delete "$INSTDIR\shortcuts-created.marker"
  Delete "$INSTDIR\peripheral-hub-public.marker"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
