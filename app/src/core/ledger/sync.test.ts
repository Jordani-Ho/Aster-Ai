import { afterEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { createTransport, type Socket, type Message } from '../transport'
import { validSignature, expiration } from '../transport/crypto'
import { openStore, type LocalStore } from '../store'
import { createIdentity } from '../identity'
import { append, createLedger, signDispute, signEvent } from './index'
import { createLedgerSync } from './sync'

const teacher = createIdentity(), student = createIdentity()
const teacherPub = teacher.publicKey, studentPub = student.publicKey
const at = (day: number) => new Date(Date.UTC(2026, 9, 1) + day * 86_400_000).toISOString()
const closers: (() => void)[] = []
const eventually = (check: () => unknown | Promise<unknown>) => vi.waitFor(check, { timeout: 10000, interval: 25 })
vi.setConfig({ testTimeout: 30000 })
afterEach(() => { closers.splice(0).reverse().forEach(close => close()) })

// Same authenticated inbox/expiry contract as transport.test.ts; all data is synthetic.
class MemoryRelay {
  events = new Map<string, Event>(); clients = new Set<MemorySocket>()
  members = new Set([teacherPub, studentPub])
  socket = (): Socket => new MemorySocket(this)
}
class MemorySocket implements Socket {
  readyState = 0; onopen: Socket['onopen'] = null; onclose: Socket['onclose'] = null
  onerror: Socket['onerror'] = null; onmessage: Socket['onmessage'] = null
  challenge = crypto.randomUUID(); owner = ''; sub = false
  constructor(private relay: MemoryRelay) {
    relay.clients.add(this)
    queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); this.emit(['AUTH', this.challenge]) })
  }
  emit(value: unknown) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }) }) }
  send(data: string) {
    const [cmd, first, filter] = JSON.parse(data)
    if (cmd === 'AUTH') {
      const e = first as Event, tags = Object.fromEntries(e.tags)
      const valid = validSignature(e) && e.kind === 22242 && this.relay.members.has(e.pubkey) && tags.challenge === this.challenge && tags.relay === 'ws://localhost/'
      if (valid) this.owner = e.pubkey
      this.emit(['OK', e.id, valid, '']); return
    }
    if (!this.owner) throw Error('auth required')
    if (cmd === 'REQ') {
      if (filter['#p']?.length !== 1 || filter['#p'][0] !== this.owner) throw Error('own inbox only')
      this.sub = true
      for (const e of this.relay.events.values()) if (expiration(e) > Date.now() / 1000 && e.tags.some(t => t[0] === 'p' && t[1] === this.owner)) this.emit(['EVENT', 'inbox', e])
    } else if (cmd === 'EVENT') {
      const e = first as Event
      if (!validSignature(e) || expiration(e) <= Date.now() / 1000) throw Error('invalid event')
      if (!this.relay.events.has(e.id)) {
        this.relay.events.set(e.id, JSON.parse(JSON.stringify(e)))
        for (const client of this.relay.clients) if (client.sub && e.tags.some(t => t[0] === 'p' && t[1] === client.owner)) client.emit(['EVENT', 'inbox', e])
      }
      this.emit(['OK', e.id, true, ''])
    }
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.relay.clients.delete(this); this.onclose?.({}) }
}
async function pair() {
  const relay = new MemoryRelay()
  let time = Date.parse(at(9))
  async function node(identity: typeof teacher, store?: LocalStore) {
    store ??= await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
    const sync = createLedgerSync({ identity, store, send: (recipient, envelope) => transport.send(recipient, envelope), now: () => time })
    const transport = createTransport({ privateKey: identity.privateKey, relays: ['ws://localhost/'], socket: relay.socket, onMessage: m => sync.receive(m) })
    closers.push(() => { sync.close(); transport.close() }, () => store!.close())
    await sync.open(teacherPub, studentPub)
    transport.start()
    return { sync, transport, store, view: () => sync.view(teacherPub, studentPub) }
  }
  const a = await node(teacher), b = await node(student)
  return { a, b, relay, node, setTime: (day: number) => { time = Date.parse(at(day)) } }
}
const topup = { type: 'topup' as const, currency: 'CNY', amount: 10, at: at(0) }
const charge = { type: 'charge' as const, currency: 'CNY', amount: 3, chargeReason: 'consult' as const, at: at(0) }
async function charged(p: Awaited<ReturnType<typeof pair>>) {
  await p.a.sync.record(teacherPub, studentPub, topup)
  const event = await p.a.sync.record(teacherPub, studentPub, charge)
  await eventually(async () => expect((await p.b.view()).ledger.events).toHaveLength(2))
  return event
}
it('1 teacher topup 10 charge 3 -> both balance 7 and identical comparison code', async () => {
  const p = await pair(); await charged(p)
  expect((await p.a.view()).code).toBe((await p.b.view()).code)
  expect((await p.b.view()).balance).toBe(7)
})
it('2 offline student catches up with full sync after 3 entries', async () => {
  const p = await pair(); p.b.sync.close(); p.b.transport.close()
  for (let i = 0; i < 3; i++) await p.a.sync.record(teacherPub, studentPub, { ...topup, at: at(i) })
  // Clear relay history: full sync must repair delivery gaps without relying on old wraps.
  p.relay.events.clear()
  const b = await p.node(student, p.b.store)
  await b.sync.requestSync()
  await eventually(async () => expect((await b.view()).balance).toBe(30))
  expect((await b.view()).code).toBe((await p.a.view()).code)
})
it('3 same signed event in different envelopes and after controller restart stays idempotent', async () => {
  const p = await pair(); await charged(p)
  const event = (await p.a.view()).ledger.events[0]
  p.b.sync.close(); p.b.transport.close()
  const b = await p.node(student, p.b.store)
  await p.a.transport.send(studentPub, { type: 'ledger.event', version: 1, payload: event })
  await b.sync.requestSync()
  await eventually(async () => expect((await b.view()).ledger.events).toHaveLength(2))
  expect((await b.view()).balance).toBe(7)
})
it('4 teacher missing middle entry is reported, student history is not repaired/replaced', async () => {
  const p = await pair(); await charged(p)
  await p.a.sync.record(teacherPub, studentPub, { ...topup, at: at(1) })
  await eventually(async () => expect((await p.b.view()).ledger.events).toHaveLength(3))
  const registry = (await p.a.store.list('ledger-index'))[0].value as { collection: string; key: string }
  const state = await p.a.store.get(registry.collection, registry.key) as unknown as { ledger: { events: Event[] } }
  state.ledger.events.splice(1, 1)
  await p.a.store.put(registry.collection, registry.key, JSON.parse(JSON.stringify(state)))
  await p.b.sync.requestSync()
  await eventually(async () => expect((await p.b.view()).notices).toContain('对方账本缺少第 2 条'))
  expect((await p.b.view()).ledger.events).toHaveLength(3)
})
it('5 verified fork hides balance and persists across restarts', async () => {
  const p = await pair(); await charged(p)
  const ledger = (await p.a.view()).ledger
  const fork = signEvent({ ...ledger, events: ledger.events.slice(0, 1) }, teacher.privateKey, { ...charge, amount: 2 })
  await p.a.transport.send(studentPub, { type: 'ledger.event', version: 1, payload: fork })
  await eventually(async () => expect((await p.b.view()).conflict).toBe(true))
  expect((await p.b.view()).balance).toBeNull(); expect((await p.b.view()).code).toBeNull()
  expect((await p.b.view()).notices).toContain('账本有冲突，请与老师核对')
  p.b.sync.close(); p.b.transport.close()
  const b = await p.node(student, p.b.store)
  expect((await b.view()).balance).toBeNull()
})
it('6 day 6 reported / day 9 received is accepted and marked 3 days late, without changing balance', async () => {
  const p = await pair(), chargeEvent = await charged(p)
  await p.b.sync.dispute(teacherPub, studentPub, { disputeFor: chargeEvent.id, memo: 'SYNTHETIC', at: at(6) })
  await eventually(async () => expect((await p.a.view()).ledger.disputes).toHaveLength(1))
  expect((await p.a.view()).receipts[0]).toMatchObject({ status: 'accepted', delayDays: 3, message: '迟到 3 天送达' })
  expect((await p.a.view()).balance).toBe(7)
  await eventually(async () => expect((await p.b.view()).ledger.disputes).toHaveLength(1))
})
it('6 day 8 report, report before charge and future report are rejected with explanation', async () => {
  const p = await pair(), event = await charged(p), ledger = (await p.b.view()).ledger
  for (const [day, explanation] of [[8, '超过扣费后 7 天'], [-1, '早于扣费时间'], [10, '晚于老师收到时间']] as const) {
    const dispute = signDispute(ledger, student.privateKey, { disputeFor: event.id, memo: 'SYNTHETIC', at: at(day) })
    await p.b.transport.send(teacherPub, { type: 'ledger.dispute', version: 1, payload: dispute })
    await eventually(async () => expect((await p.b.view()).notices.some(n => n.includes(explanation))).toBe(true))
  }
  expect((await p.a.view()).ledger.disputes).toHaveLength(0)
})
it('7 tampered amount or signature is not admitted, not treated as a fork', async () => {
  const p = await pair(); await charged(p)
  const ledger = (await p.a.view()).ledger
  const event = signEvent(ledger, teacher.privateKey, { ...topup, at: at(1) })
  event.content = event.content.replace('10', '999')
  await p.a.transport.send(studentPub, { type: 'ledger.event', version: 1, payload: event })
  await eventually(async () => expect((await p.b.view()).notices.some(n => n.includes('校验失败'))).toBe(true))
  expect((await p.b.view()).balance).toBe(7); expect((await p.b.view()).conflict).toBe(false)
})
it('out of order delivery requests a snapshot instead of dropping the missing tail', async () => {
  const p = await pair()
  let ledger = append(createLedger(teacherPub, studentPub), teacher.privateKey, topup)
  ledger = append(ledger, teacher.privateKey, charge)
  const registry = (await p.a.store.list('ledger-index'))[0].value as { collection: string; key: string }
  const state = await p.a.store.get(registry.collection, registry.key) as Record<string, unknown>
  await p.a.store.put(registry.collection, registry.key, JSON.parse(JSON.stringify({ ...state, ledger })))
  await p.a.transport.send(studentPub, { type: 'ledger.event', version: 1, payload: ledger.events[1] })
  await eventually(async () => expect((await p.b.view()).balance).toBe(7))
})
it('sender must be the registered peer; student cannot issue ledger events', async () => {
  const p = await pair(), key = generateSecretKey(), outsider = getPublicKey(key)
  const event = signEvent(createLedger(teacherPub, studentPub), key, topup)
  const message = (sender: string): Message => ({ id: crypto.randomUUID(), sender, at: 1, envelope: { type: 'ledger.event', version: 1, payload: event } })
  await p.b.sync.receive(message(outsider)); await p.a.sync.receive(message(studentPub))
  expect((await p.a.view()).ledger.events).toHaveLength(0)
  expect((await p.b.view()).ledger.events).toHaveLength(0)
})
it('offline teacher receives disputed entry once; accepted replay is not re-dated', async () => {
  const p = await pair(), event = await charged(p)
  p.a.sync.close(); p.a.transport.close()
  p.setTime(6)
  await p.b.sync.dispute(teacherPub, studentPub, { disputeFor: event.id, memo: 'SYNTHETIC', at: at(6) })
  p.setTime(9)
  const a = await p.node(teacher, p.a.store)
  await eventually(async () => expect((await a.view()).ledger.disputes).toHaveLength(1))
  const dispute = (await a.view()).ledger.disputes[0]
  p.setTime(20)
  await p.b.transport.send(teacherPub, { type: 'ledger.dispute', version: 1, payload: dispute })
  await p.b.sync.requestSync()
  await eventually(async () => expect((await a.view()).receipts).toHaveLength(1))
  expect((await a.view()).receipts[0].delayDays).toBe(3)
})

it('open, foreground, network recovery and push wake sync; cleanup removes every trigger', async () => {
  const { bindLedgerSync } = await import('./runtime')
  const target = new EventTarget(), visibility = new EventTarget(), worker = new EventTarget()
  const request = vi.fn(async () => {}), refresh = vi.fn()
  const close = bindLedgerSync(request, refresh, { target, visibility, worker })
  await eventually(() => expect(request).toHaveBeenCalledTimes(1))
  for (const [surface, event] of [[target, new globalThis.Event('focus')], [target, new globalThis.Event('online')], [visibility, new globalThis.Event('visibilitychange')], [worker, new MessageEvent('message', { data: { type: 'aster:sync-requested' } })]] as const) {
    const count = request.mock.calls.length
    surface.dispatchEvent(event)
    await eventually(() => expect(request).toHaveBeenCalledTimes(count + 1))
  }
  expect(refresh).toHaveBeenCalledTimes(5)
  close()
  target.dispatchEvent(new globalThis.Event('focus'))
  worker.dispatchEvent(new MessageEvent('message', { data: { type: 'aster:sync-requested' } }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(request).toHaveBeenCalledTimes(5)
})

it('unacknowledged outbox survives controller restart and is sent through the new transport', async () => {
  const p = await pair()
  p.a.transport.close()
  await p.a.sync.record(teacherPub, studentPub, topup)
  await eventually(async () => expect((await p.a.view()).outbox).toHaveLength(1))
  p.a.sync.close()
  const a = await p.node(teacher, p.a.store)
  await a.sync.flush()
  await eventually(async () => expect((await p.b.view()).balance).toBe(10))
  await eventually(async () => expect((await a.view()).outbox).toHaveLength(0))
})
it('exact 7-day window is inclusive; exactly 24h is unmarked and greater than 24h is marked', async () => {
  const p = await pair(), event = await charged(p), ledger = (await p.b.view()).ledger
  p.setTime(8)
  const one = signDispute(ledger, student.privateKey, { disputeFor: event.id, memo: 'BOUNDARY_24H', at: at(7) })
  await p.b.transport.send(teacherPub, { type: 'ledger.dispute', version: 1, payload: one })
  await eventually(async () => expect((await p.a.view()).receipts).toHaveLength(1))
  expect((await p.a.view()).receipts[0]).toMatchObject({ status: 'accepted', delayDays: 0 })
  p.setTime(8 + 1 / 24)
  const two = signDispute(ledger, student.privateKey, { disputeFor: event.id, memo: 'BOUNDARY_25H', at: at(7) })
  await p.b.transport.send(teacherPub, { type: 'ledger.dispute', version: 1, payload: two })
  await eventually(async () => expect((await p.a.view()).receipts).toHaveLength(2))
  expect((await p.a.view()).receipts[1]).toMatchObject({ status: 'accepted', delayDays: 1 })
})

it('backup restore waits for ledger writes and resumes after success or failure', async () => {
  const { restoreWithLedgerPaused } = await import('./runtime')
  const target = new EventTarget(), order: string[] = []
  let release!: () => void
  const writing = new Promise<void>(resolve => { release = resolve })
  target.addEventListener('aster:store-restoring', event => {
    (event as CustomEvent<{ pending: Promise<void>[] }>).detail.pending.push(writing.then(() => { order.push('saved') }))
  })
  target.addEventListener('aster:store-restored', () => { order.push('resumed') })
  const restore = restoreWithLedgerPaused(async () => { order.push('restore') }, target)
  await Promise.resolve()
  expect(order).toEqual([])
  release(); await restore
  expect(order).toEqual(['saved', 'restore', 'resumed'])
  await expect(restoreWithLedgerPaused(async () => { throw Error('synthetic failure') }, target)).rejects.toThrow('synthetic failure')
  expect(order.at(-1)).toBe('resumed')
})
