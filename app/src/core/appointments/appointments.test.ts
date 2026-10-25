import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type StoreValue } from '../store'
import { defaultSchedule, type Schedule } from '../hall/groundwork'
import { appointmentsAffectedBySchedule, createAppointmentInbox, listAppointments, markAppointmentAttendance, replyToAppointment, sendAppointmentOffer, type AppointmentMessage } from './index'

const now = new Date('2026-10-25T12:00:00Z')
const slot = { slotStart: '2026-10-26T09:00:00+08:00', minutes: 30, timezone: 'Asia/Shanghai', capacity: 3 }
const message = (sender: string, type: string, payload: unknown, at = Math.floor(+now / 1000)): AppointmentMessage => ({
  id: crypto.randomUUID(), sender, at, envelope: { type, version: 1, payload },
})

async function pair() {
  const teacher = createIdentity(), student = createIdentity()
  const teacherStore = await openStore(teacher, { factory: new IDBFactory() })
  const studentStore = await openStore(student, { factory: new IDBFactory() })
  await teacherStore.put('settings', 'role', { role: 'teacher' })
  await teacherStore.put('teacher-students', student.publicKey, { student: student.publicKey })
  const schedule = defaultSchedule()
  schedule.timezone = 'Asia/Shanghai'
  await teacherStore.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: [] } as unknown as StoreValue)
  await studentStore.put('settings', 'role', { role: 'student' })
  await studentStore.put('settings', 'teachers', [teacher.publicKey])
  return { teacher, student, teacherStore, studentStore }
}

describe('预约信封和状态机', () => {
  it('两端经问诊收件箱完成邀约、接受、确认；重复消息不重复计数', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const studentInbox = createAppointmentInbox({ identity: student, store: studentStore, now: () => now })
    const teacherInbox = createAppointmentInbox({ identity: teacher, store: teacherStore, now: () => now, send: async (_recipient, envelope) => { toStudent.push(envelope) } })
    const toStudent: { type: string; version: 1; payload: unknown }[] = []
    const toTeacher: { type: string; version: 1; payload: unknown }[] = []
    try {
      const offer = await sendAppointmentOffer({ store: teacherStore, identity: teacher, student: student.publicKey, slot, now, send: async (_to, value) => { toStudent.push(value) } })
      await studentInbox.receive(message(teacher.publicKey, toStudent[0].type, toStudent[0].payload))
      expect(offer.expiresAt).toBe(+now + 2 * 60 * 60 * 1000)
      expect(await listAppointments(studentStore)).toMatchObject([{ offerId: offer.offerId, status: 'offered', slotStart: slot.slotStart }])
      await replyToAppointment({ store: studentStore, identity: student, offerId: offer.offerId, response: 'accept', now: new Date(+now + 60_000), send: async (_to, value) => { toTeacher.push(value) } })
      await teacherInbox.receive(message(student.publicKey, toTeacher[0].type, toTeacher[0].payload, Math.floor(+now / 1000) + 60))
      await studentInbox.receive(message(teacher.publicKey, toStudent[1].type, toStudent[1].payload, Math.floor(+now / 1000) + 60))
      const teacherRows = await listAppointments(teacherStore)
      expect(teacherRows.find(row => row.offerId === offer.offerId)?.status).toBe('confirmed')
      expect((await listAppointments(studentStore)).find(row => row.offerId === offer.offerId)?.status).toBe('confirmed')
      await teacherInbox.receive(message(student.publicKey, 'appointment.reply', { offerId: offer.offerId, response: 'accept' }))
      expect(toStudent.filter(value => value.type === 'appointment.confirmed')).toHaveLength(1)
    } finally { teacherStore.close(); studentStore.close() }
  }, 20000)

  it('同一时段容量为 3、四人都接受时前三人确认，第四人收到约满取消', async () => {
    const teacher = createIdentity(), teacherStore = await openStore(teacher, { factory: new IDBFactory() })
    await teacherStore.put('settings', 'role', { role: 'teacher' })
    const schedule = defaultSchedule(); schedule.timezone = 'Asia/Shanghai'
    await teacherStore.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: [] } as unknown as StoreValue)
    const students = await Promise.all(Array.from({ length: 4 }, async () => {
      const identity = createIdentity(), store = await openStore(identity, { factory: new IDBFactory() })
      await teacherStore.put('teacher-students', identity.publicKey, { student: identity.publicKey })
      await store.put('settings', 'role', { role: 'student' }); await store.put('settings', 'teachers', [teacher.publicKey])
      return { identity, store }
    }))
    const replies: { student: string; type: string; payload: any }[] = []
    const inbox = createAppointmentInbox({ identity: teacher, store: teacherStore, now: () => now, send: async (recipient, envelope) => { replies.push({ student: recipient, ...envelope }) } })
    try {
      const offers = []
      for (const item of students) offers.push(await sendAppointmentOffer({ store: teacherStore, identity: teacher, student: item.identity.publicKey, slot, now, send: async (_recipient, envelope) => { replies.push({ student: item.identity.publicKey, ...envelope }); return undefined } }))
      await expect(sendAppointmentOffer({ store: teacherStore, identity: teacher, student: students[0].identity.publicKey, slot, now,
        send: async () => {} })).rejects.toThrow('邀约人数已到上限')
      for (const [index, item] of students.entries()) await inbox.receive(message(item.identity.publicKey, 'appointment.reply', { offerId: offers[index].offerId, response: 'accept' }, Math.floor(+now / 1000) + 60))
      const rows = await listAppointments(teacherStore)
      expect(rows.filter(row => row.status === 'confirmed')).toHaveLength(3)
      expect(rows.filter(row => row.status === 'cancelled' && row.reason === 'slot_full')).toHaveLength(1)
      expect(replies.filter(row => row.type === 'appointment.cancel' && row.payload.reason === 'slot_full')).toHaveLength(1)
    } finally { teacherStore.close(); for (const item of students) item.store.close() }
  }, 20000)

  it('拒绝过期、重复、陌生关系、非法信封和非法状态转移', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const inbox = createAppointmentInbox({ identity: teacher, store: teacherStore, now: () => now })
    const sent: unknown[] = []
    try {
      await expect(inbox.receive(message(student.publicKey, 'appointment.reply', { offerId: 'missing', response: 'accept' }))).resolves.toBeUndefined()
      const offer = await sendAppointmentOffer({ store: teacherStore, identity: teacher, student: student.publicKey, slot, now, send: async () => {} })
      const later = new Date(+now + 2 * 60 * 60 * 1000 + 1)
      const late = createAppointmentInbox({ identity: student, store: studentStore, send: async (_to, envelope) => { sent.push(envelope) }, now: () => later })
      await late.receive(message(teacher.publicKey, 'appointment.offer', { offerId: offer.offerId, slotStart: slot.slotStart, minutes: 30, expiresAt: offer.expiresAt, timezone: slot.timezone }, Math.floor(+now / 1000)))
      await expect(replyToAppointment({ store: studentStore, identity: student, offerId: offer.offerId, response: 'accept', now: later, send: async () => {} })).rejects.toThrow()
      await inbox.receive(message(student.publicKey, 'appointment.reply', { offerId: offer.offerId, response: 'accept' }, Math.floor(+later / 1000)))
      expect((await listAppointments(teacherStore)).find(row => row.offerId === offer.offerId)?.status).toBe('expired')
      for (const payload of [null, {}, { offerId: 'x', response: 'yes' }, { offerId: 'x', response: 'accept', extra: true }]) {
        await expect(inbox.receive(message(student.publicKey, 'appointment.reply', payload))).resolves.toBeUndefined()
      }
      const stranger = createIdentity()
      await expect(sendAppointmentOffer({ store: teacherStore, identity: teacher, student: stranger.publicKey, slot, now, send: async () => {} })).rejects.toThrow()
    } finally { teacherStore.close(); studentStore.close() }
  }, 20000)

  it('排班变更前准确列出被移除或超过新容量的已确认预约，不自动改状态', async () => {
    const { teacher, teacherStore, student, studentStore } = await pair()
    const secondStudent = createIdentity()
    await teacherStore.put('teacher-students', secondStudent.publicKey, { student: secondStudent.publicKey } as unknown as StoreValue)
    const base: any = { slotStart: slot.slotStart, minutes: 30, timezone: slot.timezone, capacity: 3, expiresAt: +now + 3_600_000, createdAt: now.toISOString(), status: 'confirmed' }
    await teacherStore.put('appointments', 'booking-one', { ...base, offerId: 'booking-one', student: student.publicKey, teacher: teacher.publicKey })
    await teacherStore.put('appointments', 'booking-two', { ...base, offerId: 'booking-two', student: secondStudent.publicKey, teacher: teacher.publicKey, createdAt: new Date(+now + 1000).toISOString() })
    const changed = defaultSchedule(); changed.timezone = 'Asia/Shanghai'; changed.capacity = 1
    const affectedByCapacity = await appointmentsAffectedBySchedule(teacherStore, changed as Schedule, now)
    expect(affectedByCapacity.map(row => row.offerId)).toEqual(['booking-two'])
    changed.week['1'] = []
    expect((await appointmentsAffectedBySchedule(teacherStore, changed as Schedule, now)).map(row => row.offerId)).toEqual(['booking-one', 'booking-two'])
    expect((await listAppointments(teacherStore)).every(row => row.status === 'confirmed')).toBe(true)
    await expect(markAppointmentAttendance(teacherStore, 'booking-one', 'done')).resolves.toMatchObject({ status: 'done' })
    await expect(markAppointmentAttendance(teacherStore, 'booking-one', 'no_show')).rejects.toThrow()
    teacherStore.close(); studentStore.close()
  })
})
