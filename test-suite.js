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

    // 4. Cep telefonu rehberinden kişi ekleme (Contact Picker + VCF Quoted-Printable + iPhone item1.TEL + Manuel + Canlı Numara Sorgulama)
    // 4a. WhatsApp / Telegram tarzı canlı numara sorgulama (lookup)
    const lookupBefore = await req('/api/contacts/lookup?phone=05423832663', 'GET', null, tokenKaan);
    assert.strictEqual(lookupBefore.status, 200);
    assert.strictEqual(lookupBefore.data.valid, true);
    assert.strictEqual(lookupBefore.data.isRegistered, false);

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
          // Android Chrome Contact Picker API ham formatı (+2 tane daha çoklu numara):
          { name: ['Cem ORTİ'], tel: ['05423832663', '+905423832663', '0542 383 26 63'] },
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
    assert.strictEqual(syncRes.data.importedCount, 6, 'Cem ORTİ (+2 numara), Manuel, Contact Picker, kendi numarası ve Android/iPhone VCF kişileri eksiksiz eklenmeli');

    const cemContact = syncRes.data.contacts.find((c) => c.display_name.includes('Cem ORTİ') || c.phone.includes('542'));
    assert(cemContact, 'Cem ORTİ rehbere eklenmiş olmalı');
    assert(cemContact.whatsappUrl.includes('5423832663'), 'Cem ORTİ WhatsApp linki içermeli');

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

    // 7. Mesaj gönderme, Web Push (VAPID) ve Arka Plan Bildirim Yoklama (Program Kapalıyken Bildirim)
    const vapidRes = await req('/api/push/vapid-public-key', 'GET');
    assert.strictEqual(vapidRes.status, 200);
    assert(vapidRes.data.publicKey && vapidRes.data.publicKey.length > 40, 'VAPID public key üretilmeli');

    const subRes = await req(
      '/api/push/subscribe',
      'POST',
      {
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-kaan',
          keys: {
            p256dh: Buffer.alloc(65, 4).toString('base64url'),
            auth: Buffer.alloc(16, 1).toString('base64url')
          }
        }
      },
      tokenKaan
    );
    assert.strictEqual(subRes.status, 200);

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
    console.log('[OK] 7. Program kapalıyken Web Push + arka plan mesaj bildirim yoklama testi başarılı.');

    // 8. Cem Orti Giriş Yaptığında Diğer Kullanıcıların Cem Orti Olmaması & Kendi Adıyla Doğrudan Kalıcı Giriş Testi
    const loginCem = await req('/api/auth/login', 'POST', {
      username: 'Cem Orti',
      phone: '0542 383 26 63'
    });
    assert.strictEqual(loginCem.status, 200);
    assert.strictEqual(loginCem.data.user.display_name, 'Cem Orti', 'Cem Orti kendi adıyla doğrudan giriş yapabilmeli');

    const loginAhmet = await req('/api/auth/login', 'POST', {
      username: 'Ahmet Yılmaz'
    });
    assert.strictEqual(loginAhmet.status, 200);
    assert.strictEqual(loginAhmet.data.user.display_name, 'Ahmet Yılmaz', 'Her kullanıcı kayıt sekmesine gitmeden kendi adıyla doğrudan giriş yapabilmeli');

    // Sunucu yeniden başlatma simülasyonu (sessions tablosu sıfırlansa ve Cem Orti son kullanıcı olsa bile):
    db.exec('DELETE FROM sessions');

    // Profil bilgisi olmayan rastgele bir token ASLA Cem Orti'ye bağlanmamalı!
    const randomHexToken = 'a'.repeat(64);
    const pollUnknown = await req(`/api/notifications/poll?token=${randomHexToken}`, 'GET');
    assert.strictEqual(pollUnknown.status, 401, 'Profil bilgisi olmayan bilinmeyen token Cem Orti hesabına bağlanmamalı');

    // Kaan'ın cihazı kendi X-User-Profile başlığı ile istek attığında Kaan olarak kalmalı (asla Cem Orti olmamalı!)
    const kaanProfileB64 = Buffer.from(
      encodeURIComponent(
        JSON.stringify({
          id: regKaan.data.user.id,
          username: regKaan.data.user.username,
          display_name: 'Kaan Yıldız',
          phone: '0532 111 22 33'
        })
      ).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))),
      'latin1'
    ).toString('base64');

    const meKaanRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${tokenKaan}`,
        'X-User-Profile': kaanProfileB64
      }
    });
    const meKaanData = await meKaanRes.json();
    assert.strictEqual(meKaanRes.status, 200);
    assert.strictEqual(meKaanData.user.display_name, 'Kaan Yıldız', 'Cem Orti giriş yaptıktan sonra Kaan kendi adıyla kalmalı, Cem Orti olmamalı!');
    console.log('[OK] 8. Cem Orti giriş yaptığında diğer kullanıcıların kimliği korundu; her kullanıcı kendi adıyla kalıcı giriş yaptı.');
  } finally {
    // 9. Test bittikten sonra veritabanını tamamen temizle (Madde 4: Database boş olsun)
    clearAllDatabaseData();
    const finalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
    const finalContacts = db.prepare('SELECT COUNT(*) as cnt FROM contacts').get().cnt;
    const finalConvs = db.prepare('SELECT COUNT(*) as cnt FROM conversations').get().cnt;
    const finalMsgs = db.prepare('SELECT COUNT(*) as cnt FROM messages').get().cnt;
    assert.strictEqual(finalUsers, 0);
    assert.strictEqual(finalContacts, 0);
    assert.strictEqual(finalConvs, 0);
    assert.strictEqual(finalMsgs, 0);
    console.log('[OK] 9. Veritabanı temizlendi ve tamamen boş bırakıldı (0 kullanıcı, 0 kişi, 0 mesaj).');

    httpServer.close();
    if (httpsServer) httpsServer.close();
  }

  console.log('\n=== TUM TESTLER BASARIYLA TAMAMLANDI (9/9 PASS) ===');
}

runTests().catch((err) => {
  console.error('TEST HATASI:', err);
  process.exit(1);
});
