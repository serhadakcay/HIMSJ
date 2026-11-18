# NexusChat E2EE — WhatsApp Seviyesinde Tam Kapsamlı İletişim Uygulaması

## Özellikler
- **Şifreli Kayıt & Giriş:** Cep telefonu numarası ve şifre (`crypto.scryptSync` + `timingSafeEqual`) ile güvenli hesap oluşturma.
- **Telefon Rehberi & Otomatik Entegrasyon:** Cep telefonu rehberinden kişi seçme (`Contact Picker API`) veya numara ekleme; eklenen kişi uygulamaya kayıt olduğunda otomatik eşleşme.
- **SMS ve WhatsApp Davet Gönderimi:** Eklenen kişilere tek dokunuşla WhatsApp veya SMS üzerinden davet mesajı gönderme.
- **Gerçek Uçtan Uca Şifreleme (E2EE):** ECDH P-256 + HKDF Ratchet + AES-256-GCM (Sunucu mesaj içeriklerini göremez).
- **Sesli ve Görüntülü Arama:** WebRTC tabanlı gerçek zamanlı sesli/görüntülü görüşme.
- **Program Kapalıyken Bildirim & Gelen Arama Uyandırma:** Sıfır bağımlılıklı RFC 8291/8292 VAPID Web Push motoru ile uygulama kapalıyken dahi ekrana bildirim ve cevaplanabilir arama düşürme.

## Çalıştırma ve GitHub Yayını
1. **Bilgisayarda:** `BASLAT.bat` dosyasına çift tıklayın (veya terminalde `node server.js`).
2. **GitHub + Bulut (HTTPS):** Dosyaları GitHub'a yükleyip Render.com / Railway.app'e bağladığınızda `render.yaml` otomatik algılanır ve ücretsiz HTTPS adresiyle tüm telefon ve bilgisayarlarda çalışır.
