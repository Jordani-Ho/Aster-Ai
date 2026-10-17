import { readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import webpush from 'web-push'

export const PUSH_TEXT = '知衡：有新消息'
export const PUSH_ROUTES = ['/push/subscribe', '/push/unsubscribe', '/push/notify']
const DEFAULT_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']

// 单进程 M1 存储。写入完成且 fsync 后才 rename；失败时保留旧文件和内存快照。
export class SubscriptionStore {
  constructor(file, beforeRename = () => {}) {
    this.file = file
    this.beforeRename = beforeRename
    try {
      this.records = JSON.parse(readFileSync(file, 'utf8'))
      if (!this.records || typeof this.records !== 'object' || Array.isArray(this.records)) throw new Error('invalid subscription file')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.records = {}
    }
  }
  get(pubkey) { return this.records[pubkey] }
  set(pubkey, subscription) {
    const next = { ...this.records }
    if (subscription) next[pubkey] = subscription
    else delete next[pubkey]
    const temp = this.file + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      const fd = openSync(temp, 'r+')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      this.beforeRename()
      renameSync(temp, this.file)
      this.records = next
    } catch (error) {
      try { unlinkSync(temp) } catch { /* 实际崩溃遗留的临时文件不读取 */ }
      throw error
    }
  }
}

function cleanSubscription(input, hosts) {
  const endpoint = new URL(input?.endpoint)
  // 订阅端点不能成为成员访问内网或任意网站的代理。按精确主机白名单部署。
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port ||
      endpoint.hash || !hosts.includes(endpoint.hostname)) throw new Error('invalid push endpoint')
  const p256dh = input?.keys?.p256dh, auth = input?.keys?.auth
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{87}={0,1}$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(auth)) throw new Error('invalid push keys')
  return { endpoint: endpoint.href, keys: { p256dh, auth } }
}

export function createPushService({ file, send, endpointHosts = DEFAULT_HOSTS, now = Date.now }) {
  const store = new SubscriptionStore(file)
  const hits = new Map()
  const sending = send ?? ((subscription, text) => webpush.sendNotification(subscription, text, {
    vapidDetails: { subject: process.env.VAPID_SUBJECT, publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY },
    timeout: 10000, TTL: 60,
  }))
  return {
    async handle(path, caller, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400 }
      if (path === '/push/subscribe') {
        let subscription
        try { subscription = cleanSubscription(body.subscription, endpointHosts) } catch { return { status: 400 } }
        store.set(caller, subscription)
        return { status: 200 }
      }
      if (path === '/push/unsubscribe') {
        store.set(caller, null)
        return { status: 200 }
      }
      if (path !== '/push/notify' || !/^[0-9a-f]{64}$/.test(body.pubkey)) return { status: 400 }
      const time = now()
      for (const [key, values] of hits) {
        const recent = values.filter(at => time - at < 60000)
        if (recent.length) hits.set(key, recent)
        else hits.delete(key)
      }
      const key = caller + ':' + body.pubkey, recent = hits.get(key) ?? []
      if (recent.length >= 5) return { status: 429 }
      hits.set(key, [...recent, time])
      const subscription = store.get(body.pubkey)
      if (subscription) {
        try { await sending(subscription, PUSH_TEXT) } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            // 若发送过程中用户重订阅，不删除新订阅。
            if (store.get(body.pubkey) === subscription) store.set(body.pubkey, null)
          } else return { status: 502 }
        }
      }
      // 不披露收件人是否订阅；不返回端点或令牌。
      return { status: 202 }
    },
  }
}

