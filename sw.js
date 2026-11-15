// BUILD_VER: 400
/**
 * Mesajlaşma Uygulaması - Service Worker (Arka Planda Çalışma ve Bildirim Motoru)
 * Uygulama kapatılsa bile arka planda yeni mesaj ve aramaları kontrol eder ve bildirim gösterir.
 */

const CACHE_NAME = 'mesajlasma-pwa-v7';

let bgToken = '';
let lastPollIso = new Date().toISOString();
let notifiedMsgIds = new Set();
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
          client.postMessage({ type: 'SW_FORCE_RELOAD', buildVer: 400 });
        } catch {}
      }
    })()
  );
});

async function pollServerInBackground() {
  if (!bgToken) return;
  try {
    const res = await fetch(`/api/notifications/poll?token=${encodeURIComponent(bgToken)}&since=${encodeURIComponent(lastPollIso)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.serverTime) {
      lastPollIso = data.serverTime;
    }

    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const anyFocused = clientList.some((c) => c.focused);

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
          vibrate: [200, 100, 200],
          data: { conversationId: m.conversation_id }
        });
      }
    }
  } catch {
    // Çevrimdışıysa sonraki döngüde dener
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SET_BG_TOKEN') {
    bgToken = data.token || '';
    lastPollIso = new Date().toISOString();
    if (bgInterval) clearInterval(bgInterval);
    if (bgToken) {
      bgInterval = setInterval(pollServerInBackground, 15000);
    }
  } else if (data.type === 'SHOW_LOCAL_NOTIFICATION') {
    self.registration.showNotification(data.title || 'Mesajlaşma', {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      vibrate: [250, 120, 250],
      data: data.payload || {}
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
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
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
