import type { Assignment, Checkin } from '../homework'
import { addDays, localDay, parseDay, schedule } from '../homework/schedule'
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
function scheduledIds(assignments: Assignment[], from: string, to: string): Map<string, Set<string>> {
  const days = spanDays(from, to)
  const result = new Map<string, Set<string>>()
  for (const assignment of assignments) {
    const homework = assignmentHomework(assignment)
    if (!homework) continue
    let reminders
    try { reminders = schedule([homework], assignment.startsOn, days, from) } catch { continue }
    for (const reminder of reminders) {
      const day = localDay(reminder.at)
      if (day < from || day > to) continue
      const ids = result.get(day) ?? new Set<string>()
      ids.add(homework.id)
      result.set(day, ids)
    }
  }
  return result
}

// 每天已打卡的作业 id（同一天多次打卡只算一次；at 不是合法时间的记录忽略，不抛错）。
function completedIds(checkins: Checkin[], from: string, to: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const checkin of checkins) {
    if (!checkin || typeof checkin !== 'object') continue
    if (typeof checkin.homeworkId !== 'string' || checkin.homeworkId === '') continue
    if (typeof checkin.at !== 'string') continue
    const at = Date.parse(checkin.at)
    if (!Number.isFinite(at)) continue
    const day = localDay(new Date(at))
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
