import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type LocalStore } from '../store'
import { checkIn, dueReminders, habitHomework, listCheckins, type Assignment } from './index'
import { HABIT_ANCHOR_MAX, habitAnchor, localDay, schedule } from './schedule'
import { homework as draftHomework } from '../drafting'
import type { Homework } from '../record/types'

const handles: LocalStore[] = []
const factory = new IDBFactory()
function open(): Promise<LocalStore> {
  return openStore(createIdentity('leader monkey parrot ring guide accident before fence cannon height naive bean', 'english'), { name: crypto.randomUUID(), factory })
    .then(store => { handles.push(store); return store })
}
function habit(anchor = '拖地时', extra: Partial<Homework> = {}): Homework {
  return { id: 'a'.repeat(8), title: '拖地时练动作', detail: '合成示例', schedule: { kind: 'habit', anchor }, source: 'teacher', ...extra }
}
afterEach(() => { handles.splice(0).forEach(store => store.close()) })

describe('M1-23a 4c 随习惯作业', () => {
  it('4c: habit homework produces no clock reminders but shows up in today habit list and can be checked in', async () => {
    const store = await open()
    const now = new Date(2026, 9, 18, 9, 30)
    const today = localDay(now)
    const assignment: Assignment = { homework: habit(), startsOn: today }
    // 不产生钟点提醒（也不进到点提醒）。
    expect(schedule([assignment.homework], today, 7, today)).toEqual([])
    expect(dueReminders([assignment], [], now)).toEqual([])
    // 镜子页“今天做这些事的时候”一栏能列出锚点。
    let items = habitHomework([assignment], [], now)
    expect(items).toEqual([{ homeworkId: assignment.homework.id, title: '拖地时练动作', detail: '合成示例', anchor: '拖地时', done: false }])
    // 打卡写入 checkins（homeworkId + at），镜子页同一天标记已完成；M1-24 可直接复用这些记录算坚持率。
    await checkIn(store, assignment.homework.id, undefined, now)
    const checkins = await listCheckins(store)
    expect(checkins).toHaveLength(1)
    expect(checkins[0]).toMatchObject({ homeworkId: assignment.homework.id })
    items = habitHomework([assignment], checkins, now)
    expect(items[0].done).toBe(true)
    // 第二天仍是未打卡状态，可再次打卡。
    expect(habitHomework([assignment], checkins, new Date(2026, 9, 19, 8, 0))[0].done).toBe(false)
  })

  it('4c: habit homework respects startsOn / durationDays and hides when expired', () => {
    const now = new Date(2026, 9, 18, 9, 0)
    const today = localDay(now)
    const future: Assignment = { homework: habit(), startsOn: '2026-10-20' }
    expect(habitHomework([future], [], now)).toEqual([])
    const expired: Assignment = { homework: habit('睡前', { durationDays: 1 }), startsOn: '2026-10-17' }
    expect(habitHomework([expired], [], now)).toEqual([])
    // 其他排程类型不进入习惯栏。
    const daily: Assignment = { homework: { ...habit(), id: 'b'.repeat(8), schedule: { kind: 'daily', time: '09:00' } }, startsOn: today }
    expect(habitHomework([daily], [], now)).toEqual([])
  })

  it('4c: anchor is 1–12 characters, trimmed and free of control characters; drafting accepts habit', () => {
    expect(habitAnchor('  拖地时  ')).toBe('拖地时')
    expect(() => habitAnchor('')).toThrow()
    expect(() => habitAnchor('一'.repeat(HABIT_ANCHOR_MAX + 1))).toThrow()
    expect(() => habitAnchor('拖地\n时')).toThrow()
    expect(() => schedule([habit('')], '2026-10-18', 1)).toThrow()
    // M1-10 起草：合法的 habit 作业被接受（来源 ai_draft、本机生成 id），非法锚点丢弃。
    const drafted = draftHomework([
      { title: '睡前按揉', detail: '合成示例', schedule: { kind: 'habit', anchor: '睡前' } },
      { title: '坏锚点', detail: '合成示例', schedule: { kind: 'habit', anchor: '' } },
    ])
    expect(drafted.map(item => item.schedule)).toEqual([{ kind: 'habit', anchor: '睡前' }])
    expect(drafted[0].source).toBe('ai_draft')
  })
})
