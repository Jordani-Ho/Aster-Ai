import type { Encounter, Field, Homework, Prescription, Source } from './core/record/types'
import { AI_ACCEPTED_NOTE, TEACHER_DIRECTED_NOTE } from './core/record/notes'
import { pendingDraftFields } from './core/record/sign'

// V2-16 核对签字页的纯逻辑：把病历拆成“一块一块”，草稿字段单独标出，
// 老师逐块“改一改/就这样”，全部确认后才能签字。界面只调用这里的函数，签字仍走 core/record/sign。
export type ReviewBlockKey = 'judgment' | 'prescription' | 'homework' | 'advice'

export interface ReviewField {
  path: string
  label: string
  value: string
  source: Source
  /** 空值显示“未填”，不编造。 */
  missing: boolean
}

export interface ReviewBlock {
  key: ReviewBlockKey
  title: string
  pending: boolean
  fields: ReviewField[]
  items: Homework[]
  prescription: Prescription | null
  prescriptionSource: Source | null
}

export const SOURCE_LABELS: Record<Source, string> = {
  student: '学生说的',
  teacher: '您说的',
  ai_draft: '听到了，待您确认',
  external: '外部证据',
  unknown: '未填',
}

export function textOf(field: Field<string> | undefined | null): string {
  return typeof field?.value === 'string' && field.value.trim() !== '' ? field.value : ''
}

export function prescriptionSummary(prescription: Prescription | null | undefined): string {
  if (!prescription) return ''
  const herbs = prescription.items.map(item => item.herb + (item.dose ? ' ' + item.dose : '')).join('、')
  return [herbs, prescription.method, prescription.days ? prescription.days + ' 天' : ''].filter(Boolean).join(' · ')
}

// 改方语义：和上一次签字的方子比，去了什么、加了什么。剂量变化也算一次调整，单独列出。
export function prescriptionDiff(previous: Prescription | null | undefined, next: Prescription | null | undefined): { removed: string[]; added: string[]; doseChanged: string[] } {
  const before = new Map((previous?.items ?? []).map(item => [item.herb, item.dose]))
  const after = new Map((next?.items ?? []).map(item => [item.herb, item.dose]))
  const removed = [...before.keys()].filter(herb => !after.has(herb))
  const added = [...after.keys()].filter(herb => !before.has(herb))
  const doseChanged = [...after.keys()]
    .filter(herb => before.has(herb) && before.get(herb) !== after.get(herb))
    .map(herb => `${herb} ${before.get(herb) || '未写量'} → ${after.get(herb) || '未写量'}`)
  return { removed, added, doseChanged }
}

// 改方必须写一句理由：和上一版药味/剂量/煎服法不同时要求（白皮书 §5.3 第 3 条）。
export function prescriptionChangeReasonNeeded(previous: Prescription | null | undefined, next: Prescription | null | undefined): boolean {
  if (!previous || !next) return false
  const diff = prescriptionDiff(previous, next)
  return diff.removed.length > 0 || diff.added.length > 0 || diff.doseChanged.length > 0
    || (previous.method ?? '') !== (next.method ?? '') || (previous.days ?? 0) !== (next.days ?? 0)
}

export function changeReasonText(previous: Prescription | null | undefined, next: Prescription | null | undefined): string {
  if (!previous || !next) return ''
  const diff = prescriptionDiff(previous, next)
  const parts: string[] = []
  if (diff.removed.length > 0) parts.push('比上次去了' + diff.removed.join('、'))
  if (diff.added.length > 0) parts.push('加了' + diff.added.join('、'))
  if (diff.doseChanged.length > 0) parts.push('改了剂量：' + diff.doseChanged.join('；'))
  return parts.join('；')
}

function fieldAt(encounter: Encounter, path: string): Field<unknown> | null {
  const [section, key] = path.split('.')
  if (section === 'fourExams' || section === 'judgment' || section === 'plan') {
    if ((section === 'fourExams' || section === 'judgment') && ['look', 'listenSmell', 'ask', 'pulse', 'symptomSummary', 'pattern', 'mechanism', 'rationale'].includes(key)) {
      return (encounter[section] as unknown as Record<string, Field<unknown>>)[key] ?? null
    }
    if (section === 'plan' && ['principle', 'prescription', 'advice'].includes(key)) {
      return (encounter.plan as unknown as Record<string, Field<unknown>>)[key] ?? null
    }
  }
  return null
}

function textField(encounter: Encounter, path: string, label: string): ReviewField {
  const field = fieldAt(encounter, path)
  const value = typeof field?.value === 'string' ? field.value : ''
  return { path, label, value, source: field?.source ?? 'unknown', missing: value.trim() === '' }
}

const JUDGMENT_FIELDS: readonly [string, string][] = [
  ['judgment.symptomSummary', '摘要'],
  ['judgment.pattern', '证候'],
  ['judgment.mechanism', '病机'],
  ['judgment.rationale', '辨证依据'],
  ['plan.principle', '治法'],
]

function blockPending(encounter: Encounter, key: ReviewBlockKey): boolean {
  const pending = pendingDraftFields(encounter)
  if (key === 'judgment') return pending.some(path => path.startsWith('judgment.') || path === 'plan.principle')
  if (key === 'prescription') return pending.some(path => path === 'plan.prescription')
  if (key === 'homework') return pending.some(path => path.startsWith('plan.homework['))
  return pending.some(path => path === 'plan.advice')
}

// 四块始终可见，没内容时也能由老师填写。
export function reviewBlocks(encounter: Encounter): ReviewBlock[] {
  const blocks: ReviewBlock[] = []
  const judgmentFields = JUDGMENT_FIELDS.map(([path, label]) => textField(encounter, path, label))
  const judgmentPending = blockPending(encounter, 'judgment')
  blocks.push({ key: 'judgment', title: '判断', pending: judgmentPending, fields: judgmentFields, items: [], prescription: null, prescriptionSource: null })
  const prescriptionField = encounter.plan.prescription
  const prescription = prescriptionField.value ?? null
  const prescriptionPending = blockPending(encounter, 'prescription')
  blocks.push({ key: 'prescription', title: '方子', pending: prescriptionPending, fields: [], items: [], prescription, prescriptionSource: prescription ? prescriptionField.source : null })
  const homeworkPending = blockPending(encounter, 'homework')
  blocks.push({ key: 'homework', title: '作业', pending: homeworkPending, fields: [], items: encounter.plan.homework, prescription: null, prescriptionSource: null })
  const advice = textField(encounter, 'plan.advice', '医嘱')
  const advicePending = blockPending(encounter, 'advice')
  blocks.push({ key: 'advice', title: '医嘱', pending: advicePending, fields: [advice], items: [], prescription: null, prescriptionSource: null })
  return blocks
}

export function pendingDraftCount(encounter: Encounter): number {
  return pendingDraftFields(encounter).length
}

// “还有 N 处草稿等您确认”：按块计数，四诊单独算一处。
export function pendingBlockCount(encounter: Encounter): number {
  const pending = pendingDraftFields(encounter)
  let count = reviewBlocks(encounter).filter(block => block.pending).length
  if (pending.some(path => path.startsWith('fourExams.'))) count += 1
  return count
}

function clone(encounter: Encounter): Encounter {
  return structuredClone(encounter)
}

function confirmed<T>(field: Field<T>): Field<T> {
  // V2-19：按老师意见改稿的字段保留 teacher_directed，签字后仍算“老师改过”。
  const note = field.note === TEACHER_DIRECTED_NOTE ? TEACHER_DIRECTED_NOTE : AI_ACCEPTED_NOTE
  return { ...field, source: 'teacher', note }
}

// 老师点“就这样”：这一块里的 AI 草稿转成老师确认；原文不改。
export function confirmBlock(encounter: Encounter, key: ReviewBlockKey): Encounter {
  const next = clone(encounter)
  if (key === 'judgment') {
    for (const path of ['symptomSummary', 'pattern', 'mechanism', 'rationale'] as const) {
      if (next.judgment[path].source === 'ai_draft') next.judgment[path] = confirmed(next.judgment[path])
    }
    if (next.plan.principle.source === 'ai_draft') next.plan.principle = confirmed(next.plan.principle)
  } else if (key === 'prescription') {
    if (next.plan.prescription.source === 'ai_draft') next.plan.prescription = confirmed(next.plan.prescription)
  } else if (key === 'homework') {
    next.plan.homework = next.plan.homework.map(item => (item.source === 'ai_draft'
      ? { ...item, source: 'teacher', note: item.note === TEACHER_DIRECTED_NOTE ? TEACHER_DIRECTED_NOTE : AI_ACCEPTED_NOTE }
      : item))
  } else {
    if (next.plan.advice.source === 'ai_draft') next.plan.advice = confirmed(next.plan.advice)
  }
  return next
}

// 老师改过的字段：来源写老师，不再带 ai_draft。
export function setTextField(encounter: Encounter, path: string, value: string, note?: string): Encounter {
  const next = clone(encounter)
  const field: Field<string> = value.trim() === '' ? { value: null, source: 'teacher', ...(note ? { note } : {}) } : { value, source: 'teacher', ...(note ? { note } : {}) }
  const [section, key] = path.split('.')
  if (section === 'judgment') (next.judgment as unknown as Record<string, Field<string>>)[key] = field
  else if (section === 'plan') (next.plan as unknown as Record<string, Field<string>>)[key] = field
  else if (section === 'fourExams') (next.fourExams as unknown as Record<string, Field<string>>)[key] = field
  else throw new Error('没有这个字段')
  return next
}

export function setPrescription(encounter: Encounter, value: Prescription | null, options: { reason?: string; previousEventId?: string } = {}): Encounter {
  const next = clone(encounter)
  const reason = options.reason?.trim() ?? ''
  const withReason = value && reason !== ''
    ? { ...value, ...(options.previousEventId ? { previousOf: options.previousEventId } : {}), changeReason: reason }
    : value
  next.plan.prescription = { value: withReason, source: 'teacher' }
  return next
}

export function setHomeworkItems(encounter: Encounter, items: Homework[]): Encounter {
  const next = clone(encounter)
  next.plan.homework = items
  return next
}

// 面诊“整理”后的一段原话写进某一格：同一格已有内容时用“；”接上，仍是待确认草稿。
export function setExamDraft(encounter: Encounter, key: 'look' | 'listenSmell' | 'ask' | 'pulse', value: string): Encounter {
  const next = clone(encounter)
  const text = value.trim()
  if (text === '') return next
  const prior = next.fourExams[key].value
  next.fourExams[key] = { value: prior ? prior + '；' + text : text, source: 'ai_draft', note: 'heard' }
  return next
}

// 面诊页“说完了，看草稿”时，四诊是老师自己说、自己看过的那一屏，直接算“您说的”；
// 判断/方子/作业/医嘱仍是 AI 草稿，必须在核对页逐块确认。
export function confirmHeardExams(encounter: Encounter): Encounter {
  const next = clone(encounter)
  for (const key of ['look', 'listenSmell', 'ask', 'pulse'] as const) {
    if (next.fourExams[key].source === 'ai_draft') next.fourExams[key] = { ...next.fourExams[key], source: 'teacher', note: 'heard' }
  }
  return next
}

export function hasPendingDraft(encounter: Encounter): boolean {
  return pendingDraftCount(encounter) > 0
}
