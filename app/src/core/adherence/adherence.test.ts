import { expect, it } from 'vitest'
import { currentStreak, dailyAdherence, needsNudge, weeklyRate } from './index'
import type { Assignment, Checkin } from '../homework'
import type { Homework } from '../record/types'

// 验收第 9 条要求用美国夏令时时区跑：Node 支持运行期切换 process.env.TZ，放在任何 Date 计算之前。
process.env.TZ = 'America/Los_Angeles'

function homework(id: string, schedule: Homework['schedule'], extra: Partial<Homework> = {}): Homework {
  return { id, title: '合成作业 ' + id, detail: '合成示例', schedule, source: 'teacher', ...extra }
}
const daily = (id = 'h1', extra: Partial<Homework> = {}): Homework => homework(id, { kind: 'daily', time: '09:00' }, extra)
const once = (id: string, date: string): Homework => homework(id, { kind: 'once', date })
const assignment = (item: Homework, startsOn: string): Assignment => ({ homework: item, startsOn })
const check = (homeworkId: string, day: string, time = '09:05:00'): Checkin => ({ homeworkId, at: `${day}T${time}` })

it('1: 每天一条作业，连续打卡 5 天 → currentStreak = 5', () => {
  const item = assignment(daily(), '2026-10-01')
  const checkins = ['01', '02', '03', '04', '05'].map(day => check('h1', `2026-10-${day}`))
  expect(currentStreak([item], checkins, '2026-10-05')).toBe(5)
  expect(dailyAdherence([item], checkins, '2026-10-01', '2026-10-05').map(day => day.done)).toEqual([1, 1, 1, 1, 1])
})

it('2: 中间一天漏打，从漏打那天之后重新计数', () => {
  const item = assignment(daily(), '2026-10-01')
  const checkins = ['01', '02', '03', '05', '06', '07'].map(day => check('h1', `2026-10-${day}`))
  expect(currentStreak([item], checkins, '2026-10-07')).toBe(3)
})

it('3: 只有单次/节气作业时，没作业的日子不打断连续天数', () => {
  const items = [assignment(once('a', '2026-10-01'), '2026-10-01'), assignment(once('b', '2026-10-03'), '2026-10-03')]
  const checkins = [check('a', '2026-10-01'), check('b', '2026-10-03')]
  expect(currentStreak(items, checkins, '2026-10-03')).toBe(2)
  const days = dailyAdherence(items, checkins, '2026-10-01', '2026-10-04')
  expect(days.map(day => day.scheduled)).toEqual([1, 0, 1, 0])
  expect(days.map(day => day.done)).toEqual([1, 0, 1, 0])
})

it('4: 今天还没打卡时，连续天数按到昨天计算，不归零', () => {
  const item = assignment(daily(), '2026-10-01')
  const checkins = ['01', '02', '03', '04'].map(day => check('h1', `2026-10-${day}`))
  expect(currentStreak([item], checkins, '2026-10-05')).toBe(4)
})

it('5: 同一天打卡 3 次只算一次', () => {
  const item = assignment(daily(), '2026-10-01')
  const checkins = [check('h1', '2026-10-02', '08:00:00'), check('h1', '2026-10-02', '12:00:00'), check('h1', '2026-10-02', '21:00:00')]
  const days = dailyAdherence([item], checkins, '2026-10-01', '2026-10-03')
  expect(days.map(day => day.done)).toEqual([0, 1, 0])
  expect(currentStreak([item], checkins, '2026-10-02')).toBe(1)
  expect(weeklyRate([item], checkins, '2026-10-02')).toBeCloseTo(0.5, 10)
})

it('6: durationDays 到期后的日子不算有作业', () => {
  const item = assignment(daily('h1', { durationDays: 3 }), '2026-10-01')
  const checkins = ['01', '02', '03'].map(day => check('h1', `2026-10-${day}`))
  expect(dailyAdherence([item], checkins, '2026-10-05', '2026-10-07').map(day => day.scheduled)).toEqual([0, 0, 0])
  expect(currentStreak([item], checkins, '2026-10-06')).toBe(3)
})

it('7: 7 天里完成率 4/6 ≈ 0.667；7 天都没作业返回 null', () => {
  const item = assignment(daily('h1', { durationDays: 6 }), '2026-10-01')
  const checkins = ['01', '02', '04', '06'].map(day => check('h1', `2026-10-${day}`))
  expect(weeklyRate([item], checkins, '2026-10-07')).toBeCloseTo(4 / 6, 10)
  expect(weeklyRate([], [], '2026-10-07')).toBeNull()
  expect(weeklyRate([assignment(once('x', '2026-09-01'), '2026-09-01')], [], '2026-10-07')).toBeNull()
})

it('8: 最近两个有作业的日子都漏了才提醒；漏一天、补一天不提醒', () => {
  const item = assignment(daily(), '2026-10-01')
  expect(needsNudge([item], [], '2026-10-07')).toBe(true)
  const madeUp = [check('h1', '2026-10-06')]
  expect(needsNudge([item], madeUp, '2026-10-07')).toBe(false)
  expect(needsNudge([], [], '2026-10-07')).toBe(false)
  // 今天漏了不算“最近两个有作业的日子”（不含今天）。
  expect(needsNudge([item], [], '2026-10-02')).toBe(false)
})

it('9: 美国夏令时切换周每天恰好一条记录，没有重复或缺失（TZ=America/Los_Angeles）', () => {
  // 先确认运行期时区已切到洛杉矶：10-31 是 PDT(-7)，11-02 是 PST(-8)。
  expect(new Date(2026, 9, 31, 12).getTimezoneOffset()).toBe(420)
  expect(new Date(2026, 10, 2, 12).getTimezoneOffset()).toBe(480)
  const item = assignment(daily('h1', { durationDays: 10 }), '2026-10-30')
  const days = dailyAdherence([item], [], '2026-10-30', '2026-11-05')
  expect(days.map(entry => entry.day)).toEqual([
    '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
  ])
  expect(new Set(days.map(entry => entry.day)).size).toBe(7)
  expect(days.map(entry => entry.scheduled)).toEqual([1, 1, 1, 1, 1, 1, 1])
})

it('10: at 不是合法时间的打卡被忽略，不抛错', () => {
  const item = assignment(daily(), '2026-10-01')
  const checkins = [{ homeworkId: 'h1', at: 'not-a-date' }, { homeworkId: 'h1', at: '' }, check('h1', '2026-10-01')]
  expect(() => dailyAdherence([item], checkins as Checkin[], '2026-10-01', '2026-10-03')).not.toThrow()
  expect(dailyAdherence([item], checkins as Checkin[], '2026-10-01', '2026-10-03').map(day => day.done)).toEqual([1, 0, 0])
  expect(currentStreak([item], checkins as Checkin[], '2026-10-01')).toBe(1)
  expect(weeklyRate([item], checkins as Checkin[], '2026-10-01')).toBeCloseTo(1 / 1, 10)
})
