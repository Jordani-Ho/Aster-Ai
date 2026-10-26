import { expect, it } from 'vitest'
import { adherenceReport, currentStreak, dailyAdherence, needsNudge, rankStudentAdherence, weekStart, weeklyRate } from './index'
import { checkinDay } from '../homework/schedule'
import { NUDGE_SUGGESTION, dailyMirror } from '../mirror'
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

it('V2-36 小结只给当前作业附最后打卡日；没有作业与已完成单次作业不作为请出依据', () => {
  const active = assignment(daily(), '2026-10-01')
  expect(adherenceReport([active], [check('h1', '2026-10-03')], '2026-10-31')).toMatchObject({ hasHomework: true, homeworkSince: '2026-10-01', lastCheckinDay: '2026-10-03' })
  expect(adherenceReport([], [], '2026-10-31')).toMatchObject({ hasHomework: false, homeworkSince: null, lastCheckinDay: null })
  const finished = assignment(once('once-1', '2026-10-01'), '2026-10-01')
  expect(adherenceReport([finished], [check('once-1', '2026-10-01')], '2026-10-31')).toMatchObject({ hasHomework: false, homeworkSince: null, lastCheckinDay: null })
  const short = assignment(daily('short', { durationDays: 3 }), '2026-10-01')
  expect(adherenceReport([short], [], '2026-10-02')).toMatchObject({ hasHomework: true, homeworkUntil: '2026-10-03' })
})

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

it('11（M1-23a）: 子时跨零点归日——26 日子时练、27 日 00:10 打卡，26 日算完成', () => {
  // 归日口径：本地 00:00:00–00:59:59 算前一天；01:00 起算当天。夏令时切换在凌晨 2 点，不影响零点归属。
  expect(checkinDay(new Date(2026, 9, 27, 0, 10))).toBe('2026-10-26')
  expect(checkinDay(new Date(2026, 9, 27, 0, 59, 59))).toBe('2026-10-26')
  expect(checkinDay(new Date(2026, 9, 27, 1, 0))).toBe('2026-10-27')
  const item = assignment(daily('h1', { durationDays: 2 }), '2026-10-26')
  const checkins = [check('h1', '2026-10-27', '00:10:00')]
  expect(dailyAdherence([item], checkins, '2026-10-26', '2026-10-27')).toEqual([
    { day: '2026-10-26', scheduled: 1, done: 1 },
    { day: '2026-10-27', scheduled: 1, done: 0 },
  ])
  // 27 日看：26 日已完成，27 日今天还没完成不算中断 → 连续 1 天。
  expect(currentStreak([item], checkins, '2026-10-27')).toBe(1)
})

it('12（M1-23a）: 随习惯作业每个生效日算一条，打卡计入坚持率与提醒判断', () => {
  const habit = homework('h1', { kind: 'habit', anchor: '拖地时' }, { durationDays: 10 })
  const item = assignment(habit, '2026-10-10')
  expect(dailyAdherence([item], [], '2026-10-10', '2026-10-12').map(day => day.scheduled)).toEqual([1, 1, 1])
  const checked = [check('h1', '2026-10-12')]
  expect(weeklyRate([item], checked, '2026-10-12')).toBeCloseTo(1 / 3, 10)
  // 13 日看：12 日完成，10、11 两天没完成 → 最近两个有作业日（12 已完成）不成立，13 日不提醒。
  expect(needsNudge([item], checked, '2026-10-13')).toBe(false)
  expect(needsNudge([item], [], '2026-10-13')).toBe(true)
})

it('13（M1-23a 验收 4）: 连续两天没练时镜子建议多一条温和提醒；老师端把低坚持率排前面', async () => {
  const item = assignment(daily(), '2026-10-01')
  expect(needsNudge([item], [], '2026-10-03')).toBe(true)
  // 镜子建议：只多一条，不说教；没有提醒参数时行为不变。
  const result = await dailyMirror({ carePlan: null, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], nudge: true })
  expect(result.today).toContain(NUDGE_SUGGESTION)
  expect(result.today.length).toBeLessThanOrEqual(5)
  const quiet = await dailyMirror({ carePlan: null, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [] })
  expect(quiet.today).not.toContain(NUDGE_SUGGESTION)
  // 老师端排序：低坚持率在前（升序），没有作业（null）最后，旧周不参与。2026-10-03 是周六，本周从 09-28 周一开始。
  const ordered = rankStudentAdherence([
    { student: 'a'.repeat(64), weekStart: '2026-09-28', weeklyRate: 0.8 },
    { student: 'b'.repeat(64), weekStart: '2026-09-28', weeklyRate: 0.2 },
    { student: 'c'.repeat(64), weekStart: '2026-09-28', weeklyRate: null },
    { student: 'd'.repeat(64), weekStart: '2026-09-21', weeklyRate: 0.1 },
    { student: 'e'.repeat(64), weekStart: '2026-09-28', weeklyRate: 0.3 },
  ], '2026-10-03')
  expect(ordered.map(report => report.student[0])).toEqual(['b', 'e', 'a', 'c'])
})

it('14（M1-23a 验收 4）: 本周坚持率与练习天数小结（学生端发给老师端的同口径）', () => {
  const item = assignment(daily('h1', { durationDays: 30 }), '2026-10-01')
  const checkins = ['01', '02', '04', '05'].map(day => check('h1', `2026-10-${day}`))
  const today = '2026-10-05' // 周一；本周窗口内只有今天一条作业且已完成
  expect(weekStart(today)).toBe('2026-10-05')
  const report = adherenceReport([item], checkins, today)
  expect(report).toMatchObject({ weekStart: '2026-10-05', scheduled: 1, done: 1, practiceDays: 1, streak: 2 })
  expect(report.weeklyRate).toBe(1)
})
