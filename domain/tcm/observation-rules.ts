import type { TongueAbstract } from './tongue'
import type { ObservationChoice, ObservationNote } from './observation'
import rulesJson from './observation-rules.json'

// 学生智能体的一句：只看这段时间的坚持率和舌象特征变化，不调模型。
// 规则数值放在 observation-rules.json（数据不是代码）；数据不够时一律“说不准”。
export interface ObservationRules {
  version: number
  minPracticeDays: number
  adherence: { improvedAt: number; worsenedAt: number }
  tongue: { betterColor: string; coatingColorOrder: string[]; coatingThicknessOrder: string[] }
}

export const OBSERVATION_RULES = rulesJson as ObservationRules

export function validateObservationRules(value: ObservationRules): void {
  if (!value || typeof value !== 'object') throw new Error('观察规则无效')
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('观察规则版本无效')
  if (!Number.isSafeInteger(value.minPracticeDays) || value.minPracticeDays < 0) throw new Error('观察规则无效')
  const { improvedAt, worsenedAt } = value.adherence ?? {}
  if (typeof improvedAt !== 'number' || typeof worsenedAt !== 'number') throw new Error('观察规则无效')
  if (!(worsenedAt >= 0 && worsenedAt <= improvedAt && improvedAt <= 1)) throw new Error('观察规则无效')
  const tongue = value.tongue ?? ({} as ObservationRules['tongue'])
  if (typeof tongue.betterColor !== 'string' || !Array.isArray(tongue.coatingColorOrder) || !Array.isArray(tongue.coatingThicknessOrder)) throw new Error('观察规则无效')
  if (tongue.coatingColorOrder.length < 2 || tongue.coatingThicknessOrder.length < 2) throw new Error('观察规则无效')
}

export type ObservationTongueFeatures = TongueAbstract['features']

export interface AgentObservationInput {
  practiceDays: number
  adherenceRate: number | null
  /** 这段时间最近一张舌象（没有就 null）。 */
  currentTongue: ObservationTongueFeatures | null
  /** 周期开始之前的最近一张舌象（没有就 null）。 */
  previousTongue: ObservationTongueFeatures | null
}

const UNKNOWN = new Set(['uncertain', 'unknown'])

function known(value: unknown): value is string {
  return typeof value === 'string' && !UNKNOWN.has(value)
}

function rank(order: readonly string[], value: unknown): number | null {
  if (!known(value)) return null
  const index = order.indexOf(value)
  return index < 0 ? null : index
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value))
}

/** 舌象特征变化的净方向：+ 变好、- 变差、0 看不清或没变化；没有可比较的项返回 null。 */
export function tongueSignal(current: ObservationTongueFeatures | null, previous: ObservationTongueFeatures | null, rules: ObservationRules = OBSERVATION_RULES): number | null {
  if (!current || !previous) return null
  validateObservationRules(rules)
  let compared = 0
  let net = 0
  const add = (signal: number | null) => { if (signal !== null) { compared += 1; net += signal } }
  // 舌色：向“淡红”靠是变好，离开是变差；两头都不是淡红时看不清。
  if (known(current.color) && known(previous.color)) {
    if (current.color === rules.tongue.betterColor && previous.color !== rules.tongue.betterColor) add(1)
    else if (previous.color === rules.tongue.betterColor && current.color !== rules.tongue.betterColor) add(-1)
  }
  // 苔色、苔厚：按取值表的顺序，越靠前越接近正常。
  const coatingColor = (rank(rules.tongue.coatingColorOrder, current.coatingColor) !== null && rank(rules.tongue.coatingColorOrder, previous.coatingColor) !== null)
    ? clamp(rank(rules.tongue.coatingColorOrder, previous.coatingColor)! - rank(rules.tongue.coatingColorOrder, current.coatingColor)!) : null
  add(coatingColor)
  const coatingThickness = (rank(rules.tongue.coatingThicknessOrder, current.coatingThickness) !== null && rank(rules.tongue.coatingThicknessOrder, previous.coatingThickness) !== null)
    ? clamp(rank(rules.tongue.coatingThicknessOrder, previous.coatingThickness)! - rank(rules.tongue.coatingThicknessOrder, current.coatingThickness)!) : null
  add(coatingThickness)
  // 齿痕、裂纹：越少越好；null 表示“有、位置不确定”，按 1 处算。
  const marks = (value: ObservationTongueFeatures['teeth'] | ObservationTongueFeatures['cracks']): number | null => {
    if (value === null) return 1
    if (Array.isArray(value)) return value.length
    return null
  }
  const currentTeeth = marks(current.teeth), previousTeeth = marks(previous.teeth)
  if (currentTeeth !== null && previousTeeth !== null) add(clamp(previousTeeth - currentTeeth))
  const currentCracks = marks(current.cracks), previousCracks = marks(previous.cracks)
  if (currentCracks !== null && previousCracks !== null) add(clamp(previousCracks - currentCracks))
  if (compared === 0) return null
  return net === 0 ? 0 : net > 0 ? 1 : -1
}

/**
 * 智能体四选一：
 * - 有效坚持天数不够或没有坚持率 → 说不准（数据不够，不拿零冒充）；
 * - 坚持率与舌象方向冲突 → 说不准；
 * - 其余按坚持率给方向，坚持率持平但舌象有明确变化时按舌象方向。
 */
export function agentObservation(input: AgentObservationInput, rules: ObservationRules = OBSERVATION_RULES): ObservationChoice {
  validateObservationRules(rules)
  if (!Number.isSafeInteger(input.practiceDays) || input.practiceDays < 0) throw new Error('有效坚持天数无效')
  if (!(input.adherenceRate === null || (typeof input.adherenceRate === 'number' && Number.isFinite(input.adherenceRate) && input.adherenceRate >= 0 && input.adherenceRate <= 1))) throw new Error('坚持率无效')
  if (input.practiceDays < rules.minPracticeDays || input.adherenceRate === null) return 'unsure'
  const tongue = tongueSignal(input.currentTongue, input.previousTongue, rules)
  const improved = input.adherenceRate >= rules.adherence.improvedAt
  const worsened = input.adherenceRate <= rules.adherence.worsenedAt
  if (improved) return tongue === -1 ? 'unsure' : 'improve'
  if (worsened) return tongue === 1 ? 'unsure' : 'worse'
  if (tongue === 1) return 'improve'
  if (tongue === -1) return 'worse'
  return 'same'
}

export type { ObservationChoice, ObservationNote }
