import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { addTeacher, createInbox, listReceivedRecords, loadTeachers } from '../inbox'
import { loadGroundwork, saveGroundwork } from '../hall/groundwork'
import { makeInvite } from '../onboarding'
import { dueForLeave, validLeaveDays, inactivityMilestones, runDailyRosterLeaves, receiveRosterJoin, sendPendingRosterJoin, listRosterLeaves, ROSTER_LEAVE_TEXT } from './index'

describe('V2-36 名单资格与提醒节奏', () => {
  const today = '2026-10-31'
  const report = { hasHomework: true, homeworkSince: '2026-09-01', lastCheckinDay: '2026-09-30' }

  it('接受邀请与中继连上同时触发补发时，同一条进馆消息只发一次，失败保留待发', async () => {
    const student = createIdentity(), teacher = createIdentity()
    const store = await openStore(student, { factory: new IDBFactory() })
    try {
      await store.put('student-roster-pending', teacher.publicKey, { invite: 'synthetic' })
      let release!: () => void, started!: () => void
      const sending = new Promise<void>(resolve => { release = resolve })
      const entered = new Promise<void>(resolve => { started = resolve })
      let calls = 0
      const send = async () => { calls++; started(); await sending }
      const first = sendPendingRosterJoin(store, send)
      await entered
      const second = sendPendingRosterJoin(store, send)
      release()
      await Promise.all([first, second])
      expect(calls).toBe(1)
      expect(await store.get('student-roster-pending', teacher.publicKey)).toBeUndefined()
      await store.put('student-roster-pending', teacher.publicKey, { invite: 'synthetic' })
      await expect(sendPendingRosterJoin(store, async () => { throw Error('offline') })).rejects.toThrow('offline')
      expect(await store.get('student-roster-pending', teacher.publicKey)).toBeDefined()
      await sendPendingRosterJoin(store, async () => {})
      expect(await store.get('student-roster-pending', teacher.publicKey)).toBeUndefined()
    } finally { store.close() }
  })

  it('默认不请出；30 天只请出 31 天未打卡的有作业学生', () => {
    expect(dueForLeave(report, null, today)).toBe(false)
    expect(dueForLeave(report, 30, today)).toBe(true)
    expect(dueForLeave({ ...report, lastCheckinDay: '2026-10-21' }, 30, today)).toBe(false)
    expect(dueForLeave({ ...report, hasHomework: false }, 30, today)).toBe(false)
    expect(dueForLeave({ ...report, homeworkUntil: '2026-10-01' }, 30, today)).toBe(false)
    expect(dueForLeave({ ...report, lastCheckinDay: null, homeworkSince: '2026-10-01' }, 30, today)).toBe(false)
  })

  it('拒绝越界天数、过期报告和缺少新字段的旧小结', () => {
    expect(validLeaveDays(13)).toBe(false)
    expect(validLeaveDays(365)).toBe(true)
    expect(validLeaveDays(366)).toBe(false)
    expect(dueForLeave({ hasHomework: true, homeworkSince: '2026-10-01', lastCheckinDay: null }, 30, today)).toBe(false)
    expect(dueForLeave({ hasHomework: true, homeworkSince: '2026-09-01', lastCheckinDay: 'bad' }, 30, today)).toBe(false)
    expect(dueForLeave({}, 30, today)).toBe(false)
  })

  it('30 天在第 15 天说事实、第 23 天退一步；无期限在 7/14 天', () => {
    expect(inactivityMilestones(30)).toEqual({ fact: 15, stepBack: 23 })
    expect(inactivityMilestones(null)).toEqual({ fact: 7, stepBack: 14 })
  })

  it('老师智能体只请出 A，通知学生；预约、病历集合不动，旧报告不能重新加入', async () => {
    const teacher = createIdentity(), a = createIdentity(), b = createIdentity(), c = createIdentity()
    const teacherStore = await openStore(teacher, { factory: new IDBFactory() })
    const studentStore = await openStore(a, { factory: new IDBFactory() })
    const now = new Date(2026, 9, 31, 12)
    try {
      await studentStore.put('settings', 'role', { role: 'student' })
      await addTeacher(studentStore, teacher.publicKey)
      await studentStore.put('homework', 'synthetic-homework', { title: '合成练习' })
      for (const student of [a, b, c]) await teacherStore.put('teacher-students', student.publicKey, { student: student.publicKey })
      await teacherStore.put('student-adherence', a.publicKey, { ...report, student: a.publicKey })
      await teacherStore.put('student-adherence', b.publicKey, { ...report, student: b.publicKey, lastCheckinDay: '2026-10-21' })
      await teacherStore.put('student-adherence', c.publicKey, { ...report, student: c.publicKey, hasHomework: false })
      await teacherStore.put('appointments', 'visit-a', { student: a.publicKey, status: 'confirmed', slotStart: '2026-11-07T10:00:00+08:00' })
      await teacherStore.put('teacher-records', 'history-a', { student: a.publicKey, synthetic: true })
      const baseline = await loadGroundwork(teacherStore)
      const send = async (student: string, envelope: { type: string; version: 1; payload: unknown }) => {
        expect(student).toBe(a.publicKey)
        await createInbox({ store: studentStore, identity: a }).receive({ id: 'synthetic-leave', sender: teacher.publicKey, at: Math.floor(+now / 1000), envelope })
      }
      expect(await runDailyRosterLeaves(teacherStore, teacher, send, now)).toEqual([])
      await saveGroundwork(teacherStore, { ...baseline, invitation: { ...baseline.invitation, leaveAfterDays: 30 } })
      const departed = await runDailyRosterLeaves(teacherStore, teacher, send, now)
      expect(departed).toHaveLength(1)
      expect(departed[0].student).toBe(a.publicKey)
      expect(await teacherStore.get('teacher-students', a.publicKey)).toBeUndefined()
      expect(await teacherStore.get('teacher-students', b.publicKey)).toBeDefined()
      expect(await teacherStore.get('teacher-students', c.publicKey)).toBeDefined()
      expect(await teacherStore.get('appointments', 'visit-a')).toBeDefined()
      expect(await teacherStore.get('teacher-records', 'history-a')).toBeDefined()
      expect(await loadTeachers(studentStore)).not.toContain(teacher.publicKey)
      expect((await studentStore.get('student-roster-leaves', teacher.publicKey) as { text: string }).text).toBe(ROSTER_LEAVE_TEXT)
      expect(await studentStore.get('homework', 'synthetic-homework')).toEqual({ title: '合成练习' })
      expect(await listRosterLeaves(teacherStore)).toHaveLength(1)
      await createInbox({ store: teacherStore, identity: teacher }).receive({ id: 'late-report', sender: a.publicKey, at: Math.floor(+now / 1000) + 1,
        envelope: { type: 'homework.adherence', version: 1, payload: { weekStart: '2026-10-26', weeklyRate: 0, streak: 0, practiceDays: 0, scheduled: 7, done: 0, ...report } } })
      expect(await teacherStore.get('teacher-students', a.publicKey)).toBeUndefined()
      expect(await teacherStore.get('student-adherence', a.publicKey)).toBeUndefined()
      expect(await listReceivedRecords(studentStore, a)).toEqual([])
    } finally { teacherStore.close(); studentStore.close() }
  })

  it('请出后只认老师新签的邀请，旧链接重放不能回来', async () => {
    const teacher = createIdentity(), student = createIdentity(), store = await openStore(teacher, { factory: new IDBFactory() })
    const leave = Math.floor(Date.now() / 1000) - 120
    const url = 'https://synthetic.example/invite/redeem'
    try {
      await store.put('teacher-roster-leaves', student.publicKey, { student: student.publicKey, at: new Date(leave * 1000).toISOString(), day: new Date(leave * 1000).toISOString().slice(0, 10) })
      const old = makeInvite(teacher, url, leave - 60, 3600)
      expect(await receiveRosterJoin(store, teacher.publicKey, student.publicKey, old, leave + 1)).toBe(false)
      const fresh = makeInvite(teacher, url, leave + 1, 3600)
      expect(await receiveRosterJoin(store, teacher.publicKey, student.publicKey, { ...fresh, content: 'tampered' }, leave + 2)).toBe(false)
      expect(await receiveRosterJoin(store, teacher.publicKey, student.publicKey, fresh, 0)).toBe(false)
      expect(await receiveRosterJoin(store, teacher.publicKey, student.publicKey, fresh, leave + 2)).toBe(true)
      expect(await store.get('teacher-roster-leaves', student.publicKey)).toBeUndefined()
      expect(await store.get('teacher-students', student.publicKey)).toEqual({ student: student.publicKey, joinedAt: leave + 2 })
    } finally { store.close() }
  })
})
