@echo off
chcp 65001 >nul
title NexusChat E2EE - Otomatik Başlatıcı
color 0A

echo ============================================================
echo   NexusChat E2EE - WhatsApp Seviyesinde Guvenli Iletisim
echo ============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Bilgisayarinizda Node.js kurulu degil!
    echo Lutfen https://nodejs.org adresinden LTS surumunu indirip kurun.
    pause
    exit /b 1
)

echo [1/2] Node.js surumu dogrulandi:
node -v
echo.

echo [2/2] Sunucu baslatiliyor...
start "" http://localhost:3000
node server.js
pause
