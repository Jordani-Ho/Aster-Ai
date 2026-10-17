// 推送数据不读取、不解析，所有通知始终为固定文字。
self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('知衡：有新消息', { tag: 'aster-new-message', data: { url: '/' } }))
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
