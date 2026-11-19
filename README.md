# NexusChat v9 — Telefon Rehberine Yazma & Okuma Entegrasyonu

## Entegre Edilen Özellikler
1. **Telefonun Kendi Rehberine Kaydetme (Web / PWA + Native):**
   * **Web / PWA (Chrome & Safari):** Sunucu `/api/vcard?name=...&phone=...` üzerinden `E.164 (+90...)` formatında `vCard 3.0 (.vcf)` üretir ve telefonun kendi **"Yeni Kişi Ekle / Rehbere Kaydet"** ekranını açar.
   * **Native Android (`native-mobile-wrapper/MainActivity.kt` & `AndroidManifest.xml`):** `READ_CONTACTS` / `WRITE_CONTACTS` çalışma zamanı (runtime) izinleri ve `ContactsContract.Intents.Insert.ACTION` köprüsü (`window.AndroidNative.insertContact`) eklendi.
   * **Native iOS (`native-mobile-wrapper/IOSContactsBridge.swift` & `Info.plist`):** `NSContactsUsageDescription` izni ve `CNMutableContact` / `CNSaveRequest` kaydı (`window.webkit.messageHandlers.insertContact`) eklendi.
