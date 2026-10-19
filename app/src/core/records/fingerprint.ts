import type { StoreValue } from '../store'
import type { Encounter } from '../record/types'
import { modificationLog } from '../record/sign'
import { tongueDiff } from '../../../../domain/tcm/tongue'
import type { RecordStoreLike } from './teacher'

// V2-05 第 2 步：老师的思想指纹——改稿习惯摘要（哪些字段常被改、改了多少），
// 只留计数，不留原文、不留学生身份；不受保留期限影响，长期留下。
// V2-08：模型给的舌象候选特征被老师逐项改掉时，按“特征项：模型说 X，老师定 Y”只记计数。
export const TEACHER_FINGERPRINT = 'teacher-fingerprint'

export interface FingerprintPath {
  drafts: number
  changed: number
}

export interface TeacherFingerprint {
  teacher: string
  records: number
  paths: Record<string, FingerprintPath>
  /** V2-08：舌象特征差异计数，键如“齿痕：模型不确定→老师有”。不存图、不存学生身份。 */
  tongueDiffs: Record<string, number>
  updatedAt: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function emptyFingerprint(teacher: string): TeacherFingerprint {
  return { teacher, records: 0, paths: {}, tongueDiffs: {}, updatedAt: new Date().toISOString() }
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
  const tongueDiffs: Record<string, number> = {}
  if (typeof row.tongueDiffs === 'object' && row.tongueDiffs !== null && !Array.isArray(row.tongueDiffs)) {
    for (const [diff, count] of Object.entries(row.tongueDiffs as Record<string, unknown>)) {
      if (Number.isSafeInteger(count) && (count as number) > 0) tongueDiffs[diff] = count as number
    }
  }
  return { teacher: row.teacher, records: row.records as number, paths, tongueDiffs, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '' }
}

export async function loadFingerprint(store: Pick<RecordStoreLike, 'get'>, teacher: string): Promise<TeacherFingerprint | null> {
  return normalize(await store.get(TEACHER_FINGERPRINT, teacher))
}

/** 模型候选舌象 → 老师定稿舌象的逐项差异（按位置配对，不改图、不留身份）。 */
export function tongueDiffsOf(draft: Encounter, final: Encounter): string[] {
  const before = draft.intake.tongues ?? []
  const after = final.intake.tongues ?? []
  if (before.length !== after.length) return []
  const diffs: string[] = []
  for (const [index, candidate] of before.entries()) {
    try { diffs.push(...tongueDiff(candidate, after[index])) } catch { /* 无效记录不记差异 */ }
  }
  return diffs
}

// 签字时调用：把“草案 → 定稿”里改过的字段累计进摘要。没配模型、没有 AI 草稿时不记。
export async function updateFingerprint(store: RecordStoreLike, teacher: string, draft: Encounter, final: Encounter, now = new Date()): Promise<TeacherFingerprint | null> {
  if (!HEX64.test(teacher)) return null
  const log = modificationLog(draft, final)
  const tongueDiffs = tongueDiffsOf(draft, final)
  if (log.length === 0 && tongueDiffs.length === 0) return null
  const fingerprint = (await loadFingerprint(store, teacher)) ?? emptyFingerprint(teacher)
  fingerprint.records += 1
  fingerprint.updatedAt = now.toISOString()
  for (const entry of log) {
    const current = fingerprint.paths[entry.path] ?? { drafts: 0, changed: 0 }
    current.drafts += 1
    if (JSON.stringify(entry.aiDraft) !== JSON.stringify(entry.final)) current.changed += 1
    fingerprint.paths[entry.path] = current
  }
  for (const diff of tongueDiffs) fingerprint.tongueDiffs[diff] = (fingerprint.tongueDiffs[diff] ?? 0) + 1
  await store.put(TEACHER_FINGERPRINT, teacher, fingerprint as unknown as StoreValue)
  return fingerprint
}
