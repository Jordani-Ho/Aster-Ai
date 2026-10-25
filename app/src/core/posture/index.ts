// V2-30 体态记录：老师本机保存、签字时附在面诊病历里；照片/视频从不入库，只留关键点。
import metricsDefaults from '../../../../domain/tcm/posture-metrics.json'
import {
  computeRecordValues, isPostureRecord, validatePostureFormula,
  type PostureMetric, type PostureRecord, type PostureSegment,
  type PostureFrame,
} from '../../../../domain/tcm/posture'
import type { Identity } from '../identity'
import type { LocalStore } from '../store'
import type { Encounter, Homework } from '../record/types'
import { TEACHER_RECORDS, type TeacherRecord } from '../records/teacher'

export * from '../../../../domain/tcm/posture'
export * from './freemocap'
export * from './detector'
export * from './capture'

export const POSTURE_DRAFTS = 'posture-drafts'
export const POSTURE_METRICS_ROW = 'posture-metrics'

export function loadDefaultPostureMetrics(): PostureMetric[] {
  return (metricsDefaults as PostureMetric[]).map(item => ({ ...item }))
}

function validMetric(value: unknown): PostureMetric | null {
  const metric = value as PostureMetric
  if (!metric || typeof metric !== 'object') return null
  if (typeof metric.id !== 'string' || metric.id.trim() === '' || metric.id.length > 64) return null
  if (typeof metric.name !== 'string' || metric.name.trim() === '' || metric.name.length > 40) return null
  if (typeof metric.formula !== 'string' || metric.formula.trim() === '' || metric.formula.length > 300) return null
  if (typeof metric.unit !== 'string' || metric.unit.length > 10) return null
  return { id: metric.id, name: metric.name.trim(), formula: metric.formula.trim(), unit: metric.unit.trim() }
}

export async function loadPostureMetrics(store: LocalStore): Promise<PostureMetric[]> {
  try {
    const value = await store.get('settings', POSTURE_METRICS_ROW)
    if (!Array.isArray(value)) return loadDefaultPostureMetrics()
    const list = value.map(validMetric).filter((item): item is PostureMetric => item !== null)
    return list.length > 0 ? list : loadDefaultPostureMetrics()
  } catch { return loadDefaultPostureMetrics() }
}

export interface MetricSaveResult { ok: boolean; error?: string; metrics?: PostureMetric[] }
export function validatePostureMetrics(input: unknown): MetricSaveResult {
  if (!Array.isArray(input)) return { ok: false, error: '体态指标要是一个列表。' }
  if (input.length > 30) return { ok: false, error: '体态指标最多 30 条。' }
  const list: PostureMetric[] = []
  const ids = new Set<string>()
  for (const [index, raw] of input.entries()) {
    const metric = validMetric(raw)
    if (!metric) return { ok: false, error: `第 ${index + 1} 条指标：名称、公式、单位都要填，名称最多 40 字。` }
    if (ids.has(metric.id)) return { ok: false, error: `第 ${index + 1} 条指标编号重复。` }
    const formulaError = validatePostureFormula(metric.formula)
    if (formulaError) return { ok: false, error: `第 ${index + 1} 条「${metric.name}」的公式：${formulaError}` }
    ids.add(metric.id); list.push(metric)
  }
  return { ok: true, metrics: list }
}
export async function savePostureMetrics(store: LocalStore, metrics: PostureMetric[]): Promise<void> {
  await store.put('settings', POSTURE_METRICS_ROW, metrics as unknown as import('../store').StoreValue)
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

export function newPostureSegment(frame: PostureFrame, action = '站立', phase: 'before' | 'after' = 'before', note = ''): PostureSegment {
  return { id: randomId(), action: action.trim() || '站立', phase, ...(note.trim() === '' ? {} : { note: note.trim() }), frame }
}
export function newPostureRecord(identity: Identity, student: string, segments: PostureSegment[], metrics: PostureMetric[], note = ''): PostureRecord {
  const record: PostureRecord = { id: randomId(), student, teacher: identity.publicKey, at: new Date().toISOString(), segments, metrics: metrics.map(item => ({ ...item })), values: {}, ...(note.trim() === '' ? {} : { note: note.trim() }) }
  record.values = computeRecordValues(record)
  return record
}

// V2-32：学生在家拍的一段（视角决定动作：视频记“走路”，照片记“站立”）；学生端不算指标。
export function newStudentPostureSegment(frame: PostureFrame, note = ''): PostureSegment {
  const text = note.trim()
  return {
    id: randomId(),
    action: frame.view === 'video' ? '走路' : '站立',
    phase: 'before',
    ...(text === '' ? {} : { note: text.slice(0, 200) }),
    frame,
  }
}
export function newStudentPostureRecord(student: string, teacher: string, segments: PostureSegment[], note = ''): PostureRecord {
  const text = note.trim()
  return {
    id: randomId(), student, teacher, at: new Date().toISOString(), capturedBy: 'student',
    segments, metrics: [], values: {}, ...(text === '' ? {} : { note: text.slice(0, 200) }),
  }
}

export async function savePostureDraft(store: LocalStore, record: PostureRecord): Promise<void> {
  await store.put(POSTURE_DRAFTS, record.id, record as unknown as import('../store').StoreValue)
}
export async function listPostureDrafts(store: LocalStore, student: string): Promise<PostureRecord[]> {
  const rows = await store.list(POSTURE_DRAFTS)
  return rows.map(row => row.value as unknown)
    .filter((value): value is PostureRecord => isPostureRecord(value) && value.student === student)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
}
export async function deletePostureDraft(store: LocalStore, id: string): Promise<void> { await store.delete(POSTURE_DRAFTS, id) }

export interface SignedPostureRecord { record: PostureRecord; encounterId: string; encounterAt: string; version: number }
// 老师端“一位学生”页：从老师本机已签字的病历里找体态记录（旧病历没有 postures 照常跳过）。
export async function signedPostureRecords(store: LocalStore, student: string): Promise<SignedPostureRecord[]> {
  const rows = (await store.list(TEACHER_RECORDS)).map(row => row.value as unknown as TeacherRecord)
  const result: SignedPostureRecord[] = []
  for (const value of rows) {
    if (!value || typeof value.eventJson !== 'string') continue
    try {
      const event = JSON.parse(value.eventJson) as { content?: string }
      if (typeof event.content !== 'string') continue
      const encounter = JSON.parse(event.content) as Encounter
      if (encounter.student !== student || !Array.isArray(encounter.postures)) continue
      for (const record of encounter.postures) {
        if (isPostureRecord(record)) result.push({ record, encounterId: encounter.id, encounterAt: encounter.createdAt, version: encounter.version })
      }
    } catch { /* 坏记录跳过，不让一条脏数据挡住整页 */ }
  }
  return result.sort((left, right) => Date.parse(left.record.at) - Date.parse(right.record.at))
}

export async function studentPostureRecords(store: LocalStore, student: string): Promise<SignedPostureRecord[]> {
  const signed = await signedPostureRecords(store, student)
  const drafts = await listPostureDrafts(store, student)
  return [...signed, ...drafts.map(record => ({ record, encounterId: '', encounterAt: record.at, version: 0 }))]
    .sort((left, right) => Date.parse(left.record.at) - Date.parse(right.record.at))
}

// 范围 8：老师设计的动作一键加进当前面诊草稿的 plan.homework，沿用现有作业与提醒。
export function postureHomework(action: string, id?: string): Homework {
  const title = action.trim().startsWith('体态') ? action.trim() : `体态练习：${action.trim()}`
  return {
    id: id ?? randomId(),
    title: title.slice(0, 40),
    detail: '按老师当面教的要点做；有不适就停下，问老师。',
    schedule: { kind: 'daily', time: '21:00' },
    durationDays: 7,
    source: 'teacher',
  }
}
