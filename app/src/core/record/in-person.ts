import { check, type RedFlagResult } from '../redflags'
import type { AttachmentRef, ConsultPackage, Encounter, Field } from './types'
import { signEncounter, type SignedEncounterIndex } from './sign'
import {
  RECORD_COLLECTIONS,
  UndeliveredError,
  completeSigning,
  retryHandover,
  type RecordStore,
  type SendSignedRecord,
} from './handover'

// M1-12 面诊记录：老师当面看诊时，在自己手机上新建 kind: 'in_person' 的病历。
// 主诉等 intake 由老师代录，这是病历格式第 3 节第 2 条的唯一例外（来源 teacher、note 为 in_person）；
// 起草、签字、诊毕即还全部复用 M1-10 的 drafting 与 M1-11 的 sign.ts / handover.ts，不另写一套。
export const IN_PERSON_COLLECTIONS = {
  draft: 'in-person-draft',
  outbox: 'record-outbox',
} as const

export const IN_PERSON_NOTE = 'in_person'
export const IN_PERSON_INTAKE_LABEL = '老师代录'
export const IN_PERSON_MAX_PHOTOS = 4

export const IN_PERSON_INTAKE_KEYS = ['chiefComplaint', 'presentIllness', 'history', 'medsAllergies'] as const
export type InPersonIntakeKey = (typeof IN_PERSON_INTAKE_KEYS)[number]

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function unknown<T>(): Field<T> {
  return { value: null, source: 'unknown' }
}

export interface StartInPersonOptions {
  teacher: string
  student: string
  now?: Date
  id?: string
}

// 新建面诊病历：老师与学学生公钥都必须是 64 位十六进制；其余字段先留未知，由老师现场代录。
export function startInPersonEncounter(options: StartInPersonOptions): Encounter {
  const { teacher, student } = options
  if (!HEX64.test(teacher) || !HEX64.test(student)) throw new Error('公钥格式无效')
  const id = options.id ?? randomHex(16)
  if (!HEX32.test(id)) throw new Error('病历 id 格式无效')
  return {
    id,
    version: 1,
    kind: 'in_person',
    student,
    teacher,
    createdAt: (options.now ?? new Date()).toISOString(),
    profile: {
      alias: unknown(),
      gender: unknown(),
      age: unknown(),
      bazi: unknown(),
      city: unknown(),
    },
    intake: {
      chiefComplaint: unknown(),
      presentIllness: unknown(),
      history: unknown(),
      medsAllergies: unknown(),
      attachments: [],
    },
    fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
    judgment: {
      symptomSummary: unknown(),
      pattern: unknown(),
      mechanism: unknown(),
      rationale: unknown(),
    },
    plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
  }
}

function assertInPerson(encounter: Encounter): void {
  if (!encounter || typeof encounter !== 'object' || encounter.kind !== 'in_person') throw new Error('不是面诊病历')
}

export interface InPersonIntakeResult {
  encounter: Encounter
  /** 命中的急症红线；只提示，不阻断老师继续记录（老师在现场判断）。 */
  redFlag: RedFlagResult | null
}

// 老师代录一项 intake。每次录入都过本地急症红线，但命中不阻断。
export function recordIntakeField(encounter: Encounter, key: InPersonIntakeKey, text: string): InPersonIntakeResult {
  assertInPerson(encounter)
  if (!IN_PERSON_INTAKE_KEYS.includes(key)) throw new Error('没有这个采集字段')
  if (typeof text !== 'string') throw new Error('录入内容无效')
  const value = text.trim()
  if (value.length > 2000) throw new Error('这一项太长了，请精简一下')
  const field: Field<string> = value === '' ? unknown() : { value, source: 'teacher', note: IN_PERSON_NOTE }
  const result = value === '' ? null : check(value)
  return {
    encounter: { ...encounter, intake: { ...encounter.intake, [key]: field } },
    redFlag: result && result.hit ? result : null,
  }
}

// 把已经处理过的照片（M1-09 photo.ts 的 AttachmentRef）加进面诊病历。
export function addInPersonPhoto(encounter: Encounter, ref: AttachmentRef): Encounter {
  assertInPerson(encounter)
  if (!ref || typeof ref.id !== 'string' || ref.id === '') throw new Error('附件格式无效')
  if (encounter.intake.attachments.length >= IN_PERSON_MAX_PHOTOS) {
    throw new Error('最多只能添加 ' + IN_PERSON_MAX_PHOTOS + ' 张照片')
  }
  if (encounter.intake.attachments.some(item => item.id === ref.id)) throw new Error('这张照片已经加过了')
  return { ...encounter, intake: { ...encounter.intake, attachments: [...encounter.intake.attachments, { ...ref }] } }
}

export function removeInPersonPhoto(encounter: Encounter, refId: string): Encounter {
  assertInPerson(encounter)
  return { ...encounter, intake: { ...encounter.intake, attachments: encounter.intake.attachments.filter(item => item.id !== refId) } }
}

// 学生端展示时用：面诊里老师代录的 intake 字样要与学生本人陈述区分开。
export function intakeDisplayLabel(encounter: Encounter, key: InPersonIntakeKey): string {
  const item = encounter.intake?.[key]
  if (!item || item.value === null || item.value === '') return '未知'
  if (item.source === 'teacher' && item.note === IN_PERSON_NOTE) return IN_PERSON_INTAKE_LABEL
  if (item.source === 'student') return '学生陈述'
  if (item.source === 'teacher') return '老师判断'
  return '未知'
}

// 复用 M1-10 起草：把面诊病历转成 ConsultPackage 形状（不带历史病历；附件元数据保留）。
export function inPersonConsultPackage(
  encounter: Encounter,
  attachments: readonly { ref: AttachmentRef; data: Uint8Array }[] = [],
): ConsultPackage {
  assertInPerson(encounter)
  return {
    encounter: structuredClone(encounter),
    history: [],
    attachments: attachments.map(item => ({ ref: { ...item.ref }, data: item.data })),
  }
}

// 老师端本地保存进行中的面诊草稿（含代录原文与附件索引），签字交还成功后删除。
export async function saveInPersonDraft(store: RecordStore, encounter: Encounter): Promise<void> {
  assertInPerson(encounter)
  await store.put(IN_PERSON_COLLECTIONS.draft, encounter.id, encounter)
}

function isInPersonDraft(value: unknown): value is Encounter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const encounter = value as Encounter
  return encounter.kind === 'in_person'
    && HEX32.test(encounter.id)
    && typeof encounter.createdAt === 'string'
    && typeof encounter.intake === 'object' && encounter.intake !== null
    && Array.isArray(encounter.intake.attachments)
}

export async function loadInPersonDraft(store: RecordStore): Promise<Encounter | null> {
  const rows = await store.list(IN_PERSON_COLLECTIONS.draft)
  const drafts = rows.map(row => row.value).filter(isInPersonDraft)
  if (drafts.length === 0) return null
  drafts.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  return drafts[0]
}

export async function deleteInPersonDraft(store: RecordStore, encounterId: string): Promise<void> {
  await store.delete(IN_PERSON_COLLECTIONS.draft, encounterId)
}

// 老师已有的学生索引（signed-encounters 只含公钥与时间），供新建面诊时选择。
export async function knownStudents(store: RecordStore): Promise<string[]> {
  const rows = await store.list(RECORD_COLLECTIONS.signedEncounters)
  const students = new Set<string>()
  for (const row of rows) {
    const value = row.value as { student?: unknown } | undefined
    if (value && typeof value.student === 'string' && HEX64.test(value.student)) students.add(value.student)
  }
  return [...students].sort()
}

// 未送达时抛出带签名事件 id 的错误，界面据此重发同一条签名事件（不重复签字）。
export class InPersonUndeliveredError extends UndeliveredError {
  readonly eventId: string
  constructor(eventId: string) {
    super()
    this.name = 'InPersonUndeliveredError'
    this.eventId = eventId
  }
}

export interface SignInPersonOptions {
  store: RecordStore
  encounter: Encounter
  draft: Encounter
  privateKey: Uint8Array
  send: SendSignedRecord
}

// 签字并交还：signEncounter + completeSigning（先送达再销毁问诊资料、写索引与医案），
// 成功后删除本机面诊草稿；发送失败时资料全部保留，只暂存签名事件。
export async function signAndHandoverInPerson(options: SignInPersonOptions): Promise<SignedEncounterIndex> {
  assertInPerson(options.encounter)
  const signed = signEncounter(options.encounter, options.privateKey)
  const attachmentIds = options.encounter.intake.attachments.map(item => item.id)
  try {
    const index = await completeSigning({
      store: options.store,
      encounter: options.encounter,
      draft: options.draft,
      signed,
      attachmentIds,
      send: options.send,
    })
    await deleteInPersonDraft(options.store, options.encounter.id)
    return index
  } catch (error) {
    if (error instanceof UndeliveredError) throw new InPersonUndeliveredError(signed.id)
    throw error
  }
}

// 重发暂存的签名病历；送达成功后才继续销毁与落库，并删除面诊草稿。
export async function retryInPersonHandover(
  store: RecordStore,
  eventId: string,
  send: SendSignedRecord,
): Promise<SignedEncounterIndex> {
  const index = await retryHandover(store, eventId, send)
  await deleteInPersonDraft(store, index.encounterId)
  return index
}
