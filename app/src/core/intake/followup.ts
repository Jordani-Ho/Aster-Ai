import prompt from '../../../../prompts/student/intake.md?raw'
import defaultBank from '../../../../domain/tcm/templates/default-questions.json'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import type { LlmClient } from '../llm'
import type { Field, IntakeOriginal, OrganizationPair, OrganizedIntake } from '../record/types'
import { fieldsFromOrganization, rawOrganization, validateOrganizedIntake } from './organization'

// 学生采集的追问与整理。整理可改写，但每栏必须引用有效的原话序号；
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
  originals?: IntakeOriginal[]
  organizationPairs?: OrganizationPair[]
  focusOrder: string[]
  missingFocus: string[]
  template: TeacherTemplate
  /** M1-22：家人（尤其孩子、老人）的年龄带给模型，追问语气与内容按年龄适配。 */
  member?: { age: number | null }
}

export interface OrganizeOutcome {
  fields: IntakeFields
  organized: OrganizedIntake
  questions: FollowupQuestion[]
  usedFallback: boolean
}

function originalsFor(input: OrganizeInput): IntakeOriginal[] {
  if (input.originals) return input.originals.map(item => ({ ...item }))
  const spoken = input.texts.map(text => ({ text, source: 'spoken' as const }))
  const followup = Object.values(input.focusAnswers).map(text => ({ text, source: 'followup' as const }))
  return [...spoken, ...followup].map((item, index) => ({ id: index + 1, ...item }))
}

function fallbackOutcome(input: OrganizeInput): OrganizeOutcome {
  const organized = rawOrganization(originalsFor(input))
  return { fields: fieldsFromOrganization(organized) as IntakeFields, organized, questions: fixedQuestions(input.missingFocus), usedFallback: true }
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
    const originals = originalsFor(input)
    const payload = {
      originals,
      qa: input.focusAnswers,
      organizationPairs: (input.organizationPairs ?? []).slice(0, 5),
      template: { focus: input.template.focus },
      missingFocus: input.missingFocus,
      ...(input.member ? { member: input.member } : {}),
    }
    const reply = await Promise.race([
      llm.complete([{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(payload) }]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs) }),
    ])
    const parsed: unknown = JSON.parse(reply)
    if (!isObject(parsed)) throw new Error('shape')
    const organized = validateOrganizedIntake(parsed.organized, originals)
    if (!organized) throw new Error('invalid-citations')
    const fields = fieldsFromOrganization(organized) as IntakeFields
    let questions = validateQuestions(parsed.questions, input)
    // 模型没有给出有效追问时，用固定问句补上，保证还能继续采集。
    if (questions.length === 0) questions = fixedQuestions(input.missingFocus)
    return { fields, organized, questions, usedFallback: false }
  } catch {
    return fallback
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
