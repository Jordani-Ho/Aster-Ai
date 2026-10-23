import { describe, expect, it } from 'vitest'
import type { Assignment, Checkin } from './core/homework'
import { trendCaption, weeklyTrend } from './records-trend'

const homework = { id: 'h'.repeat(32), title: '泡脚', detail: '十五分钟', schedule: { kind: 'daily' as const, time: '08:00' }, durationDays: 60, source: 'teacher' as const }
const assignment: Assignment = { homework, startsOn: '2026-09-01' }
const checkin = (day: string): Checkin => ({ homeworkId: homework.id, at: new Date(day + 'T09:00:00').toISOString() })

describe('V2-17 记录里的坚持趋势（合成数据）', () => {
  it('近四周每周完成天数只从本机打卡与排程算', () => {
    const checkins = ['2026-10-01', '2026-10-02', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map(checkin)
    const weeks = weeklyTrend([assignment], checkins, '2026-10-22', 4)
    expect(weeks.map(week => week.label)).toEqual(['第1周', '第2周', '第3周', '本周'])
    expect(weeks.map(week => week.start)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'])
    expect(weeks.map(week => week.done)).toEqual([2, 0, 3, 4])
    expect(trendCaption(weeks)).toBe('本周完成 4 天，比上周多 1 天。')
  })

  it('没有安排作业时不编天数', () => {
    const weeks = weeklyTrend([], [], '2026-10-22', 4)
    expect(weeks.every(week => week.scheduled === 0)).toBe(true)
    expect(trendCaption(weeks)).toBe('本周还没有安排作业。')
  })

  it('周数必须正整数', () => {
    expect(() => weeklyTrend([], [], '2026-10-22', 0)).toThrow('周数无效')
    expect(() => weeklyTrend([], [], '2026-10-22', 2.5)).toThrow('周数无效')
  })
})
