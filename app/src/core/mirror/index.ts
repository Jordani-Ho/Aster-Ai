import prompt from '../../../../prompts/student/daily-mirror.md?raw'
import { seasonalTexts } from '../../../../domain/tcm/seasonal'
import type { LlmClient } from '../llm'
import type { LocalStore, StoreValue } from '../store'
import type { CarePlan } from '../careplan'
import type { Weather } from '../weather'
import type { Checkin } from '../homework'
import { localDay } from '../homework/schedule'
import { last14DayTrend, type SelfRating, type Trend } from './trend'

export { recordSelfRating, listSelfRatings, last14DayTrend, validScore, SELF_RATING_COLLECTION } from './trend'
export type { SelfRating, Trend } from './trend'

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
  llm?: LlmClient
  prompt?: string
  now?: () => Date
}

function greeting(now: Date): string {
  const hour = now.getHours()
  if (hour < 5) return '夜深了，早点休息'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

// 无网 / 模型失败时的固定建议：调养方案 + 节气养生，只谈起居、饮食、情志。
function fallbackToday(carePlan: CarePlan | null, jieqi: string): string[] {
  const items: string[] = []
  if (carePlan) {
    for (const point of carePlan.points.slice(0, 3)) items.push(point)
    if (carePlan.avoid.length > 0) items.push('注意避开：' + carePlan.avoid.slice(0, 3).join('、'))
  }
  const seasonal = seasonalTexts(jieqi)
  if (seasonal) {
    items.push('起居：' + seasonal.living)
    items.push('饮食：' + seasonal.diet)
    items.push('情志：' + seasonal.emotion)
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
  const trend = last14DayTrend(input.recentCheckins, input.recentSymptoms, now)

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
      })
      const reply = await input.llm.complete([{ role: 'system', content: system }, { role: 'user', content: user }])
      today = parseToday(reply)
    } catch {
      today = []
    }
  }
  if (today.length === 0) today = fallbackToday(input.carePlan, input.jieqi)
  return { greeting: greeting(now), today, trend }
}

// 同一天只生成一次：先查本机缓存，命中直接返回；否则生成后写缓存。
export async function getDailyMirror(store: LocalStore, input: MirrorInput): Promise<MirrorResult> {
  const date = localDay(input.now?.() ?? new Date())
  const cached = await store.get(MIRROR_COLLECTION, date)
  if (cached) return cached as unknown as MirrorResult
  const result = await dailyMirror(input)
  await store.put(MIRROR_COLLECTION, date, result as unknown as StoreValue)
  return result
}
