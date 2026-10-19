import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity, type Identity } from '../identity'
import { openStore, type LocalStore } from '../store'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import template from '../../../../domain/tcm/templates/default.json'
import type { Encounter } from '../record/types'
import { signEncounter, verifySignedEncounter } from '../record/sign'
import { startInPersonEncounter } from '../record/in-person'
import { buildConsultPackage, emptyProfile, markReviewed, organizeSession, saveProfile, skipFocus, startSession, type IntakeSession } from '../intake/session'
import { addTeacher, consultEnvelope, createInbox, draftPackage, listConsults, listReceivedRecords, completeConsultSigning } from '../inbox'
import { listTeacherRecords, teacherRecordValue } from '../records/teacher'
import { addFamilyMember, loadFamilyMembers, memberStore, setFamilyMemberCity } from '../family'
import { checkIn, listCheckins } from '../homework'
import type { Envelope } from '../transport'
import { heavenAt, heavenStampOf, heavenLine, formatHeavenStamp, cityByName, heavenNow, loadTimeDisplay, saveTimeDisplay } from './index'

// 全部合成身份、合成病历、fake-indexeddb 与内存投递；不连真实 relay/gateway。
const AT = Date.UTC(2026, 9, 19, 4, 0, 0) // UTC 2026-10-19 04:00
const AT_DATE = new Date(AT)
const closers: LocalStore[] = []
const identities: Identity[] = []
function identity(): Identity {
  const value = createIdentity()
  identities.push(value)
  return value
}
async function store(who: Identity): Promise<LocalStore> {
  const value = await openStore(who, { factory: new IDBFactory() })
  closers.push(value)
  return value
}
afterEach(() => {
  while (closers.length) closers.pop()!.close()
  while (identities.length) identities.pop()!.privateKey.fill(0)
})

function profileAt(city: string): Encounter['profile'] {
  const profile = emptyProfile()
  profile.city = { value: city, source: 'student' }
  return profile
}

// 走完采集到确认页：合成会话，只说要一句话，其余追问跳过。
async function confirmedSession(student: string, teacher: string): Promise<IntakeSession> {
  let state = startSession({ student, teacher, template: template as TeacherTemplate, now: AT_DATE, id: 'a'.repeat(32) })
  state = await organizeSession(state, null)
  for (let guard = 0; guard < 12 && state.phase === 'collecting'; guard += 1) {
    for (const question of [...state.questions]) state = skipFocus(state, question.focus)
    state = await organizeSession(state, null)
  }
  return markReviewed(state)
}

// 验收 1：洛杉矶学生在 UTC 2026-10-19 04:00 发问诊包 → heaven {戌, 寒露, 洛杉矶}；
// 北京老师起草页显示这一行；签字后病历里还是这三项。
describe('V2-06 验收 1：问诊包带天地人，签字病历沿用', () => {
  it('学生发送时取 heaven，老师起草与签字后都是同一份', async () => {
    const student = identity(), teacher = identity()
    const studentStore = await store(student), teacherStore = await store(teacher)
    const la = cityByName('洛杉矶')
    expect(la).not.toBeNull()
    const heaven = heavenStampOf(heavenAt(AT, la))
    expect(heaven).toEqual({ shichen: '戌', jieqi: '寒露', city: '洛杉矶' })
    const profile = profileAt('洛杉矶')
    await saveProfile(studentStore, profile)

    // 学生发送：问诊包与其中的病历都带同一份 heaven。
    const state = await confirmedSession(student.publicKey, teacher.publicKey)
    const pkg = buildConsultPackage(state, profile, [], [], undefined, { heaven })
    expect(pkg.heaven).toEqual(heaven)
    expect(pkg.encounter.heaven).toEqual(heaven)

    // 老师端收件后，起草包的 heaven 仍是同一份。
    const teacherInbox = createInbox({ identity: teacher, store: teacherStore })
    await teacherInbox.receive({ id: crypto.randomUUID(), at: Math.floor(AT / 1000), sender: student.publicKey, envelope: consultEnvelope(pkg) })
    const consults = await listConsults(teacherStore)
    expect(consults).toHaveLength(1)
    expect(consults[0].heaven).toEqual(heaven)
    const draft = draftPackage(consults[0])
    expect(draft.heaven).toEqual(heaven)
    expect(draft.encounter.heaven).toEqual(heaven)

    // 老师起草页顶部那一行：按老师的 timeDisplay 显示（这里设成只看时辰，和卡上的例子一致）。
    await saveTimeDisplay(teacherStore, 'shichen')
    expect(heavenLine(draft.heaven, await loadTimeDisplay(teacherStore))).toBe('学生那边：戌时 · 寒露 · 洛杉矶')
    expect(heavenLine(draft.heaven, 'clock')).toBe('学生那边：19:00–21:00 · 寒露 · 洛杉矶')

    // 签字交还：签名病历里还是这三项。
    const sent: Envelope[] = []
    const final: Encounter = structuredClone(draft.encounter)
    const result = await completeConsultSigning({
      identity: teacher, store: teacherStore, consult: consults[0], final,
      send: async (_recipient, envelope) => { sent.push(envelope) },
    })
    const stored = await listTeacherRecords(teacherStore)
    expect(stored).toHaveLength(1)
    expect(stored[0].encounter.heaven).toEqual(heaven)
    expect(verifySignedEncounter(result.signed, { student: student.publicKey, teacher: teacher.publicKey }).heaven).toEqual(heaven)

    // 学生端收到后也是同一份 heaven。
    await addTeacher(studentStore, teacher.publicKey)
    const studentInbox = createInbox({ identity: student, store: studentStore })
    for (const envelope of sent) await studentInbox.receive({ id: crypto.randomUUID(), at: Math.floor(AT / 1000), sender: teacher.publicKey, envelope })
    const received = await listReceivedRecords(studentStore, student)
    expect(received).toHaveLength(1)
    expect(received[0].encounter.heaven).toEqual(heaven)
  })

  it('面诊在老师开始面诊时取一次 heaven，签字后沿用', async () => {
    const teacher = identity()
    const heaven = heavenStampOf(heavenAt(AT, cityByName('北京市')))
    expect(heaven).toEqual({ shichen: '午', jieqi: '寒露', city: '北京市' })
    const encounter = startInPersonEncounter({ teacher: teacher.publicKey, student: 'b'.repeat(64), now: AT_DATE, heaven })
    expect(encounter.heaven).toEqual(heaven)
    const signed = signEncounter(encounter, teacher.privateKey)
    expect((JSON.parse(signed.content) as Encounter).heaven).toEqual(heaven)
    expect(teacherRecordValue(signed)).not.toBeNull()
  })
})

// 验收 2：管理人在北京，给住在洛杉矶的家人设城市后，家人的新记录按洛杉矶算时辰。
describe('V2-06 验收 2：家人的城市单独设', () => {
  it('家人记录用家人城市的真太阳时；管理人改城市后新记录跟着变', async () => {
    const manager = identity()
    const rootStore = await store(manager)
    await saveProfile(rootStore, profileAt('北京市'))
    const member = await addFamilyMember(rootStore, manager, { alias: '合成家人', relation: 'child', gender: 'female', birthDate: '2015-03-04', city: '洛杉矶' })
    const scoped = memberStore(rootStore, member.account)
    closers.push(scoped)

    // 家人档案里存的是洛杉矶，天时按洛杉矶算（同一 UTC 时刻：戌时，不是北京的午时）。
    const laHeaven = await heavenNow(scoped, AT_DATE)
    expect(laHeaven).toMatchObject({ shichen: '戌', jieqi: '寒露', city: '洛杉矶' })
    await checkIn(scoped, 'hw-family', undefined, AT_DATE, heavenStampOf(laHeaven))

    // 管理人在家人设置里把城市改成北京：不改身份、不改账号，之后的新记录按北京算。
    const members = await loadFamilyMembers(rootStore)
    expect(members[0].city).toBe('洛杉矶')
    await setFamilyMemberCity(rootStore, member.account, '北京市')
    const updated = await loadFamilyMembers(rootStore)
    expect(updated[0].city).toBe('北京市')
    const beijingHeaven = await heavenNow(scoped, AT_DATE)
    expect(beijingHeaven).toMatchObject({ shichen: '午', city: '北京市' })
    await checkIn(scoped, 'hw-family', undefined, AT_DATE, heavenStampOf(beijingHeaven))

    const checkins = await listCheckins(scoped)
    expect(checkins).toHaveLength(2)
    expect(checkins.map(item => ({ shichen: item.shichen, city: item.city }))).toEqual(expect.arrayContaining([
      { shichen: '戌', city: '洛杉矶' },
      { shichen: '午', city: '北京市' },
    ]))
    // 时间显示方式和照镜子时辰沿用管理人：家人分片不单独保存这两个设置。
    await saveTimeDisplay(rootStore, 'shichen')
    expect(await loadTimeDisplay(scoped)).toBe('both')
    expect(await loadTimeDisplay(rootStore)).toBe('shichen')
  })
})

// 验收 3：没有 heaven 的旧格式病历照常能打开、能验签。
describe('V2-06 验收 3：没有 heaven 的旧病历', () => {
  it('旧格式照常验签、能存能读；界面不显示那一行', async () => {
    const teacher = identity(), student = identity()
    const encounter: Encounter = {
      id: 'c'.repeat(32), version: 1, kind: 'remote_async',
      student: student.publicKey, teacher: teacher.publicKey, createdAt: AT_DATE.toISOString(),
      profile: profileAt('北京市'),
      intake: {
        chiefComplaint: { value: '合成主诉', source: 'student' },
        presentIllness: { value: null, source: 'unknown' },
        history: { value: null, source: 'unknown' },
        medsAllergies: { value: null, source: 'unknown' },
        attachments: [],
      },
      fourExams: { look: { value: null, source: 'unknown' }, listenSmell: { value: null, source: 'unknown' }, ask: { value: null, source: 'unknown' }, pulse: { value: null, source: 'unknown' } },
      judgment: { symptomSummary: { value: null, source: 'unknown' }, pattern: { value: null, source: 'unknown' }, mechanism: { value: null, source: 'unknown' }, rationale: { value: null, source: 'unknown' } },
      plan: { principle: { value: null, source: 'unknown' }, prescription: { value: null, source: 'unknown' }, homework: [], advice: { value: null, source: 'unknown' } },
    }
    expect(encounter.heaven).toBeUndefined()
    const signed = signEncounter(encounter, teacher.privateKey)
    const verified = verifySignedEncounter(signed, { student: student.publicKey, teacher: teacher.publicKey })
    expect(verified.id).toBe(encounter.id)
    expect(verified.heaven).toBeUndefined()
    // 老师端照常收下，界面不显示“学生那边”。
    expect((JSON.parse(signed.content) as Encounter).heaven).toBeUndefined()
    expect(teacherRecordValue(signed)).not.toBeNull()
    expect(heavenLine(undefined, 'both')).toBeNull()
    expect(formatHeavenStamp(undefined)).toBeNull()
  })
})
