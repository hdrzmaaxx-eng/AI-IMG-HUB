@echo off
setlocal EnableDelayedExpansion
chcp 936 >nul
cd /d "%~dp0"

rem ============================================================
rem  把本机的改动提交并上传到 GitHub
rem  records\ 与 config.json 已写进 .gitignore，不会被上传
rem ============================================================

set "REPO_URL=https://github.com/hdrzmaaxx-eng/AI-IMG-HUB.git"
set "BRANCH=main"

echo.
echo   ==========================================
echo     AI IMG HUB  -  上传到云端
echo   ==========================================
echo.

set "GIT="
for %%I in (git.exe) do if not defined GIT set "GIT=%%~$PATH:I"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"
if not defined GIT if exist "%USERPROFILE%\scoop\apps\git\current\cmd\git.exe" set "GIT=%USERPROFILE%\scoop\apps\git\current\cmd\git.exe"

if not defined GIT (
  echo   [错误] 没找到 Git。
  echo   请先安装 Git for Windows：https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

"%GIT%" rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
  echo   这个文件夹还不是仓库，正在初始化…
  "%GIT%" init -b %BRANCH% >nul 2>&1
)

"%GIT%" remote set-url origin "%REPO_URL%" >nul 2>&1
if errorlevel 1 "%GIT%" remote add origin "%REPO_URL%" >nul 2>&1

echo.
echo   本次将要上传的改动：
"%GIT%" -c core.quotepath=false add -A
"%GIT%" -c core.quotepath=false status --short
echo.

"%GIT%" diff --cached --quiet >nul 2>&1
if not errorlevel 1 (
  echo   没有任何改动，仓库里已经是最新的。
  goto :push
)

set "MSG="
set /p MSG=  填写提交说明，直接回车用默认：
if "!MSG!"=="" set "MSG=更新 %DATE% %TIME%"

"%GIT%" commit -m "!MSG!"
if errorlevel 1 goto :fail

:push
echo.
echo   正在上传到云端…
"%GIT%" push -u origin %BRANCH%
if errorlevel 1 goto :fail

echo.
echo   ---------------------------------------------------
echo   上传完成。另一台电脑双击  下载拉取.bat  就能拿到。
echo   ---------------------------------------------------
echo.
pause
endlocal
exit /b 0

:fail
echo.
echo   ---------------------------------------------------
echo   [错误] 上传失败，请看上面的 git 输出。
echo   如果提示认证失败，说明令牌缺失或已过期，
echo   去这里重新生成一个，勾选 repo 权限：
echo   https://github.com/settings/tokens
echo   ---------------------------------------------------
echo.
pause
endlocal
exit /b 1
