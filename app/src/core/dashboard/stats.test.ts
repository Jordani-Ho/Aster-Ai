import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity, type Identity } from '../identity'
import { openStore, type LocalStore } from '../store'
import { startInPersonEncounter } from '../record/in-person'
import { tongueSvg } from '../../../../domain/tcm/tongue'
import { rememberTeacherStudent } from '../records/teacher'
import { recordError } from './errors'
import {
  buildDailyStats, HALL_ID_SETTING, loadStatsShare, saveStatsShare, sendDailyStats, SHARE_SETTING,
} from './stats'
import { startStatsSession } from './session'
import type { Envelope } from '../transport/crypto'
import { statsEnvelope } from './types'

// V2-14：全部合成身份、合成病历、fake-indexeddb；不连中继、不读学生本人感受。
const NOW = new Date('2026-10-20T12:00:00.000Z')
const TODAY = '2026-10-20'
const YESTERDAY = '2026-10-19'
const HALL = 'a'.repeat(16)
const closers: LocalStore[] = []

async function session(): Promise<{ identity: Identity; store: LocalStore }> {
  const identity = createIdentity()
  const store = await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
  closers.push(store)
  return { identity, store }
}
afterEach(() => { vi.useRealTimers(); while (closers.length) closers.pop()!.close() })

function tongueRecord() {
  const features = { color: 'pink' as const, coatingColor: 'white' as const, coatingThickness: 'thin' as const, shape: 'standard' as const, teeth: [] as string[], cracks: [] as string[], confidence: 0.8 }
  return { kind: 'tongue' as const, features, svg: tongueSvg(features), shichen: '辰', jieqi: '霜降', city: '合成城市秘密' }
}

async function seed(store: LocalStore, teacher: Identity, student: Identity, receivedAt: Date, id: string) {
  const encounter = startInPersonEncounter({ teacher: teacher.publicKey, student: student.publicKey, id, now: receivedAt })
  encounter.kind = 'remote_async'
  encounter.intake.chiefComplaint = { value: '主诉秘密内容', source: 'student' }
  encounter.intake.tongues = [tongueRecord()]
  const consult = {
    encounter,
    history: [],
    attachments: [],
    receivedAt: receivedAt.toISOString(),
    sender: student.publicKey,
    droppedHistory: 0,
    trend: { days: [TODAY, YESTERDAY], checkins: [3, 1], scores: [4, null], stress: [2, null] },
  }
  await store.put('consult-package', encounter.id, consult as never)
  return { ...consult, encounter }
}

describe('一天一行的统计', () => {
  it('只数本机集合的条数/次数；不含病历内容、舌象内容、公钥、名字、城市', async () => {
    const { identity: teacher, store } = await session()
    const student = createIdentity()
    const consult = await seed(store, teacher, student, new Date('2026-10-20T08:00:00Z'), 'a'.repeat(32))
    await seed(store, teacher, student, new Date('2026-10-19T08:00:00Z'), 'b'.repeat(32))
    // 签字记录：同一天、15 分钟后；统计只读 encounterId/createdAt，不读 eventJson。
    await store.put('teacher-records', 'signed-1', {
      eventId: 'c'.repeat(64), encounterId: consult.encounter.id, version: 1, student: student.publicKey,
      createdAt: '2026-10-20T08:15:00.000Z', eventJson: '{"秘密":"病历内容"}',
    } as never)
    await store.put('teacher-records', 'signed-old', {
      eventId: 'd'.repeat(64), encounterId: 'x', version: 1, student: student.publicKey,
      createdAt: '2026-10-19T08:15:00.000Z', eventJson: '{}',
    } as never)
    await rememberTeacherStudent(store, student.publicKey)
    await rememberTeacherStudent(store, 'b'.repeat(64))
    // 学生本人感受、钱账、门面等秘密数据：统计绝不能读/带出去。
    await store.put('kangbi-self', 'self-1', { choice: 'improve', note: '本人感受秘密' } as never)
    await store.put('ledger-index', 'ledger-1', { teacher: teacher.publicKey, student: student.publicKey, collection: 'ledger-x', key: 'k' } as never)
    await store.put('settings', 'storefront', { current: { content: '馆名秘密' }, previous: null } as never)
    await recordError(store, 'uncaughtError', NOW)

    const stats = await buildDailyStats(store, { now: NOW, hallId: HALL, onlineSeconds: 123 })
    expect(stats).toMatchObject({
      version: 1, hallId: HALL, date: TODAY, onlineSeconds: 123,
      errorCounts: { uncaughtError: 1, unhandledRejection: 0 },
      consults: 1, signatures: 1, avgSignMinutes: 15, homeworkCheckins: 3, tongueRecords: 1, students: 2,
    })
    expect(stats.appVersion).toMatch(/^\d+\.\d+\.\d+$/)

    const text = JSON.stringify(stats)
    for (const secret of ['主诉秘密内容', '舌象秘密', '合成城市秘密', '本人感受秘密', '馆名秘密', '病历内容', teacher.publicKey, student.publicKey, consult.encounter.id]) {
      expect(text).not.toContain(secret)
    }
    expect(text).not.toMatch(/[0-9a-f]{64}/)
    const envelopeText = JSON.stringify(statsEnvelope(stats))
    for (const secret of ['主诉秘密内容', '舌象秘密', '合成城市秘密', '本人感受秘密', '病历内容', teacher.publicKey, student.publicKey, consult.encounter.id]) {
      expect(envelopeText).not.toContain(secret)
    }
    expect(envelopeText).not.toMatch(/[0-9a-f]{64}/)
    expect(Object.keys(stats).sort()).toEqual([
      'appVersion', 'avgSignMinutes', 'consults', 'date', 'errorCounts', 'hallId', 'homeworkCheckins',
      'onlineSeconds', 'signatures', 'students', 'tongueRecords', 'version',
    ])
  })

  it('没有签字/没有趋势数据时留空，不编 0', async () => {
    const { identity: teacher, store } = await session()
    const student = createIdentity()
    const consult = await seed(store, teacher, student, new Date('2026-10-20T08:00:00Z'), 'c'.repeat(32))
    consult.trend = null as never
    await store.put('consult-package', consult.encounter.id, consult as never)
    const stats = await buildDailyStats(store, { now: NOW, hallId: HALL, onlineSeconds: 0 })
    expect(stats.avgSignMinutes).toBeNull()
    expect(stats.homeworkCheckins).toBeNull()
  })
})

describe('发送开关与一天一次', () => {
  it('默认开；同一天只发一次；关掉后第二天也不发', async () => {
    const { store } = await session()
    expect(await loadStatsShare(store)).toBe(true)
    const sent: { recipient: string; envelope: Envelope }[] = []
    const send = async (recipient: string, envelope: Envelope) => { sent.push({ recipient, envelope }); return 'ok' }
    const pubkey = 'e'.repeat(64), url = 'https://synthetic.invalid/#dashboard'
    const first = await sendDailyStats({ store, send, dashboardPubkey: pubkey, dashboardUrl: url, now: NOW })
    expect(first.sent).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].recipient).toBe(pubkey)
    expect(sent[0].envelope.type).toBe('community.stats')
    expect(sent[0].envelope.version).toBe(1)
    const second = await sendDailyStats({ store, send, dashboardPubkey: pubkey, dashboardUrl: url, now: NOW })
    expect(second).toMatchObject({ sent: false, reason: 'already-sent' })
    expect(sent).toHaveLength(1)

    await saveStatsShare(store, false)
    expect(await store.get('settings', SHARE_SETTING)).toEqual({ enabled: false })
    const tomorrow = new Date('2026-10-21T12:00:00.000Z')
    const off = await sendDailyStats({ store, send, dashboardPubkey: pubkey, dashboardUrl: url, now: tomorrow })
    expect(off).toMatchObject({ sent: false, reason: 'disabled' })
    expect(sent).toHaveLength(1)
  })

  it('仪表盘公钥或地址留空就什么都不发', async () => {
    const { store } = await session()
    const sent: unknown[] = []
    const send = async (...args: unknown[]) => { sent.push(args); return 'ok' }
    expect(await sendDailyStats({ store, send, dashboardPubkey: '', dashboardUrl: '', now: NOW })).toMatchObject({ sent: false, reason: 'no-dashboard' })
    expect(await sendDailyStats({ store, send, dashboardPubkey: 'e'.repeat(64), dashboardUrl: '', now: NOW })).toMatchObject({ sent: false, reason: 'no-dashboard' })
    expect(sent).toHaveLength(0)
  })

  it('本馆 ID 稳定且不会换成公钥', async () => {
    const { store } = await session()
    const first = await buildDailyStats(store, { now: NOW, onlineSeconds: 0 })
    const second = await buildDailyStats(store, { now: NOW, onlineSeconds: 0 })
    expect(first.hallId).toMatch(/^[0-9a-f]{16}$/)
    expect(second.hallId).toBe(first.hallId)
    expect(await store.get('settings', HALL_ID_SETTING)).toBe(first.hallId)
  })
})

describe('在线时长会话', () => {
  it('当天累计；跨天重新开始', async () => {
    const { store } = await session()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))
    const sessionState = await startStatsSession(store)
    vi.setSystemTime(new Date('2026-10-20T10:00:10Z'))
    expect(await buildDailyStats(store, { now: new Date(), hallId: HALL })).toMatchObject({ onlineSeconds: 10 })
    await sessionState.tick()
    vi.setSystemTime(new Date('2026-10-20T10:00:20Z'))
    expect(await buildDailyStats(store, { now: new Date(), hallId: HALL })).toMatchObject({ onlineSeconds: 20 })
    vi.setSystemTime(new Date('2026-10-21T12:00:05Z'))
    expect(await buildDailyStats(store, { now: new Date(), hallId: HALL })).toMatchObject({ onlineSeconds: 0, date: '2026-10-21' })
  })
})
