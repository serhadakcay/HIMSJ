@echo off
chcp 65001 >nul
title NexusChat v14 - Otomatik Başlatıcı
color 0A
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Node.js kurulu degil! https://nodejs.org adresinden kurun.
    pause
    exit /b 1
)
if not exist ".env" (
    echo [HATA] .env dosyasi bulunamadi! .env.example dosyasini .env olarak kopyalayip DATABASE_URL yazin.
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo Paketler kuruluyor...
    call npm install
)
start "" http://localhost:3000
node --env-file=.env server.js
pause
