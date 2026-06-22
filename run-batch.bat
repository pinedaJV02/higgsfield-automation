@echo off
REM ============================================================
REM  Runs the batch: reads prompts.txt, generates each image with
REM  Unlimited ON, and saves results to the output folder.
REM  On the first run, log in to Higgsfield in the Chrome window.
REM ============================================================
cd /d "%~dp0"
node src\index.js
pause
