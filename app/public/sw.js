// 推送数据不读取、不解析，所有通知始终为固定文字。
self.addEventListener('push', event => {
  event.waitUntil(Promise.all([
    self.registration.showNotification('知衡：有新消息', { tag: 'aster-new-message', data: { url: '/' } }),
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) if (new URL(client.url).origin === self.location.origin) {
        client.postMessage({ type: 'aster:sync-requested' })
      }
    })(),
  ]))
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const client = windows.find(item => new URL(item.url).origin === self.location.origin)
    if (client) { await client.focus(); client.postMessage({ type: 'aster:sync-requested' }) }
    else await self.clients.openWindow('/')
  })())
})
