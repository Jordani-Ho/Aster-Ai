import type { LocalStore, StoreValue } from '../store'
import type { Envelope, Message } from '../transport'
import { localDay } from '../homework/schedule'
import { listTeacherRecords, TEACHER_RECORDS, teacherContactStudents } from './teacher'

// V2-05 第 1 步：保留期限由老师定。默认 90 天，可选 30 天到 3 年。
// 老师端按自己的设置删医案，学生端按老师的设置（可能多位老师，取最短）删本机记录。
// 第 2 步：调养方案（最新一版）、作业规则、老师的思想指纹（改稿习惯摘要）、
// 康币观察记录（只有计数与评分、没有内容，是将来给康币定值的依据）不在删除范围内。
export const RETENTION_DEFAULT_DAYS = 90
export const RETENTION_MIN_DAYS = 30
export const RETENTION_MAX_DAYS = 1095
export const RETENTION_TYPE = 'retention.setting'
/** 学生端收到的每位老师的保留期限：键为老师公钥。 */
export const TEACHER_RETENTION_COLLECTION = 'teacher-retention'
export const RETENTION_DAYS_SETTING = 'retention-days'
export const LAST_RETENTION_DAY_SETTING = 'last-retention-day'
/** 长期保留的沉淀：保留期只删记录，不碰这些集合。kangbi-self 是学生本人的感受，只在这台手机上。 */
export const LONG_TERM_COLLECTIONS = ['care-plans', 'homework', 'teacher-fingerprint', 'kangbi-observations', 'kangbi-events', 'kangbi-self'] as const

const DAY = 86400000
const HEX64 = /^[0-9a-f]{64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export interface TeacherRetention {
  teacher: string
  days: number
  updatedAt: string
}

export function validRetentionDays(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= RETENTION_MIN_DAYS && (value as number) <= RETENTION_MAX_DAYS
}

export async function loadRetentionDays(store: LocalStore): Promise<number> {
  const value = await store.get('settings', RETENTION_DAYS_SETTING)
  return validRetentionDays(value) ? value : RETENTION_DEFAULT_DAYS
}

export async function saveRetentionDays(store: LocalStore, days: number): Promise<void> {
  if (!validRetentionDays(days)) throw new Error('保留期限须为 30 天到 3 年之间')
  await store.put('settings', RETENTION_DAYS_SETTING, days as unknown as StoreValue)
}

export function retentionEnvelope(teacher: string, days: number, updatedAt = new Date().toISOString()): Envelope {
  return { type: RETENTION_TYPE, version: 1, payload: { teacher, days, updatedAt } }
}

// 老师改设置后随调养方案一起（或单独）发给学生；学生端按老师公钥覆盖保存。
export async function sendRetentionSetting(send: (recipient: string, envelope: Envelope) => Promise<unknown>, teacher: string, days: number, students: readonly string[]): Promise<void> {
  if (!validRetentionDays(days)) throw new Error('保留期限须为 30 天到 3 年之间')
  const envelope = retentionEnvelope(teacher, days)
  for (const student of new Set(students)) await send(student, envelope)
}

export async function receiveRetentionSetting(store: LocalStore, message: Message): Promise<boolean> {
  const payload = message.envelope.payload as { teacher?: unknown; days?: unknown; updatedAt?: unknown }
  if (!payload || typeof payload !== 'object') return false
  if (payload.teacher !== message.sender || !HEX64.test(message.sender)) return false
  if (!validRetentionDays(payload.days)) return false
  const updatedAt = typeof payload.updatedAt === 'string' && Number.isFinite(Date.parse(payload.updatedAt)) ? payload.updatedAt : new Date().toISOString()
  const existing = await store.get(TEACHER_RETENTION_COLLECTION, message.sender) as unknown as TeacherRetention | undefined
  if (existing && existing.updatedAt > updatedAt) return false
  await store.put(TEACHER_RETENTION_COLLECTION, message.sender, { teacher: message.sender, days: payload.days, updatedAt } as unknown as StoreValue)
  return true
}

export async function listTeacherRetentions(store: LocalStore): Promise<TeacherRetention[]> {
  const rows = await store.list(TEACHER_RETENTION_COLLECTION)
  const result: TeacherRetention[] = []
  for (const row of rows) {
    const value = row.value as unknown as TeacherRetention | undefined
    if (!value || typeof value !== 'object') continue
    if (typeof value.teacher !== 'string' || !HEX64.test(value.teacher) || !validRetentionDays(value.days)) continue
    result.push({ teacher: value.teacher, days: value.days, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '' })
  }
  return result
}

// 学生可能有多位老师：按最短的保留期限删（最保守），没有老师设置时用默认 90 天。
export function effectiveRetentionDays(rows: readonly TeacherRetention[]): number {
  const valid = rows.filter(row => validRetentionDays(row.days))
  return valid.length === 0 ? RETENTION_DEFAULT_DAYS : Math.min(...valid.map(row => row.days))
}

export type RetentionRole = 'student' | 'teacher'
export interface RetentionResult { days: number; deleted: Record<string, number> }

const EMPTY_RESULT = (days: number): RetentionResult => ({ days, deleted: {} })

function olderThan(iso: unknown, cutoff: number): boolean {
  return typeof iso === 'string' && Number.isFinite(Date.parse(iso)) && Date.parse(iso) < cutoff
}

async function dropRows(store: LocalStore, collection: string, keep: (key: string, value: unknown) => boolean): Promise<number> {
  let deleted = 0
  for (const row of await store.list(collection)) {
    if (keep(row.key, row.value)) continue
    await store.delete(collection, row.key)
    deleted += 1
  }
  return deleted
}

// 老师端：删超过保留期的完整医案、问诊包、进行中的面诊草稿，以及不再被引用的照片。
async function cleanTeacher(store: LocalStore, cutoff: number): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {}
  // 未匹配到有效进馆邀请的资料也遵照老师的保留期限清理。
  deleted['teacher-basics-waiting'] = await dropRows(store, 'teacher-basics-waiting', (_key, value) => {
    const at = (value as { at?: unknown })?.at
    return typeof at === 'number' && Number.isSafeInteger(at) && at * 1000 >= cutoff
  })
  deleted[TEACHER_RECORDS] = await dropRows(store, TEACHER_RECORDS, (_key, value) => {
    const record = value as { createdAt?: unknown }
    return !olderThan(record?.createdAt, cutoff)
  })
  deleted['consult-package'] = await dropRows(store, 'consult-package', (_key, value) => {
    const consult = value as { receivedAt?: unknown; encounter?: { createdAt?: unknown } }
    return !(olderThan(consult?.receivedAt, cutoff) || olderThan(consult?.encounter?.createdAt, cutoff))
  })
  deleted['in-person-draft'] = await dropRows(store, 'in-person-draft', (_key, value) => {
    const draft = value as { createdAt?: unknown }
    return !olderThan(draft?.createdAt, cutoff)
  })
  // V2-33：库存旁车跟病历 id 走；签字病历或仍保留的问诊包任一存在，就保留快照。
  const snapshotEncounterIds = new Set((await listTeacherRecords(store)).map(record => record.encounter.id))
  for (const row of await store.list('consult-package')) snapshotEncounterIds.add(row.key)
  deleted['teacher-herb-snapshots'] = await dropRows(store, 'teacher-herb-snapshots', key => snapshotEncounterIds.has(key))
  // 照片按“仍被剩余记录引用”来判断，避免留下无主字节。
  const referenced = new Set<string>()
  for (const row of await store.list('consult-package')) {
    const consult = row.value as { attachments?: { id?: unknown }[] }
    for (const ref of consult?.attachments ?? []) if (typeof ref?.id === 'string') referenced.add(ref.id)
  }
  for (const record of await listTeacherRecords(store)) {
    for (const ref of record.encounter.intake.attachments) referenced.add(ref.id)
    // V2-08：签字病历里引用的舌头裁剪图（只含裁剪图，不含原图）。
    for (const tongue of record.encounter.intake.tongues ?? []) if (tongue.crop) referenced.add(tongue.crop.id)
  }
  for (const row of await store.list('in-person-draft')) {
    const draft = row.value as { intake?: { attachments?: { id?: unknown }[]; tongues?: { crop?: { id?: unknown } }[] } }
    for (const ref of draft?.intake?.attachments ?? []) if (typeof ref?.id === 'string') referenced.add(ref.id)
    for (const tongue of draft?.intake?.tongues ?? []) if (typeof tongue?.crop?.id === 'string') referenced.add(tongue.crop.id)
  }
  deleted.attachments = await dropRows(store, 'attachments', key => referenced.has(key))
  return deleted
}

// 学生端：删超过保留期的镜子记录、问诊卡片、作业打卡与对应照片；调养方案和作业规则一律不动。
// V2-03 起舌象只存抽象记录（tongue-records），不再存原图字节。
async function cleanStudent(store: LocalStore, cutoff: number): Promise<Record<string, number>> {
  const cutoffDay = localDay(new Date(cutoff))
  const oldDay = (key: string) => !DATE.test(key) || key < cutoffDay
  const deleted: Record<string, number> = {}
  for (const collection of ['self-ratings', 'self-stress', 'tongue-records']) {
    deleted[collection] = await dropRows(store, collection, key => !oldDay(key))
  }
  deleted.checkins = await dropRows(store, 'checkins', (_key, value) => {
    const checkin = value as { at?: unknown }
    return !olderThan(checkin?.at, cutoff)
  })
  deleted['intake-sent'] = await dropRows(store, 'intake-sent', (_key, value) => {
    const pkg = value as { encounter?: { createdAt?: unknown } }
    return !olderThan(pkg?.encounter?.createdAt, cutoff)
  })
  deleted['intake-draft'] = await dropRows(store, 'intake-draft', (_key, value) => {
    const draft = value as { createdAt?: unknown }
    return !olderThan(draft?.createdAt, cutoff)
  })
  const referenced = new Set<string>()
  for (const collection of ['intake-sent', 'intake-draft']) {
    for (const row of await store.list(collection)) {
      const value = row.value as { attachments?: ({ id?: unknown } | { ref?: { id?: unknown } })[] }
      for (const item of value?.attachments ?? []) {
        const id = (item as { id?: unknown }).id ?? (item as { ref?: { id?: unknown } }).ref?.id
        if (typeof id === 'string') referenced.add(id)
      }
    }
  }
  deleted['intake-attachments'] = await dropRows(store, 'intake-attachments', key => referenced.has(key))
  // V2-08：镜子只留最新一张舌头裁剪图；超期后随记录一起删（裁剪图认不出是谁，按保留期限处理）。
  deleted['tongue-crops'] = await dropRows(store, 'tongue-crops', (_key, value) => {
    const crop = value as { at?: unknown }
    return !olderThan(crop?.at, cutoff)
  })
  // 学生端收到的签名病历也按保留期限删；长期只留调养方案、作业规则与老师的改稿摘要。
  deleted['student-records'] = await dropRows(store, 'student-records', (_key, value) => {
    const record = value as { createdAt?: unknown }
    return !olderThan(record?.createdAt, cutoff)
  })
  // 病历删掉后，面诊照片索引与字节一并清掉，不留无主照片。
  const keptEvents = new Set((await store.list('student-records')).map(row => row.key))
  deleted['record-photo-index'] = await dropRows(store, 'record-photo-index', (_key, value) => {
    const index = value as { eventId?: unknown }
    return typeof index?.eventId === 'string' && keptEvents.has(index.eventId)
  })
  const keptPhotoKeys = new Set((await store.list('record-photo-index')).map(row => (row.value as { dataKey?: unknown })?.dataKey).filter((key): key is string => typeof key === 'string'))
  deleted['record-photos'] = await dropRows(store, 'record-photos', key => keptPhotoKeys.has(key))
  return deleted
}

/** 按保留期限删一次；role 由调用方给（本机设置里的身份角色）。 */
export async function runRetention(store: LocalStore, role: RetentionRole, options: { now?: Date; days?: number } = {}): Promise<RetentionResult> {
  const now = options.now ?? new Date()
  const days = options.days ?? (role === 'teacher' ? await loadRetentionDays(store) : effectiveRetentionDays(await listTeacherRetentions(store)))
  if (!validRetentionDays(days)) return EMPTY_RESULT(RETENTION_DEFAULT_DAYS)
  const cutoff = now.getTime() - days * DAY
  const deleted = role === 'teacher' ? await cleanTeacher(store, cutoff) : await cleanStudent(store, cutoff)
  deleted['agent-runs'] = await dropRows(store, 'agent-runs', (_key, value) => !olderThan((value as { at?: unknown })?.at, cutoff))
  return { days, deleted }
}

/** 打开应用时每天只跑一次；返回是否真的跑了。 */
export async function runRetentionOnce(store: LocalStore, role: RetentionRole, options: { now?: Date; days?: number } = {}): Promise<RetentionResult | null> {
  const now = options.now ?? new Date()
  const today = localDay(now)
  const last = await store.get('settings', LAST_RETENTION_DAY_SETTING)
  if (last === today) return null
  const result = await runRetention(store, role, { ...options, now })
  await store.put('settings', LAST_RETENTION_DAY_SETTING, today as unknown as StoreValue)
  return result
}

// 老师改保留期限后，把新设置发给认得的每一位学生（学生端据此滚动删除）。
export async function publishRetentionDays(store: LocalStore, teacher: string, days: number, send: (recipient: string, envelope: Envelope) => Promise<unknown>): Promise<number> {
  await saveRetentionDays(store, days)
  const students = await teacherContactStudents(store)
  await sendRetentionSetting(send, teacher, days, students)
  return students.length
}
