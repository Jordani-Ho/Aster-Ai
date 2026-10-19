import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity, type Identity } from '../identity'
import { openStore, type LocalStore } from '../store'
import type { Envelope } from '../transport'
import { addTeacher, createInbox, listReceivedRecords, loadTeachers } from '../inbox'
import { signEncounter } from '../record/sign'
import { startInPersonEncounter } from '../record/in-person'
import { saveTeacherRecord, teacherStudents, TEACHER_STUDENTS } from '../records/teacher'
import { CARE_PLAN_COLLECTION, signCarePlan } from '../careplan'
import { saveRetentionDays } from '../records/retention'
import { makeInvite } from '../onboarding'
import { listIdentityLinks } from '../identity/links'
import {
  canConfirmTeacherReidentify,
  confirmEnvelope,
  confirmStudentReidentify,
  confirmTeacherReidentify,
  listReidentifyRequests,
  matchCandidate,
  openTeacherReidentify,
  readReidentifyLink,
  reidentifyLink,
  reidentifyRejectedAt,
  rejectStudentReidentify,
  sendStudentReidentifyRequest,
  teacherChoices,
  teacherReidentifyWindowOpen,
  teacherStudentCandidates,
} from './index'

// 全部合成身份、合成病历、内存投递与 fake-indexeddb；不连真实 relay/gateway，不做数据迁移。
const NOW = new Date('2026-10-18T12:00:00.000Z')
const DAY = 86400000
const closers: LocalStore[] = []
const sentTypes: string[] = []
afterEach(() => { while (closers.length) closers.pop()!.close() })

interface Endpoint { identity: Identity; store: LocalStore }
const endpoints = new Map<string, Endpoint>()

async function endpoint(identity: Identity, role: 'teacher' | 'student'): Promise<Endpoint> {
  const store = await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
  await store.put('settings', 'role', { role })
  closers.push(store)
  const value = { identity, store }
  endpoints.set(identity.publicKey, value)
  return value
}

async function deliver(sender: string, recipient: string, envelope: Envelope): Promise<unknown> {
  sentTypes.push(envelope.type)
  const target = endpoints.get(recipient)
  if (!target) throw new Error('收件人不在本机网络里')
  const inbox = createInbox({
    identity: target.identity,
    store: target.store,
    send: (to, next) => deliver(recipient, to, next),
  })
  await inbox.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender, envelope })
  return crypto.randomUUID()
}

function sendFor(identity: Identity) {
  return (recipient: string, envelope: Envelope) => deliver(identity.publicKey, recipient, envelope)
}

// 老师给某个学生签一份面诊病历：老师端存一份完整医案，学生端也收到一份。
async function signedRecord(teacher: Endpoint, student: Identity, at = NOW, id = 'a'.repeat(32), alias?: string) {
  const encounter = startInPersonEncounter({ teacher: teacher.identity.publicKey, student: student.publicKey, now: at, id })
  if (alias) encounter.profile.alias = { value: alias, source: 'student' }
  const event = signEncounter(encounter, teacher.identity.privateKey)
  await saveTeacherRecord(teacher.store, event)
  if (endpoints.has(student.publicKey)) await deliver(teacher.identity.publicKey, student.publicKey, { type: 'record.signed', version: 1, payload: event })
  return event
}

describe('V2-07 验收 1：学生换手机，老师点“是”后收回保留期内病历', () => {
  it('新学生身份发请求 → 老师匹配旧学生并回发 → 旧病历按换机关系验签收下；超期的不回发', async () => {
    const teacher = await endpoint(createIdentity(), 'teacher')
    const oldStudent = createIdentity()
    await saveRetentionDays(teacher.store, 30)
    const recent = await signedRecord(teacher, oldStudent, NOW, '1'.repeat(32), '小王')
    await signedRecord(teacher, oldStudent, new Date(NOW.getTime() - 40 * DAY), '2'.repeat(32))

    // 学生清空浏览器：新身份、新库，只从老师的找回链接里拿到老师公钥。
    const fresh = await endpoint(createIdentity(), 'student')
    await addTeacher(fresh.store, teacher.identity.publicKey)
    await sendStudentReidentifyRequest(fresh.store, teacher.identity.publicKey, '小王', sendFor(fresh.identity))

    const pending = await listReidentifyRequests(teacher.store)
    expect(pending).toHaveLength(1)
    expect(pending[0].alias).toBe('小王')
    expect(pending[0].student).toBe(fresh.identity.publicKey)

    // 老师端按称呼预选旧学生（这里只有一位，唯一匹配）。
    const candidates = await teacherStudentCandidates(teacher.store)
    expect(candidates.map(item => item.student)).toContain(oldStudent.publicKey)
    expect(matchCandidate(candidates, '小王')?.student).toBe(oldStudent.publicKey)

    const result = await confirmStudentReidentify({
      store: teacher.store,
      teacher: teacher.identity.publicKey,
      request: pending[0],
      oldStudent: oldStudent.publicKey,
      newStudent: fresh.identity.publicKey,
      send: sendFor(teacher.identity),
    })
    expect(result.records).toBe(1)
    expect(await listReidentifyRequests(teacher.store)).toEqual([])

    // 老师名单旧→新；学生按老师确认过的换机关系收下旧公钥名下的病历。
    const list = await teacherStudents(teacher.store)
    expect(list).toContain(fresh.identity.publicKey)
    expect(await teacher.store.get(TEACHER_STUDENTS, oldStudent.publicKey)).toBeUndefined()
    const links = await listIdentityLinks(fresh.store)
    expect(links).toEqual([expect.objectContaining({ kind: 'student', oldKey: oldStudent.publicKey, newKey: fresh.identity.publicKey })])
    const records = await listReceivedRecords(fresh.store, fresh.identity)
    expect(records.map(record => record.event.id)).toEqual([recent.id])
    expect(records[0].encounter.student).toBe(oldStudent.publicKey)
  })

  it('冒充者自称“小王”：老师点“不是” → 名单、映射、病历都不变，不发任何回包', async () => {
    const teacher = await endpoint(createIdentity(), 'teacher')
    const oldStudent = createIdentity()
    const impostor = await endpoint(createIdentity(), 'student')
    await signedRecord(teacher, oldStudent)
    const beforeStudents = await teacherStudents(teacher.store)
    const beforeRecords = (await teacher.store.list('teacher-records')).length
    sentTypes.length = 0

    await sendStudentReidentifyRequest(impostor.store, teacher.identity.publicKey, '小王', sendFor(impostor.identity))
    const [request] = await listReidentifyRequests(teacher.store)
    await rejectStudentReidentify({ store: teacher.store, request, send: sendFor(teacher.identity) })

    expect(await listReidentifyRequests(teacher.store)).toEqual([])
    expect(await teacherStudents(teacher.store)).toEqual(beforeStudents)
    expect((await teacher.store.list('teacher-records')).length).toBe(beforeRecords)
    expect(await listIdentityLinks(teacher.store)).toEqual([])
    expect(sentTypes.filter(type => type === 'records.backup')).toEqual([])
    expect(sentTypes).toContain('reidentify.reject')
    expect(await listIdentityLinks(impostor.store)).toEqual([])
    expect(await reidentifyRejectedAt(impostor.store)).not.toBeNull()
  })
})

describe('V2-07 审核补强：学生端选旧老师', () => {
  it('两位老师默认不选；链接称呼与本机称呼一致时预选；只有一位时可默认选中；未选不能点“是”', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    const two = teacherChoices([a, b], {}, '阿慈')
    expect(two.choices).toHaveLength(2)
    expect(two.selected).toBe('')
    expect(canConfirmTeacherReidentify(two.selected)).toBe(false)
    const named = teacherChoices([a, b], { [a]: '阿慈' }, '阿慈')
    expect(named.selected).toBe(a)
    expect(named.choices.find(choice => choice.key === a)?.label).toBe('阿慈')
    expect(teacherChoices([a], {}, '阿慈').selected).toBe(a)
    expect(teacherChoices([a, b], { [a]: '阿慈' }, '别人').selected).toBe('')
    expect(teacherChoices([a], {}, '').choices[0].label).toBe('老师 ' + a.slice(-6))
    expect(canConfirmTeacherReidentify(a)).toBe(true)
  })
})

describe('V2-07 审核补强：老师端只在自己刚换手机时接受 teacher 类确认', () => {
  const DAY = 86400000
  async function world() {
    const teacher = await endpoint(createIdentity(), 'teacher')
    const student = await endpoint(createIdentity(), 'student')
    const oldA = createIdentity(), oldB = createIdentity()
    return { teacher, student, oldA, oldB }
  }
  const confirm = (student: Endpoint, teacher: Endpoint, oldTeacher: string) => deliver(
    student.identity.publicKey, teacher.identity.publicKey,
    confirmEnvelope('teacher', oldTeacher, teacher.identity.publicKey),
  )

  it('没有“刚换手机”标记：确认直接丢弃，名单/映射/记录都不变', async () => {
    const w = await world()
    await confirm(w.student, w.teacher, w.oldA.publicKey)
    expect(await listIdentityLinks(w.teacher.store)).toEqual([])
    expect(await teacherStudents(w.teacher.store)).toEqual([])
    expect(await w.teacher.store.list('teacher-records')).toEqual([])
  })

  it('标记超过 30 天：确认丢弃', async () => {
    const w = await world()
    await openTeacherReidentify(w.teacher.store, new Date(Date.now() - 31 * DAY))
    expect(teacherReidentifyWindowOpen(await w.teacher.store.get('settings', 'teacher-reidentify-open') as string)).toBe(false)
    await confirm(w.student, w.teacher, w.oldA.publicKey)
    expect(await listIdentityLinks(w.teacher.store)).toEqual([])
    expect(await teacherStudents(w.teacher.store)).toEqual([])
  })

  it('标记新鲜时接受；同一发件人第二次带不同旧公钥一律不认', async () => {
    const w = await world()
    await openTeacherReidentify(w.teacher.store)
    await confirm(w.student, w.teacher, w.oldA.publicKey)
    expect((await listIdentityLinks(w.teacher.store)).map(link => link.oldKey)).toEqual([w.oldA.publicKey])
    expect(await teacherStudents(w.teacher.store)).toEqual([w.student.identity.publicKey])

    await confirm(w.student, w.teacher, w.oldB.publicKey)
    expect((await listIdentityLinks(w.teacher.store)).map(link => link.oldKey)).toEqual([w.oldA.publicKey])
    expect(await w.teacher.store.list('reidentify-teacher-confirms')).toHaveLength(1)
  })
})

describe('V2-07 找回链接：换机标记与普通邀请分开', () => {
  it('带 reidentify 标记的链接能读回类型与老师称呼；普通邀请链接不被当成找回链接', async () => {
    const identity = createIdentity()
    const event = makeInvite(identity, 'https://community.example/invite/redeem', Math.floor(NOW.getTime() / 1000))
    const teacherLink = reidentifyLink('https://app.example/', event, 'teacher', '阿慈')
    const studentLink = reidentifyLink('https://app.example/', event, 'student')
    expect(readReidentifyLink(teacherLink)).toEqual(expect.objectContaining({ kind: 'teacher', name: '阿慈' }))
    expect(readReidentifyLink(teacherLink)?.event.pubkey).toBe(identity.publicKey)
    expect(readReidentifyLink(studentLink)).toEqual(expect.objectContaining({ kind: 'student', name: '' }))
    const normal = new URL('https://app.example/')
    normal.hash = new URL(teacherLink).hash
    expect(readReidentifyLink(normal.href)).toBeNull()
    expect(readReidentifyLink('https://app.example/#invite=broken')).toBeNull()
  })
})

describe('V2-07 验收 2：老师换手机，学生逐个点“是”；没点的新公钥方案被拒', () => {
  it('两位学生确认后老师收回两人记录；第三位没点头，新老师公钥的方案与病历都被拒', async () => {
    const oldTeacher = await endpoint(createIdentity(), 'teacher')
    const a = await endpoint(createIdentity(), 'student')
    const b = await endpoint(createIdentity(), 'student')
    const c = await endpoint(createIdentity(), 'student')
    await addTeacher(a.store, oldTeacher.identity.publicKey)
    await addTeacher(b.store, oldTeacher.identity.publicKey)
    await addTeacher(c.store, oldTeacher.identity.publicKey)
    await saveRetentionDays(oldTeacher.store, 30)
    await signedRecord(oldTeacher, a.identity, NOW, '3'.repeat(32))
    await signedRecord(oldTeacher, b.identity, NOW, '4'.repeat(32))
    await signedRecord(oldTeacher, c.identity, NOW, '5'.repeat(32))

    // 老师清空浏览器：新身份、新库；生成“换机找回链接”发给学生（生成时记 30 天标记）。
    const newTeacher = await endpoint(createIdentity(), 'teacher')
    await openTeacherReidentify(newTeacher.store)
    const link = reidentifyLink('https://app.example/', makeInvite(newTeacher.identity, 'https://community.example/invite/redeem', Math.floor(NOW.getTime() / 1000)), 'teacher', '阿慈')
    const parsed = readReidentifyLink(link)!
    expect(parsed.kind).toBe('teacher')
    expect(parsed.name).toBe('阿慈')

    for (const student of [a, b]) {
      const events = (await student.store.list('student-records')).map(row => (row.value as { eventJson: string }).eventJson)
      const result = await confirmTeacherReidentify({
        store: student.store,
        oldTeacher: oldTeacher.identity.publicKey,
        newTeacher: newTeacher.identity.publicKey,
        events,
        send: sendFor(student.identity),
      })
      expect(result.records).toBe(1)
      expect(await loadTeachers(student.store)).toEqual([newTeacher.identity.publicKey])
      expect(await listIdentityLinks(student.store)).toEqual([expect.objectContaining({ kind: 'teacher', oldKey: oldTeacher.identity.publicKey, newKey: newTeacher.identity.publicKey })])
    }

    // 老师收下确认与回发：旧老师公钥签的病历按“学生确认过的换机关系”收进 teacher-records。
    const records = await newTeacher.store.list('teacher-records')
    expect(records).toHaveLength(2)
    expect((await teacherStudents(newTeacher.store)).sort()).toEqual([a.identity.publicKey, b.identity.publicKey].sort())

    // 第三位学生没点“是”：新老师公钥签的方案被拒。
    const plan = signCarePlan({ constitution: '合成体质', points: ['合成要点'], avoid: ['合成忌口'], updatedAt: NOW.toISOString(), version: 1 }, c.identity.publicKey, newTeacher.identity.privateKey)
    await deliver(newTeacher.identity.publicKey, c.identity.publicKey, { type: 'care.plan', version: 1, payload: plan })
    expect(await c.store.get(CARE_PLAN_COLLECTION, newTeacher.identity.publicKey)).toBeUndefined()
    expect(await loadTeachers(c.store)).toEqual([oldTeacher.identity.publicKey])

    // 确认过的学生能收下新老师的新方案。
    const second = signCarePlan({ constitution: '合成体质', points: ['合成要点'], avoid: ['合成忌口'], updatedAt: NOW.toISOString(), version: 2 }, a.identity.publicKey, newTeacher.identity.privateKey)
    await deliver(newTeacher.identity.publicKey, a.identity.publicKey, { type: 'care.plan', version: 1, payload: second })
    expect(await a.store.get(CARE_PLAN_COLLECTION, newTeacher.identity.publicKey)).toBeDefined()
  })
})
