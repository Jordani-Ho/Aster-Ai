import { describe, expect, it } from 'vitest'
import { defaultSchedule, validateSchedule } from '../hall/groundwork'
import { appointmentSlots, formatAppointmentTime, type SlotBooking } from './appointments'

function withMonday(schedule = defaultSchedule()) {
  return validateSchedule({ ...schedule, timezone: 'Asia/Shanghai', duration: 30, capacity: 3,
    week: { ...schedule.week, '1': [{ start: '09:00', end: '10:00' }] }, exceptions: [] })
}

describe('预约可约时段', () => {
  it('只生成排班内、未过且提前至少两小时的时段，并按容量排除已满', () => {
    const schedule = withMonday()
    const now = new Date('2026-10-26T07:30:00+08:00')
    const one = appointmentSlots(schedule, { now, days: 1 })
    expect(one.map(slot => slot.slotStart)).toEqual(['2026-10-26T09:30:00+08:00'])
    const bookings: SlotBooking[] = Array.from({ length: 3 }, () => ({ slotStart: '2026-10-26T09:30:00+08:00', status: 'confirmed' }))
    expect(appointmentSlots(schedule, { now, days: 1, bookings })).toEqual([])
  })

  it('不把周末、整日休息日或排班外时间当成可约', () => {
    const schedule = withMonday()
    schedule.exceptions.push({ date: '2026-10-26', kind: 'off' })
    expect(appointmentSlots(schedule, { now: new Date('2026-10-26T00:00:00Z'), days: 1 })).toEqual([])
    const weekend = appointmentSlots(schedule, { now: new Date('2026-10-31T00:00:00Z'), days: 2 })
    expect(weekend).toEqual([])
  })

  it('跨春季夏令时跳过不存在的本地时刻，跨秋季回拨区分重复时刻', () => {
    const base = defaultSchedule()
    const spring = validateSchedule({ ...base, timezone: 'America/Los_Angeles', duration: 30,
      week: { ...base.week, '0': [{ start: '01:00', end: '04:00' }] }, exceptions: [] })
    const springSlots = appointmentSlots(spring, { now: new Date('2026-03-08T06:00:00Z'), days: 2 })
    expect(springSlots.map(slot => slot.slotStart)).toEqual([
      '2026-03-08T01:00:00-08:00', '2026-03-08T01:30:00-08:00',
      '2026-03-08T03:00:00-07:00', '2026-03-08T03:30:00-07:00',
    ])

    const fall = validateSchedule({ ...base, timezone: 'America/Los_Angeles', duration: 30,
      week: { ...base.week, '0': [{ start: '01:00', end: '02:00' }] }, exceptions: [] })
    const fallSlots = appointmentSlots(fall, { now: new Date('2026-11-01T05:00:00Z'), days: 2 })
    expect(fallSlots.map(slot => slot.slotStart)).toEqual([
      '2026-11-01T01:00:00-07:00', '2026-11-01T01:30:00-07:00',
      '2026-11-01T01:00:00-08:00', '2026-11-01T01:30:00-08:00',
    ])
  })

  it('用老师时区计算并可按学生时区清楚显示，同时标出老师城市', () => {
    expect(formatAppointmentTime('2026-11-02T09:00:00+08:00', 'America/Los_Angeles', '上海'))
      .toBe('11月1日 周日 17:00（老师时间：上海）')
  })

  it.each([-1, 0, 119, 1.5, Infinity])('拒绝无效的提前量 %s', leadMinutes => {
    expect(() => appointmentSlots(withMonday(), { now: new Date('2026-10-26T00:00:00Z'), leadMinutes })).toThrow()
  })
})
