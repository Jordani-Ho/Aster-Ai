import { dailyAdherence, weekStart } from './core/adherence'
import { addDays, localDay, parseDay } from './core/homework/schedule'
import type { Assignment, Checkin } from './core/homework'

// V2-17 学生·记录（11）里的“坚持的趋势”：近四周每周完成天数。
// 只用本机打卡与作业排程算，不推断、不补 0；本周按同一 checkinDay 口径。
export interface WeekTrend {
  start: string
  label: string
  done: number
  scheduled: number
}

export function weeklyTrend(assignments: readonly Assignment[], checkins: readonly Checkin[], today: string, weeks = 4): WeekTrend[] {
  if (!Number.isSafeInteger(weeks) || weeks <= 0) throw new Error('周数无效')
  const currentStart = parseDay(weekStart(today))
  const firstStart = addDays(currentStart, -7 * (weeks - 1))
  const rows = dailyAdherence([...assignments], [...checkins], localDay(firstStart), today)
  const result: WeekTrend[] = []
  for (let index = 0; index < weeks; index += 1) {
    const start = addDays(currentStart, -7 * (weeks - 1 - index))
    const end = addDays(start, 6)
    const days = rows.filter(day => day.day >= localDay(start) && day.day <= localDay(end))
    const done = days.filter(day => day.done > 0).length
    const scheduled = days.filter(day => day.scheduled > 0).length
    result.push({ start: localDay(start), label: index === weeks - 1 ? '本周' : `第${index + 1}周`, done, scheduled })
  }
  return result
}

export function trendCaption(weeks: readonly WeekTrend[]): string {
  const current = weeks.at(-1)
  if (!current) return ''
  if (current.scheduled === 0) return '本周还没有安排作业。'
  const previous = weeks.at(-2)
  if (!previous || previous.scheduled === 0) return `本周完成 ${current.done} 天。`
  const delta = current.done - previous.done
  if (delta > 0) return `本周完成 ${current.done} 天，比上周多 ${delta} 天。`
  if (delta < 0) return `本周完成 ${current.done} 天，比上周少 ${-delta} 天。`
  return `本周完成 ${current.done} 天，和上周一样。`
}
