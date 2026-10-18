import type { Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'
import type { Envelope, Message } from '../transport'
import type { ChainEventDraft } from '../ledger/types'
import { RECORD_COLLECTIONS, UndeliveredError, completeSigning, retryHandover } from '../record/handover'
import { signEncounter, verifySignedEncounter, type SignedEncounterEvent, type SignedEncounterIndex } from '../record/sign'
import type { AttachmentRef, ConsultPackage, Encounter, Homework } from '../record/types'
import { CARE_PLAN_TYPE, parseSignedCarePlanEvent, storeCarePlan, verifySignedCarePlan } from '../careplan'
import { verifyFamilyProof } from '../family/proof'
import type { AdherenceReport } from '../adherence'
import { INTAKE_COLLECTIONS, deleteDraft, restartAfterEmergency, type IntakeSession, type StoredPackage } from '../intake/session'
import { localDay } from '../homework/schedule'

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
  attachments: RECORD_COLLECTIONS.attachments,
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

export interface ConsultEnvelopePayload {
  encounter: Encounter
  history: string[]
  attachments: AttachmentRef[]
  /** 急症/自伤标记（M1-19）：只给老师端看，不进 Encounter schema。 */
  redFlag?: { hit: boolean; crisis: boolean }
  /** 最近 14 天状态与压力走势（M1-19）：只给老师端看，不进 Encounter schema。 */
  trend?: { days: string[]; checkins: number[]; scores: (number | null)[]; stress: (number | null)[] }
  /** M1-22 传输元数据：家人代管问诊时是代管人（根身份）公钥。 */
  manager?: string
  /** M1-22 代管证明：代管人私钥签名的 kind 2732 小事件，老师端验过才认 manager。 */
  managerProof?: unknown
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
  /** 急症/自伤标记（M1-19）：老师问诊箱据此醒目标出，只做展示不进入病历。 */
  redFlag?: { hit: boolean; crisis: boolean } | null
  /** 最近 14 天状态与压力走势（M1-19）：老师草稿卡片上显示一条小走势。 */
  trend?: { days: string[]; checkins: number[]; scores: (number | null)[]; stress: (number | null)[] } | null
  /** M1-22：家人代管问诊时为代管人公钥；一本账与回信都按它处理。 */
  manager?: string
  /** M1-22：带 manager 但代管证明没通过校验，老师端据此提示且不按代管扣费。 */
  managerInvalid?: boolean
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

export interface InboxOptions {
  identity: Identity
  store: LocalStore
  ledger?: { receive(message: Message): Promise<void> }
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
  return { encounter: structuredClone(consult.encounter), history: [...consult.history], attachments: [] }
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
      ...(pkg.redFlag ? { redFlag: pkg.redFlag } : {}),
      ...(pkg.trend ? { trend: pkg.trend } : {}),
      ...(pkg.manager ? { manager: pkg.manager } : {}),
      ...(pkg.managerProof ? { managerProof: structuredClone(pkg.managerProof) } : {}),
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
  if (!status.ready) throw new Error('照片还在路上，等照片到齐再起草')
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
  // Already handed back: relay replay must not resurrect deleted raw material.
  if (await store.get(RECORD_COLLECTIONS.signedEncounters, value.encounter.id + '-v' + value.encounter.version)) return
  if (!Array.isArray(value.attachments) || value.attachments.length > MAX_PHOTOS || !value.attachments.every(isRef)) return
  const history = Array.isArray(value.history) ? value.history : []
  const checked = validHistory({ ...value, history }, identity)
  const redFlagRaw = value.redFlag as unknown
  const redFlag = typeof redFlagRaw === 'object' && redFlagRaw !== null && !Array.isArray(redFlagRaw)
    && typeof (redFlagRaw as { hit?: unknown }).hit === 'boolean' && typeof (redFlagRaw as { crisis?: unknown }).crisis === 'boolean'
    ? { hit: (redFlagRaw as { hit: boolean }).hit, crisis: (redFlagRaw as { crisis: boolean }).crisis }
    : null
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
  const stored: StoredConsult = {
    encounter: value.encounter,
    history: checked.history,
    attachments: value.attachments.map(ref => ({ ...ref })),
    receivedAt: new Date().toISOString(),
    sender: message.sender,
    droppedHistory: checked.dropped,
    redFlag,
    ...(trend ? { trend } : {}),
    ...(manager ? { manager } : {}),
    ...(managerInvalid ? { managerInvalid: true } : {}),
  }
  await store.put(INBOX_COLLECTIONS.consult, value.encounter.id, stored as unknown as StoreValue)
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
  const teachers = await loadTeachers(store)
  if (!teachers.includes(message.sender)) return
  const event = parseSignedEvent(payload)
  if (!event) return
  let encounter: Encounter
  try {
    encounter = verifySignedEncounter(event, { student: identity.publicKey, teacher: message.sender })
  } catch { return }
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
  const teachers = await loadTeachers(store)
  if (!teachers.includes(message.sender)) return
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
    const data = await store.get(RECORD_COLLECTIONS.attachments, ref.id)
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
      if (type.startsWith('ledger.') && options.ledger) await options.ledger.receive(message)
      // 不认识的类型丢弃。
    },
  }
}

// 学生端病历页：只显示验签通过、且签名人在“我的老师”名单里的病历（旧数据也按名单过滤）；
// 按同一 encounter.id 归组版本。
export async function listReceivedRecords(store: LocalStore, identity: Identity): Promise<ReceivedRecord[]> {
  const teachers = await loadTeachers(store)
  const rows = await store.list(INBOX_COLLECTIONS.records)
  const records: ReceivedRecord[] = []
  for (const row of rows) {
    const value = recordValue(row.value)
    if (!value || !teachers.includes(value.teacher)) continue
    let parsed: unknown
    try { parsed = JSON.parse(value.eventJson) } catch { continue }
    const event = parseSignedEvent(parsed)
    if (!event) continue
    try {
      const encounter = verifySignedEncounter(event, { student: identity.publicKey, teacher: value.teacher })
      records.push({ event, encounter, teacher: value.teacher })
    } catch { /* 篡改或签名人不对的病历不显示。 */ }
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
  store: LocalStore
  consult: StoredConsult
  draft: Encounter
  final: Encounter
  send: SendEnvelope
  ledger?: LedgerRecorder
  charge?: number
  /** M1-22 一家一本账：扣费记在代管人（根身份）那本账上，并标注家人称呼。 */
  chargeBook?: { student: string; forMember?: string }
}

export interface ConsultSigningResult {
  index: SignedEncounterIndex
  chargeError: string | null
}

// 未送达时带回签名事件 id，老师端据此重发同一条事件，避免重复签字。
export class ConsultUndeliveredError extends UndeliveredError {
  readonly eventId: string
  constructor(eventId: string) {
    super()
    this.name = 'ConsultUndeliveredError'
    this.eventId = eventId
  }
}

async function recordCharge(
  ledger: LedgerRecorder | undefined,
  teacher: string,
  student: string,
  eventId: string,
  charge: number | undefined,
  forMember?: string,
): Promise<string | null> {
  if (charge === undefined) return null
  try {
    if (!ledger) throw new Error('还没有登记这份师生账本')
    await ledger.open?.(teacher,student)
    await ledger.record(teacher, student, {
      type: 'charge',
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

// 老师签字交还：先送达再销毁（M1-11 的 completeSigning），送达成功后再按需记一笔扣费。
export async function completeConsultSigning(options: ConsultSigningOptions): Promise<ConsultSigningResult> {
  if (options.charge !== undefined && (!Number.isSafeInteger(options.charge) || options.charge <= 0)) throw new Error('扣费金额必须是正整数')
  const bookStudent = options.chargeBook?.student ?? options.final.student
  if (options.chargeBook?.student !== undefined && (typeof options.chargeBook.student !== 'string' || !HEX64.test(options.chargeBook.student))) throw new Error('代管人公钥格式无效')
  const signed = signEncounter(options.final, options.identity.privateKey)
  const send = (type: 'record.signed', payload: SignedEncounterEvent) => options.send(options.consult.sender, { type, version: 1, payload })
  try {
    const index = await completeSigning({
      store: options.store,
      encounter: options.final,
      draft: options.draft,
      signed,
      attachmentIds: options.consult.attachments.map(ref => ref.id),
      send: async (type, payload) => { await send(type, payload) },
    })
    const chargeError = await recordCharge(options.ledger, options.final.teacher, bookStudent, index.eventId, options.charge, options.chargeBook?.forMember)
    return { index, chargeError }
  } catch (error) {
    if (error instanceof UndeliveredError) throw new ConsultUndeliveredError(signed.id)
    throw error
  }
}

// 重发暂存的签名病历；送达成功后再补记扣费。
export async function retryConsultHandover(options: {
  store: LocalStore
  eventId: string
  send: SendEnvelope
  ledger?: LedgerRecorder
  charge?: number
  teacher: string
  student: string
  chargeBook?: { student: string; forMember?: string }
}): Promise<ConsultSigningResult> {
  if (options.charge !== undefined && (!Number.isSafeInteger(options.charge) || options.charge <= 0)) throw new Error('扣费金额必须是正整数')
  const bookStudent = options.chargeBook?.student ?? options.student
  try {
    const index = await retryHandover(options.store, options.eventId, async (type, payload) => {
      await options.send(options.student, { type, version: 1, payload })
    })
    const chargeError = await recordCharge(options.ledger, options.teacher, bookStudent, index.eventId, options.charge, options.chargeBook?.forMember)
    return { index, chargeError }
  } catch (error) {
    if (error instanceof UndeliveredError) throw new ConsultUndeliveredError(options.eventId)
    throw error
  }
}

// 急症中断后，学生点“我已知晓并重新开始”时先删掉旧草稿（含急症原文），再开新的一次采集。
export async function restartIntakeAfterEmergency(store: LocalStore, state: IntakeSession, now?: Date): Promise<IntakeSession> {
  await deleteDraft(store, state.encounterId)
  return restartAfterEmergency(state, now)
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
