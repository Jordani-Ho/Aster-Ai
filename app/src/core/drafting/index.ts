import prompt from '../../../../prompts/teacher/draft-encounter.md?raw'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import { jieqiNames, shichenNames } from '../../../../domain/tcm/templates/types'
import { isQuotaExceeded, type ChatMessage, type LlmClient } from '../llm'
import type { ConsultPackage, Encounter, Field, Homework, Prescription } from '../record/types'
import { searchCases, type DraftCase } from './cases'
import { budgetLimit } from './budget'
import { fitDraftMaterials, packageOnlyMaterials, type DraftMaterialInput, type PriorMaterial } from './materials'
import { habitAnchor } from '../homework/schedule'

export type DraftLevel = 'record' | 'pattern' | 'prescription'
export interface DraftOptions {
  level?: DraftLevel
  timeoutMs?: number
  /** 界面应显示此安全错误；未提供时错误也会保留在 symptomSummary.note。 */
  onError?: (message: string) => void
}

/** V2-19：一次起草要带的材料。旧病历与医案可减，模板与问诊包不可减。 */
export interface DraftMaterials {
  template: TeacherTemplate
  prior?: readonly PriorMaterial[]
  cases?: readonly DraftCase[]
}

export interface DraftResult {
  encounter: Encounter
  /** 减了材料才有提示行（如“旧病历只带了最近 2 次”）；一行不减就是空数组。 */
  note: string[]
}
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const unknown = <T>(note?: string): Field<T> => ({ value: null, source: 'unknown', ...(note ? { note } : {}) })

function field<T>(raw: unknown, validate: (value: unknown) => value is T): Field<T> {
  if (raw === undefined || (object(raw) && raw.value === null)) return unknown()
  if (!object(raw) || !validate(raw.value)) return unknown('模型字段格式不正确，已置为未知')
  return { value: structuredClone(raw.value), source: 'ai_draft' }
}

export function prescription(value: unknown): value is Prescription {
  if (!object(value) || !Array.isArray(value.items) || !value.items.length) return false
  if (!value.items.every(item => object(item) && text(item.herb) && text(item.dose) && (item.note === undefined || text(item.note)))) return false
  if (value.method !== undefined && !text(value.method)) return false
  if (value.days !== undefined && !(Number.isInteger(value.days) && (value.days as number) > 0)) return false
  if (value.changeReason !== undefined && !text(value.changeReason)) return false
  if (value.previousOf !== undefined && !(typeof value.previousOf === 'string' && /^[0-9a-f]{64}$/i.test(value.previousOf) && text(value.changeReason))) return false
  return Object.keys(value).every(key => ['items', 'method', 'days', 'previousOf', 'changeReason'].includes(key)) &&
    value.items.every(item => Object.keys(item).every(key => ['herb', 'dose', 'note'].includes(key)))
}

function studentDraft(input: Encounter): Encounter {
  return {
    id: input.id, version: input.version, ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    kind: input.kind, student: input.student, teacher: input.teacher, createdAt: input.createdAt,
    ...(input.heaven ? { heaven: { ...input.heaven } } : {}),
    profile: structuredClone(input.profile), intake: structuredClone(input.intake),
    fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
    judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
    plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
  }
}

const time = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function schedule(value: unknown): Homework['schedule'] | null {
  if (!object(value)) return null
  switch (value.kind) {
    case 'daily': return time(value.time) ? { kind: 'daily', time: value.time } : null
    case 'shichen': return typeof value.shichen === 'string' && shichenNames.includes(value.shichen) ? { kind: 'shichen', shichen: value.shichen } : null
    case 'jieqi': return typeof value.jieqi === 'string' && jieqiNames.includes(value.jieqi) ? { kind: 'jieqi', jieqi: value.jieqi } : null
    case 'once': return date(value.date) && (value.time === undefined || time(value.time))
      ? { kind: 'once', date: value.date, ...(value.time === undefined ? {} : { time: value.time }) } : null
    // M1-23a：随习惯作业（如“拖地时”），只校验锚点，不产生钟点提醒。
    case 'habit': {
      try { return { kind: 'habit', anchor: habitAnchor(value.anchor) } } catch { return null }
    }
    default: return null
  }
}

export function homework(raw: unknown): Homework[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): Homework[] => {
    if (!object(item) || !text(item.title) || !text(item.detail)) return []
    const timing = schedule(item.schedule)
    if (!timing || (item.durationDays !== undefined && !(Number.isInteger(item.durationDays) && (item.durationDays as number) > 0))) return []
    return [{ id: crypto.randomUUID(), title: item.title, detail: item.detail, schedule: timing,
      ...(item.durationDays === undefined ? {} : { durationDays: item.durationDays as number }), source: 'ai_draft' }]
  })
}

// V2-19：每件事一次调用，只带这一位学生、这一件事的材料，不带上一次的对话。
// 材料先按 domain/tcm/agent-budget.json 的上限裁剪；模型报额度超限时再按同一顺序减两轮，
// 最后只剩问诊包与老师模板。任何情况下都不把上游错误原文交给界面。
async function callModel(llm: LlmClient, messages: ChatMessage[], timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      llm.complete(messages),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs) }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

export async function draftEncounter(pkg: ConsultPackage, materials: DraftMaterials, llm: LlmClient, options: DraftOptions = {}): Promise<DraftResult> {
  const draft = studentDraft(pkg.encounter)
  const level = options.level ?? 'record'
  try {
    const timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !['record', 'pattern', 'prescription'].includes(level)) throw new Error('options')
    // 只传本任务所需的资料；不传身份、附件二进制或未经解析的历史签名事件。
    const limit = budgetLimit()
    const input: DraftMaterialInput = {
      prompt,
      encounter: { profile: draft.profile, intake: draft.intake },
      template: materials.template,
      level,
      prior: [...(materials.prior ?? [])],
      cases: searchCases([draft.intake.chiefComplaint.value, draft.intake.presentIllness.value].filter(Boolean).join(' '), materials.cases ?? []),
    }
    const fitted = fitDraftMaterials(input)
    let reply: string
    let note = fitted.note
    try {
      reply = await callModel(llm, fitted.messages, timeoutMs)
    } catch (error) {
      if (!isQuotaExceeded(error)) throw error
      // 额度超限：按同一顺序再减一轮（上限减半），仍超就只用问诊包与模板。
      try {
        const reduced = fitDraftMaterials(input, { limit: Math.floor(limit / 2) })
        reply = await callModel(llm, reduced.messages, timeoutMs)
        note = reduced.note
      } catch (again) {
        if (!isQuotaExceeded(again)) throw again
        const minimal = packageOnlyMaterials(input)
        reply = await callModel(llm, minimal.messages, timeoutMs)
        note = minimal.note
      }
    }
    const raw: unknown = JSON.parse(reply)
    if (!object(raw)) throw new Error('shape')
    const exams = object(raw.fourExams) ? raw.fourExams : {}
    const judgment = object(raw.judgment) ? raw.judgment : {}
    const plan = object(raw.plan) ? raw.plan : {}
    for (const key of ['look', 'listenSmell', 'ask', 'pulse'] as const) draft.fourExams[key] = field(exams[key], text)
    draft.judgment.symptomSummary = field(judgment.symptomSummary, text)
    if (level === 'pattern' || level === 'prescription') {
      for (const key of ['pattern', 'mechanism', 'rationale'] as const) draft.judgment[key] = field(judgment[key], text)
      draft.plan.principle = field(plan.principle, text)
    }
    if (level === 'prescription') {
      draft.plan.prescription = field(plan.prescription, prescription)
      draft.plan.advice = field(plan.advice, text)
      draft.plan.homework = homework(plan.homework)
    }
    return { encounter: draft, note }
  } catch {
    const message = '起草失败：模型不可用、超时或回复格式错误；已保留学生资料，请重试或由老师填写。'
    const fallback = studentDraft(pkg.encounter)
    fallback.judgment.symptomSummary.note = message
    try { options.onError?.(message) } catch { /* 提示界面失败也不能阻断回退。 */ }
    return { encounter: fallback, note: [] }
  }
}
