import type { StoreValue } from '../store'
import type { Encounter } from '../record/types'
import { modificationLog } from '../record/sign'
import type { RecordStoreLike } from './teacher'

// V2-05 第 2 步：老师的思想指纹——改稿习惯摘要（哪些字段常被改、改了多少），
// 只留计数，不留原文、不留学生身份；不受保留期限影响，长期留下。
export const TEACHER_FINGERPRINT = 'teacher-fingerprint'

export interface FingerprintPath {
  drafts: number
  changed: number
}

export interface TeacherFingerprint {
  teacher: string
  records: number
  paths: Record<string, FingerprintPath>
  updatedAt: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function emptyFingerprint(teacher: string): TeacherFingerprint {
  return { teacher, records: 0, paths: {}, updatedAt: new Date().toISOString() }
}

function normalize(value: unknown): TeacherFingerprint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.teacher !== 'string' || !HEX64.test(row.teacher)) return null
  if (!Number.isSafeInteger(row.records) || (row.records as number) < 0) return null
  if (typeof row.paths !== 'object' || row.paths === null || Array.isArray(row.paths)) return null
  const paths: Record<string, FingerprintPath> = {}
  for (const [path, entry] of Object.entries(row.paths as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as { drafts?: unknown; changed?: unknown }
    if (!Number.isSafeInteger(item.drafts) || !Number.isSafeInteger(item.changed)) continue
    paths[path] = { drafts: item.drafts as number, changed: item.changed as number }
  }
  return { teacher: row.teacher, records: row.records as number, paths, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '' }
}

export async function loadFingerprint(store: Pick<RecordStoreLike, 'get'>, teacher: string): Promise<TeacherFingerprint | null> {
  return normalize(await store.get(TEACHER_FINGERPRINT, teacher))
}

// 签字时调用：把“草案 → 定稿”里改过的字段累计进摘要。没配模型、没有 AI 草稿时不记。
export async function updateFingerprint(store: RecordStoreLike, teacher: string, draft: Encounter, final: Encounter, now = new Date()): Promise<TeacherFingerprint | null> {
  if (!HEX64.test(teacher)) return null
  const log = modificationLog(draft, final)
  if (log.length === 0) return null
  const fingerprint = (await loadFingerprint(store, teacher)) ?? emptyFingerprint(teacher)
  fingerprint.records += 1
  fingerprint.updatedAt = now.toISOString()
  for (const entry of log) {
    const current = fingerprint.paths[entry.path] ?? { drafts: 0, changed: 0 }
    current.drafts += 1
    if (JSON.stringify(entry.aiDraft) !== JSON.stringify(entry.final)) current.changed += 1
    fingerprint.paths[entry.path] = current
  }
  await store.put(TEACHER_FINGERPRINT, teacher, fingerprint as unknown as StoreValue)
  return fingerprint
}
