@echo off
title Pallas

rem ── Start Ollama if not already running ─────────────────────────────────────
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL
if errorlevel 1 (
    echo  Starting Ollama...
    start "" "%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
    timeout /t 5 /nobreak >nul
) else (
    echo  Ollama is already running.
)

rem ── Open browser and start server ───────────────────────────────────────────
echo  Starting Pallas at http://localhost:3000
start "" http://localhost:3000
"C:\Program Files\nodejs\node.exe" "%~dp0server.js"
pause
