import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity, type Identity } from '../identity'
import { openStore, type LocalStore } from '../store'
import type { Envelope } from '../transport'
import { createInbox, adherenceEnvelope } from '../inbox'
import { createLedgerSync } from './sync'
import { confirmMoney, moneyCurrencyFor, saveMoneyCurrency } from './money'
import { teacherStudents } from '../records/teacher'
import type { ChainEventDraft } from './types'

// V2-12：全部合成身份与本机存储，信封直接投递到对端控制器（不连中继、不调模型）。
const closers: LocalStore[] = []
afterEach(() => { while (closers.length) closers.pop()!.close() })

interface Node { identity: Identity; store: LocalStore; sync: ReturnType<typeof createLedgerSync> }
const nodes: Node[] = []
afterEach(() => { nodes.splice(0) })

async function makeNode(identity: Identity): Promise<Node> {
  const store = await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
  closers.push(store)
  const node: Node = {
    identity, store,
    sync: createLedgerSync({
      identity, store,
      send: async (recipient, envelope) => {
        const target = nodes.find(item => item.identity.publicKey === recipient)
        if (target) await target.sync.receive({ id: crypto.randomUUID(), at: Math.floor(Date.now() / 1000), sender: identity.publicKey, envelope })
        return crypto.randomUUID()
      },
    }),
  }
  nodes.push(node)
  return node
}

const eventually = async (check: () => void | Promise<void>, timeout = 5000) => {
  const start = Date.now()
  for (;;) {
    try { await check(); return } catch (error) { if (Date.now() - start > timeout) throw error }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 9, minute)).toISOString()
const topup = (amount: number, minute = 0): ChainEventDraft => ({ type: 'topup', currency: 'CNY', amount, at: at(minute) })
const gift = (amount: number, minute = 0): ChainEventDraft => ({ type: 'gift', currency: 'CNY', amount, at: at(minute) })
const view = (node: Node, teacher: Identity, student: Identity) => node.sync.view(teacher.publicKey, student.publicKey)

async function noBook(node: Node): Promise<void> { expect(await node.sync.books()).toHaveLength(0) }

describe('V2-12 老师端第一次记账就建账', () => {
  it('老师邀请的学生没有账本也能直接说一句话记账：确认后建账，学生收到同一笔', async () => {
    const teacher = createIdentity(), student = createIdentity()
    const t = await makeNode(teacher), s = await makeNode(student)
    await t.store.put('teacher-students', student.publicKey, { student: student.publicKey })
    // 学生通过邀请加入时照 V2-04 开一本空账本；老师端还没有账本。
    await s.sync.open(teacher.publicKey, student.publicKey)
    await noBook(t)

    await confirmMoney(t.sync, {
      id: 'first-confirm', teacher: teacher.publicKey, student: student.publicKey, currency: 'CNY',
      events: [topup(10000, 0), gift(2000, 1)],
    })

    await eventually(async () => {
      const teacherView = await view(t, teacher, student)
      expect(teacherView.ledger.events).toHaveLength(2)
      expect(teacherView.balance).toBe(12000)
      const studentView = await view(s, teacher, student)
      expect(studentView.balance).toBe(12000)
      expect(studentView.ledger.events).toHaveLength(2)
    })
    const teacherView = await view(t, teacher, student)
    expect(teacherView.ledger.events[0].content).toContain('CNY')
    expect(teacherView.ledger.events.map(event => JSON.parse(event.content).type)).toEqual(['topup', 'gift'])
    expect(await t.sync.books()).toHaveLength(1)
    expect(await s.sync.books()).toHaveLength(1)
    // 同一师生只有一本：重复对账/补发不产生第二本，也不重复入账。
    await t.sync.requestSync(); await s.sync.requestSync(); await t.sync.flush(); await s.sync.flush()
    await eventually(async () => {
      expect(await t.sync.books()).toHaveLength(1)
      expect(await s.sync.books()).toHaveLength(1)
      expect((await view(s, teacher, student)).ledger.events).toHaveLength(2)
    })
  })

  it('第二位学生第一次记账时币种默认上一次用过的；已有账本的币种不变', async () => {
    const teacher = createIdentity(), first = createIdentity(), second = createIdentity()
    const t = await makeNode(teacher), a = await makeNode(first), b = await makeNode(second)
    await t.store.put('teacher-students', first.publicKey, { student: first.publicKey })
    await t.store.put('teacher-students', second.publicKey, { student: second.publicKey })
    // 两位学生加入时都开了空账本；老师端都还没有账本。
    await a.sync.open(teacher.publicKey, first.publicKey)
    await b.sync.open(teacher.publicKey, second.publicKey)

    // 第一本账：老师先选一次币种（MoneyEntry 会写 settings/money-currency）。
    await confirmMoney(t.sync, { id: 'confirm-first', teacher: teacher.publicKey, student: first.publicKey, currency: 'CNY', events: [topup(10000, 0)] })
    await saveMoneyCurrency(t.store, 'CNY')
    expect(await moneyCurrencyFor(t.store, teacher.publicKey, first.publicKey)).toBe('CNY')

    // 第二位学生还没有账本：默认取上一次用过的币种，而且只是读取，不会偷偷建账。
    expect(await moneyCurrencyFor(t.store, teacher.publicKey, second.publicKey)).toBe('CNY')
    expect(await t.sync.books()).toHaveLength(1)

    await confirmMoney(t.sync, { id: 'confirm-second', teacher: teacher.publicKey, student: second.publicKey, currency: 'CNY', events: [topup(3000, 0)] })
    await eventually(async () => {
      expect(await t.sync.books()).toHaveLength(2)
      expect((await view(t, teacher, second)).balance).toBe(3000)
      expect((await view(a, teacher, first)).balance).toBe(10000)
      expect((await view(b, teacher, second)).balance).toBe(3000)
    })
    expect(await moneyCurrencyFor(t.store, teacher.publicKey, first.publicKey)).toBe('CNY')
  })

  it('学生邀请时先开过空账本：老师第一次记账后两边仍只有一本、余额一致', async () => {
    const teacher = createIdentity(), student = createIdentity()
    const t = await makeNode(teacher), s = await makeNode(student)
    // 学生加入社区时开的空账本（V2-04 既有行为），老师端还没有账本。
    await s.sync.open(teacher.publicKey, student.publicKey)
    await noBook(t)
    expect(await s.sync.books()).toHaveLength(1)

    await confirmMoney(t.sync, { id: 'confirm-after-empty', teacher: teacher.publicKey, student: student.publicKey, currency: 'CNY', events: [topup(12000, 0)] })
    await eventually(async () => {
      expect((await view(s, teacher, student)).balance).toBe(12000)
      expect((await view(s, teacher, student)).ledger.events).toHaveLength(1)
    })
    expect(await t.sync.books()).toHaveLength(1)
    expect(await s.sync.books()).toHaveLength(1)
    // 再对账一轮也不会多出第二本或重复事件。
    await t.sync.requestSync(); await s.sync.requestSync(); await t.sync.flush(); await s.sync.flush()
    await eventually(async () => {
      expect(await t.sync.books()).toHaveLength(1)
      expect(await s.sync.books()).toHaveLength(1)
      expect((await view(t, teacher, student)).balance).toBe(12000)
      expect((await view(s, teacher, student)).balance).toBe(12000)
    })
  })
})

describe('V2-12 老师端钱账名单来源', () => {
  it('学生连上社区发来坚持率小结后，老师端就能在 teacher-students 里看到这位学生（不建账本）', async () => {
    const teacher = createIdentity(), student = createIdentity()
    const store = await openStore(teacher, { factory: new IDBFactory(), name: crypto.randomUUID() })
    closers.push(store)
    await store.put('settings', 'role', { role: 'teacher' })
    const inbox = createInbox({ identity: teacher, store, send: async () => '' })
    const envelope: Envelope = adherenceEnvelope({ weekStart: '2026-10-19', weeklyRate: null, streak: 0, practiceDays: 0, scheduled: 0, done: 0 })
    await inbox.receive({ id: crypto.randomUUID(), at: Math.floor(Date.now() / 1000), sender: student.publicKey, envelope })
    expect(await teacherStudents(store)).toContain(student.publicKey)
    // 只是认得学生，没有在建账本。
    expect(await store.list('ledger-index')).toHaveLength(0)
  })
})
