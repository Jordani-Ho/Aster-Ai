import { nip98Authorization } from '../llm/nip98'
export interface PushConfig { gatewayUrl: string; secretKey: Uint8Array; vapidPublicKey: string }
export function needsInstallHint(state: { supported: boolean; ios: boolean; standalone: boolean }): boolean {
  return !state.supported || (state.ios && !state.standalone)
}
export function pushEnvironment() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  return { supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window, ios, standalone }
}
function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
export function createPushClient(config: PushConfig) {
  const base = new URL(config.gatewayUrl)
  if (base.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(base.hostname) && base.protocol === 'http:')) throw new Error('推送服务需要 HTTPS')
  async function post(path: string, value: object) {
    const url = new URL(path, base).href
    const body = JSON.stringify(value)
    const authorization = await nip98Authorization(config.secretKey, url, 'POST', body)
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body })
    if (!response.ok) throw new Error('提醒服务暂不可用（' + response.status + '）')
  }
  return {
    async subscribe() {
      if (await Notification.requestPermission() !== 'granted') throw new Error('未获得通知权限')
      await navigator.serviceWorker.register('/sw.js')
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: applicationKey(config.vapidPublicKey),
      })
      await post('/push/subscribe', { subscription: subscription.toJSON() })
    },
    async unsubscribe() {
      // 即使当前浏览器没有 SW，也能删除服务端映射。
      await post('/push/unsubscribe', {})
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration('/sw.js')
        const subscription = await registration?.pushManager.getSubscription()
        await subscription?.unsubscribe()
      }
    },
    async notifyRecipient(pubkey: string) {
      if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('收件公钥无效')
      await post('/push/notify', { pubkey })
    },
    /** 本人的督促只发一个无内容的唤醒通知；提醒文字始终留在本机。 */
    async notifySubscribedSelf(pubkey: string): Promise<boolean> {
      if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('收件公钥无效')
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return false
      const registration = await navigator.serviceWorker.getRegistration('/sw.js')
      if (!registration || !await registration.pushManager.getSubscription()) return false
      await post('/push/notify', { pubkey })
      return true
    },
  }
}
// 供 M1-05 接入真实同步函数；初次打开、前台恢复及网络恢复都尝试同步。
export function syncWhenOpen(sync: () => Promise<unknown>, target: EventTarget = window, onError: () => void = () => {}): () => void {
  let pending = false, closed = false
  const run = () => {
    if (pending || closed) return
    pending = true
    void Promise.resolve().then(sync).catch(onError).finally(() => { pending = false })
  }
  for (const event of ['focus', 'online', 'visibilitychange']) target.addEventListener(event, run)
  run()
  return () => { closed = true; for (const event of ['focus', 'online', 'visibilitychange']) target.removeEventListener(event, run) }
}
