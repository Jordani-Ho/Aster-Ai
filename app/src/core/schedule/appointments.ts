import { effectivePeriods, validateSchedule, type Schedule } from '../hall/groundwork'

export interface SlotBooking { slotStart: string; status: string }
export interface AppointmentSlot { slotStart: string; minutes: number; timezone: string; capacity: number }
export interface SlotOptions {
  now?: Date
  days?: number
  leadMinutes?: number
  bookings?: readonly SlotBooking[]
}

interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second?: number }
const partFormatters = new Map<string, Intl.DateTimeFormat>()

function parts(date: Date, timezone: string): WallTime {
  let formatter = partFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    partFormatters.set(timezone, formatter)
  }
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) }
}

function dayText(value: WallTime): string {
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`
}

function addDays(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const result = new Date(Date.UTC(year, month - 1, date + count))
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`
}

function offsetAt(instant: number, timezone: string): number {
  const wall = parts(new Date(instant), timezone)
  return (Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0) - instant) / 60_000
}

/** 返回某个老师本地钟点对应的所有真实时刻；春季跳过不存在时刻，秋季保留重复时刻。 */
function instantsForWallTime(day: string, clock: string, timezone: string): number[] {
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = clock.split(':').map(Number)
  const wall: WallTime = { year, month, day: date, hour, minute, second: 0 }
  const naive = Date.UTC(year, month - 1, date, hour, minute)
  const offsets = new Set<number>()
  // IANA offset changes are sparse; sampling around the local date finds both sides of DST folds.
  for (let hours = -36; hours <= 36; hours += 6) offsets.add(offsetAt(naive + hours * 3_600_000, timezone))
  return [...offsets].map(offset => naive - offset * 60_000)
    .filter(instant => {
      const found = parts(new Date(instant), timezone)
      return found.year === wall.year && found.month === wall.month && found.day === wall.day
        && found.hour === wall.hour && found.minute === wall.minute && found.second === 0
    })
    .sort((left, right) => left - right)
}

function isoWithOffset(instant: number, timezone: string): string {
  const local = parts(new Date(instant), timezone)
  const offset = offsetAt(instant, timezone)
  const sign = offset < 0 ? '-' : '+'
  const magnitude = Math.abs(offset)
  return `${dayText(local)}T${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}:00${sign}${String(Math.floor(magnitude / 60)).padStart(2, '0')}:${String(magnitude % 60).padStart(2, '0')}`
}

/** 把学生选定的绝对时刻保存为其本地时区的带偏移时刻。 */
export function slotStartInZone(instant: number, timezone: string): string {
  if (!Number.isSafeInteger(instant) || instant % 60_000 !== 0 || typeof timezone !== 'string') throw new Error('预约时间无效')
  return isoWithOffset(instant, timezone)
}

/** 排班、节假日、至少提前两小时与容量共用的唯一可约时段算法。 */
export function appointmentSlots(scheduleInput: Schedule, options: SlotOptions = {}): AppointmentSlot[] {
  const schedule = validateSchedule(scheduleInput)
  const now = options.now ?? new Date()
  const days = options.days ?? 60
  const leadMinutes = options.leadMinutes ?? 120
  if (!(now instanceof Date) || !Number.isFinite(+now) || !Number.isSafeInteger(days) || days < 0 || days > 366
    || !Number.isSafeInteger(leadMinutes) || leadMinutes < 120) throw new Error('预约时间范围无效')
  const today = dayText(parts(now, schedule.timezone))
  const threshold = +now + leadMinutes * 60_000
  const counts = new Map<number, number>()
  for (const booking of options.bookings ?? []) {
    if (!booking || typeof booking.slotStart !== 'string' || !['accepted', 'confirmed'].includes(booking.status)) continue
    const at = Date.parse(booking.slotStart)
    if (Number.isFinite(at)) counts.set(at, (counts.get(at) ?? 0) + 1)
  }
  const result: AppointmentSlot[] = []
  for (let dayIndex = 0; dayIndex < days; dayIndex++) {
    const day = addDays(today, dayIndex)
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
    const periods = effectivePeriods(schedule, day, today)
    for (const period of periods) {
      const [startHour, startMinute] = period.start.split(':').map(Number)
      const [endHour, endMinute] = period.end.split(':').map(Number)
      const start = startHour * 60 + startMinute, end = endHour * 60 + endMinute
      for (let minute = start; minute + schedule.duration <= end; minute += schedule.duration) {
        const clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
        for (const instant of instantsForWallTime(day, clock, schedule.timezone)) {
          if (instant < threshold || (counts.get(instant) ?? 0) >= schedule.capacity) continue
          result.push({ slotStart: isoWithOffset(instant, schedule.timezone), minutes: schedule.duration, timezone: schedule.timezone, capacity: schedule.capacity })
        }
      }
    }
    // keep the explicit date walk tied to the validated weekly template (including Sunday=0).
    void weekday
  }
  return result.sort((left, right) => Date.parse(left.slotStart) - Date.parse(right.slotStart))
}

export function formatAppointmentTime(slotStart: string, viewerTimezone: string, teacherCity?: string, teacherTimezone?: string): string {
  const instant = new Date(slotStart)
  if (!Number.isFinite(+instant)) throw new Error('预约时间无效')
  const found = new Intl.DateTimeFormat('zh-CN', {
    timeZone: viewerTimezone, month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant)
  const values = Object.fromEntries(found.map(part => [part.type, part.value]))
  const viewer = `${values.month}月${values.day}日 ${values.weekday} ${values.hour}:${values.minute}`
  const teacherLabel = [teacherCity, teacherTimezone ? `时区 ${teacherTimezone}` : undefined].filter(Boolean).join(' · ')
  return teacherLabel ? `${viewer}（老师时间：${teacherLabel}）` : viewer
}
