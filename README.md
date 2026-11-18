# NexusChat v8 Ultimate — Yapılan Düzeltmeler

1. **Aramaların Ekrana Düşmemesi ve Hemen Kapanması (`server.js` & `public/app.js`):**
   * Arama teklifi (`CALL_OFFER`) hem WebSocket üzerinden hem de `POST /api/calls/offer` HTTP uç noktası üzerinden sunucuya kaydedilir. Alıcı cihaz `GET /api/calls/poll` ile 2.5 saniyede bir kontrol ederek WebSocket uyuduğunda bile gelen arama ekranını (`📞 Aç / ❌ Reddet`) anında açar.
   * Arama başlatıldığında WebSocket anlık kopuk olsa bile çağrı hemen kapanmaz, 10 kez çaldırma döngüsünü tamamlar.
2. **Handsfree (Hoparlör) Varsayılan Kapalı / Ahize Modu (`public/app.js`):**
   * Görüşme başladığında `isHandsfreeOn = false` olarak başlar; ses düşük/ahize seviyesinde tutulur ve `setSinkId` ile ahize çıkışı seçilir.
   * **🔈 Ahize (Hoparlör Kapalı)** butonuna dokunulduğunda **🔊 Handsfree: Açık** moduna geçerek sesi dışarı (hoparlöre) verir.
