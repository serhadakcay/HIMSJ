# NexusChat v10 Final — Çözülen Sorunlar

1. **Gönderilen ve Gelen Mesajların Okunamaması (`[Şifreli Mesaj]` Sorunu — Ekran Görüntüsü):**
   * Önceki sürümde mesaj sayacı (`recvNum`) sayfa yenilendiğinde sıfırlandığı veya sender/recipient açık anahtarları veritabanında eşleşmediği için mesajlar `[Şifreli Mesaj]` olarak kalıyordu.
   * **Kesin Çözüm:** Hem `sender_public_key_jwk` hem de `recipient_public_key_jwk` her mesaj satırına kaydedilir ve her mesajın benzersiz `IV` değeriyle türetilen `ECDH P-256 + HKDF-SHA256 + AES-256-GCM` anahtarı sayesinde hem gönderilen hem de gelen tüm mesajlar sayfa yenilense bile **%100 okunur**.
2. **Rehber İzni & Kişide Numara Seçme Hakkı:**
   * **🔓 Rehber İzni Ver & Seç** butonuna dokunduğunuzda cihazın rehber izin penceresi açılır; seçilen kişideki numaralar liste halinde önünüze gelir ve istediğiniz numarayı (veya tümünü) seçebilirsiniz.
3. **Konum, Telefondan Kişi, Fotoğraf ve Dosya Paylaşımı:**
   * Sohbet içindeki **📎** menüsünden **Fotoğraf**, **Dosya**, **Kişi Paylaş** (hem telefon rehberinden hem uygulama rehberinden) ve **Konum Paylaş** (GPS + Google Haritalar) uçtan uca şifreli olarak çalışır.
