import type { Assignment, Checkin } from '../homework'
import { addDays, checkinDay, localDay, parseDay, schedule } from '../homework/schedule'
import type { Homework } from '../record/types'

// M1-24 坚持率纯逻辑：只读作业排程与打卡记录，不写存储、不改界面、不改病历格式。
// “有作业/完成”都按设备本地日期（与 M1-13 的 schedule/localDay 一致），排程复用 core/homework。

export interface AdherenceDay {
  /** YYYY-MM-DD，设备本地日期 */
  day: string
  /** 这一天按排程的作业条数（同一作业同一天只算一次） */
  scheduled: number
  /** 这一天已完成的作业条数（只统计当天有排程的作业） */
  done: number
}

// schedule() 的窗口上限是 3660 天；坚持率也沿用这个上限，超出范围直接报错而不是给出错误结果。
const MAX_SPAN_DAYS = 3660
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

function assertDay(value: string): void {
  if (!DAY.test(value)) throw new Error('日期须为YYYY-MM-DD')
  parseDay(value)
}

function spanDays(from: string, to: string): number {
  assertDay(from); assertDay(to)
  const span = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000 + 1
  if (span <= 0) throw new Error('日期范围无效：结束日期早于开始日期')
  if (span > MAX_SPAN_DAYS) throw new Error(`日期范围过大（最多 ${MAX_SPAN_DAYS} 天）`)
  return span
}

function assignmentHomework(value: Assignment): Homework | null {
  if (!value || typeof value !== 'object') return null
  if (typeof value.startsOn !== 'string' || !DAY.test(value.startsOn)) return null
  const homework = value.homework
  if (!homework || typeof homework !== 'object' || typeof homework.id !== 'string' || homework.id === '') return null
  if (!homework.schedule || typeof homework.schedule !== 'object') return null
  return homework
}

// 每天应完成的作业 id（同一天同一作业去重）。排程坏掉的作业静默跳过，不把整页算错。
// M1-23a：随习惯作业没有钟点提醒，但每个生效日算一条“有作业”，打卡计入坚持率。
function scheduledIds(assignments: Assignment[], from: string, to: string): Map<string, Set<string>> {
  const days = spanDays(from, to)
  const result = new Map<string, Set<string>>()
  const add = (day: string, id: string) => {
    if (day < from || day > to) return
    const ids = result.get(day) ?? new Set<string>()
    ids.add(id)
    result.set(day, ids)
  }
  for (const assignment of assignments) {
    const homework = assignmentHomework(assignment)
    if (!homework) continue
    let reminders
    try { reminders = schedule([homework], assignment.startsOn, days, from) } catch { continue }
    if (homework.schedule.kind === 'habit') {
      // 随习惯作业按“生效日期起每天一条”计：子时归日只影响打卡归属，不影响排程日期。
      const startMs = Date.parse(assignment.startsOn + 'T00:00:00Z')
      for (const day of range(from, to)) {
        const elapsed = (Date.parse(day + 'T00:00:00Z') - startMs) / 86_400_000
        if (!Number.isFinite(elapsed) || elapsed < 0) continue
        if (homework.durationDays !== undefined && (!Number.isInteger(homework.durationDays) || homework.durationDays <= 0 || elapsed >= homework.durationDays)) continue
        add(day, homework.id)
      }
      continue
    }
    for (const reminder of reminders) add(localDay(reminder.at), homework.id)
  }
  return result
}

// 每天已打卡的作业 id（同一天多次打卡只算一次；at 不是合法时间的记录忽略，不抛错）。
// M1-23a 边界：本地 00:00–00:59 的打卡算前一天（子时跨零点归日），见 checkinDay。
function completedIds(checkins: Checkin[], from: string, to: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const checkin of checkins) {
    if (!checkin || typeof checkin !== 'object') continue
    if (typeof checkin.homeworkId !== 'string' || checkin.homeworkId === '') continue
    if (typeof checkin.at !== 'string') continue
    const at = Date.parse(checkin.at)
    if (!Number.isFinite(at)) continue
    const day = checkinDay(new Date(at))
    if (day < from || day > to) continue
    const ids = result.get(day) ?? new Set<string>()
    ids.add(checkin.homeworkId)
    result.set(day, ids)
  }
  return result
}

function range(from: string, to: string): string[] {
  const days = spanDays(from, to)
  const start = parseDay(from)
  return Array.from({ length: days }, (_, index) => localDay(addDays(start, index)))
}

export function dailyAdherence(assignments: Assignment[], checkins: Checkin[], from: string, to: string): AdherenceDay[] {
  const scheduled = scheduledIds(assignments, from, to)
  const completed = completedIds(checkins, from, to)
  return range(from, to).map(day => {
    const ids = scheduled.get(day)
    if (!ids || ids.size === 0) return { day, scheduled: 0, done: 0 }
    const done = completed.get(day)
    let count = 0
    for (const id of ids) if (done?.has(id)) count += 1
    return { day, scheduled: ids.size, done: count }
  })
}

function earliestStart(assignments: Assignment[], today: string): string | null {
  let earliest: string | null = null
  for (const assignment of assignments) {
    if (!assignmentHomework(assignment) || !assignment || typeof assignment.startsOn !== 'string') continue
    const start = assignment.startsOn
    try { parseDay(start) } catch { continue }
    if (earliest === null || start < earliest) earliest = start
  }
  if (earliest !== null && earliest < clampStart(today)) return clampStart(today)
  return earliest
}

function clampStart(today: string): string {
  return localDay(addDays(parseDay(today), -(MAX_SPAN_DAYS - 1)))
}

export function currentStreak(assignments: Assignment[], checkins: Checkin[], today: string): number {
  assertDay(today)
  const start = earliestStart(assignments, today)
  if (start === null) return 0
  const from = start < today ? start : today
  const scheduled = scheduledIds(assignments, from, today)
  const completed = completedIds(checkins, from, today)
  let streak = 0
  let isToday = true
  let cursor = today
  for (let remaining = spanDays(from, today); remaining > 0; remaining -= 1) {
    const day = cursor
    const ids = scheduled.get(day)
    if (ids && ids.size > 0) {
      const done = completed.get(day)
      const complete = done !== undefined && [...ids].every(id => done.has(id))
      if (complete) streak += 1
      // 今天有作业但还没完成不算中断；更早的日子没全部完成才中断。
      else if (!isToday) break
    }
    isToday = false
    cursor = localDay(addDays(parseDay(cursor), -1))
  }
  return streak
}

export function weeklyRate(assignments: Assignment[], checkins: Checkin[], today: string): number | null {
  assertDay(today)
  const from = localDay(addDays(parseDay(today), -6))
  let scheduled = 0
  let done = 0
  for (const entry of dailyAdherence(assignments, checkins, from, today)) {
    scheduled += entry.scheduled
    done += entry.done
  }
  if (scheduled === 0) return null
  return done / scheduled
}

export function needsNudge(assignments: Assignment[], checkins: Checkin[], today: string): boolean {
  assertDay(today)
  const start = earliestStart(assignments, today)
  if (start === null) return false
  const from = start < today ? start : today
  const scheduled = scheduledIds(assignments, from, today)
  const completed = completedIds(checkins, from, today)
  const recent: { complete: boolean }[] = []
  let cursor = localDay(addDays(parseDay(today), -1))
  for (let remaining = spanDays(from, today); remaining > 1 && recent.length < 2; remaining -= 1) {
    // remaining 覆盖 from..today；今天不算，所以从昨天开始，至少还剩 remaining-1 天。
    const ids = scheduled.get(cursor)
    if (ids && ids.size > 0) {
      const done = completed.get(cursor)
      recent.push({ complete: done !== undefined && [...ids].every(id => done.has(id)) })
    }
    cursor = localDay(addDays(parseDay(cursor), -1))
  }
  return recent.length === 2 && recent.every(entry => !entry.complete)
}

// 本周从周一算起（卡片口径“本周坚持率”；周日 6 → 周一偏移 6 天）。
export function weekStart(today: string): string {
  assertDay(today)
  const day = parseDay(today)
  const offset = (day.getDay() + 6) % 7
  return localDay(addDays(day, -offset))
}

export interface AdherenceReport {
  /** 本周周一，YYYY-MM-DD */
  weekStart: string
  /** 含今天最近 7 天完成率；没有作业为 null */
  weeklyRate: number | null
  /** 从今天往回数的连续完成天数 */
  streak: number
  /** 本周有完成记录的天数（“本周练习天数”） */
  practiceDays: number
  scheduled: number
  done: number
  /** 当前仍有作业；旧报告没有此字段时老师不能据此请出。 */
  hasHomework?: boolean
  /** 当前作业的最早生效日，作为从未打卡者的起点。 */
  homeworkSince?: string | null
  /** 全部当前作业都有固定到期日时，最后一个有效日。 */
  homeworkUntil?: string | null
  /** 全部有效打卡中最后一天，按子时归日。 */
  lastCheckinDay?: string | null
}

// 学生端把这份小结发给老师（不知道对方界面的还原方式也能直接显示/排序），也用于本机展示。
export function adherenceReport(assignments: Assignment[], checkins: Checkin[], today: string): AdherenceReport {
  assertDay(today)
  const start = weekStart(today)
  let scheduled = 0
  let done = 0
  let practiceDays = 0
  for (const entry of dailyAdherence(assignments, checkins, start, today)) {
    scheduled += entry.scheduled
    done += entry.done
    if (entry.done > 0) practiceDays += 1
  }
  const active = assignments.filter(row => assignmentHomework(row) && row.startsOn <= today
    && (row.homework.durationDays === undefined || (Date.parse(today + 'T00:00:00Z') - Date.parse(row.startsOn + 'T00:00:00Z')) / 86_400_000 < row.homework.durationDays)
    && !(row.homework.schedule.kind === 'once' && checkins.some(checkin => checkin.homeworkId === row.homework.id && Number.isFinite(Date.parse(checkin.at)) && checkinDay(new Date(checkin.at)) <= today)))
  const homeworkSince = active.map(row => row.startsOn).sort()[0] ?? null
  const homeworkUntil = active.length > 0 && active.every(row => Number.isSafeInteger(row.homework.durationDays) && (row.homework.durationDays ?? 0) > 0)
    ? active.map(row => localDay(addDays(parseDay(row.startsOn), (row.homework.durationDays ?? 1) - 1))).sort().at(-1) ?? null : null
  const ids = new Set(active.map(row => row.homework.id))
  const lastCheckinDay = checkins.filter(row => ids.has(row.homeworkId) && Number.isFinite(Date.parse(row.at)))
    .map(row => checkinDay(new Date(row.at))).filter(day => day <= today).sort().at(-1) ?? null
  return { weekStart: start, weeklyRate: scheduled === 0 ? null : done / scheduled, streak: currentStreak(assignments, checkins, today), practiceDays, scheduled, done,
    hasHomework: active.length > 0, homeworkSince, homeworkUntil, lastCheckinDay }
}

// 老师端“今天”页排序：同一周的报告里，坚持率低于一半的排前面（升序），无作业（null）不参与排序、排最后。
export function rankStudentAdherence<T extends { weekStart: string; weeklyRate: number | null }>(reports: readonly T[], today: string): T[] {
  const start = weekStart(today)
  const low = (value: number | null): value is number => value !== null && value < 0.5
  return reports
    .filter(report => report.weekStart === start)
    .slice()
    .sort((left, right) => {
      const leftLow = low(left.weeklyRate), rightLow = low(right.weeklyRate)
      if (leftLow && rightLow) return (left.weeklyRate as number) - (right.weeklyRate as number)
      if (leftLow !== rightLow) return leftLow ? -1 : 1
      const leftValue = left.weeklyRate ?? 2, rightValue = right.weeklyRate ?? 2
      return leftValue - rightValue
    })
}
