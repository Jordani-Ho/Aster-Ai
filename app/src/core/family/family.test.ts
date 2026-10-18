import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity, type Identity } from '../identity'
import { openStore, type LocalStore } from '../store'
import { addTeacher, consultEnvelope, consultChargeBook, createInbox, listConsults, listReceivedRecords, completeConsultSigning } from '../inbox'
import { addUtterance, confirmAndSend, emptyProfile, loadProfile, markReviewed, organizeSession, saveProfile, skipFocus, startSession } from '../intake/session'
import { dailyMirror } from '../mirror'
import { append, balance, createLedger } from '../ledger/chain'
import { verify } from '../ledger/verify'
import { createLedgerSync } from '../ledger/sync'
import { filterChargesByMember } from '../ledger/filter'
import type { ChainEventDraft, SignedLedgerEvent } from '../ledger/types'
import type { Encounter, Field, Homework } from '../record/types'
import type { Message } from '../transport'
import { addFamilyMember, loadFamilyMembers, managedLabel, memberIdentity, memberStore, removeFamilyMember } from './index'
import { createFamilyProof, FAMILY_PROOF_CONTENT, FAMILY_PROOF_KIND, verifyFamilyProof } from './proof'
import template from '../../../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'

const handles: LocalStore[] = []
const factory = new IDBFactory()

function open(who: Identity, name = crypto.randomUUID()): Promise<LocalStore> {
  return openStore(who, { name, factory }).then(store => { handles.push(store); return store })
}
function field<T>(value: T | null): Field<T> { return value === null ? { value: null, source: 'unknown' } : { value, source: 'student' } }
function ownerProfile(alias: string): Encounter['profile'] {
  const profile = emptyProfile()
  profile.alias = field(alias)
  profile.city = field('北京市')
  return profile
}
async function setupFamily() {
  const owner = createIdentity()
  const teacher = createIdentity()
  const ownerStore = await open(owner), teacherStore = await open(teacher)
  await saveProfile(ownerStore, ownerProfile('王小明'))
  await addTeacher(ownerStore, teacher.publicKey)
  const dad = await addFamilyMember(ownerStore, owner, { alias: '爸爸', relation: 'father', gender: 'male', birthDate: '1958-03-02', city: '北京市' })
  const kid = await addFamilyMember(ownerStore, owner, { alias: '孩子', relation: 'child', gender: 'female', birthDate: '2016-06-01', city: '北京市' })
  return { owner, teacher, ownerStore, teacherStore, dad, kid, dadIdentity: memberIdentity(dad), kidIdentity: memberIdentity(kid) }
}
function message(sender: string, envelope: Message['envelope']): Message {
  return { id: crypto.randomUUID(), sender, at: Math.floor(Date.now() / 1000), envelope }
}

afterEach(() => { handles.splice(0).forEach(store => store.close()) })

describe('M1-22 family accounts', () => {
  it('1: adds family members with generated identities and keeps each member data isolated', async () => {
    const { owner, teacher, ownerStore, dad, kid, dadIdentity, kidIdentity } = await setupFamily()
    const members = await loadFamilyMembers(ownerStore)
    expect(members.map(member => member.alias)).toEqual(['爸爸', '孩子'])
    expect(members.map(member => member.account)).toEqual([1, 2])
    expect(new Set([owner.publicKey, dadIdentity.publicKey, kidIdentity.publicKey]).size).toBe(3)
    // 老师名单自动带进每位家人；档案写明称呼、年龄与代管人。
    expect(await memberStore(ownerStore, dad.account).get('settings', 'teachers')).toEqual([teacher.publicKey])
    const dadProfile = await loadProfile(memberStore(ownerStore, dad.account))
    expect(dadProfile.alias.value).toBe('爸爸')
    expect(dadProfile.managedBy?.value).toBe('王小明')
    expect(dadProfile.age.value).not.toBeNull()
    // 作业、打卡、舌象分片存放，互不可见。
    await memberStore(ownerStore, dad.account).put('homework', 'h1', 'synthetic-dad-homework')
    await memberStore(ownerStore, kid.account).put('homework', 'h2', 'synthetic-kid-homework')
    await ownerStore.put('homework', 'h0', 'synthetic-owner-homework')
    expect((await memberStore(ownerStore, dad.account).list('homework')).map(row => row.value)).toEqual(['synthetic-dad-homework'])
    expect((await memberStore(ownerStore, kid.account).list('homework')).map(row => row.value)).toEqual(['synthetic-kid-homework'])
    expect((await ownerStore.list('homework')).map(row => row.value)).toEqual(['synthetic-owner-homework'])
    // 移除家人清掉他的分片，不影响其他人。
    const remaining = await removeFamilyMember(ownerStore, kid.account)
    expect(remaining.map(member => member.alias)).toEqual(['爸爸'])
    expect(await memberStore(ownerStore, kid.account).list('homework')).toEqual([])
    expect((await memberStore(ownerStore, dad.account).list('homework')).map(row => row.value)).toEqual(['synthetic-dad-homework'])
  })

  it('2: a family consult is labelled with the manager and the signed record + homework land under the family member', async () => {
    const { owner, teacher, ownerStore, teacherStore, dad, dadIdentity } = await setupFamily()
    const memberScoped = memberStore(ownerStore, dad.account)
    const dadProfile = await loadProfile(memberScoped)
    // 代管人替爸爸问诊：走正常采集到确认页，再确认发送。
    let session = startSession({ student: dadIdentity.publicKey, teacher: teacher.publicKey, template: template as TeacherTemplate })
    session = addUtterance(session, 'SYNTHETIC_DAD_COMPLAINT')
    session = await organizeSession(session, null)
    while (session.phase !== 'confirm') { session = skipFocus(session, session.questions[0].focus); session = await organizeSession(session, null) }
    session = markReviewed(session)
    const sent: Message['envelope'][] = []
    const send = async (recipient: string, envelope: Message['envelope']) => {
      expect(recipient).toBe(teacher.publicKey)
      sent.push(envelope)
    }
    await confirmAndSend(memberScoped, session, dadProfile, [], [], async pkg => {
      await send(teacher.publicKey, consultEnvelope(pkg))
    }, undefined, { manager: owner.publicKey, managerProof: createFamilyProof(owner, dadIdentity.publicKey) })
    // 老师端：问诊包里带代管人与代管证明，展示“爸爸（王小明代管）”。
    const teacherInbox = createInbox({ identity: teacher, store: teacherStore })
    for (const envelope of sent) await teacherInbox.receive(message(dadIdentity.publicKey, envelope))
    const consults = await listConsults(teacherStore)
    expect(consults).toHaveLength(1)
    expect(consults[0].manager).toBe(owner.publicKey)
    expect(consults[0].managerInvalid).toBeUndefined()
    expect(consultChargeBook(consults[0])).toEqual({ student: owner.publicKey, forMember: '爸爸' })
    expect(consults[0].encounter.profile.alias.value).toBe('爸爸')
    expect(managedLabel(consults[0].encounter.profile)).toBe('爸爸（王小明代管）')
    // 老师签字：病历回到爸爸名下，扣费记在“老师 × 代管人”那一本账，并标注 forMember。
    const homework: Homework = { id: 'a'.repeat(8), title: 'SYNTHETIC_DAILY', detail: 'synthetic', schedule: { kind: 'daily', time: '09:00' }, source: 'teacher' }
    const final: Encounter = structuredClone(consults[0].encounter)
    final.plan.homework = [homework]
    const charges: ChainEventDraft[] = []
    const chargeStudents: string[] = []
    const toMember: Message['envelope'][] = []
    const result = await completeConsultSigning({
      identity: teacher, consult: consults[0], final,
      send: async (student, envelope) => { expect(student).toBe(dadIdentity.publicKey); toMember.push(envelope) },
      ledger: { open: async () => {}, record: async (_teacher, student, draft) => { chargeStudents.push(student); charges.push(draft) } },
      charge: 3,
      chargeBook: consultChargeBook(consults[0]),
    })
    expect(result.chargeError).toBeNull()
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ type: 'charge', amount: 3, forMember: '爸爸' })
    expect(chargeStudents).toEqual([owner.publicKey])
    // 爸爸的收件箱只认“我的老师”：签名病历与作业记在爸爸名下。
    const dadInbox = createInbox({ identity: dadIdentity, store: memberScoped })
    for (const envelope of toMember) await dadInbox.receive(message(teacher.publicKey, envelope))
    const records = await listReceivedRecords(memberScoped, dadIdentity)
    expect(records).toHaveLength(1)
    expect(records[0].encounter.student).toBe(dadIdentity.publicKey)
    expect((await memberScoped.list('homework')).map(row => (row.value as unknown as { homework: Homework }).homework.title)).toEqual(['SYNTHETIC_DAILY'])
    expect(await ownerStore.list('homework')).toEqual([])
  })

  it('4: mirror advice for a child drops alcohol, strong tea and coffee while keeping safe advice', async () => {
    const { dad, kid, ownerStore } = await setupFamily()
    const dadProfile = await loadProfile(memberStore(ownerStore, dad.account))
    const kidProfile = await loadProfile(memberStore(ownerStore, kid.account))
    const llm = (seen: string[]) => ({
      complete: async (messages: { role: string; content: string }[]) => {
        seen.push(messages[1].content)
        return JSON.stringify({ today: ['喝点浓茶提神', '少喝咖啡', '早点睡觉', '饭后走一走'] })
      },
    })
    const seen: string[] = []
    const child = await dailyMirror({ carePlan: null, jieqi: '立秋', weather: null, recentCheckins: [], recentSymptoms: [], age: kidProfile.age.value, llm: llm(seen) as never })
    expect(child.today).toEqual(['早点睡觉', '饭后走一走'])
    expect(JSON.parse(seen[0]).member.age).toBe(kidProfile.age.value)
    const adult = await dailyMirror({ carePlan: null, jieqi: '立秋', weather: null, recentCheckins: [], recentSymptoms: [], age: dadProfile.age.value, llm: llm([]) as never })
    expect(adult.today).toContain('喝点浓茶提神')
  })

  it('6: two family charges share one book, sum into one balance and can be filtered by family member', async () => {
    const { owner, teacher } = await setupFamily()
    let ledger = createLedger(teacher.publicKey, owner.publicKey)
    ledger = append(ledger, teacher.privateKey, { type: 'charge', amount: 2, chargeReason: 'consult', recordHash: 'b'.repeat(64), forMember: '爸爸' })
    ledger = append(ledger, teacher.privateKey, { type: 'charge', amount: 3, chargeReason: 'consult', recordHash: 'c'.repeat(64), forMember: '孩子' })
    expect(verify(ledger)).toEqual([])
    expect(balance(ledger)).toBe(-5)
    expect(filterChargesByMember(ledger, '爸爸').map(event => (JSON.parse(event.content) as { amount: number }).amount)).toEqual([2])
    expect(filterChargesByMember(ledger, '孩子').map(event => (JSON.parse(event.content) as { amount: number }).amount)).toEqual([3])
    expect(filterChargesByMember(ledger, null)).toHaveLength(2)
    const tampered: SignedLedgerEvent = { ...ledger.events[0], content: JSON.stringify({ ...JSON.parse(ledger.events[0].content), type: 'topup' }) }
    expect(verify({ ...ledger, events: [tampered] }).some(issue => issue.code === 'invalid-member' || issue.code === 'bad-signature')).toBe(true)
  })

  it('7: 代管证明只认代管人签给这位家人的 kind 2732 小事件', async () => {
    const { owner, dadIdentity } = await setupFamily()
    const other = createIdentity()
    const proof = createFamilyProof(owner, dadIdentity.publicKey)
    expect(proof.kind).toBe(FAMILY_PROOF_KIND)
    expect(proof.content).toBe(FAMILY_PROOF_CONTENT)
    expect(proof.tags).toEqual([['p', dadIdentity.publicKey]])
    expect(verifyFamilyProof(proof, { manager: owner.publicKey, member: dadIdentity.publicKey, sender: dadIdentity.publicKey }).pubkey).toBe(owner.publicKey)
    // 换成别的“代管人”就不认。
    expect(() => verifyFamilyProof(proof, { manager: other.publicKey, member: dadIdentity.publicKey, sender: dadIdentity.publicKey })).toThrow('不是代管人签的')
    // 篡改 content 或 p 标签后事件 id 与内容不一致，拒收。
    expect(() => verifyFamilyProof({ ...proof, content: 'aster.other.v1' }, { manager: owner.publicKey, member: dadIdentity.publicKey, sender: dadIdentity.publicKey })).toThrow()
    expect(() => verifyFamilyProof({ ...proof, tags: [['p', other.publicKey]] }, { manager: owner.publicKey, member: dadIdentity.publicKey, sender: dadIdentity.publicKey })).toThrow()
    // 家人与发件人必须一致。
    expect(() => verifyFamilyProof(proof, { manager: owner.publicKey, member: dadIdentity.publicKey, sender: other.publicKey })).toThrow('家人与发件人不一致')
  })

  it('8: 伪造的代管人（没有证明或证明是别人签的）不会把扣费记到另一位学生账上', async () => {
    const { owner, teacher, ownerStore, teacherStore, dad, dadIdentity } = await setupFamily()
    const otherStudent = createIdentity()
    const memberScoped = memberStore(ownerStore, dad.account)
    const dadProfile = await loadProfile(memberScoped)
    const makeConsult = async (manager: string, managerProof: unknown) => {
      let session = startSession({ student: dadIdentity.publicKey, teacher: teacher.publicKey, template: template as TeacherTemplate })
      session = addUtterance(session, 'SYNTHETIC_FORGED_MANAGER')
      session = await organizeSession(session, null)
      while (session.phase !== 'confirm') { session = skipFocus(session, session.questions[0].focus); session = await organizeSession(session, null) }
      session = markReviewed(session)
      // 模拟恶意客户端：正常生成问诊包后，绕过界面往传输信封里塞 manager / 证明。
      let sentPackage: Parameters<typeof consultEnvelope>[0] | undefined
      await confirmAndSend(memberScoped, session, dadProfile, [], [], async pkg => { sentPackage = pkg })
      const envelope = consultEnvelope(sentPackage!)
      const payload = envelope.payload as Record<string, unknown>
      payload.manager = manager
      if (managerProof !== undefined) payload.managerProof = managerProof
      await createInbox({ identity: teacher, store: teacherStore }).receive(message(dadIdentity.publicKey, envelope))
      const consults = await listConsults(teacherStore)
      return consults.find(consult => consult.encounter.id === session.encounterId)!
    }
    // 只填 manager、没有证明：老师端不认代管人。
    const noProof = await makeConsult(otherStudent.publicKey, undefined)
    expect(noProof.manager).toBeUndefined()
    expect(noProof.managerInvalid).toBe(true)
    expect(consultChargeBook(noProof)).toBeUndefined()
    // 证明是本人（owner）签给爸爸的，却声称 manager 是另一位学生：同样不认。
    const wrongSigner = await makeConsult(otherStudent.publicKey, createFamilyProof(owner, dadIdentity.publicKey))
    expect(wrongSigner.manager).toBeUndefined()
    expect(wrongSigner.managerInvalid).toBe(true)
    expect(consultChargeBook(wrongSigner)).toBeUndefined()
    // 老师按回落规则扣费：记在发件人（爸爸）自己那本账，绝不记到那位学生账上。
    for (const consult of [noProof, wrongSigner]) {
      const students: string[] = []
      const final: Encounter = structuredClone(consult.encounter)
      await completeConsultSigning({
        identity: teacher, consult, final,
        send: async () => {},
        ledger: { open: async () => {}, record: async (_teacher, student) => { students.push(student) } },
        charge: 2,
        ...(consultChargeBook(consult) ? { chargeBook: consultChargeBook(consult) } : {}),
      })
      expect(students).toEqual([dadIdentity.publicKey])
      expect(students).not.toContain(otherStudent.publicKey)
    }
  })
})

describe('M1-22 family wiring keeps one ledger on the manager account', () => {
  it('charges the manager book with forMember through the real ledger controller', async () => {
    const { owner, teacher, ownerStore, teacherStore } = await setupFamily()
    let teacherSync: ReturnType<typeof createLedgerSync> | undefined, ownerSync: ReturnType<typeof createLedgerSync> | undefined
    try {
      teacherSync = createLedgerSync({ identity: teacher, store: teacherStore, send: async () => 'synthetic' })
      ownerSync = createLedgerSync({ identity: owner, store: ownerStore, send: async () => 'synthetic' })
      await teacherSync.open(teacher.publicKey, owner.publicKey)
      await ownerSync.open(teacher.publicKey, owner.publicKey)
      await teacherSync.record(teacher.publicKey, owner.publicKey, { type: 'charge', amount: 2, chargeReason: 'consult', forMember: '爸爸' })
      await teacherSync.record(teacher.publicKey, owner.publicKey, { type: 'charge', amount: 3, chargeReason: 'consult', forMember: '孩子' })
      const view = await teacherSync.view(teacher.publicKey, owner.publicKey)
      expect(view.balance).toBe(-5)
      expect(view.ledger.events).toHaveLength(2)
      expect(filterChargesByMember(view.ledger, '爸爸')).toHaveLength(1)
    } finally {
      await teacherSync?.close(); await ownerSync?.close()
    }
  })
})
