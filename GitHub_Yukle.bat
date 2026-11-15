@echo off
chcp 65001 >nul
title Mesajlasma - GitHub'a Kurulum ve Internet Yayin Sihirbazi
cd /d "%~dp0"

echo =====================================================================
echo   MESAJLASMA UYGULAMASI - GITHUB VE INTERNET KURULUM SIHIRBAZI
echo =====================================================================
echo.

where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [BILGI] Bilgisayarinizda Git bulunamadi. Winget ile Git kuruluyor...
    winget install --id Git.Git -e --source winget
    set "PATH=%PATH%;C:\Program Files\Git\cmd"
)

if not exist ".git" (
    echo [1/4] Git deposu baslatiliyor...
    git init
    git branch -M main
)

echo [2/4] Tum proje dosyalari (Telefon Rehberi, Arka Plan Servisi, Setup.exe) ekleniyor...
git add .
git commit -m "Mesajlasma v2.1 - Telefon rehberi, goruntulu arama, arka plan izni ve Windows x64 kurulum paketi"

echo.
echo [3/4] Lutfen GitHub uzerinde olusturdugunuz depo adresini girin
echo       (Ornek: https://github.com/kullaniciadiniz/mesajlasma.git)
set /p REPO_URL="GitHub Depo URL: "

if "%REPO_URL%"=="" (
    echo [UYARI] Depo adresi girilmedi. Daha sonra tekrar calistirabilirsiniz.
    pause
    exit /b 0
)

git remote remove origin >nul 2>&1
git remote add origin %REPO_URL%

echo [4/4] Kodlar GitHub'a yukleniyor...
git push -u origin main

echo.
echo =====================================================================
echo   BASARILI! Projeniz GitHub'a yuklendi!
echo   Simdi https://dashboard.render.com veya https://railway.app uzerinden
echo   bu GitHub deponuzu secerek ucretsiz internet linkinizi alabilirsiniz!
echo =====================================================================
pause
