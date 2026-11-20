@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set ELECTRON_NO_ATTACH_CONSOLE=1
if not exist "%~dp0runtime\resources\app\main.cjs" (
  echo Custom application is not built. Run Build-CustomHub.ps1 first.
  pause
  exit /b 1
)
start "" /D "%~dp0runtime" "%~dp0runtime\PeripheralHub.exe"
endlocal
