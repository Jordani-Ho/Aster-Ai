import type { Identity } from '../identity'
import type { LocalStore } from '../store'
import type { Envelope, Message } from '../transport'
import { append, balance, createLedger, signDispute } from './chain'
import { isHex64, parseChainFields, parseDisputeFields } from './types'
import type { ChainEventDraft, DisputeDraft, Ledger, SignedLedgerEvent } from './types'
import { verify } from './verify'
import { listIdentityLinks, mappedNewKey } from '../identity/links'

const DAY = 86_400_000
/** V2-07b：老师换机时携带过来的旧钱账（只读，不改签）；键为随机 id，值带师生公钥。 */
export const LEDGER_CARRIED = 'ledger-carried'
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
/** V2-07b：按 identity-links 归并后的视图；writeStudent 是老师继续记账时写入的新公钥那本账。 */
export interface MergedLedgerView extends LedgerView { writeStudent: string }
interface CarriedBook { teacher: string; student: string; events: SignedLedgerEvent[]; receivedAt: number }
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

// One controller per identity. Each book mutation and its outbox share one IndexedDB record.
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
  // ---- V2-07b：换机时携带旧钱账 + 读取时按 identity-links 归并 ----
  async function carriedBooks(): Promise<CarriedBook[]> {
    const rows: CarriedBook[] = []
    for (const row of await store.list(LEDGER_CARRIED)) {
      const value = row.value as Partial<CarriedBook> | undefined
      if (!value || typeof value !== 'object') continue
      if (typeof value.teacher !== 'string' || !isHex64(value.teacher)) continue
      if (typeof value.student !== 'string' || !isHex64(value.student)) continue
      if (!Array.isArray(value.events) || !value.events.every(eventShape)) continue
      rows.push({ teacher: value.teacher, student: value.student, events: value.events as SignedLedgerEvent[], receivedAt: Number.isSafeInteger(value.receivedAt) ? value.receivedAt as number : 0 })
    }
    return rows
  }
  // 按 prev 链把事件排回顺序；有分叉/缺环返回 null（不覆盖本机已有）。
  function orderByChain(events: readonly SignedLedgerEvent[]): SignedLedgerEvent[] | null {
    const byId = new Map(events.map(event => [event.id, event]))
    const ordered: SignedLedgerEvent[] = []
    let prev: string | null = null
    while (ordered.length < events.length) {
      let next: SignedLedgerEvent | null = null
      for (const event of byId.values()) {
        let fields
        try { fields = parseChainFields(event) } catch { return null }
        if (fields.prev !== prev) continue
        if (next) return null
        next = event
      }
      if (!next) return null
      ordered.push(next); byId.delete(next.id); prev = next.id
    }
    return ordered
  }
  // 只读保存老师携带来的旧账；按事件 id 幂等去重，重复 carry 不产生重复记录。
  async function receiveCarry(payload: Record<string, unknown>, sender: string): Promise<void> {
    const teacher = payload.teacher, student = payload.student, events = payload.events
    if (typeof teacher !== 'string' || !isHex64(teacher) || sender !== teacher) return
    if (typeof student !== 'string' || !isHex64(student) || student === teacher) return
    if (!Array.isArray(events) || events.length === 0 || events.length > 5000 || !events.every(eventShape)) return
    const links = await listIdentityLinks(store)
    // 只收“映射到本机的旧公钥”名下的钱账；没确认过换机关系的一律不收。
    if (!links.some(link => link.kind === 'student' && link.oldKey === student && link.newKey === owner)) return
    const incoming = events as SignedLedgerEvent[]
    if (verify({ teacher, student, events: incoming, disputes: [] }).length) return
    const rows = await store.list(LEDGER_CARRIED)
    const found = rows.find(row => {
      const value = row.value as Partial<CarriedBook> | undefined
      return value?.teacher === teacher && value?.student === student
    })
    const existing = found ? orderByChain(((found.value as unknown as CarriedBook).events ?? []).filter(eventShape)) : null
    let merged = orderByChain([...(existing ?? []), ...incoming])
    if (!merged) return
    if (existing) merged = orderByChain([...existing, ...incoming]) ?? existing
    if (verify({ teacher, student, events: merged, disputes: [] }).length) return
    await store.put(LEDGER_CARRIED, found?.key ?? crypto.randomUUID(), {
      teacher, student, events: merged, receivedAt: now(),
    } as never)
    options.onChange?.()
  }
  // 老师显式把一本旧钱账携带到映射后的新身份；不群发、不按保留期限裁剪。
  async function carryTo(teacher: string, student: string, recipient: string): Promise<number> {
    if (!isHex64(teacher) || !isHex64(student) || !isHex64(recipient)) throw Error('账本携带公钥无效')
    return serial(async () => {
      const ref = await find(teacher, student)
      if (!ref) return 0
      const state = await read(ref)
      if (verify(state.ledger).length) throw Error('账本校验失败，不能携带')
      if (state.ledger.events.length === 0) return 0
      await options.send(recipient, envelope('ledger.carry', {
        teacher, student, events: state.ledger.events,
      }))
      return state.ledger.events.length
    })
  }
  async function mergedViews(): Promise<MergedLedgerView[]> {
    return serial(async () => {
      const links = await listIdentityLinks(store)
      const groups = new Map<string, {
        teacher: string; student: string
        events: SignedLedgerEvent[]; disputes: SignedLedgerEvent[]
        notices: string[]; receipts: DisputeReceipt[]; pendingDisputes: SignedLedgerEvent[]
        conflict: boolean; balance: number | null
      }>()
      const group = (teacher: string, student: string) => {
        const canonical = mappedNewKey(links, 'student', student) ?? student
        const key = teacher + ':' + canonical
        let value = groups.get(key)
        if (!value) {
          value = { teacher, student: canonical, events: [], disputes: [], notices: [], receipts: [], pendingDisputes: [], conflict: false, balance: 0 }
          groups.set(key, value)
        }
        return value
      }
      for (const ref of await refs()) {
        const state = await read(ref)
        const entry = group(ref.teacher, ref.student)
        for (const notice of state.notices) if (!entry.notices.includes(notice)) entry.notices.push(notice)
        if (state.conflicts.length) entry.conflict = true
        for (const receipt of state.receipts) if (!entry.receipts.some(item => item.id === receipt.id)) entry.receipts.push(receipt)
        for (const event of state.pendingDisputes) if (!entry.pendingDisputes.some(item => item.id === event.id)) entry.pendingDisputes.push(event)
        for (const dispute of state.ledger.disputes) if (!entry.disputes.some(item => item.id === dispute.id)) entry.disputes.push(dispute)
        if (verify(state.ledger).length) { entry.conflict = true; entry.balance = null }
        for (const event of state.ledger.events) if (!entry.events.some(item => item.id === event.id)) entry.events.push(event)
        if (entry.balance !== null && !state.conflicts.length) {
          try { entry.balance += balance(state.ledger) } catch { entry.balance = null }
          if (!Number.isSafeInteger(entry.balance)) entry.balance = null
        }
      }
      for (const carried of await carriedBooks()) {
        const entry = group(carried.teacher, carried.student)
        if (verify({ teacher: carried.teacher, student: carried.student, events: carried.events, disputes: [] }).length) { entry.conflict = true; entry.balance = null }
        for (const event of carried.events) if (!entry.events.some(item => item.id === event.id)) entry.events.push(event)
        if (entry.balance !== null) {
          try { entry.balance += balance({ teacher: carried.teacher, student: carried.student, events: carried.events, disputes: [] }) } catch { entry.balance = null }
          if (!Number.isSafeInteger(entry.balance)) entry.balance = null
        }
      }
      const result: MergedLedgerView[] = []
      for (const entry of groups.values()) {
        entry.events.sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))
        entry.disputes.sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))
        const conflict = entry.conflict || entry.balance === null
        const amount = conflict ? null : entry.balance
        const head = entry.events.at(-1)?.id.slice(0, 6) ?? '------'
        result.push({
          ledger: { teacher: entry.teacher, student: entry.student, events: entry.events, disputes: entry.disputes },
          notices: entry.notices, conflicts: [], receipts: entry.receipts, pendingDisputes: entry.pendingDisputes, outbox: [],
          conflict, balance: amount, code: amount === null ? null : `${amount} · ${head}`,
          writeStudent: entry.student,
        })
      }
      return result.sort((left, right) => left.ledger.teacher.localeCompare(right.ledger.teacher) || left.ledger.student.localeCompare(right.ledger.student))
    })
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
      // V2-07b：老师换机时携带过来的旧钱账；只读保存，按事件 id 幂等。
      if (type === 'ledger.carry' && object(payload)) { await receiveCarry(payload, message.sender); return }
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
    /** V2-07b：按 identity-links 归并后的视图；老师端钱账页与“再记一笔”都用它。 */
    mergedViews,
    /** V2-07b：把这本旧钱账携带到映射后的新身份（幂等由接收方按事件 id 保证）。 */
    carryTo,
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
        if(owner!==teacher)throw Error('钱账只能由老师确认')
        if(draft.confirmationId){
          checked(state.ledger)
          const previous=state.ledger.events.find(e=>parseChainFields(e).confirmationId===draft.confirmationId)
          if(previous){const fields=parseChainFields(previous) as unknown as Record<string,unknown>;if(Object.entries(draft).some(([k,v])=>fields[k]!==v))throw Error('确认编号已用于另一笔交易');return previous}
        }
        state.ledger = append(state.ledger, key, draft)
        checked(state.ledger)
        const event = state.ledger.events.at(-1)!
        queue(state, envelope('ledger.event', event)); await save(ref, state)
        return event
      }))
    },
    recordBatch(teacher:string,student:string,drafts:ChainEventDraft[],confirmationId:string) {
      return serial(()=>book(teacher,student,async(state,ref)=>{
        if(owner!==teacher)throw Error('钱账只能由老师确认')
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(confirmationId)||!drafts.length||drafts.length>8)throw Error('记账确认无效')
        if(drafts.some(d=>d.confirmationId!==undefined&&d.confirmationId!==confirmationId))throw Error('记账确认编号不一致')
        if(state.conflicts.length)throw Error('账本有冲突，请与老师核对')
        checked(state.ledger)
        const previous=state.ledger.events.filter(event=>parseChainFields(event).confirmationId===confirmationId)
        if(previous.length){
          if(previous.length!==drafts.length||previous.some((event,index)=>{const fields=parseChainFields(event);return Object.entries(drafts[index]).some(([key,value])=>(fields as unknown as Record<string,unknown>)[key]!==value)}))throw Error('确认编号已用于另一份草稿')
          return previous
        }
        let candidate=state.ledger
        for(const draft of drafts)candidate=append(candidate,key,{...draft,confirmationId})
        checked(candidate)
        const events=candidate.events.slice(state.ledger.events.length)
        state.ledger=candidate
        for(const event of events)queue(state,envelope('ledger.event',event))
        await save(ref,state)
        return events
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
