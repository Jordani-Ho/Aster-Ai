import type { ChatMessage } from '../llm'
import type { Encounter, Field, Prescription } from '../record/types'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import type { DraftCase } from './cases'
import { budgetLimit, requestTokens } from './budget'

// V2-19：一次起草要带的材料分成两堆。
// 不可减：这次的问诊包（profile + intake + fourExams）、老师模板、提示词。
// 可减：这位学生以前签过字的旧病历（新→旧）、相似医案。
// 超上限时先减旧病历（从最早的减，所以这里保持「新→旧」的顺序），再减相似医案。
export interface PriorPrescription {
  items: { herb: string; dose: string }[]
  method?: string
  days?: number
  changeReason?: string
}

export interface PriorMaterial {
  id: string
  createdAt: string
  symptomSummary: string
  pattern: string
  mechanism: string
  rationale: string
  principle: string
  prescription: PriorPrescription | null
  advice: string
  homework: string[]
  outcome: { change: string; adverse: string; next: string } | null
}

export interface DraftMaterialInput {
  prompt: string
  /** 这次的问诊包：永远不减。 */
  encounter: Pick<Encounter, 'profile' | 'intake' | 'fourExams'>
  template: TeacherTemplate
  level: string
  prior: readonly PriorMaterial[]
  cases: readonly DraftCase[]
}

export interface DraftMaterialFit {
  messages: ChatMessage[]
  prior: PriorMaterial[]
  cases: DraftCase[]
  /** 减了材料才有的提示行；一行不减就是空数组。 */
  note: string[]
}

const text = (field: Field<string> | undefined): string =>
  typeof field?.value === 'string' && field.value.trim() !== '' ? field.value : ''

function prescriptionOf(record: { value: Prescription | null }): PriorPrescription | null {
  const value = record.value
  if (!value) return null
  return {
    items: value.items.map(item => ({ herb: item.herb, dose: item.dose })),
    ...(value.method ? { method: value.method } : {}),
    ...(value.days ? { days: value.days } : {}),
    ...(value.changeReason ? { changeReason: value.changeReason } : {}),
  }
}

/** 把老师签过字的旧病历投影成只读材料；同一 encounter 只取最新版本，最新在前。 */
export function priorMaterials(records: readonly { encounter: Encounter }[]): PriorMaterial[] {
  const latest = new Map<string, Encounter>()
  for (const record of records) {
    const current = latest.get(record.encounter.id)
    if (!current || record.encounter.version > current.version) latest.set(record.encounter.id, record.encounter)
  }
  return [...latest.values()]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.version - left.version)
    .map(encounter => ({
      id: encounter.id,
      createdAt: encounter.createdAt,
      symptomSummary: text(encounter.judgment.symptomSummary),
      pattern: text(encounter.judgment.pattern),
      mechanism: text(encounter.judgment.mechanism),
      rationale: text(encounter.judgment.rationale),
      principle: text(encounter.plan.principle),
      prescription: prescriptionOf(encounter.plan.prescription),
      advice: text(encounter.plan.advice),
      homework: encounter.plan.homework.map(item => item.title),
      outcome: encounter.outcome
        ? { change: text(encounter.outcome.change), adverse: text(encounter.outcome.adverse), next: text(encounter.outcome.next) }
        : null,
    }))
}

function messagesOf(input: DraftMaterialInput, prior: PriorMaterial[], cases: DraftCase[]): ChatMessage[] {
  return [
    { role: 'system', content: input.prompt },
    {
      role: 'user',
      content: JSON.stringify({ encounter: input.encounter, template: input.template, prior, cases, level: input.level }),
    },
  ]
}

/** 按上限裁剪旧病历与相似医案；问诊包、模板、提示词不动。 */
export function fitDraftMaterials(input: DraftMaterialInput, options: { limit?: number } = {}): DraftMaterialFit {
  const limit = options.limit ?? budgetLimit()
  const prior = [...input.prior]
  const cases = [...input.cases]
  let messages = messagesOf(input, prior, cases)
  // prior 是「新→旧」，从头到尾弹就是从最早的减。
  while (requestTokens(messages) > limit && prior.length > 0) {
    prior.pop()
    messages = messagesOf(input, prior, cases)
  }
  while (requestTokens(messages) > limit && cases.length > 0) {
    cases.pop()
    messages = messagesOf(input, prior, cases)
  }
  const note: string[] = []
  if (prior.length < input.prior.length) note.push(prior.length === 0 ? '旧病历这次没带' : '旧病历只带了最近 ' + prior.length + ' 次')
  if (cases.length < input.cases.length) note.push(cases.length === 0 ? '这次没参考相似医案' : '相似医案只带了 ' + cases.length + ' 份')
  return { messages, prior, cases, note }
}

/** 额度一直不够时的最后一档：只带这次问诊包和老师模板。 */
export function packageOnlyMaterials(input: DraftMaterialInput): DraftMaterialFit {
  return { messages: messagesOf(input, [], []), prior: [], cases: [], note: ['没参考旧病历和医案'] }
}
