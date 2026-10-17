import prompt from '../../../../prompts/student/intake.md?raw'
import defaultBank from '../../../../domain/tcm/templates/default-questions.json'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import type { LlmClient } from '../llm'
import type { Field } from '../record/types'

// 学生采集的追问与整理。模型只负责“摘取学生原话 + 指出还缺哪些十问项目”；
// 断网或模型失败时退回固定问句，流程不中断。

export const INTAKE_KEYS = ['chiefComplaint', 'presentIllness', 'history', 'medsAllergies'] as const
export type IntakeKey = (typeof INTAKE_KEYS)[number]
export type IntakeFields = Record<IntakeKey, Field<string>>

export const MAX_QUESTIONS_PER_ROUND = 2
export const MAX_ROUNDS = 3

export interface FollowupQuestion { focus: string; text: string }
export interface QuestionBank { templateId: string; questions: Record<string, string> }

type ObjectValue = Record<string, unknown>
const isObject = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownField(): Field<string> {
  return { value: null, source: 'unknown' }
}

export function emptyFields(): IntakeFields {
  return { chiefComplaint: unknownField(), presentIllness: unknownField(), history: unknownField(), medsAllergies: unknownField() }
}

function studentField(value: string | null): Field<string> {
  return value === null ? unknownField() : { value, source: 'student' }
}

// 只问模板里、且还没回答或跳过的项目。
export function missingFocuses(focusOrder: readonly string[], answers: Record<string, { status: string }>): string[] {
  return focusOrder.filter(focus => answers[focus] === undefined)
}

export function fixedQuestions(focuses: readonly string[], bank: QuestionBank = defaultBank): FollowupQuestion[] {
  return focuses.flatMap((focus): FollowupQuestion[] => {
    const text = bank.questions[focus]
    return typeof text === 'string' && text.trim() !== '' ? [{ focus, text: text.trim() }] : []
  }).slice(0, MAX_QUESTIONS_PER_ROUND)
}

function allStudentTexts(input: OrganizeInput): string[] {
  return [...input.texts, ...Object.values(input.focusAnswers)]
}

function validFragments(raw: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(raw)) return []
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const fragment = item.trim()
    if (!fragment || fragment.length > 500) continue
    if (!allowed.some(text => text.includes(fragment))) continue
    if (result.includes(fragment)) continue
    result.push(fragment)
    if (result.join('').length > 2000) break
  }
  return result
}

function fieldsFromReply(raw: unknown, allowed: readonly string[]): IntakeFields {
  const fields = emptyFields()
  if (!isObject(raw)) return fields
  for (const key of INTAKE_KEYS) {
    const value = validFragments(raw[key], allowed).join('\n')
    fields[key] = studentField(value === '' ? null : value)
  }
  return fields
}

function validateQuestions(raw: unknown, input: OrganizeInput): FollowupQuestion[] {
  if (!Array.isArray(raw)) return []
  const result: FollowupQuestion[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const focus = typeof item.focus === 'string' ? item.focus.trim() : ''
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (!input.template.focus.includes(focus) || !input.missingFocus.includes(focus)) continue
    if (text === '' || text.length > 60) continue
    if (result.some(question => question.focus === focus)) continue
    result.push({ focus, text })
  }
  return result
    .sort((left, right) => input.template.focus.indexOf(left.focus) - input.template.focus.indexOf(right.focus))
    .slice(0, MAX_QUESTIONS_PER_ROUND)
}

export interface OrganizeInput {
  texts: string[]
  focusAnswers: Record<string, string>
  focusOrder: string[]
  missingFocus: string[]
  template: TeacherTemplate
}

export interface OrganizeOutcome {
  fields: IntakeFields
  questions: FollowupQuestion[]
  usedFallback: boolean
}

function answersFor(input: OrganizeInput, focus: string): string | null {
  const text = input.focusAnswers[focus]
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null
}

// 断网回退：第一句作为主诉，追问回答按十问分组（旧病 → history，服药 → medsAllergies，其余 → presentIllness）。
function fallbackOutcome(input: OrganizeInput): OrganizeOutcome {
  const fields = emptyFields()
  const rest = input.texts.slice(1).filter(text => text.trim() !== '')
  const primary = input.texts[0]?.trim() ?? null
  fields.chiefComplaint = studentField(primary === '' ? null : primary)
  const present: string[] = [...rest]
  let history: string | null = null
  let meds: string | null = null
  for (const focus of input.focusOrder) {
    const answer = answersFor(input, focus)
    if (answer === null) continue
    if (focus === '九问旧病') history = history === null ? answer : history + '\n' + answer
    else if (focus === '服药') meds = meds === null ? answer : meds + '\n' + answer
    else present.push(answer)
  }
  fields.presentIllness = studentField(present.length === 0 ? null : present.join('\n'))
  fields.history = studentField(history)
  fields.medsAllergies = studentField(meds)
  return { fields, questions: fixedQuestions(input.missingFocus), usedFallback: true }
}

// 有网时走模型整理；任何失败都回退到 fixedQuestions + 学生原话，不阻断流程。
export async function organizeIntake(
  llm: LlmClient | null | undefined,
  input: OrganizeInput,
  options: { timeoutMs?: number } = {},
): Promise<OrganizeOutcome> {
  const fallback = fallbackOutcome(input)
  if (!llm) return fallback
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fallback
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const payload = {
      texts: input.texts,
      focusAnswers: input.focusAnswers,
      template: { focus: input.template.focus },
      missingFocus: input.missingFocus,
    }
    const reply = await Promise.race([
      llm.complete([{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(payload) }]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs) }),
    ])
    const parsed: unknown = JSON.parse(reply)
    if (!isObject(parsed)) throw new Error('shape')
    const allowed = allStudentTexts(input)
    const fields = fieldsFromReply(parsed.fields, allowed)
    let questions = validateQuestions(parsed.questions, input)
    // 模型没有给出有效追问时，用固定问句补上，保证还能继续采集。
    if (questions.length === 0) questions = fixedQuestions(input.missingFocus)
    return { fields, questions, usedFallback: false }
  } catch {
    return fallback
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
