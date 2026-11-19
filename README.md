# NexusChat v11 Verified — Neden Ekran Görüntüsünde `[Şifreli Mesaj]` Görünüyordu ve Nasıl Çözüldü?

1. **Ekran Görüntüsündeki Sorunun Kök Nedeni (`⏳ Henüz katılmadı` Yer Tutucu Hesap):**
   * Ekran görüntüsünde sohbet başlığında **"Aaşkım — ⏳ Henüz katılmadı • +90 530 885 89 26"** yazıyordu.
   * Kişiyi ilk eklediğinizde henüz kayıtlı olmadığı için sistem ona bir **yer tutucu ID** oluşturmuştu; karşı taraf sonradan uygulamaya kayıt olduğunda farklı bir `userId` ve `public_key_jwk` aldı, ancak eski sohbet penceresi hala yer tutucu ID'ye bağlı kaldığı için gelen mesajın açık anahtarıyla eşleşemiyordu.
2. **Kesin Çözüm (`server.js`, `crypto.js`, `app.js`):**
   * Karşı taraf uygulamaya kayıt olduğu anda (`integratePhoneContacts` ve `GET /api/contacts`) aynı telefon numarasına (`+905308858926`) sahip eski yer tutucu kayıt otomatik olarak gerçek kayıtlı hesapla (`COALESCE(reg.id, u.id)`) ve gerçek `public_key_jwk` anahtarıyla birleştirilir.
   * Sohbet açıldığında veya yeni mesaj geldiğinde kişi bilgisi otomatik yenilenir ve çözülen tüm mesajlar cihazdaki kalıcı kasaya (`nexus_plain_vault_...`) kaydedilir.
