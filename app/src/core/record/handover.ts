import type { Encounter } from './types'
import { deidentifiedCaseBook, modificationLog, type SignedEncounterEvent, type SignedEncounterIndex } from './sign'

// 老师端本地存储的集合名（登记在 app/src/core/store/README.md）。
export const RECORD_COLLECTIONS = {
  consultPackage: 'consult-package',
  attachments: 'attachments',
  signedEncounters: 'signed-encounters',
  caseBook: 'case-book',
  recordLog: 'record-log',
  pendingHandover: 'pending-handover',
} as const

export interface RecordStore {
  put(collection: string, key: string, value: unknown): Promise<void>
  get(collection: string, key: string): Promise<unknown>
  delete(collection: string, key: string): Promise<void>
  list(collection: string): Promise<{ key: string; value: unknown }[]>
}

export type SendSignedRecord = (type: 'record.signed', payload: SignedEncounterEvent) => Promise<void>

// 发送失败时抛出；此时问诊包和附件原样保留，签名事件留在 pending-handover 里可重发。
export class UndeliveredError extends Error {
  constructor() {
    super('未送达，可重发')
    this.name = 'UndeliveredError'
  }
}

function recordKey(encounter: Encounter): string {
  return encounter.id + '-v' + encounter.version
}

function logKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')
}

// 老师端签字后只留一条索引，不留病历内容；eventId 供康币扣费的 recordHash 和改方的 previousOf 使用。
export function signedEncounterIndex(encounter: Encounter, event: SignedEncounterEvent): SignedEncounterIndex {
  return {
    eventId: event.id,
    encounterId: encounter.id,
    version: encounter.version,
    student: encounter.student,
    createdAt: encounter.createdAt,
  }
}

export async function saveSignedIndex(store: RecordStore, event: SignedEncounterEvent, encounter: Encounter): Promise<SignedEncounterIndex> {
  const index = signedEncounterIndex(encounter, event)
  await store.put(RECORD_COLLECTIONS.signedEncounters, recordKey(encounter), index)
  return index
}

// 诊毕即还：删除问诊包与附件，只写“时间 + 病历 id”的本地日志，不含任何内容。
export async function destroyConsultPackage(store: RecordStore, encounterId: string, attachmentIds: string[]): Promise<void> {
  await store.delete(RECORD_COLLECTIONS.consultPackage, encounterId)
  for (const id of attachmentIds) await store.delete(RECORD_COLLECTIONS.attachments, id)
  await store.put(RECORD_COLLECTIONS.recordLog, logKey(), { at: new Date().toISOString(), encounterId })
}

export async function saveCaseBook(store: RecordStore, encounter: Encounter, draft: Encounter, eventId: string): Promise<void> {
  await store.put(RECORD_COLLECTIONS.caseBook, recordKey(encounter), {
    sourceEventId: eventId,
    deidentified: deidentifiedCaseBook(encounter),
    modifications: modificationLog(draft, encounter),
  })
}

// 未送达时暂存的待发签名病历（含重发所需的草稿与附件 id），送达并写完后删除。
export interface PendingHandover {
  event: SignedEncounterEvent
  encounter: Encounter
  draft: Encounter
  attachmentIds: string[]
}

async function finishHandover(store: RecordStore, pending: PendingHandover): Promise<SignedEncounterIndex> {
  await destroyConsultPackage(store, pending.encounter.id, pending.attachmentIds)
  await saveCaseBook(store, pending.encounter, pending.draft, pending.event.id)
  const index = await saveSignedIndex(store, pending.event, pending.encounter)
  await store.delete(RECORD_COLLECTIONS.pendingHandover, pending.event.id)
  return index
}

export interface CompleteSigningOptions {
  store: RecordStore
  encounter: Encounter
  draft: Encounter
  signed: SignedEncounterEvent
  attachmentIds: string[]
  send: SendSignedRecord
}

// 交还顺序：先暂存签名事件并发送；发送成功后销毁问诊包与附件、写医案和索引。
// 发送失败时什么都不删，留给 retryHandover 重发。
export async function completeSigning(options: CompleteSigningOptions): Promise<SignedEncounterIndex> {
  const pending: PendingHandover = {
    event: options.signed,
    encounter: options.encounter,
    draft: options.draft,
    attachmentIds: options.attachmentIds,
  }
  await options.store.put(RECORD_COLLECTIONS.pendingHandover, options.signed.id, pending)
  try {
    await options.send('record.signed', options.signed)
  } catch {
    throw new UndeliveredError()
  }
  return finishHandover(options.store, pending)
}

// 重发暂存的签名病历；送达成功后才继续销毁与落库。
export async function retryHandover(store: RecordStore, eventId: string, send: SendSignedRecord): Promise<SignedEncounterIndex> {
  const pending = await store.get(RECORD_COLLECTIONS.pendingHandover, eventId) as PendingHandover | undefined
  if (!pending) throw new Error('没有待重发的签名病历')
  try {
    await send('record.signed', pending.event)
  } catch {
    throw new UndeliveredError()
  }
  return finishHandover(store, pending)
}
