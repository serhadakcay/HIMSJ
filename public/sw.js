self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/') || event.request.url.includes('/blobs/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data.json(); } catch {}

    const isCall = data.type === 'incoming-call';
    await self.registration.showNotification(data.title || 'NexusChat E2EE', {
      body: data.body || 'Yeni bildirim',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: isCall ? `call_${data.callId}` : `msg_${Date.now()}`,
      requireInteraction: true,
      renotify: true,
      vibrate: isCall ? [600, 200, 600, 200, 600, 200, 600] : [250, 100, 250],
      data,
      actions: isCall
        ? [{ action: 'answer', title: '📞 Cevapla' }, { action: 'reject', title: '❌ Reddet' }]
        : [{ action: 'open', title: '💬 Aç' }]
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
