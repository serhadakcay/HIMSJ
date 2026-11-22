# NexusChat v14 Ultimate — Yapılan Düzeltmeler

1. **Hesap Karışması ve Kayıt Silinmesi Sorunu (`server.js` & `public/app.js`):**
   * Kayıtlı bir kullanıcının rehber kaydının veya profilinin başka bir numarayla giriş yapıldığında silinmesi/değişmesi engellendi (`integratePhoneContacts` içinde yalnızca kayıtsız `is_registered = 0` yer tutucular birleştirilir).
   * Giriş/Kayıt ve Oturum Kapatma (`POST /api/auth/logout`) işlemlerinde önceki oturuma ait WebSocket ve önbellek durumu (`resetSessionState`) tamamen sıfırlanır.
2. **Çevrimdışı (Offline) Kişilere Mesaj Atma ve Arama Başlatma (`public/app.js` & `public/crypto.js`):**
   * Alıcı çevrimdışı (`offline`) olduğunda mesaj kutusu ve arama butonları artık kilitlenmez.
   * Gönderilen mesajlar sunucuda saklanır ve karşı tarafın telefonu kapalı/uykuda olsa dahi Web Push bildirimi gönderilir.
3. **Arka Planda Çalışma ve Kapalıyken Otomatik Bildirim (`server.js` & `public/sw.js`):**
   * `triggerPushToUser` tüm kayıtlı cihaz aboneliklerine yüksek öncelikli (`Urgency: high`) Web Push bildirimi iletir; uygulama tamamen kapalı olsa bile Service Worker gelen arama ve mesaj bildirimini ekrana düşürür.
