import type { Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'
import type { Envelope, Message } from '../transport'
import type { ChainEventDraft } from '../ledger/types'
import { RECORD_COLLECTIONS, UndeliveredError, completeSigning, retryHandover } from '../record/handover'
import { signEncounter, verifySignedEncounter, type SignedEncounterEvent, type SignedEncounterIndex } from '../record/sign'
import type { AttachmentRef, ConsultPackage, Encounter, Homework } from '../record/types'
import { INTAKE_COLLECTIONS, deleteDraft, restartAfterEmergency, type IntakeSession, type StoredPackage } from '../intake/session'
import { localDay } from '../homework/schedule'

// M1-15a 串联：一个 createTransport 实例收到的信封按 type 分发给各模块。
// - consult.package / consult.attachment：老师端问诊箱与附件（照片单独一条，避免 2 MB 单条上限）。
// - record.signed：学生端验签后入库，并把作业写进 M1-13 集合。
// - ledger.*：交给 createLedgerSync().receive；不认识的类型丢弃。
export const CONSULT_TYPES = { package: 'consult.package', attachment: 'consult.attachment' } as const

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

export function consultEnvelope(pkg: ConsultPackage): Envelope {
  return {
    type: CONSULT_TYPES.package,
    version: 1,
    payload: {
      encounter: structuredClone(pkg.encounter),
      history: [...pkg.history],
      attachments: pkg.attachments.map(item => ({ ...item.ref })),
    } satisfies ConsultEnvelopePayload,
  }
}

export function attachmentEnvelope(encounterId: string, ref: AttachmentRef, data: Uint8Array): Envelope {
  return { type: CONSULT_TYPES.attachment, version: 1, payload: { encounterId, ref: { ...ref }, data: toBase64(data) } satisfies AttachmentEnvelopePayload }
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
  if (!Array.isArray(value.attachments) || value.attachments.length > MAX_PHOTOS || !value.attachments.every(isRef)) return
  const history = Array.isArray(value.history) ? value.history : []
  const checked = validHistory({ ...value, history }, identity)
  const stored: StoredConsult = {
    encounter: value.encounter,
    history: checked.history,
    attachments: value.attachments.map(ref => ({ ...ref })),
    receivedAt: new Date().toISOString(),
    sender: message.sender,
    droppedHistory: checked.dropped,
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
      if (type === 'record.signed') {
        await receiveSignedRecord(identity, store, message, payload, now)
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
): Promise<string | null> {
  if (charge === undefined) return null
  try {
    if (!ledger) throw new Error('还没有登记这份师生账本')
    await ledger.record(teacher, student, {
      type: 'charge',
      amount: charge,
      chargeReason: 'consult',
      recordHash: eventId,
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
    const chargeError = await recordCharge(options.ledger, options.final.teacher, options.final.student, index.eventId, options.charge)
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
}): Promise<ConsultSigningResult> {
  if (options.charge !== undefined && (!Number.isSafeInteger(options.charge) || options.charge <= 0)) throw new Error('扣费金额必须是正整数')
  try {
    const index = await retryHandover(options.store, options.eventId, async (type, payload) => {
      await options.send(options.student, { type, version: 1, payload })
    })
    const chargeError = await recordCharge(options.ledger, options.teacher, options.student, index.eventId, options.charge)
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
