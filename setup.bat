@echo off
REM ============================================================
REM  One-time setup. Run this once per machine.
REM  Requires Node.js (https://nodejs.org) AND Google Chrome installed.
REM  This tool drives your real Chrome over CDP, so no browser download
REM  is needed — just the npm dependencies.
REM ============================================================
cd /d "%~dp0"

echo.
echo [1/2] Checking for Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js was not found.
  echo   Install it from https://nodejs.org ^(LTS version^), then run setup.bat again.
  echo.
  pause
  exit /b 1
)
node --version

echo.
echo [2/2] Installing dependencies ^(npm install^)...
call npm install
if errorlevel 1 (
  echo   ERROR: npm install failed.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Setup complete.
echo  Next: put your prompts in prompts.txt, then run run-batch.bat.
echo  On the first run, log in to Higgsfield in the Chrome window.
echo ============================================================
echo.
pause
