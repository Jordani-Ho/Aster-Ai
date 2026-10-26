import type { Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'
import { createRunner } from '../agent/runner'
import { defineTask, type AgentTask } from '../agent/tasks'
import { listTeacherRecords } from '../records/teacher'
import { loadGroundwork } from '../hall/groundwork'
import { heavenNow } from '../heaven'
import { appointmentSlots } from '../schedule/appointments'
import { isSameCity } from '../city'
import { TEACHER_STUDENTS } from '../records/teacher'
import { APPOINTMENTS, listAppointments, notifyAppointmentExpired, sendAppointmentOffer, type Appointment, type SendAppointmentEnvelope } from './index'

const CAMPAIGNS = 'appointment-campaigns'
const DAY = 86_400_000

interface Visit { student: string; at: string; alias: string; city?: string | null }
export interface InviteMaterials {
  now: string
  timezone: string
  city: string | null
  afterDays: number
  schedule: Awaited<ReturnType<typeof loadGroundwork>>['schedule']
  visits: Visit[]
  appointments: Appointment[]
}
export interface InviteCandidate { student: string; alias: string; lastVisit: string }
export interface AppointmentInvitePlan {
  localDate: string
  slot: { slotStart: string; minutes: number; timezone: string; capacity: number } | null
  candidates: InviteCandidate[]
}
interface Campaign { id: string; slot: NonNullable<AppointmentInvitePlan['slot']>; candidates: InviteCandidate[]; cursor: number; createdAt: string }

function localDate(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

async function gather(store: LocalStore, now: Date): Promise<InviteMaterials> {
  const [groundwork, records, appointments, heaven, roster] = await Promise.all([
    loadGroundwork(store), listTeacherRecords(store), listAppointments(store), heavenNow(store, now), store.list(TEACHER_STUDENTS),
  ])
  const rosterCities = new Map(roster.filter(row => row.value && typeof row.value === 'object' && 'student' in row.value && (row.value as { student: unknown }).student === row.key)
    .map(row => [row.key, row.value as { city?: string | null }]))
  const visits = new Map<string, Visit>()
  for (const record of records) {
    const alias = record.encounter.profile.alias.value
    const current = visits.get(record.student)
    if (!current || Date.parse(record.createdAt) > Date.parse(current.at)) {
      const rosterEntry = rosterCities.get(record.student)
      const savedCity = rosterEntry && Object.hasOwn(rosterEntry, 'city') ? rosterEntry.city : record.encounter.profile.city.value
      visits.set(record.student, {
        student: record.student, at: record.createdAt, alias: typeof alias === 'string' && alias.trim() ? alias.trim() : `学生 ${record.student.slice(0, 4)}`,
        city: typeof savedCity === 'string' ? savedCity : null,
      })
    }
  }
  for (const appointment of appointments) if (appointment.status === 'done') {
    const current = visits.get(appointment.student)
    if (!current || Date.parse(appointment.slotStart) > Date.parse(current.at)) visits.set(appointment.student, {
      student: appointment.student, at: appointment.slotStart, alias: current?.alias ?? `学生 ${appointment.student.slice(0, 4)}`, city: current?.city ?? null,
    })
  }
  return {
    now: now.toISOString(), timezone: groundwork.schedule.timezone, city: heaven.city,
    afterDays: groundwork.invitation.afterDays, schedule: groundwork.schedule,
    visits: [...visits.values()], appointments,
  }
}

export function planAppointmentInvitations(materials: InviteMaterials): AppointmentInvitePlan {
  const now = new Date(materials.now)
  if (!Number.isFinite(+now) || !Number.isSafeInteger(materials.afterDays) || materials.afterDays < 1 || materials.afterDays > 3650) throw new Error('邀约规则无效')
  const recentlyInvited = new Set(materials.appointments.filter(row => +now - Date.parse(row.createdAt) < DAY).map(row => row.student))
  const futureBooked = new Set(materials.appointments.filter(row => ['accepted', 'confirmed'].includes(row.status) && Date.parse(row.slotStart) > +now).map(row => row.student))
  const candidates = materials.visits.filter(row => +now - Date.parse(row.at) >= materials.afterDays * DAY
    && !recentlyInvited.has(row.student) && !futureBooked.has(row.student))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.student.localeCompare(right.student))
    .filter(row => isSameCity(row.city, materials.city))
    .map(row => ({ student: row.student, alias: row.alias, lastVisit: row.at }))
  const bookings = materials.appointments.map(row => ({ slotStart: row.slotStart, status: row.status }))
  const slot = appointmentSlots(materials.schedule, { now, days: 60, bookings })[0]
  return {
    localDate: localDate(now, materials.timezone),
    slot: slot ? { slotStart: slot.slotStart, minutes: slot.minutes, timezone: slot.timezone, capacity: slot.capacity } : null,
    candidates,
  }
}

async function sendCampaignBatch(store: LocalStore, identity: Identity, campaign: Campaign, send: SendAppointmentEnvelope, now: Date): Promise<{ sent: number; campaign: Campaign }> {
  const current = (await store.get(CAMPAIGNS, campaign.id) as unknown as Campaign | undefined) ?? campaign
  const existing = await listAppointments(store)
  const active = existing.filter(row => row.campaignId === current.id && row.slotStart === current.slot.slotStart && row.status === 'offered').length
  const occupied = existing.filter(row => row.slotStart === current.slot.slotStart && ['accepted', 'confirmed'].includes(row.status)).length
  const target = Math.max(0, current.slot.capacity + 1 - active - occupied)
  let cursor = current.cursor, sent = 0
  while (cursor < current.candidates.length && sent < target) {
    const candidate = current.candidates[cursor]
    // Advance before network I/O: a dropped connection may have delivered the message already.
    const next = { ...current, cursor: cursor + 1 }
    await store.put(CAMPAIGNS, current.id, next as unknown as StoreValue)
    current.cursor = next.cursor; cursor += 1
    try {
      await sendAppointmentOffer({ store, identity, student: candidate.student, slot: current.slot, campaignId: current.id, now, send })
      sent += 1
    } catch (cause) {
      // The candidate may have become ineligible since the plan was made; keep the queue moving.
      if (!(cause instanceof Error) || !/未来预约|24 小时内|约满|排班内|所在城市/.test(cause.message)) throw cause
    }
  }
  return { sent, campaign: current }
}

export async function processAppointmentCampaigns(store: LocalStore, identity: Identity, send: SendAppointmentEnvelope, now = new Date()): Promise<number> {
  if (!(now instanceof Date) || !Number.isFinite(+now)) throw new Error('邀约处理时间无效')
  let sent = 0
  for (const row of await store.list(CAMPAIGNS)) {
    const campaign = row.value as unknown as Campaign
    if (!campaign || typeof campaign.id !== 'string' || !campaign.slot || !Array.isArray(campaign.candidates) || !Number.isSafeInteger(campaign.cursor)) continue
    for (const appointment of await listAppointments(store)) {
      if (appointment.campaignId !== campaign.id || appointment.status !== 'offered' || appointment.expiresAt > +now) continue
      const expired = { ...appointment, status: 'expired' as const }
      await store.put(APPOINTMENTS, appointment.offerId, expired as unknown as StoreValue)
      try { await notifyAppointmentExpired(store, expired, now, send) }
      catch { /* 过期记录仍可由本地状态恢复；网络失败不挡下一位。 */ }
    }
    // 多发的一位若也接受、但容量已满，就给他同一活动里的下一个真实可约时段。
    const rows = await listAppointments(store)
    const overflow = rows.filter(appointment => appointment.campaignId === campaign.id
      && appointment.status === 'cancelled' && appointment.reason === 'slot_full'
      && !rows.some(candidate => candidate.replacementFor === appointment.offerId))
    if (overflow.length > 0) {
      const schedule = (await loadGroundwork(store)).schedule
      for (const appointment of overflow) {
        const current = await listAppointments(store)
        const nextSlot = appointmentSlots(schedule, { now, days: 60,
          bookings: current.map(value => ({ slotStart: value.slotStart, status: value.status })) })
          .find(slot => slot.slotStart !== appointment.slotStart)
        if (!nextSlot) continue
        try {
          await sendAppointmentOffer({ store, identity, student: appointment.student, slot: nextSlot,
            campaignId: campaign.id, replacementFor: appointment.offerId, now, send })
          sent += 1
        } catch { /* 这轮没发成时不记录替代关系，下次检查继续尝试。 */ }
      }
    }
    const result = await sendCampaignBatch(store, identity, campaign, send, now)
    sent += result.sent
  }
  return sent
}

function invitationTask(store: LocalStore, identity: Identity, send: SendAppointmentEnvelope, mode: 'auto' | 'review', now: Date): AgentTask<InviteMaterials, AppointmentInvitePlan> {
  return defineTask({
    id: mode === 'auto' ? 'appointment-invite-auto' : 'appointment-invite-review', side: 'teacher',
    trigger: { kind: 'time', hour: 8 }, confirm: mode === 'auto' ? 'template' : 'human',
    gather: () => gather(store, now), tokens: () => 1, run: async materials => planAppointmentInvitations(materials),
    deliver: async plan => {
      if (!plan.slot || plan.candidates.length === 0) return
      const id = crypto.randomUUID()
      const campaign: Campaign = { id, slot: plan.slot, candidates: plan.candidates, cursor: 0, createdAt: now.toISOString() }
      await store.put(CAMPAIGNS, id, campaign as unknown as StoreValue)
      await sendCampaignBatch(store, identity, campaign, send, now)
    },
  })
}

function targetFor(identity: Identity, date: string): string { return `${identity.publicKey}-${date}` }
async function runtime(store: LocalStore, identity: Identity, send: SendAppointmentEnvelope | undefined, now: Date) {
  const groundwork = await loadGroundwork(store)
  const deliverySend = send ?? (async () => { throw new Error('中继还没连上，邀约发送需要连接') })
  const task = invitationTask(store, identity, deliverySend, groundwork.invitation.mode, now)
  const date = localDate(now, groundwork.schedule.timezone)
  const runner = createRunner({
    store, side: 'teacher', maxTokens: 1,
    ...(send ? { send: async (recipient: string, payload: unknown) => { await send(recipient, payload as import('../transport').Envelope) } } : {}),
    allowTemplate: async taskId => !!send && taskId === 'appointment-invite-auto' && (await loadGroundwork(store)).invitation.mode === 'auto',
  })
  return { task, runner, request: { targetId: targetFor(identity, date), now } }
}

export async function runDailyAppointmentInvitations(store: LocalStore, identity: Identity, send: SendAppointmentEnvelope | undefined, now = new Date()) {
  const context = await runtime(store, identity, send, now)
  return context.runner.run(context.task, context.request)
}

export async function confirmDailyAppointmentInvitations(store: LocalStore, identity: Identity, send: SendAppointmentEnvelope | undefined, key: string, now = new Date()) {
  const context = await runtime(store, identity, send, now)
  return context.runner.confirm(context.task, context.request, key)
}

export async function latestAppointmentInviteRun(store: LocalStore, identity: Identity, now = new Date()) {
  const groundwork = await loadGroundwork(store), date = localDate(now, groundwork.schedule.timezone)
  const targetId = targetFor(identity, date)
  return (await store.list('agent-runs')).map(row => ({ key: row.key, value: row.value as { taskId?: unknown; targetId?: unknown; output?: unknown; status?: unknown } }))
    .filter(row => row.value.targetId === targetId && ['appointment-invite-auto', 'appointment-invite-review'].includes(String(row.value.taskId)))
    .sort((left, right) => right.key.localeCompare(left.key))[0] ?? null
}
