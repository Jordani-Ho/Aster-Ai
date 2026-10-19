import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity, type Identity } from '../identity'
import { openStore, type LocalStore } from '../store'
import type { Envelope } from '../transport'
import { addTeacher, createInbox, listReceivedRecords } from '../inbox'
import { createLedgerSync } from '../ledger/sync'
import { signEncounter } from '../record/sign'
import { startInPersonEncounter } from '../record/in-person'
import { saveTeacherRecord } from '../records/teacher'
import { addFamilyMember, memberIdentity, memberStore } from '../family'
import { listIdentityLinks } from '../identity/links'
import {
  chooseFamilyLink,
  confirmStudentReidentify,
  listReidentifyRequests,
  listFamilyResults,
  sendFamilyReidentify,
  sendStudentReidentifyRequest,
} from './index'

// V2-07b 验收 0–3：全部合成身份/病历/账本、内存投递、fake-indexeddb；不连真实 relay。
const NOW = new Date()
const closers: LocalStore[] = []
afterEach(() => { while (closers.length) closers.pop()!.close() })

type Send = (recipient: string, envelope: Envelope) => Promise<unknown>
interface Endpoint { identity: Identity; store: LocalStore; inbox?: ReturnType<typeof createInbox>; ledger?: ReturnType<typeof createLedgerSync> }
const endpoints = new Map<string, Endpoint>()

async function newStore(identity: Identity): Promise<LocalStore> {
  const store = await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
  closers.push(store)
  return store
}

async function endpointOn(identity: Identity, store: LocalStore, role: 'teacher' | 'student' | 'family'): Promise<Endpoint> {
  if (role !== 'family') await store.put('settings', 'role', { role })
  const value: Endpoint = { identity, store }
  endpoints.set(identity.publicKey, value)
  value.ledger = createLedgerSync({
    identity, store,
    send: async (recipient, envelope) => { await deliver(identity.publicKey, recipient, envelope); return crypto.randomUUID() },
    onChange: () => {},
  })
  value.inbox = createInbox({
    identity, store, ledger: value.ledger,
    send: (recipient, envelope) => deliver(identity.publicKey, recipient, envelope),
  })
  return value
}

async function endpoint(identity: Identity, role: 'teacher' | 'student' | 'family'): Promise<Endpoint> {
  return endpointOn(identity, await newStore(identity), role)
}

async function deliver(sender: string, recipient: string, envelope: Envelope): Promise<unknown> {
  const target = endpoints.get(recipient)
  if (!target) throw new Error('收件人不在本机网络里')
  const message = { id: crypto.randomUUID(), at: Math.floor(Date.now() / 1000), sender, envelope }
  if (envelope.type.startsWith('ledger.')) {
    if (!target.ledger) throw new Error('收件人没有账本控制器')
    await target.ledger.receive(message)
  } else {
    if (!target.inbox) throw new Error('收件人没有收件箱')
    await target.inbox.receive(message)
  }
  return crypto.randomUUID()
}

function sendFor(identity: Identity): Send {
  return (recipient, envelope) => deliver(identity.publicKey, recipient, envelope)
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等待超时：' + label)
}

// 老师给某位学生/家人签一份病历，并写进 teacher-records（保留期内）。
async function teacherRecord(teacher: Endpoint, student: string, alias: string, id: string) {
  const encounter = startInPersonEncounter({ teacher: teacher.identity.publicKey, student, now: NOW, id })
  encounter.profile.alias = { value: alias, source: 'student' }
  await saveTeacherRecord(teacher.store, signEncounter(encounter, teacher.identity.privateKey))
  return encounter
}

function consultRow(manager: string, family: string, alias: string) {
  return {
    manager,
    receivedAt: NOW.toISOString(),
    sender: family,
    history: [],
    attachments: [],
    droppedHistory: 0,
    encounter: { student: family, profile: { alias: { value: alias, source: 'student' } } },
  }
}

// 老师认回一位新学生：发请求 → 老师点“是”；ledger 存在时顺带携带钱账。
async function reidentifyStudent(teacher: Endpoint, oldStudent: string, fresh: Endpoint) {
  await addTeacher(fresh.store, teacher.identity.publicKey)
  await sendStudentReidentifyRequest(fresh.store, teacher.identity.publicKey, '小王', sendFor(fresh.identity))
  const [request] = await listReidentifyRequests(teacher.store)
  return confirmStudentReidentify({
    store: teacher.store,
    teacher: teacher.identity.publicKey,
    request,
    oldStudent,
    newStudent: fresh.identity.publicKey,
    send: sendFor(teacher.identity),
    ...(teacher.ledger ? { ledger: teacher.ledger } : {}),
  })
}

describe('V2-07b 验收 0：本人换手机后钱账余额不变，再记一笔接着累加', () => {
  it('旧公钥那本钱账携带到新身份；学生端与老师端归并余额相同；再扣一笔继续累加', async () => {
    const teacher = await endpoint(createIdentity(), 'teacher')
    const oldStudent = createIdentity()
    await teacher.ledger!.open(teacher.identity.publicKey, oldStudent.publicKey)
    await teacher.ledger!.record(teacher.identity.publicKey, oldStudent.publicKey, { type: 'topup', currency: 'CNY', amount: 10000, confirmationId: 'a'.repeat(32) })

    const fresh = await endpoint(createIdentity(), 'student')
    await fresh.ledger!.open(teacher.identity.publicKey, fresh.identity.publicKey)
    await reidentifyStudent(teacher, oldStudent.publicKey, fresh)

    // 学生按换机关系收到旧钱账；两端读取时归并，余额与换机前相同。
    await waitFor(async () => {
      const views = await fresh.ledger!.mergedViews()
      return views.length === 1 && views[0].balance === 10000
    }, '学生端归并余额')
    const studentView = (await fresh.ledger!.mergedViews())[0]
    const teacherView = (await teacher.ledger!.mergedViews()).find(view => view.ledger.student === fresh.identity.publicKey)!
    expect(studentView.balance).toBe(10000)
    expect(teacherView.balance).toBe(10000)

    // 老师再记一笔：写进新公钥那本账，读取时接着旧余额累加。
    await teacher.ledger!.record(teacher.identity.publicKey, fresh.identity.publicKey, { type: 'charge', currency: 'CNY', amount: 3000, chargeReason: 'consult', confirmationId: 'b'.repeat(32) })
    await teacher.ledger!.flush()
    await waitFor(async () => {
      const views = await fresh.ledger!.mergedViews()
      return views.length === 1 && views[0].balance === 7000
    }, '学生端累加后的余额')
    expect((await teacher.ledger!.mergedViews()).find(view => view.ledger.student === fresh.identity.publicKey)!.balance).toBe(7000)
    // 不重签旧记账：旧账事件原样携带，新账本自己一条扣费。
    const view = (await fresh.ledger!.mergedViews())[0]
    expect(view.ledger.events).toHaveLength(2)
    expect(view.ledger.events.map(event => event.id)).toContain(teacherView.ledger.events[0].id)
  })
})

describe('V2-07b 验收 1：管理人和两位家人一起认回', () => {
  it('同称呼家人自动按旧代管关系匹配；保留期内记录回来、钱账余额不变，老师不用逐个点', async () => {
    const teacher = await endpoint(createIdentity(), 'teacher')
    const oldManager = createIdentity()
    const oldFamily = [createIdentity(), createIdentity()]
    const aliases = ['爸爸', '妈妈']
    for (const [index, family] of oldFamily.entries()) {
      await teacher.store.put('consult-package', crypto.randomUUID(), consultRow(oldManager.publicKey, family.publicKey, aliases[index]))
      await teacherRecord(teacher, family.publicKey, aliases[index], String(index + 2).repeat(32))
      await teacher.ledger!.open(teacher.identity.publicKey, family.publicKey)
      await teacher.ledger!.record(teacher.identity.publicKey, family.publicKey, { type: 'topup', currency: 'CNY', amount: 1000 * (index + 1), confirmationId: String(index + 4).repeat(32) })
    }

    // 管理人换手机被老师认回，然后在新手机上重新添加两位同称呼家人。
    const manager = await endpoint(createIdentity(), 'student')
    await reidentifyStudent(teacher, oldManager.publicKey, manager)
    const members = []
    for (const [index, alias] of aliases.entries()) {
      members.push(await addFamilyMember(manager.store, manager.identity, { alias, relation: index === 0 ? 'father' : 'mother', gender: index === 0 ? 'male' : 'female', birthDate: index === 0 ? '1960-01-01' : '1965-05-05', city: null }))
    }
    const familyEndpoints: Endpoint[] = []
    for (const member of members) {
      familyEndpoints.push(await endpointOn(memberIdentity(member), memberStore(manager.store, member.account), 'family'))
    }

    // 管理人把家人清单发给老师：老师自动匹配、回发记录、携带钱账，不让老师逐个点。
    const claims = await sendFamilyReidentify({ store: manager.store, identity: manager.identity.publicKey, send: sendFor(manager.identity) })
    expect(claims.map(claim => claim.alias).sort()).toEqual([...aliases].sort())
    const results = await listFamilyResults(manager.store)
    expect(results.map(result => result.status)).toEqual(['matched', 'matched'])
    for (const [index, member] of members.entries()) {
      const identity = memberIdentity(member)
      const scoped = memberStore(manager.store, member.account)
      await waitFor(async () => (await listReceivedRecords(scoped, identity)).length === 1, `家人 ${index} 收回记录`)
      const views = await familyEndpoints[index].ledger!.mergedViews()
      expect(views[0].balance).toBe(1000 * (index + 1))
      expect(await listIdentityLinks(scoped)).toEqual([expect.objectContaining({ kind: 'student', oldKey: oldFamily[index].publicKey, newKey: identity.publicKey })])
    }
    // 老师端归并余额也不变。
    const teacherViews = await teacher.ledger!.mergedViews()
    for (const [index, member] of members.entries()) {
      const view = teacherViews.find(item => item.ledger.student === member.publicKey)
      expect(view?.balance).toBe(1000 * (index + 1))
    }
  })

  it('一位家人改了称呼：管理人看到“没找到原来的记录”，手动对上后记录回来', async () => {
    const teacher = await endpoint(createIdentity(), 'teacher')
    const oldManager = createIdentity()
    const oldFamily = createIdentity()
    await teacher.store.put('consult-package', crypto.randomUUID(), consultRow(oldManager.publicKey, oldFamily.publicKey, '爸爸'))
    await teacherRecord(teacher, oldFamily.publicKey, '爸爸', '9'.repeat(32))
    await teacher.ledger!.open(teacher.identity.publicKey, oldFamily.publicKey)
    await teacher.ledger!.record(teacher.identity.publicKey, oldFamily.publicKey, { type: 'topup', currency: 'CNY', amount: 2500, confirmationId: '8'.repeat(32) })

    const manager = await endpoint(createIdentity(), 'student')
    await reidentifyStudent(teacher, oldManager.publicKey, manager)
    const member = await addFamilyMember(manager.store, manager.identity, { alias: '爸', relation: 'father', gender: 'male', birthDate: '1960-01-01', city: null })
    const identity = memberIdentity(member)
    const scoped = memberStore(manager.store, member.account)
    const family = await endpointOn(identity, scoped, 'family')

    await sendFamilyReidentify({ store: manager.store, identity: manager.identity.publicKey, send: sendFor(manager.identity) })
    const [unresolved] = await listFamilyResults(manager.store)
    expect(unresolved.status).toBe('unresolved')
    expect(unresolved.candidates).toEqual([{ oldKey: oldFamily.publicKey, alias: '爸爸' }])
    expect(await listReceivedRecords(scoped, identity)).toHaveLength(0)
    expect(await scoped.list('student-records')).toHaveLength(0)

    // 管理人手动选一位旧家人对上，记录与钱账回来。
    await chooseFamilyLink({ store: manager.store, identity: manager.identity.publicKey, newKey: identity.publicKey, oldKey: oldFamily.publicKey, send: sendFor(manager.identity) })
    await waitFor(async () => (await listReceivedRecords(scoped, identity)).length === 1, '手动对上后收回记录')
    expect((await family.ledger!.mergedViews())[0].balance).toBe(2500)
    expect((await listFamilyResults(manager.store))[0].status).toBe('matched')
  })

  it('别的管理人添加同称呼家人：拿不到这家人的记录（验收 3）', async () => {
    const teacher = await endpoint(createIdentity(), 'teacher')
    const managerA = createIdentity(), familyA = createIdentity()
    await teacher.store.put('consult-package', crypto.randomUUID(), consultRow(managerA.publicKey, familyA.publicKey, '爸爸'))
    await teacherRecord(teacher, familyA.publicKey, '爸爸', '7'.repeat(32))

    // 管理人 B 也被老师认回，但旧管理人名下没有这个“爸爸”。
    const oldManagerB = createIdentity()
    const managerB = await endpoint(createIdentity(), 'student')
    await reidentifyStudent(teacher, oldManagerB.publicKey, managerB)
    const member = await addFamilyMember(managerB.store, managerB.identity, { alias: '爸爸', relation: 'father', gender: 'male', birthDate: '1960-01-01', city: null })
    const identity = memberIdentity(member)
    const scoped = memberStore(managerB.store, member.account)
    await endpointOn(identity, scoped, 'family')

    await sendFamilyReidentify({ store: managerB.store, identity: managerB.identity.publicKey, send: sendFor(managerB.identity) })
    const [result] = await listFamilyResults(managerB.store)
    expect(result.status).toBe('unresolved')
    expect(result.candidates).toEqual([])
    expect(await listReceivedRecords(scoped, identity)).toHaveLength(0)
    // 真正的“爸爸”没有被映射给别人。
    expect((await listIdentityLinks(teacher.store)).filter(link => link.oldKey === familyA.publicKey)).toEqual([])
    expect(await teacher.store.list('teacher-records')).toHaveLength(1)
  })
})
