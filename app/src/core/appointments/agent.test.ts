import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type StoreValue } from '../store'
import { defaultSchedule } from '../hall/groundwork'
import { signEncounter } from '../record/sign'
import { startInPersonEncounter } from '../record/in-person'
import { saveTeacherRecord } from '../records/teacher'
import { createAppointmentInbox, listAppointments, sendAppointmentOffer } from './index'
import { confirmDailyAppointmentInvitations, planAppointmentInvitations, processAppointmentCampaigns, runDailyAppointmentInvitations, type InviteMaterials } from './agent'

const now = new Date('2026-10-25T12:00:00Z')
function materials(patch: Partial<InviteMaterials> = {}): InviteMaterials {
  const schedule = defaultSchedule(); schedule.timezone = 'Asia/Shanghai'
  return { now: now.toISOString(), timezone: 'Asia/Shanghai', city: '上海市', afterDays: 14, schedule, scheduleEnabled: true, visits: [], appointments: [], ...patch }
}

async function addSignedVisit(store: Awaited<ReturnType<typeof openStore>>, teacher: ReturnType<typeof createIdentity>, student: string, at: Date, alias: string) {
  const encounter = startInPersonEncounter({ teacher: teacher.publicKey, student, now: at })
  encounter.profile.alias = { value: alias, source: 'teacher' }
  await saveTeacherRecord(store, signEncounter(encounter, teacher.privateKey))
}

describe('老师智能体预约邀约', () => {
  it('V2-36 已请出的学生即使留有签字病历也不进入新邀约草稿', async () => {
    const teacher = createIdentity(), student = createIdentity(), store = await openStore(teacher, { factory: new IDBFactory() })
    try {
      const schedule = defaultSchedule(); schedule.timezone = 'Asia/Shanghai'
      await store.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: ['schedule'] } as unknown as StoreValue)
      await addSignedVisit(store, teacher, student.publicKey, new Date(+now - 30 * 86_400_000), '合成学生')
      await store.put('teacher-roster-leaves', student.publicKey, { student: student.publicKey, at: now.toISOString(), day: '2026-10-25' })
      await store.delete('teacher-students', student.publicKey)
      const run = await runDailyAppointmentInvitations(store, teacher, undefined, now)
      expect(run.output.candidates).toEqual([])
    } finally { store.close() }
  })
  it('未设排班不产生邀约；只设排班后维持过目模式', async () => {
    expect(planAppointmentInvitations(materials({ scheduleEnabled: false, visits: [{ student: 'a'.repeat(64), alias: '合成学生', at: '2026-09-01T12:00:00Z' }] })).slot).toBeNull()
    const teacher = createIdentity(), store = await openStore(teacher, { factory: new IDBFactory() })
    await store.put('settings', 'role', { role: 'teacher' })
    try {
      const empty = await runDailyAppointmentInvitations(store, teacher, undefined, now)
      expect((empty.output as any).slot).toBeNull()
      const schedule = defaultSchedule(); schedule.timezone = 'Asia/Shanghai'
      await store.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: ['schedule'] } as unknown as StoreValue)
      const ready = await runDailyAppointmentInvitations(store, teacher, undefined, new Date(+now + 86_400_000))
      expect(ready.status).toBe('draft')
      expect((ready.output as any).slot).not.toBeNull()
    } finally { store.close() }
  })
  it('只挑满 14 天、无未来预约、24 小时内没被邀约的人，优先最久未到', () => {
    const older = 'a'.repeat(64), exact = 'b'.repeat(64), recent = 'c'.repeat(64), booked = 'd'.repeat(64)
    const result = planAppointmentInvitations(materials({
      visits: [
        { student: exact, alias: '小青', at: '2026-10-11T12:00:00Z' },
        { student: older, alias: '小禾', at: '2026-09-01T12:00:00Z' },
        { student: recent, alias: '小安', at: '2026-10-12T12:01:00Z' },
        { student: booked, alias: '小河', at: '2026-09-01T00:00:00Z' },
      ],
      appointments: [
        { student: recent, status: 'declined', createdAt: '2026-10-24T13:00:00Z', slotStart: '2026-10-26T09:00:00+08:00' },
        { student: booked, status: 'confirmed', createdAt: '2026-10-20T00:00:00Z', slotStart: '2026-10-27T09:00:00+08:00' },
      ] as InviteMaterials['appointments'],
    }))
    expect(result.candidates).toEqual([
      { student: older, alias: '小禾', lastVisit: '2026-09-01T12:00:00Z' },
      { student: exact, alias: '小青', lastVisit: '2026-10-11T12:00:00Z' },
    ])
    expect(result.slot?.timezone).toBe('Asia/Shanghai')
  })

  it('自动邀约候选只包含同城学生；城市缺失按同城处理', () => {
    const local = 'a'.repeat(64), remote = 'b'.repeat(64), unknown = 'c'.repeat(64)
    const result = planAppointmentInvitations(materials({ visits: [
      { student: local, alias: '同城学生', at: '2026-09-01T12:00:00Z', city: '上海市' },
      { student: remote, alias: '异地学生', at: '2026-09-01T12:00:00Z', city: '旧金山' },
      { student: unknown, alias: '未填城市', at: '2026-09-01T12:00:00Z', city: null },
    ] }))
    expect(result.candidates.map(row => row.student)).toEqual([local, unknown])
  })

  it('中继未连接时仍能在复核模式准备本地草稿', async () => {
    const teacher = createIdentity(), store = await openStore(teacher, { factory: new IDBFactory() })
    const schedule = defaultSchedule()
    await store.put('settings', 'role', { role: 'teacher' })
    await store.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: ['schedule'] } as unknown as StoreValue)
    try {
      const run = await runDailyAppointmentInvitations(store, teacher, undefined, now)
      expect(run.status).toBe('draft')
      expect(run.output).toMatchObject({ candidates: [], slot: expect.anything() })
    } finally { store.close() }
  })

  it('review 只生成草稿；老师一键后发给容量上限加一位，过期后续给下一位', async () => {
    const teacher = createIdentity(), store = await openStore(teacher, { factory: new IDBFactory() })
    const schedule = defaultSchedule(); schedule.timezone = 'Asia/Shanghai'; schedule.capacity = 3
    await store.put('settings', 'role', { role: 'teacher' })
    await store.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: ['schedule'] } as unknown as StoreValue)
    const students = Array.from({ length: 5 }, (_, i) => ({ key: String.fromCharCode(97 + i).repeat(64), name: `合成学生${i + 1}` }))
    for (const [index, student] of students.entries()) await addSignedVisit(store, teacher, student.key, new Date(+now - (30 + index) * 86_400_000), student.name)
    const send = vi.fn(async (_recipient: string, _payload: unknown) => {})
    try {
      const draft = await runDailyAppointmentInvitations(store, teacher, send, now)
      expect(draft.status).toBe('draft')
      expect(send).not.toHaveBeenCalled()
      expect((draft.output as any).candidates).toHaveLength(5)
      const delivered = await confirmDailyAppointmentInvitations(store, teacher, send, draft.key, new Date(+now + 60_000))
      expect(delivered.status).toBe('delivered')
      expect(send).toHaveBeenCalledTimes(4)
      const expired = await processAppointmentCampaigns(store, teacher, send, new Date(+now + 2 * 60 * 60_000 + 61_000))
      expect(expired).toBe(1)
      expect(send).toHaveBeenCalledTimes(9) // 4 expired notices, then the fifth student's offer
      expect((await store.list('appointments')).filter(row => (row.value as any).status === 'offered')).toHaveLength(1)
    } finally { store.close() }
  })

  it('同一时段第四位接受后收到约满通知，并由同一活动给出下一个可约时段', async () => {
    const teacher = createIdentity(), teacherStore = await openStore(teacher, { factory: new IDBFactory() })
    const schedule = defaultSchedule(); schedule.timezone = 'Asia/Shanghai'; schedule.capacity = 3
    await teacherStore.put('settings', 'role', { role: 'teacher' })
    await teacherStore.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: ['schedule'] } as unknown as StoreValue)
    const campaignId = 'overflow-campaign'
    const slot = { slotStart: '2026-10-26T09:00:00+08:00', minutes: 30, timezone: 'Asia/Shanghai', capacity: 3 }
    await teacherStore.put('appointment-campaigns', campaignId, { id: campaignId, slot, candidates: [], cursor: 0, createdAt: now.toISOString() } as unknown as StoreValue)
    const students = await Promise.all(Array.from({ length: 4 }, async () => {
      const identity = createIdentity(), store = await openStore(identity, { factory: new IDBFactory() })
      await teacherStore.put('teacher-students', identity.publicKey, { student: identity.publicKey })
      await store.put('settings', 'role', { role: 'student' }); await store.put('settings', 'teachers', [teacher.publicKey])
      return { identity, store }
    }))
    const sent: { recipient: string; type: string; payload: any }[] = []
    const inbox = createAppointmentInbox({ identity: teacher, store: teacherStore, now: () => now, send: async (recipient, envelope) => { sent.push({ recipient, ...envelope }) } })
    try {
      const offers = []
      for (const item of students) offers.push(await sendAppointmentOffer({ store: teacherStore, identity: teacher, student: item.identity.publicKey, slot, campaignId, now,
        send: async (recipient, envelope) => { sent.push({ recipient, ...envelope }) } }))
      for (const [index, item] of students.entries()) await inbox.receive({ id: `reply-${index}`, sender: item.identity.publicKey,
        at: Math.floor(+now / 1000) + 60, envelope: { type: 'appointment.reply', version: 1, payload: { offerId: offers[index].offerId, response: 'accept' } } })
      const before = await listAppointments(teacherStore)
      const overflow = before.find(row => row.status === 'cancelled' && row.reason === 'slot_full')!
      expect(before.filter(row => row.status === 'confirmed')).toHaveLength(3)
      expect(sent.some(row => row.recipient === overflow.student && row.type === 'appointment.cancel' && row.payload.reason === 'slot_full')).toBe(true)

      await processAppointmentCampaigns(teacherStore, teacher, async (recipient, envelope) => { sent.push({ recipient, ...envelope }) }, new Date(+now + 2 * 60_000))
      const replacement = (await listAppointments(teacherStore)).find(row => row.replacementFor === overflow.offerId)
      expect(replacement).toMatchObject({ student: overflow.student, campaignId, status: 'offered' })
      expect(replacement?.slotStart).not.toBe(slot.slotStart)
      expect(sent.some(row => row.recipient === overflow.student && row.type === 'appointment.offer' && row.payload.slotStart === replacement?.slotStart)).toBe(true)
    } finally { teacherStore.close(); for (const item of students) item.store.close() }
  }, 20000)
})
