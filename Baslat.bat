@echo off
chcp 65001 >nul
title Mesajlasma Sunucusu ve Masaustu Baslaticisi (Windows 10/11 x64)
cd /d "%~dp0"

echo ==============================================================
echo   MESAJLASMA UYGULAMASI BASLATILIYOR (Windows 10/11 x64)
echo ==============================================================

if exist "%~dp0MesajlasmaServer.exe" (
    echo [BILGI] MesajlasmaServer.exe (x64 Masaustu Kontrol Paneli) aciliyor...
    start "" "%~dp0MesajlasmaServer.exe"
    exit /b 0
)

set "NODE_BIN="
if exist "%~dp0node.exe" set "NODE_BIN=%~dp0node.exe"
if not defined NODE_BIN if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe"
if not defined NODE_BIN (
    for /f "delims=" %%F in ('dir /b /s "%LOCALAPPDATA%\Microsoft\WinGet\Packages\node.exe" 2^>nul') do set "NODE_BIN=%%F"
)

if not defined NODE_BIN (
    echo [HATA] Node.js bulunamadi! Lutfen Node.js LTS x64 yukleyin.
    pause
    exit /b 1
)

echo [BILGI] Sunucu baslatiliyor: "%NODE_BIN%"
start "" http://localhost:3080
"%NODE_BIN%" "%~dp0server.js"
pause
