@echo off
REM ============================================================
REM  LIVO one-click installer (Windows)
REM
REM  Double-click this file, or run it from a terminal in the
REM  package root. All interactive steps and messages (Traditional
REM  Chinese) are handled by installer\install.ps1.
REM ============================================================
setlocal
cd /d "%~dp0"

if not exist "installer\install.ps1" (
  echo [ERROR] installer\install.ps1 not found.
  echo         Please unzip the whole package first, then run
  echo         install.bat from the package root folder.
  pause
  exit /b 1
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell not found.
  echo         PowerShell 5.1 ships with Windows 10/11 - please run this
  echo         installer on Windows 10 or newer.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "installer\install.ps1"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [ERROR] Install did not finish. See the messages above.
  echo         Report issues: https://github.com/livo-tw/livo/issues
)
pause
exit /b %RC%
