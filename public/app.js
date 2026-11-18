const e2ee = new NexusE2EE();
let token = localStorage.getItem('nexus_token') || '';
let me = null;
let ws = null;
let contacts = [];
let activePeer = null;
let deferredInstallPrompt = null;

// WebRTC Arama Durumu
let pc = null;
let localStream = null;
let activeCall = null;
let incomingOffer = null;
let pendingCandidates = [];
let ringInterval = null;

// Android / Masaüstü PWA Yükleme İstemini Yakala
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

document.getElementById('openInstallBtn').onclick = () => {
  document.getElementById('installModal').classList.remove('hidden');
};
document.getElementById('openInstallFromAuthBtn').onclick = () => {
  document.getElementById('installModal').classList.remove('hidden');
};
document.getElementById('closeInstallModalBtn').onclick = () => {
  document.getElementById('installModal').classList.add('hidden');
};

document.getElementById('androidDirectInstallBtn').onclick = async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const res = await deferredInstallPrompt.userChoice;
    if (res.outcome === 'accepted') {
      document.getElementById('installModal').classList.add('hidden');
    }
    deferredInstallPrompt = null;
  } else {
    alert('Tarayıcınızın sağ üst köşesindeki ⋮ (Üç Nokta) menüsüne dokunup "Ana ekrana ekle" veya "Uygulamayı yükle" seçeneğine basın.');
  }
};

// Service Worker Kaydı
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

// Giriş / Kayıt Sekmeleri
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
      displayName, phone, password, publicKeyJwk: pubJwkStr
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
      phone, password, publicKeyJwk: pubJwkStr
    });
    token = data.token;
    localStorage.setItem('nexus_token', token);
    me = data.user;
    startApp();
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById('logoutBtn').onclick = () => {
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
    alert('✅ Arka plan bildirimleri ve kapalıyken arama uyandırma aktif edildi!');
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
    await api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() });
  } catch {}
}

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
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
    } else if (data.type === 'ICE_CANDIDATE' && data.candidate) {
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      } else {
        pendingCandidates.push(data.candidate);
      }
    } else if (data.type === 'CALL_REJECT' || data.type === 'CALL_END') {
      closeCallScreen();
    }
  };
}

// --- REHBER VE KİŞİ EKLEME (DÜZELTİLMİŞ ÇOKLU FORMAT) ---
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

document.getElementById('openAddContactBtn').onclick = () => {
  document.getElementById('addContactModal').classList.remove('hidden');
};
document.getElementById('closeAddModalBtn').onclick = () => {
  document.getElementById('addContactModal').classList.add('hidden');
};

// 1. Android Chrome Contact Picker API (User Gesture korunarak doğrudan çağrılır)
document.getElementById('pickFromPhoneBtn').onclick = () => {
  if (!window.isSecureContext) {
    return alert('Telefon rehberine erişmek için sayfanın HTTPS adresinden açılması gerekir.');
  }
  if (navigator.contacts && typeof navigator.contacts.select === 'function') {
    navigator.contacts.select(['name', 'tel'], { multiple: true })
      .then(async (picked) => {
        if (!picked || picked.length === 0) return;
        const formatted = [];
        for (const item of picked) {
          const n = (item.name && item.name[0]) || '';
          const tels = item.tel || [];
          for (const t of tels) {
            if (t) formatted.push({ name: n, phone: t });
          }
        }
        if (formatted.length === 0) {
          return alert('Seçilen kişide telefon numarası bulunamadı.');
        }
        await saveNewContacts({ contacts: formatted });
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          alert('Rehber açılamadı: ' + err.message + '. Aşağıdan numara yazarak ekleyebilirsiniz.');
        }
      });
  } else {
    alert('Bu cihaz/tarayıcı doğrudan rehber penceresini desteklemiyor (iPhone Safari vb.). "iPhone / .vcf Dosyası" butonunu veya aşağıdaki numara kutusunu kullanın.');
  }
};

// 2. iOS (iPhone) ve Android .vcf Kişi Kartı Aktarımı
document.getElementById('pickVcfFileBtn').onclick = () => {
  document.getElementById('vcfFileInput').click();
};

document.getElementById('vcfFileInput').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;

  let allText = '';
  for (const f of files) {
    allText += '\n' + (await f.text());
  }
  await saveNewContacts({ rawText: allText });
};

// 3. Manuel Tekli Ekleme
document.getElementById('manualContactForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('newContactName').value.trim();
  const phone = document.getElementById('newContactPhone').value.trim();
  await saveNewContacts({ contacts: [{ name, phone }] });
  document.getElementById('newContactName').value = '';
  document.getElementById('newContactPhone').value = '';
};

// 4. Toplu Metin Yapıştırma
document.getElementById('bulkPasteBtn').onclick = async () => {
  const rawText = document.getElementById('bulkPasteInput').value.trim();
  if (!rawText) return alert('Lütfen en az bir numara yazın.');
  await saveNewContacts({ rawText });
  document.getElementById('bulkPasteInput').value = '';
};

async function saveNewContacts(payload) {
  try {
    const res = await api('/api/contacts/add', 'POST', payload);
    document.getElementById('addContactModal').classList.add('hidden');
    await loadContacts();

    if (res.contacts && res.contacts.length > 0) {
      const added = res.contacts[0];
      openChat(added);
      showInviteModal(added);
    }
  } catch (err) {
    alert(err.message);
  }
}

function showInviteModal(contact) {
  document.getElementById('invitePreviewText').textContent = `"${contact.inviteText}"`;
  document.getElementById('inviteWaLink').href = contact.whatsappUrl;
  document.getElementById('inviteSmsLink').href = contact.smsUrl;
  document.getElementById('inviteModal').classList.remove('hidden');
}

document.getElementById('closeInviteModalBtn').onclick = () => {
  document.getElementById('inviteModal').classList.add('hidden');
};

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

document.getElementById('backBtn').onclick = () => {
  document.getElementById('appScreen').classList.remove('mobile-chat');
};

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

// --- GERÇEK ZAMANLI SESLİ VE GÖRÜNTÜLÜ ARAMA ---
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

async function setupPeerConnection(targetUserId, callId) {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
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
    const remoteVid = document.getElementById('remoteVideo');
    if (ev.streams && ev.streams[0]) remoteVid.srcObject = ev.streams[0];
  };
}

document.getElementById('audioCallBtn').onclick = () => initiateCall('audio');
document.getElementById('videoCallBtn').onclick = () => initiateCall('video');

async function initiateCall(callType) {
  if (!activePeer || !activePeer.isRegistered) return alert('Bu kişi henüz uygulamaya kayıt olmamış.');
  const callId = 'call_' + Date.now();
  activeCall = { callId, targetUserId: activePeer.id, callType };

  document.getElementById('callScreen').classList.remove('hidden');
  document.getElementById('incomingCallControls').classList.add('hidden');
  document.getElementById('activeCallControls').classList.remove('hidden');
  document.getElementById('callPeerTitle').textContent = activePeer.display_name;
  document.getElementById('callStatusText').textContent = callType === 'video' ? '📹 Görüntülü Aranıyor...' : '📞 Sesli Aranıyor...';
  startRingtone();

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: callType === 'video'
  });
  document.getElementById('localVideo').srcObject = localStream;
  document.getElementById('localVideo').classList.toggle('hidden', callType !== 'video');

  await setupPeerConnection(activePeer.id, callId);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  const offer = await pc.createOffer();
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
  activeCall = { callId: offer.callId, targetUserId: offer.fromUserId, callType: offer.callType };

  document.getElementById('incomingCallControls').classList.add('hidden');
  document.getElementById('activeCallControls').classList.remove('hidden');
  document.getElementById('callStatusText').textContent = '🟢 Görüşme Aktif';

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: offer.callType === 'video'
  });
  document.getElementById('localVideo').srcObject = localStream;
  document.getElementById('localVideo').classList.toggle('hidden', offer.callType !== 'video');

  await setupPeerConnection(offer.fromUserId, offer.callId);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

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
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  if (pc) pc.close();
  pc = null;
  activeCall = null;
  incomingOffer = null;
  document.getElementById('callScreen').classList.add('hidden');
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
