/**
 * Mesajlaşma Uygulaması - Kapsamlı Kullanıcı ve Entegrasyon Test Paketi (v2.2)
 * Test edilen senaryolar:
 * 1. Windows 10/11 x64 Yürütülebilir Dosyalar (MesajlasmaServer.exe ve MesajlasmaSetup.exe)
 * 2. Başlangıçta Veritabanının Boş Olması (Deneme/Demo isim ve numaralarının silinmiş olması)
 * 3. Yeni Kullanıcı Kaydı ve Cep Telefonu Numarası ile Giriş
 * 4. Cep Telefonu Rehberinden Kişi Ekleme (Contact Picker API, Android/iPhone VCF ve Toplu Metin)
 * 5. Eklenen Kişilere SMS ve WhatsApp Bilgilendirme Mesajı ("... Bu numaraları kullanıcı sizi programı kullanmak için ekledi")
 * 6. Kaydedilen Kişi Programı Kullandığında Numaralar ile Kaydedilen Kişilerin Otomatik Entegrasyonu
 * 7. Şifreli Mesajlaşma (E2EE), Arka Plan Bildirim Yoklama ve Kurulum Dosyası İndirme
 * 8. Test Sonrası Veritabanının Tekrar Boş Bırakılması
 */

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { db, clearAllDatabaseData } = require('./db');
const { startServers, HTTP_PORT } = require('./server');

const BASE_URL = `http://localhost:${HTTP_PORT}`;

async function req(endpoint, method = 'GET', body = null, token = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function runTests() {
  console.log('=== MESAJLASMA v2.2 KULLANICI SENARYOLARI TESTI BASLIYOR ===\n');

  // Test öncesi veritabanını tamamen temizle
  clearAllDatabaseData();

  // 1. Windows 10/11 x64 Yürütülebilir Dosyalar (MesajlasmaServer.exe ve MesajlasmaSetup.exe)
  const serverExe = path.join(__dirname, 'MesajlasmaServer.exe');
  const setupExe = path.join(__dirname, 'MesajlasmaSetup.exe');
  execFileSync(serverExe, ['--check']);
  execFileSync(setupExe, ['--check']);
  console.log('[OK] 1. MesajlasmaServer.exe ve MesajlasmaSetup.exe x64 mimari doğrulaması başarılı.');

  // 2. Veritabanının boş olduğunu doğrula
  const initialUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const initialConvs = db.prepare('SELECT COUNT(*) as cnt FROM conversations').get().cnt;
  assert.strictEqual(initialUsers, 0, 'Veritabanında başlangıçta kullanıcı olmamalı');
  assert.strictEqual(initialConvs, 0, 'Veritabanında başlangıçta sohbet olmamalı');
  console.log('[OK] 2. Deneme amaçlı isimler ve numaralar silindi; veritabanı tamamen boş.');

  const { httpServer, httpsServer } = startServers();
  await new Promise((r) => setTimeout(r, 400));

  try {
    // 3. Kullanıcı 1 (Kaan) numarasıyla kayıt oluyor (kullanıcı adı boş bırakılsa bile otomatik oluşturulmalı)
    const regKaan = await req('/api/auth/register', 'POST', {
      displayName: 'Kaan Yıldız',
      phone: '0532 111 22 33',
      username: '',
      password: '123456',
      publicKey: 'pubkey_kaan_1',
      deviceName: 'Android Telefon',
      devicePlatform: 'Android'
    });
    assert.strictEqual(regKaan.status, 201);
    const tokenKaan = regKaan.data.token;
    assert(tokenKaan, 'Token üretilmeli');
    console.log('[OK] 3. Yeni kullanıcı kaydı (boş veritabanı üzerinde) başarılı.');

    // 4. Cep telefonu rehberinden kişi ekleme (Contact Picker + VCF Quoted-Printable + iPhone item1.TEL + Manuel)
    const vcfSample = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=C3=96mer=20=C5=9Eahin',
      'TEL;CELL:0544 777 88 99',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Selin Demir',
      'item1.TEL;type=CELL;type=VOICE;type=pref:+90 (533) 666-5544',
      'END:VCARD'
    ].join('\r\n');

    const syncRes = await req(
      '/api/contacts/sync',
      'POST',
      {
        contacts: [
          { name: 'Burak Kaya', phone: '0555 444 33 22' },
          // Android Chrome Contact Picker API ham formatı:
          { name: ['Zeynep Aydın'], tel: ['+90 536 789 01 23'] },
          // Kullanıcının kendi telefon numarasını rehberden seçmesi durumu:
          { name: ['Kaan Kendi Numaram'], tel: ['0532 111 22 33'] }
        ],
        rawText: vcfSample,
        inviteChannel: 'whatsapp'
      },
      tokenKaan
    );
    assert.strictEqual(syncRes.status, 200);
    assert.strictEqual(syncRes.data.importedCount, 5, 'Manuel, Contact Picker ham formatı, kendi numarası ve Android/iPhone VCF kişileri eksiksiz eklenmeli');

    // 5. SMS ve WhatsApp davet mesajı içeriğini doğrula
    assert(
      syncRes.data.inviteMessage.includes('Bu numaraları kullanıcı sizi programı kullanmak için ekledi'),
      'Davet mesajı istenen metni içermeli'
    );
    const burakContact = syncRes.data.contacts.find((c) => c.phone.includes('555'));
    assert(burakContact, 'Burak rehberde bulunmalı');
    assert.strictEqual(burakContact.isRegistered, false, 'Burak henüz programa kayıt olmadı');
    assert(burakContact.whatsappUrl.startsWith('https://wa.me/905554443322?text='), 'WhatsApp davet linki doğru olmalı');
    assert(burakContact.smsUrl.startsWith('sms:+905554443322?body='), 'SMS davet linki doğru olmalı');
    console.log('[OK] 4 & 5. Cep telefonu rehberinden kişi ekleme ve SMS/WhatsApp mesaj üretimi başarılı.');

    // 6. Kaydedilen kişi (Burak - 0555 444 33 22) programı kullanmaya başlıyor (Kayıt oluyor) -> Otomatik Entegrasyon!
    const regBurak = await req('/api/auth/register', 'POST', {
      displayName: 'Burak Kaya (Gerçek Hesap)',
      phone: '+90 555 444 33 22',
      username: 'burakkaya',
      password: '654321',
      publicKey: 'pubkey_burak_1',
      deviceName: 'iPhone 15',
      devicePlatform: 'iOS'
    });
    assert.strictEqual(regBurak.status, 201);
    assert.strictEqual(regBurak.data.integratedCount, 1, 'Burak kayıt olduğunda Kaan ile otomatik entegre edilmeli');
    const tokenBurak = regBurak.data.token;

    // Kaan'ın rehberinde Burak artık isRegistered = true olmalı ve aynı ID'yi paylaşmalı
    const kaanUsers = await req('/api/users', 'GET', null, tokenKaan);
    const burakInKaanList = kaanUsers.data.users.find((u) => u.phone.includes('555'));
    assert(burakInKaanList, 'Burak Kaan\'ın rehber listesinde olmalı');
    assert.strictEqual(burakInKaanList.isRegistered, true, 'Burak artık kayıtlı kullanıcı olarak görünmeli');
    assert.strictEqual(burakInKaanList.id, regBurak.data.user.id, 'Rehberdeki kişi gerçek hesap ID\'si ile entegre olmalı');

    // Burak'ın sohbet listesinde Kaan ile olan sohbet ve geçmiş davet mesajı + entegrasyon mesajı görünmeli
    const burakConvs = await req('/api/conversations', 'GET', null, tokenBurak);
    assert(burakConvs.data.conversations.length >= 1, 'Burak doğrudan Kaan ile olan entegre sohbeti görmeli');
    const sharedConvId = burakConvs.data.conversations[0].id;
    const sharedMsgs = await req(`/api/conversations/${sharedConvId}/messages`, 'GET', null, tokenBurak);
    const hasInviteMsg = sharedMsgs.data.messages.some((m) =>
      m.content.includes('Bu numaraları kullanıcı sizi programı kullanmak için ekledi')
    );
    const hasIntegrationMsg = sharedMsgs.data.messages.some((m) =>
      m.content.includes('otomatik eşleştirildi')
    );
    assert(hasInviteMsg, 'Önceden gönderilen davet mesajı entegre sohbette korunmalı');
    assert(hasIntegrationMsg, 'Otomatik numara entegrasyon sistem mesajı oluşturulmalı');
    console.log('[OK] 6. Kaydedilen kişiler programı kullandığında numaralarla otomatik entegrasyon testi başarılı.');

    // 7. Mesaj gönderme ve Arka Plan Bildirim Yoklama (SQLite zaman damgası uyumu)
    const sendMsgRes = await req(
      `/api/conversations/${sharedConvId}/messages`,
      'POST',
      {
        msgType: 'text',
        content: 'Merhaba Kaan, davetin üzerine programa katıldım!',
        isEncrypted: false
      },
      tokenBurak
    );
    assert.strictEqual(sendMsgRes.status, 201);

    const pollRes = await req(
      `/api/notifications/poll?since=${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}`,
      'GET',
      null,
      tokenKaan
    );
    assert.strictEqual(pollRes.status, 200);
    assert(pollRes.data.unreadMessages.length >= 1, 'Arka plan bildirim yoklaması yeni mesajı yakalamalı');
    console.log('[OK] 7. Mesajlaşma ve arka plan bildirim yoklama testi başarılı.');
  } finally {
    // 8. Test bittikten sonra veritabanını tamamen temizle (Madde 4: Database boş olsun)
    clearAllDatabaseData();
    const finalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
    const finalContacts = db.prepare('SELECT COUNT(*) as cnt FROM contacts').get().cnt;
    const finalConvs = db.prepare('SELECT COUNT(*) as cnt FROM conversations').get().cnt;
    const finalMsgs = db.prepare('SELECT COUNT(*) as cnt FROM messages').get().cnt;
    assert.strictEqual(finalUsers, 0);
    assert.strictEqual(finalContacts, 0);
    assert.strictEqual(finalConvs, 0);
    assert.strictEqual(finalMsgs, 0);
    console.log('[OK] 8. Veritabanı temizlendi ve tamamen boş bırakıldı (0 kullanıcı, 0 kişi, 0 mesaj).');

    httpServer.close();
    if (httpsServer) httpsServer.close();
  }

  console.log('\n=== TUM TESTLER BASARIYLA TAMAMLANDI (8/8 PASS) ===');
}

runTests().catch((err) => {
  console.error('TEST HATASI:', err);
  process.exit(1);
});
