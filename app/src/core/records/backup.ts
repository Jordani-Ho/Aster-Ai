import type { LocalStore, StoreValue } from '../store'
import type { Envelope } from '../transport'
import { listTeacherRecords, parseRecordEvent, teacherContactStudents, teacherRecordsOf, type LoadedTeacherRecord } from './teacher'
import { loadRetentionDays, type RetentionRole } from './retention'

// V2-05 第 3 步：师生互为备份。仍走现有的传递层（NIP-17/44/59 信封），只加三种消息：
// - records.request：学生 → 老师，请老师把保留期内的该学生记录发回来；
// - records.pull：老师 → 学生，请学生把保存的、这位老师签的病历发回来；
// - records.backup：任一方向回发一条签名病历（一条一个信封，和问诊照片一样避免单条过大）。
// 回发前一律核对发件人：A 学生的记录不会发给 B。
export const RECORDS_REQUEST = 'records.request'
export const RECORDS_PULL = 'records.pull'
export const RECORDS_BACKUP = 'records.backup'
export const RESTORE_NEEDED_SETTING = 'restore-needed'
const LAST_BACKUP_REQUEST_SETTING = 'last-backup-request'
/** 一个回包里最多带多少份病历（其余等下一次请求）。 */
export const MAX_BACKUP_RECORDS = 20

export type SendEnvelope = (recipient: string, envelope: Envelope) => Promise<unknown>

const HEX64 = /^[0-9a-f]{64}$/
const DAY = 86400000

export function backupEnvelope(event: unknown): Envelope {
  return { type: RECORDS_BACKUP, version: 1, payload: event }
}

export function requestEnvelope(): Envelope {
  return { type: RECORDS_REQUEST, version: 1, payload: {} }
}

export function pullEnvelope(): Envelope {
  return { type: RECORDS_PULL, version: 1, payload: {} }
}

export async function loadRole(store: LocalStore): Promise<RetentionRole | null> {
  const value = await store.get('settings', 'role') as { role?: unknown } | undefined
  return value?.role === 'teacher' ? 'teacher' : value?.role === 'student' ? 'student' : null
}

// 学生重新进社区后标记“要恢复”；连上中继后自动发请求。
export async function markRestoreNeeded(store: LocalStore): Promise<void> {
  await store.put('settings', RESTORE_NEEDED_SETTING, true as unknown as StoreValue)
}

export async function restoreNeeded(store: LocalStore): Promise<boolean> {
  return (await store.get('settings', RESTORE_NEEDED_SETTING)) === true
}

export async function clearRestoreNeeded(store: LocalStore): Promise<void> {
  await store.delete('settings', RESTORE_NEEDED_SETTING)
}

/** 学生端：向“我的老师”逐个请求把自己的记录发回来；返回请求了哪些老师。 */
export async function requestOwnRecords(store: LocalStore, teachers: readonly string[], send: SendEnvelope): Promise<string[]> {
  for (const teacher of new Set(teachers)) await send(teacher, requestEnvelope())
  await clearRestoreNeeded(store)
  return [...new Set(teachers)]
}

/** 老师端：向认得的每位学生逐个请求自己签的病历。 */
export async function requestStudentsRecords(store: LocalStore, send: SendEnvelope): Promise<string[]> {
  const students = await teacherContactStudents(store)
  for (const student of students) await send(student, pullEnvelope())
  return students
}

/** 老师端回给学生的备份：只发这一位学生在保留期内的记录。 */
export async function recordsForBackup(store: LocalStore, student: string, now = new Date()): Promise<LoadedTeacherRecord[]> {
  const days = await loadRetentionDays(store)
  const cutoff = now.getTime() - days * DAY
  return (await teacherRecordsOf(store, student))
    .filter(record => Date.parse(record.createdAt) >= cutoff)
    .slice(0, MAX_BACKUP_RECORDS)
}

/** 学生端回给老师的备份：只发这位老师签的、本机还留着的记录（由调用方验签后传入）。 */
export function ownBackupsForTeacher(events: readonly unknown[], teacher: string): unknown[] {
  const result: unknown[] = []
  for (const event of events) {
    const parsed = parseRecordEvent(event)
    if (parsed && parsed.pubkey === teacher) result.push(parsed)
  }
  return result.slice(0, MAX_BACKUP_RECORDS)
}

// 老师端收到学生回发的备份：事件必须由本机老师签名、p 标签就是发件人（学生）。
export function backupForTeacher(event: unknown, teacher: string, sender: string): ReturnType<typeof parseRecordEvent> {
  const parsed = parseRecordEvent(event)
  if (!parsed || parsed.pubkey !== teacher) return null
  const pTag = parsed.tags.find(tag => tag[0] === 'p')?.[1]
  if (pTag !== sender || !HEX64.test(sender)) return null
  return parsed
}

/**
 * 打开应用、连上中继后自动跑一次（每天最多一次）：
 * - 学生：有老师名单且标记过“要恢复”时，向老师请求自己的记录；
 * - 老师：本机没有任何医案、但有认得的学生的，主动向学生请求。
 * 半路失败不要紧：下一天或下一次重连还会再发（回包重复只覆盖相同内容）。
 */
export async function autoRestore(store: LocalStore, teachers: readonly string[], send: SendEnvelope, options: { now?: Date } = {}): Promise<boolean> {
  const role = await loadRole(store)
  if (!role) return false
  const now = options.now ?? new Date()
  const today = now.toISOString().slice(0, 10)
  const last = await store.get('settings', LAST_BACKUP_REQUEST_SETTING)
  if (last === today) return false
  if (role === 'student') {
    if (teachers.length === 0) return false
    // 只在“要恢复”或本机一份病历都没有时才请求，避免每次打开都向老师要一遍。
    if (!(await restoreNeeded(store)) && (await store.list('student-records')).length > 0) return false
    await requestOwnRecords(store, teachers, send)
  } else {
    if ((await listTeacherRecords(store)).length > 0) return false
    if ((await teacherContactStudents(store)).length === 0) return false
    await requestStudentsRecords(store, send)
  }
  await store.put('settings', LAST_BACKUP_REQUEST_SETTING, today as unknown as StoreValue)
  return true
}
