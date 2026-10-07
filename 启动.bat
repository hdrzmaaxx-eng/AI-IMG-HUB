@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE="

rem ---- 1) system PATH ----
for %%I in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:I"

rem ---- 2) common install locations ----
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"
if not defined NODE_EXE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_EXE=%NVM_SYMLINK%\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"

rem ---- 3) WorkBuddy bundled runtime (newest version first) ----
set "WB_NODE_DIR=%USERPROFILE%\.workbuddy\binaries\node\versions"
if not defined NODE_EXE if exist "%WB_NODE_DIR%" (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%WB_NODE_DIR%" 2^>nul') do (
    if not defined NODE_EXE if exist "%WB_NODE_DIR%\%%D\node.exe" set "NODE_EXE=%WB_NODE_DIR%\%%D\node.exe"
  )
)

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found on this computer.
  echo.
  echo   This tool needs Node.js 18 or newer.
  echo   Download the LTS installer from  https://nodejs.org
  echo   Install it, then run this file again.
  echo.
  echo   Already searched: PATH, the standard nodejs install folders,
  echo                    nvm, NVM_SYMLINK, scoop, and the bundled runtime.
  echo.
  pause
  exit /b 1
)

set "NODE_VER="
for /f "delims=" %%V in ('"%NODE_EXE%" -v 2^>nul') do set "NODE_VER=%%V"

set "NODE_MAJOR=!NODE_VER:v=!"
for /f "tokens=1 delims=." %%A in ("!NODE_MAJOR!") do set "NODE_MAJOR=%%A"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if !NODE_MAJOR! LSS 18 (
  echo.
  echo   [ERROR] Node.js !NODE_VER! is too old. Version 18 or newer is required.
  echo   Path: !NODE_EXE!
  echo   Please install the LTS release from  https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   AI IMG HUB  -  local service
echo   Node !NODE_VER!  (!NODE_EXE!)
echo.
echo   The browser will open automatically.
echo   Close this window to stop the service.
echo.

"%NODE_EXE%" server.js %*

rem exit code 0 = normal, -1073741510 (0xC000013A) = closed with Ctrl+C
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" if not "%EXITCODE%"=="-1073741510" (
  echo.
  echo   The service exited with an error ^(code %EXITCODE%^). See the messages above.
  pause
)

endlocal
