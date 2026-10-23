import { describe, expect, it } from 'vitest'
import { buildStudentRows, filterStudentRows, isRecent, lastVisitLabel, weekLabel, weekStatus } from './teacher-students'

const TODAY = '2026-10-22' // 周四，本周从 10-19 开始
const report = (patch: Partial<{ weekStart: string; weeklyRate: number | null; streak: number; practiceDays: number; scheduled: number; done: number }> = {}) => ({
  weekStart: '2026-10-19', weeklyRate: 0.8, streak: 3, practiceDays: 5, scheduled: 7, done: 5, ...patch,
})

describe('V2-17 学生名单（合成数据）', () => {
  it('本周坚持情况：正常 / 偏低 / 还没打卡 / 还没上报', () => {
    expect(weekStatus(report())).toBe('met')
    expect(weekStatus(report({ weeklyRate: 0.3 }))).toBe('low')
    expect(weekStatus(report({ practiceDays: 0, done: 0, weeklyRate: 0 }))).toBe('none')
    expect(weekStatus(null)).toBe('unknown')
    expect(weekLabel(report({ practiceDays: 5 }))).toBe('本周 5/7')
    expect(weekLabel(report({ practiceDays: 0, weeklyRate: 0, done: 0 }))).toBe('本周还没打卡')
    expect(weekLabel(null)).toBe('还没发来坚持小结')
  })

  it('只认本周小结；上周的旧数据不当作本周', () => {
    const rows = buildStudentRows([{ student: 'a'.repeat(64), alias: '小王', lastAt: '2026-10-20T01:00:00.000Z', report: report({ weekStart: '2026-10-12' }) }], TODAY)
    expect(rows[0].report).toBeNull()
    expect(rows[0].status).toBe('unknown')
  })

  it('按最近问诊排前面；搜索只匹配称呼；最近来过筛掉很久没来的', () => {
    const rows = buildStudentRows([
      { student: 'a'.repeat(64), alias: '小王', lastAt: '2026-10-08T01:00:00.000Z', report: report() },
      { student: 'b'.repeat(64), alias: '李阿姨', lastAt: '2026-10-21T01:00:00.000Z', report: report({ weeklyRate: 0.2 }) },
      { student: 'c'.repeat(64), alias: '小陈', lastAt: '2026-08-01T01:00:00.000Z', report: null },
    ], TODAY)
    expect(rows.map(row => row.alias)).toEqual(['李阿姨', '小王', '小陈'])
    expect(filterStudentRows(rows, { search: '王' }).map(row => row.alias)).toEqual(['小王'])
    expect(filterStudentRows(rows, { recentOnly: true }).map(row => row.alias)).toEqual(['李阿姨', '小王'])
    expect(isRecent('2026-09-23T00:00:00.000Z', TODAY)).toBe(true)
    expect(isRecent('2026-09-01T00:00:00.000Z', TODAY)).toBe(false)
    expect(isRecent(null, TODAY)).toBe(false)
    expect(lastVisitLabel(new Date(2026, 9, 8, 12).toISOString())).toBe('上次问诊 10月8日')
    expect(lastVisitLabel(null)).toBe('还没有问诊')
  })
})
