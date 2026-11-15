@echo off
chcp 65001 >nul
title Mesajlasma - Windows Guvenlik Duvari Port Izni (3080 ve 3443)
cd /d "%~dp0"

echo Windows Guvenlik Duvarinda 3080 (HTTP) ve 3443 (HTTPS/WebRTC) portlarina izin veriliyor...
netsh advfirewall firewall delete rule name="Mesajlasma_Sunucu_TCP_3080" >nul 2>&1
netsh advfirewall firewall delete rule name="Mesajlasma_Sunucu_TCP_3443" >nul 2>&1

netsh advfirewall firewall add rule name="Mesajlasma_Sunucu_TCP_3080" dir=in action=allow protocol=TCP localport=3080
netsh advfirewall firewall add rule name="Mesajlasma_Sunucu_TCP_3443" dir=in action=allow protocol=TCP localport=3443

echo.
echo [BASARILI] Cep telefonlarinin ayni Wi-Fi agindan baglanmasi icin port izinleri tanimlandi!
timeout /t 4
