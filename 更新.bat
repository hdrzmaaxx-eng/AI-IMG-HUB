@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Pull the latest code from GitHub into this folder.
rem  Only code files are overwritten.
rem  records\ and config.json are LOCAL data - never touched.
rem ============================================================

set "REPO_URL=https://github.com/hdrzmaaxx-eng/AI-IMG-HUB.git"
set "BRANCH=main"
set "TMPF=%TEMP%\aiimghub-sync.tmp"

echo.
echo   ==========================================
echo     AI IMG HUB  -  update from GitHub
echo   ==========================================
echo.

rem ---- 1) locate git ----
set "GIT="
for %%I in (git.exe) do if not defined GIT set "GIT=%%~$PATH:I"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"
if not defined GIT if exist "%USERPROFILE%\scoop\apps\git\current\cmd\git.exe" set "GIT=%USERPROFILE%\scoop\apps\git\current\cmd\git.exe"

if not defined GIT (
  echo   [ERROR] Git not found.
  echo.
  echo   Install Git for Windows first:  https://git-scm.com/download/win
  echo   Then run this file again.
  echo.
  pause
  exit /b 1
)

rem ---- 2) make sure this folder is linked to the repo ----
"%GIT%" rev-parse --git-dir >nul 2>&1
if errorlevel 1 goto :bind

"%GIT%" remote set-url origin "%REPO_URL%" >nul 2>&1
if errorlevel 1 "%GIT%" remote add origin "%REPO_URL%" >nul 2>&1

set "HASHEAD="
"%GIT%" rev-parse --verify HEAD >nul 2>&1
if not errorlevel 1 set "HASHEAD=1"
goto :fetch

:bind
echo   This folder is not linked to the repo yet. Linking now...
"%GIT%" init -b %BRANCH% >nul 2>&1
"%GIT%" remote remove origin >nul 2>&1
"%GIT%" remote add origin "%REPO_URL%"

:fetch
echo.
echo   Fetching from  %REPO_URL%
"%GIT%" fetch origin %BRANCH%
if errorlevel 1 goto :fail

set "BEFORE="
"%GIT%" rev-parse --short HEAD > "%TMPF%" 2>nul
set /p BEFORE=<"%TMPF%"

rem ---- 3) back up local code changes before overwriting ----
if not defined HASHEAD goto :sync
"%GIT%" diff --quiet HEAD >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [!] Local code changes found - saving them to git stash first.
  "%GIT%" stash push -m "auto backup before update" >nul
  if errorlevel 1 echo   [!] Stash failed, continuing anyway.
)

:sync
echo.
echo   Applying the cloud version...
"%GIT%" reset --hard origin/%BRANCH%
if errorlevel 1 goto :fail

set "AFTER="
"%GIT%" rev-parse --short HEAD > "%TMPF%" 2>nul
set /p AFTER=<"%TMPF%"
del "%TMPF%" >nul 2>&1

rem ---- 4) report ----
echo.
if "%BEFORE%"=="%AFTER%" (
  echo   Already up to date.   revision %AFTER%
) else (
  echo   Updated:   %BEFORE%  --^>  %AFTER%
)
echo.
"%GIT%" log -1 --format="  Latest: %%h  %%s"
echo.

if not exist "records\" mkdir "records" >nul 2>&1

echo   ---------------------------------------------------
echo   records\ and config.json were NOT touched.
echo   Double-click the  chinese-named launcher .bat  to start.
echo   ---------------------------------------------------
echo.
pause
endlocal
exit /b 0

:fail
echo.
echo   ---------------------------------------------------
echo   [ERROR] Update failed. Read the git output above.
echo   Usual causes: no network / wrong repo URL / expired token.
echo   records\ and config.json were NOT touched.
echo   ---------------------------------------------------
echo.
pause
endlocal
exit /b 1
