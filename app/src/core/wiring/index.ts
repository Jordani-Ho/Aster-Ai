import type { Identity } from '../identity'
import type { LocalStore } from '../store'
import type { Envelope, TransportOptions } from '../transport'
import { createTransport } from '../transport'
import { createLedgerSync } from '../ledger/sync'
import { createInbox, flushIntakeOutbox, loadTeachers, sendConsultPackage } from '../inbox'
import { autoRestore } from '../records/backup'
import type { ConsultPackage } from '../record/types'
import { createAppointmentInbox } from '../appointments'

// M1-15a：一个 createTransport 实例 + 一个收件分发 + 一个账本同步控制器。
// 所有业务消息（问诊包、照片、签字病历、账本事件）都走同一个发送函数；
// 每次发送成功后调用一次 notifyRecipient，提醒失败不影响发送结果。
export interface WiringOptions {
  identity: Identity
  store: LocalStore
  relays: string[]
  socket?: TransportOptions['socket']
  notifier?: (pubkey: string) => Promise<void>
  onStatus?: TransportOptions['onStatus']
  onChange?: () => void
  onError?: () => void
}

export function createWiring(options: WiringOptions) {
  const { identity, store } = options
  let transport: ReturnType<typeof createTransport>
  async function send(recipient: string, envelope: Envelope): Promise<string> {
    const id = await transport.send(recipient, envelope)
    // 每次发送成功后提醒收件人（M1-08）；推送失败不影响已经成功的发送。
    try { await options.notifier?.(recipient) } catch { /* 提醒不是发送成功条件。 */ }
    return id
  }
  const ledger = createLedgerSync({ identity, store, send, onChange: options.onChange, onError: options.onError })
  const appointments = createAppointmentInbox({ identity, store, send })
  const inbox = createInbox({ identity, store, ledger, send, appointments })
  transport = createTransport({
    privateKey: identity.privateKey,
    relays: options.relays,
    socket: options.socket,
    onMessage: async message => { await inbox.receive(message); options.onChange?.() },
    onStatus: status => {
      options.onStatus?.(status)
      if (status === 'ready') {
        transport.sync()
        // 重连后补一次对账与待发队列。
        void ledger.requestSync().then(() => ledger.flush()).catch(() => options.onError?.())
        // V2-05：师生互为备份——连上中继后自动补发恢复请求（每天最多一次）。
        void (async () => {
          const teachers = await loadTeachers(store)
          await autoRestore(store, teachers, send)
        })().catch(() => {})
      }
    },
  })
  return {
    identity,
    store,
    ledger,
    appointments,
    inbox,
    send,
    sendConsult: (pkg: ConsultPackage) => sendConsultPackage(send, pkg, { store }),
    flushIntakeOutbox: () => flushIntakeOutbox(store, send),
    start() { transport.start() },
    async close() { transport.close(); await ledger.close() },
  }
}

export type Wiring = ReturnType<typeof createWiring>
