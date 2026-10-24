import prompt from '../../../../prompts/student/daily-mirror.md?raw'
import { seasonalTexts } from '../../../../domain/tcm/seasonal'
import type { LlmClient } from '../llm'
import type { LocalStore, StoreValue } from '../store'
import type { CarePlan } from '../careplan'
import type { Weather } from '../weather'
import type { Checkin } from '../homework'
import { localDay } from '../homework/schedule'
import { last14DayTrend, stressHighStreak, type SelfRating, type StressRating, type Trend } from './trend'
import { createRunner } from '../agent/runner'
import { AgentError, defineTask, materialTokens } from '../agent/tasks'
import { budgetLimit } from '../drafting/budget'

export {
  recordSelfRating, recordStressRating, listSelfRatings, listStressRatings,
  last14DayTrend, stressHighStreak, validScore, SELF_RATING_COLLECTION, STRESS_RATING_COLLECTION,
} from './trend'
export type { SelfRating, StressRating, Trend } from './trend'

export const MIRROR_COLLECTION = 'mirror'

export interface MirrorResult {
  greeting: string
  today: string[]
  trend: Trend
}

export interface MirrorInput {
  carePlan: CarePlan | null
  jieqi: string
  weather: Weather | null
  recentCheckins: Checkin[]
  recentSymptoms: SelfRating[]
  recentStress?: StressRating[]
  /** M1-22：家人（孩子、老人）的年龄带给模型；孩子的建议再按词表兜底过滤。 */
  age?: number | null
  /** M1-23a：连续两个有作业的日子都没完成时，建议里多一条温和提醒（只提醒不拦截）。 */
  nudge?: boolean
  llm?: LlmClient
  prompt?: string
  now?: () => Date
}

// 温和提醒：不出现“不要/禁止/应该”，沿用 M1-19 的口吻。
export const NUDGE_SUGGESTION = '这两天没顾上练习，今天挑一件做一下也很好。'

// 给孩子的建议不能出现酒、浓茶、咖啡（M1-22 验收第 4 条）；模型不听话时这里兜底。
const CHILD_FORBIDDEN = /酒|浓茶|咖啡/
const CHILD_FALLBACK = '按时吃饭、多喝温水、早点睡觉。'

export function ageFiltered(items: readonly string[], age: number | null | undefined): string[] {
  if (age === null || age === undefined || !Number.isFinite(age) || age >= 18) return [...items]
  const kept = items.filter(item => !CHILD_FORBIDDEN.test(item))
  return kept.length > 0 ? kept : [CHILD_FALLBACK]
}

function greeting(now: Date): string {
  const hour = now.getHours()
  if (hour < 5) return '夜深了，早点休息'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

// 无网 / 模型失败时的固定建议：调养方案 + 节气养生，只谈起居、饮食、情志，不说教、不禁止。
function fallbackToday(carePlan: CarePlan | null, jieqi: string, relaxFocus: boolean): string[] {
  const items: string[] = []
  if (carePlan) {
    for (const point of carePlan.points.slice(0, 2)) items.push(point)
    if (carePlan.avoid.length > 0) items.push('注意避开：' + carePlan.avoid.slice(0, 3).join('、'))
  }
  const seasonal = seasonalTexts(jieqi)
  if (seasonal) {
    if (items.length < 2) items.push('起居：' + seasonal.living)
    if (items.length < 3) items.push('饮食：' + seasonal.diet)
    items.push(relaxFocus ? '情志与放松：最近压力不小，给自己留一段放松的时间，散散步、听听舒缓的音乐都好。' : '情志：' + seasonal.emotion)
  }
  return items.slice(0, 5)
}

function parseToday(reply: string): string[] {
  try {
    const data = JSON.parse(reply) as { today?: unknown }
    if (!Array.isArray(data.today)) return []
    return data.today.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 5)
  } catch {
    return []
  }
}

export async function dailyMirror(input: MirrorInput): Promise<MirrorResult> {
  const now = input.now?.() ?? new Date()
  const stress = input.recentStress ?? []
  const trend = last14DayTrend(input.recentCheckins, input.recentSymptoms, stress, now)
  const relaxFocus = stressHighStreak(stress, now, 4, 3)

  let today: string[] = []
  if (input.llm) {
    try {
      const system = input.prompt ?? prompt
      const user = JSON.stringify({
        carePlan: input.carePlan,
        jieqi: input.jieqi,
        weather: input.weather,
        recentCheckins: input.recentCheckins.map(checkin => ({ at: checkin.at })),
        recentSymptoms: input.recentSymptoms,
        recentStress: stress,
        relaxFocus,
        ...(input.age === undefined || input.age === null ? {} : { member: { age: input.age } }),
      })
      const reply = await input.llm.complete([{ role: 'system', content: system }, { role: 'user', content: user }])
      today = parseToday(reply)
    } catch {
      today = []
    }
  }
  if (today.length === 0) today = fallbackToday(input.carePlan, input.jieqi, relaxFocus)
  let items = ageFiltered(today, input.age)
  // 提醒放在最后一条，保证最多 5 条时也一定出现。
  if (input.nudge) items = [...items.filter(item => item !== NUDGE_SUGGESTION).slice(0, 4), NUDGE_SUGGESTION]
  return { greeting: greeting(now), today: items, trend }
}

// 同一天只生成一次：先查本机缓存，命中直接返回；否则生成后写缓存。
export async function getDailyMirror(store: LocalStore, input: MirrorInput): Promise<MirrorResult> {
  const now = input.now?.() ?? new Date()
  if (!(now instanceof Date) || !Number.isFinite(+now) || !Array.isArray(input.recentCheckins) || !Array.isArray(input.recentSymptoms) || (input.recentStress !== undefined && !Array.isArray(input.recentStress)) || typeof input.jieqi !== 'string') throw new AgentError('input')
  const date = localDay(now)
  const cached = await store.get(MIRROR_COLLECTION, date)
  if (cached) return cached as unknown as MirrorResult
  const { llm, now: _clock, ...values } = input
  const data = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as unknown as Omit<MirrorInput, 'llm' | 'now'>
  const task = defineTask({
    id: 'mirror', side: 'student', trigger: { kind: 'open' }, confirm: 'template',
    gather: async () => data,
    tokens: (materials: typeof data) => materialTokens({ ...materials, prompt: materials.prompt ?? prompt }),
    run: async (materials) => dailyMirror({ ...materials, ...(llm ? { llm } : {}), now: () => now }),
    deliver: async (result: MirrorResult) => { await store.put(MIRROR_COLLECTION, date, result as unknown as StoreValue) },
  })
  return (await createRunner({ store, side: 'student', maxTokens: budgetLimit() }).run(task, { targetId: 'self', now })).output
}
