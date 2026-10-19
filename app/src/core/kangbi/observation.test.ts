import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import template from '../../../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import { createIdentity, type Identity } from '../identity'
import { openStore, type LocalStore, type StoreValue } from '../store'
import { addTeacher, adherenceEnvelope, consultEnvelope, createInbox } from '../inbox'
import { backupEnvelope } from '../records/backup'
import { buildConsultPackage, emptyProfile, markReviewed, startSession } from '../intake'
import { signEncounter } from '../record/sign'
import { startInPersonEncounter } from '../record/in-person'
import { saveTeacherRecord } from '../records/teacher'
import { checkIn } from '../homework'
import { tongueSvg, type TongueAbstract } from '../../../../domain/tcm/tongue'
import rules from '../../../../domain/tcm/kangbi-rules.json'
import type { HealthObservation, KangbiRules } from '../../../../domain/tcm/kangbi'
import { agentObservation, OBSERVATION_RULES, tongueSignal } from '../../../../domain/tcm/observation-rules'
import {
  OBSERVATION_CHOICES, OBSERVATION_LABELS, SELF_OBSERVATIONS, agentObservationFor, buildPeriodObservation,
  kangbiSummary, latestSelfObservation, listObservations, listSelfObservations, observationNoteText,
  observationWindow, parsePeriodObservation, recordObservation, recordSelfObservation, recordSignedObservation,
  shadowRun, studentObservationWindow, teacherObservationWindow,
} from './index'

// V2-10：全部合成身份、合成作业/打卡/舌象与内存投递；不连中继、不调模型、不做数据迁移。
const NOW = new Date('2026-10-18T12:00:00.000Z')
const teacher = createIdentity()
const student = createIdentity()
const stores: LocalStore[] = []
afterEach(() => { while (stores.length) stores.pop()!.close() })

async function makeStore(identity = student): Promise<LocalStore> {
  const store = await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
  stores.push(store)
  return store
}

async function signRecord(options: { teacherStore: LocalStore; who?: Identity; at: Date }): Promise<ReturnType<typeof signEncounter>> {
  const encounter = startInPersonEncounter({ teacher: teacher.publicKey, student: student.publicKey, now: options.at })
  const event = signEncounter(encounter, teacher.privateKey)
  await saveTeacherRecord(options.teacherStore, event)
  return event
}

async function deliverRecord(store: LocalStore, event: ReturnType<typeof signEncounter>, at: Date): Promise<void> {
  await addTeacher(store, teacher.publicKey)
  const inbox = createInbox({ identity: student, store })
  await inbox.receive({ id: crypto.randomUUID(), at: Math.floor(at.getTime() / 1000), sender: teacher.publicKey, envelope: { type: 'record.signed', version: 1, payload: event } })
}

const features = (overrides: Record<string, unknown> = {}) => ({
  color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.9, ...overrides,
}) as unknown as Parameters<typeof agentObservation>[0]['currentTongue']
const tongueRecord = (overrides: Record<string, unknown> = {}): TongueAbstract => {
  const parsed = features(overrides) as unknown as Parameters<typeof tongueSvg>[0]
  return { kind: 'tongue', features: parsed, svg: tongueSvg(parsed), shichen: '午', jieqi: '秋分', city: '北京市' } as unknown as TongueAbstract
}

describe('V2-10 观察周期：上次签字到这次签字，第一次从加入那天算', () => {
  it('有上次签字就用它；没有就用加入时间；都没有就是零长度周期', () => {
    expect(observationWindow({ previousSignedAt: '2026-10-01T00:00:00.000Z', joinedAt: '2026-09-01T00:00:00.000Z', now: NOW }))
      .toEqual({ start: '2026-10-01T00:00:00.000Z', end: NOW.toISOString() })
    expect(observationWindow({ previousSignedAt: null, joinedAt: '2026-09-01T00:00:00.000Z', now: NOW }).start).toBe('2026-09-01T00:00:00.000Z')
    expect(observationWindow({ now: NOW })).toEqual({ start: NOW.toISOString(), end: NOW.toISOString() })
  })

  it('老师端排除本次刚签的病历；第一次签字用学生第一次问诊到达本机的时间', async () => {
    const teacherStore = await makeStore(teacher)
    await signRecord({ teacherStore, at: new Date('2026-10-01T09:00:00.000Z') })
    const current = await signRecord({ teacherStore, at: new Date('2026-10-10T09:00:00.000Z') })
    const window = await teacherObservationWindow(teacherStore, { student: student.publicKey, now: NOW, excludeEventId: current.id })
    // 去掉本次刚签的那份，剩下的是上一次签字（10-01）。
    expect(window.start).toBe('2026-10-01T09:00:00.000Z')
    expect(window.end).toBe(NOW.toISOString())

    const firstStore = await makeStore(teacher)
    await firstStore.put('consult-package', 'synthetic-consult', { sender: student.publicKey, receivedAt: '2026-09-20T08:00:00.000Z', encounter: { student: student.publicKey } })
    const first = await teacherObservationWindow(firstStore, { student: student.publicKey, now: NOW })
    expect(first.start).toBe('2026-09-20T08:00:00.000Z')
  })

  it('学生端从上次收到这位老师的签字病历算起，没有就用加入时间', async () => {
    const studentStore = await makeStore()
    await studentStore.put('settings', 'joined-at', '2026-09-01T00:00:00.000Z')
    const event = await signRecord({ teacherStore: await makeStore(teacher), at: new Date('2026-10-05T09:00:00.000Z') })
    await deliverRecord(studentStore, event, new Date('2026-10-05T09:00:00.000Z'))
    const window = await studentObservationWindow(studentStore, { teacher: teacher.publicKey, now: NOW })
    expect(window.start).toBe('2026-10-05T09:00:00.000Z')
    expect(await studentStore.get('settings', 'joined-at')).toBe('2026-09-01T00:00:00.000Z')
  })
})

describe('V2-10 三方各说一句', () => {
  it('老师选改善、本人不选、智能体说不准：记录分别是改善 / 未评价 / 说不准', async () => {
    const teacherStore = await makeStore(teacher)
    await signRecord({ teacherStore, at: new Date('2026-10-10T09:00:00.000Z') })
    const studentStore = await makeStore()
    const report = { periodStart: '2026-10-10T09:00:00.000Z', periodEnd: NOW.toISOString(), practiceDays: 5, adherenceRate: 0.9, agentNote: 'unsure' as const }
    const record = await recordSignedObservation(teacherStore, {
      id: 'synthetic-event-id', student: student.publicKey, teacher: teacher.publicKey, at: NOW,
      teacherMinutes: 12, consultations: 1, teacherNote: 'improve', report,
    })
    expect(record.teacherNote).toBe('improve')
    expect(record.agentNote).toBe('unsure')
    expect(OBSERVATION_LABELS[record.teacherNote!]).toBe('改善')
    // 本人没选：学生端没有这条记录，界面口径是“未评价”，不是持平。
    expect(await latestSelfObservation(studentStore, { student: student.publicKey, teacher: teacher.publicKey, window: { start: report.periodStart, end: report.periodEnd } })).toBeNull()
    expect(observationNoteText(null)).toBe('未评价')
    // 老师端观察记录字段里没有本人感受，只有周期/计数/两句话/客观量表。
    expect(Object.keys(record).sort()).toEqual(['agentNote', 'at', 'consultations', 'effects', 'id', 'periodEnd', 'periodStart', 'practiceDays', 'student', 'teacher', 'teacherMinutes', 'teacherNote'])
    expect(JSON.stringify(record)).not.toMatch(/self|本人|感受/)
    expect(await teacherStore.list(SELF_OBSERVATIONS)).toEqual([])
  })

  it('本人这一句只在本机：存本机、只看当前周期、不进观察记录', async () => {
    const studentStore = await makeStore()
    const self = await recordSelfObservation(studentStore, { student: student.publicKey, teacher: teacher.publicKey, choice: 'worse', now: NOW })
    expect(await listSelfObservations(studentStore)).toEqual([self])
    const window = { start: '2026-10-10T09:00:00.000Z', end: NOW.toISOString() }
    expect((await latestSelfObservation(studentStore, { student: student.publicKey, teacher: teacher.publicKey, window }))?.choice).toBe('worse')
    // 更早周期里的记录不冒充这一周期。
    expect(await latestSelfObservation(studentStore, { student: student.publicKey, teacher: teacher.publicKey, window: { start: '2026-10-10T00:00:00.000Z', end: '2026-10-17T00:00:00.000Z' } })).toBeNull()
    // 换一位老师就看不到（本机按老师分开）。
    const other = createIdentity()
    expect(await latestSelfObservation(studentStore, { student: student.publicKey, teacher: other.publicKey, window })).toBeNull()
  })
})

describe('V2-10 学生智能体那一句（规则在 domain/tcm/observation-rules.json）', () => {
  it('数据不够一律说不准：坚持天数不够或没有坚持率', () => {
    expect(agentObservation({ practiceDays: 2, adherenceRate: 1, currentTongue: null, previousTongue: null })).toBe('unsure')
    expect(agentObservation({ practiceDays: 5, adherenceRate: null, currentTongue: null, previousTongue: null })).toBe('unsure')
  })

  it('坚持率高给改善、低给变差；与舌象方向冲突时说不准', () => {
    expect(agentObservation({ practiceDays: 5, adherenceRate: OBSERVATION_RULES.adherence.improvedAt, currentTongue: null, previousTongue: null })).toBe('improve')
    expect(agentObservation({ practiceDays: 5, adherenceRate: OBSERVATION_RULES.adherence.worsenedAt, currentTongue: null, previousTongue: null })).toBe('worse')
    // 坚持率高但舌象明确变差 → 不硬说改善
    expect(agentObservation({ practiceDays: 5, adherenceRate: 0.9, currentTongue: features({ color: 'red', coatingThickness: 'thick' }), previousTongue: features() })).toBe('unsure')
    // 坚持率持平但舌象变好 → 改善
    expect(agentObservation({ practiceDays: 5, adherenceRate: 0.6, currentTongue: features(), previousTongue: features({ color: 'pale', coatingThickness: 'thick' }) })).toBe('improve')
  })

  it('舌象方向只看看得清的项：淡红靠拢变好、齿痕裂纹变少变好、不确定项跳过', () => {
    expect(tongueSignal(features(), features({ color: 'pale' }))).toBe(1)
    expect(tongueSignal(features({ color: 'pale' }), features())).toBe(-1)
    expect(tongueSignal(features({ teeth: ['left-tip'], cracks: [] }), features({ teeth: [], cracks: ['center'] }))).toBe(0)
    expect(tongueSignal(features({ color: 'uncertain', coatingColor: 'uncertain', coatingThickness: 'uncertain', teeth: 'uncertain', cracks: 'uncertain' }), features())).toBeNull()
    expect(tongueSignal(null, features())).toBeNull()
  })

  it('候选规则数值是数据：改阈值就改结论', () => {
    const strict = { ...OBSERVATION_RULES, adherence: { improvedAt: 0.5, worsenedAt: 0.2 } }
    expect(agentObservation({ practiceDays: 5, adherenceRate: 0.6, currentTongue: null, previousTongue: null }, strict)).toBe('improve')
    expect(agentObservation({ practiceDays: 5, adherenceRate: 0.6, currentTongue: null, previousTongue: null })).toBe('same')
  })
})

describe('V2-10 本地组装：周期、坚持率与舌象', () => {
  it('学生端按本机作业/打卡算这段时间的坚持率与天数，再取周期前后的舌象', async () => {
    const store = await makeStore()
    await store.put('settings', 'joined-at', '2026-10-01T00:00:00.000Z')
    await store.put('homework', 'hw-synthetic', { homework: { id: 'hw-synthetic', title: '合成作业', detail: '', schedule: { kind: 'daily', time: '08:00' }, source: 'teacher' }, startsOn: '2026-10-15' })
    for (const day of ['15', '16', '17', '18']) await checkIn(store, 'hw-synthetic', undefined, new Date(`2026-10-${day}T09:00:00.000Z`))
    await store.put('tongue-records', '2026-08-30', tongueRecord({ color: 'pale', coatingThickness: 'thick' }) as unknown as StoreValue)
    await store.put('tongue-records', '2026-10-15', tongueRecord() as unknown as StoreValue)

    const result = await agentObservationFor(store, { teacher: teacher.publicKey, now: NOW })
    expect(result.window.start).toBe('2026-10-01T00:00:00.000Z')
    expect(result.practiceDays).toBe(4)
    expect(result.adherenceRate).toBe(1)
    expect(result.choice).toBe('improve')

    const report = await buildPeriodObservation(store, { teacher: teacher.publicKey, now: NOW })
    expect(Object.keys(report).sort()).toEqual(['adherenceRate', 'agentNote', 'periodEnd', 'periodStart', 'practiceDays'])
    expect(report.agentNote).toBe('improve')
    expect(parsePeriodObservation(report)).toEqual(report)
    // 想塞本人感受进观察元数据：多一个字段就整条不认。
    expect(parsePeriodObservation({ ...report, selfNote: 'worse' })).toBeNull()
  })
})

describe('V2-10 本人感受不上行：检查问诊包与全部出站信封', () => {
  it('问诊包只带计数与智能体那句；本人感受不在包、不在信封、老师端也永远没有', async () => {
    const studentStore = await makeStore()
    await studentStore.put('settings', 'joined-at', '2026-10-01T00:00:00.000Z')
    const self = await recordSelfObservation(studentStore, { student: student.publicKey, teacher: teacher.publicKey, choice: 'worse', now: NOW })
    const report = await buildPeriodObservation(studentStore, { teacher: teacher.publicKey, now: NOW })

    // 学生走确认发送：问诊包 + 一条坚持率小结 + 一条病历备份，都是真实信封构造器。
    const session = markReviewed({ ...startSession({ student: student.publicKey, teacher: teacher.publicKey, template: template as TeacherTemplate, now: new Date('2026-10-18T11:00:00.000Z') }), phase: 'confirm' })
    const pkg = buildConsultPackage(session, emptyProfile(), [], [], undefined, { observation: report })
    const recordEvent = await signRecord({ teacherStore: await makeStore(teacher), at: new Date('2026-10-10T09:00:00.000Z') })
    const envelopes = [
      consultEnvelope(pkg),
      adherenceEnvelope({ weekStart: '2026-10-12', weeklyRate: 1, streak: 4, practiceDays: 4, scheduled: 4, done: 4 }),
      backupEnvelope(recordEvent),
    ]
    const dump = JSON.stringify(envelopes)
    expect(dump).not.toContain('kangbi-self')
    expect(dump).not.toContain(self.id)
    expect(dump).not.toContain('selfNote')
    expect(dump).not.toContain('"self"')
    expect(dump).not.toContain('worse')
    // 观察元数据里只有智能体那一句，没有本人感受字段。
    const payload = envelopes[0].payload as unknown as { observation: Record<string, unknown> }
    expect(Object.keys(payload.observation).sort()).toEqual(['adherenceRate', 'agentNote', 'periodEnd', 'periodStart', 'practiceDays'])

    // 老师端收下问诊包后写观察记录：本人感受仍然拿不到。
    const teacherStore = await makeStore(teacher)
    await teacherStore.put('settings', 'role', { role: 'teacher' })
    const inbox = createInbox({ identity: teacher, store: teacherStore, send: async () => '' })
    await inbox.receive({ id: crypto.randomUUID(), at: Math.floor(NOW.getTime() / 1000), sender: student.publicKey, envelope: consultEnvelope(pkg) })
    const stored = (await teacherStore.list('consult-package'))[0].value as unknown as { observation: typeof report }
    expect(Object.keys(stored.observation).sort()).toEqual(['adherenceRate', 'agentNote', 'periodEnd', 'periodStart', 'practiceDays'])
    const teacherRecord = await recordSignedObservation(teacherStore, {
      id: 'synthetic-signed', student: student.publicKey, teacher: teacher.publicKey, at: NOW,
      teacherMinutes: 10, consultations: 1, teacherNote: 'same', report: stored.observation,
    })
    expect(teacherRecord.agentNote).toBe('unsure')
    expect(await teacherStore.list(SELF_OBSERVATIONS)).toEqual([])
    const teacherDump = JSON.stringify(await Promise.all(['kangbi-observations', 'consult-package', SELF_OBSERVATIONS].map(collection => teacherStore.list(collection))))
    expect(teacherDump).not.toContain(self.id)
    expect(teacherDump).not.toContain('worse')
  })

  it('出站模块源码里没有本人感受集合，界面也没有康币余额与影子试算入口', () => {
    const outbound = ['../inbox/index.ts', '../transport/index.ts', '../wiring/index.ts', '../records/backup.ts', '../reidentify/messages.ts', '../careplan/index.ts']
    for (const file of outbound) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(text).not.toContain('kangbi-self')
      expect(text).not.toContain('SELF_OBSERVATIONS')
    }
    const uiDirectory = new URL('../../../', import.meta.url)
    const pages = readdirSync(uiDirectory).filter(name => name.endsWith('.tsx'))
    for (const page of pages) {
      const text = readFileSync(new URL(page, uiDirectory), 'utf8')
      expect(text).not.toContain('康币')
      expect(text).not.toContain('shadowRun')
      expect(text).not.toContain('kangbiSummary')
    }
  })
})

describe('V2-10 shadowRun 影子试算（只读、无界面入口）', () => {
  const studentKey = (index: number) => String(index).padStart(2, '0').repeat(32)
  const make = (name: string, practiceDays: number, teacherEffect: number, measurementEffect: number, index: number): HealthObservation => ({
    id: name, student: studentKey(index), teacher: teacher.publicKey, at: NOW.toISOString(),
    periodStart: '2026-10-10T09:00:00.000Z', periodEnd: NOW.toISOString(),
    practiceDays, teacherMinutes: 30, consultations: 1, teacherNote: 'improve', agentNote: 'unsure',
    effects: { teacher: teacherEffect, measurement: measurementEffect },
  })
  const observations = [
    make('student-1', 5, 1, 1, 1),
    make('student-2', 10, 1, 0.5, 2),
    make('student-3', 4, -1, -0.5, 3),
  ]
  const candidateA: KangbiRules = { weights: { teacher: 0.5, measurement: 0.5 }, kePerPracticeDay: 2, declinePerUnit: 1, kePerConsultation: 1, minutesPerKe: 15, dailyCap: 100 }
  const candidateB: KangbiRules = { ...candidateA, kePerPracticeDay: 4, declinePerUnit: 2 }

  it('两套候选数值给出不同的分布与总量；输入被冻结也照常只读', () => {
    const frozen = observations.map(item => Object.freeze({ ...item, effects: Object.freeze({ ...item.effects }) }))
    const a = shadowRun(frozen, candidateA)
    const b = shadowRun(frozen, candidateB)
    expect(a.perStudent.map(row => row.student)).toEqual([...a.perStudent.map(row => row.student)].sort())
    expect(a.perStudent[0].create).toBe(5 * 2 * 1)
    expect(b.perStudent[0].create).toBe(5 * 4 * 1)
    expect(a.totals.create).not.toBe(b.totals.create)
    expect(a.distribution).not.toEqual(b.distribution)
    expect(a.totals.net).toBe(a.perStudent.reduce((sum, row) => sum + row.net, 0))
    // 每人多少刻：净改善的学生在分布里，变差的学生 net 为负。
    expect(a.distribution.max).toBeGreaterThan(0)
    expect(a.distribution.min).toBeLessThan(0)
    expect(a.distribution.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(a.perStudent.length)
    expect(observations[0]).not.toHaveProperty('net')
  })

  it('生产规则全 null：一条都不算，不能把 null 当零', () => {
    const production = shadowRun(observations, rules as unknown as KangbiRules)
    expect(production.skipped).toBe(observations.length)
    expect(production.perStudent).toEqual([])
    expect(production.totals).toEqual({ create: 0, flow: 0, decline: 0, net: 0 })
    expect(production.distribution.buckets).toEqual([])
  })

  it('观察记录与汇总都不再有本人感受这一项', async () => {
    const store = await makeStore()
    await recordObservation(store, { ...make('only-one', 3, 1, 1, 9), effects: { teacher: null, measurement: null } })
    const rows = await listObservations(store)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0].effects).sort()).toEqual(['measurement', 'teacher'])
    expect(OBSERVATION_CHOICES.map(choice => choice.value)).toEqual(['improve', 'same', 'worse', 'unsure'])
    const summary = await kangbiSummary(store)
    expect(Object.keys(summary.ratings).sort()).toEqual(['measurement', 'teacher'])
  })
})
