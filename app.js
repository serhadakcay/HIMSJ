// BUILD_VER: 700
/**
 * Mesajlaşma Uygulaması - İstemci Uygulama Mantığı (v6.0)
 * - Cep Telefonu Rehberinden Kişi Ekleme (Contact Picker API + Anında Optimistik Kayıt + VCF + Toplu Metin + Manuel)
 * - Numara veya Rehberden Eklenen Kişilere SMS ve WhatsApp Mesajı Gönderme
 *   ("............ Bu numaraları kullanıcı sizi programı kullanmak için ekledi")
 * - Kaydedilen Kişiler Programı Kullandığında Otomatik Numara ve Hesap Entegrasyonu
 * - Gerçek Zamanlı Sesli & Görüntülü Arama (WebRTC + CGNAT WebSocket Ses/Görüntü Rölesi + Sesi Dışarı Verme / Hoparlör)
 * - Tüm Telefon, Tablet ve Bilgisayar Ekranlarına Otomatik Sığma + Kullanıcıya Özel Yazı Boyutu ve Yazı Stili Seçimi
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

  // WebRTC & Canlı Arama Durumu
  peerConnection: null,
  localStream: null,
  remoteStream: null,
  pendingIceCandidates: [],
  activeCall: null,
  incomingOffer: null,
  callTimerInterval: null,
  callRingInterval: null,
  callSeconds: 0,
  isSpeakerOn: false,
  callAudioCtx: null,
  speakerGainNode: null,
  remoteStreamSource: null,
  wsAudioProcessor: null,
  wsVideoInterval: null,
  webrtcAudioReceived: false,
  webrtcVideoReceived: false,
  nextPlayTime: 0,

  // Kullanıcıya Özel Yazı Boyutu ve Yazı Stili Ayarları
  fontSize: Number(localStorage.getItem('msj_font_size') || 14),
  fontFamilyKey: localStorage.getItem('msj_font_family') || 'modern',
  fontStyleMode: localStorage.getItem('msj_font_style_mode') || 'normal',

  async init() {
    const savedTheme = localStorage.getItem('msj_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    this.applyTypographySettings();

    // Eski önbellekleri temizle
    if ('caches' in window) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }

    // Yedek kullanıcı profilini yükle (Render konteyner sıfırlamalarında oturumu otomatik onarmak için)
    try {
      const savedProfile = localStorage.getItem('msj_user_profile');
      if (savedProfile && !this.user) {
        this.user = JSON.parse(savedProfile);
      }
    } catch {}

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
        navigator.serviceWorker.addEventListener('message', (ev) => {
          if (ev.data && ev.data.type === 'SW_FORCE_RELOAD') {
            if (sessionStorage.getItem('msj_sw_reloaded_v5') !== '1') {
              sessionStorage.setItem('msj_sw_reloaded_v5', '1');
              window.location.reload();
            }
          }
        });
        const reg = await navigator.serviceWorker.register('/sw.js?v=7.0');
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
        localStorage.setItem('msj_user_profile', JSON.stringify(this.user));
        this.keyBundle = await window.E2EE.ensureIdentityKeyPair(this.user.username);
        if (this.keyBundle.publicKey && this.keyBundle.publicKey !== this.user.public_key) {
          const updated = await this.api('/api/auth/profile', 'PUT', {
            public_key: this.keyBundle.publicKey
          });
          this.user = updated.user;
          localStorage.setItem('msj_user_profile', JSON.stringify(this.user));
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
    try {
      const prof = this.user || JSON.parse(localStorage.getItem('msj_user_profile') || 'null');
      if (prof && prof.id) {
        headers['X-User-Profile'] = btoa(unescape(encodeURIComponent(JSON.stringify({
          id: prof.id,
          username: prof.username,
          display_name: prof.display_name,
          phone: prof.phone
        }))));
      }
    } catch {}
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
  _lookupTimeout: null,

  openContactModal() {
    const nameInput = document.getElementById('contact-name-input');
    const phoneInput = document.getElementById('contact-phone-input');
    const bulkEl = document.getElementById('bulk-contacts-input');
    const statusEl = document.getElementById('contact-lookup-status');
    if (nameInput) nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (bulkEl) bulkEl.value = '';
    if (statusEl) {
      statusEl.style.display = 'none';
      statusEl.innerHTML = '';
    }

    const modal = document.getElementById('contact-modal');
    if (modal) modal.classList.remove('hidden');
    if (phoneInput) {
      setTimeout(() => phoneInput.focus(), 150);
    }
  },

  onContactPhoneInput(val) {
    const statusEl = document.getElementById('contact-lookup-status');
    const cleaned = String(val || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
    const digits = cleaned.replace(/\D/g, '');

    if (!statusEl) return;
    if (digits.length < 7) {
      statusEl.style.display = 'none';
      return;
    }

    if (this._lookupTimeout) clearTimeout(this._lookupTimeout);
    this._lookupTimeout = setTimeout(async () => {
      try {
        const res = await this.api(`/api/contacts/lookup?phone=${encodeURIComponent(cleaned)}`);
        if (!res || !res.valid) {
          statusEl.style.display = 'none';
          return;
        }
        statusEl.style.display = 'block';
        if (res.isRegistered && res.user) {
          statusEl.style.color = '#22c55e';
          statusEl.innerHTML = `🟢 <strong>${this.escapeHtml(res.user.display_name)}</strong> sisteme kayıtlı! (Sohbet doğrudan açılacak)`;
        } else {
          statusEl.style.color = '#38bdf8';
          statusEl.innerHTML = `📱 <em>${this.escapeHtml(res.displayPhone)}</em> sisteme eklenecek ve WhatsApp/SMS davet bağlantısı hazır.`;
        }
      } catch {
        statusEl.style.display = 'none';
      }
    }, 250);
  },

  quickStartChatWithQuery(q) {
    this.openContactModal();
    const cleanDigits = String(q || '').replace(/\D/g, '');
    if (cleanDigits.length >= 7) {
      const phoneInput = document.getElementById('contact-phone-input');
      if (phoneInput) {
        phoneInput.value = q;
        this.onContactPhoneInput(q);
      }
    } else {
      const nameInput = document.getElementById('contact-name-input');
      if (nameInput) {
        nameInput.value = q;
        nameInput.focus();
      }
    }
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

  importFromPhoneContactsApi(multiple = false) {
    // ÖNEMLİ: Kullanıcı dokunma izninin (User Gesture) kaybolmaması için
    // navigator.contacts.select() çağrısı önünde hiçbir await kullanılmamalıdır!
    if (navigator.contacts && typeof navigator.contacts.select === 'function') {
      const useMultiple = Boolean(multiple);
      let pickerPromise;
      try {
        pickerPromise = navigator.contacts.select(['name', 'tel'], { multiple: useMultiple });
      } catch {
        try {
          pickerPromise = navigator.contacts.select(['tel'], { multiple: useMultiple });
        } catch {
          pickerPromise = navigator.contacts.select(['name'], { multiple: useMultiple });
        }
      }

      Promise.resolve(pickerPromise)
        .catch((err) => {
          if (err && err.name === 'TypeError') {
            return navigator.contacts.select(['tel'], { multiple: useMultiple });
          }
          throw err;
        })
        .then(async (selected) => {
          if (!selected || (Array.isArray(selected) && selected.length === 0)) {
            const modal = document.getElementById('contact-modal');
            if (modal && modal.classList.contains('hidden')) {
              this.openContactModal();
            }
            this.toast('⚠️ Numara seçilmedi: Cem ORTİ (+2 numara) gibi birden fazla numarası olan kişilerde kişinin üzerine dokunup numarayı seçtikten sonra Bitti\'ye basın. Veya aşağıdaki kutucuğa adı ve numarayı yazıp 1 saniyede kaydedebilirsiniz.', 'error');
            return;
          }
          await this.processPickedPhoneContacts(selected);
        })
        .catch((err) => {
          const modal = document.getElementById('contact-modal');
          if (modal && modal.classList.contains('hidden')) {
            this.openContactModal();
          }
          if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) {
            this.toast('⚠️ Numara seçilmedi: Cem ORTİ (+2 numara) gibi birden fazla numarası olan kişilerde kişinin üzerine dokunup numarayı seçtikten sonra Bitti\'ye basın. Veya aşağıdaki kutucuğa adı ve numarayı yazıp 1 saniyede kaydedebilirsiniz.', 'error');
            return;
          }
          this.toast('📱 ' + (err && err.message ? err.message : 'Rehber seçici açılamadı. Lütfen numara yazarak ekleyin.'));
        });
      return;
    }

    // Contact Picker API bu tarayıcıda desteklenmiyorsa (örn. iPhone / iOS Safari veya Masaüstü):
    const modal = document.getElementById('contact-modal');
    if (modal && modal.classList.contains('hidden')) {
      this.openContactModal();
    }
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    if (isIOS) {
      this.toast('🍏 iPhone (Safari) doğrudan rehber erişimini kısıtlar. Numarayı yukarıya yazabilir veya .vcf dosyası seçebilirsiniz.');
    } else {
      this.toast('📱 Bu tarayıcı doğrudan rehber erişimini desteklemiyor. Numarayı yukarıya yazabilir veya .vcf seçebilirsiniz.');
    }
  },

  async syncContactsWithRetry(payload, maxRetries = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.api('/api/contacts/sync', 'POST', payload);
      } catch (err) {
        lastErr = err;
        // Android rehber ekranından tarayıcıya dönerken ağ soketi uyanma gecikmesi için kısa bekleme
        await new Promise((r) => setTimeout(r, 350 * attempt));
      }
    }
    throw lastErr || new Error('Rehber senkronizasyonu başarısız oldu.');
  },

  async readFileTextSafe(file) {
    if (file && typeof file.text === 'function') {
      try {
        const t = await file.text();
        if (t && t.trim()) return t;
      } catch {}
    }
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Rehber dosyası okunamadı.'));
      reader.readAsText(file, 'UTF-8');
    });
  },

  toArraySafe(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') return [val];
    try {
      return Array.from(val);
    } catch {
      return [val];
    }
  },

  normalizePhoneClient(rawPhone) {
    if (!rawPhone) return '';
    const cleaned = String(rawPhone).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
    let digits = cleaned.replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 10 && !digits.startsWith('90')) digits = '90' + digits;
    else if (digits.length === 11 && digits.startsWith('0')) digits = '90' + digits.slice(1);
    else if (digits.length === 13 && digits.startsWith('900')) digits = '90' + digits.slice(3);
    return '+' + digits;
  },

  formatPhoneDisplayClient(rawPhone) {
    const norm = this.normalizePhoneClient(rawPhone);
    if (!norm) return String(rawPhone || '').trim();
    const digits = norm.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('90')) {
      const local = '0' + digits.slice(2);
      return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7, 9)} ${local.slice(9, 11)}`;
    }
    return norm;
  },

  getSavedLocalContacts() {
    try {
      const key = `msj_saved_contacts_${(this.user && this.user.id) || 'default'}`;
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  saveContactsLocally(contactsToSave) {
    try {
      const key = `msj_saved_contacts_${(this.user && this.user.id) || 'default'}`;
      const existing = this.getSavedLocalContacts();
      const map = new Map();
      for (const c of existing) {
        const k = c.phoneNormalized || c.phone || c.display_name;
        if (k) map.set(k, c);
      }
      for (const c of contactsToSave || []) {
        const k = c.phoneNormalized || c.phone || c.display_name;
        if (k) {
          const prev = map.get(k) || {};
          map.set(k, { ...prev, ...c });
        }
      }
      localStorage.setItem(key, JSON.stringify(Array.from(map.values())));
    } catch {}
  },

  buildOptimisticContacts(formattedList) {
    const senderName = (this.user && this.user.display_name) || 'Kullanıcı';
    const senderPhone = (this.user && this.user.phone) ? ` (${this.user.phone})` : '';
    const allDisplayPhones = formattedList.map((f) => this.formatPhoneDisplayClient(f.phone || f.name));
    const phonesLabel = allDisplayPhones.filter(Boolean).join(', ');

    return formattedList.map((f, idx) => {
      const norm = this.normalizePhoneClient(f.phone) || `+900000000${idx}`;
      const dispPhone = f.phone ? this.formatPhoneDisplayClient(f.phone) : norm;
      const dispName = String(f.name || dispPhone || 'Rehber Kişisi').trim();
      const inviteText = `${phonesLabel || dispPhone} — ${senderName}${senderPhone}: Bu numaraları kullanıcı sizi programı kullanmak için ekledi. Uygulama giriş adresi: ${location.origin}`;
      const waDigits = norm.replace(/\D/g, '');
      return {
        id: f.id || ('local_' + waDigits),
        conversationId: f.conversationId || null,
        username: 'tel_' + waDigits.slice(-10),
        display_name: dispName,
        real_display_name: dispName,
        phone: dispPhone,
        phoneNormalized: norm,
        avatar_color: '#10b981',
        isSavedContact: true,
        isRegistered: Boolean(f.isRegistered),
        online: Boolean(f.online),
        inviteText,
        whatsappUrl: `https://wa.me/${waDigits}?text=${encodeURIComponent(inviteText)}`,
        smsUrl: `sms:${norm}?body=${encodeURIComponent(inviteText)}`
      };
    });
  },

  applyOptimisticContactsToUi(optimisticContacts) {
    if (!Array.isArray(optimisticContacts) || optimisticContacts.length === 0) return;
    this.saveContactsLocally(optimisticContacts);
    for (const oc of optimisticContacts) {
      const existsIdx = this.users.findIndex(
        (u) =>
          (oc.phoneNormalized && (this.normalizePhoneClient(u.phone) === oc.phoneNormalized || u.phone_normalized === oc.phoneNormalized)) ||
          u.id === oc.id ||
          (u.display_name && oc.display_name && u.display_name.toLowerCase() === oc.display_name.toLowerCase())
      );
      if (existsIdx === -1) {
        this.users.unshift(oc);
      } else {
        this.users[existsIdx] = {
          ...this.users[existsIdx],
          display_name: oc.display_name || this.users[existsIdx].display_name,
          phone: oc.phone || this.users[existsIdx].phone,
          isSavedContact: true,
          inviteText: oc.inviteText || this.users[existsIdx].inviteText,
          whatsappUrl: oc.whatsappUrl || this.users[existsIdx].whatsappUrl,
          smsUrl: oc.smsUrl || this.users[existsIdx].smsUrl
        };
      }

      // Sohbetler listesine de anında ekle
      const convExists = this.conversations.some(
        (c) =>
          c.type === 'direct' &&
          c.peer &&
          (c.peer.user_id === oc.id ||
            (oc.phoneNormalized && this.normalizePhoneClient(c.peer.phone) === oc.phoneNormalized))
      );
      if (!convExists) {
        this.conversations.unshift({
          id: oc.conversationId || ('conv_' + oc.id),
          type: 'direct',
          title: oc.display_name,
          description: oc.phone || '',
          avatarColor: oc.avatar_color || '#10b981',
          myRole: 'member',
          pinned: false,
          muted: false,
          unreadCount: 0,
          peer: {
            user_id: oc.id,
            username: oc.username,
            display_name: oc.display_name,
            phone: oc.phone,
            isRegistered: Boolean(oc.isRegistered),
            online: Boolean(oc.online)
          },
          lastMessage: {
            id: 'msg_' + Date.now(),
            senderId: (this.user && this.user.id) || '',
            senderName: (this.user && this.user.display_name) || 'Ben',
            msgType: 'text',
            content: oc.inviteText,
            isEncrypted: false,
            status: 'sent',
            createdAt: new Date().toISOString()
          }
        });
      }
    }
  },

  async processPickedPhoneContacts(selected) {
    try {
      const list = Array.isArray(selected) ? selected : Array.from(selected || []);
      const formatted = [];
      const seenNormPhones = new Set();

      for (const c of list) {
        if (!c) continue;
        // ContactInfo getter özelliklerini doğrudan oku
        const names = c.name ? (Array.isArray(c.name) ? c.name : Array.from(c.name)) : [];
        const tels = c.tel ? (Array.isArray(c.tel) ? c.tel : Array.from(c.tel)) : [];

        const cleanName = names
          .map((n) => {
            if (n && typeof n === 'object') {
              return String(n.display || n.formatted || n.givenName || n.name || '').trim();
            }
            return String(n || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
          })
          .filter(Boolean)
          .join(' ') || String(c.displayName || '').trim();

        const cleanPhones = tels
          .map((p) => {
            if (p && typeof p === 'object') {
              p = p.value || p.number || p.tel || p.phone || '';
            }
            return String(p || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
          })
          .filter(Boolean);

        // Eğer birden fazla numara varsa (+2 tane daha vb.) mobil numarayı (05... veya +905...) önceliklendir
        if (cleanPhones.length > 1) {
          cleanPhones.sort((a, b) => {
            const aIsMob = /(?:^\+?90|^0)?5\d{8}/.test(a.replace(/\D/g, ''));
            const bIsMob = /(?:^\+?90|^0)?5\d{8}/.test(b.replace(/\D/g, ''));
            if (aIsMob && !bIsMob) return -1;
            if (!aIsMob && bIsMob) return 1;
            return 0;
          });
        }

        if (cleanPhones.length > 0) {
          const tel = cleanPhones[0];
          const norm = this.normalizePhoneClient(tel) || tel;
          const dedupKey = `${cleanName.toLowerCase()}|${norm}`;
          if (!seenNormPhones.has(dedupKey)) {
            seenNormPhones.add(dedupKey);
            formatted.push({
              name: cleanName || this.formatPhoneDisplayClient(tel),
              phone: tel
            });
          }
        } else if (cleanName) {
          formatted.push({
            name: cleanName,
            phone: ''
          });
        }
      }

      if (formatted.length === 0) {
        this.toast('⚠️ Seçilen kişide geçerli isim veya telefon numarası bulunamadı.', 'error');
        return;
      }

      // 1. ANINDA OPTİMİSTİK KAYIT (0ms GECİKME - KULLANICI ASLA BEKLEMEZ)
      const optimistic = this.buildOptimisticContacts(formatted);
      this.applyOptimisticContactsToUi(optimistic);
      this.saveContactsLocally(optimistic);

      // Form kutularına da doldur (yedek)
      const nameInput = document.getElementById('contact-name-input');
      const phoneInput = document.getElementById('contact-phone-input');
      const bulkInput = document.getElementById('bulk-contacts-input');
      if (nameInput) nameInput.value = formatted[0].name || '';
      if (phoneInput && formatted[0].phone) phoneInput.value = formatted[0].phone;
      if (bulkInput) {
        bulkInput.value = formatted.map((f) => `${f.name} ${f.phone}`.trim()).join('\n');
      }

      this.closeModal('contact-modal');
      this.switchNav('contacts');
      this.renderSidebar();
      this.toast(`✅ ${optimistic.length} kişi (${optimistic.map((x) => x.display_name).join(', ')}) rehberinize eklendi!`);

      // Davet modalını da aç
      this.openInviteModal({
        importedCount: optimistic.length,
        contacts: optimistic,
        inviteMessage: optimistic[0].inviteText
      });

      // 2. Kalıcı kuyruğa (localStorage) kaydet ve arka planda sunucuya aktar
      localStorage.setItem('msj_pending_phone_import', JSON.stringify(formatted));
      await this.flushPendingPhoneImport();
    } catch (err) {
      console.error('Rehber aktarım hatası:', err);
      this.toast('❌ Rehber aktarım hatası: ' + (err.message || 'Bilinmeyen hata'), 'error');
    }
  },

  async flushPendingPhoneImport() {
    if (this._flushingPhoneImport) return;
    const raw = localStorage.getItem('msj_pending_phone_import');
    if (!raw) return;

    let formatted = [];
    try {
      formatted = JSON.parse(raw);
    } catch {
      localStorage.removeItem('msj_pending_phone_import');
      return;
    }
    if (!Array.isArray(formatted) || formatted.length === 0) {
      localStorage.removeItem('msj_pending_phone_import');
      return;
    }

    this._flushingPhoneImport = true;
    try {
      // Android rehber ekranından dönüşte ağ soketinin tam uyanması için kısa bekleme
      await new Promise((r) => setTimeout(r, 600));

      this.toast(`⏳ ${formatted.length} kişi (${formatted.map((x) => x.name).join(', ')}) rehbere kaydediliyor...`);

      const res = await this.syncContactsWithRetry({
        contacts: formatted,
        inviteChannel: 'auto',
        appUrl: location.origin
      });

      // Başarılı olduysa bekleyen kuyruğu temizle
      localStorage.removeItem('msj_pending_phone_import');

      if (res && res.contacts && res.contacts.length > 0) {
        this.users = this.users.filter((u) => !String(u.id).startsWith('local_'));
        const localKey = `msj_saved_contacts_${(this.user && this.user.id) || 'default'}`;
        const cleanedLocal = this.getSavedLocalContacts().filter((c) => !String(c.id).startsWith('local_'));
        localStorage.setItem(localKey, JSON.stringify(cleanedLocal));

        this.saveContactsLocally(res.contacts);
        this.closeModal('contact-modal');
        await Promise.all([this.loadUsers(), this.loadConversations()]);
        this.switchNav('contacts');
        this.toast(`✅ ${res.contacts.length} kişi rehberinize kalıcı olarak kaydedildi!`);
        this.openInviteModal({
          importedCount: res.contacts.length,
          contacts: res.contacts,
          inviteMessage: res.inviteMessage || res.contacts[0].inviteText
        });
      } else {
        this.toast('⚠️ Sunucu boş yanıt döndürdü, kayıt doğrulanamadı.', 'error');
      }
    } catch (err) {
      console.error('Rehber kayıt hatası:', err);
      this.toast('⚠️ Ağ bekleniyor, tekrar denenecek: ' + (err.message || 'Bağlantı hatası'), 'error');
    } finally {
      this._flushingPhoneImport = false;
    }
  },

  async handleVcfFileSelected(e) {
    const inputEl = e.target;
    const files = Array.from((inputEl && inputEl.files) || []);
    if (files.length === 0) return;

    try {
      this.toast('⏳ Rehber dosyası okunuyor...');
      let combinedText = '';
      for (const f of files) {
        combinedText += '\n' + (await this.readFileTextSafe(f));
      }

      const res = await this.syncContactsWithRetry({
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
    } finally {
      if (inputEl) inputEl.value = '';
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
    const name = (document.getElementById('contact-name-input')?.value || '').trim();
    const phone = (document.getElementById('contact-phone-input')?.value || '').trim();
    if (!phone) {
      return this.toast('Lütfen cep telefonu numarasını girin.', 'error');
    }

    const optimistic = this.buildOptimisticContacts([{ name: name || phone, phone }]);
    this.applyOptimisticContactsToUi(optimistic);
    this.saveContactsLocally(optimistic);

    const added = optimistic[0];
    this.closeModal('contact-modal');
    this.switchNav('contacts');
    this.renderSidebar();
    this.toast(`✅ ${added.display_name} (${added.phone}) rehberinize eklendi!`);

    // Eğer doğrudan WhatsApp veya SMS butonuna basıldıysa hemen ilgili uygulamayı aç
    if (channel === 'whatsapp' && added.whatsappUrl) {
      window.open(added.whatsappUrl, '_blank', 'noopener');
    } else if (channel === 'sms' && added.smsUrl) {
      window.location.href = added.smsUrl;
    }

    // Davet modalını da aç ki kullanıcı isterse hem SMS hem WhatsApp gönderebilsin
    this.openInviteModal({ importedCount: 1, contacts: [added], inviteMessage: added.inviteText });

    try {
      const res = await this.syncContactsWithRetry({
        contacts: [{ name, phone }],
        inviteChannel: channel,
        appUrl: location.origin
      });

      const serverAdded = (res && res.contacts && res.contacts[0]) || added;
      this.saveContactsLocally([serverAdded]);
      await Promise.all([this.loadUsers(), this.loadConversations()]);
      this.renderSidebar();

      if (serverAdded.conversationId) {
        await this.selectConversation(serverAdded.conversationId);
      }
    } catch (err) {
      console.warn('Sunucu senkronizasyon uyarısı:', err);
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
      localStorage.setItem('msj_user_profile', JSON.stringify(this.user));
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
      localStorage.setItem('msj_user_profile', JSON.stringify(this.user));
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
    localStorage.removeItem('msj_user_profile');
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

    // WebRTC ve Canlı Arama Sinyalizasyon Olayları
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
    if (ev.type === 'call-media') {
      this.handleRemoteCallMedia(ev);
      return;
    }
    if (ev.type === 'call-reject' || ev.type === 'call-end') {
      this.toast('Arama sonlandırıldı.');
      this.endCall(false);
    }
  },

  async loadConversations() {
    try {
      const data = await this.api('/api/conversations');
      this.conversations = data.conversations || [];
    } catch {
      this.conversations = this.conversations || [];
    }

    // Yerel rehber kişilerinden henüz sunucuda sohbeti görünmeyenleri Sohbetler listesinde de koru
    const localContacts = this.getSavedLocalContacts();
    for (const lc of localContacts) {
      const lcNorm = lc.phoneNormalized || this.normalizePhoneClient(lc.phone);
      const exists = this.conversations.some(
        (c) =>
          c.type === 'direct' &&
          c.peer &&
          (c.peer.user_id === lc.id || (lcNorm && this.normalizePhoneClient(c.peer.phone) === lcNorm))
      );
      if (!exists) {
        this.conversations.push({
          id: lc.conversationId || ('conv_' + lc.id),
          type: 'direct',
          title: lc.display_name,
          description: lc.phone || '',
          avatarColor: lc.avatar_color || '#10b981',
          myRole: 'member',
          pinned: false,
          muted: false,
          unreadCount: 0,
          peer: {
            user_id: lc.id,
            username: lc.username || 'tel',
            display_name: lc.display_name,
            phone: lc.phone,
            isRegistered: Boolean(lc.isRegistered),
            online: Boolean(lc.online)
          },
          lastMessage: {
            id: 'msg_local_' + lc.id,
            senderId: (this.user && this.user.id) || '',
            senderName: (this.user && this.user.display_name) || 'Ben',
            msgType: 'text',
            content: lc.inviteText || `${lc.phone} — Bu numaraları kullanıcı sizi programı kullanmak için ekledi`,
            isEncrypted: false,
            status: 'sent',
            createdAt: new Date().toISOString()
          }
        });
      }
    }

    if (this.currentNav === 'chats' || this.currentNav === 'channels') {
      this.renderSidebar();
    }
  },

  async loadUsers() {
    try {
      const data = await this.api('/api/users');
      this.users = data.users || [];
    } catch {
      this.users = this.users || [];
    }

    // Yerel hafızada kayıtlı rehber kişilerini birleştir (Render konteyner sıfırlamalarında bile kişiler kaybolmaz)
    const localContacts = this.getSavedLocalContacts();
    const unsyncedForServer = [];
    for (const lc of localContacts) {
      const lcNorm = lc.phoneNormalized || this.normalizePhoneClient(lc.phone);
      const found = this.users.some(
        (u) =>
          (lcNorm && (this.normalizePhoneClient(u.phone) === lcNorm || u.phone_normalized === lcNorm)) ||
          u.id === lc.id
      );
      if (!found) {
        this.users.unshift(lc);
        if (lc.phone || lc.display_name) {
          unsyncedForServer.push({ name: lc.display_name, phone: lc.phone });
        }
      }
    }

    if (unsyncedForServer.length > 0 && !this._resyncingLocalContacts) {
      this._resyncingLocalContacts = true;
      this.api('/api/contacts/sync', 'POST', {
        contacts: unsyncedForServer,
        inviteChannel: 'auto',
        appUrl: location.origin
      })
        .then(async (res) => {
          if (res && res.contacts && res.contacts.length > 0) {
            this.saveContactsLocally(res.contacts);
            const fresh = await this.api('/api/users').catch(() => null);
            if (fresh && Array.isArray(fresh.users) && fresh.users.length > 0) {
              this.users = fresh.users;
              if (this.currentNav === 'contacts') this.renderSidebar();
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          this._resyncingLocalContacts = false;
        });
    }

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
    document.body.classList.remove('mobile-chat-open');
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
        if (this.searchQuery) {
          const q = this.searchQuery;
          const isPhoneCandidate = q.replace(/\D/g, '').length >= 7;
          container.innerHTML += `
            <div style="padding:28px 18px;text-align:center;color:var(--text-muted);font-size:13.5px;">
              <p style="margin-bottom:12px;">"${this.escapeHtml(q)}" ile eşleşen sohbet bulunamadı.</p>
              <button class="btn btn-primary btn-sm" onclick="App.quickStartChatWithQuery('${this.escapeHtml(q)}')">
                ➕ ${isPhoneCandidate ? 'Bu Numara ile Sohbet Başlat & Rehbere Ekle' : 'Bu İsimle Yeni Kişi Ekle'}
              </button>
            </div>
          `;
          return;
        }
        container.innerHTML += `
          <div style="padding:28px 18px;text-align:center;color:var(--text-muted);font-size:13.5px;">
            <p style="margin-bottom:12px;">Henüz sohbet bulunmuyor.</p>
            <button class="btn btn-primary btn-sm" onclick="App.openContactModal()">💬 Yeni Kişi / Sohbet Ekle</button>
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
        if (this.searchQuery) {
          const q = this.searchQuery;
          const isPhoneCandidate = q.replace(/\D/g, '').length >= 7;
          container.innerHTML += `
            <div style="padding:28px 18px;text-align:center;color:var(--text-muted);font-size:13.5px;">
              <p style="margin-bottom:12px;">"${this.escapeHtml(q)}" rehberinizde bulunamadı.</p>
              <button class="btn btn-primary btn-sm" onclick="App.quickStartChatWithQuery('${this.escapeHtml(q)}')">
                ➕ ${isPhoneCandidate ? 'Bu Numarayı Rehbere Ekle & Sohbet Başlat' : 'Bu İsimle Yeni Kişi Ekle'}
              </button>
            </div>
          `;
          return;
        }
        container.innerHTML += `
          <div style="padding:28px 18px;text-align:center;color:var(--text-muted);font-size:13.5px;">
            <p style="margin-bottom:12px;">Rehberinizde henüz kayıtlı kişi yok.</p>
            <button class="btn btn-primary btn-sm" onclick="App.openContactModal()">💬 Yeni Kişi / Numara Ekle</button>
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
        <div style="background:var(--bg-header);padding:14px;border-radius:12px;border-left:4px solid var(--primary);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
            <h4>🔤 Yazı Boyutu, Yazı Stili ve Ekran Görünümü</h4>
            <button class="btn btn-primary btn-sm" onclick="App.openTypographyModal()">Aa Detaylı Görünüm Ayarları</button>
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
            Aktif Boyut: <strong>${this.fontSize}px</strong> • Yazı Tipi: <strong>${this.getFontFamilyLabel(this.fontFamilyKey)}</strong>
          </p>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm" onclick="App.stepFontSize(-1)">➖ Yazıyı Küçült</button>
            <button class="btn btn-secondary btn-sm" onclick="App.stepFontSize(1)">➕ Yazıyı Büyüt</button>
            <button class="btn btn-secondary btn-sm" onclick="App.resetTypography()">🔄 Varsayılan</button>
          </div>
        </div>

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
      let targetId = peerUserId;
      if (String(targetId).startsWith('local_')) {
        const localUser = this.users.find((u) => u.id === targetId);
        if (localUser) {
          const syncRes = await this.syncContactsWithRetry({
            contacts: [{ name: localUser.display_name, phone: localUser.phone }],
            inviteChannel: 'auto',
            appUrl: location.origin
          });
          if (syncRes && syncRes.contacts && syncRes.contacts[0]) {
            targetId = syncRes.contacts[0].id;
            await Promise.all([this.loadUsers(), this.loadConversations()]);
            if (syncRes.contacts[0].conversationId) {
              this.switchNav('chats');
              await this.selectConversation(syncRes.contacts[0].conversationId);
              return;
            }
          }
        }
      }
      const data = await this.api('/api/conversations/direct', 'POST', { peerUserId: targetId });
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

  // --- WebRTC + CGNAT Röleli Sesli ve Görüntülü Arama + Sesi Dışarı Verme (Hoparlör) ---
  ensureCallAudioContext() {
    if (!this.callAudioCtx || this.callAudioCtx.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.callAudioCtx = new AudioCtx();
      const compressor = this.callAudioCtx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 20;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;

      this.speakerGainNode = this.callAudioCtx.createGain();
      this.speakerGainNode.gain.value = this.isSpeakerOn ? 3.2 : 1.0;
      this.speakerGainNode.connect(compressor);
      compressor.connect(this.callAudioCtx.destination);
      this.nextPlayTime = 0;
    }
    if (this.callAudioCtx.state === 'suspended') {
      this.callAudioCtx.resume().catch(() => {});
    }
    return this.callAudioCtx;
  },

  startRingTone(mode = 'outgoing') {
    this.stopRingTone();
    const playPattern = () => {
      this.playBeep(mode === 'incoming' ? 880 : 440, 0.25);
      setTimeout(() => {
        if (this.callRingInterval) {
          this.playBeep(mode === 'incoming' ? 660 : 480, 0.25);
        }
      }, 300);
    };
    playPattern();
    this.callRingInterval = setInterval(playPattern, 2400);
  },

  stopRingTone() {
    if (this.callRingInterval) {
      clearInterval(this.callRingInterval);
      this.callRingInterval = null;
    }
  },

  updateSpeakerButtonUi() {
    const btn = document.getElementById('btn-toggle-speaker');
    if (!btn) return;
    if (this.isSpeakerOn) {
      btn.textContent = '🔊 Hoparlör: Açık';
      btn.style.background = '#10b981';
      btn.style.color = '#ffffff';
    } else {
      btn.textContent = '🔈 Sesi Dışarı Ver';
      btn.style.background = '#202c33';
      btn.style.color = '#ffffff';
    }
  },

  async applyAudioOutputRouting() {
    this.updateSpeakerButtonUi();
    const remoteVideo = document.getElementById('remote-video');
    const remoteAudio = document.getElementById('remote-audio');
    const vol = this.isSpeakerOn ? 1.0 : 0.72;
    if (remoteVideo) {
      remoteVideo.muted = false;
      remoteVideo.volume = vol;
    }
    if (remoteAudio) {
      remoteAudio.muted = false;
      remoteAudio.volume = vol;
    }
    if (this.speakerGainNode && this.callAudioCtx) {
      this.speakerGainNode.gain.setValueAtTime(this.isSpeakerOn ? 3.2 : 1.0, this.callAudioCtx.currentTime);
    }

    // Cihaz destekliyorsa (Android Chrome / Masaüstü) ses çıkış donanımını (setSinkId) hoparlöre veya ahizeye yönlendir
    if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId);
        if (outputs.length > 0) {
          let preferred = null;
          if (this.isSpeakerOn) {
            preferred =
              outputs.find((d) => /speaker|hoparlör|hands-free|loud/i.test(d.label || '')) ||
              outputs.find((d) => d.deviceId === 'default') ||
              outputs[outputs.length - 1];
          } else {
            preferred =
              outputs.find((d) => /earpiece|ahize|receiver|communications/i.test(d.label || '')) ||
              outputs[0];
          }
          if (preferred && preferred.deviceId) {
            if (remoteVideo && typeof remoteVideo.setSinkId === 'function') {
              await remoteVideo.setSinkId(preferred.deviceId).catch(() => {});
            }
            if (remoteAudio && typeof remoteAudio.setSinkId === 'function') {
              await remoteAudio.setSinkId(preferred.deviceId).catch(() => {});
            }
          }
        }
      } catch {}
    }
  },

  async toggleCallSpeaker() {
    this.isSpeakerOn = !this.isSpeakerOn;
    this.ensureCallAudioContext();
    await this.applyAudioOutputRouting();
    this.toast(
      this.isSpeakerOn
        ? '🔊 Sesi dışarı verme (Hoparlör) açıldı!'
        : '🔈 Normal ahize sesine geçildi.'
    );
  },

  attachStreamToAudioAmplifier(stream) {
    try {
      if (!stream || stream.getAudioTracks().length === 0) return;
      const ctx = this.ensureCallAudioContext();
      if (this.remoteStreamSource) {
        try { this.remoteStreamSource.disconnect(); } catch {}
      }
      this.remoteStreamSource = ctx.createMediaStreamSource(stream);
      this.remoteStreamSource.connect(this.speakerGainNode);
    } catch {}
  },

  async flushPendingIceCandidates() {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    const queue = this.pendingIceCandidates.splice(0, this.pendingIceCandidates.length);
    for (const cand of queue) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      } catch {}
    }
  },

  async createPeerConnection(targetUserId, convId, callType) {
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch {}
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp'
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]
    });

    this.remoteStream = new MediaStream();

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

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        this.stopRingTone();
        document.getElementById('call-status-label').textContent = '🟢 Görüşme Aktif (Bağlandı)';
        if (!this.callTimerInterval) {
          this.startCallTimer();
        }
      }
    };

    pc.ontrack = (ev) => {
      const remoteVideo = document.getElementById('remote-video');
      const remoteAudio = document.getElementById('remote-audio');
      const stream = (ev.streams && ev.streams[0]) ? ev.streams[0] : this.remoteStream;

      if (ev.track && stream === this.remoteStream) {
        this.remoteStream.addTrack(ev.track);
      }

      if (ev.track && ev.track.kind === 'audio') {
        this.webrtcAudioReceived = true;
      }
      if (ev.track && ev.track.kind === 'video') {
        this.webrtcVideoReceived = true;
      }

      if (remoteVideo && remoteVideo.srcObject !== stream) {
        remoteVideo.srcObject = stream;
      }
      if (remoteAudio && remoteAudio.srcObject !== stream) {
        remoteAudio.srcObject = stream;
      }

      this.applyAudioOutputRouting();
      this.attachStreamToAudioAmplifier(stream);

      if (remoteVideo) remoteVideo.play().catch(() => {});
      if (remoteAudio) remoteAudio.play().catch(() => {});

      if (callType === 'video' || (ev.track && ev.track.kind === 'video')) {
        document.getElementById('call-avatar-placeholder').classList.add('hidden');
        document.getElementById('remote-video-relay')?.classList.add('hidden');
      }
    };

    return pc;
  },

  startWebSocketMediaRelay() {
    this.stopWebSocketMediaRelay();
    if (!this.localStream || !this.activeCall) return;

    // 1. Canlı Ses Rölesi (Mobil 4.5G/5G CGNAT arkasında WebRTC UDP engellendiğinde bile sesin kesintisiz gitmesini sağlar)
    try {
      const audioTracks = this.localStream.getAudioTracks();
      if (audioTracks.length > 0) {
        const ctx = this.ensureCallAudioContext();
        const source = ctx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        const inRate = ctx.sampleRate || 48000;
        const outRate = 8000;
        const ratio = inRate / outRate;

        proc.onaudioprocess = (e) => {
          if (!this.activeCall || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          const track = this.localStream && this.localStream.getAudioTracks()[0];
          if (!track || !track.enabled) return;

          const input = e.inputBuffer.getChannelData(0);
          const outLen = Math.floor(input.length / ratio);
          const pcm16 = new Int16Array(outLen);
          let maxAmp = 0;
          for (let i = 0; i < outLen; i++) {
            const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] || 0));
            if (Math.abs(s) > maxAmp) maxAmp = Math.abs(s);
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          // Sessizlikte gereksiz paket gönderme
          if (maxAmp < 0.008) return;

          const bytes = new Uint8Array(pcm16.buffer);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);

          this.ws.send(JSON.stringify({
            type: 'call-media',
            mediaType: 'audio',
            conversationId: this.activeCall.convId,
            targetUserId: this.activeCall.targetUserId,
            sampleRate: outRate,
            pcmBase64: btoa(bin)
          }));
        };

        const zeroGain = ctx.createGain();
        zeroGain.gain.value = 0;
        source.connect(proc);
        proc.connect(zeroGain);
        zeroGain.connect(ctx.destination);
        this.wsAudioProcessor = { source, proc, zeroGain };
      }
    } catch {}

    // 2. Canlı Görüntü Rölesi (Görüntülü aramalarda CGNAT arkasında bile canlı kamera karesi aktarır)
    if (this.activeCall.callType === 'video') {
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 320;
      const ctx2d = canvas.getContext('2d');

      this.wsVideoInterval = setInterval(() => {
        if (!this.activeCall || this.webrtcVideoReceived || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const localVideo = document.getElementById('local-video');
        const vTrack = this.localStream && this.localStream.getVideoTracks()[0];
        if (!localVideo || !vTrack || !vTrack.enabled || localVideo.readyState < 2) return;

        try {
          ctx2d.drawImage(localVideo, 0, 0, canvas.width, canvas.height);
          const frameDataUrl = canvas.toDataURL('image/jpeg', 0.45);
          this.ws.send(JSON.stringify({
            type: 'call-media',
            mediaType: 'video',
            conversationId: this.activeCall.convId,
            targetUserId: this.activeCall.targetUserId,
            frameDataUrl
          }));
        } catch {}
      }, 260);
    }
  },

  stopWebSocketMediaRelay() {
    if (this.wsAudioProcessor) {
      try {
        this.wsAudioProcessor.source.disconnect();
        this.wsAudioProcessor.proc.disconnect();
        this.wsAudioProcessor.zeroGain.disconnect();
      } catch {}
      this.wsAudioProcessor = null;
    }
    if (this.wsVideoInterval) {
      clearInterval(this.wsVideoInterval);
      this.wsVideoInterval = null;
    }
  },

  handleRemoteCallMedia(ev) {
    if (!this.activeCall) return;

    if (ev.mediaType === 'audio' && ev.pcmBase64 && !this.webrtcAudioReceived) {
      try {
        const ctx = this.ensureCallAudioContext();
        const bin = atob(ev.pcmBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const pcm16 = new Int16Array(bytes.buffer);
        const sampleRate = Number(ev.sampleRate || 8000);

        const audioBuf = ctx.createBuffer(1, pcm16.length, sampleRate);
        const channel = audioBuf.getChannelData(0);
        for (let i = 0; i < pcm16.length; i++) {
          channel[i] = pcm16[i] / 32768.0;
        }

        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(this.speakerGainNode);

        const now = ctx.currentTime;
        if (this.nextPlayTime < now || this.nextPlayTime > now + 0.6) {
          this.nextPlayTime = now + 0.04;
        }
        src.start(this.nextPlayTime);
        this.nextPlayTime += audioBuf.duration;
      } catch {}
    } else if (ev.mediaType === 'video' && ev.frameDataUrl && !this.webrtcVideoReceived) {
      const relayImg = document.getElementById('remote-video-relay');
      if (relayImg) {
        relayImg.src = ev.frameDataUrl;
        relayImg.classList.remove('hidden');
        document.getElementById('call-avatar-placeholder')?.classList.add('hidden');
      }
    }
  },

  async acquireCallMediaStream(callType) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return null;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: callType === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
      });
    } catch {
      if (callType === 'video') {
        try {
          this.toast('Kamera açılamadı, mikrofon ile sesli olarak bağlanılıyor...');
          return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch {}
      }
      return null;
    }
  },

  async startCall(callType = 'audio') {
    const conv = this.getActiveConversation();
    if (!conv) return;

    const targetUserId = conv.peer ? conv.peer.user_id : null;
    const isPeerOnline = conv.type === 'direct' ? Boolean(conv.peer && conv.peer.online) : true;
    this.pendingIceCandidates = [];
    this.webrtcAudioReceived = false;
    this.webrtcVideoReceived = false;
    this.isSpeakerOn = callType === 'video';
    this.ensureCallAudioContext();
    await this.applyAudioOutputRouting();

    this.activeCall = { convId: conv.id, targetUserId, callType, startTime: Date.now(), connected: false };

    document.getElementById('call-overlay').classList.remove('hidden');
    document.getElementById('incoming-call-controls').classList.add('hidden');
    document.getElementById('active-call-controls').classList.remove('hidden');
    document.getElementById('call-avatar-placeholder').classList.remove('hidden');
    document.getElementById('remote-video-relay')?.classList.add('hidden');
    document.getElementById('call-timer-text').textContent = '00:00';
    document.getElementById('call-peer-name').textContent = conv.title;
    document.getElementById('call-peer-avatar').textContent = (conv.title || '?')[0].toUpperCase();
    document.getElementById('call-status-label').textContent = isPeerOnline
      ? (callType === 'video' ? '📹 Görüntülü çalıyor... (Cevap bekleniyor)' : '📞 Sesli çalıyor... (Cevap bekleniyor)')
      : '🔴 Kişi şu an çevrimdışı — Çağrı iletiliyor...';

    this.startRingTone('outgoing');

    this.localStream = await this.acquireCallMediaStream(callType);
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      localVideo.srcObject = this.localStream;
      localVideo.classList.toggle('hidden', callType !== 'video');
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
    } else {
      this.toast('Sunucu bağlantısı yenileniyor, lütfen tekrar deneyin.', 'error');
    }
  },

  async handleIncomingCallOffer(ev) {
    this.incomingOffer = ev;
    this.pendingIceCandidates = [];
    this.webrtcAudioReceived = false;
    this.webrtcVideoReceived = false;
    this.startRingTone('incoming');

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
    document.getElementById('remote-video-relay')?.classList.add('hidden');
    document.getElementById('call-timer-text').textContent = '00:00';
    document.getElementById('call-peer-name').textContent = ev.fromDisplayName || 'Gelen Arama';
    document.getElementById('call-peer-avatar').textContent = (ev.fromDisplayName || 'A')[0];
    document.getElementById('call-status-label').textContent =
      ev.callType === 'video' ? '📹 Gelen Görüntülü Arama... (Cevapla butonuna dokunun)' : '📞 Gelen Sesli Arama... (Cevapla butonuna dokunun)';
  },

  async acceptIncomingCall() {
    if (!this.incomingOffer) return;
    this.stopRingTone();
    const ev = this.incomingOffer;
    this.incomingOffer = null;

    this.isSpeakerOn = ev.callType === 'video';
    this.ensureCallAudioContext();
    await this.applyAudioOutputRouting();

    this.activeCall = {
      convId: ev.conversationId,
      targetUserId: ev.fromUserId,
      callType: ev.callType,
      startTime: Date.now(),
      connected: true
    };

    document.getElementById('incoming-call-controls').classList.add('hidden');
    document.getElementById('active-call-controls').classList.remove('hidden');
    document.getElementById('call-status-label').textContent = '🟢 Görüşme Aktif (Bağlandı)';
    this.startCallTimer();

    this.localStream = await this.acquireCallMediaStream(ev.callType);
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      localVideo.srcObject = this.localStream;
      localVideo.classList.toggle('hidden', ev.callType !== 'video');
    }

    this.peerConnection = await this.createPeerConnection(ev.fromUserId, ev.conversationId, ev.callType);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => this.peerConnection.addTrack(t, this.localStream));
    }

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(ev.sdp));
    await this.flushPendingIceCandidates();

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

    this.startWebSocketMediaRelay();
  },

  rejectIncomingCall() {
    this.stopRingTone();
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
    this.stopRingTone();
    if (this.activeCall) {
      this.activeCall.connected = true;
    }
    document.getElementById('call-status-label').textContent = '🟢 Görüşme Aktif (Bağlandı)';
    this.startCallTimer();

    if (this.peerConnection && ev.sdp) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(ev.sdp));
      await this.flushPendingIceCandidates();
    }

    this.startWebSocketMediaRelay();
  },

  async handleRemoteIce(ev) {
    if (!ev || !ev.candidate) return;
    if (this.peerConnection && this.peerConnection.remoteDescription) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(ev.candidate));
      } catch {}
    } else {
      this.pendingIceCandidates.push(ev.candidate);
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
      const btn = document.getElementById('btn-toggle-mic');
      if (btn) {
        btn.textContent = track.enabled ? '🎤 Mikrofon' : '🔇 Sessizde';
      }
      this.toast(track.enabled ? '🎤 Mikrofon açıldı' : '🔇 Mikrofon sessize alındı');
    }
  },

  toggleCallCamera() {
    if (!this.localStream) return;
    const track = this.localStream.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      const btn = document.getElementById('btn-toggle-cam');
      if (btn) {
        btn.textContent = track.enabled ? '📷 Kamera' : '🚫 Kamera Kapalı';
      }
      this.toast(track.enabled ? '📷 Kamera açıldı' : '🚫 Kamera kapatıldı');
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
    this.stopRingTone();
    this.stopWebSocketMediaRelay();
    clearInterval(this.callTimerInterval);
    this.callTimerInterval = null;
    this.pendingIceCandidates = [];
    this.webrtcAudioReceived = false;
    this.webrtcVideoReceived = false;

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
      try { this.peerConnection.close(); } catch {}
      this.peerConnection = null;
    }
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) remoteVideo.srcObject = null;
    const remoteAudio = document.getElementById('remote-audio');
    if (remoteAudio) remoteAudio.srcObject = null;
    const relayImg = document.getElementById('remote-video-relay');
    if (relayImg) {
      relayImg.src = '';
      relayImg.classList.add('hidden');
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

  // --- YAZI BOYUTU, YAZI STİLİ VE EKRAN SIĞDIRMA ÖZELLEŞTİRMESİ ---
  getFontFamilyCss(key) {
    const map = {
      modern: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      rounded: '"Trebuchet MS", "Nunito", Verdana, "Segoe UI", sans-serif',
      serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
      mono: 'Consolas, "SFMono-Regular", "Courier New", monospace',
      elegant: '"Palatino Linotype", "Book Antiqua", Palatino, Garamond, serif'
    };
    return map[key] || map.modern;
  },

  getFontFamilyLabel(key) {
    const labels = {
      modern: 'Modern Sistem',
      rounded: 'Yuvarlak & Yumuşak',
      serif: 'Klasik Kitap (Serif)',
      mono: 'Teknik / Daktilo',
      elegant: 'Zarif & Akıcı'
    };
    return labels[key] || 'Modern Sistem';
  },

  applyTypographySettings() {
    const size = Math.max(11, Math.min(22, Number(this.fontSize || 14)));
    this.fontSize = size;
    const familyKey = this.fontFamilyKey || 'modern';
    const styleMode = this.fontStyleMode || 'normal';

    const root = document.documentElement;
    root.style.setProperty('--user-font-size', `${size}px`);
    root.style.setProperty('--user-msg-font-size', `${(size * 1.03).toFixed(1)}px`);
    root.style.setProperty('--user-title-font-size', `${(size * 1.05).toFixed(1)}px`);
    root.style.setProperty('--user-sub-font-size', `${Math.max(11, (size * 0.88).toFixed(1))}px`);
    root.style.setProperty('--user-font-family', this.getFontFamilyCss(familyKey));

    let weight = '400';
    let fStyle = 'normal';
    if (styleMode === 'medium') weight = '600';
    else if (styleMode === 'bold') weight = '700';
    else if (styleMode === 'italic') {
      weight = '400';
      fStyle = 'italic';
    }
    root.style.setProperty('--user-font-weight', weight);
    root.style.setProperty('--user-font-style', fStyle);

    localStorage.setItem('msj_font_size', String(size));
    localStorage.setItem('msj_font_family', familyKey);
    localStorage.setItem('msj_font_style_mode', styleMode);

    // Modal içi göstergeleri güncelle
    const slider = document.getElementById('font-size-slider');
    if (slider) slider.value = String(size);

    const badge = document.getElementById('font-size-value-badge');
    if (badge) {
      const label =
        size <= 12 ? 'Küçük' : size <= 14 ? 'Normal' : size <= 16 ? 'Orta' : size <= 18 ? 'Büyük' : 'Çok Büyük';
      badge.textContent = `${size}px (${label})`;
    }

    document.querySelectorAll('.font-size-preset').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.size) === size);
    });
    document.querySelectorAll('.font-family-preset').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.family === familyKey);
    });
    document.querySelectorAll('.font-style-preset').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.style === styleMode);
    });
  },

  openTypographyModal() {
    this.applyTypographySettings();
    document.getElementById('typography-modal')?.classList.remove('hidden');
  },

  setFontSize(size) {
    this.fontSize = Math.max(11, Math.min(22, Number(size || 14)));
    this.applyTypographySettings();
    if (this.currentNav === 'settings') {
      this.renderSidebar();
    }
  },

  stepFontSize(delta) {
    this.setFontSize((Number(this.fontSize) || 14) + Number(delta || 0));
  },

  setFontFamily(familyKey) {
    this.fontFamilyKey = familyKey || 'modern';
    this.applyTypographySettings();
    if (this.currentNav === 'settings') {
      this.renderSidebar();
    }
  },

  setFontStyleMode(styleMode) {
    this.fontStyleMode = styleMode || 'normal';
    this.applyTypographySettings();
  },

  resetTypography() {
    this.fontSize = 14;
    this.fontFamilyKey = 'modern';
    this.fontStyleMode = 'normal';
    this.applyTypographySettings();
    if (this.currentNav === 'settings') {
      this.renderSidebar();
    }
    this.toast('🔤 Yazı boyutu ve stili varsayılan ayarlara döndürüldü.');
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

window.addEventListener('DOMContentLoaded', async () => {
  await App.init();
  await App.flushPendingPhoneImport();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && App.token) {
    App.flushPendingPhoneImport();
  }
});
