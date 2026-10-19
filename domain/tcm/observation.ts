export type ObservationChoice = 'improve' | 'same' | 'worse' | 'unsure'
export type ObservationNote = ObservationChoice | null

// 三方各说一句里的四选一（老师、本人、学生智能体用同一套词）。null 表示未评价，不是持平。
export const OBSERVATION_CHOICES: ReadonlyArray<{ value: ObservationChoice; label: string }> = [
  { value: 'improve', label: '改善' },
  { value: 'same', label: '持平' },
  { value: 'worse', label: '变差' },
  { value: 'unsure', label: '说不准' },
]

export const OBSERVATION_LABELS: Readonly<Record<ObservationChoice, string>> = {
  improve: '改善', same: '持平', worse: '变差', unsure: '说不准',
}

export function validObservationChoice(value: unknown): value is ObservationChoice {
  return OBSERVATION_CHOICES.some(choice => choice.value === value)
}

/** 未评价（null）显示成“未评价”，不能当成持平。 */
export function observationNoteText(note: ObservationNote): string {
  return note === null ? '未评价' : OBSERVATION_LABELS[note]
}

// 一个观察周期：一位学生跟一位老师，从上次签字到这次签字；第一次从学生加入那天算起。
export interface PeriodObservation {
  periodStart: string
  periodEnd: string
  /** 周期内有效坚持天数（学生端上报的计数，老师端只照录不二次判定）。 */
  practiceDays: number
  /** 周期内坚持率；没有排程作业时为 null（不是零）。 */
  adherenceRate: number | null
  /** 学生智能体按 domain/tcm/observation-rules.json 给的那一句。 */
  agentNote: ObservationNote
}

const CHOICE_SET = new Set<ObservationChoice>(OBSERVATION_CHOICES.map(choice => choice.value))

function finiteIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function parsePeriodObservation(value: unknown): PeriodObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!finiteIso(v.periodStart) || !finiteIso(v.periodEnd)) return null
  if (Date.parse(v.periodStart) > Date.parse(v.periodEnd)) return null
  if (!Number.isSafeInteger(v.practiceDays) || (v.practiceDays as number) < 0) return null
  if (!(v.adherenceRate === null || (typeof v.adherenceRate === 'number' && Number.isFinite(v.adherenceRate) && v.adherenceRate >= 0 && v.adherenceRate <= 1))) return null
  if (!(v.agentNote === null || (typeof v.agentNote === 'string' && CHOICE_SET.has(v.agentNote as ObservationChoice)))) return null
  if (Object.keys(v).sort().join(',') !== 'adherenceRate,agentNote,periodEnd,periodStart,practiceDays') return null
  return {
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    practiceDays: v.practiceDays as number,
    adherenceRate: v.adherenceRate as number | null,
    agentNote: v.agentNote as ObservationNote,
  }
}
