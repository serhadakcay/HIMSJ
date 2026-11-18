// BUILD_VER: 710
/**
 * Mesajlaşma Uygulaması - Service Worker (Arka Planda Çalışma, Çağrı & Bildirim Motoru v7.1)
 * Uygulama simge durumuna küçültülse veya kapatılsa bile gelen sesli/görüntülü aramaları ve mesajları bildirir.
 */

const CACHE_NAME = 'mesajlasma-pwa-v11';

let bgToken = '';
let notifiedMsgIds = new Set();
let notifiedCallIds = new Set();
let bgInterval = null;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {}
      await self.clients.claim();
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        try {
          client.postMessage({ type: 'SW_FORCE_RELOAD', buildVer: 710 });
          if ('navigate' in client) {
            await client.navigate(client.url).catch(() => {});
          }
        } catch {}
      }
    })()
  );
});

async function pollServerInBackground() {
  if (!bgToken) return;
  try {
    const res = await fetch(`/api/notifications/poll?token=${encodeURIComponent(bgToken)}`);
    if (!res.ok) return;
    const data = await res.json();

    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const anyFocused = clientList.some((c) => c.focused);

    // 1. GELEN ARAMALAR (EN YÜKSEK ÖNCELİK - GÜÇLÜ TİTREŞİM VE ARAMA KONTROLLERİ)
    if (Array.isArray(data.incomingCalls) && data.incomingCalls.length > 0) {
      for (const call of data.incomingCalls) {
        if (notifiedCallIds.has(call.callId)) continue;
        notifiedCallIds.add(call.callId);

        const isVideo = call.callType === 'video';
        await self.registration.showNotification(`📞 GELEN ARAMA: ${call.callerName}`, {
          body: (isVideo ? '📹 Görüntülü Arama' : '📞 Sesli Arama') + ' Geliyor — Yanıtlamak için dokunun',
          icon: '/icon.svg',
          badge: '/icon.svg',
          tag: 'call_' + call.callId,
          requireInteraction: true,
          renotify: true,
          vibrate: [500, 200, 500, 200, 500, 200, 500, 200, 500],
          data: {
            type: 'incoming-call',
            callId: call.callId,
            conversationId: call.conversationId,
            callerId: call.callerId,
            callerName: call.callerName,
            callType: call.callType
          },
          actions: [
            { action: 'answer', title: '🟢 Cevapla' },
            { action: 'reject', title: '🔴 Reddet' }
          ]
        }).catch(() => {});
      }
    }

    // 2. OKUNMAMIŞ MESAJLAR (Uygulama odakta değilse bildir)
    if (!anyFocused && Array.isArray(data.unreadMessages)) {
      for (const m of data.unreadMessages) {
        if (notifiedMsgIds.has(m.id)) continue;
        notifiedMsgIds.add(m.id);

        await self.registration.showNotification(`💬 ${m.sender_name}`, {
          body: m.content || '🔒 Yeni şifreli mesaj aldınız',
          icon: '/icon.svg',
          badge: '/icon.svg',
          tag: 'msj-' + m.id,
          renotify: true,
          vibrate: [250, 100, 250],
          data: {
            type: 'new-message',
            conversationId: m.conversation_id
          }
        }).catch(() => {});
      }
    }
  } catch {}
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SET_BG_TOKEN') {
    bgToken = data.token || '';
    if (bgInterval) clearInterval(bgInterval);
    if (bgToken) {
      pollServerInBackground();
      bgInterval = setInterval(pollServerInBackground, 10000);
    }
  } else if (data.type === 'SHOW_LOCAL_NOTIFICATION') {
    const isCall = data.payload && data.payload.type === 'incoming-call';
    self.registration.showNotification(data.title || 'Mesajlaşma', {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag || (isCall ? 'call_' + (data.payload.callId || 'act') : 'local_' + Date.now()),
      requireInteraction: Boolean(isCall),
      renotify: true,
      vibrate: isCall ? [500, 200, 500, 200, 500, 200, 500, 200, 500] : [250, 120, 250],
      data: data.payload || {},
      actions: isCall ? [
        { action: 'answer', title: '🟢 Cevapla' },
        { action: 'reject', title: '🔴 Reddet' }
      ] : []
    }).catch(() => {});
  }
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

  // Gelen Arama Reddetme:
  if (notifData.type === 'incoming-call' && action === 'reject') {
    if (bgToken && notifData.callId) {
      fetch('/api/calls/reject', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + bgToken
        },
        body: JSON.stringify({ callId: notifData.callId })
      }).catch(() => {});
    }
    return;
  }

  // Arama Cevaplama veya Mesaja Gitme:
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if (notifData.type === 'incoming-call') {
            client.postMessage({ type: 'ACCEPT_CALL_VIA_NOTIF', callId: notifData.callId });
          } else if (notifData.conversationId) {
            client.postMessage({ type: 'OPEN_CONVERSATION', conversationId: notifData.conversationId });
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        const url = notifData.type === 'incoming-call'
          ? `/?answerCall=${encodeURIComponent(notifData.callId)}&convId=${encodeURIComponent(notifData.conversationId || '')}`
          : '/';
        return self.clients.openWindow(url);
      }
    })
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
