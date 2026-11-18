# NexusChat v5 Pro — Çözülen Sorunlar ve Kullanım

1. **Çoklu Numaralı Rehber Kişisi Seçimi (Resim 2):** Android rehberden birden fazla numarası olan bir kişi (ör. `Cem ORTİ + 2 tane daha`) seçilip **Bitti** dendiğinde artık numara seçim ekranı açılır; istediğiniz numarayı veya tüm numaraları seçip kaydedebilirsiniz. Ayrıca Android arka plandan dönerken ağ kopmalarına karşı `localStorage` kalıcı kuyruğu ile otomatik yeniden deneme eklendi.
2. **Aramalarda Ses ve Görüntü Aktarımı:** STUN sunucularına ek olarak TURN sunucuları ve mobil operatör (4.5G/5G CGNAT) arkasında WebRTC UDP paketleri engellendiğinde bile ses ve kamera karelerini anında ileten WebSocket Medya Rölesi entegre edildi.
3. **Bilgisayar Arka Plandayken Bildirim/Arama Düşmemesi:** İstemci cihaz tipi (`mobile` / `desktop`) ve sekme görünürlüğü (`visibilitychange`) sunucuya bildirilir; bilgisayar tarayıcısı kapalıyken veya arka plandayken arama ve push bildirimleri yalnızca cep telefonuna yönlendirilir.
