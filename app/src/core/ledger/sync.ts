import type { Identity } from '../identity'
import type { LocalStore } from '../store'
import type { Envelope, Message } from '../transport'
import { append, balance, createLedger, signDispute } from './chain'
import { isHex64, parseChainFields, parseDisputeFields } from './types'
import type { ChainEventDraft, DisputeDraft, Ledger, SignedLedgerEvent } from './types'
import { verify } from './verify'

const DAY = 86_400_000
interface BookRef { teacher: string; student: string; collection: string; key: string }
export interface DisputeReceipt {
  id: string
  receivedAt: number
  status: 'accepted' | 'rejected'
  delayDays: number
  message: string
}
interface Pending { id: string; envelope: Envelope }
interface BookState {
  ledger: Ledger
  notices: string[]
  conflicts: SignedLedgerEvent[]
  receipts: DisputeReceipt[]
  pendingDisputes: SignedLedgerEvent[]
  outbox: Pending[]
}
export interface LedgerView extends BookState {
  conflict: boolean
  balance: number | null
  code: string | null
}
interface Options {
  identity: Identity
  store: LocalStore
  send: (recipient: string, envelope: Envelope) => Promise<string>
  now?: () => number
  onChange?: () => void
  onError?: () => void
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function eventShape(value: unknown): value is SignedLedgerEvent {
  if (!object(value)) return false
  return isHex64(value.id) && isHex64(value.pubkey) && Number.isSafeInteger(value.created_at) && Number.isSafeInteger(value.kind)
    && typeof value.sig === 'string' && typeof value.content === 'string' && Array.isArray(value.tags)
    && value.tags.every(tag => Array.isArray(tag) && tag.every(v => typeof v === 'string'))
}
function pairOf(event: SignedLedgerEvent) {
  const tags = event.tags.filter(tag => tag[0] === 'ledger')
  if (tags.length !== 1 || tags[0].length !== 3) return null
  return { teacher: tags[0][1], student: tags[0][2] }
}
function notice(state: BookState, message: string) {
  if (!state.notices.includes(message)) state.notices.push(message)
}
function envelope(type: string, payload: unknown): Envelope { return { type, version: 1, payload } }
function queue(state: BookState, value: Envelope) { state.outbox.push({ id: crypto.randomUUID(), envelope: value }) }
function header(state: BookState) {
  const { teacher, student, events } = state.ledger
  return { teacher, student, length: events.length, head: events.at(-1)?.id ?? null }
}
function snapshot(state: BookState) {
  return envelope('ledger.sync', {
    ...header(state), events: state.ledger.events,
    disputes: [...state.ledger.disputes, ...state.pendingDisputes], receipts: state.receipts,
  })
}
function checked(ledger: Ledger) {
  const issues = verify(ledger)
  if (issues.length) throw Error('账本校验失败：' + issues[0].message)
}

// One controller per unlocked identity. Every book mutation and its outbox commit share one encrypted record.
export function createLedgerSync(options: Options) {
  const { store } = options, owner = options.identity.publicKey, key = new Uint8Array(options.identity.privateKey)
  const now = options.now ?? Date.now
  let processing = Promise.resolve(), stopped = false
  const sending = new Set<string>()
  function serial<T>(action: () => Promise<T>): Promise<T> {
    if (stopped) return Promise.reject(Error('账本同步已关闭'))
    const result = processing.then(action)
    processing = result.then(() => {}, () => {})
    return result
  }
  async function refs(): Promise<BookRef[]> {
    return (await store.list('ledger-index')).map(row => row.value as unknown as BookRef)
  }
  async function find(teacher: string, student: string) {
    return (await refs()).find(ref => ref.teacher === teacher && ref.student === student)
  }
  async function read(ref: BookRef): Promise<BookState> {
    const value = await store.get(ref.collection, ref.key)
    if (!value) throw Error('本机账本缺失，请与对方核对')
    const state = value as unknown as BookState
    if (state.ledger.teacher !== ref.teacher || state.ledger.student !== ref.student) throw Error('本机账本身份不符')
    return state
  }
  async function save(ref: BookRef, state: BookState) {
    await store.put(ref.collection, ref.key, JSON.parse(JSON.stringify(state)))
    options.onChange?.()
    queueMicrotask(() => { void flush().catch(() => options.onError?.()) })
  }
  async function book<T>(teacher: string, student: string, action: (state: BookState, ref: BookRef) => Promise<T>) {
    const ref = await find(teacher, student)
    if (!ref) throw Error('请先登记这本师生账本')
    return action(await read(ref), ref)
  }
  async function flush() {
    if (stopped) return
    const tasks = await serial(async () => {
      const tasks: { ref: BookRef; pending: Pending }[] = []
      for (const ref of await refs()) for (const pending of (await read(ref)).outbox) {
        if (!sending.has(pending.id)) { sending.add(pending.id); tasks.push({ ref, pending }) }
      }
      return tasks
    })
    for (const { ref, pending } of tasks) {
      if (stopped) { sending.delete(pending.id); continue }
      // Do not hold the storage queue while offline. ACK only removes the persisted outbox item.
      void Promise.resolve().then(() => options.send(owner === ref.teacher ? ref.student : ref.teacher, pending.envelope))
        .then(() => {
          if (stopped) return
          return serial(async () => {
            const state = await read(ref)
            state.outbox = state.outbox.filter(item => item.id !== pending.id)
            await store.put(ref.collection, ref.key, JSON.parse(JSON.stringify(state)))
          })
        }).catch(() => { if (!stopped) options.onError?.() }).finally(() => sending.delete(pending.id))
    }
  }
  function ingestEvent(state: BookState, event: SignedLedgerEvent): boolean {
    const ledger = state.ledger
    let prev: string | null
    try { prev = parseChainFields(event).prev } catch { notice(state, '事件校验失败：内容格式无效'); return false }
    const index = prev === null ? 0 : ledger.events.findIndex(e => e.id === prev) + 1
    if (prev !== null && index === 0) {
      // No standalone acceptance: request a complete chain to verify signatures AND ancestry.
      notice(state, '事件链校验失败：缺少前序记录，已请求对账')
      if (!state.outbox.some(p => p.envelope.type === 'ledger.sync' && !(p.envelope.payload as { events?: unknown }).events)) queue(state, envelope('ledger.sync', header(state)))
      return false
    }
    const candidate = { ...ledger, events: [...ledger.events.slice(0, index), event], disputes: [] }
    if (verify(candidate).length) { notice(state, '事件校验失败：签名或链无效'); return false }
    if (ledger.events[index]?.id === event.id) return true
    if (ledger.events[index]) {
      if (!state.conflicts.some(e => e.id === event.id)) state.conflicts.push(event)
      notice(state, '账本有冲突，请与老师核对')
      return false
    }
    // A previously observed fork is never resolved by accepting a later packet.
    if (state.conflicts.length) return false
    ledger.events.push(event)
    return true
  }
  function ingestDispute(state: BookState, event: SignedLedgerEvent, receivedAt: number) {
    if (state.receipts.some(r => r.id === event.id)) return
    let error = '', claimedAt = 0
    try {
      const fields = parseDisputeFields(event)
      claimedAt = Date.parse(fields.at)
      // Check future claims first so the refusal explains the receipt-time boundary.
      if (claimedAt > receivedAt) error = '自报时间晚于老师收到时间'
      const issues = verify({ ...state.ledger, disputes: [event] })
      if (!error && issues.length) {
        const code = issues[0].code
        error = code === 'dispute-too-early' ? '自报时间早于扣费时间' : code === 'dispute-too-late' ? '自报时间超过扣费后 7 天' : '异议校验失败：' + issues[0].message
      }
    } catch { error = '异议校验失败：内容格式无效' }
    const delayDays = !error && receivedAt - claimedAt > DAY ? Math.floor((receivedAt - claimedAt) / DAY) : 0
    const receipt: DisputeReceipt = { id: event.id, receivedAt, status: error ? 'rejected' : 'accepted', delayDays, message: error || (delayDays ? `迟到 ${delayDays} 天送达` : '异议已收到') }
    state.receipts.push(receipt)
    if (!error && !state.ledger.disputes.some(e => e.id === event.id)) state.ledger.disputes.push(event)
    if (error) notice(state, error)
  }
  async function receive(message: Message) {
    if (stopped || message.sender === owner || !message.envelope.type.startsWith('ledger.')) return
    // Actual arrival is captured before waiting for local storage work, never from the rumor timestamp.
    const receivedAt = now()
    return serial(async () => {
      const { type, version, payload } = message.envelope
      if (version !== 1) return
      const pair = type === 'ledger.sync' && object(payload) ? payload : eventShape(payload) ? pairOf(payload) : null
      if (!pair || !isHex64(pair.teacher) || !isHex64(pair.student)) return
      const ref = await find(pair.teacher, pair.student)
      if (!ref || message.sender !== (owner === ref.teacher ? ref.student : ref.teacher)) return
      const state = await read(ref)
      if (type === 'ledger.event' && eventShape(payload)) {
        if (message.sender !== ref.teacher) notice(state, '事件校验失败：记账只能由老师签发')
        else ingestEvent(state, payload)
      } else if (type === 'ledger.dispute' && eventShape(payload)) {
        if (owner !== ref.teacher) notice(state, '异议校验失败：请由学生发给老师')
        else { ingestDispute(state, payload, receivedAt); queue(state, snapshot(state)) }
      } else if (type === 'ledger.sync' && object(payload)) {
        if (!Number.isSafeInteger(payload.length) || (payload.length as number) < 0 || !(payload.head === null || isHex64(payload.head))) {
          notice(state, '对账校验失败：摘要格式无效')
        } else if (!('events' in payload)) {
          if ((payload.length as number) < state.ledger.events.length) notice(state, `对方账本缺少第 ${(payload.length as number) + 1} 条`)
          queue(state, snapshot(state))
          if ((payload.length as number) > state.ledger.events.length) queue(state, envelope('ledger.sync', header(state)))
        } else if (!Array.isArray(payload.events) || !payload.events.every(eventShape) || payload.length !== payload.events.length || payload.head !== (payload.events.at(-1)?.id ?? null)) {
          notice(state, '对账校验失败：事件或摘要格式无效')
        } else {
          const events = payload.events as SignedLedgerEvent[]
          const ids = new Set(events.map(e => e.id))
          const missing = state.ledger.events.findIndex(e => !ids.has(e.id))
          if (missing >= 0) notice(state, `对方账本缺少第 ${missing + 1} 条`)
          // Examine each candidate against the locally trusted prefix to detect valid fork evidence,
          // even if another part of the remote snapshot has a gap. Never replace the local chain.
          const valid = verify({ ...state.ledger, events, disputes: [] }).length === 0
          if (!valid) notice(state, '对账校验失败：签名或链无效')
          for (const event of events) {
            let prev: string | null
            try { prev = parseChainFields(event).prev } catch { continue }
            const index = prev === null ? 0 : state.ledger.events.findIndex(e => e.id === prev) + 1
            const hasSuccessor = (prev === null || index > 0) && !!state.ledger.events[index]
            if (owner === ref.student && valid) ingestEvent(state, event)
            else if (hasSuccessor) ingestEvent(state, event)
            else if (owner === ref.teacher && valid && !state.ledger.events.some(e => e.id === event.id)) {
              notice(state, '本机账本缺少记录，请与学生核对')
            }
          }
          if (Array.isArray(payload.disputes)) for (const event of payload.disputes) {
            if (!eventShape(event)) { notice(state, '异议校验失败：事件格式无效'); continue }
            if (owner === ref.teacher) ingestDispute(state, event, receivedAt)
            else if (!verify({ ...state.ledger, disputes: [event] }).length && !state.ledger.disputes.some(e => e.id === event.id)) {
              state.ledger.disputes.push(event)
              state.pendingDisputes = state.pendingDisputes.filter(e => e.id !== event.id)
            }
          }
          if (owner === ref.teacher && Array.isArray(payload.disputes) && payload.disputes.length) queue(state, snapshot(state))
          if (owner === ref.student && Array.isArray(payload.receipts)) for (const receipt of payload.receipts) {
            if (!object(receipt) || !isHex64(receipt.id) || typeof receipt.message !== 'string' || !Number.isFinite(receipt.receivedAt) || !Number.isSafeInteger(receipt.delayDays) || !['accepted', 'rejected'].includes(receipt.status as string)) continue
            if (!state.receipts.some(r => r.id === receipt.id)) state.receipts.push(receipt as unknown as DisputeReceipt)
            if (receipt.status === 'rejected') notice(state, receipt.message)
            state.pendingDisputes = state.pendingDisputes.filter(e => e.id !== receipt.id)
          }
        }
      } else return
      await save(ref, state)
    })
  }
  return {
    receive,
    async open(teacher: string, student: string) {
      return serial(async () => {
        const ledger = createLedger(teacher, student)
        if (teacher === student || (owner !== teacher && owner !== student)) throw Error('只能登记本人参与的师生账本')
        if (await find(teacher, student)) return
        const ref = { teacher, student, collection: 'ledger-' + crypto.randomUUID().replaceAll('-', ''), key: crypto.randomUUID() }
        await save(ref, { ledger, notices: [], conflicts: [], receipts: [], pendingDisputes: [], outbox: [] })
        await store.put('ledger-index', crypto.randomUUID(), ref)
      })
    },
    books() { return serial(refs) },
    view(teacher: string, student: string): Promise<LedgerView> {
      return serial(() => book(teacher, student, async state => {
        const conflict = state.conflicts.length > 0, invalid = verify(state.ledger).length > 0
        const amount = conflict || invalid ? null : balance(state.ledger)
        if (invalid) notice(state, '本机账本校验失败，请与对方核对')
        return { ...state, conflict, balance: amount, code: amount === null ? null : `${amount} · ${state.ledger.events.at(-1)?.id.slice(0, 6) ?? '------'}` }
      }))
    },
    record(teacher: string, student: string, draft: ChainEventDraft) {
      return serial(() => book(teacher, student, async (state, ref) => {
        if (state.conflicts.length) throw Error('账本有冲突，请与老师核对')
        state.ledger = append(state.ledger, key, draft)
        checked(state.ledger)
        const event = state.ledger.events.at(-1)!
        queue(state, envelope('ledger.event', event)); await save(ref, state)
        return event
      }))
    },
    dispute(teacher: string, student: string, draft: DisputeDraft) {
      return serial(() => book(teacher, student, async (state, ref) => {
        if (owner !== student) throw Error('异议只能由学生签发')
        const event = signDispute(state.ledger, key, draft)
        checked({ ...state.ledger, disputes: [event] })
        // The teacher confirms admission; pending submissions do not enter the accepted list.
        state.pendingDisputes.push(event)
        queue(state, envelope('ledger.dispute', event)); await save(ref, state)
        return event
      }))
    },
    requestSync() {
      return serial(async () => {
        for (const ref of await refs()) {
          const state = await read(ref)
          queue(state, envelope('ledger.sync', header(state))); await save(ref, state)
        }
      })
    },
    flush,
    close() { stopped = true; return processing.then(() => { key.fill(0) }) },
  }
}
