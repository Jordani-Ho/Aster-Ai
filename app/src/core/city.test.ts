import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from './identity'
import { openStore } from './store'
import { createInbox } from './inbox'
import { isSameCity, notifyStudentsOfTeacherCityChange, notifyTeachersOfCityChange } from './city'

describe('同城口径', () => {
  it('只比较两方城市名；任一方没填时按同城处理', () => {
    expect(isSameCity('广州', '广州')).toBe(true)
    expect(isSameCity('  广州 ', '广州')).toBe(true)
    expect(isSameCity('旧金山', '广州')).toBe(false)
    expect(isSameCity(null, '广州')).toBe(true)
    expect(isSameCity('广州', null)).toBe(true)
    expect(isSameCity('', '广州')).toBe(true)
  })

  it('变化通知端到端只发送新的城市字段', async () => {
    const sender = 'a'.repeat(64), recipient = 'b'.repeat(64), sent: unknown[] = []
    const send = async (_to: string, envelope: unknown) => { sent.push(envelope) }
    await expect(notifyTeachersOfCityChange({ identity: sender, previous: '旧金山', city: '广州市', teachers: [recipient, sender], send })).resolves.toBe(1)
    expect(sent).toEqual([{ type: 'student.city', version: 1, payload: { city: '广州市' } }])
    sent.length = 0
    await expect(notifyStudentsOfTeacherCityChange({ identity: sender, previous: '广州市', city: '上海市', students: [recipient], send })).resolves.toBe(1)
    expect(sent).toEqual([{ type: 'teacher.city', version: 1, payload: { city: '上海市' } }])
  })
})

it('老师只接受已有关联学生签来的单一城市字段，并拒收过期更新', async () => {
  const teacher = createIdentity(), student = createIdentity(), stranger = createIdentity()
  const store = await openStore(teacher, { factory: new IDBFactory() })
  await store.put('settings', 'role', { role: 'teacher' })
  await store.put('teacher-students', student.publicKey, { student: student.publicKey })
  const inbox = createInbox({ identity: teacher, store })
  const receive = (sender: string, at: number, payload: unknown) => inbox.receive({
    id: `city-${at}`, sender, at, envelope: { type: 'student.city', version: 1, payload },
  })
  try {
    await receive(student.publicKey, 200, { city: '广州市' })
    expect(await store.get('teacher-students', student.publicKey)).toMatchObject({ city: '广州市', cityUpdatedAt: 200 })
    await receive(student.publicKey, 199, { city: '上海市' })
    await receive(student.publicKey, 201, { city: '广州市', alias: '不能带其他字段' })
    await receive(stranger.publicKey, 202, { city: '上海市' })
    expect(await store.get('teacher-students', student.publicKey)).toMatchObject({ city: '广州市', cityUpdatedAt: 200 })
  } finally { store.close() }
})

it('学生只接受“我的老师”发来的老师城市单字段更新', async () => {
  const student = createIdentity(), teacher = createIdentity(), stranger = createIdentity()
  const store = await openStore(student, { factory: new IDBFactory() })
  await store.put('settings', 'role', { role: 'student' })
  await store.put('settings', 'teachers', [teacher.publicKey])
  const inbox = createInbox({ identity: student, store })
  const receive = (sender: string, at: number, payload: unknown) => inbox.receive({
    id: `teacher-city-${at}`, sender, at, envelope: { type: 'teacher.city', version: 1, payload },
  })
  try {
    await receive(teacher.publicKey, 300, { city: '广州市' })
    expect(await store.get('teacher-city', teacher.publicKey)).toEqual({ city: '广州市', at: 300 })
    await receive(stranger.publicKey, 301, { city: '上海市' })
    await receive(teacher.publicKey, 302, { city: '上海市', other: '不可带入' })
    expect(await store.get('teacher-city', teacher.publicKey)).toEqual({ city: '广州市', at: 300 })
  } finally { store.close() }
})
