const SW_VER = 'nexus-sw-v14';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys().catch(() => []);
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      try { data = { body: event.data.text() }; } catch {}
    }

    const isCall = data.type === 'incoming-call';
    const title = data.title || (isCall ? '📞 Gelen Arama' : '💬 Yeni Mesaj');
    const body = data.body || (isCall ? 'Yanıtlamak için dokunun' : 'Yeni mesajınız var');

    await self.registration.showNotification(title, {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: isCall ? `call_${data.callId || Date.now()}` : `msg_${data.senderId || Date.now()}`,
      requireInteraction: true,
      renotify: true,
      silent: false,
      vibrate: isCall ? [700, 250, 700, 250, 700, 250, 700] : [300, 120, 300],
      data,
      actions: isCall
        ? [
            { action: 'answer', title: '📞 Cevapla' },
            { action: 'reject', title: '❌ Reddet' }
          ]
        : [{ action: 'open', title: '💬 Mesajı Aç' }]
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        if (data.type === 'incoming-call' && action !== 'reject') {
          client.postMessage({ type: 'ANSWER_CALL_FROM_NOTIF', callId: data.callId });
        } else if (data.senderId) {
          client.postMessage({ type: 'OPEN_CHAT_FROM_NOTIF', peerId: data.senderId });
        }
        return client.focus();
      }
    }
    if (self.clients.openWindow) {
      const targetUrl = data.type === 'incoming-call' && action !== 'reject'
        ? `/?answerCall=${encodeURIComponent(data.callId || '')}`
        : data.senderId ? `/?chatWith=${encodeURIComponent(data.senderId)}` : '/';
      return self.clients.openWindow(targetUrl);
    }
  })());
});
