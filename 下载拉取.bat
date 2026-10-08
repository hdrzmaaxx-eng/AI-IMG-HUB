@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  从 GitHub 下载最新代码到本文件夹
rem  只覆盖代码文件；records\ 与 config.json 是本机数据，一律不动
rem ============================================================

set "REPO_URL=https://github.com/hdrzmaaxx-eng/AI-IMG-HUB.git"
set "BRANCH=main"
set "TMPF=%TEMP%\aiimghub-sync.tmp"

echo.
echo   ==========================================
echo     AI IMG HUB  -  从云端下载最新版
echo   ==========================================
echo.

rem ---- 1) 找 git ----
set "GIT="
for %%I in (git.exe) do if not defined GIT set "GIT=%%~$PATH:I"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"
if not defined GIT if exist "%USERPROFILE%\scoop\apps\git\current\cmd\git.exe" set "GIT=%USERPROFILE%\scoop\apps\git\current\cmd\git.exe"

if not defined GIT (
  echo   [错误] 没找到 Git。
  echo.
  echo   请先安装 Git for Windows：https://git-scm.com/download/win
  echo   装好后重新双击本文件。
  echo.
  pause
  exit /b 1
)

rem ---- 2) 确认这个文件夹已经和仓库绑定 ----
"%GIT%" rev-parse --git-dir >nul 2>&1
if errorlevel 1 goto :bind

"%GIT%" remote set-url origin "%REPO_URL%" >nul 2>&1
if errorlevel 1 "%GIT%" remote add origin "%REPO_URL%" >nul 2>&1

set "HASHEAD="
"%GIT%" rev-parse --verify HEAD >nul 2>&1
if not errorlevel 1 set "HASHEAD=1"
goto :fetch

:bind
echo   这个文件夹还没绑定仓库，正在绑定…
"%GIT%" init -b %BRANCH% >nul 2>&1
"%GIT%" remote remove origin >nul 2>&1
"%GIT%" remote add origin "%REPO_URL%"

:fetch
echo.
echo   正在从云端拉取…
"%GIT%" fetch origin %BRANCH%
if errorlevel 1 goto :fail

set "BEFORE="
"%GIT%" rev-parse --short HEAD > "%TMPF%" 2>nul
set /p BEFORE=<"%TMPF%"

rem ---- 3) 本机对代码有改动的话，先备份再覆盖 ----
if not defined HASHEAD goto :sync
"%GIT%" diff --quiet HEAD >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [提示] 本机对代码有改动，先存到 stash 备份，再覆盖成云端版本。
  "%GIT%" stash push -m "下载前自动备份" >nul
  if errorlevel 1 echo   [提示] 备份失败，继续往下走。
)

:sync
echo.
echo   正在套用云端版本…
"%GIT%" reset --hard origin/%BRANCH%
if errorlevel 1 goto :fail

set "AFTER="
"%GIT%" rev-parse --short HEAD > "%TMPF%" 2>nul
set /p AFTER=<"%TMPF%"
del "%TMPF%" >nul 2>&1

rem ---- 4) 汇报结果 ----
echo.
if "%BEFORE%"=="%AFTER%" (
  echo   已经是最新版本。  版本号 %AFTER%
) else (
  echo   下载完成：%BEFORE%  --^>  %AFTER%
)
echo.
"%GIT%" log -1 --format="  最新提交：%%h  %%s"
echo.

if not exist "records\" mkdir "records" >nul 2>&1

echo   ---------------------------------------------------
echo   records\ 和 config.json 没有被改动，你的历史记录都还在。
echo   双击  启动.bat  就能用。
echo   ---------------------------------------------------
echo.
pause
endlocal
exit /b 0

:fail
echo.
echo   ---------------------------------------------------
echo   [错误] 下载失败，请看上面的 git 输出。
echo   常见原因：网络不通 / 仓库地址不对 / 令牌过期。
echo   records\ 和 config.json 没有被改动。
echo   ---------------------------------------------------
echo.
pause
endlocal
exit /b 1
