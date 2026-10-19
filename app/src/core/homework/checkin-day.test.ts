import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import type { Homework } from '../record/types'
import { checkIn, completedToday, dueReminders, habitHomework, listCheckins, sevenDayProgress } from './index'
import { effectiveDay, localDay } from './schedule'

// 验收：按钮上的“今日已完成”与打卡用同一个 checkinDay。
// 本地 00:00–00:59 打卡算前一天（子时归日），此时打完卡也要显示“今日已完成 ✓”，
// 不能因为按钮按日历日算而看起来没打上。时间全部注入，不依赖真实时钟。
describe('打卡与“今日已完成”同一口径（子时归日）', () => {
  const midnight = new Date(2026, 9, 18, 0, 30) // 本地 2026-10-18 00:30
  const previousDay = '2026-10-17'

  async function store() {
    return openStore(createIdentity(), { factory: new IDBFactory() })
  }

  it('本地 0:30 打卡记前一天；同一小时里“今日已完成”为真', async () => {
    const db = await store()
    await checkIn(db, 'hw-1', undefined, midnight)
    const checkins = await listCheckins(db)

    // 打卡本身按前一天归集。
    expect(effectiveDay(midnight)).toBe(previousDay)
    expect(localDay(midnight)).toBe('2026-10-18')
    // 页面用同一个 effectiveDay 判断“今天”，所以 0:30 打完卡就是已完成。
    expect(completedToday(checkins, 'hw-1', midnight)).toBe(true)
    expect(completedToday(checkins, 'hw-2', midnight)).toBe(false)
    db.close()
  })

  it('过了 0 点这一小时，这份打卡就属于前一天，不再算“今天”完成', async () => {
    const db = await store()
    await checkIn(db, 'hw-1', undefined, midnight)
    const checkins = await listCheckins(db)
    // 01:30 的有效日是 10-18，而打卡记在 10-17：按同一口径不算今天完成。
    expect(effectiveDay(new Date(2026, 9, 18, 1, 30))).toBe('2026-10-18')
    expect(completedToday(checkins, 'hw-1', new Date(2026, 9, 18, 1, 30))).toBe(false)
    // 白天正常打卡当天就算完成。
    const noon = new Date(2026, 9, 18, 12, 0)
    await checkIn(db, 'hw-1', undefined, noon)
    expect(completedToday(await listCheckins(db), 'hw-1', noon)).toBe(true)
    db.close()
  })

  it('今日作业、镜子页打卡与近 7 天统计都按同一个有效日', async () => {
    const db = await store()
    const homework: Homework = { id: 'hw-habit', title: '合成习惯', detail: '', schedule: { kind: 'habit', anchor: '睡前' }, source: 'teacher' }
    const assignment = { homework, startsOn: previousDay }
    const now = new Date(2026, 9, 18, 0, 30)
    expect(habitHomework([assignment], [], now)[0].done).toBe(false)
    await checkIn(db, 'hw-habit', undefined, now)
    const checkins = await listCheckins(db)
    // 0:30 的打卡算前一天，但页面的“今天”也是前一天，所以镜子页/今日作业都显示已完成。
    expect(habitHomework([assignment], checkins, now)[0].done).toBe(true)
    expect(completedToday(checkins, 'hw-habit', now)).toBe(true)
    // 到点的作业提醒按同一个有效日扣除已完成：0:30 这次打卡算 10-17，所以 10-17 的提醒已消除；
    // 到 10-18 白天，10-18 08:00 那份提醒是新的一天，仍会提醒（与按钮“今天还没完成”一致）。
    const daily: Homework = { ...homework, id: 'hw-daily', schedule: { kind: 'daily', time: '08:00' } }
    const dailyAssignment = { homework: daily, startsOn: previousDay }
    await checkIn(db, 'hw-daily', undefined, now)
    const allCheckins = await listCheckins(db)
    expect(dueReminders([dailyAssignment], allCheckins, now)).toHaveLength(0)
    expect(dueReminders([dailyAssignment], allCheckins, new Date(2026, 9, 18, 9, 0))).toHaveLength(1)
    // 近 7 天窗口以有效日（10-17）为最后一天。
    const progress = sevenDayProgress(daily, allCheckins, previousDay, now)
    expect(progress.days.at(-1)!.day).toBe(previousDay)
    db.close()
  })
})
