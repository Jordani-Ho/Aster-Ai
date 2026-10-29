import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type StoreValue } from '../store'
import { defaultSchedule, type Schedule } from '../hall/groundwork'
import { appointmentsAffectedBySchedule, cancelAppointment, cancelOwnAppointment, createAppointmentInbox, listAppointments, markAppointmentAttendance, replyToAppointment, requestAppointment, sendAppointmentOffer, type AppointmentMessage } from './index'
import { emptyProfile, saveProfile } from '../intake/session'
import { DEFAULT_STOREFRONT, makeStorefrontEvent, saveReceivedStorefront } from '../storefront'

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
  await teacherStore.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: ['schedule'] } as unknown as StoreValue)
  await studentStore.put('settings', 'role', { role: 'student' })
  await studentStore.put('settings', 'teachers', [teacher.publicKey])
  return { teacher, student, teacherStore, studentStore }
}

describe('预约信封和状态机', () => {
  it('老师未设排班时不发面诊邀约，学生签名门面也不开放请求时段', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const groundwork = await teacherStore.get('settings', 'hall-groundwork') as Record<string, unknown>
    await teacherStore.put('settings', 'hall-groundwork', { ...groundwork, checked: [] } as StoreValue)
    await saveReceivedStorefront(studentStore, makeStorefrontEvent(teacher, DEFAULT_STOREFRONT, Math.floor(+now / 1000), true, null, null, false), teacher.publicKey)
    try {
      await expect(sendAppointmentOffer({ store: teacherStore, identity: teacher, student: student.publicKey, slot, now, send: async () => {} })).rejects.toThrow('排班')
      await expect(requestAppointment({ store: studentStore, identity: student, teacher: teacher.publicKey, startsAt: [Date.parse(slot.slotStart)], timezone: slot.timezone, now, send: async () => {} })).rejects.toThrow('排班')
    } finally { teacherStore.close(); studentStore.close() }
  })
  it('学生提交 1–3 个偏好时段，老师按可约时段自动确认，并回传城市和时区', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const profile = emptyProfile(); profile.city = { value: '杭州市', source: 'teacher' }
    await saveProfile(teacherStore, profile)
    const toTeacher: { type: string; version: 1; payload: any }[] = []
    const toStudent: { type: string; version: 1; payload: any }[] = []
    const studentInbox = createAppointmentInbox({ identity: student, store: studentStore, now: () => now })
    const teacherInbox = createAppointmentInbox({ identity: teacher, store: teacherStore, now: () => now,
      send: async (_recipient, envelope) => { toStudent.push(envelope) } })
    try {
      const request = await requestAppointment({ store: studentStore, identity: student, teacher: teacher.publicKey,
        startsAt: [Date.parse(slot.slotStart)], timezone: 'America/Los_Angeles', now,
        send: async (_recipient, envelope) => { toTeacher.push(envelope) } })
      expect(request.status).toBe('requested')
      expect(toTeacher[0].type).toBe('appointment.request')
      await teacherInbox.receive(message(student.publicKey, toTeacher[0].type, toTeacher[0].payload))
      expect((await listAppointments(teacherStore)).find(row => row.offerId === request.offerId)).toMatchObject({ status: 'confirmed', teacherCity: '杭州市' })
      expect(toStudent[0]).toMatchObject({ type: 'appointment.confirmed', payload: { teacherCity: '杭州市', timezone: 'Asia/Shanghai' } })
      await studentInbox.receive(message(teacher.publicKey, toStudent[0].type, toStudent[0].payload))
      expect((await listAppointments(studentStore)).find(row => row.offerId === request.offerId)).toMatchObject({ status: 'confirmed', teacherCity: '杭州市', timezone: 'Asia/Shanghai' })
      await expect(requestAppointment({ store: studentStore, identity: student, teacher: teacher.publicKey,
        startsAt: [Date.parse(slot.slotStart)], timezone: 'America/Los_Angeles', now,
        send: async () => {} })).rejects.toThrow('已有待回复邀约、预约请求或未来预约')
      await teacherInbox.receive(message(student.publicKey, toTeacher[0].type, toTeacher[0].payload))
      expect((await listAppointments(teacherStore)).filter(row => row.offerId === request.offerId)).toHaveLength(1)
      await cancelOwnAppointment(studentStore, student, request.offerId, now, async (_recipient, envelope) => { toTeacher.push(envelope) })
      await teacherInbox.receive(message(student.publicKey, toTeacher.at(-1)!.type, toTeacher.at(-1)!.payload))
      expect((await listAppointments(studentStore)).find(row => row.offerId === request.offerId)).toMatchObject({ status: 'cancelled', reason: 'student_city_changed' })
      expect((await listAppointments(teacherStore)).find(row => row.offerId === request.offerId)).toMatchObject({ status: 'cancelled', reason: 'student_city_changed' })
    } finally { teacherStore.close(); studentStore.close() }
  }, 20000)

  it('异地学生不能请求面诊，老师也不能向异地学生手动邀约', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const settingsStore = await openStore(student, { factory: new IDBFactory() })
    const teacherProfile = emptyProfile(); teacherProfile.city = { value: '广州市', source: 'teacher' }
    await saveProfile(teacherStore, teacherProfile)
    const studentProfile = emptyProfile(); studentProfile.city = { value: '旧金山', source: 'student' }
    await saveProfile(studentStore, studentProfile)
    await settingsStore.put('settings', 'role', { role: 'student' })
    await settingsStore.put('settings', 'teachers', [teacher.publicKey])
    await teacherStore.put('teacher-students', student.publicKey, { student: student.publicKey, city: '旧金山', cityUpdatedAt: Math.floor(+now / 1000) })
    await saveReceivedStorefront(settingsStore, makeStorefrontEvent(teacher, DEFAULT_STOREFRONT, Math.floor(+now / 1000), true, null, '广州市'), teacher.publicKey)
    try {
      await expect(requestAppointment({ store: studentStore, settingsStore, identity: student, teacher: teacher.publicKey,
        startsAt: [Date.parse(slot.slotStart)], timezone: slot.timezone, now, send: async () => {} })).rejects.toThrow('所在城市')
      await expect(sendAppointmentOffer({ store: teacherStore, identity: teacher, student: student.publicKey,
        slot, now, send: async () => {} })).rejects.toThrow('所在城市')
      expect(await listAppointments(teacherStore)).toEqual([])
      expect(await listAppointments(studentStore)).toEqual([])
    } finally { teacherStore.close(); studentStore.close(); settingsStore.close() }
  }, 20000)

  it('学生申请排班外时间时收到不可约回复', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const toTeacher: { type: string; payload: any }[] = [], toStudent: { type: string; payload: any }[] = []
    const studentInbox = createAppointmentInbox({ identity: student, store: studentStore, now: () => now })
    const teacherInbox = createAppointmentInbox({ identity: teacher, store: teacherStore, now: () => now,
      send: async (_recipient, envelope) => { toStudent.push(envelope) } })
    try {
      const outside = Date.parse('2026-10-26T13:00:00+08:00')
      const request = await requestAppointment({ store: studentStore, identity: student, teacher: teacher.publicKey,
        startsAt: [outside], timezone: 'America/Los_Angeles', now, send: async (_recipient, envelope) => { toTeacher.push(envelope) } })
      await teacherInbox.receive(message(student.publicKey, toTeacher[0].type, toTeacher[0].payload))
      expect((await listAppointments(teacherStore)).find(row => row.offerId === request.offerId)).toMatchObject({ status: 'cancelled', reason: 'unavailable' })
      await studentInbox.receive(message(teacher.publicKey, toStudent[0].type, toStudent[0].payload))
      expect((await listAppointments(studentStore)).find(row => row.offerId === request.offerId)).toMatchObject({ status: 'cancelled', reason: 'unavailable' })
    } finally { teacherStore.close(); studentStore.close() }
  }, 20000)

  it('学生预约输入校验拒绝过去、过近、超期、重复、超过三个时段和未知老师', async () => {
    const { teacher, student, studentStore, teacherStore } = await pair()
    const valid = Date.parse(slot.slotStart)
    const send = async () => {}
    try {
      for (const startsAt of [
        [+now - 60_000], [+now + 60_000], [+now + 61 * 86_400_000], [valid, valid], [valid, valid + 60_000, valid + 120_000, valid + 180_000],
      ]) await expect(requestAppointment({ store: studentStore, identity: student, teacher: teacher.publicKey, startsAt, now, send })).rejects.toThrow()
      await expect(requestAppointment({ store: studentStore, identity: student, teacher: teacher.publicKey, startsAt: [valid], timezone: 'Invalid/Zone', now, send })).rejects.toThrow()
      await expect(requestAppointment({ store: studentStore, identity: student, teacher: createIdentity().publicKey, startsAt: [valid], now, send })).rejects.toThrow()
      await expect(requestAppointment({ store: teacherStore, identity: teacher, teacher: student.publicKey, startsAt: [valid], now, send })).rejects.toThrow()
      expect(await listAppointments(studentStore)).toEqual([])
    } finally { teacherStore.close(); studentStore.close() }
  }, 20000)

  it('学生申请的时段已满时自动回约满，且拒绝陌生关系与非法请求信封', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const another = [createIdentity(), createIdentity(), createIdentity()]
    for (const [index, identity] of another.entries()) {
      await teacherStore.put('teacher-students', identity.publicKey, { student: identity.publicKey } as unknown as StoreValue)
      await teacherStore.put('appointments', 'occupied-' + index, {
        offerId: 'occupied-' + index, student: identity.publicKey, teacher: teacher.publicKey, slotStart: slot.slotStart,
        minutes: 30, timezone: slot.timezone, capacity: 3, expiresAt: 0, createdAt: now.toISOString(), status: 'confirmed',
      } as unknown as StoreValue)
    }
    const sent: { type: string; payload: any }[] = []
    const inbox = createAppointmentInbox({ identity: teacher, store: teacherStore, now: () => now,
      send: async (_recipient, envelope) => { sent.push(envelope) } })
    const payload = { requestId: 'student-request-full', startsAt: [Date.parse(slot.slotStart)], timezone: 'America/Los_Angeles' }
    try {
      await inbox.receive(message(student.publicKey, 'appointment.request', payload))
      await inbox.receive(message(student.publicKey, 'appointment.request', payload))
      expect((await listAppointments(teacherStore)).find(row => row.offerId === payload.requestId)).toMatchObject({ status: 'cancelled', reason: 'slot_full' })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ type: 'appointment.cancel', payload: { reason: 'slot_full' } })
      await inbox.receive(message(createIdentity().publicKey, 'appointment.request', { ...payload, requestId: 'unrelated-request' }))
      await inbox.receive(message(student.publicKey, 'appointment.request', { ...payload, requestId: 'bad-request', startsAt: [1, 1] }))
      expect(await teacherStore.get('appointments', 'unrelated-request')).toBeUndefined()
      expect(await teacherStore.get('appointments', 'bad-request')).toBeUndefined()
    } finally { teacherStore.close(); studentStore.close() }
  }, 20000)

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
    const schedule = defaultSchedule(); schedule.timezone = 'Asia/Shanghai'; schedule.capacity = 3
    await teacherStore.put('settings', 'hall-groundwork', { schedule, invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', checked: ['schedule'] } as unknown as StoreValue)
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

  it('排班冲突只列当前同城预约', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const local = createIdentity()
    const teacherProfile = emptyProfile(); teacherProfile.city = { value: '广州', source: 'teacher' }
    await saveProfile(teacherStore, teacherProfile)
    await teacherStore.put('teacher-students', student.publicKey, { student: student.publicKey, city: '旧金山' })
    await teacherStore.put('teacher-students', local.publicKey, { student: local.publicKey, city: '广州' })
    const booking = (offerId: string, who: string) => ({ offerId, student: who, teacher: teacher.publicKey, slotStart: slot.slotStart,
      minutes: 30, timezone: slot.timezone, capacity: 3, expiresAt: 0, createdAt: now.toISOString(), status: 'confirmed',
      studentCity: who === student.publicKey ? '旧金山' : '广州', teacherCity: '广州' })
    await teacherStore.put('appointments', 'local-booking', booking('local-booking', local.publicKey) as unknown as StoreValue)
    await teacherStore.put('appointments', 'remote-booking', booking('remote-booking', student.publicKey) as unknown as StoreValue)
    const changed = defaultSchedule(); changed.timezone = 'Asia/Shanghai'; changed.week['1'] = []
    try { expect((await appointmentsAffectedBySchedule(teacherStore, changed as Schedule, now)).map(row => row.offerId)).toEqual(['local-booking']) }
    finally { teacherStore.close(); studentStore.close() }
  })

  it('老师明确取消受排班影响的预约时，先通知学生并保存取消状态', async () => {
    const { teacher, student, teacherStore, studentStore } = await pair()
    const booking = { offerId: 'schedule-change', student: student.publicKey, teacher: teacher.publicKey, slotStart: slot.slotStart,
      minutes: 30, timezone: slot.timezone, capacity: 3, expiresAt: 0, createdAt: now.toISOString(), status: 'confirmed' }
    await teacherStore.put('appointments', booking.offerId, booking as unknown as StoreValue)
    const sent: { type: string; payload: any }[] = []
    try {
      await expect(cancelAppointment(teacherStore, teacher, booking.offerId, 'schedule_changed', now, async () => { throw Error('relay offline') })).rejects.toThrow('relay offline')
      expect((await listAppointments(teacherStore)).find(row => row.offerId === booking.offerId)?.status).toBe('confirmed')
      await cancelAppointment(teacherStore, teacher, booking.offerId, 'schedule_changed', now, async (_recipient, envelope) => { sent.push(envelope) })
      expect(sent).toMatchObject([{ type: 'appointment.cancel', payload: { offerId: booking.offerId, reason: 'schedule_changed' } }])
      expect((await listAppointments(teacherStore)).find(row => row.offerId === booking.offerId)).toMatchObject({ status: 'cancelled', reason: 'schedule_changed' })
      const studentInbox = createAppointmentInbox({ identity: student, store: studentStore, now: () => now })
      await studentStore.put('appointments', booking.offerId, { ...booking, student: student.publicKey } as unknown as StoreValue)
      await studentInbox.receive(message(teacher.publicKey, sent[0].type, sent[0].payload))
      expect((await listAppointments(studentStore)).find(row => row.offerId === booking.offerId)).toMatchObject({ status: 'cancelled', reason: 'schedule_changed' })
    } finally { teacherStore.close(); studentStore.close() }
  }, 20000)
})
