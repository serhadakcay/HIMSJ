@echo off
chcp 65001 >nul
title NexusChat v13 - Otomatik Başlatıcı
color 0A
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Node.js kurulu degil! https://nodejs.org adresinden kurun.
    pause
    exit /b 1
)
start "" http://localhost:3000
node server.js
pause
