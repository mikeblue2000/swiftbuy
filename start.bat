@echo off
title SwiftBuy Server
cd /d "%~dp0"
echo Starting SwiftBuy server...
echo Your shop will open at http://localhost:3000
start "" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
