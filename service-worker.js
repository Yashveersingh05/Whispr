self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data.json(); } catch { return; }
  if (!payload?.callId) return;
  event.waitUntil((async () => {
    const tag = `whispr-call-${payload.callId}`;
    if (payload.dismissed) {
      const notifications = await self.registration.getNotifications({ tag });
      notifications.forEach((notification) => notification.close());
      return;
    }
    if (!payload.chatId) return;
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clientsList.some((client) => client.visibilityState === 'visible')) return;
    await self.registration.showNotification(payload.group ? `Group ${payload.video ? 'video' : 'voice'} call` : payload.video ? 'Incoming video call' : 'Incoming voice call', {
      body: payload.group ? `${payload.from || 'Someone'} started a call in ${payload.groupName || 'a group'}` : `${payload.from || 'Someone'} is calling you`,
      icon: '/logo.png',
      badge: '/logo.png',
      tag,
      renotify: true,
      requireInteraction: true,
      data: { callId: payload.callId }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const callId = event.notification.data?.callId;
  if (!callId) return;
  const target = new URL(`/interface.html?callId=${encodeURIComponent(callId)}`, self.location.origin).href;
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clientsList[0];
    if (existing) {
      try { await existing.navigate(target); } catch { /* Focus the open app as a fallback. */ }
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
