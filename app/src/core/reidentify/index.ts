import type { LocalStore, StoreValue } from '../store'
import type { Envelope } from '../transport'
import { backupEnvelope, ownBackupsForTeacher, recordsForBackup } from '../records/backup'
import { listTeacherRecords, rememberTeacherStudent, TEACHER_STUDENTS } from '../records/teacher'
import { loadTeachers, saveTeachers } from '../inbox'
import { saveIdentityLink } from '../identity/links'
import { teacherLabel, type TeacherLabels } from '../identity/teacher-labels'
import {
  confirmEnvelope, dropReidentifyRequest, requestEnvelope, rejectEnvelope,
  validReidentifyAlias, type PendingReidentifyRequest,
} from './messages'

export * from './messages'

// V2-07 换手机认回的流程层：只做本机状态 + 现有传递层发送，不新增传输方式。
// 老师换手机的通知由“换机找回链接”承担（老师手动发一次），不再单独加一种广播消息。
export type SendEnvelope = (recipient: string, envelope: Envelope) => Promise<unknown>

const HEX64 = /^[0-9a-f]{64}$/
const REIDENTIFY_REQUEST_AT = 'reidentify-request-at'

export interface StudentCandidate { student: string; alias: string | null }

export interface TeacherChoice { key: string; label: string }

// 学生端“旧老师换了手机”选择：只有一位老师时可以默认选中；两位以上必须手动选，
// 除非找回链接里的称呼与本机记的某一位老师称呼一致（仍要把选中的人显示出来）。
export function teacherChoices(teachers: readonly string[], labels: TeacherLabels = {}, linkName = ''): { choices: TeacherChoice[]; selected: string } {
  const choices = teachers.map(key => ({ key, label: teacherLabel(labels, key) }))
  if (choices.length === 1) return { choices, selected: choices[0].key }
  const name = typeof linkName === 'string' ? linkName.trim() : ''
  const matched = name === '' ? [] : choices.filter(choice => labels[choice.key]?.trim() === name)
  return { choices, selected: matched.length === 1 ? matched[0].key : '' }
}

/** 未选中任何旧老师时“是”不可点。 */
export function canConfirmTeacherReidentify(selected: string): boolean {
  return typeof selected === 'string' && HEX64.test(selected)
}

/** 学生换机：新身份向老师发“我是原来的某某”。 */
export async function sendStudentReidentifyRequest(
  store: Pick<LocalStore, 'put'>,
  teacher: string,
  alias: string,
  send: SendEnvelope,
): Promise<void> {
  if (!HEX64.test(teacher)) throw new Error('老师公钥无效')
  if (!validReidentifyAlias(alias)) throw new Error('称呼需要 1 至 12 个字')
  await send(teacher, requestEnvelope(alias))
  await store.put('settings', REIDENTIFY_REQUEST_AT, new Date().toISOString() as unknown as StoreValue)
}

/** 老师端可选的旧学生（公钥 + 称呼）；只读名单与医案里的称呼。 */
export async function teacherStudentCandidates(store: LocalStore): Promise<StudentCandidate[]> {
  const aliases = new Map<string, string>()
  for (const record of await listTeacherRecords(store)) {
    const alias = record.encounter.profile.alias.value
    if (typeof alias === 'string' && alias.trim() !== '') aliases.set(record.student, alias.trim())
  }
  const students = new Set<string>()
  for (const record of await listTeacherRecords(store)) {
    if (HEX64.test(record.student)) students.add(record.student)
  }
  for (const row of await store.list(TEACHER_STUDENTS)) {
    const value = row.value as { student?: unknown } | undefined
    const student = typeof value?.student === 'string' ? value.student : row.key
    if (typeof student === 'string' && HEX64.test(student)) students.add(student)
  }
  return [...students].sort().map(student => ({ student, alias: aliases.get(student) ?? null }))
}

/** 称呼唯一匹配才预选；重名或没有匹配返回 null，由老师自己选。 */
export function matchCandidate(candidates: readonly StudentCandidate[], alias: string): StudentCandidate | null {
  const value = typeof alias === 'string' ? alias.trim() : ''
  if (value === '') return null
  const matches = candidates.filter(candidate => candidate.alias === value)
  return matches.length === 1 ? matches[0] : null
}

/** 老师点“是”：确认旧学生 → 新学生，再把保留期内的记录回发给新学生。 */
export async function confirmStudentReidentify(options: {
  store: LocalStore
  request: PendingReidentifyRequest
  oldStudent: string
  newStudent: string
  send: SendEnvelope
}): Promise<{ records: number }> {
  const { store, request, oldStudent, newStudent, send } = options
  if (!HEX64.test(oldStudent) || !HEX64.test(newStudent) || oldStudent === newStudent) throw new Error('换机关系公钥无效')
  if (request.student !== newStudent) throw new Error('请求不是这位新学生')
  if (!validReidentifyAlias(request.alias)) throw new Error('请求里的称呼无效')
  const records = await recordsForBackup(store, oldStudent)
  // 先发确认、再发记录：学生收到确认后才会按“老师确认过的换机关系”收旧公钥名下的病历。
  await send(newStudent, confirmEnvelope('student', oldStudent, newStudent))
  for (const record of records) await send(newStudent, backupEnvelope(record.event))
  await saveIdentityLink(store, 'student', oldStudent, newStudent)
  await store.delete(TEACHER_STUDENTS, oldStudent)
  await rememberTeacherStudent(store, newStudent)
  await dropReidentifyRequest(store, newStudent)
  return { records: records.length }
}

/** 老师点“不是”：请求作废，只回一条作废通知，名单和记录都不改、不发。 */
export async function rejectStudentReidentify(options: {
  store: LocalStore
  request: PendingReidentifyRequest
  send: SendEnvelope
}): Promise<void> {
  await options.send(options.request.student, rejectEnvelope('student'))
  await dropReidentifyRequest(options.store, options.request.student)
}

/** 学生点“是”：把旧老师换成新老师，并把手里的病历回发给新老师。 */
export async function confirmTeacherReidentify(options: {
  store: LocalStore
  oldTeacher: string
  newTeacher: string
  events: readonly unknown[]
  send: SendEnvelope
}): Promise<{ records: number; teachers: string[] }> {
  const { store, oldTeacher, newTeacher, send } = options
  if (!HEX64.test(oldTeacher) || !HEX64.test(newTeacher) || oldTeacher === newTeacher) throw new Error('换机关系公钥无效')
  const teachers = await loadTeachers(store)
  if (!teachers.includes(oldTeacher)) throw new Error('本机没有这位旧老师')
  const next = teachers.map(teacher => teacher === oldTeacher ? newTeacher : teacher)
  await saveTeachers(store, next)
  await saveIdentityLink(store, 'teacher', oldTeacher, newTeacher)
  await send(newTeacher, confirmEnvelope('teacher', oldTeacher, newTeacher))
  const events = options.events.map(event => {
    if (typeof event !== 'string') return event
    try { return JSON.parse(event) as unknown } catch { return null }
  }).filter(event => event !== null)
  const backups = ownBackupsForTeacher(events, oldTeacher)
  for (const event of backups) await send(newTeacher, backupEnvelope(event))
  return { records: backups.length, teachers: next }
}
