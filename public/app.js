const e2ee = new NexusE2EE();
const isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
const deviceType = isMobileDevice ? 'mobile' : 'desktop';

let token = localStorage.getItem('nexus_token') || '';
let me = null;
let ws = null;
let contacts = [];
let activePeer = null;
let deferredInstallPrompt = null;
let pendingPhoneChoiceCb = null;

// WebRTC + CGNAT Medya Rölesi Durumu
let pc = null;
let localStream = null;
let remoteStream = null;
let activeCall = null;
let incomingOffer = null;
let pendingCandidates = [];
let ringInterval = null;
let isSpeakerOn = false;
let callAudioCtx = null;
let speakerGain = null;
let nextPlayTime = 0;
let wsAudioProc = null;
let wsVideoTimer = null;
let webrtcAudioActive = false;
let webrtcVideoActive = false;
let statsInterval = null;
let lastAudioBytes = 0;
let lastVideoBytes = 0;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

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

// Bilgisayar sekmesi gizlendiğinde veya arka plana atıldığında sunucuya bildir (PC'ye gereksiz arama/bildirim düşmesini önler)
document.addEventListener('visibilitychange', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'VISIBILITY', visible: !document.hidden }));
  }
  if (!document.hidden && token) {
    flushPendingContactImport();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', async (ev) => {
    if (ev.data?.type === 'OPEN_CHAT_FROM_NOTIF' && ev.data.peerId) {
      const peer = contacts.find((c) => c.id === ev.data.peerId);
      if (peer) openChat(peer);
    } else if (ev.data?.type === 'ANSWER_CALL_FROM_NOTIF' && ev.data.callId) {
      const res = await api(`/api/calls/active?callId=${encodeURIComponent(ev.data.callId)}`).catch(() => null);
      if (res?.call) {
        incomingOffer = {
          callId: res.call.callId,
          fromUserId: res.call.callerId,
          fromDisplayName: res.call.callerName,
          callType: res.call.callType,
          sdp: res.call.sdp
        };
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

document.getElementById('regForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const displayName = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPass').value;
    const norm = phone.replace(/\D/g, '');
    const pubJwkStr = await e2ee.initForUser(norm);

    const data = await api('/api/auth/register', 'POST', {
      displayName, phone, password, publicKeyJwk: pubJwkStr, deviceType
    });
    token = data.token;
    localStorage.setItem('nexus_token', token);
    me = data.user;
    startApp();
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const phone = document.getElementById('loginPhone').value.trim();
    const password = document.getElementById('loginPass').value;
    const norm = phone.replace(/\D/g, '');
    const pubJwkStr = await e2ee.initForUser(norm);

    const data = await api('/api/auth/login', 'POST', {
      phone, password, publicKeyJwk: pubJwkStr, deviceType
    });
    token = data.token;
    localStorage.setItem('nexus_token', token);
    me = data.user;
    startApp();
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById('logoutBtn').onclick = async () => {
  if (deviceType === 'desktop') {
    await api('/api/push/unsubscribe', 'POST', { deviceType: 'desktop' }).catch(() => {});
  }
  localStorage.removeItem('nexus_token');
  location.reload();
};

(async () => {
  if (!token) return;
  try {
    const data = await api('/api/auth/me');
    me = data.user;
    await e2ee.initForUser(me.phone_normalized.replace(/\D/g, ''));
    startApp();
  } catch {
    localStorage.removeItem('nexus_token');
  }
})();

async function startApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');
  document.getElementById('myNameLabel').textContent = me.display_name;
  document.getElementById('myPhoneLabel').textContent = me.phone;

  if ('Notification' in window && Notification.permission === 'granted') {
    document.getElementById('pushBanner').classList.add('hidden');
    registerWebPush();
  }

  connectWebSocket();
  await flushPendingContactImport();
  await loadContacts();

  const params = new URLSearchParams(location.search);
  const chatWith = params.get('chatWith');
  if (chatWith) {
    const peer = contacts.find((c) => c.id === chatWith);
    if (peer) openChat(peer);
  }
}

document.getElementById('enablePushBtn').onclick = async () => {
  if (!('Notification' in window)) return alert('Tarayıcınız bildirimleri desteklemiyor. iOS için önce Ana Ekrana Ekle yapın.');
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    document.getElementById('pushBanner').classList.add('hidden');
    await registerWebPush();
    alert('✅ Bildirimler aktif edildi!');
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
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey)
      });
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
    }, 20000);
  };

  ws.onclose = () => setTimeout(connectWebSocket, 3000);

  ws.onmessage = async (ev) => {
    const data = JSON.parse(ev.data);

    if (data.type === 'PRESENCE') {
      const c = contacts.find((x) => x.id === data.userId);
      if (c) {
        c.online = data.online;
        renderContacts();
        if (activePeer && activePeer.id === c.id) updateChatHeader();
      }
    } else if (data.type === 'CONTACT_JOINED') {
      await loadContacts();
    } else if (data.type === 'NEW_ENCRYPTED_MESSAGE') {
      if (activePeer && activePeer.id === data.message.sender_id) {
        await loadMessages(activePeer.id);
      } else {
        await loadContacts();
      }
    } else if (data.type === 'CALL_OFFER') {
      // Bilgisayarda sekme arka plandaysa arama ekranı açma (sadece cep telefonunda çalsın)
      if (deviceType === 'desktop' && document.hidden) return;
      incomingOffer = data;
      showIncomingCallScreen(data);
    } else if (data.type === 'CALL_ANSWER') {
      stopRingtone();
      document.getElementById('callStatusText').textContent = '🟢 Görüşme Bağlandı';
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
    } else if (data.type === 'CALL_REJECT' || data.type === 'CALL_END') {
      closeCallScreen();
    }
  };
}

// --- REHBER VE ÇOKLU NUMARA SEÇİMİ (Resim 2'deki sorunun kesin çözümü) ---
async function loadContacts() {
  const data = await api('/api/contacts');
  contacts = data.contacts || [];
  renderContacts();
}

function renderContacts() {
  const listEl = document.getElementById('contactList');
  listEl.innerHTML = '';
  if (contacts.length === 0) {
    listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">Henüz kişi eklemediniz. Sağ üstten <b>➕ Kişi</b> butonuna basın.</div>';
    return;
  }

  for (const c of contacts) {
    const div = document.createElement('div');
    div.className = 'contact-item' + (activePeer && activePeer.id === c.id ? ' active' : '');
    const statusBadge = c.isRegistered
      ? (c.online ? '🟢 Çevrimiçi' : '🔴 Çevrimdışı')
      : '⏳ Programa Davet Et';
    div.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;min-width:0;">
        <div class="avatar" style="background:${c.avatarColor}">${c.display_name[0].toUpperCase()}<span class="dot ${c.online ? 'on' : 'off'}"></span></div>
        <div style="min-width:0;">
          <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.display_name)}</div>
          <div style="font-size:12px;color:var(--muted);">${escapeHtml(c.phone)} • ${statusBadge}</div>
        </div>
      </div>
    `;
    div.onclick = () => openChat(c);
    listEl.appendChild(div);
  }
}

document.getElementById('openAddContactBtn').onclick = () => document.getElementById('addContactModal').classList.remove('hidden');
document.getElementById('closeAddModalBtn').onclick = () => document.getElementById('addContactModal').classList.add('hidden');

function cleanStringArray(val) {
  if (!val) return [];
  const arr = Array.isArray(val) ? val : Array.from(val);
  return arr.map((item) => {
    if (item && typeof item === 'object') {
      return String(item.value || item.number || item.tel || item.display || item.name || '').trim();
    }
    return String(item || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  }).filter(Boolean);
}

function showChoosePhoneModal(contactName, phoneNumbers, callback) {
  pendingPhoneChoiceCb = callback;
  document.getElementById('choosePhoneTitle').textContent = `📱 ${contactName} — Numara Seçin`;
  document.getElementById('choosePhoneDesc').textContent = `"${contactName}" kişisinde ${phoneNumbers.length} numara bulundu. Hangisini eklemek istersiniz?`;

  const listEl = document.getElementById('choosePhoneList');
  listEl.innerHTML = phoneNumbers.map((p, i) => `
    <label class="phone-choice-row">
      <input type="radio" name="picked_phone_opt" value="${escapeHtml(p)}" ${i === 0 ? 'checked' : ''} />
      <div>
        <strong>${escapeHtml(p)}</strong>
        <div style="font-size:12px;color:var(--muted);">${escapeHtml(contactName)}</div>
      </div>
    </label>
  `).join('') + `
    <label class="phone-choice-row" style="border-style:dashed;">
      <input type="radio" name="picked_phone_opt" value="__ALL__" />
      <div>
        <strong style="color:var(--accent);">👥 Tüm Numaraları Ekle (${phoneNumbers.length} Numara)</strong>
        <div style="font-size:12px;color:var(--muted);">Hepsi ayrı kişi olarak kaydedilir</div>
      </div>
    </label>
  `;

  document.getElementById('choosePhoneModal').classList.remove('hidden');
}

document.getElementById('cancelChoosePhoneBtn').onclick = () => {
  document.getElementById('choosePhoneModal').classList.add('hidden');
  pendingPhoneChoiceCb = null;
};

document.getElementById('confirmChoosePhoneBtn').onclick = async () => {
  const checked = document.querySelector('input[name="picked_phone_opt"]:checked');
  if (!checked) return;
  const val = checked.value;
  document.getElementById('choosePhoneModal').classList.add('hidden');
  if (pendingPhoneChoiceCb) {
    const cb = pendingPhoneChoiceCb;
    pendingPhoneChoiceCb = null;
    await cb(val);
  }
};

// Android Chrome Contact Picker (Resim 2'de "Cem ORTİ + 2 tane daha" seçilip Bitti dendiğinde çalışır)
document.getElementById('pickFromPhoneBtn').onclick = () => {
  if (!window.isSecureContext) {
    return alert('Telefon rehberine erişmek için sayfanın HTTPS adresinden açılması gerekir.');
  }
  if (navigator.contacts && typeof navigator.contacts.select === 'function') {
    navigator.contacts.select(['name', 'tel'], { multiple: false })
      .then(async (picked) => {
        if (!picked || picked.length === 0) return;

        const person = picked[0];
        const names = cleanStringArray(person.name);
        const contactName = names[0] || 'Rehber Kişisi';

        // Tekrar eden numaraları temizle (örn: 05423832663 ve +905423832663 aynıysa tekilleştir)
        const rawTels = cleanStringArray(person.tel);
        const uniqueTels = [];
        const seenNorm = new Set();
        for (const t of rawTels) {
          const digits = t.replace(/\D/g, '').slice(-10);
          if (digits && !seenNorm.has(digits)) {
            seenNorm.add(digits);
            uniqueTels.push(t);
          }
        }

        document.getElementById('addContactModal').classList.add('hidden');

        if (uniqueTels.length === 0) {
          document.getElementById('newContactName').value = contactName;
          document.getElementById('addContactModal').classList.remove('hidden');
          return alert(`"${contactName}" kişisinde kayıtlı numara bulunamadı. Lütfen numarasını yazın.`);
        }

        // Eğer birden fazla numara varsa (Resim 2'deki gibi "+ 2 tane daha") kullanıcıya seçim ekranı aç!
        if (uniqueTels.length > 1) {
          showChoosePhoneModal(contactName, uniqueTels, async (chosen) => {
            const listToSave = chosen === '__ALL__'
              ? uniqueTels.map((p, idx) => ({ name: `${contactName} (${idx + 1})`, phone: p }))
              : [{ name: contactName, phone: chosen }];
            await saveNewContactsWithRetry({ contacts: listToSave });
          });
        } else {
          await saveNewContactsWithRetry({ contacts: [{ name: contactName, phone: uniqueTels[0] }] });
        }
      })
      .catch((err) => {
        if (err && err.name !== 'AbortError') {
          alert('Rehber açılamadı: ' + err.message);
        }
      });
  } else {
    alert('Bu cihaz/tarayıcı doğrudan rehber penceresini desteklemiyor. "iPhone / .vcf Dosyası" butonunu veya aşağıdaki numara kutusunu kullanın.');
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
  await saveNewContactsWithRetry({ contacts: [{ name, phone }] });
  document.getElementById('newContactName').value = '';
  document.getElementById('newContactPhone').value = '';
};

document.getElementById('bulkPasteBtn').onclick = async () => {
  const rawText = document.getElementById('bulkPasteInput').value.trim();
  if (!rawText) return alert('Lütfen en az bir numara yazın.');
  await saveNewContactsWithRetry({ rawText });
  document.getElementById('bulkPasteInput').value = '';
};

// Android rehber ekranından dönüşte ağ soketi uyanma gecikmesine karşı kalıcı kuyruklu ve yeniden denemeli kayıt
async function saveNewContactsWithRetry(payload) {
  localStorage.setItem('nexus_pending_contact_import', JSON.stringify(payload));
  await flushPendingContactImport();
}

async function flushPendingContactImport() {
  const raw = localStorage.getItem('nexus_pending_contact_import');
  if (!raw) return;
  let payload;
  try { payload = JSON.parse(raw); } catch { localStorage.removeItem('nexus_pending_contact_import'); return; }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Android arka plandan dönünce ağ bağlantısının toparlanması için kısa bekleme
      await new Promise((r) => setTimeout(r, 350 * attempt));
      const res = await api('/api/contacts/add', 'POST', payload);
      localStorage.removeItem('nexus_pending_contact_import');
      document.getElementById('addContactModal').classList.add('hidden');
      await loadContacts();

      if (res.contacts && res.contacts.length > 0) {
        const added = res.contacts[0];
        openChat(added);
        showInviteModal(added);
      }
      return;
    } catch (err) {
      if (attempt === 3) {
        localStorage.removeItem('nexus_pending_contact_import');
        alert('Kişi eklenemedi: ' + err.message);
      }
    }
  }
}

function showInviteModal(contact) {
  document.getElementById('invitePreviewText').textContent = `"${contact.inviteText}"`;
  document.getElementById('inviteWaLink').href = contact.whatsappUrl;
  document.getElementById('inviteSmsLink').href = contact.smsUrl;
  document.getElementById('inviteModal').classList.remove('hidden');
}

document.getElementById('closeInviteModalBtn').onclick = () => document.getElementById('inviteModal').classList.add('hidden');

// --- SOHBET VE ŞİFRELİ MESAJLAŞMA ---
async function openChat(peer) {
  activePeer = peer;
  document.getElementById('appScreen').classList.add('mobile-chat');
  document.getElementById('chatHeaderActions').classList.remove('hidden');
  updateChatHeader();
  renderContacts();

  const canEncrypt = Boolean(peer.isRegistered && peer.publicKeyJwk);
  document.getElementById('msgInput').disabled = !canEncrypt;
  document.getElementById('sendBtn').disabled = !canEncrypt;
  document.getElementById('attachBtn').disabled = !canEncrypt;
  document.getElementById('msgInput').placeholder = canEncrypt
    ? 'Uçtan uca şifreli mesaj yazın...'
    : 'Bu kişi henüz kayıtlı değil — Sağ üstten WA veya SMS ile davet edin';

  await loadMessages(peer.id);
}

function updateChatHeader() {
  if (!activePeer) return;
  document.getElementById('peerNameLabel').textContent = activePeer.display_name;
  document.getElementById('peerStatusLabel').textContent = activePeer.isRegistered
    ? (activePeer.online ? `🟢 Çevrimiçi • ${activePeer.phone}` : `🔴 Çevrimdışı • ${activePeer.phone}`)
    : `⏳ Henüz katılmadı • ${activePeer.phone}`;

  document.getElementById('waInviteBtn').onclick = () => window.open(activePeer.whatsappUrl, '_blank');
  document.getElementById('smsInviteBtn').onclick = () => { location.href = activePeer.smsUrl; };
}

document.getElementById('backBtn').onclick = () => document.getElementById('appScreen').classList.remove('mobile-chat');

async function loadMessages(peerId) {
  const data = await api(`/api/messages/${peerId}`);
  const feed = document.getElementById('msgFeed');
  feed.innerHTML = '';

  for (const row of data.messages || []) {
    const isMine = row.sender_id === me.id;
    let plain = { text: '🔒 [Şifreli Mesaj]' };
    try {
      plain = await e2ee.decryptMessage(peerId, activePeer.publicKeyJwk, row);
    } catch {}

    const div = document.createElement('div');
    div.className = 'msg ' + (isMine ? 'out' : 'in');
    const imgHtml = plain.imageDataUrl ? `<img src="${plain.imageDataUrl}" />` : '';
    const fileHtml = plain.fileDataUrl ? `<a href="${plain.fileDataUrl}" download="${escapeHtml(plain.fileName)}" style="color:#38bdf8;">⬇️ ${escapeHtml(plain.fileName)}</a>` : '';
    const time = new Date(row.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `${imgHtml}${fileHtml}<div>${escapeHtml(plain.text || '')}</div><div class="msg-meta">🔒 ${time}</div>`;
    feed.appendChild(div);

    if (row.ttl_ms > 0) {
      setTimeout(() => {
        div.innerHTML = '<div>💥 [Süresi dolduğu için silindi]</div>';
      }, row.ttl_ms);
    }
  }
  feed.scrollTop = feed.scrollHeight;
}

document.getElementById('sendBtn').onclick = sendTextMessage;
document.getElementById('msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTextMessage();
});

async function sendTextMessage() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  const ttlMs = Number(document.getElementById('ttlSelect').value);
  if (!text || !activePeer || !activePeer.publicKeyJwk) return;

  input.value = '';
  const enc = await e2ee.encryptMessage(activePeer.id, activePeer.publicKeyJwk, { text });
  const res = await api(`/api/messages/${activePeer.id}`, 'POST', {
    msgType: 'text',
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    msgNum: enc.msgNum,
    ttlMs
  });
  e2ee.plainCache.set(res.message.id, { text });
  await loadMessages(activePeer.id);
}

document.getElementById('attachBtn').onclick = () => document.getElementById('fileInput').click();
document.getElementById('fileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file || !activePeer || !activePeer.publicKeyJwk) return;
  e.target.value = '';

  const reader = new FileReader();
  reader.onload = async () => {
    const isImg = file.type.startsWith('image/');
    const payload = {
      text: isImg ? '' : `📎 ${file.name}`,
      imageDataUrl: isImg ? reader.result : '',
      fileName: !isImg ? file.name : '',
      fileDataUrl: !isImg ? reader.result : ''
    };
    const enc = await e2ee.encryptMessage(activePeer.id, activePeer.publicKeyJwk, payload);
    const res = await api(`/api/messages/${activePeer.id}`, 'POST', {
      msgType: isImg ? 'image' : 'file',
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      msgNum: enc.msgNum,
      ttlMs: 0
    });
    e2ee.plainCache.set(res.message.id, payload);
    await loadMessages(activePeer.id);
  };
  reader.readAsDataURL(file);
};

// --- KESİNTİSİZ SESLİ VE GÖRÜNTÜLÜ ARAMA (WebRTC + TURN + CGNAT WebSocket Medya Rölesi) ---
function ensureAudioEngine() {
  if (!callAudioCtx || callAudioCtx.state === 'closed') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    callAudioCtx = new Ctx();
    speakerGain = callAudioCtx.createGain();
    speakerGain.gain.value = isSpeakerOn ? 3.5 : 1.8;
    speakerGain.connect(callAudioCtx.destination);
    nextPlayTime = 0;
  }
  if (callAudioCtx.state === 'suspended') callAudioCtx.resume().catch(() => {});
  return callAudioCtx;
}

document.getElementById('toggleSpeakerBtn').onclick = () => {
  isSpeakerOn = !isSpeakerOn;
  ensureAudioEngine();
  if (speakerGain) speakerGain.gain.value = isSpeakerOn ? 3.5 : 1.8;
  const btn = document.getElementById('toggleSpeakerBtn');
  btn.textContent = isSpeakerOn ? '🔊 Hoparlör Açık' : '🔈 Hoparlör';
  btn.style.background = isSpeakerOn ? '#10b981' : '';
};

function startRingtone() {
  stopRingtone();
  const beep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 520;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
      if ('vibrate' in navigator) navigator.vibrate([400, 200, 400]);
    } catch {}
  };
  beep();
  ringInterval = setInterval(beep, 2200);
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
    // Kamera meşgulse veya izin verilmediyse sesli olarak devam et
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      return null;
    }
  }
}

async function setupPeerConnection(targetUserId, callId) {
  if (pc) try { pc.close(); } catch {}
  remoteStream = new MediaStream();

  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
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

  pc.onicecandidate = (ev) => {
    if (ev.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ICE_CANDIDATE',
        callId,
        targetUserId,
        candidate: ev.candidate
      }));
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
    remoteVid.play().catch(() => {});
    remoteAud.play().catch(() => {});
  };

  // WebRTC UDP paketleri mobil operatör (CGNAT) tarafından engellenirse otomatik röle devreye girer
  if (statsInterval) clearInterval(statsInterval);
  lastAudioBytes = 0;
  lastVideoBytes = 0;
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
      lastAudioBytes = aBytes;
      lastVideoBytes = vBytes;
      if (webrtcVideoActive) {
        document.getElementById('remoteRelayImg').classList.add('hidden');
      }
    } catch {}
  }, 1000);
}

// Mobil 4.5G/5G CGNAT arkasında WebRTC engellendiğinde bile ses ve görüntüyü WebSocket üzerinden taşıyan yedek motor
function startWsMediaRelay() {
  stopWsMediaRelay();
  if (!localStream || !activeCall) return;

  // 1. Canlı Ses Aktarımı (12 kHz PCM)
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

        ws.send(JSON.stringify({
          type: 'CALL_MEDIA',
          kind: 'audio',
          targetUserId: activeCall.targetUserId,
          pcmB64: btoa(bin)
        }));
      };

      const zeroGain = ctx.createGain();
      zeroGain.gain.value = 0;
      src.connect(proc);
      proc.connect(zeroGain);
      zeroGain.connect(ctx.destination);
      wsAudioProc = { src, proc, zeroGain };
    }
  } catch {}

  // 2. Canlı Görüntü Aktarımı
  const vTrack = localStream.getVideoTracks()[0];
  if (vTrack) {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 320;
    const c2d = canvas.getContext('2d');
    const localVid = document.getElementById('localVideo');

    wsVideoTimer = setInterval(() => {
      if (!activeCall || !ws || ws.readyState !== WebSocket.OPEN) return;
      const vt = localStream?.getVideoTracks()[0];
      if (!vt || !vt.enabled || !localVid || localVid.readyState < 2) return;
      try {
        c2d.drawImage(localVid, 0, 0, canvas.width, canvas.height);
        ws.send(JSON.stringify({
          type: 'CALL_MEDIA',
          kind: 'video',
          targetUserId: activeCall.targetUserId,
          frameUrl: canvas.toDataURL('image/jpeg', 0.48)
        }));
      } catch {}
    }, 240);
  }
}

function stopWsMediaRelay() {
  if (wsAudioProc) {
    try {
      wsAudioProc.src.disconnect();
      wsAudioProc.proc.disconnect();
      wsAudioProc.zeroGain.disconnect();
    } catch {}
    wsAudioProc = null;
  }
  if (wsVideoTimer) {
    clearInterval(wsVideoTimer);
    wsVideoTimer = null;
  }
}

function handleIncomingWsMedia(ev) {
  if (!activeCall) return;
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
  }
}

document.getElementById('audioCallBtn').onclick = () => initiateCall('audio');
document.getElementById('videoCallBtn').onclick = () => initiateCall('video');

async function initiateCall(callType) {
  if (!activePeer || !activePeer.isRegistered) return alert('Bu kişi henüz uygulamaya kayıt olmamış.');
  const callId = 'call_' + Date.now();
  isSpeakerOn = callType === 'video';
  ensureAudioEngine();

  // Tarayıcı ses/video oynatıcı kilidini kullanıcı tıklaması sırasında aç
  document.getElementById('remoteVideo').play().catch(() => {});
  document.getElementById('remoteAudio').play().catch(() => {});

  activeCall = { callId, targetUserId: activePeer.id, callType };
  document.getElementById('callScreen').classList.remove('hidden');
  document.getElementById('incomingCallControls').classList.add('hidden');
  document.getElementById('activeCallControls').classList.remove('hidden');
  document.getElementById('remoteRelayImg').classList.add('hidden');
  document.getElementById('callPeerTitle').textContent = activePeer.display_name;
  document.getElementById('callStatusText').textContent = callType === 'video' ? '📹 Görüntülü Aranıyor...' : '📞 Sesli Aranıyor...';
  startRingtone();

  localStream = await getUserMediaSafe(callType);
  const localVid = document.getElementById('localVideo');
  localVid.srcObject = localStream;
  localVid.classList.toggle('hidden', !localStream || localStream.getVideoTracks().length === 0);
  if (localStream) localVid.play().catch(() => {});

  await setupPeerConnection(activePeer.id, callId);
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: callType === 'video' });
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: 'CALL_OFFER',
    callId,
    targetUserId: activePeer.id,
    callType,
    sdp: offer
  }));
}

function showIncomingCallScreen(offerData) {
  startRingtone();
  document.getElementById('callScreen').classList.remove('hidden');
  document.getElementById('incomingCallControls').classList.remove('hidden');
  document.getElementById('activeCallControls').classList.add('hidden');
  document.getElementById('remoteRelayImg').classList.add('hidden');
  document.getElementById('callPeerTitle').textContent = offerData.fromDisplayName;
  document.getElementById('callStatusText').textContent =
    offerData.callType === 'video' ? '📹 Gelen Görüntülü Arama...' : '📞 Gelen Sesli Arama...';
}

document.getElementById('acceptCallBtn').onclick = acceptIncomingCall;

async function acceptIncomingCall() {
  if (!incomingOffer) return;
  stopRingtone();
  const offer = incomingOffer;
  incomingOffer = null;
  isSpeakerOn = offer.callType === 'video';
  ensureAudioEngine();

  document.getElementById('remoteVideo').play().catch(() => {});
  document.getElementById('remoteAudio').play().catch(() => {});

  activeCall = { callId: offer.callId, targetUserId: offer.fromUserId, callType: offer.callType };
  document.getElementById('incomingCallControls').classList.add('hidden');
  document.getElementById('activeCallControls').classList.remove('hidden');
  document.getElementById('callStatusText').textContent = '🟢 Görüşme Aktif';

  localStream = await getUserMediaSafe(offer.callType);
  const localVid = document.getElementById('localVideo');
  localVid.srcObject = localStream;
  localVid.classList.toggle('hidden', !localStream || localStream.getVideoTracks().length === 0);
  if (localStream) localVid.play().catch(() => {});

  await setupPeerConnection(offer.fromUserId, offer.callId);
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
  for (const cand of pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
  pendingCandidates = [];

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send(JSON.stringify({
    type: 'CALL_ANSWER',
    callId: offer.callId,
    targetUserId: offer.fromUserId,
    sdp: answer
  }));

  startWsMediaRelay();
}

document.getElementById('rejectCallBtn').onclick = () => {
  if (incomingOffer && ws) {
    ws.send(JSON.stringify({
      type: 'CALL_REJECT',
      callId: incomingOffer.callId,
      targetUserId: incomingOffer.fromUserId
    }));
  }
  closeCallScreen();
};

document.getElementById('hangupCallBtn').onclick = () => {
  if (activeCall && ws) {
    ws.send(JSON.stringify({
      type: 'CALL_END',
      callId: activeCall.callId,
      targetUserId: activeCall.targetUserId
    }));
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
