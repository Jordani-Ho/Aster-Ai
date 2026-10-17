import type { Identity } from '../identity'
import type { LocalStore } from '../store'
import { createTransport, type TransportOptions } from '../transport'
import { createLedgerSync } from './sync'

interface Surfaces { target: EventTarget; visibility: EventTarget; worker?: EventTarget }
export function bindLedgerSync(request: () => Promise<unknown>, refresh: () => void, surfaces: Surfaces, onError: () => void = () => {}) {
  let running = false, again = false, closed = false
  const run = () => {
    if (closed) return
    if (running) { again = true; return }
    running = true
    void Promise.resolve().then(() => { if (!closed) { refresh(); return request() } }).catch(onError).finally(() => {
      running = false
      if (again) { again = false; run() }
    })
  }
  const message = (event: globalThis.Event) => { if ((event as MessageEvent).data?.type === 'aster:sync-requested') run() }
  surfaces.target.addEventListener('focus', run)
  surfaces.target.addEventListener('online', run)
  surfaces.visibility.addEventListener('visibilitychange', run)
  surfaces.worker?.addEventListener('message', message)
  run()
  return () => {
    closed = true
    surfaces.target.removeEventListener('focus', run)
    surfaces.target.removeEventListener('online', run)
    surfaces.visibility.removeEventListener('visibilitychange', run)
    surfaces.worker?.removeEventListener('message', message)
  }
}
export function startLedgerSync(options: {
  identity: Identity; store: LocalStore; relays: string[]
  socket?: TransportOptions['socket']; onChange?: () => void; onError?: () => void; onStatus?: TransportOptions['onStatus']
}) {
  const sync = createLedgerSync({ ...options, send: (recipient, envelope) => transport.send(recipient, envelope) })
  const transport = createTransport({
    privateKey: options.identity.privateKey, relays: options.relays, socket: options.socket,
    onMessage: message => sync.receive(message),
    onStatus: status => {
      options.onStatus?.(status)
      // Reconnect also retries persisted work if a previous publish was rejected/expired.
      if (status === 'ready') void sync.requestSync().then(() => sync.flush()).catch(() => options.onError?.())
    },
  })
  const unbind = bindLedgerSync(() => sync.requestSync(), () => { transport.sync(); void sync.flush().catch(() => options.onError?.()) }, {
    target: window, visibility: document, worker: navigator.serviceWorker,
  }, options.onError)
  transport.start()
  return { sync, close() { unbind(); const pending = sync.close(); transport.close(); return pending } }
}

// A restore replaces the store: let each active ledger controller finish its queued writes first.
export async function restoreWithLedgerPaused<T>(restore: () => Promise<T>, target: EventTarget = window): Promise<T> {
  const pending: Promise<void>[] = []
  target.dispatchEvent(new CustomEvent('aster:store-restoring', { detail: { pending } }))
  try { await Promise.all(pending); return await restore() }
  finally { target.dispatchEvent(new globalThis.Event('aster:store-restored')) }
}
