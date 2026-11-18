# NexusChat v7 Ultimate — Düzeltmeler ve Yeni Özellikler

1. **Gelen Arama Açma (Cevapla) & Reddetme Butonları (`index.html` & `app.js`):** CSS'teki çakışan `hidden` özelliği giderilerek gelen aramalarda büyük yeşil **📞 Aç (Cevapla)** ve kırmızı **❌ Reddet** butonlarının her ekranda görünmesi sağlandı.
2. **10 Çalma (Ring) Kuralı & Cevapsız Arama Kaydı:** Arama başlatıldığında karşı tarafı tam **10 kez** çaldırır (`1 / 10 ... 10 / 10`). 10 çalma sonunda açılmazsa arayan tarafa **"Aradığınız kişi cevap vermiyor"** uyarısı vererek aramayı kapatır; aranan kişinin ekranına ve **📞 Aramalar** sekmesine kırmızı **📵 Cevapsız Arama** kaydı düşürür.
3. **Çift Yönlü Görüntülü Arama:** Alıcı cihaz aramayı açtığı anda kendi kamerasını da başlatıp WebSocket/WebRTC medya rölesini çift yönlü aktif eder.
4. **Rehberden Kişi Ekleme:** Android sistem rehberi kapandıktan sonra sekmenin uykudan uyanmasını (`visibilitychange`) bekleyip 4 kez otomatik yeniden deneyerek kişi ve numaraları eksiksiz kaydeder.
