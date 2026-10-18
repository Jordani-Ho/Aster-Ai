import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type LocalStore } from '../store'
import { addTeacher, adherenceEnvelope, createInbox, listStudentAdherence } from '../inbox'
import { checkIn, type Assignment } from '../homework'
import { addFamilyMember, memberIdentity, memberStore } from '../family'
import { adherenceReport, rankStudentAdherence, weekStart } from './index'

const handles: LocalStore[] = []
const factory = new IDBFactory()
function open(who: ReturnType<typeof createIdentity>): Promise<LocalStore> {
  return openStore(who, { name: crypto.randomUUID(), factory }).then(store => { handles.push(store); return store })
}
function message(sender: string, envelope: { type: string; version: 1; payload: unknown }) {
  return { id: crypto.randomUUID(), sender, at: Math.floor(Date.now() / 1000), envelope }
}
afterEach(() => { handles.splice(0).forEach(store => store.close()) })

describe('M1-23a 第 6 条：家人账户同样适用坚持率', () => {
  it('家长替孩子打卡写进家人分片；家人身份上报的周坚持率与老师端排序一致', async () => {
    const owner = createIdentity()
    const teacher = createIdentity()
    const ownerStore = await open(owner), teacherStore = await open(teacher)
    await addTeacher(ownerStore, teacher.publicKey)
    const kid = await addFamilyMember(ownerStore, owner, { alias: '孩子', relation: 'child', gender: 'female', birthDate: '2016-06-01', city: '北京市' })
    const kidIdentity = memberIdentity(kid)
    const kidStore = memberStore(ownerStore, kid.account)
    // 家长替孩子把作业与打卡都放在家人分片里（f{编号}- 前缀）。
    const today = '2026-10-18'
    const assignment: Assignment = { homework: { id: 'a'.repeat(8), title: '每天练一会儿', detail: '合成', schedule: { kind: 'daily', time: '09:00' }, source: 'teacher' }, startsOn: '2026-10-12' }
    await kidStore.put('homework', assignment.homework.id, JSON.parse(JSON.stringify(assignment)))
    for (const day of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-16', '2026-10-17']) await checkIn(kidStore, assignment.homework.id, undefined, new Date(day + 'T09:05:00'))
    // 家长自己（本人分片）没有打卡：家人和本人数据隔离。
    expect(await ownerStore.list('checkins')).toEqual([])
    const kidCheckins = (await kidStore.list('checkins')).map(row => row.value as unknown as { homeworkId: string; at: string })
    const report = adherenceReport([assignment], kidCheckins, today)
    expect(report.weekStart).toBe(weekStart(today))
    expect(report.practiceDays).toBe(5)
    expect(report.streak).toBe(2) // 17、16 完成，15 漏
    expect(report.weeklyRate).toBeCloseTo(5 / 7, 10)
    // 家人身份把小结发给老师：老师端按家人身份（发件人）保存，家人筛选/排序能对上。
    await createInbox({ identity: teacher, store: teacherStore }).receive(message(kidIdentity.publicKey, adherenceEnvelope(report)))
    const stored = await listStudentAdherence(teacherStore)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ student: kidIdentity.publicKey, weekStart: report.weekStart, weeklyRate: report.weeklyRate, practiceDays: 5 })
    // 老师端排序：家人这条 <50% 的排在另一位高坚持率学生前面。
    const other = createIdentity()
    await createInbox({ identity: teacher, store: teacherStore }).receive(message(other.publicKey, adherenceEnvelope({ ...report, weeklyRate: 0.9, practiceDays: 7 })))
    const ranked = rankStudentAdherence(await listStudentAdherence(teacherStore), today)
    expect(ranked.map(row => row.student)).toEqual([kidIdentity.publicKey, other.publicKey])
  })
})
