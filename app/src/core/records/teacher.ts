import { getEventHash, verifyEvent } from 'nostr-tools/pure'
import type { StoreValue } from '../store'
import type { DraftCase } from '../drafting/cases'
import { nextVersion, SIGNED_ENCOUNTER_KIND, type SignedEncounterEvent } from '../record/sign'
import type { Encounter } from '../record/types'
import { listIdentityLinks } from '../identity/links'

// V2-05 第 0 步：老师端签字发送成功后，把完整签名病历存进 teacher-records。
// 学生索引、起草时的医案检索、改方的 previousOf、康币扣费的 recordHash 都从这一个集合读。
// 第二版不再要求去标识：集合里就是完整病历（加密由传递层负责，本机不加密）。
export const TEACHER_RECORDS = 'teacher-records'
/** 老师认得的学生的公钥名单（不含病历内容）；换手机后要靠它逐个向学生要回病历。 */
export const TEACHER_STUDENTS = 'teacher-students'

export interface TeacherRecord {
  eventId: string
  encounterId: string
  version: number
  student: string
  createdAt: string
  eventJson: string
}

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

/** 只读集合即可（老师端读医案的地方有些是精简 store）。 */
export interface RecordReader {
  list(collection: string): Promise<{ key: string; value: unknown }[]>
}

/** 精简写入接口：面诊测试用内存 store 也能落医案。 */
export interface RecordWriter {
  put(collection: string, key: string, value: unknown): Promise<void>
}

export interface RecordStoreLike extends RecordReader, RecordWriter {
  get(collection: string, key: string): Promise<unknown>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRecordEvent(value: unknown): SignedEncounterEvent | null {
  if (!object(value)) return null
  if (typeof value.id !== 'string' || !HEX64.test(value.id)) return null
  if (typeof value.pubkey !== 'string' || !HEX64.test(value.pubkey)) return null
  if (typeof value.sig !== 'string' || typeof value.content !== 'string') return null
  if (!Number.isSafeInteger(value.created_at) || value.kind !== SIGNED_ENCOUNTER_KIND || !Array.isArray(value.tags)) return null
  const tags = value.tags.filter((tag): tag is string[] => Array.isArray(tag) && tag.every(item => typeof item === 'string'))
  if (tags.length !== value.tags.length) return null
  return { id: value.id, pubkey: value.pubkey, created_at: value.created_at as number, kind: SIGNED_ENCOUNTER_KIND, tags, content: value.content, sig: value.sig }
}

// 老师端自己存的病历：只接受自己签的（签名人 = 本机身份）、结构化字段完整的事件。
// 学生回发的备份也走这里，所以必须重算 id、验签（E-004）并核对 p 标签。
export function teacherRecordValue(event: SignedEncounterEvent): TeacherRecord | null {
  if (!event || !HEX64.test(event.pubkey)) return null
  let encounter: Encounter
  try { encounter = JSON.parse(event.content) as Encounter } catch { return null }
  if (!object(encounter) || typeof encounter.id !== 'string' || !HEX32.test(encounter.id)) return null
  if (!Number.isSafeInteger(encounter.version) || (encounter.version as number) < 1) return null
  if (typeof encounter.student !== 'string' || !HEX64.test(encounter.student)) return null
  if (typeof encounter.createdAt !== 'string' || !Number.isFinite(Date.parse(encounter.createdAt))) return null
  if (encounter.teacher !== event.pubkey) return null
  const pTag = event.tags.find(tag => tag[0] === 'p')?.[1]
  if (pTag !== encounter.student) return null
  const encounterTag = event.tags.find(tag => tag[0] === 'encounter')
  if (!encounterTag || encounterTag[1] !== encounter.id || encounterTag[2] !== String(encounter.version)) return null
  let idMatches = false
  try { idMatches = getEventHash(event) === event.id } catch { idMatches = false }
  if (!idMatches || !verifyEvent(event)) return null
  return {
    eventId: event.id,
    encounterId: encounter.id,
    version: encounter.version,
    student: encounter.student,
    createdAt: encounter.createdAt,
    eventJson: JSON.stringify(event),
  }
}

// 签字发送成功后调用；同一事件重放只覆盖相同内容。
export async function saveTeacherRecord(store: RecordWriter, event: SignedEncounterEvent): Promise<TeacherRecord | null> {
  const record = teacherRecordValue(event)
  if (!record) return null
  await store.put(TEACHER_RECORDS, record.eventId, record as unknown as StoreValue)
  if (record.student) await store.put(TEACHER_STUDENTS, record.student, { student: record.student })
  return record
}

/** 老师认得的学生的名单（只存公钥，不含病历）；收到问诊或签字医案时自动登记。 */
export async function rememberTeacherStudent(store: RecordWriter, student: string): Promise<void> {
  if (typeof student !== 'string' || !HEX64.test(student)) return
  await store.put(TEACHER_STUDENTS, student, { student })
}

export interface LoadedTeacherRecord extends TeacherRecord {
  event: SignedEncounterEvent
  encounter: Encounter
}

function loaded(value: unknown): LoadedTeacherRecord | null {
  if (!object(value)) return null
  const base: TeacherRecord = {
    eventId: value.eventId as string,
    encounterId: value.encounterId as string,
    version: value.version as number,
    student: value.student as string,
    createdAt: value.createdAt as string,
    eventJson: value.eventJson as string,
  }
  if (typeof base.eventId !== 'string' || !HEX64.test(base.eventId)) return null
  if (typeof base.encounterId !== 'string' || !HEX32.test(base.encounterId)) return null
  if (!Number.isSafeInteger(base.version) || base.version < 1) return null
  if (typeof base.student !== 'string' || !HEX64.test(base.student)) return null
  if (typeof base.createdAt !== 'string' || !Number.isFinite(Date.parse(base.createdAt))) return null
  if (typeof base.eventJson !== 'string') return null
  let parsed: unknown
  try { parsed = JSON.parse(base.eventJson) } catch { return null }
  const event = parseRecordEvent(parsed)
  if (!event || event.id !== base.eventId) return null
  let encounter: Encounter
  try { encounter = JSON.parse(event.content) as Encounter } catch { return null }
  if (!object(encounter) || encounter.id !== base.encounterId) return null
  return { ...base, event, encounter }
}

// 老师端医案（完整病历），按创建时间倒序。
export async function listTeacherRecords(store: RecordReader): Promise<LoadedTeacherRecord[]> {
  const rows = await store.list(TEACHER_RECORDS)
  const result: LoadedTeacherRecord[] = []
  for (const row of rows) {
    const record = loaded(row.value)
    if (record) result.push(record)
  }
  return result.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.version - left.version)
}

export async function teacherRecordsOf(store: RecordReader, student: string): Promise<LoadedTeacherRecord[]> {
  return (await listTeacherRecords(store)).filter(record => record.student === student)
}

// V2-07：换机关系把旧学生公钥显示成新公钥，名单里不重复出现同一个人。
async function canonicalStudents(store: RecordReader, students: Iterable<string>): Promise<string[]> {
  const links = await listIdentityLinks(store)
  const mapped = new Map(links.filter(link => link.kind === 'student').map(link => [link.oldKey, link.newKey]))
  const result = new Set<string>()
  for (const student of students) {
    if (typeof student !== 'string' || !HEX64.test(student)) continue
    result.add(mapped.get(student) ?? student)
  }
  return [...result].sort()
}

// 面诊“已有学生”索引：从 teacher-records 读（按学生公钥去重），名单集合只作补充（医案丢失后仍认得学生）。
export async function teacherStudents(store: RecordReader): Promise<string[]> {
  const students = new Set((await listTeacherRecords(store)).map(record => record.student))
  for (const row of await store.list(TEACHER_STUDENTS)) {
    const value = row.value as { student?: unknown } | undefined
    const student = typeof value?.student === 'string' ? value.student : row.key
    if (typeof student === 'string' && HEX64.test(student)) students.add(student)
  }
  return canonicalStudents(store, students)
}

// 起草时的医案检索：把老师本机完整病历投影成只读 DraftCase（不含学生身份），id 用签名事件 id。
export async function teacherCases(store: RecordReader): Promise<DraftCase[]> {
  return (await listTeacherRecords(store)).map(record => ({
    id: record.eventId,
    symptomSummary: record.encounter.judgment.symptomSummary.value ?? '',
    pattern: record.encounter.judgment.pattern.value ?? '',
  }))
}

// 同一份病历的最近一份（按版本号）。
export async function latestTeacherRecord(store: RecordReader, encounterId: string): Promise<LoadedTeacherRecord | null> {
  const rows = (await listTeacherRecords(store)).filter(record => record.encounterId === encounterId)
  if (rows.length === 0) return null
  return rows.sort((left, right) => right.version - left.version)[0]
}

// 改方：从 teacher-records 取出上一版签名事件 id，生成下一版病历。
// 方子改了就把 previousOf 指向旧版事件 id（病历格式里的改方引用）。
export function revisedEncounter(previous: Encounter, previousEventId: string, updates: {
  createdAt?: string
  judgment?: Encounter['judgment']
  plan?: Encounter['plan']
  outcome?: Encounter['outcome']
  changeReason?: string
} = {}): Encounter {
  const next = nextVersion(previous, previousEventId, updates)
  const prescription = next.plan.prescription.value
  if (prescription && previous.plan.prescription.value && JSON.stringify(prescription) !== JSON.stringify(previous.plan.prescription.value)) {
    next.plan.prescription = {
      ...next.plan.prescription,
      value: { ...prescription, previousOf: previousEventId, changeReason: updates.changeReason ?? prescription.changeReason ?? '改方' },
    }
  }
  return next
}

// 按本机账本、问诊包、医案能认得的学生集合（老师端用于回发备份与下发保留期限）。
// 数据全清后这里也会为空：第二版没有身份恢复，名单无法凭空找回（在 PR 里说明）。
export async function teacherContactStudents(store: RecordReader): Promise<string[]> {
  const students = new Set(await teacherStudents(store))
  for (const collection of ['consult-package', 'in-person-draft']) {
    for (const row of await store.list(collection)) {
      const value = row.value as { sender?: unknown; student?: unknown; encounter?: { student?: unknown } } | undefined
      const student = value?.student ?? value?.encounter?.student ?? value?.sender
      if (typeof student === 'string' && HEX64.test(student)) students.add(student)
    }
  }
  for (const row of await store.list('ledger-index')) {
    const value = row.value as { teacher?: unknown; student?: unknown } | undefined
    if (typeof value?.student === 'string' && HEX64.test(value.student)) students.add(value.student)
  }
  return canonicalStudents(store, students)
}
