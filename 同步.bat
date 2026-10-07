@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Commit local changes and push them to GitHub.
rem  records\ and config.json are listed in .gitignore,
rem  so they are never uploaded.
rem ============================================================

set "REPO_URL=https://github.com/hdrzmaaxx-eng/AI-IMG-HUB.git"
set "BRANCH=main"

echo.
echo   ==========================================
echo     AI IMG HUB  -  push to GitHub
echo   ==========================================
echo.

set "GIT="
for %%I in (git.exe) do if not defined GIT set "GIT=%%~$PATH:I"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"
if not defined GIT if exist "%USERPROFILE%\scoop\apps\git\current\cmd\git.exe" set "GIT=%USERPROFILE%\scoop\apps\git\current\cmd\git.exe"

if not defined GIT (
  echo   [ERROR] Git not found.  https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

"%GIT%" rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
  echo   This folder is not a repo yet. Initializing...
  "%GIT%" init -b %BRANCH% >nul 2>&1
)

"%GIT%" remote set-url origin "%REPO_URL%" >nul 2>&1
if errorlevel 1 "%GIT%" remote add origin "%REPO_URL%" >nul 2>&1

echo.
echo   Files to upload:
"%GIT%" add -A
"%GIT%" status --short
echo.

"%GIT%" diff --cached --quiet >nul 2>&1
if not errorlevel 1 (
  echo   Nothing changed - the repo already has everything.
  goto :push
)

set "MSG="
set /p MSG=  Commit message (press Enter for default): 
if "!MSG!"=="" set "MSG=update %DATE% %TIME%"

"%GIT%" commit -m "!MSG!"
if errorlevel 1 goto :fail

:push
echo.
echo   Pushing to  %REPO_URL%
"%GIT%" push -u origin %BRANCH%
if errorlevel 1 goto :fail

echo.
echo   ---------------------------------------------------
echo   Done. On the other computer just run the update .bat
echo   ---------------------------------------------------
echo.
pause
endlocal
exit /b 0

:fail
echo.
echo   ---------------------------------------------------
echo   [ERROR] Failed. Read the git output above.
echo   If it mentions authentication, the token is missing
echo   or expired. Create a new one at
echo   https://github.com/settings/tokens   scope: repo
echo   ---------------------------------------------------
echo.
pause
endlocal
exit /b 1
