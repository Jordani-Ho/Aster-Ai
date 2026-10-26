import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type StoreValue } from '../store'
import type { Assignment, Checkin } from '../homework'
import type { Appointment } from '../appointments'
import {
  assertNudgeInputs, chooseNudges, listNudges, NUDGE_TEMPLATES, renderNudge, runStudentNudges,
  validateNudgeTemplates, type NudgeEvent, type NudgeInputs,
} from './index'

function assignment(): Assignment {
  return { homework: { id: 'daily-1', title: '伸展练习', detail: '合成示例', schedule: { kind: 'daily', time: '08:00' }, source: 'teacher' }, startsOn: '2026-10-10' }
}
function input(at: Date, patch: Partial<NudgeInputs> = {}): NudgeInputs {
  return { now: at, assignments: [assignment()], checkins: [], mirrorDays: [], mirrorStartDay: null, appointments: [], visits: [], routine: { wake: '07:00', sleep: '23:00' }, revisitDays: null, ...patch }
}
function log(at: Date, stage: NudgeEvent['stage'], patch: Partial<NudgeEvent> = {}): NudgeEvent {
  return { id: 'example-' + stage, kind: 'homework', target: 'daily-1', episode: '2026-10-25', stage, at: at.toISOString(), text: '合成提醒', actedAt: null, ...patch }
}
function offer(now: Date): Appointment {
  return { offerId: 'offer-1', student: 'a'.repeat(64), teacher: 'b'.repeat(64), slotStart: new Date(+now + 86_400_000).toISOString(), minutes: 30,
    timezone: 'Asia/Shanghai', capacity: 3, expiresAt: +now + 30 * 60_000, createdAt: now.toISOString(), status: 'offered' }
}

describe('V2-27 固定话术与真实输入', () => {
  it('禁用词出现在话术里就失败；标题含禁用词或数字缺失则整句不发', () => {
    expect(() => validateNudgeTemplates({ ...NUDGE_TEMPLATES, 'homework.first': '糖尿病会有严重后果' })).toThrow('禁用词')
    expect(renderNudge({ kind: 'homework', target: 'x', episode: '2026-10-25', stage: 'first', slots: { title: '合成练习' } })).toContain('合成练习')
    expect(renderNudge({ kind: 'homework', target: 'x', episode: '2026-10-25', stage: 'first', slots: { title: '糖尿病练习' } })).toBeNull()
    expect(renderNudge({ kind: 'appointment', target: 'x', episode: 'x', stage: 'urgent', slots: {} })).toBeNull()
  })

  it('输入校验拒绝坏作息、坏日期、伪造的邀约剩余时间和病历时间', () => {
    const now = new Date(2026, 9, 25, 8, 11)
    expect(() => assertNudgeInputs(input(now, { routine: { wake: '07:00', sleep: '25:00' } }))).toThrow('材料')
    expect(() => assertNudgeInputs(input(now, { mirrorDays: ['2026-02-30'] }))).toThrow('材料')
    expect(() => assertNudgeInputs(input(now, { assignments: [{ ...assignment(), homework: { ...assignment().homework, schedule: { kind: 'daily', time: '25:00' } } }] }))).toThrow('作业材料')
    expect(() => assertNudgeInputs(input(now, { appointments: [{ ...offer(now), expiresAt: Number.NaN }] }))).toThrow('材料')
    expect(() => assertNudgeInputs(input(now, { appointments: [{ ...offer(now), slotStart: '坏时刻' }] }))).toThrow('材料')
    expect(() => assertNudgeInputs(input(now, { visits: [{ id: 'x', at: '昨天', kind: 'in_person', next: null }] }))).toThrow('材料')
  })

  it('8 点作业：8 点多温和提醒、当天再催、次日起每天摆出真实坚持数据', () => {
    const firstAt = new Date(2026, 9, 25, 8, 11)
    const priorCheckins: Checkin[] = []
    expect(chooseNudges(input(new Date(2026, 9, 25, 8, 0), { checkins: priorCheckins }), [])).toEqual([])
    const first = chooseNudges(input(firstAt, { checkins: priorCheckins }), [])
    expect(first.find(row => row.kind === 'homework')?.stage).toBe('first')
    const once = [log(firstAt, 'first', { episode: first.find(row => row.kind === 'homework')!.episode })]
    expect(chooseNudges(input(new Date(2026, 9, 25, 10, 0)), once).find(row => row.kind === 'homework')).toBeUndefined()
    expect(chooseNudges(input(new Date(2026, 9, 25, 12, 12)), once).find(row => row.kind === 'homework')).toBeUndefined()
    expect(chooseNudges(input(new Date(2026, 9, 25, 19, 0)), once).find(row => row.kind === 'homework')?.stage).toBe('again')
    const tomorrow = chooseNudges(input(new Date(2026, 9, 26, 8, 11)), once).find(row => row.kind === 'homework')!
    expect(tomorrow.stage).toBe('daily')
    expect(renderNudge(tomorrow)).toMatch(/这周作业 \d+\/\d+，上周 \d+\/\d+/)
  })

  it('老师邀约剩 30 分钟才催回复；已过期不催', () => {
    const now = new Date(2026, 9, 25, 15, 0)
    const appointment = offer(now)
    expect(chooseNudges(input(now, { assignments: [], appointments: [{ ...appointment, expiresAt: +now + 31 * 60_000 }] }), [])).toEqual([])
    const reminder = chooseNudges(input(now, { assignments: [], appointments: [appointment] }), [])
    expect(renderNudge(reminder[0])).toContain('30 分钟')
    expect(chooseNudges(input(new Date(+now + 31 * 60_000), { assignments: [], appointments: [appointment] }), [])).toEqual([])
  })

  it('没有两周坚持数据时只发无数字的话术', () => {
    const now = new Date(2026, 9, 26, 8, 11)
    const one = { ...assignment(), startsOn: '2026-10-25' }
    const prior = [log(new Date(2026, 9, 25, 8, 11), 'first')]
    const next = chooseNudges(input(now, { assignments: [one] }), prior).find(row => row.kind === 'homework')!
    expect(next.stage).toBe('daily')
    expect(next.slots).not.toHaveProperty('lastDone')
    expect(renderNudge(next)).not.toMatch(/\d+\/\d+/)
  })

  it('一次性作业过了两周仍继续提醒，直到打卡', () => {
    const now = new Date(2026, 9, 25, 10, 0)
    const one: Assignment = { homework: { ...assignment().homework, schedule: { kind: 'once', date: '2026-10-01', time: '08:00' } }, startsOn: '2026-10-01' }
    expect(chooseNudges(input(now, { assignments: [one] }), []).find(row => row.kind === 'homework')?.stage).toBe('first')
    expect(chooseNudges(input(now, { assignments: [one], checkins: [{ homeworkId: 'daily-1', at: new Date(2026, 9, 2, 8).toISOString() }] }), [])).toEqual([])
  })

  it('23 点后只提醒睡觉，不发作业、复诊或邀约；同一睡眠段只一次', () => {
    const now = new Date(2026, 9, 25, 23, 2)
    const candidate = chooseNudges(input(now, { appointments: [offer(now)], mirrorDays: ['2026-10-18'] }), [])
    expect(candidate).toEqual([{ kind: 'sleep', target: 'self', episode: '2026-10-25', stage: 'first', slots: {} }])
    expect(chooseNudges(input(new Date(2026, 9, 26, 0, 20)), [log(now, 'first', { kind: 'sleep', target: 'self' })])).toEqual([])
  })

  it('从本人开始使用的本机日期算起，三天未照镜子才提醒；没有日期不编', () => {
    const now = new Date(2026, 9, 25, 9, 1)
    expect(chooseNudges(input(now, { assignments: [], mirrorStartDay: null }), [])).toEqual([])
    expect(chooseNudges(input(now, { assignments: [], mirrorStartDay: '2026-10-23' }), [])).toEqual([])
    expect(chooseNudges(input(now, { assignments: [], mirrorStartDay: '2026-10-22' }), []).some(row => row.kind === 'mirror')).toBe(true)
  })

  it('签字病历明确写复诊天数时按该数；没有明确文字只用老师签名门面的天数', () => {
    const now = new Date(2026, 9, 25, 11, 0)
    const visits = [{ id: 'enc-1', at: new Date(2026, 9, 10, 11).toISOString(), kind: 'remote_live' as const, next: '14天后复诊' }]
    const explicit = chooseNudges(input(now, { assignments: [], visits, revisitDays: 30 }), []).find(row => row.kind === 'revisit')
    expect(explicit?.slots.interval).toBe(14)
    expect(renderNudge(explicit!)).toContain('距上次看诊')
    expect(chooseNudges(input(now, { assignments: [], visits: [{ ...visits[0], next: '以后再看' }], revisitDays: null }), [])).toEqual([])
    expect(chooseNudges(input(now, { assignments: [], visits: [{ ...visits[0], kind: 'in_person', next: null }], revisitDays: 14 }), []).some(row => row.kind === 'revisit')).toBe(true)
  })

  it('本机只记一次提醒，后续真实打卡标成已行动；重复打开不重复推送', async () => {
    const identity = createIdentity(), store = await openStore(identity, { factory: new IDBFactory() })
    await store.put('homework', 'daily-1', assignment() as unknown as StoreValue)
    await store.put('settings', 'agent-routine', { wake: '07:00', sleep: '23:00' })
    const notifySelf = vi.fn(async () => {})
    const at = new Date(2026, 9, 25, 8, 11)
    await runStudentNudges({ store, settingsStore: store, identity, teacher: null, now: at, notifySelf })
    await runStudentNudges({ store, settingsStore: store, identity, teacher: null, now: at, notifySelf })
    expect(await listNudges(store)).toHaveLength(1)
    expect(await store.list('agent-runs')).toHaveLength(0)
    expect(notifySelf).toHaveBeenCalledTimes(1)
    await store.put('checkins', 'check-1', { homeworkId: 'daily-1', at: new Date(2026, 9, 25, 8, 12).toISOString() })
    await runStudentNudges({ store, settingsStore: store, identity, teacher: null, now: new Date(2026, 9, 25, 8, 13), notifySelf })
    expect((await listNudges(store))[0].actedAt).not.toBeNull()
    store.close()
  })
})
