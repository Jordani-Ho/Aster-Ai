import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Identity } from '../identity'
import { createIdentity } from '../identity'
import { openStore, type LocalStore } from '../store'
import type { Envelope, Message } from '../transport'
import { addTeacher, completeConsultSigning, createInbox, listReceivedRecords, type StoredConsult } from '../inbox'
import { startInPersonEncounter, recordIntakeField, signAndHandoverInPerson } from '../record/in-person'
import { signEncounter } from '../record/sign'
import type { Encounter } from '../record/types'
import { searchCases } from '../drafting/cases'
import { storeCarePlan } from '../careplan'
import { recordSelfRating, last14DayTrend, listSelfRatings } from '../mirror/trend'
import { checkIn } from '../homework'
import { saveTongue } from '../tongue'
import { parseTongueAbstract, tongueSvg, type TongueFeatures } from '../../../../domain/tcm/tongue'
import { localDay } from '../homework/schedule'
import {
  latestTeacherRecord, listTeacherRecords, revisedEncounter,
  saveTeacherRecord, teacherCases, teacherContactStudents, teacherStudents, TEACHER_RECORDS,
} from './teacher'
import {
  RETENTION_DEFAULT_DAYS, effectiveRetentionDays, listTeacherRetentions, loadRetentionDays,
  retentionEnvelope, runRetention, runRetentionOnce, saveRetentionDays, validRetentionDays,
} from './retention'
import {
  autoRestore, backupForTeacher, markRestoreNeeded, requestOwnRecords, requestStudentsRecords, restoreNeeded,
} from './backup'

// 全部使用合成身份、合成病历、fake-indexeddb 与内存投递；不连真实 relay/gateway。
const DAY = 86400000
const NOW = new Date('2026-10-18T12:00:00.000Z')
const closers: LocalStore[] = []
afterEach(() => { while (closers.length) closers.pop()!.close() })

// V2-03：舌象只存抽象记录（特征 + 本地重建示意图），不再存原图字节。
const TONGUE_FEATURES: TongueFeatures = { color: 'unknown', coatingColor: 'unknown', coatingThickness: 'unknown', shape: 'unknown', teeth: null, cracks: null, confidence: 0.5 }
const TONGUE = parseTongueAbstract({ kind: 'tongue', features: TONGUE_FEATURES, svg: tongueSvg(TONGUE_FEATURES), shichen: '辰', jieqi: '霜降', city: '北京市' })

async function newStore(identity: Identity, role: 'teacher' | 'student'): Promise<LocalStore> {
  const store = await openStore(identity, { factory: new IDBFactory() })
  await store.put('settings', 'role', { role })
  closers.push(store)
  return store
}

// 内存投递：发件人的 send 直接把信封递给收件人的 inbox.receive（与真实 transport 投递同形）。
function network(inboxes: Map<string, ReturnType<typeof createInbox>>, senders: Map<string, Identity>) {
  const routes = new Map<string, (recipient: string, envelope: Envelope) => Promise<unknown>>()
  for (const [pubkey, identity] of senders) {
    routes.set(pubkey, async (recipient, envelope) => {
      const target = inboxes.get(recipient)
      if (!target) throw new Error('收件人不在本机网络里')
      const message: Message = { id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: identity.publicKey, envelope }
      await target.receive(message)
      return crypto.randomUUID()
    })
  }
  return routes
}

// 远程问诊的最小合法病历：intake 都是学生来源，其余为未知；不含 AI 草稿。
function remoteEncounter(teacher: string, student: string, options: { id?: string; createdAt?: string } = {}): Encounter {
  const unknown = <T,>() => ({ value: null, source: 'unknown' as const }) as { value: T | null; source: 'unknown' }
  const text = (value: string) => ({ value, source: 'student' as const })
  return {
    id: options.id ?? 'a'.repeat(32),
    version: 1,
    kind: 'remote_async',
    student,
    teacher,
    createdAt: options.createdAt ?? NOW.toISOString(),
    profile: { alias: text('合成学生'), gender: unknown<'male' | 'female' | 'other'>(), age: unknown<number>(), bazi: unknown<{ year: string | null; month: string | null; day: string; hour: string | null; flags: string[] }>(), city: text('北京市') },
    intake: {
      chiefComplaint: text('睡不着，晚上多梦'),
      presentIllness: text('最近两周入睡困难'),
      history: text('无'),
      medsAllergies: text('无'),
      attachments: [],
    },
    fourExams: { look: unknown<string>(), listenSmell: unknown<string>(), ask: unknown<string>(), pulse: unknown<string>() },
    judgment: { symptomSummary: unknown<string>(), pattern: unknown<string>(), mechanism: unknown<string>(), rationale: unknown<string>() },
    plan: { principle: unknown<string>(), prescription: unknown<{ items: { herb: string; dose: string }[] }>(), homework: [], advice: unknown<string>() },
  }
}

function acceptAll(encounter: Encounter): Encounter {
  const final = structuredClone(encounter)
  for (const section of [final.fourExams, final.judgment]) {
    for (const key of Object.keys(section) as (keyof typeof section)[]) {
      const field = section[key] as { value: unknown; source: string; note?: string }
      if (field.source === 'ai_draft') field.source = 'teacher', field.note = 'ai_accepted'
    }
  }
  for (const key of ['principle', 'prescription', 'advice'] as const) {
    const field = final.plan[key] as { value: unknown; source: string; note?: string }
    if (field.source === 'ai_draft') field.source = 'teacher', field.note = 'ai_accepted'
  }
  return final
}

function storedConsult(encounter: Encounter): StoredConsult {
  return { encounter, history: [], attachments: [], receivedAt: NOW.toISOString(), sender: encounter.student, droppedHistory: 0 }
}

describe('V2-05 验收 0：老师端完整医案 teacher-records', () => {
  it('远程与面诊各签一次 → 各存一份完整病历；起草检索、改方 previousOf、扣费 recordHash 都从它读', async () => {
    const teacher = createIdentity()
    const student = createIdentity()
    const store = await newStore(teacher, 'teacher')
    const sent: Envelope[] = []

    // 远程：签字发送成功后存完整签名病历。
    const encounter = remoteEncounter(teacher.publicKey, student.publicKey)
    const final = acceptAll(encounter)
    const charges: { recordHash?: string }[] = []
    const result = await completeConsultSigning({
      identity: teacher, store, consult: storedConsult(encounter), final,
      send: async (_recipient, envelope) => { sent.push(envelope) },
      ledger: { record: async (_t, _s, draft) => { charges.push(draft) } },
      charge: 2,
    })
    const rows = await listTeacherRecords(store)
    expect(rows).toHaveLength(1)
    expect(rows[0].eventId).toBe(result.signed.id)
    expect(rows[0].encounter).toEqual(final)
    // 康币扣费的 recordHash 就是这份签名事件 id。
    expect(charges[0].recordHash).toBe(rows[0].eventId)

    // 面诊：代录后签字发送成功，也存一份完整病历。
    let inPerson = recordIntakeField(startInPersonEncounter({ teacher: teacher.publicKey, student: student.publicKey, now: NOW, id: 'b'.repeat(32) }), 'chiefComplaint', '胸口闷，睡不好').encounter
    inPerson = {
      ...inPerson,
      judgment: { ...inPerson.judgment, symptomSummary: { value: '胸闷失眠', source: 'teacher' }, pattern: { value: '肝郁', source: 'teacher' } },
      plan: { ...inPerson.plan, prescription: { value: { items: [{ herb: '合成药', dose: '3g' }], days: 3 }, source: 'teacher' } },
    }
    await signAndHandoverInPerson({
      encounter: inPerson, privateKey: teacher.privateKey, store,
      send: async (_type, event) => { await saveTeacherRecord(store, event) },
    })
    const all = await listTeacherRecords(store)
    expect(all).toHaveLength(2)
    expect(all.some(record => record.encounter.kind === 'in_person' && record.encounter.intake.chiefComplaint.value === '胸口闷，睡不好')).toBe(true)

    // 起草时的医案检索：从 teacher-records 投影 DraftCase，能搜到上一份。
    const cases = await teacherCases(store)
    expect(cases).toHaveLength(2)
    const found = searchCases('胸闷', cases)
    expect(found[0].id).toBe(all.find(record => record.encounter.kind === 'in_person')!.eventId)

    // 改方：上一版事件 id 从 teacher-records 读，previousOf 指向旧版。
    const previous = await latestTeacherRecord(store, 'b'.repeat(32))
    expect(previous).not.toBeNull()
    const revised = revisedEncounter(previous!.encounter, previous!.eventId, {
      plan: { ...previous!.encounter.plan, prescription: { value: { items: [{ herb: '合成药', dose: '2g' }], days: 3 }, source: 'teacher' } },
    })
    expect(revised.version).toBe(2)
    expect(revised.supersedes).toBe(previous!.eventId)
    expect(revised.plan.prescription.value).toMatchObject({ previousOf: previous!.eventId, changeReason: '改方' })
  })

  it('老师端只认自己签的完整病历；学生、面诊索引按公钥去重', async () => {
    const teacher = createIdentity()
    const a = createIdentity(), b = createIdentity()
    const store = await newStore(teacher, 'teacher')
    // 别人签的病历不能当成这位老师的备份（回包按发件人核对）。
    const forged = signEncounter(remoteEncounter(a.publicKey, b.publicKey), a.privateKey)
    expect(backupForTeacher(forged, teacher.publicKey, b.publicKey)).toBeNull()
    expect(backupForTeacher(forged, a.publicKey, b.publicKey)).not.toBeNull()
    // p 标签不是发件人的回包也不认。
    expect(backupForTeacher(forged, a.publicKey, teacher.publicKey)).toBeNull()
    const first = signEncounter(startInPersonEncounter({ teacher: teacher.publicKey, student: a.publicKey, now: NOW, id: 'c'.repeat(32) }), teacher.privateKey)
    const second = signEncounter(startInPersonEncounter({ teacher: teacher.publicKey, student: b.publicKey, now: NOW, id: 'd'.repeat(32) }), teacher.privateKey)
    expect(await saveTeacherRecord(store, first)).not.toBeNull()
    expect(await saveTeacherRecord(store, second)).not.toBeNull()
    expect(await teacherStudents(store)).toEqual([a.publicKey, b.publicKey].sort())
  })

  it('代码里搜不到 case-book / signed-encounters（README 除外）', () => {
    const root = new URL('../../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    const legacy = ['case-book', 'signed-encounters']
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { if (!['node_modules', 'dist', '.git', 'docs', 'deploy', 'gateway', 'relay'].includes(entry.name)) walk(path); continue }
        if (!/\.(ts|tsx|mjs|js|json)$/.test(entry.name)) continue
        files.push(path)
      }
    }
    walk(join(root, 'app', 'src'))
    walk(join(root, 'e2e'))
    // 这个测试文件本身要写出旧名，扫描时跳过。
    const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    for (const file of files) {
      if (file === self || file.endsWith('records.test.ts')) continue
      const text = readFileSync(file, 'utf8')
      for (const name of legacy) expect(text, file).not.toContain(name)
    }
  })
})

describe('V2-05 验收 1：老师设定保留期限', () => {
  const old = new Date(NOW.getTime() - 31 * DAY)
  const fresh = new Date(NOW.getTime() - 1 * DAY)

  it('老师设 30 天：第 31 天打开应用，31 天前记录两端都不见，调养方案还在', async () => {
    const teacher = createIdentity()
    const student = createIdentity()
    const teacherStore = await newStore(teacher, 'teacher')
    const studentStore = await newStore(student, 'student')

    // 默认 90 天，可选 30 天～3 年。
    expect(await loadRetentionDays(teacherStore)).toBe(RETENTION_DEFAULT_DAYS)
    expect(validRetentionDays(29)).toBe(false)
    expect(validRetentionDays(30)).toBe(true)
    expect(validRetentionDays(1095)).toBe(true)
    expect(validRetentionDays(1096)).toBe(false)
    await saveRetentionDays(teacherStore, 30)

    // 老师在两端各留一条旧记录、一条新记录。
    await saveTeacherRecord(teacherStore, signEncounter(startInPersonEncounter({ teacher: teacher.publicKey, student: student.publicKey, now: old, id: 'e'.repeat(32) }), teacher.privateKey))
    await saveTeacherRecord(teacherStore, signEncounter(startInPersonEncounter({ teacher: teacher.publicKey, student: student.publicKey, now: fresh, id: 'f'.repeat(32) }), teacher.privateKey))

    await recordSelfRating(studentStore, 3, old)
    await recordSelfRating(studentStore, 5, fresh)
    await checkIn(studentStore, 'hw-synthetic', undefined, old)
    await checkIn(studentStore, 'hw-synthetic', undefined, fresh)
    await saveTongue(studentStore, TONGUE, old)
    // 长期保留的沉淀：调养方案。
    await storeCarePlan(studentStore, teacher.publicKey, { constitution: '平和质', points: ['早睡'], avoid: ['生冷'], updatedAt: NOW.toISOString(), version: 1 })

    // 保留期限随调养方案发给学生（这里直接投递设置信封）。
    const inbox = createInbox({ identity: student, store: studentStore })
    await inbox.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: teacher.publicKey, envelope: retentionEnvelope(teacher.publicKey, 30) })
    const retentions = await listTeacherRetentions(studentStore)
    expect(effectiveRetentionDays(retentions)).toBe(30)

    // 第 31 天打开应用：两端各跑一次保留期清理。
    expect(await runRetentionOnce(teacherStore, 'teacher', { now: NOW })).not.toBeNull()
    expect(await runRetentionOnce(studentStore, 'student', { now: NOW })).not.toBeNull()
    // 同一天再打开不会重复跑。
    expect(await runRetentionOnce(teacherStore, 'teacher', { now: NOW })).toBeNull()

    const teacherRecords = await listTeacherRecords(teacherStore)
    expect(teacherRecords).toHaveLength(1)
    expect(teacherRecords[0].createdAt).toBe(fresh.toISOString())
    const ratings = await listSelfRatings(studentStore)
    expect(ratings.map(rating => rating.score)).toEqual([5])
    expect(await studentStore.list('checkins')).toHaveLength(1)
    expect(await studentStore.list('tongue-records')).toHaveLength(0)
    // 长时间保留的调养方案还在。
    expect(await studentStore.get('care-plans', teacher.publicKey)).toBeDefined()

    // 列表/走势等读数据的地方不会因为删除而报错。
    expect(() => last14DayTrend([], ratings, [], NOW)).not.toThrow()
    expect(await studentStore.list(TEACHER_RECORDS)).toEqual([])
  })

  it('学生端收到的签名病历也按保留期限删：超期删掉、保留期内还在', async () => {
    const teacher = createIdentity()
    const student = createIdentity()
    const studentStore = await newStore(student, 'student')
    await addTeacher(studentStore, teacher.publicKey)
    const inbox = createInbox({ identity: student, store: studentStore })
    const old = new Date(NOW.getTime() - 40 * DAY), recent = new Date(NOW.getTime() - 5 * DAY)
    const expired = signEncounter(startInPersonEncounter({ teacher: teacher.publicKey, student: student.publicKey, now: old, id: '7'.repeat(32) }), teacher.privateKey)
    const keptRecord = signEncounter(startInPersonEncounter({ teacher: teacher.publicKey, student: student.publicKey, now: recent, id: '8'.repeat(32) }), teacher.privateKey)
    for (const record of [expired, keptRecord]) {
      await inbox.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: teacher.publicKey, envelope: { type: 'record.signed', version: 1, payload: record } })
    }
    expect(await listReceivedRecords(studentStore, student)).toHaveLength(2)

    // 老师设 30 天：学生端按收到的设置删自己的病历。
    await inbox.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: teacher.publicKey, envelope: retentionEnvelope(teacher.publicKey, 30) })
    const result = await runRetentionOnce(studentStore, 'student', { now: NOW })
    expect(result?.days).toBe(30)
    expect(await studentStore.list('student-records')).toHaveLength(1)
    const kept = await listReceivedRecords(studentStore, student)
    expect(kept.map(record => record.event.id)).toEqual([keptRecord.id])
  })

  it('学生端按老师设置滚动删除多少天都可注入时间；保留期限非法值不入库', async () => {
    const student = createIdentity()
    const studentStore = await newStore(student, 'student')
    await expect(saveRetentionDays(studentStore, 29)).rejects.toThrow('保留期限须为 30 天到 3 年之间')
    await recordSelfRating(studentStore, 4, new Date(NOW.getTime() - 40 * DAY))
    await recordSelfRating(studentStore, 2, new Date(NOW.getTime() - 10 * DAY))
    const result = await runRetention(studentStore, 'student', { now: NOW, days: 30 })
    expect(result.days).toBe(30)
    expect((await listSelfRatings(studentStore)).map(rating => rating.score)).toEqual([2])
    expect(localDay(new Date(NOW.getTime() - 40 * DAY)) < localDay(new Date(NOW.getTime() - 30 * DAY))).toBe(true)
  })
})

describe('V2-05 验收 2、3：师生互为备份', () => {
  async function world() {
    const teacher = createIdentity()
    const a = createIdentity(), b = createIdentity()
    const teacherStore = await newStore(teacher, 'teacher')
    const aStore = await newStore(a, 'student')
    const bStore = await newStore(b, 'student')
    const inboxes = new Map<string, ReturnType<typeof createInbox>>()
    const senders = new Map<string, Identity>([[teacher.publicKey, teacher], [a.publicKey, a], [b.publicKey, b]])
    const routes = network(inboxes, senders)
    for (const [pubkey, identity] of senders) {
      const store = pubkey === teacher.publicKey ? teacherStore : pubkey === a.publicKey ? aStore : bStore
      inboxes.set(pubkey, createInbox({ identity, store, send: (recipient, envelope) => routes.get(pubkey)!(recipient, envelope) }))
    }
    return { teacher, a, b, teacherStore, aStore, bStore, inboxes, routes }
  }

  it('学生清空本机记录后走邀请链接重进：连上中继自动从老师要回保留期内的记录', async () => {
    const w = await world()
    // 老师端有这位学生的两份病历：一份在 30 天内，一份已超过 30 天。
    await saveRetentionDays(w.teacherStore, 30)
    const recent = signEncounter(startInPersonEncounter({ teacher: w.teacher.publicKey, student: w.a.publicKey, now: NOW, id: '1'.repeat(32) }), w.teacher.privateKey)
    const tooOld = signEncounter(startInPersonEncounter({ teacher: w.teacher.publicKey, student: w.a.publicKey, now: new Date(NOW.getTime() - 40 * DAY), id: '2'.repeat(32) }), w.teacher.privateKey)
    await saveTeacherRecord(w.teacherStore, recent)
    await saveTeacherRecord(w.teacherStore, tooOld)

    // 学生清空本机记录（身份仍在）：重新进入社区、重新加上老师。
    const cleared = await openStore(w.a, { factory: new IDBFactory() })
    closers.push(cleared)
    await cleared.put('settings', 'role', { role: 'student' })
    await addTeacher(cleared, w.teacher.publicKey)
    await markRestoreNeeded(cleared)
    expect(await restoreNeeded(cleared)).toBe(true)
    const studentInbox = createInbox({ identity: w.a, store: cleared, send: (recipient, envelope) => w.routes.get(w.a.publicKey)!(recipient, envelope) })
    w.inboxes.set(w.a.publicKey, studentInbox)

    // 连上中继后自动请求（每天最多一次）。
    expect(await autoRestore(cleared, [w.teacher.publicKey], (recipient, envelope) => w.routes.get(w.a.publicKey)!(recipient, envelope), { now: NOW })).toBe(true)
    expect(await restoreNeeded(cleared)).toBe(false)
    const restored = await listReceivedRecords(cleared, w.a)
    expect(restored).toHaveLength(1)
    expect(restored[0].event.id).toBe(recent.id)
  })

  it('老师清空医案后自动向两位学生要回自己签的病历；回收只来自本人、A 的记录不会发给 B', async () => {
    const w = await world()
    // 两位学生手里各有一份老师签的病历。
    const recordA = signEncounter(startInPersonEncounter({ teacher: w.teacher.publicKey, student: w.a.publicKey, now: NOW, id: '3'.repeat(32) }), w.teacher.privateKey)
    const recordB = signEncounter(startInPersonEncounter({ teacher: w.teacher.publicKey, student: w.b.publicKey, now: NOW, id: '4'.repeat(32) }), w.teacher.privateKey)
    await saveTeacherRecord(w.teacherStore, recordA)
    await saveTeacherRecord(w.teacherStore, recordB)
    // 学生端各自先收到签名病历（record.signed 与备份同一入库路径）。
    for (const [store, record] of [[w.aStore, recordA], [w.bStore, recordB]] as const) {
      await addTeacher(store, w.teacher.publicKey)
      const identity = store === w.aStore ? w.a : w.b
      const inbox = createInbox({ identity, store })
      await inbox.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: w.teacher.publicKey, envelope: { type: 'record.signed', version: 1, payload: record } })
      expect(await listReceivedRecords(store, identity)).toHaveLength(1)
    }
    // 老师换手机：医案没了，但认得的学生的名单还在。
    for (const row of await w.teacherStore.list(TEACHER_RECORDS)) await w.teacherStore.delete(TEACHER_RECORDS, row.key)
    expect(await listTeacherRecords(w.teacherStore)).toHaveLength(0)
    expect(await teacherContactStudents(w.teacherStore)).toEqual([w.a.publicKey, w.b.publicKey].sort())

    // 连上中继后自动逐个请求。
    const teacherSend = (recipient: string, envelope: Envelope) => w.routes.get(w.teacher.publicKey)!(recipient, envelope)
    expect(await autoRestore(w.teacherStore, [], teacherSend, { now: NOW })).toBe(true)
    const restored = await listTeacherRecords(w.teacherStore)
    expect(restored.map(record => record.eventId).sort()).toEqual([recordA.id, recordB.id].sort())
    // A 的记录不会出现在 B 的名下。
    expect(restored.find(record => record.eventId === recordA.id)!.student).toBe(w.a.publicKey)
    expect(restored.find(record => record.eventId === recordB.id)!.student).toBe(w.b.publicKey)
  })

  it('陌生发件人的请求/回包一律不认；老师只收自己签、p 标签是发件人的那份', async () => {
    const w = await world()
    const record = signEncounter(startInPersonEncounter({ teacher: w.teacher.publicKey, student: w.a.publicKey, now: NOW, id: '5'.repeat(32) }), w.teacher.privateKey)

    // 陌生人向老师请求记录：老师端没有他的记录，一封回包都没有。
    const stranger = createIdentity()
    const strangerStore = await newStore(stranger, 'student')
    const strangerInbox = createInbox({ identity: stranger, store: strangerStore })
    let replies = 0
    w.inboxes.set(stranger.publicKey, { receive: async (message: Message) => { replies += 1; await strangerInbox.receive(message) } })
    // 让老师这一端收到请求：通过投递路径把请求送到老师的 inbox。
    await w.inboxes.get(w.teacher.publicKey)!.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: stranger.publicKey, envelope: { type: 'records.request', version: 1, payload: {} } })
    expect(replies).toBe(0)
    expect(await strangerStore.list('student-records')).toEqual([])

    // 学生把 A 的病历回给老师、但发件人是 B：p 标签不符，老师端不认。
    await w.inboxes.get(w.b.publicKey)!.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: w.b.publicKey, envelope: { type: 'records.backup', version: 1, payload: record } })
    expect(await listTeacherRecords(w.teacherStore)).toHaveLength(0)

    // 学生端收签名病历后，向老师请求时只发给自己名单里的老师。
    await addTeacher(w.aStore, w.teacher.publicKey)
    await w.inboxes.get(w.a.publicKey)!.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: w.teacher.publicKey, envelope: { type: 'record.signed', version: 1, payload: record } })
    expect(await listReceivedRecords(w.aStore, w.a)).toHaveLength(1)
    const sent: { recipient: string; type: string }[] = []
    await requestOwnRecords(w.aStore, [w.teacher.publicKey], async (recipient, envelope) => { sent.push({ recipient, type: envelope.type }) })
    expect(sent).toEqual([{ recipient: w.teacher.publicKey, type: 'records.request' }])

    // 老师逐个请求学生：只请求认得的（这里只有 A 留下了签名医案）。
    await saveTeacherRecord(w.teacherStore, record)
    const pulled: string[] = []
    await requestStudentsRecords(w.teacherStore, async recipient => { pulled.push(recipient) })
    expect(pulled).toEqual([w.a.publicKey])
  })
})
