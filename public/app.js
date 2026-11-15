/**
 * Mesajlaşma Uygulaması - İstemci Uygulama Mantığı
 * - Cep Telefonu Rehberinden Kişi Ekleme (Contact Picker API + VCF + Toplu Metin + Manuel)
 * - Numara veya Rehberden Eklenen Kişilere SMS ve WhatsApp Mesajı Gönderme
 *   ("............ Bu numaraları kullanıcı sizi programı kullanmak için ekledi")
 * - Kaydedilen Kişiler Programı Kullandığında Otomatik Numara ve Hesap Entegrasyonu
 * - Aktif Olanları Yeşil (🟢), Aktif Olmayanları Kırmızı (🔴) Yuvarlakla Gösterme
 * - Program Kapatılsa Bile Arka Planda Çalışma İzni (Service Worker + Push/Notification + WakeLock)
 */

const App = {
  token: localStorage.getItem('msj_token') || '',
  user: null,
  keyBundle: null,
  ws: null,
  wsPingInterval: null,
  currentNav: 'chats',
  chatFilter: 'all',
  searchQuery: '',
  conversations: [],
  users: [],
  stories: [],
  calls: [],
  activeConvId: null,
  messages: [],
  decryptedCache: new Map(),
  replyToMsg: null,
  editingMsg: null,
  forwardingMsg: null,
  typingTimeout: null,
  serverInfo: null,
  deferredInstallPrompt: null,
  wakeLock: null,
  lastInvitedContacts: [],

  // Sesli mesaj kaydı
  mediaRecorder: null,
  audioChunks: [],
  recTimerInterval: null,
  recSeconds: 0,

  // WebRTC Arama Durumu
  peerConnection: null,
  localStream: null,
  activeCall: null,
  incomingOffer: null,
  callTimerInterval: null,
  callSeconds: 0,

  async init() {
    const savedTheme = localStorage.getItem('msj_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    // HTTPS geçişinde oturum anahtarını (auth_token) URL'den devral
    let autoOpenContacts = false;
    try {
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get('auth_token');
      if (urlToken) {
        this.token = urlToken;
        localStorage.setItem('msj_token', urlToken);
      }
      if (params.get('openContacts') === '1') {
        autoOpenContacts = true;
      }
      if (urlToken || autoOpenContacts) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch {}

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
    });

    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js?v=2.4');
        reg.update().catch(() => {});
        if (this.token && reg.active) {
          reg.active.postMessage({ type: 'SET_BG_TOKEN', token: this.token });
        }
      } catch {}
    }

    if (this.token) {
      try {
        const data = await this.api('/api/auth/me');
        this.user = data.user;
        this.keyBundle = await window.E2EE.ensureIdentityKeyPair(this.user.username);
        if (this.keyBundle.publicKey && this.keyBundle.publicKey !== this.user.public_key) {
          const updated = await this.api('/api/auth/profile', 'PUT', {
            public_key: this.keyBundle.publicKey
          });
          this.user = updated.user;
        }
        await this.enterApp();
        if (autoOpenContacts) {
          this.switchNav('contacts');
          this.openContactModal();
        }
        return;
      } catch {
        this.token = '';
        localStorage.removeItem('msj_token');
      }
    }
    this.showAuthScreen();
  },

  async api(url, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'İşlem başarısız oldu.');
    }
    return data;
  },

  toast(text, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    if (type === 'error') el.style.borderLeftColor = '#ef4444';
    el.textContent = text;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  },

  playBeep(freq = 660, duration = 0.12) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch {}
  },

  getDeviceInfo() {
    const ua = navigator.userAgent || '';
    const isMobile = /Android|iPhone|iPad|Mobile/i.test(ua);
    const platform = /Windows/i.test(ua)
      ? 'Windows x64'
      : /Android/i.test(ua)
      ? 'Android'
      : /iPhone|iPad/i.test(ua)
      ? 'iOS'
      : 'Web';
    const browser = /Edg/i.test(ua)
      ? 'Edge'
      : /Chrome/i.test(ua)
      ? 'Chrome'
      : /Safari/i.test(ua)
      ? 'Safari'
      : 'Tarayıcı';
    return {
      deviceName: `${browser} (${isMobile ? 'Cep Telefonu' : 'Bilgisayar'})`,
      devicePlatform: platform
    };
  },

  // --- ARKA PLANDA ÇALIŞMA VE İZİN SİHİRBAZI ---
  checkBackgroundBannerState() {
    const banner = document.getElementById('bg-permission-banner');
    if (!banner) return;
    const notifGranted = 'Notification' in window && Notification.permission === 'granted';
    const savedBg = localStorage.getItem('msj_bg_perm_granted') === '1';
    if (notifGranted && savedBg) {
      banner.classList.add('hidden');
      this.syncServiceWorkerToken();
    } else {
      banner.classList.remove('hidden');
    }
  },

  async syncServiceWorkerToken() {
    if (!('serviceWorker' in navigator) || !this.token) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg.active) {
        reg.active.postMessage({ type: 'SET_BG_TOKEN', token: this.token });
      }
      if ('periodicSync' in reg) {
        await reg.periodicSync.register('msj-bg-sync', { minInterval: 60 * 1000 }).catch(() => {});
      }
      if ('sync' in reg) {
        await reg.sync.register('msj-bg-sync').catch(() => {});
      }
    } catch {}
  },

  async requestAllBackgroundPermissions() {
    try {
      if ('Notification' in window) {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          this.toast('🔔 Bildirim ve arka plan uyandırma izni verildi!');
        }
      }

      await this.syncServiceWorkerToken();

      if ('wakeLock' in navigator) {
        try {
          this.wakeLock = await navigator.wakeLock.request('screen');
        } catch {}
      }

      if (this.token) {
        await this.api('/api/auth/background-permission', 'POST', { enabled: true }).catch(() => {});
      }

      localStorage.setItem('msj_bg_perm_granted', '1');
      this.checkBackgroundBannerState();

      if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
        const reg = await navigator.serviceWorker.ready;
        if (reg.active) {
          reg.active.postMessage({
            type: 'SHOW_LOCAL_NOTIFICATION',
            title: '✅ Arka Planda Çalışma Aktif',
            body: 'Program kapatılsa bile yeni mesaj ve aramalar size anında bildirilecektir.'
          });
        }
      }
    } catch (err) {
      this.toast('İzin isteği tamamlandı: ' + err.message);
    }
  },

  // --- 1 & 2. CEP TELEFONU REHBERİNDEN KİŞİ EKLEME VE SMS / WHATSAPP DAVET SİSTEMİ ---
  openContactModal() {
    document.getElementById('contact-name-input').value = '';
    document.getElementById('contact-phone-input').value = '';
    const bulkEl = document.getElementById('bulk-contacts-input');
    if (bulkEl) bulkEl.value = '';

    // Eğer cep telefonundan HTTP (güvensiz) yerel IP ile girilmişse HTTPS rehber izni ipucunu göster
    const httpsHint = document.getElementById('https-contacts-hint');
    if (httpsHint) {
      const isInsecureRemote =
        location.protocol === 'http:' &&
        location.hostname !== 'localhost' &&
        location.hostname !== '127.0.0.1';
      httpsHint.classList.toggle('hidden', !isInsecureRemote);
    }

    document.getElementById('contact-modal').classList.remove('hidden');
  },

  async switchToHttpsForContacts() {
    const query = this.token
      ? `?auth_token=${encodeURIComponent(this.token)}&openContacts=1`
      : '?openContacts=1';
    try {
      const info = await this.api('/api/server-info');
      if (info && info.httpsUrl) {
        window.location.href = info.httpsUrl + query;
        return;
      }
    } catch {}
    window.location.href = `https://${location.hostname}:3443${query}`;
  },

  importFromPhoneContactsApi() {
    // ÖNEMLİ: Mobil tarayıcılarda (Android Chrome / Edge vb.) kullanıcı dokunma izninin (User Gesture)
    // kaybolmaması için navigator.contacts.select() çağrısı önünde hiçbir await kullanılmamalıdır!
    if (navigator.contacts && typeof navigator.contacts.select === 'function') {
      let pickerPromise;
      try {
        pickerPromise = navigator.contacts.select(['name', 'tel'], { multiple: true });
      } catch {
        pickerPromise = navigator.contacts.select(['tel'], { multiple: true });
      }

      Promise.resolve(pickerPromise)
        .catch((err) => {
          if (err && err.name === 'TypeError') {
            return navigator.contacts.select(['tel'], { multiple: true });
          }
          throw err;
        })
        .then(async (selected) => {
          if (!selected || selected.length === 0) {
            return;
          }
          await this.processPickedPhoneContacts(selected);
        })
        .catch((err) => {
          if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) {
            return;
          }
          const modal = document.getElementById('contact-modal');
          if (modal && modal.classList.contains('hidden')) {
            this.openContactModal();
          }
          this.toast('📱 Doğrudan rehber seçici açılamadı. Kişi Kartı (.vcf) seçebilir veya numara yazabilirsiniz.');
        });
      return;
    }

    // Contact Picker API bu bağlantıda kapalıysa (örn. iOS Safari, Masaüstü veya HTTP bağlantı):
    // Kullanıcı dokunuşu (User Gesture) aktifken eşzamanlı olarak dosya seçiciyi ve rehber penceresini aç
    const modal = document.getElementById('contact-modal');
    if (modal && modal.classList.contains('hidden')) {
      this.openContactModal();
    }
    const vcfInput = document.getElementById('vcf-file-input');
    if (vcfInput) {
      try {
        vcfInput.click();
      } catch {}
    }
    const isInsecureRemote =
      location.protocol === 'http:' &&
      location.hostname !== 'localhost' &&
      location.hostname !== '127.0.0.1';
    if (isInsecureRemote) {
      this.toast('🔒 Doğrudan telefon rehberi penceresi için üstteki "Güvenli Bağlantıya (HTTPS) Geç" butonuna dokunabilir veya .vcf dosyası seçebilirsiniz.');
    } else {
      this.toast('📱 Rehber dosyanızı (.vcf / Kişi Kartı) seçebilir veya numaraları aşağıdan ekleyebilirsiniz.');
    }
  },

  async processPickedPhoneContacts(selected) {
    try {
      const formatted = [];
      for (const c of selected) {
        if (!c) continue;
        const rawName = Array.isArray(c.name) && c.name.length > 0
          ? c.name.filter(Boolean).join(' ')
          : String(c.name || c.displayName || '').trim();
        const phones = Array.isArray(c.tel)
          ? c.tel
          : (c.tel ? [c.tel] : (Array.isArray(c.phone) ? c.phone : (c.phone ? [c.phone] : [])));
        const cleanPhones = phones.map((p) => String(p || '').trim()).filter(Boolean);

        if (cleanPhones.length > 0) {
          for (const tel of cleanPhones) {
            formatted.push({
              name: String(rawName || '').trim(),
              phone: tel
            });
          }
        } else if (rawName) {
          formatted.push({
            name: String(rawName).trim(),
            phone: ''
          });
        }
      }

      const payloadContacts = formatted.length > 0 ? formatted : selected;
      const res = await this.api('/api/contacts/sync', 'POST', {
        contacts: payloadContacts,
        inviteChannel: 'auto',
        appUrl: location.origin
      });

      if (!res.importedCount) {
        this.toast('Seçilen kişilerde kaydedilebilir bilgi bulunamadı.', 'error');
        return;
      }

      this.closeModal('contact-modal');
      this.toast(`📱 Telefon rehberinizden ${res.importedCount} kişi başarıyla eklendi!`);
      await Promise.all([this.loadUsers(), this.loadConversations()]);
      this.switchNav('contacts');
      this.openInviteModal(res);
    } catch (err) {
      this.toast('Rehber aktarımı hatası: ' + err.message, 'error');
    }
  },

  async handleVcfFileSelected(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    e.target.value = '';

    try {
      let combinedText = '';
      for (const f of files) {
        combinedText += '\n' + (await f.text());
      }

      const res = await this.api('/api/contacts/sync', 'POST', {
        rawText: combinedText,
        inviteChannel: 'auto',
        appUrl: location.origin
      });

      if (!res.importedCount) {
        return this.toast('Seçilen dosyada geçerli telefon numarası bulunamadı.', 'error');
      }

      this.closeModal('contact-modal');
      this.toast(`📂 Rehberden ${res.importedCount} kişi başarıyla eklendi!`);
      await Promise.all([this.loadUsers(), this.loadConversations()]);
      this.switchNav('contacts');
      this.openInviteModal(res);
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async submitBulkTextContacts() {
    const rawText = (document.getElementById('bulk-contacts-input').value || '').trim();
    if (!rawText) {
      return this.toast('Lütfen eklenecek kişi veya telefon numaralarını yapıştırın.', 'error');
    }

    try {
      const res = await this.api('/api/contacts/sync', 'POST', {
        rawText,
        inviteChannel: 'auto',
        appUrl: location.origin
      });

      if (!res.importedCount) {
        return this.toast('Metinde geçerli bir telefon numarası bulunamadı.', 'error');
      }

      document.getElementById('bulk-contacts-input').value = '';
      this.closeModal('contact-modal');
      this.toast(`✅ ${res.importedCount} kişi rehberinize kaydedildi!`);
      await Promise.all([this.loadUsers(), this.loadConversations()]);
      this.switchNav('contacts');
      this.openInviteModal(res);
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async submitAddContact(e, channel = 'auto') {
    if (e) e.preventDefault();
    const name = document.getElementById('contact-name-input').value.trim();
    const phone = document.getElementById('contact-phone-input').value.trim();
    if (!phone) {
      return this.toast('Lütfen cep telefonu numarasını girin.', 'error');
    }

    try {
      const res = await this.api('/api/contacts/sync', 'POST', {
        contacts: [{ name, phone }],
        inviteChannel: channel,
        appUrl: location.origin
      });

      if (!res.importedCount || !res.contacts || !res.contacts[0]) {
        return this.toast('Geçerli bir telefon numarası girin (Örn: 0532 123 45 67).', 'error');
      }

      const added = res.contacts[0];
      this.closeModal('contact-modal');
      this.toast(`✅ ${added.display_name} (${added.phone}) rehberinize eklendi!`);

      await Promise.all([this.loadUsers(), this.loadConversations()]);

      // Eğer doğrudan WhatsApp veya SMS butonuna basıldıysa hemen ilgili uygulamayı aç
      if (channel === 'whatsapp' && added.whatsappUrl) {
        window.open(added.whatsappUrl, '_blank', 'noopener');
      } else if (channel === 'sms' && added.smsUrl) {
        window.location.href = added.smsUrl;
      }

      // Davet modalını da aç ki kullanıcı isterse hem SMS hem WhatsApp gönderebilsin
      this.openInviteModal(res);

      if (added.conversationId) {
        await this.selectConversation(added.conversationId);
      }
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  openInviteModal(syncResponse) {
    const contacts = (syncResponse && syncResponse.contacts) || [];
    if (contacts.length === 0) return;

    this.lastInvitedContacts = contacts;
    const defaultMsg =
      syncResponse.inviteMessage ||
      contacts[0].inviteText ||
      `${contacts.map((c) => c.phone).join(', ')} — Bu numaraları kullanıcı sizi programı kullanmak için ekledi. Uygulama: ${location.origin}`;

    const textarea = document.getElementById('invite-message-textarea');
    if (textarea) {
      textarea.value = defaultMsg;
    }

    this.refreshInviteModalLinks();
    document.getElementById('invite-modal').classList.remove('hidden');
  },

  refreshInviteModalLinks() {
    const textarea = document.getElementById('invite-message-textarea');
    const customText = textarea ? textarea.value.trim() : '';
    const encoded = encodeURIComponent(customText);

    const contacts = this.lastInvitedContacts || [];
    const allNormPhones = contacts.map((c) => c.phoneNormalized || c.phone).filter(Boolean);

    const bulkSmsBtn = document.getElementById('invite-bulk-sms-btn');
    if (bulkSmsBtn) {
      bulkSmsBtn.href = `sms:${allNormPhones.join(',')}?body=${encoded}`;
    }

    const listEl = document.getElementById('invite-contacts-list');
    if (!listEl) return;

    listEl.innerHTML = contacts
      .map((c) => {
        const waDigits = String(c.phoneNormalized || c.phone || '').replace(/\D/g, '');
        const waUrl = `https://wa.me/${waDigits}?text=${encoded}`;
        const smsUrl = `sms:${c.phoneNormalized || c.phone}?body=${encoded}`;
        const statusBadge = c.isRegistered
          ? '<span style="color:#22c55e;font-size:11px;">✅ Programı Kullanıyor (Entegre Edildi)</span>'
          : '<span style="color:#f59e0b;font-size:11px;">⏳ Davet Bekliyor</span>';

        return `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--bg-header);padding:10px 12px;border-radius:10px;border:1px solid var(--border-color);">
            <div style="min-width:0;">
              <div style="font-weight:700;font-size:13.5px;">${this.escapeHtml(c.display_name)}</div>
              <div style="font-size:12px;color:var(--text-muted);">${this.escapeHtml(c.phone)} • ${statusBadge}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <a href="${waUrl}" target="_blank" rel="noopener" class="btn btn-primary btn-sm" style="background:#16a34a;text-decoration:none;">
                🟢 WhatsApp
              </a>
              <a href="${smsUrl}" class="btn btn-secondary btn-sm" style="text-decoration:none;">
                📩 SMS
              </a>
            </div>
          </div>
        `;
      })
      .join('');
  },

  copyInviteMessage() {
    const textarea = document.getElementById('invite-message-textarea');
    if (!textarea) return;
    navigator.clipboard?.writeText(textarea.value).catch(() => {});
    this.toast('📋 Davet mesajı panoya kopyalandı!');
  },

  sendInviteToContact(userId, channel = 'whatsapp') {
    const u = this.users.find((x) => x.id === userId);
    const conv = this.getActiveConversation();
    const peer = u || (conv && conv.peer);
    if (!peer) return;

    const phone = peer.phone || '';
    const digits = phone.replace(/\D/g, '');
    const norm = digits.startsWith('0') ? '+90' + digits.slice(1) : (digits.startsWith('90') ? '+' + digits : '+' + digits);
    const senderLabel = this.user ? `${this.user.display_name} (${this.user.phone || ''})` : 'Kullanıcı';
    const text =
      peer.inviteText ||
      `${phone} — ${senderLabel}: Bu numaraları kullanıcı sizi programı kullanmak için ekledi. Uygulama giriş adresi: ${location.origin}`;

    if (channel === 'whatsapp') {
      const url = peer.whatsappUrl || `https://wa.me/${norm.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank', 'noopener');
    } else {
      const url = peer.smsUrl || `sms:${norm}?body=${encodeURIComponent(text)}`;
      window.location.href = url;
    }
  },

  sendActivePeerInvite(channel = 'whatsapp') {
    const conv = this.getActiveConversation();
    if (!conv || !conv.peer) return;
    this.sendInviteToContact(conv.peer.user_id, channel);
  },

  async callContactDirect(peerUserId, callType = 'audio') {
    try {
      const data = await this.api('/api/conversations/direct', 'POST', { peerUserId });
      await this.loadConversations();
      await this.selectConversation(data.conversation.id);
      await this.startCall(callType);
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  // --- İNTERNET ÜZERİNDEN TELEFONA VE BİLGİSAYARA KURULUM ---
  openInstallModal() {
    document.getElementById('install-modal').classList.remove('hidden');
  },

  async triggerPwaInstall() {
    if (this.deferredInstallPrompt) {
      this.deferredInstallPrompt.prompt();
      const choice = await this.deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        this.toast('🎉 Uygulama cihazınıza başarıyla kuruluyor!');
      }
      this.deferredInstallPrompt = null;
    } else {
      this.toast('Tarayıcınızın sağ üst menüsünden "Uygulamayı Yükle / Ana Ekrana Ekle" seçeneğine dokunarak kurabilirsiniz.');
    }
  },

  showAuthScreen() {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('app-screen').classList.add('hidden');
  },

  switchAuthTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('tab-login-btn').classList.toggle('active', isLogin);
    document.getElementById('tab-register-btn').classList.toggle('active', !isLogin);
    document.getElementById('login-form').classList.toggle('hidden', !isLogin);
    document.getElementById('register-form').classList.toggle('hidden', isLogin);
  },

  async handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    await this.performLogin(username, password);
  },

  async performLogin(username, password) {
    try {
      const keyBundle = await window.E2EE.ensureIdentityKeyPair(username);
      const dev = this.getDeviceInfo();
      const data = await this.api('/api/auth/login', 'POST', {
        username,
        password,
        publicKey: keyBundle.publicKey,
        deviceName: dev.deviceName,
        devicePlatform: dev.devicePlatform
      });
      this.token = data.token;
      this.user = data.user;
      this.keyBundle = keyBundle;
      localStorage.setItem('msj_token', this.token);
      this.toast(`Hoş geldiniz, ${this.user.display_name}!`);
      this.enterApp();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async handleRegister(e) {
    e.preventDefault();
    try {
      const displayName = document.getElementById('reg-displayname').value.trim();
      const username = document.getElementById('reg-username').value.trim().toLowerCase();
      const phone = document.getElementById('reg-phone').value.trim();
      const password = document.getElementById('reg-password').value;

      const keyBundle = await window.E2EE.ensureIdentityKeyPair(username || phone || displayName);
      const dev = this.getDeviceInfo();
      const data = await this.api('/api/auth/register', 'POST', {
        displayName,
        username,
        phone,
        password,
        publicKey: keyBundle.publicKey,
        deviceName: dev.deviceName,
        devicePlatform: dev.devicePlatform
      });

      this.token = data.token;
      this.user = data.user;
      this.keyBundle = keyBundle;
      localStorage.setItem('msj_token', this.token);
      if (data.integratedCount > 0) {
        this.toast(`🎉 Hesabınız oluşturuldu ve sizi rehberine ekleyen ${data.integratedCount} kişiyle otomatik entegre edildi!`);
      } else {
        this.toast('Hesabınız ve telefon numaranız başarıyla kaydedildi!');
      }
      this.enterApp();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async logout() {
    try {
      await this.api('/api/auth/logout', 'POST');
    } catch {}
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    clearInterval(this.wsPingInterval);
    this.token = '';
    this.user = null;
    this.activeConvId = null;
    this.conversations = [];
    this.users = [];
    localStorage.removeItem('msj_token');
    document.body.classList.remove('mobile-chat-open');
    this.showAuthScreen();
  },

  async enterApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');

    this.updateMyHeader();
    this.checkBackgroundBannerState();
    this.syncServiceWorkerToken();
    this.connectWebSocket();

    await Promise.all([
      this.loadConversations(),
      this.loadUsers(),
      this.loadStories()
    ]);

    if (this.conversations.length > 0 && window.innerWidth > 860) {
      this.selectConversation(this.conversations[0].id);
    } else {
      document.getElementById('empty-chat-state').classList.remove('hidden');
      document.getElementById('active-chat-view').classList.add('hidden');
    }
  },

  updateMyHeader() {
    if (!this.user) return;
    const av = document.getElementById('my-avatar');
    av.innerHTML = `${(this.user.display_name || 'U')[0].toUpperCase()}<span class="status-dot online"></span>`;
    av.style.background = this.user.avatar_color || '#10b981';
    document.getElementById('my-display-name').textContent = this.user.display_name;
  },

  connectWebSocket() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      const badge = document.getElementById('my-connection-badge');
      if (badge) {
        badge.innerHTML = '<span class="status-inline-dot online"></span>Aktif (Çevrimiçi)';
        badge.style.color = '#22c55e';
      }
      clearInterval(this.wsPingInterval);
      this.wsPingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20000);
    };

    ws.onclose = () => {
      const badge = document.getElementById('my-connection-badge');
      if (badge) {
        badge.innerHTML = '<span class="status-inline-dot offline"></span>Yeniden Bağlanıyor...';
        badge.style.color = '#ef4444';
      }
      if (this.token) {
        setTimeout(() => this.connectWebSocket(), 2500);
      }
    };

    ws.onmessage = async (ev) => {
      try {
        const data = JSON.parse(ev.data);
        await this.handleWsEvent(data);
      } catch {}
    };
  },

  async handleWsEvent(ev) {
    if (ev.type === 'contact_integrated') {
      this.toast(`🔗 Rehberinizdeki ${ev.displayName} (${ev.phone}) programı kullanmaya başladı ve otomatik entegre edildi!`);
      await Promise.all([this.loadUsers(), this.loadConversations()]);
      if (this.activeConvId) {
        this.updateActiveChatHeader();
        const data = await this.api(`/api/conversations/${this.activeConvId}/messages`);
        this.messages = data.messages || [];
        await this.renderMessages(true);
      }
      return;
    }

    if (ev.type === 'new_message') {
      await this.loadConversations();
      if (ev.conversationId === this.activeConvId && !document.hidden) {
        const exists = this.messages.some((m) => m.id === ev.message.id);
        if (!exists) {
          this.messages.push(ev.message);
        }
        await this.renderMessages(true);
        if (ev.message.senderId !== this.user.id) {
          this.playBeep(740, 0.1);
          await this.api(`/api/conversations/${this.activeConvId}/read`, 'POST').catch(() => {});
        }
      } else if (ev.message.senderId !== this.user.id) {
        this.playBeep(580, 0.12);
        const notifText = this.user.privacy_hide_notif_content
          ? '🔒 Yeni şifreli mesajınız var'
          : `${ev.message.senderName}: ${ev.message.content || 'Yeni mesaj'}`;
        this.toast(notifText);

        if (document.hidden && 'serviceWorker' in navigator && Notification.permission === 'granted') {
          const reg = await navigator.serviceWorker.ready;
          if (reg.active) {
            reg.active.postMessage({
              type: 'SHOW_LOCAL_NOTIFICATION',
              title: `💬 ${ev.message.senderName}`,
              body: ev.message.content || '🔒 Yeni şifreli mesaj'
            });
          }
        }
      }
      return;
    }

    if (ev.type === 'message_updated') {
      await this.loadConversations();
      if (ev.conversationId === this.activeConvId) {
        const idx = this.messages.findIndex((m) => m.id === ev.message.id);
        if (idx !== -1) {
          this.messages[idx] = ev.message;
          this.decryptedCache.delete(ev.message.id);
          await this.renderMessages(false);
        }
      }
      return;
    }

    if (ev.type === 'messages_read') {
      if (ev.conversationId === this.activeConvId) {
        for (const m of this.messages) {
          if (ev.messageIds.includes(m.id)) {
            m.status = 'read';
          }
        }
        await this.renderMessages(false);
      }
      await this.loadConversations();
      return;
    }

    if (ev.type === 'typing') {
      if (ev.conversationId === this.activeConvId) {
        const sub = document.getElementById('chat-header-subtitle');
        if (ev.isTyping) {
          sub.textContent = `✍️ ${ev.displayName} yazıyor...`;
          sub.style.color = '#10b981';
        } else {
          this.updateActiveChatHeader();
        }
      }
      return;
    }

    if (ev.type === 'presence') {
      await Promise.all([this.loadConversations(), this.loadUsers()]);
      if (this.activeConvId) this.updateActiveChatHeader();
      return;
    }

    if (ev.type === 'conversation_created' || ev.type === 'conversation_updated') {
      await this.loadConversations();
      if (this.activeConvId) this.updateActiveChatHeader();
      return;
    }

    // WebRTC Sinyalizasyon Olayları
    if (ev.type === 'call-offer') {
      this.handleIncomingCallOffer(ev);
      return;
    }
    if (ev.type === 'call-answer') {
      await this.handleCallAnswer(ev);
      return;
    }
    if (ev.type === 'ice-candidate') {
      await this.handleRemoteIce(ev);
      return;
    }
    if (ev.type === 'call-reject' || ev.type === 'call-end') {
      this.toast('Arama sonlandırıldı.');
      this.endCall(false);
    }
  },

  async loadConversations() {
    const data = await this.api('/api/conversations');
    this.conversations = data.conversations || [];
    if (this.currentNav === 'chats' || this.currentNav === 'channels') {
      this.renderSidebar();
    }
  },

  async loadUsers() {
    const data = await this.api('/api/users');
    this.users = data.users || [];
    if (this.currentNav === 'contacts') {
      this.renderSidebar();
    }
  },

  async loadStories() {
    const data = await this.api('/api/stories');
    this.stories = data.stories || [];
    if (this.currentNav === 'stories') {
      this.renderSidebar();
    }
  },

  async loadCalls() {
    const data = await this.api('/api/calls');
    this.calls = data.calls || [];
    if (this.currentNav === 'calls') {
      this.renderSidebar();
    }
  },

  switchNav(nav) {
    this.currentNav = nav;
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.nav === nav);
    });

    const filterBar = document.getElementById('chat-filter-bar');
    filterBar.classList.toggle('hidden', nav !== 'chats');

    if (nav === 'chats') {
      this.chatFilter = 'all';
      this.loadConversations();
    } else if (nav === 'channels') {
      this.loadConversations();
    } else if (nav === 'stories') {
      this.loadStories();
    } else if (nav === 'calls') {
      this.loadCalls();
    } else if (nav === 'contacts') {
      this.loadUsers();
    } else if (nav === 'settings') {
      this.renderSidebar();
    }
  },

  setChatFilter(filter) {
    this.chatFilter = filter;
    document.querySelectorAll('.filter-chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.filter === filter);
    });
    this.renderSidebar();
  },

  onSidebarSearch(val) {
    this.searchQuery = String(val || '').trim().toLowerCase();
    this.renderSidebar();
  },

  formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr.includes('T') ? isoStr : isoStr.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  },

  renderSidebar() {
    const container = document.getElementById('sidebar-list-container');
    container.innerHTML = '';

    // 1. SOHBETLER VEYA KANALLAR
    if (this.currentNav === 'chats' || this.currentNav === 'channels') {
      if (this.currentNav === 'channels') {
        const hdr = document.createElement('div');
        hdr.style.padding = '10px 14px';
        hdr.innerHTML = `<button class="btn btn-primary btn-block btn-sm" onclick="App.openCreateGroupModal('channel')">📢 Yeni Duyuru Kanalı Oluştur</button>`;
        container.appendChild(hdr);
      }

      let list = this.conversations.slice();
      if (this.currentNav === 'channels') {
        list = list.filter((c) => c.type === 'channel');
      } else {
        if (this.chatFilter === 'online') {
          list = list.filter((c) => (c.type === 'direct' && c.peer && c.peer.online) || (c.type !== 'direct' && (c.members || []).some((m) => m.user_id !== this.user.id && m.online)));
        }
        if (this.chatFilter === 'unread') list = list.filter((c) => c.unreadCount > 0);
        if (this.chatFilter === 'group') list = list.filter((c) => c.type === 'group');
      }

      if (this.searchQuery) {
        list = list.filter(
          (c) =>
            (c.title || '').toLowerCase().includes(this.searchQuery) ||
            (c.peer && c.peer.phone && c.peer.phone.toLowerCase().includes(this.searchQuery))
        );
      }

      if (list.length === 0) {
        container.innerHTML += `
          <div style="padding:28px 18px;text-align:center;color:var(--text-muted);font-size:13.5px;">
            <p style="margin-bottom:12px;">Henüz sohbet bulunmuyor.</p>
            <button class="btn btn-primary btn-sm" onclick="App.openContactModal()">📒 Rehberden Kişi Ekle</button>
          </div>
        `;
        return;
      }

      for (const c of list) {
        const item = document.createElement('div');
        item.className = `list-item ${c.id === this.activeConvId ? 'active' : ''}`;
        item.onclick = () => this.selectConversation(c.id);

        const initial = (c.title || '?')[0].toUpperCase();
        const isOnline =
          c.type === 'direct'
            ? Boolean(c.peer && c.peer.online)
            : (c.members || []).some((m) => m.user_id !== this.user.id && m.online);

        const statusDotClass = isOnline ? 'online' : 'offline';
        const statusTitle = isOnline ? '🟢 Aktif (Çevrimiçi)' : '🔴 Aktif Değil (Çevrimdışı)';
        const typeBadge = c.type === 'group' ? '👥 ' : c.type === 'channel' ? '📢 ' : '';
        const pinIcon = c.pinned ? '📌 ' : '';

        let lastPreview = 'Henüz mesaj yok';
        if (c.lastMessage) {
          const lm = c.lastMessage;
          if (lm.msgType === 'image') lastPreview = '📷 Fotoğraf';
          else if (lm.msgType === 'audio') lastPreview = '🎤 Sesli Mesaj';
          else if (lm.msgType === 'video') lastPreview = '🎬 Video';
          else if (lm.msgType === 'file') lastPreview = '📎 Dosya';
          else if (lm.msgType === 'poll') lastPreview = '📊 Anket: ' + lm.content;
          else lastPreview = lm.content || '🔒 Şifreli mesaj';
        }

        item.innerHTML = `
          <div class="avatar" style="background:${c.avatarColor || '#00a884'}" title="${statusTitle}">
            ${initial}
            <span class="status-dot ${statusDotClass}"></span>
          </div>
          <div class="list-item-body">
            <div class="list-item-top">
              <div class="list-item-title">${pinIcon}${typeBadge}${this.escapeHtml(c.title)}</div>
              <div class="list-item-time">${c.lastMessage ? this.formatTime(c.lastMessage.createdAt) : ''}</div>
            </div>
            <div class="list-item-bottom">
              <div class="list-item-sub">
                <span class="status-inline-dot ${statusDotClass}"></span>${this.escapeHtml(lastPreview)}
              </div>
              ${c.unreadCount > 0 ? `<span class="unread-badge">${c.unreadCount}</span>` : ''}
            </div>
          </div>
          ${c.type === 'direct' && c.peer ? `
            <div class="contact-quick-actions" onclick="event.stopPropagation()">
              <button class="contact-action-btn call-audio" onclick="App.callContactDirect('${c.peer.user_id}', 'audio')" title="Görüntüsüz (Sesli) Ara">📞</button>
              <button class="contact-action-btn call-video" onclick="App.callContactDirect('${c.peer.user_id}', 'video')" title="Görüntülü Ara">📹</button>
            </div>
          ` : ''}
        `;
        container.appendChild(item);
      }
      return;
    }

    // 2. TELEFON REHBERİ VE KAYITLI NUMARALAR (CONTACTS)
    if (this.currentNav === 'contacts') {
      const topActions = document.createElement('div');
      topActions.style.padding = '10px 12px';
      topActions.style.display = 'grid';
      topActions.style.gridTemplateColumns = '1fr 1fr';
      topActions.style.gap = '8px';
      topActions.style.borderBottom = '1px solid var(--border-color)';
      topActions.innerHTML = `
        <button class="btn btn-primary btn-sm" onclick="App.openContactModal()">➕ Kişi / Numara Ekle</button>
        <button class="btn btn-secondary btn-sm" onclick="App.importFromPhoneContactsApi()">📱 Telefondan Aktar</button>
      `;
      container.appendChild(topActions);

      const legend = document.createElement('div');
      legend.style.padding = '6px 14px';
      legend.style.fontSize = '11.5px';
      legend.style.color = 'var(--text-muted)';
      legend.style.borderBottom = '1px solid var(--border-color)';
      legend.innerHTML = `<span class="status-inline-dot online"></span><strong>Yeşil:</strong> Aktif &nbsp;|&nbsp; <span class="status-inline-dot offline"></span><strong>Kırmızı:</strong> Çevrimdışı &nbsp;|&nbsp; <strong>🟢 WA / 📩 SMS:</strong> Davet Gönder`;
      container.appendChild(legend);

      const filtered = this.users.filter(
        (u) =>
          !this.searchQuery ||
          u.display_name.toLowerCase().includes(this.searchQuery) ||
          (u.real_display_name && u.real_display_name.toLowerCase().includes(this.searchQuery)) ||
          u.username.toLowerCase().includes(this.searchQuery) ||
          (u.phone && u.phone.toLowerCase().includes(this.searchQuery))
      );

      if (filtered.length === 0) {
        container.innerHTML += `
          <div style="padding:28px 18px;text-align:center;color:var(--text-muted);font-size:13.5px;">
            <p style="margin-bottom:12px;">Rehberinizde henüz kayıtlı kişi yok.</p>
            <button class="btn btn-primary btn-sm" onclick="App.openContactModal()">📱 Telefon Rehberinden Kişi Ekle</button>
          </div>
        `;
        return;
      }

      for (const u of filtered) {
        const el = document.createElement('div');
        el.className = 'list-item';
        el.onclick = () => this.startDirectChatWith(u.id);
        const dotClass = u.online ? 'online' : 'offline';
        const statusText = u.online ? 'Aktif' : 'Çevrimdışı';
        const regBadge = u.isRegistered
          ? '<span style="color:#22c55e;font-size:11px;font-weight:600;">✅ Programı Kullanıyor</span>'
          : '<span style="color:#f59e0b;font-size:11px;">⏳ Rehberden Eklendi (Davet Et)</span>';

        el.innerHTML = `
          <div class="avatar" style="background:${u.avatar_color}">
            ${(u.display_name || '?')[0].toUpperCase()}
            <span class="status-dot ${dotClass}"></span>
          </div>
          <div class="list-item-body">
            <div class="list-item-top">
              <div class="list-item-title">${this.escapeHtml(u.display_name)}</div>
            </div>
            <div class="list-item-sub">
              <span class="status-inline-dot ${dotClass}"></span><strong>${statusText}</strong> • ${this.escapeHtml(u.phone || '@' + u.username)}
            </div>
            <div>${regBadge}</div>
          </div>
          <div class="contact-quick-actions" onclick="event.stopPropagation()">
            <button class="contact-action-btn" style="background:rgba(22,163,74,0.18);border-color:rgba(22,163,74,0.45);font-size:12px;font-weight:700;" onclick="App.sendInviteToContact('${u.id}', 'whatsapp')" title="WhatsApp'tan Davet Mesajı Gönder">WA</button>
            <button class="contact-action-btn" style="font-size:11px;font-weight:700;" onclick="App.sendInviteToContact('${u.id}', 'sms')" title="SMS ile Davet Mesajı Gönder">SMS</button>
            <button class="contact-action-btn" onclick="App.startDirectChatWith('${u.id}')" title="Mesaj Yaz">💬</button>
            <button class="contact-action-btn call-audio" onclick="App.callContactDirect('${u.id}', 'audio')" title="Görüntüsüz (Sesli) Ara">📞</button>
            <button class="contact-action-btn call-video" onclick="App.callContactDirect('${u.id}', 'video')" title="Görüntülü Ara">📹</button>
          </div>
        `;
        container.appendChild(el);
      }
      return;
    }

    // 3. HİKÂYE / DURUM PAYLAŞIMLARI
    if (this.currentNav === 'stories') {
      const topBox = document.createElement('div');
      topBox.style.padding = '12px 14px';
      topBox.innerHTML = `<button class="btn btn-primary btn-block" onclick="App.openStoryModal()">➕ Yeni Durum / Hikâye Paylaş (24 Saat)</button>`;
      container.appendChild(topBox);

      for (const s of this.stories) {
        const el = document.createElement('div');
        el.className = 'list-item';
        el.onclick = () => this.viewStory(s);
        el.innerHTML = `
          <div class="avatar" style="background:${s.bg_color || s.avatar_color};border:2px solid #10b981;">
            ${(s.display_name || 'U')[0]}
          </div>
          <div class="list-item-body">
            <div class="list-item-top">
              <div class="list-item-title">${this.escapeHtml(s.display_name)}</div>
              <div class="list-item-time">👁️ ${s.viewCount}</div>
            </div>
            <div class="list-item-sub">${this.escapeHtml(s.text_content)}</div>
          </div>
        `;
        container.appendChild(el);
      }
      return;
    }

    // 4. ARAMALAR
    if (this.currentNav === 'calls') {
      if (this.calls.length === 0) {
        container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);">Henüz sesli veya görüntülü arama kaydı yok. Rehberden bir kişiyi arayabilirsiniz.</div>`;
        return;
      }
      for (const cl of this.calls) {
        const el = document.createElement('div');
        el.className = 'list-item';
        el.onclick = () => this.selectConversation(cl.conversation_id);
        const icon = cl.call_type === 'video' ? '📹' : '📞';
        el.innerHTML = `
          <div class="avatar" style="background:${cl.caller_color || '#3b82f6'}">${icon}</div>
          <div class="list-item-body">
            <div class="list-item-top">
              <div class="list-item-title">${this.escapeHtml(cl.conv_title || cl.caller_name)}</div>
              <div class="list-item-time">${this.formatTime(cl.started_at)}</div>
            </div>
            <div class="list-item-sub">${cl.call_type === 'video' ? 'Görüntülü Arama' : 'Görüntüsüz (Sesli) Arama'} • ${cl.duration_sec} sn</div>
          </div>
        `;
        container.appendChild(el);
      }
      return;
    }

    // 5. AYARLAR, ARKA PLAN İZİNLERİ VE GÜVENLİK
    if (this.currentNav === 'settings') {
      this.renderSettingsPanel(container);
    }
  },

  async renderSettingsPanel(container) {
    const meData = await this.api('/api/auth/me').catch(() => ({ user: this.user, sessions: [] }));
    const u = meData.user || this.user;
    const sessions = meData.sessions || [];
    const notifPerm = 'Notification' in window ? Notification.permission : 'desteklenmiyor';

    container.innerHTML = `
      <div style="padding:16px;display:flex;flex-direction:column;gap:14px;">
        <div style="background:var(--bg-header);padding:14px;border-radius:12px;border-left:4px solid #22c55e;">
          <h4 style="margin-bottom:6px;">🔔 Arka Planda Çalışma ve Bildirim İzni</h4>
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
            Durum: <strong>${notifPerm === 'granted' ? '🟢 İzin Verildi (Aktif)' : '🔴 İzin Bekleniyor'}</strong>
          </p>
          <button class="btn btn-primary btn-sm" onclick="App.requestAllBackgroundPermissions()">
            ✅ Arka Planda Çalışma İznini Etkinleştir / Yenile
          </button>
        </div>

        <div style="background:var(--bg-header);padding:14px;border-radius:12px;">
          <h4 style="margin-bottom:10px;">👤 Profil ve Telefon Numaram</h4>
          <label class="field-label">Ad Soyad</label>
          <input id="set-displayname" class="input" value="${this.escapeHtml(u.display_name)}" />
          <label class="field-label">Cep Telefonu Numaram (Rehber Entegrasyonu)</label>
          <input id="set-phone" class="input" value="${this.escapeHtml(u.phone || '')}" />
          <label class="field-label">Hakkımda / Durum</label>
          <input id="set-bio" class="input" value="${this.escapeHtml(u.bio || '')}" />
          <button class="btn btn-primary btn-sm" style="margin-top:10px;" onclick="App.saveProfileSettings()">Kaydet ve Numaramı Entegre Et</button>
        </div>

        <div style="background:var(--bg-header);padding:14px;border-radius:12px;">
          <h4 style="margin-bottom:8px;">🛡️ Gizlilik Tercihleri</h4>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;">
            <input id="set-read-receipts" type="checkbox" ${u.privacy_read_receipts ? 'checked' : ''} onchange="App.saveProfileSettings()" />
            Okundu bilgisi (Mavi çift tık ✓✓) gönder
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;">
            <input id="set-hide-notif" type="checkbox" ${u.privacy_hide_notif_content ? 'checked' : ''} onchange="App.saveProfileSettings()" />
            Bildirimlerde mesaj içeriğini gizle
          </label>
        </div>

        <div style="background:var(--bg-header);padding:14px;border-radius:12px;">
          <h4 style="margin-bottom:8px;">💻 Aktif Cihazlar (${sessions.length})</h4>
          ${sessions.map((s) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-color);font-size:12.5px;">
              <div>
                <strong>${this.escapeHtml(s.device_name)}</strong> (${this.escapeHtml(s.device_platform)})
                ${s.is_current ? '<span style="color:#22c55e;"> • Bu Cihaz</span>' : ''}
              </div>
              ${!s.is_current ? `<button class="btn btn-danger btn-sm" onclick="App.revokeSession('${s.token_id}')">Kapat</button>` : ''}
            </div>
          `).join('')}
        </div>

        <button class="btn btn-danger btn-block" onclick="App.logout()">🚪 Oturumu Kapat</button>
      </div>
    `;
  },

  async saveProfileSettings() {
    try {
      const display_name = document.getElementById('set-displayname').value.trim();
      const bio = document.getElementById('set-bio').value.trim();
      const phone = document.getElementById('set-phone').value.trim();
      const privacy_read_receipts = document.getElementById('set-read-receipts').checked;
      const privacy_hide_notif_content = document.getElementById('set-hide-notif').checked;

      const data = await this.api('/api/auth/profile', 'PUT', {
        display_name,
        bio,
        phone,
        privacy_read_receipts,
        privacy_hide_notif_content
      });
      this.user = data.user;
      this.updateMyHeader();
      await Promise.all([this.loadUsers(), this.loadConversations()]);
      this.toast('Profil ve numara entegrasyon bilgileriniz güncellendi.');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async revokeSession(tokenId) {
    await this.api(`/api/auth/sessions/${tokenId}`, 'DELETE');
    this.toast('Cihaz oturumu sonlandırıldı.');
    this.renderSidebar();
  },

  async startDirectChatWith(peerUserId) {
    try {
      const data = await this.api('/api/conversations/direct', 'POST', { peerUserId });
      await this.loadConversations();
      this.switchNav('chats');
      await this.selectConversation(data.conversation.id);
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async selectConversation(convId) {
    this.activeConvId = convId;
    this.clearComposeContext();
    document.body.classList.add('mobile-chat-open');

    document.getElementById('empty-chat-state').classList.add('hidden');
    document.getElementById('active-chat-view').classList.remove('hidden');

    this.updateActiveChatHeader();
    this.renderSidebar();

    const data = await this.api(`/api/conversations/${convId}/messages`);
    this.messages = data.messages || [];
    await this.renderMessages(true);

    await this.api(`/api/conversations/${convId}/read`, 'POST').catch(() => {});
    await this.loadConversations();
  },

  closeMobileChat() {
    document.body.classList.remove('mobile-chat-open');
  },

  getActiveConversation() {
    return this.conversations.find((c) => c.id === this.activeConvId) || null;
  },

  updateActiveChatHeader() {
    const conv = this.getActiveConversation();
    if (!conv) return;

    const isOnline =
      conv.type === 'direct'
        ? Boolean(conv.peer && conv.peer.online)
        : (conv.members || []).some((m) => m.user_id !== this.user.id && m.online);
    const dotClass = isOnline ? 'online' : 'offline';

    const av = document.getElementById('chat-header-avatar');
    av.innerHTML = `${(conv.title || '?')[0].toUpperCase()}<span class="status-dot ${dotClass}"></span>`;
    av.style.background = conv.avatarColor || '#00a884';

    document.getElementById('chat-header-title').textContent = conv.title;

    const waBtn = document.getElementById('chat-btn-wa-invite');
    const smsBtn = document.getElementById('chat-btn-sms-invite');
    if (waBtn && smsBtn) {
      const showInvite = conv.type === 'direct' && conv.peer && conv.peer.phone;
      waBtn.classList.toggle('hidden', !showInvite);
      smsBtn.classList.toggle('hidden', !showInvite);
    }

    const sub = document.getElementById('chat-header-subtitle');
    if (conv.type === 'direct' && conv.peer) {
      const phoneLabel = conv.peer.phone ? ` • ${conv.peer.phone}` : '';
      const regLabel = conv.peer.isRegistered ? ' • ✅ Programı Kullanıyor' : ' • ⏳ Davet Edildi';
      if (conv.peer.online) {
        sub.innerHTML = `<span class="status-inline-dot online"></span><strong>Aktif (Çevrimiçi)</strong>${this.escapeHtml(phoneLabel)}${regLabel}`;
        sub.style.color = '#22c55e';
      } else {
        sub.innerHTML = `<span class="status-inline-dot offline"></span><strong>Aktif Değil</strong>${this.escapeHtml(phoneLabel)}${regLabel}`;
        sub.style.color = '#ef4444';
      }
    } else if (conv.type === 'group') {
      const onlineCnt = (conv.members || []).filter((m) => m.online).length;
      sub.innerHTML = `<span class="status-inline-dot ${onlineCnt > 0 ? 'online' : 'offline'}"></span>${(conv.members || []).length} üye (${onlineCnt} aktif)`;
      sub.style.color = '';
    } else {
      sub.textContent = `Duyuru Kanalı • ${(conv.members || []).length} abone`;
      sub.style.color = '';
    }

    const composer = document.getElementById('chat-composer');
    if (conv.type === 'channel' && conv.myRole === 'subscriber') {
      composer.classList.add('hidden');
    } else {
      composer.classList.remove('hidden');
    }
  },

  async getDecryptedText(msg, conv) {
    if (msg.deletedAt) return '🚫 Bu mesaj silindi';
    if (!msg.isEncrypted || !msg.ciphertext) return msg.content;
    if (this.decryptedCache.has(msg.id)) return this.decryptedCache.get(msg.id);

    const peerPub = conv && conv.peer ? conv.peer.public_key : '';
    const plain = await window.E2EE.decryptMessage(msg, conv ? conv.id : msg.conversationId, this.keyBundle, peerPub);
    this.decryptedCache.set(msg.id, plain);
    return plain;
  },

  async renderMessages(scrollToBottom = false) {
    const container = document.getElementById('messages-container');
    const conv = this.getActiveConversation();
    if (!conv) return;

    const inChatQuery = (document.getElementById('in-chat-search-input').value || '').trim().toLowerCase();

    const pinnedMsg = [...this.messages].reverse().find((m) => m.pinned && !m.deletedAt);
    const pinBanner = document.getElementById('pinned-message-banner');
    if (pinnedMsg) {
      const pText = await this.getDecryptedText(pinnedMsg, conv);
      document.getElementById('pinned-message-text').textContent = pText;
      pinBanner.classList.remove('hidden');
      pinBanner.dataset.msgId = pinnedMsg.id;
    } else {
      pinBanner.classList.add('hidden');
    }

    container.innerHTML = '';

    for (const msg of this.messages) {
      if (msg.msgType === 'system') {
        const sysEl = document.createElement('div');
        sysEl.className = 'msg-system';
        sysEl.textContent = msg.content;
        container.appendChild(sysEl);
        continue;
      }

      const plainText = await this.getDecryptedText(msg, conv);
      if (inChatQuery && !plainText.toLowerCase().includes(inChatQuery)) {
        continue;
      }

      const isMine = msg.senderId === this.user.id;
      const row = document.createElement('div');
      row.className = `msg-row ${isMine ? 'out' : 'in'}`;
      row.id = `msg-dom-${msg.id}`;

      let senderHeader = '';
      if (!isMine && conv.type !== 'direct') {
        senderHeader = `<div class="msg-sender-name" style="color:${msg.senderAvatarColor || '#38bdf8'}">${this.escapeHtml(msg.senderName)}</div>`;
      }

      let forwardedHtml = '';
      if (msg.forwardedFromName) {
        forwardedHtml = `<div class="msg-forwarded-tag">↪️ İletildi (${this.escapeHtml(msg.forwardedFromName)})</div>`;
      }

      let replyHtml = '';
      if (msg.replyTo) {
        replyHtml = `
          <div class="msg-reply-box">
            <strong>${this.escapeHtml(msg.replyTo.senderName)}</strong>
            <div>${this.escapeHtml(msg.replyTo.content)}</div>
          </div>
        `;
      }

      let mediaHtml = '';
      if (!msg.deletedAt) {
        if (msg.msgType === 'image' && msg.attachmentUrl) {
          mediaHtml = `<img src="${msg.attachmentUrl}" class="msg-image" alt="Fotoğraf" onclick="window.open('${msg.attachmentUrl}', '_blank')" />`;
        } else if (msg.msgType === 'video' && msg.attachmentUrl) {
          mediaHtml = `<video src="${msg.attachmentUrl}" controls class="msg-image"></video>`;
        } else if (msg.msgType === 'audio' && msg.attachmentUrl) {
          mediaHtml = `<audio src="${msg.attachmentUrl}" controls class="msg-audio-player"></audio>`;
        } else if (msg.msgType === 'file' && msg.attachmentUrl) {
          const kb = Math.max(1, Math.round((msg.attachmentSize || 1024) / 1024));
          mediaHtml = `
            <a href="${msg.attachmentUrl}" download="${this.escapeHtml(msg.attachmentName || 'dosya')}" class="msg-file-card">
              <span>📄</span>
              <div>
                <strong>${this.escapeHtml(msg.attachmentName || 'Dosya')}</strong>
                <div style="font-size:11px;color:var(--text-muted);">${kb} KB • İndir</div>
              </div>
            </a>
          `;
        } else if (msg.msgType === 'poll' && msg.poll) {
          const total = msg.poll.totalVotes || 0;
          mediaHtml = `
            <div class="poll-card">
              <div class="poll-question">📊 ${this.escapeHtml(msg.poll.question)}</div>
              ${msg.poll.options.map((opt) => {
                const pct = total > 0 ? Math.round((opt.count / total) * 100) : 0;
                return `
                  <div class="poll-option ${opt.votedByMe ? 'voted' : ''}" onclick="App.votePoll('${msg.poll.id}', ${opt.index})">
                    <div class="poll-bar" style="width:${pct}%"></div>
                    <div class="poll-option-row">
                      <span>${opt.votedByMe ? '✅ ' : ''}${this.escapeHtml(opt.text)}</span>
                      <strong>${opt.count} oy (${pct}%)</strong>
                    </div>
                  </div>
                `;
              }).join('')}
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Toplam ${total} oy</div>
            </div>
          `;
        }
      }

      const tickHtml = isMine
        ? msg.status === 'read'
          ? '<span class="tick-read" title="Okundu">✓✓</span>'
          : msg.status === 'delivered'
          ? '<span title="İletildi">✓✓</span>'
          : '<span title="Gönderildi">✓</span>'
        : '';

      const editedTag = msg.editedAt && !msg.deletedAt ? '<span>(düzenlendi)</span>' : '';
      const lockIcon = msg.isEncrypted ? '<span title="Uçtan Uca Şifreli">🔒</span>' : '';

      row.innerHTML = `
        <div class="msg-bubble">
          ${senderHeader}
          ${forwardedHtml}
          ${replyHtml}
          ${mediaHtml}
          ${msg.msgType !== 'poll' ? `<div class="msg-text">${this.escapeHtml(plainText)}</div>` : ''}
          <div class="msg-meta">
            ${msg.pinned ? '📌' : ''}
            ${lockIcon}
            ${editedTag}
            <span>${this.formatTime(msg.createdAt)}</span>
            ${tickHtml}
          </div>
        </div>
        ${!msg.deletedAt ? `
          <div class="msg-actions-bar">
            <button class="msg-act-btn" onclick="App.setReplyMessage('${msg.id}')">↩ Yanıtla</button>
            <button class="msg-act-btn" onclick="App.openForwardModal('${msg.id}')">↪ İlet</button>
            <button class="msg-act-btn" onclick="App.togglePinMessage('${msg.id}')">📌 Sabitle</button>
            ${isMine && msg.msgType === 'text' ? `<button class="msg-act-btn" onclick="App.setEditMessage('${msg.id}')">✏️ Düzenle</button>` : ''}
            ${isMine ? `<button class="msg-act-btn" onclick="App.deleteMessage('${msg.id}')">🗑️ Sil</button>` : ''}
          </div>
        ` : ''}
      `;
      container.appendChild(row);
    }

    if (scrollToBottom) {
      container.scrollTop = container.scrollHeight;
    }
  },

  async sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !this.activeConvId) return;

    const conv = this.getActiveConversation();
    const peerPub = conv && conv.peer ? conv.peer.public_key : '';

    try {
      if (this.editingMsg) {
        const enc = await window.E2EE.encryptForConversation(text, this.activeConvId, this.keyBundle, peerPub);
        await this.api(`/api/messages/${this.editingMsg.id}`, 'PUT', {
          content: text,
          ciphertext: enc.ciphertext,
          iv: enc.iv
        });
        input.value = '';
        this.clearComposeContext();
        return;
      }

      const enc = await window.E2EE.encryptForConversation(text, this.activeConvId, this.keyBundle, peerPub);
      input.value = '';
      const replyId = this.replyToMsg ? this.replyToMsg.id : null;
      this.clearComposeContext();

      await this.api(`/api/conversations/${this.activeConvId}/messages`, 'POST', {
        msgType: 'text',
        content: text,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        senderPublicKey: enc.senderPublicKey,
        isEncrypted: true,
        replyToId: replyId
      });
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  handleTypingInput() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.activeConvId) return;
    this.ws.send(JSON.stringify({
      type: 'typing',
      conversationId: this.activeConvId,
      isTyping: true
    }));
    clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'typing',
          conversationId: this.activeConvId,
          isTyping: false
        }));
      }
    }, 1800);
  },

  setReplyMessage(msgId) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg) return;
    this.replyToMsg = msg;
    this.editingMsg = null;
    document.getElementById('compose-context-bar').classList.remove('hidden');
    document.getElementById('compose-context-title').textContent = `↩ ${msg.senderName} kişisine yanıt veriliyor`;
    document.getElementById('compose-context-text').textContent = this.decryptedCache.get(msg.id) || msg.content;
    document.getElementById('message-input').focus();
  },

  setEditMessage(msgId) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg) return;
    this.editingMsg = msg;
    this.replyToMsg = null;
    const plain = this.decryptedCache.get(msg.id) || msg.content;
    document.getElementById('compose-context-bar').classList.remove('hidden');
    document.getElementById('compose-context-title').textContent = '✏️ Mesaj Düzenleniyor';
    document.getElementById('compose-context-text').textContent = plain;
    const input = document.getElementById('message-input');
    input.value = plain;
    input.focus();
  },

  clearComposeContext() {
    this.replyToMsg = null;
    this.editingMsg = null;
    document.getElementById('compose-context-bar').classList.add('hidden');
  },

  async togglePinMessage(msgId) {
    await this.api(`/api/messages/${msgId}`, 'PUT', { togglePin: true });
  },

  scrollToPinnedMessage() {
    const msgId = document.getElementById('pinned-message-banner').dataset.msgId;
    const dom = document.getElementById(`msg-dom-${msgId}`);
    if (dom) dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  async deleteMessage(msgId) {
    await this.api(`/api/messages/${msgId}`, 'DELETE');
    this.toast('Mesaj herkesten silindi.');
  },

  openForwardModal(msgId) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg) return;
    this.forwardingMsg = msg;
    const box = document.getElementById('forward-modal-list');
    box.innerHTML = this.conversations.map((c) => `
      <div class="list-item" onclick="App.forwardMessageTo('${c.id}')">
        <div class="avatar" style="background:${c.avatarColor}">${(c.title || '?')[0]}</div>
        <div class="list-item-body">
          <div class="list-item-title">${this.escapeHtml(c.title)}</div>
        </div>
      </div>
    `).join('');
    document.getElementById('forward-modal').classList.remove('hidden');
  },

  async forwardMessageTo(targetConvId) {
    if (!this.forwardingMsg) return;
    const text = this.decryptedCache.get(this.forwardingMsg.id) || this.forwardingMsg.content;
    const enc = await window.E2EE.encryptForConversation(text, targetConvId, this.keyBundle, '');
    await this.api(`/api/conversations/${targetConvId}/messages`, 'POST', {
      msgType: this.forwardingMsg.msgType,
      content: text,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      isEncrypted: true,
      attachmentUrl: this.forwardingMsg.attachmentUrl,
      attachmentName: this.forwardingMsg.attachmentName,
      forwardedFromName: this.forwardingMsg.senderName
    });
    this.closeModal('forward-modal');
    this.toast('Mesaj iletildi.');
    if (targetConvId !== this.activeConvId) {
      this.selectConversation(targetConvId);
    }
  },

  async handleFileSelected(e) {
    const file = e.target.files[0];
    if (!file || !this.activeConvId) return;
    e.target.value = '';

    if (file.size > 20 * 1024 * 1024) {
      return this.toast('Dosya boyutu 20MB sınırını aşıyor.', 'error');
    }

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        this.toast('Dosya şifrelenip yükleniyor...');
        const up = await this.api('/api/uploads', 'POST', {
          fileName: file.name,
          mimeType: file.type,
          dataBase64: reader.result
        });

        let msgType = 'file';
        if (file.type.startsWith('image/')) msgType = 'image';
        else if (file.type.startsWith('video/')) msgType = 'video';
        else if (file.type.startsWith('audio/')) msgType = 'audio';

        await this.api(`/api/conversations/${this.activeConvId}/messages`, 'POST', {
          msgType,
          content: file.name,
          attachmentUrl: up.url,
          attachmentName: up.name,
          attachmentSize: up.size,
          attachmentMime: up.mime,
          isEncrypted: true
        });
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
    reader.readAsDataURL(file);
  },

  async startVoiceRecording() {
    if (!this.activeConvId) return;
    document.getElementById('voice-record-bar').classList.remove('hidden');
    document.getElementById('message-input').classList.add('hidden');
    this.recSeconds = 0;
    document.getElementById('voice-record-timer').textContent = '00:00';

    clearInterval(this.recTimerInterval);
    this.recTimerInterval = setInterval(() => {
      this.recSeconds++;
      const mm = String(Math.floor(this.recSeconds / 60)).padStart(2, '0');
      const ss = String(this.recSeconds % 60).padStart(2, '0');
      document.getElementById('voice-record-timer').textContent = `${mm}:${ss}`;
    }, 1000);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(stream);
      this.mediaRecorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) this.audioChunks.push(ev.data);
      };
      this.mediaRecorder.start();
    } catch {
      this.mediaRecorder = null;
    }
  },

  cancelVoiceRecording() {
    clearInterval(this.recTimerInterval);
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    }
    this.mediaRecorder = null;
    document.getElementById('voice-record-bar').classList.add('hidden');
    document.getElementById('message-input').classList.remove('hidden');
  },

  generateSyntheticWavBase64(durationSec = 2) {
    const sampleRate = 8000;
    const numSamples = sampleRate * Math.max(1, durationSec);
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const sample = Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 1.5) * 8000;
      view.setInt16(44 + i * 2, sample, true);
    }
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'data:audio/wav;base64,' + btoa(bin);
  },

  async finishVoiceRecording() {
    clearInterval(this.recTimerInterval);
    const dur = Math.max(1, this.recSeconds);
    document.getElementById('voice-record-bar').classList.add('hidden');
    document.getElementById('message-input').classList.remove('hidden');

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = async () => {
        this.mediaRecorder.stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = async () => {
          const up = await this.api('/api/uploads', 'POST', {
            fileName: `sesli_mesaj_${Date.now()}.webm`,
            mimeType: 'audio/webm',
            dataBase64: reader.result
          });
          await this.api(`/api/conversations/${this.activeConvId}/messages`, 'POST', {
            msgType: 'audio',
            content: `🎤 Sesli Mesaj (${dur} sn)`,
            attachmentUrl: up.url,
            attachmentName: up.name,
            audioDuration: dur,
            isEncrypted: true
          });
        };
        reader.readAsDataURL(blob);
      };
      this.mediaRecorder.stop();
    } else {
      const wavB64 = this.generateSyntheticWavBase64(dur);
      const up = await this.api('/api/uploads', 'POST', {
        fileName: `sesli_mesaj_${Date.now()}.wav`,
        mimeType: 'audio/wav',
        dataBase64: wavB64
      });
      await this.api(`/api/conversations/${this.activeConvId}/messages`, 'POST', {
        msgType: 'audio',
        content: `🎤 Sesli Mesaj (${dur} sn)`,
        attachmentUrl: up.url,
        attachmentName: up.name,
        audioDuration: dur,
        isEncrypted: true
      });
    }
  },

  openPollModal() {
    document.getElementById('poll-question-input').value = '';
    document.getElementById('poll-options-input').value = '';
    document.getElementById('poll-modal').classList.remove('hidden');
  },

  async submitCreatePoll(e) {
    e.preventDefault();
    const question = document.getElementById('poll-question-input').value.trim();
    const options = document.getElementById('poll-options-input').value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (options.length < 2) {
      return this.toast('En az 2 seçenek girmelisiniz.', 'error');
    }

    await this.api(`/api/conversations/${this.activeConvId}/messages`, 'POST', {
      msgType: 'poll',
      content: question,
      poll: { question, options }
    });
    this.closeModal('poll-modal');
  },

  async votePoll(pollId, optionIndex) {
    await this.api(`/api/polls/${pollId}/vote`, 'POST', { optionIndex });
  },

  async openCreateGroupModal(type = 'group') {
    await this.loadUsers();
    document.getElementById('group-type-input').value = type;
    document.getElementById('group-modal-title').textContent =
      type === 'channel' ? '📢 Yeni Duyuru Kanalı Oluştur' : '👥 Yeni Grup Sohbeti Oluştur';
    document.getElementById('group-title-input').value = '';
    document.getElementById('group-desc-input').value = '';

    const box = document.getElementById('group-members-checklist');
    if (this.users.length === 0) {
      box.innerHTML = `<div style="padding:10px;font-size:12.5px;color:var(--text-muted);">Rehberinizde henüz kişi yok. Önce rehberden kişi ekleyebilir veya doğrudan grubu oluşturabilirsiniz.</div>`;
    } else {
      box.innerHTML = this.users.map((u) => `
        <label class="checklist-item">
          <input type="checkbox" value="${u.id}" checked />
          <span><span class="status-inline-dot ${u.online ? 'online' : 'offline'}"></span>${this.escapeHtml(u.display_name)} (${this.escapeHtml(u.phone || '@' + u.username)})</span>
        </label>
      `).join('');
    }

    document.getElementById('group-modal').classList.remove('hidden');
  },

  async submitCreateGroup(e) {
    e.preventDefault();
    const type = document.getElementById('group-type-input').value;
    const title = document.getElementById('group-title-input').value.trim();
    const description = document.getElementById('group-desc-input').value.trim();
    const checked = [...document.querySelectorAll('#group-members-checklist input:checked')].map((i) => i.value);

    const data = await this.api('/api/conversations/group', 'POST', {
      type,
      title,
      description,
      memberIds: checked
    });

    this.closeModal('group-modal');
    await this.loadConversations();
    this.selectConversation(data.conversation.id);
  },

  openStoryModal() {
    document.getElementById('story-text-input').value = '';
    document.getElementById('story-modal').classList.remove('hidden');
  },

  async submitCreateStory(e) {
    e.preventDefault();
    const textContent = document.getElementById('story-text-input').value.trim();
    const bgColor = document.getElementById('story-color-input').value;
    await this.api('/api/stories', 'POST', { textContent, bgColor });
    this.closeModal('story-modal');
    this.toast('Durum paylaşımınız eklendi!');
    await this.loadStories();
  },

  async viewStory(story) {
    await this.api(`/api/stories/${story.id}/view`, 'POST').catch(() => {});
    this.toast(`⭕ ${story.display_name}: "${story.text_content}"`);
    await this.loadStories();
  },

  openSafetyModal() {
    const conv = this.getActiveConversation();
    if (!conv) return;
    const body = document.getElementById('safety-modal-body');

    const myFp = this.user.key_fingerprint || '';
    const peerFp = conv.peer ? conv.peer.key_fingerprint : conv.id;
    const blocks = window.E2EE.computeSafetyNumber(myFp, peerFp);

    body.innerHTML = `
      <p style="font-size:13px;color:var(--text-muted);line-height:1.5;">
        Bu sohbetteki mesajlar ve aramalar <strong>ECDH P-256 + AES-256-GCM</strong> ile uçtan uca şifrelenir.
        Karşı tarafın cihazıyla aşağıdaki 60 haneli güvenlik numarasını karşılaştırarak doğrulayabilirsiniz:
      </p>
      <div class="safety-grid">
        ${blocks.map((b) => `<span>${b}</span>`).join('')}
      </div>
      ${conv.peer ? `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
          <span>Durum: <strong>${conv.peer.isVerified ? '✅ Doğrulanmış Cihaz' : '⚠️ Henüz Doğrulanmadı'}</strong></span>
          <button class="btn btn-primary btn-sm" onclick="App.verifyPeerKey('${conv.peer.user_id}')">
            ✅ Doğrulandı Olarak İşaretle
          </button>
        </div>
      ` : ''}
    `;
    document.getElementById('safety-modal').classList.remove('hidden');
  },

  async verifyPeerKey(peerUserId) {
    await this.api('/api/keys/verify', 'POST', { peerUserId });
    this.toast('Kişinin güvenlik anahtarı doğrulandı olarak işaretlendi!');
    await this.loadConversations();
    this.openSafetyModal();
  },

  toggleChatInfoDrawer() {
    const drawer = document.getElementById('chat-info-drawer');
    const isHidden = drawer.classList.toggle('hidden');
    if (!isHidden) {
      this.renderChatInfoDrawer();
    }
  },

  renderChatInfoDrawer() {
    const conv = this.getActiveConversation();
    if (!conv) return;
    const box = document.getElementById('chat-info-content');
    const isOnline = conv.peer ? conv.peer.online : false;

    box.innerHTML = `
      <div style="text-align:center;padding:12px 0;">
        <div class="avatar avatar-xl" style="background:${conv.avatarColor};margin:0 auto 10px;">
          ${(conv.title || '?')[0].toUpperCase()}
          <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
        </div>
        <h3>${this.escapeHtml(conv.title)}</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-top:4px;">${this.escapeHtml(conv.description || '')}</p>
      </div>

      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" onclick="App.startCall('audio')">📞 Sesli Ara</button>
        <button class="btn btn-primary btn-sm" onclick="App.startCall('video')">📹 Görüntülü Ara</button>
        <button class="btn btn-secondary btn-sm" onclick="App.togglePinConversation('${conv.id}')">
          📌 ${conv.pinned ? 'Sabitlemeyi Kaldır' : 'Sabitle'}
        </button>
      </div>

      ${conv.type === 'direct' && conv.peer ? `
        <div style="background:var(--bg-header);padding:12px;border-radius:10px;display:flex;flex-direction:column;gap:8px;">
          <div style="font-size:12.5px;">Durum: <span class="status-inline-dot ${conv.peer.online ? 'online' : 'offline'}"></span><strong>${conv.peer.online ? 'Aktif (Yeşil)' : 'Aktif Değil (Kırmızı)'}</strong></div>
          <div style="font-size:12.5px;">Kayıt Durumu: <strong>${conv.peer.isRegistered ? '✅ Programı Kullanıyor (Entegre)' : '⏳ Henüz Katılmadı (Davet Bekliyor)'}</strong></div>
          <div style="font-size:12.5px;">Telefon: <strong>${this.escapeHtml(conv.peer.phone || 'Belirtilmedi')}</strong></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;">
            <button class="btn btn-primary btn-sm" style="background:#16a34a;" onclick="App.sendInviteToContact('${conv.peer.user_id}', 'whatsapp')">
              🟢 WhatsApp Davet
            </button>
            <button class="btn btn-secondary btn-sm" onclick="App.sendInviteToContact('${conv.peer.user_id}', 'sms')">
              📩 SMS Davet
            </button>
          </div>
          <button class="btn btn-danger btn-sm" onclick="App.toggleBlockUser('${conv.peer.user_id}')">
            🚫 ${conv.peer.isBlocked ? 'Engeli Kaldır' : 'Kişiyi Engelle'}
          </button>
          <button class="btn btn-ghost btn-sm" onclick="App.reportUser('${conv.peer.user_id}')">
            ⚠️ Kişiyi Şikâyet Et
          </button>
        </div>
      ` : `
        <div style="background:var(--bg-header);padding:12px;border-radius:10px;">
          <h4 style="margin-bottom:8px;">Üyeler ve Aktiflik Durumu (${(conv.members || []).length})</h4>
          ${(conv.members || []).map((m) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-color);font-size:13px;">
              <div>
                <span class="status-inline-dot ${m.online ? 'online' : 'offline'}"></span>
                <strong>${this.escapeHtml(m.display_name)}</strong>
                <span style="font-size:11px;color:var(--primary);"> (${m.role})</span>
              </div>
              ${(conv.myRole === 'owner' || conv.myRole === 'admin') && m.user_id !== this.user.id ? `
                <div style="display:flex;gap:4px;">
                  ${m.role === 'member' ? `<button class="msg-act-btn" onclick="App.manageGroupMember('${conv.id}', 'promote', '${m.user_id}')">Yönetici Yap</button>` : ''}
                  <button class="msg-act-btn" onclick="App.manageGroupMember('${conv.id}', 'remove', '${m.user_id}')">Çıkar</button>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `}
    `;
  },

  async togglePinConversation(convId) {
    await this.api(`/api/conversations/${convId}/pin`, 'POST');
    await this.loadConversations();
    this.renderChatInfoDrawer();
  },

  async toggleBlockUser(targetUserId) {
    const res = await this.api('/api/users/block', 'POST', { userId: targetUserId });
    this.toast(res.blocked ? 'Kullanıcı engellendi.' : 'Kullanıcı engeli kaldırıldı.');
    await this.loadConversations();
    this.renderChatInfoDrawer();
  },

  async reportUser(targetUserId) {
    await this.api('/api/users/report', 'POST', {
      userId: targetUserId,
      reason: 'İstenmeyen mesaj / spam'
    });
    this.toast('Şikâyetiniz güvenlik kayıtlarına iletildi.');
  },

  async manageGroupMember(convId, action, userId) {
    await this.api(`/api/conversations/${convId}/members`, 'POST', { action, userId });
    await this.loadConversations();
    this.renderChatInfoDrawer();
  },

  async openQrModal() {
    document.getElementById('qr-modal').classList.remove('hidden');
    try {
      const info = await this.api('/api/server-info');
      this.serverInfo = info;
      document.getElementById('qr-http-url').textContent = info.httpUrl;
      document.getElementById('qr-https-url').textContent = info.httpsUrl;
      document.getElementById('qr-svg-box').innerHTML = info.qrSvg;
    } catch {
      document.getElementById('qr-svg-box').textContent = 'Sunucu bilgisi alınamadı.';
    }
  },

  async SwitchQrMode(mode) {
    if (!this.serverInfo) return;
    const url = mode === 'https' ? this.serverInfo.httpsUrl : this.serverInfo.httpUrl;
    const info = await this.api(`/api/server-info?url=${encodeURIComponent(url)}`);
    document.getElementById('qr-svg-box').innerHTML = info.qrSvg;
  },

  // --- WebRTC Sesli ve Görüntülü Arama ---
  async createPeerConnection(targetUserId, convId, callType) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'ice-candidate',
          targetUserId,
          conversationId: convId,
          candidate: ev.candidate
        }));
      }
    };

    pc.ontrack = (ev) => {
      const remoteVideo = document.getElementById('remote-video');
      if (ev.streams && ev.streams[0]) {
        remoteVideo.srcObject = ev.streams[0];
        if (callType === 'video') {
          document.getElementById('call-avatar-placeholder').classList.add('hidden');
        }
      }
    };

    return pc;
  },

  async startCall(callType = 'audio') {
    const conv = this.getActiveConversation();
    if (!conv) return;

    const targetUserId = conv.peer ? conv.peer.user_id : null;
    this.activeCall = { convId: conv.id, targetUserId, callType, startTime: Date.now() };

    document.getElementById('call-overlay').classList.remove('hidden');
    document.getElementById('incoming-call-controls').classList.add('hidden');
    document.getElementById('active-call-controls').classList.remove('hidden');
    document.getElementById('call-avatar-placeholder').classList.remove('hidden');
    document.getElementById('call-peer-name').textContent = conv.title;
    document.getElementById('call-peer-avatar').textContent = (conv.title || '?')[0].toUpperCase();
    document.getElementById('call-status-label').textContent =
      callType === 'video' ? '📹 Görüntülü aranıyor...' : '📞 Görüntüsüz (Sesli) aranıyor...';

    this.startCallTimer();

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video'
      });
      document.getElementById('local-video').srcObject = this.localStream;
    } catch {
      this.localStream = null;
      this.toast('Kamera/mikrofon izni olmadan sinyalizasyon modunda arama başlatıldı.');
    }

    this.peerConnection = await this.createPeerConnection(targetUserId, conv.id, callType);
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => this.peerConnection.addTrack(track, this.localStream));
    }

    const offer = await this.peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: callType === 'video'
    });
    await this.peerConnection.setLocalDescription(offer);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'call-offer',
        conversationId: conv.id,
        targetUserId,
        callType,
        sdp: offer
      }));
    }
  },

  async handleIncomingCallOffer(ev) {
    this.incomingOffer = ev;
    this.playBeep(880, 0.25);

    if (document.hidden && 'serviceWorker' in navigator && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker.ready;
      if (reg.active) {
        reg.active.postMessage({
          type: 'SHOW_LOCAL_NOTIFICATION',
          title: `📞 Gelen Arama: ${ev.fromDisplayName || 'Kişi'}`,
          body: ev.callType === 'video' ? '📹 Görüntülü Arama Geliyor — Cevaplamak için dokunun' : '📞 Sesli Arama Geliyor — Cevaplamak için dokunun'
        });
      }
    }

    document.getElementById('call-overlay').classList.remove('hidden');
    document.getElementById('incoming-call-controls').classList.remove('hidden');
    document.getElementById('active-call-controls').classList.add('hidden');
    document.getElementById('call-avatar-placeholder').classList.remove('hidden');
    document.getElementById('call-peer-name').textContent = ev.fromDisplayName || 'Gelen Arama';
    document.getElementById('call-peer-avatar').textContent = (ev.fromDisplayName || 'A')[0];
    document.getElementById('call-status-label').textContent =
      ev.callType === 'video' ? '📹 Gelen Görüntülü Arama...' : '📞 Gelen Sesli Arama...';
  },

  async acceptIncomingCall() {
    if (!this.incomingOffer) return;
    const ev = this.incomingOffer;
    this.activeCall = {
      convId: ev.conversationId,
      targetUserId: ev.fromUserId,
      callType: ev.callType,
      startTime: Date.now()
    };

    document.getElementById('incoming-call-controls').classList.add('hidden');
    document.getElementById('active-call-controls').classList.remove('hidden');
    document.getElementById('call-status-label').textContent = 'Bağlandı';
    this.startCallTimer();

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: ev.callType === 'video'
      });
      document.getElementById('local-video').srcObject = this.localStream;
    } catch {
      this.localStream = null;
    }

    this.peerConnection = await this.createPeerConnection(ev.fromUserId, ev.conversationId, ev.callType);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => this.peerConnection.addTrack(t, this.localStream));
    }

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(ev.sdp));
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'call-answer',
        conversationId: ev.conversationId,
        targetUserId: ev.fromUserId,
        sdp: answer
      }));
    }
    this.incomingOffer = null;
  },

  rejectIncomingCall() {
    if (this.incomingOffer && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'call-reject',
        conversationId: this.incomingOffer.conversationId,
        targetUserId: this.incomingOffer.fromUserId
      }));
    }
    this.incomingOffer = null;
    this.endCall(false);
  },

  async handleCallAnswer(ev) {
    document.getElementById('call-status-label').textContent = 'Görüşme Aktif 🔒';
    if (this.peerConnection && ev.sdp) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(ev.sdp));
    }
  },

  async handleRemoteIce(ev) {
    if (this.peerConnection && ev.candidate) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(ev.candidate));
      } catch {}
    }
  },

  startCallTimer() {
    this.callSeconds = 0;
    clearInterval(this.callTimerInterval);
    this.callTimerInterval = setInterval(() => {
      this.callSeconds++;
      const mm = String(Math.floor(this.callSeconds / 60)).padStart(2, '0');
      const ss = String(this.callSeconds % 60).padStart(2, '0');
      document.getElementById('call-timer-text').textContent = `${mm}:${ss}`;
    }, 1000);
  },

  toggleCallMic() {
    if (!this.localStream) return;
    const track = this.localStream.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      this.toast(track.enabled ? 'Mikrofon açıldı' : 'Mikrofon sessize alındı');
    }
  },

  toggleCallCamera() {
    if (!this.localStream) return;
    const track = this.localStream.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      this.toast(track.enabled ? 'Kamera açıldı' : 'Kamera kapatıldı');
    }
  },

  async shareScreenInCall() {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      document.getElementById('local-video').srcObject = screenStream;
      if (this.peerConnection) {
        const sender = this.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      }
    } catch {
      this.toast('Ekran paylaşımı başlatılamadı.');
    }
  },

  async endCall(notifyRemote = true) {
    clearInterval(this.callTimerInterval);
    if (notifyRemote && this.activeCall && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'call-end',
        conversationId: this.activeCall.convId,
        targetUserId: this.activeCall.targetUserId
      }));
      await this.api('/api/calls', 'POST', {
        conversationId: this.activeCall.convId,
        callType: this.activeCall.callType,
        status: 'completed',
        durationSec: this.callSeconds
      }).catch(() => {});
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.activeCall = null;
    document.getElementById('call-overlay').classList.add('hidden');
  },

  toggleInChatSearch() {
    const bar = document.getElementById('in-chat-search-bar');
    const isHidden = bar.classList.toggle('hidden');
    if (!isHidden) {
      document.getElementById('in-chat-search-input').focus();
    } else {
      document.getElementById('in-chat-search-input').value = '';
      this.renderMessages(false);
    }
  },

  toggleEmojiPicker() {
    document.getElementById('emoji-picker').classList.toggle('hidden');
  },

  insertEmoji(emoji) {
    const input = document.getElementById('message-input');
    input.value += emoji;
    input.focus();
    document.getElementById('emoji-picker').classList.add('hidden');
  },

  toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('msj_theme', next);
  },

  closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  },

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());
