@echo off
if not "%1"=="min" start /min "" "%~f0" min & exit
title HX Live Watchdog
:loop
netstat -ano | findstr /c:":8090" | findstr /c:"LISTENING" >nul
if errorlevel 1 (
  start "" /min "C:\Users\zhy70\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "C:\Users\zhy70\Documents\New project\deploy-live\net-server.mjs"
)
timeout /t 20 /nobreak >nul
goto loop
