import type { Identity } from '../identity'
import { parseTongueAbstract } from '../../../../domain/tcm/tongue'
import type { LocalStore, StoreValue } from '../store'
import type { Envelope, Message } from '../transport'
import type { ChainEventDraft } from '../ledger/types'
import { signEncounter, verifySignedEncounter, type SignedEncounterEvent } from '../record/sign'
import type { AttachmentRef, ConsultPackage, Encounter, Homework } from '../record/types'
import { CARE_PLAN_TYPE, parseSignedCarePlanEvent, storeCarePlan, verifySignedCarePlan } from '../careplan'
import { verifyFamilyProof } from '../family/proof'
import type { AdherenceReport } from '../adherence'
import { INTAKE_COLLECTIONS, type StoredPackage } from '../intake/session'
import { localDay } from '../homework/schedule'
import { isHeavenStamp } from '../heaven/stamp'
import type { HeavenStamp } from '../heaven/stamp'
import { parsePeriodObservation, type PeriodObservation } from '../../../../domain/tcm/observation'
import { saveTeacherRecord, rememberTeacherStudent } from '../records/teacher'
import { updateFingerprint } from '../records/fingerprint'
import { receiveRetentionSetting, RETENTION_TYPE } from '../records/retention'
import { listIdentityLinks, saveIdentityLink } from '../identity/links'
import {
  confirmEnvelope, familyResultEnvelope, loadTeacherConfirm, markReidentifyRejected, parseFamilyClaim, parseFamilyResult,
  parseReidentifyConfirm, parseReidentifyReject, parseReidentifyRequest,
  REIDENTIFY_CONFIRM, REIDENTIFY_FAMILY, REIDENTIFY_REJECT, REIDENTIFY_REQUEST,
  saveFamilyResult, saveReidentifyRequest, saveTeacherConfirm, validReidentifyAlias,
  teacherReidentifyOpenAt, teacherReidentifyWindowOpen,
  type FamilyCandidate, type FamilyMatched, type FamilyUnresolved,
} from '../reidentify/messages'
import {
  backupEnvelope, backupForTeacher, loadRole, MAX_BACKUP_RECORDS, recordsForBackup,
  RECORDS_BACKUP, RECORDS_PULL, RECORDS_REQUEST,
} from '../records/backup'
import { saveReceivedStorefront, STOREFRONT_TYPE, verifyStorefrontEvent } from '../storefront'

// M1-15a 串联：一个 createTransport 实例收到的信封按 type 分发给各模块。
// - consult.package / consult.attachment：老师端问诊箱与附件（照片单独一条，避免 2 MB 单条上限）。
// - record.signed：学生端验签后入库，并把作业写进 M1-13 集合。
// - homework.adherence：学生端把本周坚持率小结发给老师（M1-23a 第 5 条），只含数值、不含原文。
// - ledger.*：交给 createLedgerSync().receive；不认识的类型丢弃。
export const CONSULT_TYPES = { package: 'consult.package', attachment: 'consult.attachment' } as const
export const ADHERENCE_TYPE = 'homework.adherence'
export const ADHERENCE_COLLECTION = 'student-adherence'

export const INBOX_COLLECTIONS = {
  consult: 'consult-package',
  attachments: 'attachments',
  records: 'student-records',
  homework: 'homework',
  settings: 'settings',
} as const

// 学生端的“我的老师”白名单：只接受名单里的公钥签发的病历（病历格式第 3 节第 3 条）。
export const TEACHERS_SETTING_KEY = 'teachers'

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const REF_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_PHOTOS = 4
// V2-08：问诊包里除最多 4 张照片，还可能有最多 4 张舌象裁剪图（每份舌象一张）。
const MAX_ATTACHMENTS = MAX_PHOTOS + 4

export interface ConsultEnvelopePayload {
  encounter: Encounter
  history: string[]
  attachments: AttachmentRef[]
  /** 最近 14 天状态与压力走势（M1-19）：只给老师端看，不进 Encounter schema。 */
  trend?: { days: string[]; checkins: number[]; scores: (number | null)[]; stress: (number | null)[] }
  /** M1-22 传输元数据：家人代管问诊时是代管人（根身份）公钥。 */
  manager?: string
  /** M1-22 代管证明：代管人私钥签名的 kind 2732 小事件，老师端验过才认 manager。 */
  managerProof?: unknown
  /** V2-06：发送那一刻学生那边的天地人；签字病历原样沿用。 */
  heaven?: unknown
  /** V2-10：这段时间的计数与智能体那一句；不含本人感受、病历内容或照片。 */
  observation?: unknown
}

export interface AttachmentEnvelopePayload {
  encounterId: string
  ref: AttachmentRef
  data: string
}

export interface StoredConsult {
  encounter: Encounter
  /** 只保留验签通过、签名人为本人的历史病历。 */
  history: string[]
  attachments: AttachmentRef[]
  receivedAt: string
  sender: string
  droppedHistory: number
  /** 最近 14 天状态与压力走势（M1-19）：老师草稿卡片上显示一条小走势。 */
  trend?: { days: string[]; checkins: number[]; scores: (number | null)[]; stress: (number | null)[] } | null
  /** M1-22：家人代管问诊时为代管人公钥；一本账与回信都按它处理。 */
  manager?: string
  /** M1-22：带 manager 但代管证明没通过校验，老师端据此提示且不按代管扣费。 */
  managerInvalid?: boolean
  /** V2-06：学生发送时的天地人（时辰、节气、城市）；老师起草页显示，签字病历沿用。 */
  heaven?: HeavenStamp | null
  /** V2-10：这段时间的计数与智能体那句（只在签字时写进观察记录，签字前界面不显示）。 */
  observation?: PeriodObservation | null
}

export interface ConsultReadiness {
  consult: StoredConsult | null
  total: number
  arrived: number
  missing: string[]
  ready: boolean
}

export interface ReceivedRecord {
  event: SignedEncounterEvent
  encounter: Encounter
  teacher: string
}

export interface GroupedRecord {
  encounterId: string
  versions: ReceivedRecord[]
}

export type SendEnvelope = (recipient: string, envelope: Envelope) => Promise<unknown>

export interface LedgerRecorder {
  open?(teacher:string,student:string):Promise<unknown>
  record(teacher: string, student: string, draft: ChainEventDraft): Promise<unknown>
}

export interface InboxLedger {
  receive(message: Message): Promise<void>
  /** V2-07b：家人认回后自动携带旧钱账到新身份。 */
  open?(teacher: string, student: string): Promise<unknown>
  carryTo?(teacher: string, student: string, recipient: string): Promise<number>
}

export interface InboxOptions {
  identity: Identity
  store: LocalStore
  ledger?: InboxLedger
  send?: SendEnvelope
  now?: () => Date
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRef(value: unknown): value is AttachmentRef {
  if (!object(value)) return false
  return typeof value.id === 'string' && REF_ID.test(value.id)
    && (value.type === 'photo' || value.type === 'audio')
    && typeof value.sha256 === 'string' && HEX64.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0
}

function isEncounter(value: unknown): value is Encounter {
  if (!object(value) || !object(value.intake) || !object(value.plan) || !object(value.judgment) || !object(value.fourExams)) return false
  if (value.heaven !== undefined && !isHeavenStamp(value.heaven)) return false
  if(value.intake.tongues!==undefined) {
    if(!Array.isArray(value.intake.tongues)||value.intake.tongues.length>4)return false
    try {value.intake.tongues.forEach(parseTongueAbstract)} catch {return false}
  }
  return typeof value.id === 'string' && HEX32.test(value.id)
    && Number.isSafeInteger(value.version) && (value.version as number) >= 1
    && (value.kind === 'remote_async' || value.kind === 'in_person')
    && typeof value.student === 'string' && HEX64.test(value.student)
    && typeof value.teacher === 'string' && HEX64.test(value.teacher)
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && Array.isArray(value.intake.attachments) && value.intake.attachments.every(isRef)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value === '') throw new Error('附件编码无效')
  const binary = atob(value)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function normalizeTeachers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const teachers: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !HEX64.test(item) || teachers.includes(item)) continue
    teachers.push(item)
  }
  return teachers
}

// “我的老师”列表存在本机 settings 集合，键 `teachers`，值为 hex64 公钥数组（去重后保存）。
export async function loadTeachers(store: LocalStore): Promise<string[]> {
  const value = await store.get(INBOX_COLLECTIONS.settings, TEACHERS_SETTING_KEY)
  return normalizeTeachers(value)
}

export async function saveTeachers(store: LocalStore, teachers: readonly string[]): Promise<string[]> {
  const normalized = normalizeTeachers([...teachers])
  await store.put(INBOX_COLLECTIONS.settings, TEACHERS_SETTING_KEY, normalized as unknown as StoreValue)
  return normalized
}

export async function addTeacher(store: LocalStore, teacher: string): Promise<string[]> {
  if (typeof teacher !== 'string' || !HEX64.test(teacher)) throw new Error('老师公钥必须是 64 位十六进制')
  const teachers = await loadTeachers(store)
  if (teachers.includes(teacher)) return teachers
  return saveTeachers(store, [...teachers, teacher])
}

// V2-07：换手机后，“我的老师”名单换成新公钥，但旧公钥签的历史病历仍按换机关系认。
// 这个函数返回“当前白名单 + 由学生确认过的旧老师公钥”，用于收件过滤与病历验签。
async function historyTeachers(store: LocalStore): Promise<string[]> {
  const teachers = await loadTeachers(store)
  const links = await listIdentityLinks(store)
  const old = links.filter(link => link.kind === 'teacher' && teachers.includes(link.newKey)).map(link => link.oldKey)
  return [...new Set([...teachers, ...old])]
}

// 学生换机后，本机新公钥加上“老师确认过的旧学生公钥”，旧病历按它们验签。
async function studentKeys(store: LocalStore, identity: Identity): Promise<string[]> {
  const links = await listIdentityLinks(store)
  const old = links.filter(link => link.kind === 'student' && link.newKey === identity.publicKey).map(link => link.oldKey)
  return [...new Set([identity.publicKey, ...old])]
}

// 老师换手机后，学生手里由旧老师公钥签的病历按换机关系算作这位新老师名下。
function teacherLinkMatches(links: Awaited<ReturnType<typeof listIdentityLinks>>, teacher: string, sender: string): boolean {
  if (teacher === sender) return true
  return links.some(link => link.kind === 'teacher' && link.oldKey === teacher && link.newKey === sender)
}

export async function removeTeacher(store: LocalStore, teacher: string): Promise<string[]> {
  const teachers = await loadTeachers(store)
  return saveTeachers(store, teachers.filter(item => item !== teacher))
}

function parseSignedEvent(value: unknown): SignedEncounterEvent | null {
  if (!object(value)) return null
  if (typeof value.id !== 'string' || !HEX64.test(value.id)) return null
  if (typeof value.pubkey !== 'string' || !HEX64.test(value.pubkey)) return null
  if (typeof value.sig !== 'string' || typeof value.content !== 'string') return null
  if (!Number.isSafeInteger(value.created_at) || value.kind !== 2730 || !Array.isArray(value.tags)) return null
  const tags = value.tags.filter((tag): tag is string[] => Array.isArray(tag) && tag.every(item => typeof item === 'string'))
  if (tags.length !== value.tags.length) return null
  return { id: value.id, pubkey: value.pubkey, created_at: value.created_at as number, kind: 2730, tags, content: value.content, sig: value.sig }
}

function recordValue(value: unknown): { id: string; teacher: string; createdAt: string; eventJson: string; version: number } | null {
  if (!object(value)) return null
  if (typeof value.id !== 'string' || typeof value.teacher !== 'string' || !HEX64.test(value.teacher)) return null
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null
  if (typeof value.eventJson !== 'string' || value.eventJson === '') return null
  const version = Number.isSafeInteger(value.version) && (value.version as number) >= 1 ? value.version as number : 1
  return { id: value.id, teacher: value.teacher, createdAt: value.createdAt, eventJson: value.eventJson, version }
}

// 老师端起草前必须带上的问诊包（只有引用，不带照片字节）。
export function draftPackage(consult: StoredConsult): ConsultPackage {
  const heaven = consult.heaven ?? consult.encounter.heaven
  return {
    encounter: structuredClone(consult.encounter),
    history: [...consult.history],
    attachments: [],
    ...(heaven ? { heaven: { ...heaven } } : {}),
  }
}

// M1-22 一家一本账：只有代管证明验过的问诊才把扣费记到代管人那本账；
// 没有证明或证明无效时返回 undefined，调用方按发件人自己那本账处理。
export function consultChargeBook(consult: StoredConsult): { student: string; forMember?: string } | undefined {
  if (!consult.manager || consult.managerInvalid) return undefined
  const forMember = consult.encounter.profile.alias.value ?? undefined
  return forMember === undefined ? { student: consult.manager } : { student: consult.manager, forMember }
}

export function consultEnvelope(pkg: ConsultPackage): Envelope {
  return {
    type: CONSULT_TYPES.package,
    version: 1,
    payload: {
      encounter: structuredClone(pkg.encounter),
      history: [...pkg.history],
      attachments: pkg.attachments.map(item => ({ ...item.ref })),
      ...(pkg.trend ? { trend: pkg.trend } : {}),
      ...(pkg.manager ? { manager: pkg.manager } : {}),
      ...(pkg.managerProof ? { managerProof: structuredClone(pkg.managerProof) } : {}),
      ...((pkg.heaven ?? pkg.encounter.heaven) ? { heaven: structuredClone(pkg.heaven ?? pkg.encounter.heaven) } : {}),
      ...(pkg.observation ? { observation: structuredClone(pkg.observation) } : {}),
    } satisfies ConsultEnvelopePayload,
  }
}

export function attachmentEnvelope(encounterId: string, ref: AttachmentRef, data: Uint8Array): Envelope {
  return { type: CONSULT_TYPES.attachment, version: 1, payload: { encounterId, ref: { ...ref }, data: toBase64(data) } satisfies AttachmentEnvelopePayload }
}

// M1-23a：学生端把“本周坚持率”小结发给老师。只有数值（周起始、完成率、连续天数、本周练习天数、条数），
// 不含作业原文、身份或打卡时间；老师端按发件人覆盖保存最新一周。
export interface StudentAdherence {
  student: string
  weekStart: string
  weeklyRate: number | null
  streak: number
  practiceDays: number
  scheduled: number
  done: number
  forMember?: string
  receivedAt: string
}

export function adherenceEnvelope(report: AdherenceReport): Envelope {
  return {
    type: ADHERENCE_TYPE,
    version: 1,
    payload: {
      weekStart: report.weekStart,
      weeklyRate: report.weeklyRate,
      streak: report.streak,
      practiceDays: report.practiceDays,
      scheduled: report.scheduled,
      done: report.done,
    },
  }
}

function parseAdherence(payload: Record<string, unknown>): Omit<StudentAdherence, 'student' | 'receivedAt'> | null {
  const weekStart = payload.weekStart
  if (typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null
  const parsed = new Date(weekStart + 'T00:00:00Z')
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== weekStart) return null
  const weeklyRate = payload.weeklyRate
  if (!(weeklyRate === null || (typeof weeklyRate === 'number' && Number.isFinite(weeklyRate) && weeklyRate >= 0 && weeklyRate <= 1))) return null
  const counts = ['streak', 'practiceDays', 'scheduled', 'done'] as const
  for (const key of counts) {
    const value = payload[key]
    if (!Number.isSafeInteger(value) || (value as number) < 0) return null
  }
  if ((payload.done as number) > (payload.scheduled as number)) return null
  if ((payload.practiceDays as number) > 7) return null
  const forMember = payload.forMember
  if (forMember !== undefined && (typeof forMember !== 'string' || forMember.trim() === '' || forMember.length > 12 || /[\u0000-\u001f\u007f]/.test(forMember))) return null
  return {
    weekStart,
    weeklyRate: weeklyRate as number | null,
    streak: payload.streak as number,
    practiceDays: payload.practiceDays as number,
    scheduled: payload.scheduled as number,
    done: payload.done as number,
    ...(forMember === undefined ? {} : { forMember }),
  }
}

async function receiveAdherence(store: LocalStore, message: Message, payload: Record<string, unknown>): Promise<void> {
  const report = parseAdherence(payload)
  if (!report) return
  const existing = await store.get(ADHERENCE_COLLECTION, message.sender) as unknown as StudentAdherence | undefined
  // 旧周小结迟到时不要覆盖新周。
  if (existing && existing.weekStart > report.weekStart) return
  const stored: StudentAdherence = { student: message.sender, ...report, receivedAt: new Date().toISOString() }
  await store.put(ADHERENCE_COLLECTION, message.sender, stored as unknown as StoreValue)
  // V2-12：学生连上社区就会发这条数值小结；老师因此认得这位学生，钱账页才能列出来首次记账。
  if (await loadRole(store) === 'teacher') await rememberTeacherStudent(store, message.sender)
}

export async function listStudentAdherence(store: LocalStore): Promise<StudentAdherence[]> {
  const rows = await store.list(ADHERENCE_COLLECTION)
  const result: StudentAdherence[] = []
  for (const row of rows) {
    const value = row.value as unknown as StudentAdherence | undefined
    if (!value || typeof value !== 'object') continue
    if (typeof value.student !== 'string' || !HEX64.test(value.student)) continue
    const parsed = parseAdherence(value as unknown as Record<string, unknown>)
    if (!parsed || typeof value.receivedAt !== 'string') continue
    result.push({ student: value.student, ...parsed, receivedAt: value.receivedAt })
  }
  return result
}

// 学生发送：先发问诊包（只带 AttachmentRef），再每张照片单独一条，避免超过单条 2 MB。
// 全部发送成功后，把这位老师加入“我的老师”白名单（发送失败不加入）。
export async function sendConsultPackage(send: SendEnvelope, pkg: ConsultPackage, options: { store?: LocalStore } = {}): Promise<void> {
  const teacher = pkg.encounter.teacher
  await send(teacher, consultEnvelope(pkg))
  for (const item of pkg.attachments) await send(teacher, attachmentEnvelope(pkg.encounter.id, item.ref, item.data))
  if (options.store) await addTeacher(options.store, teacher)
}

export async function listConsults(store: LocalStore): Promise<StoredConsult[]> {
  const rows = await store.list(INBOX_COLLECTIONS.consult)
  const consults: StoredConsult[] = []
  for (const row of rows) {
    const value = row.value as unknown
    if (!object(value)) continue
    if (!isEncounter(value.encounter) || typeof value.sender !== 'string') continue
    if (!Array.isArray(value.attachments) || !value.attachments.every(isRef)) continue
    if (!Array.isArray(value.history) || !value.history.every(item => typeof item === 'string')) continue
    consults.push(value as unknown as StoredConsult)
  }
  return consults.sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
}

// V2-18：老师收件箱只按学生提交问诊的时间排，不按急症或任何关键词置顶；同一时间按病历 id 稳定排序。
export function sortConsultsBySubmittedAt(consults: readonly StoredConsult[]): StoredConsult[] {
  const submittedAt = (consult: StoredConsult): number => {
    const value = Date.parse(consult.encounter.createdAt)
    return Number.isFinite(value) ? value : 0
  }
  return [...consults].sort((left, right) =>
    submittedAt(left) - submittedAt(right) || left.encounter.id.localeCompare(right.encounter.id))
}

export async function consultReadiness(store: LocalStore, encounterId: string): Promise<ConsultReadiness> {
  const consult = await store.get(INBOX_COLLECTIONS.consult, encounterId) as unknown as StoredConsult | undefined
  if (!consult) return { consult: null, total: 0, arrived: 0, missing: [], ready: false }
  let arrived = 0
  const missing: string[] = []
  for (const ref of consult.attachments) {
    if (await store.get(INBOX_COLLECTIONS.attachments, ref.id) !== undefined) arrived += 1
    else missing.push(ref.id)
  }
  return { consult, total: consult.attachments.length, arrived, missing, ready: missing.length === 0 }
}

// 照片到齐才能起草；缺照片时界面显示“照片还在路上”。
export async function assertConsultReady(store: LocalStore, encounterId: string): Promise<StoredConsult> {
  const status = await consultReadiness(store, encounterId)
  if (!status.consult) throw new Error('还没有收到这份问诊')
  if (!status.ready) throw new Error('附件还在路上，等附件到齐再起草')
  return status.consult
}

function validHistory(consultPayload: ConsultEnvelopePayload, identity: Identity): { history: string[]; dropped: number } {
  let dropped = 0
  const history: string[] = []
  for (const raw of consultPayload.history) {
    if (typeof raw !== 'string') { dropped += 1; continue }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { dropped += 1; continue }
    const event = parseSignedEvent(parsed)
    if (!event) { dropped += 1; continue }
    try {
      verifySignedEncounter(event, { student: consultPayload.encounter.student, teacher: identity.publicKey })
      history.push(raw)
    } catch { dropped += 1 }
  }
  return { history, dropped }
}

async function importHomework(store: LocalStore, encounter: Encounter, now: () => Date): Promise<void> {
  const rows = await store.list(INBOX_COLLECTIONS.homework)
  let maxVersion = -1
  for (const row of rows) {
    const value = row.value
    if (!object(value) || value.encounterId !== encounter.id) continue
    const version = Number.isSafeInteger(value.version) ? value.version as number : 0
    if (version > maxVersion) maxVersion = version
  }
  // 旧版本迟到时不覆盖新版本作业。
  if (encounter.version < maxVersion) return
  for (const row of rows) {
    const value = row.value
    if (object(value) && value.encounterId === encounter.id) await store.delete(INBOX_COLLECTIONS.homework, row.key)
  }
  const startsOn = localDay(now())
  for (const homework of encounter.plan.homework) {
    await store.put(INBOX_COLLECTIONS.homework, crypto.randomUUID(), {
      homework: structuredClone(homework) satisfies Homework,
      startsOn,
      encounterId: encounter.id,
      version: encounter.version,
    } as unknown as StoreValue)
  }
}

async function receiveConsult(identity: Identity, store: LocalStore, message: Message, payload: Record<string, unknown>): Promise<void> {
  const value = payload as unknown as ConsultEnvelopePayload
  if (!isEncounter(value.encounter)) return
  if (value.encounter.teacher !== identity.publicKey) return
  if (value.encounter.student !== message.sender) return
  // 家人代管问诊时带代管人公钥；格式不对就整包丢弃，避免账本记到错误的书上。
  if (value.manager !== undefined && (typeof value.manager !== 'string' || !HEX64.test(value.manager) || value.manager === value.encounter.student)) return
  // 代管人必须有代管证明（代管人私钥签的 kind 2732，p 标签指向家人且家人就是发件人）。
  // 证明不通过时保留问诊但标 managerInvalid：老师端提示“代管证明无效”，扣费回落到发件人自己那本账。
  let manager: string | undefined
  let managerInvalid = false
  if (value.manager !== undefined) {
    try {
      verifyFamilyProof(value.managerProof, { manager: value.manager, member: value.encounter.student, sender: message.sender })
      manager = value.manager
    } catch { managerInvalid = true }
  }
  // 已交还的问诊包不再从老师端删除；中继重放同一问诊包只会覆盖为相同内容。
  if (!Array.isArray(value.attachments) || value.attachments.length > MAX_ATTACHMENTS || !value.attachments.every(isRef)) return
  const history = Array.isArray(value.history) ? value.history : []
  const checked = validHistory({ ...value, history }, identity)
  // V2-18：旧版本问诊包可能还带着旧标记字段；照常收下，忽略它，不写入本机也不展示。
  const trendRaw = value.trend as unknown
  const trend = typeof trendRaw === 'object' && trendRaw !== null && !Array.isArray(trendRaw)
    && Array.isArray((trendRaw as { days?: unknown }).days) && Array.isArray((trendRaw as { scores?: unknown }).scores) && Array.isArray((trendRaw as { stress?: unknown }).stress)
    ? {
      days: (trendRaw as { days: string[] }).days.filter(day => typeof day === 'string'),
      checkins: Array.isArray((trendRaw as { checkins?: unknown }).checkins) ? (trendRaw as { checkins: number[] }).checkins : [],
      scores: (trendRaw as { scores: (number | null)[] }).scores,
      stress: (trendRaw as { stress: (number | null)[] }).stress,
    }
    : null
  // V2-06：天地人（时辰、节气、城市）。格式不对就整包丢弃；缺了照常收（旧格式）。
  const heavenRaw = value.heaven ?? value.encounter.heaven
  if (heavenRaw !== undefined && !isHeavenStamp(heavenRaw)) return
  const heaven: HeavenStamp | undefined = heavenRaw
  // V2-10：观察周期元数据格式不对就忽略（不影响问诊本身）；签字前界面不显示智能体那句。
  const observation = parsePeriodObservation(value.observation)
  const stored: StoredConsult = {
    encounter: heaven && !value.encounter.heaven ? { ...value.encounter, heaven: { ...heaven } } : value.encounter,
    history: checked.history,
    attachments: value.attachments.map(ref => ({ ...ref })),
    receivedAt: new Date().toISOString(),
    sender: message.sender,
    droppedHistory: checked.dropped,
    ...(trend ? { trend } : {}),
    ...(heaven ? { heaven: { ...heaven } } : {}),
    ...(manager ? { manager } : {}),
    ...(managerInvalid ? { managerInvalid: true } : {}),
    ...(observation ? { observation } : {}),
  }
  await store.put(INBOX_COLLECTIONS.consult, value.encounter.id, stored as unknown as StoreValue)
  // V2-05：老师认得的学生的名单（只存公钥；换手机后靠它逐个向学生要回病历）。
  await rememberTeacherStudent(store, value.encounter.student)
}

async function receiveAttachment(store: LocalStore, message: Message, payload: Record<string, unknown>, identity: Identity): Promise<void> {
  const value = payload as unknown as AttachmentEnvelopePayload
  if (typeof value.encounterId !== 'string' || !isRef(value.ref) || typeof value.data !== 'string') return
  const stored = await store.get(INBOX_COLLECTIONS.consult, value.encounterId) as unknown as StoredConsult | undefined
  if (!stored || message.sender !== stored.sender || stored.encounter.teacher !== identity.publicKey) return
  const expected = stored.attachments.find(ref => ref.id === value.ref.id)
  if (!expected) return
  // 按 id + sha256 核对；再现场重算一遍，内容不符就丢弃。
  if (expected.sha256 !== value.ref.sha256 || expected.bytes !== value.ref.bytes || expected.type !== value.ref.type) return
  let data: Uint8Array
  try { data = fromBase64(value.data) } catch { return }
  if (data.length !== expected.bytes) return
  if (await sha256Hex(data) !== expected.sha256) return
  await store.put(INBOX_COLLECTIONS.attachments, expected.id, data)
}

async function receiveSignedRecord(identity: Identity, store: LocalStore, message: Message, payload: unknown, now: () => Date): Promise<void> {
  // 学生端只认“我的老师”名单：陌生成员发来的签名病历直接丢弃，验签和写库之前就拦住。
  // V2-07：名单换成新公钥后，旧公钥仍按换机关系收历史病历；旧学生公钥名下的病历也按老师确认过的关系验签。
  if (!(await historyTeachers(store)).includes(message.sender)) return
  const event = parseSignedEvent(payload)
  if (!event) return
  let encounter: Encounter | null = null
  for (const student of await studentKeys(store, identity)) {
    try {
      encounter = verifySignedEncounter(event, { student, teacher: message.sender })
      break
    } catch { /* 试下一个换机前的旧学生公钥 */ }
  }
  if (!encounter) return
  const existing = await store.get(INBOX_COLLECTIONS.records, event.id)
  if (existing === undefined) {
    await store.put(INBOX_COLLECTIONS.records, event.id, {
      id: encounter.id,
      teacher: message.sender,
      createdAt: encounter.createdAt,
      eventJson: JSON.stringify(event),
      version: encounter.version,
    })
  }
  await importHomework(store, encounter, now)
}

// 学生端收调养方案：只认“我的老师”名单里的签名，验签通过后按版本替换旧版。
async function receiveCarePlan(identity: Identity, store: LocalStore, message: Message, payload: unknown): Promise<void> {
  if (!(await historyTeachers(store)).includes(message.sender)) return
  const event = parseSignedCarePlanEvent(payload)
  if (!event) return
  try {
    const plan = verifySignedCarePlan(event, { student: identity.publicKey, teacher: message.sender })
    await storeCarePlan(store, message.sender, plan)
  } catch { /* 验签失败或内容无效就丢弃。 */ }
}

// 面诊照片由老师手机产生；每张携带同一签名病历，乱序/离线重放也能独立核对归属与哈希。
export const RECORD_PHOTO_TYPE = 'record.attachment'
interface RecordPhotoIndex { eventId: string; refId: string; sha256: string; dataKey: string }
export async function sendInPersonRecord(store: LocalStore, send: SendEnvelope, student: string, signed: SignedEncounterEvent): Promise<void> {
  const event = parseSignedEvent(signed)
  if (!event) throw Error('签名病历无效')
  const encounter = verifySignedEncounter(event, { teacher: event.pubkey, student })
  if (encounter.kind !== 'in_person') throw Error('不是面诊病历')
  const photos = []
  for (const ref of encounter.intake.attachments) {
    const data = await store.get(INBOX_COLLECTIONS.attachments, ref.id)
    if (ref.type !== 'photo' || !(data instanceof Uint8Array) || data.length !== ref.bytes || await sha256Hex(data) !== ref.sha256) {
      throw Error('照片缺失或校验失败，资料仍在本机，请检查后重发。')
    }
    photos.push({ refId: ref.id, data: toBase64(data) })
  }
  const clean = JSON.parse(JSON.stringify(event)) as SignedEncounterEvent
  await send(student, { type: 'record.signed', version: 1, payload: clean })
  for (const photo of photos) await send(student, { type: RECORD_PHOTO_TYPE, version: 1, payload: { event: clean, ...photo } })
}

// 调用方使用已验签 ReceivedRecord；读出时再次核对签名引用的长度与内容哈希。
export async function recordPhotos(store: LocalStore, record: ReceivedRecord): Promise<{ ref: AttachmentRef; data: Uint8Array }[]> {
  const rows = await store.list('record-photo-index')
  const photos: { ref: AttachmentRef; data: Uint8Array }[] = []
  for (const ref of record.encounter.intake.attachments.filter(item => item.type === 'photo')) {
    const found = rows.map(row => row.value as unknown as RecordPhotoIndex).find(row => row.eventId === record.event.id && row.refId === ref.id && row.sha256 === ref.sha256)
    const data = found ? await store.get('record-photos', found.dataKey) : await store.get(INTAKE_COLLECTIONS.attachmentData, ref.id)
    if (data instanceof Uint8Array && data.length === ref.bytes && await sha256Hex(data) === ref.sha256) photos.push({ ref, data })
  }
  return photos
}

async function receiveRecordPhoto(identity: Identity, store: LocalStore, message: Message, payload: unknown, now: () => Date): Promise<void> {
  if (!(await loadTeachers(store)).includes(message.sender) || !object(payload)) return
  const event = parseSignedEvent(payload.event)
  if (!event || typeof payload.refId !== 'string' || typeof payload.data !== 'string') return
  let encounter: Encounter
  try { encounter = verifySignedEncounter(event, { teacher: message.sender, student: identity.publicKey }) } catch { return }
  if (encounter.kind !== 'in_person') return
  const ref = encounter.intake.attachments.find(item => item.id === payload.refId)
  if (!ref || ref.type !== 'photo') return
  let bytes: Uint8Array
  try { bytes = fromBase64(payload.data) } catch { return }
  if (bytes.length !== ref.bytes || await sha256Hex(bytes) !== ref.sha256) return
  // 先有有效、绑定本人的签名；照片可以先于独立 record.signed 信封到达。
  if (await store.get(INBOX_COLLECTIONS.records, event.id) === undefined) await receiveSignedRecord(identity, store, message, event, now)
  const rows = await store.list('record-photo-index')
  const found = rows.find(row => {
    const value = row.value as unknown as RecordPhotoIndex
    return value.eventId === event.id && value.refId === ref.id
  })
  const previous = found?.value as unknown as RecordPhotoIndex | undefined
  const dataKey = previous?.dataKey ?? crypto.randomUUID()
  await store.put('record-photos', dataKey, bytes)
  try {
    await store.put('record-photo-index', found?.key ?? crypto.randomUUID(), { eventId: event.id, refId: ref.id, sha256: ref.sha256, dataKey })
  } catch (cause) {
    if (!previous) await store.delete('record-photos', dataKey).catch(() => {})
    throw cause
  }
}

// V2-07：换手机认回。请求只落到老师端待确认区，绝不自动改名单或发记录；
// 确认只写“旧公钥 → 新公钥”关系，之后的记录仍按 V2-05 的 records.backup 发送。
async function receiveReidentifyRequest(store: LocalStore, message: Message, payload: Record<string, unknown>): Promise<void> {
  if (await loadRole(store) !== 'teacher') return
  const parsed = parseReidentifyRequest(payload)
  if (!parsed) return
  await saveReidentifyRequest(store, message.sender, parsed.alias)
}

async function receiveReidentifyConfirm(identity: Identity, store: LocalStore, message: Message, payload: Record<string, unknown>): Promise<void> {
  const parsed = parseReidentifyConfirm(payload)
  if (!parsed || parsed.newKey !== identity.publicKey) return
  const role = await loadRole(store)
  if (parsed.purpose === 'student') {
    // 老师确认“旧学生 → 这位新学生”：只认“我的老师”名单里的发件人。
    // 家人分片没有单独设置角色，但同样有“我的老师”名单，所以这里不要求 role。
    if (!(await historyTeachers(store)).includes(message.sender)) return
    await saveIdentityLink(store, 'student', parsed.oldKey, parsed.newKey)
    return
  }
  // 学生确认“旧老师 → 这位新老师”：只有老师自己刚换手机（生成过找回链接、30 天内）才认；
  // 同一发件人第二次带不同旧公钥一律不认，防止反复改映射。
  if (role !== 'teacher') return
  if (!teacherReidentifyWindowOpen(await teacherReidentifyOpenAt(store))) return
  const previous = await loadTeacherConfirm(store, message.sender)
  if (previous && previous.oldKey !== parsed.oldKey) return
  await saveIdentityLink(store, 'teacher', parsed.oldKey, parsed.newKey)
  await saveTeacherConfirm(store, message.sender, parsed.oldKey)
  await rememberTeacherStudent(store, message.sender)
}

// V2-07b：家长/家人认回。老师只在这位发送者已被确认为某个旧管理人的新身份时处理，
// 并且只在“该旧管理人的旧家人集合”（consult-package.manager + 家人称呼）内按称呼匹配；
// 匹配上就自动写映射、发确认、回发保留期内记录并携带旧钱账，不再让老师逐个点“是”。
async function familyCandidatesFor(store: LocalStore, oldRoot: string): Promise<FamilyCandidate[]> {
  const byKey = new Map<string, string>()
  for (const row of await store.list('consult-package')) {
    const value = row.value as {
      manager?: unknown
      encounter?: { student?: unknown; profile?: { alias?: { value?: unknown } } }
    } | undefined
    if (!value || value.manager !== oldRoot) continue
    const student = value.encounter?.student
    const alias = value.encounter?.profile?.alias?.value
    if (typeof student !== 'string' || !HEX64.test(student)) continue
    if (typeof alias !== 'string' || !validReidentifyAlias(alias)) continue
    if (!byKey.has(student)) byKey.set(student, alias.trim())
  }
  return [...byKey.entries()].map(([oldKey, alias]) => ({ oldKey, alias }))
}

async function receiveReidentifyFamily(identity: Identity, store: LocalStore, message: Message, payload: Record<string, unknown>, options: InboxOptions): Promise<void> {
  const action = payload.action
  if (action === 'result') {
    // 老师 → 管理人：只记匹配结果与候选，供管理人界面显示与手动选旧家人。
    if (!(await historyTeachers(store)).includes(message.sender)) return
    const parsed = parseFamilyResult(payload)
    if (!parsed) return
    for (const item of parsed.matched) {
      await saveFamilyResult(store, { newKey: item.newKey, alias: item.alias, status: 'matched', oldKey: item.oldKey, candidates: [] })
    }
    for (const item of parsed.unresolved) {
      await saveFamilyResult(store, { newKey: item.newKey, alias: item.alias, status: 'unresolved', candidates: item.candidates })
    }
    return
  }
  if (action !== 'claim') return
  if (await loadRole(store) !== 'teacher') return
  const parsed = parseFamilyClaim(payload)
  if (!parsed) return
  const links = await listIdentityLinks(store)
  const manager = links.find(link => link.kind === 'student' && link.newKey === message.sender)
  // 发送者必须是老师已确认过换机关系的“新管理人”；否则不参与任何家人匹配。
  if (!manager) return
  const candidates = await familyCandidatesFor(store, manager.oldKey)
  const mapped = new Map(links.filter(link => link.kind === 'student').map(link => [link.newKey, link.oldKey] as const))
  const matched: FamilyMatched[] = []
  const unresolved: FamilyUnresolved[] = []
  for (const family of parsed.families) {
    if (family.newKey === message.sender) { unresolved.push({ newKey: family.newKey, alias: family.alias, candidates }); continue }
    const existing = mapped.get(family.newKey)
    if (existing) { matched.push({ newKey: family.newKey, oldKey: existing, alias: family.alias }); continue }
    let oldKey: string | null = null
    if (family.oldKey !== undefined) {
      if (candidates.some(candidate => candidate.oldKey === family.oldKey)) oldKey = family.oldKey
    } else {
      const matches = candidates.filter(candidate => candidate.alias === family.alias)
      if (matches.length === 1) oldKey = matches[0].oldKey
    }
    // 旧家人公钥只能映射一次：已经对上别人时不再改。
    if (!oldKey || [...mapped.values()].includes(oldKey)) { unresolved.push({ newKey: family.newKey, alias: family.alias, candidates }); continue }
    await saveIdentityLink(store, 'student', oldKey, family.newKey)
    mapped.set(family.newKey, oldKey)
    await options.send?.(family.newKey, confirmEnvelope('student', oldKey, family.newKey))
    for (const record of await recordsForBackup(store, oldKey)) await options.send?.(family.newKey, backupEnvelope(record.event))
    // 钱账是长期数据：携带不按保留期限裁剪；失败不阻断记录回发，下次 claim 可再试。
    try {
      await options.ledger?.open?.(identity.publicKey, family.newKey)
      await options.ledger?.carryTo?.(identity.publicKey, oldKey, family.newKey)
    } catch { /* 记录与映射已落地 */ }
    matched.push({ newKey: family.newKey, oldKey, alias: family.alias })
  }
  await options.send?.(message.sender, familyResultEnvelope(matched, unresolved))
}

async function receiveReidentifyReject(store: LocalStore, payload: Record<string, unknown>): Promise<void> {
  const parsed = parseReidentifyReject(payload)
  if (!parsed || parsed.purpose !== 'student') return
  if (await loadRole(store) !== 'student') return
  // 只记一条“老师没确认”的提示；名单、记录、映射都不改。
  await markReidentifyRejected(store)
}

// storefront.update：学生端只缓存“我的老师”里某位老师本人签名的最新一版门面。
// 馆名相同不代表同一老师：签名人不是名单里的老师（或换机后的新公钥）就丢弃。
async function receiveStorefront(store: LocalStore, message: Message, payload: Record<string, unknown>): Promise<void> {
  if (await loadRole(store) !== 'student') return
  const verified = verifyStorefrontEvent(payload.event)
  if (!verified) return
  // 必须由签名本人直接发来，别人转发的不收。
  if (message.sender !== verified.event.pubkey) return
  const teachers = await loadTeachers(store)
  const links = await listIdentityLinks(store)
  const known = teachers.includes(verified.event.pubkey)
    || links.some(link => link.kind === 'teacher' && teachers.includes(link.newKey) && link.oldKey === verified.event.pubkey)
  if (!known) return
  await saveReceivedStorefront(store, verified.event, verified.event.pubkey)
}

export function createInbox(options: InboxOptions) {
  const { identity, store } = options
  const now = options.now ?? (() => new Date())
  return {
    async receive(message: Message): Promise<void> {
      if (!message || !message.envelope || message.sender === identity.publicKey) return
      const { type, version, payload } = message.envelope
      if (version !== 1) return
      if (type === CONSULT_TYPES.package) {
        if (object(payload)) await receiveConsult(identity, store, message, payload)
        return
      }
      if (type === CONSULT_TYPES.attachment) {
        if (object(payload)) await receiveAttachment(store, message, payload, identity)
        return
      }
      if (type === RECORD_PHOTO_TYPE) {
        await receiveRecordPhoto(identity, store, message, payload, now)
        return
      }
      if (type === 'record.signed') {
        await receiveSignedRecord(identity, store, message, payload, now)
        return
      }
      if (type === CARE_PLAN_TYPE) {
        await receiveCarePlan(identity, store, message, payload)
        return
      }
      if (type === ADHERENCE_TYPE) {
        if (object(payload)) await receiveAdherence(store, message, payload)
        return
      }
      if (type === RETENTION_TYPE) {
        await receiveRetentionSetting(store, message)
        return
      }
      if (type === RECORDS_REQUEST) {
        await replyOwnRecords(store, message, options.send)
        return
      }
      if (type === RECORDS_PULL) {
        await replySavedRecords(identity, store, message, options.send)
        return
      }
      if (type === RECORDS_BACKUP) {
        await receiveRecordsBackup(identity, store, message, payload, now)
        return
      }
      if (type === REIDENTIFY_REQUEST) {
        if (object(payload)) await receiveReidentifyRequest(store, message, payload)
        return
      }
      if (type === REIDENTIFY_CONFIRM) {
        if (object(payload)) await receiveReidentifyConfirm(identity, store, message, payload)
        return
      }
      if (type === REIDENTIFY_REJECT) {
        if (object(payload)) await receiveReidentifyReject(store, payload)
        return
      }
      if (type === REIDENTIFY_FAMILY) {
        if (object(payload)) await receiveReidentifyFamily(identity, store, message, payload, options)
        return
      }
      if (type === STOREFRONT_TYPE) {
        if (object(payload)) await receiveStorefront(store, message, payload)
        return
      }
      if (type.startsWith('ledger.') && options.ledger) await options.ledger.receive(message)
      // 不认识的类型丢弃。
    },
  }
}

// records.request：学生请老师把保留期内的该学生记录发回来（老师端自动回，不用操作）。
async function replyOwnRecords(store: LocalStore, message: Message, send: InboxOptions['send']): Promise<void> {
  if (!send) return
  if (await loadRole(store) !== 'teacher') return
  if (typeof message.envelope.payload !== 'object' || message.envelope.payload === null) return
  const records = await recordsForBackup(store, message.sender)
  for (const record of records.slice(0, MAX_BACKUP_RECORDS)) await send(message.sender, backupEnvelope(record.event))
}

// records.pull：老师请学生把保存的、这位老师签的病历发回来（学生端自动回）。
async function replySavedRecords(identity: Identity, store: LocalStore, message: Message, send: InboxOptions['send']): Promise<void> {
  if (!send) return
  if (await loadRole(store) !== 'student') return
  if (!(await historyTeachers(store)).includes(message.sender)) return
  const links = await listIdentityLinks(store)
  // 老师换手机后学生回发：旧老师公钥签的历史病历也属于这位新老师。
  const records = (await listReceivedRecords(store, identity))
    .filter(record => teacherLinkMatches(links, record.teacher, message.sender))
    .slice(0, MAX_BACKUP_RECORDS)
  for (const record of records) await send(message.sender, backupEnvelope(record.event))
}

// records.backup：学生端按老师名单收病历（与 record.signed 同一入库路径）；
// 老师端只收自己签的、p 标签就是发件人的那份（学生回发备份）。
// V2-07：老师换机后，旧老师公钥签的历史病历也按学生确认过的换机关系收下。
async function receiveRecordsBackup(identity: Identity, store: LocalStore, message: Message, payload: unknown, now: () => Date): Promise<void> {
  if ((await historyTeachers(store)).includes(message.sender)) {
    await receiveSignedRecord(identity, store, message, payload, now)
    return
  }
  if (await loadRole(store) !== 'teacher') return
  const links = await listIdentityLinks(store)
  const oldTeachers = links.filter(link => link.kind === 'teacher' && link.newKey === identity.publicKey).map(link => link.oldKey)
  const event = backupForTeacher(payload, identity.publicKey, message.sender, oldTeachers)
  if (!event) return
  await saveTeacherRecord(store, event)
}

// 学生端病历页：只显示验签通过、且签名人在“我的老师”名单里的病历（旧数据也按名单过滤）；
// 按同一 encounter.id 归组版本。
export async function listReceivedRecords(store: LocalStore, identity: Identity): Promise<ReceivedRecord[]> {
  const teachers = await historyTeachers(store)
  const students = await studentKeys(store, identity)
  const rows = await store.list(INBOX_COLLECTIONS.records)
  const records: ReceivedRecord[] = []
  for (const row of rows) {
    const value = recordValue(row.value)
    if (!value || !teachers.includes(value.teacher)) continue
    let parsed: unknown
    try { parsed = JSON.parse(value.eventJson) } catch { continue }
    const event = parseSignedEvent(parsed)
    if (!event) continue
    for (const student of students) {
      try {
        const encounter = verifySignedEncounter(event, { student, teacher: value.teacher })
        records.push({ event, encounter, teacher: value.teacher })
        break
      } catch { /* 换机前的旧学生公钥逐一尝试 */ }
    }
  }
  return records.sort((left, right) => Date.parse(right.encounter.createdAt) - Date.parse(left.encounter.createdAt)
    || (right.encounter.version - left.encounter.version))
}

export function groupReceivedRecords(records: readonly ReceivedRecord[]): GroupedRecord[] {
  const byId = new Map<string, ReceivedRecord[]>()
  for (const record of records) {
    const list = byId.get(record.encounter.id) ?? []
    list.push(record)
    byId.set(record.encounter.id, list)
  }
  return [...byId.entries()].map(([encounterId, versions]) => ({
    encounterId,
    versions: versions.slice().sort((left, right) => right.encounter.version - left.encounter.version),
  }))
}

export interface ConsultSigningOptions {
  identity: Identity
  /** 老师本机存储：签字发送成功后把完整签名病历存进 teacher-records。 */
  store: LocalStore
  consult: StoredConsult
  final: Encounter
  /** AI 草稿（有的话）：用于记“草案 → 定稿”的思想指纹摘要。 */
  draft?: Encounter
  send: SendEnvelope
  ledger?: LedgerRecorder
  charge?: number
  currency?: string
  /** M1-22 一家一本账：扣费记在代管人（根身份）那本账上，并标注家人称呼。 */
  chargeBook?: { student: string; forMember?: string }
}

export interface ConsultSigningResult {
  signed: SignedEncounterEvent
  chargeError: string | null
}

async function recordCharge(
  ledger: LedgerRecorder | undefined,
  teacher: string,
  student: string,
  eventId: string,
  charge: number | undefined,
  forMember?: string,
  currency?:string,
): Promise<string | null> {
  if (charge === undefined) return null
  try {
    if (!ledger) throw new Error('还没有登记这份师生账本')
    if(!currency)throw Error('请先设置钱账币种')
    await ledger.open?.(teacher,student)
    await ledger.record(teacher, student, {
      type: 'charge',
      currency,
      confirmationId:eventId,
      amount: charge,
      chargeReason: 'consult',
      recordHash: eventId,
      ...(forMember === undefined ? {} : { forMember }),
    })
    return null
  } catch (cause) {
    // 病历已经交还成功，扣费失败只提示、不回滚。
    return cause instanceof Error && cause.message ? cause.message : '扣费没有记上，请重试'
  }
}

// 老师签字交还：签字 → 发送 record.signed → 存完整医案 → 按需记一笔扣费。
// V2-05：发送成功后把完整签名病历存进 teacher-records（学生索引、医案检索、previousOf、recordHash 都从这里读）；
// 问诊包与照片仍保留，按老师设定的保留期限统一删除。
export async function completeConsultSigning(options: ConsultSigningOptions): Promise<ConsultSigningResult> {
  if (options.charge !== undefined && (!Number.isSafeInteger(options.charge) || options.charge <= 0)) throw new Error('扣费金额必须是正整数')
  const bookStudent = options.chargeBook?.student ?? options.final.student
  if (options.chargeBook?.student !== undefined && (typeof options.chargeBook.student !== 'string' || !HEX64.test(options.chargeBook.student))) throw new Error('代管人公钥格式无效')
  // V2-06：签字病历沿用问诊包里的天地人，不重新取；草稿里没有就补上包里那份。
  const heaven = options.final.heaven ?? options.consult.heaven ?? options.consult.encounter.heaven
  const final: Encounter = heaven && !options.final.heaven ? { ...options.final, heaven: { ...heaven } } : options.final
  const signed = signEncounter(final, options.identity.privateKey)
  await options.send(options.consult.sender, { type: 'record.signed', version: 1, payload: signed })
  await saveTeacherRecord(options.store, signed)
  if (options.draft) await updateFingerprint(options.store, options.final.teacher, options.draft, final)
  const chargeError = await recordCharge(options.ledger, options.final.teacher, bookStudent, signed.id, options.charge, options.chargeBook?.forMember, options.currency)
  return { signed, chargeError }
}

// M1-05 接通后，intake-outbox 里的替身待发件改为真实发送；发送成功后才从待发集合删除。
export async function flushIntakeOutbox(store: LocalStore, send: SendEnvelope): Promise<number> {
  const rows = await store.list(INTAKE_COLLECTIONS.outbox)
  let flushed = 0
  for (const row of rows) {
    const stored = row.value as unknown as StoredPackage | undefined
    if (!stored || !isEncounter(stored.encounter) || !Array.isArray(stored.attachments)) continue
    const attachments: { ref: AttachmentRef; data: Uint8Array }[] = []
    let complete = true
    for (const ref of stored.attachments) {
      if (!isRef(ref)) { complete = false; break }
      const data = await store.get(INTAKE_COLLECTIONS.attachmentData, ref.id)
      if (!(data instanceof Uint8Array)) { complete = false; break }
      attachments.push({ ref: { ...ref }, data })
    }
    if (!complete) continue
    await sendConsultPackage(send, {
      encounter: stored.encounter,
      history: Array.isArray(stored.history) ? stored.history.filter(item => typeof item === 'string') : [],
      attachments,
    }, { store })
    await store.delete(INTAKE_COLLECTIONS.outbox, row.key)
    flushed += 1
  }
  return flushed
}
