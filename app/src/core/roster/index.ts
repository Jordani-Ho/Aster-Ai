import type { Event } from 'nostr-tools/pure'
import type { Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'
import type { Envelope, Message } from '../transport'
import { createRunner } from '../agent/runner'
import { defineTask } from '../agent/tasks'
import { loadGroundwork, validDate } from '../hall/groundwork'
import { localDay } from '../homework/schedule'
import { validateInvite } from '../onboarding'
import { removeTeacher, loadTeachers } from '../inbox'

export const TEACHER_LEAVES = 'teacher-roster-leaves'
export const STUDENT_LEAVES = 'student-roster-leaves'
export const ROSTER_LEAVE_TEXT = '你已经和老师的智能体失联了。想回来，请老师重新邀请你；去老师那里面诊不受影响。'
const HEX64 = /^[0-9a-f]{64}$/
const DAY_MS = 86_400_000

export interface LeaveEvidence { hasHomework?: unknown; homeworkSince?: unknown; homeworkUntil?: unknown; lastCheckinDay?: unknown }
export interface RosterLeave { student: string; at: string; day: string }
export function validLeaveDays(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 14 && (value as number) <= 365 }
export function inactivityMilestones(limit: number | null): { fact: number; stepBack: number } {
  if (limit !== null && !validLeaveDays(limit)) throw Error('请出天数须为 14–365')
  return { fact: limit === null ? 7 : Math.floor(limit / 2), stepBack: limit === null ? 14 : limit - 7 }
}
export function dayDistance(from: string, to: string): number {
  if (!validDate(from) || !validDate(to)) throw Error('名单日期无效')
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS)
}
export function dueForLeave(evidence: LeaveEvidence, limit: number | null, today: string): boolean {
  if (limit === null || !validLeaveDays(limit) || !validDate(today) || evidence.hasHomework !== true || !validDate(evidence.homeworkSince)) return false
  if (evidence.lastCheckinDay !== null && !validDate(evidence.lastCheckinDay)) return false
  if (evidence.homeworkUntil !== undefined && evidence.homeworkUntil !== null && (!validDate(evidence.homeworkUntil) || evidence.homeworkUntil < today)) return false
  const anchor = evidence.lastCheckinDay && evidence.lastCheckinDay > evidence.homeworkSince ? evidence.lastCheckinDay : evidence.homeworkSince
  return dayDistance(anchor, today) > limit
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function validLeave(value: unknown): value is RosterLeave {
  return object(value) && typeof value.student === 'string' && HEX64.test(value.student) && typeof value.at === 'string'
    && Number.isFinite(Date.parse(value.at)) && validDate(value.day)
}
export async function listRosterLeaves(store: Pick<LocalStore, 'list'>): Promise<RosterLeave[]> {
  return (await store.list(TEACHER_LEAVES)).map(row => row.value as unknown).filter(validLeave).sort((a, b) => b.at.localeCompare(a.at))
}
export async function isRemovedStudent(store: Pick<LocalStore, 'get'>, student: string): Promise<boolean> {
  return validLeave(await store.get(TEACHER_LEAVES, student))
}

/** 老师端每日任务：先把固定通知发进加密中继，再撤销名单资格；失败不会静默请出。 */
export async function runDailyRosterLeaves(store: LocalStore, identity: Identity, send: (student: string, envelope: Envelope) => Promise<unknown>, now = new Date()): Promise<RosterLeave[]> {
  if (!(now instanceof Date) || !Number.isFinite(+now) || !HEX64.test(identity.publicKey)) throw Error('请出时间或身份无效')
  const limit = (await loadGroundwork(store)).invitation.leaveAfterDays
  if (limit === null) return []
  const day = localDay(now)
  const roster = await store.list('teacher-students')
  const reports = new Map((await store.list('student-adherence')).map(row => [row.key, row.value]))
  for (const row of roster) {
    const student = row.key
    if (!HEX64.test(student) || !object(row.value) || row.value.student !== student || await isRemovedStudent(store, student)) continue
    const evidence = reports.get(student)
    if (!object(evidence) || !dueForLeave(evidence, limit, day)) continue
    const task = defineTask<{ student: string; day: string; at: string }, { student: string; day: string; at: string }>({
      id: 'roster-leave', side: 'teacher', trigger: { kind: 'time', hour: 9 }, confirm: 'template',
      gather: async () => ({ student, day, at: now.toISOString() }),
      run: async input => input,
      deliver: async (result, context) => {
        await context.send(student, { type: 'roster.leave', version: 1, payload: { at: result.at, text: ROSTER_LEAVE_TEXT } })
        await store.put(TEACHER_LEAVES, student, { student, at: result.at, day: result.day } as unknown as StoreValue)
        await store.delete('teacher-students', student)
        await store.delete('student-adherence', student)
      },
    })
    const result = await createRunner({ store, side: 'teacher', maxTokens: 1000,
      send: async (to, payload) => { await send(to, payload as Envelope) },
      allowTemplate: async id => id === 'roster-leave' && validLeaveDays((await loadGroundwork(store)).invitation.leaveAfterDays),
    }).run(task, { targetId: student, now })
    if (result.status === 'delivered') await store.delete('agent-runs', result.key).catch(() => {})
  }
  return (await listRosterLeaves(store)).filter(row => row.day === day)
}

/** 新邀请由老师签名；仅接受请出后签发的另一张邀请，旧邀请重放不能恢复资格。 */
export async function receiveRosterJoin(store: LocalStore, teacher: string, student: string, invite: unknown, at: number): Promise<boolean> {
  if (!HEX64.test(student) || !object(invite) || !Number.isSafeInteger(at) || at <= 0) return false
  const event = invite as Event
  const url = Array.isArray(event.tags) ? event.tags.find(tag => Array.isArray(tag) && tag[0] === 'u')?.[1] : undefined
  if (typeof url !== 'string' || event.pubkey !== teacher || !validateInvite(event, url, Math.floor(Date.now() / 1000))) return false
  const leave = await store.get(TEACHER_LEAVES, student)
  if (validLeave(leave) && event.created_at <= Math.floor(Date.parse(leave.at) / 1000)) return false
  await store.delete(TEACHER_LEAVES, student)
  await store.put('teacher-students', student, { student } as StoreValue)
  return true
}
export async function receiveRosterLeave(store: LocalStore, teacher: string, at: number): Promise<boolean> {
  if (!HEX64.test(teacher) || !Number.isSafeInteger(at) || at <= 0 || !(await loadTeachers(store)).includes(teacher)) return false
  const joined = await store.get('student-roster-joined', teacher)
  if (typeof joined === 'number' && joined > at) return false
  await store.put(STUDENT_LEAVES, teacher, { at: new Date(at * 1000).toISOString(), text: ROSTER_LEAVE_TEXT } as StoreValue)
  await removeTeacher(store, teacher)
  return true
}
export async function sendPendingRosterJoin(store: LocalStore, send: (teacher: string, envelope: Envelope) => Promise<unknown>): Promise<void> {
  for (const row of await store.list('student-roster-pending')) {
    if (!HEX64.test(row.key) || !object(row.value)) continue
    await send(row.key, { type: 'roster.join', version: 1, payload: { invite: row.value.invite } })
    await store.delete('student-roster-pending', row.key)
  }
}
export async function receiveRosterMessage(store: LocalStore, identity: Identity, message: Message): Promise<void> {
  if (message.envelope.version !== 1 || !object(message.envelope.payload)) return
  if (message.envelope.type === 'roster.join' && (await store.get('settings', 'role') as { role?: unknown } | undefined)?.role === 'teacher') {
    await receiveRosterJoin(store, identity.publicKey, message.sender, message.envelope.payload.invite, message.at)
  }
  if (message.envelope.type === 'roster.leave' && (await store.get('settings', 'role') as { role?: unknown } | undefined)?.role === 'student') {
    await receiveRosterLeave(store, message.sender, message.at)
  }
}
