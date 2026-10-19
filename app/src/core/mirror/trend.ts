import type { LocalStore, StoreValue } from '../store'
import { addDays, checkinDay, localDay } from '../homework/schedule'
import type { Checkin } from '../homework'
import type { HeavenStamp } from '../heaven'

// “自评今天状态 1～5 分”与“自评今天压力 1～5 分”，加最近 14 天走势（状态+压力两条线），供镜子页画趋势。
export const SELF_RATING_COLLECTION = 'self-ratings'
export const STRESS_RATING_COLLECTION = 'self-stress'

// 每条镜子记录一并记下当时的时辰、节气、城市（V2-02 第 5 条）。
export interface SelfRating extends Partial<HeavenStamp> {
  date: string
  score: number
}

export interface StressRating extends Partial<HeavenStamp> {
  date: string
  score: number
}

export interface Trend {
  days: string[]
  checkins: number[]
  scores: (number | null)[]   // 状态自评 1～5
  stress: (number | null)[]   // 压力自评 1～5
  /** 因时辰与照镜子时辰不同而不参与对照的记录条数。 */
  excluded: number
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

function stampFields(value: Record<string, unknown>): Partial<HeavenStamp> {
  const stamp: Partial<HeavenStamp> = {}
  if (typeof value.shichen === 'string') stamp.shichen = value.shichen
  if (typeof value.jieqi === 'string') stamp.jieqi = value.jieqi
  if (typeof value.city === 'string' || value.city === null) stamp.city = value.city as string | null
  return stamp
}

export function validScore(score: unknown): score is number {
  return Number.isInteger(score) && (score as number) >= 1 && (score as number) <= 5
}

// 一天一条：按日期为键覆盖，同一天自评只保留最后一次。
export async function recordSelfRating(store: LocalStore, score: number, at = new Date(), heaven?: HeavenStamp): Promise<SelfRating> {
  if (!validScore(score)) throw new Error('自评分必须是 1～5 的整数')
  const date = localDay(at)
  const rating: SelfRating = { date, score, ...(heaven ? { shichen: heaven.shichen, jieqi: heaven.jieqi, city: heaven.city } : {}) }
  await store.put(SELF_RATING_COLLECTION, date, rating as unknown as StoreValue)
  return rating
}

export async function recordStressRating(store: LocalStore, score: number, at = new Date(), heaven?: HeavenStamp): Promise<StressRating> {
  if (!validScore(score)) throw new Error('压力分必须是 1～5 的整数')
  const date = localDay(at)
  const rating: StressRating = { date, score, ...(heaven ? { shichen: heaven.shichen, jieqi: heaven.jieqi, city: heaven.city } : {}) }
  await store.put(STRESS_RATING_COLLECTION, date, rating as unknown as StoreValue)
  return rating
}

async function listRatings(store: LocalStore, collection: string): Promise<SelfRating[]> {
  const rows = await store.list(collection)
  const result: SelfRating[] = []
  for (const row of rows) {
    if (!DAY.test(row.key)) continue
    const value = row.value as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)) {
      const rating = value as Partial<SelfRating>
      if (typeof rating.date === 'string' && validScore(rating.score)) {
        result.push({ date: rating.date, score: rating.score as number, ...stampFields(rating as unknown as Record<string, unknown>) })
      }
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
// 传了 shichen（照镜子时辰）时，只拿同一时辰的记录对照；其他时辰的记录计入 excluded，不进走势。
export function last14DayTrend(
  checkins: readonly Checkin[],
  ratings: readonly SelfRating[],
  stressRatings: readonly StressRating[],
  now = new Date(),
  options: { shichen?: string } = {},
): Trend {
  const days: string[] = []
  for (let index = 13; index >= 0; index -= 1) days.push(localDay(addDays(now, -index)))

  let excluded = 0
  const comparable = <T extends Partial<HeavenStamp>>(rows: readonly T[]): T[] => {
    if (!options.shichen) return [...rows]
    return rows.filter(row => {
      if (!row || typeof row.shichen !== 'string' || row.shichen === options.shichen) return true
      excluded += 1
      return false
    })
  }

  const checkinCount = new Map<string, number>()
  for (const checkin of checkins) {
    if (!checkin || typeof checkin.at !== 'string' || !Number.isFinite(Date.parse(checkin.at))) continue
    // 与打卡同一个日子口径（本地 00:00–00:59 算前一天）。
    const day = checkinDay(new Date(checkin.at))
    checkinCount.set(day, (checkinCount.get(day) ?? 0) + 1)
  }

  const scoreByDay = new Map<string, number>()
  for (const rating of comparable(ratings)) {
    if (rating && typeof rating.date === 'string' && validScore(rating.score)) scoreByDay.set(rating.date, rating.score as number)
  }
  const stressByDay = new Map<string, number>()
  for (const rating of comparable(stressRatings)) {
    if (rating && typeof rating.date === 'string' && validScore(rating.score)) stressByDay.set(rating.date, rating.score as number)
  }

  return {
    days,
    checkins: days.map(day => checkinCount.get(day) ?? 0),
    scores: days.map(day => scoreByDay.get(day) ?? null),
    stress: days.map(day => stressByDay.get(day) ?? null),
    excluded,
  }
}

// 走势对照表下方的提示：有记录因时辰不同没进对照。
export function mirrorTrendNote(trend: Trend): string | null {
  return trend.excluded > 0 ? `有 ${trend.excluded} 条记录时辰不同，不参与对照。` : null
}

// 到了选定的时辰、今天还没照镜子时的提示；只提醒，不拦截、不补记录。
export function mirrorShichenNotice(time: { shichen: string }, chosen: string, hasToday: boolean): string | null {
  if (hasToday || time.shichen !== chosen) return null
  return `${chosen}时到了，照照镜子吧。`
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
