import type { Encounter } from './types'
import { deidentifiedCaseBook, modificationLog, type SignedEncounterEvent } from './sign'

// 老师端本地存储的集合名（登记在 app/src/core/store/README.md）。
export const RECORD_COLLECTIONS = {
  consultPackage: 'consult-package',
  attachments: 'attachments',
  signedEncounters: 'signed-encounters',
  caseBook: 'case-book',
  recordLog: 'record-log',
} as const

export interface RecordStore {
  put(collection: string, key: string, value: unknown): Promise<void>
  get(collection: string, key: string): Promise<unknown>
  delete(collection: string, key: string): Promise<void>
  list(collection: string): Promise<{ key: string; value: unknown }[]>
}

export type SendSignedRecord = (type: 'record.signed', payload: SignedEncounterEvent) => Promise<void>

function recordKey(encounter: Encounter): string {
  return encounter.id + '-v' + encounter.version
}

function logKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function saveSignedEncounter(store: RecordStore, event: SignedEncounterEvent, encounter: Encounter): Promise<void> {
  await store.put(RECORD_COLLECTIONS.signedEncounters, recordKey(encounter), event)
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

export interface CompleteSigningOptions {
  store: RecordStore
  encounter: Encounter
  draft: Encounter
  signed: SignedEncounterEvent
  attachmentIds: string[]
  send: SendSignedRecord
}

// 签字成功后的完整流程：存签名病历 → 删除问诊包与附件并记日志 → 存去标识医案与修改记录 → 交还学生。
export async function completeSigning(options: CompleteSigningOptions): Promise<void> {
  await saveSignedEncounter(options.store, options.signed, options.encounter)
  await destroyConsultPackage(options.store, options.encounter.id, options.attachmentIds)
  await saveCaseBook(options.store, options.encounter, options.draft, options.signed.id)
  await options.send('record.signed', options.signed)
}
