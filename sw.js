// BUILD_VER: 720
/**
 * Mesajlaşma Uygulaması - Service Worker (Arka Planda Çalışma, Web Push, Çağrı & Bildirim Motoru v7.2)
 * Program tamamen kapatılsa veya simge durumuna küçültülse bile:
 * 1. Oturum anahtarını (bgToken) ve kullanıcı profilini (bgProfile) kalıcı Cache Storage içinde saklar.
 * 2. Web Push (VAPID) sinyali geldiğinde kapalı olan uygulamayı uyandırır ve ekrana bildirim/arama çıkarır.
 * 3. Arka plan yoklaması (polling), PeriodicSync ve Sync ile mesaj ve aramaları yakalar.
 */

const CACHE_NAME = 'mesajlasma-pwa-v12';
const STATE_CACHE = 'mesajlasma-sw-state-v2';
const STATE_URL = 'https://msj-internal-state.local/auth-state.json';

let bgToken = '';
let bgProfile = '';
let notifiedMsgIds = new Set();
let notifiedCallIds = new Set();
let bgInterval = null;
let stateLoaded = false;

async function saveSwState() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const body = JSON.stringify({
      bgToken: bgToken || '',
      bgProfile: bgProfile || '',
      notifiedMsgIds: Array.from(notifiedMsgIds).slice(-200),
      notifiedCallIds: Array.from(notifiedCallIds).slice(-100),
      updatedAt: Date.now()
    });
    await cache.put(
      STATE_URL,
      new Response(body, { headers: { 'Content-Type': 'application/json' } })
    );
  } catch {}
}

async function loadSwState() {
  if (stateLoaded && bgToken) return;
  try {
    const cache = await caches.open(STATE_CACHE);
    const res = await cache.match(STATE_URL);
    if (res) {
      const data = await res.json();
      if (data.bgToken && !bgToken) bgToken = data.bgToken;
      if (data.bgProfile && !bgProfile) bgProfile = data.bgProfile;
      if (Array.isArray(data.notifiedMsgIds)) {
        for (const id of data.notifiedMsgIds) notifiedMsgIds.add(id);
      }
      if (Array.isArray(data.notifiedCallIds)) {
        for (const id of data.notifiedCallIds) notifiedCallIds.add(id);
      }
    }
    stateLoaded = true;
  } catch {}
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k !== STATE_CACHE)
            .map((k) => caches.delete(k))
        );
      } catch {}
      await loadSwState();
      await self.clients.claim();
      startBackgroundTimer();
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        try {
          client.postMessage({ type: 'SW_READY_FOR_TOKEN', buildVer: 720 });
        } catch {}
      }
    })()
  );
});

async function showCallNotification(call) {
  if (!call || !call.callId) return;
  const isVideo = call.callType === 'video';
  const callerName = call.callerName || call.fromDisplayName || 'Biri Arıyor';
  await self.registration.showNotification(`📞 GELEN ARAMA: ${callerName}`, {
    body: (isVideo ? '📹 Görüntülü Arama' : '📞 Sesli Arama') + ' Geliyor — Cevaplamak için dokunun',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'call_' + call.callId,
    requireInteraction: true,
    renotify: true,
    vibrate: [600, 200, 600, 200, 600, 200, 600, 200, 600],
    data: {
      type: 'incoming-call',
      callId: call.callId,
      conversationId: call.conversationId || '',
      callerId: call.callerId || call.fromUserId || '',
      callerName,
      callType: call.callType || 'audio'
    },
    actions: [
      { action: 'answer', title: '🟢 Cevapla' },
      { action: 'reject', title: '🔴 Reddet' }
    ]
  }).catch(() => {});
}

async function showMessageNotification(msg) {
  if (!msg || !msg.id) return;
  const senderName = msg.sender_name || msg.senderName || 'Yeni Mesaj';
  const text = msg.content || msg.body || '🔒 Yeni mesaj aldınız';
  await self.registration.showNotification(`💬 ${senderName}`, {
    body: text,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'msj-' + msg.id,
    requireInteraction: true,
    renotify: true,
    vibrate: [300, 120, 300],
    data: {
      type: 'new-message',
      id: msg.id,
      conversationId: msg.conversation_id || msg.conversationId || ''
    },
    actions: [
      { action: 'open', title: '💬 Aç ve Yanıtla' }
    ]
  }).catch(() => {});
}

async function pollServerInBackground() {
  await loadSwState();
  if (!bgToken) return;
  try {
    const query = `token=${encodeURIComponent(bgToken)}${bgProfile ? `&profile=${encodeURIComponent(bgProfile)}` : ''}`;
    const res = await fetch(`/api/notifications/poll?${query}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();

    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const anyFocused = clientList.some((c) => c.focused && c.visibilityState === 'visible');

    let stateChanged = false;

    // 1. GELEN ARAMALAR (Program kapalı olsa da, açık olsa da bildirim + pencere uyarısı gönder)
    if (Array.isArray(data.incomingCalls) && data.incomingCalls.length > 0) {
      for (const call of data.incomingCalls) {
        for (const client of clientList) {
          try {
            client.postMessage({ type: 'BG_INCOMING_CALL', call });
          } catch {}
        }
        if (notifiedCallIds.has(call.callId)) continue;
        notifiedCallIds.add(call.callId);
        stateChanged = true;
        await showCallNotification(call);
      }
    }

    // 2. OKUNMAMIŞ MESAJLAR (Uygulama kapalıysa veya odakta değilse ekrana bildirim çıkar)
    if (Array.isArray(data.unreadMessages) && data.unreadMessages.length > 0) {
      const freshMessages = [];
      for (const m of data.unreadMessages) {
        if (notifiedMsgIds.has(m.id)) continue;
        if (!anyFocused) {
          notifiedMsgIds.add(m.id);
          stateChanged = true;
          freshMessages.push(m);
          await showMessageNotification(m);
        }
      }
      if (freshMessages.length > 0) {
        for (const client of clientList) {
          try {
            client.postMessage({ type: 'BG_NEW_MESSAGES', messages: freshMessages });
          } catch {}
        }
      }
    }

    if (stateChanged) {
      await saveSwState();
    }
  } catch {}
}

function startBackgroundTimer() {
  if (bgInterval) clearInterval(bgInterval);
  bgInterval = setInterval(() => {
    pollServerInBackground();
  }, 4000);
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SET_BG_TOKEN') {
    bgToken = data.token || '';
    if (data.profile) {
      bgProfile = data.profile;
    }
    stateLoaded = true;
    startBackgroundTimer();
    event.waitUntil(
      (async () => {
        await saveSwState();
        await pollServerInBackground();
      })()
    );
  } else if (data.type === 'CLEAR_BG_TOKEN') {
    bgToken = '';
    bgProfile = '';
    if (bgInterval) clearInterval(bgInterval);
    event.waitUntil(saveSwState());
  } else if (data.type === 'MARK_NOTIFIED_IDS') {
    if (Array.isArray(data.msgIds)) {
      for (const id of data.msgIds) notifiedMsgIds.add(id);
    }
    if (Array.isArray(data.callIds)) {
      for (const id of data.callIds) notifiedCallIds.add(id);
    }
    event.waitUntil(saveSwState());
  } else if (data.type === 'SHOW_LOCAL_NOTIFICATION') {
    const isCall = data.payload && data.payload.type === 'incoming-call';
    if (data.payload && data.payload.id) notifiedMsgIds.add(data.payload.id);
    if (data.payload && data.payload.callId) notifiedCallIds.add(data.payload.callId);
    event.waitUntil(
      (async () => {
        await saveSwState();
        await self.registration.showNotification(data.title || 'Mesajlaşma', {
          body: data.body || '',
          icon: '/icon.svg',
          badge: '/icon.svg',
          tag: data.tag || (isCall ? 'call_' + (data.payload.callId || 'act') : 'local_' + Date.now()),
          requireInteraction: true,
          renotify: true,
          vibrate: isCall ? [600, 200, 600, 200, 600, 200, 600, 200, 600] : [300, 120, 300],
          data: data.payload || {},
          actions: isCall
            ? [
                { action: 'answer', title: '🟢 Cevapla' },
                { action: 'reject', title: '🔴 Reddet' }
              ]
            : [{ action: 'open', title: '💬 Aç ve Yanıtla' }]
        }).catch(() => {});
      })()
    );
  }
});

// WEB PUSH OLAYI: Program tamamen kapalı olsa bile işletim sistemi / tarayıcı bu olayı tetikler!
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      await loadSwState();
      let pushed = null;
      if (event.data) {
        try {
          pushed = event.data.json();
        } catch {
          try {
            pushed = { title: 'Mesajlaşma', body: event.data.text() };
          } catch {}
        }
      }

      if (pushed) {
        if (pushed.type === 'incoming-call' && pushed.callId) {
          notifiedCallIds.add(pushed.callId);
          await saveSwState();
          await showCallNotification(pushed);
        } else if (pushed.type === 'new-message' && pushed.id) {
          const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          const anyFocused = clientList.some((c) => c.focused && c.visibilityState === 'visible');
          if (!anyFocused && !notifiedMsgIds.has(pushed.id)) {
            notifiedMsgIds.add(pushed.id);
            await saveSwState();
            await showMessageNotification(pushed);
          }
        } else if (pushed.title) {
          await self.registration.showNotification(pushed.title, {
            body: pushed.body || 'Yeni bildirim',
            icon: '/icon.svg',
            badge: '/icon.svg',
            requireInteraction: true,
            renotify: true,
            vibrate: [300, 120, 300],
            data: pushed
          }).catch(() => {});
        }
      }

      await pollServerInBackground();
    })()
  );
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'msj-bg-sync') {
    event.waitUntil(pollServerInBackground());
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'msj-bg-sync') {
    event.waitUntil(pollServerInBackground());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const action = event.action;

  event.waitUntil(
    (async () => {
      await loadSwState();

      // Gelen Arama Reddetme:
      if (notifData.type === 'incoming-call' && action === 'reject') {
        if (bgToken && notifData.callId) {
          const headers = {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + bgToken
          };
          if (bgProfile) headers['X-User-Profile'] = bgProfile;
          await fetch('/api/calls/reject', {
            method: 'POST',
            headers,
            body: JSON.stringify({ callId: notifData.callId })
          }).catch(() => {});
        }
        return;
      }

      // Arama Cevaplama veya Mesaja Gitme:
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if ('focus' in client) {
          if (notifData.type === 'incoming-call') {
            client.postMessage({
              type: 'ACCEPT_CALL_VIA_NOTIF',
              callId: notifData.callId,
              conversationId: notifData.conversationId
            });
          } else if (notifData.conversationId) {
            client.postMessage({
              type: 'OPEN_CONVERSATION',
              conversationId: notifData.conversationId
            });
          }
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        const targetUrl =
          notifData.type === 'incoming-call'
            ? `/?answerCall=${encodeURIComponent(notifData.callId || '')}&convId=${encodeURIComponent(notifData.conversationId || '')}`
            : notifData.conversationId
            ? `/?convId=${encodeURIComponent(notifData.conversationId)}`
            : '/';
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/') || event.request.url.includes('/download/')) {
    return;
  }
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
  );
});
