const e2ee = new NexusE2EE();
const isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
const deviceType = isMobileDevice ? 'mobile' : 'desktop';

let token = localStorage.getItem('nexus_token') || '';
let me = null;
let ws = null;
let contacts = [];
let discoverableUsers = [];
let stories = [];
let currentSideTab = 'chats';
let activePeer = null;
let deferredInstallPrompt = null;
let pendingPhoneChoiceCb = null;
let pendingStoryImageDataUrl = '';

// WebRTC + CGNAT Medya Rölesi
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

// --- GÖRÜNÜM, ARKAPLAN FOTOĞRAFI VE YAZI AYARLARI ---
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

document.getElementById('fontSizeRange').oninput = (e) => {
  localStorage.setItem('nexus_font_size', e.target.value);
  applySavedAppearance();
};
document.getElementById('fontFamilySelect').onchange = (e) => {
  localStorage.setItem('nexus_font_family', e.target.value);
  applySavedAppearance();
};
document.getElementById('fontWeightSelect').onchange = (e) => {
  localStorage.setItem('nexus_font_weight', e.target.value);
  applySavedAppearance();
};

document.getElementById('pickWallpaperBtn').onclick = () => document.getElementById('wallpaperFileInput').click();
document.getElementById('wallpaperFileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  compressImageToDataUrl(file, 1280, 0.82, (dataUrl) => {
    try {
      localStorage.setItem('nexus_chat_wallpaper', dataUrl);
      applySavedAppearance();
    } catch {
      alert('Fotoğraf boyutu çok yüksek, daha küçük bir görsel seçin.');
    }
  });
};
document.getElementById('clearWallpaperBtn').onclick = () => {
  localStorage.removeItem('nexus_chat_wallpaper');
  applySavedAppearance();
};

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
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// --- KURULUM (ANDROID & iOS) ---
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

document.addEventListener('visibilitychange', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'VISIBILITY', visible: !document.hidden }));
  }
  if (!document.hidden && token) flushPendingContactImport();
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

// Giriş / Kayıt
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

function updateMyAvatarUi() {
  const box = document.getElementById('myAvatarBox');
  if (!box || !me) return;
  if (me.avatar_url) {
    box.innerHTML = `<img src="${me.avatar_url}" alt="Profil" />`;
  } else {
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

  connectWebSocket();
  await flushPendingContactImport();
  await Promise.all([loadContacts(), loadStories()]);
  renderSidebar();
}

// Sol Panel Sekmeleri (Sohbet & Rehber / Durum / Profil)
document.getElementById('navChatsTab').onclick = () => switchSideTab('chats');
document.getElementById('navStoriesTab').onclick = () => switchSideTab('stories');
document.getElementById('navSettingsTab').onclick = () => switchSideTab('settings');
document.getElementById('openProfileBtn').onclick = () => switchSideTab('settings');

function switchSideTab(tab) {
  currentSideTab = tab;
  document.getElementById('navChatsTab').classList.toggle('active', tab === 'chats');
  document.getElementById('navStoriesTab').classList.toggle('active', tab === 'stories');
  document.getElementById('navSettingsTab').classList.toggle('active', tab === 'settings');
  if (tab === 'stories') loadStories().then(renderSidebar);
  else if (tab === 'chats') loadContacts().then(renderSidebar);
  else renderSidebar();
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
        if (currentSideTab === 'chats') renderSidebar();
        if (activePeer && activePeer.id === c.id) updateChatHeader();
      }
    } else if (data.type === 'CONTACT_JOINED') {
      await loadContacts();
      if (currentSideTab === 'chats') renderSidebar();
    } else if (data.type === 'NEW_ENCRYPTED_MESSAGE') {
      if (activePeer && activePeer.id === data.message.sender_id) {
        await loadMessages(activePeer.id);
      } else {
        await loadContacts();
        if (currentSideTab === 'chats') renderSidebar();
      }
    } else if (data.type === 'CALL_OFFER') {
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

// --- REHBER VE DURUM / PROFİL GÖRÜNÜMÜ ---
async function loadContacts() {
  const data = await api('/api/contacts');
  contacts = data.contacts || [];
  discoverableUsers = data.discoverable || [];
}

async function loadStories() {
  const data = await api('/api/stories');
  stories = data.stories || [];
}

function renderSidebar() {
  const listEl = document.getElementById('sidebarContent');
  listEl.innerHTML = '';

  // 1. SOHBETLER & REHBER
  if (currentSideTab === 'chats') {
    if (contacts.length === 0 && discoverableUsers.length === 0) {
      listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">Henüz kişi yok. Sağ üstten <b>➕ Kişi</b> butonuna basarak rehberden veya numaradan kişi ekleyin.</div>';
      return;
    }

    for (const c of contacts) {
      const div = document.createElement('div');
      div.className = 'contact-item' + (activePeer && activePeer.id === c.id ? ' active' : '');
      const statusBadge = c.isRegistered ? (c.online ? '🟢 Çevrimiçi' : '🔴 Çevrimdışı') : '⏳ Davet Et';
      const avatarInner = c.avatarUrl ? `<img src="${c.avatarUrl}" />` : c.display_name[0].toUpperCase();
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

    // Sistemde kayıtlı olup henüz rehbere eklenmemiş kullanıcıları tek dokunuşla rehbere ekleme bölümü
    if (discoverableUsers.length > 0) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'padding:10px 14px;font-size:12px;font-weight:700;color:var(--accent);background:var(--bg);border-bottom:1px solid var(--border);';
      hdr.textContent = '🌐 Uygulamayı Kullanan Diğer Kişiler (Rehbere Ekle)';
      listEl.appendChild(hdr);

      for (const u of discoverableUsers) {
        const div = document.createElement('div');
        div.className = 'contact-item';
        const avatarInner = u.avatarUrl ? `<img src="${u.avatarUrl}" />` : u.display_name[0].toUpperCase();
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

  // 2. DURUM GÜNCELLEMELERİ (24 SAATLİK STORIES)
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
      const imgHtml = s.media_url ? `<img src="${s.media_url}" style="width:100%;max-height:220px;object-fit:cover;display:block;" />` : '';
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

  // 3. PROFİL FOTOĞRAFI, HAKKIMDA VE AYARLAR
  if (currentSideTab === 'settings') {
    const bigAvatar = me.avatar_url
      ? `<img src="${me.avatar_url}" style="width:100%;height:100%;object-fit:cover;" />`
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

        <button type="button" class="btn-red" id="settingsLogoutBtn">🚪 Oturumu Kapat</button>
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
    listEl.querySelector('#settingsLogoutBtn').onclick = async () => {
      if (deviceType === 'desktop') await api('/api/push/unsubscribe', 'POST', { deviceType: 'desktop' }).catch(() => {});
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
    alert('✅ Profil fotoğrafınız güncellendi!');
  });
};

// Durum Paylaşımı Fotoğraf Seçimi
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

// --- REHBER EKLEME İŞLEMLERİ ---
document.getElementById('openAddContactBtn').onclick = () => document.getElementById('addContactModal').classList.remove('hidden');
document.getElementById('closeAddModalBtn').onclick = () => document.getElementById('addContactModal').classList.add('hidden');

function cleanStringArray(val) {
  if (!val) return [];
  const arr = Array.isArray(val) ? val : Array.from(val);
  return arr.map((item) => {
    if (item && typeof item === 'object') return String(item.value || item.number || item.tel || item.display || item.name || '').trim();
    return String(item || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  }).filter(Boolean);
}

function showChoosePhoneModal(contactName, phoneNumbers, callback) {
  pendingPhoneChoiceCb = callback;
  document.getElementById('choosePhoneTitle').textContent = `📱 ${contactName} — Numara Seçin`;
  document.getElementById('choosePhoneDesc').textContent = `"${contactName}" kişisinde ${phoneNumbers.length} numara bulundu:`;

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

document.getElementById('pickFromPhoneBtn').onclick = () => {
  if (!window.isSecureContext) return alert('Telefon rehberine erişmek için sayfanın HTTPS adresinden açılması gerekir.');
  if (navigator.contacts && typeof navigator.contacts.select === 'function') {
    navigator.contacts.select(['name', 'tel'], { multiple: false })
      .then(async (picked) => {
        if (!picked || picked.length === 0) return;
        const person = picked[0];
        const contactName = cleanStringArray(person.name)[0] || 'Rehber Kişisi';
        const rawTels = cleanStringArray(person.tel);
        const uniqueTels = [];
        const seen = new Set();
        for (const t of rawTels) {
          const digits = t.replace(/\D/g, '').slice(-10);
          if (digits && !seen.has(digits)) { seen.add(digits); uniqueTels.push(t); }
        }
        document.getElementById('addContactModal').classList.add('hidden');
        if (uniqueTels.length === 0) {
          document.getElementById('newContactName').value = contactName;
          document.getElementById('addContactModal').classList.remove('hidden');
          return alert(`"${contactName}" kişisinde numara bulunamadı. Lütfen yazın.`);
        }
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
        if (err && err.name !== 'AbortError') alert('Rehber açılamadı: ' + err.message);
      });
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
      await new Promise((r) => setTimeout(r, 300 * attempt));
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

// --- SOHBET, ZENGİN PAYLAŞIM (RESİM, DOSYA, KİŞİ, KONUM) ---
async function openChat(peer) {
  activePeer = peer;
  document.getElementById('appScreen').classList.add('mobile-chat');
  document.getElementById('chatHeaderActions').classList.remove('hidden');
  document.getElementById('peerAvatarBox').classList.remove('hidden');
  updateChatHeader();
  if (currentSideTab === 'chats') renderSidebar();

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
  const pAv = document.getElementById('peerAvatarBox');
  if (activePeer.avatarUrl) {
    pAv.innerHTML = `<img src="${activePeer.avatarUrl}" />`;
  } else {
    pAv.textContent = (activePeer.display_name || 'K')[0].toUpperCase();
    pAv.style.background = activePeer.avatarColor || '#00a884';
  }
  document.getElementById('peerNameLabel').textContent = activePeer.display_name;
  document.getElementById('peerStatusLabel').textContent = activePeer.isRegistered
    ? (activePeer.online ? `🟢 Çevrimiçi • ${activePeer.phone}` : `🔴 Çevrimdışı • ${activePeer.phone}`)
    : `⏳ Henüz katılmadı • ${activePeer.phone}`;

  document.getElementById('waInviteBtn').onclick = () => window.open(activePeer.whatsappUrl, '_blank');
  document.getElementById('smsInviteBtn').onclick = () => { location.href = activePeer.smsUrl; };
}

document.getElementById('backBtn').onclick = () => document.getElementById('appScreen').classList.remove('mobile-chat');

// Ataç Menüsü Aç/Kapat
document.getElementById('attachBtn').onclick = () => {
  document.getElementById('attachMenu').classList.toggle('hidden');
};

// 1. Fotoğraf Paylaşımı (E2EE Şifreli Blob)
document.getElementById('sendImageOpt').onclick = () => {
  document.getElementById('attachMenu').classList.add('hidden');
  document.getElementById('imageFileInput').click();
};
document.getElementById('imageFileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !activePeer) return;
  e.target.value = '';
  await uploadAndSendEncryptedMedia(file, 'image');
};

// 2. Dosya Paylaşımı (PDF, ZIP, Belge vb. — E2EE Şifreli Blob)
document.getElementById('sendFileOpt').onclick = () => {
  document.getElementById('attachMenu').classList.add('hidden');
  document.getElementById('anyFileInput').click();
};
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

  const payload = {
    kind,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    fileSize: file.size,
    blobUrl: up.blobUrl,
    mediaKeyB64: encBlob.mediaKeyB64,
    mediaIvB64: encBlob.mediaIvB64,
    sha256B64: encBlob.sha256B64
  };
  await sendEncryptedEnvelope(kind, payload, 0);
}

// 3. Kişi Kartı (vCard) Paylaşımı
document.getElementById('sendContactCardOpt').onclick = () => {
  document.getElementById('attachMenu').classList.add('hidden');
  const box = document.getElementById('shareContactList');
  if (contacts.length === 0) return alert('Rehberinizde paylaşılacak kişi bulunmuyor.');

  box.innerHTML = contacts.map((c) => `
    <div class="phone-choice-row" data-cid="${c.id}">
      <div>
        <strong>👤 ${escapeHtml(c.display_name)}</strong>
        <div style="font-size:12px;color:var(--muted);">${escapeHtml(c.phone)}</div>
      </div>
    </div>
  `).join('');

  box.querySelectorAll('.phone-choice-row').forEach((row) => {
    row.onclick = async () => {
      const c = contacts.find((x) => x.id === row.dataset.cid);
      document.getElementById('shareContactModal').classList.add('hidden');
      if (c) {
        await sendEncryptedEnvelope('contact', {
          kind: 'contact',
          contactName: c.display_name,
          contactPhone: c.phone
        }, 0);
      }
    };
  });
  document.getElementById('shareContactModal').classList.remove('hidden');
};
document.getElementById('closeShareContactBtn').onclick = () => document.getElementById('shareContactModal').classList.add('hidden');

// 4. Konum Paylaşımı (GPS / Harita Bağlantısı)
document.getElementById('sendLocationOpt').onclick = () => {
  document.getElementById('attachMenu').classList.add('hidden');
  if (!navigator.geolocation) return alert('Cihazınız konum servisini desteklemiyor.');

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      await sendEncryptedEnvelope('location', {
        kind: 'location',
        lat,
        lng,
        mapUrl: `https://maps.google.com/?q=${lat},${lng}`
      }, 0);
    },
    (err) => alert('Konum alınamadı: ' + err.message),
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

async function sendEncryptedEnvelope(msgType, payloadObj, ttlMs) {
  if (!activePeer || !activePeer.publicKeyJwk) return;
  const enc = await e2ee.encryptMessage(activePeer.id, activePeer.publicKeyJwk, payloadObj);
  const res = await api(`/api/messages/${activePeer.id}`, 'POST', {
    msgType,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    msgNum: enc.msgNum,
    ttlMs
  });
  e2ee.plainCache.set(res.message.id, payloadObj);
  await loadMessages(activePeer.id);
}

async function loadMessages(peerId) {
  const data = await api(`/api/messages/${peerId}`);
  const feed = document.getElementById('msgFeed');
  feed.innerHTML = '';

  for (const row of data.messages || []) {
    const isMine = row.sender_id === me.id;
    let plain = { kind: 'text', text: '🔒 [Şifreli Mesaj]' };
    try {
      plain = await e2ee.decryptMessage(peerId, activePeer.publicKeyJwk, row);
    } catch {}

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
  if (blobObjectUrlCache.has(meta.blobUrl)) {
    el.src = blobObjectUrlCache.get(meta.blobUrl);
    return;
  }
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
    a.href = url;
    a.download = meta.fileName || 'dosya';
    a.click();
  } catch (err) {
    alert('Dosya çözülemedi: ' + err.message);
  }
}

document.getElementById('sendBtn').onclick = sendTextMessage;
document.getElementById('msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTextMessage();
});

async function sendTextMessage() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  const ttlMs = Number(document.getElementById('ttlSelect').value);
  if (!text || !activePeer) return;
  input.value = '';
  await sendEncryptedEnvelope('text', { kind: 'text', text }, ttlMs);
}

// --- SESLİ VE GÖRÜNTÜLÜ ARAMA (WebRTC + TURN + CGNAT Röle) ---
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
    try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch { return null; }
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
    remoteVid.play().catch(() => {});
    remoteAud.play().catch(() => {});
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
      if (webrtcVideoActive) document.getElementById('remoteRelayImg').classList.add('hidden');
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
    canvas.width = 240; canvas.height = 320;
    const c2d = canvas.getContext('2d');
    const localVid = document.getElementById('localVideo');

    wsVideoTimer = setInterval(() => {
      if (!activeCall || !ws || ws.readyState !== WebSocket.OPEN) return;
      const vt = localStream?.getVideoTracks()[0];
      if (!vt || !vt.enabled || !localVid || localVid.readyState < 2) return;
      try {
        c2d.drawImage(localVid, 0, 0, canvas.width, canvas.height);
        ws.send(JSON.stringify({ type: 'CALL_MEDIA', kind: 'video', targetUserId: activeCall.targetUserId, frameUrl: canvas.toDataURL('image/jpeg', 0.48) }));
      } catch {}
    }, 240);
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

  ws.send(JSON.stringify({ type: 'CALL_OFFER', callId, targetUserId: activePeer.id, callType, sdp: offer }));
}

function showIncomingCallScreen(offerData) {
  startRingtone();
  document.getElementById('callScreen').classList.remove('hidden');
  document.getElementById('incomingCallControls').classList.remove('hidden');
  document.getElementById('activeCallControls').classList.add('hidden');
  document.getElementById('remoteRelayImg').classList.add('hidden');
  document.getElementById('callPeerTitle').textContent = offerData.fromDisplayName;
  document.getElementById('callStatusText').textContent = offerData.callType === 'video' ? '📹 Gelen Görüntülü Arama...' : '📞 Gelen Sesli Arama...';
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

  ws.send(JSON.stringify({ type: 'CALL_ANSWER', callId: offer.callId, targetUserId: offer.fromUserId, sdp: answer }));
  startWsMediaRelay();
}

document.getElementById('rejectCallBtn').onclick = () => {
  if (incomingOffer && ws) ws.send(JSON.stringify({ type: 'CALL_REJECT', callId: incomingOffer.callId, targetUserId: incomingOffer.fromUserId }));
  closeCallScreen();
};
document.getElementById('hangupCallBtn').onclick = () => {
  if (activeCall && ws) ws.send(JSON.stringify({ type: 'CALL_END', callId: activeCall.callId, targetUserId: activeCall.targetUserId }));
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
