@echo off
REM ============================================================
REM  Alias for run-batch.bat (kept for convenience).
REM  Reads prompts.txt and generates each image with Unlimited ON.
REM ============================================================
cd /d "%~dp0"
node src\index.js
pause
