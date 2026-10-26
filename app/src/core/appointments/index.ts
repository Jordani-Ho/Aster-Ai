import type { Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'
import { sendAgentMessage } from '../agent/guard'
import type { Envelope } from '../transport'
import { appointmentSlots, slotStartInZone } from '../schedule/appointments'
import { loadGroundwork, type Schedule } from '../hall/groundwork'
import { loadProfile } from '../intake/session'

export const APPOINTMENTS = 'appointments'
export type AppointmentStatus = 'offered' | 'requested' | 'accepted' | 'confirmed' | 'declined' | 'expired' | 'done' | 'no_show' | 'cancelled'
export type AppointmentReply = 'accept' | 'decline'
export interface Appointment {
  offerId: string
  student: string
  teacher: string
  slotStart: string
  minutes: 15 | 30 | 45 | 60
  timezone: string
  capacity: number
  expiresAt: number
  createdAt: string
  status: AppointmentStatus
  campaignId?: string
  replacementFor?: string
  teacherCity?: string
  reason?: string
}
export interface AppointmentMessage { id: string; sender: string; at: number; envelope: { type: string; version: 1; payload: unknown } }
export type SendAppointmentEnvelope = (recipient: string, envelope: Envelope) => Promise<unknown>
const HEX64 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const OFFSET_SLOT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/
const VALID_MINUTES = [15, 30, 45, 60]
const DAY = 86_400_000
const HOUR = 3_600_000

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function validCity(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value) }
function validZone(value: unknown): value is string {
  if (typeof value !== 'string' || !(value === 'UTC' || /^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/.test(value))) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true } catch { return false }
}
function validSlot(value: unknown): value is string {
  if (typeof value !== 'string' || !OFFSET_SLOT.test(value) || !Number.isFinite(Date.parse(value))) return false
  const localAsUtc = new Date(`${value.slice(0, 19)}Z`)
  return Number.isFinite(+localAsUtc) && localAsUtc.toISOString().slice(0, 19) === value.slice(0, 19)
}
function validMinutes(value: unknown): value is 15 | 30 | 45 | 60 { return Number.isInteger(value) && VALID_MINUTES.includes(value as number) }
function validAppointment(value: unknown): value is Appointment {
  if (!object(value)) return false
  return typeof value.offerId === 'string' && ID.test(value.offerId) && typeof value.student === 'string' && HEX64.test(value.student)
    && typeof value.teacher === 'string' && HEX64.test(value.teacher) && validSlot(value.slotStart) && validMinutes(value.minutes)
    && validZone(value.timezone) && Number.isSafeInteger(value.capacity) && (value.capacity as number) >= 1 && (value.capacity as number) <= 20
    && Number.isSafeInteger(value.expiresAt) && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && ['offered', 'requested', 'accepted', 'confirmed', 'declined', 'expired', 'done', 'no_show', 'cancelled'].includes(String(value.status))
    && (value.campaignId === undefined || (typeof value.campaignId === 'string' && ID.test(value.campaignId)))
    && (value.replacementFor === undefined || (typeof value.replacementFor === 'string' && ID.test(value.replacementFor)))
    && (value.teacherCity === undefined || validCity(value.teacherCity))
    && (value.reason === undefined || (typeof value.reason === 'string' && value.reason.length <= 128))
}
function valueAt(row: { value: unknown }): Appointment | null { return validAppointment(row.value) ? row.value : null }
function envelope(type: string, payload: unknown): Envelope { return { type, version: 1, payload } }
async function teacherCity(store: LocalStore): Promise<string | undefined> {
  const city = (await loadProfile(store)).city.value
  return validCity(city) ? city : undefined
}
function teacherRelation(store: LocalStore, student: string): Promise<boolean> {
  return store.get('teacher-students', student).then(value => object(value) && value.student === student)
}
async function studentRelation(store: LocalStore, teacher: string): Promise<boolean> {
  const teachers = await store.get('settings', 'teachers')
  return Array.isArray(teachers) && teachers.includes(teacher)
}
async function roleIs(store: LocalStore, role: 'teacher' | 'student'): Promise<boolean> {
  const value = await store.get('settings', 'role')
  return object(value) && value.role === role
}
async function guardedSend(store: LocalStore, side: 'teacher' | 'student', offerId: string, recipient: string, payload: Envelope, now: Date, send: SendAppointmentEnvelope): Promise<void> {
  await sendAgentMessage(store, side, `appointment-${offerId}`, recipient, payload, now, async (to, body) => { await send(to, body as Envelope) })
}

export interface CreateAppointmentOfferOptions {
  store: LocalStore; identity: Identity; student: string
  slot: { slotStart: string; minutes: number; timezone: string; capacity: number }
  now?: Date; campaignId?: string; replacementFor?: string; send: SendAppointmentEnvelope
}

/** 保存后发送一条带固定两小时有效期的具体时段邀约。 */
export async function sendAppointmentOffer(options: CreateAppointmentOfferOptions): Promise<Appointment> {
  const { store, identity, student, slot } = options
  const now = options.now ?? new Date()
  if (!HEX64.test(identity.publicKey) || !HEX64.test(student) || !validSlot(slot?.slotStart) || !validMinutes(slot?.minutes)
    || !validZone(slot?.timezone) || !Number.isInteger(slot?.capacity) || slot.capacity < 1 || slot.capacity > 20
    || !(now instanceof Date) || !Number.isFinite(+now) || Date.parse(slot.slotStart) < +now + 2 * HOUR
    || (options.campaignId !== undefined && !ID.test(options.campaignId))) throw new Error('预约邀约输入无效')
  if (!(await teacherRelation(store, student))) throw new Error('不能向没有师生关系的人邀约')
  const prior = (await store.list(APPOINTMENTS)).map(valueAt).filter((row): row is Appointment => !!row)
  let replacement: Appointment | undefined
  if (options.replacementFor !== undefined) {
    replacement = prior.find(row => row.offerId === options.replacementFor)
    if (!replacement || replacement.student !== student || replacement.campaignId !== options.campaignId
      || replacement.status !== 'cancelled' || replacement.reason !== 'slot_full'
      || prior.some(row => row.replacementFor === replacement!.offerId)) throw new Error('替代时段关联无效')
  }
  const groundwork = await loadGroundwork(store)
  if (groundwork.schedule.timezone !== slot.timezone || !exactSlot(groundwork.schedule, slot.slotStart, slot.minutes, now)) throw new Error('这个时段不在老师当前排班内')
  const concurrent = prior.filter(row => row.slotStart === slot.slotStart && ['offered', 'accepted', 'confirmed'].includes(row.status)).length
  if (concurrent >= slot.capacity + 1) throw new Error('这个时段的邀约人数已到上限')
  if (prior.some(row => row.student === student && ['accepted', 'confirmed'].includes(row.status) && Date.parse(row.slotStart) > +now)) throw new Error('这位学生已有未来预约')
  if (prior.some(row => row !== replacement && row.student === student && +now - Date.parse(row.createdAt) < DAY)) throw new Error('这位学生 24 小时内已收到邀约')
  const city = await teacherCity(store)
  const offerId = crypto.randomUUID()
  const appointment: Appointment = {
    offerId, student, teacher: identity.publicKey, slotStart: slot.slotStart, minutes: slot.minutes as Appointment['minutes'],
    timezone: slot.timezone, capacity: slot.capacity, expiresAt: +now + 2 * HOUR, createdAt: now.toISOString(), status: 'offered',
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
    ...(replacement ? { replacementFor: replacement.offerId } : {}),
    ...(city ? { teacherCity: city } : {}),
  }
  await store.put(APPOINTMENTS, offerId, appointment as unknown as StoreValue)
  await guardedSend(store, 'teacher', offerId, student, envelope('appointment.offer', {
    offerId, slotStart: slot.slotStart, minutes: slot.minutes, expiresAt: appointment.expiresAt, timezone: slot.timezone,
    ...(city ? { teacherCity: city } : {}),
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
  }), now, options.send)
  return structuredClone(appointment)
}

export interface ReplyAppointmentOptions { store: LocalStore; identity: Identity; offerId: string; response: AppointmentReply; now?: Date; send: SendAppointmentEnvelope }
export async function replyToAppointment(options: ReplyAppointmentOptions): Promise<Appointment> {
  const { store, identity, offerId, response } = options
  const now = options.now ?? new Date()
  if (!ID.test(offerId) || !['accept', 'decline'].includes(response) || !(now instanceof Date) || !Number.isFinite(+now)) throw new Error('邀约回复无效')
  const current = valueAt({ value: await store.get(APPOINTMENTS, offerId) })
  if (!current || current.student !== identity.publicKey || current.status !== 'offered') throw new Error('这条邀约已不能回复')
  if (current.expiresAt <= +now) {
    const expired = { ...current, status: 'expired' as const }
    await store.put(APPOINTMENTS, offerId, expired as unknown as StoreValue)
    throw new Error('这条邀约已过期')
  }
  if (!(await studentRelation(store, current.teacher))) throw new Error('这位老师不在“我的老师”里')
  const next = { ...current, status: response === 'accept' ? 'accepted' as const : 'declined' as const }
  await store.put(APPOINTMENTS, offerId, next as unknown as StoreValue)
  await guardedSend(store, 'student', offerId, current.teacher, envelope('appointment.reply', { offerId, response }), now, options.send)
  return structuredClone(next)
}

export interface RequestAppointmentOptions {
  store: LocalStore; identity: Identity; teacher: string; startsAt: readonly number[]; timezone?: string; now?: Date; send: SendAppointmentEnvelope
}
/** 学生提交 1–3 个本地时间；老师按自己的排班和剩余容量自动确认一个。 */
export async function requestAppointment(options: RequestAppointmentOptions): Promise<Appointment> {
  const { store, identity, teacher, startsAt } = options
  const now = options.now ?? new Date(), timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  if (!HEX64.test(identity.publicKey) || !HEX64.test(teacher) || !(now instanceof Date) || !Number.isFinite(+now)
    || !validZone(timezone) || !Array.isArray(startsAt) || startsAt.length < 1 || startsAt.length > 3
    || startsAt.some(at => !Number.isSafeInteger(at) || at % 60_000 !== 0 || at < +now + 2 * HOUR || at > +now + 60 * DAY)
    || new Set(startsAt).size !== startsAt.length) throw new Error('预约请求无效：请选 1–3 个两小时后、60 天内的不同时间')
  if (!(await roleIs(store, 'student')) || !(await studentRelation(store, teacher))) throw new Error('这位老师不在“我的老师”里')
  const existing = await listAppointments(store)
  if (existing.some(row => row.student === identity.publicKey && row.teacher === teacher
    && ['offered', 'requested', 'accepted', 'confirmed'].includes(row.status) && Date.parse(row.slotStart) > +now)) throw new Error('您已有待回复邀约、预约请求或未来预约')
  const requestId = crypto.randomUUID()
  const appointment: Appointment = {
    offerId: requestId, student: identity.publicKey, teacher,
    slotStart: slotStartInZone(startsAt[0], timezone), minutes: 30, timezone, capacity: 20,
    expiresAt: 0, createdAt: now.toISOString(), status: 'requested',
  }
  await store.put(APPOINTMENTS, requestId, appointment as unknown as StoreValue)
  await guardedSend(store, 'student', requestId, teacher, envelope('appointment.request', { requestId, startsAt: [...startsAt], timezone }), now, options.send)
  return structuredClone(appointment)
}

export async function listAppointments(store: Pick<LocalStore, 'list'>): Promise<Appointment[]> {
  return (await store.list(APPOINTMENTS)).map(valueAt).filter((row): row is Appointment => !!row)
    .sort((left, right) => Date.parse(left.slotStart) - Date.parse(right.slotStart) || left.offerId.localeCompare(right.offerId))
}

function validOfferPayload(payload: unknown, at: number): boolean {
  if (!object(payload) || Object.keys(payload).some(key => !['offerId', 'slotStart', 'minutes', 'expiresAt', 'timezone', 'campaignId', 'teacherCity'].includes(key))) return false
  return typeof payload.offerId === 'string' && ID.test(payload.offerId) && validSlot(payload.slotStart) && validMinutes(payload.minutes)
    && Number.isSafeInteger(payload.expiresAt) && Math.abs((payload.expiresAt as number) - (at * 1000 + 2 * HOUR)) <= 1000
    && validZone(payload.timezone) && Date.parse(payload.slotStart) >= at * 1000 + 2 * HOUR
    && (payload.campaignId === undefined || (typeof payload.campaignId === 'string' && ID.test(payload.campaignId)))
    && (payload.teacherCity === undefined || validCity(payload.teacherCity))
}
function validReplyPayload(payload: unknown): payload is { offerId: string; response: AppointmentReply } {
  return object(payload) && Object.keys(payload).length === 2 && typeof payload.offerId === 'string' && ID.test(payload.offerId)
    && (payload.response === 'accept' || payload.response === 'decline')
}
function validRequestPayload(payload: unknown, at: number): payload is { requestId: string; startsAt: number[]; timezone: string } {
  if (!object(payload) || Object.keys(payload).some(key => !['requestId', 'startsAt', 'timezone'].includes(key))) return false
  if (typeof payload.requestId !== 'string' || !ID.test(payload.requestId) || !validZone(payload.timezone)
    || !Array.isArray(payload.startsAt) || payload.startsAt.length < 1 || payload.startsAt.length > 3) return false
  const starts = payload.startsAt
  return starts.every(value => Number.isSafeInteger(value) && (value as number) % 60_000 === 0
    && (value as number) >= at * 1000 + 2 * HOUR && (value as number) <= at * 1000 + 60 * DAY)
    && new Set(starts).size === starts.length
}
function exactSlot(schedule: Schedule, slotStart: string, minutes: number, now: Date): boolean {
  const slotTime = Date.parse(slotStart)
  if (!Number.isFinite(slotTime) || slotTime < +now || !validMinutes(minutes)) return false
  const before = new Date(slotTime - 2 * HOUR)
  return appointmentSlots(schedule, { now: before, days: 3 }).some(slot => Date.parse(slot.slotStart) === slotTime && slot.minutes === minutes)
}

async function sendStatus(store: LocalStore, appointment: Appointment, type: 'appointment.confirmed' | 'appointment.cancel', now: Date, send: SendAppointmentEnvelope, reason?: string, taskId?: string): Promise<void> {
  await guardedSend(store, 'teacher', taskId ?? appointment.offerId + (type.endsWith('cancel') ? '-cancel' : '-confirmed'), appointment.student,
    envelope(type, { offerId: appointment.offerId,
      ...(type === 'appointment.confirmed' ? { slotStart: appointment.slotStart, minutes: appointment.minutes, timezone: appointment.timezone } : {}),
      ...(appointment.teacherCity ? { teacherCity: appointment.teacherCity } : {}),
      ...(reason ? { reason } : {}) }), now, send)
}

export async function notifyAppointmentExpired(store: LocalStore, appointment: Appointment, now: Date, send: SendAppointmentEnvelope): Promise<void> {
  await sendStatus(store, appointment, 'appointment.cancel', now, send, 'expired')
}

async function availableCapacity(store: LocalStore, slotStart: string, capacity: number, exceptId?: string): Promise<number> {
  const rows = (await store.list(APPOINTMENTS)).map(valueAt).filter((row): row is Appointment => !!row)
  return capacity - rows.filter(row => row.offerId !== exceptId && row.slotStart === slotStart && ['accepted', 'confirmed'].includes(row.status)).length
}

export interface AppointmentInboxOptions { identity: Identity; store: LocalStore; send?: SendAppointmentEnvelope; now?: () => Date }
export function createAppointmentInbox(options: AppointmentInboxOptions) {
  const now = options.now ?? (() => new Date())
  const store = options.store
  const receiveOffer = async (message: AppointmentMessage) => {
    if (!(await roleIs(store, 'student')) || !(await studentRelation(store, message.sender)) || !validOfferPayload(message.envelope.payload, message.at)) return
    const payload = message.envelope.payload as { offerId: string; slotStart: string; minutes: Appointment['minutes']; expiresAt: number; timezone: string; campaignId?: string; teacherCity?: string }
    const existing = valueAt({ value: await store.get(APPOINTMENTS, payload.offerId) })
    if (existing) return
    const appointment: Appointment = { offerId: payload.offerId, student: options.identity.publicKey, teacher: message.sender, slotStart: payload.slotStart,
      minutes: payload.minutes, timezone: payload.timezone, capacity: 20, expiresAt: payload.expiresAt,
      createdAt: new Date(message.at * 1000).toISOString(), status: payload.expiresAt <= +now() ? 'expired' : 'offered',
      ...(payload.campaignId ? { campaignId: payload.campaignId } : {}), ...(payload.teacherCity ? { teacherCity: payload.teacherCity } : {}) }
    await store.put(APPOINTMENTS, appointment.offerId, appointment as unknown as StoreValue)
  }
  const receiveRequest = async (message: AppointmentMessage) => {
    if (!(await roleIs(store, 'teacher')) || !(await teacherRelation(store, message.sender)) || !validRequestPayload(message.envelope.payload, message.at)) return
    const payload = message.envelope.payload
    if (await store.get(APPOINTMENTS, payload.requestId) !== undefined) return
    const receivedAt = new Date(message.at * 1000)
    const groundwork = await loadGroundwork(store)
    const existing = await listAppointments(store)
    const alreadyBooked = existing.some(row => row.student === message.sender && ['offered', 'requested', 'accepted', 'confirmed'].includes(row.status) && Date.parse(row.slotStart) > +receivedAt)
    const bookings = existing.map(row => ({ slotStart: row.slotStart, status: row.status }))
    const allSlots = appointmentSlots(groundwork.schedule, { now: receivedAt, days: 61 })
    const openSlots = appointmentSlots(groundwork.schedule, { now: receivedAt, days: 61, bookings })
    const selected = alreadyBooked ? undefined : payload.startsAt.map(at => openSlots.find(slot => Date.parse(slot.slotStart) === at))
      .find((slot): slot is NonNullable<typeof slot> => !!slot)
    const scheduled = new Set(allSlots.map(slot => Date.parse(slot.slotStart)))
    const isFull = payload.startsAt.some(at => scheduled.has(at))
    const city = await teacherCity(store)
    const appointment: Appointment = selected ? {
      offerId: payload.requestId, student: message.sender, teacher: options.identity.publicKey, slotStart: selected.slotStart,
      minutes: selected.minutes as Appointment['minutes'], timezone: selected.timezone, capacity: selected.capacity,
      expiresAt: 0, createdAt: receivedAt.toISOString(), status: 'confirmed', ...(city ? { teacherCity: city } : {}),
    } : {
      offerId: payload.requestId, student: message.sender, teacher: options.identity.publicKey,
      slotStart: slotStartInZone(payload.startsAt[0], payload.timezone), minutes: groundwork.schedule.duration,
      timezone: payload.timezone, capacity: groundwork.schedule.capacity, expiresAt: 0, createdAt: receivedAt.toISOString(),
      status: 'cancelled', reason: alreadyBooked ? 'already_booked' : isFull ? 'slot_full' : 'unavailable', ...(city ? { teacherCity: city } : {}),
    }
    await store.put(APPOINTMENTS, appointment.offerId, appointment as unknown as StoreValue)
    if (options.send) await sendStatus(store, appointment, selected ? 'appointment.confirmed' : 'appointment.cancel', now(), options.send, selected ? undefined : appointment.reason)
  }
  const receiveReply = async (message: AppointmentMessage) => {
    if (!(await roleIs(store, 'teacher')) || !(await teacherRelation(store, message.sender)) || !validReplyPayload(message.envelope.payload)) return
    const { offerId, response } = message.envelope.payload
    const appointment = valueAt({ value: await store.get(APPOINTMENTS, offerId) })
    if (!appointment || appointment.student !== message.sender) return
    if (appointment.status !== 'offered') return
    const receivedAt = new Date(message.at * 1000)
    if (appointment.expiresAt <= +receivedAt) {
      const expired = { ...appointment, status: 'expired' as const }
      await store.put(APPOINTMENTS, offerId, expired as unknown as StoreValue)
      if (options.send) await sendStatus(store, expired, 'appointment.cancel', now(), options.send, 'expired')
      return
    }
    if (response === 'decline') {
      const declined = { ...appointment, status: 'declined' as const }
      await store.put(APPOINTMENTS, offerId, declined as unknown as StoreValue)
      return
    }
    const accepted = { ...appointment, status: 'accepted' as const }
    await store.put(APPOINTMENTS, offerId, accepted as unknown as StoreValue)
    let capacity = appointment.capacity
    let scheduled = true
    try {
      const groundwork = await loadGroundwork(store)
      scheduled = exactSlot(groundwork.schedule, appointment.slotStart, appointment.minutes, receivedAt)
      capacity = Math.min(capacity, groundwork.schedule.capacity)
    } catch { /* Older installs without a saved schedule can still complete a previously sent offer. */ }
    const remaining = await availableCapacity(store, appointment.slotStart, capacity, offerId)
    if (remaining <= 0 || !scheduled) {
      const reason = remaining <= 0 ? 'slot_full' : 'schedule_changed'
      const cancelled = { ...accepted, status: 'cancelled' as const, reason }
      await store.put(APPOINTMENTS, offerId, cancelled as unknown as StoreValue)
      if (options.send) await sendStatus(store, cancelled, 'appointment.cancel', now(), options.send, reason)
      return
    }
    const confirmed = { ...accepted, status: 'confirmed' as const }
    await store.put(APPOINTMENTS, offerId, confirmed as unknown as StoreValue)
    if (options.send) await sendStatus(store, confirmed, 'appointment.confirmed', now(), options.send)
  }
  const receiveStatus = async (message: AppointmentMessage) => {
    if (!(await roleIs(store, 'student')) || !(await studentRelation(store, message.sender)) || !object(message.envelope.payload)) return
    const { offerId, reason } = message.envelope.payload
    if (typeof offerId !== 'string' || !ID.test(offerId) || (reason !== undefined && (typeof reason !== 'string' || reason.length > 128))) return
    const current = valueAt({ value: await store.get(APPOINTMENTS, offerId) })
    if (!current || current.teacher !== message.sender || !['offered', 'requested', 'accepted', 'confirmed'].includes(current.status)) return
    const status = message.envelope.type === 'appointment.confirmed' ? 'confirmed' as const : 'cancelled' as const
    const payload = message.envelope.payload
    if (Object.keys(payload).some(key => !['offerId', 'reason', 'slotStart', 'minutes', 'timezone', 'teacherCity'].includes(key))) return
    const hasSlot = payload.slotStart !== undefined || payload.minutes !== undefined || payload.timezone !== undefined
    if (hasSlot && (!validSlot(payload.slotStart) || !validMinutes(payload.minutes) || !validZone(payload.timezone))) return
    if (payload.teacherCity !== undefined && !validCity(payload.teacherCity)) return
    if (message.envelope.type === 'appointment.confirmed' && current.status === 'requested' && !hasSlot) return
    const next = { ...current, status: message.envelope.type === 'appointment.cancel' && reason === 'expired' ? 'expired' as const : status,
      ...(hasSlot ? { slotStart: payload.slotStart as string, minutes: payload.minutes as Appointment['minutes'], timezone: payload.timezone as string } : {}),
      ...(typeof payload.teacherCity === 'string' ? { teacherCity: payload.teacherCity } : {}), ...(reason ? { reason } : {}) }
    await store.put(APPOINTMENTS, offerId, next as unknown as StoreValue)
  }
  return {
    async receive(message: AppointmentMessage): Promise<void> {
      if (!message || !object(message.envelope) || message.envelope.version !== 1 || !Number.isSafeInteger(message.at) || !HEX64.test(message.sender)) return
      const type = message.envelope.type
      if (type === 'appointment.offer') return receiveOffer(message)
      if (type === 'appointment.reply') return receiveReply(message)
      if (type === 'appointment.request') return receiveRequest(message)
      if (type === 'appointment.confirmed' || type === 'appointment.cancel') return receiveStatus(message)
    },
  }
}

export async function markAppointmentAttendance(store: LocalStore, offerId: string, status: 'done' | 'no_show'): Promise<Appointment> {
  if (!ID.test(offerId) || !['done', 'no_show'].includes(status)) throw new Error('预约状态无效')
  const current = valueAt({ value: await store.get(APPOINTMENTS, offerId) })
  if (!current || current.status !== 'confirmed') throw new Error('只有已确认的预约可以标记到场情况')
  const next = { ...current, status }
  await store.put(APPOINTMENTS, offerId, next as unknown as StoreValue)
  return next
}

/** 供排班保存前核对：旧排班下已占位、将被新规则移除或超过新容量的预约。 */
export async function appointmentsAffectedBySchedule(store: Pick<LocalStore, 'list'>, schedule: Schedule, now = new Date()): Promise<Appointment[]> {
  const bookings = (await listAppointments(store)).filter(row => ['accepted', 'confirmed'].includes(row.status) && Date.parse(row.slotStart) > +now)
  const groups = new Map<number, Appointment[]>()
  for (const row of bookings) { const key = Date.parse(row.slotStart); groups.set(key, [...(groups.get(key) ?? []), row]) }
  const affected = new Set<string>()
  for (const rows of groups.values()) {
    const ordered = rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.offerId.localeCompare(b.offerId))
    const when = new Date(Date.parse(ordered[0].slotStart))
    const exists = exactSlot(schedule, ordered[0].slotStart, ordered[0].minutes, new Date(+when - 2 * HOUR))
    const capacity = schedule.capacity
    for (const row of ordered) if (!exists || ordered.indexOf(row) >= capacity) affected.add(row.offerId)
  }
  return bookings.filter(row => affected.has(row.offerId))
}

export async function cancelAppointment(store: LocalStore, identity: Identity, offerId: string, reason: string, now: Date, send: SendAppointmentEnvelope): Promise<void> {
  const current = valueAt({ value: await store.get(APPOINTMENTS, offerId) })
  if (!current || current.teacher !== identity.publicKey || !['accepted', 'confirmed'].includes(current.status) || typeof reason !== 'string' || reason.length > 128) throw new Error('这条预约不能取消')
  const next = { ...current, status: 'cancelled' as const, reason }
  // 先等中继确认送达，再在本机落取消状态；传输失败时可安全重试。
  // 学生端按 offerId 幂等处理，因此重试使用新的发送守线键不会造成重复取消。
  await sendStatus(store, next, 'appointment.cancel', now, send, reason, crypto.randomUUID())
  await store.put(APPOINTMENTS, offerId, next as unknown as StoreValue)
}
