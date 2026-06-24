@echo off
REM ============================================================
REM  Opens the local web control panel: edit config & prompts,
REM  upload character references, run the batch with live logs,
REM  and browse the output gallery. A browser tab opens
REM  automatically. Leave this window open while you use it.
REM ============================================================
cd /d "%~dp0"
node src\server.js
pause
