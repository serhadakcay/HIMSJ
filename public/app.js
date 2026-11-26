
// Sunucudaki normalizePhone ile AYNI sonucu üretir (anahtarın her açılışta aynı isimle bulunması için)
function clientNormPhone(raw) {
  let d = String(raw || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && !d.startsWith('90')) d = '90' + d;
  else if (d.length === 11 && d.startsWith('0')) d = '90' + d.slice(1);
  else if (d.length === 13 && d.startsWith('900')) d = '90' + d.slice(3);
  return d;
}

// --- TELEFONUN KENDİ REHBERİNE (ANDROID & iOS) KİŞİ KAYDETME MOTORU ---
function normalizeE164Client(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && !digits.startsWith('90')) digits = '90' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '90' + digits.slice(1);
  return '+' + digits;
}

function saveContactToDevicePhoneBook(contactName, rawPhone) {
  const e164 = normalizeE164Client(rawPhone);
  const cleanName = String(contactName || e164 || 'Yeni Kişi').trim();
  if (!e164) return;

  // 1. Native Android (Kotlin ContactsContract.Intents.Insert.ACTION) / iOS (Swift CNContactStore) Köprüsü:
  if (window.AndroidNative && typeof window.AndroidNative.insertContact === 'function') {
    window.AndroidNative.insertContact(cleanName, e164);
    return;
  }
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.insertContact) {
    window.webkit.messageHandlers.insertContact.postMessage({ name: cleanName, phone: e164 });
    return;
  }

  // 2. Android & iOS Tarayıcıda vCard 3.0 (.vcf) -> Telefonun kendi "Yeni Kişi Ekle / Rehbere Kaydet" ekranını açar
  const vcardUrl = `/api/vcard?name=${encodeURIComponent(cleanName)}&phone=${encodeURIComponent(e164)}`;
  const a = document.createElement('a');
  a.href = vcardUrl;
  a.download = `${cleanName.replace(/[^a-zA-Z0-9_-]/g, '_')}.vcf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const e2ee = new NexusE2EE();
const isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
const deviceType = isMobileDevice ? 'mobile' : 'desktop';

let token = localStorage.getItem('nexus_token') || '';
let me = null;
let ws = null;
let contacts = [];
let discoverableUsers = [];
let stories = [];
let callLogs = [];
let missedCallCount = 0;
let currentSideTab = 'chats';
let activePeer = null;
let deferredInstallPrompt = null;
let pendingPhoneChoiceCb = null;
let pendingStoryImageDataUrl = '';

// WebRTC + Ahize / Handsfree (Hoparlör) Kontrolü + 10 Çalma (Ring)
let pc = null;
let localStream = null;
let remoteStream = null;
let activeCall = null;
let incomingOffer = null;
let pendingCandidates = [];
let ringInterval = null;
let ringCount = 0;
const MAX_RINGS = 10;

// Varsayılan olarak Handsfree (Hoparlör) KAPALI — Ses ahizeden/kulaklıktan çıkar; kullanıcı basınca hoparlör açılır!
let isHandsfreeOn = false;
let callAudioCtx = null;
let speakerGain = null;
let nextPlayTime = 0;
let wsAudioProc = null;
let wsVideoTimer = null;
let captureVideoEl = null;
let webrtcAudioActive = false;
let webrtcVideoActive = false;
let statsInterval = null;
let lastAudioBytes = 0;
let lastVideoBytes = 0;
let callPollInterval = null;

function applySavedAppearance() {
  const fSize = localStorage.getItem('nexus_font_size') || '14.5';
  const fFamily = localStorage.getItem('nexus_font_family') || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const fWeight = localStorage.getItem('nexus_font_weight') || '400';
  const wallpaper = localStorage.getItem('nexus_chat_wallpaper') || '';

  document.documentElement.style.setProperty('--user-font-size', `${fSize}px`);
  document.documentElement.style.setProperty('--user-font-family', fFamily);
  document.documentElement.style.setProperty('--user-font-weight', fWeight);

  const label = document.getElementById('fontSizeValLabel');
  if (label) label.textContent = `${fSize}px`;
  const range = document.getElementById('fontSizeRange');
  if (range) range.value = fSize;
  const famSel = document.getElementById('fontFamilySelect');
  if (famSel) famSel.value = fFamily;
  const wSel = document.getElementById('fontWeightSelect');
  if (wSel) wSel.value = fWeight;

  const chatPane = document.getElementById('chatPane');
  if (chatPane) {
    if (wallpaper) {
      chatPane.style.backgroundImage = `linear-gradient(rgba(11,20,26,0.68), rgba(11,20,26,0.68)), url("${wallpaper}")`;
    } else {
      chatPane.style.backgroundImage = 'none';
    }
  }
}
applySavedAppearance();

document.getElementById('openAppearanceBtn').onclick = () => document.getElementById('appearanceModal').classList.remove('hidden');
document.getElementById('closeAppearanceBtn').onclick = () => document.getElementById('appearanceModal').classList.add('hidden');
document.getElementById('fontSizeRange').oninput = (e) => { localStorage.setItem('nexus_font_size', e.target.value); applySavedAppearance(); };
document.getElementById('fontFamilySelect').onchange = (e) => { localStorage.setItem('nexus_font_family', e.target.value); applySavedAppearance(); };
document.getElementById('fontWeightSelect').onchange = (e) => { localStorage.setItem('nexus_font_weight', e.target.value); applySavedAppearance(); };

document.getElementById('pickWallpaperBtn').onclick = () => document.getElementById('wallpaperFileInput').click();
document.getElementById('wallpaperFileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  compressImageToDataUrl(file, 1280, 0.82, (dataUrl) => {
    try { localStorage.setItem('nexus_chat_wallpaper', dataUrl); applySavedAppearance(); }
    catch { alert('Fotoğraf boyutu çok yüksek.'); }
  });
};
document.getElementById('clearWallpaperBtn').onclick = () => { localStorage.removeItem('nexus_chat_wallpaper'); applySavedAppearance(); };

function compressImageToDataUrl(file, maxDim, quality, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
        else { w = Math.round((w * maxDim) / h); h = maxDim; }
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; });
document.getElementById('openInstallBtn').onclick = () => document.getElementById('installModal').classList.remove('hidden');
document.getElementById('openInstallFromAuthBtn').onclick = () => document.getElementById('installModal').classList.remove('hidden');
document.getElementById('closeInstallModalBtn').onclick = () => document.getElementById('installModal').classList.add('hidden');

document.getElementById('androidDirectInstallBtn').onclick = async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const res = await deferredInstallPrompt.userChoice;
    if (res.outcome === 'accepted') document.getElementById('installModal').classList.add('hidden');
    deferredInstallPrompt = null;
  } else {
    alert('Tarayıcınızın sağ üst köşesindeki ⋮ (Üç Nokta) menüsüne dokunup "Ana ekrana ekle" veya "Uygulamayı yükle" seçeneğine basın.');
  }
};

document.addEventListener('visibilitychange', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'VISIBILITY', visible: !document.hidden }));
  }
  if (!document.hidden && token) {
    flushPendingContactImport();
    checkIncomingCallByHttp();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js?v=13').then((reg) => reg.update().catch(() => {})).catch(() => {});
  navigator.serviceWorker.addEventListener('message', async (ev) => {
    if (ev.data?.type === 'OPEN_CHAT_FROM_NOTIF' && ev.data.peerId) {
      const peer = contacts.find((c) => c.id === ev.data.peerId);
      if (peer) openChat(peer);
    } else if (ev.data?.type === 'ANSWER_CALL_FROM_NOTIF' && ev.data.callId) {
      const res = await api(`/api/calls/active?callId=${encodeURIComponent(ev.data.callId)}`).catch(() => null);
      if (res?.call) {
        incomingOffer = res.call;
        pendingCandidates = res.call.iceCandidates || [];
        await acceptIncomingCall();
      }
    }
  });
}

async function api(url, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'İşlem başarısız.');
  return data;
}

document.getElementById('tabLogin').onclick = () => {
  document.getElementById('tabLogin').classList.add('active');
  document.getElementById('tabReg').classList.remove('active');
  document.getElementById('loginForm').classList.remove('hidden');
  document.getElementById('regForm').classList.add('hidden');
};
document.getElementById('tabReg').onclick = () => {
  document.getElementById('tabReg').classList.add('active');
  document.getElementById('tabLogin').classList.remove('active');
  document.getElementById('regForm').classList.remove('hidden');
  document.getElementById('loginForm').classList.add('hidden');
};

function resetSessionState() {
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
  if (callPollInterval) { clearInterval(callPollInterval); callPollInterval = null; }
  activePeer = null;
  contacts = [];
  discoverableUsers = [];
  stories = [];
  callLogs = [];
  e2ee.sharedKeyCache.clear();
  e2ee.plainCache.clear();
}

document.getElementById('regForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    resetSessionState();
    const displayName = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPass').value;
    const norm = clientNormPhone(phone);
    if (password.length < 8) { alert('Şifre en az 8 karakter olmalıdır.'); return; }
    const pubJwkStr = await e2ee.initForUser(norm);
    const keyBackup = await e2ee.createKeyBackup(password);
    const data = await api('/api/auth/register', 'POST', { displayName, phone, password, publicKeyJwk: pubJwkStr, keyBackup, deviceType });
    if (keyBackup) e2ee.clearPendingBackup();
    token = data.token;
    localStorage.setItem('nexus_token', token);
    me = data.user;
    startApp();
  } catch (err) { alert(err.message); }
};

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    resetSessionState();
    const phone = document.getElementById('loginPhone').value.trim();
    const password = document.getElementById('loginPass').value;
    const norm = clientNormPhone(phone);
    await e2ee.initForUser(norm);
    const data = await api('/api/auth/login', 'POST', { phone, password, deviceType });
    token = data.token;
    localStorage.setItem('nexus_token', token);
    me = data.user;

    // Çoklu cihaz: hesabın anahtar yedeği varsa bu cihaza geri yükle (tüm cihazlar aynı anahtarı kullanır)
    if (me.key_backup) {
      try {
        await e2ee.restoreFromBackup(me.key_backup, password);
      } catch {
        alert('⚠️ Anahtar yedeği çözülemedi. Bu cihazda yeni mesajlar okunamayabilir.');
      }
    } else if (e2ee.hasPendingBackup() || e2ee.publicKeyJwkStr) {
      const keyBackup = await e2ee.createKeyBackup(password);
      await api('/api/auth/keys', 'PUT', { publicKeyJwk: e2ee.publicKeyJwkStr, keyBackup }).catch(() => {});
      if (keyBackup) e2ee.clearPendingBackup();
      me.public_key_jwk = e2ee.publicKeyJwkStr;
    }
    delete me.key_backup;
    startApp();
  } catch (err) { alert(err.message); }
};

(async () => {
  if (!token) return;
  try {
    const data = await api('/api/auth/me');
    me = data.user;
    await e2ee.initForUser(clientNormPhone(me.phone_normalized));
    startApp();
  } catch { localStorage.removeItem('nexus_token'); }
})();

function updateMyAvatarUi() {
  const box = document.getElementById('myAvatarBox');
  if (!box || !me) return;
  if (me.avatar_url) box.innerHTML = `<img src="${escapeHtml(me.avatar_url)}" alt="Profil" />`;
  else {
    box.textContent = (me.display_name || 'B')[0].toUpperCase();
    box.style.background = me.avatar_color || '#00a884';
  }
  document.getElementById('myNameLabel').textContent = me.display_name;
  document.getElementById('myPhoneLabel').textContent = me.phone;
}

async function startApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');
  updateMyAvatarUi();

  if ('Notification' in window && Notification.permission === 'granted') {
    document.getElementById('pushBanner').classList.add('hidden');
    registerWebPush();
  }

  
  if (window.AndroidNative && typeof window.AndroidNative.requestPermissions === 'function') {
    window.AndroidNative.requestPermissions();
  }

  
  if (e2ee.publicKeyJwkStr && me && me.public_key_jwk !== e2ee.publicKeyJwkStr) {
    try {
      await api('/api/auth/keys', 'PUT', { publicKeyJwk: e2ee.publicKeyJwkStr });
      me.public_key_jwk = e2ee.publicKeyJwkStr;
    } catch (err) {
      alert('🔐 ' + (err && err.message ? err.message : 'Şifreleme anahtarı eşitlenemedi.'));
    }
  }

  connectWebSocket();
  startIncomingCallPoller();
  await flushPendingContactImport();
  await Promise.all([loadContacts(), loadStories(), loadCallLogs()]);
  renderSidebar();

  const params = new URLSearchParams(location.search);
  const answerCallId = params.get('answerCall');
  const chatWithId = params.get('chatWith');
  if (answerCallId) {
    const res = await api(`/api/calls/active?callId=${encodeURIComponent(answerCallId)}`).catch(() => null);
    if (res?.call) {
      incomingOffer = res.call;
      pendingCandidates = res.call.iceCandidates || [];
      await acceptIncomingCall();
    }
  } else if (chatWithId) {
    const peer = contacts.find((c) => c.id === chatWithId);
    if (peer) await openChat(peer);
  }
}

function startIncomingCallPoller() {
  if (callPollInterval) clearInterval(callPollInterval);
  callPollInterval = setInterval(checkIncomingCallByHttp, 2500);
}

async function checkIncomingCallByHttp() {
  if (!token || activeCall || incomingOffer) return;
  if (deviceType === 'desktop' && document.hidden) return;
  try {
    const res = await api('/api/calls/poll');
    if (res && res.incomingCall && !activeCall && !incomingOffer) {
      incomingOffer = res.incomingCall;
      pendingCandidates = res.incomingCall.iceCandidates || [];
      showIncomingCallScreen(res.incomingCall);
    }
  } catch {}
}

document.getElementById('navChatsTab').onclick = () => switchSideTab('chats');
document.getElementById('navCallsTab').onclick = () => switchSideTab('calls');
document.getElementById('navStoriesTab').onclick = () => switchSideTab('stories');
document.getElementById('navSettingsTab').onclick = () => switchSideTab('settings');
document.getElementById('openProfileBtn').onclick = () => switchSideTab('settings');

function switchSideTab(tab) {
  currentSideTab = tab;
  document.getElementById('navChatsTab').classList.toggle('active', tab === 'chats');
  document.getElementById('navCallsTab').classList.toggle('active', tab === 'calls');
  document.getElementById('navStoriesTab').classList.toggle('active', tab === 'stories');
  document.getElementById('navSettingsTab').classList.toggle('active', tab === 'settings');

  if (tab === 'calls') {
    missedCallCount = 0;
    updateMissedBadge();
    loadCallLogs().then(renderSidebar);
  } else if (tab === 'stories') {
    loadStories().then(renderSidebar);
  } else if (tab === 'chats') {
    loadContacts().then(renderSidebar);
  } else {
    renderSidebar();
  }
}

function updateMissedBadge() {
  const b = document.getElementById('missedBadge');
  if (!b) return;
  if (missedCallCount > 0) { b.textContent = String(missedCallCount); b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

document.getElementById('enablePushBtn').onclick = async () => {
  if (!('Notification' in window)) return alert('Tarayıcınız bildirimleri desteklemiyor.');
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    document.getElementById('pushBanner').classList.add('hidden');
    await registerWebPush();
  }
};

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

async function registerWebPush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/vapid-key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
    }
    await api('/api/push/subscribe', 'POST', { subscription: sub.toJSON(), deviceType });
  } catch {}
}

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/?token=${encodeURIComponent(token)}&deviceType=${deviceType}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'VISIBILITY', visible: !document.hidden }));
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PING' }));
    }, 15000);
  };

  ws.onclose = () => setTimeout(connectWebSocket, 2000);

  ws.onmessage = async (ev) => {
    const data = JSON.parse(ev.data);

    if (data.type === 'PRESENCE') {
      const c = contacts.find((x) => x.id === data.userId);
      if (c) {
        c.online = data.online;
        if (currentSideTab === 'chats') renderSidebar();
        if (activePeer && activePeer.id === c.id) updateChatHeader();
      }
    } else if (data.type === 'CONTACT_JOINED') {
      await loadContacts();
      if (currentSideTab === 'chats') renderSidebar();
    } else if (data.type === 'NEW_ENCRYPTED_MESSAGE') {
      await loadContacts();
      if (currentSideTab === 'chats') renderSidebar();
      if (activePeer) {
        const updatedPeer = contacts.find((c) => c.id === activePeer.id || c.phone === activePeer.phone);
        if (updatedPeer) {
          activePeer = updatedPeer;
          updateChatHeader();
        }
        if (activePeer.id === data.message.sender_id) {
          await loadMessages(activePeer.id);
        }
      }
    } else if (data.type === 'CALL_OFFER') {
      if (deviceType === 'desktop' && document.hidden) return;
      if (activeCall || (incomingOffer && incomingOffer.callId === data.callId)) return;
      incomingOffer = data;
      showIncomingCallScreen(data);
    } else if (data.type === 'CALL_ANSWER') {
      stopRingtone();
      if (activeCall) activeCall.answered = true;
      document.getElementById('callStatusText').textContent = '🟢 Görüşme Aktif';
      if (pc && data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const cand of pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        pendingCandidates = [];
      }
      startWsMediaRelay();
    } else if (data.type === 'ICE_CANDIDATE' && data.candidate) {
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      } else {
        pendingCandidates.push(data.candidate);
      }
    } else if (data.type === 'CALL_MEDIA') {
      handleIncomingWsMedia(data);
    } else if (data.type === 'CALL_MISSED') {
      closeCallScreen();
      missedCallCount++;
      updateMissedBadge();
      await loadCallLogs();
      if (currentSideTab === 'calls') renderSidebar();
      alert(`📵 Cevapsız Arama: ${data.fromDisplayName || 'Biri'} sizi aradı.`);
    } else if (data.type === 'CALL_REJECT') {
      closeCallScreen();
      alert('❌ Aradığınız kişi aramayı reddetti.');
    } else if (data.type === 'CALL_END') {
      closeCallScreen();
    }
  };
}

async function loadContacts() {
  const data = await api('/api/contacts');
  contacts = data.contacts || [];
  discoverableUsers = data.discoverable || [];
}
async function loadStories() {
  const data = await api('/api/stories');
  stories = data.stories || [];
}
async function loadCallLogs() {
  const data = await api('/api/calls');
  callLogs = data.calls || [];
}

function renderSidebar() {
  const listEl = document.getElementById('sidebarContent');
  listEl.innerHTML = '';

  if (currentSideTab === 'chats') {
    if (contacts.length === 0 && discoverableUsers.length === 0) {
      listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">Henüz kişi yok. Sağ üstten <b>➕ Kişi</b> butonuna basarak rehberden veya numaradan kişi ekleyin.</div>';
      return;
    }

    for (const c of contacts) {
      const div = document.createElement('div');
      div.className = 'contact-item' + (activePeer && activePeer.id === c.id ? ' active' : '');
      const statusBadge = c.isRegistered ? (c.online ? '🟢 Çevrimiçi' : '🔴 Çevrimdışı') : '⏳ Davet Et';
      const avatarInner = c.avatarUrl ? `<img src="${escapeHtml(c.avatarUrl)}" />` : c.display_name[0].toUpperCase();
      div.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;min-width:0;">
          <div class="avatar" style="background:${c.avatarColor}">${avatarInner}<span class="dot ${c.online ? 'on' : 'off'}"></span></div>
          <div style="min-width:0;">
            <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.display_name)}</div>
            <div style="font-size:12px;color:var(--muted);">${escapeHtml(c.phone)} • ${statusBadge}</div>
          </div>
        </div>
      `;
      div.onclick = () => openChat(c);
      listEl.appendChild(div);
    }

    if (discoverableUsers.length > 0) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'padding:10px 14px;font-size:12px;font-weight:700;color:var(--accent);background:var(--bg);border-bottom:1px solid var(--border);';
      hdr.textContent = '🌐 Uygulamayı Kullanan Diğer Kişiler (Rehbere Ekle)';
      listEl.appendChild(hdr);

      for (const u of discoverableUsers) {
        const div = document.createElement('div');
        div.className = 'contact-item';
        const avatarInner = u.avatarUrl ? `<img src="${escapeHtml(u.avatarUrl)}" />` : u.display_name[0].toUpperCase();
        div.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;min-width:0;">
            <div class="avatar" style="background:${u.avatarColor}">${avatarInner}</div>
            <div style="min-width:0;">
              <div style="font-weight:700;">${escapeHtml(u.display_name)}</div>
              <div style="font-size:12px;color:var(--muted);">${escapeHtml(u.phone)}</div>
            </div>
          </div>
          <button class="btn-sm" style="flex-shrink:0;">➕ Rehbere Ekle</button>
        `;
        div.querySelector('button').onclick = async (e) => {
          e.stopPropagation();
          await saveNewContactsWithRetry({ contacts: [{ name: u.display_name, phone: u.phone }] });
        };
        listEl.appendChild(div);
      }
    }
    return;
  }

  if (currentSideTab === 'calls') {
    if (callLogs.length === 0) {
      listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">Henüz arama geçmişi bulunmuyor.</div>';
      return;
    }
    for (const cl of callLogs) {
      const isOutgoing = cl.caller_id === me.id;
      const otherName = isOutgoing ? cl.callee_name : cl.caller_name;
      const otherPhone = isOutgoing ? cl.callee_phone : cl.caller_phone;
      const timeStr = new Date(cl.created_at + 'Z').toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
      const statusHtml = cl.status === 'missed'
        ? `<span style="color:#ef4444;font-weight:700;">📵 ${isOutgoing ? 'Cevap Verilmedi' : 'Cevapsız Arama'}</span>`
        : cl.status === 'rejected'
        ? `<span style="color:#f59e0b;">❌ Reddedildi</span>`
        : `<span style="color:#22c55e;">✅ ${isOutgoing ? 'Giden' : 'Gelen'} (${cl.duration_sec} sn)</span>`;

      const div = document.createElement('div');
      div.className = 'contact-item';
      div.innerHTML = `
        <div>
          <div style="font-weight:700;">${cl.call_type === 'video' ? '📹' : '📞'} ${escapeHtml(otherName)}</div>
          <div style="font-size:12px;margin-top:2px;">${statusHtml} • ${timeStr}</div>
        </div>
        <div style="font-size:12px;color:var(--muted);">${escapeHtml(otherPhone)}</div>
      `;
      listEl.appendChild(div);
    }
    return;
  }

  if (currentSideTab === 'stories') {
    const addBox = document.createElement('div');
    addBox.style.padding = '12px 14px';
    addBox.innerHTML = `<button id="openCreateStoryBtn" style="margin:0;">⭕ Yeni Durum Güncellemesi Paylaş (24 Saat)</button>`;
    listEl.appendChild(addBox);
    addBox.querySelector('#openCreateStoryBtn').onclick = () => {
      pendingStoryImageDataUrl = '';
      document.getElementById('storyCaptionInput').value = '';
      document.getElementById('storyImagePreview').textContent = '';
      document.getElementById('createStoryModal').classList.remove('hidden');
    };

    if (stories.length === 0) {
      listEl.innerHTML += '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">Son 24 saatte paylaşılan durum güncellemesi yok.</div>';
      return;
    }

    for (const s of stories) {
      const card = document.createElement('div');
      card.style.cssText = `margin:10px 14px;border-radius:14px;overflow:hidden;border:1px solid var(--border);background:${s.bg_color || '#0f766e'};`;
      const imgHtml = s.media_url ? `<img src="${escapeHtml(s.media_url)}" style="width:100%;max-height:220px;object-fit:cover;display:block;" />` : '';
      card.innerHTML = `
        ${imgHtml}
        <div style="padding:12px;background:rgba(11,20,26,0.72);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <strong>${escapeHtml(s.display_name)}</strong>
            <span style="font-size:11px;color:var(--muted);">👁️ ${s.viewCount} görüntüleme</span>
          </div>
          <p style="font-size:13.5px;">${escapeHtml(s.caption || '')}</p>
        </div>
      `;
      card.onclick = async () => {
        await api(`/api/stories/${s.id}/view`, 'POST').catch(() => {});
        await loadStories();
        renderSidebar();
      };
      listEl.appendChild(card);
    }
    return;
  }

  if (currentSideTab === 'settings') {
    const bigAvatar = me.avatar_url
      ? `<img src="${escapeHtml(me.avatar_url)}" style="width:100%;height:100%;object-fit:cover;" />`
      : (me.display_name || 'B')[0].toUpperCase();

    listEl.innerHTML = `
      <div style="padding:16px;">
        <div class="card-box" style="text-align:center;">
          <div class="avatar" style="width:84px;height:84px;font-size:32px;margin:0 auto 10px;background:${me.avatar_color};">${bigAvatar}</div>
          <button type="button" class="btn-sm" id="changeAvatarBtn">📷 Profil Fotoğrafı Seç / Değiştir</button>
        </div>
        <div class="card-box">
          <h4>👤 Profil Bilgilerim</h4>
          <input type="text" id="profNameInput" value="${escapeHtml(me.display_name)}" placeholder="Ad Soyad" style="margin-top:8px;" />
          <input type="text" id="profBioInput" value="${escapeHtml(me.bio || '')}" placeholder="Durum / Hakkımda" />
          <button type="button" id="saveProfileBtn" style="margin-bottom:0;">💾 Profili Kaydet</button>
        </div>
        <div class="card-box">
          <h4>🎨 Görünüm & Yazı Ayarları</h4>
          <button type="button" class="btn-sec" id="openAppFromSettingsBtn" style="margin-top:6px;margin-bottom:0;">🖼️ Arkaplan Fotoğrafı & Yazı Tipi/Boyutu</button>
        </div>
        <button type="button" class="btn-sm btn-sec" id="settingsChangePwBtn" style="margin-bottom:8px;">🔑 Şifre Değiştir</button>
            <button type="button" class="btn-red" id="settingsLogoutBtn">🚪 Oturumu Kapat</button>
            <button type="button" class="btn-red" id="settingsDeleteAccountBtn" style="margin-top:8px;opacity:.85;">🗑️ Hesabımı Kalıcı Olarak Sil</button>
      </div>
    `;

    listEl.querySelector('#changeAvatarBtn').onclick = () => document.getElementById('avatarFileInput').click();
    listEl.querySelector('#saveProfileBtn').onclick = async () => {
      const displayName = listEl.querySelector('#profNameInput').value.trim();
      const bio = listEl.querySelector('#profBioInput').value.trim();
      const res = await api('/api/auth/profile', 'PUT', { displayName, bio });
      me = res.user;
      updateMyAvatarUi();
      alert('✅ Profil bilgileriniz güncellendi!');
    };
    listEl.querySelector('#openAppFromSettingsBtn').onclick = () => document.getElementById('appearanceModal').classList.remove('hidden');
    listEl.querySelector('#settingsChangePwBtn').onclick = async () => {
      const oldPw = prompt('Mevcut şifreniz:');
      if (!oldPw) return;
      const newPw = prompt('Yeni şifre (en az 8 karakter):');
      if (!newPw) return;
      if (newPw.length < 8) { alert('Yeni şifre en az 8 karakter olmalıdır.'); return; }
      const newPw2 = prompt('Yeni şifreyi tekrar girin:');
      if (newPw !== newPw2) { alert('Yeni şifreler birbiriyle aynı değil.'); return; }
      try {
        let keyBackup = '';
        const kb = await api('/api/auth/key-backup');
        if (kb.keyBackup) {
          try {
            keyBackup = await e2ee.rewrapBackup(kb.keyBackup, oldPw, newPw);
          } catch {
            alert('❌ Mevcut şifreniz hatalı.');
            return;
          }
        }
        await api('/api/auth/password', 'PUT', { oldPassword: oldPw, newPassword: newPw, keyBackup });
        alert('✅ Şifreniz değiştirildi. Diğer cihazlardaki oturumlar kapatıldı; oralarda yeni şifrenizle giriş yapın.');
      } catch (err) {
        alert('❌ ' + (err && err.message ? err.message : 'Şifre değiştirilemedi.'));
      }
    };
    listEl.querySelector('#settingsDeleteAccountBtn').onclick = async () => {
      const ok = confirm('⚠️ Hesabınız KALICI olarak silinecek.\n\nTüm mesajlarınız, rehberiniz, arama geçmişiniz, durumlarınız ve dosyalarınız silinir. Bu işlem GERİ ALINAMAZ.\n\nDevam etmek istiyor musunuz?');
      if (!ok) return;
      const pw = prompt('Onaylamak için şifrenizi girin:');
      if (!pw) return;
      try {
        await api('/api/auth/account', 'DELETE', { password: pw });
      } catch (err) {
        alert('❌ ' + (err && err.message ? err.message : 'Hesap silinemedi.'));
        return;
      }
      try {
        const norm = e2ee.myPhoneNorm;
        await NexusIDB.del(`identity_${norm}`).catch(() => {});
        await NexusIDB.del(`vault_${norm}`).catch(() => {});
        await NexusIDB.del(`vaultkey_${norm}`).catch(() => {});
        Object.keys(localStorage).filter((k) => k.startsWith(`nexus_seen_peer_key_${me.id}_`)).forEach((k) => localStorage.removeItem(k));
      } catch {}
      resetSessionState();
      localStorage.removeItem('nexus_token');
      alert('✅ Hesabınız ve tüm verileriniz silindi.');
      location.reload();
    };
    listEl.querySelector('#settingsLogoutBtn').onclick = async () => {
      await api('/api/auth/logout', 'POST').catch(() => {});
      resetSessionState();
      localStorage.removeItem('nexus_token');
      location.reload();
    };
  }
}

document.getElementById('avatarFileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  compressImageToDataUrl(file, 320, 0.85, async (dataUrl) => {
    const res = await api('/api/auth/profile', 'PUT', { avatarUrl: dataUrl });
    me = res.user;
    updateMyAvatarUi();
    renderSidebar();
  });
};

document.getElementById('pickStoryImageBtn').onclick = () => document.getElementById('storyImageInput').click();
document.getElementById('storyImageInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  compressImageToDataUrl(file, 900, 0.8, (dataUrl) => {
    pendingStoryImageDataUrl = dataUrl;
    document.getElementById('storyImagePreview').textContent = '✅ Fotoğraf eklendi';
  });
};
document.getElementById('closeStoryModalBtn').onclick = () => document.getElementById('createStoryModal').classList.add('hidden');
document.getElementById('publishStoryBtn').onclick = async () => {
  const caption = document.getElementById('storyCaptionInput').value.trim();
  const bgColor = document.getElementById('storyBgColorInput').value;
  if (!caption && !pendingStoryImageDataUrl) return alert('Lütfen durum metni yazın veya fotoğraf seçin.');
  await api('/api/stories', 'POST', { caption, mediaUrl: pendingStoryImageDataUrl, bgColor });
  document.getElementById('createStoryModal').classList.add('hidden');
  await loadStories();
  renderSidebar();
};

document.getElementById('openAddContactBtn').onclick = () => document.getElementById('addContactModal').classList.remove('hidden');
document.getElementById('closeAddModalBtn').onclick = () => document.getElementById('addContactModal').classList.add('hidden');

function extractAllStringsDeep(val) {
  if (!val) return [];
  if (typeof val === 'string') return [val.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim()].filter(Boolean);
  if (Array.isArray(val) || (typeof val === 'object' && typeof val.length === 'number')) {
    const out = [];
    for (let i = 0; i < val.length; i++) out.push(...extractAllStringsDeep(val[i]));
    return out;
  }
  if (typeof val === 'object') {
    const candidate = val.value || val.number || val.tel || val.phone || val.display || val.formatted || val.name || '';
    return candidate ? [String(candidate).trim()] : [];
  }
  return [String(val).trim()].filter(Boolean);
}

function showChoosePhoneModal(contactName, phoneNumbers, callback) {
  pendingPhoneChoiceCb = callback;
  document.getElementById('choosePhoneTitle').textContent = `📱 ${contactName} — Numara Seçin`;
  document.getElementById('choosePhoneDesc').textContent = `"${contactName}" kişisinde ${phoneNumbers.length} farklı numara bulundu:`;

  const listEl = document.getElementById('choosePhoneList');
  listEl.innerHTML = phoneNumbers.map((p, i) => `
    <label class="phone-choice-row">
      <input type="radio" name="picked_phone_opt" value="${escapeHtml(p)}" ${i === 0 ? 'checked' : ''} />
      <div><strong>${escapeHtml(p)}</strong></div>
    </label>
  `).join('') + `
    <label class="phone-choice-row" style="border-style:dashed;">
      <input type="radio" name="picked_phone_opt" value="__ALL__" />
      <div><strong style="color:var(--accent);">👥 Tüm Numaraları Ekle (${phoneNumbers.length})</strong></div>
    </label>
  `;
  document.getElementById('choosePhoneModal').classList.remove('hidden');
}

document.getElementById('cancelChoosePhoneBtn').onclick = () => { document.getElementById('choosePhoneModal').classList.add('hidden'); pendingPhoneChoiceCb = null; };
document.getElementById('confirmChoosePhoneBtn').onclick = async () => {
  const checked = document.querySelector('input[name="picked_phone_opt"]:checked');
  if (!checked) return;
  const val = checked.value;
  document.getElementById('choosePhoneModal').classList.add('hidden');
  if (pendingPhoneChoiceCb) { const cb = pendingPhoneChoiceCb; pendingPhoneChoiceCb = null; await cb(val); }
};

document.getElementById('pickFromPhoneBtn').onclick = () => {
  if (!window.isSecureContext) return alert('Telefon rehberine erişmek için sayfanın HTTPS adresinden açılması gerekir.');
  if (navigator.contacts && typeof navigator.contacts.select === 'function') {
    navigator.contacts.select(['name', 'tel'], { multiple: false })
      .then(async (picked) => {
        if (!picked || picked.length === 0) return;
        const person = picked[0];
        const contactName = extractAllStringsDeep(person.name)[0] || 'Rehber Kişisi';
        const rawTels = extractAllStringsDeep(person.tel);

        const uniqueTels = [];
        const seen = new Set();
        for (const t of rawTels) {
          const digits = t.replace(/\D/g, '').slice(-10);
          if (digits.length >= 7 && !seen.has(digits)) { seen.add(digits); uniqueTels.push(t); }
        }

        document.getElementById('addContactModal').classList.add('hidden');

        if (uniqueTels.length === 0) {
          document.getElementById('newContactName').value = contactName;
          document.getElementById('addContactModal').classList.remove('hidden');
          return alert(`"${contactName}" kişisinde kayıtlı numara bulunamadı.`);
        }

        showChoosePhoneModal(contactName, uniqueTels, async (chosen) => {
          const listToSave = chosen === '__ALL__'
            ? uniqueTels.map((p, idx) => ({ name: `${contactName} (${idx + 1})`, phone: p }))
            : [{ name: contactName, phone: chosen }];
          await saveNewContactsWithRetry({ contacts: listToSave });
        });
      })
      .catch((err) => { if (err && err.name !== 'AbortError') alert('Rehber açılamadı: ' + err.message); });
  } else {
    alert('Bu cihaz doğrudan rehber penceresini desteklemiyor. "iPhone / .vcf Dosyası" veya numara kutusunu kullanın.');
  }
};

document.getElementById('pickVcfFileBtn').onclick = () => document.getElementById('vcfFileInput').click();
document.getElementById('vcfFileInput').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;
  let allText = '';
  for (const f of files) allText += '\n' + (await f.text());
  await saveNewContactsWithRetry({ rawText: allText });
};

document.getElementById('manualContactForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('newContactName').value.trim();
  const phone = document.getElementById('newContactPhone').value.trim();
  const alsoDevice = document.getElementById('alsoSaveToPhoneBook')?.checked;

  await saveNewContactsWithRetry({ contacts: [{ name, phone }] });
  if (alsoDevice && phone) {
    setTimeout(() => saveContactToDevicePhoneBook(name || phone, phone), 500);
  }
  document.getElementById('newContactName').value = '';
  document.getElementById('newContactPhone').value = '';
};

document.getElementById('bulkPasteBtn').onclick = async () => {
  const rawText = document.getElementById('bulkPasteInput').value.trim();
  if (!rawText) return alert('Lütfen en az bir numara yazın.');
  await saveNewContactsWithRetry({ rawText });
  document.getElementById('bulkPasteInput').value = '';
};

async function saveNewContactsWithRetry(payload) {
  localStorage.setItem('nexus_pending_contact_import', JSON.stringify(payload));
  await flushPendingContactImport();
}

async function flushPendingContactImport() {
  const raw = localStorage.getItem('nexus_pending_contact_import');
  if (!raw) return;
  let payload;
  try { payload = JSON.parse(raw); } catch { localStorage.removeItem('nexus_pending_contact_import'); return; }

  if (document.hidden) {
    await new Promise((resolve) => {
      const onVis = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', onVis); resolve(); } };
      document.addEventListener('visibilitychange', onVis);
    });
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      const res = await api('/api/contacts/add', 'POST', payload);
      localStorage.removeItem('nexus_pending_contact_import');
      document.getElementById('addContactModal').classList.add('hidden');
      await loadContacts();
      currentSideTab = 'chats';
      renderSidebar();

      if (res.contacts && res.contacts.length > 0) {
        const added = res.contacts[0];
        openChat(added);
        showInviteModal(added);
      }
      return;
    } catch (err) {
      if (attempt === 4) { localStorage.removeItem('nexus_pending_contact_import'); alert('Kişi eklenemedi: ' + err.message); }
    }
  }
}

function showInviteModal(contact) {
  document.getElementById('invitePreviewText').textContent = `"${contact.inviteText}"`;
  document.getElementById('inviteWaLink').href = contact.whatsappUrl;
  document.getElementById('inviteSmsLink').href = contact.smsUrl;
  const devSaveBtn = document.getElementById('inviteSaveDeviceContactBtn');
  if (devSaveBtn) {
    devSaveBtn.onclick = () => saveContactToDevicePhoneBook(contact.display_name, contact.phone);
  }
  document.getElementById('inviteModal').classList.remove('hidden');
}
document.getElementById('closeInviteModalBtn').onclick = () => document.getElementById('inviteModal').classList.add('hidden');

async function openChat(peer) {
  if (!peer.isRegistered || !peer.publicKeyJwk) {
    await loadContacts().catch(() => {});
    const refreshed = contacts.find((c) => c.id === peer.id || c.phone === peer.phone);
    if (refreshed) peer = refreshed;
  }
  activePeer = peer;
  checkPeerKeyChange(peer);
  document.getElementById('appScreen').classList.add('mobile-chat');
  document.getElementById('chatHeaderActions').classList.remove('hidden');
  document.getElementById('peerAvatarBox').classList.remove('hidden');
  updateChatHeader();
  if (currentSideTab === 'chats') renderSidebar();

  document.getElementById('msgInput').disabled = false;
  document.getElementById('sendBtn').disabled = false;
  document.getElementById('attachBtn').disabled = false;
  document.getElementById('msgInput').placeholder = peer.online
    ? 'Uçtan uca şifreli mesaj yazın...'
    : 'Çevrimdışı — Mesajınız iletilecek ve bildirim gidecek...';

  await loadMessages(peer.id);
}

function updateChatHeader() {
  if (!activePeer) return;
  const pAv = document.getElementById('peerAvatarBox');
  if (activePeer.avatarUrl) pAv.innerHTML = `<img src="${escapeHtml(activePeer.avatarUrl)}" />`;
  else {
    pAv.textContent = (activePeer.display_name || 'K')[0].toUpperCase();
    pAv.style.background = activePeer.avatarColor || '#00a884';
  }
  document.getElementById('peerNameLabel').textContent = activePeer.display_name;
  document.getElementById('peerStatusLabel').textContent = activePeer.isRegistered
    ? (activePeer.online ? `🟢 Çevrimiçi • ${activePeer.phone}` : `🔴 Çevrimdışı • ${activePeer.phone}`)
    : `⏳ Henüz katılmadı • ${activePeer.phone}`;

  const devBtn = document.getElementById('saveToDeviceContactsBtn');
  if (devBtn) devBtn.onclick = () => saveContactToDevicePhoneBook(activePeer.display_name, activePeer.phone);
  document.getElementById('waInviteBtn').onclick = () => window.open(activePeer.whatsappUrl, '_blank');
  document.getElementById('smsInviteBtn').onclick = () => { location.href = activePeer.smsUrl; };
}

document.getElementById('backBtn').onclick = () => document.getElementById('appScreen').classList.remove('mobile-chat');

document.getElementById('attachBtn').onclick = () => document.getElementById('attachMenu').classList.toggle('hidden');
document.getElementById('sendImageOpt').onclick = () => { document.getElementById('attachMenu').classList.add('hidden'); document.getElementById('imageFileInput').click(); };
document.getElementById('imageFileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !activePeer) return;
  e.target.value = '';
  await uploadAndSendEncryptedMedia(file, 'image');
};

document.getElementById('sendFileOpt').onclick = () => { document.getElementById('attachMenu').classList.add('hidden'); document.getElementById('anyFileInput').click(); };
document.getElementById('anyFileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !activePeer) return;
  e.target.value = '';
  await uploadAndSendEncryptedMedia(file, 'file');
};

async function uploadAndSendEncryptedMedia(file, kind) {
  if (file.size > 20 * 1024 * 1024) return alert('Dosya boyutu en fazla 20 MB olabilir.');
  const buf = await file.arrayBuffer();
  const encBlob = await e2ee.encryptFileBlob(buf);
  const up = await api('/api/blobs', 'POST', { encryptedBase64: encBlob.encryptedBase64 });

  await sendEncryptedEnvelope(kind, {
    kind,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    fileSize: file.size,
    blobUrl: up.blobUrl,
    mediaKeyB64: encBlob.mediaKeyB64,
    mediaIvB64: encBlob.mediaIvB64,
    sha256B64: encBlob.sha256B64
  }, 0);
}

document.getElementById('sendContactCardOpt').onclick = () => {
  document.getElementById('attachMenu').classList.add('hidden');
  const box = document.getElementById('shareContactList');

  if (contacts.length === 0) {
    box.innerHTML = '<div style="font-size:12.5px;color:var(--muted);padding:8px;">Uygulama rehberinizde kayıtlı kişi yok. Yukarıdaki butondan telefon rehberinden seçebilirsiniz.</div>';
  } else {
    box.innerHTML = contacts.map((c) => `
      <div class="phone-choice-row" data-cid="${c.id}">
        <div><strong>👤 ${escapeHtml(c.display_name)}</strong><div style="font-size:12px;color:var(--muted);">${escapeHtml(c.phone)}</div></div>
      </div>
    `).join('');

    box.querySelectorAll('.phone-choice-row').forEach((row) => {
      row.onclick = async () => {
        const c = contacts.find((x) => x.id === row.dataset.cid);
        document.getElementById('shareContactModal').classList.add('hidden');
        if (c) await sendEncryptedEnvelope('contact', { kind: 'contact', contactName: c.display_name, contactPhone: c.phone }, 0);
      };
    });
  }
  document.getElementById('shareContactModal').classList.remove('hidden');
};

document.getElementById('shareFromDevicePhoneBtn').onclick = () => {
  if (!navigator.contacts || typeof navigator.contacts.select !== 'function') {
    return alert('Bu tarayıcı doğrudan rehber erişimini desteklemiyor. Aşağıdaki listeden kişi seçebilirsiniz.');
  }
  navigator.contacts.select(['name', 'tel'], { multiple: false })
    .then(async (picked) => {
      if (!picked || picked.length === 0) return;
      const person = picked[0];
      const contactName = extractAllStringsDeep(person.name)[0] || 'Kişi';
      const rawTels = extractAllStringsDeep(person.tel);
      const uniqueTels = [...new Set(rawTels.filter(Boolean))];
      document.getElementById('shareContactModal').classList.add('hidden');
      if (uniqueTels.length === 0) return alert('Seçilen kişide telefon numarası bulunamadı.');
      if (uniqueTels.length > 1) {
        showChoosePhoneModal(contactName, uniqueTels, async (chosen) => {
          const phoneToSend = chosen === '__ALL__' ? uniqueTels.join(', ') : chosen;
          await sendEncryptedEnvelope('contact', { kind: 'contact', contactName, contactPhone: phoneToSend }, 0);
        });
      } else {
        await sendEncryptedEnvelope('contact', { kind: 'contact', contactName, contactPhone: uniqueTels[0] }, 0);
      }
    })
    .catch(() => {});
};
document.getElementById('closeShareContactBtn').onclick = () => document.getElementById('shareContactModal').classList.add('hidden');

document.getElementById('sendLocationOpt').onclick = () => {
  document.getElementById('attachMenu').classList.add('hidden');
  if (!navigator.geolocation) return alert('Cihazınız konum servisini desteklemiyor.');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      await sendEncryptedEnvelope('location', { kind: 'location', lat, lng, mapUrl: `https://maps.google.com/?q=${lat},${lng}` }, 0);
    },
    (err) => alert('Konum alınamadı: ' + err.message),
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

async function sendEncryptedEnvelope(msgType, payloadObj, ttlMs) {
  if (!activePeer) return;
  let enc;
  try {
    enc = await e2ee.encryptMessage(activePeer.id, activePeer.publicKeyJwk || '', payloadObj, activePeer.phone || '');
  } catch (err) {
    alert('🔒 ' + (err && err.message ? err.message : 'Mesaj şifrelenemedi.'));
    return;
  }
  const res = await api(`/api/messages/${activePeer.id}`, 'POST', {
    msgType,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    msgNum: enc.msgNum,
    senderPublicKeyJwk: enc.senderPublicKeyJwk,
    recipientPublicKeyJwk: enc.recipientPublicKeyJwk,
    ttlMs
  });
  e2ee.saveToVault(res.message.id, payloadObj);
  await loadMessages(activePeer.id);
}

async function loadMessages(peerId) {
  const data = await api(`/api/messages/${peerId}`);
  const feed = document.getElementById('msgFeed');
  feed.innerHTML = '';

  for (const row of data.messages || []) {
    const isMine = row.sender_id === me.id;
    let plain = { kind: 'text', text: '🔒 [Şifreli Mesaj]' };
    try { plain = await e2ee.decryptMessage(me.id, activePeer.publicKeyJwk || '', row, activePeer.phone || ''); } catch {}

    const div = document.createElement('div');
    div.className = 'msg ' + (isMine ? 'out' : 'in');
    const time = new Date(row.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let innerHtml = '';

    if (plain.kind === 'image' && plain.blobUrl) {
      const imgId = 'img_' + row.id;
      innerHtml = `<img id="${imgId}" alt="${escapeHtml(plain.fileName || 'Fotoğraf')}" /><div style="font-size:12px;">🖼️ ${escapeHtml(plain.fileName || 'Fotoğraf')}</div>`;
      setTimeout(() => decryptAndRenderBlobImage(imgId, plain), 10);
    } else if (plain.kind === 'file' && plain.blobUrl) {
      const kb = Math.max(1, Math.round((plain.fileSize || 1024) / 1024));
      innerHtml = `
        <div class="rich-card">
          <div class="rich-card-title">📄 ${escapeHtml(plain.fileName)}</div>
          <div class="rich-card-sub">${kb} KB • Uçtan Uca Şifreli Dosya</div>
          <button type="button" class="rich-card-btn" data-dl="${row.id}">⬇️ Şifreyi Çöz ve İndir</button>
        </div>
      `;
      setTimeout(() => {
        const btn = div.querySelector(`[data-dl="${row.id}"]`);
        if (btn) btn.onclick = () => downloadDecryptedBlobFile(plain);
      }, 10);
    } else if (plain.kind === 'contact') {
      innerHtml = `
        <div class="rich-card">
          <div class="rich-card-title">👤 ${escapeHtml(plain.contactName)}</div>
          <div class="rich-card-sub">📞 ${escapeHtml(plain.contactPhone)}</div>
          <button type="button" class="rich-card-btn" data-addc="${row.id}">➕ Rehberime Kaydet</button>
        </div>
      `;
      setTimeout(() => {
        const btn = div.querySelector(`[data-addc="${row.id}"]`);
        if (btn) btn.onclick = () => saveNewContactsWithRetry({ contacts: [{ name: plain.contactName, phone: plain.contactPhone }] });
      }, 10);
    } else if (plain.kind === 'location') {
      innerHtml = `
        <div class="rich-card">
          <div class="rich-card-title">📍 Paylaşılan Konum</div>
          <div class="rich-card-sub">Enlem: ${escapeHtml(plain.lat)} • Boylam: ${escapeHtml(plain.lng)}</div>
          <a href="${plain.mapUrl}" target="_blank" rel="noopener" class="rich-card-btn">🗺️ Haritada Aç</a>
        </div>
      `;
    } else {
      innerHtml = `<div>${escapeHtml(plain.text || '')}</div>`;
    }

    div.innerHTML = `${innerHtml}<div class="msg-meta">🔒 ${time}</div>`;
    feed.appendChild(div);

    if (row.ttl_ms > 0) {
      setTimeout(() => { div.innerHTML = '<div>💥 [Süresi dolduğu için silindi]</div>'; }, row.ttl_ms);
    }
  }
  feed.scrollTop = feed.scrollHeight;
}

const blobObjectUrlCache = new Map();
async function decryptAndRenderBlobImage(imgElementId, meta) {
  const el = document.getElementById(imgElementId);
  if (!el) return;
  if (blobObjectUrlCache.has(meta.blobUrl)) { el.src = blobObjectUrlCache.get(meta.blobUrl); return; }
  try {
    const resp = await fetch(meta.blobUrl);
    const encBuf = await resp.arrayBuffer();
    const plainBuf = await e2ee.decryptFileBlob(encBuf, meta.mediaKeyB64, meta.mediaIvB64, meta.sha256B64);
    const url = URL.createObjectURL(new Blob([plainBuf], { type: meta.mimeType || 'image/jpeg' }));
    blobObjectUrlCache.set(meta.blobUrl, url);
    el.src = url;
    el.onclick = () => window.open(url, '_blank');
  } catch {}
}

async function downloadDecryptedBlobFile(meta) {
  try {
    const resp = await fetch(meta.blobUrl);
    const encBuf = await resp.arrayBuffer();
    const plainBuf = await e2ee.decryptFileBlob(encBuf, meta.mediaKeyB64, meta.mediaIvB64, meta.sha256B64);
    const url = URL.createObjectURL(new Blob([plainBuf], { type: meta.mimeType || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = meta.fileName || 'dosya'; a.click();
  } catch (err) { alert('Dosya çözülemedi: ' + err.message); }
}

document.getElementById('sendBtn').onclick = sendTextMessage;
document.getElementById('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTextMessage(); });
async function sendTextMessage() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  const ttlMs = Number(document.getElementById('ttlSelect').value);
  if (!text || !activePeer) return;
  input.value = '';
  await sendEncryptedEnvelope('text', { kind: 'text', text }, ttlMs);
}

// --- AHİZE / HANDSFREE SES YÖNLENDİRME VE KESİNTİSİZ ARAMA ---
function ensureAudioEngine() {
  if (!callAudioCtx || callAudioCtx.state === 'closed') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    callAudioCtx = new Ctx();
    speakerGain = callAudioCtx.createGain();
    speakerGain.gain.value = isHandsfreeOn ? 3.2 : 0.55;
    speakerGain.connect(callAudioCtx.destination);
    nextPlayTime = 0;
  }
  if (callAudioCtx.state === 'suspended') callAudioCtx.resume().catch(() => {});
  return callAudioCtx;
}

async function applyAudioRouting() {
  const btn = document.getElementById('toggleSpeakerBtn');
  if (btn) {
    btn.textContent = isHandsfreeOn ? '🔊 Handsfree: Açık' : '🔈 Ahize (Hoparlör Kapalı)';
    btn.style.background = isHandsfreeOn ? '#10b981' : '';
    btn.style.color = isHandsfreeOn ? '#0b141a' : '';
  }

  const remoteVid = document.getElementById('remoteVideo');
  const remoteAud = document.getElementById('remoteAudio');
  const targetVol = isHandsfreeOn ? 1.0 : 0.35;
  if (remoteVid) remoteVid.volume = targetVol;
  if (remoteAud) remoteAud.volume = targetVol;

  if (speakerGain && callAudioCtx) {
    speakerGain.gain.setValueAtTime(isHandsfreeOn ? 3.2 : 0.55, callAudioCtx.currentTime);
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId);
      if (outputs.length > 0) {
        const chosen = isHandsfreeOn
          ? (outputs.find((d) => /speaker|hoparlör|hands-free|loud/i.test(d.label || '')) || outputs[outputs.length - 1])
          : (outputs.find((d) => /earpiece|ahize|receiver|communications/i.test(d.label || '')) || outputs[0]);
        if (chosen && chosen.deviceId) {
          if (remoteVid && typeof remoteVid.setSinkId === 'function') await remoteVid.setSinkId(chosen.deviceId).catch(() => {});
          if (remoteAud && typeof remoteAud.setSinkId === 'function') await remoteAud.setSinkId(chosen.deviceId).catch(() => {});
        }
      }
    } catch {}
  }
}

document.getElementById('toggleSpeakerBtn').onclick = async () => {
  isHandsfreeOn = !isHandsfreeOn;
  ensureAudioEngine();
  await applyAudioRouting();
};

function startRingCycle(mode = 'outgoing') {
  stopRingtone();
  ringCount = 0;

  const doRingOnce = () => {
    ringCount++;
    const statusEl = document.getElementById('callStatusText');
    if (statusEl && (!activeCall || !activeCall.answered)) {
      statusEl.textContent = mode === 'outgoing'
        ? `📞 Çalıyor... (${ringCount} / ${MAX_RINGS})`
        : `📲 Gelen Arama Çalıyor... (${ringCount} / ${MAX_RINGS})`;
    }

    if (ringCount > MAX_RINGS) {
      stopRingtone();
      if (mode === 'outgoing' && activeCall && !activeCall.answered) {
        const missedCallId = activeCall.callId;
        const targetId = activeCall.targetUserId;
        const cType = activeCall.callType;

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CALL_MISSED', callId: missedCallId, targetUserId: targetId, callType: cType }));
        }
        closeCallScreen();
        loadCallLogs();
        alert('📵 Aradığınız kişi cevap vermiyor.');
      } else if (mode === 'incoming') {
        closeCallScreen();
        missedCallCount++;
        updateMissedBadge();
        loadCallLogs();
      }
      return;
    }

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = mode === 'incoming' ? 680 : 460;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
      if (mode === 'incoming' && 'vibrate' in navigator) navigator.vibrate([500, 200, 500]);
    } catch {}
  };

  doRingOnce();
  ringInterval = setInterval(doRingOnce, 2400);
}

function stopRingtone() {
  if (ringInterval) clearInterval(ringInterval);
  ringInterval = null;
}

async function getUserMediaSafe(callType) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: callType === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch {
    try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch { return null; }
  }
}

async function attachLocalPreview(stream) {
  const localVid = document.getElementById('localVideo');
  const hasVid = Boolean(stream && stream.getVideoTracks().length > 0);
  localVid.muted = true;
  localVid.playsInline = true;
  localVid.srcObject = stream;
  localVid.classList.toggle('hidden', !hasVid);
  if (hasVid) {
    await localVid.play().catch(() => {});
    if (!captureVideoEl) {
      captureVideoEl = document.createElement('video');
      captureVideoEl.muted = true;
      captureVideoEl.playsInline = true;
      captureVideoEl.autoplay = true;
    }
    captureVideoEl.srcObject = stream;
    await captureVideoEl.play().catch(() => {});
  }
}

async function setupPeerConnection(targetUserId, callId) {
  if (pc) try { pc.close(); } catch {}
  remoteStream = new MediaStream();

  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  });

  pc.onicecandidate = (ev) => {
    if (ev.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ICE_CANDIDATE', callId, targetUserId, candidate: ev.candidate }));
    }
  };

  pc.ontrack = (ev) => {
    if (ev.track) remoteStream.addTrack(ev.track);
    const stream = (ev.streams && ev.streams[0]) ? ev.streams[0] : remoteStream;
    const remoteVid = document.getElementById('remoteVideo');
    const remoteAud = document.getElementById('remoteAudio');
    remoteVid.srcObject = stream;
    remoteAud.srcObject = stream;
    remoteVid.muted = false;
    remoteAud.muted = false;
    applyAudioRouting();
    remoteVid.play().catch(() => {});
    remoteAud.play().catch(() => {});
    if (ev.track && ev.track.kind === 'video') {
      document.getElementById('callCenterAvatar').classList.add('hidden');
    }
  };

  if (statsInterval) clearInterval(statsInterval);
  lastAudioBytes = 0; lastVideoBytes = 0;
  statsInterval = setInterval(async () => {
    if (!pc || !activeCall) return;
    try {
      const stats = await pc.getStats();
      let aBytes = 0, vBytes = 0;
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && !r.isRemote) {
          if ((r.kind || r.mediaType) === 'audio') aBytes += Number(r.bytesReceived || 0);
          if ((r.kind || r.mediaType) === 'video') vBytes += Number(r.bytesReceived || 0);
        }
      });
      webrtcAudioActive = (aBytes - lastAudioBytes) > 500;
      webrtcVideoActive = (vBytes - lastVideoBytes) > 1500;
      lastAudioBytes = aBytes; lastVideoBytes = vBytes;
      if (webrtcVideoActive) {
        document.getElementById('remoteRelayImg').classList.add('hidden');
        document.getElementById('callCenterAvatar').classList.add('hidden');
      }
    } catch {}
  }, 1000);
}

function startWsMediaRelay() {
  stopWsMediaRelay();
  if (!localStream || !activeCall) return;

  try {
    const aTrack = localStream.getAudioTracks()[0];
    if (aTrack) {
      const ctx = ensureAudioEngine();
      const src = ctx.createMediaStreamSource(new MediaStream([aTrack]));
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const ratio = (ctx.sampleRate || 48000) / 12000;

      proc.onaudioprocess = (e) => {
        if (!activeCall || !ws || ws.readyState !== WebSocket.OPEN) return;
        const track = localStream?.getAudioTracks()[0];
        if (!track || !track.enabled) return;

        const input = e.inputBuffer.getChannelData(0);
        const outLen = Math.floor(input.length / ratio);
        const pcm16 = new Int16Array(outLen);
        let maxAmp = 0;
        for (let i = 0; i < outLen; i++) {
          const s = Math.max(-1, Math.min(1, (input[Math.floor(i * ratio)] || 0) * 1.5));
          if (Math.abs(s) > maxAmp) maxAmp = Math.abs(s);
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        if (maxAmp < 0.002) return;

        const bytes = new Uint8Array(pcm16.buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        ws.send(JSON.stringify({ type: 'CALL_MEDIA', kind: 'audio', targetUserId: activeCall.targetUserId, pcmB64: btoa(bin) }));
      };

      const zeroGain = ctx.createGain();
      zeroGain.gain.value = 0;
      src.connect(proc);
      proc.connect(zeroGain);
      zeroGain.connect(ctx.destination);
      wsAudioProc = { src, proc, zeroGain };
    }
  } catch {}

  const vTrack = localStream.getVideoTracks()[0];
  if (vTrack) {
    const canvas = document.createElement('canvas');
    canvas.width = 280; canvas.height = 360;
    const c2d = canvas.getContext('2d');

    wsVideoTimer = setInterval(() => {
      if (!activeCall || !ws || ws.readyState !== WebSocket.OPEN) return;
      const vt = localStream?.getVideoTracks()[0];
      const srcEl = captureVideoEl || document.getElementById('localVideo');
      if (!vt || !vt.enabled || !srcEl) return;
      if (srcEl.paused) srcEl.play().catch(() => {});
      if (srcEl.readyState < 2) return;

      try {
        const vw = srcEl.videoWidth || 280;
        const vh = srcEl.videoHeight || 360;
        canvas.width = 280;
        canvas.height = Math.round((280 * vh) / vw) || 360;
        c2d.drawImage(srcEl, 0, 0, canvas.width, canvas.height);
        ws.send(JSON.stringify({
          type: 'CALL_MEDIA',
          kind: 'video',
          targetUserId: activeCall.targetUserId,
          frameUrl: canvas.toDataURL('image/jpeg', 0.52)
        }));
      } catch {}
    }, 200);
  }
}

function stopWsMediaRelay() {
  if (wsAudioProc) {
    try { wsAudioProc.src.disconnect(); wsAudioProc.proc.disconnect(); wsAudioProc.zeroGain.disconnect(); } catch {}
    wsAudioProc = null;
  }
  if (wsVideoTimer) { clearInterval(wsVideoTimer); wsVideoTimer = null; }
}

function handleIncomingWsMedia(ev) {
  if (!activeCall) return;
  if (!activeCall.answered) {
    activeCall.answered = true;
    stopRingtone();
    document.getElementById('callStatusText').textContent = '🟢 Görüşme Aktif';
    if (!wsAudioProc && !wsVideoTimer) startWsMediaRelay();
  }

  if (ev.kind === 'audio' && ev.pcmB64 && !webrtcAudioActive) {
    try {
      const ctx = ensureAudioEngine();
      const bin = atob(ev.pcmB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const pcm16 = new Int16Array(bytes.buffer);
      const buf = ctx.createBuffer(1, pcm16.length, 12000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm16.length; i++) ch[i] = pcm16[i] / 32768.0;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(speakerGain);
      const now = ctx.currentTime;
      if (nextPlayTime < now || nextPlayTime > now + 0.5) nextPlayTime = now + 0.03;
      src.start(nextPlayTime);
      nextPlayTime += buf.duration;
    } catch {}
  } else if (ev.kind === 'video' && ev.frameUrl && !webrtcVideoActive) {
    const img = document.getElementById('remoteRelayImg');
    img.src = ev.frameUrl;
    img.classList.remove('hidden');
    document.getElementById('callCenterAvatar').classList.add('hidden');
  }
}

document.getElementById('audioCallBtn').onclick = () => initiateCall('audio');
document.getElementById('videoCallBtn').onclick = () => initiateCall('video');

async function initiateCall(callType) {
  if (!activePeer) return alert('Lütfen aramak istediğiniz kişiyi seçin.');
  const callId = 'call_' + Date.now();
  isHandsfreeOn = false;
  ensureAudioEngine();
  await applyAudioRouting();
  document.getElementById('remoteVideo').play().catch(() => {});
  document.getElementById('remoteAudio').play().catch(() => {});

  activeCall = { callId, targetUserId: activePeer.id, callType, answered: false, startedAt: Date.now() };
  document.getElementById('callScreen').classList.remove('hidden');
  document.getElementById('incomingCallControls').classList.add('hidden');
  document.getElementById('activeCallControls').classList.remove('hidden');
  document.getElementById('remoteRelayImg').classList.add('hidden');
  document.getElementById('callCenterAvatar').classList.remove('hidden');
  document.getElementById('callPeerTitle').textContent = activePeer.display_name;
  document.getElementById('callPeerBigAvatar').textContent = activePeer.display_name[0].toUpperCase();

  startRingCycle('outgoing');

  localStream = await getUserMediaSafe(callType);
  await attachLocalPreview(localStream);

  await setupPeerConnection(activePeer.id, callId);
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: callType === 'video' });
  await pc.setLocalDescription(offer);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'CALL_OFFER', callId, targetUserId: activePeer.id, callType, sdp: offer }));
  }
  await api('/api/calls/offer', 'POST', { callId, targetUserId: activePeer.id, callType, sdp: offer }).catch(() => {});
}

function showIncomingCallScreen(offerData) {
  document.getElementById('callScreen').classList.remove('hidden');
  document.getElementById('incomingCallControls').classList.remove('hidden');
  document.getElementById('activeCallControls').classList.add('hidden');
  document.getElementById('remoteRelayImg').classList.add('hidden');
  document.getElementById('callCenterAvatar').classList.remove('hidden');
  document.getElementById('callPeerTitle').textContent = offerData.fromDisplayName || offerData.callerName || 'Gelen Arama';
  document.getElementById('callPeerBigAvatar').textContent = (offerData.fromDisplayName || offerData.callerName || 'A')[0].toUpperCase();
  startRingCycle('incoming');
}

document.getElementById('acceptCallBtn').onclick = acceptIncomingCall;
async function acceptIncomingCall() {
  if (!incomingOffer) return;
  stopRingtone();
  const offer = incomingOffer;
  incomingOffer = null;
  const callerId = offer.fromUserId || offer.callerId;
  isHandsfreeOn = false;
  ensureAudioEngine();
  await applyAudioRouting();
  document.getElementById('remoteVideo').play().catch(() => {});
  document.getElementById('remoteAudio').play().catch(() => {});

  activeCall = { callId: offer.callId, targetUserId: callerId, callType: offer.callType, answered: true, startedAt: Date.now() };
  document.getElementById('incomingCallControls').classList.add('hidden');
  document.getElementById('activeCallControls').classList.remove('hidden');
  document.getElementById('callStatusText').textContent = '🟢 Görüşme Aktif';

  localStream = await getUserMediaSafe(offer.callType);
  await attachLocalPreview(localStream);

  await setupPeerConnection(callerId, offer.callId);
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
  for (const cand of pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
  pendingCandidates = [];

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'CALL_ANSWER', callId: offer.callId, targetUserId: callerId, sdp: answer }));
  }
  startWsMediaRelay();
}

document.getElementById('rejectCallBtn').onclick = async () => {
  if (incomingOffer) {
    const callerId = incomingOffer.fromUserId || incomingOffer.callerId;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'CALL_REJECT', callId: incomingOffer.callId, targetUserId: callerId }));
    }
    await api('/api/calls/log', 'POST', {
      callId: incomingOffer.callId, callerId, calleeId: me.id, callType: incomingOffer.callType, status: 'rejected', durationSec: 0
    }).catch(() => {});
  }
  closeCallScreen();
};

document.getElementById('hangupCallBtn').onclick = async () => {
  if (activeCall) {
    const dur = activeCall.answered ? Math.max(1, Math.round((Date.now() - activeCall.startedAt) / 1000)) : 0;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: activeCall.answered ? 'CALL_END' : 'CALL_MISSED',
        callId: activeCall.callId,
        targetUserId: activeCall.targetUserId,
        callType: activeCall.callType
      }));
    }
    if (activeCall.answered) {
      await api('/api/calls/log', 'POST', {
        callId: activeCall.callId, callerId: me.id, calleeId: activeCall.targetUserId, callType: activeCall.callType, status: 'completed', durationSec: dur
      }).catch(() => {});
    }
  }
  closeCallScreen();
};

document.getElementById('toggleMicBtn').onclick = () => {
  const t = localStream?.getAudioTracks()[0];
  if (t) t.enabled = !t.enabled;
};
document.getElementById('toggleCamBtn').onclick = () => {
  const t = localStream?.getVideoTracks()[0];
  if (t) t.enabled = !t.enabled;
};

function closeCallScreen() {
  stopRingtone();
  stopWsMediaRelay();
  if (statsInterval) clearInterval(statsInterval);
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  if (captureVideoEl) captureVideoEl.srcObject = null;
  if (pc) pc.close();
  pc = null;
  activeCall = null;
  incomingOffer = null;
  webrtcAudioActive = false;
  webrtcVideoActive = false;
  document.getElementById('callScreen').classList.add('hidden');
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}


// ---- Güvenlik numarası ve anahtar değişikliği uyarısı ----
function checkPeerKeyChange(peer) {
  if (!peer || !peer.publicKeyJwk || !me) return;
  let fp = '';
  try { const j = JSON.parse(peer.publicKeyJwk); fp = `${j.x}:${j.y}`; } catch { return; }
  const k = `nexus_seen_peer_key_${me.id}_${peer.id}`;
  const prev = localStorage.getItem(k);
  if (prev && prev !== fp) {
    alert(`⚠️ ${peer.display_name} kişisinin güvenlik numarası değişti.\n\nKişi yeni bir cihaz kurmuş olabilir. Emin olmak için sohbet başlığında kişinin adına dokunup güvenlik numarasını karşılaştırın.`);
  }
  localStorage.setItem(k, fp);
}

(() => {
  const nameEl = document.getElementById('peerNameLabel');
  if (!nameEl) return;
  nameEl.style.cursor = 'pointer';
  nameEl.title = 'Güvenlik numarasını göster';
  nameEl.onclick = async () => {
    if (!activePeer) return;
    if (!activePeer.publicKeyJwk) { alert('Bu kişinin şifreleme anahtarı yok.'); return; }
    try {
      const sn = await e2ee.computeSafetyNumber(activePeer.publicKeyJwk);
      alert(`🔐 Güvenlik Numarası — ${activePeer.display_name}\n\n${sn}\n\nBu numara iki telefonda da AYNI olmalı. Yüz yüze veya telefonda karşılaştırın; aynıysa mesajlarınızı aranızda kimse okuyamaz.`);
    } catch {
      alert('Güvenlik numarası hesaplanamadı.');
    }
  };
})();
