import type { LocalStore } from '../store'
import { addDays, localDay } from '../homework/schedule'
import type { Checkin } from '../homework'

// “自评今天状态 1～5 分”与“自评今天压力 1～5 分”，加最近 14 天走势（状态+压力两条线），供镜子页画趋势。
export const SELF_RATING_COLLECTION = 'self-ratings'
export const STRESS_RATING_COLLECTION = 'self-stress'

export interface SelfRating {
  date: string
  score: number
}

export interface StressRating {
  date: string
  score: number
}

export interface Trend {
  days: string[]
  checkins: number[]
  scores: (number | null)[]   // 状态自评 1～5
  stress: (number | null)[]   // 压力自评 1～5
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function validScore(score: unknown): score is number {
  return Number.isInteger(score) && (score as number) >= 1 && (score as number) <= 5
}

// 一天一条：按日期为键覆盖，同一天自评只保留最后一次。
export async function recordSelfRating(store: LocalStore, score: number, at = new Date()): Promise<SelfRating> {
  if (!validScore(score)) throw new Error('自评分必须是 1～5 的整数')
  const date = localDay(at)
  await store.put(SELF_RATING_COLLECTION, date, { date, score })
  return { date, score }
}

export async function recordStressRating(store: LocalStore, score: number, at = new Date()): Promise<StressRating> {
  if (!validScore(score)) throw new Error('压力分必须是 1～5 的整数')
  const date = localDay(at)
  await store.put(STRESS_RATING_COLLECTION, date, { date, score })
  return { date, score }
}

async function listRatings(store: LocalStore, collection: string): Promise<SelfRating[]> {
  const rows = await store.list(collection)
  const result: SelfRating[] = []
  for (const row of rows) {
    if (!DAY.test(row.key)) continue
    const value = row.value as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)) {
      const rating = value as Partial<SelfRating>
      if (typeof rating.date === 'string' && validScore(rating.score)) result.push({ date: rating.date, score: rating.score as number })
    }
  }
  return result
}

export async function listSelfRatings(store: LocalStore): Promise<SelfRating[]> {
  return listRatings(store, SELF_RATING_COLLECTION)
}

export async function listStressRatings(store: LocalStore): Promise<StressRating[]> {
  return listRatings(store, STRESS_RATING_COLLECTION)
}

// 最近 14 天（含今天）每天打卡次数、状态自评、压力自评（无自评的为 null）。
export function last14DayTrend(
  checkins: readonly Checkin[],
  ratings: readonly SelfRating[],
  stressRatings: readonly StressRating[],
  now = new Date(),
): Trend {
  const days: string[] = []
  for (let index = 13; index >= 0; index -= 1) days.push(localDay(addDays(now, -index)))

  const checkinCount = new Map<string, number>()
  for (const checkin of checkins) {
    if (!checkin || typeof checkin.at !== 'string' || !Number.isFinite(Date.parse(checkin.at))) continue
    const day = localDay(new Date(checkin.at))
    checkinCount.set(day, (checkinCount.get(day) ?? 0) + 1)
  }

  const scoreByDay = new Map<string, number>()
  for (const rating of ratings) {
    if (rating && typeof rating.date === 'string' && validScore(rating.score)) scoreByDay.set(rating.date, rating.score as number)
  }
  const stressByDay = new Map<string, number>()
  for (const rating of stressRatings) {
    if (rating && typeof rating.date === 'string' && validScore(rating.score)) stressByDay.set(rating.date, rating.score as number)
  }

  return {
    days,
    checkins: days.map(day => checkinCount.get(day) ?? 0),
    scores: days.map(day => scoreByDay.get(day) ?? null),
    stress: days.map(day => stressByDay.get(day) ?? null),
  }
}

// 最近连续 N 天压力 ≥ min（含今天往回推）：用于提示侧重放松。
export function stressHighStreak(stressRatings: readonly StressRating[], now = new Date(), min = 4, days = 3): boolean {
  const byDay = new Map<string, number>()
  for (const rating of stressRatings) {
    if (rating && typeof rating.date === 'string' && validScore(rating.score)) byDay.set(rating.date, rating.score as number)
  }
  for (let index = 0; index < days; index += 1) {
    const day = localDay(addDays(now, -index))
    const score = byDay.get(day)
    if (score === undefined || score < min) return false
  }
  return true
}
