# 🔒 Mesajlaşma v2.2 — Telefon Rehberi, SMS/WhatsApp Davet, Otomatik Numara Entegrasyonu ve Görüntülü Arama

WhatsApp, Telegram ve Signal benzeri özellikleri bir araya getiren; cep telefonunda kayıtlı numaraları rehbere ekleyip **SMS veya WhatsApp** üzerinden davet mesajı gönderebilen, kaydedilen kişiler programı kullandığında numaralarıyla **otomatik entegre eden**, **Görüntülü (`📹`)**, **Görüntüsüz/Sesli (`📞`)** arama ve **Uçtan Uca Şifreli Mesajlaşma (`💬`)** yapabilen çok platformlu uygulama.

---

## 📒 1. Cep Telefonu Rehberinden Kişi Ekleme ve SMS / WhatsApp Daveti

Sol menüdeki **📒 Rehber** sekmesinden veya üst bardaki **📒+** butonundan:
1. **📱 Rehberden Kişi Seç:** Cep telefonunuzun kendi rehberini açar (`navigator.contacts.select`); seçtiğiniz kişileri ve numaralarını tek dokunuşla programa aktarır.
2. **📂 Rehber / Kişi Kartı (`.vcf`) Seç:** Android (Quoted-Printable UTF-8) ve iPhone (`item1.TEL`) rehber dosyalarını ve kişi kartlarını eksiksiz içe aktarır.
3. **📋 Toplu Kişi / Numara Yapıştır:** Kopyalanan kişi ve numaraları topluca rehbere ekler.
4. **➕ Numara ile Kişi Ekle & SMS / WhatsApp Gönder:** Kişi eklendiği anda:
   - `"............ Bu numaraları kullanıcı sizi programı kullanmak için ekledi"` şablonuyla **🟢 WhatsApp (`wa.me`)** ve **📩 SMS (`sms:`)** mesajı hazırlar ve tek tıkla gönderir.

---

## 🔗 2. Kaydedilen Kişilerin Otomatik Numara Entegrasyonu

- Rehberinize kaydettiğiniz bir numara daha sonra programa kayıt olduğunda, giriş yaptığında veya profiline numarasını girdiğinde sistem bu numarayı otomatik tanır.
- Eski yer tutucu rehber kaydını gerçek kullanıcı hesabıyla birleştirir, her iki tarafın rehber ve sohbet listesini otomatik eşleştirir ve sohbette **`✅ Programı Kullanıyor`** durumuna geçirir.

---

## 🌐 3. GitHub'a Yüklenmesi Gereken Dosyalar

Klasördeki **[`GitHub_Yukle.bat`](file:///c:/Users/Aile/Desktop/yeni/GitHub_Yukle.bat)** dosyasına çift tıkladığınızda (`.gitignore` kuralları sayesinde kişisel veritabanı ve özel sertifikalar hariç tutularak) yalnızca gerekli proje dosyaları otomatik yüklenir.
